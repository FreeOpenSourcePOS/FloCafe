/**
 * Test suite for Area E: JWT logout & token lifecycle
 * Verifies immediate token revocation on logout, token reuse rejection, expiry validation, and refresh behavior.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.FLO_AUTH_RATE_LIMIT_MAX = '100';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-jwt-test-'));

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

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb,
  createApp,
  assertEqual,
  assert,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { authRoutes, getJWTSecret } = require('../main/routes/auth');
const {
  getDatabase,
  initDatabase,
  nextTokenIatSeconds,
  nextTokensValidAfterTimestamp,
} = require('../main/db');
const { staffRoutes } = require('../main/routes/staff');
const {
  clearRevokedTokens,
  revokeToken,
  isTokenRevoked,
  isTokenStale,
  clearUserAuthCache,
  clearLoginRateLimits,
} = require('../main/middleware/security');
const { startKdsServer, stopKdsServer, getKdsPort } = require('../main/kds-server');
const { startServerApp, stopServerApp, getServerAppPort } = require('../main/server-app');

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
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function run() {
  console.log('Testing JWT Logout & Token Lifecycle (Area E)...');
  console.log('='.repeat(60));

  clearRevokedTokens();
  const db = initTestDb();

  // Seed owner user
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('jwt-owner-1', 'JWT Owner', 'jwt-owner@test.local', ?, 'owner', 1, ?, ?)
  `).run(bcrypt.hashSync('Pass1234!', 10), now(), now());

  const app = createApp({
    '/api/auth': authRoutes,
    '/api/staff': staffRoutes,
  });

  // Step 1: Login to get token
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
  assertEqual(loginRes.status, 200, 'Login succeeds');
  const token = loginRes.body.access_token;
  assert(!!token, 'Access token returned');

  // Step 2: Use token for authed endpoint (/api/auth/me) -> 200
  const meRes1 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assertEqual(meRes1.status, 200, '/api/auth/me succeeds with valid token');

  // Step 3: Refresh token with valid token -> 200
  const refreshRes1 = await request(app)
    .post('/api/auth/refresh')
    .set('Authorization', `Bearer ${token}`);
  assertEqual(refreshRes1.status, 200, '/api/auth/refresh succeeds with valid token');
  const newToken = refreshRes1.body.access_token;
  assert(!!newToken, 'New token returned on refresh');

  // Step 4: Logout using original token -> 200
  const logoutRes = await request(app)
    .post('/api/auth/logout')
    .set('Authorization', `Bearer ${token}`);
  assertEqual(logoutRes.status, 200, 'Logout succeeds');

  // Step 5: Attempt token reuse after logout -> 401
  const meRes2 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assertEqual(meRes2.status, 401, 'Token reuse after logout fails with 401');

  // Step 6: Refresh using revoked token -> 401
  const refreshRes2 = await request(app)
    .post('/api/auth/refresh')
    .set('Authorization', `Bearer ${token}`);
  assertEqual(refreshRes2.status, 401, 'Refresh with revoked token fails with 401');

  // Revoked sessions must not perform authenticated password changes.
  const passwordChangeRes = await request(app)
    .post('/api/auth/password/change')
    .set('Authorization', `Bearer ${token}`)
    .send({ current_password: 'Pass1234!', password: 'NewPass1234!' });
  assertEqual(passwordChangeRes.status, 401, 'Password change with revoked token fails with 401');

  // Logout revocation must survive a database/process lifecycle restart.
  closeDatabase();
  initDatabase();
  const afterRestart = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${token}`);
  assertEqual(afterRestart.status, 401, 'logged-out token remains rejected after database restart');

  // A bounded in-memory cache must not evict durable revocations.
  for (let i = 0; i < 5001; i++) {
    const churnToken = jwt.sign(
      { userId: 'jwt-owner-1', email: 'jwt-owner@test.local', role: 'owner', jti: `churn-${i}` },
      getJWTSecret(),
      { expiresIn: '1h' },
    );
    revokeToken(churnToken);
  }
  assertEqual(isTokenRevoked(token), true, 'original logout remains revoked after token churn');

  // Step 7: Test expired token -> 401
  const expiredToken = jwt.sign(
    { userId: 'jwt-owner-1', email: 'jwt-owner@test.local', role: 'owner' },
    getJWTSecret(),
    { expiresIn: '-1s' },
  );
  const meRes3 = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${expiredToken}`);
  assertEqual(meRes3.status, 401, 'Expired token fails with 401');

  // Step 8: New token from refresh is still valid
  const meRes4 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${newToken}`);
  if (meRes4.status !== 200) {
    console.log('meRes4 status:', meRes4.status, 'body:', meRes4.body);
  }
  assertEqual(meRes4.status, 200, 'Refreshed token remains valid');

  // Step 9: Refresh re-reads current user role from DB and preserves stale/inactive checks
  const freshDb = getDatabase();
  freshDb
    .prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('jwt-manager-1', 'JWT Manager', 'jwt-manager@test.local', ?, 'manager', 1, ?, ?)
  `)
    .run(bcrypt.hashSync('Pass1234!', 10), now(), now());

  const managerLoginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'jwt-manager@test.local', password: 'Pass1234!' });
  assertEqual(managerLoginRes.status, 200, 'Manager login succeeds');
  const managerToken = managerLoginRes.body.access_token;
  assertEqual(
    jwt.verify(managerToken, getJWTSecret()).role,
    'manager',
    'Initial token carries manager role',
  );

  freshDb.prepare(`UPDATE users SET role = 'server' WHERE id = 'jwt-manager-1'`).run();

  const roleRefreshRes = await request(app)
    .post('/api/auth/refresh')
    .set('Authorization', `Bearer ${managerToken}`);
  assertEqual(roleRefreshRes.status, 200, 'Refresh after role change succeeds');
  const refreshedRoleClaims = jwt.verify(roleRefreshRes.body.access_token, getJWTSecret());
  assertEqual(
    refreshedRoleClaims.role,
    'server',
    'Refreshed token carries updated role from database',
  );

  freshDb
    .prepare(`UPDATE users SET tokens_valid_after = ? WHERE id = 'jwt-manager-1'`)
    .run(new Date(Date.now() + 60_000).toISOString());
  const staleRefreshRes = await request(app)
    .post('/api/auth/refresh')
    .set('Authorization', `Bearer ${managerToken}`);
  assertEqual(staleRefreshRes.status, 401, 'Refresh rejects token stale via tokens_valid_after');

  freshDb
    .prepare(`UPDATE users SET tokens_valid_after = NULL, is_active = 0 WHERE id = 'jwt-manager-1'`)
    .run();
  const inactiveRefreshRes = await request(app)
    .post('/api/auth/refresh')
    .set('Authorization', `Bearer ${managerToken}`);
  assertEqual(inactiveRefreshRes.status, 401, 'Refresh rejects token for inactive user');

  // Step 10: Deterministic token invalidation across same-second, same-millisecond, legacy integer iat, and all 7 issuers
  console.log(
    '\nStep 10: Deterministic token invalidation (same-second, same-ms, legacy iat, all 7 issuers)',
  );
  freshDb
    .prepare(
      `UPDATE users SET role = 'owner', is_active = 1, pin_hash = ?, tokens_valid_after = NULL WHERE id = 'jwt-owner-1'`,
    )
    .run(bcrypt.hashSync('2468', 10));
  clearUserAuthCache();
  clearLoginRateLimits();

  // 10a: Legacy integer-second iat token minted in the same UTC second as tokens_valid_after
  const fixedSecondEpochMs = 1_760_000_000_500; // 2025-10-09T08:53:20.500Z
  const legacyIntegerIat = Math.floor(fixedSecondEpochMs / 1000); // 1760000000
  const sameSecondValidAfter = new Date(fixedSecondEpochMs)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '');
  assertEqual(
    isTokenStale(legacyIntegerIat, sameSecondValidAfter),
    true,
    'Legacy integer-second iat token minted in the same UTC second as tokens_valid_after is stale',
  );
  assertEqual(
    isTokenStale(legacyIntegerIat + 1, sameSecondValidAfter),
    false,
    'Legacy integer-second iat token minted in a later UTC second than tokens_valid_after is valid',
  );

  // 10b: Pre-change token vs. credential change vs. fresh post-change login when Date.now() is frozen to the exact same millisecond (including .000 boundary)
  const realDateNow = Date.now;
  try {
    for (const frozenMs of [1_760_000_010_000, 1_760_000_020_500, 1_760_000_030_999]) {
      Date.now = () => frozenMs;
      const iatBefore = nextTokenIatSeconds();
      const validAfterTs = nextTokensValidAfterTimestamp();
      const iatAfter = nextTokenIatSeconds();

      assert(
        !Number.isInteger(iatBefore) && !Number.isInteger(iatAfter),
        `Issued iat claims at frozen ms ${frozenMs} carry sub-second precision`,
      );
      assertEqual(
        isTokenStale(iatBefore, validAfterTs),
        true,
        `Pre-change token is stale when minted in the same frozen millisecond (${frozenMs}) as tokens_valid_after`,
      );
      assertEqual(
        isTokenStale(iatAfter, validAfterTs),
        false,
        `Post-change token is valid when minted in the same frozen millisecond (${frozenMs}) after tokens_valid_after`,
      );
    }

    // Full route integration with Date.now() frozen to a single millisecond:
    // login -> password change -> pre-change token rejected -> post-change login accepted
    const frozenRouteMs = realDateNow.call(Date);
    Date.now = () => frozenRouteMs;

    const preChangeLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(preChangeLogin.status, 200, 'Pre-change login at frozen ms succeeds');
    const preChangeToken = preChangeLogin.body.access_token;

    const pwChangeRes = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${preChangeToken}`)
      .send({ current_password: 'Pass1234!', password: 'Pass5678!' });
    assertEqual(pwChangeRes.status, 200, 'Password change in same frozen ms succeeds');

    const preChangeMeAfterPwChange = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${preChangeToken}`);
    assertEqual(
      preChangeMeAfterPwChange.status,
      401,
      'Pre-change token is rejected immediately in the same frozen millisecond after password change',
    );

    const postChangeLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass5678!' });
    assertEqual(postChangeLogin.status, 200, 'Post-change login in same frozen ms succeeds');
    const postChangeToken = postChangeLogin.body.access_token;

    const postChangeMe = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${postChangeToken}`);
    assertEqual(
      postChangeMe.status,
      200,
      'Fresh post-change login token in the same frozen millisecond is accepted by /api/auth/me',
    );

    // Restore original password while still verifying PIN change invalidation in the same frozen ms
    const restorePwRes = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${postChangeToken}`)
      .send({ current_password: 'Pass5678!', password: 'Pass1234!' });
    assertEqual(restorePwRes.status, 200, 'Password restore in same frozen ms succeeds');
  } finally {
    Date.now = realDateNow;
  }

  // 10c: Verify all 7 issuers stamp sub-second iat and respect same-millisecond invalidation vs post-change login
  clearLoginRateLimits();
  process.env.KDS_PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());
  await startKdsServer();
  await startServerApp();
  const kdsBaseUrl = `http://127.0.0.1:${getKdsPort()}`;
  const serverAppBaseUrl = `http://127.0.0.1:${getServerAppPort()}`;

  try {
    const frozenAllIssuersMs = realDateNow.call(Date);
    Date.now = () => frozenAllIssuersMs;

    // Issuers 1-4 on :3001 (login, pin-login, tenants/select, refresh)
    const login1 = await request(app)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(login1.status, 200, 'Issuer 1 (/api/auth/login) succeeds');
    const pinLogin1 = await request(app)
      .post('/api/auth/pin-login')
      .send({ user_id: 'jwt-owner-1', pin: '2468' });
    assertEqual(pinLogin1.status, 200, 'Issuer 2 (/api/auth/pin-login) succeeds');
    const select1 = await request(app)
      .post('/api/auth/tenants/select')
      .set('Authorization', `Bearer ${login1.body.access_token}`);
    assertEqual(select1.status, 200, 'Issuer 3 (/api/auth/tenants/select) succeeds');
    const refresh1 = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${login1.body.access_token}`);
    assertEqual(refresh1.status, 200, 'Issuer 4 (/api/auth/refresh) succeeds');

    // Issuer 6: Server App (:3003) /api/auth/login
    const serverAppLogin1 = await request(serverAppBaseUrl)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(serverAppLogin1.status, 200, 'Issuer 6 (server-app /api/auth/login) succeeds');

    // Issuer 7: KDS Server (:3002) /api/auth/login
    const kdsLogin1 = await request(kdsBaseUrl)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(kdsLogin1.status, 200, 'Issuer 7 (kds-server /api/auth/login) succeeds');

    const preChangeTokens = [
      { name: 'login', token: login1.body.access_token },
      { name: 'pin-login', token: pinLogin1.body.access_token },
      { name: 'tenants/select', token: select1.body.access_token },
      { name: 'refresh', token: refresh1.body.access_token },
      { name: 'server-app login', token: serverAppLogin1.body.access_token },
      { name: 'kds-server login', token: kdsLogin1.body.access_token },
    ];

    for (const { name, token: issuedToken } of preChangeTokens) {
      const decoded = jwt.verify(issuedToken, getJWTSecret()) as { iat: number };
      assert(
        typeof decoded.iat === 'number' && !Number.isInteger(decoded.iat),
        `Issuer ${name} stamps sub-second iat (${decoded.iat})`,
      );
    }

    // Bump credentials in the exact same frozen millisecond via PUT /api/staff/:id (PIN change)
    const pinChangeRes = await request(app)
      .put('/api/staff/jwt-owner-1')
      .set('Authorization', `Bearer ${login1.body.access_token}`)
      .send({ pin: '1357' });
    assertEqual(pinChangeRes.status, 200, 'Staff PIN change in same frozen millisecond succeeds');

    // Every pre-change token across Main API, Server App, and KDS must now be rejected (401)
    for (const { name, token: issuedToken } of preChangeTokens) {
      const meMain = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${issuedToken}`);
      assertEqual(meMain.status, 401, `Pre-change token from ${name} rejected on Main API`);
    }
    const staleServerAppMe = await request(serverAppBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${serverAppLogin1.body.access_token}`);
    assertEqual(
      staleServerAppMe.status,
      401,
      'Pre-change token from server-app login rejected on Server App /api/auth/me',
    );
    const staleKdsMe = await request(kdsBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${kdsLogin1.body.access_token}`);
    assertEqual(
      staleKdsMe.status,
      401,
      'Pre-change token from kds-server login rejected on KDS /api/auth/me',
    );

    // Fresh post-change logins in the exact same frozen millisecond across all issuers succeed and validate
    clearLoginRateLimits();
    const login2 = await request(app)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(login2.status, 200, 'Post-change /api/auth/login in same ms succeeds');
    const pinLogin2 = await request(app)
      .post('/api/auth/pin-login')
      .send({ user_id: 'jwt-owner-1', pin: '1357' });
    assertEqual(pinLogin2.status, 200, 'Post-change /api/auth/pin-login in same ms succeeds');
    const select2 = await request(app)
      .post('/api/auth/tenants/select')
      .set('Authorization', `Bearer ${login2.body.access_token}`);
    assertEqual(select2.status, 200, 'Post-change /api/auth/tenants/select in same ms succeeds');
    const refresh2 = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${login2.body.access_token}`);
    assertEqual(refresh2.status, 200, 'Post-change /api/auth/refresh in same ms succeeds');
    const serverAppLogin2 = await request(serverAppBaseUrl)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(
      serverAppLogin2.status,
      200,
      'Post-change server-app /api/auth/login in same ms succeeds',
    );
    const kdsLogin2 = await request(kdsBaseUrl)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(
      kdsLogin2.status,
      200,
      'Post-change kds-server /api/auth/login in same ms succeeds',
    );

    for (const [name, tok] of [
      ['login', login2.body.access_token],
      ['pin-login', pinLogin2.body.access_token],
      ['tenants/select', select2.body.access_token],
      ['refresh', refresh2.body.access_token],
    ] as const) {
      const meCheck = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tok}`);
      assertEqual(meCheck.status, 200, `Post-change token from ${name} accepted on Main API`);
    }
    const validServerAppMe = await request(serverAppBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${serverAppLogin2.body.access_token}`);
    assertEqual(
      validServerAppMe.status,
      200,
      'Post-change token from server-app login accepted on Server App /api/auth/me',
    );
    const validKdsMe = await request(kdsBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${kdsLogin2.body.access_token}`);
    assertEqual(
      validKdsMe.status,
      200,
      'Post-change token from kds-server login accepted on KDS /api/auth/me',
    );

    // Issuer 5: /api/auth/setup/initialize on a fresh user-less table in the same frozen millisecond
    freshDb.prepare('DELETE FROM users').run();
    const setupRes = await request(app).post('/api/auth/setup/initialize').send({
      name: 'Setup Owner',
      email: 'setup-owner@test.local',
      password: 'SetupPass123!',
      business_type: 'restaurant',
      setup_profile: 'empty',
      service_model: 'qsr',
      business_name: 'Setup Cafe',
      country: 'IN',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      terms_accepted: true,
      master_pin: '1234',
      owner_approval_pin: '2468',
      owner_approval_pin_confirmation: '2468',
    });
    assertEqual(setupRes.status, 200, 'Issuer 5 (/api/auth/setup/initialize) succeeds');
    const setupToken = setupRes.body.access_token;
    const setupDecoded = jwt.verify(setupToken, getJWTSecret()) as { iat: number };
    assert(
      typeof setupDecoded.iat === 'number' && !Number.isInteger(setupDecoded.iat),
      `Issuer setup/initialize stamps sub-second iat (${setupDecoded.iat})`,
    );
    const setupMeBefore = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${setupToken}`);
    assertEqual(
      setupMeBefore.status,
      200,
      'Token from setup/initialize is accepted before credential change',
    );

    const setupPwChange = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${setupToken}`)
      .send({ current_password: 'SetupPass123!', password: 'NewSetupPass123!' });
    assertEqual(
      setupPwChange.status,
      200,
      'Password change after setup/initialize in same frozen ms succeeds',
    );

    const setupMeAfter = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${setupToken}`);
    assertEqual(
      setupMeAfter.status,
      401,
      'Token from setup/initialize is invalidated in the same frozen millisecond after password change',
    );
  } finally {
    Date.now = realDateNow;
    await stopServerApp();
    await stopKdsServer();
  }

  const results = getResults();
  if (results.failed > 0) {
    throw new Error(`${results.failed} test assertions failed`);
  }
  console.log('\n✅ JWT Logout & Token Lifecycle tests passed!');
}

run()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  })
  .catch((err) => {
    try {
      closeDatabase();
    } catch {}
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  });
