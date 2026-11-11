import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileCron,
  computeNextRun,
  createTask,
  describeSchedule,
  isDue,
  migrateSchedule,
  normalizeAgent,
  normalizeDelivery,
  normalizeSchedule,
  normalizeStoredTask,
  previewSchedule,
  publicTask,
  selectorFromCron,
  TaskError,
} from '../lib/core/model.js';

const TZ = 'Asia/Shanghai';
// 上海 2026-11-10（周二）10:00
const NOW = Date.parse('2026-11-10T02:00:00Z');

function make(schedule, extra = {}) {
  return createTask(
    { title: 't', workspace: '/tmp/ws', schedule, prompt: '做点事', ...extra },
    { now: NOW, timeZone: TZ },
  );
}

test('九种调度都能算出下次执行时间', () => {
  const cases = [
    [{ kind: 'monthly', dayOfMonth: 3, time: '01:30' }, '2026-12-02T17:30:00.000Z'],
    [{ kind: 'weekly', weekday: 1, time: '09:00' }, '2026-11-16T01:00:00.000Z'],
    [{ kind: 'daily', time: '09:00' }, '2026-11-11T01:00:00.000Z'],
    [{ kind: 'hourly', minute: 5 }, '2026-11-10T02:05:00.000Z'],
    [{ kind: 'every-days', interval: 2, time: '09:00' }, '2026-11-12T01:00:00.000Z'],
    [{ kind: 'every-hours', interval: 5, minute: 30 }, '2026-11-10T02:30:00.000Z'],
    [{ kind: 'every-minutes', interval: 15 }, '2026-11-10T02:15:00.000Z'],
    [{ kind: 'every-seconds', interval: 15 }, '2026-11-10T02:00:15.000Z'],
    [{ kind: 'cron', expression: '0 9 * * 1-5' }, '2026-11-11T01:00:00.000Z'],
  ];
  for (const [schedule, expected] of cases) {
    assert.equal(make(schedule).state.nextRunAt, expected, JSON.stringify(schedule));
  }
});

test('墙上时钟类调度编译成 cron，等间隔类不走 cron', () => {
  assert.equal(compileCron({ kind: 'monthly', dayOfMonth: 3, time: '01:30' }), '30 1 3 * *');
  assert.equal(compileCron({ kind: 'weekly', weekday: 7, time: '09:05' }), '5 9 * * 0');
  assert.equal(compileCron({ kind: 'daily', time: '09:05' }), '5 9 * * *');
  assert.equal(compileCron({ kind: 'hourly', minute: 5 }), '5 * * * *');
  assert.equal(compileCron({ kind: 'cron', expression: '0 9 * * 1-5' }), '0 9 * * 1-5');
  // cron 的 */n 在字段边界会回卷，等间隔语义不能靠它表达
  for (const kind of ['every-days', 'every-hours', 'every-minutes', 'every-seconds']) {
    assert.throws(() => compileCron({ kind, interval: 5, minute: 0, time: '09:00' }), TaskError, kind);
  }
});

test('等间隔调度按绝对时间推进，不出现短间隔', () => {
  // 每 45 秒：45、45、45…不是 45/15 交替
  const seconds = make({ kind: 'every-seconds', interval: 45 }, { script: 'true', prompt: undefined });
  const first = Date.parse(seconds.state.nextRunAt);
  assert.equal(new Date(first).toISOString(), '2026-11-10T02:00:45.000Z');
  assert.equal(
    new Date(computeNextRun(seconds, first)).toISOString(),
    '2026-11-10T02:01:30.000Z',
  );

  // 每 90 分钟：对齐到整 90 分钟网格，不会被压成每小时一次
  const minutes = make({ kind: 'every-minutes', interval: 90 }, { script: 'true', prompt: undefined });
  const start = Date.parse(minutes.state.nextRunAt);
  assert.equal(new Date(start).toISOString(), '2026-11-10T03:00:00.000Z');
  assert.equal(new Date(computeNextRun(minutes, start)).toISOString(), '2026-11-10T04:30:00.000Z');

  // 每 6 小时第 30 分：跨天也是整 6 小时
  const hours = make({ kind: 'every-hours', interval: 6, minute: 30 }, { script: 'true', prompt: undefined });
  const anchor = Date.parse(hours.state.nextRunAt);
  assert.equal(new Date(anchor).toISOString(), '2026-11-10T02:30:00.000Z');
  assert.equal(new Date(computeNextRun(hours, anchor)).toISOString(), '2026-11-10T08:30:00.000Z');
  assert.equal(new Date(computeNextRun(hours, Date.parse('2026-11-10T09:00:00Z'))).toISOString(), '2026-11-10T14:30:00.000Z');
});

