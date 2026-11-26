/** Saved quick buttons: one cart line kept under a label, for the whole shop or for one customer. */
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { now } from '../db';
import { resolveItemAddons } from '../routes/orders';
import { validateItemNotes } from '../routes/orders-validation';
import { resolveOrderItemVariant } from '../services/product-variants';
import { checkLineRecipe, readCatalog } from './order-recipe';
import { RecipeError } from '../../shared/pizza/recipe';
import type { OrderLineRecipe, QuickButton } from '../../shared/pizza/types';

/** The colour names the POS gives categories: the keys of `CATEGORY_COLORS` in its product grid. */
export const QUICK_BUTTON_COLORS = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
];

/** The most buttons one customer and the shop keep; every listed button is checked on each read. */
const MAX_CUSTOMER_BUTTONS = 24;
const MAX_SHOP_BUTTONS = 48;

const COLUMNS = [
  'id',
  'label',
  'color',
  'customer_id',
  'product_id',
  'variant_id',
  'recipe',
  'addons',
  'note',
  'sort_order',
  'created_at',
  'updated_at',
] as const;
/** What a button holds. A request that names one of these has all four checked together. */
const CONTENTS = ['product_id', 'variant_id', 'recipe', 'addons'] as const;

/** A stored button; `recipe` and `addons` are JSON text. */
export type QuickButtonRow = Record<'id' | 'label' | 'color' | 'product_id', string> &
  Record<'customer_id' | 'variant_id' | 'recipe' | 'addons' | 'note', string | null> &
  Record<'created_at' | 'updated_at', string> & { sort_order: number };

type Fields = Record<string, unknown>;

const refusal = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * Checks what a button holds the way an order line is checked, and returns it normalised.
 * `lines` is shared by the buttons of one request, so they share one read of the menu.
 */
function checkedContents(db: Database.Database, lines: object, button: Fields) {
  const product = db
    .prepare('SELECT id, name, is_active, deleted_at FROM products WHERE id = ?')
    .get(String(button.product_id)) as
    | { id: string; name: string; is_active: number; deleted_at: string | null }
    | undefined;
  if (!product || !product.is_active || product.deleted_at)
    throw refusal(`${product?.name ?? 'That item'} is not on the menu. Pick another item`);
  const variant = resolveOrderItemVariant(db, product, button, false);

  const line = { product_id: product.id, modifier_selection: button.recipe };
  checkLineRecipe(db, lines, line, variant?.id);
  const recipe = (line.modifier_selection || null) as OrderLineRecipe | null;
  // An item that is not a pizza or a deal keeps what it was sent; a button keeps only a recipe.
  if (recipe && recipe.kind !== 'pizza' && recipe.kind !== 'deal')
    throw refusal('This item could not be read. Remove it and add it again');

  let addons: { id: string; quantity: number }[];
  try {
    // Stock is left out: a dip that has run out today is not a change to the menu.
    addons = resolveItemAddons(db, product.id, button.addons as unknown[], 1, {
      deferStockDeduction: true,
    });
  } catch (error) {
    // A refusal is a plain Error. A database fault is a subclass and stays a server error.
    if ((error as Error)?.constructor !== Error) throw error;
    // An add-on whose row is gone is named by its id, which means nothing to a cashier.
    if (/^Add-on ".*" was not found$/.test((error as Error).message))
      throw refusal('A dip or extra on this button is no longer on the menu. Edit the button');
    throw Object.assign(error as Error, { statusCode: 400 });
  }
  return {
    product_id: product.id,
    variant_id: variant?.id ?? null,
    recipe,
    addons: addons.map(({ id, quantity }) => ({ id, quantity })),
  };
}

/** A tap sends the note as the line's own, so it is held to the limit the order route sets. */
function checkNote(db: Database.Database, note: string | null): void {
  try {
    validateItemNotes(db, note);
  } catch (error) {
    throw (error as { diagnosticCode?: string }).diagnosticCode
      ? refusal((error as Error).message)
      : error;
  }
}

/** What a stored recipe names that the menu no longer has, in words for a stale button. */
function leftTheMenu(db: Database.Database, recipe: OrderLineRecipe): string | undefined {
  const { pizzas } = readCatalog(db);
  const parts = (recipe.kind === 'deal' ? recipe.pizzas : [recipe]).flatMap((pizza) =>
    pizza.whole ? [pizza.whole] : (pizza.halves ?? []),
  );
  for (const part of parts) {
    const pizza = pizzas.find((entry) => entry.id === part.pizzaId);
    if (!pizza) {
      const product = db
        .prepare('SELECT name FROM products WHERE id = ?')
        .get(`pz-${part.pizzaId}`) as { name: string } | undefined;
      return `${product?.name ?? part.pizzaId} is not on the menu. Pick another pizza`;
    }
    const gone = part.removed.find((name) => !pizza.ingredients.includes(name));
    if (gone) return `${pizza.name} no longer has ${gone}. Choose what to remove again`;
  }
  return undefined;
}

