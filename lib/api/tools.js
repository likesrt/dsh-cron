/**
 * 模型可用的工具：在聊天里管定时任务。
 */

const devBust = globalThis.__dshCronDevBust ?? '';
const { CronError } = await import(`../core/cron.js${devBust}`);
const { TaskError } = await import(`../core/model.js${devBust}`);

const SCHEDULE_HELP = [
  '时间用选择器对象，不要写 "every 30m" 这种字符串：',
  'once{date YYYY-MM-DD, time}（到点只跑一次）、',
  'monthly{dayOfMonth 1-31, time}、weekly{weekday 1-7（1=周一）, time}、daily{time}、hourly{minute}、',
  'every-days{interval, time}、every-hours{interval, minute}、every-minutes{interval}、',
  'every-seconds{interval}、cron{expression}（自定义 5/6 段）。time 形如 "09:30"。',
].join('');

function text(args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function objectOutput(properties = {}) {
  return { type: 'object', properties };
}

/** 发起这次调用的会话 id。 */
function callSessionId(exec) {
  const sessionId = exec?.agent?.session?.id;
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null;
}

/**
 * 不写推送时的默认落点：从哪儿建的，结果就回到哪儿。
 * 会话绑着聊天（企微/QQ 等）就发回那个聊天；没绑（Web 端）就写回这个会话的日志。
 * @returns 投递对象，或 null（连会话都没有，交给插件默认的静默）。
 */
async function defaultDelivery(service, exec) {
  const sessionId = callSessionId(exec);
  if (sessionId === null) return null;
  if (typeof service.delivery?.originDelivery === 'function') {
    const origin = await service.delivery.originDelivery(sessionId);
    if (origin !== null) return origin;
  }
  return { kind: 'session', sessionId };
}

/**
 * 只写了别名/渠道的 im 投递，能认出来就当场换成真实 id 存下来——面板和运行记录都好读。
 * 认不出来（没有目标、或有多个都对得上）就原样留着，运行时再报候选。
 */
async function resolveIm(service, delivery) {
  if (delivery?.kind !== 'im' || (delivery.botId && delivery.targetId)) return delivery;
  if (typeof service.delivery?.resolve !== 'function') return delivery;
  const resolved = await service.delivery.resolve(delivery);
  if (typeof resolved?.botId !== 'string' || typeof resolved?.targetId !== 'string') return delivery;
  return { kind: 'im', botId: resolved.botId, targetId: resolved.targetId };
}

/** 显式要了 origin / 会话日志但没写会话时，补上发起这次调用的会话。 */
function fillSession(delivery, exec) {
  if (delivery?.kind !== 'origin' && delivery?.kind !== 'session') return delivery;
  if (delivery.sessionId !== undefined) return delivery;
  const sessionId = callSessionId(exec);
  return sessionId === null ? delivery : { ...delivery, sessionId };
}

function failure(error) {
  if (error instanceof TaskError || error instanceof CronError) {
    return { ok: false, error: error.message, code: error.code };
  }
  return { ok: false, error: error?.message ?? String(error), code: 'internal_error' };
}

const DELIVERY_SCHEMA = {
  type: 'object',
  description: '结果推送。不填=回到发起任务的地方（绑了聊天就发回那个聊天，Web 会话就写回这个会话）；silent=不推送；im=推到已保存的 IM 目标（有 target 别名就够）；origin=发回发起任务的聊天；session 追加到指定会话的日志（不驱动模型）。',
  properties: {
    kind: { type: 'string', enum: ['silent', 'im', 'origin', 'session'] },
    botId: { type: 'string' },
    targetId: { type: 'string' },
    target: { type: 'string', description: 'im：目标名或 targetId。先调 cron_targets 看有哪些。' },
    bot: { type: 'string', description: 'im：渠道或 botId，用来在有多个同名目标时挑渠道（如 wecom-app）。' },
    sessionId: { type: 'string', description: 'session：不填就写回这次运行自己的会话（agent 任务由执行位置决定）。' },
  },
  required: ['kind'],
};

const TARGET_SCHEMA = {
  type: 'object',
  description: [
    'agent 任务跑在哪个会话里。new_once=新建一个会话并复用（默认，也是绝大多数情况该用的）；',
    'new=每次新建一个会话；existing=关联工作区里已有的会话（需 sessionId）。',
    '用户没特别说会话怎么处理时，不填 target 就行，别默认写 new。',
  ].join(''),
  properties: {
    kind: { type: 'string', enum: ['new_once', 'new', 'existing'] },
    sessionId: { type: 'string' },
  },
  required: ['kind'],
};

const SCRIPT_SCHEMA = {
  oneOf: [
    { type: 'string', description: '整条命令，按 shell 执行。' },
    {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string', description: '默认就是任务所属工作区。' },
        shell: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
        env: { type: 'object' },
      },
      required: ['command'],
    },
  ],
};

