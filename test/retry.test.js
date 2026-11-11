import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTask, publicTask } from '../lib/core/model.js'

test('retries 和 timeoutMs 会写进任务并对外暴露', () => {
  const task = createTask({
    title: '重试',
    mode: 'script',
    script: { command: 'true' },
    schedule: { kind: 'daily', time: '09:00' },
    workspace: '/tmp/ws',
    retries: 2,
    timeoutMs: 30_000,
    timeZone: 'UTC',
  })
  assert.equal(task.retries, 2)
  assert.equal(task.timeoutMs, 30_000)
  const pub = publicTask(task)
  assert.equal(pub.retries, 2)
  assert.equal(pub.timeoutMs, 30_000)
})

test('不填就不留字段，默认 0 次重试', () => {
  const task = createTask({
    title: '不重试',
    mode: 'script',
    script: { command: 'true' },
    schedule: { kind: 'daily', time: '09:00' },
    workspace: '/tmp/ws',
    timeZone: 'UTC',
  })
  assert.equal(task.retries, undefined)
  assert.equal(publicTask(task).retries, 0)
  assert.equal(publicTask(task).timeoutMs, null)
})

test('retries 越界会拒绝', () => {
  assert.throws(() => createTask({
    title: '越界',
    mode: 'script',
    script: { command: 'true' },
    schedule: { kind: 'daily', time: '09:00' },
    workspace: '/tmp/ws',
    retries: 9,
    timeZone: 'UTC',
  }), /retries/)
})
