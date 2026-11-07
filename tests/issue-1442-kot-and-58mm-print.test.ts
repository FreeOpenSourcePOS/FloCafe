/**
 * Regression test for Issue #1442:
 * 1. Incremental KOT on order edit/append (added_item_ids, added_items, tables activeOrder items, POS & Orders append KOT)
 * 2. Server Companion App KOT 403 suppression & Server App print-bill guard across all roles when disabled
 * 3. 58mm/80mm thermal browser-print legibility and contrast (web-print.ts & order-slip-web-print.ts)
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-1442-kot-and-58mm-print.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-1442-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-issue-1442';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { tableRoutes } = require('../main/routes/tables');
const { startServer: startMainServer, stopServer: stopMainServer } = require('../main/server');
const { startServerApp, stopServerApp } = require('../main/server-app');
const { getServerAppPort } = require('../main/server-app-state');
const { getJWTSecret } = require('../main/routes/auth');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request === '@countries') {
    resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
  } else if (request.startsWith('@/')) {
    resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
  } else if (request.startsWith('@print/')) {
    resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
  } else if (request.startsWith('@shared/')) {
    resolvedRequest = path.resolve(__dirname, '../shared', request.slice('@shared/'.length));
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

function loadFrontendModules() {
  return {
    webPrint: require('../frontend/src/lib/printer/web-print'),
    orderSlipWebPrint: require('../frontend/src/lib/printer/order-slip-web-print'),
    usePrinter: require('../frontend/src/hooks/usePrinter'),
    posSettings: require('../frontend/src/store/pos-settings'),
    apiClient: require('../frontend/src/lib/api'),
  };
}

const { webPrint, orderSlipWebPrint, usePrinter, posSettings, apiClient } = loadFrontendModules();
const { generateBillHtml } = webPrint;
const { generateOrderSlipHtml } = orderSlipWebPrint;
const { usePrinterStore } = usePrinter;
const { usePosSettingsStore } = posSettings;
const frontendApi = apiClient.default || apiClient;

async function postJson(
  baseUrl: string,
  routePath: string,
  body: Record<string, unknown>,
  token?: string,
  extraHeaders?: Record<string, string>,
) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

async function main() {
  console.log(
    'Regression Test: Issue #1442 — Incremental KOT, Server App Print Guard, 58mm Legibility',
  );
  console.log('='.repeat(78));

  const db = initTestDb();
  const { userId: ownerId, token: ownerToken, authHeader } = seedOwnerUser(db);

  // Seed manager, server, and chef users
  const managerId = 'mgr-1442';
  const serverId = 'srv-1442';
  const chefId = 'chef-1442';
  const passHash = bcrypt.hashSync('TestPass123!', 10);
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manager', 1, ?, ?)`,
  ).run(managerId, 'Manager 1442', 'manager@1442.test', passHash, now(), now());
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'server', 1, ?, ?)`,
  ).run(serverId, 'Server 1442', 'server@1442.test', passHash, now(), now());
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'chef', 1, ?, ?)`,
  ).run(chefId, 'Chef 1442', 'chef@1442.test', passHash, now(), now());

  const managerToken = jwt.sign(
    { userId: managerId, email: 'manager@1442.test', role: 'manager' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const serverToken = jwt.sign(
    { userId: serverId, email: 'server@1442.test', role: 'server' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const chefToken = jwt.sign(
    { userId: chefId, email: 'chef@1442.test', role: 'chef' },
    getJWTSecret(),
    { expiresIn: '1h' },
  );
  const chefAuthHeader = { Authorization: `Bearer ${chefToken}` };

  seedCategory(db, 'cat-1442', 'Mains');
  seedProduct(db, 'prod-1442-1', 'cat-1442', 'Margherita Pizza', 120);
  seedProduct(db, 'prod-1442-2', 'cat-1442', 'Garlic Bread', 45);
  seedProduct(db, 'prod-1442-3', 'cat-1442', 'Iced Tea', 30);

  db.prepare(`INSERT INTO addon_groups (id, name) VALUES ('ag-1442', 'Toppings')`).run();
  db.prepare(
    `INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES ('addon-1442-cheese', 'ag-1442', 'Extra Cheese', 15, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO addon_group_product (product_id, addon_group_id) VALUES ('prod-1442-2', 'ag-1442')`,
  ).run();

  db.prepare(
    `INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at)
     VALUES ('tbl-1442', 'T14', 4, 'available', 1, ?, ?)`,
  ).run(now(), now());

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/tables': tableRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ── 1. Incremental KOT on order append & activeOrderForTable items ─────────
    console.log(
      '\n1. POST /api/orders/:id/items returns added_item_ids and added_items (including replay)',
    );
    const createRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        table_id: 'tbl-1442',
        type: 'dine_in',
        items: [{ product_id: 'prod-1442-1', quantity: 2 }],
      },
    });
    assertEqualOrThrow(createRes.status, 201, 'Initial dine-in order created');
    const orderId = createRes.data.order.id;
    assertEqualOrThrow(createRes.data.order.items.length, 1, 'Initial order has 1 item');

    // Check GET /api/tables (default omits items; include_items=1 populates items only when caller has orders.read)
    const defaultTablesListRes = await api(baseUrl, '/api/tables', { headers: authHeader });
    assertEqualOrThrow(defaultTablesListRes.status, 200, 'GET /api/tables succeeds');
    const tblFromDefaultList = defaultTablesListRes.data.tables.find(
      (t: any) => t.id === 'tbl-1442',
    );
    assertOrThrow(
      Boolean(tblFromDefaultList?.current_order),
      'Table has current_order in GET /api/tables',
    );
    assertEqualOrThrow(
      tblFromDefaultList.current_order.items,
      undefined,
      'GET /api/tables without include_items=1 omits current_order.items',
    );

    const tablesListRes = await api(baseUrl, '/api/tables?include_items=1', {
      headers: authHeader,
    });
    assertEqualOrThrow(tablesListRes.status, 200, 'GET /api/tables?include_items=1 succeeds');
    const tblFromList = tablesListRes.data.tables.find((t: any) => t.id === 'tbl-1442');
    assertOrThrow(
      Array.isArray(tblFromList?.current_order?.items) &&
        tblFromList.current_order.items.length === 1,
      'GET /api/tables?include_items=1 populates current_order.items for caller with orders.read',
    );
    assertEqualOrThrow(
      tblFromList.current_order.items[0].product_name,
      'Margherita Pizza',
      'current_order.items[0] matches initial item',
    );

    const chefTablesListRes = await api(baseUrl, '/api/tables?include_items=1', {
      headers: chefAuthHeader,
    });
    assertEqualOrThrow(
      chefTablesListRes.status,
      200,
      'GET /api/tables?include_items=1 succeeds for chef',
    );
    const tblFromChefList = chefTablesListRes.data.tables.find((t: any) => t.id === 'tbl-1442');
    assertEqualOrThrow(
      tblFromChefList?.current_order?.items,
      undefined,
      'GET /api/tables?include_items=1 omits current_order.items when caller lacks orders.read',
    );

    const tableDetailRes = await api(baseUrl, '/api/tables/tbl-1442', { headers: authHeader });
    assertEqualOrThrow(tableDetailRes.status, 200, 'GET /api/tables/:id succeeds');
    assertOrThrow(
      Array.isArray(tableDetailRes.data.table?.current_order?.items) &&
        tableDetailRes.data.table.current_order.items.length === 1,
      'GET /api/tables/:id populates current_order.items for caller with orders.read',
    );

    const chefTableDetailRes = await api(baseUrl, '/api/tables/tbl-1442', {
      headers: chefAuthHeader,
    });
    assertEqualOrThrow(chefTableDetailRes.status, 200, 'GET /api/tables/:id succeeds for chef');
    assertEqualOrThrow(
      chefTableDetailRes.data.table?.current_order?.items,
      undefined,
      'GET /api/tables/:id omits current_order.items when caller lacks orders.read',
    );

    // Append 2 new items (one with an addon)
    const appendHeaders = { ...authHeader, 'Idempotency-Key': 'append-1442-key-1' };
    const appendBody = {
      items: [
        {
          product_id: 'prod-1442-2',
          quantity: 1,
          addons: [{ id: 'addon-1442-cheese', name: 'Extra Cheese', price: 15, quantity: 1 }],
        },
        {
          product_id: 'prod-1442-3',
          quantity: 2,
        },
      ],
    };
    const appendRes = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      headers: appendHeaders,
      body: appendBody,
    });
    assertEqualOrThrow(appendRes.status, 200, 'POST /api/orders/:id/items succeeds');
    assertEqualOrThrow(appendRes.data.order.items.length, 3, 'Updated order has 3 total items');
    assertOrThrow(
      Array.isArray(appendRes.data.added_item_ids) && appendRes.data.added_item_ids.length === 2,
      'Response includes added_item_ids for strictly the 2 newly inserted items',
    );
    assertOrThrow(
      Array.isArray(appendRes.data.added_items) && appendRes.data.added_items.length === 2,
      'Response includes added_items for strictly the 2 newly inserted items',
    );
    assertEqualOrThrow(
      appendRes.data.added_items[0].product_name,
      'Garlic Bread',
      'First added_item is Garlic Bread',
    );
    assertEqualOrThrow(
      appendRes.data.added_items[0].addons?.length,
      1,
      'First added_item has hydrated addons',
    );
    assertEqualOrThrow(
      appendRes.data.added_items[1].product_name,
      'Iced Tea',
      'Second added_item is Iced Tea',
    );

    // Idempotent replay preserves added_item_ids and added_items
    const replayRes = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      headers: appendHeaders,
      body: appendBody,
    });
    assertEqualOrThrow(
      replayRes.status,
      200,
      'Idempotent replay of POST /api/orders/:id/items succeeds',
    );
    assertEqualOrThrow(
      JSON.stringify(replayRes.data.added_item_ids),
      JSON.stringify(appendRes.data.added_item_ids),
      'Idempotent replay preserves added_item_ids',
    );
    assertEqualOrThrow(
      replayRes.data.added_items?.length,
      2,
      'Idempotent replay preserves added_items',
    );

    // Verify usePrinterStore.getState().printKot forwards order.items to /printers/print-kot when opts.items is omitted
    usePosSettingsStore.getState().setKotPrintingEnabled(true);
    usePrinterStore.setState({
      hardwarePrinter: {
        id: 'hw-1442',
        name: 'Kitchen Printer',
        connection_type: 'network',
        is_default: 1,
      },
      printMethod: 'escpos',
    });
    const capturedKotPayloads: any[] = [];
    const origPost = frontendApi.post;
    frontendApi.post = async (url: string, payload: any) => {
      if (url === '/printers/print-kot') {
        capturedKotPayloads.push(payload);
      }
      return { data: { warnings: [] } };
    };
    try {
      await usePrinterStore.getState().printKot({
        ...appendRes.data.order,
        items: appendRes.data.added_items,
      });
      assertEqualOrThrow(
        capturedKotPayloads.length,
        1,
        'usePrinterStore.printKot posts once to /printers/print-kot',
      );
      assertEqualOrThrow(
        capturedKotPayloads[0].items?.length,
        2,
        'usePrinterStore.printKot forwards order.items (strictly the 2 added_items) when opts.items is omitted',
      );
      assertEqualOrThrow(
        capturedKotPayloads[0].items[0].product_name,
        'Garlic Bread',
        'Forwarded KOT item 1 is Garlic Bread',
      );
      assertEqualOrThrow(
        capturedKotPayloads[0].items[1].product_name,
        'Iced Tea',
        'Forwarded KOT item 2 is Iced Tea',
      );
    } finally {
      frontendApi.post = origPost;
      usePrinterStore.setState({ hardwarePrinter: null });
    }

    // ── 2. Server Companion App KOT 403 & print-bill guard ────────────────────
    console.log('\n2. Server Companion App KOT 403 guard and print-bill setting enforcement');
    await startMainServer();
    await startServerApp();
    try {
      const serverAppBaseUrl = `http://127.0.0.1:${getServerAppPort()}`;

      // When kot_printing_enabled is 'false', Server App POST /api/printers/print-kot returns 403 across all roles
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('kot_printing_enabled', 'false', ?)
         ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = excluded.updated_at`,
      ).run(now());

      for (const [roleName, token] of [
        ['server', serverToken],
        ['manager', managerToken],
        ['owner', ownerToken],
      ] as const) {
        const kotRes = await postJson(
          serverAppBaseUrl,
          '/api/printers/print-kot',
          { orderId, items: appendRes.data.added_items },
          token,
        );
        assertEqualOrThrow(
          kotRes.status,
          403,
          `Server App POST /api/printers/print-kot returns 403 for ${roleName} when kot_printing_enabled is false`,
        );
        assertEqualOrThrow(
          kotRes.body?.error,
          'KOT printing is disabled for this business',
          `Server App POST /api/printers/print-kot returns clear disabled message for ${roleName}`,
        );
        assertEqualOrThrow(
          kotRes.body?.code,
          'KOT_PRINTING_DISABLED',
          `Server App POST /api/printers/print-kot returns KOT_PRINTING_DISABLED code for ${roleName}`,
        );
      }

      // Restore kot_printing_enabled to 'true'
      db.prepare(
        `UPDATE settings SET value = 'true', updated_at = ? WHERE key = 'kot_printing_enabled'`,
      ).run(now());

      // Default: server_app_bill_printing_enabled is 'false'
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('server_app_bill_printing_enabled', 'false', ?)
         ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = excluded.updated_at`,
      ).run(now());

      for (const [roleName, token] of [
        ['server', serverToken],
        ['manager', managerToken],
        ['owner', ownerToken],
      ] as const) {
        const res = await postJson(
          serverAppBaseUrl,
          '/api/printers/print-bill',
          { orderId },
          token,
        );
        assertEqualOrThrow(
          res.status,
          403,
          `Server App POST /api/printers/print-bill returns 403 for ${roleName} when server_app_bill_printing_enabled is false`,
        );
      }

      // When server_app_bill_printing_enabled is 'true', requests forward to main API (returns 400 when no default printer configured)
      db.prepare(
        `UPDATE settings SET value = 'true', updated_at = ? WHERE key = 'server_app_bill_printing_enabled'`,
      ).run(now());

      for (const [roleName, token] of [
        ['server', serverToken],
        ['manager', managerToken],
        ['owner', ownerToken],
      ] as const) {
        const res = await postJson(
          serverAppBaseUrl,
          '/api/printers/print-bill',
          { orderId },
          token,
        );
        assertEqualOrThrow(
          res.status,
          400,
          `Server App POST /api/printers/print-bill forwards to main API for ${roleName} when server_app_bill_printing_enabled is true`,
        );
      }
    } finally {
      await stopServerApp();
      await stopMainServer();
    }

    // ── 3. 58mm & 80mm thermal browser-print legibility ───────────────────────
    console.log('\n3. 58mm and 80mm browser-print legibility and contrast');
    const sampleBill: any = {
      id: 1,
      bill_number: 'INV-1442',
      order_id: orderId,
      subtotal: 195,
      discount_amount: 0,
      tax_amount: 9.75,
      total: 204.75,
      payment_status: 'paid',
      created_at: '2026-11-03T12:00:00Z',
      items: [
        {
          id: 1,
          product_name: 'Margherita Pizza',
          quantity: 1,
          unit_price: 120,
          subtotal: 120,
          addons: [{ name: 'Extra Cheese', price: 15, quantity: 1 }],
          special_instructions: 'Well done',
        },
      ],
      payments: [{ method: 'cash', amount: 204.75 }],
    };
    const sampleTenant: any = {
      business_name: 'FloCafe Test',
      currency: 'USD',
      country: 'US',
      timezone: 'UTC',
    };

    const html58 = generateBillHtml(sampleBill, sampleTenant, { paperSize: 'thermal58' });
    assertOrThrow(
      html58.includes(
        '.bill-container { padding: 2mm; width: 100%; max-width: 58mm; font-size: 13px; font-weight: 600; color: #000; }',
      ),
      'thermal58 sets .bill-container to 13px, font-weight 600, and #000',
    );
    assertOrThrow(
      html58.includes(
        '.items-table td { color: #000; border-bottom: 1px dashed #000; font-size: 13px; font-weight: 600; }',
      ),
      'thermal58 sets .items-table td to 13px, font-weight 600, and 1px dashed #000',
    );
    assertOrThrow(
      html58.includes(
        '.items-table th, .tax-table th, .payments-table th { background: transparent; color: #000; border-bottom: 1px solid #000; font-weight: 700; }',
      ),
      'thermal58 removes gray header backgrounds on items/tax/payments tables',
    );
    assertOrThrow(
      html58.includes('.tax-table, .payments-table { width: 100%; margin-inline-start: 0; }'),
      'thermal58 expands tax-table and payments-table to 100% width',
    );
    assertOrThrow(
      html58.includes('.header h1 { font-size: 17px; font-weight: 700; color: #000; }'),
      'thermal58 sets .header h1 to 17px, font-weight 700, and #000',
    );

    const html80 = generateBillHtml(sampleBill, sampleTenant, { paperSize: 'thermal80' });
    assertOrThrow(
      html80.includes(
        '.bill-container { padding: 3mm; width: 100%; max-width: 80mm; font-size: 14px; font-weight: 600; color: #000; }',
      ),
      'thermal80 sets .bill-container to 14px, font-weight 600, and #000',
    );
    assertOrThrow(
      html80.includes(
        '.items-table td { color: #000; border-bottom: 1px dashed #000; font-size: 14px; font-weight: 600; }',
      ),
      'thermal80 sets .items-table td to 14px, font-weight 600, and 1px dashed #000',
    );
    assertOrThrow(
      html80.includes('.header h1 { font-size: 18px; font-weight: 700; color: #000; }'),
      'thermal80 sets .header h1 to 18px, font-weight 700, and #000',
    );

    const orderSlipLabels = {
      title: 'Order Slip',
      subtotal: 'Subtotal',
      discount: 'Discount',
      serviceCharge: 'Service Charge',
      deliveryCharge: 'Delivery Charge',
      packagingCharge: 'Packaging Charge',
      tax: 'Tax',
      total: 'Total',
    };
    const slip58 = generateOrderSlipHtml(sampleBill, orderSlipLabels, { paperWidth: 58 });
    assertOrThrow(
      slip58.includes('font-size:13px;') && slip58.includes('color:#000;'),
      '58mm order slip uses font-size:13px and color:#000',
    );
    assertOrThrow(
      !slip58.includes('color:#444;'),
      '58mm order slip addon rows do not use #444 gray text',
    );
    const slip80 = generateOrderSlipHtml(sampleBill, orderSlipLabels, { paperWidth: 80 });
    assertOrThrow(
      slip80.includes('font-size:14px;') && slip80.includes('color:#000;'),
      '80mm order slip uses font-size:14px and color:#000',
    );
    assertOrThrow(
      !slip80.includes('color:#444;'),
      '80mm order slip addon rows do not use #444 gray text',
    );
  } finally {
    server.close();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('\nALL PASSED');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
