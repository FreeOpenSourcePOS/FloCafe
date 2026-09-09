import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Parses backend UTC timestamp (YYYY-MM-DD HH:MM:SS or ISO) into Date
 * without shifting for local machine timezone offset. */
export function parseDbTimestamp(ts: string | null | undefined): Date {
  if (!ts) return new Date(NaN)
  return /^\d{4}-\d{2}-\d{2} /.test(ts) ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date(ts)
}

// UTC calendar day — matches the backend's utcTodayDate() convention, so a
// date picked here is never rejected as "in the future" by a client whose
// local clock has already rolled past midnight UTC.
export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function currentUtcMonth(): string {
  return todayUtcDate().slice(0, 7)
}
