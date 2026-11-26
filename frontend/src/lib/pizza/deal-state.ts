/** State of the deal configurator: one pizza sheet per pizza, the deal's other choices, and the cart line they describe. */
import { dealPickCount, RecipeError, validateRecipe } from '../../../../shared/pizza/recipe';
import { ticketLines } from '../../../../shared/pizza/ticket';
import type {
  CatalogDeal,
  DealRecipe,
  OrderLineRecipe,
  PizzaCatalog,
  PizzaRecipe,
} from '../../../../shared/pizza/types';
import type { Product } from '@/lib/types';
import { cartLineUnitPrice } from '../cart-price';
import { PIZZA_PRODUCT_PREFIX } from './line-recipe';
import {
  newSheet,
  sheetDraft,
  sheetReducer,
  type SheetAction,
  type SheetSourceLine,
  type SheetState,
} from './sheet-state';

export interface DealState {
  dealId: string;
  /** The open tab, counted from 0 over the tabs of `dealLine`. */
  tab: number;
  /** One sheet per pizza of the deal, in pick order, each at the size the deal sets. */
  pizzas: SheetState[];
  /** Drink id to number of cans. */
  pops: Record<string, number>;
  /** True while a deal that offers cans or a bottle is on its bottle side. */
  bottle: boolean;
  /** Drink id of the two-litre bottle. */
  twoLitre: string | null;
  /** Option id of the wing flavour. */
  wingFlavour: string | null;
}

export type DealAction =
  | { type: 'tab'; tab: number }
  /** A control of the pizza sheet, on one pizza of the deal. */
  | { type: 'pizza'; index: number; action: SheetAction }
  /** Cans or the bottle; the side left is cleared, because the deal takes one or the other. */
  | { type: 'bottle'; bottle: boolean }
  | { type: 'pop'; drinkId: string; count: number }
  | { type: 'twoLitre'; drinkId: string }
  | { type: 'wings'; flavourId: string };

/** One choice the deal asks for. */
export interface DealTab {
  /** `pizza-1` and so on, then `drinks`, then `wings`. */
  id: string;
  kind: 'pizza' | 'drinks' | 'wings';
  done: boolean;
  /** The choice in one line; null until it is made. */
  summary: string | null;
  /** The choice as the ticket prints it; empty until it is made. */
  lines: string[];
  /** Why a pizza is not done, in the core's words. */
  message: string | null;
}

/** What the configurator would put in the cart, and what is still missing. */
export interface DealLine {
  heading: string;
  tabs: DealTab[];
  /** The ticket's closing `INCLUDES:` lines, which belong to the deal and to no tab. */
  includes: string[];
  /** The cans the deal asks for and how many are chosen; null for a deal without drinks. */
  cans: { asked: number; chosen: number } | null;
  /** Null until every choice is made and the core accepts the deal. */
  recipe: DealRecipe | null;
  /** Why there is no recipe, in the core's words. */
  message: string | null;
}

/** A deal with nothing chosen, or the deal of a cart line with every choice it stores. */
export function newDeal(deal: CatalogDeal, stored?: DealRecipe | null): DealState {
  const asked = dealPickCount(deal);
  return {
    dealId: deal.id,
    tab: 0,
    pizzas: asked.pizzas.map(({ sizeId }, index) => {
      const recipe = stored?.pizzas[index];
      // The sheet loads cart lines, so a stored pizza is handed to it as one.
      const line = {
        product: { id: PIZZA_PRODUCT_PREFIX },
        quantity: 1,
        addons: [],
        special_instructions: '',
        recipe,
      } as unknown as SheetSourceLine;
      return {
        ...(recipe ? sheetReducer(newSheet(), { type: 'load', line }) : newSheet()),
        sizeId,
      };
    }),
    pops: { ...stored?.pops },
    bottle: asked.choice && Boolean(stored?.twoLitre),
    twoLitre: stored?.twoLitre ?? null,
    wingFlavour: stored?.wingFlavour ?? null,
  };
}

export function dealReducer(state: DealState, action: DealAction): DealState {
  switch (action.type) {
    case 'tab':
      return { ...state, tab: action.tab };
    case 'pizza':
      return {
        ...state,
        pizzas: state.pizzas.map((sheet, index) =>
          index === action.index ? sheetReducer(sheet, action.action) : sheet,
        ),
      };
    case 'bottle':
      return action.bottle === state.bottle
        ? state
        : { ...state, bottle: action.bottle, pops: {}, twoLitre: null };
    case 'pop': {
      const pops = { ...state.pops, [action.drinkId]: action.count };
      if (!(action.count > 0)) delete pops[action.drinkId];
      return { ...state, pops };
    }
    case 'twoLitre':
      return { ...state, twoLitre: action.drinkId };
    case 'wings':
      return { ...state, wingFlavour: action.flavourId };
  }
}

/** The core's normalised copy of a draft it accepts, or its message. */
function checked<T extends OrderLineRecipe>(
  catalog: PizzaCatalog,
  draft: unknown,
): { recipe: T | null; message: string | null } {
  try {
    return { recipe: validateRecipe(catalog, draft) as T, message: null };
  } catch (error) {
    if (!(error instanceof RecipeError)) throw error;
    return { recipe: null, message: error.message };
  }
}

