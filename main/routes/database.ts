import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { captureUserSecurityState, captureUserStationSecurityState, getDatabase, getDbPath, createBackup, createBackupUnlocked, getCurrentSchemaVersion, isSafeIdentifier, mergeUserSecurityState, mergeUserStationSecurityState, withTxn, withDatabaseMaintenanceLock } from '../db';
import { clearInMemoryRevokedTokens, clearUserAuthCache, requireRole } from '../middleware/security';
import { requireMasterPin } from '../middleware/master-pin';
import { clearJWTSecretCache } from './auth';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

// Settings keys stripped from export — these are secrets; exporting them would
// allow token forgery or cloud credential theft (vuln-0005).
const EXPORT_SETTINGS_REDACT = new Set([
  'jwt_secret',
  'cloud_api_key',
  'cloud_device_secret',
]);

// User columns stripped from export — hashes must never leave the server.
const USER_REDACT_COLS = new Set(['password', 'pin', 'pin_hash']);

// Tables excluded entirely — cloud_sync_outbox may contain cloud auth payloads.
const EXPORT_EXCLUDE_TABLES = new Set(['cloud_sync_outbox']);

router.get('/export', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();

    const result = withTxn(() => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_flo_meta'
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

router.post('/import', requireRole('owner'),
  (req: Request, res: Response, next: () => void) => (req.body?.overwrite ? requireMasterPin(req, res, next) : next()),
  async (req: Request, res: Response) => {
  return withDatabaseMaintenanceLock(async () => {
    try {
    const { data, overwrite } = req.body;

    if (!data || !data.data || typeof data.data !== 'object') {
      return res.status(400).json({ error: 'Invalid import file format' });
    }

    const db = getDatabase();
    const preservedRevocations = db.prepare('SELECT token_hash, expires_at, revoked_at FROM revoked_tokens').all() as { token_hash: string; expires_at: number; revoked_at: string }[];
    const preservedUserSecurity = captureUserSecurityState(db);
    const preservedUserStations = captureUserStationSecurityState(db);
    const importData = data.data as Record<string, any[]>;
    const importSchemaVersion = parseInt(data.schema_version || '0', 10);

    const requiredTables = ['settings', 'categories', 'products', 'users'];
    const importedTables = Object.keys(importData);
    
    const missingTables = requiredTables.filter(t => !importedTables.includes(t));
    if (missingTables.length > 0) {
      return res.status(400).json({ 
        error: `Missing required tables: ${missingTables.join(', ')}` 
      });
    }

    // Exported user rows intentionally omit password/pin hashes. Preserve
    // existing destination accounts, but reject imports whose business rows
    // reference users that cannot exist after those redacted rows are skipped.
    const importedUserRows = Array.isArray(importData.users) ? importData.users : [];
    const credentialedUserIds = new Set(
      importedUserRows
        .filter((row) => typeof row?.password === 'string' && row.password.length > 0)
        .map((row) => String(row.id)),
    );
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
            if (!existingUserIds.has(userId) && !credentialedUserIds.has(userId)) unresolvedUserIds.add(userId);
          }
        }
      }
    }
    const importedWhatsappActivator = importedTables.includes('settings') && Array.isArray(importData.settings)
      ? importData.settings.find((row) => row?.key === 'whatsapp_activated_by_user_id')?.value
      : null;
    if (importedWhatsappActivator && !existingUserIds.has(String(importedWhatsappActivator)) && !credentialedUserIds.has(String(importedWhatsappActivator))) {
      unresolvedUserIds.add(String(importedWhatsappActivator));
    }
    if (unresolvedUserIds.size > 0) {
      return res.status(400).json({
        error: 'Import contains rows linked to redacted user accounts that are not present on this install. Set up matching staff accounts first.',
      });
    }

    const { path: backupPath } = await createBackupUnlocked();
    const hasVersionMismatch = importSchemaVersion !== getCurrentSchemaVersion();

    if (hasVersionMismatch) {
      console.log(`[DB Import] Version mismatch: import v${importSchemaVersion} vs current v${getCurrentSchemaVersion()}. Using data-only merge.`);
    }

    const previousForeignKeys = Number(db.pragma('foreign_keys', { simple: true })) === 1;
    db.pragma('foreign_keys = OFF');

    try {
      db.exec('BEGIN IMMEDIATE');
      try {
      for (const tableName of importedTables) {
        // Validate table name to prevent SQL injection
        if (!isSafeIdentifier(tableName)) {
          console.warn(`[DB Import] Skipping unsafe table name: ${tableName}`);
          continue;
        }

        const rows = importData[tableName];
        if (!rows || !Array.isArray(rows) || rows.length === 0) continue;

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
        
        for (const row of rows) {
          // Exported secret fields are deliberately redacted. Never import the
          // marker itself as a real credential (which would make it known).
          if (
            tableName === 'settings' &&
            EXPORT_SETTINGS_REDACT.has(String(row.key)) &&
            row.value === '[REDACTED]'
          ) continue;
          insertStmt.run(...commonCols.map(col => row[col]));
        }
        
        console.log(`[DB Import] ${tableName}: ${rows.length} rows (${commonCols.length} columns)`);
      }
      
      mergeUserSecurityState(db, preservedUserSecurity);
      mergeUserStationSecurityState(db, preservedUserStations, preservedUserSecurity.map((row) => row.id));
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
      const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyViolations.length > 0) {
        throw new Error(`Import would leave ${foreignKeyViolations.length} foreign-key violation(s)`);
      }
      db.exec('COMMIT');
      clearUserAuthCache();
      clearInMemoryRevokedTokens();
      clearJWTSecretCache();
      res.json({ 
        success: true, 
        message: hasVersionMismatch 
          ? 'Data imported with schema compatibility (some fields may be missing)'
          : 'Database imported successfully',
        backup: backupPath,
        schemaVersionMismatch: hasVersionMismatch,
        importedSchemaVersion: importSchemaVersion,
        currentSchemaVersion: getCurrentSchemaVersion()
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
  });
});

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

router.post('/backup', requireRole('owner'), requireMasterPin, async (req: Request, res: Response) => {
  try {
    const { path: backupPath, schemaVersion } = await createBackup();
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
});

router.get('/download', requireRole('owner'), requireMasterPin, async (_req: Request, res: Response) => {
  let tempDir: string | null = null;
  try {
    const dbPath = getDbPath();
    tempDir = fs.mkdtempSync(path.join(path.dirname(dbPath), '.flo-download-'));
    const snapshotPath = path.join(tempDir, 'flo-database.db');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `flo-database-${timestamp}.db`;

    // Download a clean checkpointed backup rather than streaming the live WAL
    // file. The temporary snapshot is independent of later restore/reset work.
    await createBackup(snapshotPath);
    res.download(snapshotPath, filename, (error) => {
      try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
      if (error) console.error('[DB Download] Stream error:', error);
    });
  } catch (error: any) {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
    }
    console.error('[DB Download] Error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

router.get('/tables', requireRole('owner'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_flo_meta'
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
