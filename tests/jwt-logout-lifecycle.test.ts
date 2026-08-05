/**
 * Test suite for Area E: JWT logout & token lifecycle
 * Verifies immediate token revocation on logout, token reuse rejection, expiry validation, and refresh behavior.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
const { initDatabase } = require('../main/db');
const { staffRoutes } = require('../main/routes/staff');
const { clearRevokedTokens, revokeToken, isTokenRevoked } = require('../main/middleware/security');

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
  const meRes1 = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${token}`);
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
  const meRes2 = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${token}`);
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
    { expiresIn: '-1s' }
  );
  const meRes3 = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${expiredToken}`);
  assertEqual(meRes3.status, 401, 'Expired token fails with 401');

  // Step 8: New token from refresh is still valid
  const meRes4 = await request(app)
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${newToken}`);
  if (meRes4.status !== 200) {
    console.log('meRes4 status:', meRes4.status, 'body:', meRes4.body);
  }
  assertEqual(meRes4.status, 200, 'Refreshed token remains valid');

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
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  });
