import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../lib/api/http.js';
import { Delivery } from '../lib/runtime/deliver.js';
import { call, fakeContext, logger, makeService, routeHandler } from './helpers.js';

/** 起服务 + 挂路由，拿到一个能直接打 handler 的客户端。 */
async function makeApi({ workspaceCount = 1 } = {}) {
  const harness = await makeService({ workspaceCount });
  const { ctx, routes } = fakeContext();
  registerRoutes({ ...ctx, webServer: { register: (route) => { routes.push(route); return () => {}; } } }, harness.service, harness.delivery, { warn() {} });
  const handler = routeHandler(routes);
  const api = (method, route, body) => call(handler, method, `/dsh-cron${route}`, body);
  return { ...harness, api };
}

test('GET /api/status 反映运行状态与工作区', async () => {
  const { api, service, workspaces } = await makeApi();
  try {
    await service.create({
      title: '甲', workspace: workspaces[0], mode: 'script', script: 'true', schedule: { kind: 'hourly', minute: 0 },
    });
    const { status, body } = await api('GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.running, true);
    assert.equal(body.taskCount, 1);
    assert.equal(body.timeZone, 'Asia/Shanghai');
    assert.deepEqual(body.delivery, { available: true });
    assert.deepEqual(body.workspaces.map((item) => item.path), [workspaces[0]]);
    assert.ok(body.lastTickAt);
  } finally {
    await service.stop();
  }
});

test('任务 CRUD 全流程', async () => {
  const { api, service, workspaces } = await makeApi();
  try {
    const created = await api('POST', '/api/tasks', {
      title: '早报',
      workspace: workspaces[0],
      mode: 'agent',
      prompt: '写早报',
      schedule: { kind: 'daily', time: '09:00' },
      delivery: { kind: 'silent' },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.task.title, '早报');
    assert.equal(created.body.task.scheduleText, '每天 09:00');
    const id = created.body.task.id;

    const list = await api('GET', '/api/tasks');
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].workspace, workspaces[0]);

    const view = await api('GET', `/api/tasks/${id}`);
    assert.equal(view.body.task.id, id);

    const patched = await api('PATCH', `/api/tasks/${id}`, { schedule: { kind: 'every-minutes', interval: 15 } });
    assert.equal(patched.body.task.scheduleText, '每 15 分钟');

    const paused = await api('POST', `/api/tasks/${id}/pause`);
    assert.equal(paused.body.task.enabled, false);
    assert.equal(paused.body.task.state.nextRunAt, null);
    const resumed = await api('POST', `/api/tasks/${id}/resume`);
    assert.equal(resumed.body.task.enabled, true);
    assert.ok(resumed.body.task.state.nextRunAt);

    const runs = await api('GET', `/api/tasks/${id}/runs?limit=5`);
    assert.deepEqual(runs.body.runs, []);

    const removed = await api('DELETE', `/api/tasks/${id}`);
    assert.deepEqual(removed.body.removed, true);
    assert.equal((await api('GET', '/api/tasks')).body.items.length, 0);
    await service.stop();
  } catch (error) {
    await service.stop();
    throw error;
  }
});

test('POST /api/tasks/:id/run 立刻跑一次并进历史', async () => {
  const { api, service, workspaces } = await makeApi();
  try {
    const created = await api('POST', '/api/tasks', {
      title: '跑一次', workspace: workspaces[0], mode: 'script', script: 'echo 跑了',
      schedule: { kind: 'every-minutes', interval: 5 }, delivery: { kind: 'silent' },
    });
    const id = created.body.task.id;
    const run = await api('POST', `/api/tasks/${id}/run`);
    assert.equal(run.status, 200);
    assert.equal(run.body.run.status, 'ok');
    assert.match(run.body.run.output, /跑了/);

    const global = await api('GET', '/api/runs?limit=10');
    assert.equal(global.body.runs.length, 1);
    assert.equal(global.body.runs[0].taskId, id);
    assert.equal(global.body.runs[0].workspace, workspaces[0]);
  } finally {
    await service.stop();
  }
});

