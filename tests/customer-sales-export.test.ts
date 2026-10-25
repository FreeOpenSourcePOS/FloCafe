/**
 * Owner-only customer sales export — GET /api/reports/customer-sales/export.
 *
 * Covers role gating, range validation, one-row-per-item shape with the bill's customer repeated,
 * first-row-only bill_total, exclusion of cancelled items and out-of-range bills, split-bill
 * apportioning, CSV formula neutralization, and XLSX output.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/customer-sales-export.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-sales-export-'));

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
  seedCustomer,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { reportRoutes } = require('../main/routes/reports');
const ExcelJS = require('exceljs');

function dbTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

async function main() {
  console.log('Integration Test: Customer sales export (xlsx + csv)');
  console.log('='.repeat(64));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'cat-cse', 'Export Cat');
  seedProduct(db, 'prod-cse', 'cat-cse', 'Latte', 10);
  seedProduct(db, 'prod-cse2', 'cat-cse', 'Mocha', 15);
  seedCustomer(db, 'cust-cse-1', 'Asha Rao', '9876543210');
  db.prepare(
    "UPDATE customers SET country_code = '+91', email = 'asha@example.com' WHERE id = ?",
  ).run('cust-cse-1');

  const dayOne = '2026-09-10';
  const dayTwo = '2026-09-11';
  const outside = '2026-09-20';
  const at = (date: string) => dbTimestamp(new Date(`${date}T12:00:00Z`));

  function seedBill(opts: {
    billNumber: string;
    date: string;
    customerId?: string;
    items: Array<{ name: string; qty: number; subtotal: number; status?: string }>;
    method?: string;
    splitGroup?: string;
  }): { billId: number; orderItemIds: number[] } {
    const paidAt = at(opts.date);
    const total = opts.items.filter((i) => !i.status).reduce((sum, i) => sum + i.subtotal, 0);
    db.prepare(`
      INSERT INTO orders (order_number, customer_id, user_id, type, status, subtotal, total, created_at, updated_at, completed_at)
      VALUES (?, ?, 'owner-test-001', 'dine_in', 'completed', ?, ?, ?, ?, ?)
    `).run(`ORD-${opts.billNumber}`, opts.customerId ?? null, total, total, paidAt, paidAt, paidAt);
    const orderId = Number(
      db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`ORD-${opts.billNumber}`).id,
    );
    const orderItemIds: number[] = [];
    for (const item of opts.items) {
      const info = db
        .prepare(`
        INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at)
        VALUES (?, 'prod-cse', ?, NULL, ?, ?, ?, 0, ?, ?, ?, ?)
      `)
        .run(
          orderId,
          item.name,
          item.qty,
          item.subtotal / item.qty,
          item.subtotal,
          item.subtotal,
          item.status ?? 'ready',
          paidAt,
          paidAt,
        );
      orderItemIds.push(Number(info.lastInsertRowid));
    }
    const billInfo = db
      .prepare(`
      INSERT INTO bills (bill_number, order_id, customer_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, split_group_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?, ?)
    `)
      .run(
        opts.billNumber,
        orderId,
        opts.customerId ?? null,
        total,
        total,
        total,
        JSON.stringify([{ method: opts.method ?? 'cash', amount: total, timestamp: paidAt }]),
        paidAt,
        opts.splitGroup ?? null,
        paidAt,
        paidAt,
      );
    return { billId: Number(billInfo.lastInsertRowid), orderItemIds };
  }

  seedBill({
    billNumber: 'B-CSE-1',
    date: dayOne,
    customerId: 'cust-cse-1',
    items: [
      { name: 'Latte', qty: 2, subtotal: 20 },
      { name: 'Mocha', qty: 1, subtotal: 15 },
      { name: 'Cancelled Tea', qty: 1, subtotal: 5, status: 'cancelled' },
    ],
    method: 'cash',
  });
  seedBill({
    billNumber: 'B-CSE-2',
    date: dayTwo,
    items: [{ name: '=HYPERLINK("x")', qty: 1, subtotal: 8 }],
    method: 'card',
  });
  seedBill({
    billNumber: 'B-CSE-OUT',
    date: outside,
    items: [{ name: 'Latte', qty: 1, subtotal: 10 }],
  });
  const split = seedBill({
    billNumber: 'B-CSE-SPLIT-A',
    date: dayTwo,
    customerId: 'cust-cse-1',
    items: [{ name: 'Shared Pizza', qty: 4, subtotal: 40 }],
    splitGroup: 'grp-cse',
  });
  db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)').run(
    split.billId,
    split.orderItemIds[0],
  );

  const app = createApp({ '/api/reports': reportRoutes });
  const { baseUrl, server } = await startServer(app);
  const url = (query: string) => `${baseUrl}/api/reports/customer-sales/export?${query}`;

  try {
    console.log('\n─── Role gating ───');
    const forbidden = await fetch(url(`start_date=${dayOne}&format=csv`), {
      headers: { ...manager.authHeader },
    });
    assertEqualOrThrow(forbidden.status, 403, 'manager forbidden (403)');
    const noAuth = await fetch(url(`start_date=${dayOne}&format=csv`));
    assertEqualOrThrow(noAuth.status, 401, 'unauthenticated rejected (401)');

    console.log('\n─── Validation ───');
    const badFormat = await fetch(url(`start_date=${dayOne}&format=pdf`), { headers: authHeader });
    assertEqualOrThrow(badFormat.status, 400, 'invalid format → 400');
    const reversed = await fetch(url(`start_date=${dayTwo}&end_date=${dayOne}&format=csv`), {
      headers: authHeader,
    });
    assertEqualOrThrow(reversed.status, 400, 'start after end → 400');
    const tooLong = await fetch(url('start_date=2024-01-01&end_date=2026-01-01&format=csv'), {
      headers: authHeader,
    });
    assertEqualOrThrow(tooLong.status, 400, 'range over 366 days → 400');

    console.log('\n─── CSV: single day ───');
    const dayRes = await fetch(url(`start_date=${dayOne}&format=csv`), { headers: authHeader });
    assertEqualOrThrow(dayRes.status, 200, 'csv → 200');
    assertIncludesOrThrow(
      dayRes.headers.get('content-disposition') || '',
      `customer-sales-${dayOne}.csv`,
      'single-day filename',
    );
    const dayRows = parseCsv(await dayRes.text());
    assertEqualOrThrow(dayRows.length, 2, 'two item rows; cancelled item excluded');
    assertEqualOrThrow(dayRows[0].customer_name, 'Asha Rao', 'customer name on row 1');
    assertEqualOrThrow(dayRows[1].customer_name, 'Asha Rao', 'customer name repeated on row 2');
    assertEqualOrThrow(dayRows[0].customer_phone, '9876543210', 'customer phone');
    assertEqualOrThrow(dayRows[0].customer_country_code, '91', 'country code without plus');
    assertEqualOrThrow(dayRows[0].customer_email, 'asha@example.com', 'customer email');
    assertEqualOrThrow(dayRows[0].product_name, 'Latte', 'first item');
    assertEqualOrThrow(Number(dayRows[0].quantity), 2, 'quantity');
    assertEqualOrThrow(Number(dayRows[0].net_item_sales), 20, 'net_item_sales');
    assertEqualOrThrow(dayRows[0].business_date, dayOne, 'business_date');
    assertEqualOrThrow(dayRows[0].payment_methods, 'cash', 'payment method names');
    assertEqualOrThrow(Number(dayRows[0].bill_total), 35, 'bill_total on first row');
    assertEqualOrThrow(dayRows[1].bill_total, '', 'bill_total blank on later rows');

    console.log('\n─── CSV: range ───');
    const rangeRes = await fetch(url(`start_date=${dayOne}&end_date=${dayTwo}&format=csv`), {
      headers: authHeader,
    });
    assertIncludesOrThrow(
      rangeRes.headers.get('content-disposition') || '',
      `customer-sales-${dayOne}_to_${dayTwo}.csv`,
      'range filename',
    );
    const rangeRows = parseCsv(await rangeRes.text());
    const names = rangeRows.map((r) => r.product_name);
    assertEqualOrThrow(rangeRows.length, 4, 'rows from both days, none from outside range');
    assertOrThrow(!names.includes('Cancelled Tea'), 'cancelled item absent');
    const walkIn = rangeRows.find((r) => r.bill_number === 'B-CSE-2')!;
    assertEqualOrThrow(walkIn.customer_name, '', 'walk-in bill has blank customer');
    assertEqualOrThrow(walkIn.payment_methods, 'card', 'card payment name');
    assertEqualOrThrow(walkIn.product_name, `'=HYPERLINK("x")`, 'formula cell neutralized');
    const splitRow = rangeRows.find((r) => r.bill_number === 'B-CSE-SPLIT-A')!;
    assertEqualOrThrow(Number(splitRow.quantity), 1, 'split bill quantity from bill_items');
    assertEqualOrThrow(Number(splitRow.net_item_sales), 10, 'split bill apportioned sales');

    console.log('\n─── XLSX ───');
    const xlsxRes = await fetch(url(`start_date=${dayOne}&end_date=${dayTwo}&format=xlsx`), {
      headers: authHeader,
    });
    assertEqualOrThrow(xlsxRes.status, 200, 'xlsx → 200');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await xlsxRes.arrayBuffer()));
    const sheet = workbook.getWorksheet('Customer sales')!;
    assertOrThrow(Boolean(sheet), 'Customer sales sheet exists');
    assertEqualOrThrow(sheet.rowCount, 5, 'header + 4 item rows');
    assertEqualOrThrow(String(sheet.getRow(1).getCell(6).value), 'customer_name', 'header cell');
    assertEqualOrThrow(sheet.getRow(2).getCell(6).value, 'Asha Rao', 'customer name cell');
    assertEqualOrThrow(sheet.getRow(2).getCell(12).value, 2, 'quantity is numeric');

    console.log('\n─── Empty range ───');
    const emptyRes = await fetch(url('start_date=2026-01-01&format=csv'), { headers: authHeader });
    const emptyText = (await emptyRes.text()).trim();
    assertEqualOrThrow(emptyText.split('\n').length, 1, 'empty range returns header only');
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
