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

let mockSafeStorageEnabled = false;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
      safeStorage: {
        isEncryptionAvailable: () => mockSafeStorageEnabled,
        encryptString: (v: string) => Buffer.from(v, 'utf8'),
        decryptString: (b: Buffer) => b.toString('utf8'),
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb,
  createApp,
  assertEqual,
  assertEqualOrThrow,
  assert,
  assertOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { authRoutes, getJWTSecret } = require('../main/routes/auth');
const {
  createBackup,
  getCurrentSchemaVersion,
  getDatabase,
  initDatabase,
  nextAuthTimestampMs,
  nextTokenIatSeconds,
  nextTokensValidAfterTimestamp,
  resetAuthClockForTests,
  restoreBackup,
  restoreCompatibleBackupForDowngrade,
} = require('../main/db');
const { databaseRoutes } = require('../main/routes/database');
const { resetMasterPin } = require('../main/services/master-pin');
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
    '/api/database': databaseRoutes,
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
    resetAuthClockForTests();
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

    // Backward wall-clock jump (> 10s): pre-change token must still be invalidated when credentials change after clock jump backward
    Date.now = () => frozenRouteMs - 15_000;
    const pwChangeAfterBackwardJump = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${postChangeToken}`)
      .send({ current_password: 'Pass5678!', password: 'Pass1234!' });
    assertEqual(
      pwChangeAfterBackwardJump.status,
      200,
      'Password change after backward wall-clock jump (> 10s) succeeds',
    );

    const staleAfterBackwardJump = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${postChangeToken}`);
    assertEqual(
      staleAfterBackwardJump.status,
      401,
      'Pre-change token is rejected after credential change even when Date.now() jumped backward by > 10s',
    );

    // Simulated process restart (in-memory monotonic clock reset while persisted tokens_valid_after is ahead of wall clock):
    // fresh login must still receive an iat strictly greater than persisted tokens_valid_after and succeed on /api/auth/me
    resetAuthClockForTests();
    const loginAfterSimulatedRestart = await request(app)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(
      loginAfterSimulatedRestart.status,
      200,
      'Login after simulated process restart with persisted tokens_valid_after ahead of wall clock succeeds',
    );
    const restartToken = loginAfterSimulatedRestart.body.access_token;
    const meAfterSimulatedRestart = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${restartToken}`);
    assertEqual(
      meAfterSimulatedRestart.status,
      200,
      'Fresh login token after simulated process restart is accepted by /api/auth/me',
    );

    // Simulated server restart + 2-minute backward clock adjustment after minting a token when tokens_valid_after was NULL:
    // credential change after restart + backward jump must still invalidate the pre-restart token.
    freshDb.prepare(`UPDATE users SET tokens_valid_after = NULL WHERE id = 'jwt-owner-1'`).run();
    clearUserAuthCache();
    const preRestartMintMs = frozenRouteMs + 60_000;
    Date.now = () => preRestartMintMs;
    const loginBeforeRestart = await request(app)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass1234!' });
    assertEqual(loginBeforeRestart.status, 200, 'Login at T before restart succeeds');
    const preRestartToken = loginBeforeRestart.body.access_token;

    // Simulate process restart and 2-minute backward clock jump (T - 120_000)
    resetAuthClockForTests();
    Date.now = () => preRestartMintMs - 120_000;
    const pwChangeAfterRestartAndClockRollback = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${preRestartToken}`)
      .send({ current_password: 'Pass1234!', password: 'Pass5678!' });
    assertEqual(
      pwChangeAfterRestartAndClockRollback.status,
      200,
      'Password change after restart and 2-minute backward clock jump succeeds',
    );
    const stalePreRestartMe = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${preRestartToken}`);
    assertEqual(
      stalePreRestartMe.status,
      401,
      'Pre-restart token is rejected (401) after server restart + 2-minute backward clock jump + credential change',
    );
    // Restore password back to Pass1234! for subsequent tests
    const restorePwLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'jwt-owner@test.local', password: 'Pass5678!' });
    assertEqual(restorePwLogin.status, 200, 'Post-restart login with new password succeeds');
    const restorePwRes = await request(app)
      .post('/api/auth/password/change')
      .set('Authorization', `Bearer ${restorePwLogin.body.access_token}`)
      .send({ current_password: 'Pass5678!', password: 'Pass1234!' });
    assertEqual(restorePwRes.status, 200, 'Password restored to Pass1234!');
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

    // 10d: After a 48-hour forward clock jump and wall-clock correction, all 7 issuers compute exp from wall-clock Date.now()
    clearLoginRateLimits();
    const clockJumpMs = frozenAllIssuersMs + 48 * 3600 * 1000;
    Date.now = () => clockJumpMs;
    const jumpPwChange = await request(app)
      .post('/api/auth/password/change')
      .set(
        'Authorization',
        `Bearer ${jwt.sign(
          {
            userId: setupRes.body.user.id,
            email: 'setup-owner@test.local',
            role: 'owner',
            iat: nextTokenIatSeconds(),
            exp: Math.floor(clockJumpMs / 1000) + 86400,
          },
          getJWTSecret(),
        )}`,
      )
      .send({ current_password: 'NewSetupPass123!', password: 'PostJumpPass123!' });
    assertEqual(jumpPwChange.status, 200, 'Password change during +48h clock jump succeeds');

    // Correct wall clock back by 48 hours to frozenAllIssuersMs
    const correctedWallMs = frozenAllIssuersMs;
    const expected24hExp = Math.floor(correctedWallMs / 1000) + 86400;
    const expected10dExp = Math.floor(correctedWallMs / 1000) + 10 * 86400;
    Date.now = () => correctedWallMs;

    // Re-initialize via /api/auth/setup/initialize after clearing users so all 7 issuers are exercised post-correction
    freshDb.prepare('DELETE FROM users').run();
    const postCorrectionSetup = await request(app).post('/api/auth/setup/initialize').send({
      name: 'Corrected Owner',
      email: 'corrected-owner@test.local',
      password: 'CorrectedPass123!',
      business_type: 'restaurant',
      setup_profile: 'empty',
      service_model: 'qsr',
      business_name: 'Corrected Cafe',
      country: 'IN',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      terms_accepted: true,
      master_pin: '1234',
      owner_approval_pin: '2468',
      owner_approval_pin_confirmation: '2468',
    });
    assertEqual(
      postCorrectionSetup.status,
      200,
      'Post-48h-correction /api/auth/setup/initialize succeeds',
    );
    const correctedUserId = postCorrectionSetup.body.user.id as string;

    clearLoginRateLimits();
    const postCorrectionLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'corrected-owner@test.local', password: 'CorrectedPass123!' });
    assertEqual(postCorrectionLogin.status, 200, 'Post-48h-correction /api/auth/login succeeds');

    const postCorrectionRememberLogin = await request(app).post('/api/auth/login').send({
      email: 'corrected-owner@test.local',
      password: 'CorrectedPass123!',
      rememberMe: true,
    });
    assertEqual(
      postCorrectionRememberLogin.status,
      200,
      'Post-48h-correction /api/auth/login (rememberMe) succeeds',
    );

    const postCorrectionPinLogin = await request(app)
      .post('/api/auth/pin-login')
      .send({ user_id: correctedUserId, pin: '2468' });
    assertEqual(
      postCorrectionPinLogin.status,
      200,
      'Post-48h-correction /api/auth/pin-login succeeds',
    );

    const postCorrectionSelect = await request(app)
      .post('/api/auth/tenants/select')
      .set('Authorization', `Bearer ${postCorrectionLogin.body.access_token}`);
    assertEqual(
      postCorrectionSelect.status,
      200,
      'Post-48h-correction /api/auth/tenants/select succeeds',
    );

    const postCorrectionRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${postCorrectionLogin.body.access_token}`);
    assertEqual(
      postCorrectionRefresh.status,
      200,
      'Post-48h-correction /api/auth/refresh succeeds',
    );

    const postCorrectionServerAppLogin = await request(serverAppBaseUrl)
      .post('/api/auth/login')
      .send({ email: 'corrected-owner@test.local', password: 'CorrectedPass123!' });
    assertEqual(
      postCorrectionServerAppLogin.status,
      200,
      'Post-48h-correction server-app /api/auth/login succeeds',
    );

    const postCorrectionServerAppRemember = await request(serverAppBaseUrl)
      .post('/api/auth/login')
      .send({
        email: 'corrected-owner@test.local',
        password: 'CorrectedPass123!',
        remember_me: true,
      });
    assertEqual(
      postCorrectionServerAppRemember.status,
      200,
      'Post-48h-correction server-app /api/auth/login (remember_me) succeeds',
    );

    const postCorrectionKdsLogin = await request(kdsBaseUrl)
      .post('/api/auth/login')
      .send({ email: 'corrected-owner@test.local', password: 'CorrectedPass123!' });
    assertEqual(
      postCorrectionKdsLogin.status,
      200,
      'Post-48h-correction kds-server /api/auth/login succeeds',
    );

    const postCorrection24hTokens = [
      { name: 'setup/initialize', token: postCorrectionSetup.body.access_token as string },
      { name: 'login', token: postCorrectionLogin.body.access_token as string },
      { name: 'pin-login', token: postCorrectionPinLogin.body.access_token as string },
      { name: 'tenants/select', token: postCorrectionSelect.body.access_token as string },
      { name: 'refresh', token: postCorrectionRefresh.body.access_token as string },
      { name: 'server-app login', token: postCorrectionServerAppLogin.body.access_token as string },
      { name: 'kds-server login', token: postCorrectionKdsLogin.body.access_token as string },
    ];

    for (const { name, token: tok } of postCorrection24hTokens) {
      const decoded = jwt.verify(tok, getJWTSecret()) as { iat: number; exp: number };
      assertEqual(
        decoded.exp,
        expected24hExp,
        `Post-48h-correction ${name} sets exp to wall-clock + 24h (${expected24hExp}), not logical iat + 24h`,
      );
      assert(
        decoded.iat > decoded.exp,
        `Post-48h-correction ${name} preserves ahead monotonic iat (${decoded.iat}) while exp is wall-clock bounded (${decoded.exp})`,
      );
    }

    for (const { name, token: tok } of [
      { name: 'login rememberMe', token: postCorrectionRememberLogin.body.access_token as string },
      {
        name: 'server-app remember_me',
        token: postCorrectionServerAppRemember.body.access_token as string,
      },
    ]) {
      const decoded = jwt.verify(tok, getJWTSecret()) as { exp: number };
      assertEqual(
        decoded.exp,
        expected10dExp,
        `Post-48h-correction ${name} sets exp to wall-clock + 10d (${expected10dExp})`,
      );
    }

    // Advance wall clock to +25 hours: every 24h token must be expired (401), not valid for 72 hours
    Date.now = () => correctedWallMs + 25 * 3600 * 1000;
    for (const { name, token: tok } of postCorrection24hTokens) {
      const expiredMain = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tok}`);
      assertEqual(
        expiredMain.status,
        401,
        `Post-48h-correction 24h token from ${name} expires by +25h wall-clock on Main API`,
      );
    }
    const expiredServerApp = await request(serverAppBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${postCorrectionServerAppLogin.body.access_token}`);
    assertEqual(
      expiredServerApp.status,
      401,
      'Post-48h-correction 24h token from server-app login expires by +25h wall-clock on Server App',
    );
    const expiredKds = await request(kdsBaseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${postCorrectionKdsLogin.body.access_token}`);
    assertEqual(
      expiredKds.status,
      401,
      'Post-48h-correction 24h token from kds-server login expires by +25h wall-clock on KDS',
    );
  } finally {
    Date.now = realDateNow;
    await stopServerApp();
    await stopKdsServer();
  }

  // Step 11: auth_clock_high_water_ms bounds validation & backup export/import/restore isolation
  console.log(
    '\nStep 11: auth_clock_high_water_ms bounds validation & backup export/import/restore',
  );
  {
    const liveDb = getDatabase();
    liveDb.prepare('UPDATE users SET tokens_valid_after = NULL').run();

    try {
      const safeNowMs = 1_760_500_000_123;
      Date.now = () => safeNowMs;

      for (const invalidHighWater of [
        '8639999999999001',
        '8640000000000001',
        '9007199254740992',
        '99999999999999999999',
        '-500',
        '0',
        '1760500999000abc',
        'NaN',
      ]) {
        resetAuthClockForTests();
        liveDb
          .prepare(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('auth_clock_high_water_ms', ?, ?)",
          )
          .run(invalidHighWater, now());

        const validAfterStr = nextTokensValidAfterTimestamp();
        assertOrThrow(
          typeof validAfterStr === 'string' && validAfterStr.length > 0,
          `nextTokensValidAfterTimestamp does not throw RangeError for invalid high-water '${invalidHighWater}'`,
        );
        assertEqualOrThrow(
          validAfterStr,
          new Date(safeNowMs).toISOString().replace('T', ' ').replace('Z', ''),
          `invalid high-water '${invalidHighWater}' is ignored in favor of safe wall clock`,
        );
        const healedRow = liveDb
          .prepare("SELECT value FROM settings WHERE key = 'auth_clock_high_water_ms'")
          .get() as { value?: string } | undefined;
        assertEqualOrThrow(
          healedRow?.value,
          String(safeNowMs),
          `invalid high-water '${invalidHighWater}' is overwritten with valid safe millisecond value`,
        );
      }

      // Max valid boundary (8_639_999_999_999_000) advances safely without RangeError
      resetAuthClockForTests();
      liveDb
        .prepare(
          "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('auth_clock_high_water_ms', '8639999999999000', ?)",
        )
        .run(now());
      const boundaryCutoff = nextTokensValidAfterTimestamp();
      assertEqualOrThrow(
        boundaryCutoff,
        '+275760-09-12 23:59:59.001',
        'boundary max high-water 8_639_999_999_999_000 produces valid extended-year timestamp without RangeError',
      );
      assertOrThrow(
        isTokenStale(8_639_999_999_999_000 / 1000, boundaryCutoff),
        'isTokenStale marks token at 8_639_999_999_999_000ms stale against boundary cutoff',
      );
      const clampedRow = liveDb
        .prepare("SELECT value FROM settings WHERE key = 'auth_clock_high_water_ms'")
        .get() as { value?: string } | undefined;
      assertEqualOrThrow(
        clampedRow?.value,
        '8639999999999000',
        'persisted high-water stays clamped at <= 8_639_999_999_999_000',
      );

      // Out-of-range Date.now() is also clamped safely without throwing RangeError
      resetAuthClockForTests();
      liveDb.prepare("DELETE FROM settings WHERE key = 'auth_clock_high_water_ms'").run();
      Date.now = () => 9_000_000_000_000_000;
      const clampedWallCutoff = nextTokensValidAfterTimestamp();
      assertOrThrow(
        typeof clampedWallCutoff === 'string' && clampedWallCutoff.startsWith('+275760-09-12'),
        'out-of-range Date.now() clamps safely without throwing RangeError',
      );
    } finally {
      Date.now = realDateNow;
      resetAuthClockForTests();
    }

    // Reset local auth_clock_high_water_ms to a clean current value and test export/import/restore
    const localClockMs = nextAuthTimestampMs();
    liveDb
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('auth_clock_high_water_ms', ?, ?)",
      )
      .run(String(localClockMs), now());

    clearLoginRateLimits();
    const exportOwnerLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'corrected-owner@test.local', password: 'CorrectedPass123!' });
    assertEqualOrThrow(exportOwnerLogin.status, 200, 'Owner login for export/import test succeeds');
    const ownerAuth = { Authorization: `Bearer ${exportOwnerLogin.body.access_token}` };
    const afterLoginClockRow = liveDb
      .prepare("SELECT value FROM settings WHERE key = 'auth_clock_high_water_ms'")
      .get() as { value?: string } | undefined;
    const expectedPreservedLocalClock = String(afterLoginClockRow?.value || '');
    assertOrThrow(
      /^\d+$/.test(expectedPreservedLocalClock),
      'local auth_clock_high_water_ms is populated before export',
    );

    const exportRes = await request(app).get('/api/database/export').set(ownerAuth);
    assertEqualOrThrow(exportRes.status, 200, 'GET /api/database/export succeeds');
    assertOrThrow(
      Array.isArray(exportRes.body.redacted_fields) &&
        exportRes.body.redacted_fields.includes('settings.auth_clock_high_water_ms'),
      'GET /api/database/export records settings.auth_clock_high_water_ms in redacted_fields',
    );
    const exportedAuthClockRow = (exportRes.body.data?.settings || []).find(
      (row: any) => row.key === 'auth_clock_high_water_ms',
    );
    assertEqualOrThrow(
      exportedAuthClockRow?.value,
      '[REDACTED]',
      'GET /api/database/export redacts auth_clock_high_water_ms value',
    );

    // Non-overwrite import with injected foreign/out-of-range auth_clock_high_water_ms preserves local value
    const poisonedImportPayload = {
      schema_version: String(getCurrentSchemaVersion()),
      data: {
        settings: [
          {
            key: 'auth_clock_high_water_ms',
            value: '99999999999999999999',
            updated_at: now(),
          },
        ],
        categories: [],
        products: [],
        users: [],
      },
    };
    const mergeImportRes = await request(app)
      .post('/api/database/import')
      .set(ownerAuth)
      .send({ overwrite: false, data: poisonedImportPayload });
    assertEqualOrThrow(
      mergeImportRes.status,
      200,
      'non-overwrite import with foreign auth_clock_high_water_ms succeeds without constraint error',
    );
    const afterMergeClockRow = getDatabase()
      .prepare("SELECT value FROM settings WHERE key = 'auth_clock_high_water_ms'")
      .get() as { value?: string } | undefined;
    assertEqualOrThrow(
      afterMergeClockRow?.value,
      expectedPreservedLocalClock,
      'non-overwrite import preserves local auth_clock_high_water_ms and ignores foreign value',
    );

    // Overwrite import with injected foreign future auth_clock_high_water_ms also preserves local value
    mockSafeStorageEnabled = true;
    try {
      resetMasterPin('1234');
      const foreignFutureImportPayload = {
        schema_version: String(getCurrentSchemaVersion()),
        data: {
          settings: [
            {
              key: 'auth_clock_high_water_ms',
              value: '4102444800123',
              updated_at: now(),
            },
          ],
          categories: [],
          products: [],
          users: [],
        },
      };
      const overwriteImportRes = await request(app)
        .post('/api/database/import')
        .set(ownerAuth)
        .send({ overwrite: true, master_pin: '1234', data: foreignFutureImportPayload });
      assertEqualOrThrow(
        overwriteImportRes.status,
        200,
        'overwrite import with foreign future auth_clock_high_water_ms succeeds',
      );
      const afterOverwriteClockRow = getDatabase()
        .prepare("SELECT value FROM settings WHERE key = 'auth_clock_high_water_ms'")
        .get() as { value?: string } | undefined;
      assertEqualOrThrow(
        afterOverwriteClockRow?.value,
        expectedPreservedLocalClock,
        'overwrite import preserves local auth_clock_high_water_ms instead of adopting foreign clock',
      );

      // When local install has no auth_clock_high_water_ms row, import strips foreign auth_clock_high_water_ms
      getDatabase().prepare("DELETE FROM settings WHERE key = 'auth_clock_high_water_ms'").run();
      const emptyLocalImportRes = await request(app)
        .post('/api/database/import')
        .set(ownerAuth)
        .send({ overwrite: false, data: foreignFutureImportPayload });
      assertEqualOrThrow(
        emptyLocalImportRes.status,
        200,
        'import when local auth_clock_high_water_ms is absent succeeds',
      );
      const afterEmptyLocalClockRow = getDatabase()
        .prepare("SELECT value FROM settings WHERE key = 'auth_clock_high_water_ms'")
        .get() as { value?: string } | undefined;
      assertEqualOrThrow(
        afterEmptyLocalClockRow,
        undefined,
        'import strips foreign auth_clock_high_water_ms when absent locally',
      );

      // SQLite .db restoreBackup strips out-of-range/foreign auth_clock_high_water_ms without RangeError
      const { path: sqliteBackupPath } = await createBackup();
      const poisonedBackupDb = new Database(sqliteBackupPath);
      try {
        poisonedBackupDb
          .prepare(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('auth_clock_high_water_ms', '99999999999999999999', ?)",
          )
          .run(now());
      } finally {
        poisonedBackupDb.close();
      }
      resetAuthClockForTests();
      const restoreRes = restoreBackup(sqliteBackupPath, true);
      assertEqualOrThrow(
        restoreRes.success,
        true,
        'restoreBackup succeeds even when backup .db contains out-of-range auth_clock_high_water_ms',
      );
      const restoredClockRow = getDatabase()
        .prepare("SELECT value FROM settings WHERE key = 'auth_clock_high_water_ms'")
        .get() as { value?: string } | undefined;
      const restoredClockMs = Number(restoredClockRow?.value);
      assertOrThrow(
        Number.isSafeInteger(restoredClockMs) &&
          restoredClockMs > 0 &&
          restoredClockMs <= 8_639_999_999_999_000,
        'restoreBackup writes a valid local auth_clock_high_water_ms instead of keeping poisoned backup value',
      );

      const { path: downgradeBackupPath } = await createBackup();
      const foreignFutureHighWaterMs = 4_102_444_800_123;
      const skewedDowngradeBackupDb = new Database(downgradeBackupPath);
      try {
        skewedDowngradeBackupDb
          .prepare(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('auth_clock_high_water_ms', ?, ?)",
          )
          .run(String(foreignFutureHighWaterMs), now());
        skewedDowngradeBackupDb.prepare('UPDATE users SET tokens_valid_after = NULL').run();
      } finally {
        skewedDowngradeBackupDb.close();
      }
      resetAuthClockForTests();
      await restoreCompatibleBackupForDowngrade(downgradeBackupPath, {
        newerDbVersion: getCurrentSchemaVersion() + 1,
      });
      initDatabase();
      const downgradeClockRow = getDatabase()
        .prepare("SELECT value FROM settings WHERE key = 'auth_clock_high_water_ms'")
        .get() as { value?: string } | undefined;
      const downgradeClockMs = Number(downgradeClockRow?.value);
      assertOrThrow(
        Number.isSafeInteger(downgradeClockMs) &&
          downgradeClockMs > 0 &&
          downgradeClockMs < foreignFutureHighWaterMs,
        'restoreCompatibleBackupForDowngrade discards foreign future auth_clock_high_water_ms and records local clock',
      );
      const unbumpedUsers = getDatabase()
        .prepare('SELECT COUNT(*) AS cnt FROM users WHERE tokens_valid_after IS NULL')
        .get() as { cnt: number };
      assertEqualOrThrow(
        unbumpedUsers.cnt,
        0,
        'restoreCompatibleBackupForDowngrade bumps users.tokens_valid_after for all restored accounts',
      );
      assertOrThrow(
        nextTokenIatSeconds() * 1000 < foreignFutureHighWaterMs,
        'post-downgrade-restore JWT iat is not pinned to foreign future backup high-water mark',
      );
    } finally {
      mockSafeStorageEnabled = false;
    }
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