test('POST /api/preview 给中文描述和至少两条递增时间', async () => {
  const { api, service } = await makeApi();
  try {
    const { status, body } = await api('POST', '/api/preview', { schedule: { kind: 'monthly', dayOfMonth: 3, time: '01:30' } });
    assert.equal(status, 200);
    assert.equal(body.text, '每月 3 日 01:30');
    assert.ok(Array.isArray(body.next));
    assert.ok(body.next.length >= 2);
    for (let index = 1; index < body.next.length; index += 1) {
      assert.ok(Date.parse(body.next[index]) > Date.parse(body.next[index - 1]));
    }
    // 预览是纯计算，不落盘、不登记工作区
    assert.deepEqual((await api('GET', '/api/workspaces')).body.items, []);
    assert.deepEqual((await api('GET', '/api/tasks')).body.items, []);
  } finally {
    await service.stop();
  }
});

test('没登记任何工作区时 /api/workspaces 返回空数组', async () => {
  const { api, service } = await makeApi();
  try {
    const { status, body } = await api('GET', '/api/workspaces');
    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
  } finally {
    await service.stop();
  }
});

test('没装 dsh-im 时 /api/targets 返回不可用', async () => {
  const harness = await makeService();
  const delivery = new Delivery({ get: () => undefined }, logger);
  // 真实部署里服务与路由共用同一个 Delivery 实例
  harness.service.delivery = delivery;
  const { ctx, routes } = fakeContext();
  registerRoutes({ ...ctx, webServer: { register: (route) => { routes.push(route); return () => {}; } } }, harness.service, delivery, logger);
  const api = (method, route, body) => call(routeHandler(routes), method, `/dsh-cron${route}`, body);
  try {
    const targets = await api('GET', '/api/targets');
    assert.equal(targets.status, 200);
    assert.equal(targets.body.available, false);
    assert.deepEqual(targets.body.bots, []);
    const status = await api('GET', '/api/status');
    assert.equal(status.body.delivery.available, false);
  } finally {
    await harness.service.stop();
  }
});

test('GET /api/workspaces 与 /api/targets', async () => {
  const { api, service, workspaces } = await makeApi({ workspaceCount: 2 });
  try {
    await service.create({
      title: '甲', workspace: workspaces[0], mode: 'script', script: 'true', schedule: { kind: 'hourly', minute: 0 },
    });
    await service.create({
      title: '乙', workspace: workspaces[1], mode: 'script', script: 'true', schedule: { kind: 'hourly', minute: 30 },
    });
    const list = await api('GET', '/api/workspaces');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((item) => item.path).sort(), [...workspaces].sort());
    assert.equal(list.body.items.find((item) => item.path === workspaces[0]).taskCount, 1);
    assert.equal(list.body.items.find((item) => item.path === workspaces[1]).taskCount, 1);
    assert.equal(typeof list.body.items[0].name, 'string');

    const targets = await api('GET', '/api/targets');
    assert.equal(targets.status, 200);
    assert.equal(targets.body.available, true);
    assert.ok(Array.isArray(targets.body.bots));
  } finally {
    await service.stop();
  }
});

