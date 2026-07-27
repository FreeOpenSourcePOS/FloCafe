/**
 * Regression test for customer pagination:
 * Verifies that GET /api/customers?per_page=... validates per_page inputs,
 * returns HTTP 400 for invalid/zero/negative/decimal/alphabetic values,
 * and caps oversized page limits safely.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-pagination-'));

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

const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb,
  createApp,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { customerRoutes } = require('../main/routes/customers');
const { getJWTSecret } = require('../main/routes/auth');

function makeToken(id: string, role: string, email: string) {
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  console.log('Customer Pagination Validation Tests');
  console.log('='.repeat(60));

  const db = initTestDb();

  // Seed 5 customers for testing pagination limits
  for (let i = 1; i <= 5; i++) {
    db.prepare(
      `INSERT OR IGNORE INTO customers (id, name, phone, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`
    ).run(`cust-pag-${i}`, `Pagination Customer ${i}`, `+91900000000${i}`, now(), now());
  }

  const ownerAuth = makeToken('owner-pag-001', 'owner', 'owner@pag.test');
  const app = createApp({ '/api/customers': customerRoutes });

  // Test 1: Missing per_page returns all customers (200)
  const resMissing = await request(app).get('/api/customers').set(ownerAuth);
  assertEqual(resMissing.status, 200, 'Missing per_page returns 200');
  assertEqual(resMissing.body.data.length, 5, 'Missing per_page returns all 5 customers');

  // Test 2: Valid per_page=2 limits response to 2 records (200)
  const resValid = await request(app).get('/api/customers?per_page=2').set(ownerAuth);
  assertEqual(resValid.status, 200, 'per_page=2 returns 200');
  assertEqual(resValid.body.data.length, 2, 'per_page=2 returns exactly 2 customers');

  // Test 3: Zero per_page=0 returns 400
  const resZero = await request(app).get('/api/customers?per_page=0').set(ownerAuth);
  assertEqual(resZero.status, 400, 'per_page=0 returns 400');
  assertEqual(resZero.body.error, 'Invalid per_page parameter. Must be a positive integer.', 'Correct 400 error message for per_page=0');

  // Test 4: Negative per_page=-5 returns 400
  const resNegative = await request(app).get('/api/customers?per_page=-5').set(ownerAuth);
  assertEqual(resNegative.status, 400, 'per_page=-5 returns 400');

  // Test 5: Decimal per_page=2.5 returns 400
  const resDecimal = await request(app).get('/api/customers?per_page=2.5').set(ownerAuth);
  assertEqual(resDecimal.status, 400, 'per_page=2.5 returns 400');

  // Test 6: Alphabetic per_page=abc returns 400
  const resAlphabetic = await request(app).get('/api/customers?per_page=abc').set(ownerAuth);
  assertEqual(resAlphabetic.status, 400, 'per_page=abc returns 400');

  // Test 7: SQL injection payload returns 400
  const resSql = await request(app).get('/api/customers?per_page=1; DROP TABLE customers;').set(ownerAuth);
  assertEqual(resSql.status, 400, 'SQL injection per_page payload returns 400');

  // Test 8: Oversized per_page=1000 returns 200 (capped at 500 max limit)
  const resOversized = await request(app).get('/api/customers?per_page=1000').set(ownerAuth);
  assertEqual(resOversized.status, 200, 'per_page=1000 returns 200');
  assertEqual(resOversized.body.data.length, 5, 'per_page=1000 succeeds and returns all 5 seeded customers');

  closeDatabase();

  const results = getResults();
  console.log('='.repeat(60));
  console.log(`Summary: ${results.passed} passed, ${results.failed} failed`);

  if (results.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled failure:', err);
  process.exit(1);
});
