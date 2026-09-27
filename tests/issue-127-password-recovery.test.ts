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
// This suite exceeds the production auth ceiling of 10 per window; the
// limiter under test is the Master PIN one.
process.env.FLO_AUTH_RATE_LIMIT_MAX = '100';

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
// Mounted so the recovery test can drive the editor instead of inferring it.
const { authorizationRoutes } = require('../main/routes/authorization');
app.use('/api/authorization', (req: any, _res: any, next: any) => {
  const userId = req.header('x-test-user');
  if (userId) req.user = { userId };
  next();
}, authorizationRoutes);

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
  console.log('\nTest 7: recovery restores an owner role when none remain');
  {
    db.prepare("UPDATE users SET role = 'cashier' WHERE id = 'owner-1'").run();
    const res = await request(app).post('/api/auth/recover-password').send({
      email: 'owner@example.com', master_pin: '1234', new_password: 'RecoveredOwnerPass123',
    });
    assert(res.status === 200, `recovery restores owner access when no active owner remains (got ${res.status}, ${JSON.stringify(res.body)})`);
    const recovered = db.prepare('SELECT role FROM users WHERE id = ?').get('owner-1') as { role: string };
    assert(recovered.role === 'owner', 'recovery promotes the active account back to owner');
  }

  // ── Test 8: recovery widens from "no owner" to "no administrator" ───────
  console.log('\nTest 8: recovery restores a store whose owners can no longer administer');
  {
    const { reachesAdministration, resolveEffectivePermissions } = require('../main/services/authorization');
    const bcrypt = require('bcryptjs');
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES ('manager-1', 'Manager', 'manager@example.com', ?, 'manager', 1, datetime('now'), datetime('now'))
    `).run(bcrypt.hashSync('ManagerPass123', 10));

    // Baseline: a healthy install must not turn recovery into a role promotion.
    const healthy = await request(app).post('/api/auth/recover-password').send({
      email: 'manager@example.com', master_pin: '1234', new_password: 'RecoveredManagerPass123',
    });
    assert(healthy.status === 404, `a non-owner is not recoverable while the store can still administer itself (got ${healthy.status}, ${JSON.stringify(healthy.body)})`);

    // A user-override strand: nobody can reach the editor that would undo it.
    for (const permissionId of ['settings.manage', 'staff.operational.manage']) {
      db.prepare(`
        INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
        VALUES ('owner-1', ?, 'deny', 'owner-1', datetime('now'), datetime('now'))
      `).run(permissionId);
    }
    const activeOwners = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner' AND is_active = 1").get() as { count: number }).count;
    assert(activeOwners === 1, `the stranded install still has an active owner to count (got ${activeOwners})`);
    const administrators = (db.prepare('SELECT id FROM users WHERE is_active = 1').all() as Array<{ id: string }>)
      .filter(({ id }) => {
        const effective = resolveEffectivePermissions(id);
        return effective !== null && reachesAdministration(effective.permissionIds);
      });
    assert(administrators.length === 0, 'no active account can reach administration, so the install really is stranded');

    const res = await request(app).post('/api/auth/recover-password').send({
      email: 'manager@example.com', master_pin: '1234', new_password: 'StrandedStorePass123',
    });
    assert(res.status === 200, `recovery promotes an account when owners remain but none of them can administer (got ${res.status}, ${JSON.stringify(res.body)})`);
    assert(res.body.message === 'Owner access restored. You can now log in with your new password.',
      `the response reports owner access being restored (got ${JSON.stringify(res.body.message)})`);
    assert((db.prepare('SELECT role FROM users WHERE id = ?').get('manager-1') as { role: string }).role === 'owner',
      'the recovered account is promoted to owner');

    const promoted = resolveEffectivePermissions('manager-1');
    assert(promoted !== null && reachesAdministration(promoted.permissionIds),
      'the promoted account reaches the administrative surface again, so the install is no longer stranded');
    const login = await request(app).post('/api/auth/login').send({
      email: 'manager@example.com', password: 'StrandedStorePass123',
    });
    assert(login.status === 200, `the recovered owner can log in with the new password (got ${login.status})`);
  }

  // ── Test 8b: a role-level strand still leaves a way in ─────────────────
  console.log('\nTest 8b: a store stranded by a role default recovers through the protected editor');
  {
    const { reachesAdministration, resolveEffectivePermissions } = require('../main/services/authorization');
    const bcrypt = require('bcryptjs');
    // A role-default strand: promotion alone cannot undo it, so the protected
    // editor entry point is what makes this a recovery.
    for (const permissionId of ['settings.manage', 'staff.operational.manage']) {
      db.prepare(`
        INSERT INTO role_permission_overrides (role, permission_id, effect, updated_by, created_at, updated_at)
        VALUES ('owner', ?, 'deny', 'owner-1', datetime('now'), datetime('now'))
        ON CONFLICT (role, permission_id) DO UPDATE SET effect = 'deny'
      `).run(permissionId);
    }
    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES ('cashier-1', 'Cashier', 'cashier@example.com', ?, 'cashier', 1, datetime('now'), datetime('now'))
    `).run(bcrypt.hashSync('CashierPass123', 10));
    const administrators = (db.prepare('SELECT id FROM users WHERE is_active = 1').all() as Array<{ id: string }>)
      .filter(({ id }) => {
        const effective = resolveEffectivePermissions(id);
        return effective !== null && reachesAdministration(effective.permissionIds);
      });
    assert(administrators.length === 0, 'precondition: the role default strands the install for every account');

    const res = await request(app).post('/api/auth/recover-password').send({
      email: 'cashier@example.com', master_pin: '1234', new_password: 'RoleStrandPass123',
    });
    assert(res.status === 200, `recovery promotes an account even when the owner role itself is denied (got ${res.status}, ${JSON.stringify(res.body)})`);
    assert((db.prepare('SELECT role FROM users WHERE id = ?').get('cashier-1') as { role: string }).role === 'owner',
      'the account is promoted to owner so the protected permissions follow it');

    const promoted = resolveEffectivePermissions('cashier-1');
    assert(promoted !== null && promoted.permissionIds.has('authorization.manage'),
      'the promoted owner holds the protected permission editor entry point, so the role default is undoable');
    const afterPromotion = (db.prepare('SELECT id FROM users WHERE is_active = 1').all() as Array<{ id: string }>)
      .filter(({ id }) => {
        const effective = resolveEffectivePermissions(id);
        return effective !== null && reachesAdministration(effective.permissionIds);
      });
    assert(afterPromotion.length === 0,
      'the role default still denies the two capabilities, which is why the editor entry point is what makes this a recovery');

    // Drive the editor as the promoted owner to restore the role defaults
    // and make the install administrable again.
    const cashierAuth = { 'x-test-user': 'cashier-1' };
    const roleRevision = (await request(app).get('/api/authorization/roles').set(cashierAuth))
      .body.roles.find((entry: any) => entry.role === 'owner').revision;
    const repair = await request(app).put('/api/authorization/roles/owner').set(cashierAuth).send({
      revision: roleRevision,
      overrides: [],
    });
    assert(repair.status === 200, `the promoted owner restores the role defaults through the editor (got ${repair.status})`);
    const afterRepair = (db.prepare('SELECT id FROM users WHERE is_active = 1').all() as Array<{ id: string }>)
      .filter(({ id }) => {
        const effective = resolveEffectivePermissions(id);
        return effective !== null && reachesAdministration(effective.permissionIds);
      });
    assert(afterRepair.length > 0, 'the install is administrable again once the promoted owner has driven the editor');
    const login = await request(app).post('/api/auth/login').send({
      email: 'cashier@example.com', password: 'RoleStrandPass123',
    });
    assert(login.status === 200, `the promoted owner can log in (got ${login.status})`);
  }

  // ── Test 9: rate limiting kicks in after repeated wrong-PIN attempts ─────
  console.log('\nTest 9: rate limiting kicks in after repeated wrong-PIN attempts');
  {
    // A successful Master PIN verification resets the failed-attempt counter.
    // Five consecutive wrong PINs therefore produce four 403 responses, then
    // a 429 on the fifth failure.
    let lastStatus = 0;
    for (let i = 0; i < 4; i++) {
      const res = await request(app).post('/api/auth/recover-password').send({
        email: 'owner@example.com', master_pin: '9999', new_password: 'AnotherNewPass123',
      });
      lastStatus = res.status;
      assert(res.status === 403, `attempt ${i + 1} with wrong PIN is rejected with 403 (got ${res.status})`);
    }
    const blocked = await request(app).post('/api/auth/recover-password').send({
      email: 'owner@example.com', master_pin: '9999', new_password: 'AnotherNewPass123',
    });
    assert(blocked.status === 429, `the 5th failed attempt in the window is rate-limited (got ${blocked.status})`);
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
