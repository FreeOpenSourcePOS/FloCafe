/** The lines under a pizza or deal, built from its recipe and the catalogue held in the browser. */
import { readDetailLines, stripControlBytes } from '@print/detail-lines';
import { RECIPE_NOT_PRINTED, ticketLines } from '../../../../shared/pizza/ticket';
import type { OrderLineRecipe, PizzaRecipe } from '../../../../shared/pizza/types';
import type { CartItem } from '@/lib/types';
import { getPizzaCatalog } from './catalog';

/**
 * Paper width the cart panel's lines are wrapped for: `ticketLines` keeps each
 * line three cells narrower, which fits the panel beside the quantity.
 */
export const CART_DETAIL_COLUMNS = 32;

/** The pizza or deal recipe `raw` holds, parsed if it is still stored text; nothing else counts. */
function recipeOf(raw: unknown): OrderLineRecipe | null {
  try {
    const recipe = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return recipe?.kind === 'pizza' || recipe?.kind === 'deal' ? recipe : null;
  } catch {
    return null;
  }
}

/**
 * False for the shapes `ticketLines` prints short without throwing: a pizza needs one whole or
 * two halves, each with a list of removals. The server's print path has the same check.
 */
function hasPrintableShape(recipe: OrderLineRecipe): boolean {
  const pizzaShape = (pizza: PizzaRecipe) => {
    const parts = pizza.whole ? [pizza.whole] : pizza.halves;
    return (
      !(pizza.whole && pizza.halves) &&
      Array.isArray(parts) &&
      parts.length === (pizza.whole ? 1 : 2) &&
      parts.every((part) => Array.isArray(part?.removed))
    );
  };
  if (recipe.kind === 'pizza') return pizzaShape(recipe);
  return recipe.pizzas.every(pizzaShape) && typeof (recipe.pops ?? {}) === 'object';
}

/** Null when no catalogue is loaded, when `raw` is not a recipe, or when it cannot be written out. */
function recipeLines(raw: unknown, columns: number): string[] | null {
  const catalog = getPizzaCatalog();
  const recipe = recipeOf(raw);
  if (!catalog || !recipe) return null;
  try {
    if (!hasPrintableShape(recipe)) return null;
    return ticketLines(catalog, recipe, columns).detailLines;
  } catch {
    return null;
  }
}

/**
 * The detail lines of an order item at this paper width. The ready-made
 * `detailLines` the item carries come first: they are what the server wrote
 * for the order, and the catalogue held now does not replace them. An item
 * with none gets its recipe written out from the catalogue held, and a recipe
 * that cannot be written out prints the one warning line the server prints,
 * never nothing.
 */
export function orderItemDetailLines(item: unknown, columns: number): string[] {
  const readyMade = readDetailLines(item);
  if (readyMade.length > 0) return readyMade;
  const raw = (item as { modifier_selection?: unknown } | null | undefined)?.modifier_selection;
  if (!recipeOf(raw)) return [];
  return recipeLines(raw, columns)?.map(stripControlBytes) ?? [RECIPE_NOT_PRINTED];
}

/**
 * The lines the cart panel shows under a pizza or deal line: the warning
 * words, as a sent line shows them, for a recipe that cannot be written out.
 */
export function cartLineDetailLines(line: Pick<CartItem, 'recipe'>): string[] {
  if (!recipeOf(line.recipe)) return [];
  return recipeLines(line.recipe, CART_DETAIL_COLUMNS) ?? [RECIPE_NOT_PRINTED];
}
