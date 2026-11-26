/** Checks the recipe on an order line against the menu and gives it one stable form. */
import type {
  CatalogDeal,
  DealRecipe,
  OrderLineRecipe,
  PizzaCatalog,
  PizzaPart,
  PizzaRecipe,
} from './types';
import { MAX_ADDED_TOPPINGS } from './toppings';

/** A recipe the menu does not allow; the message tells the cashier what to do. */
export class RecipeError extends Error {}

type Fields = Record<string, unknown>;

// ponytail: a fixed cap on the stored bytes. The menu parser keeps a deal small enough to fit
// (MAX_DEAL_PIZZAS in menu.ts, MAX_ADDED_TOPPINGS in toppings.ts); raise them together.
const MAX_RECIPE_BYTES = 28_000;
const UNREADABLE = 'This item could not be read. Remove it and add it again';

const some = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function fields(value: unknown): Fields {
  const prototype =
    typeof value === 'object' && value !== null ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== null) throw new RecipeError(UNREADABLE);
  return value as Fields;
}

function tooLarge(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length > MAX_RECIPE_BYTES;
  } catch {
    return true;
  }
}

const sorted = (names: string[] | undefined): string[] => [...new Set(names ?? [])].sort();

/** An empty list of extras or toppings is left out, so a recipe without any is what it always was. */
function copyPart(part: PizzaPart): PizzaPart {
  const copy: PizzaPart = { pizzaId: part.pizzaId, removed: sorted(part.removed) };
  const extra = sorted(part.extra);
  const added = sorted(part.added);
  if (extra.length > 0) copy.extra = extra;
  if (added.length > 0) copy.added = added;
  return copy;
}

function copyPizza(recipe: PizzaRecipe): PizzaRecipe {
  const copy: PizzaRecipe = { kind: 'pizza', v: 1, sizeId: recipe.sizeId };
  if (recipe.whole) copy.whole = copyPart(recipe.whole);
  if (recipe.halves) copy.halves = [copyPart(recipe.halves[0]), copyPart(recipe.halves[1])];
  if (recipe.cook) copy.cook = recipe.cook;
  if (recipe.cut) copy.cut = recipe.cut;
  return copy;
}

function copyDeal(recipe: DealRecipe): DealRecipe {
  const copy: DealRecipe = {
    kind: 'deal',
    v: 1,
    dealId: recipe.dealId,
    pizzas: recipe.pizzas.map(copyPizza),
  };
  const pops = Object.entries(recipe.pops ?? {})
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (pops.length > 0) copy.pops = Object.fromEntries(pops);
  if (recipe.twoLitre) copy.twoLitre = recipe.twoLitre;
  if (recipe.wingFlavour) copy.wingFlavour = recipe.wingFlavour;
  return copy;
}

function checkPart(catalog: PizzaCatalog, raw: unknown, label: string): void {
  const part = fields(raw);
  const pizza = catalog.pizzas.find((entry) => entry.id === part.pizzaId);
  if (!pizza) throw new RecipeError(`${label}That pizza is not on the menu. Pick another pizza`);
  const lists = [part.removed ?? [], part.extra ?? [], part.added ?? []];
  if (!lists.every(Array.isArray)) throw new RecipeError(UNREADABLE);
  const [removed, extra, added] = lists as unknown[][];
  const has = (name: unknown) => pizza.ingredients.includes(name as string);
  if (!removed.every(has))
    throw new RecipeError(
      `${label}${pizza.name} does not have that ingredient. Choose what to remove again`,
    );
  if (!extra.every(has))
    throw new RecipeError(
      `${label}${pizza.name} does not have that ingredient. Choose what to make extra again`,
    );
  // An extra is charged the topping price, which only a menu with toppings has.
  if (extra.length > 0 && !catalog.toppings)
    throw new RecipeError(
      `${label}This menu has no price for extra ${extra[0]}. Take the extra off`,
    );
  const both = extra.find((name) => removed.includes(name));
  if (both !== undefined)
    throw new RecipeError(`${label}${both} cannot be both removed and extra. Choose one`);
  for (const id of added) {
    const topping = catalog.toppings?.items.find((item) => item.id === id);
    if (!topping)
      throw new RecipeError(`${label}That topping is not on the menu. Pick another topping`);
    const name = topping.label.trim().toLowerCase();
    if (pizza.ingredients.some((ingredient) => ingredient.toLowerCase() === name))
      throw new RecipeError(
        `${label}${pizza.name} already has ${topping.label}. Choose extra ${topping.label} instead`,
      );
  }
  if (new Set(added).size > MAX_ADDED_TOPPINGS)
    throw new RecipeError(
      `${label}A pizza takes at most ${MAX_ADDED_TOPPINGS} added toppings. Take one off`,
    );
}

