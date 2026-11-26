/** Writes a parsed menu onto FloCafe's own catalogue, keyed by ids derived from the menu's ids. */
import type Database from 'better-sqlite3';
import { getCurrencyMinorUnitFactor } from '../countries';
import { now } from '../db';
import { slugForName } from '../routes/categories';
import { getTenantCurrency } from '../services/refund';
import { lineSubtotal } from '../services/tax';
import { MenuError } from '../../shared/pizza/menu';
import { HALF_TOPPING_ADDON, TOPPING_ADDON } from '../../shared/pizza/toppings';
import type { CatalogPriced, PizzaCatalog } from '../../shared/pizza/types';

type Value = string | number | null;
/** One row the menu owns: where it lives, and the columns the menu decides. */
interface Row {
  table: string;
  key: Record<string, Value>;
  values: Record<string, Value>;
}

export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  /** True when the store has no `food` or `soda` tax category, so the load assigned none. */
  untaxed: boolean;
}

/** A load refused for a reason that is not in the menu file; the message is for the owner. */
export class MenuImportError extends Error {}

/** The catalogue tables a menu owns rows in; the stored `owned_rows` names rows in these only. */
const SWITCHABLE = ['categories', 'products', 'product_variants', 'addon_groups', 'addons'];
/** What the owner is told a row of each is. */
const NOUN: Record<string, string> = {
  categories: 'A category',
  products: 'A product',
  product_variants: 'A product variant',
  addon_groups: 'An add-on group',
  addons: 'An add-on',
};
/** Rows whose id is set by a section of the menu, not by an id in the file. */
const RESERVED: Record<string, string> = {
  'categories:cat-pizzas': 'the Pizzas section',
  'categories:cat-sides': 'the Sides section',
  'categories:cat-drinks': 'the Drinks section',
  'categories:cat-deals': 'the Deals section',
  'products:pz-half-and-half': 'the half and half pizza',
  'addon_groups:ag-dips': 'the dips',
  'addon_groups:ag-toppings': 'the toppings',
  [`addons:${TOPPING_ADDON}`]: 'the toppings',
  [`addons:${HALF_TOPPING_ADDON}`]: 'the toppings',
};
const LINKS = ['category_addon_groups', 'addon_group_product'];
/** The column a derived id is tied to: a variant to its product, an add-on to its group. */
const PARENT: Record<string, string> = {
  product_variants: 'product_id',
  addons: 'addon_group_id',
};

const rowId = (row: Row): string => `${row.table} ${Object.values(row.key).join('|')}`;

