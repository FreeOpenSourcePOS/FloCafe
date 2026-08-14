export type DiscountMode = 'percentage' | 'flat' | 'both';
export type DiscountType = 'percentage' | 'amount';

export const normalizeDiscountMode = (value: unknown): DiscountMode => {
  return value === 'flat' || value === 'both' || value === 'percentage'
    ? value
    : 'percentage';
};

export const isDiscountTypeAllowed = (mode: DiscountMode, type: DiscountType) => {
  if (mode === 'both') return true;
  return mode === 'percentage' ? type === 'percentage' : type === 'amount';
};

export const defaultDiscountTypeForMode = (mode: DiscountMode): DiscountType => {
  return mode === 'flat' ? 'amount' : 'percentage';
};
