import type { CurrencyUnitAdapter } from '@/lib/countries';

/**
 * Single home for display-amount → integer-cents conversion (issue #279).
 * The adapter's `toStored` returns MAJOR units (Rial for IRR/Toman — the
 * adapter folds the Toman-to-Rial ratio itself), so multiplying by the
 * storage minor factor gives integer cents. Empty/invalid/negative →
 * null so callers can gate submit instead of sending a misleading 0.
 * Consumed by useCashClose (day close) and useCashSession (shifts) —
 * money conversion must not drift between the two flows.
 */
export function displayAmountToCents(
  raw: string,
  unitAdapter: Pick<CurrencyUnitAdapter, 'toStored'>,
  minorFactor: number,
): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(unitAdapter.toStored(n) * minorFactor);
}
