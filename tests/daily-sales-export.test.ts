/**
 * Owner-only daily sales export — GET /api/reports/daily-sales/export.
 *
 * Covers:
 *  - Role gating: owner OK, manager/cashier 403.
 *  - Validation: bad format → 400; csv without part → 400.
 *  - XLSX: Summary + Items sheets, Content-Disposition filename.
 *  - CSV: separate summary/items files; formula-neutralized cells.
 *  - Reconciliation identities from the approved contract.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/daily-sales-export.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-daily-sales-export-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  assert,
  assertEqual,
  assertIncludes,
  getResults,
  closeDatabase,
  getDatabase,
  now,
} = require('./helpers/test-setup');
const { reportRoutes } = require('../main/routes/reports');
const ExcelJS = require('exceljs');

function dbTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

async function main() {
  console.log('Integration Test: Daily sales export (xlsx + csv)');
  console.log('='.repeat(64));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'cat-dse', 'Export Cat');
  seedProduct(db, 'prod-dse', 'cat-dse', 'Latte', 10);
  seedProduct(db, 'prod-dse2', 'cat-dse', 'Mocha', 15);

  // Two paid bills on a fixed business day (Asia/Kolkata from test defaults).
  const businessDate = '2026-09-10';
  const paidAt = dbTimestamp(new Date(`${businessDate}T12:00:00Z`));

  function seedPaidBill(billNumber: string, amount: number, method: string, items: Array<{ productId: string; qty: number; subtotal: number }>) {
    db.prepare(`
      INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES (?, 'owner-test-001', 'takeaway', 'completed', ?, ?, ?, ?, ?)
    `).run(`ORD-${billNumber}`, amount, amount, paidAt, paidAt, paidAt);
    const orderId = Number(db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-${billNumber}`).id);
    for (const item of items) {
      db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 'ready', ?, ?)
      `).run(orderId, item.productId, item.productId === 'prod-dse' ? 'Latte' : 'Mocha', item.qty, item.subtotal / item.qty, item.subtotal, item.subtotal, paidAt, paidAt);
    }
    db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)
    `).run(billNumber, orderId, amount, amount, amount, JSON.stringify([{ method, amount, timestamp: paidAt }]), paidAt, paidAt, paidAt);
    return orderId;
  }

  seedPaidBill('B-DSE-1', 25, 'cash', [
    { productId: 'prod-dse', qty: 1, subtotal: 10 },
    { productId: 'prod-dse2', qty: 1, subtotal: 15 },
  ]);
  seedPaidBill('B-DSE-2', 10, 'card', [
    { productId: 'prod-dse', qty: 1, subtotal: 10 },
  ]);

  // Same-day refund (cash) against B-DSE-1.
  const bill1 = db.prepare("SELECT id FROM bills WHERE bill_number = 'B-DSE-1'").get() as { id: number };
  db.prepare(`
    INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
    VALUES (?, NULL, 500, 'cash', 'partial', NULL, 'owner-test-001', 'owner-test-001', ?)
  `).run(bill1.id, paidAt);

  const app = createApp({ '/api/reports': reportRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Role gating ───');
    {
      const forbidden = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=xlsx`,
        { headers: { ...manager.authHeader } },
      );
      assertEqual(forbidden.status, 403, 'manager forbidden (403)');
      const noAuth = await fetch(`${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=xlsx`);
      assertEqual(noAuth.status, 401, 'unauthenticated rejected (401)');
    }

    console.log('\n─── Validation ───');
    {
      const badFormat = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=pdf`,
        { headers: authHeader },
      );
      assertEqual(badFormat.status, 400, 'invalid format → 400');
      const csvNoPart = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=csv`,
        { headers: authHeader },
      );
      assertEqual(csvNoPart.status, 400, 'csv without part → 400');
    }

    console.log('\n─── XLSX export ───');
    {
      const res = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(res.status, 200, 'xlsx → 200');
      const disposition = res.headers.get('content-disposition') || '';
      assertIncludes(disposition, `daily-sales-${businessDate}.xlsx`, 'Content-Disposition filename');
      const buf = Buffer.from(await res.arrayBuffer());
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buf);
      assertEqual(workbook.worksheets.length, 2, 'xlsx has Summary + Items');
      assertEqual(workbook.worksheets[0].name, 'Summary', 'sheet 0 is Summary');
      assertEqual(workbook.worksheets[1].name, 'Items', 'sheet 1 is Items');

      // Summary metrics
      const summarySheet = workbook.getWorksheet('Summary')!;
      const metrics = new Map<string, number | string>();
      summarySheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        metrics.set(String(row.getCell(1).value), row.getCell(2).value as any);
      });
      assertEqual(metrics.get('business_date'), businessDate, 'summary business_date');
      assertEqual(Number(metrics.get('order_count')), 2, 'order_count = 2');
      assertEqual(Number(metrics.get('paid_bill_count')), 2, 'paid_bill_count = 2');
      assertEqual(Number(metrics.get('gross_collected')), 35, 'gross_collected = 35');
      assertEqual(Number(metrics.get('refunds_issued')), 5, 'refunds_issued = 5');
      assertEqual(Number(metrics.get('net_collected')), 30, 'net_collected = gross - refunds');

      const paymentCash = Number(metrics.get('payment_cash') || 0);
      const paymentCard = Number(metrics.get('payment_card') || 0);
      assertEqual(paymentCash + paymentCard, 30, 'Σ payment totals = net_collected');

      // Items sheet
      const itemsSheet = workbook.getWorksheet('Items')!;
      assertIncludes(
        String(itemsSheet.getRow(1).getCell(1).value),
        'product_id',
        'Items header has product_id',
      );
      const itemRows: Array<{ product: string; net: number }> = [];
      itemsSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        itemRows.push({
          product: String(row.getCell(2).value),
          net: Number(row.getCell(7).value),
        });
      });
      assertEqual(itemRows.length, 2, 'Items has 2 product rows');
      const latte = itemRows.find((r) => r.product === 'Latte');
      const mocha = itemRows.find((r) => r.product === 'Mocha');
      assertEqual(latte && Math.abs(latte.net - 20) < 1e-9, true, 'Latte net_item_sales = 20');
      assertEqual(mocha && Math.abs(mocha.net - 15) < 1e-9, true, 'Mocha net_item_sales = 15');
      const sumNet = itemRows.reduce((s, r) => s + r.net, 0);
      assertEqual(Math.abs(sumNet - 35) < 1e-9, true, 'Σ net_item_sales = bills.subtotal (35)');
    }

    console.log('\n─── CSV export (summary + items) ───');
    {
      const summaryRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=csv&part=summary`,
        { headers: authHeader },
      );
      assertEqual(summaryRes.status, 200, 'csv summary → 200');
      assertIncludes(
        summaryRes.headers.get('content-disposition') || '',
        `daily-sales-${businessDate}-summary.csv`,
        'summary Content-Disposition filename',
      );
      const summaryCsv = await summaryRes.text();
      assertIncludes(summaryCsv, 'metric,value', 'summary CSV header');
      assertIncludes(summaryCsv, 'net_collected,30', 'summary CSV net_collected');

      const itemsRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=csv&part=items`,
        { headers: authHeader },
      );
      assertEqual(itemsRes.status, 200, 'csv items → 200');
      assertIncludes(
        itemsRes.headers.get('content-disposition') || '',
        `daily-sales-${businessDate}-items.csv`,
        'items Content-Disposition filename',
      );
      const itemsCsv = await itemsRes.text();
      assertIncludes(
        itemsCsv,
        'product_id,product_name,product_sku,quantity,gross_item_sales,item_discounts,net_item_sales,tax_amount',
        'items CSV header',
      );
      assertIncludes(itemsCsv, 'Latte', 'items CSV has Latte');
      assertIncludes(itemsCsv, 'Mocha', 'items CSV has Mocha');
    }

    console.log('\n─── Formula neutralization in CSV ───');
    {
      // Inject a formula-leading product name on a third paid bill.
      seedPaidBill('B-DSE-3', 5, 'cash', [
        { productId: 'prod-dse', qty: 1, subtotal: 5 },
      ]);
      db.prepare(`
        UPDATE order_items SET product_name = ?
        WHERE order_id = (SELECT id FROM orders WHERE order_number = 'ORD-B-DSE-3')
      `).run('=HYPERLINK("https://evil.example","x")');
      const itemsRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=csv&part=items`,
        { headers: authHeader },
      );
      const itemsCsv = await itemsRes.text();
      assertIncludes(itemsCsv, "'=HYPERLINK", 'formula-leading name neutralized with leading quote');
      assert(!/,=HYPERLINK/.test(itemsCsv), 'no bare = formula cell in items CSV');
    }

    console.log('\n─── Empty day ───');
    {
      const res = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=2020-01-01&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(res.status, 200, 'empty day xlsx → 200');
      const buf = Buffer.from(await res.arrayBuffer());
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buf);
      const itemsSheet = workbook.getWorksheet('Items')!;
      assertEqual(itemsSheet.rowCount, 1, 'empty day Items has header only');
    }

    console.log('\n─── Accounting edge cases ───');
    {
      // Use a clean date far from the baseline fixtures so totals are isolated.
      const edgeDate = '2026-09-11';
      const edgeAt = dbTimestamp(new Date(`${edgeDate}T12:00:00Z`));
      const edgeNext = '2026-09-12';
      const edgeNextAt = dbTimestamp(new Date(`${edgeNext}T12:00:00Z`));

      function seedEdgeOrder(opts: {
        billNumber: string;
        amount: number;
        method: string;
        status?: string;
        paidAt?: string | null;
        paymentStatus?: string;
        discountAmount?: number;
        serviceCharge?: number;
        packagingCharge?: number;
        deliveryCharge?: number;
        itemOverrides?: Array<{
          productId: string;
          qty: number;
          subtotal: number;
          discountAmount?: number;
          status?: string;
          taxAmount?: number;
        }>;
        splitGroupId?: string;
        billItems?: Array<{ orderItemId: number; quantity: number }>;
      }) {
        const paid = opts.paidAt === undefined ? edgeAt : opts.paidAt;
        db.prepare(`
          INSERT INTO orders (order_number, user_id, type, status, subtotal, total, discount_amount, service_charge, packaging_charge, delivery_charge, created_at, updated_at, completed_at)
          VALUES (?, 'owner-test-001', 'takeaway', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `ORD-${opts.billNumber}`,
          opts.status || 'completed',
          opts.amount,
          opts.amount,
          opts.discountAmount || 0,
          opts.serviceCharge || 0,
          opts.packagingCharge || 0,
          opts.deliveryCharge || 0,
          edgeAt, edgeAt, paid || edgeAt,
        );
        const orderId = Number(db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-${opts.billNumber}`).id);
        const items = opts.itemOverrides || [{ productId: 'prod-dse', qty: 1, subtotal: opts.amount }];
        const itemIds: number[] = [];
        for (const item of items) {
          const name = item.productId === 'prod-dse' ? 'Latte' : 'Mocha';
          const discount = item.discountAmount || 0;
          const net = item.subtotal - discount;
          const tax = item.taxAmount || 0;
          const res = db.prepare(`
            INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, discount_amount, tax_amount, total, status, created_at, updated_at)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(orderId, item.productId, name, item.qty, item.subtotal / item.qty, net, discount, tax, net + tax, item.status || 'ready', edgeAt, edgeAt);
          itemIds.push(Number(res.lastInsertRowid));
        }
        const billRes = db.prepare(`
          INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, discount_amount, service_charge, packaging_charge, delivery_charge, split_group_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          opts.billNumber, orderId, opts.amount, opts.amount,
          paid ? opts.amount : 0,
          opts.paymentStatus || (paid ? 'paid' : 'unpaid'),
          paid ? JSON.stringify([{ method: opts.method, amount: opts.amount, timestamp: paid }]) : null,
          paid, opts.discountAmount || 0, opts.serviceCharge || 0, opts.packagingCharge || 0, opts.deliveryCharge || 0,
          opts.splitGroupId || null, edgeAt, edgeAt,
        );
        const billId = Number(billRes.lastInsertRowid);
        if (opts.billItems) {
          for (const bi of opts.billItems) {
            db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, ?)')
              .run(billId, bi.orderItemId, bi.quantity);
          }
        }
        return { orderId, billId, itemIds };
      }

      async function fetchSummary(date: string): Promise<Map<string, number | string>> {
        const res = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?date=${date}&format=csv&part=summary`,
          { headers: authHeader },
        );
        assertEqual(res.status, 200, `summary csv ${date} → 200`);
        const text = await res.text();
        const map = new Map<string, number | string>();
        for (const line of text.trim().split('\n').slice(1)) {
          const idx = line.indexOf(',');
          if (idx < 0) continue;
          const key = line.slice(0, idx);
          const raw = line.slice(idx + 1);
          map.set(key, Number.isNaN(Number(raw)) ? raw : Number(raw));
        }
        return map;
      }

      async function fetchItems(date: string): Promise<Array<{ product_id: string; product_name: string; quantity: number; gross_item_sales: number; item_discounts: number; net_item_sales: number; tax_amount: number }>> {
        const res = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?date=${date}&format=csv&part=items`,
          { headers: authHeader },
        );
        assertEqual(res.status, 200, `items csv ${date} → 200`);
        const text = await res.text();
        return text.trim().split('\n').slice(1).filter(Boolean).map((line) => {
          const cols = line.split(',');
          return {
            product_id: cols[0],
            product_name: cols[1],
            quantity: Number(cols[3]),
            gross_item_sales: Number(cols[4]),
            item_discounts: Number(cols[5]),
            net_item_sales: Number(cols[6]),
            tax_amount: Number(cols[7]),
          };
        });
      }

      // 1) Split bill: same order, two paid bills, partial bill_items allocation.
      const split = seedEdgeOrder({
        billNumber: 'B-DSE-SPLIT-1',
        amount: 10,
        method: 'cash',
        itemOverrides: [
          { productId: 'prod-dse', qty: 1, subtotal: 10 },
          { productId: 'prod-dse2', qty: 1, subtotal: 15 },
        ],
        splitGroupId: 'split-dse-a',
        billItems: [],
      });
      // Second bill for the same order (sibling in split group).
      const splitBill2 = db.prepare(`
        INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, split_group_id, created_at, updated_at)
        VALUES ('B-DSE-SPLIT-2', ?, 15, 15, 15, 0, 'paid', ?, ?, 'split-dse-a', ?, ?)
      `).run(split.orderId, JSON.stringify([{ method: 'card', amount: 15, timestamp: edgeAt }]), edgeAt, edgeAt, edgeAt);
      const splitBill2Id = Number(splitBill2.lastInsertRowid);
      // bill_items: bill1 gets Latte qty1, bill2 gets Mocha qty1.
      db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)')
        .run(split.billId, split.itemIds[0]);
      db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)')
        .run(splitBill2Id, split.itemIds[1]);

      // 2) Partial (unpaid) bill and open/unpaid order — must be excluded.
      seedEdgeOrder({ billNumber: 'B-DSE-UNPAID', amount: 99, method: 'cash', paidAt: null, paymentStatus: 'unpaid', status: 'pending' });

      // 3) Cancelled-but-paid order — must be included.
      seedEdgeOrder({ billNumber: 'B-DSE-CANCELPAID', amount: 7, method: 'cash', status: 'cancelled' });

      // 4) Voided + void_adjustment items — excluded from items sheet.
      const voided = seedEdgeOrder({
        billNumber: 'B-DSE-VOID',
        amount: 20,
        method: 'cash',
        itemOverrides: [
          { productId: 'prod-dse', qty: 1, subtotal: 20, status: 'ready' },
          { productId: 'prod-dse2', qty: 1, subtotal: 5, status: 'voided' },
          { productId: 'prod-dse2', qty: 1, subtotal: -5, status: 'void_adjustment' },
        ],
      });

      // 5) Item refund: original stays in items (refunded status), cash reversal in Summary.
      const itemRefund = seedEdgeOrder({
        billNumber: 'B-DSE-ITEMREF',
        amount: 15,
        method: 'cash',
        itemOverrides: [{ productId: 'prod-dse2', qty: 1, subtotal: 15, status: 'refunded' }],
      });
      db.prepare(`
        INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
        VALUES (?, ?, 1500, 'cash', 'item', NULL, 'owner-test-001', 'owner-test-001', ?)
      `).run(itemRefund.billId, itemRefund.itemIds[0], edgeAt);

      // 6) Item + order-level discounts and charges.
      seedEdgeOrder({
        billNumber: 'B-DSE-DISC',
        amount: 30,
        method: 'card',
        discountAmount: 5,
        serviceCharge: 2,
        packagingCharge: 1,
        deliveryCharge: 3,
        itemOverrides: [{ productId: 'prod-dse', qty: 2, subtotal: 35, discountAmount: 5 }],
      });

      // 7) Later-day refund (sale day edgeDate, refund day edgeNext).
      const later = seedEdgeOrder({ billNumber: 'B-DSE-LATER', amount: 40, method: 'cash' });
      db.prepare(`
        INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
        VALUES (?, NULL, 4000, 'cash', 'next-day', NULL, 'owner-test-001', 'owner-test-001', ?)
      `).run(later.billId, edgeNextAt);

      // 8) Custom payment method name with spaces — Summary key must be snake_case.
      const customMethodId = Number(db.prepare(`
        INSERT INTO payment_methods (name, is_active, sort_order, created_at, updated_at)
        VALUES ('Visa Terminal 2', 1, 10, ?, ?)
      `).run(edgeAt, edgeAt).lastInsertRowid);
      db.prepare(`
        INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
        VALUES ('ORD-B-DSE-CUSTOM', 'owner-test-001', 'takeaway', 'completed', 11, 11, ?, ?, ?)
      `).run(edgeAt, edgeAt, edgeAt);
      const customOrderId = Number(db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-B-DSE-CUSTOM'").get().id);
      db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
        VALUES (?, 'prod-dse', 'Latte', 1, 11, 11, 0, 11, 'ready', ?, ?)
      `).run(customOrderId, edgeAt, edgeAt);
      db.prepare(`
        INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
        VALUES ('B-DSE-CUSTOM', ?, 11, 11, 11, 0, 'paid', ?, ?, ?, ?)
      `).run(customOrderId, JSON.stringify([{ method: 'custom', payment_method_id: customMethodId, amount: 11, timestamp: edgeAt }]), edgeAt, edgeAt, edgeAt);

      const summary = await fetchSummary(edgeDate);
      const items = await fetchItems(edgeDate);

      // Exclusions: unpaid bill and its amount never contribute.
      assertEqual(summary.get('gross_collected'), 10 + 15 + 7 + 20 + 15 + 30 + 40 + 11, 'gross excludes unpaid, includes cancelled-paid/split/void-order/charges');
      assertEqual(summary.get('refunds_issued'), 15, 'same-day refunds: item refund 15 only (later-day refund lands on refund day)');
      // Later-day refund belongs to edgeNext, not edgeDate.
      const summaryNext = await fetchSummary(edgeNext);
      assertEqual(summaryNext.get('refunds_issued'), 40, 'later-day refund counted on refund day');
      assertEqual(summaryNext.get('gross_collected'), 0, 'later-day refund day has no new sales');

      assertEqual(summary.get('paid_bill_count'), 8, 'paid_bill_count: split2+cancel+void+itemref+disc+later+custom = 8');
      assertEqual(summary.get('discount_total'), 5 + 5, 'discount_total = order-level 5 + item-level 5');
      assertEqual(summary.get('service_charge_total'), 2, 'service_charge_total');
      assertEqual(summary.get('packaging_charge_total'), 1, 'packaging_charge_total');
      assertEqual(summary.get('delivery_charge_total'), 3, 'delivery_charge_total');

      // Payment totals still reconcile to net_collected; no misleading _count keys.
      const net = Number(summary.get('net_collected'));
      const paymentSum = [...summary.entries()]
        .filter(([k]) => k.startsWith('payment_'))
        .reduce((s, [, v]) => s + Number(v), 0);
      assert(Math.abs(paymentSum - net) < 1e-9, 'Σ payment totals = net_collected');
      assert(![...summary.keys()].some((k) => k.endsWith('_count') && k.startsWith('payment_')), 'no payment_*_count metrics');
      assertEqual(summary.has('payment_visa_terminal_2'), true, 'custom method key is snake_case payment_visa_terminal_2');
      assertEqual(summary.has('payment_Visa Terminal 2'), false, 'raw custom method name not used as key');

      // Items: void/void_adjustment excluded; split allocation not double-counted.
      const latte = items.find((r) => r.product_id === 'prod-dse');
      const mocha = items.find((r) => r.product_id === 'prod-dse2');
      // Latte: split bill1 (10) + cancelled-paid (7) + void order (20) + disc (35 gross − 5 item disc → net 30) + later (40) + custom (11) = 118.
      // Mocha: split bill2 (15) + item-refund original (15) = 30 (voided/void_adjustment rows excluded).
      assert(latte && Math.abs(latte.net_item_sales - 118) < 1e-9, `Latte net excludes void, includes split+cancel+disc+later+custom (got ${latte?.net_item_sales})`);
      assert(mocha && Math.abs(mocha.net_item_sales - 30) < 1e-9, `Mocha net excludes void/void_adjustment, includes refunded original (got ${mocha?.net_item_sales})`);
      const sumNet = items.reduce((s, r) => s + r.net_item_sales, 0);
      assert(Math.abs(sumNet - 118 - 30) < 1e-9, `Σ net_item_sales = Latte+Mocha (got ${sumNet})`);
      assertEqual(items.some((r) => r.product_id === 'prod-dse2' && r.net_item_sales === -5), false, 'void_adjustment row not exported');

      // Business-day cutoff: with 04:00 IST start, a 01:30 IST payment on the next
      // calendar date rolls back onto the previous business day.
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '04:00', CURRENT_TIMESTAMP)").run();
      try {
        const cutoffBase = '2026-09-13';
        const cutoffNext = '2026-09-14';
        seedEdgeOrder({
          billNumber: 'B-DSE-CUTOFF',
          amount: 25,
          method: 'cash',
          paidAt: dbTimestamp(new Date('2026-09-14T01:30:00+05:30')),
        });
        const cutoffSummary = await fetchSummary(cutoffBase);
        assertEqual(cutoffSummary.get('gross_collected'), 25, 'cutoff: 01:30 IST payment belongs to previous business day (04:00 start)');
        const cutoffNextSummary = await fetchSummary(cutoffNext);
        assertEqual(cutoffNextSummary.get('gross_collected'), 0, 'cutoff: next calendar day empty before 04:00');
      } finally {
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '00:00', CURRENT_TIMESTAMP)").run();
      }

      // Timezone: IST boundary — 19:00Z belongs to next IST calendar day.
      // Dates stay clear of the cutoff fixture above so leftover paid_at rows cannot leak in.
      db.prepare("UPDATE settings SET value = 'Asia/Kolkata' WHERE key = 'timezone'").run();
      try {
        const istDay = '2026-09-16';
        const istPrev = '2026-09-15';
        db.prepare(`
          INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
          VALUES ('ORD-B-DSE-IST', 'owner-test-001', 'takeaway', 'completed', 50, 50, ?, ?, ?)
        `).run(edgeAt, edgeAt, edgeAt);
        const istOrderId = Number(db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-B-DSE-IST'").get().id);
        db.prepare(`
          INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
          VALUES (?, 'prod-dse', 'Latte', 1, 50, 50, 0, 50, 'ready', ?, ?)
        `).run(istOrderId, edgeAt, edgeAt);
        // 2026-09-16 00:30 IST = 2026-09-15 19:00 UTC.
        const istPaid = dbTimestamp(new Date('2026-09-15T19:00:00Z'));
        db.prepare(`
          INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
          VALUES ('B-DSE-IST', ?, 50, 50, 50, 0, 'paid', ?, ?, ?, ?)
        `).run(istOrderId, JSON.stringify([{ method: 'cash', amount: 50, timestamp: istPaid }]), istPaid, istPaid, istPaid);
        const istPrevSummary = await fetchSummary(istPrev);
        const istDaySummary = await fetchSummary(istDay);
        assertEqual(istPrevSummary.get('gross_collected'), 0, 'IST: 19:00Z is not on previous IST day');
        assertEqual(istDaySummary.get('gross_collected'), 50, 'IST: 19:00Z belongs to next IST calendar day');
      } finally {
        db.prepare("UPDATE settings SET value = 'Asia/Kolkata' WHERE key = 'timezone'").run();
      }

      // Charge/order-discount identity: gross vs payments still hold after edge fixtures.
      const finalSummary = await fetchSummary(edgeDate);
      const finalNet = Number(finalSummary.get('net_collected'));
      const finalPaymentSum = [...finalSummary.entries()]
        .filter(([k]) => k.startsWith('payment_'))
        .reduce((s, [, v]) => s + Number(v), 0);
      assert(Math.abs(finalPaymentSum - finalNet) < 1e-9, 'final Σ payment totals = net_collected');
    }
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(64));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
