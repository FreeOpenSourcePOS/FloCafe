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
  console.log('Regression: customer soft-reactivate identity and phone filters');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', datetime('now'))").run();

  db.prepare(`
    INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run('cust-soft-1', 'Old Name', '9876543210', '+91');
  db.prepare(`
    INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run('cust-soft-2', 'Canonical Old Name', '+919988776655', '+91');

  const before = db.prepare("SELECT * FROM customers WHERE id = 'cust-soft-1'").get();
  assertEqual(before.is_active, 0, 'precondition: row starts soft-deleted');
  assertEqual(before.country_code, '+91', 'precondition: legacy country_code is +91');

  const app = createApp({ '/api/customers': customerRoutes });
  const { baseUrl } = await startServer(app);

  try {
    // Re-POST with same legacy national phone + new address. This must
    // (a) not throw a binding error, (b) reactivate the row, (c) canonicalize
    // phone/country_code, and (d) NOT silently overwrite country_code with address.
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
    assertEqual(res.data.customer.id, 'cust-soft-1', 'legacy national phone reactivation preserves customer ID');

    const after = db.prepare("SELECT * FROM customers WHERE id = 'cust-soft-1'").get();
    assertEqual(after.is_active, 1, 'row reactivated');
    assertEqual(after.phone, '+919876543210', 'legacy national phone canonicalized on reactivation');
    assertEqual(after.name, 'New Name', 'name updated');
    assertEqual(after.email, 'new@example.com', 'email updated');
    assertEqual(after.address, '123 Fake St', 'address updated to its own column, not country_code');
    assertEqual(after.country_code, '+91', 'country_code follows parsed phone, not contradictory request body');
    assert(after.country_code !== after.address, 'country_code and address columns hold different values');

    const canonicalRes = await api(baseUrl + '/api', '/customers', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Canonical New Name',
        phone: '9988776655',
        email: 'canonical@example.com',
        address: '456 Test Ave',
      },
    });

    assertEqual(canonicalRes.status, 201, `POST reactivates canonical soft-deleted customer; got ${canonicalRes.status} ${JSON.stringify(canonicalRes.data)}`);
    assertEqual(canonicalRes.data.customer.id, 'cust-soft-2', 'canonical phone reactivation preserves customer ID');

    const canonicalAfter = db.prepare("SELECT * FROM customers WHERE id = 'cust-soft-2'").get();
    assertEqual(canonicalAfter.is_active, 1, 'canonical row reactivated');
    assertEqual(canonicalAfter.phone, '+919988776655', 'canonical row keeps normalized phone');
    assertEqual(canonicalAfter.country_code, '+91', 'canonical row keeps parsed country code');

    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run('cust-invalid-active', 'Active Invalid', '1234567890', '+91', 1);
    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run('cust-invalid-inactive', 'Inactive Invalid', '2222222222', '+91', 0);
    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run('cust-valid-active', 'Active Valid', '+919999999999', '+91', 1);

    const alerts = await api(baseUrl + '/api', '/customers/alerts', {
      headers: authHeader,
    });
    assertEqual(alerts.status, 200, 'alerts endpoint returns successfully');
    assertEqual(alerts.data.invalidPhonesCount, 1, 'invalid-phone alert counts only active malformed rows');

    const invalidList = await api(baseUrl + '/api', '/customers?filter=invalid_phones', {
      headers: authHeader,
    });
    assertEqual(invalidList.status, 200, 'invalid phone list returns successfully');
    assertEqual(invalidList.data.data.length, 1, 'invalid-phone filter returns only active malformed rows');
    assertEqual(invalidList.data.data[0].id, 'cust-invalid-active', 'invalid-phone filter excludes inactive malformed rows');

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