/** Every row a menu maps to, parents before the rows that point at them. */
function menuRows(
  catalog: PizzaCatalog,
  money: (cents: number) => number,
  tax: { food: string | null; drinks: string | null },
): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  const add = (table: string, key: Row['key'], values: Row['values'] = {}) => {
    const row = { table, key, values };
    if (seen.has(rowId(row)))
      throw new MenuError(
        'menu',
        `two entries map to ${table} id "${Object.values(key).join('|')}"`,
      );
    seen.add(rowId(row));
    rows.push(row);
  };

  const category = (id: string, name: string, color: string, sort_order: number) =>
    add(
      'categories',
      { id },
      { name, slug: slugForName(name), color, sort_order, is_active: 1, deleted_at: null },
    );
  const product = (
    id: string,
    category_id: string,
    sort_order: number,
    entry: { name: string; description?: string; priceCents: number },
    tax_category_id = tax.food,
  ) =>
    add(
      'products',
      { id },
      {
        category_id,
        name: entry.name,
        description: entry.description || null,
        price: money(entry.priceCents),
        // With no category to give, the column is left alone: the owner's own choice stays.
        ...(tax_category_id === null ? {} : { tax_category_id }),
        sort_order,
        is_active: 1,
        deleted_at: null,
      },
    );
  /** A product sold in several sizes; its own price is the lowest, for the POS tile. */
  const sized = (
    id: string,
    category_id: string,
    sort_order: number,
    name: string,
    description: string,
    variants: CatalogPriced[],
    tax_category_id = tax.food,
  ) => {
    const priceCents = Math.min(...variants.map((variant) => variant.priceCents));
    product(id, category_id, sort_order, { name, description, priceCents }, tax_category_id);
    variants.forEach((variant, index) =>
      add(
        'product_variants',
        { id: `${id}-${variant.id}` },
        {
          product_id: id,
          name: variant.label,
          price: money(variant.priceCents),
          sort_order: index,
          is_active: 1,
        },
      ),
    );
  };
  /** A required group is one choice at no charge; an optional one takes any number of each. */
  const addonGroup = (stem: string, name: string, required: boolean, options: CatalogPriced[]) => {
    add(
      'addon_groups',
      { id: `ag-${stem}` },
      {
        name,
        is_required: required ? 1 : 0,
        min_selection: required ? 1 : 0,
        max_selection: required ? 1 : null,
        allow_multiple_quantities: required ? 0 : 1,
        is_active: 1,
      },
    );
    options.forEach((option, index) =>
      add(
        'addons',
        { id: `ad-${stem}-${option.id}` },
        {
          addon_group_id: `ag-${stem}`,
          name: option.label,
          price: money(option.priceCents),
          sort_order: index,
          is_active: 1,
        },
      ),
    );
  };

  category('cat-pizzas', 'Pizzas', 'red', 0);
  catalog.pizzas.forEach((pizza, index) => {
    sized(`pz-${pizza.id}`, 'cat-pizzas', index, pizza.name, pizza.description, catalog.sizes);
    add(
      'pizza_products',
      { product_id: `pz-${pizza.id}` },
      {
        menu_id: pizza.id,
        kind: 'pizza',
        ingredients: JSON.stringify(pizza.ingredients),
        picks: null,
      },
    );
  });
  sized('pz-half-and-half', 'cat-pizzas', catalog.pizzas.length, 'Half & Half', '', catalog.sizes);
  add(
    'pizza_products',
    { product_id: 'pz-half-and-half' },
    { menu_id: 'half-and-half', kind: 'half-and-half', ingredients: null, picks: null },
  );
  if (catalog.dips.length > 0) {
    addonGroup('dips', 'Dips', false, catalog.dips);
    add('category_addon_groups', { category_id: 'cat-pizzas', addon_group_id: 'ag-dips' });
  }

  if (catalog.sides.length > 0) category('cat-sides', 'Sides', 'green', 1);
  catalog.sides.forEach((side, index) => {
    product(`sd-${side.id}`, 'cat-sides', index, side);
    if (!side.modifier) return;
    const stem = `${side.id}-${side.modifier.id}`;
    const choices = side.modifier.options.map((option) => ({ ...option, priceCents: 0 }));
    addonGroup(stem, side.modifier.label, true, choices);
    add('addon_group_product', { product_id: `sd-${side.id}`, addon_group_id: `ag-${stem}` });
  });

  if (catalog.drinks.length > 0) category('cat-drinks', 'Drinks', 'blue', 2);
  catalog.drinks.forEach((drink, index) =>
    sized(
      `dr-${drink.id}`,
      'cat-drinks',
      index,
      drink.label,
      '',
      catalog.drinkVariants,
      tax.drinks,
    ),
  );

  if (catalog.deals.length > 0) category('cat-deals', 'Deals', 'amber', 3);
  catalog.deals.forEach((deal, index) => {
    product(`dl-${deal.id}`, 'cat-deals', index, deal);
    add(
      'pizza_products',
      { product_id: `dl-${deal.id}` },
      { menu_id: deal.id, kind: 'deal', ingredients: null, picks: JSON.stringify(deal.picks) },
    );
  });

  // An extra or an added topping is charged as one of two add-ons, whatever the topping is: the
  // order route counts them from the line's recipe (`checkLineRecipe`), never the cashier.
  if (catalog.toppings) {
    const price = money(catalog.toppings.priceCents);
    add(
      'addon_groups',
      { id: 'ag-toppings' },
      {
        name: 'Toppings',
        is_required: 0,
        min_selection: 0,
        max_selection: null,
        allow_multiple_quantities: 1,
        is_active: 1,
      },
    );
    const topping = (id: string, name: string, amount: number, sort_order: number) =>
      add(
        'addons',
        { id },
        { addon_group_id: 'ag-toppings', name, price: amount, sort_order, is_active: 1 },
      );
    topping(TOPPING_ADDON, 'Topping', price, 0);
    // Half the price in decimal arithmetic, half a cent rounded up: two halves of 2.25 are 2.26.
    topping(HALF_TOPPING_ADDON, 'Half topping', lineSubtotal(price, 0.5, null, 0, 2), 1);
    add('category_addon_groups', { category_id: 'cat-pizzas', addon_group_id: 'ag-toppings' });
    if (catalog.deals.length > 0)
      add('category_addon_groups', { category_id: 'cat-deals', addon_group_id: 'ag-toppings' });
  }

  return rows;
}

