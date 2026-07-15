/**
 * Regression: customer soft-reactivate UPDATE binds correctly.
 *
 * Backs the fix in main/routes/customers.ts where the soft-reactivate
 * UPDATE in POST /customers added a country_code placeholder but
 * didn't add the matching binding — old users re-creating a soft-
 * deleted customer with the same phone would hit a better-sqlite3
 * "Too few parameter values" or silently bind address into
 * country_code.
 *
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/customer-soft-reactivate-bindings.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-reactivate-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, closeDatabase, seedOwnerUser, api, assertEqual, assert, getResults, createApp, startServer } = require('./helpers/test-setup');
const { customerRoutes } = require('../main/routes/customers');

async function main() {
  console.log('Regression: customer soft-reactivate binding count');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);

  db.prepare(`
    INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run('cust-soft-1', 'Old Name', '9876543210', '+91');

  const before = db.prepare("SELECT * FROM customers WHERE id = 'cust-soft-1'").get();
  assertEqual(before.is_active, 0, 'precondition: row starts soft-deleted');
  assertEqual(before.country_code, '+91', 'precondition: legacy country_code is +91');

  const app = createApp({ '/api/customers': customerRoutes });
  const { baseUrl } = await startServer(app);

  try {
    // Re-POST with same phone + new country_code + new address. This must
    // (a) not throw a binding error, (b) reactivate the row, (c) update
    // country_code, (d) NOT silently overwrite country_code with address.
    const res = await api(baseUrl + '/api', '/customers', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'New Name',
        phone: '9876543210',
        email: 'new@example.com',
        address: '123 Fake St',
        country_code: '+54',
      },
    });

    assertEqual(res.status, 201, `POST reactivates soft-deleted customer (no binding error); got ${res.status} ${JSON.stringify(res.data)}`);

    const after = db.prepare("SELECT * FROM customers WHERE id = 'cust-soft-1'").get();
    assertEqual(after.is_active, 1, 'row reactivated');
    assertEqual(after.name, 'New Name', 'name updated');
    assertEqual(after.email, 'new@example.com', 'email updated');
    assertEqual(after.address, '123 Fake St', 'address updated to its own column, not country_code');
    assertEqual(after.country_code, '+54', 'country_code updated to Argentina dial code (not silently overwritten)');
    assert(after.country_code !== after.address, 'country_code and address columns hold different values');

    console.log('\n[DB] Database closed');
    closeDatabase();
    Module._load = originalLoad;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const { passed, failed, total } = getResults();
    console.log(`\n${passed}/${total} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err: any) {
    console.error('Regression failed:', err.message);
    closeDatabase();
    Module._load = originalLoad;
    process.exit(1);
  }
}

main();