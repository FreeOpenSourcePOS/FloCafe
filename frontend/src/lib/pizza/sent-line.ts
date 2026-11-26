/**
 * A pizza or deal line of an order already placed: the lines shown under it,
 * the line the sheet or the deal configurator opens on, and the edit a changed
 * line sends to the order's item edit route.
 */
import { recipeKey } from '../../../../shared/pizza/recipe';
import { RECIPE_NOT_PRINTED, ticketLines } from '../../../../shared/pizza/ticket';
import type { OrderLineRecipe, PizzaCatalog } from '../../../../shared/pizza/types';
import type { OrderItemEditAttemptBody } from '../order-item-edit-attempt';
import {
  HALF_TOPPING_ADDON,
  TOPPING_ADDON,
  toppingCounts,
} from '../../../../shared/pizza/toppings';
import { lineRecipe, PIZZA_PRODUCT_PREFIX, sentRecipe } from './line-recipe';
import { chargedAddons, toppingCharges } from './toppings';
import {
  DIP_PREFIX,
  type SheetLine,
  type SheetSourceLine,
  type SheetState,
  type SoldPrices,
} from './sheet-state';

/** Product ids of deals start with this. */
export const DEAL_PRODUCT_PREFIX = 'dl-';
const HALF_AND_HALF = `${PIZZA_PRODUCT_PREFIX}half-and-half`;

/** The fields of an order item, as the order routes answer it, that a sent line is read from. */
export interface SentItem {
  product_id: string;
  variant_id?: string | null;
  quantity: number;
  addons?:
    | { id?: number | string | null; name: string; price?: number; quantity?: number }[]
    | null;
  special_instructions?: string | null;
  edit_version?: number;
  unit_price?: number | string | null;
  modifier_selection?: unknown;
  price_overridden?: number | boolean;
  discount_amount?: number | null;
}

export interface SentAddon {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

/** What a sent line holds, and what the sheet or the configurator hands back. */
export interface SentLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  addons: SentAddon[];
  note: string;
  recipe: OrderLineRecipe | null;
}

export type SentLineEdit = OrderItemEditAttemptBody & {
  replacement?: { modifier_selection?: OrderLineRecipe | null };
};

/**
 * True for a product only the pizza screens can add: the server refuses a half
 * and half and a deal that come without a recipe. The menu load derives these
 * ids, so a shop with no pizza menu has no such product.
 */
export function needsPizzaScreen(productId: string): boolean {
  return productId === HALF_AND_HALF || productId.startsWith(DEAL_PRODUCT_PREFIX);
}

/** The recipe an order item stores, as text or parsed; null when it stores none. */
function storedRecipe(item: SentItem): OrderLineRecipe | null {
  try {
    const raw = item.modifier_selection;
    const recipe = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return recipe?.kind === 'pizza' || recipe?.kind === 'deal' ? recipe : null;
  } catch {
    return null;
  }
}

/**
 * The lines under a sent line, wrapped as `ticketLines` wraps them for
 * `columns`. A line with no recipe has none. A recipe that cannot be written
 * out, because no menu is held or the menu no longer fits it, gives the one
 * line the kitchen ticket prints in that case.
 */
export function sentDetailLines(
  catalog: PizzaCatalog | null,
  item: SentItem,
  columns: number,
): string[] {
  const recipe = storedRecipe(item);
  if (!recipe) return [];
  try {
    if (catalog) return ticketLines(catalog, recipe, columns).detailLines;
  } catch {
    // Falls through to the warning line.
  }
  return [RECIPE_NOT_PRINTED];
}

export function sentLine(item: SentItem): SentLine {
  return {
    productId: item.product_id,
    variantId: item.variant_id ?? null,
    quantity: Number(item.quantity),
    addons: (item.addons ?? []).map((addon) => ({
      id: String(addon.id ?? ''),
      name: addon.name,
      price: Number(addon.price ?? 0),
      quantity: Number(addon.quantity ?? 1),
    })),
    note: (item.special_instructions ?? '').trim(),
    recipe: lineRecipe(storedRecipe(item)),
  };
}

/**
 * False for a line the edit route would refuse whatever was changed: one of
 * its add-ons no longer has an id, so a replacement could not name it.
 */
export function sentLineChangeable(item: SentItem): boolean {
  return (item.addons ?? []).every((addon) => addon.id !== null && addon.id !== undefined);
}

/**
 * True for a line with a price override or a discount of its own. The server
 * prices a replacement from the catalogue, so saving a change drops either.
 */
export function sentLineRepriced(item: SentItem): boolean {
  return Boolean(item.price_overridden) || Number(item.discount_amount ?? 0) > 0;
}

/** What the line was sold at: one of it without add-ons, each of its dips by the dip's menu id, and its toppings. */
export function soldPrices(item: SentItem): SoldPrices {
  const { addons } = sentLine(item);
  const sold = (id: string) => addons.find((addon) => addon.id === id)?.price ?? null;
  return {
    price: Number(item.unit_price ?? 0),
    dips: Object.fromEntries(
      addons
        .filter((addon) => addon.id.startsWith(DIP_PREFIX))
        .map((addon) => [addon.id.slice(DIP_PREFIX.length), addon.price]),
    ),
    toppings: { whole: sold(TOPPING_ADDON), half: sold(HALF_TOPPING_ADDON) },
  };
}

