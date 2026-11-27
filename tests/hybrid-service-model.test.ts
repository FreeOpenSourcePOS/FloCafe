/**
 * Hybrid service model: ready-made items skip the kitchen, and hybrid venues pay by order type.
 *
 * Covers:
 * - products.requires_kitchen create/update/serialize and validation
 * - order lines snapshot the flag; ready-made lines never wait on the kitchen
 * - KDS orders and items exclude ready-made lines; ready-made-only orders never reach the board
 * - order status derivation and KOT eligibility ignore ready-made lines
 * - later catalog edits do not rewrite existing lines
 * - service_model 'hybrid' settings validation and per-order-type billing
 *
 * Usage: node tests/run-electron-node-test.cjs tests/hybrid-service-model.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-hybrid-service-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      powerMonitor: { on: () => {} },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-hybrid-service-model';
process.env.KDS_PORT = '0';

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedTable,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { startKdsServer, stopKdsServer, getKdsPort } = require('../main/kds-server');
const { stopScheduledOrderSweep } = require('../main/services/scheduled-orders');
const { ACTIVE_RELEASED_KDS_ORDER_IDS_SQL, orderHasKitchenWorkSql } = require('../main/db');
const { isOrderPrepaid } = require('../main/services/service-model');
const { selectBoardEligibleOrderPage } = require('../main/services/customer-display-tokens');
const { deriveOrderStatusFromItems } = require('../shared/order-item-status');
const { isKotItemPending } = require('../shared/print/document');
const bcrypt = require('bcryptjs');
const { WebSocket } = require('ws');
const { once } = require('node:events');

function setStoreSetting(db: any, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

async function main() {
  console.log('='.repeat(66));
  console.log('Hybrid service model: ready-made items and per-order-type billing');
  console.log('='.repeat(66));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  setStoreSetting(db, 'country', 'US');
  setStoreSetting(db, 'currency', 'USD');
  setStoreSetting(db, 'timezone', 'America/New_York');
  setStoreSetting(db, 'kds_enabled', 'true');
  seedCategory(db, 'cat-hy', 'Hybrid Menu');
  seedTable(db, 'tbl-hy-1', 1, 4);

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function req(options: { path: string; method?: string; body?: any }) {
    const { path: urlPath, ...rest } = options;
    const res = await api(baseUrl, urlPath, { ...rest, headers: owner.authHeader });
    return { status: res.status, body: res.data };
  }

  function itemsOf(orderId: string | number) {
    return db
      .prepare('SELECT product_id, status, requires_kitchen FROM order_items WHERE order_id = ?')
      .all(orderId) as Array<{ product_id: string; status: string; requires_kitchen: number }>;
  }

  try {
    console.log('\n--- 1. Catalog flag ---');
    const dish = await req({
      path: '/api/products',
      method: 'POST',
      body: { name: 'Grilled Fish', price: 18, category_id: 'cat-hy' },
    });
    assertEqualOrThrow(dish.status, 201, 'kitchen dish is created');
    assertEqualOrThrow(dish.body.product?.requires_kitchen, true, 'new products go to the kitchen');

    const cola = await req({
      path: '/api/products',
      method: 'POST',
      body: { name: 'Bottled Cola', price: 3, category_id: 'cat-hy', requires_kitchen: false },
    });
    assertEqualOrThrow(cola.status, 201, 'ready-made item is created');
    assertEqualOrThrow(cola.body.product?.requires_kitchen, false, 'ready-made flag is stored');
    const dishId = dish.body.product.id;
    const colaId = cola.body.product.id;

    const badFlag = await req({
      path: '/api/products',
      method: 'POST',
      body: { name: 'Bad Flag', price: 1, category_id: 'cat-hy', requires_kitchen: 'no' },
    });
    assertEqualOrThrow(badFlag.status, 400, 'non-boolean requires_kitchen is rejected');

    const listed = await req({ path: '/api/products', method: 'GET' });
    const listedCola = (listed.body.products ?? listed.body.data ?? listed.body).find?.(
      (p: any) => p.id === colaId,
    );
    assertEqualOrThrow(listedCola?.requires_kitchen, false, 'catalog list exposes the flag');

    console.log('\n--- 2. Orders snapshot the flag ---');
    const readyOnly = await req({
      path: '/api/orders',
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: colaId, quantity: 2 }] },
    });
    assertEqualOrThrow(readyOnly.status, 201, 'ready-made-only order is created');
    const readyOnlyId = readyOnly.body.order.id;
    assertEqualOrThrow(
      JSON.stringify(itemsOf(readyOnlyId).map((i) => [i.status, i.requires_kitchen])),
      JSON.stringify([['served', 0]]),
      'ready-made line is served and not a kitchen line',
    );

    const kitchenOnly = await req({
      path: '/api/orders',
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: dishId, quantity: 1 }] },
    });
    const kitchenOnlyId = kitchenOnly.body.order.id;
    assertEqualOrThrow(
      JSON.stringify(itemsOf(kitchenOnlyId).map((i) => [i.status, i.requires_kitchen])),
      JSON.stringify([['pending', 1]]),
      'kitchen line stays pending',
    );

    const mixed = await req({
      path: '/api/orders',
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: dishId, quantity: 1 },
          { product_id: colaId, quantity: 1 },
        ],
      },
    });
    const mixedId = mixed.body.order.id;
    assertEqualOrThrow(itemsOf(mixedId).length, 2, 'mixed order keeps both lines');

    console.log('\n--- 3. KDS excludes ready-made work ---');
    const kds = await req({ path: '/api/kds/orders', method: 'GET' });
    assertEqualOrThrow(kds.status, 200, 'KDS orders load');
    const kdsById = new Map<string, any>(kds.body.orders.map((o: any) => [String(o.id), o]));
    assertOrThrow(!kdsById.has(String(readyOnlyId)), 'ready-made-only order is not on the KDS');
    assertOrThrow(kdsById.has(String(kitchenOnlyId)), 'kitchen-only order is on the KDS');
    const mixedOnKds = kdsById.get(String(mixedId));
    assertOrThrow(!!mixedOnKds, 'mixed order is on the KDS');
    assertEqualOrThrow(
      JSON.stringify((mixedOnKds?.items ?? []).map((i: any) => i.product_id)),
      JSON.stringify([dishId]),
      'only the kitchen line is shown for a mixed order',
    );

    const kitchenSqlRows = db
      .prepare(`SELECT id FROM orders o WHERE ${orderHasKitchenWorkSql('o')}`)
      .all()
      .map((row: any) => String(row.id));
    assertOrThrow(
      !kitchenSqlRows.includes(String(readyOnlyId)),
      'kitchen-work filter drops the ready-made-only order',
    );
    assertOrThrow(
      kitchenSqlRows.includes(String(mixedId)) && kitchenSqlRows.includes(String(kitchenOnlyId)),
      'kitchen-work filter keeps orders with a kitchen line',
    );

    console.log('\n--- 4. Status derivation and KOT eligibility ---');
    assertEqualOrThrow(
      deriveOrderStatusFromItems(itemsOf(readyOnlyId)),
      null,
      'ready-made-only order derives no kitchen status',
    );
    assertEqualOrThrow(
      deriveOrderStatusFromItems(itemsOf(mixedId).map((i) => ({ ...i, quantity: 1 }))),
      'pending',
      'a served ready-made line does not start a mixed order',
    );
    assertEqualOrThrow(
      deriveOrderStatusFromItems([{ status: 'ready', quantity: 1 }]),
      'ready',
      'legacy rows without the flag still derive normally',
    );
    assertOrThrow(
      itemsOf(readyOnlyId).every((i) => !isKotItemPending(i.status)),
      'ready-made lines are never pending for a kitchen ticket',
    );
    assertOrThrow(
      itemsOf(kitchenOnlyId).every((i) => isKotItemPending(i.status)),
      'kitchen lines still print on the kitchen ticket',
    );

    console.log('\n--- 5. Catalog edits do not rewrite history ---');
    const flip = await req({
      path: `/api/products/${colaId}`,
      method: 'PUT',
      body: { requires_kitchen: true },
    });
    assertEqualOrThrow(flip.status, 200, 'flag can be flipped');
    assertEqualOrThrow(flip.body.product?.requires_kitchen, true, 'updated flag is returned');
    assertEqualOrThrow(
      itemsOf(readyOnlyId)[0].requires_kitchen,
      0,
      'an existing line keeps the flag it was sold with',
    );
    const afterFlip = await req({
      path: '/api/orders',
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: colaId, quantity: 1 }] },
    });
    assertEqualOrThrow(
      itemsOf(afterFlip.body.order.id)[0].status,
      'pending',
      'new lines follow the current flag',
    );

    console.log('\n--- 6. Hybrid billing and settings ---');
    const badModel = await req({
      path: '/api/settings/business',
      method: 'PUT',
      body: { service_model: 'banquet' },
    });
    assertEqualOrThrow(badModel.status, 400, 'unknown service model is rejected');

    setStoreSetting(db, 'billing_type', 'postpaid');
    setStoreSetting(db, 'service_model', 'finedine');
    assertEqualOrThrow(isOrderPrepaid(db, 'takeaway'), false, 'postpaid venue stays postpaid');
    setStoreSetting(db, 'billing_type', 'prepaid');
    setStoreSetting(db, 'service_model', 'qsr');
    assertEqualOrThrow(isOrderPrepaid(db, 'dine_in'), true, 'prepaid venue stays prepaid');

    setStoreSetting(db, 'tables_required', 'false');
    const hybrid = await req({
      path: '/api/settings/business',
      method: 'PUT',
      body: { service_model: 'hybrid' },
    });
    assertEqualOrThrow(hybrid.status, 200, 'hybrid can be enabled');
    assertEqualOrThrow(hybrid.body.service_model, 'hybrid', 'service model is reported');
    assertEqualOrThrow(hybrid.body.tables_required, true, 'hybrid keeps tables for dine-in');
    assertEqualOrThrow(isOrderPrepaid(db, 'takeaway'), true, 'hybrid counter orders are prepaid');
    assertEqualOrThrow(isOrderPrepaid(db, 'delivery'), true, 'hybrid delivery orders are prepaid');
    assertEqualOrThrow(isOrderPrepaid(db, 'dine_in'), false, 'hybrid table orders are postpaid');

    // F-09: Partial business update and wildcard setting update cannot disable tables_required in hybrid mode
    const partialBusiness = await req({
      path: '/api/settings/business',
      method: 'PUT',
      body: { tables_required: false },
    });
    assertEqualOrThrow(partialBusiness.status, 200, 'partial business update succeeds');
    assertEqualOrThrow(
      partialBusiness.body.tables_required,
      true,
      'partial PUT /settings/business keeps tables_required=true in hybrid mode',
    );
    const wildcardTables = await req({
      path: '/api/settings/tables_required',
      method: 'PUT',
      body: { value: 'false' },
    });
    assertEqualOrThrow(wildcardTables.status, 200, 'wildcard tables_required update succeeds');
    assertEqualOrThrow(
      wildcardTables.body.setting?.value,
      'true',
      'PUT /settings/tables_required coerces to true in hybrid mode',
    );

    console.log('\n--- 7. Standalone KDS excludes ready-made lines & category routing (F-03) ---');
    // Flip cola back to ready-made in its own drinks category for station routing checks
    seedCategory(db, 'cat-drinks', 'Ready Drinks');
    await req({
      path: `/api/products/${colaId}`,
      method: 'PUT',
      body: { requires_kitchen: false, category_id: 'cat-drinks' },
    });
    const water = await req({
      path: '/api/products',
      method: 'POST',
      body: { name: 'Bottled Water', price: 2, category_id: 'cat-drinks', requires_kitchen: false },
    });
    assertEqualOrThrow(water.status, 201, 'second ready-made item created');
    const waterId = water.body.product.id;

    db.prepare(
      `INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
       VALUES ('st-drinks', 'Drinks Station', ?, 1, ?, ?)`,
    ).run(JSON.stringify(['cat-drinks']), now(), now());
    const chefPass = bcrypt.hashSync('ChefPass123!', 10);
    db.prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, station_assignments_configured, created_at, updated_at)
       VALUES ('chef-drinks', 'Drinks Chef', 'drinks-chef@flo.local', ?, 'chef', 1, 1, ?, ?)`,
    ).run(chefPass, now(), now());
    db.prepare(
      `INSERT INTO station_users (user_id, station_id, created_at) VALUES ('chef-drinks', 'st-drinks', ?)`,
    ).run(now());

    const routedMixed = await req({
      path: '/api/orders',
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: dishId, quantity: 1 },
          { product_id: colaId, quantity: 1 },
        ],
      },
    });
    assertEqualOrThrow(routedMixed.status, 201, 'mixed takeaway order created for KDS checks');
    const routedMixedId = routedMixed.body.order.id;

    await startKdsServer();
    const kdsBaseUrl = `http://127.0.0.1:${getKdsPort()}`;

    const standaloneAll = await api(kdsBaseUrl, '/api/kds/orders', { headers: owner.authHeader });
    assertEqualOrThrow(standaloneAll.status, 200, 'standalone KDS orders load');
    const standaloneMixed = standaloneAll.data.orders.find(
      (o: any) => String(o.id) === String(routedMixedId),
    );
    assertOrThrow(!!standaloneMixed, 'mixed order appears on standalone KDS');
    assertEqualOrThrow(
      JSON.stringify(standaloneMixed.items.map((i: any) => i.product_id)),
      JSON.stringify([dishId]),
      'standalone KDS hides ready-made items on mixed orders',
    );
    assertOrThrow(
      !standaloneAll.data.orders.some((o: any) => String(o.id) === String(readyOnlyId)),
      'standalone KDS hides ready-made-only orders',
    );

    // Drinks-only station must not match the mixed takeaway order via its ready-made cola
    const drinksChefLogin = await api(kdsBaseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'drinks-chef@flo.local', password: 'ChefPass123!' },
    });
    assertEqualOrThrow(drinksChefLogin.status, 200, 'drinks chef logs into standalone KDS');
    const drinksChefAuth = { Authorization: `Bearer ${drinksChefLogin.data.access_token}` };
    const standaloneDrinks = await api(kdsBaseUrl, '/api/kds/orders', { headers: drinksChefAuth });
    assertEqualOrThrow(standaloneDrinks.status, 200, 'drinks chef standalone KDS loads');
    assertOrThrow(
      !standaloneDrinks.data.orders.some((o: any) => String(o.id) === String(routedMixedId)),
      'standalone KDS does not route tableless order by ready-made category',
    );
    const mainDrinks = await req({
      path: '/api/kds/orders?station_id=st-drinks',
      method: 'GET',
    });
    assertEqualOrThrow(mainDrinks.status, 200, 'main KDS station-filtered query loads');
    assertOrThrow(
      !mainDrinks.body.orders.some((o: any) => String(o.id) === String(routedMixedId)),
      'main KDS does not route tableless order by ready-made category',
    );

    console.log('\n--- 8. Customer Display keeps paid prepaid mixed orders pending (F-04) ---');
    const prepaidMixed = await req({
      path: '/api/orders',
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: dishId, quantity: 1 },
          { product_id: colaId, quantity: 1 },
        ],
      },
    });
    assertEqualOrThrow(prepaidMixed.status, 201, 'prepaid mixed order created');
    const prepaidMixedId = prepaidMixed.body.order.id;
    const prepaidBill = await req({
      path: '/api/bills/generate',
      method: 'POST',
      body: { order_id: prepaidMixedId },
    });
    assertEqualOrThrow(prepaidBill.status, 201, 'prepaid mixed bill generated');
    const prepaidPay = await req({
      path: `/api/bills/${prepaidBill.body.bill.id}/payment`,
      method: 'POST',
      body: { method: 'card', amount: prepaidBill.body.bill.total },
    });
    assertEqualOrThrow(prepaidPay.status, 200, 'prepaid mixed bill paid');
    const boardPage = selectBoardEligibleOrderPage(db, {
      statuses: ['pending', 'preparing', 'ready'],
      orderTypes: ['takeaway'],
      limit: 100,
    });
    const projectedPrepaid = boardPage.pageRows.find(
      (o: any) => String(o.id) === String(prepaidMixedId),
    );
    assertEqualOrThrow(
      projectedPrepaid?.status,
      'pending',
      'paid prepaid mixed order projects pending (not preparing) before kitchen starts',
    );

    console.log('\n--- 9. All 4 KDS status mutation transports reject ready-made items (F-05) ---');
    const routedItems = db
      .prepare(
        'SELECT id, product_id, requires_kitchen, status FROM order_items WHERE order_id = ?',
      )
      .all(routedMixedId) as Array<{
      id: number;
      product_id: string;
      requires_kitchen: number;
      status: string;
    }>;
    const readyItemRow = routedItems.find((i) => i.requires_kitchen === 0)!;
    const kitchenItemRow = routedItems.find((i) => i.requires_kitchen === 1)!;

    const patchOrderItem = await req({
      path: `/api/order-items/${readyItemRow.id}/status`,
      method: 'PATCH',
      body: { status: 'pending' },
    });
    assertEqualOrThrow(
      patchOrderItem.status,
      400,
      'PATCH /api/order-items/:id/status rejects ready-made item',
    );

    const patchMainKds = await req({
      path: `/api/kds/items/${readyItemRow.id}/status`,
      method: 'PATCH',
      body: { status: 'preparing', expected_status: 'served' },
    });
    assertEqualOrThrow(
      patchMainKds.status,
      400,
      'PATCH /api/kds/items/:id/status rejects ready-made item',
    );

    const patchStandaloneKds = await api(kdsBaseUrl, `/api/kds/items/${readyItemRow.id}/status`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'ready', expected_status: 'served' },
    });
    assertEqualOrThrow(
      patchStandaloneKds.status,
      400,
      'standalone PATCH /api/kds/items/:id/status rejects ready-made item',
    );

    const ownerToken = String(owner.authHeader.Authorization).replace(/^Bearer\s+/, '');
    const ws = new WebSocket(`ws://127.0.0.1:${getKdsPort()}/kds`);
    await once(ws, 'open');
    const wsWaitFor = (types: string[]) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${types.join('/')}`)),
          5000,
        );
        const onMsg = (raw: any) => {
          const msg = JSON.parse(raw.toString());
          if (types.includes(msg.type)) {
            clearTimeout(timer);
            ws.off('message', onMsg);
            resolve(msg);
          }
        };
        ws.on('message', onMsg);
      });
    const authOkPromise = wsWaitFor(['auth_success']);
    ws.send(JSON.stringify({ type: 'auth', token: ownerToken }));
    await authOkPromise;
    const wsErrorPromise = wsWaitFor(['error', 'status_updated']);
    ws.send(
      JSON.stringify({
        type: 'status_update',
        order_item_id: readyItemRow.id,
        status: 'pending',
      }),
    );
    const wsReply = await wsErrorPromise;
    ws.close();
    await once(ws, 'close');
    assertEqualOrThrow(
      wsReply.type,
      'error',
      'KDS WebSocket status_update rejects ready-made item',
    );

    const readyAfterAttempts = db
      .prepare('SELECT status FROM order_items WHERE id = ?')
      .get(readyItemRow.id) as { status: string };
    assertEqualOrThrow(
      readyAfterAttempts.status,
      'served',
      'ready-made item remains served after all 4 rejected KDS status writes',
    );

    const patchKitchenItem = await req({
      path: `/api/order-items/${kitchenItemRow.id}/status`,
      method: 'PATCH',
      body: { status: 'preparing' },
    });
    assertEqualOrThrow(patchKitchenItem.status, 200, 'updating kitchen item succeeds');
    assertEqualOrThrow(
      JSON.stringify((patchKitchenItem.body.order?.items ?? []).map((i: any) => i.product_id)),
      JSON.stringify([dishId]),
      'PATCH /api/order-items/:id/status response omits ready-made items',
    );

    console.log(
      '\n--- 10. Backend /api/printers/print-kot skips ready-made-only orders without printer (F-06) ---',
    );
    const rmKotRes = await req({
      path: '/api/printers/print-kot',
      method: 'POST',
      body: { orderId: readyOnlyId },
    });
    assertEqualOrThrow(
      rmKotRes.status,
      200,
      'ready-made-only print-kot returns 200 without host printer',
    );
    assertEqualOrThrow(
      rmKotRes.body.skipped,
      true,
      'ready-made-only print-kot reports skipped: true',
    );

    const kitchenKotRes = await req({
      path: '/api/printers/print-kot',
      method: 'POST',
      body: { orderId: kitchenOnlyId },
    });
    assertEqualOrThrow(
      kitchenKotRes.status,
      400,
      'kitchen order print-kot still requires a configured printer',
    );

    console.log('\n--- 11. Refund/void adjustment rows stay off KDS (F-07) ---');
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
      bcrypt.hashSync('1234', 10),
      owner.userId,
    );

    // 11a. Voiding an in-progress kitchen item sets void_adjustment requires_kitchen = 0
    const voidRes = await req({
      path: `/api/orders/${routedMixedId}/items/${kitchenItemRow.id}/cancel`,
      method: 'PATCH',
      body: { reason: 'Customer changed mind', override_pin: '1234' },
    });
    assertEqualOrThrow(voidRes.status, 200, 'kitchen item void succeeds');
    const voidAdj = db
      .prepare(
        "SELECT requires_kitchen FROM order_items WHERE order_id = ? AND status = 'void_adjustment'",
      )
      .get(routedMixedId) as { requires_kitchen: number } | undefined;
    assertEqualOrThrow(
      voidAdj?.requires_kitchen,
      0,
      'void void_adjustment row has requires_kitchen = 0',
    );

    // 11b. Refunding 1 line of a 2-line paid ready-made-only order never leaks into KDS or ACTIVE_RELEASED_KDS_ORDER_IDS_SQL
    const rmTwoLine = await req({
      path: '/api/orders',
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: colaId, quantity: 2 },
          { product_id: waterId, quantity: 1 },
        ],
      },
    });
    assertEqualOrThrow(rmTwoLine.status, 201, '2-line ready-made order created');
    const rmTwoLineId = rmTwoLine.body.order.id;
    const rmBill = await req({
      path: '/api/bills/generate',
      method: 'POST',
      body: { order_id: rmTwoLineId },
    });
    assertEqualOrThrow(rmBill.status, 201, 'ready-made bill generated');
    const rmPay = await req({
      path: `/api/bills/${rmBill.body.bill.id}/payment`,
      method: 'POST',
      body: { method: 'card', amount: rmBill.body.bill.total },
    });
    assertEqualOrThrow(rmPay.status, 200, 'ready-made bill paid');
    const rmColaLine = db
      .prepare('SELECT id, total FROM order_items WHERE order_id = ? AND product_id = ?')
      .get(rmTwoLineId, colaId) as { id: number; total: number };
    const rmRefund = await req({
      path: '/api/refunds',
      method: 'POST',
      body: {
        bill_id: rmBill.body.bill.id,
        order_item_id: rmColaLine.id,
        amount: rmColaLine.total,
        method: 'card',
        reason: 'Warm drink',
        approver_id: owner.userId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(rmRefund.status, 201, 'ready-made item refund succeeds');
    const refundAdj = db
      .prepare(
        "SELECT requires_kitchen FROM order_items WHERE order_id = ? AND status = 'void_adjustment'",
      )
      .get(rmTwoLineId) as { requires_kitchen: number } | undefined;
    assertEqualOrThrow(
      refundAdj?.requires_kitchen,
      0,
      'refund void_adjustment row has requires_kitchen = 0',
    );
    const hasKitchenAfterRefund = db
      .prepare(`SELECT id FROM orders o WHERE o.id = ? AND ${orderHasKitchenWorkSql('o')}`)
      .get(rmTwoLineId);
    assertOrThrow(
      !hasKitchenAfterRefund,
      'orderHasKitchenWorkSql stays false after refunding a ready-made line',
    );
    const activeIdsAfterRefund = db
      .prepare(`SELECT id FROM (${ACTIVE_RELEASED_KDS_ORDER_IDS_SQL})`)
      .all()
      .map((r: any) => String(r.id));
    assertOrThrow(
      !activeIdsAfterRefund.includes(String(rmTwoLineId)),
      'refunded ready-made-only order stays out of ACTIVE_RELEASED_KDS_ORDER_IDS_SQL',
    );
    const kdsAfterRefund = await api(kdsBaseUrl, '/api/kds/orders', { headers: owner.authHeader });
    assertOrThrow(
      !kdsAfterRefund.data.orders.some((o: any) => String(o.id) === String(rmTwoLineId)),
      'refunded 2-line ready-made-only order does not leak onto standalone KDS',
    );

    // 11c. Completed + served + refunded kitchen order stays out of ACTIVE_RELEASED_KDS_ORDER_IDS_SQL
    const servedKitchenOrder = await req({
      path: '/api/orders',
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: dishId, quantity: 1 }] },
    });
    const servedKitchenId = servedKitchenOrder.body.order.id;
    const servedKitchenItem = db
      .prepare('SELECT id, total FROM order_items WHERE order_id = ?')
      .get(servedKitchenId) as { id: number; total: number };
    const servedKitchenBill = await req({
      path: '/api/bills/generate',
      method: 'POST',
      body: { order_id: servedKitchenId },
    });
    await req({
      path: `/api/bills/${servedKitchenBill.body.bill.id}/payment`,
      method: 'POST',
      body: { method: 'card', amount: servedKitchenBill.body.bill.total },
    });
    await req({
      path: `/api/kds/items/${servedKitchenItem.id}/status`,
      method: 'PATCH',
      body: { status: 'served' },
    });
    const kitchenRefund = await req({
      path: '/api/refunds',
      method: 'POST',
      body: {
        bill_id: servedKitchenBill.body.bill.id,
        order_item_id: servedKitchenItem.id,
        amount: servedKitchenItem.total,
        method: 'card',
        reason: 'Customer complaint',
        approver_id: owner.userId,
        override_pin: '1234',
      },
    });
    assertEqualOrThrow(kitchenRefund.status, 201, 'completed served kitchen order refund succeeds');
    const activeIdsAfterKitchenRefund = db
      .prepare(`SELECT id FROM (${ACTIVE_RELEASED_KDS_ORDER_IDS_SQL})`)
      .all()
      .map((r: any) => String(r.id));
    assertOrThrow(
      !activeIdsAfterKitchenRefund.includes(String(servedKitchenId)),
      'completed served refunded kitchen order stays out of ACTIVE_RELEASED_KDS_ORDER_IDS_SQL',
    );

    const results = getResults();
    console.log('\n' + '='.repeat(66));
    console.log(`Hybrid service model results: Passed ${results.passed}/${results.total}`);
    assertEqualOrThrow(results.failed, 0, 'zero failed assertions');
  } finally {
    stopScheduledOrderSweep();
    await stopKdsServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Hybrid service model test failed:', err);
  process.exit(1);
});
