/** Extras and added toppings as money in the browser: the two add-ons a line carries for its recipe. */
import {
  HALF_TOPPING_ADDON,
  isToppingAddon,
  TOPPING_ADDON,
  toppingCounts,
} from '../../../../shared/pizza/toppings';
import type { OrderLineRecipe } from '../../../../shared/pizza/types';

/** The add-on group a menu load makes for the two topping add-ons. */
const TOPPINGS_GROUP = 'ag-toppings';

type Counts = ReturnType<typeof toppingCounts>;
/** What one topping and one half topping cost; null for one the POS does not sell. */
export interface ToppingPrices {
  whole: number | null;
  half: number | null;
}
type OnSale = { addon_groups?: { addons?: { id: string; price: number }[] }[] | null };

export { isToppingAddon };

/** The topping add-ons one of a line carries for its recipe: none for a recipe without toppings. */
export function toppingCharges(
  recipe: OrderLineRecipe | null | undefined,
): { id: string; quantity: number }[] {
  const counts = toppingCounts(recipe);
  return [
    { id: TOPPING_ADDON, quantity: counts.whole },
    { id: HALF_TOPPING_ADDON, quantity: counts.half },
  ].filter((charge) => charge.quantity > 0);
}

/**
 * A line's add-ons with the topping add-ons its recipe derives in place of any it had, each as
 * the POS sells it. Null when the POS does not sell one the recipe needs: the line is then not
 * saved, because the server refuses a topping that is not charged.
 */
export function chargedAddons<T extends { id: string }>(
  had: T[],
  recipe: OrderLineRecipe | null | undefined,
  onSale: T[],
): (T & { quantity?: number })[] | null {
  const charges = toppingCharges(recipe).map(({ id, quantity }) => {
    const addon = onSale.find((entry) => entry.id === id);
    return addon && { ...addon, quantity };
  });
  if (charges.some((charge) => !charge)) return null;
  return [...had.filter((addon) => !isToppingAddon(addon.id)), ...(charges as T[])];
}

/**
 * The price of each topping add-on of a POS product, which is what the cart and the server
 * charge. `sold` is what a line of an order already placed was sold at, while it keeps its prices.
 */
export function toppingPrices(
  product: OnSale | undefined,
  sold?: Partial<ToppingPrices> | null,
): ToppingPrices {
  const onSale = (product?.addon_groups ?? []).flatMap((group) => group.addons ?? []);
  const price = (id: string) => {
    const addon = onSale.find((entry) => entry.id === id);
    return addon ? Number(addon.price) : null;
  };
  return {
    whole: sold?.whole ?? price(TOPPING_ADDON),
    half: sold?.half ?? price(HALF_TOPPING_ADDON),
  };
}

/** What the toppings of one of a line add to it; null while a price it needs is not known. */
export function toppingTotal(counts: Counts, prices: ToppingPrices): number | null {
  if ((counts.whole > 0 && prices.whole === null) || (counts.half > 0 && prices.half === null))
    return null;
  return counts.whole * (prices.whole ?? 0) + counts.half * (prices.half ?? 0);
}

/**
 * The add-on groups upstream's add-on window offers. The toppings group is left out: its
 * add-ons are counted from the recipe by the pizza sheet, never picked by hand.
 */
export function handPickedGroups<T extends { id: string | number }>(groups: T[]): T[] {
  return groups.filter((group) => group.id !== TOPPINGS_GROUP);
}

/**
 * The add-ons of a replacement built in upstream's edit window, which cannot show a topping
 * add-on: when it replaces a sent line by its own product, the server keeps that line's recipe,
 * so the topping add-ons the line was sold with are kept beside what the window chose.
 */
export function keptToppingAddons<T extends { id?: unknown }>(
  sold: { product_id: unknown; addons?: readonly { id?: unknown }[] | null },
  productId: unknown,
  chosen: T[],
): T[] {
  if (productId !== sold.product_id) return chosen;
  const kept = (sold.addons ?? []).filter(
    (addon) => isToppingAddon(addon.id) && !chosen.some((entry) => entry.id === addon.id),
  );
  // An add-on of an order item has the name, price and quantity the window's own have.
  return [...chosen, ...(kept as T[])];
}
