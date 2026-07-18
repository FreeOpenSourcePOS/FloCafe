import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';
import * as fs from 'fs';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

let db: Database.Database;
let dbHealthError: string | null = null;

const DEFAULT_CLOUD_SERVER_URL = 'https://blue.flopos.com/';

function randomSecret(): string {
  return crypto.randomBytes(32).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function getSettingValue(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

function upsertSetting(key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now());
}

function insertSettingIfMissing(key: string, value: string): void {
  db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, now());
}

export function getDbHealth(): { ok: boolean; error?: string } {
  if (!db) return { ok: false, error: 'Database not initialized' };
  if (dbHealthError) return { ok: false, error: dbHealthError };
  return { ok: true };
}

export function getDbPath(): string {
  const userDataPath = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '../');
  return path.join(userDataPath, 'flo.db');
}

function getBackupDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'backups');
}

export function initDatabase(): void {
  const dbPath = getDbPath();
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  console.log(`[DB] Opening database at: ${dbPath}`);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF'); // Off during migrations

  runMigrations();

  db.pragma('foreign_keys = ON');

  runStartupIntegrityCheck();
  repairSequences();
  autoRepairPaymentDetails();
  autoRepairDefaultPrinter();
}

export function ensureCloudIdentity(): { posHash: string; deviceSecret: string } {
  let deviceSecret = getSettingValue('cloud_device_secret');
  if (!deviceSecret) {
    deviceSecret = randomSecret();
    upsertSetting('cloud_device_secret', deviceSecret);
  }

  let posHash = getSettingValue('cloud_pos_hash');
  if (!posHash) {
    posHash = `pos_${sha256Hex(deviceSecret).slice(0, 40)}`;
    upsertSetting('cloud_pos_hash', posHash);
  }

  insertSettingIfMissing('cloud_device_created_at', now());
  return { posHash, deviceSecret };
}

/** Atomic multi-statement mutation. Use for anything touching >1 row or >1 table. */
export function withTxn<T>(fn: () => T): T {
  return db.transaction(fn)();
}

/** Safely append an object to a JSON-array column. Creates the array if missing/invalid. */
export function appendJsonArray(table: string, idColumn: string, idValue: any, column: string, value: any): void {
  // Validate identifiers to prevent SQL injection
  if (!isSafeIdentifier(table) || !isSafeIdentifier(idColumn) || !isSafeIdentifier(column)) {
    throw new Error(`Invalid identifier: table=${table}, idColumn=${idColumn}, column=${column}`);
  }
  const row = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${idColumn} = ?`).get(idValue) as any;
  let arr: any[] = [];
  if (row && row.v) {
    try {
      const parsed = JSON.parse(row.v);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = [];
    }
  }
  arr.push(value);
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${idColumn} = ?`).run(JSON.stringify(arr), idValue);
}

/** Runs on every startup. Logs loud warnings but never throws — DB stays available even if dirty. */
function runStartupIntegrityCheck(): void {
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    const bad = integrity.filter((r) => r.integrity_check !== 'ok');
    if (bad.length > 0) {
      const msg = bad.map((r) => r.integrity_check).join('; ');
      console.error('[DB] ⚠ integrity_check reported issues:', msg);
      dbHealthError = `Database integrity error: ${msg}`;
    } else {
      console.log('[DB] integrity_check: ok');
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as any[];
    if (fkViolations.length > 0) {
      console.error(`[DB] ⚠ ${fkViolations.length} foreign-key violation(s):`, fkViolations.slice(0, 5));
    } else {
      console.log('[DB] foreign_key_check: clean');
    }
  } catch (err: any) {
    console.error('[DB] Startup integrity check failed:', err.message);
  }
}

/** Re-seeds the sequences table from existing order_number and bill_number data.
 *  Fixes UNIQUE constraint collisions caused by migration v10 dropping and recreating
 *  the sequences table, which reset counters while old numbered rows still existed. */
function repairSequences(): void {
  try {
    const collectSequenceMax = (table: 'orders' | 'bills', numberColumn: string, pattern: RegExp) => {
      const rows = db.prepare(`SELECT ${numberColumn} AS value FROM ${table} WHERE ${numberColumn} IS NOT NULL`).all() as { value: string }[];
      const maxByDate = new Map<string, number>();

      for (const row of rows) {
        const match = String(row.value).match(pattern);
        if (!match) continue;
        const date = match[1];
        const sequence = Number.parseInt(match[2], 10);
        if (!Number.isFinite(sequence)) continue;
        maxByDate.set(date, Math.max(maxByDate.get(date) || 0, sequence));
      }

      return Array.from(maxByDate, ([date, max_val]) => ({ date, max_val }));
    };

    // Extract max sequence per date from order_numbers (format: ORD-YYYYMMDD-NNNN)
    const orderRows = collectSequenceMax('orders', 'order_number', /^ORD-(\d{8})-(\d+)$/);

    for (const row of orderRows) {
      if (!row.date || !row.max_val) continue;
      const existing = db.prepare(`SELECT current_value FROM sequences WHERE name = 'orders' AND date = ?`).get(row.date) as any;
      if (!existing) {
        db.prepare(`INSERT INTO sequences (name, date, current_value) VALUES ('orders', ?, ?)`).run(row.date, row.max_val);
      } else if (existing.current_value < row.max_val) {
        db.prepare(`UPDATE sequences SET current_value = ? WHERE name = 'orders' AND date = ?`).run(row.max_val, row.date);
      }
    }

    // Extract max sequence per date from bill_numbers (format: INV-YYYYMMDD-NNNN)
    const billRows = collectSequenceMax('bills', 'bill_number', /^INV-(\d{8})-(\d+)$/);

    for (const row of billRows) {
      if (!row.date || !row.max_val) continue;
      const existing = db.prepare(`SELECT current_value FROM sequences WHERE name = 'bills' AND date = ?`).get(row.date) as any;
      if (!existing) {
        db.prepare(`INSERT INTO sequences (name, date, current_value) VALUES ('bills', ?, ?)`).run(row.date, row.max_val);
      } else if (existing.current_value < row.max_val) {
        db.prepare(`UPDATE sequences SET current_value = ? WHERE name = 'bills' AND date = ?`).run(row.max_val, row.date);
      }
    }
  } catch (err) {
    console.error('[DB] repairSequences failed:', err);
  }
}