const SCHEDULE_SCHEMA = {
  type: 'object',
  description: SCHEDULE_HELP,
  properties: {
    kind: {
      type: 'string',
      enum: [
        'once',
        'monthly',
        'weekly',
        'daily',
        'hourly',
        'every-days',
        'every-hours',
        'every-minutes',
        'every-seconds',
        'cron',
      ],
    },
    dayOfMonth: { type: 'integer', description: 'monthly：1-31。' },
    weekday: { type: 'integer', description: 'weekly：1=周一 … 7=周日。' },
    date: { type: 'string', description: 'once：YYYY-MM-DD，到点跑一次。' },
    time: { type: 'string', description: '形如 09:30；once / monthly / weekly / daily / every-days 用。' },
    minute: { type: 'integer', description: 'hourly / every-hours：0-59。' },
    interval: { type: 'integer', description: 'every-* 的间隔。' },
    expression: { type: 'string', description: 'cron：5 段或 6 段表达式。' },
  },
  required: ['kind'],
};

const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    workdir: { type: 'string', description: '默认就是任务所属工作区。' },
    preset: { type: 'string', description: '智能模式用哪个 Agent（宿主预置），不填用宿主默认。' },
    provider: { type: 'string', description: '智能模式用哪个提供商，配合 model 使用。' },
    model: { type: 'string', description: '智能模式用哪个模型，配合 provider 使用。' },
    continuity: { type: 'boolean', description: '每次把上次输出喂给模型。' },
    contextFrom: { type: 'array', items: { type: 'string' }, description: '其它任务的 id，把它们的上次产物带上。' },
  },
};

