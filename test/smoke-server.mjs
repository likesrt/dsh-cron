/**
 * 脱离宿主的冒烟服务：真服务 + 真路由，临时工作区和临时登记表。
 * 用来手动点接口，不写真实 $DSH_HOME。
 * 跑法：node test/smoke-server.mjs [port]
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CronService } from '../lib/runtime/service.js';
import { MultiStore } from '../lib/data/store.js';
import { Delivery } from '../lib/runtime/deliver.js';
import { Dispatcher } from '../lib/runtime/dispatch.js';
import { registerRoutes } from '../lib/api/http.js';

const port = Number(process.argv[2] ?? 13999);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cron-smoke-'));
const workspace = path.join(root, 'ws');
await fs.mkdir(workspace, { recursive: true });

const store = new MultiStore({
  registryPath: path.join(root, 'registry', 'workspaces.json'),
  timeZone: 'Asia/Shanghai',
});

const sent = [];
const ctx = {
  get: (name) => (name === 'dshIm'
    ? {
      listBots: async () => [{ botId: 'bot-wecom', channel: 'wecom' }],
      listTargets: async () => [{ targetId: 'ops', name: '运维群', kind: 'group', route: { chatId: 'ops' } }],
      send: async (botId, target, text) => {
        sent.push({ botId, target, text });
        return { sent: true };
      },
    }
    : undefined),
};

const delivery = new Delivery(ctx, console);
const dispatcher = new Dispatcher(ctx, console);
const service = new CronService({ ctx, store, delivery, dispatcher, options: { timeZone: 'Asia/Shanghai' } });
await service.start();

await service.create({
  title: '示例：每 15 分钟',
  workspace,
  mode: 'script',
  script: 'echo 示例输出',
  schedule: { kind: 'every-minutes', interval: 15 },
  delivery: { kind: 'silent' },
});

const routes = [];
const fakeWeb = {
  register: (route) => {
    routes.push(route);
    return () => {};
  },
};
registerRoutes({ ...ctx, webServer: fakeWeb }, service, delivery, console);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const route = routes.find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
  if (!route) {
    res.writeHead(404).end('not found');
    return;
  }
  route.handler(req, res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dsh-cron API: http://127.0.0.1:${port}/dsh-cron/api/status`);
  console.log(`工作区 ${workspace}（登记表在 ${path.join(root, 'registry')}）`);
});

process.on('SIGTERM', async () => {
  await service.stop();
  server.close();
});