function checkedPizza(catalog: PizzaCatalog, raw: unknown): PizzaRecipe {
  const recipe = fields(raw);
  if (recipe.kind !== 'pizza' || recipe.v !== 1) throw new RecipeError(UNREADABLE);
  if (recipe.sizeId == null) throw new RecipeError('Pick a size');
  if (!catalog.sizes.some((size) => size.id === recipe.sizeId))
    throw new RecipeError('That size is not on the menu. Pick a size');

  const { whole, halves, cook, cut } = recipe;
  if (whole != null && halves != null)
    throw new RecipeError('Choose a whole pizza or a half and half, not both');
  if (whole != null) checkPart(catalog, whole, '');
  else if (halves == null) throw new RecipeError('Pick a pizza');
  else {
    if (!Array.isArray(halves) || halves.length > 2) throw new RecipeError(UNREADABLE);
    if (halves[0] == null) throw new RecipeError('Pick the first half');
    if (halves[1] == null) throw new RecipeError('Pick the second half');
    checkPart(catalog, halves[0], 'First half: ');
    checkPart(catalog, halves[1], 'Second half: ');
  }
  if (cook != null && cook !== 'well-done' && cook !== 'light-bake')
    throw new RecipeError('Choose well done or light bake');
  if (cut != null && cut !== 'square-cut' && cut !== 'uncut')
    throw new RecipeError('Choose square cut or uncut');

  const copy = copyPizza(recipe as unknown as PizzaRecipe);
  if (copy.halves && JSON.stringify(copy.halves[0]) === JSON.stringify(copy.halves[1]))
    throw new RecipeError('Both halves are the same. Choose a whole pizza instead');
  return copy;
}

function checkedDeal(catalog: PizzaCatalog, recipe: Fields): DealRecipe {
  if (recipe.v !== 1) throw new RecipeError(UNREADABLE);
  const deal = catalog.deals.find((entry) => entry.id === recipe.dealId);
  if (!deal) throw new RecipeError('That deal is not on the menu. Pick another deal');
  const asked = dealPickCount(deal);

  const rawPizzas = recipe.pizzas ?? [];
  if (!Array.isArray(rawPizzas) || rawPizzas.length !== asked.pizzas.length)
    throw new RecipeError(
      asked.pizzas.length === 0
        ? `${deal.name} has no pizzas to pick`
        : `Pick ${some(asked.pizzas.length, 'pizza')} for ${deal.name}`,
    );
  const pizzas = rawPizzas.map((raw, index) => {
    try {
      const pizza = checkedPizza(catalog, raw);
      const { sizeId } = asked.pizzas[index];
      if (pizza.sizeId !== sizeId) {
        const label = catalog.sizes.find((size) => size.id === sizeId)?.label ?? sizeId;
        throw new RecipeError(`Pick a ${label} pizza`);
      }
      return pizza;
    } catch (error) {
      if (error instanceof RecipeError)
        throw new RecipeError(`Pizza ${index + 1}: ${error.message}`);
      throw error;
    }
  });

  const isDrink = (id: unknown) => catalog.drinks.some((drink) => drink.id === id);
  const unknownDrink = 'That drink is not on the menu. Pick another drink';
  let cans = 0;
  for (const [drinkId, count] of Object.entries(fields(recipe.pops ?? {}))) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
      throw new RecipeError(UNREADABLE);
    if (!isDrink(drinkId)) throw new RecipeError(unknownDrink);
    cans += count;
  }
  const bottle = recipe.twoLitre ?? null;
  if (bottle !== null && !isDrink(bottle)) throw new RecipeError(unknownDrink);

  if (asked.choice) {
    const options = deal.picks.flatMap((pick) => (pick.type === 'choice' ? pick.options : []));
    const offered = options.find((option) => option.type === 'pop')?.count ?? 0;
    const offer = `Pick ${some(offered, 'pop')} or a 2L bottle`;
    if (bottle !== null && cans > 0) throw new RecipeError(`${offer}, not both`);
    if (bottle === null && cans !== offered) throw new RecipeError(offer);
  } else {
    if (bottle !== null) throw new RecipeError(`${deal.name} has no 2L bottle to pick`);
    if (cans !== asked.pops)
      throw new RecipeError(
        asked.pops === 0 ? `${deal.name} has no pops to pick` : `Pick ${some(asked.pops, 'pop')}`,
      );
  }

  const flavours = catalog.sides.find((side) => side.id === 'wings')?.modifier?.options ?? [];
  if (asked.wingFlavour && !flavours.some((flavour) => flavour.id === recipe.wingFlavour))
    throw new RecipeError('Pick a wing flavour');
  if (!asked.wingFlavour && recipe.wingFlavour != null)
    throw new RecipeError(`${deal.name} has no wing flavour to pick`);

  return copyDeal({ ...(recipe as unknown as DealRecipe), pizzas });
}

/** Returns a normalised copy of a valid recipe; throws a `RecipeError` otherwise. */
export function validateRecipe(catalog: PizzaCatalog, raw: unknown): OrderLineRecipe {
  const recipe = fields(raw);
  if (tooLarge(recipe)) throw new RecipeError(UNREADABLE);
  return recipe.kind === 'deal' ? checkedDeal(catalog, recipe) : checkedPizza(catalog, recipe);
}

/** The same recipe gives the same key, whatever order removals and pops were tapped in. */
export function recipeKey(recipe: OrderLineRecipe): string {
  return JSON.stringify(recipe.kind === 'deal' ? copyDeal(recipe) : copyPizza(recipe));
}

/**
 * What a deal asks the customer to choose. `pops` is the cans of a plain `pop`
 * pick; the can count of a `choice` is in `deal.picks`, on its `pop` option.
 */
export function dealPickCount(deal: CatalogDeal): {
  pizzas: { sizeId: string }[];
  pops: number;
  wingFlavour: boolean;
  choice: boolean;
} {
  return {
    pizzas: deal.picks.flatMap((pick) =>
      pick.type === 'pizza'
        ? Array.from({ length: pick.count }, () => ({ sizeId: pick.size }))
        : [],
    ),
    pops: deal.picks.reduce((sum, pick) => sum + (pick.type === 'pop' ? pick.count : 0), 0),
    wingFlavour: deal.picks.some((pick) => pick.type === 'wing-flavour'),
    choice: deal.picks.some((pick) => pick.type === 'choice'),
  };
}
