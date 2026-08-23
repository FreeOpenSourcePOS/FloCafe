import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { captureKitchenStationSecurityState, captureKdsEnabledSetting, captureRestoreProtectedSettings, captureUserSecurityState, captureUserStationSecurityState, getDatabase, getDbPath, createBackup, createBackupUnlocked, getCurrentSchemaVersion, getForeignKeyViolationKeys, isSafeIdentifier, mergeKdsEnabledSetting, mergeRestoreProtectedSettings, mergeUserSecurityState, mergeUserStationSecurityState, throwIfDatabaseMaintenanceAborted, withTxn, withDatabaseMaintenanceLock } from '../db';
import { clearInMemoryRevokedTokens, clearUserAuthCache, requireRole } from '../middleware/security';
import { requireMasterPin } from '../middleware/master-pin';
import { clearJWTSecretCache } from './auth';
import * as fs from 'fs';
import * as path from 'path';
import { asyncHandler } from '../middleware/async-handler';
import { getHttpRequestSignal, trackHttpRequestWork } from '../shutdown';
import { parsePhoneE164 } from '../lib/phone';
import { ROLE_ACCESS } from '../../shared/role-permissions';

const router = Router();

// Settings keys stripped from export — these are secrets; exporting them would
// allow token forgery or cloud credential theft (vuln-0005).
const EXPORT_SETTINGS_REDACT = new Set([
  'jwt_secret',
  'cloud_api_key',
  'cloud_device_secret',
  'cloud_pos_hash',
  'mobile_pairing_code',
  'mobile_pairing_code_expires_at',
  // Bearer-like token used to poll a pending cloud account-deletion request
  // (see main/services/cloud-sync.ts) — same exposure risk as the cloud
  // credentials above.
  'cloud_deletion_status_token',
  // Legacy builds persisted arbitrary upstream errors here; keep exports
  // from carrying that text even before an upgraded database is reopened.
  'cloud_last_error',
]);

// User columns stripped from export — hashes must never leave the server.
const USER_REDACT_COLS = new Set(['password', 'pin', 'pin_hash']);

// Tables excluded entirely — cloud_sync_outbox may contain cloud auth payloads.
const EXPORT_EXCLUDE_TABLES = new Set(['cloud_sync_outbox', 'support_ticket_outbox', 'store_diagnostics_outbox', 'kds_pairing_tokens']);
const USER_ROLES = new Set(['owner', 'manager', 'cashier', 'server', 'chef']);

// Parses an import file's schema_version exactly as the import handler does.
// A missing or malformed value collapses to -1 (and an omitted version to 0),
// which always counts as a mismatch against the live schema — and therefore as
// a destructive, delete-and-replace import that needs Master PIN confirmation.
function parseImportSchemaVersion(value: unknown): number {
  const raw = String(value ?? '0');
  return /^(?:0|[1-9]\d*)$/.test(raw) ? Number(raw) : -1;
}

