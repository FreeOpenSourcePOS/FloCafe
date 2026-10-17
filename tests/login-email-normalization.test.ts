/**
 * Test suite for Area B: Login email normalization
 * Verifies that POST /api/auth/login accepts mixed-case and whitespace-padded emails.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.FLO_AUTH_RATE_LIMIT_MAX = '100';
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-login-norm-'));

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

const { authRoutes } = require('../main/routes/auth');

async function run() {
  console.log('Testing Login Email Normalization (Area B)...');
  console.log('='.repeat(60));

  const db = initTestDb();

  // Seed a user with normalized email
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('norm-user-1', 'Norm Owner', 'owner@flocafe.local', ?, 'owner', 1, ?, ?)
  `).run(bcrypt.hashSync('Pass1234!', 10), now(), now());

  const app = createApp({ '/api/auth': authRoutes });

  // Test 1: Exact lowercase email
  const res1 = await request(app)
    .post('/api/auth/login')
    .send({ email: 'owner@flocafe.local', password: 'Pass1234!' });
  assertEqual(res1.status, 200, 'Exact lowercase email login succeeds');
  assert(!!res1.body.access_token, 'Login returns access token');

  // Test 2: Uppercase / Mixed-case email
  const res2 = await request(app)
    .post('/api/auth/login')
    .send({ email: 'Owner@FloCafe.Local', password: 'Pass1234!' });
  assertEqual(res2.status, 200, 'Mixed-case email login succeeds');

  // Test 3: Whitespace-padded email
  const res3 = await request(app)
    .post('/api/auth/login')
    .send({ email: '  owner@flocafe.local \t', password: 'Pass1234!' });
  assertEqual(res3.status, 200, 'Whitespace-padded email login succeeds');

  // Test 4: Mixed-case AND whitespace-padded email
  const res4 = await request(app)
    .post('/api/auth/login')
    .send({ email: '  OWNER@FLOCAFE.LOCAL \n', password: 'Pass1234!' });
  assertEqual(res4.status, 200, 'Mixed-case and whitespace-padded email login succeeds');

  // Test 5: Main API wrong password with mixed-case email
  const res5 = await request(app)
    .post('/api/auth/login')
    .send({ email: 'Owner@FloCafe.Local', password: 'WrongPassword!' });
  assertEqual(res5.status, 401, 'Main API: Wrong password with mixed-case returns 401');
  assert(!res5.body.access_token, 'Main API: No access token issued on wrong password');

  // Test 6: Main API missing email/password
  const res6a = await request(app).post('/api/auth/login').send({});
  assertEqual(res6a.status, 400, 'Main API: Empty body returns 400');
  const res6b = await request(app).post('/api/auth/login').send({ email: '   ' });
  assertEqual(res6b.status, 400, 'Main API: Whitespace-only email returns 400');

  // Seed kitchen chef user and station assignment for KDS tests
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('norm-chef-1', 'Norm Chef', 'chef@flocafe.local', ?, 'chef', 1, ?, ?)
  `).run(bcrypt.hashSync('ChefPass1234!', 10), now(), now());

  db.prepare(`
    INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
    VALUES ('kds-norm-station-1', 'Main Line', '[]', 1, ?, ?)
  `).run(now(), now());

  db.prepare(`
    INSERT INTO station_users (user_id, station_id, created_at)
    VALUES ('norm-chef-1', 'kds-norm-station-1', ?)
  `).run(now());

  // Seed non-kitchen staff user (server)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('norm-server-1', 'Norm Server', 'server@flocafe.local', ?, 'server', 1, ?, ?)
  `).run(bcrypt.hashSync('ServerPass1234!', 10), now(), now());

  // Seed inactive chef user
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('norm-inactive-chef', 'Inactive Chef', 'inactive-chef@flocafe.local', ?, 'chef', 0, ?, ?)
  `).run(bcrypt.hashSync('ChefPass1234!', 10), now(), now());

  // Seed chef user with configured station assignments but no assigned stations
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, station_assignments_configured, created_at, updated_at)
    VALUES ('norm-unassigned-chef', 'Unassigned Chef', 'unassigned-chef@flocafe.local', ?, 'chef', 1, 1, ?, ?)
  `).run(bcrypt.hashSync('ChefPass1234!', 10), now(), now());

  // Test 7: Main API inactive user rejected
  const res7 = await request(app)
    .post('/api/auth/login')
    .send({ email: 'INACTIVE-CHEF@FLOCAFE.LOCAL', password: 'ChefPass1234!' });
  assertEqual(res7.status, 401, 'Main API: Inactive user with uppercase email returns 401');

  // ── Standalone KDS Login Tests ──────────────────────────────
  process.env.KDS_PORT = '0';
  const { startKdsServer, stopKdsServer, getKdsPort } = require('../main/kds-server');
  await startKdsServer();
  const kdsPort = getKdsPort();
  const kdsUrl = `http://127.0.0.1:${kdsPort}`;

  try {
    // KDS Test 1: Exact lowercase email
    const kdsRes1 = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: 'chef@flocafe.local', password: 'ChefPass1234!' });
    assertEqual(kdsRes1.status, 200, 'KDS: Exact lowercase email login succeeds');
    assert(!!kdsRes1.body.access_token, 'KDS: Login returns access token');
    assertEqual(kdsRes1.body.user?.role, 'chef', 'KDS: User role is chef');
    assertEqual(kdsRes1.body.user?.email, 'chef@flocafe.local', 'KDS: Canonical stored email returned');
    assert(kdsRes1.body.user?.station_ids?.includes('kds-norm-station-1'), 'KDS: Station ID assigned');
    assertEqual(kdsRes1.body.user?.station_assignments_configured, true, 'KDS: Station assignments configured');

    // KDS Test 2: Uppercase email
    const kdsRes2 = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: 'CHEF@FLOCAFE.LOCAL', password: 'ChefPass1234!' });
    assertEqual(kdsRes2.status, 200, 'KDS: Uppercase email login succeeds');
    assert(!!kdsRes2.body.access_token, 'KDS: Uppercase login returns access token');
    assertEqual(kdsRes2.body.user?.email, 'chef@flocafe.local', 'KDS: Uppercase login returns canonical stored email');

    // KDS Test 3: Mixed-case email
    const kdsRes3 = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: 'ChEf@FloCafe.Local', password: 'ChefPass1234!' });
    assertEqual(kdsRes3.status, 200, 'KDS: Mixed-case email login succeeds');
    assertEqual(kdsRes3.body.user?.email, 'chef@flocafe.local', 'KDS: Mixed-case login returns canonical stored email');

    // KDS Test 4: Whitespace-padded email
    const kdsRes4 = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: '  chef@flocafe.local \t', password: 'ChefPass1234!' });
    assertEqual(kdsRes4.status, 200, 'KDS: Whitespace-padded email login succeeds');

    // KDS Test 5: Mixed-case and whitespace-padded email
    const kdsRes5 = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: '  CHEF@FLOCAFE.LOCAL \n', password: 'ChefPass1234!' });
    assertEqual(kdsRes5.status, 200, 'KDS: Mixed-case and whitespace-padded email login succeeds');

    // KDS Test 6: Missing credentials
    const kdsRes6Empty = await request(kdsUrl).post('/api/auth/login').send({});
    assertEqual(kdsRes6Empty.status, 400, 'KDS: Missing body returns 400');
    const kdsRes6Whitespace = await request(kdsUrl).post('/api/auth/login').send({ email: '   ', password: 'ChefPass1234!' });
    assertEqual(kdsRes6Whitespace.status, 400, 'KDS: Whitespace-only email returns 400');

    // KDS Test 7: Wrong password with lowercase and mixed-case email
    const kdsRes7a = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: 'chef@flocafe.local', password: 'WrongPassword!' });
    assertEqual(kdsRes7a.status, 401, 'KDS: Wrong password returns 401');
    assert(!kdsRes7a.body.access_token, 'KDS: No token issued on wrong password');

    const kdsRes7b = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: 'ChEf@FloCafe.Local', password: 'WrongPassword!' });
    assertEqual(kdsRes7b.status, 401, 'KDS: Wrong password with mixed-case returns 401');

    // KDS Test 8: Inactive chef user returns 401
    const kdsRes8 = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: 'INACTIVE-CHEF@FLOCAFE.LOCAL', password: 'ChefPass1234!' });
    assertEqual(kdsRes8.status, 401, 'KDS: Inactive chef with uppercase email returns 401');

    // KDS Test 9: Non-kitchen staff role returns 403
    const kdsRes9 = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: 'SERVER@FLOCAFE.LOCAL', password: 'ServerPass1234!' });
    assertEqual(kdsRes9.status, 403, 'KDS: Non-kitchen staff with uppercase email is rejected with 403');

    // KDS Test 10: Chef with configured station assignments but no active stations returns 403
    const kdsRes10 = await request(kdsUrl)
      .post('/api/auth/login')
      .send({ email: 'UNASSIGNED-CHEF@FLOCAFE.LOCAL', password: 'ChefPass1234!' });
    assertEqual(kdsRes10.status, 403, 'KDS: Chef with no station assignment returns 403');
    assertEqual(kdsRes10.body?.error, 'No active kitchen station is assigned to this user', 'KDS: Specific station error message returned');
  } finally {
    await stopKdsServer();
  }

  const results = getResults();
  if (results.failed > 0) {
    throw new Error(`${results.failed} test assertions failed`);
  }
  console.log('\n✅ Login email normalization tests passed!');
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
