/** State of the pizza sheet: a reducer for its controls and the cart line it describes. */
import { RecipeError, validateRecipe } from '../../../../shared/pizza/recipe';
import { ticketLines } from '../../../../shared/pizza/ticket';
import type {
  CookNote,
  CutNote,
  PizzaCatalog,
  PizzaRecipe,
  TicketLines,
} from '../../../../shared/pizza/types';
import type { CartItem, Product } from '@/lib/types';
import { cartLineUnitPrice } from '../cart-price';
import { lineRecipe, PIZZA_PRODUCT_PREFIX as PRODUCT_PREFIX } from './line-recipe';

/** One side of the sheet: the pizza picked there and the ingredients taken off it. */
export interface SheetHalf {
  pizzaId: string | null;
  removed: string[];
}

export interface SheetState {
  sizeId: string | null;
  /** True for a half and half. */
  split: boolean;
  /** A whole pizza is the first entry; the second waits for a half and half. */
  halves: [SheetHalf, SheetHalf];
  cook: CookNote | null;
  cut: CutNote | null;
  /** Dip id to how many. */
  dips: Record<string, number>;
  note: string;
  quantity: number;
}

/** The cart-line fields the sheet reads when a line is opened for editing. */
export type SheetSourceLine = Pick<
  CartItem,
  'product' | 'variant' | 'quantity' | 'addons' | 'special_instructions' | 'recipe'
>;

export type SheetAction =
  | { type: 'size'; sizeId: string }
  | { type: 'split'; split: boolean }
  | { type: 'pizza'; half: 0 | 1; pizzaId: string }
  /** Takes an ingredient off that half, or puts it back. */
  | { type: 'ingredient'; half: 0 | 1; name: string }
  | { type: 'cook'; cook: CookNote | null }
  | { type: 'cut'; cut: CutNote | null }
  | { type: 'dip'; dipId: string; count: number }
  | { type: 'note'; note: string }
  | { type: 'quantity'; quantity: number }
  | { type: 'load'; line: SheetSourceLine };

/** What the sheet would put in the cart, and whether it may. */
export interface SheetLine {
  /** Null for a plain pizza, which is just its product, size and dips. */
  recipe: PizzaRecipe | null;
  productId: string | null;
  variantId: string | null;
  dips: { addonId: string; name: string; priceCents: number; quantity: number }[];
  /** The size price plus the dips, for one pizza; null until a size is picked. */
  unitPriceCents: number | null;
  printsAs: TicketLines | null;
  canAdd: boolean;
  /** Why Add is off. */
  message: string | null;
}

/** Add-on ids of the dips start with this. */
export const DIP_PREFIX = 'ad-dips-';

const wholeCount = (value: number, least: number) => Math.max(least, Math.floor(value) || 0);

/** An empty sheet, or one opened from a tile: on its pizza, on a size, or as a half and half. */
export function newSheet(
  start: { pizzaId?: string; sizeId?: string; split?: boolean } = {},
): SheetState {
  return {
    sizeId: start.sizeId ?? null,
    split: start.split ?? false,
    halves: [
      { pizzaId: start.pizzaId ?? null, removed: [] },
      { pizzaId: null, removed: [] },
    ],
    cook: null,
    cut: null,
    dips: {},
    note: '',
    quantity: 1,
  };
}

/** The sheet for a pizza line already in the cart; null for a line that is not one pizza. */
function sheetOf(line: SheetSourceLine): SheetState | null {
  const { recipe, product, variant } = line;
  if (!product.id.startsWith(PRODUCT_PREFIX) || recipe?.kind === 'deal') return null;
  const parts = recipe?.halves ?? [
    recipe?.whole ?? { pizzaId: product.id.slice(PRODUCT_PREFIX.length), removed: [] },
  ];
  const sheet = newSheet({
    sizeId: recipe?.sizeId ?? variant?.id.slice(product.id.length + 1),
    split: Boolean(recipe?.halves),
  });
  parts.forEach((part, index) => {
    sheet.halves[index] = { pizzaId: part.pizzaId, removed: [...part.removed] };
  });
  for (const addon of line.addons) {
    if (addon.id.startsWith(DIP_PREFIX))
      sheet.dips[addon.id.slice(DIP_PREFIX.length)] = addon.quantity || 1;
  }
  return {
    ...sheet,
    cook: recipe?.cook ?? null,
    cut: recipe?.cut ?? null,
    note: line.special_instructions,
    quantity: line.quantity,
  };
}

function withHalf(state: SheetState, index: 0 | 1, half: SheetHalf): SheetState {
  const halves: [SheetHalf, SheetHalf] = [state.halves[0], state.halves[1]];
  halves[index] = half;
  return { ...state, halves };
}

export function sheetReducer(state: SheetState, action: SheetAction): SheetState {
  switch (action.type) {
    case 'size':
      return { ...state, sizeId: action.sizeId };
    case 'split':
      return { ...state, split: action.split };
    case 'pizza': {
      const half = state.halves[action.half];
      return withHalf(state, action.half, {
        pizzaId: action.pizzaId,
        removed: half.pizzaId === action.pizzaId ? half.removed : [],
      });
    }
    case 'ingredient': {
      const half = state.halves[action.half];
      const removed = half.removed.includes(action.name)
        ? half.removed.filter((name) => name !== action.name)
        : [...half.removed, action.name];
      return withHalf(state, action.half, { ...half, removed });
    }
    case 'cook':
      return { ...state, cook: action.cook };
    case 'cut':
      return { ...state, cut: action.cut };
    case 'dip': {
      const dips = { ...state.dips, [action.dipId]: wholeCount(action.count, 0) };
      if (dips[action.dipId] === 0) delete dips[action.dipId];
      return { ...state, dips };
    }
    case 'note':
      return { ...state, note: action.note };
    case 'quantity':
      return { ...state, quantity: wholeCount(action.quantity, 1) };
    case 'load':
      return sheetOf(action.line) ?? state;
  }
}

