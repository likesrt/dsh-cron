import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeService, tempDir, logger } from './helpers.js';
import { TickLock } from '../lib/data/lock.js';
import { Delivery } from '../lib/runtime/deliver.js';
import { workspaceDataDir } from '../lib/data/store.js';

test('失败攒成一条 incident，恢复后自动关闭', async () => {
  const { service, workspaces } = await makeService();
  try {
    await service.create({
      title: '会挂的', workspace: workspaces[0], mode: 'script', script: 'sh -c "exit 2"',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const [created] = service.list();
    const record = service.store.find(created.id);
    await service.execute(record, 'manual');
    await service.execute(record, 'manual');

    const open = service.incidents('open');
    assert.equal(open.length, 1);
    assert.equal(open[0].count, 2);
    assert.equal(open[0].taskId, created.id);
    assert.equal(open[0].workspace, workspaces[0]);

    record.script = { command: 'echo ok' };
    await service.execute(record, 'manual');
    assert.equal(service.incidents('open').length, 0);
    assert.equal(service.incidents('resolved').length, 1);
  } finally {
    await service.stop();
  }
});

test('incident 落在本工作区的 incidents.json', async () => {
  const { service, workspaces } = await makeService({ workspaceCount: 2 });
  try {
    await service.create({
      title: '甲挂', workspace: workspaces[0], mode: 'script', script: 'false',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    await service.create({
      title: '乙好', workspace: workspaces[1], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const tasks = service.list();
    await service.execute(service.store.find(tasks.find((item) => item.title === '甲挂').id), 'manual');
    await service.execute(service.store.find(tasks.find((item) => item.title === '乙好').id), 'manual');

    const first = JSON.parse(await fs.readFile(path.join(workspaceDataDir(workspaces[0]), 'incidents.json'), 'utf8'));
    assert.equal(first.incidents.length, 1);
    // 没有故障的工作区不会凭空写出 incidents.json
    await assert.rejects(
      () => fs.readFile(path.join(workspaceDataDir(workspaces[1]), 'incidents.json'), 'utf8'),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    await service.stop();
  }
});

test('ack 后不再算待处理', async () => {
  const { service, workspaces } = await makeService();
  try {
    await service.create({
      title: '挂', workspace: workspaces[0], mode: 'script', script: 'false',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const [task] = service.list();
    await service.execute(service.store.find(task.id), 'manual');
    const [incident] = service.incidents('open');
    await service.ackIncident(incident.id);
    assert.equal(service.incidents('open').length, 0);
    assert.equal(service.incidents('acked').length, 1);
    await assert.rejects(() => service.ackIncident('nope'), /找不到/);
  } finally {
    await service.stop();
  }
});

test('体检指出具体问题', async () => {
  const { service, workspaces } = await makeService();
  try {
    // 只写别名是合法的（聊天里建任务拿不到 id），所以体检不吭声
    await service.create({
      title: '只写别名', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 }, delivery: { kind: 'im', target: 'yuyan' },
    });
    assert.deepEqual(service.health().problems, []);

    // id 写残了才点名
    const broken = await service.create({
      title: '残了的投递', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 }, delivery: { kind: 'im', botId: 'bot' },
    });
    const health = service.health();
    assert.equal(health.ok, false);
    assert.ok(health.problems.some((problem) => problem.taskId === broken.id && /投递目标/.test(problem.issue)));
  } finally {
    await service.stop();
  }
});

test('体检能发现调度写坏的任务', async () => {
  const { service, workspaces } = await makeService();
  try {
    const created = await service.create({
      title: '坏调度', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const record = service.store.find(created.id);
    record.schedule = { kind: 'cron', expression: '0 9 * *' };
    const health = service.health();
    assert.equal(health.ok, false);
    assert.ok(health.problems.some((problem) => /调度有问题/.test(problem.issue)));
  } finally {
    await service.stop();
  }
});

test('跨进程 tick 锁：别人持锁时本进程不执行', async () => {
  const { service, workspaces } = await makeService();
  try {
    await service.create({
      title: '到点', workspace: workspaces[0], mode: 'script', script: 'echo hi',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const [task] = service.list();
    const record = service.store.find(task.id);
    record.state.nextRunAt = new Date(Date.now() - 1000).toISOString();

    const rival = new TickLock(workspaceDataDir(workspaces[0]));
    assert.equal(await rival.acquire(), true);
    await service.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await service.history(task.id)).length, 0);

    await rival.release();
    await service.tick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await service.history(task.id)).length, 1);
  } finally {
    await service.stop();
  }
});

test('锁只挡住持锁的那个工作区', async () => {
  const { service, workspaces } = await makeService({ workspaceCount: 2 });
  try {
    const first = await service.create({
      title: '被锁住', workspace: workspaces[0], mode: 'script', script: 'echo 1',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const second = await service.create({
      title: '照常跑', workspace: workspaces[1], mode: 'script', script: 'echo 2',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    for (const id of [first.id, second.id]) {
      service.store.find(id).state.nextRunAt = new Date(Date.now() - 1000).toISOString();
    }

    const rival = new TickLock(workspaceDataDir(workspaces[0]));
    assert.equal(await rival.acquire(), true);
    await service.tick();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal((await service.history(first.id)).length, 0);
    assert.equal((await service.history(second.id)).length, 1);
    await rival.release();
  } finally {
    await service.stop();
  }
});

test('过期锁会被回收', async () => {
  const dir = await tempDir('dsh-cron-lock-');
  const stale = new TickLock(dir, { ttlMs: 10 });
  await stale.acquire();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const fresh = new TickLock(dir, { ttlMs: 10 });
  assert.equal(await fresh.acquire(), true);
  await fresh.release();
});

test('会话投递：写进会话日志而不唤醒模型', async () => {
  const appended = [];
  const fakeSession = { append: (type, data, options) => appended.push({ type, data, options }) };
  const ctx = {
    get: (name) => (name === 'sessions'
      ? { get: (id) => (id === 'session-1' ? fakeSession : undefined), flush: async () => true }
      : name === 'agents'
        ? { turnBoundaryOf: () => ({ turn: 3, step: 1 }) }
        : undefined),
  };
  const delivery = new Delivery(ctx, logger);
  const result = await delivery.send({ kind: 'session', sessionId: 'session-1' }, '端口 8080 对外开着');
  assert.equal(result.sent, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, 'assistant/message');
  assert.deepEqual(appended[0].options, { surfaceOp: 'append' });
  assert.equal(appended[0].data.turn, 3);
  assert.match(appended[0].data.message.content[0].text, /8080/);
});

test('会话投递：会话没开着时如实说', async () => {
  const delivery = new Delivery({ get: () => ({ get: () => undefined }) }, logger);
  const result = await delivery.send({ kind: 'session', sessionId: 'missing' }, 'x');
  assert.equal(result.sent, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /没开着/);
});

test('IM 投递：没装 dsh-im 时静默失败，不拖垮任务', async () => {
  const delivery = new Delivery({ get: () => undefined }, logger);
  assert.equal(delivery.available(), false);
  assert.deepEqual(await delivery.listTargets(), { available: false, bots: [] });
  const result = await delivery.send({ kind: 'im', botId: 'bot', targetId: 'ops' }, 'x');
  assert.equal(result.sent, false);
  assert.match(result.reason, /dsh-im/);
});

test('IM 投递：拿不到 id 时按已保存的目标去认', async () => {
  const sent = [];
  const bots = [
    { botId: 'wecomapp_beb5', channel: 'wecom-app', targets: [{ targetId: 'tgt_7be9', name: 'yuyan' }] },
    { botId: 'qq_2485', channel: 'qq', targets: [
      { targetId: 'tgt_a', name: '单聊 · 15D80' },
      { targetId: 'tgt_b', name: '单聊 · E1824' },
    ] },
  ];
  const service = {
    send: async (botId, targetId, text) => { sent.push({ botId, targetId, text }); return { sent: true }; },
    listBots: async () => bots,
    listTargets: async (botId) => bots.find((bot) => bot.botId === botId)?.targets ?? [],
  };
  const delivery = new Delivery({ get: () => service }, logger);
  assert.equal(delivery.available(), true);

  // 别名按名称认
  assert.deepEqual(await delivery.resolve({ kind: 'im', target: 'yuyan' }), { botId: 'wecomapp_beb5', targetId: 'tgt_7be9' });
  // 别名按 targetId 认
  assert.deepEqual(await delivery.resolve({ kind: 'im', target: 'tgt_7be9' }), { botId: 'wecomapp_beb5', targetId: 'tgt_7be9' });
  // 同名目标靠渠道分开
  assert.match((await delivery.resolve({ kind: 'im', target: '单聊', bot: 'qq' })).reason, /2 个目标都对得上|指明一个/);
  // 名字对不上，把现有的报出来
  assert.match((await delivery.resolve({ kind: 'im', target: '不存在的' })).reason, /现有：/);
  // 只有一个目标时什么都不填也认
  const only = new Delivery({ get: () => ({ ...service, listBots: async () => [bots[0]] }) }, logger);
  assert.deepEqual(await only.resolve({ kind: 'im', auto: true }), { botId: 'wecomapp_beb5', targetId: 'tgt_7be9' });

  // 认出来了就真的发出去
  const result = await delivery.send({ kind: 'im', target: 'yuyan' }, '  有内容  ');
  assert.deepEqual(result, { sent: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { botId: 'wecomapp_beb5', targetId: 'tgt_7be9', text: '有内容' });
});

test('IM 投递：没装 dsh-im 时说清楚', async () => {
  const delivery = new Delivery({ get: () => undefined }, logger);
  assert.equal(delivery.available(), false);
  assert.match((await delivery.send({ kind: 'im', target: 'x' }, '内容')).reason, /dsh-im/);
});

test('回原会话投递：现读会话绑定，再按渠道键翻译成路由', async () => {
  const calls = [];
  const bindings = {
    bound: { channel: 'wecom-app', botId: 'wecomapp_beb5', conversationKey: 'p2p:yuyan' },
    qq: { channel: 'qq', botId: 'qq_2485', conversationKey: 'c2c:OPENID' },
    weird: { channel: 'nope', botId: 'bot_x', conversationKey: 'p2p:x' },
  };
  const service = {
    send: async (botId, draft, text) => { calls.push({ botId, draft, text }); return { sent: true }; },
    listBots: async () => [],
    describeConversation: async (sessionId) => bindings[sessionId] ?? null,
  };
  const delivery = new Delivery({ get: () => service }, logger);

  assert.deepEqual(await delivery.send({ kind: 'origin', sessionId: 'bound' }, '  到点了  '), { sent: true });
  assert.deepEqual(calls[0], {
    botId: 'wecomapp_beb5', draft: { kind: 'user', route: { chatId: 'yuyan' } }, text: '到点了',
  });

  // QQ 的键是 c2c:<openid>
  assert.deepEqual(await delivery.send({ kind: 'origin', sessionId: 'qq' }, '内容'), { sent: true });
  assert.deepEqual(calls[1].draft, { kind: 'user', route: { userOpenId: 'OPENID' } });

  // 没绑聊天的会话（Web 端）：改写到这个会话的日志里
  const appended = [];
  const webDelivery = new Delivery({
    get: (name) => (name === 'sessions'
      ? { get: (id) => ({ append: (...args) => appended.push([id, ...args]) }) }
      : service),
  }, logger);
  const unbound = await webDelivery.send({ kind: 'origin', sessionId: 'free' }, '内容');
  assert.deepEqual(unbound, { sent: true });
  assert.equal(appended[0][0], 'free');
  assert.deepEqual(appended[0][2].message.content, [{ type: 'text', text: '内容' }]);

  // 认不出的渠道键不猜
  assert.match((await delivery.send({ kind: 'origin', sessionId: 'weird' }, '内容')).reason, /先设置里保存|保存一个投递目标/);

  // 聊天里 /new 过之后旧会话解绑，就按记下的渠道 + 会话键继续发
  const moved = await delivery.send({
    kind: 'origin', sessionId: 'gone', channel: 'wecom-app', botId: 'wecomapp_beb5', conversationKey: 'p2p:yuyan',
  }, '内容');
  assert.deepEqual(moved, { sent: true });
  assert.deepEqual(calls.at(-1), { botId: 'wecomapp_beb5', draft: { kind: 'user', route: { chatId: 'yuyan' } }, text: '内容' });

  // 老会话没有存 id 时退到这次运行自己的会话
  assert.deepEqual(await delivery.send({ kind: 'origin' }, '内容', { sessionId: 'bound' }), { sent: true });
  // 两个都没有就不发
  assert.match((await delivery.send({ kind: 'origin' }, '内容')).reason, /没有可回写的会话/);
});

test('originDelivery 只在会话真绑了聊天时才给出投递', async () => {
  const bound = new Delivery({ get: () => ({ send: async () => {}, listBots: async () => [], describeConversation: async () => ({ channel: 'wecom-app', botId: 'wecomapp_x', conversationKey: 'p2p:yuyan' }) }) }, logger);
  assert.deepEqual(await bound.originDelivery('s1'), {
    kind: 'origin', sessionId: 's1', channel: 'wecom-app', botId: 'wecomapp_x', conversationKey: 'p2p:yuyan',
  });

  const free = new Delivery({ get: () => ({ send: async () => {}, listBots: async () => [], describeConversation: async () => null }) }, logger);
  assert.equal(await free.originDelivery('s1'), null);

  const none = new Delivery({ get: () => undefined }, logger);
  assert.equal(await none.originDelivery('s1'), null);
});
