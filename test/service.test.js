import test from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';

test('脚本模式：有输出就按唯一投递推送，记录退出码', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    await service.create({
      title: '回声',
      workspace: workspaces[0],
      mode: 'script',
      script: 'echo 高危端口 8080',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'tg-1' },
    });
    const task = service.list()[0];
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(run.exitCode, 0);
    assert.match(run.output, /8080/);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /8080/);
    assert.deepEqual(sent[0].target, { kind: 'im', botId: 'bot', targetId: 'tg-1' });
  } finally {
    await service.stop();
  }
});

test('脚本模式：空输出保持静默', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    await service.create({
      title: '静默', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'tg-1' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(sent.length, 0);
    assert.match(run.deliveryReason, /静默|无输出/);
  } finally {
    await service.stop();
  }
});

test('脚本失败：用同一个 delivery 发失败，累计连续失败', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    await service.create({
      title: '会挂的', workspace: workspaces[0], mode: 'script', script: 'sh -c "echo 炸了 >&2; exit 3"',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'ops' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'failed');
    assert.equal(run.exitCode, 3);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /定时任务失败/);
    assert.equal(service.store.find(task.id).state.consecutiveFailures, 1);
  } finally {
    await service.stop();
  }
});

test('失败消息也走同一个 delivery：silent 就完全不发', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    await service.create({
      title: '静默失败', workspace: workspaces[0], mode: 'script', script: 'sh -c "exit 1"',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'silent' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'failed');
    assert.equal(sent.length, 0);
    assert.equal(service.store.find(task.id).state.consecutiveFailures, 1);
  } finally {
    await service.stop();
  }
});

test('模型模式：拿到答案后按投递配置推送', async () => {
  const { service, sent, dispatches, workspaces } = await makeService();
  try {
    await service.create({
      title: '写日报', workspace: workspaces[0], mode: 'agent', prompt: '写今天的日报',
      schedule: { kind: 'daily', time: '09:00' },
      delivery: { kind: 'im', botId: 'bot', targetId: 'me' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].cwd, workspaces[0], '没指定 workdir 时落到任务所属工作区');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /模型给的答案/);
  } finally {
    await service.stop();
  }
});

