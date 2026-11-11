import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_KINDS, createTask, normalizeStoredTask, normalizeTarget, publicTask } from '../lib/core/model.js';

const base = { title: '甲', workspace: '/tmp/ws', mode: 'agent', prompt: '跑一下', schedule: { kind: 'daily', time: '09:00' } };

test('三种执行位置都能归一化', () => {
  assert.deepEqual(TARGET_KINDS, ['new_once', 'new', 'existing']);
  assert.deepEqual(normalizeTarget(undefined), { kind: 'new_once' });
  assert.deepEqual(normalizeTarget({ kind: 'new' }), { kind: 'new' });
  assert.deepEqual(normalizeTarget({ kind: 'existing', sessionId: 'session-9' }), { kind: 'existing', sessionId: 'session-9' });
  assert.deepEqual(normalizeTarget('new_once'), { kind: 'new_once' });
  assert.throws(() => normalizeTarget({ kind: 'existing' }));
  assert.throws(() => normalizeTarget({ kind: 'nope' }));
});

test('任务对象带上 target，旧数据默认新建并复用', () => {
  const task = createTask(base);
  assert.deepEqual(task.target, { kind: 'new_once' });
  assert.deepEqual(publicTask(task).target, { kind: 'new_once' });

  const stored = normalizeStoredTask({ ...base, id: 'x' }, { workspace: '/tmp/ws' });
  assert.deepEqual(stored.target, { kind: 'new_once' });
});

test('new_once 记住会话后 publicTask 才暴露 targetSessionId', () => {
  const task = createTask({ ...base, target: { kind: 'new_once' } });
  assert.equal(publicTask(task).targetSessionId, undefined);
  task.state.targetSessionId = 'session-42';
  assert.equal(publicTask(task).targetSessionId, 'session-42');

  const existing = createTask({ ...base, target: { kind: 'existing', sessionId: 'session-7' } });
  existing.state.targetSessionId = 'session-42';
  assert.equal(publicTask(existing).targetSessionId, undefined);
});

test('权限预设：写进任务并对外暴露，空值不留字段', () => {
  const base = {
    title: '权限', workspace: '/tmp/ws', mode: 'agent', prompt: 'ping',
    schedule: { kind: 'daily', time: '09:00' }, timeZone: 'UTC',
  }
  const task = createTask({ ...base, permission: 'auto' })
  assert.equal(task.permission, 'auto')
  assert.equal(publicTask(task).permission, 'auto')
  assert.equal(createTask(base).permission, undefined)
  assert.equal(publicTask(createTask(base)).permission, null)
})

test('权限预设：名字形状不合法就拒绝', () => {
  assert.throws(() => createTask({
    title: '权限', workspace: '/tmp/ws', mode: 'agent', prompt: 'ping',
    schedule: { kind: 'daily', time: '09:00' }, timeZone: 'UTC',
    permission: 'auto admit!',
  }), /permission/)
})
