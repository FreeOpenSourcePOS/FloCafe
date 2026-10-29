/**
 * Store-timezone parsing, daylight-saving validation, and wall-clock formatting
 * for scheduled order kitchen release times ("Send to kitchen at").
 *
 * Scheduled instants are entered and displayed in the configured store timezone
 * and persisted as canonical UTC ISO-8601 strings (`YYYY-MM-DDTHH:MM:SS.sssZ`),
 * so changing the store timezone setting later preserves the saved instant.
 */

export type ScheduledTimeValidationCode =
  | 'INVALID_FORMAT'
  | 'INVALID_TIMEZONE'
  | 'INVALID_CALENDAR_DATE'
  | 'DST_NONEXISTENT_TIME'
  | 'DST_AMBIGUOUS_TIME'
  | 'PAST_SCHEDULED_TIME';

export interface ScheduledTimeParseSuccess {
  ok: true;
  isoUtc: string;
  instantMs: number;
}

export interface ScheduledTimeParseFailure {
  ok: false;
  code: ScheduledTimeValidationCode;
  message: string;
}

export type ScheduledTimeParseResult = ScheduledTimeParseSuccess | ScheduledTimeParseFailure;

export interface ParseScheduledForOptions {
  input: unknown;
  timezone: string;
  nowMs?: number;
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const EXPLICIT_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i;

function isValidCalendarAndClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return false;
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

function getWallClockInTimezone(instantMs: number, formatter: Intl.DateTimeFormat): WallClockParts {
  const parts = formatter.formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const rawHour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: get('minute'),
    second: get('second'),
  };
}