/** The pizza the sheet holds as it stands, finished or not: what `validateRecipe` is asked about. */
export function sheetDraft(state: SheetState): unknown {
  const [first, second] = state.halves.map((half) =>
    half.pizzaId === null ? null : { pizzaId: half.pizzaId, removed: half.removed },
  );
  return {
    kind: 'pizza',
    v: 1,
    sizeId: state.sizeId,
    ...(state.split ? { halves: [first, second] } : first ? { whole: first } : {}),
    ...(state.cook ? { cook: state.cook } : {}),
    ...(state.cut ? { cut: state.cut } : {}),
  };
}

/**
 * The line the sheet describes. `columns` is the paper width the "prints as"
 * text is wrapped for. Add is off until the core accepts the recipe; its
 * message says what is missing.
 */
export function sheetLine(catalog: PizzaCatalog, state: SheetState, columns = 42): SheetLine {
  const draft = sheetDraft(state);
  let pizza: PizzaRecipe | null = null;
  let message: string | null = null;
  try {
    pizza = validateRecipe(catalog, draft) as PizzaRecipe;
  } catch (error) {
    if (!(error instanceof RecipeError)) throw error;
    message = error.message;
  }

  const dips = catalog.dips.flatMap((dip) =>
    state.dips[dip.id] > 0
      ? [
          {
            addonId: DIP_PREFIX + dip.id,
            name: dip.label,
            priceCents: dip.priceCents,
            quantity: state.dips[dip.id],
          },
        ]
      : [],
  );
  const size = catalog.sizes.find((entry) => entry.id === state.sizeId);
  const productId = pizza && PRODUCT_PREFIX + (pizza.whole?.pizzaId ?? 'half-and-half');

  return {
    recipe: lineRecipe(pizza),
    productId,
    variantId: pizza && `${productId}-${pizza.sizeId}`,
    dips,
    unitPriceCents: size
      ? size.priceCents + dips.reduce((sum, dip) => sum + dip.priceCents * dip.quantity, 0)
      : null,
    printsAs: pizza && ticketLines(catalog, pizza, columns),
    canAdd: pizza !== null,
    message,
  };
}

/** What a line of an order already placed was sold at: one pizza without add-ons, and each dip by its menu id. */
export interface SoldPrices {
  price: number;
  dips: Record<string, number>;
}

/** What the sheet shows as money, in the currency's own units. */
export interface SheetQuote {
  /** What one pizza costs in each size, by the size's menu id. */
  sizes: Record<string, number>;
  /** What one of each dip costs, by the dip's menu id. */
  dips: Record<string, number>;
  /** One pizza at the size chosen, without its dips; null until a size is chosen. */
  pizza: number | null;
  /** One of the line: the pizza and its dips. */
  unit: number | null;
  /** True when the line keeps a price set by hand, whatever size is chosen. */
  kept: boolean;
}

/**
 * What the cart charges for the pizza the sheet holds, by the cart's own rule:
 * the size variant of the POS product, at its online price when `online`, the
 * product's dips, and a line's price override in place of the size price.
 * Until a pizza is chosen the half-and-half product stands in, because every
 * pizza costs its size price. Anything the product list does not sell, and a
 * sheet given no list, is quoted from the menu. `sold` is given for a line of
 * an order already placed while saving keeps its prices: the pizza and the
 * dips it has are then quoted at what they were sold for.
 */
export function sheetQuote(
  catalog: PizzaCatalog,
  state: SheetState,
  products: Product[] | undefined,
  online: boolean,
  override?: { price: number } | null,
  sold?: SoldPrices | null,
): SheetQuote {
  const pizzaId = state.split ? null : state.halves[0].pizzaId;
  const product =
    products?.find((entry) => entry.id === PRODUCT_PREFIX + pizzaId) ??
    products?.find((entry) => entry.id === `${PRODUCT_PREFIX}half-and-half`);
  const onSale = (product?.addon_groups ?? []).flatMap((group) => group.addons ?? []);
  const sizes = Object.fromEntries(
    catalog.sizes.map((size) => {
      const variant = product?.variants?.find((entry) => entry.id === `${product.id}-${size.id}`);
      return [
        size.id,
        product && variant
          ? cartLineUnitPrice({ product, variant }, online)
          : size.priceCents / 100,
      ];
    }),
  );
  const dips = Object.fromEntries(
    catalog.dips.map((dip) => {
      const addon = onSale.find((entry) => entry.id === DIP_PREFIX + dip.id);
      return [dip.id, sold?.dips[dip.id] ?? (addon ? Number(addon.price) : dip.priceCents / 100)];
    }),
  );
  const pizza =
    state.sizeId === null ? null : (sold?.price ?? override?.price ?? sizes[state.sizeId] ?? null);
  const dipTotal = Object.entries(state.dips).reduce(
    (sum, [dipId, count]) => sum + (dips[dipId] ?? 0) * count,
    0,
  );
  return {
    sizes,
    dips,
    pizza,
    unit: pizza === null ? null : pizza + dipTotal,
    kept: Boolean(override),
  };
}
