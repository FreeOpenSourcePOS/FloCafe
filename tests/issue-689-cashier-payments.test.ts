const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-689-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.7.5' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedCategory, seedProduct,
  api, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { createPaymentIdempotencyKey } = require('../frontend/src/lib/payment-idempotency');

async function main() {
  console.log('Issue #689: sequential cashier payments from an insecure LAN context');
  const db = initTestDb();
  const cashierId = 'cashier-689';
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'cashier', 1, ?, ?)
  `).run(cashierId, 'Cashier 689', 'cashier-689@test.local', bcrypt.hashSync('testpass123', 10), now(), now());
  const token = jwt.sign(
    { userId: cashierId, email: 'cashier-689@test.local', role: 'cashier' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const authHeader = { Authorization: `Bearer ${token}` };

  seedCategory(db, 'cat-689', 'Issue 689 menu');
  seedProduct(db, 'prod-689', 'cat-689', 'Issue 689 item', 10);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);
  let sequence = 0;
  const insecureContextCrypto = {
    getRandomValues(values: Uint32Array) {
      sequence += 1;
      values.fill(sequence);
      return values;
    },
  };

  try {
    for (let orderNumber = 1; orderNumber <= 2; orderNumber += 1) {
      const order = await api(baseUrl, '/api/orders', {
        method: 'POST',
        body: { type: 'takeaway', items: [{ product_id: 'prod-689', quantity: 1 }] },
        headers: authHeader,
      });
      assertEqual(order.status, 201, `cashier creates order ${orderNumber}`);

      const bill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST', body: { order_id: order.data.order.id }, headers: authHeader,
      });
      assertEqual(bill.status, 201, `cashier generates bill ${orderNumber}`);

      const idempotencyKey = createPaymentIdempotencyKey(insecureContextCrypto);
      const payment = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payments`, {
        method: 'POST',
        body: { payments: [{ method: 'card', amount: bill.data.bill.total }] },
        headers: { ...authHeader, 'Idempotency-Key': idempotencyKey },
      });
      assertEqual(payment.status, 200, `cashier pays order ${orderNumber}`);
      assertEqual(payment.data.bill.payment_status, 'paid', `order ${orderNumber} payment persists`);
    }

    assertEqual(sequence, 2, 'a fresh fallback key is generated for each payment request');
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    Date.now = () => 1;
    Math.random = () => 0.5;
    try {
      const firstLegacyKey = createPaymentIdempotencyKey({});
      const secondLegacyKey = createPaymentIdempotencyKey({});
      assertEqual(firstLegacyKey === secondLegacyKey, false, 'legacy fallback keys remain unique');
    } finally {
      Date.now = originalDateNow;
      Math.random = originalMathRandom;
    }
    const persisted = db.prepare(`
      SELECT COUNT(*) AS count
      FROM bills
      WHERE payment_status = 'paid' AND paid_amount = total
    `).get() as { count: number };
    assertEqual(persisted.count, 2, 'both cashier payments remain persisted');

    const { passed, failed } = getResults();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
