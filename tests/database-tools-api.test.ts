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
import * as http from 'node:http';

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
const { API_JSON_BODY_LIMIT } = require('../main/http-limits');
const { initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion, MIGRATIONS, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { authRoutes } = require('../main/routes/auth');
const { databaseToolsRoutes } = require('../main/routes/database-tools');
const { databaseRoutes } = require('../main/routes/database');
const { verifyMasterPin, isMasterPinSet } = require('../main/services/master-pin');
const { cancelHttpShutdownWork, closeHttpServer, installHttpShutdownTracking } = require('../main/shutdown');

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
let stalledDownloadStarted!: () => void;
const stalledDownloadStartedPromise = new Promise<void>((resolve) => { stalledDownloadStarted = resolve; });
let stalledDownloadDestroyed = false;
app.use(express.json({ limit: API_JSON_BODY_LIMIT }));
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
app.use((req: any, res: any, next: any) => {
  if (req.path === '/api/db/download' && req.headers['x-test-stall-download'] === '1') {
    const destroy = res.destroy.bind(res);
    res.destroy = (...args: any[]) => {
      stalledDownloadDestroyed = true;
      return destroy(...args);
    };
    res.download = (_filePath: string, _filename: string, _callback: (error?: Error) => void) => {
      stalledDownloadStarted();
    };
  }
  next();
});
app.use('/api/auth', authRoutes);
app.use('/api/db-tools', databaseToolsRoutes);
app.use('/api/db', databaseRoutes);

const downloadServer = http.createServer(app);
installHttpShutdownTracking(downloadServer);

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

  await new Promise<void>((resolve) => downloadServer.listen(0, '127.0.0.1', resolve));
  const stalledDownload = request(downloadServer)
    .get('/api/db/download')
    .set('Authorization', `Bearer ${ownerToken}`)
    .set('x-test-stall-download', '1')
    .send({ master_pin: '1234' });
  void stalledDownload.then(() => undefined, () => undefined);
  await stalledDownloadStartedPromise;
  cancelHttpShutdownWork();
  await new Promise((resolve) => setImmediate(resolve));
  assert(stalledDownloadDestroyed, 'database download destroys its response when HTTP shutdown cancels the request');
  await closeHttpServer(downloadServer, 'database download stream test', 100);

  const unresolvedUserImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [], categories: [], products: [], users: [],
        orders: [{ id: 'order-with-missing-user', user_id: 'missing-user' }],
      },
    },
  });
  assert(unresolvedUserImport.status === 400, `imports with unresolved redacted user references are rejected (got ${unresolvedUserImport.status})`);
  assert(unresolvedUserImport.body.error?.includes('user accounts'), 'unresolved user import explains the required staff setup');

  const redactedUserImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [],
        categories: [],
        products: [],
        users: [{ id: 'redacted-user-1', name: 'Imported Redacted User', role: 'waiter', is_active: 1 }],
        orders: [{ id: 1001, order_number: 'ORD-REDACTED-USER-001', user_id: 'redacted-user-1' }],
      },
    },
  });
  assert(redactedUserImport.status === 200, `redacted exported users are restored as placeholders (got ${redactedUserImport.status}, ${JSON.stringify(redactedUserImport.body)})`);
  assert(redactedUserImport.body.placeholderUsersCreated === 1, 'import reports one placeholder user created');
  const placeholderUser = db.prepare("SELECT name, role, is_active, password, email FROM users WHERE id = 'redacted-user-1'").get() as { name: string; role: string; is_active: number; password: string; email: string | null } | undefined;
  assert(placeholderUser?.name === 'Imported Redacted User', 'placeholder user preserves display name');
  assert(placeholderUser?.role === 'waiter', 'placeholder user preserves role');
  assert(placeholderUser?.is_active === 0, 'placeholder user is inactive');
  assert(placeholderUser?.email == null, 'placeholder user does not reserve the exported email');
  assert(placeholderUser?.password !== '[REDACTED]', 'placeholder user does not use the redaction marker as a password');

  // Redacted export fields must never become literal credentials on import.
  db.prepare("INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES ('stale-import-category', 'Stale', 99)").run();
  const jwtSecretBefore = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined;
  const redactedImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [{ key: 'jwt_secret', value: '[REDACTED]', updated_at: now() }],
        categories: [],
        products: [],
        users: [],
      },
    },
  });
  assert(redactedImport.status === 200, `redacted settings import returns 200 (got ${redactedImport.status}, ${JSON.stringify(redactedImport.body)})`);
  assert((db.prepare("SELECT COUNT(*) AS count FROM categories WHERE id = 'stale-import-category'").get() as { count: number }).count === 0, 'overwrite import clears tables explicitly present as empty');
  const jwtSecretAfter = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get() as { value: string } | undefined;
  assert(
    (jwtSecretAfter?.value ?? null) === (jwtSecretBefore?.value ?? null),
    'redacted jwt_secret is preserved during import',
  );

  const largeJsonImport = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
    master_pin: '1234',
    overwrite: true,
    data: {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [{ key: 'json_large_import_probe', value: 'x'.repeat(2 * 1024 * 1024), updated_at: now() }],
        categories: [],
        products: [],
        users: [],
      },
    },
  });
  assert(largeJsonImport.status === 200, `multi-megabyte JSON imports are accepted (got ${largeJsonImport.status}, ${JSON.stringify(largeJsonImport.body).slice(0, 200)})`);

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

  // ── Test 3c: schema-mismatch import requires the Master PIN (GHSA-xxv4-gm82-4639) ──
  console.log('\nTest 3c: POST /db/import destructive path is master-PIN gated');
  {
    const currentVersion = getCurrentSchemaVersion();
    const emptyPayload = { settings: [], categories: [], products: [], users: [] };
    const importWithoutPin = (payload: Record<string, unknown>) =>
      request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({ overwrite: false, data: payload });

    db.prepare("INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES ('ghsa-sentinel', 'Sentinel', 999)").run();
    const sentinelCount = () => (db.prepare("SELECT COUNT(*) AS c FROM categories WHERE id = 'ghsa-sentinel'").get() as { c: number }).c;

    // GET /api/db-tools/master-pin/status exposes live schemaVersion alongside availability
    const pinStatus = await request(app).get('/api/db-tools/master-pin/status').set('Authorization', `Bearer ${ownerToken}`);
    assert(pinStatus.status === 200, `master-pin status returns 200 (got ${pinStatus.status})`);
    assert(pinStatus.body.available === true, 'master-pin status reports available: true');
    assert(pinStatus.body.isSet === true, 'master-pin status reports isSet: true');
    assert(pinStatus.body.schemaVersion === currentVersion, `master-pin status includes live schemaVersion (got ${pinStatus.body.schemaVersion}, expected ${currentVersion})`);

    // Mismatched (future) schema version, no PIN → rejected and DB unchanged.
    const futureNoPin = await importWithoutPin({ schema_version: String(currentVersion + 1), data: emptyPayload });
    assert(futureNoPin.status === 403, `future schema_version import without a PIN is rejected (got ${futureNoPin.status})`);
    assert(sentinelCount() === 1, 'rejected schema-mismatch import leaves the database unchanged');

    // Mismatched schema version with wrong PIN → rejected and DB unchanged.
    const mismatchedWrongPin = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
      overwrite: false,
      master_pin: '0000',
      data: { schema_version: String(currentVersion + 1), data: emptyPayload },
    });
    assert(mismatchedWrongPin.status === 403, `mismatched schema_version with wrong PIN is rejected (got ${mismatchedWrongPin.status})`);
    assert(sentinelCount() === 1, 'rejected wrong-PIN schema-mismatch import leaves the database unchanged');

    // Fresh install (schema version 0), no PIN → rejected.
    const freshZeroNoPin = await importWithoutPin({ schema_version: '0', data: emptyPayload });
    assert(freshZeroNoPin.status === 403, `fresh schema_version 0 import without a PIN is rejected (got ${freshZeroNoPin.status})`);

    // Old (upgrade-path) schema version, no PIN → rejected.
    const oldNoPin = await importWithoutPin({ schema_version: String(currentVersion - 1), data: emptyPayload });
    assert(oldNoPin.status === 403, `old-schema (upgrade-path) import without a PIN is rejected (got ${oldNoPin.status})`);

    // Malformed schema version, no PIN → treated as destructive and rejected.
    const malformedNoPin = await importWithoutPin({ schema_version: 'not-a-version', data: emptyPayload });
    assert(malformedNoPin.status === 403, `malformed schema_version import without a PIN is rejected (got ${malformedNoPin.status})`);

    // Omitted schema version, no PIN → defaults to 0 (a mismatch) and is rejected.
    const omittedNoPin = await importWithoutPin({ data: emptyPayload });
    assert(omittedNoPin.status === 403, `omitted schema_version import without a PIN is rejected (got ${omittedNoPin.status})`);

    // Mismatched schema version with the correct PIN → allowed.
    const mismatchedWithPin = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
      overwrite: false,
      master_pin: '1234',
      data: { schema_version: String(currentVersion + 1), data: emptyPayload },
    });
    assert(mismatchedWithPin.status === 200, `schema-mismatch import with the correct PIN succeeds (got ${mismatchedWithPin.status}, ${JSON.stringify(mismatchedWithPin.body)})`);

    // Matching schema version, no overwrite, no PIN → non-destructive merge, allowed.
    const matchingNoPin = await importWithoutPin({ schema_version: String(currentVersion), data: emptyPayload });
    assert(matchingNoPin.status === 200, `matching-schema import without overwrite needs no PIN (got ${matchingNoPin.status})`);

    // Matching schema version + explicit overwrite, no PIN → still rejected.
    const matchingOverwriteNoPin = await request(app).post('/api/db/import').set('Authorization', `Bearer ${ownerToken}`).send({
      overwrite: true,
      data: { schema_version: String(currentVersion), data: emptyPayload },
    });
    assert(matchingOverwriteNoPin.status === 403, `matching-schema overwrite import without a PIN is still rejected (got ${matchingOverwriteNoPin.status})`);
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
    assert(getCurrentSchemaVersion() === MIGRATIONS[MIGRATIONS.length - 1].version, 'the recreated database is at the latest schema version');

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
