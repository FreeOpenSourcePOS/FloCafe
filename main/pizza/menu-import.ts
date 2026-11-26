/** Writes a parsed menu onto FloCafe's own catalogue, keyed by ids derived from the menu's ids. */
import type Database from 'better-sqlite3';
import { getCurrencyMinorUnitFactor } from '../countries';
import { now } from '../db';
import { slugForName } from '../routes/categories';
import { getTenantCurrency } from '../services/refund';
import { MenuError } from '../../shared/pizza/menu';
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

  return rows;
}

/** The `"<table>:<id>"` entries the last load stored, or none before the first load. */
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
 * off, not deleted, because orders point at it; a row no load owned is never touched.
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
  const owned = rows
    .filter((row) => SWITCHABLE.includes(row.table))
    .map((row) => `${row.table}:${row.key.id}`)
    .sort();
  rows.push({
    table: 'pizza_menu',
    key: { id: 1 },
    values: { catalog: JSON.stringify(catalog), owned_rows: JSON.stringify(owned) },
  });
  // Categories last: one is judged after the menu's own products in it are switched off.
  const isCategory = (entry: string): number => Number(entry.startsWith('categories:'));
  const gone = lastOwnedRows(db)
    .filter((entry) => !owned.includes(entry))
    .sort((a, b) => isCategory(a) - isCategory(b));
  const summary: ImportSummary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    deactivated: 0,
    untaxed: tax.food === null || (catalog.drinks.length > 0 && tax.drinks === null),
  };

  db.transaction(() => {
    const stamp = now();
    for (const row of rows) summary[writeRow(db, row, stamp)] += 1;
    for (const entry of gone) {
      const table = entry.split(':', 1)[0];
      const id = entry.slice(table.length + 1);
      const stillUsed =
        table === 'categories' &&
        db
          .prepare(
            'SELECT 1 FROM products WHERE category_id = ? AND is_active = 1 AND deleted_at IS NULL',
          )
          .get(id);
      if (stillUsed) continue;
      summary.deactivated += db
        .prepare(`UPDATE ${table} SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1`)
        .run(stamp, id).changes;
    }
  })();
  return summary;
}
