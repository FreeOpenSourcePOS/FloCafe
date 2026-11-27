import { cartVariantUnitPrice } from '@/lib/cart-price';
import { activeVariants } from '@/lib/product-variants';
import type { Product, ProductVariant } from '@/lib/types';

type Priced = Pick<Product, 'price' | 'variants'>;

/**
 * The price most pizzas share at each size, by size name in menu order, as the cart charges it.
 * A size has none unless more than half the pizzas on sale at that size, and at least two, have it.
 * A pizza counts once per size, and votes only when all its variants of that name share one price.
 */
export function standardPrices(pizzas: Priced[], online: boolean): Map<string, number> {
  const counts = new Map<string, { total: number; votes: Map<number, number> }>();
  for (const product of pizzas) {
    const perPizza = new Map<string, Set<number>>();
    for (const variant of activeVariants(product.variants)) {
      const prices = perPizza.get(variant.name) ?? new Set<number>();
      prices.add(cartVariantUnitPrice({ product, variant }, online));
      perPizza.set(variant.name, prices);
    }
    for (const [size, pizzaPrices] of perPizza) {
      const count = counts.get(size) ?? { total: 0, votes: new Map<number, number>() };
      count.total += 1;
      if (pizzaPrices.size === 1) {
        const [price] = pizzaPrices;
        count.votes.set(price, (count.votes.get(price) ?? 0) + 1);
      }
      counts.set(size, count);
    }
  }
  const standard = new Map<string, number>();
  for (const [size, { total, votes }] of counts) {
    const [first] = [...votes].sort((a, b) => b[1] - a[1]);
    if (first && first[1] >= 2 && first[1] * 2 > total) standard.set(size, first[0]);
  }
  return standard;
}

/** The price a size button shows: null when it is the standard price for its size. */
export function tilePrice(
  product: Priced,
  variant: ProductVariant,
  standard: ReadonlyMap<string, number>,
  online: boolean,
): number | null {
  const price = cartVariantUnitPrice({ product, variant }, online);
  return standard.get(variant.name) === price ? null : price;
}

const LABELS = new Map([
  ['small', 'S'],
  ['medium', 'M'],
  ['large', 'L'],
  ['extra large', 'XL'],
]);

/**
 * The short label of each size button, by size name: S, M, L or XL, or the size's own name.
 * Sizes that would share a label keep their own names, so no two buttons read the same.
 */
export function sizeLabels(names: Iterable<string>): Map<string, string> {
  const unique = [...new Set(names)];
  const short = (name: string) => LABELS.get(name.trim().toLowerCase()) ?? name;
  const uses = new Map<string, number>();
  for (const name of unique) uses.set(short(name), (uses.get(short(name)) ?? 0) + 1);
  return new Map(unique.map((name) => [name, uses.get(short(name))! > 1 ? name : short(name)]));
}

/** One label per size for the whole menu, so a tile and the legend never name a size apart. */
export function catalogSizeLabels(products: Pick<Product, 'variants'>[]): Map<string, string> {
  return sizeLabels(
    products.flatMap((product) => activeVariants(product.variants).map((v) => v.name)),
  );
}
