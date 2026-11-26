/** The recipe a cart line is identified and sent by. */
import type { OrderLineRecipe } from '../../../../shared/pizza/types';

/** Product ids of pizzas and of the half-and-half product start with this. */
export const PIZZA_PRODUCT_PREFIX = 'pz-';

/**
 * Null for no recipe and for a plain pizza: a whole pizza with nothing removed,
 * made extra or added and no cook or cut note is just its product and size, so
 * a line that says so in a recipe and a line with no recipe are the same line.
 */
export function lineRecipe<T extends OrderLineRecipe>(recipe: T | null | undefined): T | null {
  if (!recipe) return null;
  const plain =
    recipe.kind === 'pizza' &&
    recipe.whole?.removed?.length === 0 &&
    !recipe.whole.extra?.length &&
    !recipe.whole.added?.length &&
    !recipe.halves &&
    !recipe.cook &&
    !recipe.cut;
  return plain ? null : recipe;
}

/**
 * What an order line sends as `modifier_selection`. A pizza with no recipe
 * sends null, because the server keeps the stored recipe of an edited line
 * that sends none, and only null clears it. Any other product without a
 * recipe sends no field.
 */
export function sentRecipe(
  productId: string,
  recipe: OrderLineRecipe | null | undefined,
): { modifier_selection?: OrderLineRecipe | null } {
  const sent = lineRecipe(recipe);
  if (sent) return { modifier_selection: sent };
  return productId.startsWith(PIZZA_PRODUCT_PREFIX) ? { modifier_selection: null } : {};
}

/**
 * A pizza's recipe at the size of the variant its line now has, read from the
 * derived variant id `<product id>-<size>`. Anything else comes back as it is.
 */
export function recipeForVariant<T extends OrderLineRecipe | null | undefined>(
  recipe: T,
  productId: string,
  variantId: string | null | undefined,
): T {
  if (recipe?.kind !== 'pizza' || !variantId?.startsWith(`${productId}-`)) return recipe;
  const sizeId = variantId.slice(productId.length + 1);
  return sizeId === recipe.sizeId ? recipe : { ...recipe, sizeId };
}