function createWallClockFormatter(timezone: string): Intl.DateTimeFormat | null {
  if (!timezone || typeof timezone !== 'string' || !timezone.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone.trim(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null;
  }
}

function timezoneOffsetMsAtInstant(instantMs: number, formatter: Intl.DateTimeFormat): number {
  const local = getWallClockInTimezone(instantMs, formatter);
  const wholeSecondInstant = Math.floor(instantMs / 1000) * 1000;
  return (
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) -
    wholeSecondInstant
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatWallClockLabel(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string {
  const base = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
  return second > 0 ? `${base}:${pad2(second)}` : base;
}

/**
 * Parses a "Send to kitchen at" value into a canonical UTC ISO instant.
 *
 * - Wall-clock inputs (`YYYY-MM-DDTHH:MM` or `YYYY-MM-DD HH:MM[:SS]`) are
 *   interpreted in `timezone`, rejecting nonexistent (skipped spring-forward)
 *   and ambiguous (repeated fall-back) daylight-saving times with a clear
 *   explanation.
 * - Explicit-offset ISO inputs (`...Z` or `...+HH:MM`) are accepted as exact
 *   instants.
 * - Past or current instants (`<= nowMs`) are rejected.
 */
export function parseScheduledForInput(
  options: ParseScheduledForOptions,
): ScheduledTimeParseResult {
  const { input, timezone, nowMs = Date.now() } = options;
  const formatter = createWallClockFormatter(timezone);
  if (!formatter) {
    return {
      ok: false,
      code: 'INVALID_TIMEZONE',
      message: 'Store timezone is not configured or is invalid.',
    };
  }

  if (typeof input !== 'string' || !input.trim()) {
    return {
      ok: false,
      code: 'INVALID_FORMAT',
      message: 'Scheduled kitchen release time must be a valid date and time (YYYY-MM-DDTHH:MM).',
    };
  }

  const trimmed = input.trim();

  const wallMatch = WALL_CLOCK_RE.exec(trimmed);
  if (wallMatch) {
    const year = Number(wallMatch[1]);
    const month = Number(wallMatch[2]);
    const day = Number(wallMatch[3]);
    const hour = Number(wallMatch[4]);
    const minute = Number(wallMatch[5]);
    const second = wallMatch[6] !== undefined ? Number(wallMatch[6]) : 0;
    const ms = wallMatch[7] !== undefined ? Number(wallMatch[7].padEnd(3, '0')) : 0;

    if (!isValidCalendarAndClock(year, month, day, hour, minute, second)) {
      return {
        ok: false,
        code: 'INVALID_CALENDAR_DATE',
        message: 'Scheduled kitchen release date or time is not a valid calendar date.',
      };
    }

    const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    const candidateOffsets = new Set<number>();
    const windowMs = 16 * 60 * 60 * 1000;
    const stepMs = 15 * 60 * 1000;
    for (let probe = wallUtcMs - windowMs; probe <= wallUtcMs + windowMs; probe += stepMs) {
      candidateOffsets.add(timezoneOffsetMsAtInstant(probe, formatter));
    }
    let refined = wallUtcMs;
    for (let i = 0; i < 3; i++) {
      const off = timezoneOffsetMsAtInstant(refined, formatter);
      candidateOffsets.add(off);
      refined = wallUtcMs - off;
    }

    const candidateInstants = Array.from(candidateOffsets)
      .map((off) => wallUtcMs - off)
      .sort((a, b) => a - b);

    const uniqueMatches: number[] = [];
    for (const candidateMs of candidateInstants) {
      if (uniqueMatches.length > 0 && uniqueMatches[uniqueMatches.length - 1] === candidateMs) {
        continue;
      }
      const actual = getWallClockInTimezone(candidateMs, formatter);
      const actualMs = ((candidateMs % 1000) + 1000) % 1000;
      if (
        actual.year === year &&
        actual.month === month &&
        actual.day === day &&
        actual.hour === hour &&
        actual.minute === minute &&
        actual.second === second &&
        actualMs === ms
      ) {
        uniqueMatches.push(candidateMs);
      }
    }

    const label = formatWallClockLabel(year, month, day, hour, minute, second);
    const cleanTz = timezone.trim();

    if (uniqueMatches.length === 0) {
      return {
        ok: false,
        code: 'DST_NONEXISTENT_TIME',
        message: `Selected time (${label}) does not exist in store timezone ${cleanTz} because clocks spring forward for daylight saving time. Choose a valid time before or after the transition.`,
      };
    }

    if (uniqueMatches.length > 1) {
      return {
        ok: false,
        code: 'DST_AMBIGUOUS_TIME',
        message: `Selected time (${label}) occurs twice in store timezone ${cleanTz} when clocks fall back from daylight saving time. Choose an unambiguous time outside the repeated hour.`,
      };
    }

    const instantMs = uniqueMatches[0];
    if (instantMs <= nowMs) {
      return {
        ok: false,
        code: 'PAST_SCHEDULED_TIME',
        message:
          'Scheduled kitchen release time must be in the future. Place an unscheduled order or use Release now for immediate kitchen preparation.',
      };
    }

    return {
      ok: true,
      isoUtc: new Date(instantMs).toISOString(),
      instantMs,
    };
  }

  const explicitMatch = EXPLICIT_OFFSET_RE.exec(trimmed);
  if (explicitMatch) {
    const year = Number(explicitMatch[1]);
    const month = Number(explicitMatch[2]);
    const day = Number(explicitMatch[3]);
    const hour = Number(explicitMatch[4]);
    const minute = Number(explicitMatch[5]);
    const second = explicitMatch[6] !== undefined ? Number(explicitMatch[6]) : 0;
    const ms = explicitMatch[7] !== undefined ? Number(explicitMatch[7].padEnd(3, '0')) : 0;
    const rawZone = explicitMatch[8];
    const sign = explicitMatch[9];
    const offHour = explicitMatch[10] !== undefined ? Number(explicitMatch[10]) : 0;
    const offMin = explicitMatch[11] !== undefined ? Number(explicitMatch[11]) : 0;

    if (
      !isValidCalendarAndClock(year, month, day, hour, minute, second) ||
      offHour > 23 ||
      offMin > 59
    ) {
      return {
        ok: false,
        code: 'INVALID_CALENDAR_DATE',
        message: 'Scheduled kitchen release date or time is not a valid calendar date.',
      };
    }

    const baseUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    const offsetDeltaMs =
      rawZone.toUpperCase() === 'Z'
        ? 0
        : (sign === '+' ? 1 : -1) * (offHour * 60 + offMin) * 60 * 1000;
    const instantMs = baseUtc - offsetDeltaMs;

    if (instantMs <= nowMs) {
      return {
        ok: false,
        code: 'PAST_SCHEDULED_TIME',
        message:
          'Scheduled kitchen release time must be in the future. Place an unscheduled order or use Release now for immediate kitchen preparation.',
      };
    }

    return {
      ok: true,
      isoUtc: new Date(instantMs).toISOString(),
      instantMs,
    };
  }

  return {
    ok: false,
    code: 'INVALID_FORMAT',
    message:
      'Scheduled kitchen release time must be formatted as YYYY-MM-DDTHH:MM in the store timezone.',
  };
}

/**
 * Formats an instant (Date or stored UTC timestamp) into `YYYY-MM-DDTHH:MM` in
 * the given IANA timezone for `<input type="datetime-local" />` controls.
 */
export function formatInstantForDateTimeInput(
  instant: Date | string | null | undefined,
  timezone: string,
): string {
  if (!instant) return '';
  const date =
    instant instanceof Date
      ? instant
      : new Date(
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(instant.trim())
            ? `${instant.trim().replace(' ', 'T')}Z`
            : instant,
        );
  if (Number.isNaN(date.getTime())) return '';
  const formatter = createWallClockFormatter(timezone);
  if (!formatter) return '';
  const parts = getWallClockInTimezone(date.getTime(), formatter);
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/**
 * Formats an instant for human display in the configured store timezone.
 */
export function formatScheduledInstantForDisplay(
  instant: Date | string | null | undefined,
  timezone: string,
  locale?: string,
): string {
  if (!instant) return '';
  const date =
    instant instanceof Date
      ? instant
      : new Date(
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(instant.trim())
            ? `${instant.trim().replace(' ', 'T')}Z`
            : instant,
        );
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return formatInstantForDateTimeInput(date, timezone).replace('T', ' ');
  }
}

/**
 * Computes a sensible default future wall-clock value (`YYYY-MM-DDTHH:MM`) in
 * the store timezone, advancing past any ambiguous fall-back DST hour.
 */
export function suggestFutureScheduleWallClock(
  timezone: string,
  nowMs: number = Date.now(),
  minutesAhead: number = 30,
): string {
  const stepFiveMin = 5 * 60 * 1000;
  let candidateMs =
    Math.ceil((nowMs + Math.max(5, minutesAhead) * 60 * 1000) / stepFiveMin) * stepFiveMin;
  for (let attempt = 0; attempt < 12; attempt++) {
    const wall = formatInstantForDateTimeInput(new Date(candidateMs), timezone);
    if (!wall) return '';
    const check = parseScheduledForInput({ input: wall, timezone, nowMs });
    if (check.ok) return wall;
    candidateMs += 15 * 60 * 1000;
  }
  return formatInstantForDateTimeInput(new Date(candidateMs), timezone);
}
