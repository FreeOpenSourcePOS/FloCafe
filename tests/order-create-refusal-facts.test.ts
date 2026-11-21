/**
 * Order-create refusals say which check refused them, including pre-check
 * idempotency/add-on validation and malformed JSON bodies.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-create-refusal-facts.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-refusal-facts-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const {
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assertEqualOrThrow,
  assertOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { malformedOrderBodyPayload } = require('../main/routes/orders');
const { classifyOrderRequestFailure } = require('../frontend/src/lib/order-attempt');

async function main() {
  resetCounters();
  initDatabase();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?)
     ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`,
  ).run(now());
  const owner = seedOwnerUser(db);
  const diagnosticRows = () =>
    (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number })
      .count;
  seedCategory(db, 'cat-refusal', 'Menu');
  seedProduct(db, 'refusal-burger', 'cat-refusal', 'Refusal Burger', 100);
  db.prepare(
    `INSERT INTO addon_groups (id, name, min_selection, max_selection, allow_multiple_quantities, is_required, is_active, created_at, updated_at)
     VALUES ('grp-opt', 'Extras', 0, 3, 1, 0, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active, created_at, updated_at)
     VALUES ('addon-cheese', 'grp-opt', 'Cheese', 20, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('refusal-burger', 'grp-opt')`,
  ).run();

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const bodyApp = express();
  bodyApp.use(express.json());
  bodyApp.use((err: any, req: any, res: any, _next: any) => {
    if (err?.type === 'entity.parse.failed') {
      return res
        .status(400)
        .json(malformedOrderBodyPayload(req) ?? { error: 'Malformed JSON request body' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  });
  const bodyServer = await startServer(bodyApp);
  try {
    const emptyOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'takeaway', items: [] },
    });
    assertEqualOrThrow(emptyOrder.status, 400, 'an order without items is refused');
    assertEqualOrThrow(
      emptyOrder.data.reason_code,
      'validation.rejected',
      'the refusal keeps its registered reason code',
    );
    assertEqualOrThrow(
      emptyOrder.data.display_code,
      'no_items',
      'the refusal says the order carried no items',
    );
    assertEqualOrThrow(
      emptyOrder.data.outcome,
      'not_applied',
      'the refusal is filed as not applied',
    );

    const longNote = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'takeaway',
        special_instructions: 'x'.repeat(300),
        items: [{ product_id: 'refusal-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(longNote.status, 400, 'an over-long order note is refused');
    assertEqualOrThrow(
      longNote.data.display_code,
      'order_notes_too_long',
      'the refusal says the order note was too long',
    );

    const badAddonQty = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'takeaway',
        items: [
          {
            product_id: 'refusal-burger',
            quantity: 1,
            addons: [{ id: 'addon-cheese', quantity: 0 }],
          },
        ],
      },
    });
    assertEqualOrThrow(badAddonQty.status, 400, 'a zero add-on quantity is refused');
    assertEqualOrThrow(
      badAddonQty.data.display_code,
      'addon_quantity_invalid',
      'pre-check add-on quantity validation emits addon_quantity_invalid',
    );

    const idemKey = 'idem-refusal-reuse-1';
    const firstOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { ...owner.authHeader, 'Idempotency-Key': idemKey },
      body: {
        type: 'takeaway',
        items: [{ product_id: 'refusal-burger', quantity: 1 }],
      },
    });
    assertEqualOrThrow(firstOrder.status, 201, 'initial order with idempotency key succeeds');

    const reusedIdem = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: { ...owner.authHeader, 'Idempotency-Key': idemKey },
      body: {
        type: 'takeaway',
        items: [{ product_id: 'refusal-burger', quantity: 2 }],
      },
    });
    assertEqualOrThrow(reusedIdem.status, 409, 'reusing an idempotency key for a new body is 409');
    assertEqualOrThrow(
      reusedIdem.data.display_code,
      'idempotency_key_reused',
      'pre-check idempotency conflict emits idempotency_key_reused',
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    const rowsBeforeMalformed = diagnosticRows();
    assertOrThrow(rowsBeforeMalformed > 0, 'authenticated refusals record diagnostic rows');

    const malformed = await api(bodyServer.baseUrl, '/api/orders', {
      method: 'POST',
      body: '{"type":"takeaway","items":[',
    });
    assertEqualOrThrow(malformed.status, 400, 'a malformed order body is refused');
    assertEqualOrThrow(
      malformed.data.reason_code,
      'validation.rejected',
      'a malformed order body is a validation rejection the POS can trust',
    );
    assertEqualOrThrow(
      malformed.data.display_code,
      'malformed_body',
      'the refusal says the body could not be parsed',
    );
    assertEqualOrThrow(
      malformed.data.outcome,
      'not_applied',
      'the malformed body refusal is filed as not applied',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEqualOrThrow(
      diagnosticRows(),
      rowsBeforeMalformed,
      'an unauthenticated malformed body writes no diagnostic row',
    );

    const classifiedOrder = classifyOrderRequestFailure(
      { response: { status: 400, data: emptyOrder.data } },
      { operation: 'order.create', correlationId: String(emptyOrder.data.correlation_id) },
    );
    assertEqualOrThrow(classifiedOrder.trusted, true, 'the client trusts the order refusal answer');
    assertEqualOrThrow(
      classifiedOrder.displayCode,
      'no_items',
      'the client keeps the refusal code for the support report',
    );
    const classifiedBody = classifyOrderRequestFailure(
      { response: { status: 400, data: malformed.data } },
      { operation: 'order.create', correlationId: String(malformed.data.correlation_id) },
    );
    assertEqualOrThrow(
      classifiedBody.trusted,
      true,
      'the client trusts a malformed body refusal instead of reporting an unconfirmed attempt',
    );

    const posSource = fs.readFileSync(
      path.join(__dirname, '../frontend/src/app/(dashboard)/pos/page.tsx'),
      'utf8',
    );
    assertOrThrow(
      posSource.includes("failure.reasonCode === 'discount.rejected' && failure.displayCode"),
      'POS scopes discountMessages lookup to discount.rejected so order.create display codes keep rejectionMessage',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => bodyServer.server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Test suite crashed:', error);
  process.exit(1);
});
