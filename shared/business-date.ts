/**
 * The business-day rule: which day an instant belongs to, for a tenant timezone
 * and a configured `business_day_start_time`.
 *
 * The backend resolves it through main/db.ts and the renderer imports this module
 * directly, so a report and the screen that shows it cannot name different days
 * for the same store. The rule works from the instant rather than from wall-clock
 * minutes: across a daylight-saving transition the local wall clock skips or
 * repeats, and only the instant comparison knows whether a repeated hour is the
 * first pass or the second.
 *
 * `businessDateForInstant` takes named arguments on purpose. Its two historical
 * callers passed the same three values in opposite orders, and because a Date and
 * a string are each valid in either position a swapped call typechecked and
 * silently moved money between days.
 */

export interface BusinessDateInput {
  /** The moment being bucketed. */
  instant: Date;
  /** IANA timezone of the tenant, e.g. `Europe/Madrid`. */
  timezone: string;
  /** `business_day_start_time` as `HH:MM`; anything unset or out of contract means midnight. */
  startTime?: string;
}

/**
 * The tenant's start-time contract: `00:00` to `11:59`, and midnight for anything
 * else. This is the range the settings endpoint accepts, so it is the range a
 * stored value can legitimately hold. Anything wider would make the renderer
 * honour an afternoon cutoff the backend's own read path normalises away, and the
 * two would then name different days for the same store.
 */
export function normalizeBusinessDayStartTime(startTime: string | null | undefined): string {
  const trimmed = typeof startTime === 'string' ? startTime.trim() : '';
  return /^(?:0\d|1[01]):[0-5]\d$/.test(trimmed) ? trimmed : '00:00';
}

/** Offset of a configured day start in milliseconds, or 0 when unset or unparsable. */
function dayStartOffsetMs(startTime: string = '00:00'): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(startTime.trim());
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return (hours * 60 + minutes) * 60 * 1000;
}

function calendarDateInTimezone(instant: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

function previousCalendarDate(calendarDate: string): string {
  const [year, month, day] = calendarDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function timezoneOffsetMilliseconds(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant.getTime();
}

/** `[start, end)` instants of one business day, or null when the timezone cannot resolve. */
function dayStartInstants(date: string, timezone: string, startTime: string): [Date, Date] | null {
  const [y, m, d] = date.split('-').map(Number);
  const offsetMinutes = dayStartOffsetMs(startTime) / 60000;
  const startHour = Math.floor(offsetMinutes / 60);
  const startMinute = offsetMinutes % 60;
  try {
    // The zone offset at the candidate instant is the one that maps a local wall
    // time onto an instant, so re-read it until it stops moving. A single pass
    // lands on the wrong instant either side of a transition.
    const toUtc = (localWallTime: number): Date => {
      let instant = new Date(localWallTime);
      for (let attempt = 0; attempt < 3; attempt++) {
        instant = new Date(localWallTime - timezoneOffsetMilliseconds(instant, timezone));
      }
      return instant;
    };
    return [
      toUtc(Date.UTC(y, m - 1, d, startHour, startMinute)),
      toUtc(Date.UTC(y, m - 1, d + 1, startHour, startMinute)),
    ];
  } catch {
    return null;
  }
}

function utcDayStartInstant(date: string, startTime: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + dayStartOffsetMs(startTime));
}

function sqlTimestamp(instant: Date): string {
  return instant.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/** Business date of an instant: the tenant-local calendar day, rolled back one day when
 *  the instant is still inside the previous business day's window. The configured start
 *  time is held to the tenant contract first, so this answers exactly what the
 *  backend's own settings read path answers. */
export function businessDateForInstant({ instant, timezone, startTime = '00:00' }: BusinessDateInput): string {
  const offset = normalizeBusinessDayStartTime(startTime);
  const calendarDate = calendarDateInTimezone(instant, timezone);
  if (dayStartOffsetMs(offset) === 0) return calendarDate;

  const [start] = dayStartInstants(calendarDate, timezone, offset) ?? [utcDayStartInstant(calendarDate, offset)];
  if (instant >= start) return calendarDate;

  return previousCalendarDate(calendarDate);
}

/** Half-open UTC ranges `[start, end)` for one date in the tenant timezone with an optional day start offset. */
export function dayBoundsInTimezone(date: string, timezone: string, startTime: string = '00:00'): [string, string] {
  const instants = dayStartInstants(date, timezone, startTime);
  if (!instants) return utcDayBounds(date, startTime);
  return [sqlTimestamp(instants[0]), sqlTimestamp(instants[1])];
}

/** Half-open UTC range strings `[start, end)` for a UTC calendar date with an optional day start offset. */
export function utcDayBounds(date: string, startTime: string = '00:00'): [string, string] {
  const start = utcDayStartInstant(date, startTime);
  return [sqlTimestamp(start), sqlTimestamp(new Date(start.getTime() + 24 * 3600 * 1000))];
}
