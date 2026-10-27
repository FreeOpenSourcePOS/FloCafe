/**
 * End-to-End Integration Test: Issue #1348
 * Multi-station KOT routing from the Waiter App (Server App -> Main API -> Thermal Transport)
 *
 * Verifies that when the Waiter App (server-standalone) sends an order and posts
 * `/api/printers/print-kot` with no `stationName` through `main/server-app.ts`:
 *  1. `main/server-app.ts` authenticates the waiter and forwards `/api/printers/print-kot`
 *     to `main/routes/printers.ts` on the Main API.
 *  2. `main/routes/printers.ts` invokes `routeItemsToStations()` to split items across
 *     mapped category station printers and falls back to the default Kitchen printer for
 *     unmapped items.
 *  3. `printKOTDetailed` / `printViaNetwork` in `main/printers/thermal.ts` dispatches
 *     separate ESC/POS KOT payloads to each physical station printer with only its
 *     own items.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/server-app-station-routing.test.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-server-app-station-routing-'));

class RasterSurfaceStub {
  destroyed = false;
  webContents = {
    on: () => {},
    removeListener: () => {},
    send: () => {},
    loadURL: async () => {},
  };
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.destroyed = true;
  }
  on() {}
  removeListener() {}
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      ipcMain: { on: () => {}, removeListener: () => {}, handle: () => {} },
      BrowserWindow: RasterSurfaceStub,
    };
  }
  return originalLoad.apply(this, arguments as any);
};

interface RecordedDispatch {
  ip: string;
  port: number;
  bytes: Buffer;
  text: string;
}

const DEFAULT_KITCHEN_PRINTER = {
  id: 'pr-default-kitchen',
  name: 'Main Kitchen Printer',
  ip: '192.0.2.100',
  port: 9100,
};

const GRILL_STATION_PRINTER = {
  id: 'pr-grill',
  name: 'Grill Station Printer',
  ip: '192.0.2.101',
  port: 9101,
};

const BAR_STATION_PRINTER = {
  id: 'pr-bar',
  name: 'Bar Station Printer',
  ip: '192.0.2.102',
  port: 9102,
};

const STUBBED_PRINTER_IPS = new Set([
  DEFAULT_KITCHEN_PRINTER.ip,
  GRILL_STATION_PRINTER.ip,
  BAR_STATION_PRINTER.ip,
]);

async function getFreeTcpPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function postJson(
  baseUrl: string,
  pathName: string,
  body: unknown,
  token?: string,
  extraHeaders?: Record<string, string>,
) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsedBody = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  return { status: response.status, body: parsedBody };
}

function assertMultiStationRouting(dispatches: RecordedDispatch[]) {
  assert.equal(
    dispatches.length,
    3,
    `Expected 3 separate KOT dispatches (Grill, Bar, fallback Kitchen), got ${dispatches.length}`,
  );

  const grillDispatches = dispatches.filter(
    (d) => d.ip === GRILL_STATION_PRINTER.ip && d.port === GRILL_STATION_PRINTER.port,
  );
  assert.equal(grillDispatches.length, 1, 'Grill station printer receives exactly 1 KOT dispatch');
  const grillText = grillDispatches[0].text;
  assert.match(grillText, /GRILL/i, 'Grill KOT header identifies Grill station');
  assert.match(grillText, /Ribeye Steak/, 'Grill KOT includes Ribeye Steak');
  assert.match(grillText, /Charbroiled Burger/, 'Grill KOT includes Charbroiled Burger');
  assert.doesNotMatch(grillText, /Classic Mojito/, 'Grill KOT excludes Bar items');
  assert.doesNotMatch(grillText, /Basque Cheesecake/, 'Grill KOT excludes unmapped Dessert items');

  const barDispatches = dispatches.filter(
    (d) => d.ip === BAR_STATION_PRINTER.ip && d.port === BAR_STATION_PRINTER.port,
  );
  assert.equal(barDispatches.length, 1, 'Bar station printer receives exactly 1 KOT dispatch');
  const barText = barDispatches[0].text;
  assert.match(barText, /BAR/i, 'Bar KOT header identifies Bar station');
  assert.match(barText, /Classic Mojito/, 'Bar KOT includes Classic Mojito');
  assert.doesNotMatch(barText, /Ribeye Steak/, 'Bar KOT excludes Grill items');
  assert.doesNotMatch(barText, /Charbroiled Burger/, 'Bar KOT excludes Grill items');
  assert.doesNotMatch(barText, /Basque Cheesecake/, 'Bar KOT excludes unmapped Dessert items');

  const kitchenDispatches = dispatches.filter(
    (d) => d.ip === DEFAULT_KITCHEN_PRINTER.ip && d.port === DEFAULT_KITCHEN_PRINTER.port,
  );
  assert.equal(
    kitchenDispatches.length,
    1,
    'Default Kitchen printer receives exactly 1 fallback KOT dispatch for unmatched items',
  );
  const kitchenText = kitchenDispatches[0].text;
  assert.match(kitchenText, /KITCHEN/i, 'Fallback KOT header identifies Kitchen');
  assert.match(kitchenText, /Basque Cheesecake/, 'Fallback Kitchen KOT includes Basque Cheesecake');
  assert.doesNotMatch(kitchenText, /Ribeye Steak/, 'Fallback Kitchen KOT excludes Grill items');
  assert.doesNotMatch(
    kitchenText,
    /Charbroiled Burger/,
    'Fallback Kitchen KOT excludes Grill items',
  );
  assert.doesNotMatch(kitchenText, /Classic Mojito/, 'Fallback Kitchen KOT excludes Bar items');
}

async function main() {
  console.log('Integration Test: Server App end-to-end multi-station KOT routing (#1348)');
  console.log('='.repeat(74));

  process.env.PORT = String(await getFreeTcpPort());
  process.env.KDS_PORT = String(await getFreeTcpPort());
  process.env.SERVER_APP_PORT = String(await getFreeTcpPort());

  const bcrypt = require('bcryptjs');
  const { seedCategory, seedProduct } = require('./helpers/test-setup');
  const { initDatabase, getDatabase, closeDatabase, now } = await import('../main/db');
  const { startServer, stopServer } = await import('../main/server');
  const { startKdsServer, stopKdsServer } = await import('../main/kds-server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');
  const { escPosToText } = await import('../main/printers/thermal');
  const { destroySharedRasterRenderer } = await import('../main/printers/raster-renderer');

  // Stub only the physical network socket dispatch layer (`net.Socket.prototype.connect`)
  // for the test printer IPs, leaving HTTP loopback traffic (Server App -> Main API) untouched.
  const recordedDispatches: RecordedDispatch[] = [];
  const originalSocketConnect = net.Socket.prototype.connect;
  (net.Socket.prototype as any).connect = function (this: net.Socket, ...args: any[]) {
    const [port, host, connectListener] = args;
    if (typeof port === 'number' && typeof host === 'string' && STUBBED_PRINTER_IPS.has(host)) {
      const chunks: Buffer[] = [];
      let finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        const bytes = Buffer.concat(chunks);
        recordedDispatches.push({
          ip: host,
          port,
          bytes,
          text: escPosToText(bytes),
        });
      };
      this.setTimeout = () => this;
      (this as any).write = (
        chunk: Buffer | Uint8Array | string,
        encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
        cb?: (error?: Error | null) => void,
      ) => {
        const buf = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk as any);
        chunks.push(buf);
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
        if (callback) process.nextTick(callback);
        return true;
      };
      (this as any).end = (cb?: () => void) => {
        finalize();
        if (typeof cb === 'function') process.nextTick(cb);
        return this;
      };
      (this as any).destroy = () => {
        finalize();
        return this;
      };
      if (typeof connectListener === 'function') {
        process.nextTick(connectListener);
      }
      return this;
    }
    return originalSocketConnect.apply(this, args as any);
  };

  initDatabase();
  const db = getDatabase();

  const setSetting = (key: string, value: string) =>
    db
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, now());

  for (const [key, value] of [
    ['country', 'US'],
    ['currency', 'USD'],
    ['currency_symbol', '$'],
    ['timezone', 'America/New_York'],
    ['business_name', 'Flo Test Cafe'],
    ['kot_printing_enabled', 'true'],
  ] as const) {
    setSetting(key, value);
  }

  const passwordHash = bcrypt.hashSync('WaiterPass123!', 10);
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('waiter-1', 'Waiter One', 'waiter@server-app.test', ?, 'server', 1, ?, ?)
  `).run(passwordHash, now(), now());

  db.prepare(`
    INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at)
    VALUES ('tbl-1', 'T1', 4, 'available', 1, ?, ?)
  `).run(now(), now());

  // Seed default Kitchen printer + two station printers (Grill and Bar)
  const insertPrinter = db.prepare(`
    INSERT INTO printers (id, name, connection_type, ip_address, port, paper_width, is_default, created_at, updated_at)
    VALUES (?, ?, 'network', ?, ?, 'cols-42', ?, ?, ?)
  `);
  insertPrinter.run(
    DEFAULT_KITCHEN_PRINTER.id,
    DEFAULT_KITCHEN_PRINTER.name,
    DEFAULT_KITCHEN_PRINTER.ip,
    DEFAULT_KITCHEN_PRINTER.port,
    1,
    now(),
    now(),
  );
  insertPrinter.run(
    GRILL_STATION_PRINTER.id,
    GRILL_STATION_PRINTER.name,
    GRILL_STATION_PRINTER.ip,
    GRILL_STATION_PRINTER.port,
    0,
    now(),
    now(),
  );
  insertPrinter.run(
    BAR_STATION_PRINTER.id,
    BAR_STATION_PRINTER.name,
    BAR_STATION_PRINTER.ip,
    BAR_STATION_PRINTER.port,
    0,
    now(),
    now(),
  );

  // Seed 2 mapped categories + 1 unmapped category
  seedCategory(db, 'cat-grill', 'Grill');
  seedCategory(db, 'cat-bar', 'Bar');
  seedCategory(db, 'cat-dessert', 'Desserts');

  seedProduct(db, 'prod-steak', 'cat-grill', 'Ribeye Steak', 2800);
  seedProduct(db, 'prod-burger', 'cat-grill', 'Charbroiled Burger', 1600);
  seedProduct(db, 'prod-mojito', 'cat-bar', 'Classic Mojito', 1200);
  seedProduct(db, 'prod-cheesecake', 'cat-dessert', 'Basque Cheesecake', 900);

  // Map cat-grill -> Grill Station and cat-bar -> Bar Station; leave cat-dessert unmapped
  const insertStation = db.prepare(`
    INSERT INTO kitchen_stations (id, name, category_ids, printer_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  insertStation.run(
    'stn-grill',
    'Grill',
    JSON.stringify(['cat-grill']),
    GRILL_STATION_PRINTER.id,
    now(),
    now(),
  );
  insertStation.run(
    'stn-bar',
    'Bar',
    JSON.stringify(['cat-bar']),
    BAR_STATION_PRINTER.id,
    now(),
    now(),
  );

  await startServer();
  await startKdsServer();
  await startServerApp();
  const serverAppBaseUrl = `http://127.0.0.1:${getServerAppPort()}`;

  try {
    // 1. Authenticate waiter on Server App
    const loginRes = await postJson(serverAppBaseUrl, '/api/auth/login', {
      email: 'waiter@server-app.test',
      password: 'WaiterPass123!',
    });
    assert.equal(loginRes.status, 200, 'Waiter logs into Server App');
    const waiterToken = loginRes.body.access_token as string;
    assert.ok(waiterToken, 'Server App returns access_token for waiter');

    // 2. Create order through Server App with items spanning Grill, Bar, and unmapped Desserts
    const createOrderRes = await postJson(
      serverAppBaseUrl,
      '/api/orders',
      {
        table_id: 'tbl-1',
        type: 'dine_in',
        items: [
          { product_id: 'prod-steak', quantity: 2 },
          { product_id: 'prod-burger', quantity: 1 },
          { product_id: 'prod-mojito', quantity: 3 },
          { product_id: 'prod-cheesecake', quantity: 1 },
        ],
      },
      waiterToken,
      { 'Idempotency-Key': 'waiter-station-routing-order-1' },
    );
    assert.equal(
      createOrderRes.status,
      201,
      `Server App POST /api/orders creates order (got ${createOrderRes.status}: ${JSON.stringify(createOrderRes.body)})`,
    );
    const createdOrder = createOrderRes.body.order;
    assert.ok(createdOrder?.id, 'Created order has an id');
    assert.equal(createdOrder.items?.length, 4, 'Created order has all 4 items');

    // 3. Call Server App POST /api/printers/print-kot with { orderId, items } and NO stationName,
    //    matching printKotForOrder() in frontend/src/app/server-standalone/page.tsx
    recordedDispatches.length = 0;
    const printKotWithItemsRes = await postJson(
      serverAppBaseUrl,
      '/api/printers/print-kot',
      {
        orderId: createdOrder.id,
        items: createdOrder.items,
      },
      waiterToken,
    );
    assert.equal(
      printKotWithItemsRes.status,
      200,
      `Server App POST /api/printers/print-kot succeeds (got ${printKotWithItemsRes.status}: ${JSON.stringify(printKotWithItemsRes.body)})`,
    );
    assert.equal(printKotWithItemsRes.body.success, true);

    assertMultiStationRouting(recordedDispatches);
    console.log(
      '  ✓ Waiter App print-kot (with items, no stationName) routed to Grill, Bar, and fallback Kitchen printers',
    );

    // 4. Also verify POST /api/printers/print-kot with { orderId } alone (no items, no stationName)
    recordedDispatches.length = 0;
    const printKotOrderOnlyRes = await postJson(
      serverAppBaseUrl,
      '/api/printers/print-kot',
      {
        orderId: createdOrder.id,
      },
      waiterToken,
    );
    assert.equal(printKotOrderOnlyRes.status, 200);
    assert.equal(printKotOrderOnlyRes.body.success, true);

    assertMultiStationRouting(recordedDispatches);
    console.log(
      '  ✓ Waiter App print-kot (orderId only, no stationName) routed DB items to Grill, Bar, and fallback Kitchen printers',
    );

    // 5. Append flow: waiter appends a Bar item and an unmapped Dessert item via
    //    POST /api/orders/:id/items and calls POST /api/printers/print-kot with only newItems
    const existingItemIds = new Set((createdOrder.items as Array<{ id: number }>).map((i) => i.id));
    const appendOrderRes = await postJson(
      serverAppBaseUrl,
      `/api/orders/${createdOrder.id}/items`,
      {
        items: [
          { product_id: 'prod-mojito', quantity: 1 },
          { product_id: 'prod-cheesecake', quantity: 2 },
        ],
      },
      waiterToken,
      { 'Idempotency-Key': 'waiter-station-routing-append-1' },
    );
    assert.equal(appendOrderRes.status, 200, 'Server App POST /api/orders/:id/items succeeds');
    const newItems = (appendOrderRes.body.order.items as Array<{ id: number }>).filter(
      (item) => !existingItemIds.has(item.id),
    );
    assert.equal(newItems.length, 2, 'Append delta contains only the 2 newly added items');

    recordedDispatches.length = 0;
    const appendPrintRes = await postJson(
      serverAppBaseUrl,
      '/api/printers/print-kot',
      {
        orderId: createdOrder.id,
        items: newItems,
      },
      waiterToken,
    );
    assert.equal(appendPrintRes.status, 200);
    assert.equal(appendPrintRes.body.success, true);
    assert.equal(
      recordedDispatches.length,
      2,
      'Appending Bar + unmapped Dessert items dispatches only to Bar and fallback Kitchen printers (skipping Grill)',
    );
    assert.equal(
      recordedDispatches.filter((d) => d.ip === GRILL_STATION_PRINTER.ip).length,
      0,
      'Grill printer receives no KOT when no Grill items were appended',
    );
    const appendedBar = recordedDispatches.find((d) => d.ip === BAR_STATION_PRINTER.ip);
    assert.ok(appendedBar, 'Bar printer receives KOT for appended Mojito');
    assert.match(appendedBar.text, /Classic Mojito/);
    assert.doesNotMatch(appendedBar.text, /Basque Cheesecake/);
    const appendedKitchen = recordedDispatches.find((d) => d.ip === DEFAULT_KITCHEN_PRINTER.ip);
    assert.ok(appendedKitchen, 'Default Kitchen printer receives KOT for appended Cheesecake');
    assert.match(appendedKitchen.text, /Basque Cheesecake/);
    assert.doesNotMatch(appendedKitchen.text, /Classic Mojito/);
    console.log(
      '  ✓ Waiter App append-items print-kot routed only touched stations (Bar + fallback Kitchen)',
    );

    // 6. Negative verification: if station routing is bypassed (e.g. an explicit stationName forces
    //    all items onto a single default-printer ticket, or items land on the wrong station),
    //    assertMultiStationRouting must fail.
    recordedDispatches.length = 0;
    const bypassedRes = await postJson(
      serverAppBaseUrl,
      '/api/printers/print-kot',
      {
        orderId: createdOrder.id,
        items: createdOrder.items,
        stationName: 'Kitchen',
      },
      waiterToken,
    );
    assert.equal(bypassedRes.status, 200);
    assert.equal(
      recordedDispatches.length,
      1,
      'Passing an explicit stationName bypasses per-station routing into 1 combined ticket',
    );
    assert.throws(
      () => assertMultiStationRouting(recordedDispatches),
      /Expected 3 separate KOT dispatches/,
      'Routing assertion fails if station routing is bypassed into a single ticket',
    );
    assert.throws(
      () =>
        assertMultiStationRouting([
          {
            ip: GRILL_STATION_PRINTER.ip,
            port: GRILL_STATION_PRINTER.port,
            bytes: Buffer.alloc(0),
            text: 'GRILL\nRibeye Steak\nCharbroiled Burger\nClassic Mojito',
          },
          {
            ip: BAR_STATION_PRINTER.ip,
            port: BAR_STATION_PRINTER.port,
            bytes: Buffer.alloc(0),
            text: 'BAR\nClassic Mojito',
          },
          {
            ip: DEFAULT_KITCHEN_PRINTER.ip,
            port: DEFAULT_KITCHEN_PRINTER.port,
            bytes: Buffer.alloc(0),
            text: 'KITCHEN\nBasque Cheesecake',
          },
        ]),
      /Grill KOT excludes Bar items/,
      'Routing assertion fails if a Bar item leaks onto the Grill station ticket',
    );
    console.log(
      '  ✓ Routing assertion rejects bypassed single-ticket and cross-station dispatches',
    );
  } finally {
    net.Socket.prototype.connect = originalSocketConnect;
    destroySharedRasterRenderer();
    await stopServerApp();
    await stopKdsServer();
    await stopServer();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('ALL PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
