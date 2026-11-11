import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCron,
  nextOccurrence,
  zonedParts,
  zonedTimeToInstant,
  describeCron,
  CronError,
} from '../lib/core/cron.js';

const SH = 'Asia/Shanghai';
const NY = 'America/New_York';

function iso(ms) {
  return new Date(ms).toISOString();
}

function next(expr, fromIso, zone = SH, options) {
  const ms = nextOccurrence(parseCron(expr), new Date(fromIso).getTime(), zone, options);
  return ms === null ? null : iso(ms);
}

test('每天 9 点（上海）', () => {
  assert.equal(next('0 9 * * *', '2026-11-10T00:30:00Z'), '2026-11-10T01:00:00.000Z');
  assert.equal(next('0 9 * * *', '2026-11-10T02:00:00Z'), '2026-11-11T01:00:00.000Z');
});

test('每 15 分钟', () => {
  assert.equal(next('*/15 * * * *', '2026-11-10T00:07:00Z'), '2026-11-10T00:15:00.000Z');
  assert.equal(next('*/15 * * * *', '2026-11-10T00:15:00Z'), '2026-11-10T00:30:00.000Z');
});

test('周日用 7 表示', () => {
  const a = next('0 9 * * 7', '2026-11-10T00:00:00Z');
  const b = next('0 9 * * 0', '2026-11-10T00:00:00Z');
  assert.equal(a, b);
});

test('闰日 2 月 29 日', () => {
  assert.equal(next('0 0 29 2 *', '2026-11-10T00:00:00Z', 'UTC', { horizonMs: 9 * 365 * 86400000 }), '2028-02-29T00:00:00.000Z');
});

test('工作日 8:30', () => {
  // 2026-11-13 是周五；下一次 8:30 应为周一 11-16
  assert.equal(next('30 8 * * 1-5', '2026-11-13T09:00:00Z'), '2026-11-16T00:30:00.000Z');
});

test('日与周同时限定时取“或”', () => {
  // 2026-11-16 是周一
  assert.equal(next('0 0 1 * 1', '2026-11-10T00:00:00Z'), '2026-11-15T16:00:00.000Z');
});

test('夏令时跳变时跳过不存在的钟点', () => {
  // 2027-03-14 02:30 在纽约不存在（2:00 -> 3:00）
  const ms = nextOccurrence(parseCron('30 2 * * *'), new Date('2027-03-13T12:00:00Z').getTime(), NY);
  assert.equal(iso(ms), '2027-03-15T06:30:00.000Z');
});

test('夏令时回拨时同一钟点只取较早的一次', () => {
  // 2027-11-07 01:30 在纽约出现两次，取较早（EDT, UTC-4）
  const ms = nextOccurrence(parseCron('30 1 * * *'), new Date('2027-11-06T12:00:00Z').getTime(), NY);
  assert.equal(iso(ms), '2027-11-07T05:30:00.000Z');
});

test('六段带秒', () => {
  assert.equal(next('30 * * * * *', '2026-11-10T00:00:10Z', 'UTC'), '2026-11-10T00:00:30.000Z');
});

test('非法表达式报错', () => {
  assert.throws(() => parseCron('0 9 * *'), CronError);
  assert.throws(() => parseCron('99 9 * * *'), CronError);
  assert.throws(() => parseCron('0 9 * * MONDAY'), CronError);
  assert.throws(() => parseCron('*/0 * * * *'), CronError);
});

test('时区换算正确', () => {
  const instant = zonedTimeToInstant({ year: 2026, month: 11, day: 10, hour: 9, minute: 0, second: 0 }, SH);
  assert.equal(iso(instant), '2026-11-10T01:00:00.000Z');
  assert.deepEqual(zonedParts(instant, SH), { year: 2026, month: 11, day: 10, hour: 9, minute: 0, second: 0 });
});

test('描述文本', () => {
  assert.match(describeCron(parseCron('0 9,21 * * *'), SH), /每天 .*09:00.*21:00/);
  assert.match(describeCron(parseCron('* * * * *'), SH), /每分钟/);
});

test('远未来无解时返回 null 而不是死循环', () => {
  // 2 月 31 日永远不会到来
  const ms = nextOccurrence(parseCron('0 0 31 2 *'), Date.now(), 'UTC', { horizonMs: 400 * 86400000 });
  assert.equal(ms, null);
});
