import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_SCHEDULE_ENTRY_IDS, readDisableBuiltin, syncBuiltinSchedule } from '../lib/api/builtin.js';
import { registerRoutes } from '../lib/api/http.js';
import { call, routeHandler } from './helpers.js';

/** 造一份贴近真实形状的插件清单：entryId 带 include: 前缀，patchId 是补丁里的裸 id。 */
function rowsOf(enabled) {
  return [
    { entryId: 'include:schedule', patchId: 'schedule', enabled },
    { entryId: 'include:tool-schedule', patchId: 'tool-schedule', enabled },
    { entryId: 'include:ui-schedule', patchId: 'ui-schedule', enabled },
  ];
}

function fakeCtx({ rows = rowsOf(true), settings } = {}) {
  const calls = [];
  const services = {
    pluginManager: {
      listPlugins: async () => rows,
      setPluginEnabled: async (entryId, enabled) => {
        calls.push([entryId, enabled]);
        const row = rows.find((item) => item.entryId === entryId);
        if (row !== undefined) row.enabled = enabled;
      },
    },
  };
  if (settings !== undefined) services.settings = { describe: () => [{ ns: 'dsh-cron', value: settings }] };
  return { ctx: { get: (name) => services[name] }, calls, rows };
}

test('三个入口的 id 是官方补丁里的裸 id', () => {
  assert.deepEqual([...BUILTIN_SCHEDULE_ENTRY_IDS], ['schedule', 'tool-schedule', 'ui-schedule']);
});

test('关掉开关就把官方那套打开，并认得 include: 前缀', async () => {
  const { ctx, calls } = fakeCtx({ rows: rowsOf(false) });
  const failures = await syncBuiltinSchedule(ctx, { warn() {} }, false);
  assert.equal(failures, 0);
  assert.deepEqual(calls, [
    ['include:schedule', true], ['include:tool-schedule', true], ['include:ui-schedule', true],
  ]);
});

test('打开开关就把官方那套收回', async () => {
  const { ctx, calls } = fakeCtx({ rows: rowsOf(true) });
  const failures = await syncBuiltinSchedule(ctx, { warn() {} }, true);
  assert.equal(failures, 0);
  assert.deepEqual(calls, [
    ['include:schedule', false], ['include:tool-schedule', false], ['include:ui-schedule', false],
  ]);
});

test('状态已经对上了就不写补丁', async () => {
  const { ctx, calls } = fakeCtx({ rows: rowsOf(false) });
  await syncBuiltinSchedule(ctx, { warn() {} }, true);
  assert.deepEqual(calls, []);
});

test('没有 pluginManager 时安静退出', async () => {
  const failures = await syncBuiltinSchedule({ get: () => undefined }, { warn() {} }, false);
  assert.equal(failures, 0);
});

test('单个入口失败会报次数，交给调用方重试', async () => {
  const { ctx } = fakeCtx({ rows: rowsOf(false) });
  const manager = ctx.get('pluginManager');
  manager.setPluginEnabled = async (entryId, enabled) => {
    if (entryId === 'include:tool-schedule') throw new Error('HMR transactions cannot be nested');
    const row = manager.listPlugins ? undefined : undefined;
    void row; void enabled;
  };
  const failures = await syncBuiltinSchedule(ctx, { warn() {} }, false);
  assert.ok(failures >= 1);
});

test('readDisableBuiltin 只认布尔值', () => {
  assert.equal(readDisableBuiltin(fakeCtx({ settings: { disableBuiltinSchedule: true } }).ctx), true);
  assert.equal(readDisableBuiltin(fakeCtx({ settings: { disableBuiltinSchedule: false } }).ctx), false);
  assert.equal(readDisableBuiltin(fakeCtx({ settings: {} }).ctx), undefined);
  assert.equal(readDisableBuiltin({ get: () => undefined }), undefined);
});

test('POST /api/builtin 把开关落到宿主插件上', async () => {
  const { ctx, calls } = fakeCtx({ rows: rowsOf(false) });
  const routes = [];
  registerRoutes(
    { ...ctx, webServer: { register: (route) => { routes.push(route); return () => {}; } } },
    { status: () => ({}), health: () => ({}), listWorkspaces: () => [] },
    { listTargets: async () => ({ items: [] }) },
    { warn() {} },
    { syncBuiltinSchedule: (innerCtx, _logger, disabled) => syncBuiltinSchedule(innerCtx, { warn() {} }, disabled) },
  );
  const handler = routeHandler(routes);
  const { status, body } = await call(handler, 'POST', '/dsh-cron/api/builtin', { disabled: false });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(calls, [
    ['include:schedule', true], ['include:tool-schedule', true], ['include:ui-schedule', true],
  ]);
});
