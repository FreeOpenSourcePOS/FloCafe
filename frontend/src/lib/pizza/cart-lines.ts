/** Cart changes the pizza screens make: "Customize 1" and saving an edited line. */
import { generateCartItemId } from '@/lib/cart-identity';
import type { Addon, CartItem } from '@/lib/types';
import { DIP_PREFIX } from './sheet-state';

/**
 * "Customize 1": takes one off a line of several so it can be changed alone.
 * Answers the new cart and the line to open in the sheet; a line of one is
 * that line, and the cart is left as it is. Null when the cart has no such line.
 */
export function customizeOne(
  items: CartItem[],
  lineId: string,
): { items: CartItem[]; line: CartItem } | null {
  const source = items.find((item) => item.id === lineId);
  if (!source) return null;
  if (source.quantity <= 1) return { items, line: source };

  // The two lines hold the same pizza until the sheet saves, so the new one
  // cannot take its id from what it holds.
  let id = `${lineId}:1`;
  for (let n = 2; items.some((item) => item.id === id); n += 1) id = `${lineId}:${n}`;
  const line = { ...source, id, quantity: 1 };
  return {
    items: items.flatMap((item) =>
      item === source ? [{ ...source, quantity: source.quantity - 1 }, line] : [item],
    ),
    line,
  };
}

/**
 * Saves an edited line where it stood, under the identity of what it now
 * holds. A line that has become the same as another joins that one.
 */
export function replaceCartLine(
  items: CartItem[],
  lineId: string,
  edited: Omit<CartItem, 'id'>,
): CartItem[] {
  if (!items.some((item) => item.id === lineId)) return items;
  const id = generateCartItemId(
    edited.product.id,
    edited.variant?.id ?? null,
    edited.addons,
    edited.special_instructions,
    edited.price_override,
    edited.recipe,
  );
  const joins = id !== lineId && items.some((item) => item.id === id);
  return items.flatMap((item) => {
    if (item.id === lineId) return joins ? [] : [{ ...edited, id }];
    return item.id === id ? [{ ...item, quantity: item.quantity + edited.quantity }] : [item];
  });
}

/**
 * The add-ons of a line the sheet saves. The sheet changes dips only, so an
 * add-on of any other group the line already had stays as it was.
 */
export function sheetAddons(had: Addon[], dips: Addon[]): Addon[] {
  return [...had.filter((addon) => !addon.id.startsWith(DIP_PREFIX)), ...dips];
}