router.get('/export', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const db = getDatabase();

    const result = withTxn(() => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_flo_meta'
      `).all() as { name: string }[];

      const exportData: Record<string, any[]> = {};
      const redactedFields: string[] = [];

      for (const { name: tableName } of tables) {
        if (!isSafeIdentifier(tableName)) {
          console.warn(`[DB Export] Skipping unsafe table name: ${tableName}`);
          continue;
        }

        if (EXPORT_EXCLUDE_TABLES.has(tableName)) {
          redactedFields.push(`table:${tableName}`);
          continue;
        }

        const rows = db.prepare(`SELECT * FROM ${tableName}`).all() as Record<string, any>[];

        if (tableName === 'settings') {
          exportData[tableName] = rows.map((row) => {
            if (EXPORT_SETTINGS_REDACT.has(row.key)) {
              redactedFields.push(`settings.${row.key}`);
              return { ...row, value: '[REDACTED]' };
            }
            return row;
          });
        } else if (tableName === 'users') {
          exportData[tableName] = rows.map((row) => {
            const sanitized = { ...row };
            for (const col of USER_REDACT_COLS) {
              if (col in sanitized) {
                delete sanitized[col];
                if (!redactedFields.includes(`users.${col}`)) redactedFields.push(`users.${col}`);
              }
            }
            return sanitized;
          });
        } else {
          exportData[tableName] = rows;
        }
      }

      return { exportData, redactedFields };
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `flo-export-${timestamp}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({
      version: 1,
      app: 'FloDesktop',
      exported_at: new Date().toISOString(),
      schema_version: String(getCurrentSchemaVersion()),
      redacted_fields: result.redactedFields,
      data: result.exportData,
    });
  } catch (error: any) {
    console.error('[DB Export] Error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

router.post('/import', requireRole(...ROLE_ACCESS.owner),
  (req: Request, res: Response, next: () => void) => {
    // A schema-mismatch import reaches the same delete-and-replace path as an
    // explicit overwrite (the `overwrite || hasVersionMismatch` branch below),
    // so it must require the same Master PIN confirmation. Gate on both
    // triggers so an owner cannot bypass the destructive-operation confirmation
    // by submitting a deliberately mismatched or malformed schema_version
    // (GHSA-xxv4-gm82-4639).
    const body = req.body as { overwrite?: unknown; data?: Record<string, unknown> } | undefined;
    const overwrite = Boolean(body?.overwrite);
    const schemaVersionMismatch = body?.data && typeof body.data === 'object'
      ? parseImportSchemaVersion(body.data.schema_version) !== getCurrentSchemaVersion()
      : false;
    return (overwrite || schemaVersionMismatch) ? requireMasterPin(req, res, next) : next();
  },
  asyncHandler(async (req: Request, res: Response) => {
  return withDatabaseMaintenanceLock(async (signal) => {
    try {
    throwIfDatabaseMaintenanceAborted(signal);
    const { data, overwrite } = req.body;

    if (!data || !data.data || typeof data.data !== 'object') {
      return res.status(400).json({ error: 'Invalid import file format' });
    }

    const db = getDatabase();
    const preservedRevocations = db.prepare('SELECT token_hash, expires_at, revoked_at FROM revoked_tokens').all() as { token_hash: string; expires_at: number; revoked_at: string }[];
    const baselineForeignKeyViolations = getForeignKeyViolationKeys(db);
    const preservedUserSecurity = captureUserSecurityState(db);
    const preservedUserStations = captureUserStationSecurityState(db);
    const preservedStationSecurity = captureKitchenStationSecurityState(db);
    const preservedKdsEnabled = captureKdsEnabledSetting(db);
    const preservedProtectedSettings = captureRestoreProtectedSettings(db);
    const importData = data.data as Record<string, any[]>;
    const importSchemaVersion = parseImportSchemaVersion(data.schema_version);
    const hasVersionMismatch = importSchemaVersion !== getCurrentSchemaVersion();

    if (hasVersionMismatch) {
      console.log(`[DB Import] Version mismatch: import v${importSchemaVersion} vs current v${getCurrentSchemaVersion()}. Using data-only merge.`);
    }

    const requiredTables = ['settings', 'categories', 'products', 'users'];
    const importedTables = Object.keys(importData);
    
    const missingTables = requiredTables.filter(t => !importedTables.includes(t));
    if (missingTables.length > 0) {
      return res.status(400).json({ 
        error: `Missing required tables: ${missingTables.join(', ')}` 
      });
    }

    // Exported user rows intentionally omit password/pin hashes. Preserve
    // existing destination accounts, and create inactive placeholders for
    // redacted exported users so historical rows keep valid staff references.
    const importedUserRows = Array.isArray(importData.users) ? importData.users : [];
    const credentialedUserIds = new Set(
      importedUserRows
        .filter((row) => typeof row?.password === 'string' && row.password.length > 0)
        .map((row) => String(row.id)),
    );
    const redactedUserIds = new Set(
      importedUserRows
        .filter((row) => row && typeof row === 'object' && row.id != null && !credentialedUserIds.has(String(row.id)))
        .map((row) => String(row.id)),
    );
    const importProvidedUserIds = new Set([...credentialedUserIds, ...redactedUserIds]);
    const existingUserIds = new Set(
      (db.prepare('SELECT id FROM users').all() as { id: string }[]).map((row) => String(row.id)),
    );
    const unresolvedUserIds = new Set<string>();
    for (const [tableName, rows] of Object.entries(importData)) {
      if (tableName === 'users' || !Array.isArray(rows) || !isSafeIdentifier(tableName)) continue;
      const userReferenceColumns = (db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as { table: string; from: string }[])
        .filter((foreignKey) => foreignKey.table === 'users')
        .map((foreignKey) => foreignKey.from);
      if (userReferenceColumns.length === 0) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        for (const column of userReferenceColumns) {
          const value = row[column];
          if (value != null && String(value) !== '') {
            const userId = String(value);
            if (!existingUserIds.has(userId) && !importProvidedUserIds.has(userId)) unresolvedUserIds.add(userId);
          }
        }
      }
    }
    const importedWhatsappActivator = importedTables.includes('settings') && Array.isArray(importData.settings)
      ? importData.settings.find((row) => row?.key === 'whatsapp_activated_by_user_id')?.value
      : null;
    if (importedWhatsappActivator && !existingUserIds.has(String(importedWhatsappActivator)) && !importProvidedUserIds.has(String(importedWhatsappActivator))) {
      unresolvedUserIds.add(String(importedWhatsappActivator));
    }
    if (unresolvedUserIds.size > 0) {
      return res.status(400).json({
        error: 'Import contains rows linked to user accounts that are not present in this export or this install. Set up matching staff accounts first.',
      });
    }

    const { path: backupPath } = await createBackupUnlocked(undefined, signal);
    throwIfDatabaseMaintenanceAborted(signal);

    const previousForeignKeys = Number(db.pragma('foreign_keys', { simple: true })) === 1;
    db.pragma('foreign_keys = OFF');

    try {
      throwIfDatabaseMaintenanceAborted(signal);
      db.exec('BEGIN IMMEDIATE');
      try {
      for (const tableName of importedTables) {
        throwIfDatabaseMaintenanceAborted(signal);
        if (EXPORT_EXCLUDE_TABLES.has(tableName)) continue;
        // Validate table name to prevent SQL injection
        if (!isSafeIdentifier(tableName)) {
          console.warn(`[DB Import] Skipping unsafe table name: ${tableName}`);
          continue;
        }

        const rows = importData[tableName];
        if (!rows || !Array.isArray(rows)) continue;
        if (rows.length === 0) {
          if (overwrite || hasVersionMismatch) {
            if (tableName === 'settings') {
              const protectedKeys = Array.from(EXPORT_SETTINGS_REDACT);
              const placeholders = protectedKeys.map(() => '?').join(', ');
              db.prepare(`DELETE FROM settings WHERE key NOT IN (${placeholders})`).run(...protectedKeys);
            } else {
              db.exec(`DELETE FROM ${tableName}`);
            }
          }
          continue;
        }

        const currentCols = getTableColumns(db, tableName);
        // Validate and filter column names to prevent SQL injection
        const importCols = Object.keys(rows[0]).filter(isSafeIdentifier);
        // A normal export intentionally omits password/pin hashes. It must not
        // attempt to recreate users with a NULL required password.
        if (tableName === 'users' && !importCols.includes('password')) continue;
        const commonCols = hasVersionMismatch
          ? importCols.filter(c => currentCols.includes(c) && isSafeIdentifier(c))
          : importCols;

        if (commonCols.length === 0) continue;

        if (overwrite || hasVersionMismatch) {
          if (tableName === 'settings') {
            const protectedKeys = Array.from(EXPORT_SETTINGS_REDACT);
            const placeholders = protectedKeys.map(() => '?').join(', ');
            db.prepare(`DELETE FROM settings WHERE key NOT IN (${placeholders})`).run(...protectedKeys);
          } else {
            db.exec(`DELETE FROM ${tableName}`);
          }
        }

        const colList = commonCols.join(', ');
        const placeholders = commonCols.map(() => '?').join(', ');
        const insertStmt = db.prepare(
          `INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})`
        );
        
        const tenantCountryRow = db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as any;
        const tenantCountry = tenantCountryRow?.value || 'IN';

        for (const row of rows) {
          throwIfDatabaseMaintenanceAborted(signal);
          // Exported secret fields are deliberately redacted. Never import the
          // marker itself as a real credential (which would make it known).
          if (
            tableName === 'settings' &&
            EXPORT_SETTINGS_REDACT.has(String(row.key)) &&
            row.value === '[REDACTED]'
          ) continue;

          if (tableName === 'customers' && row.phone) {
            const parsed = parsePhoneE164(String(row.phone), tenantCountry);
            if (parsed) {
              row.phone = parsed.e164;
              if (commonCols.includes('country_code')) {
                row.country_code = parsed.countryCode;
              }
            }
          }

          insertStmt.run(...commonCols.map(col => row[col]));
        }
        
        console.log(`[DB Import] ${tableName}: ${rows.length} rows (${commonCols.length} columns)`);
      }
      
      const placeholderUsersCreated = restoreRedactedUserPlaceholders(db, importedUserRows, existingUserIds);
      if (placeholderUsersCreated > 0) {
        console.log(`[DB Import] Created ${placeholderUsersCreated} inactive placeholder user(s) for redacted exported accounts`);
      }

      mergeUserSecurityState(db, preservedUserSecurity);
      mergeUserStationSecurityState(db, preservedUserStations, preservedUserSecurity.map((row) => row.id), preservedStationSecurity);
      mergeKdsEnabledSetting(db, preservedKdsEnabled);
      mergeRestoreProtectedSettings(db, preservedProtectedSettings);
      db.prepare('DELETE FROM kds_pairing_tokens').run();
      const mergeRevocation = db.prepare(`
        INSERT INTO revoked_tokens (token_hash, expires_at, revoked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(token_hash) DO UPDATE SET
          expires_at = MAX(revoked_tokens.expires_at, excluded.expires_at),
          revoked_at = MIN(revoked_tokens.revoked_at, excluded.revoked_at)
      `);
      for (const revocation of preservedRevocations) {
        mergeRevocation.run(revocation.token_hash, revocation.expires_at, revocation.revoked_at);
      }
      const newForeignKeyViolations = [...getForeignKeyViolationKeys(db)]
        .filter((key) => !baselineForeignKeyViolations.has(key));
      if (newForeignKeyViolations.length > 0) {
        throw new Error(`Import would introduce ${newForeignKeyViolations.length} new foreign-key violation(s)`);
      }
      throwIfDatabaseMaintenanceAborted(signal);
      db.exec('COMMIT');
      try {
        clearUserAuthCache();
        clearInMemoryRevokedTokens();
        clearJWTSecretCache();
      } catch (cacheError: any) {
        // The import is already committed above. A failure to clear the
        // in-memory auth/revocation caches must not be reported as a failed
        // import — that would encourage an operator to retry an already-
        // committed import. Log it and still report success.
        console.error('[DB Import] Post-commit cache cleanup failed:', cacheError);
      }
      res.json({ 
        success: true, 
        message: hasVersionMismatch 
          ? 'Data imported with schema compatibility (some fields may be missing)'
          : 'Database imported successfully',
        backup: backupPath,
        schemaVersionMismatch: hasVersionMismatch,
        importedSchemaVersion: importSchemaVersion,
        currentSchemaVersion: getCurrentSchemaVersion(),
        placeholderUsersCreated,
      });
      } catch (err: any) {
        try { db.exec('ROLLBACK'); } catch { }
        throw err;
      }
    } finally {
      db.pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    }
    } catch (error: any) {
      console.error('[DB Import] Error:', error);
      res.status(500).json({ error: 'Import failed' });
    }
  }, getHttpRequestSignal(req));
}));

function restoreRedactedUserPlaceholders(
  db: Database.Database,
  importedUserRows: any[],
  existingUserIds: Set<string>,
): number {
  if (importedUserRows.length === 0) return 0;

  const currentCols = getTableColumns(db, 'users');
  const insertableCols = [
    'id',
    'name',
    'email',
    'password',
    'role',
    'category_ids',
    'is_active',
    'terms_accepted_at',
    'tokens_valid_after',
    'station_assignments_configured',
    'created_at',
    'updated_at',
  ].filter((column) => currentCols.includes(column));
  if (!insertableCols.includes('id') || !insertableCols.includes('password')) return 0;

  const colList = insertableCols.join(', ');
  const placeholders = insertableCols.map(() => '?').join(', ');
  const insertStmt = db.prepare(`INSERT OR IGNORE INTO users (${colList}) VALUES (${placeholders})`);
  let created = 0;

  for (const row of importedUserRows) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.password === 'string' && row.password.length > 0) continue;

    const id = row.id == null ? '' : String(row.id);
    if (!id || existingUserIds.has(id)) continue;

    const timestamp = typeof row.updated_at === 'string' && row.updated_at
      ? row.updated_at
      : new Date().toISOString();
    const role = USER_ROLES.has(String(row.role)) ? String(row.role) : 'cashier';
    const values: Record<string, unknown> = {
      id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name : `Imported staff ${id}`,
      email: null,
      password: `disabled-redacted-import-${id}`,
      role,
      category_ids: typeof row.category_ids === 'string' ? row.category_ids : null,
      is_active: 0,
      terms_accepted_at: null,
      tokens_valid_after: null,
      station_assignments_configured: 0,
      created_at: typeof row.created_at === 'string' && row.created_at ? row.created_at : timestamp,
      updated_at: timestamp,
    };

    const info = insertStmt.run(...insertableCols.map((column) => values[column] ?? null));
    if (info.changes > 0) {
      existingUserIds.add(id);
      created += 1;
    }
  }

  return created;
}