test('GET /api/health 与 /api/incidents、ack', async () => {
  const { api, service, workspaces } = await makeApi();
  try {
    const created = await api('POST', '/api/tasks', {
      title: '会挂的', workspace: workspaces[0], mode: 'script', script: 'false',
      schedule: { kind: 'every-minutes', interval: 5 }, delivery: { kind: 'silent' },
    });
    await api('POST', `/api/tasks/${created.body.task.id}/run`);

    const health = await api('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(typeof health.body.health.ok, 'boolean');
    assert.ok('openIncidents' in health.body.health);

    const incidents = await api('GET', '/api/incidents?status=open');
    assert.equal(incidents.body.incidents.length, 1);
    const incidentId = incidents.body.incidents[0].id;
    assert.equal(incidents.body.incidents[0].workspace, workspaces[0]);

    const acked = await api('POST', `/api/incidents/${incidentId}/ack`);
    assert.equal(acked.body.incident.status, 'acked');
    assert.equal((await api('GET', '/api/incidents?status=open')).body.incidents.length, 0);
    assert.equal((await api('GET', '/api/incidents?status=acked')).body.incidents.length, 1);
  } finally {
    await service.stop();
  }
});

test('错误统一 {ok:false,error}：400 校验失败、404 找不到', async () => {
  const { api, service, workspaces } = await makeApi();
  try {
    const invalid = await api('POST', '/api/tasks', {
      title: '缺工作区', mode: 'script', script: 'true', schedule: { kind: 'hourly', minute: 0 },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.ok, false);
    assert.match(invalid.body.error, /workspace/);

    const badSchedule = await api('POST', '/api/preview', { schedule: { kind: 'weekly', weekday: 9, time: '09:00' } });
    assert.equal(badSchedule.status, 400);
    assert.equal(badSchedule.body.code, 'invalid');

    const missing = await api('GET', '/api/tasks/cron-nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');

    const missingAck = await api('POST', '/api/incidents/inc-nope/ack');
    assert.equal(missingAck.status, 404);

    const unknown = await api('GET', '/api/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.ok, false);
    void workspaces;
  } finally {
    await service.stop();
  }
});

test('不再由后端提供 HTML 页面', async () => {
  const { api, service } = await makeApi();
  try {
    for (const route of ['/', '/index.html', '/ui/index.html']) {
      const response = await api('GET', route);
      assert.equal(response.status, 404, route);
      assert.equal(response.body.ok, false);
    }
    const css = await api('GET', '/ui/index.html');
    assert.equal(css.headers['content-type'], 'application/json; charset=utf-8');
  } finally {
    await service.stop();
  }
});

test('GET /api/sessions 只列该工作区的会话', async () => {
  const { api, service, workspaces } = await makeApi();
  try {
    const { ctx, routes } = fakeContext();
    const summaries = [
      { sessionId: 'session-a', cwd: workspaces[0], title: '甲', updatedAt: '2026-11-10T09:00:00.000Z' },
      { sessionId: 'session-b', cwd: '/somewhere/else', title: '乙', updatedAt: '2026-11-10T10:00:00.000Z' },
      { sessionId: 'session-c', title: '没有 cwd' },
      { sessionId: 'session-d', cwd: workspaces[0], updatedAt: '2026-11-11T09:00:00.000Z' },
    ];
    const ctxWithSessions = { ...ctx, get: (key) => key === 'sessionController' ? { list: async () => summaries } : undefined };
    registerRoutes({ ...ctxWithSessions, webServer: { register: (route) => { routes.push(route); return () => {}; } } }, service, new Delivery(ctxWithSessions, { warn() {} }), { warn() {} });
    const handler = routeHandler(routes);

    const response = await call(handler, 'GET', `/dsh-cron/api/sessions?workspace=${encodeURIComponent(workspaces[0])}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.available, true);
    assert.deepEqual(response.body.items.map((item) => item.sessionId), ['session-d', 'session-a']);
    assert.equal(response.body.items[1].title, '甲');
  } finally {
    await service.stop();
  }
});

test('GET /api/sessions 没有 sessionController 时降级', async () => {
  const { api } = await makeApi();
  const response = await api('GET', '/api/sessions?workspace=/tmp/ws');
  assert.equal(response.status, 200);
  assert.equal(response.body.available, false);
  assert.deepEqual(response.body.items, []);
});

// ---------------------------------------------------------------- 会话日志回落到本次运行

test('写会话日志没指定会话时，写到这次运行自己的会话', async () => {
  const appended = [];
  const sessions = {
    get: (id) => ({ append: (type, data) => appended.push({ id, type, text: data.message.content[0].text }) }),
    flush: async () => {},
  };
  const delivery = new Delivery({ get: (name) => (name === 'sessions' ? sessions : undefined) }, logger);

  const fallback = await delivery.send({ kind: 'session' }, '任务输出', { sessionId: 's-run' });
  assert.equal(fallback.sent, true);
  assert.deepEqual(appended, [{ id: 's-run', type: 'assistant/message', text: '任务输出' }]);

  const explicit = await delivery.send({ kind: 'session', sessionId: 's-picked' }, '另一段', { sessionId: 's-run' });
  assert.equal(explicit.sent, true);
  assert.equal(appended[1].id, 's-picked');

  const none = await delivery.send({ kind: 'session' }, '没有会话', {});
  assert.equal(none.sent, false);
  assert.equal(none.skipped, true);
});
