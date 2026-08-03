import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse a backend timestamp into a Date. The API stores timestamps in UTC
 * wall time as `YYYY-MM-DD HH:MM:SS` (space form); V8's legacy parser reads
 * that form as machine-LOCAL time, so `new Date(ts)` shifts by the host's
 * offset on machines outside UTC. ISO rows (pre-v45 data) parse as UTC
 * natively. Use this for every `created_at`/`paid_at`-style field.
 */
export function parseDbTimestamp(ts: string | null | undefined): Date {
  if (!ts) return new Date(NaN)
  return /^\d{4}-\d{2}-\d{2} /.test(ts) ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date(ts)
}
