export type CurrencyAmountTarget = 'payment' | 'wallet' | 'discount';
export type CurrencyDiscountType = 'percentage' | 'amount';

export function getDiscountInputStep(maxDecimals: number, discountType: CurrencyDiscountType): string {
  return discountType === 'percentage' || maxDecimals === 0 ? '1' : '0.01';
}

export function normalizeFixedDiscountValue(value: number, maxDecimals: number): number {
  return roundCurrencyValue(value, maxDecimals === 0 ? 0 : 2);
}

export function roundCurrencyValue(value: number, maxDecimals: number): number {
  const factor = 10 ** Math.max(0, maxDecimals);
  return Math.round(value * factor) / factor;
}

export function allowCurrencyDecimalKey(
  maxDecimals: number,
  amountTarget: CurrencyAmountTarget,
  discountType: CurrencyDiscountType,
): boolean {
  return (amountTarget === 'discount' && discountType === 'percentage') || maxDecimals > 0;
}
