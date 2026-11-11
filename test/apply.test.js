import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeContext, tempDir } from './helpers.js';

/** apply 只需要一个临时登记表和一个工作区；不碰真实 $DSH_HOME。 */
async function makeEnv(prefix = 'dsh-cron-apply-') {
  const root = await tempDir(prefix);
  const registryPath = path.join(root, 'dsh-cron', 'workspaces.json');
  const workspace = path.join(root, 'ws');
  await fs.mkdir(workspace, { recursive: true });
  return { root, registryPath, workspace };
}

test('apply 起服务、挂工具、挂接口、提供 cron 服务', async () => {
  const { apply, name, inject } = await import('../lib/index.js');
  assert.equal(name, 'dsh-cron');
  assert.deepEqual([...inject], ['tools', 'webServer']);

  const { registryPath, workspace } = await makeEnv();
  const { ctx, tools, routes, provided } = fakeContext();
  await apply(ctx, { registryPath, timeZone: 'Asia/Shanghai', disableBuiltinSchedule: true });

  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'cron_ack', 'cron_create', 'cron_edit', 'cron_health', 'cron_incidents',
    'cron_list', 'cron_notepad', 'cron_remove', 'cron_run', 'cron_runs', 'cron_targets', 'cron_view',
  ]);
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`);
    assert.equal(tool.parameters?.type, 'object', `${tool.name} 的参数不是 object schema`);
    assert.ok(tool.output?.schema, `${tool.name} 缺 output schema`);
  }

  // 契约 §2/§3：工具描述里不再出现已删除的模式和失败通道
  const create = tools.find((tool) => tool.name === 'cron_create');
  assert.doesNotMatch(create.description, /monitor|hybrid|failureDelivery/);
  assert.deepEqual(create.parameters.properties.mode.enum, ['script', 'agent']);
  assert.deepEqual(create.parameters.properties.schedule.properties.kind.enum, [
    'once', 'monthly', 'weekly', 'daily', 'hourly', 'every-days', 'every-hours', 'every-minutes', 'every-seconds', 'cron',
  ]);
  assert.ok(create.parameters.required.includes('workspace'));

  const route = routes.find((item) => item.path === '/dsh-cron');
  assert.ok(route, '没有注册 /dsh-cron 路由');
  assert.equal(route.kind, 'prefix');

  const cron = provided.get('cron');
  assert.ok(cron, '没有 provide cron 服务');
  assert.equal(cron.contractVersion, 2);

  const created = await cron.create({
    title: '面板外建的',
    workspace,
    mode: 'script',
    script: 'true',
    schedule: { kind: 'every-minutes', interval: 5 },
  });
  assert.equal(created.workspace, workspace);
  assert.equal((await cron.list()).length, 1);
  assert.equal(cron.view(created.id).title, '面板外建的');
  assert.equal(cron.health().ok, true);
  assert.deepEqual(cron.incidents('open'), []);
  assert.deepEqual(cron.workspaces().map((item) => item.taskCount), [1]);
  await cron.remove(created.id);
  assert.equal((await cron.list()).length, 0);

  // 任务数据确实落在 <workspace>/dsh-cron 下
  const dataDir = path.join(workspace, 'dsh-cron');
  const tasks = JSON.parse(await fs.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.deepEqual(tasks.tasks, []);
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  assert.deepEqual(registry.workspaces, [workspace]);
});

test('devReload 打开时能重复挂载（每次 import 新实现体）', async () => {
  const { apply } = await import('../lib/index.js');
  const { registryPath } = await makeEnv('dsh-cron-apply2-');
  for (let round = 0; round < 2; round += 1) {
    const { ctx, tools, provided, disposers } = fakeContext();
    await apply(ctx, { registryPath, devReload: true });
    assert.equal(tools.length, 12);
    assert.ok(provided.get('cron'));
    for (const dispose of disposers) await dispose();
  }
});
