/**
 * agent 模式的执行路径。
 *
 * 定时任务自己没有 Agent，没法直接驱动 agent loop（子代理需要一个活着的父级），
 * 所以只走宿主级的 `sessionController`：新建会话、投 prompt、等这一轮结束，
 * 再把 assistant 的文本抓出来当作任务输出。内置 schedule 已被本插件的 patch 关掉，
 * 不再作为退路。
 */

function controllerService(ctx) {
  const controller = ctx.get?.('sessionController');
  if (!controller || typeof controller.create !== 'function') return null;
  if (typeof controller.prompt !== 'function') return null;
  return controller;
}

export class Dispatcher {
  constructor(ctx, logger = console) {
    this.ctx = ctx;
    this.logger = logger;
    this.seq = 0;
  }

  /** Which execution path is usable right now. */
  capability() {
    return controllerService(this.ctx) ? 'session' : null;
  }

  available() {
    return this.capability() !== null;
  }

  /**
   * Run one agent turn with a prompt and return its answer.
   * @param {{prompt: string, cwd?: string, agentPreset?: string, provider?: string, model?: string, permission?: string, timeoutMs?: number, target?: object, reusedSessionId?: string, taskId?: string}} request
   * @returns {Promise<{dispatched: boolean, output?: string, sessionId?: string, path?: string, reusedSessionId?: string, reason?: string}>}
   */
  async dispatch({ prompt, cwd, agentPreset, provider, model, permission, timeoutMs = 180_000, target, reusedSessionId, taskId }, signal) {
    const body = String(prompt ?? '').trim();
    if (!body) return { dispatched: false, reason: 'prompt 为空' };

    const controller = controllerService(this.ctx);
    if (!controller) return { dispatched: false, reason: '当前环境没有 sessionController，agent 模式跑不了' };
    return this.#viaSession(controller, { prompt: body, cwd, agentPreset, provider, model, permission, timeoutMs, target, reusedSessionId, taskId }, signal);
  }

  async #viaSession(controller, { prompt, cwd, agentPreset, provider, model, permission, timeoutMs, target, reusedSessionId, taskId }, signal) {
    this.seq += 1;
    const requestId = `cron-${taskId ?? Date.now().toString(36)}-${this.seq}`;
    const cancellation = signal ?? new AbortController().signal;
    const kind = target?.kind ?? 'new_once';
    try {
      let sessionId;
      let remember = null;

      if (kind === 'existing') {
        sessionId = target.sessionId;
      } else if (kind === 'new_once' && reusedSessionId) {
        sessionId = reusedSessionId;
      } else {
        const created = await controller.create({
          ...(cwd ? { cwd } : {}),
          ...(agentPreset ? { agentPreset } : {}),
        }, cancellation);
        sessionId = created?.sessionId;
        if (!sessionId) return { dispatched: false, path: 'session', reason: '会话创建未返回 sessionId' };
        if (kind === 'new_once') remember = sessionId;
      }

      const modelApplied = await selectSessionModel(this.ctx, controller, sessionId, { provider, model });
      const permissionApplied = applySessionPermission(this.ctx, sessionId, permission);

      await controller.prompt(
        {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        },
        cancellation,
      );

      const waited = await controller.wait({ sessionId, timeoutMs, maxMessages: 200 }, cancellation);
      const output = extractAnswer(waited);
      return {
        dispatched: true,
        sessionId,
        path: 'session',
        ...(remember ? { reusedSessionId: remember } : {}),
        ...(output ? { output } : {}),
        ...(modelApplied ? { modelApplied: selection(provider, model) } : {}),
        ...(permissionApplied ? { permissionApplied } : {}),
        ...(waited?.reason === 'timeout' ? { reason: '等待模型超时' } : {}),
      };
    } catch (error) {
      return { dispatched: false, path: 'session', reason: `会话派发失败：${error?.message ?? error}` };
    }
  }
}

function selection(provider, model) {
  return `${provider}/${model}`;
}

/**
 * 把任务的权限预设落到这条会话上；不指定就沿用会话自己的设置。
 * @param {object} ctx 宿主 context
 * @param {string} sessionId 目标会话
 * @param {string} [preset] 预设名，空表示不改
 * @returns {string|null} 实际设置上的预设名
 */
function applySessionPermission(ctx, sessionId, preset) {
  if (!preset || !sessionId) return null;
  const presets = ctx.get?.('permissionPresets');
  if (!presets || typeof presets.set !== 'function') throw new Error('当前环境没有 permissionPresets，无法指定权限预设');
  const agent = ctx.get?.('agents')?.get?.(sessionId);
  const session = agent?.session;
  if (!session) throw new Error('会话还没有起来，无法设置权限预设');
  presets.set(session, preset);
  return preset;
}

/**
 * 让这条会话用指定模型跑：优先直接改 Agent 的模型，避免连带改掉全局默认模型。
 * @param {object} ctx 宿主 context
 * @param {object} controller sessionController
 * @param {string} sessionId 目标会话
 * @param {{provider?: string, model?: string}} wanted 任务上配置的模型
 * @returns {Promise<boolean>} 是否真的切换了
 */
async function selectSessionModel(ctx, controller, sessionId, { provider, model }) {
  if (!provider || !model || !sessionId) return false;
  const selection = { provider, model };
  const agent = ctx.get?.('agents')?.get?.(sessionId);
  const handle = agent?.model;
  if (handle && typeof handle.select === 'function') {
    handle.select(selection);
    return true;
  }
  // 退路：会话控制器会同时把选择记成部署默认模型。
  if (typeof controller.selectModel === 'function') {
    await controller.selectModel({ sessionId, provider, model });
    return true;
  }
  throw new Error('当前环境无法为会话指定模型');
}

/** Pull the answer text out of the `wait` value: assistant records arrive newest first. */
export function extractAnswer(waited) {
  const records = waited?.output?.records ?? waited?.records ?? [];
  if (!Array.isArray(records)) return textOf(waited?.output ?? waited?.text);
  for (const record of records) {
    const event = record?.event ?? record;
    const type = typeof event?.type === 'string' ? event.type : '';
    if (!type.startsWith('assistant')) continue;
    const text = textOf(event?.data?.content ?? event?.data?.message?.content ?? event?.message?.content);
    if (text) return text;
  }
  return '';
}

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}