export function createCronTools(service) {
  const tools = [];

  tools.push({
    name: 'cron_targets',
    description: '列出 dsh-im 里已保存的投递目标（机器人 + targetId + 名称 + 渠道）。建任务要推送时先看这个，别猜 botId/targetId。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: objectOutput({ available: { type: 'boolean' }, bots: { type: 'array' } }),
      render: text,
    },
    async execute() {
      return service.delivery.listTargets();
    },
  });

  tools.push({
    name: 'cron_create',
    description: [
      '新建一条定时任务。',
      '模式默认 agent（智能模式）：把 prompt 交给模型跑一轮，配了渠道时模型整段只回 [silent] 就不推送这一轮。',
      'mode=script（脚本模式）只跑命令、不经过模型，stdout 有内容才推送、stdout 为空就静默（stderr 只进运行记录）。',
      '用户明确说要跑某个命令/脚本才用 script；不要因为"看起来像一条命令"就自己降级成脚本模式。',
      '如果你判断这条任务用脚本模式明显更合适（只是跑个命令、查个端口、看一眼 git 状态），先把建议和理由说给用户，等用户点头再建，别自己决定。',
      '任务必须归属一个工作区（绝对路径），配置、历史、故障记录都落在 <workspace>/dsh-cron/ 下。',
      '成功和失败共用一个 delivery，silent 就是什么都不发。',
      '聊天里建任务时通常拿不到 botId/targetId：用 cron_targets 看已保存的目标，delivery 只写 target（目标名或 targetId）即可；只有一个目标时 delivery 只写 {kind:"im"} 也能自动认。',
      'agent 任务另有 target 决定跑在哪个会话里，与 delivery 无关。',
      SCHEDULE_HELP,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务名，便于识别的短语。' },
        workspace: { type: 'string', description: '工作区绝对路径，必填。' },
        schedule: SCHEDULE_SCHEMA,
        mode: { type: 'string', enum: ['script', 'agent'], description: '默认 agent（智能模式）。只有用户明确要跑命令/脚本时才写 script。' },
        prompt: { type: 'string', description: '智能模式下交给模型的话。' },
        script: SCRIPT_SCHEMA,
        delivery: DELIVERY_SCHEMA,
        target: TARGET_SCHEMA,
        repeat: { type: 'integer', description: '跑够这么多次自动停；不填表示一直跑。' },
        retries: { type: 'integer', description: '失败后重试几次，0..5，不填就是 0。超时不重试。' },
        timeoutMs: { type: 'integer', description: '这条任务的单次超时（毫秒），不填用插件全局超时。' },
        permission: { type: 'string', description: '智能模式用哪个权限预设（read-only / workspace-write / danger-full-access / auto），不填沿用会话自己的。' },
        tags: { type: 'array', items: { type: 'string' } },
        agent: AGENT_SCHEMA,
      },
      required: ['title', 'workspace', 'schedule'],
    },
    output: {
      schema: objectOutput({
        id: { type: 'string' },
        title: { type: 'string' },
        scheduleText: { type: 'string' },
        nextRunAt: { type: 'string' },
      }),
      render: text,
    },
    async execute(args, exec) {
      try {
        const input = { ...args, delivery: fillSession(args.delivery, exec) };
        // 不写 delivery 就是默认行为：从哪儿建的，结果就回到哪儿。
        if (input.delivery === undefined) {
          const fallback = await defaultDelivery(service, exec);
          if (fallback !== null) input.delivery = fallback;
        }
        input.delivery = await resolveIm(service, input.delivery);
        const task = await service.create(input);
        return {
          ok: true,
          id: task.id,
          title: task.title,
          mode: task.mode,
          workspace: task.workspace,
          scheduleText: task.scheduleText,
          nextRunAt: task.state?.nextRunAt ?? null,
        };
      } catch (error) {
        return failure(error);
      }
    },
  });

  tools.push({
    name: 'cron_list',
    description: '列出所有定时任务（含已停止的），按下次执行时间排序。',
    parameters: {
      type: 'object',
      properties: { includeEnded: { type: 'boolean', description: '默认 true。' } },
    },
    output: { schema: objectOutput({ items: { type: 'array' } }), render: text },
    async execute(args) {
      const items = service.list({ includeEnded: args?.includeEnded !== false }).map((task) => ({
        id: task.id,
        title: task.title,
        workspace: task.workspace,
        mode: task.mode,
        scheduleText: task.scheduleText,
        enabled: task.enabled,
        nextRunAt: task.state?.nextRunAt ?? null,
        lastRunAt: task.state?.lastRunAt ?? null,
        lastResult: task.state?.lastResult ?? null,
        failures: task.state?.consecutiveFailures ?? 0,
        runCount: task.runCount,
        repeat: task.repeat,
        retries: task.retries,
        permission: task.permission ?? null,
        delivery: task.delivery?.kind ?? 'silent',
        target: task.target?.kind ?? 'new_once',
        targetSessionId: task.targetSessionId ?? null,
        preset: task.agent?.preset ?? null,
        model: task.agent?.provider && task.agent?.model ? `${task.agent.provider}/${task.agent.model}` : null,
      }));
      return { items };
    },
  });

  tools.push({
    name: 'cron_view',
    description: '查看一条定时任务的完整配置和状态。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: { schema: objectOutput({ task: { type: 'object' } }), render: text },
    async execute(args) {
      const task = service.view(args.id);
      if (!task) return { ok: false, error: `找不到任务 ${args.id}` };
      return { task };
    },
  });

  tools.push({
    name: 'cron_edit',
    description: '改一条定时任务：标题、调度、模式、prompt、脚本、执行位置、推送、启停、次数上限、所属工作区。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        workspace: { type: 'string', description: '换工作区会连同任务配置一起搬过去。' },
        schedule: SCHEDULE_SCHEMA,
        mode: { type: 'string', enum: ['script', 'agent'], description: '要改模式才写。改成 script 只在用户明确要跑命令时；拿不准就先问用户。' },
        prompt: { type: 'string' },
        script: SCRIPT_SCHEMA,
        delivery: DELIVERY_SCHEMA,
        target: TARGET_SCHEMA,
        repeat: { type: 'integer' },
        retries: { type: 'integer' },
        timeoutMs: { type: 'integer' },
        permission: { type: 'string' },
        enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        agent: AGENT_SCHEMA,
      },
      required: ['id'],
    },
    output: { schema: objectOutput({ task: { type: 'object' } }), render: text },
    async execute(args, exec) {
      try {
        const { id, ...patch } = args;
        if (patch.delivery !== undefined) patch.delivery = await resolveIm(service, fillSession(patch.delivery, exec));
        return { ok: true, task: await service.edit(id, patch) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  tools.push({
    name: 'cron_run',
    description: '立即运行一次（手动触发，不影响原来的调度节奏）。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: { schema: objectOutput({ run: { type: 'object' } }), render: text },
    async execute(args) {
      try {
        const run = await service.runNow(args.id);
        return { ok: run.status === 'ok', run };
      } catch (error) {
        return failure(error);
      }
    },
  });

  tools.push({
    name: 'cron_remove',
    description: '删除一条定时任务；它建出来的会话会一并归档（关联已有会话的不动）。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: {
      schema: objectOutput({
        removed: { type: 'boolean' },
        sessions: {
          type: 'object',
          properties: {
            archived: { type: 'number', description: '归档的会话数' },
            skipped: { type: 'number', description: '环境不支持归档时没动过的会话数' },
            failed: { type: 'number', description: '归档失败的会话数' },
          },
        },
      }),
      render: text,
    },
    async execute(args) {
      try {
        return { ok: true, ...(await service.remove(args.id)) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  tools.push({
    name: 'cron_runs',
    description: '查执行历史：状态、耗时、输出、错误。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '只看某条任务；不填看全部。' },
        limit: { type: 'integer', description: '默认 20。' },
      },
    },
    output: { schema: objectOutput({ runs: { type: 'array' } }), render: text },
    async execute(args) {
      return { runs: await service.history(args?.id, args?.limit ?? 20) };
    },
  });

  tools.push({
    name: 'cron_notepad',
    description: '任务的跨运行记事本（KV）：不填 value 读取，填了写入，clear=true 清空。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
        clear: { type: 'boolean' },
      },
      required: ['id'],
    },
    output: { schema: objectOutput({ notepad: { type: 'object' } }), render: text },
    async execute(args) {
      try {
        if (args.clear) return { ok: true, notepad: await service.notepad(args.id, null) };
        if (args.key !== undefined && args.value !== undefined) {
          return { ok: true, notepad: await service.notepad(args.id, { [args.key]: args.value }) };
        }
        return { ok: true, notepad: await service.notepad(args.id) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  tools.push({
    name: 'cron_incidents',
    description: '长期失败事件列表：哪条任务一直在挂、挂了几次、最近一次错误。',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'resolved', 'acked'], description: '不填看全部。' } },
    },
    output: { schema: objectOutput({ incidents: { type: 'array' } }), render: text },
    async execute(args) {
      return { incidents: service.incidents(args?.status) };
    },
  });

  tools.push({
    name: 'cron_ack',
    description: '确认一条故障记录，确认后不再出现在待处理里。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: { schema: objectOutput({ incident: { type: 'object' } }), render: text },
    async execute(args) {
      try {
        return { ok: true, incident: await service.ackIncident(args.id) };
      } catch (error) {
        return failure(error);
      }
    },
  });

  tools.push({
    name: 'cron_health',
    description: '体检：找出配置有问题的任务（缺脚本、缺 prompt、调度写错、投递目标不完整等）。',
    parameters: { type: 'object', properties: {} },
    output: { schema: objectOutput({ health: { type: 'object' } }), render: text },
    async execute() {
      return { health: service.health() };
    },
  });

  return tools;
}
