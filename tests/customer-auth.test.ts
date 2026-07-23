/**
 * Regression test for vuln-0001 (CWE-862):
 * Verifies that all customer endpoints require authentication
 * and enforce role-based access control.
 *
 * Run: npm run test:customer-auth
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-auth-'));

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
  console.log('Customer Auth Regression Tests (vuln-0001)');
  console.log('='.repeat(60));

  const db = initTestDb();

  // Seed a customer so /:id routes have something to hit
  const custId = 'cust-auth-test-001';
  db.prepare(
    `INSERT OR IGNORE INTO customers (id, name, phone, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run(custId, 'Auth Test Customer', '5550000001', now(), now());

  // Seed users for role checks
  const ownerAuth   = makeToken('owner-auth-001',   'owner',   'owner@auth.test');
  const managerAuth = makeToken('mgr-auth-001',     'manager', 'manager@auth.test');
  const cashierAuth = makeToken('cashier-auth-001', 'cashier', 'cashier@auth.test');
  const waiterAuth  = makeToken('waiter-auth-001',  'waiter',  'waiter@auth.test');
  const chefAuth    = makeToken('chef-auth-001',    'chef',    'chef@auth.test');

  const app = createApp({ '/api/customers': customerRoutes });

  console.log('\n── 1. Unauthenticated requests must return 401 ──────────────');

  const unauthCases: Array<[string, string, object?]> = [
    ['GET',    '/api/customers/'],
    ['GET',    `/api/customers/${custId}`],
    ['GET',    `/api/customers/${custId}/wallet`],
    ['POST',   '/api/customers/', { name: 'Attacker', phone: '5559999999' }],
    ['PUT',    `/api/customers/${custId}`, { name: 'Modified' }],
    ['DELETE', '/api/customers/admin/cleanup'],
  ];

  for (const [method, url, body] of unauthCases) {
    const req = request(app)[method.toLowerCase()](url).set('Content-Type', 'application/json');
    if (body) req.send(body);
    const res = await req;
    assertEqual(res.status, 401, `No token → ${method} ${url} returns 401`);
  }

  console.log('\n── 2. Read endpoints: cashier + waiter allowed ──────────────');

  for (const [label, auth] of [['cashier', cashierAuth], ['waiter', waiterAuth]]) {
    const listRes = await request(app).get('/api/customers/').set(auth as any);
    assertEqual(listRes.status, 200, `${label} can GET /api/customers/`);

    const getRes = await request(app).get(`/api/customers/${custId}`).set(auth as any);
    assertEqual(getRes.status, 200, `${label} can GET /api/customers/:id`);

    const walletRes = await request(app).get(`/api/customers/${custId}/wallet`).set(auth as any);
    assertEqual(walletRes.status, 200, `${label} can GET /api/customers/:id/wallet`);
  }

  console.log('\n── 3. Write endpoints: waiter cannot PUT ──');

  const waiterPutRes = await request(app)
    .put(`/api/customers/${custId}`)
    .set(waiterAuth as any)
    .send({ name: 'Modified' });
  assertEqual(waiterPutRes.status, 403, 'waiter cannot PUT /api/customers/:id');

  console.log('\n── 4. Write endpoints: cashier, manager + owner allowed to PUT ──');

  // Cashiers can correct a customer's name/phone from the POS (e.g. a typo
  // caught at checkout). There's no DELETE to worry about — see 4b below.
  for (const [label, auth] of [['cashier', cashierAuth], ['manager', managerAuth], ['owner', ownerAuth]]) {
    const putRes = await request(app)
      .put(`/api/customers/${custId}`)
      .set(auth as any)
      .send({ name: `Modified by ${label}` });
    assertEqual(putRes.status, 200, `${label} can PUT /api/customers/:id`);
  }

  console.log('\n── 4b. Customers are never deletable — DELETE /:id does not exist ──');

  // Product decision: a customer record must never be removed (soft or hard)
  // — orders/bills/loyalty_ledger reference it with no FK, and every
  // customer's history/loyalty standing outweighs the cost of a stale row.
  // Assert this for the highest-privilege role too, so the route can't
  // quietly come back gated behind "owner only".
  const ownerDeleteRes = await request(app).delete(`/api/customers/${custId}`).set(ownerAuth);
  assertEqual(ownerDeleteRes.status, 404, 'DELETE /api/customers/:id does not exist, even for owner');

  const stillActive = db.prepare('SELECT is_active FROM customers WHERE id = ?').get(custId) as any;
  assertEqual(stillActive.is_active, 1, 'customer row is untouched — not soft-deleted');

  console.log('\n── 5. Admin cleanup: owner only ─────────────────────────────');

  const managerCleanup = await request(app).delete('/api/customers/admin/cleanup').set(managerAuth);
  assertEqual(managerCleanup.status, 403, 'manager cannot DELETE /api/customers/admin/cleanup');

  const ownerCleanup = await request(app).delete('/api/customers/admin/cleanup').set(ownerAuth);
  assertEqual(ownerCleanup.status, 200, 'owner can DELETE /api/customers/admin/cleanup');

  console.log('\n── 6. Chef (kitchen-only role) cannot access customers ───────');

  const chefList = await request(app).get('/api/customers/').set(chefAuth);
  assertEqual(chefList.status, 403, 'chef cannot GET /api/customers/');

  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed`);
  if (results.failed > 0) {
    throw new Error(`${results.failed} customer auth assertion(s) failed`);
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('\n✅ Customer auth tests passed');
  })
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