test('模型模式：没答案时不推空消息', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    const dispatcher = service.dispatcher;
    dispatcher.dispatch = async () => ({ dispatched: true, output: '' });
    await service.create({
      title: '空答案', workspace: workspaces[0], mode: 'agent', prompt: '随便',
      schedule: { kind: 'daily', time: '09:00' },
      delivery: { kind: 'im', botId: 'bot', targetId: 'me' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(sent.length, 0);
  } finally {
    await service.stop();
  }
});

test('连续性是上次输出进入 prompt', async () => {
  const { service, dispatches, workspaces } = await makeService();
  try {
    await service.create({
      title: '接着上次', workspace: workspaces[0], mode: 'agent', prompt: '继续',
      schedule: { kind: 'daily', time: '09:00' },
      agent: { continuity: true },
    });
    const [task] = service.list();
    const record = service.store.find(task.id);
    record.state.lastOutput = '上次说到了第三段';
    await service.execute(record, 'manual');
    assert.match(dispatches[0].prompt, /上次说到了第三段/);
  } finally {
    await service.stop();
  }
});

test('超过硬超时会被打断', async () => {
  const { service, workspaces } = await makeService({ options: { timeLimitMs: 400 } });
  try {
    await service.create({
      title: '睡太久', workspace: workspaces[0], mode: 'script', script: 'sleep 5',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'timeout');
  } finally {
    await service.stop();
  }
});

test('repeat 到上限后不再排下一次', async () => {
  const { service, workspaces } = await makeService();
  try {
    await service.create({
      title: '跑两次就停', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 }, repeat: 2,
    });
    const [task] = service.list();
    const record = service.store.find(task.id);
    await service.execute(record, 'manual');
    await service.execute(record, 'manual');
    assert.equal(record.runCount, 2);
    assert.equal(service.store.find(record.id).state.nextRunAt, null);
  } finally {
    await service.stop();
  }
});

test('到点自动执行，记录 trigger=schedule', async () => {
  const { service, store, workspaces } = await makeService();
  try {
    await service.create({
      title: '自动跑', workspace: workspaces[0], mode: 'script', script: 'echo tick',
      schedule: { kind: 'hourly', minute: 0 },
    });
    const [task] = service.list();
    const record = store.find(task.id);
    record.state.nextRunAt = new Date(Date.now() - 1000).toISOString();
    // 任何一次任务表变更都会按新的到期时间重新定时，这里用它把定时器压到立即触发。
    await service.edit(task.id, { title: '自动跑' });

    await new Promise((resolve) => { setTimeout(resolve, 400); });
    const runs = await service.history(task.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, 'schedule');
  } finally {
    await service.stop();
  }
});

test('notepad 跨运行保存', async () => {
  const { service, workspaces } = await makeService();
  try {
    await service.create({
      title: '记事本', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const [task] = service.list();
    await service.notepad(task.id, { lastSeen: 'abc' });
    assert.deepEqual(service.store.find(task.id).notepad, { lastSeen: 'abc' });
    assert.deepEqual(service.view(task.id).state.notepad, { lastSeen: 'abc' });
    assert.deepEqual(await service.notepad(task.id), { lastSeen: 'abc' });
    assert.deepEqual(await service.notepad(task.id, null), {});
    assert.deepEqual(service.view(task.id).state.notepad, {});
  } finally {
    await service.stop();
  }
});

test('编辑：脚本与投递走归一化，调度换掉会重算下次执行', async () => {
  const { service, workspaces } = await makeService();
  try {
    const task = await service.create({
      title: '改我', workspace: workspaces[0], mode: 'script', script: 'echo 旧',
      schedule: { kind: 'every-minutes', interval: 10 },
    });
    const edited = await service.edit(task.id, {
      script: 'echo 新',
      delivery: { kind: 'im', botId: 'bot-wecom', targetId: 'ops' },
      schedule: { kind: 'daily', time: '09:00' },
    });
    assert.equal(edited.script.command, 'echo 新');
    assert.equal(edited.delivery.targetId, 'ops');
    assert.deepEqual(edited.schedule, { kind: 'daily', time: '09:00' });
    assert.equal(edited.scheduleText, '每天 09:00');
    assert.ok(edited.state.nextRunAt);

    const withContinuity = await service.edit(task.id, { repeat: 5, agent: { continuity: true } });
    assert.equal(withContinuity.repeat, 5);
    assert.equal(withContinuity.agent.continuity, true);
    await assert.rejects(() => service.edit(task.id, { repeat: 0 }), /repeat/);

    const cleared = await service.edit(task.id, { script: null });
    assert.equal(cleared.script, null);
    await assert.rejects(() => service.edit(task.id, { mode: 'nope' }), /mode/);
    // 已删除的 im-session 读到即退化，不再报错
    const degraded = await service.edit(task.id, { delivery: { kind: 'im-session' } });
    assert.equal(degraded.delivery.kind, 'silent');
  } finally {
    await service.stop();
  }
});

test('换工作区：任务整份数据搬过去', async () => {
  const { service, workspaces, sent } = await makeService({ workspaceCount: 2 });
  try {
    const task = await service.create({
      title: '搬家', workspace: workspaces[0], mode: 'script', script: 'echo 搬好了',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'ops' },
    });
    const moved = await service.edit(task.id, { workspace: workspaces[1] });
    assert.equal(moved.workspace, workspaces[1]);
    assert.equal(service.store.storeFor(workspaces[0]).all().length, 0);
    assert.equal(service.store.storeFor(workspaces[1]).all().length, 1);

    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.workspace, workspaces[1]);
    assert.equal(sent.length, 1);
  } finally {
    await service.stop();
  }
});

test('建任务缺工作区或工作区不是绝对路径都会拒绝', async () => {
  const { service, workspaces } = await makeService();
  try {
    await assert.rejects(
      () => service.create({ title: 'x', mode: 'script', script: 'true', schedule: { kind: 'hourly', minute: 0 } }),
      /workspace/,
    );
    await assert.rejects(
      () => service.create({
        title: 'x', workspace: 'ws/relative', mode: 'script', script: 'true', schedule: { kind: 'hourly', minute: 0 },
      }),
      /绝对路径/,
    );
    assert.equal(service.list().length, 0);
    assert.equal(workspaces.length, 1);
  } finally {
    await service.stop();
  }
});

test('状态与体检反映工作区和投递可用性', async () => {
  const { service, workspaces } = await makeService();
  try {
    await service.create({
      title: '好任务', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const status = service.status();
    assert.equal(status.running, true);
    assert.equal(status.taskCount, 1);
    assert.equal(status.timeZone, 'Asia/Shanghai');
    assert.deepEqual(status.delivery, { available: true });
    assert.deepEqual(status.workspaces.map((item) => item.path), [workspaces[0]]);
    assert.equal(status.activeRuns, 0);
    assert.ok(status.lastTickAt);

    const health = service.health();
    assert.equal(health.ok, true);
    assert.deepEqual(health.problems, []);
    assert.equal(health.disableBuiltinSchedule, false);
  } finally {
    await service.stop();
  }
});

test('预览接口给的是选择器对应的人话和接下来几次', async () => {
  const { service } = await makeService();
  try {
    const preview = service.preview({ kind: 'weekly', weekday: 1, time: '09:00' });
    assert.equal(preview.text, '每周一 09:00');
    assert.ok(preview.next.length >= 2);
    assert.ok(Date.parse(preview.next[0]) > Date.now());
  } finally {
    await service.stop();
  }
});

test('失败重试：首次失败会在重试里跑成功，只推一次失败通知', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    await service.create({
      title: '重试一次',
      workspace: workspaces[0],
      mode: 'script',
      // 第一次退出码 1，第二次成功；计数器放在 workspace 下。
      script: 'f=counter.txt; n=$(( $(cat $f 2>/dev/null || echo 0) + 1 )); echo $n > $f; [ $n -gt 1 ]',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'tg-1' },
      retries: 1,
    });
    service.options.retryDelayMs = 1;
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(run.attempts, 2);
    // 中间那次失败不该外发。
    assert.equal(sent.length, 0);
  } finally {
    await service.stop();
  }
});

