import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEAR_MARKER, clearingRange, clearSessionContext, clearAgentContext } from '../lib/runtime/memory.js';

/** 只带 surface / append / eventAt 的假会话：清空逻辑要能在没有宿主时单独验。 */
function fakeSession({ nodes = [], events = {} } = {}) {
  const appended = [];
  return {
    surface: { nodes },
    appended,
    eventAt: (seq) => events[seq],
    append(type, data, opts) {
      appended.push({ type, data, opts });
      return { type, seq: 100 + appended.length };
    },
  };
}

test('清空时保住开头的 system/message，其余全部遮蔽', () => {
  const session = fakeSession({
    nodes: [1, 2, 3, 4],
    events: { 1: { type: 'system/message' }, 2: { type: 'user/message' }, 3: { type: 'assistant/message' } },
  });
  assert.deepEqual(clearingRange(session), { shadowed: [2, 3, 4], startSeq: 2, endSeq: 4 });

  const result = clearSessionContext(session);
  assert.equal(result.cleared, 3);
  assert.equal(session.appended.length, 1);
  const [event] = session.appended;
  assert.equal(event.type, 'user/message');
  assert.deepEqual(event.data.content, [{ type: 'text', text: CLEAR_MARKER }]);
  assert.equal(event.data.role, 'user');
  assert.deepEqual(event.data.source, { kind: 'user' });
  assert.match(event.data.id, /^[0-9a-f-]{36}$/);
  // 定位式替换的契约：range 两端 + 列全被遮蔽的节点
  assert.deepEqual(event.opts.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 4 });
  assert.deepEqual(event.opts.sourceEventSeqs, [2, 3, 4]);
});

test('只有 system/message 时没有可清的内容', () => {
  const session = fakeSession({ nodes: [1], events: { 1: { type: 'system/message' } } });
  assert.equal(clearingRange(session), null);
  assert.deepEqual(clearSessionContext(session), { cleared: 0, range: null });
  assert.equal(session.appended.length, 0);
});

test('开头不是 system/message 时从头遮蔽', () => {
  const session = fakeSession({
    nodes: [5, 6],
    events: { 5: { type: 'user/message' }, 6: { type: 'assistant/message' } },
  });
  assert.deepEqual(clearingRange(session), { shadowed: [5, 6], startSeq: 5, endSeq: 6 });
  assert.equal(clearSessionContext(session).cleared, 2);
});

test('空会话和拿不到 surface 的会话都不动', () => {
  assert.equal(clearingRange(fakeSession({ nodes: [] })), null);
  assert.equal(clearingRange({ surface: {} }), null);
  assert.equal(clearingRange(undefined), null);
  assert.equal(clearSessionContext({}).cleared, 0);
});

test('读不到事件时按"开头就是系统提示词"处理，宁可少清一条', () => {
  const session = { surface: { nodes: [7, 8] }, append() { this.called = true; } };
  assert.deepEqual(clearingRange(session), { shadowed: [8], startSeq: 8, endSeq: 8 });
});

test('清 agent 上下文：只在空闲阶段动手，并刷一次盘', async () => {
  const flushed = [];
  const session = fakeSession({
    nodes: [1, 2, 3],
    events: { 1: { type: 'system/message' }, 2: { type: 'user/message' }, 3: { type: 'assistant/message' } },
  });
  const idle = {
    status: 'idle',
    session,
    runMaintenance: (task) => task(new AbortController().signal),
  };
  const result = await clearAgentContext(idle, { sessions: { flush: async (s) => flushed.push(s) } });
  assert.equal(result.cleared, 2);
  assert.deepEqual(flushed, [session]);

  const busy = { status: 'running', session, runMaintenance: () => { throw new Error('不该被调用'); } };
  assert.deepEqual(await clearAgentContext(busy, {}), { cleared: 0, busy: true });
});

test('清 agent 上下文：被取消时一个字都不改', async () => {
  const session = fakeSession({
    nodes: [1, 2],
    events: { 1: { type: 'system/message' }, 2: { type: 'user/message' } },
  });
  const controller = new AbortController();
  controller.abort();
  const agent = { status: 'idle', session, runMaintenance: (task) => task(controller.signal) };
  const result = await clearAgentContext(agent, { signal: controller.signal });
  assert.equal(result.cleared, 0);
  assert.equal(session.appended.length, 0);
});