test('九种调度的人话描述', () => {
  const cases = [
    [{ kind: 'monthly', dayOfMonth: 3, time: '01:30' }, '每月 3 日 01:30'],
    [{ kind: 'weekly', weekday: 1, time: '09:00' }, '每周一 09:00'],
    [{ kind: 'weekly', weekday: 7, time: '18:05' }, '每周日 18:05'],
    [{ kind: 'daily', time: '09:00' }, '每天 09:00'],
    [{ kind: 'hourly', minute: 5 }, '每小时第 05 分'],
    [{ kind: 'every-days', interval: 3, time: '08:00' }, '每 3 天 08:00'],
    [{ kind: 'every-hours', interval: 2, minute: 30 }, '每 2 小时第 30 分'],
    [{ kind: 'every-minutes', interval: 15 }, '每 15 分钟'],
    [{ kind: 'every-seconds', interval: 30 }, '每 30 秒'],
  ];
  for (const [schedule, expected] of cases) {
    assert.equal(describeSchedule(make(schedule)), expected, JSON.stringify(schedule));
  }
  assert.match(describeSchedule(make({ kind: 'cron', expression: '0 9,21 * * *' })), /每天 .*09:00/);
});

test('每 N 天按创建日锚定，不会在月底重置', () => {
  const task = createTask(
    { title: '隔天', workspace: '/tmp/ws', schedule: { kind: 'every-days', interval: 2, time: '09:00' }, script: 'true' },
    { now: Date.parse('2026-11-28T02:00:00Z'), timeZone: TZ }, // 上海 11-28 10:00
  );
  assert.equal(task.state.nextRunAt, '2026-11-30T01:00:00.000Z');
  const next = computeNextRun(task, Date.parse('2026-11-30T01:00:00Z'));
  assert.equal(new Date(next).toISOString(), '2026-12-02T01:00:00.000Z');
});

test('repeat 上限与暂停的任务不再排期', () => {
  const task = make({ kind: 'every-minutes', interval: 5 }, { script: 'true', prompt: undefined, repeat: 3 });
  assert.ok(task.state.nextRunAt);
  task.runCount = 3;
  assert.equal(computeNextRun(task, NOW), null);
  task.runCount = 0;
  task.enabled = false;
  assert.equal(computeNextRun(task, NOW), null);
});

test('到期判断', () => {
  const task = make({ kind: 'every-minutes', interval: 1 }, { script: 'true', prompt: undefined });
  assert.equal(isDue(task, NOW), false);
  assert.equal(isDue(task, Date.parse(task.state.nextRunAt) + 1), true);
  task.enabled = false;
  assert.equal(isDue(task, Date.parse(task.state.nextRunAt) + 1), false);
});

test('选择器参数校验', () => {
  assert.throws(() => normalizeSchedule({ kind: 'weekly', weekday: 8, time: '09:00' }), TaskError);
  assert.throws(() => normalizeSchedule({ kind: 'monthly', dayOfMonth: 0, time: '09:00' }), TaskError);
  assert.throws(() => normalizeSchedule({ kind: 'daily', time: '25:00' }), TaskError);
  assert.throws(() => normalizeSchedule({ kind: 'daily', time: '9点半' }), TaskError);
  assert.throws(() => normalizeSchedule({ kind: 'every-seconds', interval: 4 }), TaskError);
  assert.throws(() => normalizeSchedule({ kind: 'every-minutes', interval: 0 }), TaskError);
  assert.throws(() => normalizeSchedule({ kind: 'hourly', minute: 60 }), TaskError);
  assert.throws(() => normalizeSchedule({ kind: 'cron', expression: '0 9 * *' }), TaskError);
  assert.throws(() => normalizeSchedule({ kind: 'nope' }), TaskError);
  assert.deepEqual(normalizeSchedule({ kind: 'daily', time: '9:5' }), { kind: 'daily', time: '09:05' });
});

