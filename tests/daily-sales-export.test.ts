/**
 * Owner-only daily sales export — GET /api/reports/daily-sales/export.
 *
 * Covers:
 *  - Role gating: owner OK, manager/cashier 403.
 *  - Validation: bad format → 400; csv without part → 400.
 *  - XLSX: Summary + Items + Payments sheets, Content-Disposition filename.
 *  - CSV: separate summary/items/payments files; formula-neutralized cells.
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

  function seedPaidBill(
    billNumber: string,
    amount: number,
    method: string,
    items: Array<{ productId: string; qty: number; subtotal: number }>,
    transactionId?: string,
  ) {
    db.prepare(`
      INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES (?, 'owner-test-001', 'takeaway', 'completed', ?, ?, ?, ?, ?)
    `).run(`ORD-${billNumber}`, amount, amount, paidAt, paidAt, paidAt);
    const orderId = Number(
      db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-${billNumber}`).id,
    );
    for (const item of items) {
      db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 'ready', ?, ?)
      `).run(
        orderId,
        item.productId,
        item.productId === 'prod-dse' ? 'Latte' : 'Mocha',
        item.qty,
        item.subtotal / item.qty,
        item.subtotal,
        item.subtotal,
        paidAt,
        paidAt,
      );
    }
    db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)
    `).run(
      billNumber,
      orderId,
      amount,
      amount,
      amount,
      JSON.stringify([
        {
          method,
          amount,
          timestamp: paidAt,
          ...(transactionId ? { transaction_id: transactionId } : {}),
        },
      ]),
      paidAt,
      paidAt,
      paidAt,
    );
    return orderId;
  }

  seedPaidBill('B-DSE-1', 25, 'cash', [
    { productId: 'prod-dse', qty: 1, subtotal: 10 },
    { productId: 'prod-dse2', qty: 1, subtotal: 15 },
  ]);
  seedPaidBill('B-DSE-2', 10, 'card', [{ productId: 'prod-dse', qty: 1, subtotal: 10 }], '000123');

  // Same-day refund (cash) against B-DSE-1.
  const bill1 = db.prepare("SELECT id FROM bills WHERE bill_number = 'B-DSE-1'").get() as {
    id: number;
  };
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
      const noAuth = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=xlsx`,
      );
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
      const csvBadPart = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=csv&part=unknown`,
        { headers: authHeader },
      );
      assertEqual(csvBadPart.status, 400, 'csv with invalid part → 400');

      const mixedArgs = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&from=2026-09-01&to=2026-09-10&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(mixedArgs.status, 400, 'date combined with from/to → 400');
      const mixedBody = await mixedArgs.json();
      assertIncludes(String(mixedBody.error || ''), 'Specify either', 'mixed args error message');

      const fromOnly = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?from=2026-09-01&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(fromOnly.status, 400, 'from without to → 400');

      const toOnly = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?to=2026-09-10&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(toOnly.status, 400, 'to without from → 400');

      const badCalendarDate = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=2026-02-30&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(badCalendarDate.status, 400, 'impossible calendar date → 400');

      const badRangeDate = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?from=not-a-date&to=2026-09-10&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(badRangeDate.status, 400, 'invalid from date format → 400');

      const reversedRange = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?from=2026-09-10&to=2026-09-09&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(reversedRange.status, 400, 'reversed range (to < from) → 400');
      const reversedBody = await reversedRange.json();
      assertIncludes(
        String(reversedBody.error || ''),
        'on or after',
        'reversed range error message',
      );

      const oversizedRange = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?from=2026-01-01&to=2026-04-04&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(oversizedRange.status, 400, 'range > 93 days (94 days) → 400');
      const oversizedBody = await oversizedRange.json();
      assertIncludes(
        String(oversizedBody.error || ''),
        '93',
        'oversized range mentions 93-day cap',
      );

      const maxAllowedRange = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?from=2026-01-01&to=2026-04-03&format=csv&part=summary`,
        { headers: authHeader },
      );
      assertEqual(maxAllowedRange.status, 200, 'range == 93 days → 200');
      const maxAllowedCsv = await maxAllowedRange.text();
      assertIncludes(maxAllowedCsv, 'day_count,93', '93-day range summary has day_count=93');
    }

    console.log('\n─── XLSX export ───');
    {
      const res = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=xlsx`,
        { headers: authHeader },
      );
      assertEqual(res.status, 200, 'xlsx → 200');
      const disposition = res.headers.get('content-disposition') || '';
      assertIncludes(
        disposition,
        `daily-sales-${businessDate}.xlsx`,
        'Content-Disposition filename',
      );
      const buf = Buffer.from(await res.arrayBuffer());
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buf);
      assertEqual(
        workbook.worksheets.length,
        5,
        'xlsx has Summary + Daily + Taxes + Items + Payments',
      );
      assertEqual(workbook.worksheets[0].name, 'Summary', 'sheet 0 is Summary');
      assertEqual(workbook.worksheets[1].name, 'Daily', 'sheet 1 is Daily');
      assertEqual(workbook.worksheets[2].name, 'Taxes', 'sheet 2 is Taxes');
      assertEqual(workbook.worksheets[3].name, 'Items', 'sheet 3 is Items');
      assertEqual(workbook.worksheets[4].name, 'Payments', 'sheet 4 is Payments');

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

      const paymentsSheet = workbook.getWorksheet('Payments')!;
      const paymentRows: Array<{
        bill: string;
        order: string;
        time: string;
        method: string;
        amount: number;
        transactionId: string;
      }> = [];
      paymentsSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        paymentRows.push({
          bill: String(row.getCell(1).value),
          order: String(row.getCell(2).value),
          time: String(row.getCell(3).value),
          method: String(row.getCell(4).value),
          amount: Number(row.getCell(5).value),
          transactionId: String(row.getCell(6).value ?? ''),
        });
      });
      assertEqual(paymentRows.length, 2, 'Payments has one row per ledger line');
      const cardRow = paymentRows.find((r) => r.method === 'card');
      assertEqual(cardRow?.bill, 'B-DSE-2', 'card payment row carries bill number');
      assertEqual(cardRow?.order, 'ORD-B-DSE-2', 'card payment row carries order number');
      assertEqual(
        cardRow?.transactionId,
        '000123',
        'card terminal transaction id keeps leading zeros',
      );
      assertEqual(
        cardRow?.time,
        `${businessDate} 17:30:00`,
        'payment time is store-local (Asia/Kolkata)',
      );
      assertEqual(
        paymentRows.reduce((s, r) => s + r.amount, 0),
        35,
        'Σ payment line amounts = gross_collected',
      );
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

      const paymentsRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=csv&part=payments`,
        { headers: authHeader },
      );
      assertEqual(paymentsRes.status, 200, 'csv payments → 200');
      assertIncludes(
        paymentsRes.headers.get('content-disposition') || '',
        `daily-sales-${businessDate}-payments.csv`,
        'payments Content-Disposition filename',
      );
      const paymentsCsv = await paymentsRes.text();
      assertIncludes(
        paymentsCsv,
        'bill_number,order_number,payment_time,method,amount,transaction_id',
        'payments CSV header',
      );
      assertIncludes(
        paymentsCsv,
        `B-DSE-2,ORD-B-DSE-2,${businessDate} 17:30:00,card,10,000123`,
        'payments CSV card row with transaction id',
      );
    }

    console.log('\n─── Formula neutralization in CSV ───');
    {
      // Inject a formula-leading product name on a third paid bill.
      seedPaidBill('B-DSE-3', 5, 'cash', [{ productId: 'prod-dse', qty: 1, subtotal: 5 }]);
      db.prepare(`
        UPDATE order_items SET product_name = ?
        WHERE order_id = (SELECT id FROM orders WHERE order_number = 'ORD-B-DSE-3')
      `).run('=HYPERLINK("https://evil.example","x")');
      const itemsRes = await fetch(
        `${baseUrl}/api/reports/daily-sales/export?date=${businessDate}&format=csv&part=items`,
        { headers: authHeader },
      );
      const itemsCsv = await itemsRes.text();
      assertIncludes(
        itemsCsv,
        "'=HYPERLINK",
        'formula-leading name neutralized with leading quote',
      );
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
      assertEqual(
        workbook.getWorksheet('Payments')!.rowCount,
        1,
        'empty day Payments has header only',
      );
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
          edgeAt,
          edgeAt,
          paid || edgeAt,
        );
        const orderId = Number(
          db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-${opts.billNumber}`)
            .id,
        );
        const items = opts.itemOverrides || [
          { productId: 'prod-dse', qty: 1, subtotal: opts.amount },
        ];
        const itemIds: number[] = [];
        for (const item of items) {
          const name = item.productId === 'prod-dse' ? 'Latte' : 'Mocha';
          const discount = item.discountAmount || 0;
          const net = item.subtotal - discount;
          const tax = item.taxAmount || 0;
          const res = db
            .prepare(`
            INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, discount_amount, tax_amount, total, status, created_at, updated_at)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
            .run(
              orderId,
              item.productId,
              name,
              item.qty,
              item.subtotal / item.qty,
              net,
              discount,
              tax,
              net + tax,
              item.status || 'ready',
              edgeAt,
              edgeAt,
            );
          itemIds.push(Number(res.lastInsertRowid));
        }
        const billRes = db
          .prepare(`
          INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, discount_amount, service_charge, packaging_charge, delivery_charge, split_group_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            opts.billNumber,
            orderId,
            opts.amount,
            opts.amount,
            paid ? opts.amount : 0,
            opts.paymentStatus || (paid ? 'paid' : 'unpaid'),
            paid
              ? JSON.stringify([{ method: opts.method, amount: opts.amount, timestamp: paid }])
              : null,
            paid,
            opts.discountAmount || 0,
            opts.serviceCharge || 0,
            opts.packagingCharge || 0,
            opts.deliveryCharge || 0,
            opts.splitGroupId || null,
            edgeAt,
            edgeAt,
          );
        const billId = Number(billRes.lastInsertRowid);
        if (opts.billItems) {
          for (const bi of opts.billItems) {
            db.prepare(
              'INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, ?)',
            ).run(billId, bi.orderItemId, bi.quantity);
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
          map.set(key, raw === '' || Number.isNaN(Number(raw)) ? raw : Number(raw));
        }
        return map;
      }

      async function fetchItems(date: string): Promise<
        Array<{
          product_id: string;
          product_name: string;
          quantity: number;
          gross_item_sales: number;
          item_discounts: number;
          net_item_sales: number;
          tax_amount: number;
        }>
      > {
        const res = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?date=${date}&format=csv&part=items`,
          { headers: authHeader },
        );
        assertEqual(res.status, 200, `items csv ${date} → 200`);
        const text = await res.text();
        return text
          .trim()
          .split('\n')
          .slice(1)
          .filter(Boolean)
          .map((line) => {
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
      const splitBill2 = db
        .prepare(`
        INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, split_group_id, created_at, updated_at)
        VALUES ('B-DSE-SPLIT-2', ?, 15, 15, 15, 0, 'paid', ?, ?, 'split-dse-a', ?, ?)
      `)
        .run(
          split.orderId,
          JSON.stringify([{ method: 'card', amount: 15, timestamp: edgeAt }]),
          edgeAt,
          edgeAt,
          edgeAt,
        );
      const splitBill2Id = Number(splitBill2.lastInsertRowid);
      // bill_items: bill1 gets Latte qty1, bill2 gets Mocha qty1.
      db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)').run(
        split.billId,
        split.itemIds[0],
      );
      db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)').run(
        splitBill2Id,
        split.itemIds[1],
      );

      // 2) Partial (unpaid) bill and open/unpaid order — must be excluded.
      seedEdgeOrder({
        billNumber: 'B-DSE-UNPAID',
        amount: 99,
        method: 'cash',
        paidAt: null,
        paymentStatus: 'unpaid',
        status: 'pending',
      });

      // 3) Cancelled-but-paid order — must be included.
      seedEdgeOrder({
        billNumber: 'B-DSE-CANCELPAID',
        amount: 7,
        method: 'cash',
        status: 'cancelled',
      });

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
      const customMethodId = Number(
        db
          .prepare(`
        INSERT INTO payment_methods (name, is_active, sort_order, created_at, updated_at)
        VALUES ('Visa Terminal 2', 1, 10, ?, ?)
      `)
          .run(edgeAt, edgeAt).lastInsertRowid,
      );
      db.prepare(`
        INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
        VALUES ('ORD-B-DSE-CUSTOM', 'owner-test-001', 'takeaway', 'completed', 11, 11, ?, ?, ?)
      `).run(edgeAt, edgeAt, edgeAt);
      const customOrderId = Number(
        db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-B-DSE-CUSTOM'").get().id,
      );
      db.prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
        VALUES (?, 'prod-dse', 'Latte', 1, 11, 11, 0, 11, 'ready', ?, ?)
      `).run(customOrderId, edgeAt, edgeAt);
      db.prepare(`
        INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
        VALUES ('B-DSE-CUSTOM', ?, 11, 11, 11, 0, 'paid', ?, ?, ?, ?)
      `).run(
        customOrderId,
        JSON.stringify([
          { method: 'custom', payment_method_id: customMethodId, amount: 11, timestamp: edgeAt },
        ]),
        edgeAt,
        edgeAt,
        edgeAt,
      );

      const summary = await fetchSummary(edgeDate);
      const items = await fetchItems(edgeDate);

      // Exclusions: unpaid bill and its amount never contribute.
      assertEqual(
        summary.get('gross_collected'),
        10 + 15 + 7 + 20 + 15 + 30 + 40 + 11,
        'gross excludes unpaid, includes cancelled-paid/split/void-order/charges',
      );
      assertEqual(
        summary.get('refunds_issued'),
        15,
        'same-day refunds: item refund 15 only (later-day refund lands on refund day)',
      );
      // Later-day refund belongs to edgeNext, not edgeDate.
      const summaryNext = await fetchSummary(edgeNext);
      assertEqual(summaryNext.get('refunds_issued'), 40, 'later-day refund counted on refund day');
      assertEqual(summaryNext.get('gross_collected'), 0, 'later-day refund day has no new sales');

      assertEqual(
        summary.get('paid_bill_count'),
        8,
        'paid_bill_count: split2+cancel+void+itemref+disc+later+custom = 8',
      );
      assertEqual(
        summary.get('discount_total'),
        5 + 5,
        'discount_total = order-level 5 + item-level 5',
      );
      assertEqual(summary.get('service_charge_total'), 2, 'service_charge_total');
      assertEqual(summary.get('packaging_charge_total'), 1, 'packaging_charge_total');
      assertEqual(summary.get('delivery_charge_total'), 3, 'delivery_charge_total');

      // Payment totals still reconcile to net_collected; no misleading _count keys.
      const net = Number(summary.get('net_collected'));
      const paymentSum = [...summary.entries()]
        .filter(([k]) => k.startsWith('payment_'))
        .reduce((s, [, v]) => s + Number(v), 0);
      assert(Math.abs(paymentSum - net) < 1e-9, 'Σ payment totals = net_collected');
      assert(
        ![...summary.keys()].some((k) => k.endsWith('_count') && k.startsWith('payment_')),
        'no payment_*_count metrics',
      );
      assertEqual(
        summary.has('payment_visa_terminal_2'),
        true,
        'custom method key is snake_case payment_visa_terminal_2',
      );
      assertEqual(
        summary.has('payment_Visa Terminal 2'),
        false,
        'raw custom method name not used as key',
      );

      // Items: void/void_adjustment excluded; split allocation not double-counted.
      const latte = items.find((r) => r.product_id === 'prod-dse');
      const mocha = items.find((r) => r.product_id === 'prod-dse2');
      // Latte: split bill1 (10) + cancelled-paid (7) + void order (20) + disc (35 gross − 5 item disc → net 30) + later (40) + custom (11) = 118.
      // Mocha: split bill2 (15) + item-refund original (15) = 30 (voided/void_adjustment rows excluded).
      assert(
        latte && Math.abs(latte.net_item_sales - 118) < 1e-9,
        `Latte net excludes void, includes split+cancel+disc+later+custom (got ${latte?.net_item_sales})`,
      );
      assert(
        mocha && Math.abs(mocha.net_item_sales - 30) < 1e-9,
        `Mocha net excludes void/void_adjustment, includes refunded original (got ${mocha?.net_item_sales})`,
      );
      const sumNet = items.reduce((s, r) => s + r.net_item_sales, 0);
      assert(Math.abs(sumNet - 118 - 30) < 1e-9, `Σ net_item_sales = Latte+Mocha (got ${sumNet})`);
      assertEqual(
        items.some((r) => r.product_id === 'prod-dse2' && r.net_item_sales === -5),
        false,
        'void_adjustment row not exported',
      );

      // Business-day cutoff: with 04:00 IST start, a 01:30 IST payment on the next
      // calendar date rolls back onto the previous business day.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '04:00', CURRENT_TIMESTAMP)",
      ).run();
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
        assertEqual(
          cutoffSummary.get('gross_collected'),
          25,
          'cutoff: 01:30 IST payment belongs to previous business day (04:00 start)',
        );
        const cutoffNextSummary = await fetchSummary(cutoffNext);
        assertEqual(
          cutoffNextSummary.get('gross_collected'),
          0,
          'cutoff: next calendar day empty before 04:00',
        );
      } finally {
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '00:00', CURRENT_TIMESTAMP)",
        ).run();
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
        const istOrderId = Number(
          db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-B-DSE-IST'").get().id,
        );
        db.prepare(`
          INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
          VALUES (?, 'prod-dse', 'Latte', 1, 50, 50, 0, 50, 'ready', ?, ?)
        `).run(istOrderId, edgeAt, edgeAt);
        // 2026-09-16 00:30 IST = 2026-09-15 19:00 UTC.
        const istPaid = dbTimestamp(new Date('2026-09-15T19:00:00Z'));
        db.prepare(`
          INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
          VALUES ('B-DSE-IST', ?, 50, 50, 50, 0, 'paid', ?, ?, ?, ?)
        `).run(
          istOrderId,
          JSON.stringify([{ method: 'cash', amount: 50, timestamp: istPaid }]),
          istPaid,
          istPaid,
          istPaid,
        );
        const istPrevSummary = await fetchSummary(istPrev);
        const istDaySummary = await fetchSummary(istDay);
        assertEqual(
          istPrevSummary.get('gross_collected'),
          0,
          'IST: 19:00Z is not on previous IST day',
        );
        assertEqual(
          istDaySummary.get('gross_collected'),
          50,
          'IST: 19:00Z belongs to next IST calendar day',
        );
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

      console.log('\n─── Multi-day range equivalence, cutoff & per-tax-rate summary ───');
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '04:00', CURRENT_TIMESTAMP)",
      ).run();
      try {
        const day1 = '2026-10-01';
        const day2 = '2026-10-02';
        const day3 = '2026-10-03';
        const day1At = dbTimestamp(new Date('2026-10-01T10:00:00Z')); // 15:30 IST on 2026-10-01
        // 2026-10-03 01:30 IST = 2026-10-02 20:00 UTC -> with 04:00 cutoff, belongs to business day 2026-10-02!
        const day2CutoffAt = dbTimestamp(new Date('2026-10-02T20:00:00Z'));
        const day3At = dbTimestamp(new Date('2026-10-03T10:00:00Z')); // 15:30 IST on 2026-10-03

        // Day 1 Bill A: Single-component tax (VAT 10% on 100 -> tax 10, total 110), known cost 40 (margin 60%)
        db.prepare(`
          INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, total, created_at, updated_at, completed_at)
          VALUES ('ORD-RNG-1A', 'owner-test-001', 'takeaway', 'completed', 100, 10, 110, ?, ?, ?)
        `).run(day1At, day1At, day1At);
        const ord1A = Number(
          db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-RNG-1A'").get().id,
        );
        db.prepare(`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total,
            tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
          )
          VALUES (?, 'prod-dse', 'Latte', 2, 50, 100, 10, 110, ?, 40, 1, 'ready', ?, ?)
        `).run(
          ord1A,
          JSON.stringify({
            taxable_base: 100,
            components: [{ name: 'VAT', rate: 10, amount: 10 }],
          }),
          day1At,
          day1At,
        );
        db.prepare(`
          INSERT INTO bills (
            bill_number, order_id, subtotal, tax_amount, tax_breakdown, total, paid_amount, balance,
            payment_status, payment_details, paid_at, created_at, updated_at
          )
          VALUES ('B-RNG-1A', ?, 100, 10, ?, 110, 110, 0, 'paid', ?, ?, ?, ?)
        `).run(
          ord1A,
          JSON.stringify([{ name: 'VAT', rate: 10, amount: 10, taxable_base: 100 }]),
          JSON.stringify([
            { method: 'card', amount: 110, timestamp: day1At, transaction_id: 'TX-1A' },
          ]),
          day1At,
          day1At,
          day1At,
        );
        const bill1AId = Number(
          db.prepare("SELECT id FROM bills WHERE bill_number = 'B-RNG-1A'").get().id,
        );

        // Day 1 Bill B: Shared-base multi-component tax (CGST 2.5% = 5 + SGST 2.5% = 5 on base 200 -> tax 10, total 210), known cost 50 (margin 75%)
        db.prepare(`
          INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, total, created_at, updated_at, completed_at)
          VALUES ('ORD-RNG-1B', 'owner-test-001', 'takeaway', 'completed', 200, 10, 210, ?, ?, ?)
        `).run(day1At, day1At, day1At);
        const ord1B = Number(
          db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-RNG-1B'").get().id,
        );
        db.prepare(`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total,
            tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
          )
          VALUES (?, 'prod-dse2', 'Mocha', 4, 50, 200, 10, 210, ?, 50, 1, 'ready', ?, ?)
        `).run(
          ord1B,
          JSON.stringify({
            taxable_base: 200,
            components: [
              { name: 'CGST', rate: 2.5, amount: 5 },
              { name: 'SGST', rate: 2.5, amount: 5 },
            ],
          }),
          day1At,
          day1At,
        );
        db.prepare(`
          INSERT INTO bills (
            bill_number, order_id, subtotal, tax_amount, tax_breakdown, total, paid_amount, balance,
            payment_status, payment_details, paid_at, created_at, updated_at
          )
          VALUES ('B-RNG-1B', ?, 200, 10, ?, 210, 210, 0, 'paid', ?, ?, ?, ?)
        `).run(
          ord1B,
          JSON.stringify([
            { name: 'CGST', rate: 2.5, amount: 5, taxable_base: 200 },
            { name: 'SGST', rate: 2.5, amount: 5, taxable_base: 200 },
          ]),
          JSON.stringify([{ method: 'cash', amount: 210, timestamp: day1At }]),
          day1At,
          day1At,
          day1At,
        );

        // Day 2 Bill C (paid at 01:30 IST on 2026-10-03, attributed to 2026-10-02 by 04:00 cutoff):
        // VAT 10% on 50 -> tax 5, service_charge 4, total 59. Two items: one known cost (Latte 30, cost 24 -> margin 20%), one unknown cost (Mocha 20, known=0).
        // Plus a refund of 10 on Day 2 against Day 1 Bill A.
        db.prepare(`
          INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, service_charge, total, created_at, updated_at, completed_at)
          VALUES ('ORD-RNG-2C', 'owner-test-001', 'takeaway', 'completed', 50, 5, 4, 59, ?, ?, ?)
        `).run(day2CutoffAt, day2CutoffAt, day2CutoffAt);
        const ord2C = Number(
          db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-RNG-2C'").get().id,
        );
        db.prepare(`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total,
            tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
          )
          VALUES (?, 'prod-dse', 'Latte', 1, 30, 30, 3, 33, ?, 24, 1, 'ready', ?, ?)
        `).run(
          ord2C,
          JSON.stringify({
            taxable_base: 30,
            components: [{ name: 'VAT', rate: 10, amount: 3 }],
          }),
          day2CutoffAt,
          day2CutoffAt,
        );
        db.prepare(`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total,
            tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
          )
          VALUES (?, 'prod-dse2', 'Mocha', 1, 20, 20, 2, 22, ?, NULL, 0, 'ready', ?, ?)
        `).run(
          ord2C,
          JSON.stringify({
            taxable_base: 20,
            components: [{ name: 'VAT', rate: 10, amount: 2 }],
          }),
          day2CutoffAt,
          day2CutoffAt,
        );
        db.prepare(`
          INSERT INTO bills (
            bill_number, order_id, subtotal, tax_amount, tax_breakdown, service_charge, total, paid_amount, balance,
            payment_status, payment_details, paid_at, created_at, updated_at
          )
          VALUES ('B-RNG-2C', ?, 50, 5, ?, 4, 59, 59, 0, 'paid', ?, ?, ?, ?)
        `).run(
          ord2C,
          JSON.stringify([{ name: 'VAT', rate: 10, amount: 5, taxable_base: 50 }]),
          JSON.stringify([{ method: 'cash', amount: 59, timestamp: day2CutoffAt }]),
          day2CutoffAt,
          day2CutoffAt,
          day2CutoffAt,
        );
        db.prepare(`
          INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, reason, shift_id, approved_by, created_by, created_at)
          VALUES (?, NULL, 1000, 'card', 'range-refund', NULL, 'owner-test-001', 'owner-test-001', ?)
        `).run(bill1AId, day2CutoffAt);

        // Day 3 Bill D: Historical record with stored tax_amount = 7.5 on item and bill, but NO tax_snapshot / tax_breakdown.
        db.prepare(`
          INSERT INTO orders (order_number, user_id, type, status, subtotal, tax_amount, total, created_at, updated_at, completed_at)
          VALUES ('ORD-RNG-3D', 'owner-test-001', 'takeaway', 'completed', 75, 7.5, 82.5, ?, ?, ?)
        `).run(day3At, day3At, day3At);
        const ord3D = Number(
          db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-RNG-3D'").get().id,
        );
        db.prepare(`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total,
            tax_snapshot, ingredient_cost, ingredient_cost_known, status, created_at, updated_at
          )
          VALUES (?, 'prod-dse', 'Latte', 1, 75, 75, 7.5, 82.5, NULL, 30, 1, 'ready', ?, ?)
        `).run(ord3D, day3At, day3At);
        db.prepare(`
          INSERT INTO bills (
            bill_number, order_id, subtotal, tax_amount, tax_breakdown, total, paid_amount, balance,
            payment_status, payment_details, paid_at, created_at, updated_at
          )
          VALUES ('B-RNG-3D', ?, 75, 7.5, NULL, 82.5, 82.5, 0, 'paid', ?, ?, ?, ?)
        `).run(
          ord3D,
          JSON.stringify([{ method: 'cash', amount: 82.5, timestamp: day3At }]),
          day3At,
          day3At,
          day3At,
        );

        // Mutate current product tax configuration AFTER historical orders were settled.
        // Historical export must ignore current product settings and rely only on stored snapshots.
        db.prepare(
          "UPDATE products SET tax_type = 'exclusive', tax_category_id = 'mutated_99_percent' WHERE id IN ('prod-dse', 'prod-dse2')",
        ).run();

        // Fetch single-day summaries for day1, day2, day3 and range summary for [day1, day3]
        const s1 = await fetchSummary(day1);
        const s2 = await fetchSummary(day2);
        const s3 = await fetchSummary(day3);

        const rangeSummaryRes = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?from=${day1}&to=${day3}&format=csv&part=summary`,
          { headers: authHeader },
        );
        assertEqual(rangeSummaryRes.status, 200, 'range summary csv → 200');
        assertIncludes(
          rangeSummaryRes.headers.get('content-disposition') || '',
          `daily-sales-${day1}_to_${day3}-summary.csv`,
          'range summary CSV filename uses from_to',
        );
        const rangeSummaryText = await rangeSummaryRes.text();
        const sRange = new Map<string, number | string>();
        for (const line of rangeSummaryText.trim().split('\n').slice(1)) {
          const idx = line.indexOf(',');
          if (idx < 0) continue;
          const key = line.slice(0, idx);
          const raw = line.slice(idx + 1);
          sRange.set(key, raw === '' || Number.isNaN(Number(raw)) ? raw : Number(raw));
        }

        assertEqual(sRange.get('from_date'), day1, 'range summary from_date');
        assertEqual(sRange.get('to_date'), day3, 'range summary to_date');
        assertEqual(sRange.get('day_count'), 3, 'range summary day_count = 3');

        // Verify N-day range equals exact sum of N single-day exports across additive metrics
        const additiveKeys = [
          'order_count',
          'paid_bill_count',
          'gross_collected',
          'refunds_issued',
          'net_collected',
          'tax_total',
          'discount_total',
          'service_charge_total',
          'packaging_charge_total',
          'delivery_charge_total',
          'known_cost_net_item_sales',
          'ingredient_cost_total',
          'gross_profit_total',
          'payment_cash',
          'payment_card',
        ];
        for (const key of additiveKeys) {
          const sumSingle =
            Number(s1.get(key) || 0) + Number(s2.get(key) || 0) + Number(s3.get(key) || 0);
          const rangeVal = Number(sRange.get(key) || 0);
          assert(
            Math.abs(rangeVal - sumSingle) < 1e-9,
            `range ${key} (${rangeVal}) == sum of 3 single days (${sumSingle})`,
          );
        }

        // Verify business-day cutoff attribution across range:
        // Day 2 gross_collected = 59 (from 01:30 IST on 2026-10-03), refunds_issued = 10 (from 01:30 IST on 2026-10-03)
        assertEqual(Number(s2.get('gross_collected')), 59, 'cutoff across range: day2 gross = 59');
        assertEqual(Number(s2.get('refunds_issued')), 10, 'cutoff across range: day2 refunds = 10');
        assertEqual(
          Number(s3.get('gross_collected')),
          82.5,
          'cutoff across range: day3 gross = 82.5 (excludes 01:30 IST bill)',
        );

        // Verify period profitability margin and coverage are recomputed from summed underlying amounts, NOT averaged daily percentages:
        // Day 1 known_cost_net_item_sales = 300, cost = 90, profit = 210 (daily margin = 70.00%, status = known)
        // Day 2 known_cost_net_item_sales = 30, cost = 24, profit = 6 (daily margin = 20.00%, status = partial because Mocha had unknown cost)
        // Day 3 known_cost_net_item_sales = 75, cost = 30, profit = 45 (daily margin = 60.00%, status = known)
        // Simple average of daily margins would be (70 + 20 + 60) / 3 = 50.00%.
        // True recomputed period margin = (210 + 6 + 45) / (300 + 30 + 75) * 100 = 261 / 405 * 100 = 64.44%.
        assertEqual(
          Number(sRange.get('gross_margin_percent')),
          64.44,
          'period gross_margin_percent recomputed from summed amounts (64.44%, not averaged 50%)',
        );
        assertEqual(
          sRange.get('cost_coverage_status'),
          'partial',
          'period cost_coverage_status is partial when any item in range has unknown cost',
        );

        // Verify Daily CSV part and Taxes CSV part
        const dailyCsvRes = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?from=${day1}&to=${day3}&format=csv&part=daily`,
          { headers: authHeader },
        );
        assertEqual(dailyCsvRes.status, 200, 'range daily csv → 200');
        const dailyCsvLines = (await dailyCsvRes.text()).trim().split('\n');
        assertEqual(dailyCsvLines.length, 4, 'daily CSV has header + 3 business day rows');
        assertIncludes(
          dailyCsvLines[1],
          `${day1},2,2,320,0,320,20`,
          'daily CSV row 1 matches day1',
        );
        assertIncludes(dailyCsvLines[2], `${day2},1,1,59,10,49,5`, 'daily CSV row 2 matches day2');
        assertIncludes(
          dailyCsvLines[3],
          `${day3},1,1,82.5,0,82.5,7.5`,
          'daily CSV row 3 matches day3',
        );

        const taxesCsvRes = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?from=${day1}&to=${day3}&format=csv&part=taxes`,
          { headers: authHeader },
        );
        assertEqual(taxesCsvRes.status, 200, 'range taxes csv → 200');
        const taxesCsvText = await taxesCsvRes.text();
        const taxesCsvLines = taxesCsvText.trim().split('\n');
        assertEqual(
          taxesCsvLines[0],
          'business_date,tax_name,tax_rate,taxable_base,tax_amount,gross_amount,shared_base,base_additive,incomplete_detail,warning',
          'taxes CSV header',
        );
        // Expected rows (sorted by tax_amount DESC, then tax_name ASC):
        // 1) 2026-10-01 VAT 10% (amount=10, shared_base=false, base_additive=true)
        // 2) 2026-10-01 CGST 2.5% (amount=5, shared_base=true, base_additive=false)
        // 3) 2026-10-01 SGST 2.5% (amount=5, shared_base=true, base_additive=false)
        // 4) 2026-10-02 VAT 10% (amount=5, shared_base=false, base_additive=true)
        // 5) 2026-10-03 Unknown (blank rate/base/gross, tax_amount=7.5, incomplete_detail=true, warning)
        assertEqual(taxesCsvLines.length, 6, 'taxes CSV has header + 5 rows across the 3 days');
        assertIncludes(
          taxesCsvLines[1],
          `${day1},VAT,10,100,10,110,false,true,false,`,
          'day1 VAT row marks shared_base=false, base_additive=true',
        );
        assertIncludes(
          taxesCsvLines[2],
          `${day1},CGST,2.5,200,5,205,true,false,false,`,
          'day1 CGST row marks shared_base=true, base_additive=false',
        );
        assertIncludes(
          taxesCsvLines[3],
          `${day1},SGST,2.5,200,5,205,true,false,false,`,
          'day1 SGST row marks shared_base=true, base_additive=false',
        );
        assertIncludes(
          taxesCsvLines[4],
          `${day2},VAT,10,50,5,55,false,true,false,`,
          'day2 VAT row from cutoff order',
        );
        assertIncludes(
          taxesCsvLines[5],
          `${day3},Unknown,,,7.5,,false,false,true,`,
          'day3 incomplete historical tax row leaves rate/base/gross blank and keeps tax_amount=7.5',
        );

        // Check Summary incomplete-detail flags on day1 (complete) vs range (incomplete due to day3)
        assertEqual(
          String(s1.get('tax_detail_complete')),
          'true',
          'day1 summary tax_detail_complete is true',
        );
        assertEqual(
          String(s1.get('tax_detail_warning')),
          '',
          'day1 summary tax_detail_warning is empty',
        );
        assertEqual(
          String(sRange.get('tax_detail_complete')),
          'false',
          'range summary tax_detail_complete is false when historical breakdown is incomplete',
        );
        assertIncludes(
          String(sRange.get('tax_detail_warning')),
          'lacked rate or taxable base breakdown',
          'range summary includes tax_detail_warning',
        );

        // Verify XLSX sheets & reconciliation on the multi-day range
        const rangeXlsxRes = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?from=${day1}&to=${day3}&format=xlsx`,
          { headers: authHeader },
        );
        assertEqual(rangeXlsxRes.status, 200, 'range xlsx → 200');
        assertIncludes(
          rangeXlsxRes.headers.get('content-disposition') || '',
          `daily-sales-${day1}_to_${day3}.xlsx`,
          'range XLSX filename uses from_to',
        );
        const rangeWb = new ExcelJS.Workbook();
        await rangeWb.xlsx.load(Buffer.from(await rangeXlsxRes.arrayBuffer()));
        const dailySheet = rangeWb.getWorksheet('Daily')!;
        const taxesSheet = rangeWb.getWorksheet('Taxes')!;
        assertEqual(dailySheet.rowCount, 4, 'XLSX Daily sheet has header + 3 rows');
        assertEqual(taxesSheet.rowCount, 6, 'XLSX Taxes sheet has header + 5 rows');

        let sumDailyTax = 0;
        dailySheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;
          sumDailyTax += Number(row.getCell(7).value || 0);
        });
        let sumTaxesSheetTax = 0;
        taxesSheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;
          sumTaxesSheetTax += Number(row.getCell(5).value || 0);
        });
        const summaryTaxTotal = Number(sRange.get('tax_total'));
        assert(
          Math.abs(sumTaxesSheetTax - summaryTaxTotal) < 1e-9,
          `Taxes sheet tax total (${sumTaxesSheetTax}) == Summary tax_total (${summaryTaxTotal})`,
        );
        assert(
          Math.abs(sumDailyTax - summaryTaxTotal) < 1e-9,
          `Daily sheet tax total (${sumDailyTax}) == Summary tax_total (${summaryTaxTotal})`,
        );
        // Verify blank cells on unknown historical tax row in XLSX
        const unknownTaxRow = taxesSheet.getRow(6);
        assertEqual(unknownTaxRow.getCell(2).value, 'Unknown', 'XLSX unknown row tax_name');
        assertEqual(
          unknownTaxRow.getCell(3).value,
          '',
          'XLSX unknown row tax_rate is empty string',
        );
        assertEqual(
          unknownTaxRow.getCell(4).value,
          '',
          'XLSX unknown row taxable_base is empty string',
        );
        assertEqual(
          Number(unknownTaxRow.getCell(5).value),
          7.5,
          'XLSX unknown row tax_amount = 7.5',
        );
        assertEqual(
          unknownTaxRow.getCell(6).value,
          '',
          'XLSX unknown row gross_amount is empty string',
        );
        assertEqual(
          String(unknownTaxRow.getCell(9).value),
          'true',
          'XLSX unknown row incomplete_detail = true',
        );

        // Verify Items and Payments across range equal the sum / concatenation of single-day exports
        const items1 = await fetchItems(day1);
        const items2 = await fetchItems(day2);
        const items3 = await fetchItems(day3);
        const rangeItemsRes = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?from=${day1}&to=${day3}&format=csv&part=items`,
          { headers: authHeader },
        );
        assertEqual(rangeItemsRes.status, 200, 'range items csv → 200');
        const rangeItems = (await rangeItemsRes.text())
          .trim()
          .split('\n')
          .slice(1)
          .filter(Boolean)
          .map((line) => {
            const cols = line.split(',');
            return {
              product_id: cols[0],
              quantity: Number(cols[3]),
              net_item_sales: Number(cols[6]),
              tax_amount: Number(cols[7]),
            };
          });
        for (const prodId of ['prod-dse', 'prod-dse2']) {
          const singleQty = [...items1, ...items2, ...items3]
            .filter((r) => r.product_id === prodId)
            .reduce((s, r) => s + r.quantity, 0);
          const singleNet = [...items1, ...items2, ...items3]
            .filter((r) => r.product_id === prodId)
            .reduce((s, r) => s + r.net_item_sales, 0);
          const singleTax = [...items1, ...items2, ...items3]
            .filter((r) => r.product_id === prodId)
            .reduce((s, r) => s + r.tax_amount, 0);
          const rangeRow = rangeItems.find((r) => r.product_id === prodId);
          assertEqual(
            rangeRow?.quantity,
            singleQty,
            `range item ${prodId} quantity == sum of days`,
          );
          assert(
            rangeRow !== undefined && Math.abs(rangeRow.net_item_sales - singleNet) < 1e-9,
            `range item ${prodId} net_item_sales == sum of days`,
          );
          assert(
            rangeRow !== undefined && Math.abs(rangeRow.tax_amount - singleTax) < 1e-9,
            `range item ${prodId} tax_amount == sum of days`,
          );
        }

        const rangePaymentsRes = await fetch(
          `${baseUrl}/api/reports/daily-sales/export?from=${day1}&to=${day3}&format=csv&part=payments`,
          { headers: authHeader },
        );
        assertEqual(rangePaymentsRes.status, 200, 'range payments csv → 200');
        const rangePaymentLines = (await rangePaymentsRes.text()).trim().split('\n');
        assertEqual(rangePaymentLines.length, 5, 'range payments CSV has header + 4 payment rows');
        assertIncludes(
          rangePaymentLines[1],
          'B-RNG-1A,ORD-RNG-1A,2026-10-01 15:30:00,card,110,TX-1A',
          'range payments CSV preserves card transaction_id',
        );
        assertEqual(
          rangeWb.getWorksheet('Payments')!.rowCount,
          rangePaymentLines.length,
          'XLSX Payments row count matches CSV payments part',
        );
        assertEqual(
          rangeWb.getWorksheet('Items')!.rowCount,
          rangeItems.length + 1,
          'XLSX Items row count matches CSV items part',
        );
      } finally {
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '00:00', CURRENT_TIMESTAMP)",
        ).run();
      }
    }
  } finally {
    server.close();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
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
