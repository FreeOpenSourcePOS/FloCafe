import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';
import * as fs from 'fs';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { BUNDLED_COUNTRY_PACKS, bundledPackVersionId } from './tax-packs/bundled';

let db: Database.Database;
let dbHealthError: string | null = null;

// Database backup, restore, and wipe operations must not overlap. The lock is
// a FIFO promise chain so a rejected operation cannot strand later work.
let databaseMaintenanceTail: Promise<void> = Promise.resolve();

export function withDatabaseMaintenanceLock<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = databaseMaintenanceTail;
  let release!: () => void;
  databaseMaintenanceTail = new Promise<void>((resolve) => { release = resolve; });
  return previous.then(operation).finally(release);
}

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

export function upsertSettings(entries: Record<string, string | undefined | null>): void {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, val] of Object.entries(entries)) {
    if (val !== undefined) stmt.run(key, val ?? '', now());
  }
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
  dbHealthError = null;
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

/** Locally-cached RevFlo pairing code (plaintext) — FloAdmin only ever returns it once. */
export function getCachedPairingCode(): { code: string; expiresAt: string } | null {
  const code = getSettingValue('mobile_pairing_code');
  const expiresAt = getSettingValue('mobile_pairing_code_expires_at');
  if (!code || !expiresAt) return null;
  if (new Date(expiresAt).getTime() <= Date.now()) return null;
  return { code, expiresAt };
}

export function setCachedPairingCode(code: string, expiresAt: string): void {
  upsertSetting('mobile_pairing_code', code);
  upsertSetting('mobile_pairing_code_expires_at', expiresAt);
}

/** Random UUID, generated once and persisted — never derived from store/device identity. */
export function ensureTelemetryAnonId(): string {
  let anonId = getSettingValue('telemetry_anon_id');
  if (!anonId) {
    anonId = crypto.randomUUID();
    upsertSetting('telemetry_anon_id', anonId);
  }
  return anonId;
}

/**
 * Anonymous usage telemetry is on by default for new installs and is switched
 * off in Settings > Privacy. First-run setup discloses it rather than asking:
 * a pre-ticked consent box is not valid consent, so we do not present one.
 * Tier 2 store-attributed diagnostics is a separate, explicit opt-in and is
 * never bundled into this stream.
 */
export function isTelemetryEnabled(): boolean {
  return getSettingValue('telemetry_enabled') === 'true';
}

/**
 * Tier 2 store-attributed diagnostics, kept separate from anonymous telemetry.
 * New installs default to enabled; an owner can switch it off in Settings.
 */
export function isDiagnosticsConsentEnabled(): boolean {
  return getSettingValue('diagnostics_consent') !== 'false';
}

/**
 * Kitchen Display System on/off switch (issue #133). Defaults to enabled
 * (missing/anything but the literal 'false') so pre-existing installs that
 * predate this setting keep their current always-on behavior.
 */
export function isKdsEnabled(): boolean {
  return getSettingValue('kds_enabled') !== 'false';
}

/**
 * KOT ticket printing on/off switch (issue #133) — coarser than
 * `auto_print_kot` (which only gates *automatic* printing on order
 * placement). When this is off, no KOT print command may be sent,
 * automatic or manual. Defaults to enabled, same reasoning as isKdsEnabled.
 */
export function isKotPrintingEnabled(): boolean {
  return getSettingValue('kot_printing_enabled') !== 'false';
}

export function upsertTelemetryLastPing(): void {
  upsertSetting('telemetry_last_ping_at', now());
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
    db = null as unknown as Database.Database;
    console.log('[DB] Database closed');
  }
}

export async function createBackupUnlocked(targetPath?: string): Promise<{ path: string; schemaVersion: number }> {
  // Internal callers must already hold withDatabaseMaintenanceLock().
  console.log('[DB] createBackup: Starting...');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uniqueSuffix = crypto.randomBytes(4).toString('hex');
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Always write to a temp path inside userData first. On MAS, the sandbox
  // only grants access to the user-selected file itself — opening the backup
  // DB in WAL mode would try to create .db-wal/.db-shm siblings next to the
  // user-selected file, which the sandbox blocks. Writing to userData first
  // avoids that restriction; we copy the final clean file to targetPath.
  const tempPath = path.join(backupDir, `flo-backup-${timestamp}-${uniqueSuffix}.db`);
  const finalPath = targetPath || tempPath;
  let completed = false;

  try {
    console.log('[DB] createBackup: Backing up to temp:', tempPath);
    await db.backup(tempPath);

    let currentVersion = 0;
    let backupDb: Database.Database | undefined;
    try {
      backupDb = new Database(tempPath);
      // Switch to DELETE journal mode: checkpoints WAL and removes
      // .db-wal/.db-shm so the final file is self-contained.
      backupDb.pragma('journal_mode = DELETE');
      backupDb.exec(`
        CREATE TABLE IF NOT EXISTS _flo_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      currentVersion = getCurrentSchemaVersion();
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('schema_version', String(currentVersion));
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('backup_created_at', new Date().toISOString());
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('app_version', app.getVersion());
    } finally {
      backupDb?.close();
    }

    if (finalPath !== tempPath) {
      fs.copyFileSync(tempPath, finalPath);
      fs.unlinkSync(tempPath);
    }
    for (const sidecar of [`${finalPath}-wal`, `${finalPath}-shm`]) {
      try { if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar); } catch { }
    }
    if (finalPath !== tempPath) {
      console.log(`[DB] Backup saved to: ${finalPath} (schema v${currentVersion})`);
    } else {
      console.log(`[DB] Backup created: ${finalPath} (schema v${currentVersion})`);
    }

    completed = true;
    return { path: finalPath, schemaVersion: currentVersion };
  } finally {
    if (!completed) {
      for (const filePath of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
      }
    }
  }
}

export function createBackup(targetPath?: string): Promise<{ path: string; schemaVersion: number }> {
  return withDatabaseMaintenanceLock(() => createBackupUnlocked(targetPath));
}

function removeDatabaseFiles(dbPath: string): string[] {
  const failures: string[] = [];
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error: any) {
      console.warn(`[DB] Could not remove ${filePath}:`, error);
      failures.push(filePath);
    }
  }
  return failures;
}

/**
 * Creates the safety backup and resets the live database while holding the
 * same maintenance lock used by ordinary backups. On a failed wipe/reopen,
 * restore the safety backup before surfacing the error so callers never see a
 * false success or an intentionally closed database.
 */
export async function resetDatabaseWithBackup(): Promise<{ backupPath: string }> {
  return withDatabaseMaintenanceLock(async () => {
    const { path: backupPath } = await createBackupUnlocked();
    const dbPath = getDbPath();

    try {
      closeDatabase();
      const failures = removeDatabaseFiles(dbPath);
      if (failures.length > 0) {
        throw new Error(`Could not remove database files: ${failures.join(', ')}`);
      }
      initDatabase();
      return { backupPath };
    } catch (error: any) {
      // Reopen the pre-wipe snapshot so a partial filesystem failure cannot
      // leave the process serving an empty or closed database.
      try {
        closeDatabase();
        removeDatabaseFiles(dbPath);
        fs.copyFileSync(backupPath, dbPath);
        initDatabase();
      } catch (recoveryError: any) {
        throw new Error(
          `Database reset failed: ${error?.message || 'unknown error'}; ` +
          `database recovery also failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
      throw error;
    }
  });
}

/** Reads the schema_version stamp createBackup() writes into _flo_meta. Older backups predating that stamp (or a file that fails to open) return null. */
function readBackupSchemaVersion(fullPath: string): number | null {
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(fullPath, { readonly: true, fileMustExist: true });
    const row = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : null;
  } catch {
    return null;
  } finally {
    backupDb?.close();
  }
}

/**
 * Lists backups in the managed backups/ directory, newest first. Only
 * backups written by createBackup()/syncBackupBeforeMigration() live here —
 * a backup saved to a user-chosen custom path (via the Export Backup /
 * "choose location" flow) intentionally does not appear here, same as it
 * never has for the existing File > Export Backup menu action. See #120.
 */
