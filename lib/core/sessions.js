/**
 * 会话里有一部分是宿主自己用的：mnemon 的任务与运行容器（id 形如
 * `mnemon-task-v1-<uuid>`），以及任何子智能体会话（origin: subagent）。
 * 它们不出现在用户的会话列表里，插件里的会话选择器也不该列出来。
 */

const INTERNAL_SESSION_ID = /^mnemon-(?:task|run)-v\d+-/;

/** @param {{sessionId?: string, origin?: string}} [session] */
export function isInternalSession(session) {
  if (session?.origin === 'subagent') return true;
  return typeof session?.sessionId === 'string' && INTERNAL_SESSION_ID.test(session.sessionId);
}