test('失败重试：重试用尽后推一次失败，其余仍是最后一次的结论', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    await service.create({
      title: '一直失败',
      workspace: workspaces[0],
      mode: 'script',
      script: 'exit 3',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'tg-1' },
      retries: 2,
    });
    service.options.retryDelayMs = 1;
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'failed');
    assert.equal(run.attempts, 3);
    assert.equal(run.exitCode, 3);
    assert.equal(sent.length, 1);
  } finally {
    await service.stop();
  }
});

test('编辑：权限预设能设能清，重试与超时也走同一层归一化', async () => {
  const { service, workspaces } = await makeService();
  try {
    const task = await service.create({
      title: '改权限', workspace: workspaces[0], mode: 'agent', prompt: 'ping',
      schedule: { kind: 'daily', time: '09:00' },
    });
    assert.equal(task.permission, null);

    const edited = await service.edit(task.id, { permission: 'auto', retries: 2, timeoutMs: 30_000 });
    assert.equal(edited.permission, 'auto');
    assert.equal(edited.retries, 2);
    assert.equal(edited.timeoutMs, 30_000);

    const cleared = await service.edit(task.id, { permission: '', retries: null, timeoutMs: null });
    assert.equal(cleared.permission, null);
    assert.equal(cleared.retries, 0);
    assert.equal(cleared.timeoutMs, null);
  } finally {
    await service.stop();
  }
});