/** Idempotent auto-repair for the pre-fix payment_details corruption: `{A},{A}` → `[A]`.
 *  Only runs when rows are detected as malformed AND the deduped sum matches `paid_amount`. */
function autoRepairPaymentDetails(): void {
  try {
    const rows = db.prepare(`SELECT id, payment_details, paid_amount FROM bills WHERE payment_details IS NOT NULL AND payment_details != ''`).all() as any[];
    const toFix: { id: number; value: string }[] = [];

    for (const row of rows) {
      try { JSON.parse(row.payment_details); continue; } catch { }

      const wrapped = '[' + String(row.payment_details).replace(/\}\s*,\s*\{/g, '},{') + ']';
      let parsed: any[];
      try { parsed = JSON.parse(wrapped); } catch { continue; }
      if (!Array.isArray(parsed)) continue;

      const deduped: any[] = [];
      for (const p of parsed) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.method === p.method && prev.amount === p.amount && prev.timestamp === p.timestamp) continue;
        deduped.push(p);
      }

      const dedupedSum = deduped.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const rawSum = parsed.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const chosen = Math.abs(dedupedSum - row.paid_amount) <= 0.02 ? deduped
        : Math.abs(rawSum - row.paid_amount) <= 0.02 ? parsed : null;
      if (!chosen) continue;

      toFix.push({ id: row.id, value: JSON.stringify(chosen) });
    }

    if (toFix.length === 0) return;

    const stmt = db.prepare(`UPDATE bills SET payment_details = ?, updated_at = datetime('now') WHERE id = ?`);
    const tx = db.transaction((rows: { id: number; value: string }[]) => {
      for (const r of rows) stmt.run(r.value, r.id);
    });
    tx(toFix);
    console.log(`[DB] auto-repaired payment_details on ${toFix.length} bill(s)`);
  } catch (err: any) {
    console.error('[DB] autoRepairPaymentDetails failed:', err.message);
  }
}

/** Keep printer selection deterministic if an older install ended up with multiple defaults. */
function autoRepairDefaultPrinter(): void {
  try {
    const defaults = db.prepare(`
      SELECT id FROM printers
      WHERE is_default = 1
      ORDER BY CASE WHEN id = 'printer-1' AND name = 'Thermal Printer' THEN 1 ELSE 0 END ASC,
               COALESCE(updated_at, created_at, '') DESC,
               COALESCE(created_at, '') DESC,
               name COLLATE NOCASE ASC,
               id ASC
    `).all() as { id: string }[];

    if (defaults.length <= 1) return;

    const keepId = defaults[0].id;
    db.prepare(`
      UPDATE printers
      SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END,
          updated_at = CASE WHEN id = ? THEN updated_at ELSE ? END
      WHERE is_default = 1
    `).run(keepId, keepId, now());

    console.log(`[DB] auto-repaired default printers; kept ${keepId}`);
  } catch (err: any) {
    console.error('[DB] autoRepairDefaultPrinter failed:', err.message);
  }
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    console.log('[DB] Database closed');
  }
}

export async function createBackup(targetPath?: string): Promise<{ path: string; schemaVersion: number }> {
  console.log('[DB] createBackup: Starting...');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Always write to a temp path inside userData first. On MAS, the sandbox
  // only grants access to the user-selected file itself — opening the backup
  // DB in WAL mode would try to create .db-wal/.db-shm siblings next to the
  // user-selected file, which the sandbox blocks. Writing to userData first
  // avoids that restriction; we copy the final clean file to targetPath.
  const tempPath = path.join(backupDir, `flo-backup-${timestamp}.db`);
  const finalPath = targetPath || tempPath;

  console.log('[DB] createBackup: Backing up to temp:', tempPath);
  await db.backup(tempPath);

  const backupDb = new Database(tempPath);
  // Switch to DELETE journal mode: checkpoints WAL and removes .db-wal/.db-shm
  // so the final file is self-contained with no auxiliary files.
  backupDb.pragma('journal_mode = DELETE');
  backupDb.exec(`
    CREATE TABLE IF NOT EXISTS _flo_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  const currentVersion = getCurrentSchemaVersion();
  backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
    .run('schema_version', String(currentVersion));
  backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
    .run('backup_created_at', new Date().toISOString());
  backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
    .run('app_version', app.getVersion());
  backupDb.close();

  if (finalPath !== tempPath) {
    fs.copyFileSync(tempPath, finalPath);
    fs.unlinkSync(tempPath);
    console.log(`[DB] Backup saved to: ${finalPath} (schema v${currentVersion})`);
  } else {
    console.log(`[DB] Backup created: ${finalPath} (schema v${currentVersion})`);
  }

  return { path: finalPath, schemaVersion: currentVersion };
}

function getColumns(dbInstance: Database.Database, tableName: string): string[] {
  try {
    const columns = dbInstance.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
    return columns.map(col => col.name);
  } catch {
    return [];
  }
}

export function getTables(dbInstance: Database.Database): string[] {
  try {
    const tables = dbInstance.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' 
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_flo_meta'
    `).all() as { name: string }[];
    return tables.map(t => t.name);
  } catch {
    return [];
  }
}

