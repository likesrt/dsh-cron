import test from 'node:test';
import assert from 'node:assert/strict';
import { createCronTools } from '../lib/api/tools.js';

/** 只关心工具编排：service 用最小替身，记下它收到什么。 */
function fakeService({ origin = null, resolved = null } = {}) {
  const created = [];
  const patched = [];
  return {
    created,
    patched,
    delivery: {
      listTargets: async () => ({ available: true, bots: [] }),
      originDelivery: async (sessionId) => (origin === null ? null : { ...origin, sessionId }),
      resolve: async (value) => resolved ?? (value.target === 'yuyan' ? { botId: 'wecomapp_beb5', targetId: 'tgt_7be9' } : { reason: '没匹配上' }),
    },
    async create(input) {
      created.push(input);
      return { id: 'cron-1', title: input.title, mode: 'script', workspace: input.workspace, scheduleText: '', state: {} };
    },
    async edit(id, patch) {
      patched.push({ id, patch });
      return { id, title: 'x' };
    },
  };
}

const tool = (service, name) => createCronTools(service).find((item) => item.name === name);
const exec = (sessionId) => ({ agent: { session: { id: sessionId } } });

const base = { title: '早报', workspace: '/tmp/ws', schedule: { kind: 'daily', time: '09:00' }, script: 'true' };

test('从聊天里建任务：不写推送就发回这个聊天', async () => {
  const service = fakeService({ origin: { kind: 'origin' } });
  await tool(service, 'cron_create').execute({ ...base }, exec('session-chat'));
  assert.deepEqual(service.created[0].delivery, { kind: 'origin', sessionId: 'session-chat' });
});

test('Web 端建的会话没绑聊天：结果写回这个会话', async () => {
  const service = fakeService({ origin: null });
  await tool(service, 'cron_create').execute({ ...base }, exec('session-web'));
  assert.deepEqual(service.created[0].delivery, { kind: 'session', sessionId: 'session-web' });
});

test('连会话都没有（比如手工调工具）才落到静默', async () => {
  const service = fakeService({ origin: null });
  await tool(service, 'cron_create').execute({ ...base });
  assert.equal(service.created[0].delivery, undefined);
});

test('点名会话日志但没写会话时，补上发起调用的会话', async () => {
  const service = fakeService();
  await tool(service, 'cron_create').execute({ ...base, delivery: { kind: 'session' } }, exec('session-web'));
  assert.deepEqual(service.created[0].delivery, { kind: 'session', sessionId: 'session-web' });
});

test('明确不要推送时以调用方为准', async () => {
  const service = fakeService({ origin: { kind: 'origin' } });
  await tool(service, 'cron_create').execute({ ...base, delivery: { kind: 'silent' } }, exec('session-chat'));
  assert.deepEqual(service.created[0].delivery, { kind: 'silent' });
});

test('点名要 origin 但没写会话时，补上发起调用的会话', async () => {
  const service = fakeService();
  await tool(service, 'cron_create').execute({ ...base, delivery: { kind: 'origin' } }, exec('session-chat'));
  assert.deepEqual(service.created[0].delivery, { kind: 'origin', sessionId: 'session-chat' });
});

test('改任务时同样补齐 origin 的会话', async () => {
  const service = fakeService();
  await tool(service, 'cron_edit').execute({ id: 'cron-1', delivery: { kind: 'origin' } }, exec('session-chat'));
  assert.deepEqual(service.patched[0].patch.delivery, { kind: 'origin', sessionId: 'session-chat' });
});

test('只写别名的 im 投递：建任务时换成真实 id 存下来', async () => {
  const service = fakeService();
  await tool(service, 'cron_create').execute({ ...base, delivery: { kind: 'im', target: 'yuyan' } }, exec('session-web'));
  assert.deepEqual(service.created[0].delivery, { kind: 'im', botId: 'wecomapp_beb5', targetId: 'tgt_7be9' });
});

test('别名认不出来时原样留着，运行时再报候选', async () => {
  const service = fakeService();
  await tool(service, 'cron_create').execute({ ...base, delivery: { kind: 'im', target: 'nobody' } }, exec('session-web'));
  assert.deepEqual(service.created[0].delivery, { kind: 'im', target: 'nobody' });
});

test('cron_targets 把已保存的目标摊给模型看', async () => {
  const service = fakeService();
  const result = await tool(service, 'cron_targets').execute({});
  assert.equal(result.available, true);
  assert.deepEqual(result.bots, []);
});
