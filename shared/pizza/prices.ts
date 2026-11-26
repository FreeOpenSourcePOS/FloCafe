/** The prices of a menu as its owner counts them: one per size, however many pizzas carry it. */
import type { PizzaCatalog } from './types';

/** In the order a price list shows them. */
export const GROUPS = ['size', 'topping', 'dip', 'side', 'drink', 'deal'] as const;
export type PriceGroup = (typeof GROUPS)[number];

/** One price of a catalogue. `count` is how many pizzas, dips or drinks it is charged on. */
export interface MenuPrice {
  /** `size:<id>`, `topping`, `dip`, `side:<id>`, `drink:<variant id>` or `deal:<id>`. */
  key: string;
  group: PriceGroup;
  label: string;
  priceCents: number;
  count: number;
}

/** One row of `GET /api/pizza/prices`; amounts are in the store's currency, not cents. */
export interface PriceRow {
  key: string;
  group: PriceGroup;
  label: string;
  count: number;
  /** What the menu file last loaded says. */
  file: number;
  /** What is charged now. */
  price: number;
  overridden: boolean;
}

/** What the price routes answer. `unused` are prices set for something the menu no longer has. */
export interface PriceList {
  prices: PriceRow[];
  unused: { key: string; price: number }[];
}

/**
 * A copy of `catalog` in which every price is what `priceFor` answers for it. The side with id
 * `dip` and each dip on a pizza are one price, as they are in the menu file.
 */
function mapPrices(catalog: PizzaCatalog, priceFor: (price: MenuPrice) => number): PizzaCatalog {
  const priced = <T extends { priceCents: number }>(
    entry: T,
    key: string,
    group: PriceGroup,
    label: string,
    count = 1,
  ): T => ({
    ...entry,
    priceCents: priceFor({
      key,
      group,
      label,
      priceCents: entry.priceCents,
      count,
    }),
  });
  const sizes = catalog.sizes.map((size) =>
    priced(size, `size:${size.id}`, 'size', size.label, catalog.pizzas.length),
  );
  const toppings = catalog.toppings && priced(catalog.toppings, 'topping', 'topping', 'Topping');
  const sides = catalog.sides.map((side) =>
    side.id === 'dip'
      ? priced(side, 'dip', 'dip', side.name, catalog.dips.length)
      : priced(side, `side:${side.id}`, 'side', side.name),
  );
  const dip = sides.find((side) => side.id === 'dip');
  return {
    ...catalog,
    sizes,
    dips: catalog.dips.map((entry) => (dip ? { ...entry, priceCents: dip.priceCents } : entry)),
    sides,
    drinkVariants: catalog.drinkVariants.map((variant) =>
      priced(variant, `drink:${variant.id}`, 'drink', variant.label, catalog.drinks.length),
    ),
    deals: catalog.deals.map((deal) => priced(deal, `deal:${deal.id}`, 'deal', deal.name)),
    ...(toppings ? { toppings } : {}),
  };
}

/** Every price of a catalogue, group by group and in menu order within one. */
export function menuPrices(catalog: PizzaCatalog): MenuPrice[] {
  const prices: MenuPrice[] = [];
  mapPrices(catalog, (price) => {
    prices.push(price);
    return price.priceCents;
  });
  return prices.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
}

/** `catalog` with the prices `cents` has under their keys; a key it lacks keeps its price. */
export function withPrices(
  catalog: PizzaCatalog,
  cents: ReadonlyMap<string, number>,
): PizzaCatalog {
  return mapPrices(catalog, (price) => cents.get(price.key) ?? price.priceCents);
}
