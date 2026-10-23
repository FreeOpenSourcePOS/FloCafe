export const POS_CATEGORY_SORTS = ['saved', 'name'] as const;
export const POS_ITEM_SORTS = ['saved', 'name', 'price_asc', 'price_desc'] as const;

export type PosCategorySort = (typeof POS_CATEGORY_SORTS)[number];
export type PosItemSort = (typeof POS_ITEM_SORTS)[number];

export function isPosCategorySort(value: unknown): value is PosCategorySort {
  return POS_CATEGORY_SORTS.some((option) => option === value);
}

export function isPosItemSort(value: unknown): value is PosItemSort {
  return POS_ITEM_SORTS.some((option) => option === value);
}