export interface RestoreResult {
  success: boolean;
  mode: 'direct' | 'data_only' | 'full';
  backupSchemaVersion: number;
  currentSchemaVersion: number;
  tablesRestored: number;
  error?: string;
}

export function restoreBackup(backupPath: string, forceDirect: boolean = false): RestoreResult {
  console.log('[DB] restoreBackup: Starting restore from:', backupPath);

  const backupDb = new Database(backupPath, { readonly: true });

  const metaRow = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  const backupSchemaVersion = metaRow ? parseInt(metaRow.value, 10) : 0;
  backupDb.close();

  const currentDb = getDatabase();
  const currentVersion = getCurrentSchemaVersion();

  console.log(`[DB] Backup schema version: ${backupSchemaVersion}, Current: ${currentVersion}`);

  if (forceDirect || backupSchemaVersion === currentVersion) {
    console.log('[DB] restoreBackup: Direct restore (same schema version)');
    closeDatabase();
    const dbPath = getDbPath();
    fs.copyFileSync(backupPath, dbPath);
    initDatabase();

    // Get fresh DB handle after reinitialization
    const freshDb = getDatabase();
    return {
      success: true,
      mode: 'direct',
      backupSchemaVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: getTables(freshDb).length
    };
  }

  console.log('[DB] restoreBackup: Data-only restore (schema version mismatch)');
  return dataOnlyRestore(backupPath, backupSchemaVersion, currentVersion);
}

/** Return true only if the string is a safe SQL identifier (letters, digits, underscore). */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function dataOnlyRestore(backupPath: string, backupVersion: number, currentVersion: number): RestoreResult {
  const backupDb = new Database(backupPath, { readonly: true });
  const currentDb = getDatabase();

  const backupTables = getTables(backupDb);
  const currentTables = getTables(currentDb);

  const commonTables = backupTables.filter(t => currentTables.includes(t));
  let tablesRestored = 0;

  // Escape single-quotes in the path so the ATTACH string literal is safe
  // (e.g. macOS paths containing apostrophes like /Users/O'Brien/backup.db)
  const safeBackupPath = backupPath.replace(/'/g, "''");

  currentDb.exec('BEGIN IMMEDIATE');

  try {
    // ATTACH once outside the loop — avoids repeated injection attempts and is faster
    currentDb.exec(`ATTACH DATABASE '${safeBackupPath}' AS _restore_src`);

    for (const tableName of commonTables) {
      // ── Guard: skip tables whose name isn't a plain SQL identifier ──────────
      if (!isSafeIdentifier(tableName)) {
        console.warn(`[DB] dataOnlyRestore: skipping table with unsafe name: ${JSON.stringify(tableName)}`);
        continue;
      }

      const backupCols = getColumns(backupDb, tableName);
      const currentCols = getColumns(currentDb, tableName);

      // ── Guard: skip columns whose name isn't a plain SQL identifier ─────────
      const commonCols = backupCols
        .filter(c => currentCols.includes(c))
        .filter(c => {
          if (isSafeIdentifier(c)) return true;
          console.warn(`[DB] dataOnlyRestore: skipping unsafe column: ${JSON.stringify(c)} in ${tableName}`);
          return false;
        });

      if (commonCols.length === 0) continue;

      const colList = commonCols.join(', ');

      currentDb.exec(`DELETE FROM ${tableName}`);
      currentDb.exec(`INSERT INTO ${tableName} (${colList}) SELECT ${colList} FROM _restore_src.${tableName}`);

      tablesRestored++;
      console.log(`[DB] Restored ${tableName}: ${commonCols.length} columns`);
    }

    currentDb.exec('DETACH DATABASE _restore_src');
    currentDb.exec('COMMIT');

    return {
      success: true,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored
    };
  } catch (error: any) {
    currentDb.exec('ROLLBACK');
    console.error('[DB] dataOnlyRestore failed:', error);
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: error.message
    };
  } finally {
    backupDb.close();
  }
}


export function getSchemaVersionFromBackup(backupPath: string): number {
  try {
    const backupDb = new Database(backupPath, { readonly: true });
    const metaRow = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    backupDb.close();
    return metaRow ? parseInt(metaRow.value, 10) : 0;
  } catch {
    return 0;
  }
}

