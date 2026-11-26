/**
 * Quick buttons as the POS uses them: the four requests, and the mapping
 * between a saved button and the cart line it stands for.
 */
import api from '@/lib/api';
import { cartLineUnitPrice } from '@/lib/cart-price';
import { isVariantSoldOut } from '@/lib/product-variants';
import type { CartItem, Product, ProductVariant } from '@/lib/types';
import type { QuickButton, QuickButtonInput } from '../../../../shared/pizza/types';
import { cartLineDetailLines } from './detail-lines';
import { lineRecipe, PIZZA_PRODUCT_PREFIX } from './line-recipe';

/** What a button holds of a cart line: everything but its quantity and its price. */
export type ButtonLine = Pick<
  CartItem,
  'product' | 'variant' | 'addons' | 'special_instructions' | 'recipe'
>;

type ButtonContents = Required<
  Pick<QuickButtonInput, 'product_id' | 'variant_id' | 'recipe' | 'addons' | 'note'>
>;

const ROUTE = '/pizza/quick-buttons';
const SHEET_LINE_PREFIX = 'quick-button:';

/** The shop-wide buttons in their order, then the buttons of the customer on the order. */
export async function fetchQuickButtons(customerId?: string | number | null) {
  const params = customerId == null ? {} : { customer_id: String(customerId) };
  return (await api.get<{ buttons: QuickButton[] }>(ROUTE, { params })).data.buttons;
}

export async function saveQuickButton(input: QuickButtonInput) {
  return (await api.post<{ button: QuickButton }>(ROUTE, input)).data.button;
}

/** Changes the fields `changes` names; a button never moves to another customer. */
export async function updateQuickButton(
  id: string,
  changes: Partial<Omit<QuickButtonInput, 'customer_id'>>,
) {
  return (await api.put<{ button: QuickButton }>(`${ROUTE}/${id}`, changes)).data.button;
}

export async function deleteQuickButton(id: string): Promise<void> {
  await api.delete(`${ROUTE}/${id}`);
}

/** The server's words for a refused request, or `fallback` when it gave none. */
export function refusalMessage(error: unknown, fallback: string): string {
  const said = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof said === 'string' && said ? said : fallback;
}

/** What the route stores of a cart line. */
export function buttonContents(line: ButtonLine): ButtonContents {
  return {
    product_id: String(line.product.id),
    variant_id: line.variant?.id ?? null,
    recipe: lineRecipe(line.recipe),
    addons: line.addons.map((addon) => ({ id: addon.id, quantity: addon.quantity || 1 })),
    note: line.special_instructions,
  };
}

const variantOf = (button: QuickButton, products: Product[]) =>
  products
    .find((entry) => String(entry.id) === button.product_id)
    ?.variants?.find((entry) => entry.id === button.variant_id) ?? null;

/** True when the size the button holds is sold out, as the size buttons of a pizza tile decide it. */
export function buttonSoldOut(button: QuickButton, products: Product[]): boolean {
  const variant = variantOf(button, products);
  return variant !== null && isVariantSoldOut(variant);
}

/**
 * The cart line a tap on the button adds, built from the POS's own products so
 * that it is the line the button was saved from. Null when the button cannot
 * be added: the menu changed under it, the POS does not sell what it holds, or
 * its size is sold out.
 */
export function buttonLine(button: QuickButton, products: Product[]): ButtonLine | null {
  if (!button.usable || buttonSoldOut(button, products)) return null;
  const product = products.find((entry) => String(entry.id) === button.product_id);
  if (!product) return null;
  const variant = variantOf(button, products);
  if (button.variant_id && !variant) return null;
  const onSale = (product.addon_groups ?? []).flatMap((group) => group.addons ?? []);
  const addons = button.addons.flatMap(({ id, quantity }) => {
    const addon = onSale.find((entry) => entry.id === id);
    return addon ? [{ ...addon, quantity }] : [];
  });
  if (addons.length !== button.addons.length) return null;
  return {
    product,
    variant,
    addons,
    special_instructions: button.note ?? '',
    ...(button.recipe ? { recipe: button.recipe } : {}),
  };
}

/**
 * What one tap costs now; the server stores no price. `online` is true while
 * the order is for an online platform, which has its own price for a size.
 */
export function buttonPrice(line: ButtonLine, online = false): number {
  return (
    cartLineUnitPrice(line, online) +
    line.addons.reduce((sum, addon) => sum + Number(addon.price) * (addon.quantity || 1), 0)
  );
}

/** The name of what a button holds, as the cart shows it. */
export function buttonName(line: ButtonLine): string {
  return line.variant ? `${line.product.name} (${line.variant.name})` : line.product.name;
}

/** What a button holds, on one line: its name, then the kitchen lines, add-ons and note. */
export function buttonSummary(line: ButtonLine): string {
  return [
    buttonName(line),
    ...cartLineDetailLines(line).map((text) => text.trim()),
    ...line.addons.map(
      (addon) => `+ ${addon.name}${(addon.quantity || 1) > 1 ? ` ×${addon.quantity}` : ''}`,
    ),
    ...(line.special_instructions ? [line.special_instructions] : []),
  ].join(' · ');
}

/** True for a button the pizza sheet can open: a pizza or a half and half, not a deal. */
export function isPizzaButton(button: QuickButton): boolean {
  return button.product_id.startsWith(PIZZA_PRODUCT_PREFIX) && button.recipe?.kind !== 'deal';
}

/**
 * A button as the line the pizza sheet opens on. The sheet reads only ids from
 * a line, so this needs no product and works for a button the menu changed under.
 */
export function buttonSheetLine(button: QuickButton): CartItem {
  return {
    id: SHEET_LINE_PREFIX + button.id,
    product: { id: button.product_id } as Product,
    variant: button.variant_id ? ({ id: button.variant_id } as ProductVariant) : null,
    quantity: 1,
    addons: button.addons as CartItem['addons'],
    special_instructions: button.note ?? '',
    recipe: button.recipe,
  };
}

/** The button a sheet line came from, or null for a line of the cart. */
export function sheetButtonId(lineId: string | null | undefined): string | null {
  return lineId?.startsWith(SHEET_LINE_PREFIX) ? lineId.slice(SHEET_LINE_PREFIX.length) : null;
}
