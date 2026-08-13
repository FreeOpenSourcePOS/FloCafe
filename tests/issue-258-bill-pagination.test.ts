/**
 * Integration Test: Issue #258 — bill history pagination
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-258-bill-pagination.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-258-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-258';

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { billRoutes } = require('../main/routes/bills');

function seedBill(db: any, index: number, status = 'unpaid') {
  const orderResult = db.prepare(`
    INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at)
    VALUES (?, 'owner-test-001', 'takeaway', 'completed', ?, ?, ?, ?)
  `).run(
    `ORD-258-${String(index).padStart(3, '0')}`,
    index,
    index,
    `2026-01-01 10:${String(index).padStart(2, '0')}:00`,
    `2026-01-01 10:${String(index).padStart(2, '0')}:00`,
  );
  db.prepare(`
    INSERT INTO bills (bill_number, order_id, subtotal, total, balance, payment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `INV-258-${String(index).padStart(3, '0')}`,
    orderResult.lastInsertRowid,
    index,
    index,
    index,
    status,
    `2026-01-01 10:${String(index).padStart(2, '0')}:00`,
    `2026-01-01 10:${String(index).padStart(2, '0')}:00`,
  );
}

async function main() {
  console.log('Integration Test: Issue #258 — bill history pagination');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  for (let i = 1; i <= 7; i++) {
    seedBill(db, i, i % 2 === 0 ? 'paid' : 'unpaid');
  }

  const app = createApp({ '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Scenario A: offset pagination traverses all bills ───');
    const first = await api(baseUrl, '/api/bills?per_page=3', { headers: authHeader });
    assertEqual(first.status, 200, 'A: first page succeeds');
    assertEqual(first.data.bills.length, 3, 'A: first page returns requested page size');
    assertEqual(first.data.pagination.total, 7, 'A: total count is returned');
    assertEqual(first.data.pagination.next_offset, 3, 'A: next offset advances by returned rows');
    assertEqual(first.data.pagination.has_more, true, 'A: first page reports more rows');
    assertEqual(first.data.bills.map((bill: any) => bill.bill_number).join(','), 'INV-258-007,INV-258-006,INV-258-005', 'A: first page uses stable newest-first order');

    const second = await api(baseUrl, '/api/bills?per_page=3&offset=3', { headers: authHeader });
    assertEqual(second.status, 200, 'A: second page succeeds');
    assertEqual(second.data.bills.map((bill: any) => bill.bill_number).join(','), 'INV-258-004,INV-258-003,INV-258-002', 'A: second page continues without overlap');
    assertEqual(second.data.pagination.next_offset, 6, 'A: second page next offset advances');

    const third = await api(baseUrl, '/api/bills?per_page=3&offset=6', { headers: authHeader });
    assertEqual(third.status, 200, 'A: final page succeeds');
    assertEqual(third.data.bills.map((bill: any) => bill.bill_number).join(','), 'INV-258-001', 'A: final page returns remaining row');
    assertEqual(third.data.pagination.next_offset, null, 'A: final page has no next offset');
    assertEqual(third.data.pagination.has_more, false, 'A: final page reports no more rows');

    const traversed = [...first.data.bills, ...second.data.bills, ...third.data.bills].map((bill: any) => bill.id);
    assertEqual(new Set(traversed).size, 7, 'A: traversal has no duplicate bill IDs');

    console.log('\n─── Scenario B: filters are preserved across paginated responses ───');
    const paid = await api(baseUrl, '/api/bills?status=paid&limit=2&offset=1', { headers: authHeader });
    assertEqual(paid.status, 200, 'B: filtered page succeeds');
    assertEqual(paid.data.pagination.limit, 2, 'B: limit alias sets page size');
    assertEqual(paid.data.pagination.total, 3, 'B: filtered total is returned');
    assertEqual(paid.data.bills.map((bill: any) => bill.bill_number).join(','), 'INV-258-004,INV-258-002', 'B: offset applies inside the status filter');
    assert(paid.data.bills.every((bill: any) => bill.payment_status === 'paid'), 'B: every returned bill matches the status filter');

    console.log('\n─── Scenario C: malformed pagination values are rejected ───');
    const badLimit = await api(baseUrl, '/api/bills?per_page=0', { headers: authHeader });
    assertEqual(badLimit.status, 400, 'C: non-positive per_page is rejected');
    const badOffset = await api(baseUrl, '/api/bills?offset=-1', { headers: authHeader });
    assertEqual(badOffset.status, 400, 'C: negative offset is rejected');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