/** The `"<table>:<id>"` entries of every row a load made, or none before the first load. */
function lastOwnedRows(db: Database.Database): string[] {
  const stored = db.prepare('SELECT owned_rows FROM pizza_menu WHERE id = 1').get() as
    | { owned_rows: string }
    | undefined;
  if (!stored) return [];
  try {
    const owned: unknown = JSON.parse(stored.owned_rows);
    const readable =
      Array.isArray(owned) &&
      owned.every(
        (entry) =>
          typeof entry === 'string' &&
          SWITCHABLE.includes(entry.split(':', 1)[0]) &&
          entry.indexOf(':') < entry.length - 1,
      );
    if (readable) return owned as string[];
  } catch {
    // Falls through to the refusal below.
  }
  throw new MenuImportError(
    'The stored menu record is unreadable (pizza_menu.owned_rows), so the menu was not loaded.',
  );
}

/** The `"<table>:<id>"` entries of the switchable rows among a menu's rows, sorted. */
const switchable = (rows: Row[]): string[] =>
  rows
    .filter((row) => SWITCHABLE.includes(row.table))
    .map((row) => `${row.table}:${row.key.id}`)
    .sort();

/** What the previous load wrote, worked out from the catalogue it stored; null when that cannot be read. */
function previousLoadRows(db: Database.Database): string[] | null {
  const stored = db.prepare('SELECT catalog FROM pizza_menu WHERE id = 1').get() as
    | { catalog: string }
    | undefined;
  if (!stored) return [];
  try {
    return switchable(menuRows(JSON.parse(stored.catalog), Number, { food: null, drinks: null }));
  } catch {
    return null;
  }
}

/** `food` and `soda` as the store's active tax pack knows them, or null where it has no such category. */
function taxCategories(db: Database.Database): { food: string | null; soda: string | null } {
  const country =
    (
      db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as
        | { value: string | null }
        | undefined
    )?.value ?? '';
  const found = db
    .prepare(
      `SELECT category_id FROM tax_categories
       WHERE category_id IN ('food', 'soda') AND pack_version_id = (
         SELECT active_version_id FROM country_packs
         WHERE country IN (?, '*') AND status = 'active'
         ORDER BY CASE WHEN country = ? THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1
       )`,
    )
    .all(country, country)
    .map((row) => (row as { category_id: string }).category_id);
  return {
    food: found.includes('food') ? 'food' : null,
    soda: found.includes('soda') ? 'soda' : null,
  };
}

/** The timestamp columns a write sets. A link row has none. */
const stampColumns = (table: string, inserting: boolean): string[] => {
  if (LINKS.includes(table)) return [];
  if (table === 'pizza_menu') return ['imported_at'];
  return inserting ? ['created_at', 'updated_at'] : ['updated_at'];
};