/** "Garden · NO OLIVES", or both names of a half and half. */
function pizzaSummary(catalog: PizzaCatalog, recipe: PizzaRecipe): string {
  const parts = recipe.halves ?? (recipe.whole ? [recipe.whole] : []);
  const names = parts.map(
    (part) => catalog.pizzas.find((pizza) => pizza.id === part.pizzaId)?.name ?? part.pizzaId,
  );
  const removed = recipe.whole?.removed ?? [];
  return [names.join(' / '), ...removed.map((name) => `NO ${name.toUpperCase()}`)].join(' · ');
}

/**
 * The line the configurator describes. A choice the menu does not have (a
 * drink, a flavour, a pizza) counts as not made, so nothing is missing exactly
 * when the core accepts the deal. `columns` is the paper width the lines are
 * wrapped for.
 */
export function dealLine(catalog: PizzaCatalog, state: DealState, columns = 42): DealLine {
  const deal = catalog.deals.find((entry) => entry.id === state.dealId);
  const asked = deal && dealPickCount(deal);
  const base = { kind: 'deal', v: 1, dealId: state.dealId } as const;
  const whole = (part: Partial<DealRecipe>) =>
    ticketLines(catalog, { ...base, pizzas: [], ...part }, columns);
  // With nothing chosen the ticket is only what comes with the deal; a tab's lines leave that out.
  const { heading, detailLines: includes } = whole({});
  const printed = (part: Partial<DealRecipe>) => ({
    detailLines: whole(part).detailLines.slice(0, -includes.length || undefined),
  });

  const drafts = state.pizzas.map(sheetDraft);
  const tabs: DealTab[] = drafts.map((draft, index) => {
    const { recipe, message } = checked<PizzaRecipe>(catalog, draft);
    // Only this pizza's place is filled, because the ticket numbers a pizza by its place.
    const alone: PizzaRecipe[] = [];
    if (recipe) alone[index] = recipe;
    return {
      id: `pizza-${index + 1}`,
      kind: 'pizza',
      done: recipe !== null,
      summary: recipe && pizzaSummary(catalog, recipe),
      lines: recipe ? printed({ pizzas: alone }).detailLines : [],
      message,
    };
  });

  const offered = (deal?.picks ?? [])
    .flatMap((pick) => (pick.type === 'choice' ? pick.options : []))
    .find((option) => option.type === 'pop');
  const cansAsked = asked?.pops || offered?.count || 0;
  const cans = catalog.drinks.flatMap((drink) =>
    state.pops[drink.id] > 0 ? [{ ...drink, count: state.pops[drink.id] }] : [],
  );
  const chosen = cans.reduce((sum, can) => sum + can.count, 0);
  const bottle = catalog.drinks.find((drink) => drink.id === state.twoLitre);
  const hasDrinks = Boolean(asked && (asked.pops > 0 || asked.choice));
  let drinks: Partial<DealRecipe> = {};
  if (hasDrinks) {
    if (state.bottle) drinks = bottle ? { twoLitre: bottle.id } : {};
    else if (chosen > 0) {
      // Keys in the core's order, so the line here is the ticket's.
      const sorted = [...cans].sort((a, b) => (a.id < b.id ? -1 : 1));
      drinks = { pops: Object.fromEntries(sorted.map((can) => [can.id, can.count])) };
    }
    const done = state.bottle ? Boolean(bottle) : chosen === cansAsked;
    tabs.push({
      id: 'drinks',
      kind: 'drinks',
      done,
      summary: !done
        ? null
        : bottle && state.bottle
          ? `2L ${bottle.label}`
          : cans.map((can) => `${can.count} ${can.label}`).join(', '),
      lines: done ? printed(drinks).detailLines : [],
      message: null,
    });
  }

  const flavours = catalog.sides.find((side) => side.id === 'wings')?.modifier?.options ?? [];
  const flavour = flavours.find((option) => option.id === state.wingFlavour);
  if (asked?.wingFlavour)
    tabs.push({
      id: 'wings',
      kind: 'wings',
      done: Boolean(flavour),
      summary: flavour?.label ?? null,
      lines: flavour ? printed({ wingFlavour: flavour.id }).detailLines : [],
      message: null,
    });

  return {
    heading,
    tabs,
    includes,
    cans: hasDrinks ? { asked: cansAsked, chosen } : null,
    ...checked<DealRecipe>(catalog, {
      ...base,
      pizzas: drafts,
      ...drinks,
      ...(asked?.wingFlavour && flavour ? { wingFlavour: flavour.id } : {}),
    }),
  };
}

/**
 * What the cart charges for one of a deal: the price of its POS product, or
 * the price a line keeps when one was set by hand. A configurator given no
 * product is quoted from the menu.
 */
export function dealQuote(
  deal: CatalogDeal,
  product: Pick<Product, 'price'> | undefined,
  override?: { price: number } | null,
): { price: number; kept: boolean } {
  return {
    price: product
      ? cartLineUnitPrice({ product, price_override: override }, false)
      : deal.priceCents / 100,
    kept: Boolean(product && override),
  };
}
