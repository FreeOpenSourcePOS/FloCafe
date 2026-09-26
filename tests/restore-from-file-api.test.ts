/**
 * Restore-from-file API tests.
 *
 * Pins the authorised alternative to the Master PIN gate: a restore over HTTP is
 * allowed for a session holding database.manage, it requires the typed
 * confirmation phrase, and it only accepts a file the operator actually picked in
 * the native dialog — never an arbitrary renderer-supplied path.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/restore-from-file-api.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-restore-from-file-api-'));

const mockApp = { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' };
const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-restore-from-file';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { API_JSON_BODY_LIMIT } = require('../main/http-limits');
const { initDatabase, getDatabase, closeDatabase, createBackup, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { databaseRoutes } = require('../main/routes/database');
const {
  rememberRestoreFileSelection,
  consumeRestoreFileSelection,
  clearRestoreFileSelection,
} = require('../main/services/restore-file-selection');

const RESTORE_CONFIRMATION = 'RESTORE BACKUP';

function ownerToken(): string {
  return jwt.sign({ userId: 'restore-owner', role: 'owner' }, getJWTSecret(), { expiresIn: '10m' });
}

function serverToken(): string {
  return jwt.sign({ userId: 'restore-server', role: 'server' }, getJWTSecret(), { expiresIn: '10m' });
}

async function run() {
  fs.mkdirSync(path.join(testDir, 'backups'), { recursive: true });
  initDatabase();

  const { authRoutes } = require('../main/routes/auth');
  const { requireAuth } = require('../main/server');
  const app = express();
  app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
  app.use(requireAuth);
  app.use('/api/auth', authRoutes);
  app.use('/api/db', databaseRoutes);

  const seedUser = (id: string, role: string) => getDatabase().prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, id, `${id}@test.local`, 'not-a-real-hash', role, now(), now());
  seedUser('restore-owner', 'owner');
  seedUser('restore-server', 'server');

  const backupSource = (await createBackup()).path;
  getDatabase().prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('api-post-backup', 'Added After Backup');

  // --- confirmation phrase is required --------------------------------------
  const noConfirmSelection = rememberRestoreFileSelection(backupSource);
  const missingPhrase = await request(app)
    .post('/api/db/restore')
    .set('Authorization', `Bearer ${ownerToken()}`)
    .send({ selection_token: noConfirmSelection.token });
  assert.equal(missingPhrase.status, 400, 'restore without the confirmation phrase is refused');
  clearRestoreFileSelection();

  // --- an unpicked path is refused ------------------------------------------
  const noSelection = await request(app)
    .post('/api/db/restore')
    .set('Authorization', `Bearer ${ownerToken()}`)
    .send({ confirmation: RESTORE_CONFIRMATION, selection_token: 'invented-token' });
  assert.equal(noSelection.status, 400, 'restore with a token that was never issued is refused');
  assert.match(noSelection.body.error, /Choose a backup file/, 'the refusal explains the file must be chosen first');

  // --- a session without database.manage is refused -------------------------
  const unprivilegedSelection = rememberRestoreFileSelection(backupSource);
  const unprivileged = await request(app)
    .post('/api/db/restore')
    .set('Authorization', `Bearer ${serverToken()}`)
    .send({ confirmation: RESTORE_CONFIRMATION, selection_token: unprivilegedSelection.token });
  assert.equal(unprivileged.status, 403, 'restore is refused for a session without database.manage');
  clearRestoreFileSelection();

  // --- an unauthenticated caller is refused ---------------------------------
  const anonymousSelection = rememberRestoreFileSelection(backupSource);
  const anonymous = await request(app)
    .post('/api/db/restore')
    .send({ confirmation: RESTORE_CONFIRMATION, selection_token: anonymousSelection.token });
  assert.equal(anonymous.status, 401, 'restore is refused without a session');
  clearRestoreFileSelection();

  // --- a valid single-use selection restores --------------------------------
  const selection = rememberRestoreFileSelection(backupSource);
  const restored = await request(app)
    .post('/api/db/restore')
    .set('Authorization', `Bearer ${ownerToken()}`)
    .send({ confirmation: RESTORE_CONFIRMATION, selection_token: selection.token });
  assert.equal(restored.status, 200, `restore from a picked file succeeds (got ${restored.status}: ${JSON.stringify(restored.body)})`);
  assert.equal(restored.body.success, true, 'restore reports success');
  assert.equal(
    getDatabase().prepare('SELECT id FROM categories WHERE id = ?').get('api-post-backup'),
    undefined,
    'the restore replaced the data added after the backup was taken',
  );

  // The token is single use: replaying it must not restore again.
  const replay = await request(app)
    .post('/api/db/restore')
    .set('Authorization', `Bearer ${ownerToken()}`)
    .send({ confirmation: RESTORE_CONFIRMATION, selection_token: selection.token });
  assert.equal(replay.status, 400, 'a restore selection token cannot be replayed');

  // --- the selection service itself -----------------------------------------
  clearRestoreFileSelection();
  assert.equal(consumeRestoreFileSelection('anything'), null, 'no selection means nothing to consume');
  const reused = rememberRestoreFileSelection(backupSource);
  assert.equal(consumeRestoreFileSelection('wrong-token'), null, 'a mismatched token does not yield the path');
  assert.equal(consumeRestoreFileSelection(reused.token), backupSource, 'the matching token yields the picked path once');
  assert.equal(consumeRestoreFileSelection(reused.token), null, 'the selection is consumed after one use');

  console.log('✅ Restore-from-file API and authorisation tests passed');
}

run()
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
