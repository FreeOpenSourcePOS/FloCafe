import type { Category, Product } from '@/lib/types';
import {
  POS_CATEGORY_SORTS,
  POS_ITEM_SORTS,
  isPosCategorySort,
  isPosItemSort,
  type PosCategorySort,
  type PosItemSort,
} from '../../../shared/pos-sort';

export {
  POS_CATEGORY_SORTS,
  POS_ITEM_SORTS,
  isPosCategorySort,
  isPosItemSort,
  type PosCategorySort,
  type PosItemSort,
};

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
