/**
 * Database Tools API Tests (supertest)
 *
 * Exercises /api/db-tools/* and the PIN-gated parts of /api/db/* against the
 * real Express route handlers.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/database-tools-api.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-db-tools-api-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-for-db-tools-api';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { authRoutes } = require('../main/routes/auth');
const { databaseToolsRoutes } = require('../main/routes/database-tools');
const { databaseRoutes } = require('../main/routes/database');
const { verifyMasterPin, isMasterPinSet } = require('../main/services/master-pin');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function isNativeAbiMismatch(error: any): boolean {
  return error?.code === 'ERR_DLOPEN_FAILED'
    && String(error?.message || '').includes('NODE_MODULE_VERSION');
}

try {
  initDatabase();
} catch (error: any) {
  if (isNativeAbiMismatch(error)) {
    console.log('  ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
    process.exit(77);
  }
  console.error('Failed to initialize database:', error.message);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use((req: any, res: any, next: any) => {
  if (!req.path.startsWith('/api')) { next(); return; }
  if (req.path.startsWith('/api/auth')) { next(); return; }

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
app.use('/api/auth', authRoutes);
app.use('/api/db-tools', databaseToolsRoutes);
app.use('/api/db', databaseRoutes);

function tokenFor(userId: string, role: string): string {
  return jwt.sign({ userId, email: `${userId}@flo.local`, role }, getJWTSecret(), { expiresIn: '1h' });
}

async function runTests() {
  console.log('Database Tools API Tests (supertest)');
  console.log('='.repeat(50));

  // ── Test 1: setup/initialize requires a 4-digit master_pin when available ──
  console.log('\nTest 1: setup requires master_pin');
  {
    const missingPin = await request(app).post('/api/auth/setup/initialize').send({
      name: 'Owner', email: 'owner@example.com', password: 'TestPass123',
      business_type: 'restaurant', setup_profile: 'empty', service_model: 'qsr',
      terms_accepted: true,
    });
    assert(missingPin.status === 400, `setup without master_pin returns 400 (got ${missingPin.status})`);

    const ok = await request(app).post('/api/auth/setup/initialize').send({
      name: 'Owner', email: 'owner@example.com', password: 'TestPass123',
      business_type: 'restaurant', setup_profile: 'empty', service_model: 'qsr',
      terms_accepted: true, master_pin: '1234',
    });
    assert(ok.status === 200, `setup with valid master_pin succeeds (got ${ok.status}, ${JSON.stringify(ok.body)})`);
    assert(isMasterPinSet(), 'master PIN is set on disk after setup');
    assert(verifyMasterPin('1234'), 'the PIN submitted during setup verifies afterward');
  }

  const ownerToken = tokenFor('owner-1', 'owner');
  const db = getDatabase();
  db.exec(`INSERT OR IGNORE INTO users (id, name, password, role, is_active) VALUES ('cashier-1', 'Cashier', 'hash', 'cashier', 1)`);
  const cashierToken = tokenFor('cashier-1', 'cashier');

  // ── Test 2: health-check is owner-gated, not PIN-gated ──────────────────
  console.log('\nTest 2: GET /db-tools/health-check');
  {
    const forbidden = await request(app).get('/api/db-tools/health-check').set('Authorization', `Bearer ${cashierToken}`);
    assert(forbidden.status === 403, `non-owner is forbidden (got ${forbidden.status})`);

    const ok = await request(app).get('/api/db-tools/health-check').set('Authorization', `Bearer ${ownerToken}`);
    assert(ok.status === 200, `owner gets 200 (got ${ok.status})`);
    assert(Array.isArray(ok.body.findings), 'response has a findings array');
    assert(typeof ok.body.summary?.safeCount === 'number', 'response has a summary.safeCount');
  }

  // ── Test 3: POST /db/backup requires the master PIN ─────────────────────
  console.log('\nTest 3: POST /db/backup is master-PIN gated');
  {
    const noPin = await request(app).post('/api/db/backup').set('Authorization', `Bearer ${ownerToken}`).send({});
    assert(noPin.status === 403, `backup without a PIN is rejected (got ${noPin.status})`);

    const wrongPin = await request(app).post('/api/db/backup').set('Authorization', `Bearer ${ownerToken}`).send({ master_pin: '0000' });
    assert(wrongPin.status === 403, `backup with the wrong PIN is rejected (got ${wrongPin.status})`);

    const ok = await request(app).post('/api/db/backup').set('Authorization', `Bearer ${ownerToken}`).send({ master_pin: '1234' });
    assert(ok.status === 200, `backup with the correct PIN succeeds (got ${ok.status}, ${JSON.stringify(ok.body)})`);
    const backupFiles = fs.readdirSync(path.join(testDir, 'backups')).filter((f: string) => f.endsWith('.db'));
    assert(backupFiles.length > 0, 'a backup file was actually written to the backups directory');
  }

  // ── Test 3b: GET /db-tools/backups lists what was just created (#120) ───
  console.log('\nTest 3b: GET /db-tools/backups');
  {
    const forbidden = await request(app).get('/api/db-tools/backups').set('Authorization', `Bearer ${cashierToken}`);
    assert(forbidden.status === 403, `non-owner is forbidden (got ${forbidden.status})`);

    const ok = await request(app).get('/api/db-tools/backups').set('Authorization', `Bearer ${ownerToken}`);
    assert(ok.status === 200, `owner gets 200 (got ${ok.status})`);
    assert(Array.isArray(ok.body.backups), 'response has a backups array');
    assert(ok.body.backups.length >= 1, 'the backup created in Test 3 is listed');

    const entry = ok.body.backups[0];
    assert(typeof entry.fileName === 'string' && entry.fileName.endsWith('.db'), 'entry has a .db fileName');
    assert(typeof entry.sizeBytes === 'number' && entry.sizeBytes > 0, 'entry has a positive sizeBytes');
    assert(!Number.isNaN(new Date(entry.createdAt).getTime()), 'entry has a parseable createdAt');
    assert(entry.kind === 'manual', 'a backup created via POST /db/backup is classified as manual, not auto');
  }

  // ── Test 4: POST /db-tools/initialize ────────────────────────────────────
  console.log('\nTest 4: POST /db-tools/initialize');
  {
    const wrongPhrase = await request(app).post('/api/db-tools/initialize').set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234', confirmation_phrase: 'nope' });
    assert(wrongPhrase.status === 400, `wrong confirmation phrase is rejected (got ${wrongPhrase.status})`);

    const wrongPin = await request(app).post('/api/db-tools/initialize').set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '0000', confirmation_phrase: 'INITIALIZE' });
    assert(wrongPin.status === 403, `wrong PIN is rejected even with the right phrase (got ${wrongPin.status})`);

    const ok = await request(app).post('/api/db-tools/initialize').set('Authorization', `Bearer ${ownerToken}`)
      .send({ master_pin: '1234', confirmation_phrase: 'INITIALIZE' });
    assert(ok.status === 200, `initialize succeeds with correct PIN + phrase (got ${ok.status}, ${JSON.stringify(ok.body)})`);
    assert(!!ok.body.backupPath, 'response includes the forced pre-wipe backup path');

    const freshDb = getDatabase();
    const userCount = (freshDb.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    assert(userCount === 0, 'no users remain after initialize — back to first-run state');
    assert(getCurrentSchemaVersion() === 33, 'the recreated database is at the latest schema version');

    // The core "locked-out owner" guarantee: the Master PIN survives a full DB wipe
    // because it lives outside flo.db entirely.
    assert(isMasterPinSet(), 'master-pin.enc still exists after the database was wiped');
    assert(verifyMasterPin('1234'), 'the same Master PIN still verifies after the database was wiped');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

runTests();