export function getCurrentSchemaVersion(): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Builds a throwaway in-memory database by running the exact same
 * createSchema()+MIGRATIONS pipeline a real fresh install takes. This is the
 * "ideal" schema reference for the DB health check — deriving it from the
 * live migration pipeline (instead of hand-maintaining a second schema spec)
 * guarantees it can never drift from what main/db.ts actually produces.
 *
 * Temporarily swaps the module-level `db` binding since createSchema()/
 * runMigrations() operate on it directly. Safe because better-sqlite3 is
 * fully synchronous and Node is single-threaded — nothing else can observe
 * the swapped binding as long as this function doesn't yield to the event loop.
 * Caller owns the returned handle and must call .close() on it.
 */
export function buildIdealSchemaDb(): Database.Database {
  const idealDb = new Database(':memory:');
  const previousDb = db;
  db = idealDb;
  try {
    runMigrations();
  } finally {
    db = previousDb;
  }
  return idealDb;
}

// ─── Migration registry ───────────────────────────────────────────────────────
// Each entry runs exactly once, in order, wrapped in a transaction.
// To add a schema change: append a new entry. Never edit existing entries.

export const MIGRATIONS: { version: number; name: string; up: () => void }[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: () => {
      createSchema();
      seedInstallDefaults();
    },
  },
  {
    version: 2,
    name: 'hash_plaintext_pins',
    up: () => {
      // Migrate from plaintext PINs to hashed PINs.
      // New installs going forward store only pin_hash.
      const userColumns = getColumns(db, 'users');
      if (!userColumns.includes('pin_hash')) {
        db.exec(`ALTER TABLE users ADD COLUMN pin_hash TEXT`);
      }

      if (!userColumns.includes('pin')) return;

      const usersWithPin = db.prepare('SELECT id, pin FROM users WHERE pin IS NOT NULL').all() as { id: string; pin: string }[];
      for (const user of usersWithPin) {
        const pin = String(user.pin || '');
        if (!pin) continue;
        // Already a bcrypt hash?
        if (pin.startsWith('$2')) continue;
        db.prepare('UPDATE users SET pin_hash = ?, pin = NULL WHERE id = ?')
          .run(bcrypt.hashSync(pin, 10), user.id);
      }
    },
  },
  {
    version: 3,
    name: 'cloud_identity_and_outbox',
    up: () => {
      createCloudSyncSchema();
      seedCloudSyncDefaults();
    },
  },
  {
    version: 4,
    name: 'add_notes_limits_settings',
    up: () => {
      insertSettingIfMissing('max_order_notes_length', '200');
      insertSettingIfMissing('max_item_notes_length', '100');
    },
  },
  {
    version: 5,
    name: 'add_print_logs_table',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS print_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bill_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          printed_at TEXT DEFAULT CURRENT_TIMESTAMP,
          print_type TEXT DEFAULT 'receipt',
          FOREIGN KEY (bill_id) REFERENCES bills(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
    },
  },
  {
    version: 6,
    name: 'add_loyalty_settings',
    up: () => {
      insertSettingIfMissing('loyalty_enabled', 'true');
      insertSettingIfMissing('loyalty_points_per_currency', '1');
      insertSettingIfMissing('loyalty_redemption_rate', '100');
      insertSettingIfMissing('loyalty_max_balance_enabled', '0');
      insertSettingIfMissing('loyalty_max_balance_points', '10000');
      insertSettingIfMissing('loyalty_expiry_enabled', '0');
      insertSettingIfMissing('loyalty_expiry_months', '6');
      insertSettingIfMissing('loyalty_min_redemption', '100');
      insertSettingIfMissing('loyalty_max_redemption_percentage', '50');
    },
  },
  {
    version: 7,
    name: 'add_discount_settings',
    up: () => {
      insertSettingIfMissing('discount_mode', 'percentage');
      insertSettingIfMissing('discount_requires_approval', '0');
      insertSettingIfMissing('discount_max_percentage', '25');
      insertSettingIfMissing('discount_max_amount', '0');
    },
  },
  {
    version: 8,
    name: 'add_loyalty_index',
    up: () => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_ledger(customer_id, type)');
    },
  },
  {
    version: 9,
    name: 'add_sequences_table',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sequences (
          name TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          current_value INTEGER NOT NULL DEFAULT 0
        )
      `);
    },
  },
  {
    version: 10,
    name: 'fix_sequences_composite_key',
    up: () => {
      // v9 used `name TEXT PRIMARY KEY` but the code needs (name, date) as a
      // composite key. Drop and recreate with the correct schema.
      db.exec(`DROP TABLE IF EXISTS sequences`);
      db.exec(`
        CREATE TABLE sequences (
          name TEXT NOT NULL,
          date TEXT NOT NULL,
          current_value INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (name, date)
        )
      `);
    },
  },
  {
    version: 11,
    name: 'first_run_setup_uses_welcome_form',
    up: () => {
      // Intentionally no-op. Fresh installs must remain uninitialized so the
      // local welcome form can create the first owner account.
    },
  },
  {
    version: 12,
    name: 'fix_table_integer_ids',
    up: () => {
      // Non-destructive migration: convert integer table IDs to strings.
      // Some tables were created before POST /tables was fixed (Task 1),
      // so they got SQLite rowid integers instead of 'tbl-...' strings.
      db.exec(`UPDATE tables SET id = 'tbl-' || id WHERE typeof(id) = 'integer'`);
    },
  },
  {
    version: 13,
    name: 'fix_null_table_ids',
    up: () => {
      // Fix tables with NULL ids caused by old INSERT without id column.
      // SQLite stored NULL instead of generating an id.
      //
      // Generate string IDs using rowid for existing tables with NULL ids
      db.exec(`UPDATE tables SET id = 'tbl-' || rowid WHERE id IS NULL`);

      // Also catch any integer ids that slipped through v12
      db.exec(`UPDATE tables SET id = 'tbl-' || id WHERE typeof(id) = 'integer'`);
    },
  },
  {
    version: 14,
    name: 'simplify_loyalty_settings',
    up: () => {
      // Loyalty program is now a single on/off switch — earning rate comes from
      // each product's own cb_percent, and redemption uses a fixed in-code rate.
      // Drop the now-unused tuning settings; keep only loyalty_enabled.
      db.exec(`
        DELETE FROM settings WHERE key IN (
          'loyalty_points_per_currency',
          'loyalty_redemption_rate',
          'loyalty_max_balance_enabled',
          'loyalty_max_balance_points',
          'loyalty_expiry_enabled',
          'loyalty_expiry_months',
          'loyalty_min_redemption',
          'loyalty_max_redemption_percentage',
          'loyalty_expiry_days'
        )
      `);
      const customerCols = db.prepare(`PRAGMA table_info(customers)`).all() as { name: string }[];
      if (customerCols.some((c) => c.name === 'loyalty_points')) {
        db.exec(`ALTER TABLE customers DROP COLUMN loyalty_points`);
      }
    },
  },
  {
    version: 15,
    name: 'add_instagram_handle_setting',
    up: () => {
      insertSettingIfMissing('instagram_handle', '');
    },
  },
  {
    version: 16,
    name: 'add_terms_accepted_at_to_users',
    up: () => {
      const userColumns = getColumns(db, 'users');
      if (!userColumns.includes('terms_accepted_at')) {
        db.exec(`ALTER TABLE users ADD COLUMN terms_accepted_at TEXT`);
      }
    },
  },
  {
    version: 17,
    name: 'add_held_orders_table',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS held_orders (
          id TEXT PRIMARY KEY,
          table_id TEXT NOT NULL,
          items TEXT NOT NULL,
          customer_id TEXT,
          guest_count INTEGER DEFAULT 1,
          order_notes TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 18,
    name: 'fix_null_category_ids',
    up: () => {
      // Same bug as v13's fix_null_table_ids: POST /categories inserted without
      // the id column, and categories.id (TEXT PRIMARY KEY, not a rowid alias)
      // silently accepted NULL. Backfill so these rows become deletable and
      // stop colliding with the "All" filter (which also compares against null).
      db.exec(`UPDATE categories SET id = 'cat-' || rowid WHERE id IS NULL`);
    },
  },
  {
    version: 19,
    name: 'backfill_product_cb_percent_and_tags',
    up: () => {
      // cb_percent/tags were added to createSchema() (CREATE TABLE IF NOT EXISTS)
      // back when v1-v7 -> v8 was still a destructive dropAllTables()+recreate
      // migration. Once migrations became incremental (non-destructive), no
      // ALTER TABLE ever backfilled these columns onto pre-v8 installs that
      // updated straight through — so POST /products 500s with "table products
      // has no column named cb_percent" on any DB that never got the columns.
      const productColumns = getColumns(db, 'products');
      if (!productColumns.includes('cb_percent')) {
        db.exec(`ALTER TABLE products ADD COLUMN cb_percent REAL DEFAULT 0`);
      }
      if (!productColumns.includes('tags')) {
        db.exec(`ALTER TABLE products ADD COLUMN tags TEXT`);
      }
    },
  },
  {
    version: 20,
    name: 'add_tables_is_active',
    up: () => {
      // Tables were hard-deleted, orphaning orders.table_id/held_orders.table_id
      // on any historical order still pointing at them. Add is_active so tables
      // can be deactivated (like products/categories/staff) instead of destroyed.
      const tableColumns = getColumns(db, 'tables');
      if (!tableColumns.includes('is_active')) {
        db.exec(`ALTER TABLE tables ADD COLUMN is_active INTEGER DEFAULT 1`);
      }
    },
  },
  {
    version: 21,
    name: 'clear_legacy_loyalty_expiry',
    up: () => {
      // v14 turned off expiry for new loyalty points, but left expires_at on
      // pre-existing ledger rows untouched. Since wallet balance nets all-time
      // debits against only unexpired credits, a legacy credit hitting its old
      // expiry date silently drops out of the credit sum while the debits that
      // already spent it stay — collapsing the customer's balance. Clearing
      // expires_at retroactively aligns legacy rows with the non-expiry policy.
      db.exec(`UPDATE loyalty_ledger SET expires_at = NULL WHERE expires_at IS NOT NULL`);
    },
  },
  {
    version: 22,
    name: 'add_customers_phone_digits',
    up: () => {
      if (!getColumns(db, 'customers').includes('phone_digits')) {
        db.exec(`
          ALTER TABLE customers ADD COLUMN phone_digits TEXT
            GENERATED ALWAYS AS (
              CASE WHEN phone IS NULL THEN NULL
                   ELSE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')
              END
            ) VIRTUAL
        `);
      }
    },
  },
  {
    version: 23,
    name: 'normalize_customer_phones',
    up: () => {
      const tenantCountryRow = db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as any;
      const tenantCountry = tenantCountryRow?.value || 'IN';
      
      const { parsePhoneE164 } = require('./lib/phone');

      const customers = db.prepare(
        "SELECT id, phone, country_code FROM customers WHERE phone IS NOT NULL AND phone != ''"
      ).all() as any[];

      let normalized = 0, unparseable = 0;

      for (const c of customers) {
        const parsed = parsePhoneE164(c.phone, tenantCountry);
        if (parsed) {
          db.prepare('UPDATE customers SET phone = ?, country_code = ? WHERE id = ?')
            .run(parsed.e164, parsed.countryCode, c.id);
          normalized++;
        } else {
          console.log(`[MIGRATION v23] unparseable: ${c.id} ${c.phone}`);
          unparseable++;
        }
      }
      console.log(`[MIGRATION v23] normalized: ${normalized}, unparseable: ${unparseable}`);

      const dupes = db.prepare(`
        SELECT phone_digits, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
        FROM customers
        WHERE phone_digits IS NOT NULL AND phone_digits != ''
        GROUP BY phone_digits
        HAVING cnt > 1
      `).all() as any[];

      let merged = 0;

      for (const group of dupes) {
        const ids = group.ids.split(',').sort();
        const allRows = db.prepare(
          `SELECT * FROM customers WHERE id IN (${ids.map(() => '?').join(',')})
           ORDER BY created_at ASC, id ASC`
        ).all(...ids) as any[];

        const winner = allRows[0];
        const losers = allRows.slice(1);

        const coalesceFields = ['email', 'address', 'notes', 'country_code'];
        for (const loser of losers) {
          for (const field of coalesceFields) {
            if (!winner[field] && loser[field]) {
              winner[field] = loser[field];
            }
          }
        }

        db.prepare(`
          UPDATE customers SET email = ?, address = ?, notes = ?, country_code = ?, updated_at = ?
          WHERE id = ?
        `).run(winner.email, winner.address, winner.notes, winner.country_code, now(), winner.id);

        const fkTables = ['orders', 'bills', 'held_orders', 'loyalty_ledger'];
        for (const table of fkTables) {
          db.prepare(`UPDATE ${table} SET customer_id = ? WHERE customer_id IN (${losers.map(() => '?').join(',')})`)
            .run(winner.id, ...losers.map((l: any) => l.id));
        }

        const loserIds = losers.map((l: any) => l.id);
        db.prepare(`DELETE FROM customers WHERE id IN (${loserIds.map(() => '?').join(',')})`)
          .run(...loserIds);

        console.log(`[MIGRATION v23] merged ${loserIds.join(',')} → ${winner.id} (phone: ${winner.phone})`);
        merged += losers.length;
      }
      console.log(`[MIGRATION v23] merged ${merged} duplicate customer(s)`);

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_digits_unique
        ON customers(phone_digits)
        WHERE phone_digits IS NOT NULL AND phone_digits != ''
      `);
      
      const total = db.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number };
      const nonE164 = db.prepare(
        "SELECT COUNT(*) as cnt FROM customers WHERE phone IS NOT NULL AND phone != '' AND phone NOT LIKE '+%'"
      ).get() as { cnt: number };
      console.log(`[MIGRATION v23] verification: ${total.cnt} customers, ${nonE164.cnt} still non-E.164`);
      if (nonE164.cnt > 0) {
        console.warn(`[MIGRATION v23] WARNING: ${nonE164.cnt} customers have unparseable phones (preserved as raw)`);
      }
    },
  },
  {
    version: 24,
    name: 'normalize_customer_phones_retry',
    up: () => {
      const tenantCountryRow = db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as any;
      const tenantCountry = tenantCountryRow?.value || 'IN';
      
      const { parsePhoneE164 } = require('./lib/phone');

      const customers = db.prepare(
        "SELECT id, phone, country_code FROM customers WHERE phone IS NOT NULL AND phone != ''"
      ).all() as any[];

      let normalized = 0, unparseable = 0;

      for (const c of customers) {
        const parsed = parsePhoneE164(c.phone, tenantCountry);
        if (parsed && parsed.e164 !== c.phone) {
          db.prepare('UPDATE customers SET phone = ?, country_code = ? WHERE id = ?')
            .run(parsed.e164, parsed.countryCode, c.id);
          normalized++;
        } else if (!parsed) {
          unparseable++;
        }
      }
      console.log(`[MIGRATION v24] normalized: ${normalized}, unparseable: ${unparseable}`);
    },
  },
];