/** Writes one row only when it is missing or differs, so an unchanged row keeps its timestamps. */
function writeRow(
  db: Database.Database,
  { table, key, values }: Row,
  stamp: string,
): 'created' | 'updated' | 'unchanged' {
  const where = Object.keys(key)
    .map((column) => `${column} = @${column}`)
    .join(' AND ');
  const stored = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(key) as
    | Record<string, unknown>
    | undefined;
  const parent = PARENT[table];
  if (stored && parent && stored[parent] !== values[parent])
    throw new MenuError(
      'menu',
      `${table} id "${key.id}" is already used under "${stored[parent]}", so it cannot go under "${values[parent]}"`,
    );
  // A side's group has no parent column: its side is the one linked to it. Two sides whose ids
  // spell the same group may not both be linked, whichever link came first.
  const otherSide =
    table === 'addon_group_product' &&
    (db
      .prepare(
        `SELECT product_id FROM addon_group_product
         WHERE addon_group_id = @addon_group_id AND product_id <> @product_id
           AND product_id LIKE 'sd-%'
           AND substr(@addon_group_id, 1, length(product_id) + 1) = 'ag-' || substr(product_id, 4) || '-'`,
      )
      .get(key) as { product_id: string } | undefined);
  if (otherSide)
    throw new MenuError(
      'menu',
      `addon_groups id "${key.addon_group_id}" is already used under "${otherSide.product_id}", so it cannot go under "${key.product_id}"`,
    );
  if (stored && Object.entries(values).every(([column, value]) => stored[column] === value))
    return 'unchanged';
  const written: Record<string, Value> = { ...values };
  for (const column of stampColumns(table, !stored)) written[column] = stamp;
  if (stored) {
    const assignments = Object.keys(written).map((column) => `${column} = @${column}`);
    db.prepare(`UPDATE ${table} SET ${assignments.join(', ')} WHERE ${where}`).run({
      ...key,
      ...written,
    });
    return 'updated';
  }
  const columns = Object.keys({ ...key, ...written });
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`,
  ).run({ ...key, ...written });
  return 'created';
}

/**
 * Loads a menu in one transaction. A row the last load owned and this one does not is switched
 * off, not deleted, because orders point at it; a row no load owned is never touched, so a menu
 * that derives the id of one is refused.
 */
export function importMenu(db: Database.Database, catalog: PizzaCatalog): ImportSummary {
  const currency = getTenantCurrency(db);
  const factor = getCurrencyMinorUnitFactor(currency);
  if (factor !== 100)
    throw new MenuImportError(
      `A menu file is priced in dollars and cents, and the store currency ${currency} is not counted in hundredths, so the menu was not loaded.`,
    );
  const money = (cents: number): number => cents / factor;
  const { food, soda } = taxCategories(db);
  const tax = { food, drinks: catalog.drinksPst ? soda : food };
  const rows = menuRows(catalog, money, tax);
  const owned = switchable(rows);
  const ownedBefore = lastOwnedRows(db);
  // A row that leaves the menu stays in the list, so the load that brings it back still owns it.
  const everOwned = [...new Set([...ownedBefore, ...owned])].sort();
  // Only what the previous load wrote is switched off, so a row switched back on by hand stays on.
  // With that load's catalogue unreadable, everything a load ever made stands in for it.
  const previous = previousLoadRows(db) ?? ownedBefore;
  rows.push({
    table: 'pizza_menu',
    key: { id: 1 },
    values: { catalog: JSON.stringify(catalog), owned_rows: JSON.stringify(everOwned) },
  });
  // Categories last: one is judged after the menu's own products in it are switched off.
  const isCategory = (entry: string): number => Number(entry.startsWith('categories:'));
  // A category is judged again by every load: one kept on for a hand-made product is switched
  // off by the load after that product goes, however many loads lie between.
  const gone = [...new Set([...previous, ...ownedBefore.filter(isCategory)])]
    .filter((entry) => ownedBefore.includes(entry) && !owned.includes(entry))
    .sort((a, b) => isCategory(a) - isCategory(b));
  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    deactivated: 0,
    untaxed: tax.food === null || (catalog.drinks.length > 0 && tax.drinks === null),
  };

  db.transaction(() => {
    const ours = new Set(ownedBefore);
    // A pizza or deal loaded before the list kept rows that left the menu: its `pizza_products` row
    // says a load made it, and its sizes with it.
    const madeBefore = (productId: unknown): boolean =>
      !ours.has(`products:${productId}`) &&
      Boolean(db.prepare('SELECT 1 FROM pizza_products WHERE product_id = ?').get(productId));
    for (const entry of owned) {
      const table = entry.split(':', 1)[0];
      const id = entry.slice(table.length + 1);
      if (ours.has(entry)) continue;
      const found = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
        | { product_id?: string }
        | undefined;
      const known =
        (table === 'products' && madeBefore(id)) ||
        (table === 'product_variants' && madeBefore(found?.product_id));
      if (found && !known)
        throw new MenuImportError(
          `${NOUN[table]} with the id ${id} already exists and was not made by a menu load. ${
            RESERVED[entry]
              ? `That id is reserved for ${RESERVED[entry]} of the menu, so the menu cannot be loaded until support renames or removes that ${NOUN[table].replace(/^An? /, '')}.`
              : 'Give that item a different id in the menu file, then load it again.'
          }`,
        );
    }
    const stamp = now();
    for (const row of rows) summary[writeRow(db, row, stamp)] += 1;
    // A category nested under another by hand is judged before it: the parent then sees whether
    // its child stayed on.
    const depth = (entry: string): number => {
      let id: unknown = entry.slice('categories:'.length);
      let above = 0;
      for (; isCategory(entry) && id && above < 32; above++)
        id = (
          db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(id) as
            | { parent_id: string | null }
            | undefined
        )?.parent_id;
      return above;
    };
    const depths = new Map(gone.map((entry) => [entry, depth(entry)]));
    gone.sort((a, b) => (depths.get(b) as number) - (depths.get(a) as number));
    gone.sort((a, b) => isCategory(a) - isCategory(b));
    for (const entry of gone) {
      const table = entry.split(':', 1)[0];
      const id = entry.slice(table.length + 1);
      // A sub-category counts: the catalogue shows its products only while this one is on.
      const stillUsed =
        table === 'categories' &&
        db
          .prepare(
            `SELECT 1 FROM products WHERE category_id = @id AND is_active = 1 AND deleted_at IS NULL
             UNION ALL
             SELECT 1 FROM categories WHERE parent_id = @id AND is_active = 1 AND deleted_at IS NULL`,
          )
          .get({ id });
      if (stillUsed) continue;
      summary.deactivated += db
        .prepare(`UPDATE ${table} SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1`)
        .run(stamp, id).changes;
    }
  })();
  return summary;
}
