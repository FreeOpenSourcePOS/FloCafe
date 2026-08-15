/**
 * Regression coverage for GHSA-ppjh-gjj8-7f63: token-revocation lookup
 * failures must fail closed. A missing/locked/closed revocation store must
 * deny, never silently allow, a token that may have been revoked.
 *
 * Run: node tests/run-electron-node-test.cjs tests/token-revocation-fail-closed.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-rev-failclosed-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-rev-failclosed';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const Database = require('better-sqlite3');
const {
  initTestDb, createApp, assertEqual, getResults, getDatabase, closeDatabase, now,
} = require('./helpers/test-setup');
const { initDatabase, getDbPath } = require('../main/db');
const { getJWTSecret, authRoutes } = require('../main/routes/auth');
const { isTokenRevoked, revokeToken } = require('../main/middleware/security');

async function run() {
  console.log('Token revocation fail-closed tests (GHSA-ppjh-gjj8-7f63)');
  console.log('='.repeat(60));

  const db = initTestDb();

  // ── 1. Locked database fails closed ─────────────────────────────────────
  // The first lookup also runs the expired-revocation cleanup write; holding
  // an exclusive write lock on a second connection makes that write throw
  // SQLITE_BUSY, which must be treated as revoked (deny), not as un-revoked.
  {
    db.pragma('busy_timeout = 100');
    const second = new Database(getDbPath());
    second.exec('BEGIN EXCLUSIVE');
    try {
      assertEqual(isTokenRevoked('locked-db-token'), true, 'locked revocation store fails closed (deny)');
    } finally {
      second.exec('ROLLBACK');
      second.close();
      db.pragma('busy_timeout = 5000');
    }
  }

  // ── 2. Baseline: a valid non-revoked token is not flagged ───────────────
  assertEqual(isTokenRevoked('never-revoked-token'), false, 'non-revoked token is not flagged');

  // ── 3. A revoked token is flagged ───────────────────────────────────────
  revokeToken('revoked-token', Date.now() + 60_000);
  assertEqual(isTokenRevoked('revoked-token'), true, 'revoked token is flagged');

  // ── 4. Missing revocation table (query failure) fails closed ────────────
  db.exec('DROP TABLE revoked_tokens');
  assertEqual(isTokenRevoked('missing-table-token'), true, 'missing revoked_tokens table fails closed (deny)');

  // ── 5. Route-level: valid token is denied when the store is unavailable ──
  {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES ('rev-owner-1', 'Rev Owner', 'rev-owner@test.local', ?, 'owner', 1, ?, ?)`)
      .run(bcrypt.hashSync('Pass1234!', 10), now(), now());
    const token = jwt.sign(
      { userId: 'rev-owner-1', email: 'rev-owner@test.local', role: 'owner' },
      getJWTSecret(),
      { expiresIn: '1h' },
    );
    const app = createApp({ '/api/auth': authRoutes });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    assertEqual(res.status, 401, 'valid token is denied (401) when the revocation store is unavailable');
  }

  // ── 6. Closed database fails closed ─────────────────────────────────────
  db.exec(`CREATE TABLE revoked_tokens (token_hash TEXT PRIMARY KEY, expires_at INTEGER, revoked_at TEXT)`);
  closeDatabase();
  assertEqual(isTokenRevoked('closed-db-token'), true, 'closed revocation store fails closed (deny)');
  initDatabase();

  const results = getResults();
  if (results.failed > 0) {
    throw new Error(`${results.failed} assertion(s) failed`);
  }
  console.log('\n✅ Token revocation fail-closed tests passed!');
}

run()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  })
  .catch((err) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  });