test('定时器睡到最早到期时间，没有任务时不挂定时器', async () => {
  const { service, store, workspaces } = await makeService();
  try {
    // 空任务表：进程完全空闲，不该有任何定时器。
    assert.equal(service.timer, null);

    const first = await service.create({
      title: '先到', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    const second = await service.create({
      title: '后到', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 30 },
    });

    // 把两条的到期时间摆好：定时器必须盯着最早那条，而不是固定间隔醒来。
    const now = Date.now();
    store.find(first.id).state.nextRunAt = new Date(now + 4_000).toISOString();
    store.find(second.id).state.nextRunAt = new Date(now + 600_000).toISOString();
    await service.edit(first.id, { title: '先到' });

    assert.ok(service.timer, '有任务时应当挂上定时器');
    const delay = service.timer._idleTimeout;
    assert.ok(delay > 0 && delay <= 4_000, `定时器应当睡到最早的到期时间，实际 ${delay}ms`);

    // 两条都删掉：定时器收起来，不再空转。
    await service.remove(first.id);
    await service.remove(second.id);
    assert.equal(service.timer, null);
  } finally {
    await service.stop();
  }
});

test('暂停的任务不参与定时', async () => {
  const { service, store, workspaces } = await makeService();
  try {
    const task = await service.create({
      title: '暂停的', workspace: workspaces[0], mode: 'script', script: 'true',
      schedule: { kind: 'every-minutes', interval: 5 },
    });
    await service.pause(task.id);
    assert.equal(store.find(task.id).state.nextRunAt, null);
    assert.equal(service.timer, null, '全暂停时不该有任何定时器');
  } finally {
    await service.stop();
  }
});

test('脚本模式：只有 stderr 有字时不推送，但字进运行记录', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    await service.create({
      title: '只有告警', workspace: workspaces[0], mode: 'script',
      script: 'sh -c "echo 只是警告 >&2; exit 0"',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'tg-1' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(sent.length, 0, 'stderr 不该变成一条推送');
    assert.match(run.output, /只是警告/, '运行记录里要留痕');
    assert.match(run.deliveryReason, /无输出|静默/);
  } finally {
    await service.stop();
  }
});

test('脚本模式：条件成立才写 stdout，条件不成立一声不响', async () => {
  const { service, sent, workspaces } = await makeService();
  try {
    await service.create({
      title: '看门狗', workspace: workspaces[0], mode: 'script',
      script: 'sh -c "if [ 1 -eq 2 ]; then echo 磁盘满了; fi"',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'tg-1' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(sent.length, 0);
  } finally {
    await service.stop();
  }
});

test('智能模式：整段只回 [silent] 就不推送', async () => {
  const { service, sent, dispatcher, workspaces } = await makeService();
  dispatcher.dispatch = async () => ({ dispatched: true, output: ' [SILENT] ', sessionId: 'session-1', path: 'session' });
  try {
    await service.create({
      title: '巡检', workspace: workspaces[0], mode: 'agent', prompt: '检查磁盘',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'tg-1' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(sent.length, 0, '模型要求静默时不该推送');
    assert.ok(!run.output, '标记不该进运行记录');
    assert.match(run.deliveryReason, /静默/);
  } finally {
    await service.stop();
  }
});

test('智能模式：正常答复照旧推送，prompt 里带上静默约定', async () => {
  const { service, sent, dispatches, workspaces } = await makeService();
  try {
    await service.create({
      title: '巡检2', workspace: workspaces[0], mode: 'agent', prompt: '检查磁盘',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'im', botId: 'bot', targetId: 'tg-1' },
    });
    const [task] = service.list();
    const run = await service.execute(service.store.find(task.id), 'manual');
    assert.equal(run.status, 'ok');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /模型给的答案/);
    assert.match(dispatches[0].prompt, /\[silent\]/);
  } finally {
    await service.stop();
  }
});

test('智能模式：没配渠道时不往 prompt 里塞静默约定', async () => {
  const { service, dispatches, workspaces } = await makeService();
  try {
    await service.create({
      title: '自用', workspace: workspaces[0], mode: 'agent', prompt: '整理笔记',
      schedule: { kind: 'every-minutes', interval: 5 },
      delivery: { kind: 'silent' },
    });
    const [task] = service.list();
    await service.execute(service.store.find(task.id), 'manual');
    assert.doesNotMatch(dispatches[0].prompt, /\[silent\]/);
  } finally {
    await service.stop();
  }
});

test('删除任务：它建出来的会话一并归档，用已有会话的不动', async () => {
  const archived = [];
  const workspaceService = {
    archiveSession: async (sessionId, options) => {
      archived.push({ sessionId, options });
    },
  };
  // 宿主把它挂在 workspaceRegistry 名下
  const { service, workspaces } = await makeService({
    ctx: { get: (name) => (name === 'workspaceRegistry' ? workspaceService : undefined) },
  });
  const [workspace] = workspaces;

  const own = await service.create({
    title: '用自己的会话',
    workspace,
    mode: 'agent',
    prompt: '跑一下',
    schedule: { kind: 'daily', time: '09:00' },
    target: { kind: 'new_once' },
  });
  const userSession = await service.create({
    title: '用已有会话',
    workspace,
    mode: 'agent',
    prompt: '跑一下',
    schedule: { kind: 'daily', time: '09:00' },
    target: { kind: 'existing', sessionId: 'session-mine' },
  });

  // 记一次运行，历史里的会话也算任务建出来的
  await service.runNow(own.id);

  const result = await service.remove(own.id);
  assert.equal(result.removed, true);
  assert.equal(result.sessions.archived, 1);
  assert.deepEqual(archived.map((item) => item.sessionId), ['session-1']);
  assert.equal(archived[0].options.stopActivity, true);

  archived.length = 0;
  const other = await service.remove(userSession.id);
  assert.equal(other.sessions.archived, 0);
  assert.deepEqual(archived, [], '用户自己的会话不该被归档');
});

test('没有 workspace 服务时删除任务不报错，如实记下跳过的会话', async () => {
  const { service, workspaces } = await makeService();
  const [workspace] = workspaces;
  const task = await service.create({
    title: '孤儿任务',
    workspace,
    mode: 'agent',
    prompt: '跑一下',
    schedule: { kind: 'daily', time: '09:00' },
  });
  await service.runNow(task.id);
  const result = await service.remove(task.id);
  assert.equal(result.removed, true);
  assert.equal(result.sessions.skipped, 1);
  assert.equal(result.sessions.archived, 0);
});

test('编辑任务不该把"复用的会话"丢掉', async () => {
  const { service, workspaces } = await makeService();
  try {
    const requests = [];
    service.dispatcher = {
      available: () => true,
      dispatch: async (request) => {
        requests.push(request);
        const sessionId = request.reusedSessionId ?? 'session-1';
        return { dispatched: true, output: '好', sessionId, reusedSessionId: sessionId, path: 'session' };
      },
    };
    const task = await service.create({
      title: '甲', prompt: '跑一轮', workspace: workspaces[0],
      schedule: { kind: 'every-minutes', interval: 5 }, delivery: { kind: 'silent' },
    });
    await service.execute(service.store.find(task.id), 'manual');
    assert.equal(service.store.find(task.id).state.targetSessionId, 'session-1');

    // 面板保存时总会带上整个 target，哪怕用户只改了标题。
    await service.edit(task.id, { title: '甲（改个名）', target: { kind: 'new_once' } });
    assert.equal(service.store.find(task.id).state.targetSessionId, 'session-1', '标题改动不该重置会话');

    await service.execute(service.store.find(task.id), 'manual');
    assert.equal(requests[1].reusedSessionId, 'session-1', '第二轮该复用同一个会话，而不是再建一个');
  } finally {
    await service.stop();
  }
});

test('换成每次新建会话，就把记住的会话清掉', async () => {
  const { service, workspaces } = await makeService();
  try {
    service.dispatcher = {
      available: () => true,
      dispatch: async (request) => ({
        dispatched: true, output: '好',
        sessionId: request.reusedSessionId ?? 'session-1',
        reusedSessionId: request.reusedSessionId ?? 'session-1',
        path: 'session',
      }),
    };
    const task = await service.create({
      title: '甲', prompt: '跑一轮', workspace: workspaces[0],
      schedule: { kind: 'every-minutes', interval: 5 }, delivery: { kind: 'silent' },
    });
    await service.execute(service.store.find(task.id), 'manual');
    assert.equal(service.store.find(task.id).state.targetSessionId, 'session-1');

    await service.edit(task.id, { target: { kind: 'new' } });
    assert.equal(service.store.find(task.id).state.targetSessionId, undefined);
  } finally {
    await service.stop();
  }
});

test('复用会话默认每轮清空上下文，显式关掉才带历史', async () => {
  const { service, workspaces } = await makeService();
  try {
    const requests = [];
    service.dispatcher = {
      available: () => true,
      dispatch: async (request) => {
        requests.push(request);
        const sessionId = request.reusedSessionId ?? 'session-ctx';
        return { dispatched: true, output: '好', sessionId, reusedSessionId: sessionId, path: 'session' };
      },
    };
    const keep = await service.create({
      title: '带历史', workspace: workspaces[0], mode: 'agent', prompt: '跑一下',
      schedule: { kind: 'every-minutes', interval: 5 }, delivery: { kind: 'silent' },
      target: { kind: 'new_once', freshContext: false },
    });
    const fresh = await service.create({
      title: '不带历史', workspace: workspaces[0], mode: 'agent', prompt: '跑一下',
      schedule: { kind: 'every-minutes', interval: 5 }, delivery: { kind: 'silent' },
      target: { kind: 'new_once' },
    });

    await service.execute(service.store.find(keep.id), 'manual');
    await service.execute(service.store.find(fresh.id), 'manual');
    assert.equal(requests[0].clearContext, false);
    assert.equal(requests[1].clearContext, true);
  } finally {
    await service.stop();
  }
});
