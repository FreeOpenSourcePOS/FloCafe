import {
  POS_CATEGORY_SORTS,
  POS_ITEM_SORTS,
  isPosCategorySort,
  isPosItemSort,
  type PosCategorySort,
  type PosItemSort,
} from '../../shared/pos-sort';

export {
  POS_CATEGORY_SORTS,
  POS_ITEM_SORTS,
  isPosCategorySort,
  isPosItemSort,
  type PosCategorySort,
  type PosItemSort,
};

/** Falls back to the saved order when a stored value is missing or unrecognised. */
export function readPosSortSettings(settings: Record<string, string | undefined>): {
  category_sort: PosCategorySort;
  item_sort: PosItemSort;
} {
  const category = settings.pos_category_sort;
  const item = settings.pos_item_sort;
  return {
    category_sort: isPosCategorySort(category) ? category : 'saved',
    item_sort: isPosItemSort(item) ? item : 'saved',
  };
}
