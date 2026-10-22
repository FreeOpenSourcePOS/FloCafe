import type { Category, Product } from '@/lib/types';

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

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** `saved` keeps the order the API returned (sort_order, then name). */
export function sortCategories(categories: Category[], sort: PosCategorySort): Category[] {
  if (sort !== 'name') return categories;
  return [...categories].sort((a, b) => nameCollator.compare(a.name, b.name));
}

export function sortProducts(products: Product[], sort: PosItemSort): Product[] {
  if (sort === 'saved') return products;
  const sorted = [...products];
  if (sort === 'name') return sorted.sort((a, b) => nameCollator.compare(a.name, b.name));
  const direction = sort === 'price_asc' ? 1 : -1;
  return sorted.sort(
    (a, b) =>
      direction * (Number(a.price) - Number(b.price)) || nameCollator.compare(a.name, b.name),
  );
}
