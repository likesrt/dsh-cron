/**
 * 清空一个会话的"模型上下文"。
 *
 * 会话日志只追加，界面上看到的历史是从追加事件派生出来的，谁也删不掉已写下的东西。
 * 能改的是**模型可见的 surface**：一次定位式替换（surfaceOp: replace）把一段节点
 * 换成一行标记，模型就再也看不到那一段了，而会话 id、标题、所属工作区、完整日志、
 * 界面记录全都不变。这也是 `/compact` 用的同一套机制，平台没把它留给压缩独占。
 */

import { randomUUID } from 'node:crypto';

/** 替换节点里留给模型的那一行：说明上文是被清掉的，不是从来没发生过。 */
export const CLEAR_MARKER = '[Earlier conversation cleared by the user; previous messages are no longer in context.]';

/** 开头的 system/message 是 agent 的指令，替换它等于让下一轮没有系统提示词。 */
function isSystemNode(session, seq) {
  if (typeof session?.eventAt !== 'function') return true;
  try {
    const event = session.eventAt(seq);
    return event !== undefined && event.type === 'system/message';
  } catch {
    return true;
  }
}

/**
 * 要遮蔽的那一段：保住开头那条 system/message，其余全部纳入。
 * @param {object} session 会话
 * @returns {{shadowed: number[], startSeq: number, endSeq: number}|null} 没有可清的内容时返回 null
 */
export function clearingRange(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const startIndex = isSystemNode(session, nodes[0]) ? 1 : 0;
  if (startIndex >= nodes.length) return null;
  return {
    shadowed: nodes.slice(startIndex),
    startSeq: nodes[startIndex],
    endSeq: nodes[nodes.length - 1],
  };
}

/**
 * 就地把会话的模型上下文清空。
 *
 * `sourceEventSeqs` 必须列全被遮蔽的节点，`surfaceOp` 必须恰好是
 * `{ op: 'replace', startSeq, endSeq }`——这是 host 侧会校验的契约。
 * @param {object} session 已在 store 里登记、当前空闲的会话
 * @param {string} [marker] 留给模型的那一行
 * @returns {{cleared: number, range: object|null}} 被遮蔽的节点数
 */
export function clearSessionContext(session, marker = CLEAR_MARKER) {
  const range = clearingRange(session);
  if (range === null) return { cleared: 0, range: null };
  session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: marker }],
    source: { kind: 'user' },
  }, {
    surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
    sourceEventSeqs: range.shadowed,
  });
  return { cleared: range.shadowed.length, range };
}

/**
 * 清空一个 agent 当前会话，落在它自己的空闲阶段。
 *
 * `runMaintenance` 是手动压缩用的同一套占用机制：有 turn、排队的唤醒或别的维护任务时
 * 它会把这次清空挡回去，而不是在半路把历史换掉。
 * @param {object} agent 活着的 agent
 * @param {object} options `{ sessions?, signal? }`，sessions 用来刷盘
 * @returns {Promise<{cleared: number}>}
 */
export async function clearAgentContext(agent, { sessions, signal } = {}) {
  if (agent?.status !== 'idle') return { cleared: 0, busy: true };
  let operation;
  try {
    operation = agent.runMaintenance(async (agentSignal) => {
      if (agentSignal?.aborted || signal?.aborted) return { cleared: 0 };
      const result = clearSessionContext(agent.session);
      if (result.cleared > 0 && typeof sessions?.flush === 'function') {
        // 刷一次盘：清空要能扛住紧接着的退出，而不是只活在内存里。
        await sessions.flush(agent.session);
      }
      return { cleared: result.cleared };
    });
  } catch {
    // runMaintenance 在 agent 被 turn 或别的维护任务占住时同步抛。
    return { cleared: 0, busy: true };
  }
  const result = await operation;
  return { ...result, busy: false };
}