function contentsOf(row: QuickButtonRow) {
  return {
    product_id: row.product_id,
    variant_id: row.variant_id,
    recipe: JSON.parse(row.recipe ?? 'null') as OrderLineRecipe | null,
    addons: JSON.parse(row.addons ?? '[]') as { id: string; quantity: number }[],
  };
}

/** The stored button with a fresh answer to "can this be added right now". Nothing is rewritten. */
function present(db: Database.Database, lines: object, row: QuickButtonRow): QuickButton {
  const contents = contentsOf(row);
  let reason: string | null = null;
  try {
    checkedContents(db, lines, contents);
    checkNote(db, row.note);
  } catch (error) {
    if (!(error as { statusCode?: number }).statusCode) throw error;
    reason =
      (error instanceof RecipeError && contents.recipe && leftTheMenu(db, contents.recipe)) ||
      (error as Error).message;
  }
  return { ...row, ...contents, usable: reason === null, reason };
}

/** The shop-wide buttons in their order, then the buttons of `customerId` if that customer exists. */
export function listQuickButtons(db: Database.Database, customerId?: string): QuickButton[] {
  const lines = {};
  // ponytail: each button is checked with a handful of lookups. Fine for a screen of buttons;
  // read the products and add-ons once per request if a shop ever keeps hundreds.
  return (
    db
      .prepare(
        `SELECT * FROM pizza_quick_buttons
         WHERE customer_id IS NULL
            OR customer_id = (SELECT id FROM customers WHERE id = ? AND is_active = 1)
         ORDER BY customer_id IS NOT NULL, sort_order, rowid`,
      )
      .all(customerId ?? null) as QuickButtonRow[]
  ).map((row) => present(db, lines, row));
}

export function findQuickButton(db: Database.Database, id: string): QuickButtonRow | undefined {
  return db.prepare('SELECT * FROM pizza_quick_buttons WHERE id = ?').get(id) as
    | QuickButtonRow
    | undefined;
}

export function deleteQuickButton(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM pizza_quick_buttons WHERE id = ?').run(id);
}

function text(raw: unknown, most: number, tooLong: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if ([...value].length > most) throw refusal(tooLong);
  return value;
}

/**
 * Saves a new button from `body`, or with `stored` changes that button: only the fields `body`
 * names change, and a button never moves to another customer. Throws a refusal answered with 400.
 */
export function saveQuickButton(
  db: Database.Database,
  body: Fields,
  stored?: QuickButtonRow,
): QuickButton {
  const named = (field: string) => !stored || body[field] !== undefined;
  const row = { ...stored } as QuickButtonRow;
  if (named('label')) {
    row.label = text(body.label, 24, 'A button name can have at most 24 characters');
    if (!row.label) throw refusal('Give this button a name');
  }
  if (named('color')) {
    if (!QUICK_BUTTON_COLORS.includes(body.color as string))
      throw refusal('Pick a colour for this button');
    row.color = body.color as string;
  }
  if (named('note')) {
    row.note = text(body.note, 140, 'A note can have at most 140 characters') || null;
    checkNote(db, row.note);
  }
  if (CONTENTS.some(named)) {
    const contents = checkedContents(db, {}, { ...(stored && contentsOf(stored)), ...body });
    Object.assign(row, contents, {
      recipe: contents.recipe && JSON.stringify(contents.recipe),
      addons: contents.addons.length > 0 ? JSON.stringify(contents.addons) : null,
    });
  }
  if (!stored) {
    row.customer_id = null;
    if (body.customer_id) {
      const customer = db
        .prepare('SELECT id FROM customers WHERE id = ? AND is_active = 1')
        .get(String(body.customer_id)) as { id: string } | undefined;
      if (!customer) throw refusal('That customer was not found. Search for the customer again');
      row.customer_id = customer.id;
    }
    const { kept } = db
      .prepare('SELECT COUNT(*) AS kept FROM pizza_quick_buttons WHERE customer_id IS ?')
      .get(row.customer_id) as { kept: number };
    const most = row.customer_id ? MAX_CUSTOMER_BUTTONS : MAX_SHOP_BUTTONS;
    if (kept >= most)
      throw refusal(
        `${row.customer_id ? 'This customer' : 'The shop'} already has ${most} buttons. Delete one, then save this one`,
      );
    row.id = randomUUID();
    row.created_at = now();
    row.sort_order = (
      db
        .prepare(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM pizza_quick_buttons WHERE customer_id IS ?',
        )
        .get(row.customer_id) as { next: number }
    ).next;
  }
  if (body.sort_order !== undefined) {
    if (!Number.isSafeInteger(body.sort_order))
      throw refusal('The place of a button in the row is a whole number');
    row.sort_order = body.sort_order as number;
  }
  row.updated_at = now();

  db.prepare(
    stored
      ? `UPDATE pizza_quick_buttons SET ${COLUMNS.map((column) => `${column} = @${column}`).join(', ')} WHERE id = @id`
      : `INSERT INTO pizza_quick_buttons (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((column) => `@${column}`).join(', ')})`,
  ).run(row);
  return present(db, {}, findQuickButton(db, row.id) as QuickButtonRow);
}
