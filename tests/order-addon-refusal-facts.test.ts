/**
 * Add-on refusals reach the POS and support hub with the reason codes they wait for.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-addon-refusal-facts.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-addon-refusal-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

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
const { serializeOperationFailure } = require('../main/lib/operation-failure');
const { classifyOrderRequestFailure } = require('../frontend/src/lib/order-attempt');

const ADDON_GROUP_POINT = 'fc.backend.order.create.addon_group_validation';
const ADDON_ITEM_POINT = 'fc.backend.order.create.addon_item_validation';

async function main() {
  resetCounters();
  initDatabase();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?)
     ON CONFLICT(key) DO UPDATE SET value='IN', updated_at=excluded.updated_at`,
  ).run(now());
  const owner = seedOwnerUser(db);
  seedCategory(db, 'cat-addon-refusal', 'Menu');
  seedProduct(db, 'combo-burger', 'cat-addon-refusal', 'Combo Burger', 100);
  db.prepare(
    `INSERT INTO addon_groups (id, name, min_selection, max_selection, allow_multiple_quantities, is_required, is_active, created_at, updated_at)
     VALUES ('grp-size', 'Size', 1, 3, 0, 1, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active, created_at, updated_at)
     VALUES ('addon-regular', 'grp-size', 'Regular', 0, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active, created_at, updated_at)
     VALUES ('addon-retired', 'grp-size', 'Retired', 2, 0, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('combo-burger', 'grp-size')`,
  ).run();

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  try {
    assertEqualOrThrow(
      serializeOperationFailure({ capture_point: ADDON_GROUP_POINT, outcome: 'not_applied' })
        ?.reason_code,
      'order.addon_selection_required',
      'the add-on group refusal point is registered with its POS reason code',
    );
    assertEqualOrThrow(
      serializeOperationFailure({ capture_point: ADDON_ITEM_POINT, outcome: 'not_applied' })
        ?.reason_code,
      'order.addon_unavailable',
      'the add-on item refusal point is registered with its POS reason code',
    );

    const missingRequired = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'combo-burger', quantity: 1 }] },
    });
    assertEqualOrThrow(missingRequired.status, 400, 'skipping a required add-on group is refused');
    assertEqualOrThrow(
      missingRequired.data.reason_code,
      'order.addon_selection_required',
      'the POS is told the add-on selection is missing',
    );
    assertEqualOrThrow(
      missingRequired.data.stage,
      'validation',
      'the add-on group refusal is filed at validation',
    );
    assertEqualOrThrow(
      missingRequired.data.outcome,
      'not_applied',
      'the add-on group refusal is filed as not applied',
    );
    assertEqualOrThrow(
      missingRequired.data.classification,
      'expected_rejection',
      'the add-on group refusal is an expected rejection',
    );

    const unavailable = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'takeaway',
        items: [
          {
            product_id: 'combo-burger',
            quantity: 1,
            addons: [{ id: 'addon-retired', quantity: 1 }],
          },
        ],
      },
    });
    const classified = classifyOrderRequestFailure(
      { response: { status: 400, data: missingRequired.data } },
      { operation: 'order.create', correlationId: String(missingRequired.data.correlation_id) },
    );
    assertEqualOrThrow(
      classified.trusted,
      true,
      'the POS trusts the add-on group refusal instead of reporting an unconfirmed attempt',
    );
    assertEqualOrThrow(
      classified.reasonCode,
      'order.addon_selection_required',
      'the POS keeps the add-on group reason code',
    );

    assertEqualOrThrow(unavailable.status, 400, 'a retired add-on is refused');
    assertEqualOrThrow(
      unavailable.data.reason_code,
      'order.addon_unavailable',
      'the POS is told the add-on is unavailable',
    );
    assertEqualOrThrow(
      unavailable.data.stage,
      'validation',
      'the add-on item refusal is filed at validation',
    );
    assertEqualOrThrow(
      unavailable.data.outcome,
      'not_applied',
      'the add-on item refusal is filed as not applied',
    );

    // Single-line tracked add-on stock exhaustion routes through stock_validation
    // so stock_scope='addon' and stock_shortfall facts reach POS and support.
    db.prepare(
      `INSERT INTO addon_groups (id, name, min_selection, max_selection, allow_multiple_quantities, is_required, is_active, created_at, updated_at)
       VALUES ('grp-toppings', 'Toppings', 0, 5, 1, 0, 1, ?, ?)`,
    ).run(now(), now());
    db.prepare(
      `INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('combo-burger', 'grp-toppings')`,
    ).run();
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, track_inventory, stock_quantity, created_at, updated_at)
       VALUES ('addon-bacon-zero', 'grp-toppings', 'Extra Bacon', 3, 1, 1, 0, ?, ?)`,
    ).run(now(), now());
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, track_inventory, stock_quantity, created_at, updated_at)
       VALUES ('addon-cheese-partial', 'grp-toppings', 'Aged Cheese', 2, 1, 1, 1, ?, ?)`,
    ).run(now(), now());

    const outOfStockAddon = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'takeaway',
        items: [
          {
            product_id: 'combo-burger',
            quantity: 1,
            addons: [
              { id: 'addon-regular', quantity: 1 },
              { id: 'addon-bacon-zero', quantity: 1 },
            ],
          },
        ],
      },
    });
    assertEqualOrThrow(
      outOfStockAddon.status,
      400,
      'single-line zero-stock tracked add-on is refused',
    );
    assertEqualOrThrow(
      outOfStockAddon.data.reason_code,
      'order.stock_insufficient',
      'zero-stock tracked add-on emits order.stock_insufficient',
    );
    assertEqualOrThrow(
      outOfStockAddon.data.facts?.stock_scope,
      'addon',
      'zero-stock tracked add-on preserves stock_scope=addon',
    );
    assertEqualOrThrow(
      outOfStockAddon.data.facts?.stock_shortfall,
      'out_of_stock',
      'zero-stock tracked add-on preserves stock_shortfall=out_of_stock',
    );
    const classifiedOutOfStock = classifyOrderRequestFailure(
      { response: { status: 400, data: outOfStockAddon.data } },
      { operation: 'order.create', correlationId: String(outOfStockAddon.data.correlation_id) },
    );
    assertEqualOrThrow(
      classifiedOutOfStock.trusted,
      true,
      'POS trusts zero-stock tracked add-on refusal',
    );
    assertEqualOrThrow(
      classifiedOutOfStock.reasonCode,
      'order.stock_insufficient',
      'POS keeps order.stock_insufficient for zero-stock tracked add-on',
    );

    const partialStockAddon = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'takeaway',
        items: [
          {
            product_id: 'combo-burger',
            quantity: 2,
            addons: [
              { id: 'addon-regular', quantity: 1 },
              { id: 'addon-cheese-partial', quantity: 1 },
            ],
          },
        ],
      },
    });
    assertEqualOrThrow(
      partialStockAddon.status,
      400,
      'single-line partial-stock tracked add-on is refused',
    );
    assertEqualOrThrow(
      partialStockAddon.data.reason_code,
      'order.stock_insufficient',
      'partial-stock tracked add-on emits order.stock_insufficient',
    );
    assertEqualOrThrow(
      partialStockAddon.data.facts?.stock_scope,
      'addon',
      'partial-stock tracked add-on preserves stock_scope=addon',
    );
    assertEqualOrThrow(
      partialStockAddon.data.facts?.stock_shortfall,
      'partial',
      'partial-stock tracked add-on preserves stock_shortfall=partial',
    );
    const classifiedPartial = classifyOrderRequestFailure(
      { response: { status: 400, data: partialStockAddon.data } },
      { operation: 'order.create', correlationId: String(partialStockAddon.data.correlation_id) },
    );
    assertEqualOrThrow(
      classifiedPartial.trusted,
      true,
      'POS trusts partial-stock tracked add-on refusal',
    );
    assertEqualOrThrow(
      classifiedPartial.reasonCode,
      'order.stock_insufficient',
      'POS keeps order.stock_insufficient for partial-stock tracked add-on',
    );

    const posSource = fs.readFileSync(
      path.join(__dirname, '../frontend/src/app/(dashboard)/pos/page.tsx'),
      'utf8',
    );
    assertOrThrow(
      posSource.includes(ADDON_GROUP_POINT) && posSource.includes(ADDON_ITEM_POINT),
      'POS maps add-on refusals into STRUCTURED_HELP_CAPTURE_POINTS',
    );
    const supportSource = fs.readFileSync(
      path.join(__dirname, '../frontend/src/app/(dashboard)/support/page.tsx'),
      'utf8',
    );
    assertOrThrow(
      supportSource.includes(ADDON_GROUP_POINT) && supportSource.includes(ADDON_ITEM_POINT),
      'Support hub preserves add-on capture points in HELP_CAPTURE_OUTCOMES',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