function getTableColumns(db: Database.Database, tableName: string): string[] {
  if (!isSafeIdentifier(tableName)) {
    console.warn(`[DB Columns] Unsafe table name rejected: ${tableName}`);
    return [];
  }
  try {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
    return columns.map(col => col.name);
  } catch {
    return [];
  }
}

router.post('/backup', requireRole(...ROLE_ACCESS.owner), requireMasterPin, asyncHandler(async (req: Request, res: Response) => {
  try {
    const { path: backupPath, schemaVersion } = await createBackup(undefined, getHttpRequestSignal(req));
    res.json({ 
      success: true, 
      path: backupPath,
      filename: path.basename(backupPath),
      schemaVersion
    });
  } catch (error: any) {
    console.error('[DB Backup] Error:', error);
    res.status(500).json({ error: 'Backup failed' });
  }
}));

router.get('/download', requireRole(...ROLE_ACCESS.owner), requireMasterPin, asyncHandler(async (req: Request, res: Response) => {
  let tempDir: string | null = null;
  try {
    const dbPath = getDbPath();
    tempDir = fs.mkdtempSync(path.join(path.dirname(dbPath), '.flo-download-'));
    const snapshotPath = path.join(tempDir, 'flo-database.db');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `flo-database-${timestamp}.db`;

    // Download a clean checkpointed backup rather than streaming the live WAL
    // file. The temporary snapshot is independent of later restore/reset work.
    await createBackup(snapshotPath, getHttpRequestSignal(req));
    const signal = getHttpRequestSignal(req);
    const download = new Promise<void>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        try { res.destroy(); } catch (error) { settle(error as Error); return; }
      };
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      res.once('finish', () => settle());
      res.once('close', () => settle());
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        res.download(snapshotPath, filename, (error) => settle(error));
      } catch (error) {
        settle(error as Error);
      }
    });
    void trackHttpRequestWork(req, download)
      .finally(() => {
        try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
      })
      .catch((error) => {
        console.error('[DB Download] Stream error:', (error as Error).message);
      });
  } catch (error: any) {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
    }
    console.error('[DB Download] Error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
}));

router.get('/tables', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_flo_meta'
      ORDER BY name
    `).all() as { name: string }[];

    const tableInfo = tables
      .filter(({ name: tableName }) => isSafeIdentifier(tableName))
      .map(({ name: tableName }) => {
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number };
        return { name: tableName, rows: count.count };
      });

    res.json({ tables: tableInfo });
  } catch (error: any) {
    console.error('[DB Tables] Error:', error);
    res.status(500).json({ error: 'Could not fetch database tables' });
  }
});

export const databaseRoutes = router;