test('旧调度：间隔、字符串、at/after 都迁到选择器', () => {
  assert.deepEqual(migrateSchedule({ kind: 'every', seconds: 900 }, TZ), { kind: 'every-minutes', interval: 15 });
  assert.deepEqual(migrateSchedule({ kind: 'every', seconds: 7200 }, TZ), { kind: 'every-hours', interval: 2, minute: 0 });
  assert.deepEqual(migrateSchedule({ kind: 'every', seconds: 86400 }, TZ), { kind: 'every-days', interval: 1, time: '00:00' });
  assert.deepEqual(migrateSchedule({ kind: 'every', seconds: 45 }, TZ), { kind: 'every-seconds', interval: 45 });
  // 换不动单位的间隔保持原值：90 秒就是 90 秒，不是 2 分钟
  assert.deepEqual(migrateSchedule({ kind: 'every', seconds: 90 }, TZ), { kind: 'every-seconds', interval: 90 });
  assert.deepEqual(migrateSchedule({ kind: 'every', seconds: 5400 }, TZ), { kind: 'every-minutes', interval: 90 });
  assert.deepEqual(migrateSchedule({ kind: 'after', seconds: 600 }, TZ), { kind: 'every-minutes', interval: 10 });
  assert.deepEqual(migrateSchedule('every 30m', TZ), { kind: 'every-minutes', interval: 30 });
  assert.deepEqual(migrateSchedule('每天 21:30', TZ), { kind: 'daily', time: '21:30' });
  assert.deepEqual(migrateSchedule('every monday 9am', TZ), { kind: 'weekly', weekday: 1, time: '09:00' });
  assert.deepEqual(migrateSchedule('30 1 3 * *', TZ), { kind: 'monthly', dayOfMonth: 3, time: '01:30' });
  assert.deepEqual(migrateSchedule({ kind: 'at', at: '2026-12-01T09:00:00+08:00' }, TZ), {
    kind: 'cron',
    expression: '0 9 1 12 *',
  });
  // 反推不出来的形状原样留在 cron 里
  assert.deepEqual(migrateSchedule('0 9 * * 1-5', TZ), { kind: 'cron', expression: '0 9 * * 1-5' });
});

test('cron 能反推成选择器', () => {
  assert.deepEqual(selectorFromCron('*/15 * * * *'), { kind: 'every-minutes', interval: 15 });
  assert.deepEqual(selectorFromCron('*/5 * * * * *'), { kind: 'every-seconds', interval: 5 });
  assert.deepEqual(selectorFromCron('30 */2 * * *'), { kind: 'every-hours', interval: 2, minute: 30 });
  assert.deepEqual(selectorFromCron('5 * * * *'), { kind: 'hourly', minute: 5 });
  assert.deepEqual(selectorFromCron('0 9 * * *'), { kind: 'daily', time: '09:00' });
  assert.deepEqual(selectorFromCron('0 9 * * 1'), { kind: 'weekly', weekday: 1, time: '09:00' });
  assert.deepEqual(selectorFromCron('0 9 * * 0'), { kind: 'weekly', weekday: 7, time: '09:00' });
  assert.deepEqual(selectorFromCron('30 1 3 * *'), { kind: 'monthly', dayOfMonth: 3, time: '01:30' });
  assert.equal(selectorFromCron('0 9 * * 1-5'), null);
  // 步长超出字段宽度的表达式，语义已经不是「每 N 分钟」
  assert.equal(selectorFromCron('*/90 * * * *'), null);
  assert.equal(selectorFromCron('*/30 */48 * * *'), null);
  assert.equal(selectorFromCron('0 9 5 6 1'), null);
});