/**
 * True when saving `now` over the sent line `was` prices it again from the
 * catalogue as it is today: its product, its size, its quantity or its add-ons
 * changed. A change of recipe or note alone keeps the unit price, the add-on
 * prices, the discount and the override the line was sold with.
 */
export function sentLineReprices(was: SentLine, now: SentLine): boolean {
  const priced = (line: SentLine) =>
    JSON.stringify([
      line.productId,
      line.variantId,
      line.quantity,
      line.addons.map((addon) => `${addon.id}x${addon.quantity}`).sort(),
    ]);
  return priced(was) !== priced(now);
}

/**
 * What the sheet on a sent line does until the product prices are held. A
 * change that prices the line again cannot be quoted without them, so it is
 * `blocked`; a change of recipe or note keeps the sold price and is saved.
 * `notice` is true when the sheet says that prices could not be loaded: after
 * a failed request, and beside a blocked change.
 */
export function sentPriceGate(now: { reprices: boolean; held: boolean; failed: boolean }): {
  blocked: boolean;
  notice: boolean;
} {
  if (now.held) return { blocked: false, notice: false };
  return { blocked: now.reprices, notice: now.reprices || now.failed };
}

/** The line the sheet's `load` action reads; it looks at ids, counts, the note and the recipe only. */
export function sheetSource(line: SentLine): SheetSourceLine {
  return {
    product: { id: line.productId },
    variant: line.variantId ? { id: line.variantId } : null,
    quantity: line.quantity,
    addons: line.addons,
    special_instructions: line.note,
    recipe: line.recipe,
  } as unknown as SheetSourceLine;
}

/**
 * A sent line's add-ons with the topping add-ons `recipe` derives. One the
 * line was sold with keeps its name and price; a new one is named by its id
 * at no price, because the server names and prices the add-ons of an edit. While the counts are
 * unchanged the sold rows are kept as they are, so two rows of one stay two rows.
 */
function withToppings(addons: SentAddon[], recipe: OrderLineRecipe | null): SentAddon[] {
  const held = (id: string) =>
    addons.reduce((sum, addon) => sum + (addon.id === id ? addon.quantity : 0), 0);
  const counts = toppingCounts(recipe);
  if (held(TOPPING_ADDON) === counts.whole && held(HALF_TOPPING_ADDON) === counts.half)
    return addons;
  const sellable = [
    ...addons,
    ...toppingCharges(recipe).map(({ id }) => ({ id, name: id, price: 0, quantity: 0 })),
  ];
  return chargedAddons(addons, recipe, sellable) as SentAddon[];
}

/**
 * The line the sheet saves over `was`. The sheet changes dips and toppings
 * only, so an add-on of any other group stays as it was.
 */
export function sheetSentLine(was: SentLine, line: SheetLine, state: SheetState): SentLine {
  return {
    productId: line.productId ?? was.productId,
    variantId: line.variantId,
    quantity: state.quantity,
    addons: withToppings(
      [
        ...was.addons.filter((addon) => !addon.id.startsWith(DIP_PREFIX)),
        ...line.dips.map((dip) => ({
          id: dip.addonId,
          name: dip.name,
          price: dip.priceCents / 100,
          quantity: dip.quantity,
        })),
      ],
      line.recipe,
    ),
    note: state.note.trim(),
    recipe: line.recipe,
  };
}

/** The line the deal configurator saves over `was`: its choices, and the toppings of its pizzas. */
export function dealSentLine(was: SentLine, recipe: OrderLineRecipe): SentLine {
  return { ...was, addons: withToppings(was.addons, recipe), recipe };
}

/** Everything about a line but its quantity, the same for the same line whatever order it was built in. */
const contents = (line: SentLine): string =>
  JSON.stringify([
    line.productId,
    line.variantId,
    line.note,
    line.addons.map((addon) => `${addon.id}x${addon.quantity}`).sort(),
    line.recipe ? recipeKey(line.recipe) : null,
  ]);

/**
 * The body of the edit that turns the sent `item` into `now`; null when
 * nothing changed. A change of quantity alone sends the quantity, so the
 * stored recipe is not sent again. Any other change sends a replacement with
 * its recipe; a pizza with none sends null, which clears the stored one.
 */
export function sentLineEdit(item: SentItem, now: SentLine): SentLineEdit | null {
  const was = sentLine(item);
  const version = item.edit_version;
  const expected_edit_version =
    typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : 0;
  if (contents(was) === contents(now)) {
    return was.quantity === now.quantity ? null : { expected_edit_version, quantity: now.quantity };
  }
  return {
    expected_edit_version,
    replacement: {
      product_id: now.productId,
      quantity: now.quantity,
      ...(now.variantId ? { variant_id: now.variantId } : {}),
      addons: now.addons,
      ...(now.note ? { special_instructions: now.note } : {}),
      ...sentRecipe(now.productId, now.recipe),
    },
  };
}
