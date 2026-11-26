/** The recipe on an order line: checked at the API, kept across edits, printed as detail lines. */
import type Database from 'better-sqlite3';
import { getDatabase } from '../db';
import { RecipeError, validateRecipe } from '../../shared/pizza/recipe';
import { RECIPE_NOT_PRINTED, ticketLines } from '../../shared/pizza/ticket';
import type { OrderLineRecipe, PizzaCatalog, PizzaRecipe } from '../../shared/pizza/types';

const WRONG_ITEM = 'The recipe is for a different item. Remove it and add it again';

type Line = { modifier_selection?: unknown } | null | undefined;

/** The pizza or deal recipe a line holds, parsed if it is still stored text; nothing else counts. */
function recipeOf(line: Line): OrderLineRecipe | undefined {
  let value = line?.modifier_selection;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === 'pizza' || kind === 'deal' ? (value as OrderLineRecipe) : undefined;
}

export function readCatalog(db: Database.Database): PizzaCatalog {
  try {
    const row = db.prepare('SELECT catalog FROM pizza_menu WHERE id = 1').get();
    const catalog = JSON.parse((row as { catalog: string }).catalog);
    for (const list of ['pizzas', 'sizes', 'deals', 'drinks']) {
      if (!Array.isArray(catalog[list])) throw new Error(list);
    }
    return catalog;
  } catch {
    throw Object.assign(new Error('The pizza menu is not loaded. Load the menu file again.'), {
      statusCode: 503,
    });
  }
}

function agreedRecipe(
  db: Database.Database,
  catalog: () => PizzaCatalog,
  productId: string,
  variantId: string | undefined,
  raw: unknown,
): unknown {
  const product = db
    .prepare('SELECT menu_id, kind FROM pizza_products WHERE product_id = ?')
    .get(productId) as { menu_id: string; kind: 'pizza' | 'half-and-half' | 'deal' } | undefined;
  if (!product) {
    if (recipeOf({ modifier_selection: raw }))
      throw new RecipeError(
        'This item does not take a pizza or deal recipe. Remove it and add it again',
      );
    return raw;
  }
  if (product.kind !== 'deal' && !variantId) throw new RecipeError('Pick a size for this pizza');
  const pickHalves = 'Pick the two halves';
  if (!raw) {
    if (product.kind === 'pizza') return raw;
    throw new RecipeError(product.kind === 'deal' ? 'Pick what goes in this deal' : pickHalves);
  }

  const recipe = validateRecipe(catalog(), raw);
  if (recipe.kind === 'deal') {
    if (product.kind !== 'deal' || recipe.dealId !== product.menu_id)
      throw new RecipeError(WRONG_ITEM);
    return recipe;
  }
  if (product.kind === 'deal') throw new RecipeError(WRONG_ITEM);
  if (product.kind === 'half-and-half') {
    if (!recipe.halves) throw new RecipeError(pickHalves);
  } else if (!recipe.whole) {
    throw new RecipeError('A half and half is its own item. Choose Half & Half instead');
  } else if (recipe.whole.pizzaId !== product.menu_id) {
    throw new RecipeError(WRONG_ITEM);
  }
  if (variantId !== `${productId}-${recipe.sizeId}`)
    throw new RecipeError('The size does not match this item. Pick the size again');
  return recipe;
}

const requestCatalogs = new WeakMap<object, PizzaCatalog>();

/**
 * Checks the recipe on an incoming order line against the menu and the line's own product and
 * variant, and leaves it normalised in `modifier_selection`. A refusal is a `RecipeError`
 * answered with 400; a menu that cannot be read answers 503. A product that is not a pizza or a
 * deal keeps what it sent. `lines` is the request's list: its lines share one read of the menu.
 */
export function checkLineRecipe(
  db: Database.Database,
  lines: object,
  line: { product_id: string; modifier_selection?: unknown },
  variantId: string | undefined,
): void {
  const catalog = () => {
    if (!requestCatalogs.has(lines)) requestCatalogs.set(lines, readCatalog(db));
    return requestCatalogs.get(lines) as PizzaCatalog;
  };
  try {
    line.modifier_selection = agreedRecipe(
      db,
      catalog,
      line.product_id,
      variantId,
      line.modifier_selection,
    );
  } catch (error) {
    throw error instanceof RecipeError ? Object.assign(error, { statusCode: 400 }) : error;
  }
}

/**
 * A replacement that leaves `modifier_selection` out keeps the recipe stored on the line it
 * replaces, while the product stays. A kept pizza recipe takes the size of the new variant.
 */
export function keepStoredRecipe(
  replacement: { product_id?: unknown; variant_id?: unknown; modifier_selection?: unknown },
  stored: { product_id: string; modifier_selection?: unknown },
): void {
  if (replacement.modifier_selection !== undefined) return;
  if (replacement.product_id !== stored.product_id) return;
  const recipe = recipeOf(stored);
  if (!recipe) return;
  if (recipe.kind === 'pizza' && typeof replacement.variant_id === 'string')
    recipe.sizeId = replacement.variant_id.trim().slice(stored.product_id.length + 1);
  replacement.modifier_selection = recipe;
}

/** What a restricted kitchen display station gets: the line's recipe as stored, or null. */
export function kdsRecipe(line: Line): unknown {
  return recipeOf(line) ? line?.modifier_selection : null;
}

/**
 * False for the malformed shapes `ticketLines` would print short without throwing: a pizza needs
 * one whole or two halves, each with a list of removals, and a deal's pops are an object.
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

/**
 * Order items with `detailLines` written from each line's recipe, for a printer laying out
 * `columns` characters. The recipe is not checked against the menu: an order sold before a menu
 * change still prints. A recipe whose shape cannot be written out, or a menu that cannot be read,
 * is logged and prints one warning line, so a ticket never drops a recipe silently. `field` names
 * where the lines go; a caller that runs on every refresh passes `logged` to log each item once.
 */
export function withRecipeDetailLines<T>(
  items: T,
  columns: number,
  field = 'detailLines',
  logged?: Set<unknown>,
): T {
  if (!Array.isArray(items) || !items.some(recipeOf)) return items;
  let catalog: PizzaCatalog | undefined;
  let menuError: unknown;
  try {
    catalog = readCatalog(getDatabase());
  } catch (error) {
    menuError = error;
  }
  return items.map((item) => {
    const recipe = recipeOf(item);
    if (!recipe) return item;
    let detailLines = [RECIPE_NOT_PRINTED];
    try {
      if (!catalog) throw menuError;
      if (!hasPrintableShape(recipe)) throw new Error('The recipe is not in a printable shape');
      detailLines = ticketLines(catalog, recipe, columns).detailLines;
    } catch (error) {
      if (!logged?.has(item.id))
        console.warn(`[Pizza] Recipe not printed for order item ${item.id}:`, error);
      if (logged && logged.size > 1000) logged.clear();
      logged?.add(item.id);
    }
    return { ...item, [field]: detailLines };
  }) as T;
}

const kdsLogged = new Set<unknown>();

/**
 * Kitchen display items, each pizza or deal line carrying `recipe_lines`: the lines its kitchen
 * ticket prints at 48 columns, the warning line included. Other items are handed back untouched.
 * A display refreshes all day, so a recipe that cannot be written out is logged once per item.
 */
export function withKdsRecipeLines<T>(items: T): T {
  return withRecipeDetailLines(items, 48, 'recipe_lines', kdsLogged);
}
