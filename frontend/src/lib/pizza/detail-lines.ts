/** The lines under a pizza or deal, built from its recipe and the catalogue held in the browser. */
import { readDetailLines, stripControlBytes } from '@print/detail-lines';
import { ticketLines } from '../../../../shared/pizza/ticket';
import type { OrderLineRecipe } from '../../../../shared/pizza/types';
import type { CartItem } from '@/lib/types';
import { getPizzaCatalog } from './catalog';

/**
 * Paper width the cart panel's lines are wrapped for: `ticketLines` keeps each
 * line three cells narrower, which fits the panel beside the quantity.
 */
export const CART_DETAIL_COLUMNS = 32;

/** Null when no catalogue is loaded, or when `raw` is not a recipe. */
function recipeLines(raw: unknown, columns: number): string[] | null {
  const catalog = getPizzaCatalog();
  if (!catalog) return null;
  try {
    const recipe = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (recipe?.kind !== 'pizza' && recipe?.kind !== 'deal') return null;
    return ticketLines(catalog, recipe as OrderLineRecipe, columns).detailLines;
  } catch {
    return null;
  }
}

/**
 * The detail lines of an order item at this paper width: from the recipe in
 * its `modifier_selection` when a catalogue is loaded, else the ready-made
 * `detailLines` the item carries.
 */
export function orderItemDetailLines(item: unknown, columns: number): string[] {
  const recipe = (item as { modifier_selection?: unknown } | null | undefined)?.modifier_selection;
  return recipeLines(recipe, columns)?.map(stripControlBytes) ?? readDetailLines(item);
}

/** The lines the cart panel shows under a pizza or deal line. */
export function cartLineDetailLines(line: Pick<CartItem, 'recipe'>): string[] {
  return recipeLines(line.recipe, CART_DETAIL_COLUMNS) ?? [];
}
