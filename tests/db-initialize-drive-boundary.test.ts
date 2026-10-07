/**
 * Database initialize must not dead-end on a stale Drive restore boundary.
 *
 * A restore/reset on a store with no Drive account bound persists
 * `{ phase: 'prepared', database_account_subject: null }`. If the process dies
 * before that intent is cleared while a bound token file survives, every later
 * recovery pass reads the pair as ambiguous and blocks the whole Drive service
 * - including `googleDrive.disconnect()`. The owner then cannot run
 * POST /api/db-tools/initialize to recover, which is the one operation that
 * would rebuild the database.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/db-initialize-drive-boundary.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-db-init-boundary-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, 'utf8'),
        decryptString: (value: Buffer) => value.toString('utf8'),
      },
      ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-db-initialize-boundary';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const databaseModule = require('../main/db');
const { initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { databaseToolsRoutes } = require('../main/routes/database-tools');
const { googleDrive } = require('../main/services/google-drive');
const { resetMasterPin } = require('../main/services/master-pin');
const { assertEqualOrThrow, assertOrThrow } = require('./helpers/test-setup');

const intentPath = path.join(testDir, 'google-drive-restore.pending');
const tokenPath = path.join(testDir, 'google-drive-token.enc');

function writeBoundToken(): void {
  fs.writeFileSync(tokenPath, JSON.stringify({
    version: 2,
    access_token: 'stale-access-token',
    refresh_token: 'stale-refresh-token',
    installation_id: 'stale-installation',
    account_subject: 'stale-subject',
  }), { mode: 0o600 });
}

function writeStaleIntent(): void {
  fs.writeFileSync(intentPath, JSON.stringify({ phase: 'prepared', database_account_subject: null }), { mode: 0o600 });
}

async function run(): Promise<void> {
  initDatabase();
  getDatabase().prepare(
    "INSERT OR IGNORE INTO users (id, name, password, role, is_active) VALUES ('owner-1', 'Owner', 'hash', 'owner', 1)"
  ).run();
  resetMasterPin('1234');

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  app.use('/api/db-tools', databaseToolsRoutes);

  const ownerToken = jwt.sign({ userId: 'owner-1', email: 'owner@flo.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const initialize = () => request(app).post('/api/db-tools/initialize')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ master_pin: '1234', confirmation_phrase: 'INITIALIZE' });

  // Mirror app startup: the Drive service reconciles the boundary before any request.
  writeStaleIntent();
  writeBoundToken();
  googleDrive.start();

  // Only the explicit owner-typed reset may discard the boundary.
  await assert.rejects(
    googleDrive.prepareForDatabaseRestore(),
    (error: any) => error?.code === 'conflict',
    'an unresolvable boundary still blocks Drive work that was not an explicit reset',
  );

  const recoverySourcePath = path.join(testDir, 'committed-recovery.db');
  fs.writeFileSync(recoverySourcePath, 'replacement snapshot');
  const replacement = databaseModule.beginDatabaseReplacementJournal(recoverySourcePath, 'reset');
  databaseModule.commitDatabaseReplacementJournal(replacement);
  const finalizeDatabaseReplacementJournal = databaseModule.finalizeDatabaseReplacementJournal;
  databaseModule.finalizeDatabaseReplacementJournal = () => { throw new Error('simulated journal finalization failure'); };
  try {
    await assert.rejects(
      googleDrive.prepareForDatabaseRestore({ discardUnresolvedBoundary: true }),
      (error: any) => error?.code === 'conflict',
      'initialize remains blocked when committed replacement cleanup fails',
    );
    assertEqualOrThrow(databaseModule.getDatabaseReplacementJournal()?.phase, 'committed', 'failed cleanup retains its committed replacement journal');
    assertOrThrow(fs.existsSync(intentPath), 'failed cleanup retains the restore boundary');
  } finally {
    databaseModule.finalizeDatabaseReplacementJournal = finalizeDatabaseReplacementJournal;
  }

  const blocked = await initialize();
  assertEqualOrThrow(blocked.status, 200, `initialize recovers a stale Drive restore boundary (got ${blocked.status}, ${JSON.stringify(blocked.body)})`);
  assertOrThrow(!!blocked.body.backupPath, 'initialize still returns the forced pre-wipe backup path');
  assertOrThrow(!fs.existsSync(intentPath), 'the stale restore boundary is cleared once the database is rebuilt');
  assertOrThrow(getCurrentSchemaVersion() > 0, 'the rebuilt database is at the current schema version');

  assertOrThrow(!fs.existsSync(tokenPath), 'stale Drive credentials are not carried across the reset');

  // A completed reset leaves no users behind, so setup must run again before the
  // owner can repeat the operation - which is exactly the flow under test here.
  getDatabase().prepare(
    "INSERT OR IGNORE INTO users (id, name, password, role, is_active) VALUES ('owner-1', 'Owner', 'hash', 'owner', 1)"
  ).run();

  const repeated = await initialize();
  assertEqualOrThrow(repeated.status, 200, `a second initialize is not wedged by the first (got ${repeated.status}, ${JSON.stringify(repeated.body)})`);

  console.log('✅ Database initialize recovers a stale Drive restore boundary');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });
