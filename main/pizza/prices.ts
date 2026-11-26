/** The prices the owner sets in the POS: read beside the menu file's, and saved by loading the menu again. */
import type Database from 'better-sqlite3';
import { getCurrencyMinorUnitFactor } from '../countries';
import { now } from '../db';
import { getTenantCurrency } from '../services/refund';
import { lineSubtotal } from '../services/tax';
import { menuPrices, withPrices, type PriceList } from '../../shared/pizza/prices';
import type { PizzaCatalog } from '../../shared/pizza/types';
import { importMenu } from './menu-import';

/** A request refused with a message for the owner. */
const refuse = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};

/** The most one price can be, in the store's currency. */
const MAX_PRICE = 99999.99;

interface Override {
  key: string;
  price_cents: number;
  file_cents: number | null;
}

/** The catalogue in force, its prices, and the stored overrides by key. */
function stored(db: Database.Database) {
  const row = db.prepare('SELECT catalog FROM pizza_menu WHERE id = 1').get() as
    | { catalog: string }
    | undefined;
  if (!row) return refuse(404, 'No menu has been loaded');
  const overrides = new Map(
    (
      db
        .prepare('SELECT key, price_cents, file_cents FROM pizza_price_overrides ORDER BY key')
        .all() as Override[]
    ).map((override) => [override.key, override]),
  );
  try {
    const catalog: PizzaCatalog = JSON.parse(row.catalog);
    return { catalog, prices: menuPrices(catalog), overrides };
  } catch {
    return refuse(503, 'The pizza menu is not loaded. Load the menu file again.');
  }
}

/** Every price of the loaded menu with the file's amount beside it, and the overrides nothing uses. */
export function readPrices(db: Database.Database): PriceList {
  const { prices, overrides } = stored(db);
  const keys = new Set(prices.map((price) => price.key));
  return {
    prices: prices.map(({ key, group, label, count, priceCents }) => ({
      key,
      group,
      label,
      count,
      file: (overrides.get(key)?.file_cents ?? priceCents) / 100,
      price: priceCents / 100,
      overridden: overrides.has(key),
    })),
    unused: [...overrides.values()]
      .filter((override) => !keys.has(override.key))
      .map((override) => ({
        key: override.key,
        price: override.price_cents / 100,
      })),
  };
}

/**
 * Sets and takes off prices in one transaction: `changes` maps a price's key to an amount in the
 * store's currency, or to null for the menu file's price. The menu is then loaded again from what
 * the file said, so every row a price is written on changes together. One bad entry refuses all.
 */
export function savePrices(db: Database.Database, changes: unknown): PriceList {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes))
    return refuse(400, 'Send the prices to change as { "prices": { "<key>": <amount or null> } }.');
  const currency = getTenantCurrency(db);
  const factor = getCurrencyMinorUnitFactor(currency);
  const decimals = Math.round(Math.log10(factor));
  db.transaction(() => {
    const { catalog, prices, overrides } = stored(db);
    const fileCatalog = withPrices(
      catalog,
      new Map(
        [...overrides.values()].flatMap(({ key, file_cents }) =>
          file_cents === null ? [] : [[key, file_cents]],
        ),
      ),
    );
    const remove = db.prepare('DELETE FROM pizza_price_overrides WHERE key = ?');
    const set = db.prepare(
      `INSERT INTO pizza_price_overrides (key, price_cents, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET price_cents = excluded.price_cents, updated_at = excluded.updated_at`,
    );
    for (const [key, amount] of Object.entries(changes)) {
      if (amount === null) {
        remove.run(key);
        continue;
      }
      const price = prices.find((entry) => entry.key === key);
      if (!price) refuse(400, `${key} is not a price on the menu that is loaded.`);
      // Whole minor units, worked out in decimal arithmetic: 23.005 is not an amount in cents.
      const minor =
        typeof amount === 'number' && amount >= 0 && amount <= MAX_PRICE
          ? lineSubtotal(amount, factor, null, 0, 6)
          : NaN;
      if (!Number.isInteger(minor))
        refuse(
          400,
          `${price?.label}: ${String(amount)} is not an amount in ${currency}. Use a price from 0 to ${MAX_PRICE} with at most ${decimals} decimal places.`,
        );
      set.run(key, minor, now());
    }
    importMenu(db, fileCatalog);
  })();
  return readPrices(db);
}
