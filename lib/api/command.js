/**
 * `/clear`：把一个会话的模型上下文就地清空，界面记录和会话本身都留着。
 *
 * 命令只是壳，真正动手的是 runtime/memory.js——那边跟任务的"每轮清空上下文"共用同一段逻辑。
 */

import { clearAgentContext } from '../runtime/memory.js';

const DESCRIPTION = '清空当前会话的模型上下文（会话与界面记录保留）';
const USAGE = '用法：/clear（不需要参数）';
const BUSY = '会话正在运行，等它停下来再试。';
const NOTHING = '这个会话还没有可清空的内容。';
const CANCELLED = '已取消。';

/** 宿主把这些服务挂在 context 上，取不到就说明这个环境不支持。 */
function serviceOf(ctx, name) {
  try {
    return ctx?.get?.(name) ?? ctx?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * 执行一次 `/clear`。
 * @param {object} ctx 宿主 context
 * @param {object} invocation 命令调用（agent / rawInput / signal）
 * @returns {Promise<object>} CommandResult
 */
export async function executeClear(ctx, invocation) {
  if (String(invocation?.rawInput ?? '').trim() !== '') return { kind: 'error', text: USAGE };
  if (invocation?.signal?.aborted) return { kind: 'error', text: CANCELLED };
  const agent = invocation?.agent;
  if (!agent?.session) return { kind: 'error', text: '拿不到当前会话。' };
  if (agent.status !== 'idle') return { kind: 'error', text: BUSY };

  let result;
  try {
    result = await clearAgentContext(agent, { sessions: serviceOf(ctx, 'sessions'), signal: invocation.signal });
  } catch (error) {
    return { kind: 'error', text: `清空失败：${error?.message ?? error}` };
  }
  if (invocation?.signal?.aborted) return { kind: 'error', text: CANCELLED };
  if (result?.busy) return { kind: 'error', text: BUSY };
  if (!result || result.cleared === 0) return { kind: 'success', text: NOTHING };
  return {
    kind: 'success',
    text: `已清空模型上下文：${String(result.cleared)} 段历史不再进入模型视角（会话与界面记录都还在）。`,
  };
}

/**
 * 注册 `/clear`。宿主没有命令注册表时安静地什么也不做。
 * @param {object} ctx 宿主 context
 * @param {object} [logger] 日志器
 * @returns {(() => void)|null} 注销函数
 */
export function registerClearCommand(ctx, logger = console) {
  const commands = serviceOf(ctx, 'commands');
  if (typeof commands?.register !== 'function') return null;
  try {
    const dispose = commands.register({
      name: 'clear',
      description: DESCRIPTION,
      handler: (invocation) => executeClear(ctx, invocation),
    });
    return typeof dispose === 'function' ? dispose : null;
  } catch (error) {
    logger?.warn?.(`[dsh-cron] 注册 /clear 失败：${error?.message ?? error}`);
    return null;
  }
}
