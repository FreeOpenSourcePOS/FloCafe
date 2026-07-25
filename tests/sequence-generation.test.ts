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
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, getResults, closeDatabase,
  assert, assertEqual,
} = require('./helpers/test-setup');

const { generateOrderNumber, generateBillNumber, dateStampInTimezone } = require('../main/db');

async function main() {
  console.log('Test: Sequence Number Generation');
  console.log('='.repeat(50));

  const db = initTestDb();

  try {
    // ── Test 1: sequences table has composite primary key ──────────────
    console.log('\n1. Sequences table has composite primary key (name, date)');
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sequences'").get();
    const ddl = tableInfo?.sql?.replace(/\s+/g, ' ').trim() || '';
    assert(ddl.includes('PRIMARY KEY (name, date)'), 'Table has PRIMARY KEY (name, date)');

    // ── Test 2: First order number is ORD-<date>-0001 ─────────────────
    console.log('\n2. First order number is ORD-<date>-0001');
    // generateOrderNumber() dates its bucket in the store timezone
    // (default Asia/Kolkata), while generateBillNumber() below still
    // uses raw UTC -- these two are NOT always the same calendar day
    // (Kolkata is UTC+5:30), so each needs its own expected date.
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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
    assertEqual(billFirst, `INV-${today}-0001`, 'First bill number matches');
    assertEqual(billSecond, `INV-${today}-0002`, 'Second bill number matches');
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
    assertEqual(billRow?.date, today, 'Bills row has today date');

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
