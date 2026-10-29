import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const nativeFs = require('node:fs') as typeof import('node:fs');
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-newer-db-recovery-'));

let safeStorageEnabled = false;

const mockApp = {
  isPackaged: true,
  getPath: () => testDir,
  getVersion: () => '3.13.14',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: mockApp,
      safeStorage: {
        isEncryptionAvailable: () => safeStorageEnabled,
        encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
        decryptString: (value: Buffer) => {
          const text = value.toString('utf8');
          if (!text.startsWith('enc:')) throw new Error('corrupt ciphertext');
          return text.slice(4);
        },
      },
      shell: {
        openExternal: () => Promise.resolve(),
        openPath: () => Promise.resolve(''),
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import {
  buildIdealSchemaDb,
  closeDatabase,
  createBackup,
  discoverDowngradeBackupsAsync,
  finalizeDatabaseReplacementJournal,
  getBackupDir,
  getCurrentSchemaVersion,
  getDatabase,
  getDatabaseReplacementJournal,
  getDbPath,
  getLatestSupportedSchemaVersion,
  initDatabase,
  isHealthyDatabaseFile,
  isSchemaVersionMismatchError,
  planNewerDatabaseArchivePath,
  restoreBackup,
  restoreCompatibleBackupForDowngrade,
  SchemaVersionMismatchError,
} from '../main/db';
import { FLOCAFE_RELEASES_URL, runDowngradeRecoveryFlow } from '../main/downgrade-recovery';
import { getUserAuthStatus, isTokenRevoked, revokeToken } from '../main/middleware/security';
import {
  clearJWTSecretCache,
  getJWTSecret,
  JWT_SECRET_SAFE_STORAGE_MARKER,
} from '../main/security/jwt-secret';
import { runHealthCheck } from '../main/services/schema-health';

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function removeDbSet(basePath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${basePath}${suffix}`;
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

function clearDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  for (const name of fs.readdirSync(dirPath)) {
    fs.rmSync(path.join(dirPath, name), { recursive: true, force: true });
  }
}

function writeStampedSchemaSnapshot(
  destinationPath: string,
  targetVersion: number,
  options: {
    appVersion?: string;
    backupCreatedAt?: string;
    seed?: (dbInstance: Database.Database) => void;
    overridePragmaVersion?: number;
    overrideMetaSchemaVersion?: string;
  } = {},
): void {
  const idealDb = buildIdealSchemaDb(targetVersion);
  const tempSnapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-snap-build-'));
  const tempSnapPath = path.join(tempSnapDir, 'snap.db');
  try {
    const rawBuffer = idealDb.serialize();
    fs.writeFileSync(tempSnapPath, rawBuffer);
  } finally {
    idealDb.close();
  }

  let snapDb: Database.Database | undefined;
  try {
    snapDb = new Database(tempSnapPath);
    snapDb.pragma('journal_mode = DELETE');
    snapDb.pragma('foreign_keys = OFF');
    options.seed?.(snapDb);
    snapDb.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
    const finalPragma = options.overridePragmaVersion ?? targetVersion;
    const finalMeta = options.overrideMetaSchemaVersion ?? String(finalPragma);
    snapDb.pragma(`user_version = ${finalPragma}`);
    snapDb
      .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
      .run('schema_version', finalMeta);
    if (options.appVersion !== undefined) {
      snapDb
        .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
        .run('app_version', options.appVersion);
    }
    if (options.backupCreatedAt !== undefined) {
      snapDb
        .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
        .run('backup_created_at', options.backupCreatedAt);
    }
    snapDb.close();
    snapDb = undefined;
    fs.copyFileSync(tempSnapPath, destinationPath);
  } finally {
    snapDb?.close();
    fs.rmSync(tempSnapDir, { recursive: true, force: true });
  }
}

function buildActiveNewerWalDatabase(
  destinationDbPath: string,
  baseTemplatePath: string,
  newerVersion: number,
  newerAppVersion: string,
): { dbSha: string; walSha: string; shmSha: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-newer-wal-stage-'));
  const stageDbPath = path.join(stageDir, 'flo.db');
  fs.copyFileSync(baseTemplatePath, stageDbPath);

  let writerDb: Database.Database | undefined;
  try {
    writerDb = new Database(stageDbPath);
    writerDb.pragma('journal_mode = WAL');
    writerDb.pragma('wal_autocheckpoint = 0');
    writerDb.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
    writerDb
      .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
      .run('app_version', newerAppVersion);
    writerDb
      .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(newerVersion));
    writerDb
      .prepare(`
        INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
        VALUES ('ORD-AFTER-UPGRADE-900', 'takeaway', 'pending', 42, 42, '2026-10-29 01:00:00', '2026-10-29 01:00:00')
      `)
      .run();
    writerDb.pragma(`user_version = ${newerVersion}`);

    assert.equal(fs.existsSync(`${stageDbPath}-wal`), true, 'staged newer DB has live -wal');
    assert.equal(fs.existsSync(`${stageDbPath}-shm`), true, 'staged newer DB has live -shm');
    assert.ok(fs.statSync(`${stageDbPath}-wal`).size > 0, 'staged -wal has uncheckpointed frames');

    // Copy active WAL database + sidecars before closing writerDb so -wal/-shm remain uncheckpointed on disk.
    removeDbSet(destinationDbPath);
    fs.copyFileSync(stageDbPath, destinationDbPath);
    fs.copyFileSync(`${stageDbPath}-wal`, `${destinationDbPath}-wal`);
    fs.copyFileSync(`${stageDbPath}-shm`, `${destinationDbPath}-shm`);
  } finally {
    writerDb?.close();
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  return {
    dbSha: sha256File(destinationDbPath),
    walSha: sha256File(`${destinationDbPath}-wal`),
    shmSha: sha256File(`${destinationDbPath}-shm`),
  };
}

const SQLITE_HOT_JOURNAL_MAGIC = Buffer.from('d9d505f920a163d7', 'hex');

function buildActiveHotJournalDatabase(
  destinationDbPath: string,
  seededCommittedBackupPath: string,
  options: {
    pragmaVersion: number;
    metaSchemaVersion: string;
    appVersion: string;
  },
): { dbSha: string; journalSha: string } {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-hot-journal-stage-'));
  const stageDbPath = path.join(stageDir, 'flo.db');
  fs.copyFileSync(seededCommittedBackupPath, stageDbPath);

  let setupDb: Database.Database | undefined;
  let writerDb: Database.Database | undefined;
  try {
    setupDb = new Database(stageDbPath);
    setupDb.pragma('journal_mode = DELETE');
    setupDb.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
    setupDb
      .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
      .run('app_version', options.appVersion);
    setupDb
      .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
      .run('schema_version', options.metaSchemaVersion);
    setupDb
      .prepare(
        "UPDATE settings SET value = replace(value, 'COMMITTED-', 'NEWER-COMMITTED-') WHERE key LIKE 'hotjournalfill%'",
      )
      .run();
    setupDb.pragma(`user_version = ${options.pragmaVersion}`);
    setupDb.close();
    setupDb = undefined;

    writerDb = new Database(stageDbPath);
    writerDb.pragma('journal_mode = DELETE');
    writerDb.pragma('cache_size = 5');
    writerDb.pragma('synchronous = FULL');
    writerDb.exec('BEGIN IMMEDIATE');
    writerDb
      .prepare(
        "UPDATE settings SET value = 'UNCOMMITTED-' || substr(value, 1, 2000) WHERE key LIKE 'hotjournalfill%'",
      )
      .run();

    const stageJournalPath = `${stageDbPath}-journal`;
    assert.equal(fs.existsSync(stageJournalPath), true, 'genuine SQLite -journal exists on spill');
    const journalHeader = fs.readFileSync(stageJournalPath).subarray(0, 8);
    assert.deepEqual(
      journalHeader,
      SQLITE_HOT_JOURNAL_MAGIC,
      'rollback journal begins with genuine SQLite magic header',
    );

    removeDbSet(destinationDbPath);
    fs.copyFileSync(stageDbPath, destinationDbPath);
    fs.copyFileSync(stageJournalPath, `${destinationDbPath}-journal`);
  } finally {
    try {
      writerDb?.close();
    } catch {}
    try {
      setupDb?.close();
    } catch {}
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  return {
    dbSha: sha256File(destinationDbPath),
    journalSha: sha256File(`${destinationDbPath}-journal`),
  };
}

function verifyPreservedNewerSetReadable(
  baseDbPath: string,
  expectedSchemaVersion: number,
  expectedOrderNumber: string,
): void {
  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-verify-newer-'));
  const verifyDbPath = path.join(verifyDir, 'preserved.db');
  let verifyDb: Database.Database | undefined;
  try {
    fs.copyFileSync(baseDbPath, verifyDbPath);
    if (fs.existsSync(`${baseDbPath}-wal`)) {
      fs.copyFileSync(`${baseDbPath}-wal`, `${verifyDbPath}-wal`);
    }
    if (fs.existsSync(`${baseDbPath}-shm`)) {
      fs.copyFileSync(`${baseDbPath}-shm`, `${verifyDbPath}-shm`);
    }
    verifyDb = new Database(verifyDbPath, { fileMustExist: true });
    const version = Number(verifyDb.pragma('user_version', { simple: true }));
    assert.equal(version, expectedSchemaVersion, 'preserved newer DB retains newer schema version');
    const order = verifyDb
      .prepare('SELECT order_number, total FROM orders WHERE order_number = ?')
      .get(expectedOrderNumber) as { order_number: string; total: number } | undefined;
    assert.deepEqual(
      order,
      { order_number: expectedOrderNumber, total: 42 },
      'preserved newer DB + sidecars retain uncheckpointed post-upgrade order rows',
    );
  } finally {
    verifyDb?.close();
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  console.log('Testing newer-database downgrade recovery flow...');
  const maxSupported = getLatestSupportedSchemaVersion();
  assert.ok(maxSupported >= 2, 'migration registry has at least two versions');
  const olderCompatibleVersion = maxSupported - 1;
  const newerDbVersion = maxSupported + 3;

  const dbPath = getDbPath();
  const backupDir = getBackupDir();
  const secureJwtFilePath = path.join(testDir, 'jwt-secret.enc');
  const previousJwtSecretEnv = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  safeStorageEnabled = true;

  try {
    // Seed a baseline valid database at maxSupported to build clean backup fixtures.
    initDatabase();
    const baseDb = getDatabase();
    baseDb
      .prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
      .run('cat-recovery', 'Recovery Drinks');
    baseDb
      .prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)')
      .run('prod-espresso', 'cat-recovery', 'Espresso', 4.5);
    baseDb
      .prepare(
        "INSERT OR REPLACE INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('user-staff-1', 'Staff One', 'staff1@test.local', 'unused', 'owner', 1, '2026-10-28 09:00:00', '2026-10-28 09:00:00')",
      )
      .run();
    baseDb
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('jwt_secret', ?, '2026-10-28 09:00:00')",
      )
      .run(JWT_SECRET_SAFE_STORAGE_MARKER);
    fs.writeFileSync(secureJwtFilePath, Buffer.from('enc:live-newer-jwt-secret-hex-0001', 'utf8'));
    clearJWTSecretCache();
    assert.equal(getJWTSecret(), 'live-newer-jwt-secret-hex-0001');
    const preRestoreBearerToken = jwt.sign(
      { userId: 'user-staff-1', role: 'owner' },
      getJWTSecret(),
      { expiresIn: '24h' },
    );
    assert.equal(getUserAuthStatus('user-staff-1')?.role, 'owner');
    revokeToken('in-memory-revoked-token');
    assert.equal(isTokenRevoked('in-memory-revoked-token'), true);
    const sameSchemaSeedBackup = (await createBackup()).path;
    const baseTemplateCopy = path.join(testDir, 'base-template.db');
    fs.copyFileSync(sameSchemaSeedBackup, baseTemplateCopy);
    const firstBootPreV0File = fs
      .readdirSync(backupDir)
      .find((name) => name.includes('-pre-v0-to-v'));
    assert.ok(firstBootPreV0File, 'fresh install created a pre-v0 migration backup');
    const preV0TemplateCopy = path.join(testDir, 'pre-v0-template.db');
    fs.copyFileSync(path.join(backupDir, firstBootPreV0File), preV0TemplateCopy);
    closeDatabase();
    clearDirectory(backupDir);

    // 1. Synthetic newer-schema database (DELETE mode + active WAL mode with -wal/-shm sidecars)
    //    must throw SchemaVersionMismatchError without altering flo.db or removing sidecars.
    const deleteModeNewerPath = path.join(testDir, 'newer-delete-mode.db');
    writeStampedSchemaSnapshot(deleteModeNewerPath, maxSupported, {
      appVersion: '4.1.0',
      overridePragmaVersion: newerDbVersion,
    });
    removeDbSet(dbPath);
    fs.copyFileSync(deleteModeNewerPath, dbPath);
    const deleteModeShaBefore = sha256File(dbPath);

    let caughtDeleteMismatch: SchemaVersionMismatchError | null = null;
    assert.throws(
      () => initDatabase(),
      (err: unknown) => {
        if (err instanceof SchemaVersionMismatchError) {
          caughtDeleteMismatch = err;
          return true;
        }
        return false;
      },
      'DELETE-mode newer database throws SchemaVersionMismatchError',
    );
    assert.equal(caughtDeleteMismatch!.dbVersion, newerDbVersion);
    assert.equal(caughtDeleteMismatch!.appVersion, maxSupported);
    assert.equal(caughtDeleteMismatch!.dbAppVersion, '4.1.0');
    assert.equal(isSchemaVersionMismatchError(caughtDeleteMismatch), true);
    assert.equal(
      isSchemaVersionMismatchError({
        name: 'SchemaVersionMismatchError',
        dbVersion: newerDbVersion,
        appVersion: maxSupported,
      }),
      false,
    );
    assert.equal(
      sha256File(dbPath),
      deleteModeShaBefore,
      'DELETE-mode newer database bytes are untouched',
    );

    const staleMetaNewerPath = path.join(testDir, 'newer-stale-meta.db');
    writeStampedSchemaSnapshot(staleMetaNewerPath, maxSupported, {
      appVersion: '3.10.0',
      overridePragmaVersion: newerDbVersion,
      overrideMetaSchemaVersion: String(olderCompatibleVersion),
    });
    removeDbSet(dbPath);
    fs.copyFileSync(staleMetaNewerPath, dbPath);
    let caughtStaleMetaMismatch: SchemaVersionMismatchError | null = null;
    assert.throws(
      () => initDatabase(),
      (err: unknown) => {
        if (err instanceof SchemaVersionMismatchError) {
          caughtStaleMetaMismatch = err;
          return true;
        }
        return false;
      },
    );
    assert.equal(caughtStaleMetaMismatch!.dbVersion, newerDbVersion);
    assert.equal(
      caughtStaleMetaMismatch!.dbAppVersion,
      null,
      'stale _flo_meta.app_version with mismatched _flo_meta.schema_version is ignored',
    );

    const walHashes = buildActiveNewerWalDatabase(
      dbPath,
      baseTemplateCopy,
      newerDbVersion,
      '4.2.0',
    );
    let caughtWalMismatch: SchemaVersionMismatchError | null = null;
    assert.throws(
      () => initDatabase(),
      (err: unknown) => {
        if (err instanceof SchemaVersionMismatchError) {
          caughtWalMismatch = err;
          return true;
        }
        return false;
      },
      'WAL-mode newer database throws SchemaVersionMismatchError even when user_version bump is in -wal',
    );
    assert.equal(caughtWalMismatch!.dbVersion, newerDbVersion);
    assert.equal(caughtWalMismatch!.appVersion, maxSupported);
    assert.equal(caughtWalMismatch!.dbAppVersion, '4.2.0');
    assert.equal(sha256File(dbPath), walHashes.dbSha, 'WAL newer flo.db bytes untouched');
    assert.equal(
      sha256File(`${dbPath}-wal`),
      walHashes.walSha,
      'WAL newer flo.db-wal preserved untouched',
    );
    assert.equal(
      sha256File(`${dbPath}-shm`),
      walHashes.shmSha,
      'WAL newer flo.db-shm preserved untouched',
    );

    // 2. Backup discovery & content validation (ignoring misleading filenames).
    clearDirectory(backupDir);

    const preUpgradeBackupPath = path.join(
      backupDir,
      `flo-backup-2026-10-28T10-00-00-000Z-pre-v${olderCompatibleVersion}-to-v${newerDbVersion}.db`,
    );
    writeStampedSchemaSnapshot(preUpgradeBackupPath, olderCompatibleVersion, {
      appVersion: '3.12.9',
      backupCreatedAt: '2026-10-28T10:00:00.000Z',
      seed: (snapDb) => {
        snapDb
          .prepare('INSERT INTO categories (id, name) VALUES (?, ?)')
          .run('cat-pre', 'Pre-Upgrade Category');
        snapDb
          .prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)')
          .run('prod-pre', 'cat-pre', 'Pre-Upgrade Cortado', 5.25);
        snapDb
          .prepare(`
            INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
            VALUES ('ORD-20261028-0007', 'dine_in', 'completed', 5.25, 5.25, '2026-10-28 09:45:00', '2026-10-28 09:50:00')
          `)
          .run();
        const tables = new Set(
          (
            snapDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
              name: string;
            }[]
          ).map((r) => r.name),
        );
        if (tables.has('kds_pairing_tokens')) {
          snapDb
            .prepare(
              "INSERT INTO kds_pairing_tokens (id, token, created_at, expires_at) VALUES ('kds-tok-1', 'stale-kds-token', '2026-10-28 09:00:00', '2099-01-01 00:00:00')",
            )
            .run();
        }
        snapDb
          .prepare(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('google_drive_account_subject', 'stale-drive-subject', '2026-10-28 09:00:00')",
          )
          .run();
        snapDb
          .prepare(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('jwt_secret', ?, '2026-10-28 09:00:00')",
          )
          .run(JWT_SECRET_SAFE_STORAGE_MARKER);
        snapDb
          .prepare(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('mobile_pairing_code', '654321', '2026-10-28 09:00:00')",
          )
          .run();
        snapDb
          .prepare(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('mobile_pairing_code_expires_at', '2099-01-01T00:00:00.000Z', '2026-10-28 09:00:00')",
          )
          .run();
        snapDb
          .prepare(
            "INSERT OR REPLACE INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('user-staff-1', 'Staff One', 'staff1@test.local', 'unused', 'server', 1, '2026-10-28 09:00:00', '2026-10-28 09:00:00')",
          )
          .run();
      },
    });

    // Misleading filename claims v999->v1000, but actual SQLite contents are valid maxSupported.
    const misleadingCompatiblePath = path.join(
      backupDir,
      'flo-backup-2026-10-28T08-00-00-000Z-pre-v999-to-v1000.db',
    );
    fs.copyFileSync(baseTemplateCopy, misleadingCompatiblePath);
    {
      const fixMetaDb = new Database(misleadingCompatiblePath);
      fixMetaDb
        .prepare("INSERT OR REPLACE INTO _flo_meta (key, value) VALUES ('backup_created_at', ?)")
        .run('2026-10-28T08:00:00.000Z');
      fixMetaDb.close();
    }

    // Misleading filename claims v1->v2, but actual SQLite contents require maxSupported + 5.
    const misleadingNewerPath = path.join(
      backupDir,
      'flo-backup-2026-10-28T11-00-00-000Z-pre-v1-to-v2.db',
    );
    writeStampedSchemaSnapshot(misleadingNewerPath, maxSupported, {
      appVersion: '5.0.0',
      backupCreatedAt: '2026-10-28T11:00:00.000Z',
      overridePragmaVersion: maxSupported + 5,
    });

    // Corrupt/truncated file with a normal managed backup filename.
    const corruptBackupPath = path.join(backupDir, 'flo-backup-2026-10-28T07-00-00-000Z.db');
    fs.writeFileSync(corruptBackupPath, Buffer.from('not a valid sqlite file at all'));

    // Header/metadata mismatch file.
    const mismatchMetaBackupPath = path.join(
      backupDir,
      'flo-backup-2026-10-28T06-00-00-000Z-meta-mismatch.db',
    );
    writeStampedSchemaSnapshot(mismatchMetaBackupPath, maxSupported, {
      appVersion: '3.13.14',
      overrideMetaSchemaVersion: '1',
    });

    // Non-Flo SQLite database with valid SQLite integrity and user_version = 2.
    const unrelatedSqlitePath = path.join(backupDir, 'unrelated-sqlite.db');
    {
      const unrelatedDb = new Database(unrelatedSqlitePath);
      unrelatedDb.exec('CREATE TABLE cookies (name TEXT PRIMARY KEY, value TEXT)');
      unrelatedDb.pragma('user_version = 2');
      unrelatedDb.close();
    }

    const preV0BackupPath = path.join(
      backupDir,
      `flo-backup-2026-10-28T05-00-00-000Z-pre-v0-to-v${maxSupported}.db`,
    );
    fs.copyFileSync(preV0TemplateCopy, preV0BackupPath);

    const discovery = await discoverDowngradeBackupsAsync();
    assert.equal(discovery.maxSupportedSchemaVersion, maxSupported);
    assert.deepEqual(
      discovery.compatible.map((item) => ({
        fileName: item.fileName,
        schemaVersion: item.schemaVersion,
        appVersion: item.appVersion,
        backupCreatedAt: item.backupCreatedAt,
      })),
      [
        {
          fileName: path.basename(preUpgradeBackupPath),
          schemaVersion: olderCompatibleVersion,
          appVersion: '3.12.9',
          backupCreatedAt: '2026-10-28T10:00:00.000Z',
        },
        {
          fileName: path.basename(misleadingCompatiblePath),
          schemaVersion: maxSupported,
          appVersion: '3.13.14',
          backupCreatedAt: '2026-10-28T08:00:00.000Z',
        },
      ],
      'discovery validates SQLite contents rather than filenames and sorts newest compatible first',
    );
    assert.deepEqual(
      discovery.incompatibleNewer.map((item) => ({
        fileName: item.fileName,
        schemaVersion: item.schemaVersion,
        appVersion: item.appVersion,
      })),
      [
        {
          fileName: path.basename(misleadingNewerPath),
          schemaVersion: maxSupported + 5,
          appVersion: '5.0.0',
        },
      ],
      'misleadingly named newer backup is rejected as incompatible_newer',
    );
    assert.deepEqual(
      discovery.corruptOrInvalid.map((item) => item.fileName).sort(),
      [
        path.basename(corruptBackupPath),
        path.basename(mismatchMetaBackupPath),
        path.basename(preV0BackupPath),
        path.basename(unrelatedSqlitePath),
      ].sort(),
      'corrupt, metadata-mismatched, pre-v0, and non-Flo SQLite files are rejected as corrupt_or_invalid',
    );
    const rejectedByName = new Map(discovery.corruptOrInvalid.map((item) => [item.fileName, item]));
    assert.equal(
      rejectedByName.get(path.basename(preV0BackupPath))?.detail,
      'Backup does not contain an initialized Flo Cafe schema',
      'first-boot pre-v0 snapshot reports uninitialized schema rather than header mismatch',
    );
    assert.equal(rejectedByName.get(path.basename(preV0BackupPath))?.schemaVersion, null);
    assert.equal(
      rejectedByName.get(path.basename(mismatchMetaBackupPath))?.detail,
      'Backup schema metadata does not match the SQLite header',
      'true header/metadata mismatch still reports mismatch detail',
    );

    // 3a. Recovery dialog when NO compatible backups exist keeps Get Latest Version,
    //     Open Backups Folder, and Exit available without modifying any files.
    const openedUrls: string[] = [];
    const openedPaths: string[] = [];
    const noCompatibleDialogs: { title?: string; detail?: string; buttons?: string[] }[] = [];
    const noCompatibleOutcome = await runDowngradeRecoveryFlow(caughtWalMismatch!, {
      appVersion: '3.13.14',
      dialog: {
        showMessageBox: async (options: any) => {
          noCompatibleDialogs.push({
            title: options.title,
            detail: options.detail,
            buttons: options.buttons,
          });
          // Main screen -> Restore Compatible Backup (2), then Empty screen -> Open Backups Folder (1),
          // then Main screen -> Get Latest Version (0).
          if (noCompatibleDialogs.length === 1) return { response: 2, checkboxChecked: false };
          if (noCompatibleDialogs.length === 2) return { response: 1, checkboxChecked: false };
          return { response: 0, checkboxChecked: false };
        },
      } as any,
      shell: {
        openExternal: async (url: string) => {
          openedUrls.push(url);
        },
        openPath: async (target: string) => {
          openedPaths.push(target);
          return '';
        },
      },
      log: { info() {}, warn() {}, error() {} },
      isShutdownRequested: () => false,
      discoverBackups: async () => ({
        backupDir,
        maxSupportedSchemaVersion: maxSupported,
        compatible: [],
        incompatibleNewer: discovery.incompatibleNewer,
        corruptOrInvalid: discovery.corruptOrInvalid,
      }),
      planPreservedArchivePath: planNewerDatabaseArchivePath,
      restoreBackup: restoreCompatibleBackupForDowngrade,
      getBackupDir,
      getDbPath,
    });
    assert.deepEqual(noCompatibleOutcome, {
      outcome: 'opened_releases',
      url: FLOCAFE_RELEASES_URL,
    });
    assert.equal(noCompatibleDialogs[1]?.title, 'No Compatible Backup Available');
    assert.deepEqual(noCompatibleDialogs[1]?.buttons, [
      'Get Latest Version',
      'Open Backups Folder',
      'Exit',
    ]);
    assert.match(noCompatibleDialogs[1]?.detail || '', /require a newer Flo Cafe version/);
    assert.match(noCompatibleDialogs[1]?.detail || '', /failed integrity or schema validation/);
    assert.deepEqual(openedPaths, [backupDir], 'Open Backups Folder reveals backupDir');
    assert.deepEqual(
      openedUrls,
      [FLOCAFE_RELEASES_URL],
      'Get Latest Version opens official releases URL',
    );
    assert.equal(
      sha256File(dbPath),
      walHashes.dbSha,
      'no-compatible-backups flow touches zero DB bytes',
    );
    assert.equal(sha256File(`${dbPath}-wal`), walHashes.walSha);
    assert.equal(sha256File(`${dbPath}-shm`), walHashes.shmSha);

    // 3b. Confirmation cancellation leaves newer DB and -wal/-shm sidecars completely untouched.
    const cancelDialogs: { title?: string; detail?: string }[] = [];
    const cancelOutcome = await runDowngradeRecoveryFlow(caughtWalMismatch!, {
      appVersion: '3.13.14',
      dialog: {
        showMessageBox: async (options: any) => {
          cancelDialogs.push({ title: options.title, detail: options.detail });
          // 1: Restore Compatible Backup -> 2: select #1 -> 3: Cancel confirmation -> 4: Exit
          if (cancelDialogs.length === 1) return { response: 2, checkboxChecked: false };
          if (cancelDialogs.length === 2) return { response: 0, checkboxChecked: false };
          if (cancelDialogs.length === 3) return { response: 1, checkboxChecked: false };
          return { response: 3, checkboxChecked: false };
        },
      } as any,
      shell: {
        openExternal: async () => {},
        openPath: async () => '',
      },
      log: { info() {}, warn() {}, error() {} },
      isShutdownRequested: () => false,
      discoverBackups: () => discoverDowngradeBackupsAsync(),
      planPreservedArchivePath: planNewerDatabaseArchivePath,
      restoreBackup: restoreCompatibleBackupForDowngrade,
      getBackupDir,
      getDbPath,
    });
    assert.deepEqual(cancelOutcome, { outcome: 'exit' });
    assert.equal(cancelDialogs[2]?.title, 'Confirm Backup Restore');
    assert.match(
      cancelDialogs[2]?.detail || '',
      /orders, payments, inventory changes, or settings recorded since this backup was created will NOT be present/,
      'confirmation dialog warns about absent post-backup changes',
    );
    assert.match(
      cancelDialogs[2]?.detail || '',
      /flo-preserved-newer-v/,
      'confirmation dialog states exact preserved newer-DB archive path',
    );
    assert.equal(sha256File(dbPath), walHashes.dbSha, 'cancelled restore leaves flo.db untouched');
    assert.equal(
      sha256File(`${dbPath}-wal`),
      walHashes.walSha,
      'cancelled restore leaves flo.db-wal untouched',
    );
    assert.equal(
      sha256File(`${dbPath}-shm`),
      walHashes.shmSha,
      'cancelled restore leaves flo.db-shm untouched',
    );
    assert.deepEqual(
      fs.readdirSync(backupDir).filter((name) => name.startsWith('flo-preserved-newer-')),
      [],
      'cancelled restore leaves no preserved archive files behind',
    );

    for (const shutdownScenario of [
      'restore-abort',
      'open-external-fail',
      'open-path-error',
      'open-path-throw',
    ] as const) {
      let shutdownActive = false;
      const seenDialogTitles: string[] = [];
      const shutdownOutcome = await runDowngradeRecoveryFlow(caughtWalMismatch!, {
        appVersion: '3.13.14',
        dialog: {
          showMessageBox: async (options: any) => {
            seenDialogTitles.push(options.title);
            if (shutdownScenario === 'restore-abort') {
              if (seenDialogTitles.length === 1) return { response: 2, checkboxChecked: false };
              return { response: 0, checkboxChecked: false };
            }
            if (shutdownScenario === 'open-external-fail') {
              return { response: 0, checkboxChecked: false };
            }
            return { response: 1, checkboxChecked: false };
          },
        } as any,
        shell: {
          openExternal: async () => {
            shutdownActive = true;
            throw new Error('browser unavailable during shutdown');
          },
          openPath: async () => {
            shutdownActive = true;
            if (shutdownScenario === 'open-path-throw') {
              throw new Error('file manager unavailable during shutdown');
            }
            return 'could not open path during shutdown';
          },
        },
        log: { info() {}, warn() {}, error() {} },
        isShutdownRequested: () => shutdownActive,
        discoverBackups: () => discoverDowngradeBackupsAsync(),
        planPreservedArchivePath: planNewerDatabaseArchivePath,
        restoreBackup: async () => {
          shutdownActive = true;
          const abortErr = new Error('Database maintenance cancelled during shutdown') as Error & {
            code?: string;
          };
          abortErr.code = 'ERR_SHUTDOWN_ABORTED';
          throw abortErr;
        },
        getBackupDir,
        getDbPath,
      });
      assert.deepEqual(shutdownOutcome, { outcome: 'exit' });
      assert.equal(
        seenDialogTitles.includes('Backup Restore Failed'),
        false,
        `no Backup Restore Failed dialog on ${shutdownScenario}`,
      );
      assert.equal(
        seenDialogTitles.includes('Cannot Open Download Page'),
        false,
        `no Cannot Open Download Page dialog on ${shutdownScenario}`,
      );
      assert.equal(
        seenDialogTitles.includes('Cannot Open Backups Folder'),
        false,
        `no Cannot Open Backups Folder dialog on ${shutdownScenario}`,
      );
    }

    // 4a. Direct calls with missing, corrupt, or newer-incompatible backups fail closed before touching DB.
    await assert.rejects(
      () => restoreCompatibleBackupForDowngrade(path.join(backupDir, 'missing-does-not-exist.db')),
      /ENOENT|no such file/i,
      'missing backup fails before touching active DB',
    );
    await assert.rejects(
      () => restoreCompatibleBackupForDowngrade(corruptBackupPath),
      /failed validation/i,
      'corrupt backup fails validation before touching active DB',
    );
    await assert.rejects(
      () => restoreCompatibleBackupForDowngrade(misleadingNewerPath),
      /Requires schema v/i,
      'newer-schema backup fails compatibility check before touching active DB',
    );
    assert.equal(sha256File(dbPath), walHashes.dbSha);
    assert.equal(sha256File(`${dbPath}-wal`), walHashes.walSha);
    assert.equal(sha256File(`${dbPath}-shm`), walHashes.shmSha);

    // 4b. Simulated mid-replacement I/O failure rolls back flo.db + -wal + -shm cleanly,
    //     cleans up temporary journal artifacts, preserves archive, and surfaces actionable error.
    const mutableFs = nativeFs as unknown as { copyFileSync: typeof fs.copyFileSync };
    const originalCopyFileSync = nativeFs.copyFileSync;
    let injectedInstallFailureFired = false;
    mutableFs.copyFileSync = ((source, target, mode) => {
      if (
        !injectedInstallFailureFired &&
        String(target) === dbPath &&
        String(source).includes('flo-restore-source-')
      ) {
        injectedInstallFailureFired = true;
        throw new Error('simulated ENOSPC while writing compatible backup');
      }
      return originalCopyFileSync(source, target, mode);
    }) as typeof fs.copyFileSync;

    const failureDialogs: { title?: string; detail?: string }[] = [];
    let failureOutcome;
    try {
      failureOutcome = await runDowngradeRecoveryFlow(caughtWalMismatch!, {
        appVersion: '3.13.14',
        dialog: {
          showMessageBox: async (options: any) => {
            failureDialogs.push({ title: options.title, detail: options.detail });
            // 1: Restore -> 2: select #1 -> 3: Confirm -> 4: Backup Restore Failed -> Exit (2)
            if (failureDialogs.length === 1) return { response: 2, checkboxChecked: false };
            if (failureDialogs.length === 2) return { response: 0, checkboxChecked: false };
            if (failureDialogs.length === 3) return { response: 0, checkboxChecked: false };
            return { response: 2, checkboxChecked: false };
          },
        } as any,
        shell: { openExternal: async () => {}, openPath: async () => '' },
        log: { info() {}, warn() {}, error() {} },
        isShutdownRequested: () => false,
        discoverBackups: () => discoverDowngradeBackupsAsync(),
        planPreservedArchivePath: planNewerDatabaseArchivePath,
        restoreBackup: restoreCompatibleBackupForDowngrade,
        getBackupDir,
        getDbPath,
      });
    } finally {
      mutableFs.copyFileSync = originalCopyFileSync;
    }

    assert.equal(injectedInstallFailureFired, true, 'fault injection triggered mid-replacement');
    assert.deepEqual(failureOutcome, { outcome: 'exit' });
    assert.equal(failureDialogs[3]?.title, 'Backup Restore Failed');
    assert.match(
      failureDialogs[3]?.detail || '',
      /simulated ENOSPC while writing compatible backup/,
      'failure dialog surfaces actionable error reason',
    );
    assert.match(
      failureDialogs[3]?.detail || '',
      /restored in place and preserved at/,
      'failure dialog confirms rollback and preserved archive location',
    );
    assert.equal(
      sha256File(dbPath),
      walHashes.dbSha,
      'mid-replacement rollback restores flo.db byte-for-byte',
    );
    assert.equal(
      sha256File(`${dbPath}-wal`),
      walHashes.walSha,
      'mid-replacement rollback restores flo.db-wal byte-for-byte',
    );
    assert.equal(
      sha256File(`${dbPath}-shm`),
      walHashes.shmSha,
      'mid-replacement rollback restores flo.db-shm byte-for-byte',
    );
    assert.deepEqual(
      fs.readdirSync(backupDir).filter((name) => name.includes('recovery-')),
      [],
      'mid-replacement rollback cleans up temporary journal artifacts',
    );

    // 4c. Simulated process crash leaving a prepared downgrade replacement journal + sidecars on disk
    //     while live flo.db is missing: next startup recovers flo.db + -wal + -shm and re-raises SchemaVersionMismatchError.
    const crashJournalBase = path.join(backupDir, 'flo-restore-recovery-crashtest01');
    fs.copyFileSync(dbPath, `${crashJournalBase}.db`);
    fs.copyFileSync(`${dbPath}-wal`, `${crashJournalBase}.db-wal`);
    fs.copyFileSync(`${dbPath}-shm`, `${crashJournalBase}.db-shm`);
    fs.writeFileSync(
      `${crashJournalBase}.json`,
      JSON.stringify({
        phase: 'prepared',
        recoveryPath: `${crashJournalBase}.db`,
        dbPath,
        driveInvalidationRequired: true,
        downgradeRecovery: true,
        recoverySidecars: ['-wal', '-shm'],
      }),
    );
    // Simulate crash right after live database files were removed.
    removeDbSet(dbPath);
    assert.equal(fs.existsSync(dbPath), false);

    assert.throws(
      () => initDatabase(),
      (err: unknown) =>
        err instanceof SchemaVersionMismatchError && err.dbVersion === newerDbVersion,
      'startup recovers interrupted downgrade replacement and detects the restored newer DB',
    );
    assert.equal(
      sha256File(dbPath),
      walHashes.dbSha,
      'crash-recovery restores newer flo.db byte-for-byte',
    );
    assert.equal(
      sha256File(`${dbPath}-wal`),
      walHashes.walSha,
      'crash-recovery restores newer flo.db-wal byte-for-byte',
    );
    assert.equal(
      sha256File(`${dbPath}-shm`),
      walHashes.shmSha,
      'crash-recovery restores newer flo.db-shm byte-for-byte',
    );
    assert.equal(
      fs.existsSync(`${crashJournalBase}.json`),
      false,
      'crash-recovery removes consumed prepared journal',
    );
    verifyPreservedNewerSetReadable(dbPath, newerDbVersion, 'ORD-AFTER-UPGRADE-900');

    const nonArchiveBackupsBefore4d = fs
      .readdirSync(backupDir)
      .filter((name) => !name.startsWith('flo-preserved-newer-'))
      .sort();
    const schemaDriftOlderBackupPath = path.join(
      backupDir,
      `flo-backup-2026-10-28T10-30-00-000Z-pre-v${olderCompatibleVersion}-to-v${newerDbVersion}.db`,
    );
    writeStampedSchemaSnapshot(schemaDriftOlderBackupPath, olderCompatibleVersion, {
      appVersion: '3.12.9',
      backupCreatedAt: '2026-10-28T10:30:00.000Z',
      seed: (snapDb) => {
        snapDb.exec('CREATE TABLE unexpected_rogue_artifact (id TEXT PRIMARY KEY)');
      },
    });
    const schemaDriftDialogs: { title?: string; detail?: string }[] = [];
    const schemaDriftOutcome = await runDowngradeRecoveryFlow(caughtWalMismatch!, {
      appVersion: '3.13.14',
      dialog: {
        showMessageBox: async (options: any) => {
          schemaDriftDialogs.push({ title: options.title, detail: options.detail });
          if (schemaDriftDialogs.length === 1) return { response: 2, checkboxChecked: false };
          if (schemaDriftDialogs.length === 2) return { response: 0, checkboxChecked: false };
          if (schemaDriftDialogs.length === 3) return { response: 0, checkboxChecked: false };
          return { response: 2, checkboxChecked: false };
        },
      } as any,
      shell: { openExternal: async () => {}, openPath: async () => '' },
      log: { info() {}, warn() {}, error() {} },
      isShutdownRequested: () => false,
      discoverBackups: () => discoverDowngradeBackupsAsync(),
      planPreservedArchivePath: planNewerDatabaseArchivePath,
      restoreBackup: restoreCompatibleBackupForDowngrade,
      getBackupDir,
      getDbPath,
    });
    assert.deepEqual(schemaDriftOutcome, { outcome: 'exit' });
    assert.equal(schemaDriftDialogs[3]?.title, 'Backup Restore Failed');
    assert.match(
      schemaDriftDialogs[3]?.detail || '',
      /Restored database table structure does not match schema v/,
      'post-migration tableColumns mismatch surfaces Backup Restore Failed instead of committing',
    );
    assert.equal(
      sha256File(dbPath),
      walHashes.dbSha,
      'post-migration schema failure rolls back flo.db',
    );
    assert.equal(
      sha256File(`${dbPath}-wal`),
      walHashes.walSha,
      'post-migration schema failure rolls back flo.db-wal',
    );
    assert.equal(
      sha256File(`${dbPath}-shm`),
      walHashes.shmSha,
      'post-migration schema failure rolls back flo.db-shm',
    );
    assert.deepEqual(
      fs.readdirSync(backupDir).filter((name) => name.includes('recovery-')),
      [],
      'post-migration schema failure cleans up temporary journal artifacts',
    );
    assert.equal(
      fs.readFileSync(secureJwtFilePath, 'utf8'),
      'enc:live-newer-jwt-secret-hex-0001',
      'rollback leaves OS-backed jwt-secret.enc untouched',
    );
    assert.equal(
      getJWTSecret(),
      'live-newer-jwt-secret-hex-0001',
      'rollback leaves cached JWT secret untouched',
    );
    fs.unlinkSync(schemaDriftOlderBackupPath);
    assert.deepEqual(
      fs
        .readdirSync(backupDir)
        .filter((name) => !name.startsWith('flo-preserved-newer-'))
        .sort(),
      nonArchiveBackupsBefore4d,
      'failed forward-migrating downgrade restore leaves zero extra pre-migration backups behind',
    );
    for (const fileName of fs.readdirSync(backupDir)) {
      if (fileName.startsWith('flo-preserved-newer-')) {
        fs.unlinkSync(path.join(backupDir, fileName));
      }
    }

    // 5. Successful restore of pre-upgrade backup (olderCompatibleVersion -> maxSupported):
    //    preserves newer DB + -wal/-shm sidecars, commits journal, and completes normal initDatabase().
    const successDialogs: string[] = [];
    const restoreOutcome = await runDowngradeRecoveryFlow(caughtWalMismatch!, {
      appVersion: '3.13.14',
      dialog: {
        showMessageBox: async (options: any) => {
          successDialogs.push(options.title);
          // 1: Restore Compatible Backup -> 2: select #1 (pre-upgrade v(maxSupported-1)) -> 3: Confirm
          if (successDialogs.length === 1) return { response: 2, checkboxChecked: false };
          if (successDialogs.length === 2) return { response: 0, checkboxChecked: false };
          return { response: 0, checkboxChecked: false };
        },
      } as any,
      shell: { openExternal: async () => {}, openPath: async () => '' },
      log: { info() {}, warn() {}, error() {} },
      isShutdownRequested: () => false,
      discoverBackups: () => discoverDowngradeBackupsAsync(),
      planPreservedArchivePath: planNewerDatabaseArchivePath,
      restoreBackup: restoreCompatibleBackupForDowngrade,
      getBackupDir,
      getDbPath,
    });

    assert.equal(restoreOutcome.outcome, 'restored');
    const restoreResult = restoreOutcome.result;
    assert.equal(restoreResult.backupSchemaVersion, olderCompatibleVersion);
    assert.equal(restoreResult.restoredSchemaVersion, maxSupported);
    assert.equal(fs.existsSync(restoreResult.preservedDbPath), true, 'preserved newer DB exists');
    assert.deepEqual(
      restoreResult.preservedSidecarPaths,
      [`${restoreResult.preservedDbPath}-wal`, `${restoreResult.preservedDbPath}-shm`],
      'both -wal and -shm sidecar paths are recorded and preserved',
    );
    assert.equal(
      sha256File(restoreResult.preservedDbPath),
      walHashes.dbSha,
      'preserved newer DB matches original flo.db byte-for-byte',
    );
    assert.equal(
      sha256File(`${restoreResult.preservedDbPath}-wal`),
      walHashes.walSha,
      'preserved -wal matches original flo.db-wal byte-for-byte',
    );
    assert.equal(
      sha256File(`${restoreResult.preservedDbPath}-shm`),
      walHashes.shmSha,
      'preserved -shm matches original flo.db-shm byte-for-byte',
    );
    verifyPreservedNewerSetReadable(
      restoreResult.preservedDbPath,
      newerDbVersion,
      'ORD-AFTER-UPGRADE-900',
    );

    // Now run normal startup initDatabase() exactly as initialize() in main/index.ts does!
    initDatabase();
    const committedJournal = getDatabaseReplacementJournal();
    assert.equal(
      committedJournal?.phase,
      'committed',
      'committed replacement journal is preserved across initDatabase() for Google Drive invalidation',
    );
    finalizeDatabaseReplacementJournal(committedJournal!);
    assert.equal(
      getDatabaseReplacementJournal(),
      null,
      'finalizing committed journal removes temporary recovery snapshot',
    );
    assert.equal(
      fs.existsSync(restoreResult.preservedDbPath),
      true,
      'finalizing replacement journal never deletes preserved newer-DB archive',
    );
    assert.equal(
      fs.existsSync(`${restoreResult.preservedDbPath}-wal`),
      true,
      'finalizing replacement journal never deletes preserved -wal sidecar',
    );
    assert.equal(
      fs.existsSync(`${restoreResult.preservedDbPath}-shm`),
      true,
      'finalizing replacement journal never deletes preserved -shm sidecar',
    );

    const activeDb = getDatabase();
    assert.equal(
      getCurrentSchemaVersion(),
      maxSupported,
      'restored older backup is migrated forward to maxSupported',
    );
    const restoredOrder = activeDb
      .prepare('SELECT order_number, total FROM orders WHERE order_number = ?')
      .get('ORD-20261028-0007') as { order_number: string; total: number } | undefined;
    assert.deepEqual(
      restoredOrder,
      { order_number: 'ORD-20261028-0007', total: 5.25 },
      'pre-upgrade order data is present after restore',
    );
    const absentNewerOrder = activeDb
      .prepare('SELECT order_number FROM orders WHERE order_number = ?')
      .get('ORD-AFTER-UPGRADE-900');
    assert.equal(
      absentNewerOrder,
      undefined,
      'post-upgrade order is absent from restored database as warned in confirmation',
    );
    const kdsTokensRemaining = (
      activeDb.prepare('SELECT COUNT(*) AS count FROM kds_pairing_tokens').get() as {
        count: number;
      }
    ).count;
    assert.equal(kdsTokensRemaining, 0, 'stale KDS pairing tokens are cleared on restore');
    const staleDriveSubject = activeDb
      .prepare("SELECT value FROM settings WHERE key = 'google_drive_account_subject'")
      .get();
    assert.equal(staleDriveSubject, undefined, 'Google Drive restore binding is cleared');
    const rotatedJwtSecret = getJWTSecret();
    assert.notEqual(
      rotatedJwtSecret,
      'live-newer-jwt-secret-hex-0001',
      'committed downgrade restore rotates the JWT signing secret',
    );
    assert.match(rotatedJwtSecret, /^[0-9a-f]{64}$/, 'rotated JWT secret is 32-byte random hex');
    assert.throws(
      () => jwt.verify(preRestoreBearerToken, rotatedJwtSecret),
      'bearer JWT minted before downgrade restore is rejected after secret rotation',
    );
    assert.equal(
      fs.readFileSync(secureJwtFilePath, 'utf8'),
      `enc:${rotatedJwtSecret}`,
      'getJWTSecret() rotates OS-backed jwt-secret.enc to the new secret on startup',
    );
    assert.equal(
      (
        activeDb.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as {
          value: string;
        }
      ).value,
      JWT_SECRET_SAFE_STORAGE_MARKER,
      'settings.jwt_secret upgrades back to safe-storage marker after rotating jwt-secret.enc',
    );
    assert.equal(
      activeDb
        .prepare("SELECT key FROM settings WHERE key LIKE 'mobile\\_pairing\\_code%' ESCAPE '\\'")
        .all().length,
      0,
      'stale mobile pairing codes are cleared on downgrade restore',
    );
    assert.equal(
      getUserAuthStatus('user-staff-1')?.role,
      'server',
      'in-memory userAuthCache is cleared on downgrade restore so restored user role applies',
    );
    assert.equal(
      isTokenRevoked('in-memory-revoked-token'),
      false,
      'in-memory revoked token set is cleared on downgrade restore',
    );
    const activeMetaRows = activeDb.prepare('SELECT key, value FROM _flo_meta').all() as {
      key: string;
      value: string | null;
    }[];
    const activeMeta = new Map(activeMetaRows.map((row) => [row.key, row.value]));
    assert.equal(activeMeta.get('schema_version'), String(maxSupported));
    assert.equal(
      activeMeta.get('app_version'),
      '3.13.14',
      '_flo_meta.app_version is aligned with running app version after forward migration',
    );
    assert.equal(
      activeMeta.has('backup_created_at'),
      false,
      'backup-only backup_created_at stamp is removed from live _flo_meta after restore',
    );
    const sequenceRow = activeDb
      .prepare("SELECT current_value FROM sequences WHERE name = 'orders' AND date = '20261028'")
      .get() as { current_value: number } | undefined;
    assert.equal(sequenceRow?.current_value, 7, 'order sequence counters are repaired on restore');
    assert.equal(
      runHealthCheck().findings.length,
      0,
      'restored and migrated database passes runHealthCheck() with zero drift',
    );
    assert.deepEqual(
      fs
        .readdirSync(backupDir)
        .filter((name) => !name.startsWith('flo-preserved-newer-'))
        .sort(),
      nonArchiveBackupsBefore4d,
      'successful forward-migrating downgrade restore does not write duplicate pre-migration backups',
    );

    for (const [index, isDowngradeJournal] of [true, false].entries()) {
      const orderNumber = `ORD-20261029-000${index + 1}`;
      const journalBase = path.join(backupDir, `flo-restore-recovery-walcommit0${index + 1}`);
      if (isDowngradeJournal) {
        fs.copyFileSync(restoreResult.preservedDbPath, `${journalBase}.db`);
        fs.copyFileSync(`${restoreResult.preservedDbPath}-wal`, `${journalBase}.db-wal`);
        fs.copyFileSync(`${restoreResult.preservedDbPath}-shm`, `${journalBase}.db-shm`);
      } else {
        fs.copyFileSync(baseTemplateCopy, `${journalBase}.db`);
      }
      fs.writeFileSync(
        `${journalBase}.json`,
        JSON.stringify({
          phase: 'committed',
          recoveryPath: `${journalBase}.db`,
          dbPath,
          driveInvalidationRequired: true,
          ...(isDowngradeJournal
            ? { downgradeRecovery: true, recoverySidecars: ['-wal', '-shm'] }
            : { baselineForeignKeyViolations: [] }),
        }),
      );

      const crashStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-committed-wal-crash-'));
      try {
        const openDb = getDatabase();
        openDb.pragma('wal_autocheckpoint = 0');
        openDb
          .prepare(`
            INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
            VALUES (?, 'takeaway', 'completed', 9.5, 9.5, '2026-10-29 12:00:00', '2026-10-29 12:05:00')
          `)
          .run(orderNumber);
        assert.ok(fs.statSync(`${dbPath}-wal`).size > 0);
        fs.copyFileSync(dbPath, path.join(crashStageDir, 'flo.db'));
        fs.copyFileSync(`${dbPath}-wal`, path.join(crashStageDir, 'flo.db-wal'));
        closeDatabase();
        removeDbSet(dbPath);
        fs.copyFileSync(path.join(crashStageDir, 'flo.db'), dbPath);
        fs.copyFileSync(path.join(crashStageDir, 'flo.db-wal'), `${dbPath}-wal`);
        assert.equal(fs.existsSync(`${dbPath}-shm`), false);
      } finally {
        fs.rmSync(crashStageDir, { recursive: true, force: true });
      }

      initDatabase();
      const retainedCommitted = getDatabaseReplacementJournal();
      assert.equal(
        retainedCommitted?.phase,
        'committed',
        `committed journal (downgrade=${isDowngradeJournal}) survives unclean WAL restart`,
      );
      assert.deepEqual(
        getDatabase()
          .prepare('SELECT order_number FROM orders WHERE order_number = ?')
          .get(orderNumber),
        { order_number: orderNumber },
        `unrecovered WAL frames survive startup when committed journal (downgrade=${isDowngradeJournal}) is pending Drive invalidation`,
      );
      finalizeDatabaseReplacementJournal(retainedCommitted!);
    }
    closeDatabase();

    const upgradedAfterCommitHashes = buildActiveNewerWalDatabase(
      dbPath,
      baseTemplateCopy,
      newerDbVersion,
      '4.3.0',
    );
    for (const [index, isDowngradeJournal] of [true, false].entries()) {
      const journalBase = path.join(backupDir, `flo-restore-recovery-newercommit0${index + 1}`);
      fs.copyFileSync(baseTemplateCopy, `${journalBase}.db`);
      fs.writeFileSync(
        `${journalBase}.json`,
        JSON.stringify({
          phase: 'committed',
          recoveryPath: `${journalBase}.db`,
          dbPath,
          driveInvalidationRequired: true,
          ...(isDowngradeJournal ? { downgradeRecovery: true, recoverySidecars: [] } : {}),
        }),
      );
      let caughtCommittedMismatch: SchemaVersionMismatchError | null = null;
      assert.throws(
        () => initDatabase(),
        (err: unknown) => {
          if (err instanceof SchemaVersionMismatchError) {
            caughtCommittedMismatch = err;
            return true;
          }
          return false;
        },
        `committed journal (downgrade=${isDowngradeJournal}) never rolls back a subsequently upgraded newer DB`,
      );
      assert.equal(caughtCommittedMismatch!.dbVersion, newerDbVersion);
      assert.equal(caughtCommittedMismatch!.dbAppVersion, '4.3.0');
      assert.equal(sha256File(dbPath), upgradedAfterCommitHashes.dbSha);
      assert.equal(sha256File(`${dbPath}-wal`), upgradedAfterCommitHashes.walSha);
      assert.equal(sha256File(`${dbPath}-shm`), upgradedAfterCommitHashes.shmSha);
      const preservedJournal = getDatabaseReplacementJournal();
      assert.equal(preservedJournal?.phase, 'committed');
      finalizeDatabaseReplacementJournal(preservedJournal!);
    }

    clearDirectory(backupDir);
    const validV84BackupPath = path.join(
      backupDir,
      'flo-backup-2026-10-28T09-00-00-000Z-pre-v84.db',
    );
    writeStampedSchemaSnapshot(validV84BackupPath, 84, {
      appVersion: '3.9.0',
      backupCreatedAt: '2026-10-28T09:00:00.000Z',
      seed: (snapDb) => {
        snapDb.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('cat-v84', 'Roasts');
        snapDb
          .prepare(
            'INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity) VALUES (?, ?, ?, ?, 1, 18.5)',
          )
          .run('prod-v84-beans', 'cat-v84', 'House Beans', 16);
        snapDb
          .prepare(
            "INSERT OR REPLACE INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('user-v84-owner', 'V84 Owner', 'v84@test.local', 'unused', 'owner', 1, '2026-10-28 08:00:00', '2026-10-28 08:00:00')",
          )
          .run();
      },
    });
    const noStaffV84BackupPath = path.join(
      backupDir,
      'flo-backup-2026-10-28T08-30-00-000Z-pre-v84-no-staff.db',
    );
    writeStampedSchemaSnapshot(noStaffV84BackupPath, 84, {
      appVersion: '3.9.0',
      seed: (snapDb) => {
        snapDb.prepare('DELETE FROM users').run();
        snapDb.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('cat-v84', 'Roasts');
        snapDb
          .prepare(
            'INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity) VALUES (?, ?, ?, ?, 1, 12)',
          )
          .run('prod-v84-beans', 'cat-v84', 'House Beans', 16);
      },
    });
    const negativeV84BackupPath = path.join(
      backupDir,
      'flo-backup-2026-10-28T08-15-00-000Z-pre-v84-neg.db',
    );
    writeStampedSchemaSnapshot(negativeV84BackupPath, 84, {
      appVersion: '3.9.0',
      seed: (snapDb) => {
        snapDb.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('cat-v84', 'Roasts');
        snapDb
          .prepare(
            'INSERT INTO products (id, category_id, name, price, track_inventory, stock_quantity) VALUES (?, ?, ?, ?, 1, -2)',
          )
          .run('prod-v84-neg', 'cat-v84', 'Negative Stock', 16);
      },
    });

    const v84Discovery = await discoverDowngradeBackupsAsync();
    assert.deepEqual(
      v84Discovery.compatible.map((item) => ({
        fileName: item.fileName,
        schemaVersion: item.schemaVersion,
        appVersion: item.appVersion,
      })),
      [{ fileName: path.basename(validV84BackupPath), schemaVersion: 84, appVersion: '3.9.0' }],
      'valid pre-v85 backup with stocked products is discovered as compatible',
    );
    assert.deepEqual(
      v84Discovery.corruptOrInvalid.map((item) => item.fileName).sort(),
      [path.basename(noStaffV84BackupPath), path.basename(negativeV84BackupPath)].sort(),
      'pre-v85 backups violating migration v85 preconditions are rejected at preflight',
    );
    await assert.rejects(
      () => restoreCompatibleBackupForDowngrade(noStaffV84BackupPath, { newerDbVersion }),
      /staff user/i,
      'pre-v85 stocked backup without staff users fails preflight before touching active DB',
    );
    assert.equal(sha256File(dbPath), upgradedAfterCommitHashes.dbSha);
    assert.equal(sha256File(`${dbPath}-wal`), upgradedAfterCommitHashes.walSha);
    assert.equal(sha256File(`${dbPath}-shm`), upgradedAfterCommitHashes.shmSha);

    const v84RestoreResult = await restoreCompatibleBackupForDowngrade(validV84BackupPath, {
      newerDbVersion,
    });
    assert.equal(v84RestoreResult.backupSchemaVersion, 84);
    assert.equal(v84RestoreResult.restoredSchemaVersion, maxSupported);
    initDatabase();
    finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
    assert.deepEqual(
      getDatabase()
        .prepare(
          "SELECT product_id, quantity_delta, movement_type, reference_type, actor_user_id, stock_after FROM inventory_movements WHERE product_id = 'prod-v84-beans'",
        )
        .get(),
      {
        product_id: 'prod-v84-beans',
        quantity_delta: 18.5,
        movement_type: 'adjustment',
        reference_type: 'opening_balance',
        actor_user_id: 'user-v84-owner',
        stock_after: 18.5,
      },
      'restoring a pre-v85 stocked backup backfills opening_balance inventory movement cleanly',
    );
    assert.equal(runHealthCheck().findings.length, 0);

    getDatabase()
      .prepare(`
        INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
        VALUES ('ORD-20261029-0091', 'takeaway', 'completed', 11, 11, '2026-10-29 13:00:00', '2026-10-29 13:05:00')
      `)
      .run();
    getDatabase().pragma('wal_checkpoint(TRUNCATE)');
    closeDatabase();
    const committedCleanSnapshot = path.join(testDir, 'committed-clean-snapshot.db');
    fs.copyFileSync(dbPath, committedCleanSnapshot);
    const committedCleanHeader = fs.readFileSync(committedCleanSnapshot).subarray(0, 100);
    assert.equal(committedCleanHeader[18], 2);
    assert.equal(committedCleanHeader[19], 2);
    const committedCleanSha = sha256File(committedCleanSnapshot);

    const walEnospcStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-enospc-wal-live-'));
    let walLiveDbSha = '';
    let walLiveWalSha = '';
    try {
      const committedDeleteModeSnapshot = path.join(
        walEnospcStageDir,
        'committed-delete-mode-snapshot.db',
      );
      fs.copyFileSync(committedCleanSnapshot, committedDeleteModeSnapshot);
      const deleteModeSnapDb = new Database(committedDeleteModeSnapshot);
      deleteModeSnapDb.pragma('journal_mode = DELETE');
      deleteModeSnapDb.close();
      const deleteSnapHeader = fs.readFileSync(committedDeleteModeSnapshot).subarray(0, 100);
      assert.equal(deleteSnapHeader[18], 1);
      assert.equal(deleteSnapHeader[19], 1);
      assert.equal(fs.existsSync(`${committedDeleteModeSnapshot}-wal`), false);
      assert.equal(fs.existsSync(`${committedDeleteModeSnapshot}-shm`), false);
      assert.equal(fs.existsSync(`${committedDeleteModeSnapshot}-journal`), false);

      const walClosedNewerPath = path.join(walEnospcStageDir, 'newer-wal-closed.db');
      fs.copyFileSync(committedCleanSnapshot, walClosedNewerPath);
      const walClosedNewerDb = new Database(walClosedNewerPath);
      walClosedNewerDb.pragma('journal_mode = WAL');
      walClosedNewerDb
        .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
        .run('app_version', '4.5.0');
      walClosedNewerDb
        .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(newerDbVersion));
      walClosedNewerDb.pragma(`user_version = ${newerDbVersion}`);
      walClosedNewerDb.pragma('wal_checkpoint(TRUNCATE)');
      walClosedNewerDb.close();
      const walClosedNewerHeader = fs.readFileSync(walClosedNewerPath).subarray(0, 100);
      assert.equal(walClosedNewerHeader[18], 2);
      assert.equal(walClosedNewerHeader[19], 2);
      assert.equal(walClosedNewerHeader.readInt32BE(60), newerDbVersion);
      assert.equal(fs.existsSync(`${walClosedNewerPath}-wal`), false);
      assert.equal(fs.existsSync(`${walClosedNewerPath}-shm`), false);
      const walClosedNewerSha = sha256File(walClosedNewerPath);

      clearDirectory(backupDir);
      removeDbSet(dbPath);
      fs.copyFileSync(walClosedNewerPath, dbPath);
      let walClosedMismatch: SchemaVersionMismatchError | null = null;
      assert.throws(
        () => initDatabase(),
        (err: unknown) => {
          if (err instanceof SchemaVersionMismatchError) {
            walClosedMismatch = err;
            return true;
          }
          return false;
        },
        'cleanly closed WAL-mode newer database throws SchemaVersionMismatchError',
      );
      assert.equal(walClosedMismatch!.dbVersion, newerDbVersion);
      assert.equal(walClosedMismatch!.appVersion, maxSupported);
      assert.equal(walClosedMismatch!.dbAppVersion, '4.5.0');
      assert.equal(sha256File(dbPath), walClosedNewerSha);
      assert.equal(
        fs.existsSync(`${dbPath}-wal`),
        false,
        'preflight does not create flo.db-wal on cleanly closed WAL newer DB',
      );
      assert.equal(
        fs.existsSync(`${dbPath}-shm`),
        false,
        'preflight does not create flo.db-shm on cleanly closed WAL newer DB',
      );

      const walClosedRestoreCandidate = path.join(
        backupDir,
        'flo-backup-2026-10-28T11-00-00-000Z-pre-v120-to-v121.db',
      );
      fs.copyFileSync(baseTemplateCopy, walClosedRestoreCandidate);
      const walClosedRestoreResult = await restoreCompatibleBackupForDowngrade(
        walClosedRestoreCandidate,
        { newerDbVersion },
      );
      assert.deepEqual(
        walClosedRestoreResult.preservedSidecarPaths,
        [],
        'downgrade restore of cleanly closed WAL newer DB does not archive fabricated sidecars',
      );
      assert.equal(sha256File(walClosedRestoreResult.preservedDbPath), walClosedNewerSha);
      assert.equal(fs.existsSync(`${walClosedRestoreResult.preservedDbPath}-wal`), false);
      assert.equal(fs.existsSync(`${walClosedRestoreResult.preservedDbPath}-shm`), false);
      initDatabase();
      finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
      closeDatabase();

      clearDirectory(backupDir);
      removeDbSet(dbPath);
      fs.copyFileSync(committedCleanSnapshot, dbPath);
      initDatabase();
      const openWalDb = getDatabase();
      openWalDb.pragma('wal_autocheckpoint = 0');
      openWalDb
        .prepare(`
          INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
          VALUES ('ORD-20261029-0092', 'takeaway', 'completed', 13, 13, '2026-10-29 13:10:00', '2026-10-29 13:15:00')
        `)
        .run();
      fs.copyFileSync(dbPath, path.join(walEnospcStageDir, 'flo.db'));
      fs.copyFileSync(`${dbPath}-wal`, path.join(walEnospcStageDir, 'flo.db-wal'));
      walLiveDbSha = sha256File(path.join(walEnospcStageDir, 'flo.db'));
      walLiveWalSha = sha256File(path.join(walEnospcStageDir, 'flo.db-wal'));
      closeDatabase();

      const walNewerEnospcHashes = buildActiveNewerWalDatabase(
        dbPath,
        baseTemplateCopy,
        newerDbVersion,
        '4.4.0',
      );
      const walNewerCopyDir = path.join(walEnospcStageDir, 'newer-wal');
      fs.mkdirSync(walNewerCopyDir);
      fs.copyFileSync(dbPath, path.join(walNewerCopyDir, 'flo.db'));
      fs.copyFileSync(`${dbPath}-wal`, path.join(walNewerCopyDir, 'flo.db-wal'));
      fs.copyFileSync(`${dbPath}-shm`, path.join(walNewerCopyDir, 'flo.db-shm'));

      // Also build a supported WAL database whose header is still older/unchanged while a
      // committed row lives only in -wal/-shm (crash-recovery startup with full /tmp volume).
      const walSupportedCrashDir = path.join(walEnospcStageDir, 'supported-wal-crash');
      fs.mkdirSync(walSupportedCrashDir);
      {
        const crashStageDbPath = path.join(walSupportedCrashDir, 'flo.db');
        fs.copyFileSync(committedCleanSnapshot, crashStageDbPath);
        const crashWriter = new Database(crashStageDbPath);
        crashWriter.pragma('journal_mode = WAL');
        crashWriter.pragma('wal_autocheckpoint = 0');
        crashWriter
          .prepare(`
            INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
            VALUES ('ORD-20261029-0093', 'takeaway', 'completed', 29, 29, '2026-10-29 14:00:00', '2026-10-29 14:05:00')
          `)
          .run();
        const crashCopyDir = path.join(walEnospcStageDir, 'supported-wal-crash-live');
        fs.mkdirSync(crashCopyDir);
        fs.copyFileSync(crashStageDbPath, path.join(crashCopyDir, 'flo.db'));
        fs.copyFileSync(`${crashStageDbPath}-wal`, path.join(crashCopyDir, 'flo.db-wal'));
        fs.copyFileSync(`${crashStageDbPath}-shm`, path.join(crashCopyDir, 'flo.db-shm'));
        crashWriter.close();
      }
      const walSupportedCrashLiveDir = path.join(walEnospcStageDir, 'supported-wal-crash-live');

      const mutableFsMkdtemp = nativeFs as unknown as {
        mkdtempSync: typeof fs.mkdtempSync;
        copyFileSync: typeof fs.copyFileSync;
        writeFileSync: typeof fs.writeFileSync;
      };
      const originalMkdtempSync = nativeFs.mkdtempSync;
      const originalStageCopyFileSync = nativeFs.copyFileSync;
      const originalStageWriteFileSync = nativeFs.writeFileSync;
      const isOsTmpStagingTarget = (rawPath: unknown): boolean => {
        const text = String(rawPath);
        return (
          text.includes('flo-schema-preflight-') ||
          text.includes('flo-db-health-probe-') ||
          text.includes('flo-recovery-verify-') ||
          text.includes('flo-backup-discover-') ||
          text.includes('flo-restore-source-')
        );
      };

      // Subcase A: Only os.tmpdir() staging fails (e.g. separate full /tmp tmpfs), while the
      // database volume (testDir / backupDir) still has space.
      const preExistingTmpRestoreSourceDirs = new Set(
        fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('flo-restore-source-')),
      );
      mutableFsMkdtemp.copyFileSync = ((src, dest, mode) => {
        if (isOsTmpStagingTarget(dest)) {
          throw Object.assign(new Error('ENOSPC: injected os.tmpdir() snapshot copy full'), {
            code: 'ENOSPC',
          });
        }
        return originalStageCopyFileSync.call(nativeFs, src, dest, mode);
      }) as typeof fs.copyFileSync;
      mutableFsMkdtemp.writeFileSync = ((file, data, options) => {
        if (isOsTmpStagingTarget(file)) {
          throw Object.assign(new Error('ENOSPC: injected os.tmpdir() snapshot write full'), {
            code: 'ENOSPC',
          });
        }
        return originalStageWriteFileSync.call(nativeFs, file, data, options as any);
      }) as typeof fs.writeFileSync;
      try {
        // Crash-stranded .flo-db-stage-* directories are ignored by discovery and cleaned on boot.
        clearDirectory(backupDir);
        const strandedUserDataStage = path.join(testDir, '.flo-db-stage-preflight-stranded');
        const strandedBackupStage = path.join(backupDir, '.flo-db-stage-health-stranded');
        fs.mkdirSync(strandedUserDataStage, { recursive: true });
        fs.mkdirSync(strandedBackupStage, { recursive: true });
        fs.writeFileSync(path.join(strandedBackupStage, 'probe.db'), 'stranded temp bytes');
        const strandedDiscovery = await discoverDowngradeBackupsAsync();
        assert.deepEqual(strandedDiscovery.compatible, []);
        assert.deepEqual(strandedDiscovery.corruptOrInvalid, []);

        // Supported WAL crash-recovery database boots cleanly via DB-volume fallback staging.
        removeDbSet(dbPath);
        fs.copyFileSync(path.join(walSupportedCrashLiveDir, 'flo.db'), dbPath);
        fs.copyFileSync(path.join(walSupportedCrashLiveDir, 'flo.db-wal'), `${dbPath}-wal`);
        fs.copyFileSync(path.join(walSupportedCrashLiveDir, 'flo.db-shm'), `${dbPath}-shm`);
        initDatabase();
        assert.deepEqual(
          getDatabase()
            .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0093'")
            .get(),
          { order_number: 'ORD-20261029-0093' },
          'supported WAL crash-recovery database initializes cleanly via DB-volume staging when os.tmpdir() is full',
        );
        assert.equal(
          fs.existsSync(strandedUserDataStage),
          false,
          'startup removes crash-stranded .flo-db-stage-* directory in userData',
        );
        assert.equal(
          fs.existsSync(strandedBackupStage),
          false,
          'startup removes crash-stranded .flo-db-stage-* directory in backups',
        );
        closeDatabase();

        // Supported-header + newer-WAL database still detects newer WAL version via DB-volume
        // fallback staging without mutating live files or leaking staging directories, AND
        // full async discovery + downgrade restore + subsequent startup all succeed via DB-volume staging.
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db'), dbPath);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db-wal'), `${dbPath}-wal`);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db-shm'), `${dbPath}-shm`);
        let tmpOnlyNewerWalMismatch: SchemaVersionMismatchError | null = null;
        assert.throws(
          () => initDatabase(),
          (err: unknown) => {
            if (err instanceof SchemaVersionMismatchError) {
              tmpOnlyNewerWalMismatch = err;
              return true;
            }
            return false;
          },
          'newer WAL database detects SchemaVersionMismatchError via DB-volume fallback when os.tmpdir() is full',
        );
        assert.equal(tmpOnlyNewerWalMismatch!.dbVersion, newerDbVersion);
        assert.equal(tmpOnlyNewerWalMismatch!.dbAppVersion, '4.4.0');
        assert.equal(sha256File(dbPath), walNewerEnospcHashes.dbSha);
        assert.equal(sha256File(`${dbPath}-wal`), walNewerEnospcHashes.walSha);
        assert.equal(sha256File(`${dbPath}-shm`), walNewerEnospcHashes.shmSha);
        assert.deepEqual(
          fs.readdirSync(testDir).filter((name) => name.startsWith('.flo-db-stage-')),
          [],
          'DB-volume fallback staging cleans up private temp directories in finally',
        );

        const tmpOnlyDeleteCandidate = path.join(
          backupDir,
          'flo-backup-2026-10-28T15-00-00-000Z-pre-v120-to-v121.db',
        );
        const tmpOnlyWalHeaderCandidate = path.join(
          backupDir,
          'flo-backup-2026-10-28T16-00-00-000Z-wal-header.db',
        );
        fs.copyFileSync(baseTemplateCopy, tmpOnlyDeleteCandidate);
        fs.copyFileSync(committedCleanSnapshot, tmpOnlyWalHeaderCandidate);
        const tmpOnlyAsyncDiscovery = await discoverDowngradeBackupsAsync();
        assert.equal(
          tmpOnlyAsyncDiscovery.compatible.length,
          2,
          'discoverDowngradeBackupsAsync stages WAL-header candidates on DB volume when os.tmpdir() is full',
        );
        assert.deepEqual(
          fs.readdirSync(backupDir).filter((name) => name.startsWith('.flo-db-stage-')),
          [],
          'discoverDowngradeBackupsAsync cleans up DB-volume stage directories',
        );

        const tmpOnlyDowngradeRestore = await restoreCompatibleBackupForDowngrade(
          tmpOnlyWalHeaderCandidate,
          { newerDbVersion },
        );
        assert.equal(
          sha256File(tmpOnlyDowngradeRestore.preservedDbPath),
          walNewerEnospcHashes.dbSha,
        );
        assert.equal(
          sha256File(`${tmpOnlyDowngradeRestore.preservedDbPath}-wal`),
          walNewerEnospcHashes.walSha,
        );
        assert.equal(
          sha256File(`${tmpOnlyDowngradeRestore.preservedDbPath}-shm`),
          walNewerEnospcHashes.shmSha,
        );
        assert.deepEqual(
          fs
            .readdirSync(os.tmpdir())
            .filter(
              (name) =>
                name.startsWith('flo-restore-source-') &&
                !preExistingTmpRestoreSourceDirs.has(name),
            ),
          [],
          'failed os.tmpdir() writeFileSync cleans up empty flo-restore-source-* directory before fallback',
        );
        assert.deepEqual(
          fs.readdirSync(testDir).filter((name) => name.startsWith('.flo-db-stage-')),
          [],
          'restoreCompatibleBackupForDowngrade cleans up DB-volume restore-source staging directory',
        );
        initDatabase();
        assert.deepEqual(
          getDatabase()
            .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0091'")
            .get(),
          { order_number: 'ORD-20261029-0091' },
          'downgrade restore + post-restore initDatabase succeed end-to-end when os.tmpdir() returns ENOSPC',
        );
        finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);

        // Also verify mkdtempSync ENOSPC in os.tmpdir() AND that in-process initDatabase(false, true)
        // during restoreBackup preserves active .flo-db-stage-* directories instead of sweeping them.
        const sameVersionBackupResult = await createBackup(
          path.join(walEnospcStageDir, 'same-version-direct-restore.db'),
        );
        const activeUserDataStage = path.join(testDir, '.flo-db-stage-active-probe');
        const activeBackupStage = path.join(backupDir, '.flo-db-stage-active-discover');
        fs.mkdirSync(activeUserDataStage, { recursive: true });
        fs.mkdirSync(activeBackupStage, { recursive: true });
        fs.writeFileSync(path.join(activeUserDataStage, 'probe.db'), 'in-flight probe');
        fs.writeFileSync(path.join(activeBackupStage, 'candidate.db'), 'in-flight discovery');
        mutableFsMkdtemp.mkdtempSync = ((prefix: string, options?: any) => {
          if (isOsTmpStagingTarget(prefix)) {
            throw Object.assign(new Error('ENOSPC: injected os.tmpdir() mkdtemp full'), {
              code: 'ENOSPC',
            });
          }
          return originalMkdtempSync.call(nativeFs, prefix, options);
        }) as typeof fs.mkdtempSync;
        try {
          const directRestoreUnderTmpEnospc = restoreBackup(sameVersionBackupResult.path, true);
          assert.equal(
            directRestoreUnderTmpEnospc.success,
            true,
            `restoreBackup succeeds via DB-volume fallback when os.tmpdir() mkdtemp fails (${directRestoreUnderTmpEnospc.error || ''})`,
          );
          assert.equal(directRestoreUnderTmpEnospc.mode, 'direct');
          assert.equal(
            fs.existsSync(activeUserDataStage),
            true,
            'in-process initDatabase(false, true) preserves active .flo-db-stage-* in userData',
          );
          assert.equal(
            fs.existsSync(activeBackupStage),
            true,
            'in-process initDatabase(false, true) preserves active .flo-db-stage-* in backups',
          );
          assert.deepEqual(
            fs
              .readdirSync(testDir)
              .filter((name) => name.startsWith('.flo-db-stage-restore-source-')),
            [],
            'restoreBackup cleans up its own .flo-db-stage-restore-source-* directory',
          );
        } finally {
          mutableFsMkdtemp.mkdtempSync = originalMkdtempSync;
        }
        finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
        closeDatabase();
        initDatabase();
        assert.equal(
          fs.existsSync(activeUserDataStage),
          false,
          'top-level startup initDatabase() sweeps crash-stranded .flo-db-stage-* in userData',
        );
        assert.equal(
          fs.existsSync(activeBackupStage),
          false,
          'top-level startup initDatabase() sweeps crash-stranded .flo-db-stage-* in backups',
        );
        closeDatabase();

        // Committed WAL replacement journal health probe also succeeds via DB-volume fallback.
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db'), dbPath);
        fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db-wal'), `${dbPath}-wal`);
        const tmpOnlyWalCommittedBase = path.join(backupDir, 'flo-restore-recovery-tmponlywal');
        fs.copyFileSync(baseTemplateCopy, `${tmpOnlyWalCommittedBase}.db`);
        fs.writeFileSync(
          `${tmpOnlyWalCommittedBase}.json`,
          JSON.stringify({
            phase: 'committed',
            recoveryPath: `${tmpOnlyWalCommittedBase}.db`,
            dbPath,
            driveInvalidationRequired: true,
            downgradeRecovery: true,
            recoverySidecars: [],
          }),
        );
        initDatabase();
        assert.deepEqual(
          getDatabase()
            .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0092'")
            .get(),
          { order_number: 'ORD-20261029-0092' },
          'committed WAL replacement journal verifies cleanly via DB-volume fallback when os.tmpdir() is full',
        );
        finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
        closeDatabase();
      } finally {
        mutableFsMkdtemp.copyFileSync = originalStageCopyFileSync;
        mutableFsMkdtemp.writeFileSync = originalStageWriteFileSync;
      }

      // Subcase B: Both os.tmpdir() AND database-volume staging fail with ENOSPC -> fail closed.
      mutableFsMkdtemp.mkdtempSync = ((prefix: string, options?: any) => {
        const text = String(prefix);
        if (isOsTmpStagingTarget(text) || text.includes('.flo-db-stage-')) {
          throw Object.assign(new Error('ENOSPC: no space left on device, mkdtemp'), {
            code: 'ENOSPC',
          });
        }
        return originalMkdtempSync.call(nativeFs, prefix, options);
      }) as typeof fs.mkdtempSync;

      let preparedWalHeaderRetryBase = '';
      try {
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(deleteModeNewerPath, dbPath);
        let enospcSidecarFreeMismatch: SchemaVersionMismatchError | null = null;
        assert.throws(
          () => initDatabase(),
          (err: unknown) => {
            if (err instanceof SchemaVersionMismatchError) {
              enospcSidecarFreeMismatch = err;
              return true;
            }
            return false;
          },
          'legacy rollback-header newer database throws SchemaVersionMismatchError without temp staging',
        );
        assert.equal(enospcSidecarFreeMismatch!.dbVersion, newerDbVersion);
        assert.equal(enospcSidecarFreeMismatch!.dbAppVersion, '4.1.0');
        assert.equal(sha256File(dbPath), deleteModeShaBefore);
        assert.equal(fs.existsSync(`${dbPath}-wal`), false);
        assert.equal(fs.existsSync(`${dbPath}-shm`), false);

        removeDbSet(dbPath);
        fs.copyFileSync(walClosedNewerPath, dbPath);
        let enospcWalClosedNewerMismatch: SchemaVersionMismatchError | null = null;
        assert.throws(
          () => initDatabase(),
          (err: unknown) => {
            if (err instanceof SchemaVersionMismatchError) {
              enospcWalClosedNewerMismatch = err;
              return true;
            }
            return false;
          },
          'WAL-header newer database falls back to header schemaVersion under temp ENOSPC without creating sidecars',
        );
        assert.equal(enospcWalClosedNewerMismatch!.dbVersion, newerDbVersion);
        assert.equal(enospcWalClosedNewerMismatch!.dbAppVersion, null);
        assert.equal(sha256File(dbPath), walClosedNewerSha);
        assert.equal(fs.existsSync(`${dbPath}-wal`), false);
        assert.equal(fs.existsSync(`${dbPath}-shm`), false);

        removeDbSet(dbPath);
        fs.copyFileSync(deleteModeNewerPath, dbPath);
        fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(0));
        let enospcHeaderNewerWithWalMismatch: SchemaVersionMismatchError | null = null;
        assert.throws(
          () => initDatabase(),
          (err: unknown) => {
            if (err instanceof SchemaVersionMismatchError) {
              enospcHeaderNewerWithWalMismatch = err;
              return true;
            }
            return false;
          },
          'headerVersion > maxSupported database preserves mismatch error even if WAL staging fails',
        );
        assert.equal(enospcHeaderNewerWithWalMismatch!.dbVersion, newerDbVersion);
        assert.equal(enospcHeaderNewerWithWalMismatch!.dbAppVersion, null);

        removeDbSet(dbPath);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db'), dbPath);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db-wal'), `${dbPath}-wal`);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db-shm'), `${dbPath}-shm`);
        assert.throws(
          () => initDatabase(),
          /ENOSPC/,
          'WAL preflight staging failure propagates instead of opening newer WAL DB read-write',
        );
        const bothFullRestoreCandidate = path.join(
          backupDir,
          'flo-backup-2026-10-28T17-00-00-000Z-both-full.db',
        );
        fs.copyFileSync(baseTemplateCopy, bothFullRestoreCandidate);
        await assert.rejects(
          () => restoreCompatibleBackupForDowngrade(bothFullRestoreCandidate, { newerDbVersion }),
          /ENOSPC/,
          'restoreCompatibleBackupForDowngrade fails closed when neither os.tmpdir() nor DB volume can stage',
        );
        assert.equal(sha256File(dbPath), walNewerEnospcHashes.dbSha);
        assert.equal(sha256File(`${dbPath}-wal`), walNewerEnospcHashes.walSha);
        assert.equal(sha256File(`${dbPath}-shm`), walNewerEnospcHashes.shmSha);

        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(committedDeleteModeSnapshot, dbPath);
        const deleteModeCommittedJournalBase = path.join(
          backupDir,
          'flo-restore-recovery-enospcdel',
        );
        fs.copyFileSync(baseTemplateCopy, `${deleteModeCommittedJournalBase}.db`);
        fs.writeFileSync(
          `${deleteModeCommittedJournalBase}.json`,
          JSON.stringify({
            phase: 'committed',
            recoveryPath: `${deleteModeCommittedJournalBase}.db`,
            dbPath,
            driveInvalidationRequired: true,
            downgradeRecovery: true,
            recoverySidecars: [],
          }),
        );
        initDatabase();
        assert.deepEqual(
          getDatabase()
            .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0091'")
            .get(),
          { order_number: 'ORD-20261029-0091' },
          'DELETE-mode committed journal succeeds under temp ENOSPC without rolling back',
        );
        finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
        closeDatabase();

        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(committedCleanSnapshot, dbPath);
        const cleanWalCommittedJournalBase = path.join(
          backupDir,
          'flo-restore-recovery-enospcclean',
        );
        fs.copyFileSync(baseTemplateCopy, `${cleanWalCommittedJournalBase}.db`);
        fs.writeFileSync(
          `${cleanWalCommittedJournalBase}.json`,
          JSON.stringify({
            phase: 'committed',
            recoveryPath: `${cleanWalCommittedJournalBase}.db`,
            dbPath,
            driveInvalidationRequired: true,
            downgradeRecovery: true,
            recoverySidecars: [],
          }),
        );
        assert.equal(isHealthyDatabaseFile(dbPath, undefined, false), false);
        assert.equal(fs.existsSync(`${dbPath}-wal`), false);
        assert.equal(fs.existsSync(`${dbPath}-shm`), false);
        assert.throws(
          () => initDatabase(),
          /ENOSPC/,
          'cleanly closed WAL-header committed journal fails closed under temp ENOSPC without creating sidecars',
        );
        assert.equal(sha256File(dbPath), committedCleanSha);
        assert.equal(fs.existsSync(`${dbPath}-wal`), false);
        assert.equal(fs.existsSync(`${dbPath}-shm`), false);
        assert.equal(getDatabaseReplacementJournal()?.phase, 'committed');

        for (const [index, isDowngradeJournal] of [true, false].entries()) {
          clearDirectory(backupDir);
          removeDbSet(dbPath);
          fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db'), dbPath);
          fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db-wal'), `${dbPath}-wal`);
          const walCommittedBase = path.join(
            backupDir,
            `flo-restore-recovery-enospcwal0${index + 1}`,
          );
          fs.copyFileSync(baseTemplateCopy, `${walCommittedBase}.db`);
          fs.writeFileSync(
            `${walCommittedBase}.json`,
            JSON.stringify({
              phase: 'committed',
              recoveryPath: `${walCommittedBase}.db`,
              dbPath,
              driveInvalidationRequired: true,
              ...(isDowngradeJournal
                ? { downgradeRecovery: true, recoverySidecars: [] }
                : { baselineForeignKeyViolations: [] }),
            }),
          );
          assert.equal(
            isHealthyDatabaseFile(dbPath, undefined, false),
            false,
            'exported isHealthyDatabaseFile remains non-throwing when temp staging fails',
          );
          assert.throws(
            () => initDatabase(),
            /ENOSPC/,
            `committed WAL journal (downgrade=${isDowngradeJournal}) fails closed under temp ENOSPC instead of rolling back`,
          );
          assert.equal(sha256File(dbPath), walLiveDbSha);
          assert.equal(sha256File(`${dbPath}-wal`), walLiveWalSha);
          assert.equal(getDatabaseReplacementJournal()?.phase, 'committed');
        }

        clearDirectory(backupDir);
        const preparedDeleteModeBase = path.join(backupDir, 'flo-restore-recovery-enospcprepdel');
        fs.copyFileSync(committedDeleteModeSnapshot, `${preparedDeleteModeBase}.db`);
        fs.writeFileSync(
          `${preparedDeleteModeBase}.json`,
          JSON.stringify({
            phase: 'prepared',
            recoveryPath: `${preparedDeleteModeBase}.db`,
            dbPath,
            driveInvalidationRequired: true,
            downgradeRecovery: true,
            recoverySidecars: [],
          }),
        );
        initDatabase();
        assert.equal(getDatabaseReplacementJournal(), null);
        assert.deepEqual(
          getDatabase()
            .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0091'")
            .get(),
          { order_number: 'ORD-20261029-0091' },
          'prepared journal with DELETE-mode snapshot recovers under temp ENOSPC without probing WAL dbPath',
        );
        closeDatabase();

        for (const [index, isDowngradeJournal] of [false, true].entries()) {
          clearDirectory(backupDir);
          removeDbSet(dbPath);
          fs.writeFileSync(dbPath, 'interrupted partial replacement');
          const preparedWalBase = path.join(
            backupDir,
            `flo-restore-recovery-enospcprepwal0${index + 1}`,
          );
          preparedWalHeaderRetryBase = preparedWalBase;
          fs.copyFileSync(committedCleanSnapshot, `${preparedWalBase}.db`);
          fs.writeFileSync(
            `${preparedWalBase}.json`,
            JSON.stringify({
              phase: 'prepared',
              recoveryPath: `${preparedWalBase}.db`,
              dbPath,
              driveInvalidationRequired: true,
              ...(isDowngradeJournal
                ? { downgradeRecovery: true, recoverySidecars: [] }
                : { baselineForeignKeyViolations: [] }),
            }),
          );
          assert.throws(
            () => initDatabase(),
            /ENOSPC/,
            `prepared journal with WAL-header snapshot (downgrade=${isDowngradeJournal}) fails closed under temp ENOSPC`,
          );
          assert.equal(
            fs.existsSync(`${preparedWalBase}.db-wal`),
            false,
            'failed WAL-header snapshot verification does not orphan -wal sidecar',
          );
          assert.equal(
            fs.existsSync(`${preparedWalBase}.db-shm`),
            false,
            'failed WAL-header snapshot verification does not orphan -shm sidecar',
          );
        }
      } finally {
        mutableFsMkdtemp.mkdtempSync = originalMkdtempSync;
      }

      assert.ok(preparedWalHeaderRetryBase);
      initDatabase();
      assert.equal(getDatabaseReplacementJournal(), null);
      assert.deepEqual(
        getDatabase()
          .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0091'")
          .get(),
        { order_number: 'ORD-20261029-0091' },
        'prepared WAL-header snapshot recovers cleanly on retry once temp staging recovers',
      );
      closeDatabase();

      clearDirectory(backupDir);
      removeDbSet(dbPath);
      fs.copyFileSync(committedCleanSnapshot, dbPath);
      const recoveredCleanWalBase = path.join(backupDir, 'flo-restore-recovery-enospccleanok');
      fs.copyFileSync(baseTemplateCopy, `${recoveredCleanWalBase}.db`);
      fs.writeFileSync(
        `${recoveredCleanWalBase}.json`,
        JSON.stringify({
          phase: 'committed',
          recoveryPath: `${recoveredCleanWalBase}.db`,
          dbPath,
          driveInvalidationRequired: true,
          downgradeRecovery: true,
          recoverySidecars: [],
        }),
      );
      initDatabase();
      assert.deepEqual(
        getDatabase()
          .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0091'")
          .get(),
        { order_number: 'ORD-20261029-0091' },
        'cleanly closed WAL-header committed database boots intact without sidecar leaks once temp staging works',
      );
      finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
      closeDatabase();

      clearDirectory(backupDir);
      removeDbSet(dbPath);
      fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db'), dbPath);
      fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db-wal'), `${dbPath}-wal`);
      const recoveredWalBase = path.join(backupDir, 'flo-restore-recovery-enospcwalok');
      fs.copyFileSync(baseTemplateCopy, `${recoveredWalBase}.db`);
      fs.writeFileSync(
        `${recoveredWalBase}.json`,
        JSON.stringify({
          phase: 'committed',
          recoveryPath: `${recoveredWalBase}.db`,
          dbPath,
          driveInvalidationRequired: true,
          downgradeRecovery: true,
          recoverySidecars: [],
        }),
      );
      initDatabase();
      assert.deepEqual(
        getDatabase()
          .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0092'")
          .get(),
        { order_number: 'ORD-20261029-0092' },
        'committed WAL database boots intact once temp staging recovers',
      );
      finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
      closeDatabase();

      // Subcase C: File copy/write into os.tmpdir() succeeds, then SQLite WAL/SHM/pager initialization
      // in os.tmpdir() throws SQLITE_IOERR_SHMSIZE while the database volume succeeds.
      const dbProto = Database.prototype as unknown as {
        prepare: typeof Database.prototype.prepare;
        pragma: typeof Database.prototype.pragma;
      };
      const originalDbPrepare = dbProto.prepare;
      const originalDbPragma = dbProto.pragma;
      const preExistingTmpStageDirs = new Set(
        fs.readdirSync(os.tmpdir()).filter((name) => isOsTmpStagingTarget(name)),
      );
      let injectedTmpShmFailures = 0;
      dbProto.prepare = function (this: Database.Database, source: string) {
        if (isOsTmpStagingTarget(this.name)) {
          injectedTmpShmFailures += 1;
          throw new Database.SqliteError('disk I/O error', 'SQLITE_IOERR_SHMSIZE');
        }
        return originalDbPrepare.call(this, source);
      } as typeof Database.prototype.prepare;
      dbProto.pragma = function (
        this: Database.Database,
        source: string,
        options?: Database.PragmaOptions,
      ) {
        if (isOsTmpStagingTarget(this.name) && !/^\s*temp_store\b/i.test(String(source))) {
          injectedTmpShmFailures += 1;
          throw new Database.SqliteError('disk I/O error', 'SQLITE_IOERR_SHMSIZE');
        }
        return originalDbPragma.call(this, source, options);
      } as typeof Database.prototype.pragma;

      try {
        // (1) Committed WAL journal (both downgrade and standard) + isHealthyDatabaseFile fall back
        // to DB-volume staging on os.tmpdir() SQLITE_IOERR_SHMSIZE instead of rolling back committed data.
        for (const [idx, isDowngradeJournal] of [true, false].entries()) {
          clearDirectory(backupDir);
          removeDbSet(dbPath);
          fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db'), dbPath);
          fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db-wal'), `${dbPath}-wal`);
          const shmCommittedBase = path.join(
            backupDir,
            `flo-restore-recovery-shmcommit0${idx + 1}`,
          );
          fs.copyFileSync(baseTemplateCopy, `${shmCommittedBase}.db`);
          fs.writeFileSync(
            `${shmCommittedBase}.json`,
            JSON.stringify({
              phase: 'committed',
              recoveryPath: `${shmCommittedBase}.db`,
              dbPath,
              driveInvalidationRequired: true,
              ...(isDowngradeJournal
                ? { downgradeRecovery: true, recoverySidecars: [] }
                : { baselineForeignKeyViolations: [] }),
            }),
          );
          assert.equal(
            isHealthyDatabaseFile(dbPath, undefined, false),
            true,
            'isHealthyDatabaseFile retries on DB volume when os.tmpdir() throws SQLITE_IOERR_SHMSIZE',
          );
          initDatabase();
          assert.deepEqual(
            getDatabase()
              .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0092'")
              .get(),
            { order_number: 'ORD-20261029-0092' },
            `committed WAL journal (downgrade=${isDowngradeJournal}) preserves committed DB when os.tmpdir() throws SQLITE_IOERR_SHMSIZE`,
          );
          finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
          closeDatabase();
        }

        // (3) Prepared journal with WAL-header recovery snapshot retries on DB volume instead of failing validation.
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.writeFileSync(dbPath, 'partial replacement interrupted before commit');
        const shmPreparedBase = path.join(backupDir, 'flo-restore-recovery-shmprepwal');
        fs.copyFileSync(committedCleanSnapshot, `${shmPreparedBase}.db`);
        fs.writeFileSync(
          `${shmPreparedBase}.json`,
          JSON.stringify({
            phase: 'prepared',
            recoveryPath: `${shmPreparedBase}.db`,
            dbPath,
            driveInvalidationRequired: true,
            downgradeRecovery: true,
            recoverySidecars: [],
          }),
        );
        initDatabase();
        assert.equal(getDatabaseReplacementJournal(), null);
        assert.deepEqual(
          getDatabase()
            .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0091'")
            .get(),
          { order_number: 'ORD-20261029-0091' },
          'prepared WAL-header recovery snapshot verifies via DB-volume fallback on os.tmpdir() SQLITE_IOERR_SHMSIZE',
        );
        closeDatabase();

        // (2) Supported-header + newer-WAL preflight retries on DB volume instead of returning null.
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db'), dbPath);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db-wal'), `${dbPath}-wal`);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db-shm'), `${dbPath}-shm`);
        let shmPreflightMismatch: SchemaVersionMismatchError | null = null;
        assert.throws(
          () => initDatabase(),
          (err: unknown) => {
            if (err instanceof SchemaVersionMismatchError) {
              shmPreflightMismatch = err;
              return true;
            }
            return false;
          },
          'supported-header + newer-WAL preflight detects newer schema via DB volume when os.tmpdir() throws SQLITE_IOERR_SHMSIZE',
        );
        assert.equal(shmPreflightMismatch!.dbVersion, newerDbVersion);
        assert.equal(shmPreflightMismatch!.dbAppVersion, '4.4.0');
        assert.equal(sha256File(dbPath), walNewerEnospcHashes.dbSha);
        assert.equal(sha256File(`${dbPath}-wal`), walNewerEnospcHashes.walSha);
        assert.equal(sha256File(`${dbPath}-shm`), walNewerEnospcHashes.shmSha);

        // (4) & (5) WAL-header backup candidate discovery + downgrade restore + direct restoreBackup
        // all succeed via DB-volume fallback when os.tmpdir() throws SQLITE_IOERR_SHMSIZE after copy.
        const shmWalCandidatePath = path.join(
          backupDir,
          'flo-backup-2026-10-28T18-00-00-000Z-wal-shm-fallback.db',
        );
        fs.copyFileSync(committedCleanSnapshot, shmWalCandidatePath);
        const shmDiscovery = await discoverDowngradeBackupsAsync();
        assert.equal(
          shmDiscovery.compatible.length,
          1,
          'discoverDowngradeBackupsAsync classifies WAL-header backup as compatible via DB-volume fallback on SQLITE_IOERR_SHMSIZE',
        );
        assert.equal(shmDiscovery.compatible[0]?.path, shmWalCandidatePath);
        assert.equal(shmDiscovery.corruptOrInvalid.length, 0);

        const shmDowngradeRestore = await restoreCompatibleBackupForDowngrade(shmWalCandidatePath, {
          newerDbVersion,
        });
        assert.equal(sha256File(shmDowngradeRestore.preservedDbPath), walNewerEnospcHashes.dbSha);
        initDatabase();
        assert.deepEqual(
          getDatabase()
            .prepare("SELECT order_number FROM orders WHERE order_number = 'ORD-20261029-0091'")
            .get(),
          { order_number: 'ORD-20261029-0091' },
          'downgrade restore of WAL-header backup succeeds via DB-volume fallback on os.tmpdir() SQLITE_IOERR_SHMSIZE',
        );
        finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);

        const stampedWalDirectBackupPath = path.join(
          walEnospcStageDir,
          'stamped-wal-header-direct-restore.db',
        );
        {
          const created = await createBackup(stampedWalDirectBackupPath);
          const walStampDb = new Database(created.path);
          walStampDb.pragma('journal_mode = WAL');
          walStampDb.pragma('wal_checkpoint(TRUNCATE)');
          walStampDb.close();
          assert.equal(fs.existsSync(`${created.path}-wal`), false);
          assert.equal(fs.existsSync(`${created.path}-shm`), false);
          assert.equal(fs.readFileSync(created.path)[18], 2);
        }
        const shmDirectRestore = restoreBackup(stampedWalDirectBackupPath, true);
        assert.equal(
          shmDirectRestore.success,
          true,
          `direct restoreBackup of WAL-header backup succeeds under os.tmpdir() SQLITE_IOERR_SHMSIZE (${shmDirectRestore.error || ''})`,
        );
        finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
        closeDatabase();

        assert.ok(injectedTmpShmFailures >= 6, 'SQLITE_IOERR_SHMSIZE fault injection fired');
        assert.deepEqual(
          fs
            .readdirSync(os.tmpdir())
            .filter((name) => isOsTmpStagingTarget(name) && !preExistingTmpStageDirs.has(name)),
          [],
          'failed os.tmpdir() SQLite probes clean up all temporary staging directories',
        );
        assert.deepEqual(
          fs.readdirSync(testDir).filter((name) => name.startsWith('.flo-db-stage-')),
          [],
          'DB-volume SQLite fallback probes clean up userData staging directories',
        );
        assert.deepEqual(
          fs.readdirSync(backupDir).filter((name) => name.startsWith('.flo-db-stage-')),
          [],
          'DB-volume SQLite fallback probes clean up backups staging directories',
        );
      } finally {
        dbProto.prepare = originalDbPrepare;
        dbProto.pragma = originalDbPragma;
      }

      // Subcase D: Dual-volume SQLITE_IOERR_SHMSIZE and in-place SQLITE_IOERR_READ fail closed
      // instead of overwriting committed data or opening a newer WAL/_flo_meta database read-write.
      const isAnyStagingDbTarget = (rawPath: unknown): boolean => {
        const text = String(rawPath);
        return isOsTmpStagingTarget(text) || text.includes('.flo-db-stage-');
      };
      dbProto.prepare = function (this: Database.Database, source: string) {
        if (isAnyStagingDbTarget(this.name)) {
          throw new Database.SqliteError('disk I/O error', 'SQLITE_IOERR_SHMSIZE');
        }
        return originalDbPrepare.call(this, source);
      } as typeof Database.prototype.prepare;
      dbProto.pragma = function (
        this: Database.Database,
        source: string,
        options?: Database.PragmaOptions,
      ) {
        if (isAnyStagingDbTarget(this.name) && !/^\s*temp_store\b/i.test(String(source))) {
          throw new Database.SqliteError('disk I/O error', 'SQLITE_IOERR_SHMSIZE');
        }
        return originalDbPragma.call(this, source, options);
      } as typeof Database.prototype.pragma;

      try {
        // Committed WAL journal fails closed without overwriting committed flo.db.
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db'), dbPath);
        fs.copyFileSync(path.join(walEnospcStageDir, 'flo.db-wal'), `${dbPath}-wal`);
        const dualShmCommittedBase = path.join(backupDir, 'flo-restore-recovery-dualshmcommit');
        fs.copyFileSync(baseTemplateCopy, `${dualShmCommittedBase}.db`);
        fs.writeFileSync(
          `${dualShmCommittedBase}.json`,
          JSON.stringify({
            phase: 'committed',
            recoveryPath: `${dualShmCommittedBase}.db`,
            dbPath,
            driveInvalidationRequired: true,
            downgradeRecovery: true,
            recoverySidecars: [],
          }),
        );
        assert.equal(isHealthyDatabaseFile(dbPath, undefined, false), false);
        assert.throws(
          () => initDatabase(),
          /Could not stage .*disk I\/O error/,
          'committed WAL journal fails closed when both volumes throw SQLITE_IOERR_SHMSIZE',
        );
        assert.equal(sha256File(dbPath), walLiveDbSha);
        assert.equal(sha256File(`${dbPath}-wal`), walLiveWalSha);
        assert.equal(getDatabaseReplacementJournal()?.phase, 'committed');

        // Supported-header + newer-WAL preflight fails closed instead of returning null.
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db'), dbPath);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db-wal'), `${dbPath}-wal`);
        fs.copyFileSync(path.join(walNewerCopyDir, 'flo.db-shm'), `${dbPath}-shm`);
        assert.throws(
          () => initDatabase(),
          /Could not stage active database for schema preflight.*disk I\/O error/,
          'newer-WAL preflight fails closed when both volumes throw SQLITE_IOERR_SHMSIZE',
        );
        assert.equal(sha256File(dbPath), walNewerEnospcHashes.dbSha);
        assert.equal(sha256File(`${dbPath}-wal`), walNewerEnospcHashes.walSha);
        assert.equal(sha256File(`${dbPath}-shm`), walNewerEnospcHashes.shmSha);

        const dualShmWalBackup = path.join(
          backupDir,
          'flo-backup-2026-10-28T19-00-00-000Z-dual-shm.db',
        );
        fs.copyFileSync(committedCleanSnapshot, dualShmWalBackup);
        await assert.rejects(
          () => restoreCompatibleBackupForDowngrade(dualShmWalBackup, { newerDbVersion }),
          /Could not stage restore source.*disk I\/O error/,
          'restoreCompatibleBackupForDowngrade fails closed when both volumes throw SQLITE_IOERR_SHMSIZE',
        );
        assert.equal(sha256File(dbPath), walNewerEnospcHashes.dbSha);

        // Prepared WAL-header journal fails closed and preserves journal on disk.
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.writeFileSync(dbPath, 'interrupted partial replacement');
        const dualShmPreparedBase = path.join(backupDir, 'flo-restore-recovery-dualshmprep');
        fs.copyFileSync(committedCleanSnapshot, `${dualShmPreparedBase}.db`);
        fs.writeFileSync(
          `${dualShmPreparedBase}.json`,
          JSON.stringify({
            phase: 'prepared',
            recoveryPath: `${dualShmPreparedBase}.db`,
            dbPath,
            driveInvalidationRequired: true,
            downgradeRecovery: true,
            recoverySidecars: [],
          }),
        );
        assert.throws(
          () => initDatabase(),
          /Could not stage recovery snapshot for verification.*disk I\/O error/,
          'prepared WAL-header journal fails closed when both volumes throw SQLITE_IOERR_SHMSIZE',
        );
        assert.equal(getDatabaseReplacementJournal()?.phase, 'prepared');
      } finally {
        dbProto.prepare = originalDbPrepare;
        dbProto.pragma = originalDbPragma;
      }

      // In-place legacy rollback-format SQLITE_IOERR_READ fails closed on committed journal and
      // _flo_meta preflight instead of rolling back committed data or opening newer _flo_meta DB.
      const deleteModeNewerMetaOnlyPath = path.join(
        walEnospcStageDir,
        'delete-mode-supported-header-newer-meta.db',
      );
      fs.copyFileSync(committedDeleteModeSnapshot, deleteModeNewerMetaOnlyPath);
      {
        const metaEditDb = new Database(deleteModeNewerMetaOnlyPath);
        metaEditDb.pragma('journal_mode = DELETE');
        metaEditDb.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
        metaEditDb
          .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
          .run('schema_version', String(newerDbVersion));
        metaEditDb.pragma(`user_version = ${maxSupported}`);
        metaEditDb.close();
      }
      const deleteModeNewerMetaSha = sha256File(deleteModeNewerMetaOnlyPath);
      const committedDeleteSha = sha256File(committedDeleteModeSnapshot);

      dbProto.prepare = function (this: Database.Database, source: string) {
        if (this.readonly && path.resolve(this.name) === path.resolve(dbPath)) {
          throw new Database.SqliteError('disk I/O error', 'SQLITE_IOERR_READ');
        }
        return originalDbPrepare.call(this, source);
      } as typeof Database.prototype.prepare;
      try {
        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(committedDeleteModeSnapshot, dbPath);
        const inPlaceCommittedBase = path.join(backupDir, 'flo-restore-recovery-inplaceio');
        fs.copyFileSync(baseTemplateCopy, `${inPlaceCommittedBase}.db`);
        fs.writeFileSync(
          `${inPlaceCommittedBase}.json`,
          JSON.stringify({
            phase: 'committed',
            recoveryPath: `${inPlaceCommittedBase}.db`,
            dbPath,
            driveInvalidationRequired: true,
            downgradeRecovery: true,
            recoverySidecars: [],
          }),
        );
        assert.throws(
          () => initDatabase(),
          /disk I\/O error/,
          'in-place legacy committed journal fails closed on SQLITE_IOERR_READ instead of rolling back',
        );
        assert.equal(sha256File(dbPath), committedDeleteSha);
        assert.equal(getDatabaseReplacementJournal()?.phase, 'committed');

        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(deleteModeNewerMetaOnlyPath, dbPath);
        assert.throws(
          () => initDatabase(),
          /disk I\/O error/,
          'in-place _flo_meta preflight fails closed on SQLITE_IOERR_READ instead of opening newer DB read-write',
        );
        assert.equal(sha256File(dbPath), deleteModeNewerMetaSha);
      } finally {
        dbProto.prepare = originalDbPrepare;
      }

      clearDirectory(backupDir);
      removeDbSet(dbPath);
    } finally {
      fs.rmSync(walEnospcStageDir, { recursive: true, force: true });
    }

    // 5h. Genuine active hot rollback journal (flo.db-journal) is refused before any archive,
    //     replacement journal, or live-file mutation, and interrupted recovery clears stale -journal.
    const hotJournalSeedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-hot-journal-seed-'));
    try {
      const committedHotSeedBackup = path.join(hotJournalSeedDir, 'flo-backup-committed-seed.db');
      fs.copyFileSync(baseTemplateCopy, committedHotSeedBackup);
      {
        const seedDb = new Database(committedHotSeedBackup);
        seedDb.pragma('journal_mode = DELETE');
        const insertFill = seedDb.prepare(
          'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        );
        seedDb.transaction(() => {
          for (let i = 0; i < 600; i += 1) {
            insertFill.run(`hotjournalfill${i}`, `COMMITTED-${'c'.repeat(2000)}`);
          }
        })();
        seedDb.close();
      }

      clearDirectory(backupDir);
      const hotCompatibleBackupPath = path.join(backupDir, 'flo-backup-hot-compatible.db');
      fs.copyFileSync(committedHotSeedBackup, hotCompatibleBackupPath);

      const hotJournalHashes = buildActiveHotJournalDatabase(dbPath, committedHotSeedBackup, {
        pragmaVersion: newerDbVersion,
        metaSchemaVersion: String(newerDbVersion),
        appVersion: '4.7.0',
      });
      const savedHotRawDb = path.join(hotJournalSeedDir, 'saved-hot.db');
      const savedHotJournal = `${savedHotRawDb}-journal`;
      fs.copyFileSync(dbPath, savedHotRawDb);
      fs.copyFileSync(`${dbPath}-journal`, savedHotJournal);

      // Verify fixture genuineness: raw main file holds spilled UNCOMMITTED- bytes while replaying
      // with its hot journal in an isolated copy recovers NEWER-COMMITTED-.
      assert.equal(
        fs.readFileSync(dbPath).includes(Buffer.from('UNCOMMITTED-', 'utf8')),
        true,
        'spilled uncommitted pages are present in raw flo.db before rollback replay',
      );

      let hotPreflightMismatch: SchemaVersionMismatchError | null = null;
      assert.throws(
        () => initDatabase(),
        (err: unknown) => {
          if (err instanceof SchemaVersionMismatchError) {
            hotPreflightMismatch = err;
            return true;
          }
          return false;
        },
        'hot-journaled newer database triggers SchemaVersionMismatchError preflight',
      );
      assert.equal(hotPreflightMismatch!.dbVersion, newerDbVersion);
      assert.equal(hotPreflightMismatch!.dbAppVersion, '4.7.0');
      assert.equal(sha256File(dbPath), hotJournalHashes.dbSha, 'preflight preserves flo.db bytes');
      assert.equal(
        sha256File(`${dbPath}-journal`),
        hotJournalHashes.journalSha,
        'preflight preserves flo.db-journal bytes',
      );

      await assert.rejects(
        () =>
          restoreCompatibleBackupForDowngrade(hotCompatibleBackupPath, {
            newerDbVersion,
          }),
        /rollback journal[\s\S]*update Flo Cafe/i,
        'downgrade restore refuses active hot rollback journal with actionable update guidance',
      );
      assert.equal(
        sha256File(dbPath),
        hotJournalHashes.dbSha,
        'refused hot-journal restore leaves flo.db SHA-256 untouched',
      );
      assert.equal(
        sha256File(`${dbPath}-journal`),
        hotJournalHashes.journalSha,
        'refused hot-journal restore leaves flo.db-journal SHA-256 untouched',
      );
      assert.deepEqual(
        fs
          .readdirSync(backupDir)
          .filter(
            (name) =>
              name.startsWith('flo-preserved-newer-') || name.startsWith('flo-restore-recovery-'),
          ),
        [],
        'refused hot-journal restore writes no archive or replacement journal artifacts',
      );

      // Verify isolated replay of untouched flo.db + flo.db-journal still yields NEWER-COMMITTED-.
      const verifyHotDir = path.join(hotJournalSeedDir, 'verify-replay');
      fs.mkdirSync(verifyHotDir);
      const verifyHotDbPath = path.join(verifyHotDir, 'flo.db');
      fs.copyFileSync(dbPath, verifyHotDbPath);
      fs.copyFileSync(`${dbPath}-journal`, `${verifyHotDbPath}-journal`);
      {
        const replayedDb = new Database(verifyHotDbPath);
        const replayedRow = replayedDb
          .prepare(
            "SELECT substr(value, 1, 16) AS prefix FROM settings WHERE key = 'hotjournalfill0'",
          )
          .get() as { prefix: string } | undefined;
        assert.deepEqual(replayedRow, { prefix: 'NEWER-COMMITTED-' });
        replayedDb.close();
      }

      // Verify runDowngradeRecoveryFlow surfaces the actionable rollback-journal refusal dialog
      // and allows exiting safely without modifying flo.db or flo.db-journal.
      let hotJournalErrorDialogDetail = '';
      const hotJournalFlowOutcome = await runDowngradeRecoveryFlow(hotPreflightMismatch!, {
        appVersion: '3.13.14',
        dialog: {
          showMessageBox: async (options: any) => {
            if (options.title === 'Newer Database Detected') {
              return { response: 2, checkboxChecked: false }; // Restore Compatible Backup
            }
            if (options.title === 'Select Compatible Backup') {
              return { response: 0, checkboxChecked: false }; // Select hotCompatibleBackupPath
            }
            if (options.title === 'Confirm Backup Restore') {
              return { response: 0, checkboxChecked: false }; // Confirm restore
            }
            if (options.title === 'Backup Restore Failed') {
              hotJournalErrorDialogDetail = String(options.detail || '');
              return { response: 2, checkboxChecked: false }; // Exit safely
            }
            throw new Error(`Unexpected dialog title: ${options.title}`);
          },
        } as any,
        shell: { openExternal: async () => {}, openPath: async () => '' },
        log: { info() {}, warn() {}, error() {} },
        isShutdownRequested: () => false,
        discoverBackups: () => discoverDowngradeBackupsAsync(),
        planPreservedArchivePath: planNewerDatabaseArchivePath,
        restoreBackup: restoreCompatibleBackupForDowngrade,
        getBackupDir,
        getDbPath,
      });
      assert.deepEqual(hotJournalFlowOutcome, { outcome: 'exit' });
      assert.match(hotJournalErrorDialogDetail, /rollback journal/i);
      assert.equal(sha256File(dbPath), hotJournalHashes.dbSha);
      assert.equal(sha256File(`${dbPath}-journal`), hotJournalHashes.journalSha);

      // Interrupted replacement recovery clears any mismatched flo.db-journal before installing
      // the verified recovery snapshot so old journal pages never replay into the recovered DB.
      clearDirectory(backupDir);
      fs.copyFileSync(savedHotRawDb, dbPath);
      fs.copyFileSync(savedHotJournal, `${dbPath}-journal`);
      const staleJournalRecoveryBase = path.join(
        backupDir,
        'flo-restore-recovery-stalejournalcheck',
      );
      fs.copyFileSync(committedHotSeedBackup, `${staleJournalRecoveryBase}.db`);
      fs.writeFileSync(
        `${staleJournalRecoveryBase}.json`,
        JSON.stringify({
          phase: 'prepared',
          recoveryPath: `${staleJournalRecoveryBase}.db`,
          dbPath,
          driveInvalidationRequired: true,
          downgradeRecovery: true,
          recoverySidecars: [],
        }),
      );
      initDatabase();
      assert.equal(
        fs.existsSync(`${dbPath}-journal`),
        false,
        'interrupted replacement recovery removes stale flo.db-journal before restoring snapshot',
      );
      const recoveredMarker = getDatabase()
        .prepare(
          "SELECT substr(value, 1, 10) AS prefix FROM settings WHERE key = 'hotjournalfill0'",
        )
        .get() as { prefix: string } | undefined;
      assert.deepEqual(
        recoveredMarker,
        { prefix: 'COMMITTED-' },
        'mismatched hot journal is never replayed into the recovered snapshot',
      );
      closeDatabase();
    } finally {
      fs.rmSync(hotJournalSeedDir, { recursive: true, force: true });
    }

    // 5i. Metadata-only newer schema stamp (_flo_meta.schema_version > maxSupported while
    //     PRAGMA user_version <= maxSupported) is intercepted across clean DELETE-mode, WAL,
    //     and active rollback-journal databases without mutating live bytes or sidecars.
    const metaOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-meta-only-newer-'));
    try {
      clearDirectory(backupDir);

      // (a) Clean DELETE-mode with user_version = maxSupported, _flo_meta.schema_version = maxSupported + 3.
      const metaOnlyDeletePath = path.join(metaOnlyDir, 'meta-only-delete.db');
      writeStampedSchemaSnapshot(metaOnlyDeletePath, maxSupported, {
        appVersion: '4.8.0',
        overridePragmaVersion: maxSupported,
        overrideMetaSchemaVersion: String(newerDbVersion),
      });
      removeDbSet(dbPath);
      fs.copyFileSync(metaOnlyDeletePath, dbPath);
      const metaOnlyDeleteSha = sha256File(dbPath);
      let caughtMetaOnlyDelete: SchemaVersionMismatchError | null = null;
      assert.throws(
        () => initDatabase(),
        (err: unknown) => {
          if (err instanceof SchemaVersionMismatchError) {
            caughtMetaOnlyDelete = err;
            return true;
          }
          return false;
        },
        'clean DELETE-mode metadata-only newer schema throws SchemaVersionMismatchError',
      );
      assert.equal(caughtMetaOnlyDelete!.dbVersion, newerDbVersion);
      assert.equal(caughtMetaOnlyDelete!.appVersion, maxSupported);
      assert.equal(caughtMetaOnlyDelete!.dbAppVersion, '4.8.0');
      assert.equal(
        sha256File(dbPath),
        metaOnlyDeleteSha,
        'clean DELETE-mode metadata-only newer DB SHA-256 is untouched',
      );
      assert.equal(fs.existsSync(`${dbPath}-wal`), false);
      assert.equal(fs.existsSync(`${dbPath}-shm`), false);
      assert.equal(fs.existsSync(`${dbPath}-journal`), false);

      // (b) Active WAL database with user_version = maxSupported and newer _flo_meta.schema_version in WAL.
      const metaOnlyWalStagePath = path.join(metaOnlyDir, 'wal-stage.db');
      fs.copyFileSync(baseTemplateCopy, metaOnlyWalStagePath);
      let metaOnlyWalHashes: { dbSha: string; walSha: string; shmSha: string };
      {
        const walWriter = new Database(metaOnlyWalStagePath);
        walWriter.pragma('journal_mode = WAL');
        walWriter.pragma('wal_autocheckpoint = 0');
        walWriter.pragma(`user_version = ${maxSupported}`);
        walWriter
          .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
          .run('schema_version', String(newerDbVersion));
        walWriter
          .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
          .run('app_version', '4.8.1');
        removeDbSet(dbPath);
        fs.copyFileSync(metaOnlyWalStagePath, dbPath);
        fs.copyFileSync(`${metaOnlyWalStagePath}-wal`, `${dbPath}-wal`);
        fs.copyFileSync(`${metaOnlyWalStagePath}-shm`, `${dbPath}-shm`);
        walWriter.close();
        metaOnlyWalHashes = {
          dbSha: sha256File(dbPath),
          walSha: sha256File(`${dbPath}-wal`),
          shmSha: sha256File(`${dbPath}-shm`),
        };
      }
      let caughtMetaOnlyWal: SchemaVersionMismatchError | null = null;
      assert.throws(
        () => initDatabase(),
        (err: unknown) => {
          if (err instanceof SchemaVersionMismatchError) {
            caughtMetaOnlyWal = err;
            return true;
          }
          return false;
        },
        'WAL metadata-only newer schema throws SchemaVersionMismatchError',
      );
      assert.equal(caughtMetaOnlyWal!.dbVersion, newerDbVersion);
      assert.equal(caughtMetaOnlyWal!.appVersion, maxSupported);
      assert.equal(caughtMetaOnlyWal!.dbAppVersion, '4.8.1');
      assert.equal(sha256File(dbPath), metaOnlyWalHashes.dbSha);
      assert.equal(sha256File(`${dbPath}-wal`), metaOnlyWalHashes.walSha);
      assert.equal(sha256File(`${dbPath}-shm`), metaOnlyWalHashes.shmSha);

      // (c) Active rollback-journal database with user_version = maxSupported and committed
      //     _flo_meta.schema_version = newerDbVersion protected by hot flo.db-journal.
      const metaOnlyHotSeedPath = path.join(metaOnlyDir, 'hot-seed.db');
      fs.copyFileSync(baseTemplateCopy, metaOnlyHotSeedPath);
      {
        const seedDb = new Database(metaOnlyHotSeedPath);
        seedDb.pragma('journal_mode = DELETE');
        const ins = seedDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        seedDb.transaction(() => {
          for (let i = 0; i < 400; i += 1) {
            ins.run(`hotjournalfill${i}`, `COMMITTED-${'m'.repeat(2000)}`);
          }
        })();
        seedDb.close();
      }
      const metaOnlyHotHashes = buildActiveHotJournalDatabase(dbPath, metaOnlyHotSeedPath, {
        pragmaVersion: maxSupported,
        metaSchemaVersion: String(newerDbVersion),
        appVersion: '4.8.2',
      });
      let caughtMetaOnlyJournal: SchemaVersionMismatchError | null = null;
      assert.throws(
        () => initDatabase(),
        (err: unknown) => {
          if (err instanceof SchemaVersionMismatchError) {
            caughtMetaOnlyJournal = err;
            return true;
          }
          return false;
        },
        'rollback-journal metadata-only newer schema throws SchemaVersionMismatchError',
      );
      assert.equal(caughtMetaOnlyJournal!.dbVersion, newerDbVersion);
      assert.equal(caughtMetaOnlyJournal!.appVersion, maxSupported);
      assert.equal(caughtMetaOnlyJournal!.dbAppVersion, '4.8.2');
      assert.equal(sha256File(dbPath), metaOnlyHotHashes.dbSha);
      assert.equal(sha256File(`${dbPath}-journal`), metaOnlyHotHashes.journalSha);

      // (d) Older or absent _flo_meta stamps on supported user_version remain compatible.
      removeDbSet(dbPath);
      writeStampedSchemaSnapshot(dbPath, maxSupported, {
        appVersion: '3.10.0',
        overridePragmaVersion: maxSupported,
        overrideMetaSchemaVersion: String(olderCompatibleVersion),
      });
      initDatabase();
      assert.equal(getCurrentSchemaVersion(), maxSupported);
      getDatabase().exec('DROP TABLE IF EXISTS _flo_meta');
      closeDatabase();
      initDatabase();
      assert.equal(getCurrentSchemaVersion(), maxSupported);
      closeDatabase();
    } finally {
      fs.rmSync(metaOnlyDir, { recursive: true, force: true });
    }

    // 5j. Non-blocking async backup discovery prefilters non-SQLite and header-newer standalone
    //     candidates without PRAGMA integrity_check or temp materialization, yields to event-loop
    //     timers during multi-backup scans, and surfaces all compatible backups without truncation.
    const asyncScanSeedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-async-scan-seed-'));
    try {
      clearDirectory(backupDir);
      removeDbSet(dbPath);
      fs.copyFileSync(deleteModeNewerPath, dbPath);

      const multiMbSeedBackup = path.join(asyncScanSeedDir, 'seed-large.db');
      fs.copyFileSync(baseTemplateCopy, multiMbSeedBackup);
      {
        const seedDb = new Database(multiMbSeedBackup);
        seedDb.pragma('journal_mode = DELETE');
        const ins = seedDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
        seedDb.transaction(() => {
          for (let i = 0; i < 1200; i += 1) {
            ins.run(`scanfill${i}`, `SCAN-${'s'.repeat(2500)}`);
          }
        })();
        seedDb.close();
      }

      // Add non-SQLite junk and standalone newer-header backups that must be prefiltered cheaply.
      for (let i = 0; i < 4; i += 1) {
        fs.writeFileSync(
          path.join(backupDir, `flo-backup-junk-${i}.db`),
          Buffer.from(`not sqlite ${i}`),
        );
      }
      for (let i = 0; i < 4; i += 1) {
        const newerBackupCandidate = path.join(
          backupDir,
          `flo-backup-2026-10-29T00-0${i}-00-000Z-newer-${i}.db`,
        );
        fs.copyFileSync(deleteModeNewerPath, newerBackupCandidate);
      }

      let prefilterIntegrityChecks = 0;
      const origPrepare = Database.prototype.prepare;
      Database.prototype.prepare = function (sql: string, ...rest: unknown[]) {
        if (sql === 'PRAGMA integrity_check') prefilterIntegrityChecks += 1;
        return (origPrepare as any).call(this, sql, ...rest);
      };
      try {
        const prefilterOnlyResult = await discoverDowngradeBackupsAsync();
        assert.equal(prefilterOnlyResult.compatible.length, 0);
        assert.equal(prefilterOnlyResult.incompatibleNewer.length, 4);
        assert.equal(prefilterOnlyResult.corruptOrInvalid.length, 4);
        assert.equal(
          prefilterIntegrityChecks,
          0,
          'cheap SQLite header prefilter skips PRAGMA integrity_check on non-SQLite and header-newer files',
        );
      } finally {
        Database.prototype.prepare = origPrepare;
      }

      // Add 24 valid multi-MB compatible backups (> 5 pages in UI) and verify event-loop timers
      // fire promptly DURING discoverDowngradeBackupsAsync while all 24 compatible backups surface.
      const compatibleCount = 24;
      for (let i = 0; i < compatibleCount; i += 1) {
        const padded = String(i).padStart(2, '0');
        const candidatePath = path.join(backupDir, `flo-backup-2026-10-28T12-${padded}-00-000Z.db`);
        fs.copyFileSync(multiMbSeedBackup, candidatePath);
        const ts = new Date(Date.UTC(2026, 9, 28, 12, i, 0));
        fs.utimesSync(candidatePath, ts, ts);
      }

      let timerTicksDuringScan = 0;
      let scanFinished = false;
      const interval = setInterval(() => {
        if (!scanFinished) timerTicksDuringScan += 1;
      }, 5);
      let asyncDiscoveryResult;
      try {
        asyncDiscoveryResult = await discoverDowngradeBackupsAsync();
        scanFinished = true;
      } finally {
        clearInterval(interval);
      }

      assert.equal(
        asyncDiscoveryResult.compatible.length,
        compatibleCount,
        'all compatible backups are surfaced without silent truncation',
      );
      assert.equal(asyncDiscoveryResult.incompatibleNewer.length, 4);
      assert.equal(asyncDiscoveryResult.corruptOrInvalid.length, 4);
      assert.ok(
        timerTicksDuringScan >= 1,
        `expected event-loop timer callbacks to fire during multi-backup discovery (got ${timerTicksDuringScan})`,
      );

      // Verify runDowngradeRecoveryFlow awaits async discoverBackups and pages through to the oldest backup.
      let mainDialogVisits = 0;
      const asyncFlowOutcome = await runDowngradeRecoveryFlow(
        new SchemaVersionMismatchError(newerDbVersion, maxSupported, '4.1.0'),
        {
          appVersion: '3.13.14',
          dialog: {
            showMessageBox: async (options: any) => {
              if (options.title === 'Newer Database Detected') {
                mainDialogVisits += 1;
                return {
                  response: mainDialogVisits === 1 ? 2 : 3,
                  checkboxChecked: false,
                };
              }
              const moreIdx = (options.buttons as string[]).indexOf('More Backups...');
              if (moreIdx >= 0) return { response: moreIdx, checkboxChecked: false };
              // On final page (items 21..24), verify oldest item #24 is reachable, then Cancel -> Exit.
              assert.match(
                options.detail || '',
                /24\./,
                'oldest compatible backup #24 is reachable',
              );
              const cancelIdx = (options.buttons as string[]).indexOf('Cancel');
              assert.ok(cancelIdx >= 0, 'Select Compatible Backup dialog includes Cancel');
              return { response: cancelIdx, checkboxChecked: false };
            },
          } as any,
          shell: { openExternal: async () => {}, openPath: async () => '' },
          log: { info() {}, warn() {}, error() {} },
          isShutdownRequested: () => false,
          discoverBackups: () => discoverDowngradeBackupsAsync(),
          planPreservedArchivePath: planNewerDatabaseArchivePath,
          restoreBackup: restoreCompatibleBackupForDowngrade,
          getBackupDir,
          getDbPath,
        },
      );
      assert.deepEqual(asyncFlowOutcome, { outcome: 'exit' });

      // Verify discoverDowngradeBackupsAsync rejects with ERR_SHUTDOWN_ABORTED on pre-aborted or
      // mid-scan AbortSignal (never resolving with truncated partial results), and that
      // runDowngradeRecoveryFlow handles discovery aborts and discovery/archive-planning errors.
      clearDirectory(backupDir);
      const preAbortedController = new AbortController();
      preAbortedController.abort();
      await assert.rejects(
        () => discoverDowngradeBackupsAsync({ signal: preAbortedController.signal }),
        (err: any) => err?.code === 'ERR_SHUTDOWN_ABORTED',
        'pre-aborted signal rejects discoverDowngradeBackupsAsync even when backups/ is empty',
      );

      fs.writeFileSync(path.join(backupDir, 'flo-backup-a-corrupt.db'), 'not a sqlite file');
      fs.copyFileSync(baseTemplateCopy, path.join(backupDir, 'flo-backup-z-compatible.db'));
      const midScanAbortController = new AbortController();
      const origLstatForMidScan = nativeFs.lstatSync;
      const mutableFsForMidScan = nativeFs as unknown as { lstatSync: typeof fs.lstatSync };
      mutableFsForMidScan.lstatSync = ((targetPath: fs.PathLike, options?: any) => {
        const result = origLstatForMidScan.call(nativeFs, targetPath, options);
        if (String(targetPath).endsWith('flo-backup-a-corrupt.db')) {
          midScanAbortController.abort();
        }
        return result;
      }) as typeof fs.lstatSync;
      try {
        await assert.rejects(
          () => discoverDowngradeBackupsAsync({ signal: midScanAbortController.signal }),
          (err: any) => err?.code === 'ERR_SHUTDOWN_ABORTED',
          'mid-scan abort rejects with ERR_SHUTDOWN_ABORTED instead of returning truncated compatible=[]',
        );
      } finally {
        mutableFsForMidScan.lstatSync = origLstatForMidScan;
      }

      const flowAbortSeenDialogs: string[] = [];
      const flowMidScanController = new AbortController();
      mutableFsForMidScan.lstatSync = ((targetPath: fs.PathLike, options?: any) => {
        const result = origLstatForMidScan.call(nativeFs, targetPath, options);
        if (String(targetPath).endsWith('flo-backup-a-corrupt.db')) {
          flowMidScanController.abort();
        }
        return result;
      }) as typeof fs.lstatSync;
      try {
        const abortedDiscoveryOutcome = await runDowngradeRecoveryFlow(
          new SchemaVersionMismatchError(newerDbVersion, maxSupported, '4.1.0'),
          {
            appVersion: '3.13.14',
            dialog: {
              showMessageBox: async (options: any) => {
                flowAbortSeenDialogs.push(String(options.title));
                return { response: 2, checkboxChecked: false };
              },
            } as any,
            shell: { openExternal: async () => {}, openPath: async () => '' },
            log: { info() {}, warn() {}, error() {} },
            isShutdownRequested: () => flowMidScanController.signal.aborted,
            discoverBackups: () =>
              discoverDowngradeBackupsAsync({ signal: flowMidScanController.signal }),
            planPreservedArchivePath: planNewerDatabaseArchivePath,
            restoreBackup: restoreCompatibleBackupForDowngrade,
            getBackupDir,
            getDbPath,
          },
        );
        assert.deepEqual(abortedDiscoveryOutcome, { outcome: 'exit' });
        assert.deepEqual(
          flowAbortSeenDialogs,
          ['Newer Database Detected'],
          'aborted backup discovery exits cleanly without false No Compatible Backup or error dialogs',
        );
      } finally {
        mutableFsForMidScan.lstatSync = origLstatForMidScan;
      }

      const discoveryErrorDialogs: { title: string; detail: string }[] = [];
      let discoveryErrorMainVisits = 0;
      const discoveryErrorOutcome = await runDowngradeRecoveryFlow(
        new SchemaVersionMismatchError(newerDbVersion, maxSupported, '4.1.0'),
        {
          appVersion: '3.13.14',
          dialog: {
            showMessageBox: async (options: any) => {
              discoveryErrorDialogs.push({
                title: String(options.title),
                detail: String(options.detail || ''),
              });
              if (options.title === 'Newer Database Detected') {
                discoveryErrorMainVisits += 1;
                return {
                  response: discoveryErrorMainVisits === 1 ? 2 : 3,
                  checkboxChecked: false,
                };
              }
              if (options.title === 'Backup Inspection Failed') {
                return { response: 0, checkboxChecked: false };
              }
              throw new Error(`Unexpected dialog: ${options.title}`);
            },
          } as any,
          shell: { openExternal: async () => {}, openPath: async () => '' },
          log: { info() {}, warn() {}, error() {} },
          isShutdownRequested: () => false,
          discoverBackups: async () => {
            throw new Error('simulated EIO while reading backups directory');
          },
          planPreservedArchivePath: planNewerDatabaseArchivePath,
          restoreBackup: restoreCompatibleBackupForDowngrade,
          getBackupDir,
          getDbPath,
        },
      );
      assert.deepEqual(discoveryErrorOutcome, { outcome: 'exit' });
      assert.equal(discoveryErrorDialogs[1]?.title, 'Backup Inspection Failed');
      assert.match(discoveryErrorDialogs[1]?.detail || '', /simulated EIO/);

      const planErrorDialogs: { title: string; detail: string }[] = [];
      let planErrorMainVisits = 0;
      const planErrorOutcome = await runDowngradeRecoveryFlow(
        new SchemaVersionMismatchError(newerDbVersion, maxSupported, '4.1.0'),
        {
          appVersion: '3.13.14',
          dialog: {
            showMessageBox: async (options: any) => {
              planErrorDialogs.push({
                title: String(options.title),
                detail: String(options.detail || ''),
              });
              if (options.title === 'Newer Database Detected') {
                planErrorMainVisits += 1;
                return {
                  response: planErrorMainVisits === 1 ? 2 : 3,
                  checkboxChecked: false,
                };
              }
              if (options.title === 'Select Compatible Backup') {
                return { response: 0, checkboxChecked: false };
              }
              if (options.title === 'Backup Restore Failed') {
                return { response: 0, checkboxChecked: false };
              }
              throw new Error(`Unexpected dialog: ${options.title}`);
            },
          } as any,
          shell: { openExternal: async () => {}, openPath: async () => '' },
          log: { info() {}, warn() {}, error() {} },
          isShutdownRequested: () => false,
          discoverBackups: () => discoverDowngradeBackupsAsync(),
          planPreservedArchivePath: () => {
            throw new Error('simulated EACCES planning archive path');
          },
          restoreBackup: restoreCompatibleBackupForDowngrade,
          getBackupDir,
          getDbPath,
        },
      );
      assert.deepEqual(planErrorOutcome, { outcome: 'exit' });
      assert.equal(planErrorDialogs[2]?.title, 'Backup Restore Failed');
      assert.match(planErrorDialogs[2]?.detail || '', /simulated EACCES planning archive path/);
    } finally {
      fs.rmSync(asyncScanSeedDir, { recursive: true, force: true });
    }

    // 6. Electron main/index.ts startup interception (via tests/startup-failure-child.cjs):
    //    SchemaVersionMismatchError triggers Newer Database Detected (never dialog.showErrorBox),
    //    and supports Exit, Get Latest Version, and Restore Compatible Backup -> normal initialize().
    for (const mode of [
      'exit',
      'update',
      'restore',
      'shutdown',
      'discover-shutdown',
      'dialog-throw',
    ] as const) {
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        FLO_STARTUP_NEWER_DB_MODE: mode,
      };
      delete childEnv.FLO_STARTUP_RACE;
      delete childEnv.FLO_STARTUP_FAILURE_RACE;
      const child = spawn(
        process.execPath,
        [
          require.resolve('ts-node/dist/bin.js'),
          '--transpile-only',
          '-P',
          path.join(__dirname, 'tsconfig.json'),
          path.join(__dirname, 'startup-failure-child.cjs'),
        ],
        {
          cwd: path.resolve(__dirname, '..'),
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`startup-failure child (${mode}) timed out: ${output}`)),
            20_000,
          );
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (exitCode, exitSignal) => {
            clearTimeout(timer);
            resolve([exitCode, exitSignal]);
          });
        },
      );
      assert.equal(signal, null, `startup-failure child (${mode}) exited by signal: ${output}`);
      assert.equal(code, 0, `startup-failure child (${mode}) failed: ${output}`);
      const resultLine = output.trim().split('\n').at(-1) || '';
      assert.equal(
        JSON.parse(resultLine).passed,
        true,
        `startup-failure child (${mode}) reported passed=false: ${output}`,
      );
    }

    console.log('Newer-database downgrade recovery tests passed.');
  } finally {
    closeDatabase();
    if (previousJwtSecretEnv === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecretEnv;
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('Newer-database downgrade recovery test failed:', error);
  process.exit(1);
});
