/**
 * 调度器本体：到点判断、执行、推送、历史。
 *
 * 只有两条执行路径（契约 §2）：script 跑命令，agent 叫醒模型。
 */

import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { runScript } from './exec.js';

// core/ 也带上 devReload 的尾巴：这些模块被 part 静态 import 时不会跟着刷新。
const devBust = globalThis.__dshCronDevBust ?? '';
const {
  TaskError,
  computeNextRun,
  createTask,
  isDue,
  normalizeAgent,
  normalizeDelivery,
  normalizeMode,
  normalizePermission,
  normalizeSchedule,
  normalizeScript,
  normalizeTarget,
  normalizeWorkspace,
  previewSchedule,
  publicTask,
} = await import(`../core/model.js${devBust}`);
const { CronError } = await import(`../core/cron.js${devBust}`);
const { IncidentBook } = await import(`../core/incidents.js${devBust}`);
const { TickLock } = await import(`../data/lock.js${devBust}`);
const { workspaceDataDir } = await import(`../data/store.js${devBust}`);

/** 单个 setTimeout 的上限，和宿主 setTimeout 一致（约 24.8 天）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 兜底巡检：只挂在有任务的时候。正常到点由定时器精确唤醒，
 * 这一层只用来吸收系统时钟跳变和漏掉的重新定时，别让它成为主要机制。
 */
const SAFETY_SWEEP_MS = 300_000;

export const DEFAULT_TIME_LIMIT_MS = 180_000;

/** 等待一段时间，外部取消时立刻退出。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** 智能模式的静默约定：整段回复只有这个标记时，本轮不推送。 */
const SILENT_MARKER = /^\s*[[【]\s*(silent|静默)\s*[\]】]\s*$/i;

/** 只在配了渠道时才告诉模型这条约定，省得没必要的提示。 */
const SILENT_HINT = '如果本轮判断不需要打扰人，就只回复 [silent]，不要写别的内容。';

/** @returns 这段回复是不是在要求本轮静默。 */
function isSilentAnswer(text) {
  return typeof text === 'string' && SILENT_MARKER.test(text);
}

/** 去掉静默标记，留下的正文才进运行记录。 */
function stripSilentMarker(text) {
  return isSilentAnswer(text) ? '' : text;
}

export class CronService extends EventEmitter {
  constructor({ ctx, store, delivery, dispatcher, logger = console, options = {} }) {
    super();
    this.ctx = ctx;
    this.store = store;
    this.delivery = delivery;
    this.dispatcher = dispatcher;
    this.logger = logger;
    this.options = {
      timeZone: options.timeZone ?? 'UTC',
      timeLimitMs: options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
      maxConcurrent: options.maxConcurrent ?? 3,
      sweepMs: options.sweepMs ?? SAFETY_SWEEP_MS,
      ...options,
    };
    // 故障记录和 tick 锁都是按工作区独立的：某个工作区被别的进程接管，
    // 不该连累其它工作区的任务。
    this.books = new Map();
    this.locks = new Map();
    this.running = new Set();
    this.timer = null;
    this.stopped = false;
    this.lastTickAt = null;
    this.startedAt = null;
    this.tickLock = false;
  }

  async start() {
    await this.store.load();
    for (const entry of this.store.entries()) await this.#book(entry.workspace);

    // 手改过配置、升级过版本、或调度刚迁移完的任务，下次执行时间要补算。
    let touched = false;
    for (const task of this.store.all()) {
      if (!task.timeZone) {
        task.timeZone = this.options.timeZone;
        touched = true;
      }
      if (task.enabled && (!task.state?.nextRunAt || !Number.isFinite(Date.parse(task.state.nextRunAt)))) {
        const next = computeNextRun(task, Date.now());
        task.state.nextRunAt = next === null ? null : new Date(next).toISOString();
        touched = true;
      }
    }
    if (touched || this.store.entries().some((entry) => entry.migrated)) await this.store.save();

    this.startedAt = new Date().toISOString();
    this.stopped = false;
    // 启动即扫一轮（补算过的下次执行时间在这里落地），随后按最早到期时间定时。
    await this.tick().catch(() => {});
    this.#schedule();
    return this;
  }

  async stop() {
    this.stopped = true;
    this.#clearTimer();
    for (const controller of this.running) controller.abort();
    this.running.clear();
    for (const lock of this.locks.values()) await lock.release({ force: true }).catch(() => {});
    try {
      await this.store.save();
    } catch {
      /* best effort */
    }
  }

