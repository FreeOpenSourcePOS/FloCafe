/**
 * Test: Sequence Number Generation
 *
 * Tests the order/bill number sequence logic (getNextSequence).
 * Catches the bug where `sequences` table had `name TEXT PRIMARY KEY`
 * instead of `PRIMARY KEY (name, date)`, causing "Failed to generate
 * sequence" errors on every new order.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sequence-generation.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-seq-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  getResults,
  closeDatabase,
  assert,
  assertEqual,
} = require('./helpers/test-setup');

const { generateOrderNumber, generateBillNumber, dateStampInTimezone } = require('../main/db');

async function main() {
  console.log('Test: Sequence Number Generation');
  console.log('='.repeat(50));

  const db = initTestDb();

  try {
    // ── Test 1: sequences table has composite primary key ──────────────
    console.log('\n1. Sequences table has composite primary key (name, date)');
    const tableInfo = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sequences'")
      .get();
    const ddl = tableInfo?.sql?.replace(/\s+/g, ' ').trim() || '';
    assert(ddl.includes('PRIMARY KEY (name, date)'), 'Table has PRIMARY KEY (name, date)');

    // ── Test 2: First order number is ORD-<date>-0001 ─────────────────
    console.log('\n2. First order number is ORD-<date>-0001');
    // generateOrderNumber() dates its bucket in the store timezone
    // (default Asia/Kolkata), while generateBillNumber() below still
    // uses raw UTC -- these two are NOT always the same calendar day
    // (Kolkata is UTC+5:30), so each needs its own expected date.
    const orderToday = dateStampInTimezone('Asia/Kolkata');
    const first = generateOrderNumber();
    assertEqual(first, `ORD-${orderToday}-0001`, 'First order number matches');

    // ── Test 3: Second order number is ORD-<date>-0002 ────────────────
    console.log('\n3. Second order number is ORD-<date>-0002');
    const second = generateOrderNumber();
    assertEqual(second, `ORD-${orderToday}-0002`, 'Second order number matches');

    // ── Test 4: Third order number is ORD-<date>-0003 ────────────────
    console.log('\n4. Third order number is ORD-<date>-0003');
    const third = generateOrderNumber();
    assertEqual(third, `ORD-${orderToday}-0003`, 'Third order number matches');

    // ── Test 5: Order numbers are sequential ──────────────────────────
    console.log('\n5. Order numbers are sequential');
    assert(first < second, 'First < Second');
    assert(second < third, 'Second < Third');

    // ── Test 6: Bill numbers are sequential and separate ──────────────
    console.log('\n6. Bill numbers are sequential and separate from orders');
    const billFirst = generateBillNumber();
    const billSecond = generateBillNumber();
    assertEqual(billFirst, `INV-${orderToday}-0001`, 'First bill number matches');
    assertEqual(billSecond, `INV-${orderToday}-0002`, 'Second bill number matches');
    assert(billFirst < billSecond, 'Bill numbers are sequential');

    // ── Test 7: Bill prefix differs from order prefix ─────────────────
    console.log('\n7. Bill prefix differs from order prefix');
    assert(billFirst.startsWith('INV-'), 'Bill starts with INV');
    assert(first.startsWith('ORD-'), 'Order starts with ORD');

    // ── Test 8: Many sequences don't fail ─────────────────────────────
    console.log('\n8. Generating 50 order numbers without failure');
    const generated = new Set<string>();
    for (let i = 0; i < 50; i++) {
      generated.add(generateOrderNumber());
    }
    assertEqual(generated.size, 50, '50 unique order numbers generated');

    // ── Test 9: Sequences table has correct row count ─────────────────
    console.log('\n9. Sequences table has rows for orders and bills');
    const seqRows = db.prepare('SELECT name, date, current_value FROM sequences').all() as any[];
    const orderRow = seqRows.find((r: any) => r.name === 'orders');
    const billRow = seqRows.find((r: any) => r.name === 'bills');
    assert(orderRow !== undefined, 'Orders sequence row exists');
    assert(billRow !== undefined, 'Bills sequence row exists');
    assertEqual(orderRow?.date, orderToday, 'Orders row has today date');
    assertEqual(billRow?.date, orderToday, 'Bills row has today date');

    // ── Test 10: Invoice numbers can reset monthly ────────────────────
    console.log('\n10. Bill numbers can reset monthly');
    db.prepare(
      "UPDATE settings SET value = 'monthly' WHERE key = 'invoice_number_reset_period'",
    ).run();
    db.prepare('DELETE FROM sequences WHERE name = ?').run('bills');
    const monthly = generateBillNumber();
    assertEqual(
      monthly,
      `INV-${orderToday.slice(0, 6)}-0001`,
      'Monthly bill number uses YYYYMM bucket',
    );
    const monthlyRow = db.prepare("SELECT date FROM sequences WHERE name = 'bills'").get() as any;
    assertEqual(monthlyRow?.date, orderToday.slice(0, 6), 'Monthly sequence bucket is YYYYMM');

    // ── Test 11: Invoice numbers can reset by financial year ───────────
    console.log('\n11. Bill numbers can reset by financial year');
    db.prepare(
      "UPDATE settings SET value = 'financial_year' WHERE key = 'invoice_number_reset_period'",
    ).run();
    db.prepare(
      "UPDATE settings SET value = '4' WHERE key = 'invoice_financial_year_start_month'",
    ).run();
    db.prepare(
      "UPDATE settings SET value = '1' WHERE key = 'invoice_financial_year_start_day'",
    ).run();
    db.prepare('DELETE FROM sequences WHERE name = ?').run('bills');
    const parts = orderToday.match(/^(\d{4})(\d{2})(\d{2})$/);
    const year = Number(parts?.[1]);
    const month = Number(parts?.[2]);
    const day = Number(parts?.[3]);
    const fyStart = month > 4 || (month === 4 && day >= 1) ? year : year - 1;
    const fySegment = `FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
    const financialYear = generateBillNumber();
    assertEqual(
      financialYear,
      `INV-${fySegment}-0001`,
      'Financial-year bill number uses FY segment',
    );

    // ── Test 12: Invoice numbers can run without resets or period text ─
    console.log('\n12. Bill numbers can run without resets or period text');
    db.prepare(
      "UPDATE settings SET value = 'never' WHERE key = 'invoice_number_reset_period'",
    ).run();
    db.prepare(
      "UPDATE settings SET value = 'false' WHERE key = 'invoice_number_include_period'",
    ).run();
    db.prepare('DELETE FROM sequences WHERE name = ?').run('bills');
    const noReset = generateBillNumber();
    assertEqual(noReset, 'INV-0001', 'No-reset bill number omits period text when configured');
    const noResetRow = db.prepare("SELECT date FROM sequences WHERE name = 'bills'").get() as any;
    assertEqual(noResetRow?.date, 'ALL', 'No-reset sequence bucket is ALL');

    // ── Test 13: A pre-existing prefix saved with a trailing dash is ──
    // ── sanitized so it doesn't double up with the auto separator ─────
    console.log('\n13. Bill number sanitizes a pre-existing "FAC-" prefix (no double dash)');
    db.prepare(
      "UPDATE settings SET value = 'daily' WHERE key = 'invoice_number_reset_period'",
    ).run();
    db.prepare(
      "UPDATE settings SET value = 'true' WHERE key = 'invoice_number_include_period'",
    ).run();
    db.prepare("UPDATE settings SET value = 'FAC-' WHERE key = 'invoice_number_prefix'").run();
    db.prepare('DELETE FROM sequences WHERE name = ?').run('bills');
    const facDash = generateBillNumber();
    assertEqual(
      facDash,
      `FAC-${orderToday}-0001`,
      'Trailing dash in stored prefix is stripped, not doubled',
    );

    // ── Test 14: Daily reset keeps the date even when it is toggled off ─
    console.log(
      '\n14. Daily-reset numbers stay unique across a day rollover without prefix or date',
    );
    const setSetting = (key: string, value: string) =>
      db
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value);
    setSetting('invoice_number_prefix', '');
    setSetting('invoice_number_include_period', 'false');
    setSetting('invoice_number_reset_period', 'daily');
    setSetting('order_number_prefix', '');
    setSetting('order_number_include_date', 'false');
    setSetting('order_number_reset_daily', 'true');
    db.prepare("DELETE FROM sequences WHERE name IN ('bills', 'orders')").run();

    const RealDate = Date;
    const dayOne = generateBillNumber();
    const orderDayOne = generateOrderNumber();
    const shifted = RealDate.now() + 24 * 60 * 60 * 1000;
    (globalThis as any).Date = class extends RealDate {
      constructor(...args: any[]) {
        super(...(args.length ? (args as [any]) : [shifted]));
      }
      static now() {
        return shifted;
      }
    };
    let dayTwo: string;
    let orderDayTwo: string;
    try {
      dayTwo = generateBillNumber();
      orderDayTwo = generateOrderNumber();
    } finally {
      (globalThis as any).Date = RealDate;
    }
    assertEqual(dayOne, `${orderToday}-0001`, 'Day one bill number carries the date');
    assert(dayTwo !== dayOne, 'Day two bill number differs from day one');
    assert(/^\d{8}-0001$/.test(dayTwo), 'Day two bill number restarts at 0001 under its own date');
    assert(orderDayTwo !== orderDayOne, 'Day two order number differs from day one');
    assert(
      /^\d{8}-0001$/.test(orderDayTwo),
      'Day two order number restarts at 0001 under its own date',
    );

    // ── Test 15: Mid-day setting switches and reused numbers never collide ─
    console.log('\n15. Already-issued numbers lift the counter instead of failing the sale');
    const insertOrder = db.prepare('INSERT INTO orders (order_number) VALUES (?)');
    const anchorOrderId = Number(insertOrder.run('ANCHOR').lastInsertRowid);
    const insertBill = db.prepare(
      'INSERT INTO bills (bill_number, order_id, subtotal, total) VALUES (?, ?, 0, 0)',
    );
    const issueBill = (n: string) => insertBill.run(n, anchorOrderId);

    // Daily series switched to a lifetime counter on the same day.
    setSetting('invoice_number_prefix', 'INV');
    setSetting('invoice_number_include_period', 'true');
    setSetting('invoice_number_reset_period', 'daily');
    db.prepare("DELETE FROM sequences WHERE name = 'bills'").run();
    db.prepare('DELETE FROM bills').run();
    const issuedToday = [generateBillNumber(), generateBillNumber(), generateBillNumber()];
    for (const n of issuedToday) issueBill(n);
    setSetting('invoice_number_reset_period', 'never');
    const afterSwitch = generateBillNumber();
    assertEqual(
      afterSwitch,
      `INV-${orderToday}-0004`,
      'Same-day switch to a lifetime counter continues after issued numbers',
    );
    issueBill(afterSwitch);

    // Empty prefix and no period (legacy daily numbers 0001..0012) moved to a lifetime counter.
    setSetting('invoice_number_prefix', '');
    setSetting('invoice_number_include_period', 'false');
    db.prepare('DELETE FROM bills').run();
    for (let i = 1; i <= 12; i++) issueBill(String(i).padStart(4, '0'));
    db.prepare("DELETE FROM sequences WHERE name = 'bills'").run();
    assertEqual(generateBillNumber(), '0013', 'Lifetime counter resumes after legacy bare numbers');

    // A stale or missing counter on the same day never reissues a number.
    setSetting('invoice_number_prefix', 'INV');
    setSetting('invoice_number_include_period', 'true');
    setSetting('invoice_number_reset_period', 'daily');
    db.prepare('DELETE FROM bills').run();
    issueBill(`INV-${orderToday}-0001`);
    issueBill(`INV-${orderToday}-0002`);
    db.prepare("DELETE FROM sequences WHERE name = 'bills'").run();
    assertEqual(
      generateBillNumber(),
      `INV-${orderToday}-0003`,
      'Missing counter row skips numbers already issued today',
    );

    // Order numbers: daily series switched to a lifetime counter on the same day.
    setSetting('order_number_prefix', 'ORD');
    setSetting('order_number_include_date', 'true');
    setSetting('order_number_reset_daily', 'true');
    db.prepare("DELETE FROM sequences WHERE name = 'orders'").run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM orders').run();
    for (let i = 0; i < 3; i++) insertOrder.run(generateOrderNumber());
    setSetting('order_number_reset_daily', 'false');
    assertEqual(
      generateOrderNumber(),
      `ORD-${orderToday}-0004`,
      'Order counter continues after issued numbers',
    );

    // ── Summary ───────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(50));
    const results = getResults();
    console.log(`Results: ${results.passed}/${results.total} passed, ${results.failed} failed`);
    process.exit(results.failed > 0 ? 1 : 0);
  } catch (error: any) {
    console.error(`\n✗ Test crashed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    closeDatabase();
  }
}

main();
