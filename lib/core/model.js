/**
 * 任务模型：校验、归一化、下次执行时间。
 * 只做纯计算，不碰 I/O 和宿主 API，方便单测。
 */

import path from 'node:path';
import { CronError, describeCron, nextOccurrence, parseCron, zonedParts, zonedTimeToInstant } from './cron.js';

export const MODES = ['script', 'agent'];
export const DELIVERY_KINDS = ['silent', 'im', 'session', 'origin'];
/** agent 任务跑在哪个会话里；与 delivery（结果发到哪）是两件事。 */
export const TARGET_KINDS = ['new_once', 'new', 'existing'];
export const SCHEDULE_KINDS = [
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
];

/** 旧数据的调度类型，读到就迁移，写回后不再出现。 */
export const LEGACY_SCHEDULE_KINDS = ['every', 'at', 'after'];

export const MIN_EVERY_SECONDS = 5;
export const MAX_TIMEOUT_MS = 3_600_000;
export const MAX_TITLE_LENGTH = 80;

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const TIME_PATTERN = /^(\d{1,2}):(\d{1,2})$/;

export class TaskError extends Error {
  constructor(message, code = 'invalid-task') {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function requireString(value, field, { max = 10_000, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new TaskError(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed === '') throw new TaskError(`${field} 不能为空`);
  if (trimmed.length > max) throw new TaskError(`${field} 超过 ${max} 字符`);
  return trimmed;
}

function optionalString(value, field, options) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, options);
}

function intIn(value, field, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new TaskError(`${field} 必须是整数`);
  if (number < min || number > max) throw new TaskError(`${field} 需要在 ${min}-${max} 之间`);
  return number;
}

/** 工作区路径：必须是绝对路径，否则不同宿主进程会落到不同目录。 */
export function normalizeWorkspace(value, field = 'workspace') {
  const raw = requireString(value, field, { max: 1024 });
  if (!path.isAbsolute(raw)) throw new TaskError(`${field} 必须是绝对路径`);
  const normalized = path.normalize(raw);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function parseDate(value, field) {
  const text = requireString(value, field, { max: 10 });
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new TaskError(`${field} 需要形如 2026-11-12`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new TaskError(`${field} 不是有效日期`);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TaskError(`${field} 不是有效日期`);
  }
  return text;
}

function parseClock(value, field) {
  const text = requireString(value, field, { max: 5 });
  const match = text.match(TIME_PATTERN);
  if (!match) throw new TaskError(`${field} 需要形如 09:30`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new TaskError(`${field} 超出 00:00-23:59`);
  return `${pad2(hour)}:${pad2(minute)}`;
}

function clockParts(time) {
  const [hour, minute] = time.split(':').map(Number);
  return { hour, minute };
}

// --------------------------------------------------------------- 调度

/**
 * 墙上时钟类选择器 → cron 表达式。
 * 面板上让用户挑「每月几号几点」，存盘也只存选择器；算时间时折成 cron，
 * 交给已经处理过时区和 DST 的 parseCron/nextOccurrence。
 * every-* 是等间隔语义，cron 表达不了（字段会回卷），由 computeNextRun 直接推进。
 */
export function compileCron(schedule) {
  switch (schedule.kind) {
    case 'monthly': {
      const { hour, minute } = clockParts(schedule.time);
      return `${minute} ${hour} ${schedule.dayOfMonth} * *`;
    }
    case 'weekly': {
      const { hour, minute } = clockParts(schedule.time);
      return `${minute} ${hour} * * ${schedule.weekday === 7 ? 0 : schedule.weekday}`;
    }
    case 'daily': {
      const { hour, minute } = clockParts(schedule.time);
      return `${minute} ${hour} * * *`;
    }
    case 'hourly':
      return `${schedule.minute} * * * *`;
    case 'cron':
      return schedule.expression;
    default:
      throw new TaskError(`${schedule?.kind} 是等间隔调度，不能用 cron 表达`);
  }
}

export function normalizeSchedule(input, timeZone = 'UTC') {
  if (input === undefined || input === null || input === '') throw new TaskError('schedule 不能为空');
  if (typeof input === 'string' || LEGACY_SCHEDULE_KINDS.includes(input?.kind)) {
    return migrateSchedule(input, timeZone);
  }
  if (typeof input !== 'object') throw new TaskError('schedule 必须是对象');

  const kind = input.kind;
  if (!SCHEDULE_KINDS.includes(kind)) {
    throw new TaskError(`schedule.kind 只能是 ${SCHEDULE_KINDS.join('/')}`);
  }

  switch (kind) {
    case 'once':
      return {
        kind,
        date: parseDate(input.date, 'schedule.date'),
        time: parseClock(input.time, 'schedule.time'),
      };
    case 'monthly':
      return {
        kind,
        dayOfMonth: intIn(input.dayOfMonth, 'schedule.dayOfMonth', 1, 31),
        time: parseClock(input.time, 'schedule.time'),
      };
    case 'weekly':
      return {
        kind,
        weekday: intIn(input.weekday, 'schedule.weekday', 1, 7),
        time: parseClock(input.time, 'schedule.time'),
      };
    case 'daily':
      return { kind, time: parseClock(input.time, 'schedule.time') };
    case 'hourly':
      return { kind, minute: intIn(input.minute, 'schedule.minute', 0, 59) };
    case 'every-days':
      return {
        kind,
        interval: intIn(input.interval, 'schedule.interval', 1, 365),
        time: parseClock(input.time, 'schedule.time'),
      };
    case 'every-hours':
      return {
        kind,
        interval: intIn(input.interval, 'schedule.interval', 1, 168),
        minute: intIn(input.minute, 'schedule.minute', 0, 59),
      };
    case 'every-minutes':
      // 间隔是等间隔语义，不受 cron 分钟字段（0-59）限制
      return { kind, interval: intIn(input.interval, 'schedule.interval', 1, 1440) };
    case 'every-seconds':
      return { kind, interval: intIn(input.interval, 'schedule.interval', MIN_EVERY_SECONDS, 3600) };
    default: {
      const expression = requireString(input.expression, 'schedule.expression', { max: 200 });
      try {
        parseCron(expression); // 提前校验，错误信息才能指到具体字段
      } catch (error) {
        if (error instanceof CronError) throw new TaskError(`schedule.expression 写错了：${error.message}`);
        throw error;
      }
      return { kind: 'cron', expression };
    }
  }
}

/** 旧数据（`every`/`at`/`after`、字符串调度）一次性迁移成选择器。 */
export function migrateSchedule(input, timeZone = 'UTC') {
  let converted;
  try {
    converted = legacyToSelector(input, timeZone);
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError(`无法迁移调度 ${JSON.stringify(input)}：${error?.message ?? error}`);
  }
  try {
    return normalizeSchedule(converted, timeZone);
  } catch (error) {
    // 迁移不了的就原样当 cron 存着：任务不丢，体检会把它指出来。
    const expression = typeof converted?.expression === 'string' ? converted.expression.trim() : '';
    if (expression) return { kind: 'cron', expression };
    throw error;
  }
}

function legacyToSelector(input, timeZone) {
  if (typeof input === 'string') return legacyToSelector(parseLegacyText(input, timeZone), timeZone);
  if (!input || typeof input !== 'object') throw new TaskError('schedule 无法识别');

  if (input.kind === 'every' || input.kind === 'after') {
    return selectorFromSeconds(Number(input.seconds ?? 0));
  }
  if (input.kind === 'at') {
    const instant = Date.parse(String(input.at ?? ''));
    if (!Number.isFinite(instant)) throw new TaskError(`schedule.at 不是合法时间：${input.at}`);
    // 一次性调度已去掉（契约 §10）：只能保守地留成「每年同一天同一时刻」，
    // 任务配置不会凭空消失，用户能在面板里改成想要的选择器。
    const parts = zonedParts(instant, timeZone);
    return { kind: 'cron', expression: `${parts.minute} ${parts.hour} ${parts.day} ${parts.month} *` };
  }
  if (input.kind === 'cron') {
    return selectorFromCron(input.expression) ?? { kind: 'cron', expression: String(input.expression).trim() };
  }
  return input;
}

function selectorFromSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) throw new TaskError('间隔秒数不合法');
  // 优先用最粗的单位，读起来最接近用户的说法；单位换不动就原样按秒存。
  if (value % 86_400 === 0 && value / 86_400 <= 365) {
    return { kind: 'every-days', interval: value / 86_400, time: '00:00' };
  }
  if (value % 3_600 === 0 && value / 3_600 <= 168) {
    return { kind: 'every-hours', interval: value / 3_600, minute: 0 };
  }
  if (value % 60 === 0 && value / 60 <= 1440) return { kind: 'every-minutes', interval: value / 60 };
  if (value >= MIN_EVERY_SECONDS && value <= 3600) return { kind: 'every-seconds', interval: value };
  if (value < MIN_EVERY_SECONDS) return { kind: 'every-seconds', interval: MIN_EVERY_SECONDS };
  // 实在换算不了的取最近的整分钟，宁可近似也不丢任务。
  return { kind: 'every-minutes', interval: Math.min(1440, Math.max(1, Math.round(value / 60))) };
}

function isStar(field) {
  return field === '*' || field === '?';
}

function singleOf(field) {
  return /^\d+$/.test(field) ? Number(field) : null;
}

function stepOf(field) {
  const match = String(field).match(/^\*\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * cron 表达式 → 选择器（能反推就反推）。
 * 老任务里全是 cron 字符串，直接丢给用户编辑等于让人手写 cron，
 * 所以凡是能落到选择器上的形态都翻回去。
 */
export function selectorFromCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length === 6) {
    const interval = stepOf(parts[0]);
    if (interval && parts.slice(1).every(isStar)) {
      if (interval >= MIN_EVERY_SECONDS && interval <= 59) return { kind: 'every-seconds', interval };
    }
    return null;
  }
  if (parts.length !== 5) return null;

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;
  if (!isStar(monthField)) return null;

  const minuteStep = stepOf(minuteField);
  // 步长必须落在字段宽度内，否则原表达式的语义已经变了（*\/90 的分钟字段只有 0）
  if (minuteStep && minuteStep <= 59 && isStar(hourField) && isStar(dayOfMonthField) && isStar(dayOfWeekField)) {
    return { kind: 'every-minutes', interval: minuteStep };
  }

  const minute = singleOf(minuteField);
  if (minute === null || minute > 59) return null;

  if (isStar(hourField) && isStar(dayOfMonthField) && isStar(dayOfWeekField)) {
    return { kind: 'hourly', minute };
  }

  const hourStep = stepOf(hourField);
  if (hourStep && hourStep <= 23 && isStar(dayOfMonthField) && isStar(dayOfWeekField)) {
    return { kind: 'every-hours', interval: hourStep, minute };
  }

  const hour = singleOf(hourField);
  if (hour === null || hour > 23) return null;
  const time = `${pad2(hour)}:${pad2(minute)}`;

  if (isStar(dayOfMonthField) && isStar(dayOfWeekField)) return { kind: 'daily', time };

  const weekday = singleOf(dayOfWeekField);
  if (isStar(dayOfMonthField) && weekday !== null) {
    if (weekday <= 7) return { kind: 'weekly', weekday: weekday === 0 ? 7 : weekday, time };
  }

  const dayOfMonth = singleOf(dayOfMonthField);
  if (dayOfMonth !== null && isStar(dayOfWeekField) && dayOfMonth >= 1 && dayOfMonth <= 31) {
    return { kind: 'monthly', dayOfMonth, time };
  }
  return null;
}

/** 旧版自然语言解析，只服务迁移，不再对外承诺这套写法。 */
function parseLegacyText(input, defaultTimeZone = 'UTC') {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) throw new TaskError('调度描述为空');

