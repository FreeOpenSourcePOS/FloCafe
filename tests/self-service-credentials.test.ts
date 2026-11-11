/**
 * Comprehensive tests for self-service Password & PIN changes across all roles and surfaces
 * (:3001 Main API, :3002 Standalone KDS, :3003 Standalone Server App) plus configurable
 * Owner-default admin credential reset permission (`staff.credentials.reset`).
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.FLO_AUTH_RATE_LIMIT_MAX = '200';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-self-service-credentials-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

let bcryptHashInterceptor:
  | ((
      value: string,
      rounds: number | string,
      next: (value: string, rounds: number | string) => Promise<string>,
    ) => Promise<string>)
  | null = null;
{
  const loadedBcrypt = require('bcryptjs');
  const origHash = loadedBcrypt.hash.bind(loadedBcrypt);
  loadedBcrypt.hash = (value: string, rounds: number | string) =>
    bcryptHashInterceptor
      ? bcryptHashInterceptor(value, rounds, origHash)
      : origHash(value, rounds);
}

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb,
  createApp,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const {
  authRoutes,
  getJWTSecret,
  signFreshSessionToken,
  resetCredentialChangeRateLimitsForTests,
} = require('../main/routes/auth');
const { staffRoutes } = require('../main/routes/staff');
const { authorizationRoutes } = require('../main/routes/authorization');
const {
  clearRevokedTokens,
  clearUserAuthCache,
  clearLoginRateLimits,
} = require('../main/middleware/security');
const { PERMISSION_BY_ID } = require('../shared/permissions');
const { resolveEffectivePermissions, hasPermission } = require('../main/services/authorization');

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate free TCP port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((err) => (err ? reject(err) : resolve())),
  );
  return port;
}

function seedUser(
  db: any,
  opts: {
    id: string;
    name: string;
    email: string;
    password: string;
    role: 'owner' | 'manager' | 'cashier' | 'server' | 'chef';
    pin?: string | null;
  },
) {
  const ts = now();
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    opts.id,
    opts.name,
    opts.email.toLowerCase(),
    bcrypt.hashSync(opts.password, 10),
    opts.role,
    opts.pin ? bcrypt.hashSync(opts.pin, 10) : null,
    ts,
    ts,
  );
}

async function run() {
  console.log('Testing Self-Service Password & PIN Change + staff.credentials.reset');
  console.log('='.repeat(70));

  clearRevokedTokens();
  clearUserAuthCache();
  clearLoginRateLimits();
  resetCredentialChangeRateLimitsForTests();

  const db = initTestDb();
  const ts = now();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('kds_enabled', 'true', ?)",
  ).run(ts);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('server_app_enabled', 'true', ?)",
  ).run(ts);

  // ── 1. Permission definition & role defaults ───────────────────────────────
  console.log('\n1. Permission catalog & default role assignment for staff.credentials.reset');
  const permDef = PERMISSION_BY_ID.get('staff.credentials.reset');
  assertOrThrow(Boolean(permDef), 'staff.credentials.reset exists in PERMISSION_BY_ID');
  assertEqualOrThrow(permDef.area, 'staff', 'staff.credentials.reset area is staff');
  assertEqualOrThrow(
    permDef.defaultRoles.join(','),
    'owner',
    'staff.credentials.reset defaults to owner only',
  );
  assertEqualOrThrow(
    permDef.configurable,
    true,
    'staff.credentials.reset is configurable in Permission Matrix',
  );
  assertEqualOrThrow(
    permDef.risk,
    'sensitive',
    'staff.credentials.reset carries sensitive risk level',
  );

  const roles: Array<'owner' | 'manager' | 'cashier' | 'server' | 'chef'> = [
    'owner',
    'manager',
    'cashier',
    'server',
    'chef',
  ];
  for (const role of roles) {
    seedUser(db, {
      id: `self-${role}`,
      name: `Self ${role}`,
      email: `self-${role}@flo.local`,
      password: `InitPass-${role}-1!`,
      role,
      pin: null,
    });
    const effective = resolveEffectivePermissions(`self-${role}`);
    assertOrThrow(Boolean(effective), `resolveEffectivePermissions resolves for ${role}`);
    assertEqualOrThrow(
      hasPermission(`self-${role}`, 'staff.credentials.reset'),
      role === 'owner',
      `${role} default staff.credentials.reset is ${role === 'owner'}`,
    );
  }

  // Mount authorization under /api/permissions because test-setup createApp skips outer JWT decode
  // on /api/auth* prefixes except /api/auth/me (authRoutes performs its own full token checks).
  const app = createApp({
    '/api/auth': authRoutes,
    '/api/staff': staffRoutes,
    '/api/users': staffRoutes,
    '/api/permissions': authorizationRoutes,
  });

  // ── 2. Self-service password & PIN changes for ALL 5 roles on :3001 ────────
  console.log('\n2. Self-service password & PIN changes across all 5 roles on Main API (:3001)');
  for (let idx = 0; idx < roles.length; idx++) {
    const role = roles[idx];
    const userId = `self-${role}`;
    const email = `self-${role}@flo.local`;
    const initialPassword = `InitPass-${role}-1!`;
    const updatedPassword = `NextPass-${role}-2!`;
    const firstPin = String(1100 + idx);
    const secondPin = String(550011 + idx);

    clearLoginRateLimits();
    resetCredentialChangeRateLimitsForTests();

    const loginRes = await request(app).post('/api/auth/login').send({
      email,
      password: initialPassword,
    });
    assertEqualOrThrow(loginRes.status, 200, `${role}: initial password login succeeds`);
    assertEqualOrThrow(
      loginRes.body.user.has_pin,
      false,
      `${role}: login reports has_pin: false when PIN is unset`,
    );
    assertOrThrow(
      !('pin_hash' in loginRes.body.user) && !('password' in loginRes.body.user),
      `${role}: login response never exposes pin_hash or password`,
    );

    const token1 = loginRes.body.access_token as string;
    const meBefore = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token1}`);
    assertEqualOrThrow(meBefore.status, 200, `${role}: /api/auth/me succeeds`);
    assertEqualOrThrow(
      meBefore.body.user.has_pin,
      false,
      `${role}: /api/auth/me reports has_pin: false before PIN setup`,
    );
    assertOrThrow(
      !('pin_hash' in meBefore.body.user) && !('password' in meBefore.body.user),
      `${role}: /api/auth/me never exposes pin_hash or password`,
    );

    // Wrong current_password rejected on /api/auth/password/change
    const wrongPwRes = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${token1}`)
      .send({ current_password: 'WrongPassword1!', password: updatedPassword });
    assertEqualOrThrow(wrongPwRes.status, 400, `${role}: wrong current_password rejected with 400`);
    assertEqualOrThrow(
      wrongPwRes.body.attempts_remaining,
      4,
      `${role}: wrong current_password reports 4 attempts remaining`,
    );

    // Weak new password rejected
    const weakPwRes = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${token1}`)
      .send({ current_password: initialPassword, password: 'abc' });
    assertEqualOrThrow(weakPwRes.status, 400, `${role}: weak new password rejected with 400`);

    // Valid self-service password change issues fresh token and revokes prior session tokens
    const changePwRes = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${token1}`)
      .send({ current_password: initialPassword, password: updatedPassword });
    assertEqualOrThrow(changePwRes.status, 200, `${role}: self-service password change succeeds`);
    assertEqualOrThrow(
      changePwRes.body.message,
      'Password changed successfully',
      `${role}: password change preserves message contract`,
    );
    const token2 = changePwRes.body.token as string;
    assertOrThrow(
      typeof token2 === 'string' && token2.length > 0 && token2 !== token1,
      `${role}: password change returns a fresh JWT`,
    );

    const staleAfterPwChange = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token1}`);
    assertEqualOrThrow(
      staleAfterPwChange.status,
      401,
      `${role}: pre-password-change token is immediately rejected (401)`,
    );

    const freshAfterPwChange = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token2}`);
    assertEqualOrThrow(
      freshAfterPwChange.status,
      200,
      `${role}: fresh token from password change continues session seamlessly`,
    );

    // Old password rejected, new password accepted on login
    const oldLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email, password: initialPassword });
    assertEqualOrThrow(oldLoginRes.status, 401, `${role}: old password no longer logs in`);

    // First-time PIN setup (user.pin_hash is null) MUST verify current_password
    const missingPwFirstPin = await request(app)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${token2}`)
      .send({ pin: firstPin, current_pin: '0000' });
    assertEqualOrThrow(
      missingPwFirstPin.status,
      400,
      `${role}: first-time PIN setup rejects missing current_password`,
    );

    const wrongPwFirstPin = await request(app)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${token2}`)
      .send({ pin: firstPin, current_password: 'WrongPassword1!' });
    assertEqualOrThrow(
      wrongPwFirstPin.status,
      400,
      `${role}: first-time PIN setup rejects wrong current_password`,
    );
    assertEqualOrThrow(
      wrongPwFirstPin.body.attempts_remaining,
      4,
      `${role}: wrong current_password on first-time PIN setup decrements attempts_remaining`,
    );

    for (const invalidPin of ['123', '1234567', 'abcd', '12 34']) {
      const badFormatRes = await request(app)
        .post('/api/auth/pin/change')
        .set('Authorization', `Bearer ${token2}`)
        .send({ pin: invalidPin, current_password: updatedPassword });
      assertEqualOrThrow(
        badFormatRes.status,
        400,
        `${role}: invalid PIN format "${invalidPin}" rejected with 400`,
      );
    }

    const setFirstPinRes = await request(app)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${token2}`)
      .send({ pin: firstPin, current_password: updatedPassword });
    assertEqualOrThrow(setFirstPinRes.status, 200, `${role}: first-time PIN setup succeeds`);
    assertEqualOrThrow(
      setFirstPinRes.body.message,
      'PIN changed successfully',
      `${role}: first-time PIN setup message`,
    );
    assertEqualOrThrow(
      setFirstPinRes.body.has_pin,
      true,
      `${role}: first-time PIN setup reports has_pin: true`,
    );
    const token3 = setFirstPinRes.body.token as string;
    assertOrThrow(
      typeof token3 === 'string' && token3.length > 0 && token3 !== token2,
      `${role}: first-time PIN setup returns fresh JWT`,
    );

    const staleAfterFirstPin = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token2}`);
    assertEqualOrThrow(
      staleAfterFirstPin.status,
      401,
      `${role}: pre-PIN-setup token is immediately rejected (401)`,
    );

    const meAfterFirstPin = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token3}`);
    assertEqualOrThrow(meAfterFirstPin.status, 200, `${role}: fresh token after PIN setup works`);
    assertEqualOrThrow(
      meAfterFirstPin.body.user.has_pin,
      true,
      `${role}: /api/auth/me reports has_pin: true after PIN setup`,
    );

    // Subsequent PIN change (user.pin_hash is set) MUST verify current_pin (not current_password alone)
    const missingCurPinRes = await request(app)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${token3}`)
      .send({ pin: secondPin, current_password: updatedPassword });
    assertEqualOrThrow(
      missingCurPinRes.status,
      400,
      `${role}: changing existing PIN requires current_pin even if current_password is sent`,
    );

    const wrongCurPinRes = await request(app)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${token3}`)
      .send({ pin: secondPin, current_pin: '9999' });
    assertEqualOrThrow(wrongCurPinRes.status, 400, `${role}: wrong current_pin rejected with 400`);
    assertEqualOrThrow(
      wrongCurPinRes.body.attempts_remaining,
      4,
      `${role}: wrong current_pin reports 4 attempts remaining`,
    );

    const rotatePinRes = await request(app)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${token3}`)
      .send({ pin: secondPin, current_pin: firstPin });
    assertEqualOrThrow(rotatePinRes.status, 200, `${role}: rotating to 6-digit PIN succeeds`);
    const token4 = rotatePinRes.body.token as string;
    assertOrThrow(Boolean(token4) && token4 !== token3, `${role}: rotated PIN returns fresh JWT`);

    const staleAfterRotate = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token3}`);
    assertEqualOrThrow(
      staleAfterRotate.status,
      401,
      `${role}: token before PIN rotation is immediately rejected (401)`,
    );

    // Verify PIN sign-in rejects old PIN and accepts new 6-digit PIN
    const oldPinLogin = await request(app)
      .post('/api/auth/pin-login')
      .send({ user_id: userId, pin: firstPin });
    assertEqualOrThrow(oldPinLogin.status, 401, `${role}: old PIN rejected on pin-login`);

    const newPinLogin = await request(app)
      .post('/api/auth/pin-login')
      .send({ user_id: userId, pin: secondPin });
    assertEqualOrThrow(newPinLogin.status, 200, `${role}: new 6-digit PIN logs in via pin-login`);
    assertEqualOrThrow(
      newPinLogin.body.user.has_pin,
      true,
      `${role}: pin-login user includes has_pin: true`,
    );
  }

  // ── 3. Per-user failed-attempt rate limit / 5-attempt lockout on /pin/change ──
  console.log('\n3. Per-user 5-attempt lockout on POST /api/auth/pin/change');
  resetCredentialChangeRateLimitsForTests();
  clearLoginRateLimits();

  const cashierLogin = await request(app).post('/api/auth/login').send({
    email: 'self-cashier@flo.local',
    password: 'NextPass-cashier-2!',
  });
  const cashierToken = cashierLogin.body.access_token as string;
  const chefLogin = await request(app).post('/api/auth/login').send({
    email: 'self-chef@flo.local',
    password: 'NextPass-chef-2!',
  });
  const chefToken = chefLogin.body.access_token as string;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const badAttempt = await request(app)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ pin: '8888', current_pin: '0000' });
    assertEqualOrThrow(
      badAttempt.status,
      400,
      `Cashier wrong current_pin attempt ${attempt} returns 400`,
    );
    assertEqualOrThrow(
      badAttempt.body.attempts_remaining,
      5 - attempt,
      `Cashier wrong current_pin attempt ${attempt} reports ${5 - attempt} attempts remaining`,
    );
  }

  const lockedOutCashier = await request(app)
    .post('/api/auth/pin/change')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send({ pin: '8888', current_pin: '550013' }); // even with CORRECT current PIN!
  assertEqualOrThrow(
    lockedOutCashier.status,
    429,
    '6th PIN change attempt for locked-out cashier returns 429 even with correct current_pin',
  );

  // Another user on the same terminal is unaffected
  const unaffectedChef = await request(app)
    .post('/api/auth/pin/change')
    .set('Authorization', `Bearer ${chefToken}`)
    .send({ pin: '654321', current_pin: '550015' });
  assertEqualOrThrow(
    unaffectedChef.status,
    200,
    'Chef on same terminal is unaffected by cashier PIN-change lockout',
  );

  resetCredentialChangeRateLimitsForTests();

  // ── 4. Standalone KDS (:3002) & Standalone Server App (:3003) self-service ──
  console.log('\n4. Standalone KDS (:3002) and Server App (:3003) self-service Password & PIN');
  seedUser(db, {
    id: 'kds-chef-solo',
    name: 'KDS Solo Chef',
    email: 'kds-solo-chef@flo.local',
    password: 'KdsChefPass1!',
    role: 'chef',
    pin: null,
  });
  seedUser(db, {
    id: 'sa-waiter-solo',
    name: 'Mobile Waiter',
    email: 'sa-waiter@flo.local',
    password: 'WaiterPass1!',
    role: 'server',
    pin: null,
  });

  process.env.KDS_PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());
  const { startKdsServer, stopKdsServer, getKdsPort } = require('../main/kds-server');
  const { startServerApp, stopServerApp, getServerAppPort } = require('../main/server-app');

  await startKdsServer();
  await startServerApp();
  const kdsBaseUrl = `http://127.0.0.1:${getKdsPort()}`;
  const serverAppBaseUrl = `http://127.0.0.1:${getServerAppPort()}`;

  try {
    // Standalone KDS chef flow
    const kdsLogin = await request(kdsBaseUrl).post('/api/auth/login').send({
      email: 'kds-solo-chef@flo.local',
      password: 'KdsChefPass1!',
    });
    assertEqualOrThrow(kdsLogin.status, 200, 'Standalone KDS chef login succeeds');
    assertEqualOrThrow(
      kdsLogin.body.user.has_pin,
      false,
      'Standalone KDS login exposes has_pin: false',
    );
    assertOrThrow(!('pin_hash' in kdsLogin.body.user), 'Standalone KDS login omits pin_hash');

    const kdsToken1 = kdsLogin.body.access_token as string;
    const kdsMe1 = await request(kdsBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${kdsToken1}`);
    assertEqualOrThrow(kdsMe1.status, 200, 'Standalone KDS /api/auth/me succeeds');
    assertEqualOrThrow(
      kdsMe1.body.user.has_pin,
      false,
      'Standalone KDS /api/auth/me reports has_pin: false',
    );
    assertOrThrow(!('pin_hash' in kdsMe1.body.user), 'Standalone KDS /api/auth/me omits pin_hash');

    // Chef changes own password from standalone KDS
    const kdsPwChange = await request(kdsBaseUrl)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${kdsToken1}`)
      .send({ current_password: 'KdsChefPass1!', password: 'KdsChefPass2!' });
    assertEqualOrThrow(
      kdsPwChange.status,
      200,
      'Chef changes own password via standalone KDS /api/auth/password/change',
    );
    const kdsToken2 = kdsPwChange.body.token as string;
    assertOrThrow(
      Boolean(kdsToken2) && kdsToken2 !== kdsToken1,
      'KDS password change returns fresh token',
    );

    const kdsStaleMe = await request(kdsBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${kdsToken1}`);
    assertEqualOrThrow(kdsStaleMe.status, 401, 'Old KDS token is revoked after password change');

    const kdsOrdersWithFresh = await request(kdsBaseUrl)
      .get('/api/kds/orders')
      .set('Authorization', `Bearer ${kdsToken2}`);
    assertEqualOrThrow(
      kdsOrdersWithFresh.status,
      200,
      'Fresh KDS token continues KDS orders access without re-login',
    );

    // Chef sets first-time PIN from standalone KDS using current_password
    const kdsSetPin = await request(kdsBaseUrl)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${kdsToken2}`)
      .send({ pin: '4321', current_password: 'KdsChefPass2!' });
    assertEqualOrThrow(kdsSetPin.status, 200, 'Chef sets first-time PIN on standalone KDS');
    assertEqualOrThrow(kdsSetPin.body.has_pin, true, 'KDS pin/change returns has_pin: true');
    const kdsToken3 = kdsSetPin.body.token as string;

    // Chef rotates PIN from standalone KDS using current_pin
    const kdsRotatePin = await request(kdsBaseUrl)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${kdsToken3}`)
      .send({ pin: '987654', current_pin: '4321' });
    assertEqualOrThrow(kdsRotatePin.status, 200, 'Chef rotates PIN on standalone KDS');
    const kdsToken4 = kdsRotatePin.body.token as string;

    const kdsStale3 = await request(kdsBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${kdsToken3}`);
    assertEqualOrThrow(kdsStale3.status, 401, 'Pre-rotation KDS token is rejected');

    const kdsMe4 = await request(kdsBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${kdsToken4}`);
    assertEqualOrThrow(kdsMe4.status, 200, 'Post-rotation KDS token is accepted');
    assertEqualOrThrow(kdsMe4.body.user.has_pin, true, 'KDS /api/auth/me reports has_pin: true');

    const kdsPinSignIn = await request(kdsBaseUrl)
      .post('/api/auth/pin-login')
      .send({ user_id: 'kds-chef-solo', pin: '987654' });
    assertEqualOrThrow(kdsPinSignIn.status, 200, 'Chef can sign in on KDS with newly rotated PIN');

    // Standalone Server App waiter flow
    const saLogin = await request(serverAppBaseUrl).post('/api/auth/login').send({
      email: 'sa-waiter@flo.local',
      password: 'WaiterPass1!',
    });
    assertEqualOrThrow(saLogin.status, 200, 'Standalone Server App waiter login succeeds');
    assertEqualOrThrow(saLogin.body.user.has_pin, false, 'Server App login exposes has_pin: false');
    assertOrThrow(!('pin_hash' in saLogin.body.user), 'Server App login omits pin_hash');

    const saToken1 = saLogin.body.access_token as string;
    const saPwChange = await request(serverAppBaseUrl)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${saToken1}`)
      .send({ current_password: 'WaiterPass1!', password: 'WaiterPass2!' });
    assertEqualOrThrow(saPwChange.status, 200, 'Waiter changes own password on Server App');
    const saToken2 = saPwChange.body.token as string;

    const saStale1 = await request(serverAppBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${saToken1}`);
    assertEqualOrThrow(
      saStale1.status,
      401,
      'Old Server App token is rejected after password change',
    );

    const saSetPin = await request(serverAppBaseUrl)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${saToken2}`)
      .send({ pin: '2580', current_password: 'WaiterPass2!' });
    assertEqualOrThrow(saSetPin.status, 200, 'Waiter sets first-time PIN on Server App');
    const saToken3 = saSetPin.body.token as string;

    const saRotatePin = await request(serverAppBaseUrl)
      .post('/api/auth/pin/change')
      .set('Authorization', `Bearer ${saToken3}`)
      .send({ pin: '369258', current_pin: '2580' });
    assertEqualOrThrow(saRotatePin.status, 200, 'Waiter rotates PIN on Server App');
    const saToken4 = saRotatePin.body.token as string;

    const saMe4 = await request(serverAppBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${saToken4}`);
    assertEqualOrThrow(saMe4.status, 200, 'Fresh Server App token stays authenticated');
    assertEqualOrThrow(
      saMe4.body.user.has_pin,
      true,
      'Server App /api/auth/me reports has_pin: true',
    );

    const saPinSignIn = await request(serverAppBaseUrl)
      .post('/api/auth/pin-login')
      .send({ user_id: 'sa-waiter-solo', pin: '369258' });
    assertEqualOrThrow(saPinSignIn.status, 200, 'Waiter signs in on Server App with rotated PIN');
  } finally {
    await stopServerApp();
    await stopKdsServer();
  }

  // ── 5. Admin credential reset (PUT /api/staff/:id) & permission matrix ──────
  console.log('\n5. Owner default vs Manager configurable staff.credentials.reset');
  seedUser(db, {
    id: 'admin-owner-1',
    name: 'Primary Owner',
    email: 'admin-owner-1@flo.local',
    password: 'OwnerAdmin1!',
    role: 'owner',
    pin: '1111',
  });
  seedUser(db, {
    id: 'admin-owner-2',
    name: 'Second Owner',
    email: 'admin-owner-2@flo.local',
    password: 'OwnerAdmin2!',
    role: 'owner',
    pin: '2222',
  });
  seedUser(db, {
    id: 'admin-mgr-a',
    name: 'Manager Alpha',
    email: 'admin-mgr-a@flo.local',
    password: 'MgrAlpha1!',
    role: 'manager',
    pin: '3333',
  });
  seedUser(db, {
    id: 'admin-mgr-b',
    name: 'Manager Beta',
    email: 'admin-mgr-b@flo.local',
    password: 'MgrBeta1!',
    role: 'manager',
    pin: '4444',
  });

  const loginFor = async (email: string, password: string): Promise<string> => {
    clearLoginRateLimits();
    const res = await request(app).post('/api/auth/login').send({ email, password });
    assertEqualOrThrow(res.status, 200, `Login succeeds for ${email}`);
    return res.body.access_token as string;
  };

  let ownerToken = await loginFor('admin-owner-1@flo.local', 'OwnerAdmin1!');
  const mgrAToken = await loginFor('admin-mgr-a@flo.local', 'MgrAlpha1!');
  const mgrBToken = await loginFor('admin-mgr-b@flo.local', 'MgrBeta1!');

  // 5a. Owner can reset password and PIN (and clear PIN) on ANY role without current credentials
  for (const target of [
    { id: 'admin-owner-2', label: 'another owner' },
    { id: 'admin-mgr-b', label: 'a manager' },
    { id: 'self-cashier', label: 'a cashier' },
    { id: 'self-server', label: 'a waiter (server)' },
    { id: 'self-chef', label: 'a chef' },
  ]) {
    const resetRes = await request(app)
      .put(`/api/staff/${target.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ password: 'OwnerResetPass9!', pin: '7654' });
    assertEqualOrThrow(
      resetRes.status,
      200,
      `Owner resets password and PIN on ${target.label} without current credentials`,
    );
    assertEqualOrThrow(resetRes.body.staff.has_pin, 1, `Reset ${target.label} reports has_pin = 1`);
  }

  // Owner clearing PIN (pin: null) clears pin_hash so target can set first-time PIN with password
  const clearCashierPin = await request(app)
    .put('/api/staff/self-cashier')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ pin: null });
  assertEqualOrThrow(clearCashierPin.status, 200, 'Owner clears cashier PIN via pin: null');
  assertEqualOrThrow(clearCashierPin.body.staff.has_pin, 0, 'Cleared cashier reports has_pin = 0');

  // When Owner resets their OWN credentials via PUT /api/staff/:id, fresh token keeps them logged in
  const ownerSelfAdminReset = await request(app)
    .put('/api/staff/admin-owner-1')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ pin: '1919' });
  assertEqualOrThrow(ownerSelfAdminReset.status, 200, 'Owner updates own PIN via /api/staff/:id');
  assertOrThrow(
    typeof ownerSelfAdminReset.body.token === 'string' &&
      ownerSelfAdminReset.body.token !== ownerToken,
    'Owner self-update via /api/staff/:id returns fresh session token',
  );
  const staleOwnerMe = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${ownerToken}`);
  assertEqualOrThrow(staleOwnerMe.status, 401, 'Old owner token is stale after self admin reset');
  ownerToken = ownerSelfAdminReset.body.token as string;
  const freshOwnerMe = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${ownerToken}`);
  assertEqualOrThrow(freshOwnerMe.status, 200, 'Fresh owner token after self admin reset works');

  // 5b. By default, Manager WITHOUT staff.credentials.reset gets 403 on password/PIN overrides,
  //     while non-credential updates AND new staff creation still succeed!
  for (const opTarget of ['self-cashier', 'self-server', 'self-chef']) {
    const mgrPwDenied = await request(app)
      .put(`/api/staff/${opTarget}`)
      .set('Authorization', `Bearer ${mgrAToken}`)
      .send({ password: 'MgrIllegalReset1!' });
    assertEqualOrThrow(
      mgrPwDenied.status,
      403,
      `Manager without staff.credentials.reset gets 403 resetting password on ${opTarget}`,
    );
    assertEqualOrThrow(
      mgrPwDenied.body.permission,
      'staff.credentials.reset',
      `Denied password reset on ${opTarget} identifies staff.credentials.reset`,
    );

    const mgrPinDenied = await request(app)
      .put(`/api/users/${opTarget}`)
      .set('Authorization', `Bearer ${mgrAToken}`)
      .send({ pin: '1212' });
    assertEqualOrThrow(
      mgrPinDenied.status,
      403,
      `Manager without staff.credentials.reset gets 403 setting PIN on ${opTarget} via /api/users`,
    );

    const mgrClearPinDenied = await request(app)
      .put(`/api/staff/${opTarget}`)
      .set('Authorization', `Bearer ${mgrAToken}`)
      .send({ pin: null });
    assertEqualOrThrow(
      mgrClearPinDenied.status,
      403,
      `Manager without staff.credentials.reset gets 403 clearing PIN on ${opTarget}`,
    );

    const mgrNonCredOk = await request(app)
      .put(`/api/staff/${opTarget}`)
      .set('Authorization', `Bearer ${mgrAToken}`)
      .send({ name: `Renamed ${opTarget}`, password: '' });
    assertEqualOrThrow(
      mgrNonCredOk.status,
      200,
      `Manager without staff.credentials.reset can still edit non-credential fields on ${opTarget}`,
    );
  }

  // Manager can still create brand-new operational staff with initial password & PIN
  const mgrCreateRes = await request(app)
    .post('/api/staff')
    .set('Authorization', `Bearer ${mgrAToken}`)
    .send({
      name: 'Brand New Waiter',
      email: 'brand-new-waiter@flo.local',
      password: 'BrandNewPass1!',
      role: 'server',
      pin: '4567',
    });
  assertEqualOrThrow(
    mgrCreateRes.status,
    201,
    'Manager without staff.credentials.reset can still create new operational staff with initial password and PIN',
  );

  // 5c. Owner grants staff.credentials.reset to the `manager` role -> Managers can now reset
  //     operational staff (`cashier`, `server`, `chef`) passwords/PINs, while `owner`/`manager`
  //     targets remain strictly 403!
  const rolesRead1 = await request(app)
    .get('/api/permissions/roles')
    .set('Authorization', `Bearer ${ownerToken}`);
  assertEqualOrThrow(rolesRead1.status, 200, 'Owner reads role permission matrix');
  const managerRoleRev1 = rolesRead1.body.roles.find((r: any) => r.role === 'manager')?.revision;

  const grantRoleRes = await request(app)
    .put('/api/permissions/roles/manager')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      revision: managerRoleRev1,
      overrides: [{ permission_id: 'staff.credentials.reset', effect: 'allow' }],
    });
  assertEqualOrThrow(
    grantRoleRes.status,
    200,
    'Owner grants staff.credentials.reset to manager role',
  );

  const preResetServerToken = await loginFor('self-server@flo.local', 'OwnerResetPass9!');

  for (const opTarget of ['self-cashier', 'self-server', 'self-chef']) {
    const mgrResetBoth = await request(app)
      .put(`/api/staff/${opTarget}`)
      .set('Authorization', `Bearer ${mgrAToken}`)
      .send({ password: `MgrGranted-${opTarget}-1!`, pin: '6789' });
    assertEqualOrThrow(
      mgrResetBoth.status,
      200,
      `Manager WITH role-granted staff.credentials.reset resets password & PIN on ${opTarget}`,
    );
  }

  // Verify target's pre-reset token was invalidated and new credentials work
  const staleServerAfterMgrReset = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${preResetServerToken}`);
  assertEqualOrThrow(
    staleServerAfterMgrReset.status,
    401,
    'Operational staff pre-reset token is revoked after authorized manager reset',
  );
  const serverLoginAfterMgrReset = await loginFor(
    'self-server@flo.local',
    'MgrGranted-self-server-1!',
  );
  assertOrThrow(
    Boolean(serverLoginAfterMgrReset),
    'Operational staff logs in with manager-reset password',
  );

  // Even WITH staff.credentials.reset, Manager can NEVER reset Owner or Manager accounts!
  for (const privilegedTarget of ['admin-owner-1', 'admin-owner-2', 'admin-mgr-b', 'admin-mgr-a']) {
    const mgrPrivAttempt = await request(app)
      .put(`/api/staff/${privilegedTarget}`)
      .set('Authorization', `Bearer ${mgrAToken}`)
      .send({ password: 'CompromisedPriv1!', pin: '0000' });
    assertEqualOrThrow(
      mgrPrivAttempt.status,
      403,
      `Manager WITH staff.credentials.reset still gets 403 targeting privileged account ${privilegedTarget}`,
    );
  }

  // 5d. Remove role grant and grant staff.credentials.reset ONLY to Manager Alpha (user override):
  //     Manager Alpha succeeds on operational staff resets while Manager Beta gets 403!
  const rolesRead2 = await request(app)
    .get('/api/permissions/roles')
    .set('Authorization', `Bearer ${ownerToken}`);
  const managerRoleRev2 = rolesRead2.body.roles.find((r: any) => r.role === 'manager')?.revision;
  const clearRoleRes = await request(app)
    .put('/api/permissions/roles/manager')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      revision: managerRoleRev2,
      overrides: [],
    });
  assertEqualOrThrow(clearRoleRes.status, 200, 'Owner clears manager role overrides');

  const mgrAUserPerms = await request(app)
    .get('/api/permissions/users/admin-mgr-a')
    .set('Authorization', `Bearer ${ownerToken}`);
  const grantMgrAOnly = await request(app)
    .put('/api/permissions/users/admin-mgr-a')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      revision: mgrAUserPerms.body.revision,
      overrides: [{ permission_id: 'staff.credentials.reset', effect: 'allow' }],
    });
  assertEqualOrThrow(
    grantMgrAOnly.status,
    200,
    'Owner grants staff.credentials.reset user override to Manager Alpha only',
  );

  const mgrAUserReset = await request(app)
    .put('/api/staff/self-cashier')
    .set('Authorization', `Bearer ${mgrAToken}`)
    .send({ pin: null });
  assertEqualOrThrow(
    mgrAUserReset.status,
    200,
    'Manager Alpha with individual user override clears cashier PIN',
  );

  const mgrBUserDenied = await request(app)
    .put('/api/staff/self-cashier')
    .set('Authorization', `Bearer ${mgrBToken}`)
    .send({ pin: '3131' });
  assertEqualOrThrow(
    mgrBUserDenied.status,
    403,
    'Manager Beta without override receives 403 on cashier PIN reset',
  );

  console.log('\n6. Token rotation expiration preservation and concurrency checks');
  // 6a: Test signFreshSessionToken preserving 10-day vs 24-hour expiration
  const testUser = { id: 'test-user', email: 'test@flo.local', role: 'server' };
  const standardTokenPayload = {
    userId: testUser.id,
    email: testUser.email,
    role: testUser.role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400,
  };
  const standardRotated = signFreshSessionToken(testUser, standardTokenPayload);
  const standardDecoded = jwt.verify(standardRotated, getJWTSecret()) as any;
  assertOrThrow(
    standardDecoded.exp - standardDecoded.iat <= 86400,
    'Rotated standard token has 24h expiration',
  );

  const rememberedTokenPayload = {
    userId: testUser.id,
    email: testUser.email,
    role: testUser.role,
    remember: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 10 * 86400,
  };
  const rememberedRotated = signFreshSessionToken(testUser, rememberedTokenPayload);
  const rememberedDecoded = jwt.verify(rememberedRotated, getJWTSecret()) as any;
  assertOrThrow(
    rememberedDecoded.exp - rememberedDecoded.iat >= 10 * 86400 - 10,
    'Rotated token with remember: true preserves 10-day expiration',
  );

  // Decoded token from KDS or Server App without explicit remember property but with 10-day exp
  const kdsOrServerLongLivedPayload = {
    userId: testUser.id,
    email: testUser.email,
    role: testUser.role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 10 * 86400,
  };
  const kdsRotated = signFreshSessionToken(testUser, kdsOrServerLongLivedPayload);
  const kdsDecoded = jwt.verify(kdsRotated, getJWTSecret()) as any;
  assertOrThrow(
    kdsDecoded.exp - kdsDecoded.iat >= 10 * 86400 - 10,
    'Rotated KDS/Server App 10-day token without explicit remember flag preserves 10-day expiration',
  );

  // 6b: Concurrency check: in-flight password / PIN change fails if staff reset modified credentials
  clearLoginRateLimits();
  clearRevokedTokens();
  // Login as self-cashier with current credentials
  const concurrentCashierToken = await loginFor(
    'self-cashier@flo.local',
    'MgrGranted-self-cashier-1!',
  );
  assertOrThrow(Boolean(concurrentCashierToken), 'Self-cashier logs in for concurrency test');

  // Admin resets self-cashier password concurrently
  const adminResetRes = await request(app)
    .put('/api/staff/self-cashier')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ password: 'AdminReset123!' });
  assertEqualOrThrow(adminResetRes.status, 200, 'Owner resets self-cashier password');

  // Attempt self-service password change using the pre-reset session token
  const stalePasswordChangeRes = await request(app)
    .post('/api/auth/password/change')
    .set('Authorization', `Bearer ${concurrentCashierToken}`)
    .send({
      current_password: 'MgrGranted-self-cashier-1!',
      password: 'ShouldFail123!',
    });
  assertEqualOrThrow(
    stalePasswordChangeRes.status,
    401,
    'In-flight password change with stale token rejected with 401',
  );

  // Attempt self-service PIN change using the pre-reset session token
  const stalePinChangeRes = await request(app)
    .post('/api/auth/pin/change')
    .set('Authorization', `Bearer ${concurrentCashierToken}`)
    .send({
      current_password: 'AdminReset123!',
      pin: '9876',
    });
  assertEqualOrThrow(
    stalePinChangeRes.status,
    401,
    'In-flight PIN change with stale token rejected with 401',
  );

  // 6c: Concurrency check (#1540): logout during async bcrypt.hash stops password/PIN change at commit boundary
  console.log('\n6c. Revoking initiating session during bcrypt.hash aborts commit (#1540)');
  clearLoginRateLimits();
  clearRevokedTokens();
  resetCredentialChangeRateLimitsForTests();
  seedUser(db, {
    id: 'self-race-cashier',
    name: 'Race Cashier',
    email: 'self-race-cashier@flo.local',
    password: 'RacePass-1!',
    role: 'cashier',
    pin: '4321',
  });

  const runPausedHashRace = async (
    triggerChange: () => Promise<any>,
    logoutToken: string,
  ): Promise<any> => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseHash!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    bcryptHashInterceptor = async (value, rounds, next) => {
      signalEntered();
      await gate;
      return next(value, rounds);
    };
    try {
      const responsePromise = triggerChange();
      await Promise.race([
        entered,
        responsePromise.then((earlyRes: any) => {
          throw new Error(
            `Request returned status ${earlyRes?.status} before entering bcrypt.hash`,
          );
        }),
      ]);
      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${logoutToken}`);
      assertEqualOrThrow(
        logoutRes.status,
        200,
        'Concurrent /api/auth/logout revokes initiating session during hash',
      );
      releaseHash();
      return await responsePromise;
    } finally {
      releaseHash();
      bcryptHashInterceptor = null;
    }
  };

  const racePwToken = await loginFor('self-race-cashier@flo.local', 'RacePass-1!');
  assertOrThrow(Boolean(racePwToken), 'Race cashier logs in for password-change logout race');
  const pwLogoutRaceRes = await runPausedHashRace(
    () =>
      request(app)
        .post('/api/auth/password/change')
        .set('Authorization', `Bearer ${racePwToken}`)
        .send({
          current_password: 'RacePass-1!',
          password: 'BlockedNewPass-2!',
        })
        .then((res: any) => res),
    racePwToken,
  );
  assertEqualOrThrow(
    pwLogoutRaceRes.status,
    401,
    'Password change returns 401 when initiating session is logged out during hashing',
  );
  assertOrThrow(
    !pwLogoutRaceRes.body.token,
    'Aborted password change does not return a replacement token',
  );
  const blockedPwLoginRes = await request(app).post('/api/auth/login').send({
    email: 'self-race-cashier@flo.local',
    password: 'BlockedNewPass-2!',
  });
  assertEqualOrThrow(
    blockedPwLoginRes.status,
    401,
    'Aborted password change did not persist new password',
  );

  const racePinToken = await loginFor('self-race-cashier@flo.local', 'RacePass-1!');
  assertOrThrow(
    Boolean(racePinToken),
    'Original password still works after aborted password change',
  );
  const pinLogoutRaceRes = await runPausedHashRace(
    () =>
      request(app)
        .post('/api/auth/pin/change')
        .set('Authorization', `Bearer ${racePinToken}`)
        .send({
          current_pin: '4321',
          pin: '9876',
        })
        .then((res: any) => res),
    racePinToken,
  );
  assertEqualOrThrow(
    pinLogoutRaceRes.status,
    401,
    'PIN change returns 401 when initiating session is logged out during hashing',
  );
  assertOrThrow(
    !pinLogoutRaceRes.body.token,
    'Aborted PIN change does not return a replacement token',
  );
  const blockedPinLoginRes = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: 'self-race-cashier', pin: '9876' });
  assertEqualOrThrow(blockedPinLoginRes.status, 401, 'Aborted PIN change did not persist new PIN');
  const originalPinLoginRes = await request(app)
    .post('/api/auth/pin-login')
    .send({ user_id: 'self-race-cashier', pin: '4321' });
  assertEqualOrThrow(
    originalPinLoginRes.status,
    200,
    'Original PIN still valid after aborted PIN change',
  );

  console.log('\n✅ All Self-Service Password & PIN + staff.credentials.reset tests passed!');
}

run()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    try {
      closeDatabase();
    } catch {}
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error('Self-service credentials test failed:', error);
    process.exit(1);
  });
