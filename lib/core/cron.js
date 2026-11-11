/**
 * Five-field cron parsing and next-occurrence resolution with real time-zone
 * support (DST-correct), plus a small descriptive renderer.
 *
 * Supported grammar per field: `*`, `?`, single values, `a-b` ranges, `a,b,c`
 * lists, `*\/n` and `a-b/n` steps, and month/weekday names (JAN..DEC,
 * SUN..SAT). Weekday 7 is accepted as Sunday. Six fields are accepted when the
 * first one is a seconds field (0-59).
 *
 * Matching follows Vixie cron: when BOTH day-of-month and day-of-week are
 * restricted, a day matches if either one matches.
 */

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const WEEKDAY_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dayOfMonth', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { key: 'dayOfWeek', min: 0, max: 7, names: WEEKDAY_NAMES },
];

export class CronError extends Error {
  constructor(message, code = 'invalid-cron') {
    super(message);
    this.name = 'CronError';
    this.code = code;
  }
}

function parseValue(token, field) {
  const lowered = token.toLowerCase();
  if (field.names && Object.hasOwn(field.names, lowered)) return field.names[lowered];
  if (!/^\d+$/.test(token)) {
    throw new CronError(`字段 ${field.key} 中的 "${token}" 不是合法取值`);
  }
  const value = Number(token);
  if (value < field.min || value > field.max) {
    throw new CronError(`字段 ${field.key} 中的 ${value} 超出 ${field.min}-${field.max}`);
  }
  return value;
}

function parseField(source, field) {
  const raw = String(source).trim();
  if (raw === '') throw new CronError(`字段 ${field.key} 为空`);
  if (raw === '*' || raw === '?') {
    return { values: expandRange(field.min, field.max, 1), restricted: false };
  }

  const values = new Set();
  let restricted = true;

  for (const part of raw.split(',')) {
    if (part === '') throw new CronError(`字段 ${field.key} 中有空列表项`);
    const [rangePart, stepPart, ...rest] = part.split('/');
    if (rest.length > 0) throw new CronError(`字段 ${field.key} 中的 "${part}" 步长写法不合法`);

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw new CronError(`字段 ${field.key} 的步长 "${stepPart}" 不是整数`);
      step = Number(stepPart);
      if (step === 0) throw new CronError(`字段 ${field.key} 的步长不能为 0`);
    }

    let from;
    let to;
    if (rangePart === '*' || rangePart === '?') {
      from = field.min;
      to = field.max;
      if (stepPart === undefined) restricted = false;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      from = parseValue(a, field);
      to = parseValue(b, field);
    } else {
      from = parseValue(rangePart, field);
      to = stepPart === undefined ? from : field.max;
    }

    if (from > to) throw new CronError(`字段 ${field.key} 的范围 "${part}" 起点大于终点`);
    for (const value of expandRange(from, to, step)) values.add(value);
  }

  if (field.key === 'dayOfWeek' && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  if (values.size === 0) throw new CronError(`字段 ${field.key} 没有匹配任何值`);
  return { values, restricted };
}

function expandRange(from, to, step) {
  const out = [];
  for (let value = from; value <= to; value += step) out.push(value);
  return out;
}

/**
 * Parse a cron expression.
 * @returns {{
 *   source: string,
 *   seconds: number[]|null,
 *   minutes: number[],
 *   hours: number[],
 *   daysOfMonth: number[],
 *   months: number[],
 *   daysOfWeek: number[],
 *   domRestricted: boolean,
 *   dowRestricted: boolean,
 * }}
 */
export function parseCron(expression) {
  const source = String(expression ?? '').trim();
  if (source === '') throw new CronError('cron 表达式为空');
  const parts = source.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new CronError(`cron 表达式需要 5 段（分 时 日 月 周），收到 ${parts.length} 段`);
  }

  let seconds = null;
  let offset = 0;
  if (parts.length === 6) {
    const secondField = parseField(parts[0], { key: 'second', min: 0, max: 59 });
    seconds = [...secondField.values].sort((a, b) => a - b);
    offset = 1;
  }

  const parsed = { source };
  for (let index = 0; index < FIELDS.length; index += 1) {
    const field = FIELDS[index];
    const result = parseField(parts[index + offset], field);
    if (field.key === 'dayOfMonth') {
      parsed.daysOfMonth = [...result.values].sort((a, b) => a - b);
      parsed.domRestricted = result.restricted;
    } else if (field.key === 'dayOfWeek') {
      parsed.daysOfWeek = [...result.values].sort((a, b) => a - b);
      parsed.dowRestricted = result.restricted;
    } else {
      const plural = { minute: 'minutes', hour: 'hours', month: 'months' }[field.key];
      parsed[plural] = [...result.values].sort((a, b) => a - b);
    }
  }
  parsed.seconds = seconds;
  return parsed;
}