  const dailyMatch = text.match(/^(?:每天|每日|daily|day)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (dailyMatch) {
    let hour = Number(dailyMatch[1]);
    const minute = Number(dailyMatch[2] ?? 0);
    if (dailyMatch[3] === 'pm' && hour < 12) hour += 12;
    if (dailyMatch[3] === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw new TaskError('时间超出范围');
    return { kind: 'cron', expression: `${minute} ${hour} * * *`, timeZone: defaultTimeZone };
  }

  const bare = text.replace(/^every\s+/, '').replace(/^每\s*/, '').trim();
  const interval = bare.match(
    /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|秒|m|min|mins|minute|minutes|分|分钟|h|hr|hrs|hour|hours|小时|d|day|days|天)$/,
  );
  if (interval) {
    const amount = Number(interval[1]);
    const unit = interval[2];
    const scale = unit.startsWith('s') || unit === '秒'
      ? 1
      : unit.startsWith('m') || unit === '分' || unit === '分钟'
        ? 60
        : unit.startsWith('h') || unit === '小时'
          ? 3600
          : 86400;
    return { kind: 'every', seconds: Math.round(amount * scale) };
  }

  const weekdays = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const weekly = bare.match(/^(sun|mon|tue|wed|thu|fri|sat)(?:day)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (weekly) {
    let hour = Number(weekly[2]);
    const minute = Number(weekly[3] ?? 0);
    const meridiem = weekly[4];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw new TaskError('时间超出范围');
    return {
      kind: 'cron',
      expression: `${minute} ${hour} * * ${weekdays[weekly[1]]}`,
      timeZone: defaultTimeZone,
    };
  }

  parseCron(input);
  return { kind: 'cron', expression: String(input).trim(), timeZone: defaultTimeZone };
}

// --------------------------------------------------------------- 投递

export function normalizeDelivery(input, field = 'delivery', fallback = 'silent') {
  const value = input ?? fallback;
  if (!value) return { kind: 'silent' };
  if (typeof value === 'string') {
    if (value === 'silent' || value === 'none') return { kind: 'silent' };
    return { kind: 'session', sessionId: value };
  }

  const kind = value.kind ?? 'silent';

  // 已删除的「绑定会话所在聊天」投递，语义最接近的是写回那个会话的日志。
  if (kind === 'im-session') {
    const sessionId = optionalString(value.sessionId, `${field}.sessionId`, { max: 200 });
    return sessionId ? { kind: 'session', sessionId } : { kind: 'silent' };
  }
  if (!DELIVERY_KINDS.includes(kind)) {
    throw new TaskError(`${field}.kind 只能是 ${DELIVERY_KINDS.join('/')}`);
  }
  if (kind === 'silent') return { kind: 'silent' };
  // 回到发起这条任务的那个聊天：不写会话就用这次运行自己的会话。
  // 顺手记下当时的渠道与会话键，聊天换了会话（/new）也还认得出是哪个聊天。
  if (kind === 'origin') {
    const delivery = { kind: 'origin' };
    const sessionId = optionalString(value.sessionId, `${field}.sessionId`, { max: 200 });
    if (sessionId) delivery.sessionId = sessionId;
    const channel = optionalString(value.channel, `${field}.channel`, { max: 60 });
    if (channel) delivery.channel = channel;
    const botId = optionalString(value.botId, `${field}.botId`, { max: 200 });
    if (botId) delivery.botId = botId;
    const conversationKey = optionalString(value.conversationKey, `${field}.conversationKey`, { max: 300 });
    if (conversationKey) delivery.conversationKey = conversationKey;
    return delivery;
  }
  if (kind === 'session') {
    // 不给 sessionId：写回这次运行自己用的会话（agent 任务由执行位置决定）。
    const sessionId = optionalString(value.sessionId, `${field}.sessionId`, { max: 200 });
    return sessionId ? { kind: 'session', sessionId } : { kind: 'session' };
  }

  const botId = optionalString(value.botId, `${field}.botId`, { max: 200 });
  const targetId = optionalString(value.targetId, `${field}.targetId`, { max: 200 });
  if (!targetId) {
    // 老数据里只存了 sessionId 的 im 投递，等价于写会话。
    const sessionId = optionalString(value.sessionId, `${field}.sessionId`, { max: 200 });
    if (sessionId) return { kind: 'session', sessionId };
  }
  // 聊天里建任务时拿不到 botId / targetId：允许只写目标别名或渠道，运行时再解析成真实目标。
  const alias = optionalString(value.target, `${field}.target`, { max: 200 });
  const channel = optionalString(value.bot, `${field}.bot`, { max: 200 });
  return {
    kind: 'im',
    ...(botId ? { botId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(!botId && !targetId && alias ? { target: alias } : {}),
    ...(!botId && !targetId && channel ? { bot: channel } : {}),
    ...(!botId && !targetId && !alias && !channel ? { auto: true } : {}),
  };
}

// --------------------------------------------------------------- 执行位置

/** agent 任务跑在哪个会话里。缺省等价于内置定时任务的「新建会话并复用」。 */
export function normalizeTarget(input, field = 'target') {
  if (input === undefined || input === null || input === '') return { kind: 'new_once' };
  if (typeof input === 'string') {
    if (!TARGET_KINDS.includes(input)) throw new TaskError(`${field}.kind 只能是 ${TARGET_KINDS.join('/')}`);
    return input === 'existing' ? { kind: 'new_once' } : { kind: input };
  }
  if (typeof input !== 'object') throw new TaskError(`${field} 必须是对象`);
  const kind = input.kind ?? 'new_once';
  if (!TARGET_KINDS.includes(kind)) throw new TaskError(`${field}.kind 只能是 ${TARGET_KINDS.join('/')}`);
  if (kind === 'existing') {
    const sessionId = requireString(input.sessionId, `${field}.sessionId`, { max: 200 });
    return { kind, sessionId };
  }
  // 复用的会话默认每轮清空模型上下文：会话 id 不变、界面记录还在，但模型看不到上一轮。
  if (kind === 'new_once' && input.freshContext === false) return { kind, freshContext: false };
  return { kind };
}

// --------------------------------------------------------------- 任务

export function normalizeMode(value) {
  if (value === undefined || value === null || value === '') return null;
  // 契约 §2：hybrid/monitor 已删除，旧值读到即降级成 agent。
  if (value === 'hybrid' || value === 'monitor') return 'agent';
  if (!MODES.includes(value)) throw new TaskError(`mode 只能是 ${MODES.join('/')}`);
  return value;
}

/** 权限预设名：交给宿主的 permissionPresets 解析，这里只管形状。 */
export function normalizePermission(value) {
  const name = String(value ?? '').trim();
  if (!name) return undefined;
  if (name.length > 40) throw new TaskError('permission 名字太长');
  if (!/^[a-z][a-z0-9-]*$/i.test(name)) throw new TaskError('permission 只能是预设名');
  return name;
}

export function normalizeScript(input) {
  if (!input) return null;
  if (typeof input === 'string') return { command: input.trim() };
  const command = requireString(input.command ?? input.path, 'script.command', { max: 4000 });
  return {
    command,
    ...(Array.isArray(input.args) && input.args.length > 0 ? { args: input.args.map(String) } : {}),
    ...(optionalString(input.cwd, 'script.cwd', { max: 400 }) ? { cwd: input.cwd.trim() } : {}),
    ...(input.shell === true ? { shell: true } : {}),
    ...(input.timeoutMs ? { timeoutMs: intIn(input.timeoutMs, 'script.timeoutMs', 1000, MAX_TIMEOUT_MS) } : {}),
    ...(input.env && typeof input.env === 'object'
      ? { env: Object.fromEntries(Object.entries(input.env).map(([key, value]) => [key, String(value)])) }
      : {}),
  };
}

export function normalizeAgent(input) {
  if (!input) return {};
  const skills = Array.isArray(input.skills)
    ? input.skills.filter((skill) => typeof skill === 'string').slice(0, 20)
    : [];
  return {
    ...(optionalString(input.workdir, 'agent.workdir', { max: 400 }) ? { workdir: input.workdir.trim() } : {}),
    ...(optionalString(input.preset, 'agent.preset', { max: 200 }) ? { preset: input.preset.trim() } : {}),
    ...(optionalString(input.provider, 'agent.provider', { max: 200 }) ? { provider: input.provider.trim() } : {}),
    ...(optionalString(input.model, 'agent.model', { max: 200 }) ? { model: input.model.trim() } : {}),
    ...(input.continuity === true ? { continuity: true } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(Array.isArray(input.contextFrom) && input.contextFrom.length > 0
      ? { contextFrom: input.contextFrom.map(String).slice(0, 10) }
      : {}),
  };
}

export function newId() {
  return `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createTask(input, { now = Date.now(), timeZone = 'UTC' } = {}) {
  const title = requireString(input.title, 'title', { max: MAX_TITLE_LENGTH });
  const prompt = optionalString(input.prompt, 'prompt', { max: 20_000, allowEmpty: true }) ?? null;
  // 默认智能模式：没点名脚本、也没只给一条命令时，都按"交给模型"理解。
  const rawScript = typeof input.script === 'string' ? input.script : input.script?.command;
  const mode = normalizeMode(input.mode) ?? (!prompt && rawScript ? 'script' : 'agent');

  const task = {
    id: input.id ?? newId(),
    title,
    enabled: input.enabled !== false,
    mode,
    schedule: normalizeSchedule(input.schedule ?? input.when, timeZone),
    repeat: input.repeat === undefined || input.repeat === null
      ? null
      : intIn(input.repeat, 'repeat', 1, 1_000_000),
    runCount: 0,
    ...(input.retries === undefined || input.retries === null || input.retries === ''
      ? {}
      : { retries: intIn(input.retries, 'retries', 0, 5) }),
    ...(input.timeoutMs === undefined || input.timeoutMs === null || input.timeoutMs === ''
      ? {}
      : { timeoutMs: intIn(input.timeoutMs, 'timeoutMs', 1_000, 3_600_000) }),
    ...(input.permission ? { permission: normalizePermission(input.permission) } : {}),
    script: normalizeScript(input.script),
    prompt,
    workspace: normalizeWorkspace(input.workspace),
    delivery: normalizeDelivery(input.delivery, 'delivery', 'silent'),
    target: normalizeTarget(input.target, 'target'),
    tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string').slice(0, 10) : [],
    agent: normalizeAgent(input.agent),
    timeZone,
    notepad: {},
    state: {
      lastRunAt: null,
      lastResult: null,
      lastOutput: null,
      nextRunAt: null,
      consecutiveFailures: 0,
      pausedReason: null,
    },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  validateMode(task);
  const next = computeNextRun(task, now);
  task.state.nextRunAt = next === null ? null : new Date(next).toISOString();
  return task;
}

export function validateMode(task) {
  if (task.mode === 'script' && !task.script?.command) {
    throw new TaskError('script 模式需要 script.command');
  }
  if (task.mode === 'agent' && !task.prompt) {
    throw new TaskError('agent 模式需要 prompt');
  }
}

/**
 * 磁盘上的旧任务归一化。读取路径上不抛错：一条坏任务不该让整个工作区起不来，
 * 能迁移的迁移，迁不动的留给体检报出来。
 */
export function normalizeStoredTask(raw, { timeZone = 'UTC', workspace } = {}) {
  const task = { ...raw };
  task.workspace = workspace ?? task.workspace;
  task.mode = normalizeMode(raw.mode) ?? 'agent';
  task.timeZone = typeof raw.timeZone === 'string' && raw.timeZone ? raw.timeZone : timeZone;

  try {
    task.schedule = normalizeSchedule(raw.schedule ?? raw.when, task.timeZone);
  } catch {
    const fallback = typeof raw.schedule === 'object' ? raw.schedule?.expression : raw.schedule ?? raw.when;
    task.schedule = { kind: 'cron', expression: String(fallback ?? '0 9 * * *').trim() || '0 9 * * *' };
  }

  task.delivery = normalizeDelivery(raw.delivery, 'delivery', 'silent');
  task.target = normalizeTarget(raw.target, 'target');
  try {
    task.script = normalizeScript(raw.script);
  } catch {
    task.script = null;
  }
  task.prompt = typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim() : null;
  task.agent = normalizeAgent(raw.agent);
  task.tags = Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string').slice(0, 10) : [];
  task.repeat = Number.isInteger(raw.repeat) ? raw.repeat : null;
  task.runCount = Number.isInteger(raw.runCount) ? raw.runCount : 0;
  task.enabled = raw.enabled !== false;
  // 记事本历史上存过两处：任务顶层和 state 里，读的时候都认。
  const legacyNotepad = raw.notepad ?? raw.state?.notepad;
  task.notepad = legacyNotepad && typeof legacyNotepad === 'object' ? { ...legacyNotepad } : {};
  task.state = {
    lastRunAt: null,
    lastResult: null,
    lastOutput: null,
    nextRunAt: null,
    consecutiveFailures: 0,
    pausedReason: null,
    ...(raw.state && typeof raw.state === 'object' ? raw.state : {}),
  };
  delete task.state.notepad;
  task.createdAt = raw.createdAt ?? new Date().toISOString();
  task.updatedAt = raw.updatedAt ?? task.createdAt;

  delete task.monitor;
  delete task.failureDelivery;
  delete task.when;
  return task;
}

/** 下次执行时刻（ms）；永不执行返回 null。 */
export function computeNextRun(task, from) {
  if (!task.enabled) return null;
  if (Number.isInteger(task.repeat) && task.runCount >= task.repeat) return null;
  const schedule = task.schedule;
  if (!schedule) return null;
  const timeZone = task.timeZone ?? 'UTC';
  const cursor = typeof from === 'number' ? from : Date.now();

  try {
    switch (schedule.kind) {
      case 'once': {
        // 到点跑完就不再有下次；过去的时间永不补跑。
        if (task.runCount > 0) return null;
        const [year, month, day] = schedule.date.split('-').map(Number);
        const [hour, minute] = schedule.time.split(':').map(Number);
        const instant = zonedTimeToInstant({ year, month, day, hour, minute, second: 0 }, timeZone);
        return instant !== null && instant > cursor ? instant : null;
      }
      // 等间隔语义用绝对时间推进：cron 的 `*/n` 在字段边界会回卷，
      // 每 45 秒会变成 45/15 秒交替，每 90 分钟会退化成一小时。
      case 'every-seconds':
        return nextAbsolute(cursor, schedule.interval * 1000);
      case 'every-minutes':
        return nextAbsolute(cursor, schedule.interval * 60_000);
      case 'every-hours':
        return nextEveryHours(task, cursor, schedule, timeZone);
      case 'every-days':
        return nextEveryDays(task, cursor, schedule, timeZone);
      default:
        // 墙上时钟类（含自定义 cron）走带时区和 DST 的 cron 换算
        return nextOccurrence(parseCron(compileCron(schedule)), cursor, timeZone);
    }
  } catch (error) {
    // 坏表达式只会让这条任务不跑，体检会点名；整个 tick 不能被它拖死。
    if (error instanceof CronError) return null;
    throw error;
  }
}

/** 按绝对时间等间隔推进，锚在 epoch（1970-01-01T00:00Z 是整分整秒）。 */
function nextAbsolute(from, stepMs) {
  return (Math.floor(from / stepMs) + 1) * stepMs;
}

/**
 * 每 N 小时第 M 分：先找到创建后的第一个 :M，再按绝对小时等间隔推进。
 * 这样跨天、跨月都不会出现短间隔，也能扛住停机后跳过错过的那几次。
 */
function nextEveryHours(task, from, schedule, timeZone) {
  const parsed = parseCron(`${schedule.minute} * * * *`);
  const created = Date.parse(task.createdAt ?? '');
  const anchor = nextOccurrence(parsed, Number.isFinite(created) ? created : from, timeZone);
  if (anchor === null) return null;
  if (from < anchor) return anchor;
  const step = schedule.interval * 3_600_000;
  return anchor + Math.ceil((from - anchor + 1) / step) * step;
}

/**
 * 每 N 天：日号在月底会重置，按步长取日号会变成 1、3、5…31、1 这种断点，
 * 所以按创建日的第几天锚定，逐个日候选筛。
 */
function nextEveryDays(task, from, schedule, timeZone) {
  const parsed = parseCron(compileCron({ kind: 'daily', time: schedule.time }));
  const interval = schedule.interval;
  const created = Date.parse(task.createdAt ?? '');
  const anchorDay = localDayIndex(Number.isFinite(created) ? created : from, timeZone);
  let cursor = from;
  for (let step = 0; step <= interval + 2; step += 1) {
    const next = nextOccurrence(parsed, cursor, timeZone);
    if (next === null) return null;
    if (mod(localDayIndex(next, timeZone) - anchorDay, interval) === 0) return next;
    cursor = next;
  }
  return null;
}

function localDayIndex(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function mod(value, base) {
  return ((value % base) + base) % base;
}

export function describeSchedule(task) {
  return describeValue(task.schedule, task.timeZone ?? 'UTC');
}

function describeValue(schedule, timeZone) {
  switch (schedule?.kind) {
    case 'once':
      return `${schedule.date} ${schedule.time} 一次`;
    case 'monthly':
      return `每月 ${schedule.dayOfMonth} 日 ${schedule.time}`;
    case 'weekly':
      return `每${WEEKDAY_LABELS[schedule.weekday - 1]} ${schedule.time}`;
    case 'daily':
      return `每天 ${schedule.time}`;
    case 'hourly':
      return `每小时第 ${pad2(schedule.minute)} 分`;
    case 'every-days':
      return `每 ${schedule.interval} 天 ${schedule.time}`;
    case 'every-hours':
      return `每 ${schedule.interval} 小时第 ${pad2(schedule.minute)} 分`;
    case 'every-minutes':
      return `每 ${schedule.interval} 分钟`;
    case 'every-seconds':
      return `每 ${schedule.interval} 秒`;
    case 'cron':
      try {
        return describeCron(parseCron(schedule.expression), timeZone);
      } catch {
        return schedule.expression;
      }
    default:
      return String(schedule?.kind ?? '');
  }
}

/** 选择器预览：一次算出多条接下来要跑的时间，供面板显示。 */
export function previewSchedule(input, { from = Date.now(), timeZone = 'UTC', count = 3 } = {}) {
  const schedule = normalizeSchedule(input, timeZone);
  const task = {
    enabled: true,
    repeat: null,
    runCount: 0,
    schedule,
    timeZone,
    createdAt: new Date(from).toISOString(),
  };
  const next = [];
  let cursor = from;
  for (let index = 0; index < count; index += 1) {
    const instant = computeNextRun(task, cursor);
    if (instant === null) break;
    next.push(new Date(instant).toISOString());
    cursor = instant;
  }
  return { schedule, text: describeValue(schedule, timeZone), next };
}

/** Whether the task is due at `now`. */
export function isDue(task, now) {
  if (!task.enabled) return false;
  const next = task.state?.nextRunAt;
  if (!next) return false;
  const nextMs = typeof next === 'number' ? next : Date.parse(next);
  if (!Number.isFinite(nextMs)) return false;
  return nextMs <= now;
}

/** Project a stored task into the shape handed to the model / panel. */
export function publicTask(task) {
  return {
    id: task.id,
    title: task.title,
    enabled: task.enabled,
    mode: task.mode,
    schedule: task.schedule,
    scheduleText: describeSchedule(task),
    repeat: task.repeat,
    retries: task.retries ?? 0,
    timeoutMs: task.timeoutMs ?? null,
    permission: task.permission ?? null,
    runCount: task.runCount,
    script: task.script ?? null,
    prompt: task.prompt ?? null,
    workspace: task.workspace,
    delivery: task.delivery,
    target: task.target ?? { kind: 'new_once' },
    ...(task.target?.kind !== 'existing' && task.state?.targetSessionId
      ? { targetSessionId: task.state.targetSessionId }
      : {}),
    tags: task.tags ?? [],
    agent: task.agent ?? {},
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    state: {
      lastRunAt: task.state?.lastRunAt ?? null,
      lastResult: task.state?.lastResult ?? null,
      lastOutput: task.state?.lastOutput ?? null,
      nextRunAt: task.state?.nextRunAt ?? null,
      consecutiveFailures: task.state?.consecutiveFailures ?? 0,
      pausedReason: task.state?.pausedReason ?? null,
      notepad: task.notepad ?? task.state?.notepad ?? {},
    },
  };
}
