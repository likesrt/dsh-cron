/**
 * 测试公用：临时工作区、假投递/派发、HTTP 调用壳子。
 * 不叫 *.test.js，不会被 node --test 当成用例文件。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CronService } from '../lib/runtime/service.js';
import { MultiStore } from '../lib/data/store.js';

export const logger = { info() {}, warn() {}, error() {}, debug() {} };

export async function tempDir(prefix = 'dsh-cron-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * 起一个真实服务：真 MultiStore（临时登记表 + 临时工作区），假投递和假派发。
 */
export async function makeService({ workspaceCount = 1, options = {}, ctx = {} } = {}) {
  const root = await tempDir();
  const registryPath = path.join(root, 'registry', 'workspaces.json');
  const workspaces = [];
  for (let index = 0; index < workspaceCount; index += 1) {
    const dir = path.join(root, `ws-${index + 1}`);
    await fs.mkdir(dir, { recursive: true });
    workspaces.push(dir);
  }

  const store = new MultiStore({ registryPath, timeZone: options.timeZone ?? 'Asia/Shanghai' });
  const sent = [];
  const delivery = {
    available: () => true,
    send: async (target, text) => {
      sent.push({ target, text });
      return { sent: true };
    },
    listTargets: async () => ({ available: true, bots: [] }),
  };
  const dispatches = [];
  const dispatcher = {
    available: () => true,
    dispatch: async (request) => {
      dispatches.push(request);
      return { dispatched: true, output: '模型给的答案', sessionId: 'session-1', path: 'session' };
    },
  };

  const service = new CronService({
    ctx,
    store,
    delivery,
    dispatcher,
    logger,
    options: {
      timeZone: 'Asia/Shanghai',
      maxConcurrent: 2,
      sweepMs: 3_600_000,
      ...options,
    },
  });
  await service.start();
  return { service, store, delivery, dispatcher, sent, dispatches, workspaces, root, registryPath };
}

/** cordis 宿主上下文的最小替身：够 apply 用。 */
export function fakeContext({ services = {} } = {}) {
  const disposers = [];
  const tools = [];
  const routes = [];
  const provided = new Map();
  const listeners = new Map();
  const ctx = {
    logger,
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => dispose?.();
    },
    tools: { register: (tool) => tools.push(tool) },
    webServer: {
      register: (route) => {
        routes.push(route);
        return () => {};
      },
    },
    provide: (key, value) => provided.set(key, value),
    get: (name) => services[name],
    on(event, handler) {
      listeners.get(event)?.push(handler) ?? listeners.set(event, [handler]);
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };
  return { ctx, tools, routes, provided, disposers, listeners };
}

function fakeRequest(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  return stream;
}

function fakeResponse() {
  const chunks = [];
  return {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

/** 直接打路由 handler，不占端口。 */
export async function call(handler, method, url, body) {
  const res = fakeResponse();
  await handler(fakeRequest(method, url, body), res);
  const raw = res.text();
  return { status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null };
}

/** 取 registers 里挂上的 /dsh-cron 路由处理器。 */
export function routeHandler(routes) {
  const route = routes.find((item) => item.path === '/dsh-cron');
  if (!route) throw new Error('没有注册 /dsh-cron 路由');
  return route.handler;
}