function syncBackupBeforeMigration(version: number): void {
  try {
    const dbPath = getDbPath();
    const backupDir = getBackupDir();
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const targetPath = path.join(backupDir, `flo-backup-${timestamp}-pre-v${version}.db`);

    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(dbPath, targetPath);

    const backupDb = new Database(targetPath);
    backupDb.pragma('journal_mode = DELETE');
    backupDb.exec(`
      CREATE TABLE IF NOT EXISTS _flo_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('schema_version', String(getCurrentSchemaVersion()));
    backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('backup_created_at', new Date().toISOString());
    backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('app_version', app.getVersion());
    backupDb.close();

    console.log(`[DB] Auto-backup before migration v${version} created at ${targetPath}`);
  } catch (err: any) {
    console.error(`[DB] Auto-backup before migration failed:`, err.message);
  }
}

function runMigrations(): void {
  const current = getCurrentSchemaVersion();
  const target = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

  if (current >= target) {
    console.log(`[DB] Schema up to date (v${current})`);
    return;
  }

  console.log(`[DB] Schema: v${current} → v${target}`);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    
    if (migration.version === 23) {
      console.log(`[DB] Triggering auto-backup before v23...`);
      syncBackupBeforeMigration(23);
    }

    console.log(`[DB] Applying migration v${migration.version}: ${migration.name}`);
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
    console.log(`[DB] Migration v${migration.version} complete`);
  }
}

function createSchema(): void {
  db.exec(`
    -- ── Master data tables ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      parent_id TEXT,
      slug TEXT,
      color TEXT,
      icon TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      category_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL DEFAULT 0,
      cost REAL DEFAULT 0,
      sku TEXT,
      barcode TEXT,
      image_url TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      track_inventory INTEGER DEFAULT 0,
      stock_quantity REAL DEFAULT 0,
      low_stock_threshold REAL DEFAULT 5,
      tax_type TEXT DEFAULT 'none',
      tax_rate REAL DEFAULT 0,
      cb_percent REAL DEFAULT 0,
      tags TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS addon_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_required INTEGER DEFAULT 0,
      min_selection INTEGER DEFAULT 0,
      max_selection INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS addons (
      id TEXT PRIMARY KEY,
      addon_group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (addon_group_id) REFERENCES addon_groups(id)
    );

    CREATE TABLE IF NOT EXISTS addon_group_product (
      product_id TEXT NOT NULL,
      addon_group_id TEXT NOT NULL,
      PRIMARY KEY (product_id, addon_group_id)
    );

    CREATE TABLE IF NOT EXISTS kitchen_stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category_ids TEXT,
      printer_ip TEXT,
      printer_port INTEGER DEFAULT 9100,
      printer_name TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      capacity INTEGER DEFAULT 4,
      status TEXT DEFAULT 'available',
      floor TEXT,
      section TEXT,
      position_x REAL,
      position_y REAL,
      kitchen_station_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      country_code TEXT DEFAULT '+91',
      address TEXT,
      notes TEXT,
      tag_counts TEXT DEFAULT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Users (authentication + roles) ──────────────────────────────────
    -- Roles: owner, manager, cashier, waiter, chef
    -- KDS is operated by the chef role.

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier'
        CHECK (role IN ('owner', 'manager', 'cashier', 'waiter', 'chef')),
      pin TEXT,
      pin_hash TEXT,
      category_ids TEXT,
      is_active INTEGER DEFAULT 1,
      terms_accepted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Transactional tables ─────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      table_id TEXT,
      customer_id TEXT,
      user_id TEXT,
      type TEXT DEFAULT 'takeaway',
      guest_count INTEGER,
      special_instructions TEXT,
      packaging_charge REAL DEFAULT 0,
      delivery_charge REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      subtotal REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT,
      discount_value REAL,
      discount_reason TEXT,
      round_off REAL DEFAULT 0,
      total REAL DEFAULT 0,
      cooking_started_at TEXT,
      ready_at TEXT,
      served_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_sku TEXT,
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      subtotal REAL NOT NULL,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      tax_type TEXT,
      discount_amount REAL DEFAULT 0,
      total REAL NOT NULL,
      variant_selection TEXT,
      modifier_selection TEXT,
      addons TEXT,
      special_instructions TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT UNIQUE NOT NULL,
      order_id INTEGER NOT NULL,
      customer_id TEXT,
      subtotal REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT,
      discount_value REAL,
      discount_reason TEXT,
      delivery_charge REAL DEFAULT 0,
      packaging_charge REAL DEFAULT 0,
      round_off REAL DEFAULT 0,
      total REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'unpaid',
      payment_details TEXT,
      paid_at TEXT,
      printed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS loyalty_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      bill_id INTEGER,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Config tables ────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kds_pairing_tokens (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      station_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connection_type TEXT NOT NULL CHECK (connection_type IN ('network', 'usb', 'webusb')),
      ip_address TEXT,
      port INTEGER DEFAULT 9100,
      usb_device_path TEXT,
      is_default INTEGER DEFAULT 0,
      paper_width TEXT DEFAULT '80mm',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Indexes ──────────────────────────────────────────────────────────

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_active   ON products(is_active);
    CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created    ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_bills_order       ON bills(order_id);
  `);
}

function createCloudSyncSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_sync_outbox_status
      ON cloud_sync_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_sync_outbox_entity
      ON cloud_sync_outbox(entity_type, entity_id);
  `);
}

function seedCloudSyncDefaults(): void {
  createCloudSyncSchema();

  const serverUrl = getSettingValue('cloud_server_url');
  if (!serverUrl) upsertSetting('cloud_server_url', DEFAULT_CLOUD_SERVER_URL);

  // Mirrors FloAdmin's own `stores` table defaults (sync + reports on, orders off —
  // see specs/floadmin.md § api surface). Harmless pre-claim: every send path in
  // cloud-sync.ts is gated on api_key being present, which only exists after a
  // human claims the store on FloAdmin, so nothing transmits before then.
  insertSettingIfMissing('cloud_sync_enabled', '1');
  insertSettingIfMissing('cloud_orders_enabled', '0');
  insertSettingIfMissing('cloud_reports_enabled', '1');
  insertSettingIfMissing('cloud_command_polling_enabled', '1');
  insertSettingIfMissing('cloud_connected', 'false');
  insertSettingIfMissing('cloud_registration_status', 'unregistered');

  ensureCloudIdentity();
}

function seedInstallDefaults(): void {
  const insert = (key: string, value: string) =>
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);

  insert('business_name', '');
  insert('business_type', 'restaurant');
  insert('country', 'IN');
  insert('currency', 'INR');
  insert('currency_symbol', '₹');
  insert('timezone', 'Asia/Kolkata');
  insert('address', '');
  insert('phone', '');
  insert('email', '');
  insert('business_address', '');
  insert('business_phone', '');
  insert('instagram_handle', '');
  insert('tax_registered', 'false');
  insert('gstin', '');
  insert('state_code', '');
  insert('tax_scheme', 'regular');
  insert('billing_type', 'postpaid');
  insert('tables_required', 'true');
  insert('service_model', 'finedine');
  insert('setup_profile', '');
  insert('cloud_server_url', DEFAULT_CLOUD_SERVER_URL);
  insert('cloud_connected', 'false');
  insert('cloud_sync_enabled', '1');
  insert('cloud_orders_enabled', '0');
  insert('cloud_reports_enabled', '1');
  insert('cloud_command_polling_enabled', '1');
  insert('cloud_registration_status', 'unregistered');

  seedCloudSyncDefaults();

  console.log('[DB] Install defaults loaded; first-run setup pending');
}

const SHORT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateShortId(table: string, length = 6): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let id = '';
    for (let i = 0; i < length; i++) id += SHORT_ID_CHARS[Math.floor(Math.random() * SHORT_ID_CHARS.length)];
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
  }
  throw new Error(`generateShortId: could not find unique id for ${table} after 20 attempts`);
}

