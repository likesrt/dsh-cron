/**
 * 推送：把结果交给 dsh-im 的聊天目标，或写进某个会话的日志，或什么都不做。
 *
 * dsh-im 是可选的：不写进 inject，用 ctx.get('dshIm') 现查，
 * 任何失败都退化成一条运行记录里的原因，不能让任务本身失败。
 */

/**
 * 会话键 → 投递路由。
 *
 * dsh-im 把「哪个聊天」记成会话键（如 wecom-app 的 p2p:yuyan），主动投递要的是
 * {kind, route} 这一组平台字段。这里按各渠道的键格式翻译，规则与 dsh-im 的
 * delivery-suggestions 一致；认不出来的键不猜，让调用方去设置里保存目标。
 */
const KEY_CHANNELS = new Set([
  'weixin', 'feishu', 'dingtalk', 'wecom', 'wecom-app', 'qq',
  'slack', 'telegram', 'discord', 'whatsapp', 'imessage', 'matrix',
]);

function afterPrefix(key, prefix) {
  const marker = `${prefix}:`;
  if (!key.startsWith(marker)) return null;
  const value = key.slice(marker.length);
  if (value === '' || value.trim() !== value || /[\s:\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function simpleRoute(key, definitions) {
  for (const [prefix, kind, field] of definitions) {
    const value = afterPrefix(key, prefix);
    if (value !== null) return { kind, route: { [field]: value } };
  }
  return null;
}

/** Turn one persisted conversation key into the route fields the channel sends with. */
export function conversationRoute(channel, key) {
  if (!KEY_CHANNELS.has(channel) || typeof key !== 'string') return null;
  switch (channel) {
    case 'weixin':
      return simpleRoute(key, [['p2p', 'user', 'toUserId']]);
    case 'wecom-app':
      return simpleRoute(key, [['p2p', 'user', 'chatId']]);
    case 'wecom':
      return simpleRoute(key, [['direct', 'user', 'chatId'], ['group', 'group', 'chatId']]);
    case 'dingtalk':
      return simpleRoute(key, [['p2p', 'user', 'userId'], ['group', 'group', 'openConversationId']]);
    case 'qq':
      return simpleRoute(key, [['c2c', 'user', 'userOpenId'], ['group', 'group', 'groupOpenId']]);
    case 'feishu': {
      const openId = afterPrefix(key, 'p2p');
      if (openId !== null && openId.startsWith('ou_')) return { kind: 'user', route: { openId } };
      return simpleRoute(key, [['group', 'group', 'chatId']]);
    }
    case 'telegram': {
      const match = /^(direct|group):(-?\d+)(?::([1-9]\d*))?$/.exec(key);
      if (match === null) return null;
      if (match[3] === undefined) return { kind: 'chat', route: { chatId: match[2] } };
      return { kind: 'topic', route: { chatId: match[2], messageThreadId: Number(match[3]) } };
    }
    case 'slack': {
      const direct = afterPrefix(key, 'direct');
      if (direct !== null) return { kind: 'conversation', route: { channelId: direct } };
      const match = /^group:([^:]+):(\d{1,20}(?:\.\d{1,20})?)$/.exec(key);
      return match === null ? null : { kind: 'thread', route: { channelId: match[1], threadTs: match[2] } };
    }
    case 'discord': {
      const match = /^(?:direct|group):(\d{1,32})$/.exec(key);
      return match === null ? null : { kind: 'channel', route: { channelId: match[1] } };
    }
    case 'whatsapp': {
      const direct = /^direct:(\d{5,32}@(?:s\.whatsapp\.net|lid))$/.exec(key);
      if (direct !== null) return { kind: 'user', route: { jid: direct[1] } };
      const group = /^group:(\d{5,32}(?:-\d{1,32})?@g\.us)$/.exec(key);
      return group === null ? null : { kind: 'group', route: { jid: group[1] } };
    }
    case 'matrix': {
      const direct = /^(?:dm|direct:dm):(@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?)$/.exec(key);
      if (direct !== null) return { kind: 'dm', route: { userId: direct[1] } };
      const room = /^(?:room|direct:room):([!#][^:$\s]+:[A-Za-z0-9.-]+(?::\d{1,5})?)(?:\$\$([^\s]+))?$/u.exec(key);
      if (room === null) return null;
      return room[2] === undefined
        ? { kind: 'room', route: { roomId: room[1] } }
        : { kind: 'thread', route: { roomId: room[1], threadId: `$${room[2]}` } };
    }
    case 'imessage': {
      const guid = key.startsWith('direct:') ? key.slice('direct:'.length) : '';
      return /^(?:iMessage|any);-;[^;]+$/u.test(guid) ? { kind: 'user', route: { chatGuid: guid } } : null;
    }
    default:
      return null;
  }
}

export class Delivery {
  constructor(ctx, logger = console) {
    this.ctx = ctx;
    this.logger = logger;
  }

  service() {
    const service = this.ctx.get?.('dshIm') ?? undefined;
    if (!service || typeof service.send !== 'function') return null;
    return service;
  }

  available() {
    return this.service() !== null;
  }

  /** Saved IM targets the panel can offer, grouped by bot. */
  async listTargets() {
    const service = this.service();
    if (!service) return { available: false, bots: [] };
    const bots = await service.listBots();
    const out = [];
    for (const bot of bots) {
      try {
        const targets = await service.listTargets(bot.botId);
        out.push({ ...bot, targets: Array.isArray(targets) ? targets : [] });
      } catch (error) {
        out.push({ ...bot, targets: [], error: error?.message ?? String(error) });
      }
    }
    return { available: true, bots: out };
  }

  /**
   * Append a finished result into a Session log. A pure log write: the message
   * shows up in that conversation without starting a model turn.
   */
  async #appendToSession(delivery, body) {
    const sessions = this.ctx.get?.('sessions');
    if (!sessions?.get) return { sent: false, skipped: true, reason: 'sessions 服务不可用' };
    const session = sessions.get(delivery.sessionId);
    if (!session || typeof session.append !== 'function') {
      return { sent: false, skipped: true, reason: '那个会话没开着，写不进去' };
    }
    let boundary = { turn: 0, step: 0 };
    try {
      boundary = this.ctx.get?.('agents')?.turnBoundaryOf?.(session) ?? boundary;
    } catch {
      /* 回落到 0 位置，日志照样写进去 */
    }
    try {
      session.append(
        'assistant/message',
        {
          turn: Number(boundary?.turn ?? 0),
          step: Number(boundary?.step ?? 0),
          message: { role: 'assistant', content: [{ type: 'text', text: body }] },
          stream: [],
        },
        { surfaceOp: 'append' },
      );
      await sessions.flush?.(session);
      return { sent: true };
    } catch (error) {
      return { sent: false, reason: `写会话失败：${error?.message ?? error}` };
    }
  }

  /**
   * 这个会话现在绑在哪个聊天上？没绑就别记成「回原会话」，省得每轮都记一条空投递。
   * @returns {Promise<{kind: 'origin', sessionId: string} | null>}
   */
  async originDelivery(sessionId) {
    const service = this.service();
    if (!service || typeof sessionId !== 'string' || sessionId === '') return null;
    if (typeof service.describeConversation !== 'function') return null;
    try {
      const described = await service.describeConversation(sessionId);
      if (!described) return null;
      const delivery = { kind: 'origin', sessionId };
      for (const key of ['channel', 'botId', 'conversationKey']) {
        if (typeof described[key] === 'string' && described[key] !== '') delivery[key] = described[key];
      }
      return delivery;
    } catch {
      return null;
    }
  }

  /**
   * 把一条 im 投递解析成真实的 botId + targetId。
   *
   * 聊天里建任务时拿不到这两个 id（targetId 是用户在设置里起的别名），所以允许只填目标名
   * 或渠道，甚至什么都不填——只要存下来的目标只有一个，就用它。
   * @returns {Promise<{botId: string, targetId: string} | {reason: string}>}
   */
  async resolve(delivery) {
    if (!delivery || delivery.kind !== 'im') return { reason: '不是 im 投递' };
    if (delivery.botId && delivery.targetId) return { botId: delivery.botId, targetId: delivery.targetId };
    let listed;
    try {
      listed = await this.listTargets();
    } catch (error) {
      return { reason: `读不到已保存的投递目标：${error?.message ?? error}` };
    }
    if (!listed.available) return { reason: 'dsh-im 未安装或未激活' };

    const candidates = [];
    for (const bot of listed.bots) {
      for (const target of bot.targets ?? []) {
        candidates.push({
          botId: bot.botId,
          targetId: target.targetId,
          name: typeof target.name === 'string' ? target.name : '',
          channel: typeof bot.channel === 'string' ? bot.channel : '',
        });
      }
    }
    if (candidates.length === 0) return { reason: '还没有保存的投递目标' };
    const label = (item) => `${item.name || item.targetId}（${item.channel}）`;

    const alias = typeof delivery.target === 'string' ? delivery.target.trim().toLowerCase() : '';
    const channel = typeof delivery.bot === 'string' ? delivery.bot.trim().toLowerCase() : '';
    let picked = candidates;
    if (alias) {
      picked = picked.filter((item) => (
        item.targetId.toLowerCase() === alias
        || item.name.toLowerCase() === alias
        || item.name.toLowerCase().includes(alias)
      ));
    }
    if (channel) {
      picked = picked.filter((item) => (
        item.botId.toLowerCase() === channel
        || item.channel.toLowerCase() === channel
        || item.channel.toLowerCase().includes(channel)
      ));
    }
    if (picked.length === 1) return { botId: picked[0].botId, targetId: picked[0].targetId };
    if (picked.length === 0) {
      return { reason: `没有叫「${delivery.target ?? delivery.bot}」的投递目标，现有：${candidates.map(label).join('、')}` };
    }
    return { reason: `有 ${picked.length} 个目标都对得上，指明一个：${picked.map(label).join('、')}` };
  }

  /**
   * Send one text.
   * @param {{kind: 'silent'|'im'|'session', botId?: string, targetId?: string, sessionId?: string}} delivery
   * @param {string} text
   * @param {{sessionId?: string}} [runSession] 本次运行用的会话，`session` 投递没指定会话时写这里
   * @returns {Promise<{sent: boolean, skipped?: boolean, reason?: string}>}
   */
  async send(delivery, text, runSession = {}) {
    if (!delivery || delivery.kind === 'silent') return { sent: false, skipped: true, reason: 'silent' };
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return { sent: false, skipped: true, reason: 'empty' };

    // 回发起任务的聊天：每次发送前现读会话绑定，跟随 /session 切换与 /new。
    if (delivery.kind === 'origin') {
      const sessionId = delivery.sessionId ?? runSession.sessionId;
      if (!sessionId) return { sent: false, skipped: true, reason: '没有可回写的会话' };
      const service = this.service();
      if (!service) return { sent: false, skipped: true, reason: 'dsh-im 未安装或未激活' };
      if (typeof service.describeConversation !== 'function') {
        return { sent: false, skipped: true, reason: '这个 dsh-im 版本查不了会话绑定' };
      }
      let described;
      try {
        described = await service.describeConversation(sessionId);
      } catch (error) {
        return { sent: false, reason: `读会话绑定失败：${error?.message ?? error}` };
      }
      // 会话当前绑着哪个聊天优先；聊天里 /new 过之后旧会话解绑，就退回建任务时记下的那个聊天。
      const where = described ?? (delivery.channel && delivery.conversationKey
        ? { channel: delivery.channel, botId: delivery.botId, conversationKey: delivery.conversationKey }
        : null);
      // 没有聊天可发（Web 端的会话）：改写到这个会话的日志里，仍然是「回到发起任务的地方」。
      if (!where) return this.#appendToSession({ kind: 'session', sessionId }, body);
      const draft = conversationRoute(where.channel, where.conversationKey);
      if (draft === null) {
        return { sent: false, skipped: true, reason: `认不出 ${where.channel} 的会话地址，先在设置里保存一个投递目标` };
      }
      if (typeof where.botId !== 'string' || where.botId === '') {
        return { sent: false, skipped: true, reason: '不知道用哪个机器人发，先在设置里保存一个投递目标' };
      }
      try {
        await service.send(where.botId, draft, body);
        return { sent: true };
      } catch (error) {
        return { sent: false, reason: `投递失败：${error?.code ?? ''} ${error?.message ?? error}`.trim() };
      }
    }

    // 写会话日志不经过聊天渠道，dsh-im 没装也能用。
    if (delivery.kind === 'session') {
      const sessionId = delivery.sessionId ?? runSession.sessionId;
      if (!sessionId) return { sent: false, skipped: true, reason: '这次运行没有会话可写' };
      return this.#appendToSession({ ...delivery, sessionId }, body);
    }

    const service = this.service();
    if (!service) return { sent: false, skipped: true, reason: 'dsh-im 未安装或未激活' };

    const resolved = await this.resolve(delivery);
    if (resolved.reason !== undefined) return { sent: false, skipped: true, reason: resolved.reason };

    try {
      await service.send(resolved.botId, resolved.targetId, body);
      return { sent: true };
    } catch (error) {
      return { sent: false, reason: `投递失败：${error?.code ?? ''} ${error?.message ?? error}`.trim() };
    }
  }
}
