import test from 'node:test';
import assert from 'node:assert/strict';
import { executeClear, registerClearCommand } from '../lib/api/command.js';

/** 只带 surface / append / eventAt 的假会话。 */
function fakeSession({ nodes = [], events = {} } = {}) {
  const appended = [];
  return {
    surface: { nodes },
    appended,
    eventAt: (seq) => events[seq],
    append(type, data, opts) {
      appended.push({ type, data, opts });
      return { type, seq: 90 + appended.length };
    },
  };
}

function conversation() {
  return fakeSession({
    nodes: [1, 2, 3],
    events: {
      1: { type: 'system/message' },
      2: { type: 'user/message' },
      3: { type: 'assistant/message' },
    },
  });
}

function fakeCtx({ flushed = [] } = {}) {
  return {
    flushed,
    get: (name) => (name === 'sessions' ? { flush: async (session) => { flushed.push(session); return true; } } : undefined),
  };
}

function invocationFor(session, { status = 'idle', rawInput = '' } = {}) {
  const controller = new AbortController();
  return {
    agent: {
      status,
      session,
      runMaintenance: (task) => task(controller.signal),
    },
    rawInput,
    signal: controller.signal,
    controller,
  };
}

test('/clear：清掉历史，只留系统提示词和一行标记', async () => {
  const session = conversation();
  const out = await executeClear(fakeCtx(), invocationFor(session));
  assert.equal(out.kind, 'success');
  assert.match(out.text, /2 段历史/);
  assert.equal(session.appended.length, 1);
  assert.deepEqual(session.appended[0].opts.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 });
});

test('/clear：会话正忙就如实拒绝，什么都不改', async () => {
  const session = conversation();
  const out = await executeClear(fakeCtx(), invocationFor(session, { status: 'running' }));
  assert.deepEqual(out, { kind: 'error', text: '会话正在运行，等它停下来再试。' });
  assert.equal(session.appended.length, 0);
});

test('/clear：带参数按用法提示拒绝', async () => {
  const out = await executeClear(fakeCtx(), invocationFor(conversation(), { rawInput: '清一下' }));
  assert.equal(out.kind, 'error');
  assert.match(out.text, /用法/);
});

test('/clear：没有可清的内容时说清楚', async () => {
  const session = fakeSession({ nodes: [1], events: { 1: { type: 'system/message' } } });
  const out = await executeClear(fakeCtx(), invocationFor(session));
  assert.deepEqual(out, { kind: 'success', text: '这个会话还没有可清空的内容。' });
});

test('/clear：runMaintenance 被占住时返回"正在运行"', async () => {
  const session = conversation();
  const invocation = invocationFor(session);
  invocation.agent = {
    status: 'idle',
    session,
    runMaintenance: () => { throw new Error('already active'); },
  };
  const out = await executeClear(fakeCtx(), invocation);
  assert.equal(out.kind, 'error');
  assert.match(out.text, /正在运行/);
});

test('注册 /clear：命令名和说明对得上，注销函数原样返回', async () => {
  const registered = [];
  const dispose = () => {};
  const ctx = {
    get: (name) => (name === 'commands'
      ? { register: (definition) => { registered.push(definition); return dispose; } }
      : undefined),
  };
  const off = registerClearCommand(ctx);
  assert.equal(off, dispose);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'clear');
  assert.match(registered[0].description, /清空/);

  const result = await registered[0].handler(invocationFor(conversation()));
  assert.equal(result.kind, 'success');
});

test('没有命令注册表时安静跳过', () => {
  assert.equal(registerClearCommand({ get: () => undefined }), null);
  assert.equal(registerClearCommand({}), null);
});
