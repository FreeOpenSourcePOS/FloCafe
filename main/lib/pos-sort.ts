export const POS_CATEGORY_SORTS = ['saved', 'name'] as const;
export const POS_ITEM_SORTS = ['saved', 'name', 'price_asc', 'price_desc'] as const;

export function isPosCategorySort(value: unknown): value is (typeof POS_CATEGORY_SORTS)[number] {
  return POS_CATEGORY_SORTS.some((option) => option === value);
}

export function isPosItemSort(value: unknown): value is (typeof POS_ITEM_SORTS)[number] {
  return POS_ITEM_SORTS.some((option) => option === value);
}

/** Falls back to the saved order when a stored value is missing or unrecognised. */
export function readPosSortSettings(settings: Record<string, string | undefined>) {
  const category = settings.pos_category_sort;
  const item = settings.pos_item_sort;
  return {
    category_sort: isPosCategorySort(category) ? category : 'saved',
    item_sort: isPosItemSort(item) ? item : 'saved',
  };
}
