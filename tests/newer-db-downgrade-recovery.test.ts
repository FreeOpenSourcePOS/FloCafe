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
  discoverDowngradeBackups,
  finalizeDatabaseReplacementJournal,
  getBackupDir,
  getCurrentSchemaVersion,
  getDatabase,
  getDatabaseReplacementJournal,
  getDbPath,
  getLatestSupportedSchemaVersion,
  initDatabase,
  isHealthyDatabaseFile,
  planNewerDatabaseArchivePath,
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
  for (const suffix of ['', '-wal', '-shm']) {
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

    const discovery = discoverDowngradeBackups();
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
    const rejectedByName = new Map(
      discovery.corruptOrInvalid.map((item) => [item.fileName, item]),
    );
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
      discoverBackups: () => ({
        backupDir,
        maxSupportedSchemaVersion: maxSupported,
        compatible: [],
        incompatibleNewer: discovery.incompatibleNewer,
        corruptOrInvalid: discovery.corruptOrInvalid,
      }),
      planPreservedArchivePath: (v) => planNewerDatabaseArchivePath(v),
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
      discoverBackups: discoverDowngradeBackups,
      planPreservedArchivePath: (v) => planNewerDatabaseArchivePath(v),
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
        discoverBackups: discoverDowngradeBackups,
        planPreservedArchivePath: (v) => planNewerDatabaseArchivePath(v),
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
        discoverBackups: discoverDowngradeBackups,
        planPreservedArchivePath: (v) => planNewerDatabaseArchivePath(v),
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
      discoverBackups: discoverDowngradeBackups,
      planPreservedArchivePath: (v) => planNewerDatabaseArchivePath(v),
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
    assert.equal(sha256File(dbPath), walHashes.dbSha, 'post-migration schema failure rolls back flo.db');
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
      discoverBackups: discoverDowngradeBackups,
      planPreservedArchivePath: (v) => planNewerDatabaseArchivePath(v),
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
    const activeMetaRows = activeDb
      .prepare('SELECT key, value FROM _flo_meta')
      .all() as { key: string; value: string | null }[];
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

    const v84Discovery = discoverDowngradeBackups();
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

    const walEnospcStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-enospc-wal-live-'));
    let walLiveDbSha = '';
    let walLiveWalSha = '';
    try {
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

      const mutableFsMkdtemp = nativeFs as unknown as { mkdtempSync: typeof fs.mkdtempSync };
      const originalMkdtempSync = nativeFs.mkdtempSync;
      mutableFsMkdtemp.mkdtempSync = ((prefix: string, options?: any) => {
        const text = String(prefix);
        if (
          text.includes('flo-schema-preflight-') ||
          text.includes('flo-db-health-probe-') ||
          text.includes('flo-recovery-verify-')
        ) {
          throw Object.assign(new Error('ENOSPC: no space left on device, mkdtemp'), {
            code: 'ENOSPC',
          });
        }
        return originalMkdtempSync.call(nativeFs, prefix, options);
      }) as typeof fs.mkdtempSync;

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
          'sidecar-free newer database throws SchemaVersionMismatchError without temp staging',
        );
        assert.equal(enospcSidecarFreeMismatch!.dbVersion, newerDbVersion);
        assert.equal(enospcSidecarFreeMismatch!.dbAppVersion, '4.1.0');
        assert.equal(sha256File(dbPath), deleteModeShaBefore);
        assert.equal(fs.existsSync(`${dbPath}-wal`), false);
        assert.equal(fs.existsSync(`${dbPath}-shm`), false);

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
        assert.equal(sha256File(dbPath), walNewerEnospcHashes.dbSha);
        assert.equal(sha256File(`${dbPath}-wal`), walNewerEnospcHashes.walSha);
        assert.equal(sha256File(`${dbPath}-shm`), walNewerEnospcHashes.shmSha);

        clearDirectory(backupDir);
        removeDbSet(dbPath);
        fs.copyFileSync(committedCleanSnapshot, dbPath);
        const cleanCommittedJournalBase = path.join(backupDir, 'flo-restore-recovery-enospcclean');
        fs.copyFileSync(baseTemplateCopy, `${cleanCommittedJournalBase}.db`);
        fs.writeFileSync(
          `${cleanCommittedJournalBase}.json`,
          JSON.stringify({
            phase: 'committed',
            recoveryPath: `${cleanCommittedJournalBase}.db`,
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
          'sidecar-free committed journal succeeds under temp ENOSPC without rolling back',
        );
        finalizeDatabaseReplacementJournal(getDatabaseReplacementJournal()!);
        closeDatabase();

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
        const preparedNoSidecarBase = path.join(backupDir, 'flo-restore-recovery-enospcprep');
        fs.copyFileSync(committedCleanSnapshot, `${preparedNoSidecarBase}.db`);
        fs.writeFileSync(
          `${preparedNoSidecarBase}.json`,
          JSON.stringify({
            phase: 'prepared',
            recoveryPath: `${preparedNoSidecarBase}.db`,
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
          'prepared journal with sidecar-free snapshot recovers under temp ENOSPC without probing WAL dbPath',
        );
        closeDatabase();
      } finally {
        mutableFsMkdtemp.mkdtempSync = originalMkdtempSync;
      }

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
    } finally {
      fs.rmSync(walEnospcStageDir, { recursive: true, force: true });
    }

    // 6. Electron main/index.ts startup interception (via tests/startup-failure-child.cjs):
    //    SchemaVersionMismatchError triggers Newer Database Detected (never dialog.showErrorBox),
    //    and supports Exit, Get Latest Version, and Restore Compatible Backup -> normal initialize().
    for (const mode of ['exit', 'update', 'restore', 'shutdown'] as const) {
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
