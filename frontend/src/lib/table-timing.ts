import { parseDbTimestamp } from '@/lib/utils';

export type TurnoverTier = 'fresh' | 'mid' | 'extended';

/** Minutes elapsed since a table was seated (`seated_at`), floored, never negative. */
export function getElapsedMinutes(seatedAt: string, now: number = Date.now()): number {
  const seatedMs = parseDbTimestamp(seatedAt).getTime();
  if (!Number.isFinite(seatedMs)) return 0;
  return Math.max(0, Math.floor((now - seatedMs) / 60000));
}

/** <30min fresh, 30-60min mid-service, >60min extended/turnover alert. */
export function getTurnoverTier(minutes: number): TurnoverTier {
  if (minutes >= 60) return 'extended';
  if (minutes >= 30) return 'mid';
  return 'fresh';
}

export const TURNOVER_TIER_CLASSES: Record<TurnoverTier, string> = {
  fresh: 'bg-emerald-100 text-emerald-700',
  mid: 'bg-amber-100 text-amber-700',
  extended: 'bg-rose-100 text-rose-700',
};

/** Splits total minutes into {h, m} for `common.timeHoursMinutes`/`common.timeMinutes`. */
export function splitHoursMinutes(minutes: number): { h: number; m: number } {
  return { h: Math.floor(minutes / 60), m: minutes % 60 };
}
