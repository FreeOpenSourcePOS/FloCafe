/** Issue #255 regression coverage for append idempotency replay and payload mismatch rejection. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-255-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { getJWTSecret } = require('../main/routes/auth');

function seedWaiterUser(db: any) {
  const userId = 'waiter-255';
  db.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'waiter', 1, ?, ?)
  `).run(userId, 'Issue 255 Waiter', 'waiter-255@test.local', bcrypt.hashSync('testpass123', 10), now(), now());
  const token = jwt.sign({ userId, email: 'waiter-255@test.local', role: 'waiter' }, getJWTSecret(), { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  console.log('Issue #255 append idempotency contract');
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const waiterAuth = seedWaiterUser(db);
  seedCategory(db, 'cat-255', 'Issue 255 menu');
  seedProduct(db, 'prod-255-base', 'cat-255', 'Issue 255 base', 100);
  seedProduct(db, '001', 'cat-255', 'Issue 255 append', 25);
  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-255-base', quantity: 1 }] },
      headers: authHeader,
    });
    assertEqual(created.status, 201, 'append replay fixture order is created');
    const orderId = created.data.order.id;
    const appendBody = {
      items: [{
        product_id: '001',
        quantity: 1,
        addons: [{ id: '001', name: 'Extra 001', price: 3, quantity: 1 }],
        special_instructions: 'response-loss fixture',
      }],
      special_instructions: 'append note',
    };
    const retryHeaders = { ...authHeader, 'Idempotency-Key': 'issue-255-append-retry' };

    const committedResponse = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: appendBody,
      headers: retryHeaders,
    });
    // Deliberately do not use committedResponse.data below: this models a
    // renderer losing the response after the transaction committed.
    const countAfterCommit = db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?').get(orderId) as { count: number };

    db.prepare('UPDATE order_idempotency SET user_id = \'legacy\' WHERE idempotency_key = ?').run('issue-255-append-retry');
    const unauthorizedReplay = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: appendBody,
      headers: { ...waiterAuth, 'Idempotency-Key': 'issue-255-append-retry' },
    });
    const countAfterUnauthorized = db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?').get(orderId) as { count: number };
    assertEqual(unauthorizedReplay.status, 403, 'a waiter cannot replay a legacy append record for another owner\'s order');
    assertEqual(countAfterUnauthorized.count, countAfterCommit.count, 'unauthorized replay does not expose or mutate the order');

    const whitespaceOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-255-base', quantity: 1 }] },
      headers: authHeader,
    });
    const whitespaceBefore = db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?').get(whitespaceOrder.data.order.id) as { count: number };
    const blankKey = await api(baseUrl, `/api/orders/${whitespaceOrder.data.order.id}/items`, {
      method: 'POST',
      body: appendBody,
      headers: { ...authHeader, 'Idempotency-Key': '   ' },
    });
    const countAfterBlankKey = db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?').get(whitespaceOrder.data.order.id) as { count: number };
    assertEqual(blankKey.status, 200, 'a supplied whitespace-only idempotency key is treated as absent');
    assertEqual(countAfterBlankKey.count, whitespaceBefore.count + 1, 'a whitespace-only key follows the non-idempotent append path');

    const malformedKey = await api(baseUrl, `/api/orders/${whitespaceOrder.data.order.id}/items`, {
      method: 'POST',
      body: appendBody,
      headers: { ...authHeader, 'Idempotency-Key': 'invalid key' },
    });
    const tooLongKey = await api(baseUrl, `/api/orders/${whitespaceOrder.data.order.id}/items`, {
      method: 'POST',
      body: appendBody,
      headers: { ...authHeader, 'Idempotency-Key': 'x'.repeat(129) },
    });
    const countAfterInvalidKeys = db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?').get(whitespaceOrder.data.order.id) as { count: number };
    assertEqual(malformedKey.status, 400, 'a non-whitespace invalid idempotency key is rejected');
    assertEqual(tooLongKey.status, 400, 'an overlong idempotency key is rejected');
    assertEqual(countAfterInvalidKeys.count, whitespaceBefore.count + 1, 'invalid idempotency keys do not mutate the order');

    db.prepare('INSERT INTO bills (bill_number, order_id, split_group_id) VALUES (?, ?, ?)').run('BILL-255-SPLIT', orderId, 'split-255');
    const replayedResponse = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: appendBody,
      headers: retryHeaders,
    });
    const countAfterReplay = db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?').get(orderId) as { count: number };

    assertEqual(committedResponse.status, 200, 'first append commits successfully');
    assertEqual(replayedResponse.status, 200, 'retry with the same key replays the committed append after a later split');
    assertEqual(countAfterReplay.count, countAfterCommit.count, 'response-loss retry does not duplicate order items');
    assertEqual(replayedResponse.data.order.items.length, committedResponse.data.order.items.length, 'replay returns the original append response');
    const addonRow = db.prepare(`
      SELECT oia.addon_id, oia.addon_name, oia.price, oia.quantity
      FROM order_item_addons oia
      JOIN order_items oi ON oi.id = oia.order_item_id
      WHERE oi.order_id = ? AND oi.product_id = '001'
    `).get(orderId) as { addon_id: string | null; addon_name: string; price: number; quantity: number };
    assertEqual(addonRow.addon_name, 'Extra 001', 'append replay fixture preserves the add-on snapshot');
    assertEqual(addonRow.quantity, 1, 'append replay fixture preserves add-on quantity');

    const mismatched = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      body: { ...appendBody, items: [{ ...appendBody.items[0], quantity: 2 }] },
      headers: retryHeaders,
    });
    const countAfterMismatch = db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?').get(orderId) as { count: number };
    assertEqual(mismatched.status, 409, 'reusing an append key for a different payload is rejected');
    assertEqual(countAfterMismatch.count, countAfterReplay.count, 'mismatched append rejection does not mutate the order');
    assert(
      String(mismatched.data.error || '').includes('different order request'),
      'mismatched append response explains the idempotency conflict',
    );
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
