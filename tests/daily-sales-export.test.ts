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

  // Two paid bills on a fixed business day (UTC timezone from test defaults).
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