  async #book(workspace) {
    let book = this.books.get(workspace);
    if (!book) {
      const dir = this.store.storeFor(workspace)?.dir ?? workspaceDataDir(workspace);
      book = new IncidentBook(dir);
      await book.load();
      this.books.set(workspace, book);
    }
    return book;
  }

  #lock(workspace) {
    let lock = this.locks.get(workspace);
    if (!lock) {
      const dir = this.store.storeFor(workspace)?.dir ?? workspaceDataDir(workspace);
      lock = new TickLock(dir, { logger: this.logger });
      this.locks.set(workspace, lock);
    }
    return lock;
  }

  status() {
    return {
      running: !this.stopped,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      taskCount: this.store.all().length,
      activeRuns: this.running.size,
      timeZone: this.options.timeZone,
      delivery: { available: this.delivery.available() },
      workspaces: this.listWorkspaces(),
    };
  }

  // ---------------------------------------------------------------- CRUD

  list({ includeEnded = true } = {}) {
    const tasks = [...this.store.all()]
      .sort((a, b) => {
        const left = a.state?.nextRunAt ? Date.parse(a.state.nextRunAt) : Number.MAX_SAFE_INTEGER;
        const right = b.state?.nextRunAt ? Date.parse(b.state.nextRunAt) : Number.MAX_SAFE_INTEGER;
        return left - right;
      })
      .map(publicTask);
    if (includeEnded) return tasks;
    return tasks.filter((task) => task.enabled || task.state?.nextRunAt);
  }

  view(id) {
    const task = this.store.find(id);
    return task ? publicTask(task) : null;
  }

  requireTask(id) {
    const task = this.store.find(id);
    if (!task) throw new TaskError(`找不到任务 ${id}`, 'not_found');
    return task;
  }

  async create(input) {
    const task = createTask({ ...input, id: undefined }, { now: Date.now(), timeZone: this.options.timeZone });
    if (task.permission) this.#assertPermission(task.permission);
    if (this.store.find(task.id)) {
      task.id = `${task.id}-${Math.random().toString(36).slice(2, 5)}`;
    }
    await this.#assertWorkspace(task.workspace);
    await this.store.insert(task);
    await this.#book(task.workspace);
    await this.store.saveWorkspace(task.workspace);
    this.emit('tasks/changed');
    this.#schedule();
    return publicTask(task);
  }

  /** 预设名必须是宿主认识的，别等到跑的时候才炸。 */
  #assertPermission(name) {
    const presets = this.ctx?.get?.('permissionPresets');
    const known = presets?.names;
    if (!Array.isArray(known) || known.length === 0) return;
    if (!known.includes(name)) throw new TaskError(`permission 只能是 ${known.join(' / ')}`);
  }

  /** 任务落在工作区目录里；目录不在就别建任务，省得事后满世界补空目录。 */
  async #assertWorkspace(workspace) {
    try {
      if ((await stat(workspace)).isDirectory()) return;
    } catch {
      /* 落到下面统一报错 */
    }
    throw new TaskError(`工作区不存在：${workspace}`, 'invalid_workspace');
  }

  async edit(id, patch) {
    const task = this.requireTask(id);
    const previousWorkspace = task.workspace;
    let moved = false;

    if (patch.title !== undefined) {
      const title = String(patch.title).trim();
      if (!title) throw new TaskError('title 不能为空');
      task.title = title.slice(0, 80);
    }
    if (patch.prompt !== undefined) task.prompt = String(patch.prompt).trim() || null;
    if (patch.enabled !== undefined) task.enabled = Boolean(patch.enabled);
    if (patch.repeat !== undefined) task.repeat = normalizeRepeat(patch.repeat);
    if (patch.retries !== undefined) {
      if (patch.retries === null || patch.retries === '') delete task.retries;
      else task.retries = normalizeRetries(patch.retries);
    }
    if (patch.timeoutMs !== undefined) {
      if (patch.timeoutMs === null || patch.timeoutMs === '') delete task.timeoutMs;
      else task.timeoutMs = normalizeTaskTimeout(patch.timeoutMs);
    }
    if (patch.mode !== undefined) {
      const mode = normalizeMode(patch.mode);
      if (!mode) throw new TaskError('mode 只能是 script/agent');
      task.mode = mode;
    }
    if (patch.permission !== undefined) {
      if (!patch.permission) delete task.permission;
      else {
        task.permission = normalizePermission(patch.permission);
        this.#assertPermission(task.permission);
      }
    }
    if (patch.agent !== undefined) task.agent = normalizeAgent(patch.agent);
    if (patch.script !== undefined) task.script = normalizeScript(patch.script);
    if (patch.delivery !== undefined) task.delivery = normalizeDelivery(patch.delivery, 'delivery');
    if (patch.target !== undefined) {
      const next = normalizeTarget(patch.target, 'target');
      const previous = task.target ?? { kind: 'new_once' };
      // 面板保存时总会把整个 target 带回来，只有真的换了执行位置才丢掉记住的会话，
      // 否则改个标题都会让「新建会话并复用」从下一轮开始另起一个会话。
      const changed = next.kind !== previous.kind
        || (next.kind === 'existing' && next.sessionId !== previous.sessionId);
      task.target = next;
      if (changed) {
        task.state = task.state ?? {};
        delete task.state.targetSessionId;
      }
    }
    if (patch.tags !== undefined) task.tags = Array.isArray(patch.tags) ? patch.tags.slice(0, 10) : [];
    if (patch.workspace !== undefined) {
      const workspace = normalizeWorkspace(patch.workspace);
      if (workspace !== task.workspace) {
        // 任务整份数据跟着工作区走，所以换工作区就是换存储文件。
        await this.#assertWorkspace(workspace);
        this.store.remove(task.id);
        task.workspace = workspace;
        moved = true;
      }
    }
    if (patch.schedule !== undefined) {
      task.schedule = normalizeSchedule(patch.schedule, task.timeZone ?? this.options.timeZone);
      task.state.nextRunAt = null;
    }

    task.updatedAt = new Date().toISOString();
    if (moved) {
      await this.store.insert(task);
      await this.#book(task.workspace);
    }
    if (task.enabled && (!task.state.nextRunAt || patch.schedule !== undefined || patch.enabled === true)) {
      const next = computeNextRun(task, Date.now());
      task.state.nextRunAt = next === null ? null : new Date(next).toISOString();
    }
    if (!task.enabled) task.state.nextRunAt = null;
    await this.store.saveWorkspace(task.workspace);
    if (moved) await this.store.saveWorkspace(previousWorkspace);
    this.emit('tasks/changed');
    this.#schedule();
    return publicTask(task);
  }

  async remove(id) {
    const task = this.store.find(id);
    if (!task) throw new TaskError(`找不到任务 ${id}`, 'not_found');
    await this.store.remove(id);
    await this.store.saveWorkspace(task.workspace);
    const sessions = await this.#retireSessions(task);
    this.emit('tasks/changed');
    this.#schedule();
    return { removed: true, id, sessions };
  }

  /** 工作区登记表挂在 workspaceRegistry 名下，旧名兜一下，省得跟着宿主改名。 */
  #workspaceRegistry() {
    for (const name of ['workspaceRegistry', 'workspace', 'workspaces']) {
      let service;
      try {
        service = this.ctx?.get?.(name);
      } catch {
        service = undefined;
      }
      if (typeof service?.archiveSession === 'function') return service;
    }
    return null;
  }

  /**
   * 任务建出来的会话跟着任务一起退场。
   *
   * 平台没有硬删会话的接口，归档就是它自己的语言：会话从各处列表里消失、正在跑的工作
   * 停掉，需要时还能从归档里捞回来。用「关联已有会话」的任务动的是用户自己的会话，
   * 一个都不碰。
   */
  async #retireSessions(task) {
    const result = { archived: 0, skipped: 0, failed: 0 };
    if (task.target?.kind === 'existing') return result;
    const ids = new Set();
    if (typeof task.state?.targetSessionId === 'string') ids.add(task.state.targetSessionId);
    try {
      for (const run of await this.store.readRuns({ taskId: task.id, limit: 1000 })) {
        if (typeof run?.sessionId === 'string') ids.add(run.sessionId);
      }
    } catch (error) {
      this.logger.warn?.('[dsh-cron] 读运行历史失败，只按任务记下的会话收尾', error);
    }
    if (ids.size === 0) return result;
    const registry = this.#workspaceRegistry();
    if (!registry) {
      result.skipped = ids.size;
      return result;
    }
    for (const sessionId of ids) {
      try {
        await registry.archiveSession(sessionId, { stopActivity: true });
        result.archived += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn?.(`[dsh-cron] 归档会话 ${sessionId} 失败：${error?.message ?? error}`);
      }
    }
    return result;
  }

  async pause(id) {
    return this.edit(id, { enabled: false });
  }

  async resume(id) {
    return this.edit(id, { enabled: true });
  }

  async notepad(id, patch) {
    const task = this.requireTask(id);
    if (patch === undefined) return { ...(task.notepad ?? {}) };
    // null 表示清空：展开 null 不会删键，得显式处理。
    task.notepad = patch === null ? {} : { ...(task.notepad ?? {}), ...patch };
    task.updatedAt = new Date().toISOString();
    await this.store.saveWorkspace(task.workspace);
    return { ...task.notepad };
  }

  // ------------------------------------------------------------- running

  /** Tick: admit every due task of every workspace subject to the concurrency limit. */
  #clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * 按最早到期时间重新定时。挑最晚醒来的边界：到期点、时钟上限、兜底巡检。
   * 一个启用的任务都没有时不挂任何定时器，进程完全空闲。
   */
  #schedule() {
    if (this.stopped) return;
    this.#clearTimer();
    const now = Date.now();
    let earliest = null;
    for (const task of this.store.all()) {
      if (!task.enabled) continue;
      const at = Date.parse(task.state?.nextRunAt);
      if (!Number.isFinite(at)) continue;
      earliest = earliest === null ? at : Math.min(earliest, at);
    }
    if (earliest === null) return;
    const delay = Math.max(0, Math.min(earliest - now, MAX_TIMER_DELAY_MS, this.options.sweepMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick()
        .catch((error) => this.logger.warn?.('[dsh-cron] tick 失败', error))
        .finally(() => this.#schedule());
    }, delay);
    this.timer.unref?.();
  }

  async tick() {
    if (this.stopped || this.tickLock) return;
    this.tickLock = true;
    const held = [];
    try {
      this.lastTickAt = new Date().toISOString();
      const now = Date.now();
      for (const entry of this.store.entries()) {
        const due = entry.tasks.filter((task) => isDue(task, now) && !task.state?.executing);
        if (due.length === 0) continue;
        const lock = this.#lock(entry.workspace);
        const locked = await lock.acquire();
        if (!locked) continue; // 另一个进程正在跑这个工作区
        held.push(lock);
        for (const task of due) {
          if (this.running.size >= this.options.maxConcurrent) break;
          this.launch(task, 'schedule');
        }
      }
    } finally {
      for (const lock of held) await lock.release().catch(() => {});
      this.tickLock = false;
    }
  }

  /** Manual trigger that never consumes a scheduled occurrence. */
  async runNow(id) {
    const task = this.requireTask(id);
    if (task.state?.executing) throw new TaskError('该任务正在执行中', 'busy');
    return this.execute(task, 'manual');
  }

  launch(task, trigger) {
    const controller = new AbortController();
    this.running.add(controller);
    const promise = this.execute(task, trigger, controller.signal)
      .catch((error) => {
        this.logger.warn?.(`[dsh-cron] 任务 ${task.id} 执行异常`, error);
      })
      .finally(() => {
        this.running.delete(controller);
      });
    return promise;
  }

  /**
   * Run one task once and record the outcome.
   * @param {object} task stored task record
   * @param {'schedule'|'manual'} trigger
   */
  async execute(task, trigger, signal) {
    const startedAt = Date.now();
    task.state = task.state ?? {};
    task.state.executing = true;
    const run = {
      runId: `run-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.id,
      workspace: task.workspace,
      title: task.title,
      mode: task.mode,
      trigger,
      startedAt: new Date(startedAt).toISOString(),
      status: 'running',
    };

    const limit = task.timeoutMs ?? this.options.timeLimitMs;
    const attempts = (task.retries ?? 0) + 1;
    let outcome = { status: 'ok' };
    let used = 0;
    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        used = attempt;
        const final = attempt === attempts;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), limit);
        const onOuterAbort = () => controller.abort();
        signal?.addEventListener('abort', onOuterAbort, { once: true });
        try {
          outcome = await this.#runOnce(task, controller.signal, run, final);
        } catch (error) {
          outcome = {
            status: controller.signal.aborted ? 'timeout' : 'failed',
            error: error?.message ?? String(error),
          };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onOuterAbort);
        }
        // 超时和成功都不再重试：超时说明这次就是跑不完，重试只会更糟。
        if (outcome.status !== 'failed' || final) break;
        await sleep(attempt * (task.retryDelayMs ?? this.options.retryDelayMs ?? 5_000), signal);
      }
    } finally {
      task.state.executing = false;
    }

    run.endedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedAt;
    run.status = outcome.status;
    if (outcome.exitCode !== undefined) run.exitCode = outcome.exitCode;
    if (outcome.output) run.output = outcome.output;
    if (outcome.error) run.error = outcome.error;
    if (outcome.delivered !== undefined) run.delivered = outcome.delivered;
    if (outcome.deliveryReason) run.deliveryReason = outcome.deliveryReason;
    if (outcome.dispatched !== undefined) run.dispatched = outcome.dispatched;
    if (outcome.sessionId) run.sessionId = outcome.sessionId;
    if (outcome.targetSessionId) run.targetSessionId = outcome.targetSessionId;
    if (outcome.path) run.path = outcome.path;
    if (outcome.modelApplied) run.modelApplied = outcome.modelApplied;
    if (outcome.clearedContext) run.clearedContext = outcome.clearedContext;
    if (outcome.permissionApplied) run.permissionApplied = outcome.permissionApplied;
    if (used > 1) run.attempts = used;

    // Bookkeeping and rescheduling.
    task.runCount = (task.runCount ?? 0) + 1;
    task.state.lastRunAt = run.startedAt;
    task.state.lastResult = run.status;
    task.state.lastOutput = outcome.output ?? task.state.lastOutput ?? null;
    task.state.consecutiveFailures = run.status === 'ok'
      ? 0
      : (task.state.consecutiveFailures ?? 0) + 1;

    // 一个任务同时只有一条未处理故障，恢复正常的那次运行负责关掉它。
    try {
      const book = await this.#book(task.workspace);
      if (run.status === 'ok') {
        await book.resolve(task.id);
      } else {
        run.incidentId = (await book.record(task, run))?.id;
      }
    } catch (error) {
      this.logger.warn?.('[dsh-cron] 记录 incident 失败', error);
    }

    const next = computeNextRun(task, Date.now());
    task.state.nextRunAt = next === null ? null : new Date(next).toISOString();
    task.updatedAt = new Date().toISOString();

    await this.store.appendRun(run);
    await this.store.saveWorkspace(task.workspace);
    this.#schedule();
    this.emit('run/finished', run);
    this.emit('tasks/changed');
    return run;
  }

  async #runOnce(task, signal, run, final = true) {
    if (task.mode === 'script') {
      const result = await runScript(task.script, {
        signal,
        timeoutMs: task.timeoutMs ?? this.options.timeLimitMs,
        cwd: task.workspace,
      });
      const timedOut = result.timedOut || signal.aborted;
      const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (result.exitCode !== 0 || timedOut) {
        if (final) await this.#notifyFailure(task, text || `退出码 ${result.exitCode ?? 'null'}${timedOut ? '（超时）' : ''}`);
        return {
          status: timedOut ? 'timeout' : 'failed',
          exitCode: result.exitCode,
          output: text,
          error: timedOut ? '执行超时' : `退出码 ${result.exitCode}`,
        };
      }
      // 推送正文只认 stdout：脚本想说话就往 stdout 写，不想打扰就一个字都别写；
      // stderr 只进运行记录（出问题时也进失败通知），免得一句 warning 变成一条推送。
      return { status: 'ok', exitCode: result.exitCode, output: text, ...(await this.#deliver(task, result.stdout)) };
    }

    const prompt = this.#composePrompt(task);
    const dispatched = await this.dispatcher.dispatch(
      {
        title: `[cron] ${task.title}`,
        prompt,
        cwd: task.agent?.workdir ?? task.workspace,
        agentPreset: task.agent?.preset,
        provider: task.agent?.provider,
        model: task.agent?.model,
        permission: task.permission,
        target: task.target ?? { kind: 'new_once' },
        reusedSessionId: task.state?.targetSessionId,
        // 复用同一个会话，却不想带着上一轮的上下文跑。
        clearContext: (task.target ?? {}).freshContext !== false,
        taskId: task.id,
      },
      signal,
    );
    if (!dispatched.dispatched) {
      if (final) await this.#notifyFailure(task, dispatched.reason, { sessionId: dispatched.sessionId });
      return { status: 'failed', error: dispatched.reason, output: '' };
    }

    if (dispatched.reusedSessionId) {
      task.state = task.state ?? {};
      task.state.targetSessionId = dispatched.reusedSessionId;
    }
    const silent = isSilentAnswer(dispatched.output);
    const answer = stripSilentMarker(dispatched.output ?? '');
    return {
      status: 'ok',
      output: answer,
      dispatched: true,
      sessionId: dispatched.sessionId,
      targetSessionId: task.state?.targetSessionId ?? dispatched.sessionId,
      path: dispatched.path,
      ...(dispatched.modelApplied ? { modelApplied: dispatched.modelApplied } : {}),
      ...(dispatched.clearedContext ? { clearedContext: dispatched.clearedContext } : {}),
      ...(dispatched.permissionApplied ? { permissionApplied: dispatched.permissionApplied } : {}),
      ...(silent
        ? { delivered: false, deliveryReason: '本轮按模型要求静默' }
        : answer ? await this.#deliver(task, answer, { sessionId: dispatched.sessionId }) : {}),
    };
  }

  /** Compose the prompt handed to the model. */
  #composePrompt(task, { extra = '' } = {}) {
    const parts = [];
    if (task.prompt) parts.push(task.prompt.trim());
    if (task.delivery && task.delivery.kind !== 'silent') parts.push(SILENT_HINT);
    if (extra) parts.push(extra);
    if (task.agent?.continuity && task.state?.lastOutput) {
      parts.push(`你上次这条任务的输出如下，可以据此去重或接着上次的进度：\n\n${clip(task.state.lastOutput, 4000)}`);
    }
    const contextFrom = task.agent?.contextFrom ?? [];
    if (contextFrom.length > 0) {
      const blocks = [];
      for (const otherId of contextFrom) {
        const other = this.store.find(otherId);
        if (!other?.state?.lastOutput) continue;
        blocks.push(`【任务 ${other.title} 的上次产物】\n${clip(other.state.lastOutput, 3000)}`);
      }
      if (blocks.length > 0) parts.push(blocks.join('\n\n'));
    }
    return parts.join('\n\n');
  }

  /** 成功失败共用一个投递配置：静默就什么都不发。 */
  async #deliver(task, text, runSession = {}) {
    if (!text) return { delivered: false, deliveryReason: '无输出，保持静默' };
    if (!task.delivery || task.delivery.kind === 'silent') {
      return { delivered: false, deliveryReason: '静默' };
    }
    const sent = await this.delivery.send(task.delivery, text, runSession);
    return { delivered: sent.sent, deliveryReason: sent.reason };
  }

  async #notifyFailure(task, text, runSession = {}) {
    if (!task.delivery || task.delivery.kind === 'silent') return;
    const body = `【定时任务失败】${task.title}\n${clip(String(text ?? '未知错误'), 1500)}`;
    await this.delivery.send(task.delivery, body, runSession);
  }

  /** 可建任务的工作区：已登记的在前，主机登记过但还没任务的在后面。 */
  listWorkspaces() {
    const items = new Map()
    for (const workspace of this.store.listWorkspaces()) items.set(workspace.path, { ...workspace, registered: true })
    for (const workspace of this.#hostWorkspaces()) {
      if (!items.has(workspace.path)) items.set(workspace.path, { ...workspace, taskCount: 0, registered: false })
    }
    return [...items.values()]
  }

  /** 主机的工作区登记表；取不到就返回空，不影响自定义路径。 */
  #hostWorkspaces() {
    const found = []
    try {
      const registry = this.ctx?.get?.('workspaceRegistry')
      for (const workspace of registry?.list?.() ?? []) {
        if (typeof workspace?.path !== 'string' || !workspace.path.startsWith('/')) continue
        found.push({ path: workspace.path, name: workspace.title ?? workspace.path })
      }
    } catch (error) {
      this.logger.warn?.('[dsh-cron] 读取主机工作区失败', error)
    }
    return found
  }

  async history(taskId, limit = 50) {
    return this.store.readRuns({ taskId, limit });
  }

  /** Long-running failure rows; `status` filters open / resolved / acked. */
  incidents(status) {
    const merged = [];
    for (const [workspace, book] of this.books) {
      for (const incident of book.list(status ? { status } : {})) {
        merged.push({ ...incident, workspace });
      }
    }
    return merged.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  async ackIncident(id) {
    for (const book of this.books.values()) {
      const incident = await book.ack(id);
      if (incident) return incident;
    }
    throw new TaskError(`找不到故障记录 ${id}`, 'not_found');
  }

  /** 选择器预览：面板改时间时立刻能看到接下来几次执行。 */
  preview(input) {
    return previewSchedule(input, {
      from: Date.now(),
      timeZone: this.options.timeZone,
      count: 3,
    });
  }

  /** Self-check that points at what is actually wrong rather than restating the config. */
  health() {
    const problems = [];
    for (const task of this.store.all()) {
      if (!task.enabled) continue;
      if (task.mode === 'agent' && !task.prompt) {
        problems.push({ taskId: task.id, title: task.title, issue: '缺 prompt，模型模式会空转' });
      }
      if (task.mode === 'script' && !task.script?.command) {
        problems.push({ taskId: task.id, title: task.title, issue: '缺脚本命令' });
      }
      if (task.mode === 'agent' && !this.dispatcher.available()) {
        // 这台宿主没装会话控制器，agent 任务到点只会失败，提前说清楚。
        problems.push({ taskId: task.id, title: task.title, issue: '当前环境没有 sessionController，agent 任务跑不了' });
      }
      const exhausted = Number.isInteger(task.repeat) && task.runCount >= task.repeat;
      const onceDone = task.schedule?.kind === 'once' && task.runCount > 0;
      if (!task.state?.nextRunAt && !exhausted && !onceDone) {
        problems.push({ taskId: task.id, title: task.title, issue: '启用但没有下次执行时间' });
      }
      try {
        // 存盘里的调度对象才是唯一真相：迁移失败的任务会以畸形 cron 躺在这里。
        normalizeSchedule(task.schedule, task.timeZone ?? this.options.timeZone);
      } catch (error) {
        const message = error instanceof CronError ? error.message : error?.message ?? String(error);
        problems.push({ taskId: task.id, title: task.title, issue: `调度有问题：${message}` });
      }
      // im 投递允许只写别名（聊天里建任务拿不到 id），运行时才解析；只有显式 id 写残了才算问题。
      const im = task.delivery?.kind === 'im' ? task.delivery : null;
      if (im && Boolean(im.botId) !== Boolean(im.targetId)) {
        problems.push({ taskId: task.id, title: task.title, issue: '投递目标不完整：botId 和 targetId 要么都给，要么都别给' });
      }
      // 回原会话要有个会话：脚本任务没有自己的会话，两样都没有就发不出去。
      if (task.delivery?.kind === 'origin' && task.mode === 'script'
        && !task.delivery.sessionId && !task.delivery.conversationKey) {
        problems.push({ taskId: task.id, title: task.title, issue: '回原会话缺会话，脚本任务没地方发' });
      }
      if (task.delivery?.kind === 'session' && !task.delivery.sessionId && task.mode === 'script') {
        // 脚本任务不建会话，写会话日志得自己指定一个。
        problems.push({ taskId: task.id, title: task.title, issue: '脚本任务写会话日志要指定会话' });
      }
      if (!task.workspace) {
        problems.push({ taskId: task.id, title: task.title, issue: '缺工作区' });
      }
    }
    return {
      ok: problems.length === 0,
      problems,
      delivery: { available: this.delivery.available() },
      dispatcher: { available: this.dispatcher.available() },
      openIncidents: [...this.books.values()].reduce((sum, book) => sum + book.openCount(), 0),
      disableBuiltinSchedule: this.options.disableBuiltinSchedule === true,
    };
  }
}

function normalizeRetries(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 5) throw new TaskError('retries 需要是 0..5 的整数');
  return count;
}

function normalizeTaskTimeout(value) {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1_000 || ms > 3_600_000) throw new TaskError('timeoutMs 需要是 1000..3600000 的整数');
  return ms;
}

function normalizeRepeat(value) {
  if (value === null) return null;
  const repeat = Number(value);
  if (!Number.isInteger(repeat) || repeat < 1) throw new TaskError('repeat 需要是 >= 1 的整数');
  return repeat;
}

function clip(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…（已截断，原长 ${value.length} 字符）`;
}
