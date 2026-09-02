export type CurrencyAmountTarget = 'payment' | 'wallet' | 'discount';
export type CurrencyDiscountType = 'percentage' | 'amount';

export function getDiscountInputStep(maxDecimals: number, discountType: CurrencyDiscountType): string {
  return discountType === 'percentage' || maxDecimals === 0 ? '1' : '0.01';
}

export function allowCurrencyDecimalKey(
  maxDecimals: number,
  amountTarget: CurrencyAmountTarget,
  discountType: CurrencyDiscountType,
): boolean {
  return (amountTarget === 'discount' && discountType === 'percentage') || maxDecimals > 0;
}
