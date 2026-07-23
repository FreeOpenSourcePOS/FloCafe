/**
 * Issue #127 — Local password recovery via Master PIN (supertest)
 *
 * Exercises POST /api/auth/recover-password against the real Express route
 * handler, following the harness pattern used by tests/database-tools-api.test.ts.
 *
 * Coverage:
 *   - blocked when setup is incomplete (no owner exists yet)
 *   - blocked when the Master PIN has never been set on this device
 *   - blocked when Master PIN protection is unavailable (no OS keyring)
 *   - rejected with the wrong Master PIN
 *   - successful recovery with the correct email + PIN + new password
 *   - the new password actually works for a subsequent /login call
 *   - rate-limiting kicks in after repeated wrong-PIN attempts
 *   - an unrelated password change does not disturb the stored Master PIN blob
 *   - recovery never creates/wipes users — only the targeted owner's password changes
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-127-password-recovery.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-127-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

// Identity "encryption" stand-in, toggleable so we can exercise the
// "Master PIN unavailable on this device" branch of authorizeMasterPin.
let encryptionAvailable = true;
const mockSafeStorage = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp, safeStorage: mockSafeStorage };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-for-issue-127';

const express = require('express');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const { authRoutes } = require('../main/routes/auth');
const { setMasterPin, verifyMasterPin, isMasterPinSet } = require('../main/services/master-pin');

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
app.use('/api/auth', authRoutes);

async function runTests() {
  console.log('Issue #127: Password Recovery API (supertest)');
  console.log('='.repeat(50));

  const db = getDatabase();

  // ── Test 1: blocked when setup is incomplete (no owner exists yet) ──────
  console.log('\nTest 1: recover-password blocked before setup is complete');
  {
    const res = await request(app).post('/api/auth/recover-password').send({
      email: 'owner@example.com', master_pin: '1234', new_password: 'NewPass123',
    });
    assert(res.status === 409, `blocked with 409 when no owner exists (got ${res.status})`);
    assert(!isMasterPinSet(), 'no Master PIN has been set yet at this point either');
  }

  // Bypass the setup wizard on purpose: insert the owner directly so we can
  // control exactly when (if ever) the Master PIN gets set, independent of
  // /setup/initialize's own "PIN required at setup" enforcement.
  const bcrypt = require('bcryptjs');
  const ORIGINAL_PASSWORD = 'OriginalPass123';
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('owner-1', 'Owner', 'owner@example.com', ?, 'owner', 1, datetime('now'), datetime('now'))
  `).run(bcrypt.hashSync(ORIGINAL_PASSWORD, 10));

  // ── Test 2a: blocked when the Master PIN has never been set ─────────────
  console.log('\nTest 2a: recover-password blocked when Master PIN is not set yet');
  {
    const res = await request(app).post('/api/auth/recover-password').send({
      email: 'owner@example.com', master_pin: '1234', new_password: 'NewPass123',
    });
    assert(res.status === 409, `blocked with 409 when Master PIN is unset (got ${res.status}, ${JSON.stringify(res.body)})`);
  }

  // ── Test 2b: blocked when Master PIN protection is unavailable ──────────
  console.log('\nTest 2b: recover-password blocked when encryption/keyring is unavailable');
  {
    encryptionAvailable = false;
    const res = await request(app).post('/api/auth/recover-password').send({
      email: 'owner@example.com', master_pin: '1234', new_password: 'NewPass123',
    });
    assert(res.status === 503, `blocked with 503 when safeStorage is unavailable (got ${res.status})`);
    encryptionAvailable = true;
  }

  // Now actually set a Master PIN for this install (independent of flo.db —
  // exactly like a real install, this can be done without an active session).
  setMasterPin('1234');
  assert(isMasterPinSet(), 'Master PIN is set on disk for the remaining tests');

  // ── Test 3: rejected with the wrong Master PIN ───────────────────────────
  console.log('\nTest 3: recover-password rejected with the wrong Master PIN');
  {
    const res = await request(app).post('/api/auth/recover-password').send({
      email: 'owner@example.com', master_pin: '0000', new_password: 'NewPass123',
    });
    assert(res.status === 403, `wrong PIN is rejected (got ${res.status}, ${JSON.stringify(res.body)})`);

    const login = await request(app).post('/api/auth/login').send({
      email: 'owner@example.com', password: ORIGINAL_PASSWORD,
    });
    assert(login.status === 200, 'original password still works after a failed recovery attempt');
  }

  // ── Test 4: successful recovery with correct email + PIN + new password ─
  console.log('\nTest 4: successful recovery with correct email, PIN, and new password');
  const NEW_PASSWORD = 'BrandNewPass123';
  {
    const res = await request(app).post('/api/auth/recover-password').send({
      email: 'Owner@Example.com', // exercises email normalization (case/whitespace)
      master_pin: '1234',
      new_password: NEW_PASSWORD,
    });
    assert(res.status === 200, `recovery succeeds with correct PIN (got ${res.status}, ${JSON.stringify(res.body)})`);

    const oldLogin = await request(app).post('/api/auth/login').send({
      email: 'owner@example.com', password: ORIGINAL_PASSWORD,
    });
    assert(oldLogin.status === 401, 'the old password no longer works after recovery');

    const newLogin = await request(app).post('/api/auth/login').send({
      email: 'owner@example.com', password: NEW_PASSWORD,
    });
    assert(newLogin.status === 200, `the new password set via recovery works for /login (got ${newLogin.status})`);
    assert(!!newLogin.body.access_token, 'login after recovery returns an access token');
  }

  // ── Test 5: recovery never creates/wipes users — only one password field changes ─
  console.log('\nTest 5: recovery does not touch user count or other rows');
  {
    const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
    assert(userCount === 1, `still exactly one user after recovery (got ${userCount})`);
  }

  // ── Test 6: an unrelated password change does not disturb the Master PIN ─
  console.log('\nTest 6: unrelated password changes leave the Master PIN blob untouched');
  {
    const jwt = require('jsonwebtoken');
    const { getJWTSecret } = require('../main/routes/auth');
    const token = jwt.sign({ userId: 'owner-1', email: 'owner@example.com', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });

    const changeRes = await request(app).post('/api/auth/password/change')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: NEW_PASSWORD, password: 'YetAnotherPass123' });
    assert(changeRes.status === 200, `unrelated /password/change succeeds (got ${changeRes.status})`);
    assert(verifyMasterPin('1234'), 'the Master PIN set during recovery testing still verifies after an unrelated password change');
  }

  // ── Test 7: rate limiting kicks in after repeated wrong-PIN attempts ─────
  console.log('\nTest 7: rate limiting kicks in after repeated wrong-PIN attempts');
  {
    // Budget so far consumed against the recover-password rate-limit key
    // (IP-scoped, 5 attempts per window): Test 3 (1) + Test 4 (1) = 2 used.
    // 3 attempts remain before the 6th trips the 429.
    let lastStatus = 0;
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/recover-password').send({
        email: 'owner@example.com', master_pin: '9999', new_password: 'AnotherNewPass123',
      });
      lastStatus = res.status;
      assert(res.status === 403, `attempt ${i + 1} with wrong PIN is rejected with 403 (got ${res.status})`);
    }
    const blocked = await request(app).post('/api/auth/recover-password').send({
      email: 'owner@example.com', master_pin: '9999', new_password: 'AnotherNewPass123',
    });
    assert(blocked.status === 429, `the 6th attempt in the window is rate-limited (got ${blocked.status})`);
    assert(lastStatus === 403, 'sanity: the attempts immediately before the block were still plain wrong-PIN rejections');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

runTests().catch((err) => {
  console.error(err);
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
