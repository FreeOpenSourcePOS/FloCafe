export type CurrencyAmountTarget = 'payment' | 'wallet' | 'discount';
export type CurrencyDiscountType = 'percentage' | 'amount';

export function getDiscountInputStep(maxDecimals: number, discountType: CurrencyDiscountType): string {
  return discountType === 'percentage' || maxDecimals === 0 ? '1' : '0.01';
}

export function normalizeFixedDiscountValue(value: number, maxDecimals: number): number {
  return roundCurrencyValue(value, maxDecimals === 0 ? 0 : 2);
}

export function roundCurrencyValue(value: number, maxDecimals: number): number {
  const decimals = Math.max(0, maxDecimals);
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(value));
  const adjustedValue = value < 0 ? value - epsilon : value + epsilon;
  return Number(adjustedValue.toFixed(decimals));
}

export function allowCurrencyDecimalKey(
  maxDecimals: number,
  amountTarget: CurrencyAmountTarget,
  discountType: CurrencyDiscountType,
): boolean {
  return (amountTarget === 'discount' && discountType === 'percentage') || maxDecimals > 0;
}
