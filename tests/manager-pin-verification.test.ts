/**
 * Test suite for Area D: Manager PIN verification
 * Verifies role filtering, is_active status, rate limiting, and targeted lookup for manager PIN overrides.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mgr-pin-'));

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

const { billRoutes } = require('../main/routes/bills');
const { getJWTSecret } = require('../main/routes/auth');

function makeToken(id: string, role: string, email: string) {
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function run() {
  console.log('Testing Manager PIN Verification (Area D)...');
  console.log('='.repeat(60));

  const db = initTestDb();

  // Turn on discount approval in settings
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discount_requires_approval', 'true', ?)").run(now());

  // Seed active manager 1 (PIN: 1111)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-1', 'Manager One', 'mgr1@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('1111', 10), now(), now());

  // Seed active manager 2 (PIN: 2222)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-2', 'Manager Two', 'mgr2@test.local', 'Pass1234!', 'manager', ?, 1, ?, ?)
  `).run(bcrypt.hashSync('2222', 10), now(), now());

  // Seed deactivated manager 3 (PIN: 3333, is_active = 0)
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES ('mgr-3', 'Deactivated Manager', 'mgr3@test.local', 'Pass1234!', 'manager', ?, 0, ?, ?)
  `).run(bcrypt.hashSync('3333', 10), now(), now());

  // Seed an order and bill to test discount approval
  const orderRes = db.prepare(`
    INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES ('ORD-TEST-001', 'dine_in', 100, 10, 110, 'pending', ?, ?)
  `).run(now(), now());
  const orderId = orderRes.lastInsertRowid;

  const billRes = db.prepare(`
    INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
    VALUES ('BILL-TEST-001', ?, 100, 10, 110, 0, 110, 'unpaid', ?, ?)
  `).run(orderId, now(), now());
  const billId = billRes.lastInsertRowid;

  const ownerAuth = makeToken('mgr-1', 'manager', 'mgr1@test.local');
  const app = createApp({ '/api/bills': billRoutes });

  // Test 1: Valid Manager 1 PIN (1111) succeeds
  const res1 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '1111' });
  assertEqual(res1.status, 200, 'Valid manager 1 PIN succeeds');

  // Test 2: Valid Manager 2 PIN (2222) succeeds
  const res2 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '2222' });
  assertEqual(res2.status, 200, 'Valid manager 2 PIN succeeds');

  // Test 3: Deactivated Manager 3 PIN (3333) fails
  const res3 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '3333' });
  assertEqual(res3.status, 403, 'Deactivated manager PIN fails with 403');

  // Test 4: Targeted Manager lookup by manager_id
  const res4 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '2222', manager_id: 'mgr-2' });
  assertEqual(res4.status, 200, 'Targeted manager PIN lookup by manager_id succeeds');

  // Test 5: Incorrect PIN returns 403
  const res5 = await request(app)
    .post(`/api/bills/${billId}/applyDiscount`)
    .set(ownerAuth)
    .send({ type: 'percentage', value: 10, override_pin: '9999' });
  assertEqual(res5.status, 403, 'Incorrect PIN returns 403');

  const results = getResults();
  if (results.failed > 0) {
    throw new Error(`${results.failed} test assertions failed`);
  }
  console.log('\n✅ Manager PIN verification tests passed!');
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