test('旧任务数据归一化：mode 降级、字段删除、notepad 迁移', () => {
  const legacy = {
    id: 'cron-old',
    title: '旧的',
    mode: 'monitor',
    schedule: { kind: 'every', seconds: 600 },
    monitor: { kind: 'url', url: 'https://example.com' },
    prompt: '变了告诉我',
    failureDelivery: { kind: 'im', botId: 'bot', targetId: 'ops' },
    delivery: { kind: 'im-session', sessionId: 'session-9' },
    notepad: { lastSeen: 'abc' },
    state: { consecutiveFailures: 2 },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const task = normalizeStoredTask(legacy, { timeZone: TZ, workspace: '/tmp/ws' });
  assert.equal(task.mode, 'agent');
  assert.deepEqual(task.schedule, { kind: 'every-minutes', interval: 10 });
  assert.deepEqual(task.delivery, { kind: 'session', sessionId: 'session-9' });
  assert.equal(task.monitor, undefined);
  assert.equal(task.failureDelivery, undefined);
  assert.equal(task.workspace, '/tmp/ws');
  assert.equal(task.state.consecutiveFailures, 2);
  assert.deepEqual(publicTask(task).state.notepad, { lastSeen: 'abc' });

  // 迁移不了的调度留在 cron 里，不让整个工作区加载失败
  const broken = normalizeStoredTask({ title: 'x', mode: 'script', script: 'true', schedule: '过一会儿' }, { workspace: '/tmp/ws' });
  assert.equal(broken.schedule.kind, 'cron');
  assert.equal(computeNextRun(broken, NOW), null);
});

test('模式校验', () => {
  assert.throws(() => make({ kind: 'daily', time: '09:00' }, { mode: 'agent', prompt: undefined }), TaskError);
  assert.throws(() => make({ kind: 'daily', time: '09:00' }, { mode: 'script', script: undefined }), TaskError);
  assert.throws(() => make({ kind: 'daily', time: '09:00' }, { mode: 'nope' }), TaskError);
  // 旧值降级而不是报错
  assert.equal(make({ kind: 'daily', time: '09:00' }, { mode: 'monitor' }).mode, 'agent');
  assert.equal(make({ kind: 'daily', time: '09:00' }, { mode: 'hybrid' }).mode, 'agent');
});

test('工作区必填且必须是绝对路径', () => {
  assert.throws(() => createTask({ title: 'x', schedule: { kind: 'daily', time: '09:00' }, prompt: 'p' }, { now: NOW }), /workspace/);
  assert.throws(
    () => createTask({ title: 'x', workspace: 'relative/ws', schedule: { kind: 'daily', time: '09:00' }, prompt: 'p' }, { now: NOW }),
    /绝对路径/,
  );
  const task = createTask({ title: 'x', workspace: '/tmp/ws/', schedule: { kind: 'daily', time: '09:00' }, prompt: 'p' }, { now: NOW });
  assert.equal(task.workspace, '/tmp/ws');
});

test('投递只有一个：silent / im / session', () => {
  assert.deepEqual(normalizeDelivery(undefined), { kind: 'silent' });
  assert.deepEqual(normalizeDelivery({ kind: 'silent' }), { kind: 'silent' });
  assert.deepEqual(normalizeDelivery({ kind: 'im', botId: 'bot', targetId: 'ops' }), { kind: 'im', botId: 'bot', targetId: 'ops' });
  assert.deepEqual(normalizeDelivery({ kind: 'session', sessionId: 's1' }), { kind: 'session', sessionId: 's1' });
  // 缺字段不在这里拦：聊天里建任务拿不到 id，运行时再解析（别名 / 渠道 / 只有一个目标）
  assert.deepEqual(normalizeDelivery({ kind: 'im' }), { kind: 'im', auto: true });
  assert.deepEqual(normalizeDelivery({ kind: 'im', target: 'yuyan' }), { kind: 'im', target: 'yuyan' });
  assert.deepEqual(normalizeDelivery({ kind: 'im', bot: 'wecom-app' }), { kind: 'im', bot: 'wecom-app' });
  // 显式 id 优先，别名就不记了
  assert.deepEqual(normalizeDelivery({ kind: 'im', botId: 'b', targetId: 't', target: 'x' }), { kind: 'im', botId: 'b', targetId: 't' });
  // 已删除的 im-session 读到就退化成写会话；没有会话就退化成静默
  assert.deepEqual(normalizeDelivery({ kind: 'im-session', sessionId: 's1' }), { kind: 'session', sessionId: 's1' });
  assert.deepEqual(normalizeDelivery({ kind: 'im-session' }), { kind: 'silent' });
  assert.throws(() => normalizeDelivery({ kind: 'nope' }), TaskError);
});

test('publicTask 投影出契约里的字段', () => {
  const task = make({ kind: 'daily', time: '09:00' });
  const view = publicTask(task);
  assert.equal(view.scheduleText, '每天 09:00');
  assert.equal(view.workspace, '/tmp/ws');
  assert.equal(view.delivery.kind, 'silent');
  assert.equal(view.prompt, '做点事');
  assert.equal(view.script, null);
  assert.deepEqual(view.state.notepad, {});
  for (const key of ['id', 'title', 'enabled', 'mode', 'schedule', 'repeat', 'runCount', 'tags', 'createdAt', 'updatedAt']) {
    assert.ok(key in view, `缺字段 ${key}`);
  }
});

test('调度预览给出多条递增的时间', () => {
  const preview = previewSchedule({ kind: 'every-minutes', interval: 15 }, { from: NOW, timeZone: TZ });
  assert.equal(preview.text, '每 15 分钟');
  assert.equal(preview.next.length, 3);
  assert.equal(preview.next[0], '2026-11-10T02:15:00.000Z');
  for (let index = 1; index < preview.next.length; index += 1) {
    assert.ok(Date.parse(preview.next[index]) > Date.parse(preview.next[index - 1]));
  }

  const monthly = previewSchedule({ kind: 'monthly', dayOfMonth: 3, time: '01:30' }, { from: NOW, timeZone: TZ });
  assert.equal(monthly.text, '每月 3 日 01:30');
  assert.ok(monthly.next.length >= 2);
});

// ---------------------------------------------------------------- 一次性调度

test('仅一次：算出指定本地时刻，跑完不再有下次', () => {
  const schedule = normalizeSchedule({ kind: 'once', date: '2026-11-12', time: '09:00' }, TZ);
  assert.deepEqual(schedule, { kind: 'once', date: '2026-11-12', time: '09:00' });
  const task = createTask(
    { title: '一次性', workspace: '/tmp/ws', mode: 'script', script: 'true', schedule },
    { now: Date.parse('2026-11-10T00:00:00Z'), timeZone: TZ },
  );
  assert.equal(task.state.nextRunAt, '2026-11-12T01:00:00.000Z');
  assert.equal(describeSchedule(task), '2026-11-12 09:00 一次');
  assert.equal(isDue(task, Date.parse('2026-11-12T01:00:01.000Z')), true);

  task.runCount = 1;
  assert.equal(computeNextRun(task, Date.parse('2026-11-12T02:00:00Z')), null);
  assert.equal(isDue(task, Date.parse('2026-11-13T01:00:01.000Z')), true);
});

test('仅一次：过去的时间不补跑', () => {
  const schedule = normalizeSchedule({ kind: 'once', date: '2020-01-01', time: '09:00' }, TZ);
  const task = createTask(
    { title: '过期', workspace: '/tmp/ws', mode: 'script', script: 'true', schedule },
    { now: Date.parse('2026-11-10T00:00:00Z'), timeZone: TZ },
  );
  assert.equal(task.state.nextRunAt, null);
});

test('仅一次：日期格式与边界校验', () => {
  assert.deepEqual(
    normalizeSchedule({ kind: 'once', date: '2026-11-12', time: '9:00' }, TZ),
    { kind: 'once', date: '2026-11-12', time: '09:00' },
  );
  assert.throws(() => normalizeSchedule({ kind: 'once', date: '2026-02-30', time: '09:00' }, TZ));
  assert.throws(() => normalizeSchedule({ kind: 'once', date: '11/12/2026', time: '09:00' }, TZ));
});

test('仅一次：预览只给一条', () => {
  const result = previewSchedule(
    { kind: 'once', date: '2026-11-12', time: '09:00' },
    { from: Date.parse('2026-11-10T00:00:00Z'), timeZone: TZ },
  );
  assert.deepEqual(result.next, ['2026-11-12T01:00:00.000Z']);
  assert.equal(result.text, '2026-11-12 09:00 一次');
});

// ---------------------------------------------------------------- 运行模型与投递会话

test('agent.preset 归一化，空串视为不指定', () => {
  assert.deepEqual(normalizeAgent({ preset: ' fast ' }), { preset: 'fast' });
  assert.deepEqual(normalizeAgent({ preset: '' }), {});
  assert.deepEqual(normalizeAgent({}), {});
});

test('写会话日志可以不指定会话：跑完写回本次运行的会话', () => {
  assert.deepEqual(normalizeDelivery({ kind: 'session' }), { kind: 'session' });
  assert.deepEqual(normalizeDelivery({ kind: 'session', sessionId: 's-1' }), { kind: 'session', sessionId: 's-1' });
});

test('不写 mode 默认智能模式，只给一条命令才算脚本模式', () => {
  const prompt = createTask({
    title: '甲', prompt: '看看今天的告警', workspace: '/tmp/ws',
    schedule: { kind: 'every-minutes', interval: 5 },
  });
  assert.equal(prompt.mode, 'agent');

  const command = createTask({
    title: '乙', script: 'echo hi', workspace: '/tmp/ws',
    schedule: { kind: 'every-minutes', interval: 5 },
  });
  assert.equal(command.mode, 'script');

  const explicit = createTask({
    title: '丙', mode: 'script', script: 'true', workspace: '/tmp/ws',
    schedule: { kind: 'every-minutes', interval: 5 },
  });
  assert.equal(explicit.mode, 'script');

  assert.throws(() => createTask({
    title: '丁', workspace: '/tmp/ws', schedule: { kind: 'every-minutes', interval: 5 },
  }), /prompt/);
});

test('执行位置不写就是新建会话并复用', () => {
  const task = createTask({
    title: '甲', prompt: '跑一轮', workspace: '/tmp/ws',
    schedule: { kind: 'every-minutes', interval: 5 },
  });
  assert.deepEqual(task.target, { kind: 'new_once' });
});
