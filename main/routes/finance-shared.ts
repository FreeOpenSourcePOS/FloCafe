import { utcTodayDate } from '../db';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Business date a record is FOR: defaults to today, may be backdated, never
 * postdated. Distinct from created_at, which always stamps the real moment
 * of recording and is never client-supplied.
 */
export function normalizeBusinessDate(value: unknown): string {
  if (value === undefined || value === null || value === '') return utcTodayDate();
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw httpError('date must be in YYYY-MM-DD format', 400);
  }
  const [year, month, day] = value.split('-').map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    throw httpError('date is not a real calendar date', 400);
  }
  if (value > utcTodayDate()) {
    throw httpError('date cannot be in the future', 400);
  }
  return value;
}

/** [firstDay, lastDay] of a `YYYY-MM` month, both inclusive `YYYY-MM-DD` strings. */
export function monthBounds(month: string): [string, string] {
  if (!MONTH_PATTERN.test(month)) {
    throw httpError('month must be in YYYY-MM format', 400);
  }
  const [year, mon] = month.split('-').map(Number);
  if (mon < 1 || mon > 12) {
    throw httpError('month must be in YYYY-MM format', 400);
  }
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(lastDay).padStart(2, '0')}`];
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}
