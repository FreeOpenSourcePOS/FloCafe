/** A sold pizza or deal line whose recipe or note changes keeps the money it was sold at. */
import type Database from 'better-sqlite3';
import type { TaxResult } from '../services/tax';
import { assertProductOnMenu } from '../routes/orders-validation';
import { checkLineRecipe } from './order-recipe';
import { recipeKey } from '../../shared/pizza/recipe';
import type { OrderLineRecipe } from '../../shared/pizza/types';

type Addon = { id?: unknown; quantity?: unknown } | null | undefined;

const addonKey = (addons: Addon[]): string =>
  addons
    .filter(Boolean)
    .map((addon) => `${addon?.id} x${Number(addon?.quantity) || 1}`)
    .sort()
    .join('\n');

/**
 * True when a replacement names the product, variant, quantity and add-ons the sold line already
 * has, on a product a menu load made, and sets no price of its own: only the recipe or the note
 * can differ.
 */
export function changesRecipeOnly(
  db: Database.Database,
  replacement: {
    product_id?: unknown;
    variant_id?: unknown;
    quantity?: unknown;
    addons?: Addon[] | null;
    price_override?: unknown;
  },
  sold: { product_id: unknown; variant_id?: unknown; quantity: unknown },
  soldAddons: { addon_id: unknown; quantity: unknown }[],
): boolean {
  return (
    replacement.product_id === sold.product_id &&
    String(replacement.variant_id ?? '').trim() === String(sold.variant_id ?? '') &&
    Number(replacement.quantity) === Number(sold.quantity) &&
    (replacement.price_override ?? null) === null &&
    addonKey(Array.isArray(replacement.addons) ? replacement.addons : []) ===
      addonKey(soldAddons.map((addon) => ({ id: addon.addon_id, quantity: addon.quantity }))) &&
    !!db.prepare('SELECT 1 FROM pizza_products WHERE product_id = ?').get(sold.product_id)
  );
}

const parsed = (text: unknown): unknown => {
  try {
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/**
 * Whether two `modifier_selection` values say the same thing. Two recipes are compared by
 * `recipeKey`, which needs no menu and ignores key order and the order removals and pops were
 * tapped in; the order of halves and of a deal's pizzas still counts.
 */
function sameSelection(sent: unknown, sold: unknown): boolean {
  const isRecipe = (value: unknown): value is OrderLineRecipe =>
    ['pizza', 'deal'].includes((value as { kind?: string } | null)?.kind as string);
  try {
    if (isRecipe(sent) && isRecipe(sold)) return recipeKey(sent) === recipeKey(sold);
  } catch {
    return false;
  }
  return JSON.stringify(sent) === JSON.stringify(sold);
}

/**
 * Turns a recipe-only replacement into the sold line with a new recipe or note: the size, unit
 * price and item discount are copied from the saved row, never worked out again. A recipe that
 * differs from the saved one, a cleared one included, is checked against the menu and needs a
 * product that is still sold; the saved one is not checked, so a pizza the menu has since lost
 * can still take a note.
 */
export function carrySoldLine(
  db: Database.Database,
  line: { product_id: string; modifier_selection?: unknown },
  soldRow: object,
): void {
  const sold = soldRow as Record<string, unknown>;
  const soldRecipe = parsed(sold.modifier_selection);
  if (sameSelection(line.modifier_selection ?? null, soldRecipe)) {
    line.modifier_selection = soldRecipe;
  } else {
    checkLineRecipe(db, [line], line, (sold.variant_id as string | null) ?? undefined, sold);
    // A plain pizza may drop its recipe without a look at the menu, so a retired one is stopped here.
    assertProductOnMenu(
      (db
        .prepare('SELECT name, is_active, deleted_at FROM products WHERE id = ?')
        .get(line.product_id) ?? {}) as Parameters<typeof assertProductOnMenu>[0],
    );
  }
  Object.assign(line, {
    variant_id: sold.variant_id,
    variant_selection: parsed(sold.variant_selection),
    unit_price: sold.unit_price,
    discount_amount: Number(sold.discount_amount) || 0,
  });
}

/** The tax a saved line was sold with, in the shape the tax engine answers. */
export function soldTax(soldRow: object): TaxResult {
  const sold = soldRow as Record<string, unknown>;
  return {
    tax_amount: Number(sold.tax_amount) || 0,
    tax_breakdown: (parsed(sold.tax_breakdown) as TaxResult['tax_breakdown'] | null) ?? [],
    tax_type: typeof sold.tax_type === 'string' ? sold.tax_type : 'none',
    tax_snapshot: parsed(sold.tax_snapshot) as TaxResult['tax_snapshot'],
  };
}
