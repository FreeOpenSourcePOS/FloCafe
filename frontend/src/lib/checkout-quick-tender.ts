import type { CurrencyUnitAdapter } from '@countries';

export interface QuickCashDisplayOptions {
  remainingMinor: number;
  minorFactor: number;
  unitAdapter: Pick<CurrencyUnitAdapter, 'toDisplay' | 'maxDecimals'>;
  maxPills?: number;
}

function roundToPrecision(value: number, precision: number): number {
  const safePrecision = Math.max(0, precision);
  const factor = 10 ** safePrecision;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(value));
  const adjusted = value < 0 ? value - epsilon : value + epsilon;
  return Math.round(adjusted * factor) / factor;
}

/** Computes up to `maxPills` (default 4) unique, ascending quick-cash tender amounts in display units. */
export function computeQuickCashDisplayAmounts({
  remainingMinor,
  minorFactor,
  unitAdapter,
  maxPills = 4,
}: QuickCashDisplayOptions): number[] {
  if (!Number.isFinite(remainingMinor) || remainingMinor <= 0 || maxPills <= 0) {
    return [];
  }

  const safeFactor = minorFactor > 0 ? minorFactor : 1;
  const displayPrecision = Math.max(0, unitAdapter.maxDecimals ?? 0);
  const exactDisplay = roundToPrecision(
    unitAdapter.toDisplay(remainingMinor / safeFactor),
    displayPrecision,
  );
  if (!Number.isFinite(exactDisplay) || exactDisplay <= 0) {
    return [];
  }

  const minExponent = Math.max(0, Math.floor(Math.log10(Math.max(1, exactDisplay))) - 1);
  const candidates = new Set<number>();

  for (let exp = minExponent; exp <= minExponent + 5; exp++) {
    const base = 10 ** exp;
    const stepOne = roundToPrecision(Math.ceil(exactDisplay / base) * base, displayPrecision);
    const stepFive = roundToPrecision(
      Math.ceil(exactDisplay / (5 * base)) * (5 * base),
      displayPrecision,
    );
    const notes = [base, 2 * base, 5 * base];

    for (const candidate of [stepOne, stepFive, ...notes]) {
      if (candidate > exactDisplay) {
        candidates.add(candidate);
      }
    }
  }

  const nextBills = [...candidates].sort((a, b) => a - b).slice(0, Math.max(0, maxPills - 1));
  return [exactDisplay, ...nextBills];
}

/** Proportionally scales integer minor-unit row amounts to sum strictly to `targetTotalMinor` using Hamilton largest-remainder apportionment. */
export function rescalePaymentAmountsMinor(
  currentMinorAmounts: number[],
  targetTotalMinor: number,
): number[] {
  if (currentMinorAmounts.length === 0) return [];
  const safeTarget = Math.max(0, Math.round(targetTotalMinor));
  if (safeTarget === 0) {
    return currentMinorAmounts.map(() => 0);
  }

  const normalized = currentMinorAmounts.map((v) =>
    Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0,
  );
  const previousTotal = normalized.reduce((sum, v) => sum + v, 0);

  if (previousTotal <= 0) {
    const base = Math.floor(safeTarget / normalized.length);
    let rem = safeTarget - base * normalized.length;
    return normalized.map(() => {
      if (rem > 0) {
        rem--;
        return base + 1;
      }
      return base;
    });
  }

  const scaled = normalized.map((amt, index) => {
    const exact = (amt * safeTarget) / previousTotal;
    const floorVal = Math.floor(exact);
    return { index, floorVal, frac: exact - floorVal };
  });

  const result = scaled.map((item) => item.floorVal);
  let remainder = safeTarget - result.reduce((sum, v) => sum + v, 0);

  if (remainder > 0) {
    const byFraction = [...scaled].sort((a, b) =>
      b.frac !== a.frac ? b.frac - a.frac : a.index - b.index,
    );
    for (let i = 0; i < byFraction.length && remainder > 0; i++) {
      result[byFraction[i].index] += 1;
      remainder--;
    }
  }

  return result;
}

/** Computes remaining minor units to allocate to `targetIndex` without floating-point subtraction drift. */
export function allocateRemainingMinor(
  totalDueMinor: number,
  rowAmountsMinor: number[],
  targetIndex: number,
): number {
  const safeDue = Math.max(0, Math.round(totalDueMinor));
  const otherSum = rowAmountsMinor.reduce((sum, amt, index) => {
    if (index === targetIndex) return sum;
    return sum + (Number.isFinite(amt) ? Math.max(0, Math.round(amt)) : 0);
  }, 0);
  return Math.max(0, safeDue - otherSum);
}
