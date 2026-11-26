import type Database from 'better-sqlite3';

export const PIZZA_VERSION_KEY = 'pizza_schema_version';

// Append-only, like upstream's MIGRATIONS. Every entry is idempotent and creates only pizza
// tables: schema repair can create a pizza table before the counter is written, and the list
// also runs when the reference schema of an older upstream version is built.
export const PIZZA_MIGRATIONS: {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}[] = [
  {
    version: 1,
    name: 'create_pizza_tables',
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS pizza_products (
          product_id  TEXT PRIMARY KEY,
          menu_id     TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN ('pizza', 'half-and-half', 'deal')),
          ingredients TEXT,
          picks       TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pizza_menu (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          catalog     TEXT NOT NULL,
          owned_rows  TEXT NOT NULL DEFAULT '[]',
          imported_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pizza_quick_buttons (
          id          TEXT PRIMARY KEY,
          label       TEXT NOT NULL,
          color       TEXT,
          customer_id TEXT,
          product_id  TEXT NOT NULL,
          variant_id  TEXT,
          recipe      TEXT,
          addons      TEXT,
          note        TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
      `),
  },
];

const latestPizzaVersion = (): number => PIZZA_MIGRATIONS[PIZZA_MIGRATIONS.length - 1].version;

/**
 * 0 when the counter was never written. A counter that is there but is not a whole number reads
 * as Infinity, newer than any build, so the database is refused and the value is not overwritten.
 */
export function getPizzaSchemaVersion(db: Database.Database): number {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_flo_meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare('SELECT value FROM _flo_meta WHERE key = ?').get(PIZZA_VERSION_KEY) as
    | { value: unknown }
    | undefined;
  if (!row) return 0;
  const version = /^\d+$/.test(String(row.value)) ? Number(row.value) : Infinity;
  return Number.isSafeInteger(version) ? version : Infinity;
}

/** The pizza version a reference schema is built at: the candidate file's own, or this build's. */
export function referencePizzaVersion(candidate?: Database.Database): number {
  const latest = latestPizzaVersion();
  return candidate ? Math.min(getPizzaSchemaVersion(candidate), latest) : latest;
}

/** Runs pending pizza migrations up to `target`. `beforeFirst` fires once, only if any is pending. */
export function runPizzaMigrations(
  db: Database.Database,
  target = latestPizzaVersion(),
  beforeFirst?: () => void,
): void {
  const current = getPizzaSchemaVersion(db);
  const pending = PIZZA_MIGRATIONS.filter((m) => m.version > current && m.version <= target);
  if (pending.length === 0) return;
  beforeFirst?.();
  db.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
  const stamp = db.prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)');
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      stamp.run(PIZZA_VERSION_KEY, String(migration.version));
    })();
  }
}

/** Why a database needs a newer build than this one, or null when this build can open it. */
export function newerPizzaSchemaDetail(db: Database.Database): string | null {
  const version = getPizzaSchemaVersion(db);
  const latest = latestPizzaVersion();
  if (version <= latest) return null;
  return Number.isFinite(version)
    ? `Requires pizza schema v${version} (this version supports up to v${latest})`
    : `Its pizza schema version cannot be read (this version supports up to v${latest})`;
}

let warnedNewerPizzaSchema = false;

/** True when the database needs a newer build. The log says why, once per process. */
export function isNewerPizzaSchema(db: Database.Database): boolean {
  const detail = newerPizzaSchemaDetail(db);
  if (detail && !warnedNewerPizzaSchema) {
    warnedNewerPizzaSchema = true;
    console.warn(`[DB] ${detail}`);
  }
  return detail !== null;
}

export type PizzaMenuSnapshot = Record<'products' | 'menu', Record<string, unknown>[]>;

/** The pizza side of the menu a currency reset carries across; money in it is zeroed. */
export function capturePizzaMenu(db: Database.Database): PizzaMenuSnapshot {
  const rows = (table: string) =>
    db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const withoutPrices = (catalog: unknown): string => {
    try {
      return JSON.stringify(
        JSON.parse(String(catalog), (key, value) => (key === 'priceCents' ? 0 : value)),
      );
    } catch (cause) {
      throw new Error(
        'The stored pizza menu is unreadable. Load the menu file again before changing currency.',
        { cause },
      );
    }
  };
  return {
    products: rows('pizza_products'),
    menu: rows('pizza_menu').map((row) => ({ ...row, catalog: withoutPrices(row.catalog) })),
  };
}

/** Runs after upstream has restored its menu: a row whose product did not survive is dropped. */
export function restorePizzaMenu(db: Database.Database, snapshot: PizzaMenuSnapshot): void {
  const hasProduct = db.prepare('SELECT 1 FROM products WHERE id = ?');
  const insert = (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...Object.values(row));
  };
  for (const row of snapshot.products) {
    if (hasProduct.get(row.product_id)) insert('pizza_products', row);
  }
  for (const row of snapshot.menu) insert('pizza_menu', row);
}
