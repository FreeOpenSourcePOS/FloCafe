/**
 * Owner-only compiled daily invoices PDF/HTML export — GET /api/reports/daily-invoices/export.
 *
 * Covers:
 *  1. Sequential bill_number ascending ordering across multiple bills (paid, partially_refunded, refunded).
 *  2. [REFUNDED] and [PARTIALLY REFUNDED] status badges and refund details are present and never filtered out.
 *  3. Cover-page summary totals and VAT/Tax Summary Table match the daily sales .xlsx export for the same business date / range.
 *  4. Cross-midnight business_day_start_time (day_close_hour) boundary filtering includes post-midnight pre-cutoff bills and excludes out-of-window bills.
 *  5. 403 rejection for non-owner roles (manager, cashier, server/waiter, chef/kitchen) and 401 for unauthenticated requests.
 *  6. save-html-as-pdf desktop IPC and verifyBrowserPrintFallback produce valid PDF output (%PDF-) with .invoice-card break-inside: avoid.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/daily-invoices-export.test.ts
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-daily-invoices-export-'));
const registeredIpcHandlers = new Map<string, (...args: any[]) => any>();
let saveDialogResult: { canceled: boolean; filePath?: string } = { canceled: false };
let lastLoadedHtmlPath = '';
let lastLoadedHtmlContent = '';

class FakePdfBrowserWindow {
  static allWindows: FakePdfBrowserWindow[] = [];
  destroyed = false;
  webContents: any;

  constructor(_options?: any) {
    const allowedUrls: string[] = [];
    let beforeRequestHandler:
      | ((details: { url: string }, cb: (res: { cancel: boolean }) => void) => void)
      | null = null;
    this.webContents = {
      session: {
        webRequest: {
          onBeforeRequest: (
            handler: (details: { url: string }, cb: (res: { cancel: boolean }) => void) => void,
          ) => {
            beforeRequestHandler = handler;
          },
        },
      },
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      printToPDF: async (options: { pageSize?: string; preferCSSPageSize?: boolean }) => {
        return Buffer.from(
          `%PDF-1.4\n% Fake PDF pageSize=${options.pageSize} preferCSSPageSize=${String(options.preferCSSPageSize)} allowedUrls=${allowedUrls.length}\n${lastLoadedHtmlContent}\n%%EOF\n`,
          'utf8',
        );
      },
      _triggerBeforeRequest: (url: string): boolean => {
        let allowed = true;
        if (beforeRequestHandler) {
          beforeRequestHandler({ url }, (res) => {
            allowed = !res.cancel;
          });
        }
        if (allowed) allowedUrls.push(url);
        return allowed;
      },
    };
    FakePdfBrowserWindow.allWindows.push(this);
  }

  async loadFile(filePath: string) {
    lastLoadedHtmlPath = filePath;
    assert.ok(fs.existsSync(filePath), 'staging HTML file exists during loadFile');
    lastLoadedHtmlContent = fs.readFileSync(filePath, 'utf8');
    const { pathToFileURL } = require('node:url');
    const allowed = this.webContents._triggerBeforeRequest(pathToFileURL(filePath).href);
    assert.equal(allowed, true, 'staged HTML file URL is allowed by onBeforeRequest');
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }

  static getAllWindows() {
    return FakePdfBrowserWindow.allWindows;
  }

  static fromWebContents(sender: any) {
    return sender?.ownerWindow ?? null;
  }
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
        getName: () => 'FloCafe',
      },
      BrowserWindow: FakePdfBrowserWindow,
      ipcMain: {
        on: () => undefined,
        handle: (channel: string, listener: (...args: any[]) => any) => {
          registeredIpcHandlers.set(channel, listener);
        },
      },
      dialog: {
        showSaveDialog: async () => saveDialogResult,
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => ({ response: 1 }),
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-daily-invoices-export';

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const jwt = require('jsonwebtoken');
const { reportRoutes } = require('../main/routes/reports');
const { registerIpcHandlers } = require('../main/ipc');
const ExcelJS = require('exceljs');

function seedRoleUser(
  db: any,
  userId: string,
  name: string,
  email: string,
  role: 'cashier' | 'server' | 'chef',
): { userId: string; token: string; authHeader: Record<string, string> } {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'hashed', ?, 1, ?, ?)`,
  ).run(userId, name, email, role, now(), now());
  const token = jwt.sign({ userId, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { userId, token, authHeader: { Authorization: `Bearer ${token}` } };
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function parseHtmlSummaryMetrics(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /<tr\s+data-section="summary"\s+data-metric="([^"]*)"\s+data-value="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    map.set(unescapeHtml(match[1]), unescapeHtml(match[2]));
  }
  return map;
}

function parseHtmlTaxRows(html: string): Array<{
  date: string;
  name: string;
  rate: string;
  base: string;
  tax: string;
  gross: string;
}> {
  const rows: Array<{
    date: string;
    name: string;
    rate: string;
    base: string;
    tax: string;
    gross: string;
  }> = [];
  const re =
    /<tr\s+data-section="tax"\s+data-date="([^"]*)"\s+data-name="([^"]*)"\s+data-rate="([^"]*)"\s+data-base="([^"]*)"\s+data-tax="([^"]*)"\s+data-gross="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    rows.push({
      date: unescapeHtml(match[1]),
      name: unescapeHtml(match[2]),
      rate: unescapeHtml(match[3]),
      base: unescapeHtml(match[4]),
      tax: unescapeHtml(match[5]),
      gross: unescapeHtml(match[6]),
    });
  }
  return rows;
}

function parseInvoiceCardOrder(html: string): Array<{ billNumber: string; status: string }> {
  const cards: Array<{ billNumber: string; status: string }> = [];
  const re =
    /<article\s+class="invoice-card"\s+data-section="invoice"\s+data-bill-number="([^"]*)"\s+data-order-number="[^"]*"\s+data-status="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    cards.push({
      billNumber: unescapeHtml(match[1]),
      status: unescapeHtml(match[2]),
    });
  }
  return cards;
}

async function verifyBrowserPrintFallback(html: string, filename: string): Promise<void> {
  const { exportHtmlDocumentAsPdf } = require('../frontend/src/lib/export-pdf');
  const originalWindow = (globalThis as any).window;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  URL.createObjectURL = () => {
    const url = `blob:daily-invoices-pdf-${createdUrls.length + 1}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };

  const actions: string[] = [];
  let listeners = new Map<string, Array<() => void>>();
  const popup: any = {
    closed: false,
    document: { readyState: 'complete' },
    location: {
      href: 'about:blank',
      replace(url: string) {
        actions.push(`replace:${url}`);
        popup.location.href = url;
        listeners = new Map<string, Array<() => void>>();
        popup.document = { readyState: 'loading' };
      },
    },
    addEventListener(type: string, callback: () => void) {
      const list = listeners.get(type) || [];
      list.push(callback);
      listeners.set(type, list);
    },
    focus() {
      actions.push('focus');
    },
    print() {
      actions.push('print');
    },
    close() {
      actions.push('close');
      popup.closed = true;
    },
    dispatchLoad() {
      popup.document.readyState = 'complete';
      for (const cb of [...(listeners.get('load') || [])]) cb();
    },
    dispatchAfterPrint() {
      for (const cb of [...(listeners.get('afterprint') || [])]) cb();
    },
  };

  try {
    (globalThis as any).window = {
      open: () => popup,
    };
    await exportHtmlDocumentAsPdf({
      html,
      filename,
      pageSize: 'A4',
    });
    assert.deepEqual(
      actions,
      ['replace:blob:daily-invoices-pdf-1'],
      'browser fallback navigates opened popup to HTML blob URL',
    );
    popup.dispatchLoad();
    assert.deepEqual(
      actions,
      ['replace:blob:daily-invoices-pdf-1', 'focus', 'print'],
      'browser fallback focuses popup and triggers window.print() once loaded',
    );
    popup.dispatchAfterPrint();
    assert.equal(popup.closed, true, 'browser fallback closes popup after print completes');
    assert.deepEqual(
      revokedUrls,
      ['blob:daily-invoices-pdf-1'],
      'browser fallback revokes blob URL after print completes',
    );
  } finally {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
}

async function main() {
  console.log('Integration Test: Daily Invoices Compiled PDF/HTML Export (#1397)');
  console.log('='.repeat(68));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const cashier = seedRoleUser(
    db,
    'cashier-test-001',
    'Test Cashier',
    'cashier@test.local',
    'cashier',
  );
  const waiter = seedRoleUser(db, 'server-test-001', 'Test Waiter', 'waiter@test.local', 'server');
  const kitchen = seedRoleUser(db, 'chef-test-001', 'Test Chef', 'chef@test.local', 'chef');

  // Configure store metadata
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_name', 'FloCafe Artisan Roasters <script>alert(1)</script>', CURRENT_TIMESTAMP)",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_address', '42 Espresso Lane, Bengaluru', CURRENT_TIMESTAMP)",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('tax_registration_number', '29ABCDE1234F1Z5', CURRENT_TIMESTAMP)",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', CURRENT_TIMESTAMP)",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'INR', CURRENT_TIMESTAMP)",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('timezone', 'UTC', CURRENT_TIMESTAMP)",
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '00:00', CURRENT_TIMESTAMP)",
  ).run();

  seedCategory(db, 'cat-inv', 'Coffee & Pastry');
  seedProduct(db, 'prod-latte', 'cat-inv', 'Cappuccino', 100);
  seedProduct(db, 'prod-croissant', 'cat-inv', 'Butter Croissant', 80);
  seedProduct(db, 'prod-cake', 'cat-inv', 'Basque Cheesecake', 200);

  db.prepare(
    "INSERT INTO customers (id, name, phone, email, country_code) VALUES ('cust-1', 'Aarav Sharma', '+919876543210', 'aarav@example.com', '+91')",
  ).run();

  const businessDate = '2026-09-15';

  function insertBillWithOrder(opts: {
    billNumber: string;
    orderNumber: string;
    paidAt: string;
    paymentStatus: 'paid' | 'partially_refunded' | 'refunded';
    subtotal: number;
    taxAmount: number;
    taxRate: number;
    taxTitle: string;
    discountAmount?: number;
    serviceCharge?: number;
    total: number;
    method: string;
    transactionId?: string;
    customerId?: string | null;
    items: Array<{
      productId: string;
      productName: string;
      qty: number;
      unitPrice: number;
      subtotal: number;
      taxAmount: number;
      total: number;
      status?: string;
      variant?: string;
    }>;
  }): { billId: number; orderId: number; itemIds: number[] } {
    const discountAmount = opts.discountAmount ?? 0;
    const serviceCharge = opts.serviceCharge ?? 0;
    const taxBreakdown = JSON.stringify([
      { title: opts.taxTitle, rate: opts.taxRate, amount: opts.taxAmount },
    ]);
    const taxSnapshot = JSON.stringify({
      lines: [
        {
          taxableBase: opts.subtotal - discountAmount,
          components: [
            {
              label: opts.taxTitle,
              rate: opts.taxRate,
              amount: opts.taxAmount,
            },
          ],
        },
      ],
    });

    db.prepare(`
      INSERT INTO orders (
        order_number, user_id, customer_id, type, status,
        subtotal, discount_amount, service_charge, tax_amount, tax_breakdown, tax_snapshot, total,
        created_at, updated_at, completed_at
      )
      VALUES (?, 'owner-test-001', ?, 'dine-in', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.orderNumber,
      opts.customerId ?? null,
      opts.subtotal,
      discountAmount,
      serviceCharge,
      opts.taxAmount,
      taxBreakdown,
      taxSnapshot,
      opts.total,
      opts.paidAt,
      opts.paidAt,
      opts.paidAt,
    );

    const orderId = Number(
      (
        db.prepare('SELECT id FROM orders WHERE order_number = ?').get(opts.orderNumber) as {
          id: number;
        }
      ).id,
    );

    const itemIds: number[] = [];
    for (const item of opts.items) {
      const itemSnap = JSON.stringify({
        lines: [
          {
            taxableBase: item.subtotal,
            components: [
              {
                label: opts.taxTitle,
                rate: opts.taxRate,
                amount: item.taxAmount,
              },
            ],
          },
        ],
      });
      const res = db
        .prepare(`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity, unit_price,
            subtotal, tax_amount, tax_breakdown, tax_snapshot, total,
            variant_selection, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          orderId,
          item.productId,
          item.productName,
          item.qty,
          item.unitPrice,
          item.subtotal,
          item.taxAmount,
          JSON.stringify([{ title: opts.taxTitle, rate: opts.taxRate, amount: item.taxAmount }]),
          itemSnap,
          item.total,
          item.variant ?? null,
          item.status ?? 'ready',
          opts.paidAt,
          opts.paidAt,
        );
      itemIds.push(Number(res.lastInsertRowid));
    }

    const billRes = db
      .prepare(`
        INSERT INTO bills (
          bill_number, order_id, customer_id, subtotal, discount_amount, service_charge,
          tax_amount, tax_breakdown, tax_snapshot, total, paid_amount, balance,
          payment_status, payment_details, paid_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      `)
      .run(
        opts.billNumber,
        orderId,
        opts.customerId ?? null,
        opts.subtotal,
        discountAmount,
        serviceCharge,
        opts.taxAmount,
        taxBreakdown,
        taxSnapshot,
        opts.total,
        opts.total,
        opts.paymentStatus,
        JSON.stringify([
          {
            method: opts.method,
            amount: opts.total,
            timestamp: opts.paidAt,
            ...(opts.transactionId ? { transaction_id: opts.transactionId } : {}),
          },
        ]),
        opts.paidAt,
        opts.paidAt,
        opts.paidAt,
      );

    return { billId: Number(billRes.lastInsertRowid), orderId, itemIds };
  }

  // Seed 3 bills out of bill_number order (INV-0003 first, INV-0001 second, INV-0002 third)
  // 1) INV-0003: fully refunded bill
  const b3 = insertBillWithOrder({
    billNumber: 'INV-0003',
    orderNumber: 'ORD-0003',
    paidAt: `${businessDate} 14:30:00`,
    paymentStatus: 'refunded',
    subtotal: 200,
    taxAmount: 10,
    taxRate: 5,
    taxTitle: 'GST 5%',
    total: 210,
    method: 'card',
    transactionId: 'TXN-9003',
    items: [
      {
        productId: 'prod-cake',
        productName: 'Basque Cheesecake',
        qty: 1,
        unitPrice: 200,
        subtotal: 200,
        taxAmount: 10,
        total: 210,
        status: 'refunded',
      },
    ],
  });
  db.prepare(`
    INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
    VALUES (?, ?, 21000, 'card', 'Customer cancelled dessert', NULL, 'owner-test-001', 'owner-test-001', ?)
  `).run(b3.billId, b3.itemIds[0], `${businessDate} 15:00:00`);

  // 2) INV-0001: paid bill with customer
  insertBillWithOrder({
    billNumber: 'INV-0001',
    orderNumber: 'ORD-0001',
    paidAt: `${businessDate} 10:15:00`,
    paymentStatus: 'paid',
    subtotal: 100,
    taxAmount: 5,
    taxRate: 5,
    taxTitle: 'GST 5%',
    total: 105,
    method: 'cash',
    customerId: 'cust-1',
    items: [
      {
        productId: 'prod-latte',
        productName: 'Cappuccino',
        qty: 1,
        unitPrice: 100,
        subtotal: 100,
        taxAmount: 5,
        total: 105,
        variant: JSON.stringify([{ group_name: 'Size', option_name: 'Regular' }]),
      },
    ],
  });

  // 3) INV-0002: partially_refunded bill
  const b2 = insertBillWithOrder({
    billNumber: 'INV-0002',
    orderNumber: 'ORD-0002',
    paidAt: `${businessDate} 12:00:00`,
    paymentStatus: 'partially_refunded',
    subtotal: 180,
    taxAmount: 32.4,
    taxRate: 18,
    taxTitle: 'GST 18%',
    total: 212.4,
    method: 'cash',
    items: [
      {
        productId: 'prod-latte',
        productName: 'Cappuccino',
        qty: 1,
        unitPrice: 100,
        subtotal: 100,
        taxAmount: 18,
        total: 118,
      },
      {
        productId: 'prod-croissant',
        productName: 'Butter Croissant',
        qty: 1,
        unitPrice: 80,
        subtotal: 80,
        taxAmount: 14.4,
        total: 94.4,
        status: 'refunded',
      },
    ],
  });
  db.prepare(`
    INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
    VALUES (?, ?, 9440, 'cash', 'Croissant cold', NULL, 'owner-test-001', 'owner-test-001', ?)
  `).run(b2.billId, b2.itemIds[1], `${businessDate} 12:30:00`);

  const app = createApp({ '/api/reports': reportRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── 1. Role gating (403 for non-owner roles, 401 unauthenticated) ───');
    {
      const unauth = await fetch(
        `${baseUrl}/api/reports/daily-invoices/export?date=${businessDate}&format=html`,
      );
      assert.equal(unauth.status, 401, 'unauthenticated request returns 401');

      for (const [roleName, staff] of [
        ['manager', manager],
        ['cashier', cashier],
        ['waiter/server', waiter],
        ['kitchen/chef', kitchen],
      ] as const) {
        const res = await fetch(
          `${baseUrl}/api/reports/daily-invoices/export?date=${businessDate}&format=html`,
          { headers: staff.authHeader },
        );
        assert.equal(res.status, 403, `${roleName} role is rejected with 403`);
      }

      const badFormat = await fetch(
        `${baseUrl}/api/reports/daily-invoices/export?date=${businessDate}&format=xlsx`,
        { headers: owner.authHeader },
      );
      assert.equal(badFormat.status, 400, 'unsupported format=xlsx returns 400');

      const reversedRange = await fetch(
        `${baseUrl}/api/reports/daily-invoices/export?from=2026-09-16&to=2026-09-15&format=html`,
        { headers: owner.authHeader },
      );
      assert.equal(reversedRange.status, 400, 'reversed date range returns 400');

      const oversizedRange = await fetch(
        `${baseUrl}/api/reports/daily-invoices/export?from=2025-01-01&to=2026-01-02&format=html`,
        { headers: owner.authHeader },
      );
      assert.equal(oversizedRange.status, 400, 'range > 366 days returns 400');
    }
    console.log('  ✓ Role gating and input validation verified');

    console.log(
      '\n─── 2. Sequential bill_number ordering & [REFUNDED] / [PARTIALLY REFUNDED] badges ───',
    );
    let compiledHtml = '';
    {
      const res = await fetch(
        `${baseUrl}/api/reports/daily-invoices/export?date=${businessDate}&format=html`,
        { headers: owner.authHeader },
      );
      assert.equal(res.status, 200, 'owner export returns 200');
      assert.match(res.headers.get('content-type') || '', /text\/html/);
      assert.match(
        res.headers.get('content-disposition') || '',
        new RegExp(`invoices-${businessDate}\\.html`),
      );
      compiledHtml = await res.text();

      // Verify XSS escaping on store name
      assert.ok(
        compiledHtml.includes('FloCafe Artisan Roasters &lt;script&gt;alert(1)&lt;/script&gt;'),
        'store legal name is HTML-escaped',
      );
      assert.ok(
        !compiledHtml.includes('<script>alert(1)</script>'),
        'raw script tag is never emitted',
      );
      assert.ok(
        compiledHtml.includes('GSTIN: 29ABCDE1234F1Z5'),
        'country taxIdLabel (GSTIN) and tax ID are rendered',
      );
      assert.ok(compiledHtml.includes('42 Espresso Lane, Bengaluru'), 'store address is rendered');

      // Verify strict ascending bill_number order
      const cards = parseInvoiceCardOrder(compiledHtml);
      assert.deepEqual(
        cards,
        [
          { billNumber: 'INV-0001', status: 'paid' },
          { billNumber: 'INV-0002', status: 'partially_refunded' },
          { billNumber: 'INV-0003', status: 'refunded' },
        ],
        'invoices are rendered in strict ascending bill_number order including paid, partially_refunded, and refunded bills',
      );

      // Verify status badges and refund details
      assert.ok(compiledHtml.includes('[PAID]'), '[PAID] status badge is present');
      assert.ok(
        compiledHtml.includes('[PARTIALLY REFUNDED]'),
        '[PARTIALLY REFUNDED] status badge is present',
      );
      assert.ok(compiledHtml.includes('[REFUNDED]'), '[REFUNDED] status badge is present');
      assert.ok(
        compiledHtml.includes('Croissant cold') &&
          compiledHtml.includes('Butter Croissant (x1)') &&
          compiledHtml.includes('94.40'),
        'partial refund reason, refunded item/qty, and amount are present on INV-0002',
      );
      assert.ok(
        compiledHtml.includes('Customer cancelled dessert') &&
          compiledHtml.includes('Basque Cheesecake (x1)') &&
          compiledHtml.includes('210.00'),
        'full refund reason, refunded item/qty, and amount are present on INV-0003',
      );
      assert.ok(
        compiledHtml.includes('TXN-9003'),
        'card transaction_id is rendered in payment breakdown',
      );
      assert.ok(
        compiledHtml.includes('Aarav Sharma') && compiledHtml.includes('+919876543210'),
        'customer details are rendered on INV-0001',
      );
      assert.ok(
        compiledHtml.includes('page-break-inside: avoid;') &&
          compiledHtml.includes('break-inside: avoid;'),
        '.invoice-card enforces page-break-inside: avoid; break-inside: avoid;',
      );
    }
    console.log('  ✓ Sequential bill_number ordering and refund badges/details verified');

    console.log('\n─── 3. Cover-page reconciliation with Daily Sales .xlsx export ───');
    {
      const xlsxRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=xlsx`,
        { headers: owner.authHeader },
      );
      assert.equal(xlsxRes.status, 200, 'daily-sales .xlsx returns 200');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(await xlsxRes.arrayBuffer()));

      const xlsxSummary = new Map<string, string>();
      workbook.getWorksheet('Summary').eachRow((row: any, rowNumber: number) => {
        if (rowNumber > 1) {
          xlsxSummary.set(String(row.getCell(1).value), String(row.getCell(2).value ?? ''));
        }
      });

      const htmlSummary = parseHtmlSummaryMetrics(compiledHtml);
      assert.equal(
        htmlSummary.size,
        xlsxSummary.size,
        'cover page summary metric count matches .xlsx Summary sheet',
      );
      for (const [metric, xlsxVal] of xlsxSummary.entries()) {
        assert.equal(
          htmlSummary.get(metric),
          xlsxVal,
          `cover page summary metric "${metric}" matches .xlsx (${xlsxVal})`,
        );
      }

      // Reconcile VAT/Tax Summary Table with .xlsx Taxes sheet
      const xlsxTaxRows: Array<{
        date: string;
        name: string;
        rate: string;
        base: string;
        tax: string;
        gross: string;
      }> = [];
      workbook.getWorksheet('Taxes').eachRow((row: any, rowNumber: number) => {
        if (rowNumber > 1) {
          xlsxTaxRows.push({
            date: String(row.getCell(1).value ?? ''),
            name: String(row.getCell(2).value ?? ''),
            rate:
              row.getCell(3).value === null || row.getCell(3).value === ''
                ? ''
                : String(Number(row.getCell(3).value)),
            base:
              row.getCell(4).value === null || row.getCell(4).value === ''
                ? ''
                : String(Number(row.getCell(4).value)),
            tax: String(Number(row.getCell(5).value ?? 0)),
            gross:
              row.getCell(6).value === null || row.getCell(6).value === ''
                ? ''
                : String(Number(row.getCell(6).value)),
          });
        }
      });

      const htmlTaxRows = parseHtmlTaxRows(compiledHtml);
      assert.deepEqual(
        htmlTaxRows,
        xlsxTaxRows,
        'cover page tax breakdown rows match .xlsx Taxes sheet exactly',
      );
    }
    console.log('  ✓ Cover-page summary and VAT/Tax Summary Table reconcile 100% with .xlsx');

    console.log('\n─── 4. Cross-midnight business_day_start_time boundary filtering ───');
    {
      // Configure business_day_start_time = 04:00 UTC
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '04:00', CURRENT_TIMESTAMP)",
      ).run();

      const shiftDate = '2026-09-20';
      // Window for 2026-09-20 with 04:00 start is [2026-09-20 04:00:00, 2026-09-21 04:00:00)
      // Pre-window bill at 2026-09-20 02:30:00 (belongs to 2026-09-19, must be excluded)
      insertBillWithOrder({
        billNumber: 'INV-CM-PRE',
        orderNumber: 'ORD-CM-PRE',
        paidAt: '2026-09-20 02:30:00',
        paymentStatus: 'paid',
        subtotal: 50,
        taxAmount: 2.5,
        taxRate: 5,
        taxTitle: 'GST 5%',
        total: 52.5,
        method: 'cash',
        items: [
          {
            productId: 'prod-latte',
            productName: 'Cappuccino',
            qty: 1,
            unitPrice: 50,
            subtotal: 50,
            taxAmount: 2.5,
            total: 52.5,
          },
        ],
      });

      // Post-midnight pre-cutoff bill at 2026-09-21 02:15:00 (belongs to 2026-09-20, must be included)
      insertBillWithOrder({
        billNumber: 'INV-CM-IN-2',
        orderNumber: 'ORD-CM-IN-2',
        paidAt: '2026-09-21 02:15:00',
        paymentStatus: 'paid',
        subtotal: 100,
        taxAmount: 5,
        taxRate: 5,
        taxTitle: 'GST 5%',
        total: 105,
        method: 'cash',
        items: [
          {
            productId: 'prod-latte',
            productName: 'Cappuccino',
            qty: 1,
            unitPrice: 100,
            subtotal: 100,
            taxAmount: 5,
            total: 105,
          },
        ],
      });

      // Afternoon bill at 2026-09-20 18:00:00 (belongs to 2026-09-20, must be included)
      insertBillWithOrder({
        billNumber: 'INV-CM-IN-1',
        orderNumber: 'ORD-CM-IN-1',
        paidAt: '2026-09-20 18:00:00',
        paymentStatus: 'paid',
        subtotal: 80,
        taxAmount: 4,
        taxRate: 5,
        taxTitle: 'GST 5%',
        total: 84,
        method: 'cash',
        items: [
          {
            productId: 'prod-croissant',
            productName: 'Butter Croissant',
            qty: 1,
            unitPrice: 80,
            subtotal: 80,
            taxAmount: 4,
            total: 84,
          },
        ],
      });

      // Post-cutoff bill at 2026-09-21 04:05:00 (belongs to 2026-09-21, must be excluded)
      insertBillWithOrder({
        billNumber: 'INV-CM-POST',
        orderNumber: 'ORD-CM-POST',
        paidAt: '2026-09-21 04:05:00',
        paymentStatus: 'paid',
        subtotal: 200,
        taxAmount: 10,
        taxRate: 5,
        taxTitle: 'GST 5%',
        total: 210,
        method: 'cash',
        items: [
          {
            productId: 'prod-cake',
            productName: 'Basque Cheesecake',
            qty: 1,
            unitPrice: 200,
            subtotal: 200,
            taxAmount: 10,
            total: 210,
          },
        ],
      });

      const cmRes = await fetch(
        `${baseUrl}/api/reports/daily-invoices/export?date=${shiftDate}&format=html`,
        { headers: owner.authHeader },
      );
      assert.equal(cmRes.status, 200, 'cross-midnight export returns 200');
      const cmHtml = await cmRes.text();
      const cmCards = parseInvoiceCardOrder(cmHtml);
      assert.deepEqual(
        cmCards.map((c) => c.billNumber),
        ['INV-CM-IN-1', 'INV-CM-IN-2'],
        'cross-midnight export includes post-midnight pre-cutoff bill and excludes out-of-window bills',
      );

      // Reset business_day_start_time back to 00:00
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '00:00', CURRENT_TIMESTAMP)",
      ).run();
    }
    console.log('  ✓ Cross-midnight business_day_start_time boundary filtering verified');

    console.log('\n─── 5. Desktop save-html-as-pdf IPC & Browser Print Fallback ───');
    {
      const mainFrame = { frameToken: 'frame-main', detached: false };
      const mainWin = { isDestroyed: () => false };
      const trustedSender = {
        sender: {
          ownerWindow: mainWin,
          mainFrame,
          getURL: () => 'http://localhost:3001/',
        },
        senderFrame: mainFrame,
      };
      registerIpcHandlers(undefined, () => mainWin as any);
      const saveHtmlAsPdfIpc = registeredIpcHandlers.get('save-html-as-pdf');
      assert.equal(
        typeof saveHtmlAsPdfIpc,
        'function',
        'save-html-as-pdf IPC handler is registered',
      );

      const pdfOutPath = path.join(testDir, `invoices-${businessDate}.pdf`);
      saveDialogResult = { canceled: false, filePath: pdfOutPath };
      const ipcResult = await saveHtmlAsPdfIpc!(trustedSender, {
        html: compiledHtml,
        defaultFileName: `invoices-${businessDate}.pdf`,
        pageSize: 'A4',
      });
      assert.deepEqual(
        ipcResult,
        { success: true, path: pdfOutPath },
        'save-html-as-pdf writes compiled invoices PDF file',
      );
      const pdfBytes = fs.readFileSync(pdfOutPath);
      assert.equal(
        pdfBytes.subarray(0, 5).toString('ascii'),
        '%PDF-',
        'compiled invoices PDF starts with %PDF- magic header',
      );
      assert.ok(
        pdfBytes.toString('utf8').includes('break-inside: avoid;'),
        'compiled PDF payload preserves .invoice-card break-inside: avoid rule',
      );
      assert.ok(
        lastLoadedHtmlPath.length > 0 && !fs.existsSync(lastLoadedHtmlPath),
        'staging HTML file is cleaned up after printToPDF',
      );

      await verifyBrowserPrintFallback(compiledHtml, `invoices-${businessDate}.pdf`);
    }
    console.log('  ✓ save-html-as-pdf desktop IPC and verifyBrowserPrintFallback verified');

    console.log(
      '\n─── 6. Qodo review invariants: refund scope reconciliation, locale/lang, active tax pack label, cover pagination, item total vs subtotal, >9999 sequence & prefix changes, and invoice count cap ───',
    );
    {
      const {
        buildDailyInvoicesExportDataset,
        serializeDailyInvoicesExportHtml,
      } = require('../main/services/daily-invoices-export');
      const { DailySalesExportValidationError } = require('../main/services/daily-sales-export');

      // (a) HTML lang attribute, locale-aware money formatting, item subtotal vs total, and bounded cover page
      assert.ok(
        compiledHtml.includes('<html lang="en-IN">'),
        'HTML lang attribute uses resolved regional locale (en-IN) instead of hardcoded en',
      );
      assert.ok(
        compiledHtml.includes('₹105.00') && compiledHtml.includes('₹212.40'),
        'invoice amounts use locale-aware formatMoney with currency symbol',
      );
      assert.ok(
        compiledHtml.includes('data-item-subtotal="100" data-item-total="105"') &&
          compiledHtml.includes('<td class="num" data-col="item-subtotal">₹100.00</td>') &&
          compiledHtml.includes('<td class="num" data-col="item-total">₹105.00</td>'),
        'invoice line item table renders both pre-tax Subtotal (₹100.00) and after-tax Total (₹105.00) matching receipts',
      );
      const coverEndIdx = compiledHtml.indexOf('</section>');
      const invoicesSectionIdx = compiledHtml.indexOf('data-section="invoices"');
      const appendixSectionIdx = compiledHtml.indexOf('data-section="daily-tax-appendix"');
      const dailyTaxesTableIdx = compiledHtml.indexOf('<table data-section="taxes">');
      assert.ok(
        coverEndIdx > 0 &&
          invoicesSectionIdx > coverEndIdx &&
          appendixSectionIdx > invoicesSectionIdx &&
          dailyTaxesTableIdx > appendixSectionIdx,
        'per-day tax breakdown table is placed in the post-invoices appendix so the cover page remains bounded to page 1',
      );

      // (b) Custom active tax pack registrationNumberLabel overrides static country taxIdLabel
      const customPackPayload = JSON.stringify({
        country: 'IN',
        name: 'India Custom Pack',
        version: '1.0.0',
        registrationNumberLabel: 'Custom-TRN',
        rules: [],
      });
      db.prepare(
        `INSERT OR REPLACE INTO country_packs (
           id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
         ) VALUES ('pack-in-custom', 'local', 'IN', '*', 'ver-in-custom-1', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run();
      db.prepare(
        `INSERT OR REPLACE INTO country_pack_versions (
           id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
           effective_from, effective_to, min_flo_version, published_at, status, created_at
         ) VALUES (
           'ver-in-custom-1', 'pack-in-custom', '1.0.0', 1, '{}', ?, 'sha256:test', NULL,
           '2026-01-01', NULL, '2.4.0', '2026-01-01', 'active', CURRENT_TIMESTAMP
         )`,
      ).run(customPackPayload);
      const customPackDataset = buildDailyInvoicesExportDataset({ date: businessDate }, db);
      assert.equal(
        customPackDataset.store.tax_id_label,
        'Custom-TRN',
        'active tax pack registrationNumberLabel overrides static country taxIdLabel',
      );
      const customPackHtml = serializeDailyInvoicesExportHtml(customPackDataset, {
        locale: 'de-DE',
      });
      assert.ok(
        customPackHtml.includes('<html lang="de-DE">') &&
          customPackHtml.includes('Custom-TRN: 29ABCDE1234F1Z5'),
        'custom locale option and active tax pack registrationNumberLabel render in HTML',
      );
      db.prepare(`DELETE FROM country_pack_versions WHERE id = 'ver-in-custom-1'`).run();
      db.prepare(`DELETE FROM country_packs WHERE id = 'pack-in-custom'`).run();

      // (c) Refund scope reconciliation across period boundaries (prior-bill refund in window + post-window refund on window bill)
      const priorBill = insertBillWithOrder({
        billNumber: 'INV-PRIOR-0001',
        orderNumber: 'ORD-PRIOR-0001',
        paidAt: '2026-09-10 11:00:00',
        paymentStatus: 'partially_refunded',
        subtotal: 100,
        taxAmount: 5,
        taxRate: 5,
        taxTitle: 'GST 5%',
        total: 105,
        method: 'cash',
        items: [
          {
            productId: 'prod-latte',
            productName: 'Cappuccino',
            qty: 1,
            unitPrice: 100,
            subtotal: 100,
            taxAmount: 5,
            total: 105,
          },
        ],
      });
      // In-window refund on 2026-09-15 against the older 2026-09-10 bill (50.00 INR)
      db.prepare(
        `INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
         VALUES (?, ?, 5000, 'cash', 'Prior bill goodwill adjustment', NULL, 'owner-test-001', 'owner-test-001', ?)`,
      ).run(priorBill.billId, priorBill.itemIds[0], `${businessDate} 16:00:00`);

      // Post-window refund on 2026-09-16 against INV-0002 (paid on 2026-09-15, 25.00 INR)
      db.prepare(
        `INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
         VALUES (?, ?, 2500, 'cash', 'Next-day partial adjustment', NULL, 'owner-test-001', 'owner-test-001', '2026-09-16 09:00:00')`,
      ).run(b2.billId, b2.itemIds[0]);

      const reconciledDataset = buildDailyInvoicesExportDataset({ date: businessDate }, db);
      assert.equal(
        reconciledDataset.in_window_refunds_on_included_bills,
        304.4,
        'in-window refunds on included bills equals 94.40 + 210.00',
      );
      assert.equal(
        reconciledDataset.in_window_refunds_on_prior_bills,
        50,
        'in-window refunds on prior-period bills equals 50.00',
      );
      assert.equal(
        reconciledDataset.total_refunds,
        354.4,
        'cover total_refunds equals in_window_refunds_on_included_bills (304.40) + in_window_refunds_on_prior_bills (50.00)',
      );
      assert.equal(
        reconciledDataset.post_window_refunds_on_included_bills,
        25,
        'post-window refunds on included bills equals 25.00',
      );
      assert.equal(
        reconciledDataset.lifetime_refunds_on_included_bills,
        329.4,
        'lifetime refunds on included bills equals in-window (304.40) + post-window (25.00)',
      );
      const reconciledHtml = serializeDailyInvoicesExportHtml(reconciledDataset);
      assert.ok(
        reconciledHtml.includes('data-scope="in_window_refunds_on_prior_bills" data-value="50"') &&
          reconciledHtml.includes(
            'data-scope="post_window_refunds_on_included_bills" data-value="25"',
          ) &&
          reconciledHtml.includes('data-bill-number="INV-PRIOR-0001"') &&
          reconciledHtml.includes('[Outside Period]') &&
          reconciledHtml.includes('[In Period]'),
        'HTML explicitly reconciles in-period, prior-bill, and outside-period refund scopes',
      );

      // (d) Sequence ordering across 9999 -> 10000 and mid-range prefix change
      const seqDate = '2026-09-25';
      insertBillWithOrder({
        billNumber: 'INV-10000',
        orderNumber: 'ORD-10000',
        paidAt: `${seqDate} 11:00:00`,
        paymentStatus: 'paid',
        subtotal: 100,
        taxAmount: 5,
        taxRate: 5,
        taxTitle: 'GST 5%',
        total: 105,
        method: 'cash',
        items: [
          {
            productId: 'prod-latte',
            productName: 'Cappuccino',
            qty: 1,
            unitPrice: 100,
            subtotal: 100,
            taxAmount: 5,
            total: 105,
          },
        ],
      });
      insertBillWithOrder({
        billNumber: 'INV-9999',
        orderNumber: 'ORD-9999',
        paidAt: `${seqDate} 10:00:00`,
        paymentStatus: 'paid',
        subtotal: 100,
        taxAmount: 5,
        taxRate: 5,
        taxTitle: 'GST 5%',
        total: 105,
        method: 'cash',
        items: [
          {
            productId: 'prod-latte',
            productName: 'Cappuccino',
            qty: 1,
            unitPrice: 100,
            subtotal: 100,
            taxAmount: 5,
            total: 105,
          },
        ],
      });
      insertBillWithOrder({
        billNumber: 'BILL-10001',
        orderNumber: 'ORD-10001',
        paidAt: `${seqDate} 12:00:00`,
        paymentStatus: 'paid',
        subtotal: 100,
        taxAmount: 5,
        taxRate: 5,
        taxTitle: 'GST 5%',
        total: 105,
        method: 'cash',
        items: [
          {
            productId: 'prod-latte',
            productName: 'Cappuccino',
            qty: 1,
            unitPrice: 100,
            subtotal: 100,
            taxAmount: 5,
            total: 105,
          },
        ],
      });
      const seqDataset = buildDailyInvoicesExportDataset({ date: seqDate }, db);
      assert.deepEqual(
        seqDataset.invoices.map((i: any) => i.bill_number),
        ['INV-9999', 'INV-10000', 'BILL-10001'],
        'numeric sequence ordering places INV-9999 before INV-10000 and preserves sequence across mid-range prefix change (BILL-10001)',
      );

      // (e) Pre-hydration invoice count cap throws DailySalesExportValidationError before hydrating
      assert.throws(
        () => buildDailyInvoicesExportDataset({ date: seqDate }, db, { maxInvoicesCount: 2 }),
        (err: unknown) =>
          err instanceof DailySalesExportValidationError &&
          err.statusCode === 400 &&
          /maximum invoice count \(2\)/.test(err.message),
        'exceeding maxInvoicesCount throws DailySalesExportValidationError (400) before hydration',
      );
    }
    console.log('  ✓ All 7 Qodo review invariants verified');

    console.log(
      '\n─── 7. Custom charges (Eco Fee) and legacy charge fallback in archived invoices (PR #1400) ───',
    );
    {
      const chargesDate = '2026-09-22';
      const ecoBreakdown = JSON.stringify([
        {
          id: 'eco_fee',
          name: 'Eco Fee',
          type: 'fixed',
          amount: 10.0,
          calculation_basis: 'net',
          waived: false,
        },
      ]);

      // Bill with 10.00 custom Eco Fee (subtotal: 60.00, tax: 4.20, total: 74.20)
      insertBillWithOrder({
        billNumber: 'INV-ECO-01',
        orderNumber: 'ORD-ECO-01',
        paidAt: `${chargesDate}T12:00:00Z`,
        paymentStatus: 'paid',
        subtotal: 60,
        taxAmount: 4.2,
        taxRate: 7,
        taxTitle: 'VAT 7%',
        total: 74.2,
        method: 'cash',
        items: [
          {
            productId: 'prod-latte',
            productName: 'Eco Coffee',
            qty: 1,
            unitPrice: 60,
            subtotal: 60,
            taxAmount: 4.2,
            total: 64.2,
          },
        ],
      });
      // Attach charges_breakdown to the newly inserted order and bill
      db.prepare("UPDATE orders SET charges_breakdown = ? WHERE order_number = 'ORD-ECO-01'").run(
        ecoBreakdown,
      );
      db.prepare("UPDATE bills SET charges_breakdown = ? WHERE bill_number = 'INV-ECO-01'").run(
        ecoBreakdown,
      );

      // Legacy bill with charges_breakdown = NULL and legacy service, packaging, delivery charges
      insertBillWithOrder({
        billNumber: 'INV-LEGACY-01',
        orderNumber: 'ORD-LEGACY-01',
        paidAt: `${chargesDate}T13:00:00Z`,
        paymentStatus: 'paid',
        subtotal: 50,
        serviceCharge: 5.0,
        taxAmount: 3.5,
        taxRate: 7,
        taxTitle: 'VAT 7%',
        total: 63.5,
        method: 'card',
        items: [
          {
            productId: 'prod-croissant',
            productName: 'Legacy Croissant',
            qty: 1,
            unitPrice: 50,
            subtotal: 50,
            taxAmount: 3.5,
            total: 53.5,
          },
        ],
      });
      db.prepare(
        "UPDATE bills SET packaging_charge = 3.0, delivery_charge = 2.0, total = 63.5 WHERE bill_number = 'INV-LEGACY-01'",
      ).run();
      db.prepare(
        "UPDATE orders SET packaging_charge = 3.0, delivery_charge = 2.0, total = 63.5 WHERE order_number = 'ORD-LEGACY-01'",
      ).run();

      // Bill where orders.charges_breakdown has a custom fee but bills.charges_breakdown is NULL (Qodo Finding #3)
      insertBillWithOrder({
        billNumber: 'INV-SPLIT-NULL-BREAKDOWN-01',
        orderNumber: 'ORD-WITH-ORDER-FEE-01',
        paidAt: `${chargesDate}T14:00:00Z`,
        paymentStatus: 'paid',
        subtotal: 40,
        serviceCharge: 4.0,
        taxAmount: 2.8,
        taxRate: 7,
        taxTitle: 'VAT 7%',
        total: 46.8,
        method: 'cash',
        items: [
          {
            productId: 'prod-cookie',
            productName: 'Choco Cookie',
            qty: 1,
            unitPrice: 40,
            subtotal: 40,
            taxAmount: 2.8,
            total: 42.8,
          },
        ],
      });
      const orderOnlyCustomFee = JSON.stringify([
        {
          id: 'order_custom_fee',
          name: 'Order Level Surcharge',
          type: 'fixed',
          amount: 25.0,
          calculation_basis: 'net',
          waived: false,
        },
      ]);
      db.prepare("UPDATE orders SET charges_breakdown = ? WHERE order_number = 'ORD-WITH-ORDER-FEE-01'").run(
        orderOnlyCustomFee,
      );
      db.prepare("UPDATE bills SET charges_breakdown = NULL WHERE bill_number = 'INV-SPLIT-NULL-BREAKDOWN-01'").run();

      const res = await fetch(
        `${baseUrl}/api/reports/daily-invoices/export?date=${chargesDate}&format=html`,
        { headers: owner.authHeader },
      );
      assert.equal(res.status, 200, 'owner export for charges date returns 200');
      const html = await res.text();

      // Verify custom Eco Fee renders in archived invoice
      assert.ok(html.includes('Eco Fee'), 'custom charge "Eco Fee" renders in archived invoice');
      assert.ok(html.includes('10.00'), 'custom charge amount "10.00" renders in archived invoice');

      // Verify bill with NULL charges_breakdown never adopts orders.charges_breakdown (Qodo Finding #3)
      assert.ok(
        !html.includes('Order Level Surcharge'),
        'bill with NULL charges_breakdown does not inherit orders.charges_breakdown',
      );

      // Verify legacy bills with charges_breakdown = NULL still render standard charge lines
      assert.ok(
        html.includes('Service Charge'),
        'legacy bill renders "Service Charge" when charges_breakdown is NULL',
      );
      assert.ok(
        html.includes('Packaging Charge'),
        'legacy bill renders "Packaging Charge" when charges_breakdown is NULL',
      );
      assert.ok(
        html.includes('Delivery Charge'),
        'legacy bill renders "Delivery Charge" when charges_breakdown is NULL',
      );
    }
    console.log('  ✓ Custom charges and legacy fallbacks verified in archived invoices');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n✅ All daily-invoices-export tests passed!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
