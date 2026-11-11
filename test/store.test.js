import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MultiStore, Store, defaultRegistryPath, workspaceDataDir } from '../lib/data/store.js';
import { makeService, tempDir } from './helpers.js';

test('单工作区 Store：读写 tasks.json / runs.jsonl', async () => {
  const workspace = await tempDir('dsh-cron-store-');
  const store = new Store(workspace, { timeZone: 'Asia/Shanghai' });
  await store.load();
  assert.deepEqual(store.all(), []);
  assert.equal(store.dir, path.join(workspace, 'dsh-cron'));

  store.insert({ id: 'a', title: '甲', workspace, schedule: { kind: 'daily', time: '09:00' }, state: {} });
  await store.save();
  const raw = JSON.parse(await fs.readFile(path.join(workspace, 'dsh-cron', 'tasks.json'), 'utf8'));
  assert.equal(raw.version, 2);
  assert.equal(raw.workspace, workspace);
  assert.equal(raw.tasks.length, 1);

  await store.appendRun({ runId: 'r1', taskId: 'a', startedAt: new Date().toISOString(), status: 'ok' });
  const runs = await store.readRuns({ taskId: 'a' });
  assert.equal(runs.length, 1);

  const reloaded = new Store(workspace, { timeZone: 'Asia/Shanghai' });
  await reloaded.load();
  assert.equal(reloaded.all().length, 1);
  assert.equal(reloaded.all()[0].workspace, workspace);
});

test('两个工作区各自落盘、互不干扰', async () => {
  const { service, workspaces } = await makeService({ workspaceCount: 2 });
  try {
    const [first, second] = workspaces;
    await service.create({
      title: '工作区一的任务',
      workspace: first,
      mode: 'script',
      script: 'true',
      schedule: { kind: 'daily', time: '09:00' },
    });
    await service.create({
      title: '工作区二的任务',
      workspace: second,
      mode: 'script',
      script: 'true',
      schedule: { kind: 'every-minutes', interval: 15 },
    });

    const firstFile = JSON.parse(await fs.readFile(path.join(first, 'dsh-cron', 'tasks.json'), 'utf8'));
    const secondFile = JSON.parse(await fs.readFile(path.join(second, 'dsh-cron', 'tasks.json'), 'utf8'));
    assert.deepEqual(firstFile.tasks.map((task) => task.title), ['工作区一的任务']);
    assert.deepEqual(secondFile.tasks.map((task) => task.title), ['工作区二的任务']);

    // 合并视图能看到两条
    assert.equal(service.list().length, 2);

    // 注册表登记了两个工作区
    const registry = JSON.parse(await fs.readFile(service.store.registryPath, 'utf8'));
    assert.equal(registry.version, 1);
    assert.deepEqual([...registry.workspaces].sort(), [...workspaces].sort());
  } finally {
    await service.stop();
  }
});

test('重开服务能从登记表把各工作区的任务合并回来', async () => {
  const { service, workspaces, registryPath } = await makeService({ workspaceCount: 2 });
  let ids;
  try {
    const a = await service.create({
      title: '甲', workspace: workspaces[0], mode: 'script', script: 'true', schedule: { kind: 'hourly', minute: 0 },
    });
    const b = await service.create({
      title: '乙', workspace: workspaces[1], mode: 'script', script: 'true', schedule: { kind: 'hourly', minute: 30 },
    });
    ids = [a.id, b.id];
  } finally {
    await service.stop();
  }

  const reopened = new MultiStore({ registryPath, timeZone: 'Asia/Shanghai' });
  await reopened.load();
  assert.equal(reopened.all().length, 2);
  assert.deepEqual(reopened.all().map((task) => task.id).sort(), [...ids].sort());
  assert.deepEqual(
    reopened.listWorkspaces().map((item) => item.taskCount).sort(),
    [1, 1],
  );
});

test('运行记录按工作区落盘，合并查询带工作区信息', async () => {
  const { service, store, workspaces } = await makeService({ workspaceCount: 2 });
  try {
    const first = await service.create({
      title: '甲', workspace: workspaces[0], mode: 'script', script: 'echo 一', schedule: { kind: 'hourly', minute: 0 },
    });
    const second = await service.create({
      title: '乙', workspace: workspaces[1], mode: 'script', script: 'echo 二', schedule: { kind: 'hourly', minute: 0 },
    });
    await service.execute(store.find(first.id), 'manual');
    await service.execute(store.find(second.id), 'manual');

    const firstRuns = await fs.readFile(path.join(workspaces[0], 'dsh-cron', 'runs.jsonl'), 'utf8');
    const secondRuns = await fs.readFile(path.join(workspaces[1], 'dsh-cron', 'runs.jsonl'), 'utf8');
    assert.equal(firstRuns.trim().split('\n').length, 1);
    assert.equal(secondRuns.trim().split('\n').length, 1);

    const merged = await service.history(undefined, 10);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((run) => run.workspace).sort(), [...workspaces].sort());
  } finally {
    await service.stop();
  }
});

