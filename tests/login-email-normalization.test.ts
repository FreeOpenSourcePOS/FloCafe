/**
 * Test suite for Area B: Login email normalization
 * Verifies that POST /api/auth/login accepts mixed-case and whitespace-padded emails.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
