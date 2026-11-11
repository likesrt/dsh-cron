/**
 * 数据落盘：一个工作区一份，登记表单独放在 DSH_HOME。
 *
 * 任务跟着工作区走，跨工作区的任务不会互相覆盖，删掉某个工作区也不影响别的
 * 排期；单工作区场景就是 MultiStore 只有一个成员，能力完全一样。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeStoredTask } from '../core/model.js';

const DATA_DIR_NAME = 'dsh-cron';
const REGISTRY_NAME = 'workspaces.json';
const MAX_RUN_BYTES = 4 * 1024 * 1024;
/** 历史保留的默认值，与内置任务的投递记录同一量级：留够复盘，也不让文件无限长。 */
const DEFAULT_HISTORY_DAYS = 30;
const DEFAULT_HISTORY_RECORDS = 200;
/** 每跑这么多次整理一遍历史；太频繁等于每次运行都全量读一遍。 */
const MAINTAIN_EVERY_APPENDS = 20;

export function resolveDshHome() {
  return process.env.DSH_HOME?.trim() || path.join(process.env.HOME ?? '/root', '.dsh');
}

/** 工作区登记表位置：全局唯一，跨宿主进程共用。 */
export function defaultRegistryPath() {
  return path.join(resolveDshHome(), 'dsh-cron', REGISTRY_NAME);
}

/** 单个工作区的数据目录，目录名固定，前端和脚本都按它找。 */
export function workspaceDataDir(workspace) {
  return path.join(workspace, DATA_DIR_NAME);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

async function writeJsonAtomic(file, payload) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, file);
}

