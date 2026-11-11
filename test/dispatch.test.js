import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAnswer } from '../lib/runtime/dispatch.js';

// Shape taken from dsh-api-session-controller: SessionWaitValue =
// { reason, state, output: { records: SessionEventEntry[], truncated } },
// with assistant records newest first.
function waitValue(records, reason = 'idle') {
  return { reason, state: { cursor: 9, active: false, running: false, queue: null, pendingInput: [] }, output: { records, truncated: false } };
}

const assistant = (text) => ({
  type: 'event',
  event: { type: 'assistant/message', data: { content: [{ type: 'text', text }] } },
});

test('取出最新一条 assistant 文本', () => {
  const value = waitValue([
    assistant('收到'),
    assistant('更早的内容'),
  ]);
  assert.equal(extractAnswer(value), '收到');
});

test('跳过非 assistant 事件和空文本', () => {
  const value = waitValue([
    { type: 'event', event: { type: 'user/message', data: { content: [{ type: 'text', text: '用户的话' }] } } },
    assistant(''),
    assistant('真正的答案'),
  ]);
  assert.equal(extractAnswer(value), '真正的答案');
});

test('没有 assistant 记录时返回空串', () => {
  assert.equal(extractAnswer(waitValue([])), '');
  assert.equal(extractAnswer(undefined), '');
  assert.equal(extractAnswer({ reason: 'timeout' }), '');
});

test('兼容 content 上挂在 message 上的形态', () => {
  const value = waitValue([
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '另一形态' }] } } } },
  ]);
  assert.equal(extractAnswer(value), '另一形态');
});

// ---------------------------------------------------------------- 执行位置

function fakeController({ sessionId = 'session-new' } = {}) {
  const calls = { create: [], prompt: [], wait: [] };
  const controller = {
    create: async (request) => { calls.create.push(request); return { sessionId }; },
    prompt: async (request) => { calls.prompt.push(request); return { accepted: true }; },
    wait: async (request) => {
      calls.wait.push(request);
      return { reason: 'idle', output: { records: [{ type: 'event', event: { type: 'assistant/message', data: { content: [{ type: 'text', text: '答案' }] } } }] } };
    },
  };
  return { controller, calls };
}

async function runTarget(target, { reusedSessionId } = {}) {
  const { controller, calls } = fakeController();
  const { Dispatcher } = await import('../lib/runtime/dispatch.js');
  const dispatcher = new Dispatcher({ get: () => controller });
  const result = await dispatcher.dispatch({ prompt: '跑', cwd: '/tmp/ws', target, reusedSessionId, taskId: 'cron-1' });
  return { result, calls };
}

test('每次新建会话：每次都 create', async () => {
  const first = await runTarget({ kind: 'new' });
  const second = await runTarget({ kind: 'new' });
  assert.equal(first.calls.create.length, 1);
  assert.equal(second.calls.create.length, 1);
  assert.equal(first.result.reusedSessionId, undefined);
  assert.equal(first.calls.prompt[0].sessionId, 'session-new');
});

test('关联已有会话：不 create，直接对指定会话投 prompt', async () => {
  const { result, calls } = await runTarget({ kind: 'existing', sessionId: 'session-old' });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.prompt[0].sessionId, 'session-old');
  assert.equal(result.sessionId, 'session-old');
  assert.equal(result.reusedSessionId, undefined);
});

test('新建会话并复用：首次 create 并回报 reusedSessionId，之后不再 create', async () => {
  const first = await runTarget({ kind: 'new_once' });
  assert.equal(first.calls.create.length, 1);
  assert.equal(first.result.reusedSessionId, 'session-new');

  const second = await runTarget({ kind: 'new_once' }, { reusedSessionId: 'session-new' });
  assert.equal(second.calls.create.length, 0);
  assert.equal(second.calls.prompt[0].sessionId, 'session-new');
  assert.equal(second.result.reusedSessionId, undefined);
});

test('没有执行位置时按新建并复用处理', async () => {
  const { calls } = await runTarget(undefined);
  assert.equal(calls.create.length, 1);
});

// ---------------------------------------------------------------- agent 预置与投递会话

import { Dispatcher } from '../lib/runtime/dispatch.js';

function presetController(created) {
  return {
    create: async (opts) => { created.push(opts); return { sessionId: `s-${created.length}` }; },
    prompt: async () => ({ ok: true }),
    wait: async () => waitValue([assistant('答案')]),
  };
}

test('agent 预置透传给会话创建', async () => {
  const created = [];
  const dispatcher = new Dispatcher({ get: () => presetController(created) }, { warn() {} });
  const result = await dispatcher.dispatch({
    prompt: '跑一下', cwd: '/tmp/ws', agentPreset: 'fast', target: { kind: 'new_once' }, taskId: 't1',
  });
  assert.equal(result.dispatched, true);
  assert.deepEqual(created, [{ cwd: '/tmp/ws', agentPreset: 'fast' }]);
});

test('没给预置就不传 agentPreset', async () => {
  const created = [];
  const dispatcher = new Dispatcher({ get: () => presetController(created) }, { warn() {} });
  await dispatcher.dispatch({ prompt: '跑一下', cwd: '/tmp/ws', target: { kind: 'new' }, taskId: 't2' });
  assert.deepEqual(created, [{ cwd: '/tmp/ws' }]);
});

// ---------------------------------------------------------------- 权限预设

function permissionCtx(controller) {
  const applied = []
  const session = { id: 'session-x' }
  const ctx = {
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'agents') return { get: () => ({ session, model: { select() {} } }) }
      if (name === 'permissionPresets') {
        return {
          names: ['read-only', 'workspace-write', 'danger-full-access', 'auto'],
          set: (target, name) => applied.push({ session: target, name }),
        }
      }
      return undefined
    },
  }
  return { ctx, applied }
}

test('权限预设落到这条会话上', async () => {
  const created = []
  const { ctx, applied } = permissionCtx(presetController(created))
  const dispatcher = new Dispatcher(ctx, { warn() {} })
  const result = await dispatcher.dispatch({
    prompt: '跑一下', cwd: '/tmp/ws', permission: 'auto', target: { kind: 'new' }, taskId: 't-perm',
  })
  assert.equal(applied.length, 1)
  assert.equal(applied[0].name, 'auto')
  assert.equal(result.permissionApplied, 'auto')
});

test('没配权限就不动会话的权限', async () => {
  const created = []
  const { ctx, applied } = permissionCtx(presetController(created))
  const dispatcher = new Dispatcher(ctx, { warn() {} })
  const result = await dispatcher.dispatch({
    prompt: '跑一下', cwd: '/tmp/ws', target: { kind: 'new' }, taskId: 't-perm2',
  })
  assert.equal(applied.length, 0)
  assert.equal(result.permissionApplied, undefined)
});