test('旧格式 tasks.json 会被迁移并写回', async () => {
  const workspace = await tempDir('dsh-cron-migrate-');
  const dataDir = workspaceDataDir(workspace);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'cron-legacy',
          title: '旧任务',
          mode: 'hybrid',
          schedule: 'every 30m',
          script: 'echo hi',
          prompt: '总结',
          failureDelivery: { kind: 'im', botId: 'b', targetId: 't' },
          state: { notepad: { seen: '1' } },
        },
      ],
    }),
    'utf8',
  );

  const store = new Store(workspace, { timeZone: 'Asia/Shanghai' });
  await store.load();
  const [task] = store.all();
  assert.equal(task.mode, 'agent');
  assert.deepEqual(task.schedule, { kind: 'every-minutes', interval: 30 });
  assert.equal(task.failureDelivery, undefined);
  assert.deepEqual(task.notepad, { seen: '1' });
  assert.equal(store.migrated, true);

  await store.save();
  const written = JSON.parse(await fs.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.equal(written.version, 2);
  assert.deepEqual(written.tasks[0].schedule, { kind: 'every-minutes', interval: 30 });
  assert.equal(written.tasks[0].mode, 'agent');
});

test('登记表默认落在 DSH_HOME 下', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/fake-dsh-home';
  try {
    assert.equal(defaultRegistryPath(), '/tmp/fake-dsh-home/dsh-cron/workspaces.json');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
  assert.equal(workspaceDataDir('/abs/ws'), '/abs/ws/dsh-cron');
});

test('运行历史按保留天数与条数清理', async () => {
  const workspace = await tempDir('dsh-cron-runs-');
  const store = new Store(workspace, { timeZone: 'Asia/Shanghai', historyDays: 7, historyRecords: 3 });
  await store.load();

  const now = Date.parse('2026-11-11T00:00:00Z');
  const day = 86_400_000;
  const write = (taskId, index, ageDays) => store.appendRun({
    runId: `r-${taskId}-${index}`,
    taskId,
    startedAt: new Date(now - ageDays * day).toISOString(),
    status: 'ok',
  });

  // 太老的先写进去，跑一次清理就该没了
  await write('a', 0, 30);
  await write('b', 0, 30);
  assert.equal(await store.pruneRuns({ now }), 2);
  assert.deepEqual(await store.readRuns({ limit: 10 }), []);

  // 同一个任务写 5 条，只留最近 3 条
  for (let index = 1; index <= 5; index += 1) await write('a', index, 6 - index);
  assert.equal(await store.pruneRuns({ now }), 2);
  const kept = await store.readRuns({ taskId: 'a', limit: 10 });
  assert.deepEqual(kept.map((run) => run.runId), ['r-a-5', 'r-a-4', 'r-a-3']);
  assert.equal(kept.length, 3);
});

test('条数上限按任务各算，不把别的任务挤掉', async () => {
  const workspace = await tempDir('dsh-cron-runs-');
  const store = new Store(workspace, { timeZone: 'Asia/Shanghai', historyDays: 30, historyRecords: 2 });
  await store.load();
  const startedAt = new Date().toISOString();
  for (const taskId of ['a', 'b']) {
    for (let index = 0; index < 4; index += 1) {
      await store.appendRun({ runId: `${taskId}-${index}`, taskId, startedAt, status: 'ok' });
    }
  }
  await store.pruneRuns();
  assert.equal((await store.readRuns({ taskId: 'a', limit: 10 })).length, 2);
  assert.equal((await store.readRuns({ taskId: 'b', limit: 10 })).length, 2);
});

test('MultiStore 把历史保留配置带给每个工作区', async () => {
  const registryPath = path.join(await tempDir('dsh-cron-reg-'), 'workspaces.json');
  const store = new MultiStore({ registryPath, timeZone: 'Asia/Shanghai', historyDays: 5, historyRecords: 40 });
  const workspace = await tempDir('dsh-cron-ws-');
  const one = await store.addWorkspace(workspace);
  assert.equal(one.historyDays, 5);
  assert.equal(one.historyRecords, 40);

  const fallback = new MultiStore({ registryPath, timeZone: 'Asia/Shanghai' });
  const two = await fallback.addWorkspace(workspace);
  assert.equal(two.historyDays, 30);
  assert.equal(two.historyRecords, 200);
});