/** Atomically get the next sequence value for a given name and date. */
function getNextSequence(name: string, date: string): number {
  return db.transaction(() => {
    // Try to update existing row
    const updated = db.prepare(`
      UPDATE sequences SET current_value = current_value + 1
      WHERE name = ? AND date = ?
    `).run(name, date);

    if (updated.changes === 0) {
      // Row doesn't exist for today, insert it
      try {
        db.prepare(`
          INSERT INTO sequences (name, date, current_value) VALUES (?, ?, 1)
        `).run(name, date);
        return 1;
      } catch {
        // Another concurrent insert won the race, try update again
        const retry = db.prepare(`
          UPDATE sequences SET current_value = current_value + 1
          WHERE name = ? AND date = ?
        `).run(name, date);
        if (retry.changes === 0) {
          throw new Error(`Failed to generate sequence for ${name}`);
        }
      }
    }

    const row = db.prepare('SELECT current_value FROM sequences WHERE name = ? AND date = ?')
      .get(name, date) as any;
    return row?.current_value ?? 0;
  })();
}

export function generateOrderNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const next = getNextSequence('orders', date);
  return `ORD-${date}-${String(next).padStart(4, '0')}`;
}

export function generateBillNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const next = getNextSequence('bills', date);
  return `INV-${date}-${String(next).padStart(4, '0')}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** Verify a user PIN against the stored pin_hash. */
export function verifyPin(storedHash: string | null | undefined, inputPin: string | number): boolean {
  if (!storedHash || !inputPin) return false;
  return bcrypt.compareSync(String(inputPin), storedHash);
}

/** Parse JSON string fields on order_item rows returned from SQLite.
 *  Stored as JSON.stringify(value) — may be "null", "[...]", "{...}" etc.
 *  Returns actual JS value (array / object / null) so the frontend can map/iterate. */
export function parseItemJson(item: any): any {
  const tryParse = (val: any) => {
    if (typeof val !== 'string') return val;
    try { return JSON.parse(val); } catch { return val; }
  };
  return {
    ...item,
    addons: tryParse(item.addons),
    variant_selection: tryParse(item.variant_selection),
    modifier_selection: tryParse(item.modifier_selection),
    tax_breakdown: tryParse(item.tax_breakdown),
  };
}

/** Parse JSON text columns on bill/order rows returned from SQLite. */
export function parseRowJson(row: any): any {
  if (!row) return row;
  const tryParse = (val: any) => {
    if (typeof val !== 'string') return val;
    try { return JSON.parse(val); } catch { return val; }
  };

  // tax_breakdown is stored as an array of per-item breakdowns (array of arrays).
  // Aggregate into a flat array of { title, rate, amount } for the frontend.
  let taxBreakdown = tryParse(row.tax_breakdown);
  if (Array.isArray(taxBreakdown) && taxBreakdown.length > 0 && Array.isArray(taxBreakdown[0])) {
    const merged: Record<string, { title: string; rate: number; amount: number }> = {};
    for (const itemBreakdown of taxBreakdown) {
      if (!Array.isArray(itemBreakdown)) continue;
      for (const line of itemBreakdown) {
        const key = `${line.title}_${line.rate}`;
        if (!merged[key]) {
          merged[key] = { title: line.title, rate: line.rate, amount: 0 };
        }
        merged[key].amount += line.amount;
      }
    }
    taxBreakdown = Object.values(merged).map((line) => ({
      ...line,
      amount: Math.round(line.amount * 100) / 100,
    }));
  }

  return {
    ...row,
    tax_breakdown: taxBreakdown,
    payment_details: tryParse(row.payment_details),
  };
}