export class Store {
  /**
   * 单工作区存储。
   * @param {string} workspace 工作区绝对路径
   * @param {{directory?: string, timeZone?: string, historyDays?: number, historyRecords?: number}} [options]
   */
  constructor(workspace, { directory, timeZone = 'UTC', historyDays, historyRecords } = {}) {
    this.workspace = path.resolve(workspace);
    this.dir = directory ? path.resolve(directory) : workspaceDataDir(this.workspace);
    this.timeZone = timeZone;
    this.tasksFile = path.join(this.dir, 'tasks.json');
    this.runsFile = path.join(this.dir, 'runs.jsonl');
    this.historyDays = positive(historyDays) ?? DEFAULT_HISTORY_DAYS;
    this.historyRecords = positive(historyRecords) ?? DEFAULT_HISTORY_RECORDS;
    this.appends = 0;
    this.tasks = [];
    this.loaded = false;
    this.migrated = false;
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true });
    let raw = [];
    try {
      const text = await fs.readFile(this.tasksFile, 'utf8');
      const parsed = JSON.parse(text);
      raw = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      raw = [];
    }
    this.tasks = raw.map((item) => normalizeStoredTask(item, {
      timeZone: this.timeZone,
      workspace: this.workspace,
    }));
    // 迁移是否真的改过内容，决定启动后要不要马上写回，避免每轮启动都重算。
    this.migrated = JSON.stringify(raw) !== JSON.stringify(this.tasks);
    this.loaded = true;
    return this.tasks;
  }

  async save() {
    const payload = JSON.stringify(
      { version: 2, workspace: this.workspace, savedAt: new Date().toISOString(), tasks: this.tasks },
      null,
      2,
    );
    await writeJsonAtomic(this.tasksFile, payload);
    this.migrated = false;
  }

  all() {
    return this.tasks;
  }

  find(id) {
    return this.tasks.find((task) => task.id === id);
  }

  insert(task) {
    this.tasks.push(task);
    return task;
  }

  remove(id) {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return null;
    return this.tasks.splice(index, 1)[0];
  }

  async appendRun(run) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.runsFile, `${JSON.stringify(run)}\n`, 'utf8');
    this.appends += 1;
    await this.#maintain();
  }

  /** 文件长到阈值、或攒够若干条时才整理一次，别让每次运行都全量读历史。 */
  async #maintain() {
    let stat;
    try {
      stat = await fs.stat(this.runsFile);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.size <= MAX_RUN_BYTES && this.appends % MAINTAIN_EVERY_APPENDS !== 0) return;
    await this.pruneRuns();
  }

  /**
   * 按配置清理运行历史：超过保留天数的丢掉，再让每个任务各留最近的 N 条。
   * 坏行（写一半断电之类）顺手清掉，读的时候本来也跳过。
   * @param {{now?: number}} [options]
   * @returns {Promise<number>} 被丢掉的记录条数
   */
  async pruneRuns({ now = Date.now() } = {}) {
    let raw;
    try {
      raw = await fs.readFile(this.runsFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    const cutoff = now - this.historyDays * 86_400_000;
    const buckets = new Map();
    let parsed = 0;
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      let record;
      try {
        record = JSON.parse(text);
      } catch {
        continue;
      }
      parsed += 1;
      const startedAt = Date.parse(record?.startedAt ?? '');
      if (Number.isFinite(startedAt) && startedAt < cutoff) continue;
      const key = typeof record?.taskId === 'string' ? record.taskId : '';
      const bucket = buckets.get(key) ?? [];
      bucket.push(text);
      buckets.set(key, bucket);
    }
    const kept = [];
    for (const bucket of buckets.values()) kept.push(...bucket.slice(-this.historyRecords));
    if (kept.length === parsed) return 0;
    await writeJsonAtomic(this.runsFile, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
    return parsed - kept.length;
  }

  /** Most recent runs first. */
  async readRuns({ taskId, limit = 50 } = {}) {
    let raw;
    try {
      raw = await fs.readFile(this.runsFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const lines = raw.split('\n');
    const out = [];
    for (let index = lines.length - 1; index >= 0 && out.length < limit; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (taskId && record.taskId !== taskId) continue;
      out.push(record);
    }
    return out;
  }
}

/**
 * 多工作区门面：任务按 workspace 路由到各自的 Store，读的时候合并。
 * 服务层只跟它打交道，所以「一个工作区」和「十个工作区」走的是同一套代码。
 */
export class MultiStore {
  constructor({ registryPath = defaultRegistryPath(), timeZone = 'UTC', historyDays, historyRecords } = {}) {
    this.registryPath = path.resolve(registryPath);
    this.registryDir = path.dirname(this.registryPath);
    this.timeZone = timeZone;
    this.historyDays = positive(historyDays) ?? DEFAULT_HISTORY_DAYS;
    this.historyRecords = positive(historyRecords) ?? DEFAULT_HISTORY_RECORDS;
    this.stores = new Map();
    this.order = [];
  }

  async load() {
    const listed = await this.#readRegistry();
    for (const workspace of listed) {
      try {
        await this.addWorkspace(workspace, { persist: false });
      } catch (error) {
        // 一个工作区读不了（盘被卸载、权限变了）不该拖垮其它工作区的排期。
        if (error?.code === 'ENOENT' || error?.code === 'EACCES') continue;
        throw error;
      }
    }
    return this.all();
  }

  async #readRegistry() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.registryPath, 'utf8'));
      const list = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
      return [...new Set(list.filter((item) => typeof item === 'string' && path.isAbsolute(item)))];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async #writeRegistry() {
    await fs.mkdir(this.registryDir, { recursive: true });
    const payload = JSON.stringify({ version: 1, workspaces: [...this.order] }, null, 2);
    await writeJsonAtomic(this.registryPath, payload);
  }

  async addWorkspace(workspace, { persist = true } = {}) {
    const key = path.resolve(workspace);
    let store = this.stores.get(key);
    if (!store) {
      store = new Store(key, {
        timeZone: this.timeZone,
        historyDays: this.historyDays,
        historyRecords: this.historyRecords,
      });
      await store.load();
      this.stores.set(key, store);
      this.order.push(key);
    }
    if (persist) await this.#writeRegistry();
    return store;
  }

  entries() {
    return this.order.map((workspace) => this.stores.get(workspace)).filter(Boolean);
  }

  all() {
    return this.entries().flatMap((store) => store.tasks);
  }

  find(id) {
    for (const store of this.entries()) {
      const task = store.find(id);
      if (task) return task;
    }
    return null;
  }

  storeFor(workspace) {
    if (!workspace) return null;
    return this.stores.get(path.resolve(workspace)) ?? null;
  }

  workspaceOf(taskId) {
    for (const store of this.entries()) {
      if (store.find(taskId)) return store.workspace;
    }
    return null;
  }

  async insert(task) {
    const store = await this.addWorkspace(task.workspace);
    store.insert(task);
    return task;
  }

  async remove(id) {
    for (const store of this.entries()) {
      const removed = store.remove(id);
      if (removed) {
        await store.save();
        return removed;
      }
    }
    return null;
  }

  async save() {
    for (const store of this.entries()) await store.save();
    await this.#writeRegistry();
  }

  async saveWorkspace(workspace) {
    const store = this.storeFor(workspace);
    if (store) await store.save();
  }

  async appendRun(run) {
    const store = this.storeFor(run.workspace) ?? this.storeFor(this.workspaceOf(run.taskId));
    if (!store) throw new Error(`运行记录的所属工作区未登记：${run.workspace ?? run.taskId}`);
    await store.appendRun(run);
  }

  /** 跨工作区的历史：按开始时间倒序合并。 */
  async readRuns({ taskId, limit = 50 } = {}) {
    const merged = [];
    for (const store of this.entries()) {
      merged.push(...(await store.readRuns({ taskId, limit })));
    }
    merged.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    return merged.slice(0, limit);
  }

  listWorkspaces() {
    return this.entries().map((store) => ({
      path: store.workspace,
      name: path.basename(store.workspace) || store.workspace,
      taskCount: store.tasks.length,
    }));
  }

  get dir() {
    return this.registryDir;
  }
}