export function listBackups(): { fileName: string; path: string; sizeBytes: number; createdAt: string; kind: 'manual' | 'auto'; schemaVersion: number | null }[] {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];

  return fs.readdirSync(backupDir)
    .filter((fileName) => fileName.startsWith('flo-backup-') && fileName.endsWith('.db'))
    .map((fileName) => {
      const fullPath = path.join(backupDir, fileName);
      const stat = fs.statSync(fullPath);
      return {
        fileName,
        path: fullPath,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        kind: (fileName.includes('-pre-v') ? 'auto' : 'manual') as 'manual' | 'auto',
        schemaVersion: readBackupSchemaVersion(fullPath),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Deletes one backup from the managed backups/ directory by file name.
 * fileName is validated against the exact naming scheme createBackup() uses
 * and resolved only inside backupDir, so a path-traversal fileName (e.g.
 * `../../flo.db`) can't escape the backups folder or delete the live DB.
 */
export function deleteBackup(fileName: string): void {
  if (!/^flo-backup-[\w.-]+\.db$/.test(fileName)) {
    throw new Error('Invalid backup file name');
  }
  const backupDir = getBackupDir();
  const fullPath = path.join(backupDir, fileName);
  if (path.dirname(fullPath) !== backupDir) {
    throw new Error('Invalid backup file name');
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error('Backup not found');
  }
  fs.unlinkSync(fullPath);
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

function validateDirectBackup(backupPath: string, currentDb: Database.Database, currentVersion: number): string | null {
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const metaRow = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    const metadataVersion = metaRow ? Number.parseInt(metaRow.value, 10) : 0;
    const pragmaVersion = Number(backupDb.pragma('user_version', { simple: true }));
    if (metadataVersion !== currentVersion || pragmaVersion !== currentVersion) {
      return `Direct restore requires matching metadata/header schema v${currentVersion}`;
    }

    const integrity = backupDb.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.some((row) => row.integrity_check !== 'ok')) {
      return `Backup integrity check failed: ${integrity.map((row) => row.integrity_check).join('; ')}`;
    }
    const foreignKeyViolations = backupDb.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length > 0) {
      return `Backup contains ${foreignKeyViolations.length} foreign-key violation(s)`;
    }

    const currentTables = getTables(currentDb);
    const backupTables = new Set(getTables(backupDb));
    const missingTables = currentTables.filter((tableName) => !backupTables.has(tableName));
    if (missingTables.length > 0) {
      return `Backup is missing required table(s): ${missingTables.join(', ')}`;
    }

    for (const tableName of currentTables) {
      const backupColumns = new Set(getColumns(backupDb, tableName));
      const missingColumns = getColumns(currentDb, tableName).filter((column) => !backupColumns.has(column));
      if (missingColumns.length > 0) {
        return `Backup table ${tableName} is missing required column(s): ${missingColumns.join(', ')}`;
      }
    }
    return null;
  } catch (error: any) {
    return `Backup validation failed: ${error?.message || 'unknown error'}`;
  } finally {
    backupDb?.close();
  }
}

type RevocationRow = { token_hash: string; expires_at: number; revoked_at: string };
export type UserStationSecurityState = { user_id: string; station_id: string };

export function captureUserStationSecurityState(dbInstance: Database.Database): UserStationSecurityState[] {
  try {
    return dbInstance.prepare('SELECT user_id, station_id FROM station_users').all() as UserStationSecurityState[];
  } catch {
    return [];
  }
}

export function mergeUserStationSecurityState(dbInstance: Database.Database, rows: UserStationSecurityState[], userIds: string[]): void {
  const preservedIds = new Set(userIds);
  const currentUsers = dbInstance.prepare('SELECT id FROM users').all() as { id: string }[];
  for (const user of currentUsers) {
    dbInstance.prepare('DELETE FROM station_users WHERE user_id = ?').run(user.id);
  }
  const insert = dbInstance.prepare('INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)');
  const stationExists = dbInstance.prepare('SELECT 1 FROM kitchen_stations WHERE id = ?');
  for (const row of rows) {
    if (preservedIds.has(row.user_id) && stationExists.get(row.station_id)) {
      insert.run(row.user_id, row.station_id, now());
    }
  }
}

export type UserSecurityState = {
  id: string;
  password: string;
  pin: string | null;
  pin_hash: string | null;
  role: string;
  category_ids: string | null;
  is_active: number;
  tokens_valid_after: string | null;
};

export function getUserKdsStationIds(dbInstance: Database.Database, userId: string): string[] | null {
  try {
    return (dbInstance.prepare('SELECT station_id FROM station_users WHERE user_id = ?').all(userId) as { station_id: string }[])
      .map((row) => String(row.station_id));
  } catch {
    return null;
  }
}

export function captureUserSecurityState(dbInstance: Database.Database): UserSecurityState[] {
  try {
    return dbInstance.prepare('SELECT id, password, pin, pin_hash, role, category_ids, is_active, tokens_valid_after FROM users').all() as UserSecurityState[];
  } catch {
    return [];
  }
}

export function mergeUserSecurityState(dbInstance: Database.Database, rows: UserSecurityState[]): void {
  for (const row of rows) {
    const restored = dbInstance.prepare('SELECT id, is_active, tokens_valid_after FROM users WHERE id = ?').get(row.id) as UserSecurityState | undefined;
    if (!restored) continue;
    const currentEpoch = row.tokens_valid_after;
    const restoredEpoch = restored.tokens_valid_after;
    const currentParsedTime = currentEpoch ? parseDbTimestamp(currentEpoch).getTime() : Number.NaN;
    const restoredParsedTime = restoredEpoch ? parseDbTimestamp(restoredEpoch).getTime() : Number.NaN;
    const currentTime = Number.isFinite(currentParsedTime) ? currentParsedTime : Number.NEGATIVE_INFINITY;
    const restoredTime = Number.isFinite(restoredParsedTime) ? restoredParsedTime : Number.NEGATIVE_INFINITY;
    const tokensValidAfter = currentTime >= restoredTime ? currentEpoch : restoredEpoch;
    dbInstance.prepare(`
      UPDATE users
      SET password = ?, pin = ?, pin_hash = ?, role = ?, category_ids = ?,
          is_active = ?, tokens_valid_after = ?
      WHERE id = ?
    `).run(
      row.password, row.pin, row.pin_hash, row.role, row.category_ids,
      row.is_active === 0 || restored.is_active === 0 ? 0 : 1,
      tokensValidAfter,
      row.id,
    );
  }

  // Accounts introduced only by an older snapshot must not become a new
  // login path without an explicit owner reactivation.
  const preservedIds = new Set(rows.map((row) => row.id));
  const restoredUsers = dbInstance.prepare('SELECT id FROM users').all() as { id: string }[];
  const disableRestoredOnly = dbInstance.prepare('UPDATE users SET is_active = 0, tokens_valid_after = ? WHERE id = ?');
  for (const user of restoredUsers) {
    if (!preservedIds.has(user.id)) disableRestoredOnly.run(now(), user.id);
  }
}

function readRevocations(dbInstance: Database.Database): RevocationRow[] {
  try {
    return dbInstance.prepare('SELECT token_hash, expires_at, revoked_at FROM revoked_tokens').all() as RevocationRow[];
  } catch {
    return [];
  }
}

function mergeRevocations(dbInstance: Database.Database, rows: RevocationRow[]): void {
  if (rows.length === 0) return;
  const merge = dbInstance.prepare(`
    INSERT INTO revoked_tokens (token_hash, expires_at, revoked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      expires_at = MAX(revoked_tokens.expires_at, excluded.expires_at),
      revoked_at = MIN(revoked_tokens.revoked_at, excluded.revoked_at)
  `);
  for (const row of rows) merge.run(row.token_hash, row.expires_at, row.revoked_at);
}

export function restoreBackup(backupPath: string, forceDirect: boolean = false): RestoreResult {
  console.log('[DB] restoreBackup: Starting restore from:', backupPath);

  let metadataVersion = 0;
  let pragmaVersion = 0;
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const metaRow = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    metadataVersion = metaRow ? Number.parseInt(metaRow.value, 10) : 0;
    pragmaVersion = Number(backupDb.pragma('user_version', { simple: true }));
  } finally {
    backupDb?.close();
  }

  // The SQLite header is authoritative for what initDatabase() will open. A
  // forged/stale _flo_meta stamp must not let forceDirect replace the live DB
  // with a database this build cannot migrate or serve.
  const backupSchemaVersion = Number.isFinite(metadataVersion) && metadataVersion > 0
    ? metadataVersion
    : pragmaVersion;
  const currentDb = getDatabase();
  const currentVersion = getCurrentSchemaVersion();
  // Never let restoring an older snapshot resurrect a token that was revoked
  // after that snapshot was created.
  const preservedRevocations = readRevocations(currentDb);
  const preservedUserSecurity = captureUserSecurityState(currentDb);
  const preservedUserStations = captureUserStationSecurityState(currentDb);

  console.log(`[DB] Backup schema version: ${backupSchemaVersion}, SQLite: ${pragmaVersion}, Current: ${currentVersion}`);

  if (forceDirect && pragmaVersion > currentVersion) {
    return {
      success: false,
      mode: 'direct',
      backupSchemaVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: `Direct restore rejected: backup schema v${pragmaVersion} is newer than supported schema v${currentVersion}`,
    };
  }

  if (forceDirect || backupSchemaVersion === currentVersion) {
    const validationError = validateDirectBackup(backupPath, currentDb, currentVersion);
    if (validationError) {
      return {
        success: false,
        mode: 'direct',
        backupSchemaVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored: 0,
        error: validationError,
      };
    }

    console.log('[DB] restoreBackup: Direct restore (same schema version)');
    const dbPath = getDbPath();
    const recoveryPath = path.join(getBackupDir(), `flo-restore-recovery-${crypto.randomBytes(8).toString('hex')}.db`);

    // Checkpoint the live WAL before making a synchronous recovery copy.
    currentDb.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(dbPath, recoveryPath);
    closeDatabase();

    try {
      removeDatabaseFiles(dbPath);
      fs.copyFileSync(backupPath, dbPath);
      initDatabase();

      const freshDb = getDatabase();
      mergeUserSecurityState(freshDb, preservedUserSecurity);
      mergeUserStationSecurityState(freshDb, preservedUserStations, preservedUserSecurity.map((row) => row.id));
      mergeRevocations(freshDb, preservedRevocations);
      const integrity = freshDb.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      const foreignKeyViolations = freshDb.prepare('PRAGMA foreign_key_check').all();
      if (
        integrity.some((row) => row.integrity_check !== 'ok') ||
        foreignKeyViolations.length > 0
      ) {
        throw new Error('Restored database failed integrity validation');
      }
      return {
        success: true,
        mode: 'direct',
        backupSchemaVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored: getTables(freshDb).length,
      };
    } catch (error: any) {
      // A corrupt/incompatible same-version file must not strand the live
      // database. Restore the checkpointed safety copy before rethrowing.
      try {
        closeDatabase();
        removeDatabaseFiles(dbPath);
        fs.copyFileSync(recoveryPath, dbPath);
        initDatabase();
      } catch (recoveryError: any) {
        throw new Error(
          `Direct restore failed: ${error?.message || 'unknown error'}; ` +
          `live database recovery failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
      throw error;
    } finally {
      try { if (fs.existsSync(recoveryPath)) fs.unlinkSync(recoveryPath); } catch { }
    }
  }

  console.log('[DB] restoreBackup: Data-only restore (schema version mismatch)');
  return dataOnlyRestore(backupPath, backupSchemaVersion, currentVersion, preservedRevocations, preservedUserSecurity, preservedUserStations);
}

/** Return true only if the string is a safe SQL identifier (letters, digits, underscore). */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function dataOnlyRestore(
  backupPath: string,
  backupVersion: number,
  currentVersion: number,
  preservedRevocations: RevocationRow[] = [],
  preservedUserSecurity: UserSecurityState[] = [],
  preservedUserStations: UserStationSecurityState[] = [],
): RestoreResult {
  // Read metadata and columns before ATTACH. Keeping a separate read-only
  // handle open while detaching the same file causes SQLITE_BUSY/locked.
  let backupDb: Database.Database | undefined;
  let backupTables: string[] = [];
  const backupColumns = new Map<string, string[]>();
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    backupTables = getTables(backupDb);
    for (const tableName of backupTables) {
      if (isSafeIdentifier(tableName)) backupColumns.set(tableName, getColumns(backupDb, tableName));
    }
  } finally {
    backupDb?.close();
  }

  const currentDb = getDatabase();
  const currentTables = getTables(currentDb);
  const commonTables = backupTables.filter((tableName) => currentTables.includes(tableName));
  const previousForeignKeys = Number(currentDb.pragma('foreign_keys', { simple: true })) === 1;
  let attached = false;
  let inTransaction = false;
  let tablesRestored = 0;

  // Existing failed versions of this function could strand this alias on the
  // long-lived connection. Remove it before attempting a fresh restore.
  try {
    const attachedDatabases = currentDb.prepare('PRAGMA database_list').all() as { name: string }[];
    if (attachedDatabases.some((entry) => entry.name === '_restore_src')) {
      currentDb.exec('DETACH DATABASE _restore_src');
    }
  } catch (error: any) {
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: `Could not clear a previous restore attachment: ${error?.message || 'unknown error'}`,
    };
  }

  try {
    // FK enforcement must be disabled before BEGIN. With it off, deleting a
    // common parent does not cascade-delete current-only child tables that an
    // older backup does not contain. The final check below protects commit.
    currentDb.pragma('foreign_keys = OFF');
    const safeBackupPath = backupPath.replace(/'/g, "''");
    currentDb.exec(`ATTACH DATABASE '${safeBackupPath}' AS _restore_src`);
    attached = true;
    currentDb.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    for (const tableName of commonTables) {
      if (!isSafeIdentifier(tableName)) {
        console.warn(`[DB] dataOnlyRestore: skipping unsafe table: ${JSON.stringify(tableName)}`);
        continue;
      }

      const currentColumns = getColumns(currentDb, tableName);
      const commonColumns = (backupColumns.get(tableName) || [])
        .filter((column) => currentColumns.includes(column))
        .filter((column) => {
          if (isSafeIdentifier(column)) return true;
          console.warn(`[DB] dataOnlyRestore: skipping unsafe column: ${JSON.stringify(column)} in ${tableName}`);
          return false;
        });

      if (commonColumns.length === 0) continue;

      const columnList = commonColumns.join(', ');
      currentDb.exec(`DELETE FROM ${tableName}`);
      currentDb.exec(`INSERT INTO ${tableName} (${columnList}) SELECT ${columnList} FROM _restore_src.${tableName}`);

      tablesRestored++;
      console.log(`[DB] Restored ${tableName}: ${commonColumns.length} columns`);
    }

    mergeUserSecurityState(currentDb, preservedUserSecurity);
    mergeUserStationSecurityState(currentDb, preservedUserStations, preservedUserSecurity.map((row) => row.id));
    mergeRevocations(currentDb, preservedRevocations);
    const foreignKeyViolations = currentDb.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(`Restore would leave ${foreignKeyViolations.length} foreign-key violation(s)`);
    }

    // SQLite does not allow DETACH while a write transaction is active.
    // Commit only after the integrity check, then detach the already-closed
    // source handle immediately so the long-lived connection stays clean.
    currentDb.exec('COMMIT');
    inTransaction = false;
    try {
      currentDb.exec('DETACH DATABASE _restore_src');
      attached = false;
    } catch (detachError: any) {
      // Once committed, a detach failure cannot be rolled back. Reopening the
      // main connection drops every attachment and gives the caller a clean,
      // usable handle instead of reporting a false failure with live data
      // already changed.
      try {
        closeDatabase();
        initDatabase();
        attached = false;
      } catch (recoveryError: any) {
        throw new Error(
          `Restore committed but source cleanup failed: ${detachError?.message || 'unknown error'}; ` +
          `database reopen also failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
    }

    return {
      success: true,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored,
    };
  } catch (error: any) {
    if (inTransaction) {
      try { currentDb.exec('ROLLBACK'); } catch { }
      inTransaction = false;
    }
    console.error('[DB] dataOnlyRestore failed:', error);
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: error?.message || 'Restore failed',
    };
  } finally {
    if (attached) {
      try { currentDb.exec('DETACH DATABASE _restore_src'); } catch { }
    }
    try {
      getDatabase().pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    } catch { }
  }
}


export function getSchemaVersionFromBackup(backupPath: string): number | null {
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const metaRow = backupDb.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    if (!metaRow) return null;
    const version = Number.parseInt(metaRow.value, 10);
    return Number.isFinite(version) && version >= 0 ? version : null;
  } catch {
    return null;
  } finally {
    backupDb?.close();
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
  idealDb.pragma('foreign_keys = OFF'); // Off during migrations
  const previousDb = db;
  db = idealDb;
  try {
    runMigrations();
  } finally {
    db = previousDb;
  }
  idealDb.pragma('foreign_keys = ON');
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
      // country_code only exists in createSchema()'s CREATE TABLE, which is
      // a no-op (IF NOT EXISTS) for any install whose customers table
      // predates that column being added — this migration is the first
      // thing to actually read/write it, and was crashing with "no such
      // column: country_code" on every such upgrade (reported on a fresh
      // Windows install of v1.9.7). Guard it here instead of assuming it's
      // there.
      if (!getColumns(db, 'customers').includes('country_code')) {
        db.exec(`ALTER TABLE customers ADD COLUMN country_code TEXT DEFAULT '+91'`);
      }

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
  {
    version: 25,
    name: 'add_order_item_addons_table',
    up: () => {
      // Selected addons are snapshotted as JSON on order_items.addons. That
      // works for print/receipt display but makes addon reporting ("addons
      // sold by day/product/station") require JSON parsing instead of
      // indexed SQL, and ambiguous parsed-vs-raw-JSON typing already caused
      // a KOT print failure (see 02a511e). Add a normalized snapshot table
      // and backfill it from existing rows. order_items.addons stays the
      // read-path source of truth for now — this migration only adds the
      // table and starts populating it; see issue #125.
      db.exec(`
        CREATE TABLE IF NOT EXISTS order_item_addons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_item_id INTEGER NOT NULL,
          addon_id TEXT,
          addon_name TEXT NOT NULL,
          price NUMERIC NOT NULL DEFAULT 0,
          quantity INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
          FOREIGN KEY (addon_id) REFERENCES addons(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_order_item_addons_order_item_id ON order_item_addons(order_item_id);
        CREATE INDEX IF NOT EXISTS idx_order_item_addons_addon_id ON order_item_addons(addon_id);
      `);

      const rows = db.prepare(
        `SELECT id, addons, created_at FROM order_items WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'`
      ).all() as { id: number; addons: string; created_at: string }[];

      let backfilled = 0, skipped = 0;
      for (const row of rows) {
        let parsed: any;
        try {
          parsed = JSON.parse(row.addons);
        } catch {
          skipped++;
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        insertOrderItemAddons(db, row.id, parsed, row.created_at || now());
        backfilled++;
      }
      console.log(`[MIGRATION v25] backfilled addons for ${backfilled} order items (${skipped} unparseable, skipped)`);
    },
  },
  {
    version: 26,
    name: 'add_kds_default_view',
    up: () => {
      db.prepare(
        `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('kds_default_view', 'tabs', ?)`
      ).run(now());
    },
  },
  {
    version: 27,
    name: 'add_station_printer_link_and_user_stations',
    up: () => {
      // Links a kitchen station to a printer row instead of duplicating
      // ip/port/name inline, and lets a staff login (or shared counter
      // login) be assigned to one or more stations. See issue #134.
      const stationColumns = getColumns(db, 'kitchen_stations');
      if (!stationColumns.includes('printer_id')) {
        db.exec(`ALTER TABLE kitchen_stations ADD COLUMN printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS station_users (
          user_id TEXT NOT NULL,
          station_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, station_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (station_id) REFERENCES kitchen_stations(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 28,
    name: 'seed_telemetry_settings',
    up: () => {
      // Installs that ran first-run setup before telemetry was added (v1.9.4)
      // never had these rows written — loadInstallDefaults() only runs on a
      // fresh DB. INSERT OR IGNORE is safe: fresh installs already have them.
      // All default to off so existing installs stay opted-out.
      const t = now();
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('anonymous_data_consent', 'false', ?)`).run(t);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'false', ?)`).run(t);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_scope', 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics', ?)`).run(t);
    },
  },
  {
    version: 29,
    name: 'whatsapp_messaging',
    up: () => {
      createWhatsAppSchema();
      seedWhatsAppDefaults();
    },
  },
  {
    version: 30,
    name: 'drop_order_items_addons_json_column',
    up: () => {
      // order_item_addons (v25) has been the sole write target for selected
      // addons for a while now, and every read path was moved onto it in the
      // same release this migration ships in — order_items.addons is no
      // longer written or read anywhere in the app. This is the cleanup: one
      // more backfill sweep (belt-and-braces — v25 already ran, but this
      // catches anything created between then and the dual-write existing,
      // or any hand-edited row), then drop the column outright rather than
      // leave a dead, unused JSON copy sitting in the schema. See issue #125.
      const columns = getColumns(db, 'order_items');
      if (!columns.includes('addons')) return; // already dropped (idempotent re-run)

      const rows = db.prepare(`
        SELECT id, addons, created_at FROM order_items
        WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'
          AND NOT EXISTS (SELECT 1 FROM order_item_addons WHERE order_item_id = order_items.id)
      `).all() as { id: number; addons: string; created_at: string }[];

      let backfilled = 0;
      const unrecoverable: number[] = [];
      for (const row of rows) {
        let parsed: any;
        try {
          parsed = JSON.parse(row.addons);
        } catch {
          unrecoverable.push(row.id);
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        insertOrderItemAddons(db, row.id, parsed, row.created_at || now());
        backfilled++;
      }
      console.log(`[MIGRATION v30] backfilled ${backfilled} order_item(s) still missing a normalized addons snapshot`);

      if (unrecoverable.length > 0) {
        console.warn(`[MIGRATION v30] ${unrecoverable.length} order_item row(s) have unparseable legacy addons JSON (ids: ${unrecoverable.join(', ')}) and could not be migrated. Leaving the addons column in place so this data isn't lost — please review these rows manually.`);
        return;
      }

      const remaining = (db.prepare(`
        SELECT COUNT(*) as count FROM order_items
        WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'
          AND NOT EXISTS (SELECT 1 FROM order_item_addons WHERE order_item_id = order_items.id)
      `).get() as { count: number }).count;

      if (remaining > 0) {
        console.warn(`[MIGRATION v30] ${remaining} order_item row(s) still lack a normalized addons snapshot after backfill — skipping the column drop this run.`);
        return;
      }

      db.exec('ALTER TABLE order_items DROP COLUMN addons');
      console.log('[MIGRATION v30] Dropped order_items.addons — order_item_addons is now the only place selected addons live.');
    },
  },
  {
    version: 31,
    name: 'add_customers_tag_counts_column',
    up: () => {
      // tag_counts, like country_code (fixed in v23's guard above), only
      // ever existed in createSchema()'s CREATE TABLE — no migration added
      // it for installs whose customers table predates it. Unlike
      // country_code this isn't just a startup-migration crash: it's read
      // and written on every order for a returning customer
      // (routes/orders.ts), so any affected install would crash there
      // instead, mid-use rather than at launch.
      if (!getColumns(db, 'customers').includes('tag_counts')) {
        db.exec(`ALTER TABLE customers ADD COLUMN tag_counts TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 32,
    name: 'add_kds_and_kot_printing_toggles',
    up: () => {
      // Independent on/off switches for the Kitchen Display System and for
      // KOT ticket printing (issue #133) — not every business runs both.
      // Default 'true' on both to match the pre-toggle always-on behavior
      // existing installs already have.
      insertSettingIfMissing('kds_enabled', 'true');
      insertSettingIfMissing('kot_printing_enabled', 'true');
    },
  },
  {
    version: 33,
    name: 'add_addon_groups_allow_multiple_quantities',
    up: () => {
      if (!getColumns(db, 'addon_groups').includes('allow_multiple_quantities')) {
        db.exec(`ALTER TABLE addon_groups ADD COLUMN allow_multiple_quantities INTEGER DEFAULT 0`);
      }
    },
  },
  {
    version: 34,
    name: 'add_order_items_voided_at',
    up: () => {
      // Issue #150: voiding an in-progress (preparing/ready) item marks it
      // status='voided' instead of hard-cancelling it, so the kitchen display
      // can show it struck-through for a grace period before it drops off the
      // board. voided_at is that timestamp anchor.
      if (!getColumns(db, 'order_items').includes('voided_at')) {
        db.exec(`ALTER TABLE order_items ADD COLUMN voided_at TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 35,
    name: 'add_tax_pack_configuration_tables',
    up: () => {
      createTaxPackSchema();
    },
  },
  {
    version: 36,
    name: 'add_product_and_addon_tax_categories',
    up: () => {
      const productColumns = getColumns(db, 'products');
      if (!productColumns.includes('tax_category_id')) {
        db.exec(`ALTER TABLE products ADD COLUMN tax_category_id TEXT DEFAULT NULL`);
      }
      if (!productColumns.includes('tax_behavior')) {
        db.exec(`ALTER TABLE products ADD COLUMN tax_behavior TEXT DEFAULT 'country_default'`);
      }

      const addonColumns = getColumns(db, 'addons');
      if (!addonColumns.includes('tax_category_id')) {
        db.exec(`ALTER TABLE addons ADD COLUMN tax_category_id TEXT DEFAULT NULL`);
      }
      if (!addonColumns.includes('tax_behavior')) {
        db.exec(`ALTER TABLE addons ADD COLUMN tax_behavior TEXT DEFAULT 'country_default'`);
      }
      if (!addonColumns.includes('inherit_parent_tax_category')) {
        db.exec(`ALTER TABLE addons ADD COLUMN inherit_parent_tax_category INTEGER DEFAULT 1`);
      }
    },
  },
  {
    version: 37,
    name: 'add_transaction_tax_snapshots_and_charge_categories',
    up: () => {
      const orderColumns = getColumns(db, 'orders');
      if (!orderColumns.includes('tax_snapshot')) {
        db.exec(`ALTER TABLE orders ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
      if (!orderColumns.includes('packaging_tax_category_id')) {
        db.exec(`ALTER TABLE orders ADD COLUMN packaging_tax_category_id TEXT DEFAULT NULL`);
      }
      if (!orderColumns.includes('delivery_tax_category_id')) {
        db.exec(`ALTER TABLE orders ADD COLUMN delivery_tax_category_id TEXT DEFAULT NULL`);
      }
      if (!orderColumns.includes('service_charge_tax_category_id')) {
        db.exec(`ALTER TABLE orders ADD COLUMN service_charge_tax_category_id TEXT DEFAULT NULL`);
      }

      if (!getColumns(db, 'order_items').includes('tax_snapshot')) {
        db.exec(`ALTER TABLE order_items ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
      if (!getColumns(db, 'bills').includes('tax_snapshot')) {
        db.exec(`ALTER TABLE bills ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 38,
    name: 'register_bundled_tax_pack_versions',
    up: () => {
      createTaxPackSchema();
      const insertPack = db.prepare(`
        INSERT INTO country_packs (
          id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          publisher = excluded.publisher,
          country = excluded.country,
          jurisdiction = excluded.jurisdiction,
          active_version_id = COALESCE(country_packs.active_version_id, excluded.active_version_id),
          updated_at = excluded.updated_at
      `);
      const insertVersion = db.prepare(`
        INSERT OR IGNORE INTO country_pack_versions (
          id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
          effective_from, effective_to, min_flo_version, published_at, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?)
      `);
      const insertCategory = db.prepare(`
        INSERT OR IGNORE INTO tax_categories (
          id, pack_version_id, category_id, label, default_behavior, definition_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRule = db.prepare(`
        INSERT OR IGNORE INTO tax_rules (
          id, pack_version_id, rule_id, label, calculation_type, rate, amount,
          applies_per, base_rule_ids, definition_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const pack of BUNDLED_COUNTRY_PACKS) {
        const versionId = bundledPackVersionId(pack);
        const packJson = JSON.stringify(pack);
        const installedAt = now();
        const alreadyInstalled = db.prepare(
          'SELECT 1 FROM country_pack_versions WHERE id = ?'
        ).get(versionId);

        insertPack.run(
          pack.id, pack.publisher, pack.country, pack.jurisdiction,
          versionId, installedAt, installedAt,
        );
        insertVersion.run(
          versionId,
          pack.id,
          pack.version,
          pack.schemaVersion,
          JSON.stringify({
            id: pack.id,
            publisher: pack.publisher,
            country: pack.country,
            jurisdiction: pack.jurisdiction,
            version: pack.version,
            publishedAt: pack.publishedAt,
          }),
          packJson,
          sha256Hex(packJson),
          pack.effectiveFrom,
          pack.effectiveTo || null,
          pack.minFloVersion,
          pack.publishedAt,
          installedAt,
        );

        for (const category of pack.categories) {
          insertCategory.run(
            `${versionId}:category:${category.id}`,
            versionId,
            category.id,
            category.label,
            category.defaultBehavior || null,
            JSON.stringify(category),
            installedAt,
          );
        }
        for (const rule of pack.rules) {
          insertRule.run(
            `${versionId}:rule:${rule.id}`,
            versionId,
            rule.id,
            rule.label,
            rule.type,
            rule.rate || null,
            rule.amount || null,
            rule.appliesPer || null,
            JSON.stringify(rule.baseRuleIds || []),
            JSON.stringify(rule),
            installedAt,
          );
        }

        if (!alreadyInstalled) {
          db.prepare(`
            INSERT INTO tax_config_audit (
              action, pack_id, pack_version_id, details_json, created_at
            ) VALUES ('install_bundled_pack', ?, ?, ?, ?)
          `).run(
            pack.id,
            versionId,
            JSON.stringify({ source: 'application_bundle', version: pack.version }),
            installedAt,
          );
        }
      }
    },
  },
  {
    version: 39,
    name: 'add_users_tokens_valid_after',
    up: () => {
      // Backs the JWT-revocation-on-credential-change fix (#173): requireAuth
      // rejects any token whose `iat` predates this `tokens_valid_after`, so changing a
      // password/PIN can invalidate every outstanding session for that user
      // without maintaining a per-token blocklist across devices.
      if (!getColumns(db, 'users').includes('tokens_valid_after')) {
        db.exec(`ALTER TABLE users ADD COLUMN tokens_valid_after TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 40,
    name: 'v2_cloud_defaults_and_tax_toggle',
    up: () => {
      // Seed-written timestamps use SQLite's format without T. An ISO
      // timestamp means the merchant explicitly changed the setting.
      db.prepare(`
        UPDATE settings
           SET value = '1', updated_at = ?
         WHERE key = 'cloud_sync_enabled'
           AND value = '0'
           AND updated_at NOT LIKE '%T%'
      `).run(now());
      db.prepare(`DELETE FROM settings WHERE key = 'cloud_pending_store_id'`).run();
      insertSettingIfMissing('taxes_enabled', 'false');
    },
  },
  {
    version: 41,
    name: 'support_ticket_outbox',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS support_ticket_outbox (
          client_ticket_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
          support_code TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_support_ticket_outbox_retry
          ON support_ticket_outbox(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    version: 42,
    name: 'add_global_cashback_percent',
    up: () => {
      insertSettingIfMissing('global_cashback_percent', '0');
      // Existing cb_percent values are deliberately left alone. Under the
      // tri-state, 0 means "earns nothing" and NULL means "inherit the global
      // rate" — and the old schema default was 0, so rewriting 0 to NULL here
      // would silently opt every product a merchant had excluded back into
      // earning the moment they set a global rate. Products created from here
      // on default to NULL; existing ones adopt the global rate only through
      // the explicit bulk action on the products screen.
    },
  },
  {
    version: 43,
    name: 'telemetry_default_on_for_new_installs',
    up: () => {
      // INSERT OR IGNORE, deliberately: an existing merchant's choice must
      // survive, including an earlier opt-out. Only installs that predate the
      // setting entirely pick up the new default here — every build released
      // so far shipped telemetry on, so this changes nothing for the current
      // fleet and simply keeps a fresh row consistent with seedInstallDefaults.
      const t = now();
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'true', ?)`).run(t);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('anonymous_data_consent', 'true', ?)`).run(t);
      db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_scope', 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics', ?)`).run(t);
    },
  },
  {
    version: 44,
    name: 'store_diagnostics_outbox',
    up: () => {
      // This setting is migrated to the product default in v47. Keep the
      // original schema migration safe for databases upgrading through v44.
      insertSettingIfMissing('diagnostics_consent', 'true');
      db.exec(`
        CREATE TABLE IF NOT EXISTS store_diagnostics_outbox (
          event_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_store_diagnostics_outbox_retry
          ON store_diagnostics_outbox(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    // Performance fixes for ~100k+ orders (issue #208) plus timestamp
    // normalization, in one migration because v40 never shipped outside this
    // PR (upstream's v40-v44 landed first; this is v45). Indexes are all
    // `IF NOT EXISTS` so reruns are safe. Range queries
    // (`created_at >= ? AND created_at < ?`) and the composite used by the
    // orders list pagination both depend on the indexes.
    //
    // The normalization: `now()` used to write ISO-8601 (`...T10:00:00.123Z`)
    // while rows inserted via CURRENT_TIMESTAMP defaults carry SQLite's
    // `YYYY-MM-DD HH:MM:SS` form. Mixed formats break string range compares
    // at day boundaries, intra-day ORDER BY, `expires_at > datetime('now')`
    // expiry checks, and JS `new Date(ts)` parsing (the space form is read as
    // machine-local time). Normalize every legacy ISO row to the space form
    // once, so all rows in a column share one sortable, UTC-wall format.
    // Only rows containing 'T' are touched; each column is verified to exist
    // before the UPDATE so odd legacy installs cannot crash the migration.
    version: 45,
    name: 'add_performance_indexes_and_normalize_timestamps',
    up: () => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
        CREATE INDEX IF NOT EXISTS idx_orders_table_id ON orders(table_id);
        CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(type);
        CREATE INDEX IF NOT EXISTS idx_bills_created_at ON bills(created_at);
        CREATE INDEX IF NOT EXISTS idx_bills_paid_status_paid_at ON bills(payment_status, paid_at);
        CREATE INDEX IF NOT EXISTS idx_bills_customer_id ON bills(customer_id);
        CREATE INDEX IF NOT EXISTS idx_print_logs_bill_id ON print_logs(bill_id);
        CREATE INDEX IF NOT EXISTS idx_ledger_bill_id_type ON loyalty_ledger(bill_id, type);
        CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
        CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at);
        -- idx_bills_paid_at: payment-method breakdown scans paid_at ranges
        -- (including NULL for still-open bills); a plain single-column index
        -- lets the OR optimization use both branches.
        CREATE INDEX IF NOT EXISTS idx_bills_paid_at ON bills(paid_at);
      `);
      const normalize: [string, string][] = [
        ['orders', 'created_at'], ['orders', 'updated_at'],
        ['orders', 'cooking_started_at'], ['orders', 'ready_at'],
        ['orders', 'served_at'], ['orders', 'completed_at'], ['orders', 'cancelled_at'],
        ['order_items', 'created_at'], ['order_items', 'updated_at'], ['order_items', 'voided_at'],
        ['bills', 'created_at'], ['bills', 'updated_at'], ['bills', 'paid_at'], ['bills', 'printed_at'],
        ['customers', 'created_at'], ['customers', 'updated_at'],
        ['users', 'created_at'], ['users', 'updated_at'],
        ['users', 'terms_accepted_at'], ['users', 'tokens_valid_after'],
        ['loyalty_ledger', 'created_at'], ['loyalty_ledger', 'updated_at'], ['loyalty_ledger', 'expires_at'],
        ['products', 'created_at'], ['products', 'updated_at'],
        ['addons', 'created_at'], ['addons', 'updated_at'],
        ['addon_groups', 'created_at'], ['addon_groups', 'updated_at'],
        ['tables', 'created_at'], ['tables', 'updated_at'],
        ['settings', 'updated_at'],
        ['print_logs', 'printed_at'],
        ['order_item_addons', 'created_at'],
        ['whatsapp_messages', 'queued_at'], ['whatsapp_messages', 'seen_at'],
        ['whatsapp_messages', 'typing_at'], ['whatsapp_messages', 'sent_at'],
        ['whatsapp_messages', 'delivered_at'], ['whatsapp_messages', 'read_at'],
        ['whatsapp_messages', 'failed_at'],
        ['whatsapp_blocklist', 'blocked_at'],
        ['held_orders', 'created_at'], ['held_orders', 'updated_at'],
        ['kds_pairing_tokens', 'expires_at'], ['kds_pairing_tokens', 'created_at'],
        // Outbox tables (created by migrations v3/v41, before this one): rows
        // that failed pre-upgrade carry ISO next_attempt_at, which would sort
        // after space-form `now()` and defer retries by up to a day.
        ['cloud_sync_outbox', 'created_at'], ['cloud_sync_outbox', 'updated_at'], ['cloud_sync_outbox', 'next_attempt_at'],
        ['support_ticket_outbox', 'created_at'], ['support_ticket_outbox', 'updated_at'],
        ['support_ticket_outbox', 'next_attempt_at'], ['support_ticket_outbox', 'delivered_at'],
      ];
      for (const [table, column] of normalize) {
        if (!getColumns(db, table).includes(column)) continue;
        // '2026-08-01T10:00:00.123Z' -> '2026-08-01 10:00:00' (second precision,
        // matching now()/CURRENT_TIMESTAMP). Milliseconds are never relied on.
        db.prepare(
          `UPDATE ${table} SET ${column} = substr(REPLACE(${column}, 'T', ' '), 1, 19) WHERE ${column} LIKE '%T%'`
        ).run();
      }
    },
  },
  {
    version: 46,
    name: 'normalize_cloud_enabled_flags_to_01',
    up: () => {
      // cloud_sync_enabled/cloud_orders_enabled/cloud_reports_enabled/
      // cloud_command_polling_enabled are meant to mirror FloAdmin's own
      // `stores` table and are read as a strict '1' check everywhere in
      // cloud-sync.ts — but both the setup wizard (auth.ts) and the Settings
      // → Cloud route wrote 'true'/'false' instead, so any store that ever
      // completed setup or saved that settings page silently never matched
      // the '1' check: cloud sync, order/report sync, command polling, and
      // RevFlo pairing's auto-registration all quietly stopped working.
      const flags = ['cloud_sync_enabled', 'cloud_orders_enabled', 'cloud_reports_enabled', 'cloud_command_polling_enabled'];
      const toOne = db.prepare(`UPDATE settings SET value = '1' WHERE key = ? AND value = 'true'`);
      const toZero = db.prepare(`UPDATE settings SET value = '0' WHERE key = ? AND value = 'false'`);
      for (const key of flags) {
        toOne.run(key);
        toZero.run(key);
      }
    },
  },
  {
    version: 47,
    name: 'store_diagnostics_enabled_by_default',
    up: () => {
      // New installs already receive the v44/v47 default. Preserve an existing
      // false value because it may represent an owner's explicit opt-out.
      insertSettingIfMissing('diagnostics_consent', 'true');
    },
  },
  {
    version: 48,
    name: 'deactivate_reusable_demo_credentials',
    up: () => {
      // Only the bundled demo identities with the original public password are
      // affected. A merchant who changed one of these passwords keeps the user
      // active and retains their account.
      const changedAt = now();
      const demoUsers = db.prepare(`SELECT id, password FROM users WHERE id IN ('user-demo-manager', 'user-demo-cashier', 'user-demo-chef')`).all() as { id: string; password: string }[];
      const deactivate = db.prepare('UPDATE users SET is_active = 0, tokens_valid_after = ?, updated_at = ? WHERE id = ?');
      for (const user of demoUsers) {
        try {
          if (bcrypt.compareSync('demo12345', user.password)) deactivate.run(changedAt, changedAt, user.id);
        } catch {
          // A corrupt legacy hash must not abort the migration or prevent the
          // rest of the database from opening.
          console.warn(`[DB] Could not inspect demo credential for ${user.id}`);
        }
      }
    },
  },
  {
    version: 49,
    name: 'add_payment_idempotency_records',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_idempotency (
          idempotency_key TEXT PRIMARY KEY,
          bill_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payment_idempotency_bill ON payment_idempotency(bill_id);
        CREATE TABLE IF NOT EXISTS payment_transaction_refs (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
        CREATE INDEX IF NOT EXISTS idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
        CREATE TABLE IF NOT EXISTS payment_transaction_ref_conflicts (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          detected_at TEXT NOT NULL
        );
      `);
      const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL').all() as { id: string; payment_details: string }[];
      const insert = db.prepare('INSERT OR IGNORE INTO payment_transaction_refs (method, transaction_id, bill_id, created_at) VALUES (?, ?, ?, ?)');
      const conflictInsert = db.prepare('INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at) VALUES (?, ?, ?, ?, ?)');
      const seenRefs = new Map<string, { billId: string; createdAt: string }>();
      const detectedAt = now();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (payment && typeof payment.method === 'string' && typeof payment.transaction_id === 'string' && payment.transaction_id.trim() !== '') {
              const createdAt = payment.timestamp || detectedAt;
              const key = `${payment.method}\u0000${payment.transaction_id}`;
              const previous = seenRefs.get(key);
              if (previous && previous.billId !== row.id) conflictInsert.run(payment.method, payment.transaction_id, row.id, previous.createdAt, detectedAt);
              else seenRefs.set(key, { billId: row.id, createdAt });
              insert.run(payment.method, payment.transaction_id, row.id, createdAt);
            }
          }
        } catch {
          // Invalid legacy payment JSON is handled at settlement time; it must
          // not prevent idempotency tables from being created.
        }
      }
    },
  },
  {
    version: 50,
    name: 'add_order_idempotency_records',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS order_idempotency (
          idempotency_key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 51,
    name: 'enforce_global_payment_transaction_refs',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_transaction_ref_conflicts (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          detected_at TEXT NOT NULL
        );
      `);
      const duplicateRows = db.prepare(`
        SELECT method, transaction_id, bill_id, created_at
        FROM payment_transaction_refs
        WHERE transaction_id IN (
          SELECT transaction_id FROM payment_transaction_refs
          GROUP BY transaction_id HAVING COUNT(*) > 1
        )
      `).all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      const recordConflict = db.prepare(`
        INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      for (const row of duplicateRows) recordConflict.run(row.method, row.transaction_id, row.bill_id, row.created_at, detectedAt);
      db.exec(`
        CREATE TABLE payment_transaction_refs_global (
          transaction_id TEXT PRIMARY KEY,
          method TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      db.exec(`
        INSERT OR IGNORE INTO payment_transaction_refs_global (transaction_id, method, bill_id, created_at)
        SELECT transaction_id, method, bill_id, created_at
        FROM payment_transaction_refs
        ORDER BY created_at, bill_id;
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_global RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 52,
    name: 'restore_method_scoped_transaction_refs',
    up: () => {
      // v51 temporarily collapsed references by transaction_id. Rebuild from
      // the authoritative payment snapshots as well as the collapsed table so
      // duplicate same-method references are audited rather than discarded.
      const recordConflict = db.prepare(`
        INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      db.exec(`
        CREATE TABLE payment_transaction_refs_method (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
      `);
      const insertRef = db.prepare(`
        INSERT OR IGNORE INTO payment_transaction_refs_method
          (method, transaction_id, bill_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const findRef = db.prepare('SELECT bill_id, created_at FROM payment_transaction_refs_method WHERE method = ? AND transaction_id = ?');
      const addRef = (method: string, transactionId: string, billId: string, createdAt: string) => {
        const existing = findRef.get(method, transactionId) as { bill_id: string; created_at: string } | undefined;
        if (existing && String(existing.bill_id) !== String(billId)) {
          recordConflict.run(method, transactionId, billId, createdAt, detectedAt);
          return;
        }
        insertRef.run(method, transactionId, billId, createdAt);
      };
      const existingRefs = db.prepare('SELECT method, transaction_id, bill_id, created_at FROM payment_transaction_refs').all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      for (const ref of existingRefs) addRef(ref.method, ref.transaction_id, ref.bill_id, ref.created_at);
      const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL ORDER BY id').all() as { id: string; payment_details: string }[];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (!payment || typeof payment.method !== 'string' || typeof payment.transaction_id !== 'string' || payment.transaction_id.trim() === '') continue;
            addRef(payment.method, payment.transaction_id, String(row.id), payment.timestamp || detectedAt);
          }
        } catch {
          // Invalid legacy JSON remains recoverable by the settlement path.
        }
      }
      db.exec(`
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_method RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 53,
    name: 'scope_idempotency_records_to_user',
    up: () => {
      db.exec(`
        CREATE TABLE payment_idempotency_scoped (
          user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, idempotency_key)
        );
        CREATE TABLE order_idempotency_scoped (
          user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, idempotency_key)
        );
      `);
      const paymentRows = db.prepare(`
        SELECT p.idempotency_key, p.bill_id, p.request_hash, p.response_json, p.created_at,
               'legacy' AS user_id
        FROM payment_idempotency p
      `).all() as { idempotency_key: string; bill_id: string; request_hash: string; response_json: string; created_at: string; user_id: string }[];
      const insertPayment = db.prepare(`
        INSERT INTO payment_idempotency_scoped
          (user_id, idempotency_key, bill_id, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of paymentRows) insertPayment.run(row.user_id || 'legacy', row.idempotency_key, row.bill_id, row.request_hash, row.response_json, row.created_at);

      const orderRows = db.prepare('SELECT idempotency_key, request_hash, response_json, created_at FROM order_idempotency').all() as { idempotency_key: string; request_hash: string; response_json: string; created_at: string }[];
      const insertOrder = db.prepare(`
        INSERT INTO order_idempotency_scoped
          (user_id, idempotency_key, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of orderRows) {
        let userId = 'legacy';
        try {
          const response = JSON.parse(row.response_json);
          if (response?.order?.user_id != null) userId = String(response.order.user_id);
        } catch {
          // Keep the compatibility owner for malformed historical responses.
        }
        insertOrder.run(userId, row.idempotency_key, row.request_hash, row.response_json, row.created_at);
      }
      db.exec(`
        DROP TABLE payment_idempotency;
        ALTER TABLE payment_idempotency_scoped RENAME TO payment_idempotency;
        CREATE INDEX idx_payment_idempotency_bill ON payment_idempotency(bill_id);
        DROP TABLE order_idempotency;
        ALTER TABLE order_idempotency_scoped RENAME TO order_idempotency;
      `);
    },
  },
  {
    version: 54,
    name: 'repair_retry_ownership_and_payment_reference_history',
    up: () => {
      // Repair databases that were opened by an intermediate v53 build before
      // ownership backfilling was added. Keep the compatibility owner only
      // when the historical record has no recoverable owner.
      const paymentRows = db.prepare(`
        SELECT p.idempotency_key,
               CAST(o.user_id AS TEXT) AS user_id
        FROM payment_idempotency p
        JOIN bills b ON b.id = p.bill_id
        JOIN orders o ON o.id = b.order_id
        WHERE p.user_id = 'legacy' AND o.user_id IS NOT NULL
      `).all() as { idempotency_key: string; user_id: string }[];
      const updatePayment = db.prepare(`
        UPDATE payment_idempotency SET user_id = ?
        WHERE user_id = 'legacy' AND idempotency_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM payment_idempotency existing
            WHERE existing.idempotency_key = payment_idempotency.idempotency_key
              AND existing.user_id != 'legacy'
          )
      `);
      for (const row of paymentRows) updatePayment.run(row.user_id, row.idempotency_key);

      const orderRows = db.prepare(`
        SELECT idempotency_key, response_json
        FROM order_idempotency
        WHERE user_id = 'legacy'
      `).all() as { idempotency_key: string; response_json: string }[];
      const updateOrder = db.prepare(`
        UPDATE order_idempotency SET user_id = ?
        WHERE user_id = 'legacy' AND idempotency_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM order_idempotency existing
            WHERE existing.idempotency_key = order_idempotency.idempotency_key
              AND existing.user_id != 'legacy'
          )
      `);
      for (const row of orderRows) {
        try {
          const response = JSON.parse(row.response_json);
          if (response?.order?.user_id != null) updateOrder.run(String(response.order.user_id), row.idempotency_key);
        } catch {
          // Leave malformed historical responses under the compatibility owner.
        }
      }

      // Reconstruct references from every bill snapshot. This repairs v51/v52
      // databases where a global transaction-id table collapsed cross-method
      // rows before method-scoped uniqueness was restored.
      const existingRefs = db.prepare('SELECT method, transaction_id, bill_id, created_at FROM payment_transaction_refs').all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      const rows = db.prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL ORDER BY id').all() as { id: string; payment_details: string }[];
      db.exec(`
        CREATE TABLE payment_transaction_refs_repaired (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
      `);
      const insertRef = db.prepare(`
        INSERT OR IGNORE INTO payment_transaction_refs_repaired
          (method, transaction_id, bill_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const findRef = db.prepare('SELECT bill_id FROM payment_transaction_refs_repaired WHERE method = ? AND transaction_id = ?');
      const recordConflict = db.prepare(`
        INSERT INTO payment_transaction_ref_conflicts
          (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      const addRef = (method: string, transactionId: string, billId: string, createdAt: string) => {
        const existing = findRef.get(method, transactionId) as { bill_id: string } | undefined;
        if (existing && String(existing.bill_id) !== String(billId)) {
          recordConflict.run(method, transactionId, billId, createdAt, detectedAt);
          return;
        }
        insertRef.run(method, transactionId, billId, createdAt);
      };
      for (const ref of existingRefs) addRef(ref.method, ref.transaction_id, ref.bill_id, ref.created_at);
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (!payment || typeof payment.method !== 'string' || typeof payment.transaction_id !== 'string' || payment.transaction_id.trim() === '') continue;
            addRef(payment.method, payment.transaction_id, String(row.id), payment.timestamp || detectedAt);
          }
        } catch {
          // Invalid legacy JSON remains recoverable by the settlement path.
        }
      }
      db.exec(`
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_repaired RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 55,
    name: 'durable_token_revocations',
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS revoked_tokens (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          revoked_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
          ON revoked_tokens(expires_at);
      `);
    },
  },
];

function syncBackupBeforeMigration(fromVersion: number, toVersion: number): void {
  let targetPath = '';
  let completed = false;
  try {
    const dbPath = getDbPath();
    const backupDir = getBackupDir();
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    targetPath = path.join(backupDir, `flo-backup-${timestamp}-pre-v${fromVersion}-to-v${toVersion}.db`);

    if (fs.existsSync(dbPath)) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, targetPath);
    } else {
      // A brand-new install has no source file yet; keep the backup contract
      // by creating an empty SQLite file with migration metadata below.
      fs.writeFileSync(targetPath, '');
    }

    let backupDb: Database.Database | undefined;
    try {
      backupDb = new Database(targetPath);
      backupDb.pragma('journal_mode = DELETE');
      backupDb.exec(`
        CREATE TABLE IF NOT EXISTS _flo_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
      // This snapshot predates the migration about to run. Keep both the
      // metadata stamp and SQLite header aligned with that older version so
      // restoring it cannot be misclassified as a current-schema backup.
      backupDb.pragma(`user_version = ${fromVersion}`);
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('schema_version', String(fromVersion));
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('backup_created_at', new Date().toISOString());
      backupDb.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`).run('app_version', app.getVersion());
    } finally {
      backupDb?.close();
    }

    completed = true;
    console.log(`[DB] Auto-backup before migrating v${fromVersion} → v${toVersion} created at ${targetPath}`);
  } catch (err: any) {
    console.error(`[DB] Auto-backup before migration failed:`, err.message);
    throw new Error(`Pre-migration backup failed; refusing to migrate the database: ${err.message}`);
  } finally {
    if (!completed && targetPath) {
      for (const filePath of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`]) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
      }
    }
  }
}

export class SchemaVersionMismatchError extends Error {
  constructor(public readonly dbVersion: number, public readonly appVersion: number) {
    super(
      `Database schema (v${dbVersion}) is newer than this app version supports (v${appVersion}). ` +
      `This usually means another device or a previous update already upgraded this database. ` +
      `Please update Flo Cafe to the latest version before continuing.`
    );
    this.name = 'SchemaVersionMismatchError';
  }
}

function runMigrations(): void {
  const current = getCurrentSchemaVersion();
  const target = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

  if (current > target) {
    // The database has already been migrated by a newer build than this one
    // (shared/synced DB, or a stale install/shortcut still pointing at this
    // binary). Proceeding would let old queries reference columns a later
    // migration already dropped (e.g. order_items.addons, #133) — fail loudly
    // at startup instead of mid-transaction during business hours.
    throw new SchemaVersionMismatchError(current, target);
  }

  if (current === target) {
    console.log(`[DB] Schema up to date (v${current})`);
    return;
  }

  console.log(`[DB] Schema: v${current} → v${target}`);

  // Back up once, up front, before running the whole pending batch — not just
  // before specific hand-picked versions. An install that's been stuck for a
  // long time (broken auto-update, offline for months, etc.) can jump through
  // a dozen+ migrations in a single run; every one of them deserves the same
  // protection, not just the couple we happened to remember to flag by number.
  //
  // Deliberately unconditional, including current === 0: that's NOT a
  // reliable signal for "nothing to protect" — real old installs can report
  // user_version 0 if they predate this app's version-tracking pragma (see
  // tests/fixtures/upgrade-snapshots/pre-migration-scheme-v1.5.0.db), and
  // those are exactly the installs with the most pending migrations and the
  // most at stake. A brand-new install just backs up an empty/tiny file.
  console.log(`[DB] Triggering auto-backup before migrating v${current} → v${target}...`);
  syncBackupBeforeMigration(current, target);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    console.log(`[DB] Applying migration v${migration.version}: ${migration.name}`);
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
    console.log(`[DB] Migration v${migration.version} complete`);
  }
}

// createSchema() only runs for migration v1, i.e. brand-new installs — for
// any existing install this is a no-op (CREATE TABLE IF NOT EXISTS). If you
// add a column directly to a CREATE TABLE below, existing installs never
// get it unless you also add a guarded ALTER migration for it (see v23/v29
// in MIGRATIONS above for the pattern, and specs/DatabaseMigrations.md).
// tests/upgrade-path.test.ts exists specifically to catch this class of bug.
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
      tax_category_id TEXT DEFAULT NULL,
      tax_behavior TEXT DEFAULT 'country_default',
      -- Stays DEFAULT 0 so a fresh install and an upgraded one have an
      -- identical products table. SQLite cannot alter a column default without
      -- rebuilding the table, so changing it here would drift every upgraded
      -- install away from the ideal schema and light up schema-health forever.
      -- The tri-state does not depend on the default: every insert path passes
      -- cb_percent explicitly, and NULL is written as NULL.
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
      allow_multiple_quantities INTEGER DEFAULT 0,
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
      tax_category_id TEXT DEFAULT NULL,
      tax_behavior TEXT DEFAULT 'country_default',
      inherit_parent_tax_category INTEGER DEFAULT 1,
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
      printer_id TEXT,
      printer_ip TEXT,
      printer_port INTEGER DEFAULT 9100,
      printer_name TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS station_users (
      user_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, station_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (station_id) REFERENCES kitchen_stations(id) ON DELETE CASCADE
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
      tax_snapshot TEXT DEFAULT NULL,
      packaging_tax_category_id TEXT DEFAULT NULL,
      delivery_tax_category_id TEXT DEFAULT NULL,
      service_charge_tax_category_id TEXT DEFAULT NULL,
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
      tax_snapshot TEXT DEFAULT NULL,
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
      tax_snapshot TEXT DEFAULT NULL,
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

    CREATE TABLE IF NOT EXISTS country_packs (
      id TEXT PRIMARY KEY,
      publisher TEXT NOT NULL,
      country TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      active_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'installed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_pack_versions (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      digest TEXT,
      signature TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      min_flo_version TEXT NOT NULL,
      published_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_id, version)
    );

    CREATE TABLE IF NOT EXISTS tax_categories (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      label TEXT NOT NULL,
      default_behavior TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS tax_rules (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      label TEXT NOT NULL,
      calculation_type TEXT NOT NULL,
      rate TEXT,
      amount TEXT,
      applies_per TEXT,
      base_rule_ids TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS tax_overrides (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      field_name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_by_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tax_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      pack_id TEXT,
      pack_version_id TEXT,
      override_id TEXT,
      actor_user_id TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Indexes ──────────────────────────────────────────────────────────

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_active   ON products(is_active);
    CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created    ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_bills_order       ON bills(order_id);
    CREATE INDEX IF NOT EXISTS idx_country_pack_versions_pack ON country_pack_versions(pack_id);
    CREATE INDEX IF NOT EXISTS idx_tax_categories_pack_version ON tax_categories(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_rules_pack_version ON tax_rules(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_overrides_pack_version ON tax_overrides(pack_version_id);
  `);
}

function createTaxPackSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS country_packs (
      id TEXT PRIMARY KEY,
      publisher TEXT NOT NULL,
      country TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      active_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'installed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_pack_versions (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      digest TEXT,
      signature TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      min_flo_version TEXT NOT NULL,
      published_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_id, version)
    );

    CREATE TABLE IF NOT EXISTS tax_categories (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      label TEXT NOT NULL,
      default_behavior TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS tax_rules (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      label TEXT NOT NULL,
      calculation_type TEXT NOT NULL,
      rate TEXT,
      amount TEXT,
      applies_per TEXT,
      base_rule_ids TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS tax_overrides (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      field_name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_by_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tax_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      pack_id TEXT,
      pack_version_id TEXT,
      override_id TEXT,
      actor_user_id TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_country_pack_versions_pack ON country_pack_versions(pack_id);
    CREATE INDEX IF NOT EXISTS idx_tax_categories_pack_version ON tax_categories(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_rules_pack_version ON tax_rules(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_overrides_pack_version ON tax_overrides(pack_version_id);
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

function createWhatsAppSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER REFERENCES bills(id),
      customer_id TEXT REFERENCES customers(id),
      phone_e164 TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
      kind TEXT NOT NULL DEFAULT 'manual_reply'
        CHECK (kind IN ('bill_receipt','manual_reply','auto_followup')),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','seen','typing','sent','delivered','read','failed')),
      body TEXT NOT NULL,
      external_message_id TEXT,
      error TEXT,
      queued_at TEXT DEFAULT CURRENT_TIMESTAMP,
      seen_at TEXT,
      typing_at TEXT,
      sent_at TEXT,
      delivered_at TEXT,
      read_at TEXT,
      failed_at TEXT,
      created_by_user_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone
      ON whatsapp_messages(phone_e164, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status
      ON whatsapp_messages(status, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_bill
      ON whatsapp_messages(bill_id);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_inbound_unread
      ON whatsapp_messages(direction, status, queued_at DESC)
      WHERE direction = 'inbound' AND status NOT IN ('read','failed');

    CREATE TABLE IF NOT EXISTS whatsapp_blocklist (
      phone_e164 TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
      blocked_by_user_id TEXT
    );
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

function seedWhatsAppDefaults(): void {
  insertSettingIfMissing('whatsapp_enabled', 'false');
  insertSettingIfMissing('whatsapp_activated_by_user_id', '');
  insertSettingIfMissing('whatsapp_activated_at', '');
  insertSettingIfMissing('whatsapp_disclosure_version_acknowledged', '');
  insertSettingIfMissing('whatsapp_connected_phone', '');
  insertSettingIfMissing('whatsapp_disclosure_version', '1');
  // On by default — no one asks Flo to send a paid bill into a group chat.
  // Operators who do want group processing have to opt in explicitly.
  insertSettingIfMissing('whatsapp_filter_groups', 'true');
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
  insert('taxes_enabled', 'false');
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
  insert('anonymous_data_consent', 'true');
  insert('telemetry_enabled', 'true');
  insert('telemetry_scope', 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics');
  insert('diagnostics_consent', 'true');
  insert('kds_enabled', 'true');
  insert('kot_printing_enabled', 'true');
  insert('order_number_prefix', 'ORD');
  insert('order_number_include_date', 'true');
  insert('order_number_reset_daily', 'true');

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

/** YYYYMMDD for "now" in the given IANA timezone (falls back to UTC if the zone is invalid). */
export function dateStampInTimezone(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}${get('month')}${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
}

export function generateOrderNumber(): string {
  const prefix = getSettingValue('order_number_prefix') ?? 'ORD';
  const includeDate = getSettingValue('order_number_include_date') !== 'false';
  const resetDaily = getSettingValue('order_number_reset_daily') !== 'false';
  const timezone = getSettingValue('timezone') || 'Asia/Kolkata';

  // The sequence "bucket": a per-day counter when the series resets at store
  // midnight, or a single fixed bucket when the series is meant to keep
  // climbing indefinitely.
  const bucket = resetDaily ? dateStampInTimezone(timezone) : 'ALL';
  const next = getNextSequence('orders', bucket);

  const dateSegment = includeDate ? dateStampInTimezone(timezone) : '';
  return [prefix, dateSegment, String(next).padStart(4, '0')].filter(Boolean).join('-');
}

export function generateBillNumber(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const next = getNextSequence('bills', date);
  return `INV-${date}-${String(next).padStart(4, '0')}`;
}

export function now(): string {
  // Match SQLite's CURRENT_TIMESTAMP format (`YYYY-MM-DD HH:MM:SS`, UTC). The
  // legacy `new Date().toISOString()` form (with `T`, `Z`, milliseconds) was
  // mixed into columns whose `CREATE TABLE` defaults use CURRENT_TIMESTAMP, so
  // range and ordering operations on those columns stopped sorting correctly.
  // Migration v45 normalized the legacy ISO rows to this format. #208
  return new Date().toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/**
 * Parse a DB timestamp into a Date. Columns are stored in UTC wall time in
 * `YYYY-MM-DD HH:MM:SS` (space) form — V8's legacy parser treats that form as
 * machine-LOCAL time, so `new Date(ts)` silently shifts by the host's offset
 * on machines outside UTC. ISO rows (`...T10:00:00.123Z`, pre-v40 data) parse
 * as UTC natively. Use this everywhere a stored timestamp is turned into a
 * Date (reports, receipts, KDS clocks, auth token staleness, telemetry).
 */
export function parseDbTimestamp(ts: string | null | undefined): Date {
  if (!ts) return new Date(NaN);
  // Space form: append a Z so V8 parses it as UTC instead of machine-local.
  return /^\d{4}-\d{2}-\d{2} /.test(ts) ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date(ts);
}

/**
 * "Today" as a `YYYY-MM-DD` string in UTC. All daily boundaries are UTC —
 * the tenant timezone setting only drives the insights hour/day bucketing,
 * never which day a row belongs to.
 */
export function utcTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `[start, end)` half-open range strings (UTC wall, `YYYY-MM-DD HH:MM:SS`)
 * for a given `YYYY-MM-DD` date. Use with `WHERE col >= ? AND col < ?`
 * against the UTC timestamp columns (`created_at`, `paid_at`, etc.) so
 * indexes apply instead of `date(col) = date('now')`, which can't. #208
 *
 * Bounds are emitted in the space form so string comparisons line up exactly
 * with stored rows (migration v40 normalized all rows to it).
 */
export function utcDayBounds(date: string): [string, string] {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const fmt = (dt: Date) => dt.toISOString().replace('T', ' ').replace(/\..*$/, '');
  return [fmt(start), fmt(end)];
}

/** Verify a user PIN against the stored pin_hash. */
export function verifyPin(storedHash: string | null | undefined, inputPin: string | number): boolean {
  if (!storedHash || !inputPin) return false;
  return bcrypt.compareSync(String(inputPin), storedHash);
}

// Issue #150: a voided in-progress item stays on the KDS board, struck
// through, for this long after voiding — long enough for kitchen staff to
// notice it's been pulled — then drops off like a served item would.
export const KDS_VOIDED_ITEM_VISIBILITY_MS = 15 * 60 * 1000;

/**
 * Whether a voided order item should still appear on a KDS surface. Only
 * ever called for status='voided' rows; every other status is a normal
 * KDS-visibility decision the caller already makes. The synthetic negative
 * `void_adjustment` bill line this same void flow inserts (main/routes/index.ts)
 * is never a kitchen item and callers should exclude it before this check
 * even runs, not route it through here.
 */
export function isVoidedItemKdsVisible(voidedAt: string | null | undefined): boolean {
  if (!voidedAt) return true;
  return Date.now() - parseDbTimestamp(voidedAt).getTime() < KDS_VOIDED_ITEM_VISIBILITY_MS;
}

/** Remove customer/payment/order-financial fields from category-scoped KDS payloads. */
export function projectKdsOrder(order: any, restricted: boolean): any {
  if (!restricted) return order;
  const allowedFields = [
    'id', 'order_number', 'table_id', 'type', 'guest_count',
    'special_instructions', 'status', 'created_at', 'updated_at',
    'table_name', 'table_number', 'floor', 'section',
  ];
  return Object.fromEntries(allowedFields.filter((field) => field in order).map((field) => [field, order[field]]));
}

/** Keep category-scoped KDS lines limited to kitchen-operational fields. */
export function projectKdsItem(item: any, restricted: boolean): any {
  if (!restricted) return item;
  const allowedFields = [
    'id', 'order_id', 'product_id', 'product_name', 'product_sku',
    'quantity', 'status', 'special_instructions', 'created_at', 'updated_at',
    'order_number', 'type', 'table_id', 'table_name', 'order_status', 'order_notes', 'order_time',
  ];
  const projected = Object.fromEntries(allowedFields.filter((field) => field in item).map((field) => [field, item[field]]));
  if (Array.isArray(item.addons)) {
    projected.addons = item.addons.map((addon: any) => {
      const safeAddon: Record<string, any> = {};
      for (const field of ['id', 'name', 'quantity']) {
        if (field in addon) safeAddon[field] = addon[field];
      }
      return safeAddon;
    });
  }
  return projected;
}

/** Avoid exposing printer/network credentials in restricted KDS station metadata. */
export function projectKdsStation(station: any, restricted: boolean): any {
  if (!restricted) return station;
  const allowedFields = ['id', 'name', 'description', 'category_ids', 'sort_order', 'is_active'];
  return Object.fromEntries(allowedFields.filter((field) => field in station).map((field) => [field, station[field]]));
}

/**
 * Snapshots an order item's selected addons into the normalized
 * order_item_addons table — the only place selected addons are stored (see
 * issue #125; order_items.addons was dropped in migration v28). Silently
 * skips entries missing a name.
 */
export function insertOrderItemAddons(
  dbInstance: Database.Database,
  orderItemId: number | bigint,
  addons: { id?: string; name?: string; price?: number; quantity?: number }[] | null | undefined,
  createdAt: string
): void {
  if (!addons || !Array.isArray(addons) || addons.length === 0) return;
  const addonExists = dbInstance.prepare('SELECT 1 FROM addons WHERE id = ?');
  const insertAddon = dbInstance.prepare(`
    INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const addon of addons) {
    if (!addon || !addon.name) continue;
    // addon_id has an FK to addons(id) — if the catalog addon was since
    // deleted (or the id never matched one, e.g. ad-hoc/legacy data), fall
    // back to NULL rather than let the FK violation abort order creation.
    // addon_name/price are the snapshot of record either way.
    const linkedAddonId = addon.id && addonExists.get(addon.id) ? addon.id : null;
    const qty = Math.max(1, Math.floor(Number(addon.quantity) || 1));
    insertAddon.run(orderItemId, linkedAddonId, addon.name, addon.price || 0, qty, createdAt);
  }
}

/** Parse JSON string fields on order_item rows returned from SQLite.
 *  Stored as JSON.stringify(value) — may be "null", "[...]", "{...}" etc.
 *  Returns actual JS value (array / object / null) so the frontend can map/iterate.
 *  addons is not handled here — see attachEffectiveAddons, which resolves it
 *  from the normalized order_item_addons table instead. */
export function parseItemJson(item: any): any {
  const tryParse = (val: any) => {
    if (typeof val !== 'string') return val;
    try { return JSON.parse(val); } catch { return val; }
  };
  return {
    ...item,
    variant_selection: tryParse(item.variant_selection),
    modifier_selection: tryParse(item.modifier_selection),
    tax_breakdown: tryParse(item.tax_breakdown),
    tax_snapshot: tryParse(item.tax_snapshot),
  };
}

/**
 * Resolves selected addons for a batch of order_items rows from the
 * normalized order_item_addons table — the sole source of truth (see issue
 * #125; order_items.addons was dropped in migration v28). Returns new
 * objects with `addons` set to an array (empty if the item has none); does
 * not mutate the input.
 */
export function attachEffectiveAddons<T extends { id: number }>(
  dbInstance: Database.Database,
  items: T[]
): (T & { addons: { id: string | null; name: string; price: number; quantity: number }[] })[] {
  if (items.length === 0) return items as (T & { addons: { id: string | null; name: string; price: number; quantity: number }[] })[];

  const ids = items.map((item) => item.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = dbInstance.prepare(
    `SELECT * FROM order_item_addons WHERE order_item_id IN (${placeholders}) ORDER BY id`
  ).all(...ids) as { order_item_id: number; addon_id: string | null; addon_name: string; price: number; quantity: number }[];

  const byItem = new Map<number, { id: string | null; name: string; price: number; quantity: number }[]>();
  for (const row of rows) {
    const list = byItem.get(row.order_item_id) || [];
    list.push({ id: row.addon_id, name: row.addon_name, price: row.price, quantity: row.quantity });
    byItem.set(row.order_item_id, list);
  }

  return items.map((item) => ({ ...item, addons: byItem.get(item.id) || [] }));
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
    tax_snapshot: tryParse(row.tax_snapshot),
    payment_details: tryParse(row.payment_details),
  };
}