const formatterCache = new Map();

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Local calendar fields for an instant in a time zone. */
export function zonedParts(instant, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

function offsetMsAt(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Convert wall-clock fields in a time zone to a UTC instant.
 * @returns {number|null} null when the wall time does not exist (DST gap).
 */
export function zonedTimeToInstant(fields, timeZone) {
  const { year, month, day, hour, minute, second = 0 } = fields;
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = guess - offsetMsAt(guess, timeZone);
  const secondOffset = offsetMsAt(instant, timeZone);
  instant = guess - secondOffset;
  const check = zonedParts(instant, timeZone);
  if (
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute ||
    check.second !== second
  ) {
    return null;
  }
  return instant;
}

function dayMatches(parsed, parts) {
  if (!parsed.months.includes(parts.month)) return false;
  const domHit = parsed.daysOfMonth.includes(parts.day);
  const dow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const dowHit = parsed.daysOfWeek.includes(dow);
  if (parsed.domRestricted && parsed.dowRestricted) return domHit || dowHit;
  if (parsed.domRestricted) return domHit;
  if (parsed.dowRestricted) return dowHit;
  return true;
}

const DEFAULT_HORIZON_MS = 5 * 365 * 24 * 3600 * 1000;

/**
 * Next instant strictly after `after` that matches the expression.
 * @param {ReturnType<typeof parseCron>} parsed
 * @param {number|Date} after
 * @param {string} timeZone IANA zone, defaults to UTC.
 * @param {{ horizonMs?: number }} [options]
 * @returns {number|null} epoch milliseconds, or null when nothing matches in the horizon.
 */
export function nextOccurrence(parsed, after, timeZone = 'UTC', options = {}) {
  const afterMs = after instanceof Date ? after.getTime() : Number(after);
  if (!Number.isFinite(afterMs)) throw new CronError('nextOccurrence 需要合法的起始时间');
  const horizonMs = options.horizonMs ?? DEFAULT_HORIZON_MS;
  const deadline = afterMs + horizonMs;

  const startParts = zonedParts(afterMs, timeZone);
  // Walk local calendar days from the day containing `after`.
  let cursorInstant = zonedTimeToInstant(
    { year: startParts.year, month: startParts.month, day: startParts.day, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  if (cursorInstant === null) cursorInstant = afterMs - (afterMs % 86400000);

  let guard = 0;
  while (cursorInstant <= deadline) {
    guard += 1;
    if (guard > 4000) break;
    const parts = zonedParts(cursorInstant, timeZone);
    const localMidnight = Date.UTC(parts.year, parts.month - 1, parts.day);

    if (dayMatches(parsed, parts)) {
      const found = firstTimeOnDay(parsed, parts, timeZone, afterMs);
      if (found !== null) return found;
    }

    // Advance exactly one local day: add 24h, then correct if DST kept us on the same date.
    let next = cursorInstant + 86400000;
    let nextParts = zonedParts(next, timeZone);
    let sameDay = Date.UTC(nextParts.year, nextParts.month - 1, nextParts.day) === localMidnight;
    let tries = 0;
    while (sameDay && tries < 3) {
      next += 3600000;
      nextParts = zonedParts(next, timeZone);
      sameDay = Date.UTC(nextParts.year, nextParts.month - 1, nextParts.day) === localMidnight;
      tries += 1;
    }
    cursorInstant = next;
    if (!Number.isFinite(cursorInstant)) break;
  }
  return null;
}

function firstTimeOnDay(parsed, dayParts, timeZone, afterMs) {
  const seconds = parsed.seconds ?? [0];
  for (const hour of parsed.hours) {
    for (const minute of parsed.minutes) {
      for (const second of seconds) {
        const instant = zonedTimeToInstant(
          {
            year: dayParts.year,
            month: dayParts.month,
            day: dayParts.day,
            hour,
            minute,
            second,
          },
          timeZone,
        );
        if (instant === null) continue; // DST gap: this wall time does not exist
        if (instant > afterMs) return instant;
      }
    }
  }
  return null;
}

/** Human-readable rendering, e.g. "每天 09:00（Asia/Shanghai）". */
export function describeCron(parsed, timeZone = 'UTC') {
  const minutes = parsed.minutes.join(',');
  const hours = parsed.hours.join(',');
  const zone = timeZone === 'UTC' ? 'UTC' : timeZone;
  if (parsed.source.trim() === '* * * * *') return `每分钟（${zone}）`;
  if (parsed.source.trim() === '0 * * * *') return `每小时整点（${zone}）`;
  const isDaily = !parsed.domRestricted && !parsed.dowRestricted && parsed.months.length === 12;
  if (isDaily && parsed.hours.length * parsed.minutes.length <= 6) {
    const times = [];
    for (const hour of parsed.hours) {
      for (const minute of parsed.minutes) {
        times.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
      }
    }
    return `每天 ${times.join('、')}（${zone}）`;
  }
  void minutes;
  void hours;
  return `${parsed.source}（${zone}）`;
}

export const CRON_HELP = [
  '5 段：分 时 日 月 周；可选第 6 段放最前面表示秒。',
  '支持 * ? 单值 a-b 范围 a,b,c 列表 和 /n 步长；月份可用 JAN-DEC，周可用 SUN-SAT，周日写 0 或 7。',
  '日和周同时被限定时，命中任一即触发（Vixie cron 语义）。',
  '示例：0 9 * * *（每天 9 点）、*/15 * * * *（每 15 分钟）、30 8 * * 1-5（工作日 8:30）。',
].join('\n');
