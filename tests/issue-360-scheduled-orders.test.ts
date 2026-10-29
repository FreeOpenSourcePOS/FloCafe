/**
 * Scheduled orders with release semantics: store-timezone/DST validation,
 * deferred stock/KDS/KOT side effects, 10s/startup/resume due sweep,
 * concurrent idempotency, atomic blocked-stock holds with explicit retry,
 * saved quote preservation, prepay/edit-lock/audited reschedule rules,
 * refund-before-cancel enforcement, and shared transactional release hooks.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-360-scheduled-orders.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-scheduled-orders-360-'));

let kotPrintCalls: Array<{ orderId: unknown; stationName: string; itemCount: number }> = [];

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      powerMonitor: { on: () => {} },
    };
  }
  const loaded = originalLoad.apply(this, arguments as any);
  if (
    typeof request === 'string' &&
    (request.endsWith('/printers/thermal') || request.endsWith('\\printers\\thermal')) &&
    loaded &&
    typeof loaded.printKOTDetailed === 'function' &&
    !(loaded as any).__scheduledKotWrapped
  ) {
    const origPrintKot = loaded.printKOTDetailed;
    loaded.printKOTDetailed = async function (
      order: any,
      items: any[],
      stationName: string,
      ...rest: any[]
    ) {
      kotPrintCalls.push({
        orderId: order?.id,
        stationName,
        itemCount: Array.isArray(items) ? items.length : 0,
      });
      return { ok: true, warnings: [] };
    };
    (loaded as any).__scheduledKotWrapped = true;
    void origPrintKot;
  }
  return loaded;
};

process.env.JWT_SECRET = 'test-secret-scheduled-orders-360';
process.env.KDS_PORT = '0';

const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  seedTable,
  seedCustomer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
  resetCounters,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { validateInventoryLedgerDatabase, withTxn } = require('../main/db');
const { adjustProductStock } = require('../main/services/inventory');
const { createSupply, getSupply } = require('../main/services/supplies');
const { saveRecipe } = require('../main/services/recipes');
const { buildDisplayFeed } = require('../main/services/customer-display-tokens');
const {
  releaseScheduledOrder,
  sweepDueScheduledOrders,
  startScheduledOrderSweep,
  stopScheduledOrderSweep,
  triggerScheduledOrderSweep,
} = require('../main/services/scheduled-orders');
const {
  parseScheduledForInput,
  formatScheduledInstantForDisplay,
} = require('../shared/scheduled-time');
const { resetPinRateLimitForTests } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');
const { startKdsServer, stopKdsServer, getKdsPort } = require('../main/kds-server');

function setStoreSetting(db: any, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

function productStock(db: any, id: string): number {
  const row = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any;
  return Number(row?.stock_quantity ?? 0);
}

function variantStock(db: any, id: string): number {
  const row = db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(id) as any;
  return Number(row?.stock_quantity ?? 0);
}

function addonStock(db: any, id: string): number {
  const row = db.prepare('SELECT stock_quantity FROM addons WHERE id = ?').get(id) as any;
  return Number(row?.stock_quantity ?? 0);
}

function supplyStock(db: any, id: string): number {
  return Number(getSupply(db, id).stock_quantity);
}

function assertLedgerReconciles(db: any, label: string) {
  assertEqualOrThrow(
    validateInventoryLedgerDatabase(db),
    null,
    `inventory ledger reconciles (${label})`,
  );
}

function futureWallClockInZone(timezone: string, offsetMinutes: number): string {
  const target = new Date(Date.now() + offsetMinutes * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(target);
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour === '24' ? '00' : byType.hour}:${byType.minute}`;
}

async function main() {
  console.log('Scheduled orders with release semantics (#360)');
  console.log('='.repeat(66));
  resetCounters();
  resetPinRateLimitForTests();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(
    bcrypt.hashSync('9999', 10),
    owner.userId,
  );

  // Configure store regional snapshot & printing/KDS settings
  setStoreSetting(db, 'country', 'US');
  setStoreSetting(db, 'currency', 'USD');
  setStoreSetting(db, 'timezone', 'America/New_York');
  setStoreSetting(db, 'kds_enabled', 'true');
  setStoreSetting(db, 'kot_printing_enabled', 'true');
  setStoreSetting(db, 'auto_print_kot', 'true');
  setStoreSetting(db, 'require_kitchen_delivered_before_settlement', 'true');
  setStoreSetting(db, 'discount_mode', 'percentage');
  setStoreSetting(db, 'discount_max_percentage', '50');
  setStoreSetting(db, 'discount_requires_approval', 'false');

  // Seed default backend printer so autoPrintReleasedOrderKot exercises KOT routing
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, ip_address, port, paper_width, text_size, is_default, cash_drawer_pulse_enabled, created_at, updated_at)
     VALUES ('prn-kot-1', 'Kitchen Thermal', 'network', '127.0.0.1', 9100, 'cols-42', 'normal', 1, 0, ?, ?)`,
  ).run(now(), now());

  seedCategory(db, 'cat-sched', 'Scheduled Menu');
  db.prepare(
    `INSERT INTO kitchen_stations (id, name, category_ids, is_active, sort_order, created_at, updated_at)
     VALUES ('stn-sched-1', 'Main Line', ?, 1, 1, ?, ?)`,
  ).run(JSON.stringify(['cat-sched']), now(), now());
  seedTable(db, 'tbl-sched-1', 1, 4);
  seedCustomer(db, 'cust-sched-1', 'Alex Customer', '+15550101234');
  seedCustomer(db, 'cust-sched-2', 'Sam Customer', '+15550105678');

  // Seed tracked product (stock = 10 via adjustProductStock so ledger reconciles)
  seedProduct(db, 'prod-latte', 'cat-sched', 'Scheduled Latte', 200, {
    track_inventory: true,
    stock_quantity: 0,
  });
  seedProduct(db, 'prod-muffin', 'cat-sched', 'Blueberry Muffin', 80, {
    track_inventory: true,
    stock_quantity: 0,
  });
  seedProduct(db, 'prod-sized-tea', 'cat-sched', 'Iced Tea', 120, {
    track_inventory: false,
    stock_quantity: 0,
  });

  // Seed tracked variant on prod-sized-tea
  db.prepare(
    `INSERT INTO product_variants (id, product_id, name, price, track_inventory, stock_quantity, is_active, sort_order, created_at, updated_at)
     VALUES ('var-tea-large', 'prod-sized-tea', 'Large', 150, 1, 0, 1, 1, ?, ?)`,
  ).run(now(), now());

  // Seed tracked add-on group + add-on
  db.prepare(
    `INSERT INTO addon_groups (id, name, min_selection, max_selection, allow_multiple_quantities, is_required, is_active, created_at, updated_at)
     VALUES ('grp-extras', 'Extras', 0, NULL, 1, 0, 1, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active, track_inventory, stock_quantity, low_stock_threshold, created_at, updated_at)
     VALUES ('addon-syrup', 'grp-extras', 'Vanilla Syrup', 20, 1, 1, 0, 2, ?, ?)`,
  ).run(now(), now());
  db.prepare(
    `INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('prod-latte', 'grp-extras')`,
  ).run();

  withTxn(() => {
    adjustProductStock(db, {
      productId: 'prod-latte',
      quantityDelta: 10,
      movementType: 'adjustment',
      referenceType: 'opening_balance',
      reason: 'Initial stock',
      actorUserId: owner.userId,
    });
    adjustProductStock(db, {
      productId: 'prod-muffin',
      quantityDelta: 2,
      movementType: 'adjustment',
      referenceType: 'opening_balance',
      reason: 'Initial stock',
      actorUserId: owner.userId,
    });
    adjustProductStock(db, {
      productId: 'prod-sized-tea',
      variantId: 'var-tea-large',
      quantityDelta: 8,
      movementType: 'adjustment',
      referenceType: 'opening_balance',
      reason: 'Initial variant stock',
      actorUserId: owner.userId,
    });
    adjustProductStock(db, {
      productId: null,
      addonId: 'addon-syrup',
      quantityDelta: 10,
      movementType: 'adjustment',
      referenceType: 'opening_balance',
      reason: 'Initial addon stock',
      actorUserId: owner.userId,
    });
  });

  // Seed recipe supplies (beans = 500g, milk = 100ml so we also test negative supply stock allowance!)
  const beans = createSupply(db, {
    name: 'Espresso Beans',
    baseUnit: 'g',
    stockQuantity: 500,
    lowStockThreshold: 50,
    actorUserId: owner.userId,
  });
  const oatSupply = createSupply(db, {
    name: 'Barista Milk Supply',
    baseUnit: 'ml',
    stockQuantity: 100,
    lowStockThreshold: 50,
    actorUserId: owner.userId,
  });

  saveRecipe(db, {
    productId: 'prod-latte',
    yieldQuantity: 1,
    items: [
      { supply_id: beans.id, quantity: 18, unit: 'g' },
      { supply_id: oatSupply.id, quantity: 120, unit: 'ml' },
    ],
  });

  assertLedgerReconciles(db, 'initial seed');

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  await startKdsServer();
  const kdsBaseUrl = `http://127.0.0.1:${getKdsPort()}`;

  try {
    // ── 1. Order type gating & Timezone / DST validation ─────────────────────
    console.log('\n--- 1. Order type gating, store timezone & DST validation ---');
    {
      const validFuture = futureWallClockInZone('America/New_York', 90);

      const dineInRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'dine_in',
          table_id: 'tbl-sched-1',
          scheduled_for: validFuture,
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      assertEqualOrThrow(dineInRes.status, 400, 'dine_in rejects scheduled_for with 400');

      const onlineRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'online',
          online_platform: 'UberEats',
          scheduled_for: validFuture,
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      assertEqualOrThrow(onlineRes.status, 400, 'online rejects scheduled_for with 400');

      // Past time rejection
      const pastRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: '2020-01-15T10:00',
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      assertEqualOrThrow(pastRes.status, 400, 'past scheduled_for is rejected with 400');

      // Nonexistent spring-forward DST local time in America/New_York (2027-03-14 02:30 jumps 02:00 -> 03:00)
      const springRefMs = Date.parse('2027-03-14T00:00:00Z');
      const springParsed = parseScheduledForInput({
        input: '2027-03-14T02:30',
        timezone: 'America/New_York',
        nowMs: springRefMs,
      });
      assertEqualOrThrow(springParsed.ok, false, 'spring-forward nonexistent time rejected');
      if (!springParsed.ok) {
        assertEqualOrThrow(
          springParsed.code,
          'DST_NONEXISTENT_TIME',
          'spring-forward returns DST_NONEXISTENT_TIME',
        );
        assertIncludesOrThrow(
          springParsed.message,
          'America/New_York',
          'spring-forward message names store timezone',
        );
      }

      // Repeated fall-back DST local time in America/New_York (2027-11-07 01:30 occurs twice)
      const fallRefMs = Date.parse('2027-11-07T00:00:00Z');
      const fallParsed = parseScheduledForInput({
        input: '2027-11-07T01:30',
        timezone: 'America/New_York',
        nowMs: fallRefMs,
      });
      assertEqualOrThrow(fallParsed.ok, false, 'fall-back ambiguous time rejected');
      if (!fallParsed.ok) {
        assertEqualOrThrow(
          fallParsed.code,
          'DST_AMBIGUOUS_TIME',
          'fall-back returns DST_AMBIGUOUS_TIME',
        );
        assertIncludesOrThrow(
          fallParsed.message,
          'occurs twice',
          'fall-back message explains repeated DST clock',
        );
      }

      // Explicit-offset ISO inputs are rejected in favor of store-timezone wall-clock format
      const explicitUtcParsed = parseScheduledForInput({
        input: '2028-05-01T15:00:00Z',
        timezone: 'America/New_York',
        nowMs: Date.parse('2028-05-01T10:00:00Z'),
      });
      assertEqualOrThrow(explicitUtcParsed.ok, false, 'explicit Z offset input rejected');
      if (!explicitUtcParsed.ok) {
        assertEqualOrThrow(
          explicitUtcParsed.code,
          'INVALID_FORMAT',
          'explicit Z offset returns INVALID_FORMAT',
        );
      }

      const explicitOffsetParsed = parseScheduledForInput({
        input: '2028-05-01T15:00:00-04:00',
        timezone: 'America/New_York',
        nowMs: Date.parse('2028-05-01T10:00:00Z'),
      });
      assertEqualOrThrow(explicitOffsetParsed.ok, false, 'explicit numeric offset input rejected');
      if (!explicitOffsetParsed.ok) {
        assertEqualOrThrow(
          explicitOffsetParsed.code,
          'INVALID_FORMAT',
          'explicit numeric offset returns INVALID_FORMAT',
        );
      }

      const httpExplicitOffsetRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: '2028-05-01T15:00:00Z',
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      assertEqualOrThrow(
        httpExplicitOffsetRes.status,
        400,
        'POST /api/orders rejects explicit-offset scheduled_for with 400',
      );

      // HTTP endpoint also rejects future spring-forward DST time (2028-03-12T02:30 in America/New_York)
      const httpDstRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: '2028-03-12T02:30',
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      assertEqualOrThrow(
        httpDstRes.status,
        400,
        'POST /api/orders rejects nonexistent spring-forward DST local time with 400',
      );
      assertIncludesOrThrow(
        String(httpDstRes.data?.error || ''),
        'daylight saving',
        'HTTP 400 explains daylight-saving rejection',
      );
    }

    // ── 2. No early stock, KDS, or KOT side effects + timezone preservation ──
    console.log('\n--- 2. No early stock, KDS, or KOT effects & UTC instant preservation ---');
    let scheduledOrder1Id = 0;
    let scheduledOrder1ItemId = 0;
    let scheduledOrder1SavedUtc = '';
    {
      kotPrintCalls = [];
      const futureWall = futureWallClockInZone('America/New_York', 120);
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'delivery',
          customer_id: 'cust-sched-1',
          delivery_address: '742 Evergreen Terrace',
          scheduled_for: futureWall,
          items: [
            {
              product_id: 'prod-latte',
              quantity: 2,
              addons: [{ id: 'addon-syrup', quantity: 1 }],
            },
            {
              product_id: 'prod-sized-tea',
              variant_id: 'var-tea-large',
              quantity: 1,
            },
          ],
        },
      });
      assertEqualOrThrow(createRes.status, 201, 'delivery scheduled order created (201)');
      const created = createRes.data.order;
      scheduledOrder1Id = Number(created.id);
      scheduledOrder1ItemId = Number(created.items[0].id);
      scheduledOrder1SavedUtc = String(created.scheduled_for);

      assertEqualOrThrow(created.release_status, 'scheduled', 'release_status is scheduled');
      assertEqualOrThrow(created.released_at, null, 'released_at is null before release');
      assertEqualOrThrow(
        created.release_blocked_reason,
        null,
        'release_blocked_reason is null before release',
      );
      assertOrThrow(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(scheduledOrder1SavedUtc),
        'scheduled_for persisted as canonical UTC ISO instant',
      );

      // Stock & supply untouched on scheduled creation
      assertEqualOrThrow(productStock(db, 'prod-latte'), 10, 'product stock untouched pre-release');
      assertEqualOrThrow(
        variantStock(db, 'var-tea-large'),
        8,
        'variant stock untouched pre-release',
      );
      assertEqualOrThrow(addonStock(db, 'addon-syrup'), 10, 'add-on stock untouched pre-release');
      assertEqualOrThrow(supplyStock(db, beans.id), 500, 'beans supply untouched pre-release');
      assertEqualOrThrow(supplyStock(db, oatSupply.id), 100, 'milk supply untouched pre-release');
      assertEqualOrThrow(kotPrintCalls.length, 0, 'no automatic KOT printed at scheduled creation');
      assertLedgerReconciles(db, 'after scheduled order creation');

      // Changing store timezone setting preserves exact saved UTC instant
      setStoreSetting(db, 'timezone', 'Asia/Kolkata');
      const reReadRes = await api(baseUrl, `/api/orders/${scheduledOrder1Id}`, {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(
        reReadRes.data.order.scheduled_for,
        scheduledOrder1SavedUtc,
        'saved scheduled_for UTC instant preserved after store timezone change',
      );
      const nyDisplay = formatScheduledInstantForDisplay(
        scheduledOrder1SavedUtc,
        'America/New_York',
        'en-US',
      );
      const inDisplay = formatScheduledInstantForDisplay(
        scheduledOrder1SavedUtc,
        'Asia/Kolkata',
        'en-US',
      );
      assertOrThrow(
        nyDisplay !== inDisplay,
        'display presentation reflects updated store timezone without mutating stored UTC instant',
      );
      setStoreSetting(db, 'timezone', 'America/New_York');

      // Excluded from KDS, kitchen, customer display, and KOT print endpoints
      const kdsOrdersRes = await api(baseUrl, '/api/kds/orders', { headers: owner.authHeader });
      assertEqualOrThrow(kdsOrdersRes.status, 200, 'GET /api/kds/orders succeeds');
      assertOrThrow(
        !kdsOrdersRes.data.orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'unreleased order excluded from /api/kds/orders',
      );

      const standaloneKdsPreRes = await api(kdsBaseUrl, '/api/kds/orders', {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(
        standaloneKdsPreRes.status,
        200,
        'standalone GET /api/kds/orders succeeds',
      );
      assertOrThrow(
        !standaloneKdsPreRes.data.orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'unreleased order excluded from standalone /api/kds/orders',
      );

      const kdsDisplayRes = await api(baseUrl, '/api/kds/display?station_id=stn-sched-1', {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(kdsDisplayRes.status, 200, 'GET /api/kds/display succeeds');
      assertOrThrow(
        !kdsDisplayRes.data.orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'unreleased order excluded from /api/kds/display',
      );

      const kitchenRes = await api(baseUrl, '/api/kitchen/orders', { headers: owner.authHeader });
      assertEqualOrThrow(kitchenRes.status, 200, 'GET /api/kitchen/orders succeeds');
      assertOrThrow(
        !kitchenRes.data.orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'unreleased order excluded from /api/kitchen/orders',
      );

      const displayFeed = buildDisplayFeed();
      assertOrThrow(
        !displayFeed.orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'unreleased order excluded from customer display feed',
      );

      const manualKotRes = await api(baseUrl, '/api/printers/print-kot', {
        method: 'POST',
        headers: manager.authHeader,
        body: { orderId: scheduledOrder1Id },
      });
      assertEqualOrThrow(
        manualKotRes.status,
        409,
        'POST /api/printers/print-kot rejected (409) before release even from another staff client',
      );

      const kdsItemMutateRes = await api(
        baseUrl,
        `/api/kds/items/${scheduledOrder1ItemId}/status`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'preparing' },
        },
      );
      assertEqualOrThrow(
        kdsItemMutateRes.status,
        409,
        'PATCH /api/kds/items/:id/status rejected (409) before release',
      );

      const standaloneKdsMutatePreRes = await api(
        kdsBaseUrl,
        `/api/kds/items/${scheduledOrder1ItemId}/status`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'preparing' },
        },
      );
      assertEqualOrThrow(
        standaloneKdsMutatePreRes.status,
        409,
        'standalone PATCH /api/kds/items/:id/status rejected (409) before release',
      );

      const orderItemMutateRes = await api(
        baseUrl,
        `/api/order-items/${scheduledOrder1ItemId}/status`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'preparing' },
        },
      );
      assertEqualOrThrow(
        orderItemMutateRes.status,
        409,
        'PATCH /api/order-items/:id/status rejected (409) before release',
      );

      const orderStatusMutateRes = await api(baseUrl, `/api/orders/${scheduledOrder1Id}/status`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { status: 'preparing' },
      });
      assertEqualOrThrow(
        orderStatusMutateRes.status,
        409,
        'PATCH /api/orders/:id/status (preparing) rejected (409) before release',
      );

      // Visible in dedicated scheduled queue endpoint
      const dedicatedQueueRes = await api(baseUrl, '/api/orders/scheduled', {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(dedicatedQueueRes.status, 200, 'GET /api/orders/scheduled succeeds');
      assertOrThrow(
        dedicatedQueueRes.data.orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'scheduled order returned by GET /api/orders/scheduled',
      );
      assertEqualOrThrow(
        typeof dedicatedQueueRes.data.scheduled_count,
        'number',
        'GET /api/orders/scheduled returns scheduled_count',
      );
      assertEqualOrThrow(
        typeof dedicatedQueueRes.data.blocked_count,
        'number',
        'GET /api/orders/scheduled returns blocked_count',
      );

      // Create a second scheduled order so multiple pages can be exercised
      const schedSecondOrderRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: futureWallClockInZone('America/New_York', 180),
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      assertEqualOrThrow(schedSecondOrderRes.status, 201, 'second scheduled order created for pagination test');

      // Page 1 with limit = 1 returns next_cursor
      const page1Res = await api(baseUrl, '/api/orders/scheduled?limit=1', {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(page1Res.status, 200, 'GET /api/orders/scheduled?limit=1 succeeds');
      assertEqualOrThrow(page1Res.data.orders.length, 1, 'page 1 has length 1');
      assertOrThrow(
        typeof page1Res.data.next_cursor === 'string' && page1Res.data.next_cursor.length > 0,
        'page 1 returns non-null next_cursor string',
      );

      // Page 2 using cursor returns the next item
      const page2Res = await api(
        baseUrl,
        `/api/orders/scheduled?limit=1&cursor=${encodeURIComponent(page1Res.data.next_cursor)}`,
        {
          headers: owner.authHeader,
        },
      );
      assertEqualOrThrow(page2Res.status, 200, 'GET /api/orders/scheduled with cursor succeeds');
      assertEqualOrThrow(page2Res.data.orders.length, 1, 'page 2 has length 1');
      assertOrThrow(
        Number(page2Res.data.orders[0].id) !== Number(page1Res.data.orders[0].id),
        'page 2 returns a distinct order from page 1',
      );

      // Invalid cursor returns 400 with INVALID_CURSOR
      const invalidCursorRes = await api(baseUrl, '/api/orders/scheduled?cursor=not-a-valid-cursor-token', {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(invalidCursorRes.status, 400, 'invalid cursor rejected with 400');
      assertEqualOrThrow(invalidCursorRes.data.code, 'INVALID_CURSOR', 'code is INVALID_CURSOR');

      // Heartbeat active orders excludes unreleased scheduled orders
      const { cloudSync } = require('../main/services/cloud-sync');
      const heartbeatPayload = (cloudSync as any).buildHeartbeatPayload({ pos_hash: 'test_hash', pos_id: 'pos_1' });
      const rawActiveOrdersCount = (db.prepare(`
        SELECT COUNT(*) as count FROM orders
        WHERE status IN ('pending', 'preparing', 'ready', 'served')
          AND release_status = 'released'
      `).get() as { count: number }).count;
      assertEqualOrThrow(
        heartbeatPayload.active_orders,
        rawActiveOrdersCount,
        'heartbeat active_orders matches released active orders and excludes unreleased scheduled orders',
      );
    }

    // ── 3. Quote preservation + recipe-at-release + negative supply + due sweep + concurrent idempotency ─
    console.log(
      '\n--- 3. Quote preservation, current recipe at release, negative supply, due sweep & concurrency ---',
    );
    {
      // Record saved financial quote before mutating catalog & recipe
      const beforeQuote = await api(baseUrl, `/api/orders/${scheduledOrder1Id}`, {
        headers: owner.authHeader,
      });
      const savedTotal = Number(beforeQuote.data.order.total);
      const savedSubtotal = Number(beforeQuote.data.order.subtotal);
      assertEqualOrThrow(
        savedSubtotal,
        2 * 200 + 2 * 20 + 1 * 150,
        'quoted subtotal = 2*(200+20) + 150 = 590',
      );

      // Mutate catalog prices AND update recipe BEFORE release!
      db.prepare("UPDATE products SET price = 350 WHERE id = 'prod-latte'").run();
      db.prepare("UPDATE addons SET price = 50 WHERE id = 'addon-syrup'").run();
      saveRecipe(db, {
        productId: 'prod-latte',
        yieldQuantity: 1,
        items: [
          { supply_id: beans.id, quantity: 25, unit: 'g' }, // was 18g, now 25g -> 2 lattes = 50g
          { supply_id: oatSupply.id, quantity: 120, unit: 'ml' }, // 2 lattes = 240ml (supply has 100ml -> goes to -140ml!)
        ],
      });

      // Fire concurrent due sweep + manual release + sweep at/after scheduled_for!
      const afterDueDate = new Date(Date.parse(scheduledOrder1SavedUtc) + 5_000);
      const [sweepRes, manualRes, secondSweepRes] = await Promise.all([
        sweepDueScheduledOrders(db, { nowDate: afterDueDate, trigger: 'sweep' }),
        releaseScheduledOrder(db, scheduledOrder1Id, {
          trigger: 'manual',
          actorUserId: owner.userId,
          nowDate: afterDueDate,
        }),
        releaseScheduledOrder(db, scheduledOrder1Id, {
          trigger: 'sweep',
          nowDate: afterDueDate,
        }),
      ]);

      const releasedCount =
        (sweepRes.releasedIds.includes(scheduledOrder1Id) ? 1 : 0) +
        (manualRes.outcome === 'released' ? 1 : 0) +
        (secondSweepRes.outcome === 'released' ? 1 : 0);
      assertEqualOrThrow(
        releasedCount,
        1,
        'concurrent sweep and manual retry release the order exactly once',
      );

      // Verify stock deducted ONCE, using updated recipe (50g beans) and allowing negative supply (-140ml milk)
      assertEqualOrThrow(productStock(db, 'prod-latte'), 8, 'prod-latte deducted once (10 -> 8)');
      assertEqualOrThrow(
        variantStock(db, 'var-tea-large'),
        7,
        'var-tea-large deducted once (8 -> 7)',
      );
      assertEqualOrThrow(
        addonStock(db, 'addon-syrup'),
        8,
        'addon-syrup deducted once (10 -> 8 for 2x1)',
      );
      assertEqualOrThrow(
        supplyStock(db, beans.id),
        450,
        'beans supply deducted using recipe in effect at release (500 - 2*25 = 450)',
      );
      assertEqualOrThrow(
        supplyStock(db, oatSupply.id),
        -140,
        'negative recipe-supply stock remains allowed at release (100 - 240 = -140)',
      );
      assertEqualOrThrow(
        kotPrintCalls.length,
        1,
        'automatic KOT printed once when scheduled order released',
      );
      assertLedgerReconciles(db, 'after concurrent scheduled release');

      // Verify saved prices/totals preserved (no automatic repricing!)
      const afterQuote = await api(baseUrl, `/api/orders/${scheduledOrder1Id}`, {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(afterQuote.data.order.release_status, 'released', 'order is now released');
      assertOrThrow(Boolean(afterQuote.data.order.released_at), 'released_at populated');
      assertEqualOrThrow(
        Number(afterQuote.data.order.subtotal),
        savedSubtotal,
        'saved subtotal preserved across catalog price changes',
      );
      assertEqualOrThrow(
        Number(afterQuote.data.order.total),
        savedTotal,
        'saved total preserved across catalog price changes',
      );
      assertEqualOrThrow(
        Number(afterQuote.data.order.items[0].unit_price),
        200,
        'saved item unit_price preserved (200, not repriced to 350)',
      );
      assertEqualOrThrow(
        Number(afterQuote.data.order.items[0].inventory_deducted_quantity),
        2,
        'actual depletion snapshot saved on released order item',
      );

      // Now visible in KDS & customer display!
      const kdsAfter = await api(baseUrl, '/api/kds/orders', { headers: owner.authHeader });
      assertOrThrow(
        kdsAfter.data.orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'released order now appears on KDS',
      );
      const standaloneKdsAfter = await api(kdsBaseUrl, '/api/kds/orders', {
        headers: owner.authHeader,
      });
      assertOrThrow(
        standaloneKdsAfter.data.orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'released order appears on standalone KDS server',
      );
      const standaloneKdsMutatePost = await api(
        kdsBaseUrl,
        `/api/kds/items/${scheduledOrder1ItemId}/status`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'preparing' },
        },
      );
      assertEqualOrThrow(
        standaloneKdsMutatePost.status,
        200,
        'standalone PATCH /api/kds/items/:id/status succeeds after release',
      );
      assertOrThrow(
        buildDisplayFeed().orders.some((o: any) => Number(o.id) === scheduledOrder1Id),
        'released order now appears on customer display feed',
      );

      // Restore catalog prices for subsequent tests
      db.prepare("UPDATE products SET price = 200 WHERE id = 'prod-latte'").run();
      db.prepare("UPDATE addons SET price = 20 WHERE id = 'addon-syrup'").run();
    }

    // ── 4. Startup & resume overdue sweep ────────────────────────────────────
    console.log('\n--- 4. Startup and resume overdue release ---');
    {
      const dueSoonWall = futureWallClockInZone('America/New_York', 30);
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: dueSoonWall,
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      assertEqualOrThrow(createRes.status, 201, 'overdue candidate created');
      const overdueId = Number(createRes.data.order.id);

      // Backdate scheduled_for to 2 minutes ago to simulate an order that became overdue while asleep/offline
      const pastIso = new Date(Date.now() - 120_000).toISOString();
      db.prepare('UPDATE orders SET scheduled_for = ? WHERE id = ?').run(pastIso, overdueId);

      startScheduledOrderSweep(40);
      // Allow startup sweep promise to settle
      await new Promise((r) => setTimeout(r, 80));

      const afterStartup = db
        .prepare('SELECT release_status, released_at FROM orders WHERE id = ?')
        .get(overdueId) as any;
      assertEqualOrThrow(
        afterStartup.release_status,
        'released',
        'startup sweep automatically releases overdue scheduled order',
      );
      assertOrThrow(Boolean(afterStartup.released_at), 'startup sweep sets released_at');

      // Verify subsequent periodic interval tick ALSO runs after startup sweep settles
      const periodicCreate = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: dueSoonWall,
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      const periodicOrderId = Number(periodicCreate.data.order.id);
      db.prepare('UPDATE orders SET scheduled_for = ? WHERE id = ?').run(pastIso, periodicOrderId);
      await new Promise((r) => setTimeout(r, 100));
      stopScheduledOrderSweep();

      const afterPeriodic = db
        .prepare('SELECT release_status FROM orders WHERE id = ?')
        .get(periodicOrderId) as any;
      assertEqualOrThrow(
        afterPeriodic.release_status,
        'released',
        'periodic due sweep interval releases subsequent due scheduled orders',
      );

      // Also test resume sweep directly
      const resumeCreate = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: dueSoonWall,
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      const resumeOrderId = Number(resumeCreate.data.order.id);
      db.prepare('UPDATE orders SET scheduled_for = ? WHERE id = ?').run(pastIso, resumeOrderId);
      const resumeSummary = await triggerScheduledOrderSweep('resume');
      assertOrThrow(
        resumeSummary.releasedIds.includes(resumeOrderId),
        'resume trigger releases overdue scheduled order',
      );
      assertLedgerReconciles(db, 'after startup and resume sweeps');
    }

    // ── 5. Blocked release holds whole order atomically + explicit retry ─────
    console.log('\n--- 5. Atomic whole-order hold on blocked stock/catalog & explicit retry ---');
    {
      // prod-latte currently has stock = 6 (10 - 2 - 1 - 1). prod-muffin has stock = 2.
      // Create a scheduled order needing 1 prod-latte (available!) AND 5 prod-muffin (only 2 available -> short!).
      const schedWall = futureWallClockInZone('America/New_York', 45);
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: schedWall,
          items: [
            { product_id: 'prod-latte', quantity: 1 },
            { product_id: 'prod-muffin', quantity: 5 },
          ],
        },
      });
      assertEqualOrThrow(
        createRes.status,
        201,
        'scheduled order accepted even when future stock must be replenished before release',
      );
      const blockedOrderId = Number(createRes.data.order.id);
      const latteBefore = productStock(db, 'prod-latte');
      const muffinBefore = productStock(db, 'prod-muffin');

      // Due sweep runs when order becomes due -> must hold WHOLE order atomically!
      const futureNow = new Date(Date.parse(createRes.data.order.scheduled_for) + 10_000);
      const sweepBlocked = await sweepDueScheduledOrders(db, {
        nowDate: futureNow,
        trigger: 'sweep',
      });
      assertOrThrow(
        sweepBlocked.blockedIds.includes(blockedOrderId),
        'due sweep marks insufficient-stock order as blocked',
      );

      // Neither prod-latte nor prod-muffin may have been partially deducted!
      assertEqualOrThrow(
        productStock(db, 'prod-latte'),
        latteBefore,
        'atomic rollback: available line (prod-latte) NOT partially deducted when sibling line fails',
      );
      assertEqualOrThrow(
        productStock(db, 'prod-muffin'),
        muffinBefore,
        'short line (prod-muffin) NOT deducted',
      );
      assertLedgerReconciles(db, 'after blocked release rollback');

      const blockedOrderRes = await api(baseUrl, `/api/orders/${blockedOrderId}`, {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(
        blockedOrderRes.data.order.release_status,
        'blocked',
        'release_status is blocked',
      );
      assertIncludesOrThrow(
        String(blockedOrderRes.data.order.release_blocked_reason || ''),
        'Blueberry Muffin',
        'release_blocked_reason names the offending item',
      );

      // Still excluded from KDS!
      const kdsWhileBlocked = await api(baseUrl, '/api/kds/orders', { headers: owner.authHeader });
      assertOrThrow(
        !kdsWhileBlocked.data.orders.some((o: any) => Number(o.id) === blockedOrderId),
        'blocked order remains excluded from KDS',
      );
      const standaloneKdsBlocked = await api(kdsBaseUrl, '/api/kds/orders', {
        headers: owner.authHeader,
      });
      assertOrThrow(
        !standaloneKdsBlocked.data.orders.some((o: any) => Number(o.id) === blockedOrderId),
        'blocked order excluded from standalone KDS server',
      );
      const blockedItemId = Number(blockedOrderRes.data.order.items[0].id);
      const standaloneMutateBlocked = await api(
        kdsBaseUrl,
        `/api/kds/items/${blockedItemId}/status`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'preparing' },
        },
      );
      assertEqualOrThrow(
        standaloneMutateBlocked.status,
        409,
        'standalone PATCH /api/kds/items/:id/status rejected (409) while blocked',
      );

      // Rescheduling a blocked order preserves release_status = 'blocked' and release_blocked_reason
      const newSchedWall = futureWallClockInZone('America/New_York', 120);
      const reschedBlockedRes = await api(baseUrl, `/api/orders/${blockedOrderId}/schedule`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { scheduled_for: newSchedWall },
      });
      assertEqualOrThrow(
        reschedBlockedRes.status,
        200,
        'PATCH /api/orders/:id/schedule succeeds on a blocked order',
      );
      assertEqualOrThrow(
        reschedBlockedRes.data.order.release_status,
        'blocked',
        'rescheduling a blocked order preserves release_status = blocked',
      );
      assertIncludesOrThrow(
        String(reschedBlockedRes.data.order.release_blocked_reason || ''),
        'Blueberry Muffin',
        'rescheduling a blocked order preserves release_blocked_reason',
      );
      const blockedAudit = db
        .prepare(
          `SELECT details_json FROM order_audit_log
           WHERE order_id = ? AND action = 'schedule_updated'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(String(blockedOrderId)) as { details_json: string };
      const parsedBlockedAudit = JSON.parse(blockedAudit.details_json);
      assertEqualOrThrow(
        parsedBlockedAudit.release_status,
        'blocked',
        'audit details records release_status: blocked',
      );

      // Restock prod-muffin (+5 -> total 7), verify automatic due sweep does NOT auto-release a blocked order!
      withTxn(() => {
        adjustProductStock(db, {
          productId: 'prod-muffin',
          quantityDelta: 5,
          movementType: 'adjustment',
          referenceType: 'restock',
          reason: 'Restocked muffins',
          actorUserId: owner.userId,
        });
      });

      const sweepAfterRestock = await sweepDueScheduledOrders(db, {
        nowDate: new Date(futureNow.getTime() + 20_000),
        trigger: 'sweep',
      });
      assertOrThrow(
        !sweepAfterRestock.releasedIds.includes(blockedOrderId),
        'automatic due sweep skips already-blocked order until staff explicitly retries',
      );

      // Also test catalog unavailability block before final retry: deactivate prod-muffin
      db.prepare("UPDATE products SET is_active = 0 WHERE id = 'prod-muffin'").run();
      const retryWhileInactive = await api(baseUrl, `/api/orders/${blockedOrderId}/release`, {
        method: 'POST',
        headers: owner.authHeader,
      });
      assertEqualOrThrow(
        retryWhileInactive.status,
        409,
        'manual retry returns 409 RELEASE_BLOCKED while product is inactive',
      );
      assertEqualOrThrow(
        retryWhileInactive.data.code,
        'RELEASE_BLOCKED',
        'code is RELEASE_BLOCKED',
      );

      // Re-activate prod-muffin and explicitly retry via POST /api/orders/:id/release
      db.prepare("UPDATE products SET is_active = 1 WHERE id = 'prod-muffin'").run();
      const retrySuccess = await api(baseUrl, `/api/orders/${blockedOrderId}/release`, {
        method: 'POST',
        headers: owner.authHeader,
      });
      assertEqualOrThrow(retrySuccess.status, 200, 'explicit retry after resolving issue succeeds');
      assertEqualOrThrow(
        retrySuccess.data.order.release_status,
        'released',
        'retried order transitions to released',
      );
      assertEqualOrThrow(
        retrySuccess.data.order.release_blocked_reason,
        null,
        'release_blocked_reason cleared on successful release',
      );
      assertEqualOrThrow(
        productStock(db, 'prod-latte'),
        latteBefore - 1,
        'prod-latte deducted on successful retry',
      );
      assertEqualOrThrow(
        productStock(db, 'prod-muffin'),
        2,
        'prod-muffin deducted 5 from restocked 7 -> 2',
      );
      assertLedgerReconciles(db, 'after explicit retry release');
    }

    // ── 6. Pre-payment edits, prepay without early release/completion, edit-lock, audited reschedule ─
    console.log(
      '\n--- 6. Edits before payment, prepay without early release/completion, edit lock & audited reschedule ---',
    );
    let paidScheduledOrderId = 0;
    let paidScheduledBillId = '';
    {
      const schedWall = futureWallClockInZone('America/New_York', 90);
      const createRes = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          customer_id: 'cust-sched-1',
          scheduled_for: schedWall,
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      assertEqualOrThrow(createRes.status, 201, 'scheduled takeaway order created');
      paidScheduledOrderId = Number(createRes.data.order.id);
      const initialItemId = Number(createRes.data.order.items[0].id);
      const initialEditVersion = Number(createRes.data.order.items[0].edit_version || 0);
      const stockBeforeEdits = productStock(db, 'prod-latte');

      // Before payment: item edit, item append, customer change, and discount ARE allowed and do NOT deduct stock early!
      const editRes = await api(
        baseUrl,
        `/api/orders/${paidScheduledOrderId}/items/${initialItemId}/edit`,
        {
          method: 'PATCH',
          headers: { ...owner.authHeader, 'Idempotency-Key': 'edit-sched-item-1' },
          body: { expected_edit_version: initialEditVersion, quantity: 2 },
        },
      );
      assertEqualOrThrow(editRes.status, 200, 'item quantity edit allowed before payment');
      assertEqualOrThrow(
        productStock(db, 'prod-latte'),
        stockBeforeEdits,
        'item edit on unreleased order does not deduct stock early',
      );

      const appendRes = await api(baseUrl, `/api/orders/${paidScheduledOrderId}/items`, {
        method: 'POST',
        headers: owner.authHeader,
        body: { items: [{ product_id: 'prod-muffin', quantity: 1 }] },
      });
      assertEqualOrThrow(appendRes.status, 200, 'item append allowed before payment');

      const custRes = await api(baseUrl, `/api/orders/${paidScheduledOrderId}/customer`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { customer_id: 'cust-sched-2' },
      });
      assertEqualOrThrow(custRes.status, 200, 'customer update allowed before payment');

      const discRes = await api(baseUrl, `/api/orders/${paidScheduledOrderId}/discount`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { discount_type: 'percentage', discount_value: 10 },
      });
      assertEqualOrThrow(discRes.status, 200, 'order discount allowed before payment');

      // Generate bill & take partial payment, then remaining payment BEFORE release
      const genBillRes = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        headers: owner.authHeader,
        body: { order_id: String(paidScheduledOrderId) },
      });
      assertEqualOrThrow(genBillRes.status, 201, 'bill generated for scheduled order');
      paidScheduledBillId = String(genBillRes.data.bill.id);
      const payableTotal = Number(genBillRes.data.bill.total);

      const partialPayRes = await api(baseUrl, `/api/bills/${paidScheduledBillId}/payment`, {
        method: 'POST',
        headers: owner.authHeader,
        body: { method: 'card', amount: 100, transaction_id: 'TXN-SCHED-PART-1' },
      });
      assertEqualOrThrow(
        partialPayRes.status,
        200,
        'partial payment succeeds before release without kitchen-delivery block',
      );
      assertEqualOrThrow(partialPayRes.data.bill.payment_status, 'partial', 'bill is partial');

      // Even after partial payment, item and financial edits MUST be blocked!
      const activeItemAfterPartial = appendRes.data.order.items.find(
        (i: any) => i.status === 'pending',
      );
      const blockedAppend = await api(baseUrl, `/api/orders/${paidScheduledOrderId}/items`, {
        method: 'POST',
        headers: owner.authHeader,
        body: { items: [{ product_id: 'prod-muffin', quantity: 1 }] },
      });
      assertEqualOrThrow(blockedAppend.status, 409, 'item append blocked after partial payment');
      assertEqualOrThrow(
        blockedAppend.data.code,
        'SCHEDULED_ORDER_PAID',
        'item append returns SCHEDULED_ORDER_PAID code',
      );

      const blockedEditAfterPartial = await api(
        baseUrl,
        `/api/orders/${paidScheduledOrderId}/items/${activeItemAfterPartial.id}/edit`,
        {
          method: 'PATCH',
          headers: { ...owner.authHeader, 'Idempotency-Key': 'edit-sched-item-blocked' },
          body: {
            expected_edit_version: Number(activeItemAfterPartial.edit_version || 0),
            quantity: 3,
          },
        },
      );
      assertEqualOrThrow(
        blockedEditAfterPartial.status,
        409,
        'item quantity edit blocked after partial payment',
      );
      assertEqualOrThrow(
        blockedEditAfterPartial.data.code,
        'SCHEDULED_ORDER_PAID',
        'item edit returns SCHEDULED_ORDER_PAID code',
      );

      const blockedDisc = await api(baseUrl, `/api/orders/${paidScheduledOrderId}/discount`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { discount_type: 'percentage', discount_value: 5 },
      });
      assertEqualOrThrow(blockedDisc.status, 409, 'order discount blocked after partial payment');
      assertEqualOrThrow(
        blockedDisc.data.code,
        'SCHEDULED_ORDER_PAID',
        'returns SCHEDULED_ORDER_PAID code',
      );

      const blockedItemDisc = await api(
        baseUrl,
        `/api/orders/${paidScheduledOrderId}/items/${activeItemAfterPartial.id}/discount`,
        {
          method: 'POST',
          headers: owner.authHeader,
          body: { discount_type: 'percentage', discount_value: 5 },
        },
      );
      assertEqualOrThrow(
        blockedItemDisc.status,
        409,
        'item discount blocked after partial payment',
      );
      assertEqualOrThrow(
        blockedItemDisc.data.code,
        'SCHEDULED_ORDER_PAID',
        'item discount returns SCHEDULED_ORDER_PAID code',
      );

      const blockedCust = await api(baseUrl, `/api/orders/${paidScheduledOrderId}/customer`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { customer_id: 'cust-sched-1' },
      });
      assertEqualOrThrow(blockedCust.status, 409, 'customer change blocked after partial payment');
      assertEqualOrThrow(
        blockedCust.data.code,
        'SCHEDULED_ORDER_PAID',
        'customer change returns SCHEDULED_ORDER_PAID code',
      );

      const blockedBillDisc = await api(
        baseUrl,
        `/api/bills/${paidScheduledBillId}/applyDiscount`,
        {
          method: 'POST',
          headers: owner.authHeader,
          body: { type: 'percentage', value: 5 },
        },
      );
      assertEqualOrThrow(
        blockedBillDisc.status,
        409,
        'bill discount blocked after partial payment',
      );
      assertEqualOrThrow(
        blockedBillDisc.data.code,
        'SCHEDULED_ORDER_PAID',
        'bill discount returns SCHEDULED_ORDER_PAID code',
      );

      const blockedBillCharges = await api(baseUrl, `/api/bills/${paidScheduledBillId}/charges`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { charge_id: 'service_charge', waived: true },
      });
      assertEqualOrThrow(
        blockedBillCharges.status,
        409,
        'bill charges change blocked after partial payment',
      );
      assertEqualOrThrow(
        blockedBillCharges.data.code,
        'SCHEDULED_ORDER_PAID',
        'bill charges returns SCHEDULED_ORDER_PAID code',
      );

      const blockedItemCancel = await api(
        baseUrl,
        `/api/orders/${paidScheduledOrderId}/items/${activeItemAfterPartial.id}/cancel`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { reason: 'Changed mind' },
        },
      );
      assertEqualOrThrow(
        blockedItemCancel.status,
        409,
        'item cancellation blocked after partial payment',
      );
      assertEqualOrThrow(
        blockedItemCancel.data.code,
        'SCHEDULED_ORDER_PAID',
        'item cancellation returns SCHEDULED_ORDER_PAID code',
      );

      const blockedPriceOverride = await api(
        baseUrl,
        `/api/orders/${paidScheduledOrderId}/items/${activeItemAfterPartial.id}/price`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { price: 150, reason: 'VIP' },
        },
      );
      assertEqualOrThrow(
        blockedPriceOverride.status,
        409,
        'manual price override blocked after partial payment',
      );
      assertEqualOrThrow(
        blockedPriceOverride.data.code,
        'SCHEDULED_ORDER_PAID',
        'manual price override returns SCHEDULED_ORDER_PAID code',
      );

      // Settle remaining balance in full BEFORE release
      const remaining = Number((payableTotal - 100).toFixed(2));
      const fullPayRes = await api(baseUrl, `/api/bills/${paidScheduledBillId}/payment`, {
        method: 'POST',
        headers: owner.authHeader,
        body: { method: 'card', amount: remaining, transaction_id: 'TXN-SCHED-FULL-2' },
      });
      assertEqualOrThrow(fullPayRes.status, 200, 'full payment succeeds before release');
      assertEqualOrThrow(fullPayRes.data.bill.payment_status, 'paid', 'bill is fully paid');

      // Full payment MUST NOT release early or mark kitchen order completed!
      const afterFullPayOrder = await api(baseUrl, `/api/orders/${paidScheduledOrderId}`, {
        headers: owner.authHeader,
      });
      assertEqualOrThrow(
        afterFullPayOrder.data.order.release_status,
        'scheduled',
        'full payment does NOT release future order early',
      );
      assertEqualOrThrow(
        afterFullPayOrder.data.order.status,
        'pending',
        'full payment does NOT mark unreleased order completed',
      );

      // Audited timing-only reschedule IS allowed after full payment until release!
      const rescheduledWall = futureWallClockInZone('America/New_York', 150);
      const reschedRes = await api(baseUrl, `/api/orders/${paidScheduledOrderId}/schedule`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { scheduled_for: rescheduledWall },
      });
      assertEqualOrThrow(
        reschedRes.status,
        200,
        'timing-only reschedule succeeds even after full payment',
      );
      const scheduleAudit = db
        .prepare(
          `SELECT action, actor_user_id, details_json FROM order_audit_log
           WHERE order_id = ? AND action = 'schedule_updated' ORDER BY id DESC LIMIT 1`,
        )
        .get(String(paidScheduledOrderId)) as any;
      assertOrThrow(Boolean(scheduleAudit), 'schedule_updated recorded in order_audit_log');
      assertEqualOrThrow(
        scheduleAudit.actor_user_id,
        owner.userId,
        'schedule_updated attributes authenticated actor',
      );
    }

    // ── 7. Cancellation rules (refund required after payment; no restock before release; restock after release) ─
    console.log('\n--- 7. Cancellation rules before release, after payment, and after release ---');
    {
      // Paid scheduled order CANNOT be cancelled until collected funds are refunded in full (even with manager PIN!)
      const cancelWhilePaidRes = await api(baseUrl, `/api/orders/${paidScheduledOrderId}/status`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { status: 'cancelled', reason: 'Customer called', override_pin: '1234' },
      });
      assertEqualOrThrow(
        cancelWhilePaidRes.status,
        409,
        'cancelling paid scheduled order before full refund is rejected with 409',
      );
      assertEqualOrThrow(
        cancelWhilePaidRes.data.code,
        'REFUND_REQUIRED_BEFORE_CANCEL',
        'returns REFUND_REQUIRED_BEFORE_CANCEL',
      );

      // Simulate order created 2 days ago while still unreleased -> refund must NOT fail late-refund cutoff!
      db.prepare("UPDATE orders SET created_at = '2026-01-01 10:00:00' WHERE id = ?").run(
        paidScheduledOrderId,
      );
      const billRow = db
        .prepare('SELECT total FROM bills WHERE id = ?')
        .get(paidScheduledBillId) as any;

      // Partial refund still blocks cancellation!
      const partialRefundRes = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          bill_id: paidScheduledBillId,
          amount: 50,
          method: 'card',
          reason: 'Partial test',
          approver_id: manager.userId,
          override_pin: '1234',
        },
      });
      assertEqualOrThrow(
        partialRefundRes.status,
        201,
        'manager PIN (not late owner-only) authorizes refund on unreleased scheduled order regardless of created_at age',
      );

      const cancelAfterPartialRefund = await api(
        baseUrl,
        `/api/orders/${paidScheduledOrderId}/status`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'cancelled', reason: 'Still has net funds', override_pin: '1234' },
        },
      );
      assertEqualOrThrow(
        cancelAfterPartialRefund.status,
        409,
        'cancellation still blocked while unrefunded funds remain',
      );

      // Refund remaining collected balance in full
      const remainingRefund = Number((Number(billRow.total) - 50).toFixed(2));
      const finalRefundRes = await api(baseUrl, '/api/refunds', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          bill_id: paidScheduledBillId,
          amount: remainingRefund,
          method: 'card',
          reason: 'Full refund before cancel',
          approver_id: manager.userId,
          override_pin: '1234',
        },
      });
      assertEqualOrThrow(finalRefundRes.status, 201, 'remaining balance refunded in full');

      const latteBeforeCancel = productStock(db, 'prod-latte');
      const muffinBeforeCancel = productStock(db, 'prod-muffin');
      const beansBeforeCancel = supplyStock(db, beans.id);

      // Now cancel unreleased order -> succeeds, preserves bill & audit history, and restores ZERO stock!
      const cancelAfterFullRefund = await api(
        baseUrl,
        `/api/orders/${paidScheduledOrderId}/status`,
        {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'cancelled', reason: 'Refunded and cancelled' },
        },
      );
      assertEqualOrThrow(
        cancelAfterFullRefund.status,
        200,
        'scheduled order cancels cleanly once collected funds are fully refunded',
      );
      assertEqualOrThrow(
        productStock(db, 'prod-latte'),
        latteBeforeCancel,
        'cancelling before release does NOT restore product stock that was never deducted',
      );
      assertEqualOrThrow(
        productStock(db, 'prod-muffin'),
        muffinBeforeCancel,
        'cancelling before release does NOT restore muffin stock that was never deducted',
      );
      assertEqualOrThrow(
        supplyStock(db, beans.id),
        beansBeforeCancel,
        'cancelling before release does NOT restore recipe supply stock that was never deducted',
      );
      const preservedBill = db
        .prepare('SELECT payment_status FROM bills WHERE id = ?')
        .get(paidScheduledBillId) as any;
      assertEqualOrThrow(
        preservedBill?.payment_status,
        'refunded',
        'bill record preserved with refunded status after cancellation',
      );
      const auditCount = (
        db
          .prepare('SELECT COUNT(*) AS c FROM order_audit_log WHERE order_id = ?')
          .get(String(paidScheduledOrderId)) as any
      ).c;
      assertOrThrow(auditCount >= 3, 'audit log history preserved on cancelled scheduled order');
      assertLedgerReconciles(db, 'after pre-release cancellation');

      // Cancelling AFTER release (while pending) DOES restore recorded snapshots, and rescheduling after release is 409!
      const postRelCreate = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: futureWallClockInZone('America/New_York', 60),
          items: [
            {
              product_id: 'prod-latte',
              quantity: 1,
              addons: [{ id: 'addon-syrup', quantity: 1 }],
            },
          ],
        },
      });
      const postRelId = Number(postRelCreate.data.order.id);
      const latteStockPreRel = productStock(db, 'prod-latte');
      const syrupStockPreRel = addonStock(db, 'addon-syrup');
      const beansStockPreRel = supplyStock(db, beans.id);

      const relNowRes = await api(baseUrl, `/api/orders/${postRelId}/release`, {
        method: 'POST',
        headers: owner.authHeader,
      });
      assertEqualOrThrow(relNowRes.status, 200, 'Release now succeeds');
      assertEqualOrThrow(
        productStock(db, 'prod-latte'),
        latteStockPreRel - 1,
        'stock deducted on release',
      );

      // Reschedule after release must fail with 409 ALREADY_RELEASED
      const reschedAfterRel = await api(baseUrl, `/api/orders/${postRelId}/schedule`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { scheduled_for: futureWallClockInZone('America/New_York', 120) },
      });
      assertEqualOrThrow(
        reschedAfterRel.status,
        409,
        'reschedule rejected with 409 once order is released',
      );
      assertEqualOrThrow(reschedAfterRel.data.code, 'ALREADY_RELEASED', 'code is ALREADY_RELEASED');

      // Cancel released pending order -> restores product, add-on, and recipe snapshots!
      const cancelRelRes = await api(baseUrl, `/api/orders/${postRelId}/status`, {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { status: 'cancelled', reason: 'Cancel after release' },
      });
      assertEqualOrThrow(cancelRelRes.status, 200, 'released pending order cancels cleanly');
      assertEqualOrThrow(
        productStock(db, 'prod-latte'),
        latteStockPreRel,
        'cancelling after release restores deducted product stock',
      );
      assertEqualOrThrow(
        addonStock(db, 'addon-syrup'),
        syrupStockPreRel,
        'cancelling after release restores deducted add-on stock',
      );
      assertEqualOrThrow(
        supplyStock(db, beans.id),
        beansStockPreRel,
        'cancelling after release restores deducted recipe snapshot',
      );
      assertLedgerReconciles(db, 'after post-release cancellation');
    }

    // ── 8. Shared transactional release checkPreconditions hook ──────────────
    console.log('\n--- 8. Shared releaseScheduledOrder checkPreconditions hook ---');
    {
      const hookCreate = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: futureWallClockInZone('America/New_York', 60),
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      const hookOrderId = Number(hookCreate.data.order.id);
      const stockBeforeHook = productStock(db, 'prod-latte');

      const skippedOutcome = await releaseScheduledOrder(db, hookOrderId, {
        trigger: 'sweep',
        checkPreconditions: () => ({
          allow: false,
          markBlocked: false,
          holdReason: 'Awaiting counter settlement',
        }),
      });
      assertEqualOrThrow(
        skippedOutcome.outcome,
        'skipped',
        'checkPreconditions(markBlocked: false) skips release cleanly',
      );
      assertEqualOrThrow(
        skippedOutcome.order.release_status,
        'scheduled',
        'skipped order stays scheduled',
      );
      assertEqualOrThrow(
        productStock(db, 'prod-latte'),
        stockBeforeHook,
        'skipped precondition check deducts nothing',
      );

      const blockedOutcome = await releaseScheduledOrder(db, hookOrderId, {
        trigger: 'manual',
        actorUserId: owner.userId,
        checkPreconditions: () => ({
          allow: false,
          markBlocked: true,
          holdReason: 'Checkout counter unpaid',
        }),
      });
      assertEqualOrThrow(
        blockedOutcome.outcome,
        'blocked',
        'checkPreconditions(markBlocked: true) atomically blocks release',
      );
      assertEqualOrThrow(
        blockedOutcome.order.release_blocked_reason,
        'Checkout counter unpaid',
        'checkPreconditions holdReason persisted',
      );

      // Verify unexpected release errors in sweepDueScheduledOrders are caught,
      // the offending order is marked blocked with a generic reason, and the sweep
      // continues processing subsequent orders without aborting.
      const poisonCreate = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: futureWallClockInZone('America/New_York', 60),
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      const poisonOrderId = Number(poisonCreate.data.order.id);

      const healthyCreate = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          type: 'takeaway',
          scheduled_for: futureWallClockInZone('America/New_York', 60),
          items: [{ product_id: 'prod-latte', quantity: 1 }],
        },
      });
      const healthyOrderId = Number(healthyCreate.data.order.id);

      const sweepDueTime = new Date(Date.parse(poisonCreate.data.order.scheduled_for) + 5_000);
      const isolatedSweepSummary = await sweepDueScheduledOrders(db, {
        nowDate: sweepDueTime,
        trigger: 'sweep',
        checkPreconditions: (ctx) => {
          if (Number(ctx.order.id) === poisonOrderId) {
            throw new Error('Simulated unexpected driver fault during release');
          }
          return { allow: true };
        },
      });

      assertOrThrow(
        isolatedSweepSummary.blockedIds.includes(poisonOrderId),
        'poison order with unexpected error marked blocked in sweep summary',
      );
      assertOrThrow(
        isolatedSweepSummary.releasedIds.includes(healthyOrderId),
        'healthy subsequent order successfully released despite prior poison order error',
      );
      const poisonDbOrder = db
        .prepare('SELECT release_status, release_blocked_reason FROM orders WHERE id = ?')
        .get(poisonOrderId) as { release_status: string; release_blocked_reason: string };
      assertEqualOrThrow(
        poisonDbOrder.release_status,
        'blocked',
        'poison order marked blocked in database',
      );
      assertIncludesOrThrow(
        poisonDbOrder.release_blocked_reason,
        'Automatic release failed due to an unexpected error',
        'poison order has generic actionable blocked reason',
      );

      assertLedgerReconciles(db, 'after checkPreconditions tests');
    }

    // ── 9. Prepaid scheduled order completion across KDS surfaces & KDS-disabled release ──
    console.log(
      '\n--- 9. Prepaid scheduled order completion across KDS surfaces & KDS-disabled release ---',
    );
    {
      withTxn(() => {
        adjustProductStock(db, {
          productId: 'prod-latte',
          quantityDelta: 20,
          movementType: 'adjustment',
          referenceType: 'opening_balance',
          reason: 'Restock for prepaid scheduled completion tests',
          actorUserId: owner.userId,
        });
      });

      const createPrepaidScheduledOrder = async (
        lineLabels: string[],
        options?: { pay?: boolean; partialRefundAmount?: number },
      ) => {
        const shouldPay = options?.pay !== false;
        const createRes = await api(baseUrl, '/api/orders', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            type: 'takeaway',
            scheduled_for: futureWallClockInZone('America/New_York', 60),
            items: lineLabels.map((label) => ({
              product_id: 'prod-latte',
              quantity: 1,
              special_instructions: label,
            })),
          },
        });
        assertEqualOrThrow(createRes.status, 201, 'create scheduled order for completion test');
        const createdOrderId = Number(createRes.data.order.id);
        let generatedBillId: number | null = null;

        if (shouldPay) {
          const genBillRes = await api(baseUrl, '/api/bills/generate', {
            method: 'POST',
            headers: owner.authHeader,
            body: { order_id: createdOrderId },
          });
          assertOrThrow(
            [200, 201].includes(genBillRes.status),
            'generate bill for prepaid scheduled order',
          );
          generatedBillId = Number(genBillRes.data.bill.id);
          const payRes = await api(baseUrl, `/api/bills/${generatedBillId}/payment`, {
            method: 'POST',
            headers: owner.authHeader,
            body: {
              method: 'card',
              transaction_id: `TXN-SCHED-COMP-${createdOrderId}`,
            },
          });
          assertEqualOrThrow(payRes.status, 200, 'settle prepaid scheduled order before release');
        }

        if (options?.partialRefundAmount && generatedBillId !== null) {
          const refundRes = await api(baseUrl, '/api/refunds', {
            method: 'POST',
            headers: owner.authHeader,
            body: {
              bill_id: generatedBillId,
              amount: options.partialRefundAmount,
              method: 'card',
              reason: 'Partial refund before release',
              approver_id: manager.userId,
              override_pin: '1234',
            },
          });
          assertEqualOrThrow(refundRes.status, 201, 'issue partial refund on scheduled order');
        }

        const releaseRes = await api(baseUrl, `/api/orders/${createdOrderId}/release`, {
          method: 'POST',
          headers: owner.authHeader,
        });
        assertEqualOrThrow(releaseRes.status, 200, 'release scheduled order');

        const detailRes = await api(baseUrl, `/api/orders/${createdOrderId}`, {
          headers: owner.authHeader,
        });
        assertEqualOrThrow(detailRes.status, 200, 'fetch released scheduled order details');
        return {
          orderId: createdOrderId,
          billId: generatedBillId,
          releasedOrder: releaseRes.data.order,
          items: detailRes.data.order.items as Array<{ id: number; status: string }>,
        };
      };

      // 9a. KDS enabled + PATCH /api/order-items/:id/status (2 items -> completes only on last item served)
      {
        const { orderId, releasedOrder, items } = await createPrepaidScheduledOrder([
          'Cup A',
          'Cup B',
        ]);
        assertEqualOrThrow(
          releasedOrder.status,
          'pending',
          'KDS-enabled prepaid order stays pending at release while active items exist',
        );
        assertEqualOrThrow(
          releasedOrder.completed_at ?? null,
          null,
          'completed_at remains null at release when KDS is enabled',
        );
        assertEqualOrThrow(items.length, 2, 'two active items created');

        const firstServed = await api(baseUrl, `/api/order-items/${items[0].id}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(firstServed.status, 200, 'first item transitions to served');
        assertEqualOrThrow(
          firstServed.data.order.status,
          'preparing',
          'order transitions to preparing while second item is still unserved',
        );

        const secondServed = await api(baseUrl, `/api/order-items/${items[1].id}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(secondServed.status, 200, 'last item transitions to served');
        assertEqualOrThrow(
          secondServed.data.order.status,
          'completed',
          'order auto-completes via /api/order-items/:id/status when last item becomes served',
        );
        assertOrThrow(
          Boolean(secondServed.data.order.completed_at),
          'completed_at recorded on auto-completed order',
        );

        const verified = await api(baseUrl, `/api/orders/${orderId}`, {
          headers: owner.authHeader,
        });
        assertEqualOrThrow(verified.data.order.status, 'completed', 'persisted order is completed');
      }

      // 9b. KDS enabled + PATCH /api/kds/items/:id/status on main API (:3001)
      {
        const { orderId, releasedOrder, items } = await createPrepaidScheduledOrder(['Main KDS']);
        assertEqualOrThrow(releasedOrder.status, 'pending', 'stays pending at release');

        const prepRes = await api(baseUrl, `/api/kds/items/${items[0].id}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'preparing' },
        });
        assertEqualOrThrow(prepRes.status, 200, 'preparing via /api/kds/items/:id/status');
        const midOrder = await api(baseUrl, `/api/orders/${orderId}`, {
          headers: owner.authHeader,
        });
        assertEqualOrThrow(
          midOrder.data.order.status,
          'preparing',
          'order transitions to preparing while item is preparing',
        );

        const servedRes = await api(baseUrl, `/api/kds/items/${items[0].id}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(servedRes.status, 200, 'served via /api/kds/items/:id/status');
        const doneOrder = await api(baseUrl, `/api/orders/${orderId}`, {
          headers: owner.authHeader,
        });
        assertEqualOrThrow(
          doneOrder.data.order.status,
          'completed',
          'order auto-completes via main /api/kds/items/:id/status',
        );
        assertOrThrow(
          Boolean(doneOrder.data.order.completed_at),
          'completed_at set via main /api/kds/items/:id/status',
        );
      }

      // 9c. KDS enabled + standalone KDS HTTP server (:3002) PATCH /api/kds/items/:id/status
      {
        const { orderId, releasedOrder, items } = await createPrepaidScheduledOrder([
          'Standalone KDS HTTP',
        ]);
        assertEqualOrThrow(releasedOrder.status, 'pending', 'stays pending at release');

        const standaloneServed = await api(kdsBaseUrl, `/api/kds/items/${items[0].id}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(
          standaloneServed.status,
          200,
          'served via standalone KDS server PATCH /api/kds/items/:id/status',
        );
        const doneOrder = await api(baseUrl, `/api/orders/${orderId}`, {
          headers: owner.authHeader,
        });
        assertEqualOrThrow(
          doneOrder.data.order.status,
          'completed',
          'order auto-completes via standalone KDS server',
        );
        assertOrThrow(
          Boolean(doneOrder.data.order.completed_at),
          'completed_at set via standalone KDS server',
        );
      }

      // 9d. KDS enabled + KDS WebSocket status_update
      {
        const { orderId, releasedOrder, items } = await createPrepaidScheduledOrder(['KDS WS']);
        assertEqualOrThrow(releasedOrder.status, 'pending', 'stays pending at release');

        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${getKdsPort()}/kds`);
          const timeout = setTimeout(() => {
            ws.terminate();
            reject(new Error('Timed out waiting for KDS WebSocket status_updated'));
          }, 5000);

          ws.on('error', (err: Error) => {
            clearTimeout(timeout);
            reject(err);
          });
          ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'auth', token: owner.token }));
          });
          ws.on('message', (raw: Buffer) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'auth_success') {
              ws.send(
                JSON.stringify({
                  type: 'status_update',
                  order_item_id: items[0].id,
                  status: 'served',
                }),
              );
            } else if (msg.type === 'status_updated' && Number(msg.order_item_id) === items[0].id) {
              clearTimeout(timeout);
              ws.close();
              resolve();
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              ws.close();
              reject(new Error(`KDS WS error: ${msg.message}`));
            }
          });
        });

        const doneOrder = await api(baseUrl, `/api/orders/${orderId}`, {
          headers: owner.authHeader,
        });
        assertEqualOrThrow(
          doneOrder.data.order.status,
          'completed',
          'order auto-completes via KDS WebSocket status_update',
        );
        assertOrThrow(
          Boolean(doneOrder.data.order.completed_at),
          'completed_at set via KDS WebSocket status_update',
        );
      }

      // 9e. Partially refunded scheduled order does NOT auto-complete when item becomes served
      {
        const { orderId, releasedOrder, items } = await createPrepaidScheduledOrder(
          ['Partially Refunded'],
          { partialRefundAmount: 50 },
        );
        assertEqualOrThrow(
          releasedOrder.status,
          'pending',
          'partially refunded order stays pending at release',
        );

        const servedRes = await api(baseUrl, `/api/order-items/${items[0].id}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(servedRes.status, 200, 'partially refunded order item marked served');
        const afterServed = await api(baseUrl, `/api/orders/${orderId}`, {
          headers: owner.authHeader,
        });
        assertEqualOrThrow(
          afterServed.data.order.status,
          'served',
          'partially refunded order transitions to served without auto-completing to completed',
        );
        assertEqualOrThrow(
          afterServed.data.order.completed_at ?? null,
          null,
          'partially refunded order leaves completed_at null',
        );
      }

      // 9f. KDS disabled -> settled non-refunded scheduled order completes immediately at release
      setStoreSetting(db, 'kds_enabled', 'false');
      try {
        const settledNoKds = await createPrepaidScheduledOrder(['No KDS Paid']);
        assertEqualOrThrow(
          settledNoKds.releasedOrder.status,
          'completed',
          'settled non-refunded order completes immediately at release when KDS is disabled',
        );
        assertOrThrow(
          Boolean(settledNoKds.releasedOrder.completed_at),
          'completed_at populated at release when KDS is disabled',
        );

        const unpaidNoKds = await createPrepaidScheduledOrder(['No KDS Unpaid'], { pay: false });
        assertEqualOrThrow(
          unpaidNoKds.releasedOrder.status,
          'pending',
          'unpaid scheduled order stays pending at release when KDS is disabled',
        );
        assertEqualOrThrow(
          unpaidNoKds.releasedOrder.completed_at ?? null,
          null,
          'unpaid scheduled order leaves completed_at null at release',
        );

        const refundedNoKds = await createPrepaidScheduledOrder(['No KDS Partially Refunded'], {
          partialRefundAmount: 50,
        });
        assertEqualOrThrow(
          refundedNoKds.releasedOrder.status,
          'pending',
          'partially refunded scheduled order stays pending at release when KDS is disabled',
        );
      } finally {
        setStoreSetting(db, 'kds_enabled', 'true');
      }

      assertLedgerReconciles(db, 'after prepaid scheduled order completion tests');

      // 9g. 3-decimal country (BH -> BHD) with unset settings.currency + missing-country 409 guard
      seedProduct(db, 'prod-bhd-sweet', 'cat-sched', 'Bahraini Sweet', 0.503, {
        track_inventory: false,
        stock_quantity: 0,
      });
      seedProduct(db, 'prod-bhd-tea', 'cat-sched', 'Bahraini Tea', 1, {
        track_inventory: false,
        stock_quantity: 0,
      });

      try {
        setStoreSetting(db, 'country', 'BH');
        setStoreSetting(db, 'timezone', 'Asia/Bahrain');
        db.prepare("DELETE FROM settings WHERE key = 'currency'").run();

        // Split 1.006 BHD order across two paid 0.503 BHD bills -> auto-completes on KDS served
        const bhdSplitCreate = await api(baseUrl, '/api/orders', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            type: 'takeaway',
            scheduled_for: futureWallClockInZone('Asia/Bahrain', 60),
            items: [{ product_id: 'prod-bhd-sweet', quantity: 2 }],
          },
        });
        assertEqualOrThrow(bhdSplitCreate.status, 201, 'create 1.006 BHD scheduled order');
        const bhdSplitOrderId = Number(bhdSplitCreate.data.order.id);
        assertEqualOrThrow(
          Number(bhdSplitCreate.data.order.total),
          1.006,
          'order total resolved using 3-decimal BHD from country BH',
        );

        const insertBhdBill = db.prepare(
          `INSERT INTO bills (
             bill_number, order_id, subtotal, total, paid_amount, balance,
             payment_status, payment_details, paid_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`,
        );
        const billTs = now();
        insertBhdBill.run(
          `BILL-BHD-${bhdSplitOrderId}-1`,
          bhdSplitOrderId,
          0.503,
          0.503,
          0.503,
          0,
          JSON.stringify([{ method: 'card', amount: 0.503 }]),
          billTs,
          billTs,
          billTs,
        );
        insertBhdBill.run(
          `BILL-BHD-${bhdSplitOrderId}-2`,
          bhdSplitOrderId,
          0.503,
          0.503,
          0.503,
          0,
          JSON.stringify([{ method: 'card', amount: 0.503 }]),
          billTs,
          billTs,
          billTs,
        );

        const bhdSplitRel = await api(baseUrl, `/api/orders/${bhdSplitOrderId}/release`, {
          method: 'POST',
          headers: owner.authHeader,
        });
        assertEqualOrThrow(bhdSplitRel.status, 200, 'release 1.006 BHD split order');
        assertEqualOrThrow(
          bhdSplitRel.data.order.status,
          'pending',
          'BHD split order stays pending at release while KDS is enabled',
        );
        const bhdSplitDetail = await api(baseUrl, `/api/orders/${bhdSplitOrderId}`, {
          headers: owner.authHeader,
        });
        const bhdSplitItemId = Number(bhdSplitDetail.data.order.items[0].id);

        const bhdSplitServed = await api(baseUrl, `/api/order-items/${bhdSplitItemId}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(bhdSplitServed.status, 200, 'mark 1.006 BHD split item served');
        assertEqualOrThrow(
          bhdSplitServed.data.order.status,
          'completed',
          '1.006 BHD split order auto-completes on served without USD 2-decimal rounding loss',
        );

        // Unpaid 0.004 BHD balance (0.996 paid on 1.000 BHD) must NOT round to 0 or auto-complete
        const bhdShortCreate = await api(baseUrl, '/api/orders', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            type: 'takeaway',
            scheduled_for: futureWallClockInZone('Asia/Bahrain', 60),
            items: [{ product_id: 'prod-bhd-tea', quantity: 1 }],
          },
        });
        assertEqualOrThrow(bhdShortCreate.status, 201, 'create 1.000 BHD scheduled order');
        const bhdShortOrderId = Number(bhdShortCreate.data.order.id);
        insertBhdBill.run(
          `BILL-BHD-${bhdShortOrderId}-SHORT`,
          bhdShortOrderId,
          1,
          1,
          0.996,
          0.004,
          JSON.stringify([{ method: 'card', amount: 0.996 }]),
          billTs,
          billTs,
          billTs,
        );
        const bhdShortRel = await api(baseUrl, `/api/orders/${bhdShortOrderId}/release`, {
          method: 'POST',
          headers: owner.authHeader,
        });
        assertEqualOrThrow(bhdShortRel.status, 200, 'release 0.004 BHD balance order');
        const bhdShortDetail = await api(baseUrl, `/api/orders/${bhdShortOrderId}`, {
          headers: owner.authHeader,
        });
        const bhdShortItemId = Number(bhdShortDetail.data.order.items[0].id);
        const bhdShortServed = await api(baseUrl, `/api/order-items/${bhdShortItemId}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(bhdShortServed.status, 200, 'mark 0.004 BHD balance item served');
        assertEqualOrThrow(
          bhdShortServed.data.order.status,
          'served',
          '0.004 BHD unpaid balance blocks auto-completion to completed under 3-decimal BHD minor units',
        );
        assertEqualOrThrow(
          bhdShortServed.data.order.completed_at ?? null,
          null,
          '0.004 BHD unpaid balance leaves completed_at null',
        );

        // KDS disabled -> 1.006 BHD split order completes immediately at release
        setStoreSetting(db, 'kds_enabled', 'false');
        const bhdNoKdsCreate = await api(baseUrl, '/api/orders', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            type: 'takeaway',
            scheduled_for: futureWallClockInZone('Asia/Bahrain', 60),
            items: [{ product_id: 'prod-bhd-sweet', quantity: 2 }],
          },
        });
        assertEqualOrThrow(bhdNoKdsCreate.status, 201, 'create KDS-disabled 1.006 BHD order');
        const bhdNoKdsOrderId = Number(bhdNoKdsCreate.data.order.id);
        insertBhdBill.run(
          `BILL-BHD-${bhdNoKdsOrderId}-1`,
          bhdNoKdsOrderId,
          0.503,
          0.503,
          0.503,
          0,
          JSON.stringify([{ method: 'card', amount: 0.503 }]),
          billTs,
          billTs,
          billTs,
        );
        insertBhdBill.run(
          `BILL-BHD-${bhdNoKdsOrderId}-2`,
          bhdNoKdsOrderId,
          0.503,
          0.503,
          0.503,
          0,
          JSON.stringify([{ method: 'card', amount: 0.503 }]),
          billTs,
          billTs,
          billTs,
        );
        const bhdNoKdsRel = await api(baseUrl, `/api/orders/${bhdNoKdsOrderId}/release`, {
          method: 'POST',
          headers: owner.authHeader,
        });
        assertEqualOrThrow(bhdNoKdsRel.status, 200, 'release KDS-disabled 1.006 BHD order');
        assertEqualOrThrow(
          bhdNoKdsRel.data.order.status,
          'completed',
          'KDS-disabled 1.006 BHD split order completes immediately at release',
        );
        setStoreSetting(db, 'kds_enabled', 'true');

        // Unconfigured country + currency fails loudly with 409 rather than defaulting to USD
        const missingRegCreate = await api(baseUrl, '/api/orders', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            type: 'takeaway',
            scheduled_for: futureWallClockInZone('Asia/Bahrain', 60),
            items: [{ product_id: 'prod-bhd-tea', quantity: 1 }],
          },
        });
        const missingRegOrderId = Number(missingRegCreate.data.order.id);
        insertBhdBill.run(
          `BILL-BHD-${missingRegOrderId}-PAID`,
          missingRegOrderId,
          1,
          1,
          1,
          0,
          JSON.stringify([{ method: 'card', amount: 1 }]),
          billTs,
          billTs,
          billTs,
        );

        db.prepare("DELETE FROM settings WHERE key IN ('currency', 'country')").run();
        const missingRegRel = await api(baseUrl, `/api/orders/${missingRegOrderId}/release`, {
          method: 'POST',
          headers: owner.authHeader,
        });
        assertEqualOrThrow(
          missingRegRel.status,
          409,
          'POST /api/orders/:id/release returns 409 when regional country/currency are missing',
        );

        setStoreSetting(db, 'country', 'BH');
        const okRel = await api(baseUrl, `/api/orders/${missingRegOrderId}/release`, {
          method: 'POST',
          headers: owner.authHeader,
        });
        assertEqualOrThrow(okRel.status, 200, 'release succeeds once country is set');
        const missingRegDetail = await api(baseUrl, `/api/orders/${missingRegOrderId}`, {
          headers: owner.authHeader,
        });
        const missingItemId = Number(missingRegDetail.data.order.items[0].id);

        db.prepare("DELETE FROM settings WHERE key IN ('currency', 'country')").run();
        const item409Res1 = await api(baseUrl, `/api/order-items/${missingItemId}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(
          item409Res1.status,
          409,
          'PATCH /api/order-items/:id/status returns 409 when regional settings are missing',
        );

        const item409Res2 = await api(baseUrl, `/api/kds/items/${missingItemId}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(
          item409Res2.status,
          409,
          'PATCH /api/kds/items/:id/status returns 409 when regional settings are missing',
        );

        const item409Res3 = await api(kdsBaseUrl, `/api/kds/items/${missingItemId}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(
          item409Res3.status,
          409,
          'standalone KDS PATCH returns 409 when regional settings are missing',
        );

        const after409Detail = await api(baseUrl, `/api/orders/${missingRegOrderId}`, {
          headers: owner.authHeader,
        });
        assertEqualOrThrow(
          after409Detail.data.order.items[0].status,
          'pending',
          'item status update rolls back cleanly when regional check returns 409',
        );

        setStoreSetting(db, 'country', 'BH');
        const recoveredServed = await api(baseUrl, `/api/order-items/${missingItemId}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: { status: 'served' },
        });
        assertEqualOrThrow(recoveredServed.status, 200, 'served succeeds after restoring country');
        assertEqualOrThrow(
          recoveredServed.data.order.status,
          'completed',
          'restored BH regional setting completes paid order on served',
        );
      } finally {
        setStoreSetting(db, 'country', 'US');
        setStoreSetting(db, 'currency', 'USD');
        setStoreSetting(db, 'timezone', 'America/New_York');
        setStoreSetting(db, 'kds_enabled', 'true');
      }
    }

    // ── 11. /orders UI surfaces: Refund exposure, payment badges, post-payment edit lock, and cancel error ─
    console.log('\n--- 11. /orders UI surfaces (OrderCard, OrderDetailPanel, PaymentModal) ---');
    {
      const rootDir = path.resolve(__dirname, '..');
      const frontendRequire = Module.createRequire(path.join(rootDir, 'frontend/package.json'));
      const zustandPath = frontendRequire.resolve('zustand');
      const resolveFrontendPackage = (reqName: string): string | null => {
        if (reqName.startsWith('.') || path.isAbsolute(reqName) || reqName.startsWith('node:')) {
          return null;
        }
        try {
          return frontendRequire.resolve(reqName);
        } catch {
          return null;
        }
      };
      const origResolveFilename = Module._resolveFilename;
      Module._resolveFilename = function (
        reqName: string,
        parent: unknown,
        isMain: boolean,
        options?: unknown,
      ) {
        const resolvedRequest =
          reqName === 'zustand'
            ? zustandPath
            : reqName === '@countries'
              ? path.resolve(rootDir, 'main/countries.ts')
              : reqName.startsWith('@/')
                ? path.resolve(rootDir, 'frontend/src', reqName.slice(2))
                : reqName.startsWith('@print/')
                  ? path.resolve(rootDir, 'shared/print', reqName.slice('@print/'.length))
                  : reqName.startsWith('@shared/')
                    ? path.resolve(rootDir, 'shared', reqName.slice('@shared/'.length))
                    : (resolveFrontendPackage(reqName) ?? reqName);
        return origResolveFilename.call(this, resolvedRequest, parent, isMain, options);
      };
      try {
        const React = frontendRequire('react');
        const ReactDOMServer = frontendRequire('react-dom/server');
        const { IntlProvider } = frontendRequire('use-intl');
        const messages = require('../frontend/src/lib/i18n/messages/en.json');
        const { useAuthStore } = require('../frontend/src/store/auth');
        const { OrderCard } = require('../frontend/src/components/orders/OrderCard');
        const { OrderDetailPanel } = require('../frontend/src/components/orders/OrderDetailPanel');
        const PaymentModal = require('../frontend/src/components/pos/PaymentModal').default;
        const {
          canCheckoutOrder,
          getCancelOrderFailureKind,
          isOrderCustomerEditLocked,
          isOrderItemEditLocked,
          isScheduledEditLockedError,
          resolveOrderPaymentStatus,
        } = require('../frontend/src/lib/order-payment-state');

        useAuthStore.setState({
          user: { id: owner.userId, role: 'owner', name: 'Owner', email: 'owner@test.com' },
          currentTenant: {
            id: 'local',
            business_name: 'FloCafe Test',
            role: 'owner',
            currency: 'USD',
            country: 'US',
          },
        });

        const renderWithIntl = (element: unknown) =>
          ReactDOMServer.renderToStaticMarkup(
            React.createElement(
              IntlProvider,
              { locale: 'en', messages, onError: () => {} },
              element,
            ),
          );

        const buildSurfaceProps = (orderRow: unknown) => ({
          order: orderRow,
          now: Date.now(),
          canCancelItems: true,
          canEditItems: true,
          onEditItem: () => {},
          canOverridePrice: true,
          onOverridePrice: () => {},
          canRestoreItems: true,
          canRefund: true,
          isWhatsAppReady: false,
          printHistory: {},
          generatingBillId: null,
          printingBillId: null,
          sendingWaOrderId: null,
          cancellingOrderId: null,
          convertingOrderId: null,
          onCheckout: () => {},
          onAddItems: () => {},
          onRefund: () => {},
          onConvertToTakeaway: () => {},
          onCancelOrder: () => {},
          onPrint: () => {},
          onSendWhatsApp: () => {},
          onLinkCustomer: () => {},
          onCreateNewOrderForCustomer: () => {},
          onDeleteItem: () => {},
          onVoidItem: () => {},
          onRestoreItem: () => {},
        });

        const fetchOrderFromActiveFeed = async (targetOrderId: number) => {
          const listRes = await api(baseUrl, '/api/orders?view=active', {
            headers: owner.authHeader,
          });
          assertEqualOrThrow(listRes.status, 200, 'GET /api/orders?view=active succeeds');
          const found = (listRes.data.orders as Array<{ id: number }>).find(
            (o) => Number(o.id) === Number(targetOrderId),
          );
          assertOrThrow(Boolean(found), `order ${targetOrderId} returned in active /orders feed`);
          return found as any;
        };

        // 11a. Unpaid scheduled order on /orders allows edits, Checkout, Add Item, and Discount in PaymentModal
        const uiSchedRes = await api(baseUrl, '/api/orders', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            type: 'takeaway',
            scheduled_for: futureWallClockInZone('America/New_York', 90),
            items: [{ product_id: 'prod-latte', quantity: 2 }],
          },
        });
        assertEqualOrThrow(uiSchedRes.status, 201, 'create scheduled order for /orders UI test');
        const uiSchedOrderId = Number(uiSchedRes.data.order.id);

        const unpaidScheduled = await fetchOrderFromActiveFeed(uiSchedOrderId);
        assertEqualOrThrow(
          resolveOrderPaymentStatus(unpaidScheduled),
          'unpaid',
          'unpaid scheduled order resolves unpaid badge',
        );
        const unpaidCardHtml = renderWithIntl(
          React.createElement(OrderCard, buildSurfaceProps(unpaidScheduled)),
        );
        const unpaidPanelHtml = renderWithIntl(
          React.createElement(OrderDetailPanel, buildSurfaceProps(unpaidScheduled)),
        );
        assertIncludesOrThrow(unpaidCardHtml, 'Unpaid', 'unpaid OrderCard shows Unpaid badge');
        assertIncludesOrThrow(unpaidCardHtml, 'Checkout', 'unpaid OrderCard shows Checkout');
        assertIncludesOrThrow(unpaidCardHtml, 'Add Item', 'unpaid OrderCard shows Add Item');
        assertIncludesOrThrow(
          unpaidCardHtml,
          'Link Customer',
          'unpaid OrderCard shows Link Customer',
        );
        assertIncludesOrThrow(
          unpaidCardHtml,
          'title="Edit item"',
          'unpaid OrderCard shows Edit item',
        );
        assertIncludesOrThrow(
          unpaidPanelHtml,
          'Add Item',
          'unpaid OrderDetailPanel shows Add Item',
        );
        assertOrThrow(
          !unpaidCardHtml.includes('>Refund<'),
          'unpaid OrderCard hides Refund before payment',
        );

        const uiBillGenRes = await api(baseUrl, '/api/bills/generate', {
          method: 'POST',
          headers: owner.authHeader,
          body: { order_id: String(uiSchedOrderId) },
        });
        assertEqualOrThrow(uiBillGenRes.status, 201, 'generate bill for scheduled order');
        const uiBillId = Number(uiBillGenRes.data.bill.id);
        const unpaidPaymentModalHtml = renderWithIntl(
          React.createElement(PaymentModal, {
            bill: uiBillGenRes.data.bill,
            currency: '$',
            onClose: () => {},
            onPaid: () => {},
          }),
        );
        assertIncludesOrThrow(
          unpaidPaymentModalHtml,
          'Apply Discount',
          'unpaid scheduled bill shows Apply Discount in PaymentModal',
        );

        // 11b. Record partial payment + release to kitchen -> no longer in ScheduledOrdersDrawer,
        //      so /orders MUST expose Refund alongside Take Payment AND lock edits/discounts!
        const partialPayUiRes = await api(baseUrl, `/api/bills/${uiBillId}/payment`, {
          method: 'POST',
          headers: owner.authHeader,
          body: { method: 'cash', amount: 80 },
        });
        assertEqualOrThrow(partialPayUiRes.status, 200, 'record partial payment');

        const releaseUiRes = await api(baseUrl, `/api/orders/${uiSchedOrderId}/release`, {
          method: 'POST',
          headers: owner.authHeader,
        });
        assertEqualOrThrow(
          releaseUiRes.status,
          200,
          'release partially paid scheduled order to kitchen',
        );

        const partialReleased = await fetchOrderFromActiveFeed(uiSchedOrderId);
        assertEqualOrThrow(partialReleased.release_status, 'released', 'order is released');
        assertEqualOrThrow(partialReleased.status, 'pending', 'released order is pending');
        assertEqualOrThrow(
          resolveOrderPaymentStatus(partialReleased),
          'partial',
          'partial released scheduled order resolves partial badge',
        );
        assertEqualOrThrow(
          isOrderItemEditLocked(partialReleased),
          true,
          'item edits locked on released scheduled order after partial payment',
        );
        assertEqualOrThrow(
          isOrderCustomerEditLocked(partialReleased),
          true,
          'customer edits locked on released scheduled order after partial payment',
        );

        const partialCardHtml = renderWithIntl(
          React.createElement(OrderCard, buildSurfaceProps(partialReleased)),
        );
        const partialPanelHtml = renderWithIntl(
          React.createElement(OrderDetailPanel, buildSurfaceProps(partialReleased)),
        );
        assertIncludesOrThrow(
          partialCardHtml,
          'Partially Paid',
          'OrderCard shows Partially Paid badge',
        );
        assertIncludesOrThrow(
          partialCardHtml,
          'Take Payment',
          'OrderCard keeps Take Payment for remaining balance',
        );
        assertIncludesOrThrow(
          partialCardHtml,
          'Refund',
          'OrderCard exposes Refund on pending partially paid scheduled order',
        );
        assertIncludesOrThrow(
          partialPanelHtml,
          'Refund',
          'OrderDetailPanel exposes Refund on pending partially paid scheduled order',
        );
        for (const [label, html] of [
          ['OrderCard', partialCardHtml],
          ['OrderDetailPanel', partialPanelHtml],
        ] as const) {
          assertOrThrow(
            !html.includes('Add Item'),
            `${label} hides Add Item after first payment on scheduled order`,
          );
          assertOrThrow(
            !html.includes('Link Customer'),
            `${label} hides Link Customer after first payment on scheduled order`,
          );
          assertOrThrow(
            !html.includes('title="Edit item"'),
            `${label} hides Edit item after first payment on scheduled order`,
          );
          assertOrThrow(
            !html.includes('title="Override price"'),
            `${label} hides Override price after first payment on scheduled order`,
          );
          assertOrThrow(
            !html.includes('title="Remove item"'),
            `${label} hides Remove item after first payment on scheduled order`,
          );
        }

        const partialBillLookup = await api(baseUrl, '/api/bills/generate', {
          method: 'POST',
          headers: owner.authHeader,
          body: { order_id: String(uiSchedOrderId) },
        });
        assertEqualOrThrow(partialBillLookup.status, 200, 'fetch partial bill');
        const partialPaymentModalHtml = renderWithIntl(
          React.createElement(PaymentModal, {
            bill: partialBillLookup.data.bill,
            currency: '$',
            onClose: () => {},
            onPaid: () => {},
          }),
        );
        assertOrThrow(
          !partialPaymentModalHtml.includes('Apply Discount'),
          'PaymentModal locks Apply Discount after first payment on scheduled order',
        );

        // Cancel attempt fails with REFUND_REQUIRED_BEFORE_CANCEL and classifies specifically
        const cancelBeforeRefund = await api(baseUrl, `/api/orders/${uiSchedOrderId}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: {
            status: 'cancelled',
            reason: 'Customer cancelled',
            approver_id: manager.userId,
            override_pin: '1234',
          },
        });
        assertEqualOrThrow(
          cancelBeforeRefund.status,
          409,
          'cancel rejected with 409 while partial payment remains unrefunded',
        );
        assertEqualOrThrow(
          getCancelOrderFailureKind({ response: { data: cancelBeforeRefund.data } }),
          'refund_required_before_cancel',
          'orders/page cancel failure classifier identifies REFUND_REQUIRED_BEFORE_CANCEL',
        );
        assertEqualOrThrow(
          isScheduledEditLockedError({
            response: { data: { code: 'SCHEDULED_ORDER_PAID' } },
          }),
          true,
          'scheduled edit lock error helper matches SCHEDULED_ORDER_PAID',
        );

        const {
          canPayScheduledOrder,
          isPayableBill,
          isPayableBillStatus,
        } = require('../frontend/src/lib/order-payment-state');
        assertEqualOrThrow(
          isPayableBillStatus('unpaid'),
          true,
          'isPayableBillStatus accepts unpaid',
        );
        assertEqualOrThrow(
          isPayableBillStatus('partial'),
          true,
          'isPayableBillStatus accepts partial',
        );
        assertEqualOrThrow(
          isPayableBillStatus('partially_paid'),
          true,
          'isPayableBillStatus accepts partially_paid',
        );
        assertEqualOrThrow(
          isPayableBillStatus('paid'),
          false,
          'isPayableBillStatus rejects paid',
        );
        assertEqualOrThrow(
          isPayableBillStatus('refunded'),
          false,
          'isPayableBillStatus rejects refunded',
        );
        assertEqualOrThrow(
          isPayableBill({ payment_status: 'partially_paid' } as any),
          true,
          'isPayableBill accepts partially_paid bill',
        );
        assertEqualOrThrow(
          isPayableBill({ payment_status: 'paid' } as any),
          false,
          'isPayableBill rejects paid bill',
        );
        assertEqualOrThrow(
          canPayScheduledOrder({ bills: [{ payment_status: 'partially_paid' }] } as any),
          true,
          'canPayScheduledOrder accepts order with partially_paid bill',
        );
        assertEqualOrThrow(
          canPayScheduledOrder({ bills: [{ payment_status: 'paid' }] } as any),
          false,
          'canPayScheduledOrder rejects order when all bills are paid',
        );

        // 11c. Partial refund ($30 of $80) -> Partially Refunded badge, Checkout suppressed, Refund still exposed!
        const partialRefundUiRes = await api(baseUrl, '/api/refunds', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            bill_id: uiBillId,
            amount: 30,
            method: 'cash',
            reason: 'Partial refund on /orders',
            approver_id: manager.userId,
            override_pin: '1234',
          },
        });
        assertEqualOrThrow(partialRefundUiRes.status, 201, 'issue partial refund');

        const partiallyRefundedOrder = await fetchOrderFromActiveFeed(uiSchedOrderId);
        assertEqualOrThrow(
          resolveOrderPaymentStatus(partiallyRefundedOrder),
          'partially_refunded',
          'partially refunded order resolves partially_refunded badge',
        );
        assertEqualOrThrow(
          canCheckoutOrder(partiallyRefundedOrder),
          false,
          'partially_refunded bill suppresses Checkout (backend rejects pay on refunded bills)',
        );
        const partRefCardHtml = renderWithIntl(
          React.createElement(OrderCard, buildSurfaceProps(partiallyRefundedOrder)),
        );
        const partRefPanelHtml = renderWithIntl(
          React.createElement(OrderDetailPanel, buildSurfaceProps(partiallyRefundedOrder)),
        );
        assertIncludesOrThrow(
          partRefCardHtml,
          'Partially Refunded',
          'OrderCard shows Partially Refunded badge instead of Unpaid',
        );
        assertIncludesOrThrow(
          partRefPanelHtml,
          'Partially Refunded',
          'OrderDetailPanel shows Partially Refunded badge instead of Unpaid',
        );
        assertIncludesOrThrow(
          partRefCardHtml,
          'Refund',
          'OrderCard keeps Refund exposed for remaining refundable balance',
        );
        assertIncludesOrThrow(
          partRefPanelHtml,
          'Refund',
          'OrderDetailPanel keeps Refund exposed for remaining refundable balance',
        );
        assertOrThrow(
          !partRefCardHtml.includes('Checkout') && !partRefCardHtml.includes('Take Payment'),
          'OrderCard suppresses Checkout/Take Payment on partially_refunded order',
        );
        assertOrThrow(
          !partRefPanelHtml.includes('Checkout') && !partRefPanelHtml.includes('Take Payment'),
          'OrderDetailPanel suppresses Checkout/Take Payment on partially_refunded order',
        );

        // 11d. Refund remaining $50 -> Refunded badge, Checkout & Refund suppressed, cancellation now succeeds!
        const fullRefundUiRes = await api(baseUrl, '/api/refunds', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            bill_id: uiBillId,
            amount: 50,
            method: 'cash',
            reason: 'Remaining refund before cancel',
            approver_id: manager.userId,
            override_pin: '1234',
          },
        });
        assertEqualOrThrow(fullRefundUiRes.status, 201, 'issue remaining refund to $0 net paid');

        const fullyRefundedOrder = await fetchOrderFromActiveFeed(uiSchedOrderId);
        assertEqualOrThrow(
          resolveOrderPaymentStatus(fullyRefundedOrder),
          'refunded',
          'fully refunded pending order resolves refunded badge',
        );
        assertEqualOrThrow(
          canCheckoutOrder(fullyRefundedOrder),
          false,
          'fully refunded order suppresses Checkout',
        );
        const fullRefCardHtml = renderWithIntl(
          React.createElement(OrderCard, buildSurfaceProps(fullyRefundedOrder)),
        );
        const fullRefPanelHtml = renderWithIntl(
          React.createElement(OrderDetailPanel, buildSurfaceProps(fullyRefundedOrder)),
        );
        assertIncludesOrThrow(
          fullRefCardHtml,
          'Refunded',
          'OrderCard shows Refunded badge instead of Unpaid',
        );
        assertIncludesOrThrow(
          fullRefPanelHtml,
          'Refunded',
          'OrderDetailPanel shows Refunded badge instead of Unpaid',
        );
        assertOrThrow(
          !fullRefCardHtml.includes('Checkout') &&
            !fullRefCardHtml.includes('Take Payment') &&
            !fullRefCardHtml.includes('>Refund<'),
          'OrderCard suppresses Checkout and Refund once fully refunded',
        );
        assertOrThrow(
          !fullRefPanelHtml.includes('Checkout') &&
            !fullRefPanelHtml.includes('Take Payment') &&
            !fullRefPanelHtml.includes('>Refund<'),
          'OrderDetailPanel suppresses Checkout and Refund once fully refunded',
        );

        const cancelAfterFullRefundUi = await api(baseUrl, `/api/orders/${uiSchedOrderId}/status`, {
          method: 'PATCH',
          headers: owner.authHeader,
          body: {
            status: 'cancelled',
            reason: 'Refunded in full on /orders',
            approver_id: manager.userId,
            override_pin: '1234',
          },
        });
        assertEqualOrThrow(
          cancelAfterFullRefundUi.status,
          200,
          'released scheduled order cancels cleanly once refunded in full via /orders',
        );

        // 11e. Ordinary (non-scheduled) partial order retains Add Item while gaining Refund on /orders
        const regularOrderRes = await api(baseUrl, '/api/orders', {
          method: 'POST',
          headers: owner.authHeader,
          body: {
            type: 'takeaway',
            items: [{ product_id: 'prod-latte', quantity: 2 }],
          },
        });
        assertEqualOrThrow(regularOrderRes.status, 201, 'create regular non-scheduled order');
        const regularOrderId = Number(regularOrderRes.data.order.id);
        const regBillGen = await api(baseUrl, '/api/bills/generate', {
          method: 'POST',
          headers: owner.authHeader,
          body: { order_id: String(regularOrderId) },
        });
        const regBillId = Number(regBillGen.data.bill.id);
        const regPartialPay = await api(baseUrl, `/api/bills/${regBillId}/payment`, {
          method: 'POST',
          headers: owner.authHeader,
          body: { method: 'cash', amount: 50, override_pin: '9999' },
        });
        assertEqualOrThrow(regPartialPay.status, 200, 'partial payment on regular order');

        const regularPartial = await fetchOrderFromActiveFeed(regularOrderId);
        const regCardHtml = renderWithIntl(
          React.createElement(OrderCard, buildSurfaceProps(regularPartial)),
        );
        assertIncludesOrThrow(
          regCardHtml,
          'Take Payment',
          'regular partial order keeps Take Payment',
        );
        assertIncludesOrThrow(regCardHtml, 'Add Item', 'regular partial order keeps Add Item');
        assertIncludesOrThrow(regCardHtml, 'Refund', 'regular partial order also exposes Refund');
      } finally {
        Module._resolveFilename = origResolveFilename;
      }
    }

    const results = getResults();
    console.log('\n' + '='.repeat(66));
    console.log(`Passed: ${results.passed}/${results.total}`);
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
  console.error('Scheduled orders test failed:', err);
  process.exit(1);
});
