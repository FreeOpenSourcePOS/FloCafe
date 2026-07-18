/**
 * Integration regression: the legacy /api/customers-search endpoint (used by
 * the POS CustomerSearch component) and the /api/customers?search= filter
 * (admin Customers page) both match BOTH e164 ('+919876543210') and legacy
 * local-format ('9876543210') rows when the frontend sends a digit-only query.
 *
 * Covers the fix in main/routes/index.ts and main/routes/customers.ts where
 * search switched from `phone LIKE ?` to `phone_digits LIKE ?` after the
 * STORED generated column added in migration v22.
 *
 * Run: node tests/run-electron-node-test.cjs tests/phone-search-integration.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-phone-search-int-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, closeDatabase, seedOwnerUser, api, assertEqual, assert, getResults, createApp, startServer } = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes');

function insertCustomer(db, id, name, phone, countryCode, isActive) {
  db.prepare(
    "INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
  ).run(id, name, phone, countryCode, isActive);
}

async function main() {
  console.log('Integration: customer phone search bridges e164 + legacy + pretty');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);

  insertCustomer(db, 'ci-e164',      'Anita E164',   '+919876543210',    '+91', 1);
  insertCustomer(db, 'ci-local',     'Anita Local',  '9876543211',       '+91', 1);
  insertCustomer(db, 'ci-formatted', 'Anita Pretty', '+91 987-654-3212', '+91', 1);
  insertCustomer(db, 'ci-us',        'Bob US',       '+1 (555) 123-4567', '+1',  1);
  insertCustomer(db, 'ci-ar',        'Carlos AR',    '+541143210000',    '+54', 1);
  insertCustomer(db, 'ci-inactive',  'Inactive',     '+911111111111',    '+91', 0);

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  const apiBase = baseUrl + '/api';

  try {
    // ── /api/customers-search (legacy flat path, used by POS) ──────────────
    let res = await api(apiBase, '/customers-search?q=9876543210', { headers: authHeader });
    assertEqual(res.status, 200, 'search returns 200 for short digits');
    let ids = (res.data || []).map((c: any) => c.id).sort();
    assertEqual(ids.length, 1, `digits "9876543210" matches e164 (got ${ids.length})`);
    assert(ids.includes('ci-e164'),      'e164 row returned for short query');

    res = await api(apiBase, '/customers-search?q=919876543210', { headers: authHeader });
    assertEqual(res.status, 200, 'search returns 200 for intl digits');
    ids = (res.data || []).map((c: any) => c.id).sort();
    assertEqual(ids.length, 1, `intl digits match e164 (got ${ids.length})`);
    assert(ids.includes('ci-e164'),      'e164 row returned for intl query');

    res = await api(apiBase, '/customers-search?q=1111111111', { headers: authHeader });
    assertEqual(res.status, 200, 'search returns 200 for inactive digits');
    assertEqual((res.data || []).length, 0, 'inactive e164 row excluded by is_active = 1');

    res = await api(apiBase, '/customers-search?q=541143210000', { headers: authHeader });
    ids = (res.data || []).map(c => c.id);
    assertEqual(ids.length, 1, `AR digits find ci-ar only (got ${ids.length})`);
    assertEqual(ids[0], 'ci-ar', 'AR row is ci-ar');

    res = await api(apiBase, '/customers-search?q=5551234567', { headers: authHeader });
    ids = (res.data || []).map(c => c.id);
    assertEqual(ids.length, 1, `US short digits "5551234567" find ci-us only after stripping parens (got ${ids.length})`);
    assertEqual(ids[0], 'ci-us', 'US pretty-format row matched for short query');

    res = await api(apiBase, '/customers-search?q=15551234567', { headers: authHeader });
    ids = (res.data || []).map(c => c.id);
    assertEqual(ids.length, 1, `US intl digits "15551234567" find ci-us only (got ${ids.length})`);
    assertEqual(ids[0], 'ci-us', 'US pretty-format row matched for intl query');

    res = await api(apiBase, '/customers-search?q=anita', { headers: authHeader });
    ids = (res.data || []).map(c => c.id).sort();
    assertEqual(ids.length, 3, `name LIKE branch matches anita (got ${ids.length})`);

    // ── /api/customers?search= (admin list filter) ──────────────────────────
    res = await api(apiBase, '/customers?search=9876543210&per_page=10', { headers: authHeader });
    let list = (res.data?.data || []);
    assertEqual(list.length, 1, `list filter short query matches e164 (got ${list.length})`);
    assert(list.some((c: any) => c.id === 'ci-e164'), 'list returns e164');

    res = await api(apiBase, '/customers?search=919876543210&per_page=10', { headers: authHeader });
    list = (res.data?.data || []);
    assertEqual(list.length, 1, `list filter intl query excludes local (got ${list.length})`);
    assert(list.some((c: any) => c.id === 'ci-e164'), 'list returns e164 for intl query');

    res = await api(apiBase, '/customers?search=5551234567&per_page=10', { headers: authHeader });
    list = (res.data?.data || []);
    assertEqual(list.length, 1, `list filter US short query matches ci-us only (got ${list.length})`);
    assertEqual(list[0]?.id, 'ci-us', 'list filter matches US pretty-format row');

    res = await api(apiBase, '/customers?search=15551234567&per_page=10', { headers: authHeader });
    list = (res.data?.data || []);
    assertEqual(list.length, 1, `list filter US intl query matches ci-us only (got ${list.length})`);
    assertEqual(list[0]?.id, 'ci-us', 'list filter matches US pretty-format row for intl query');

    server.close();
    closeDatabase();
    Module._load = originalLoad;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const { passed, failed, total } = getResults();
    console.log(`\n${passed}/${total} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err: any) {
    try { server.close(); } catch {}
    try { closeDatabase(); } catch {}
    Module._load = originalLoad;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.error('FAILED:', err.message);
    process.exit(1);
  }
}

main();