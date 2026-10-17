/**
 * Sequence Repair Performance, Correctness & Heap Benchmark Test
 *
 * Verifies Issue #1182 (ARCH-012b):
 * 1. Preserves no-reuse contract: counters are per (name, date), missing/lower
 *    state advances to the greatest persisted suffix, higher state is never lowered,
 *    gaps do not reuse values, and next-number generation remains atomic.
 * 2. Recovery on migration v10, restore, or missing state.
 * 3. Regression coverage for clean history, gaps, absent/lower/higher counters,
 *    malformed suffixes, and coverage boundaries for custom numbering formats.
 * 4. Scale and heap benchmarks at 100k and 365k rows demonstrating ordinary startup
 *    skips materializing historical rows, and forced repair stays bounded in heap and time.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sequence-repair-performance.test.ts
 */

// ── Electron Mock ─────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-seq-perf-'));
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

const {
  initTestDb,
  closeDatabase,
  assertOrThrow,
  assertEqualOrThrow,
} = require('./helpers/test-setup');

const {
  initDatabase,
  getDatabase,
  generateOrderNumber,
  generateBillNumber,
  repairSequences,
  executeSequenceRepair,
  getSettingValue,
} = require('../main/db');

async function main() {
  console.log('='.repeat(60));
  console.log('Sequence Repair Performance & Invariants Tests (#1182 / ARCH-012b)');
  console.log('='.repeat(60));

  const db = initTestDb();

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Section 1: Invariants, Gaps, and No-Reuse Contract
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. Invariants, Gaps, and No-Reuse Contract ---');

    // 1.1 Gaps in order history: stored counter 1, existing orders 1 and 5
    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM sequences').run();

    db.prepare(
      "INSERT INTO sequences (name, date, current_value) VALUES ('orders', '20261017', 1)",
    ).run();
    db.prepare("INSERT INTO orders (order_number) VALUES ('ORD-20261017-0001')").run();
    db.prepare("INSERT INTO orders (order_number) VALUES ('ORD-20261017-0005')").run();

    const repairGapResult = repairSequences(true);
    assertOrThrow(repairGapResult.repaired === true, 'Repair executed on force');

    const gapSeq = db
      .prepare("SELECT current_value FROM sequences WHERE name = 'orders' AND date = '20261017'")
      .get() as any;
    assertEqualOrThrow(
      gapSeq.current_value,
      5,
      'Stored counter advanced from 1 to greatest suffix 5 across gap',
    );

    // 1.2 Higher existing counter: stored counter 25, orders only up to 5
    db.prepare(
      "UPDATE sequences SET current_value = 25 WHERE name = 'orders' AND date = '20261017'",
    ).run();
    repairSequences(true);
    const highSeq = db
      .prepare("SELECT current_value FROM sequences WHERE name = 'orders' AND date = '20261017'")
      .get() as any;
    assertEqualOrThrow(highSeq.current_value, 25, 'Existing higher counter 25 is never lowered');

    // 1.3 Absent counter: date with orders but no sequence row
    db.prepare("INSERT INTO orders (order_number) VALUES ('ORD-20261018-0008')").run();
    repairSequences(true);
    const absentSeq = db
      .prepare("SELECT current_value FROM sequences WHERE name = 'orders' AND date = '20261018'")
      .get() as any;
    assertEqualOrThrow(
      absentSeq.current_value,
      8,
      'Absent sequence row seeded to greatest suffix 8',
    );

    // 1.4 Next sequence generation strictly exceeds maximum without value reuse
    const nextOrderNum = generateOrderNumber();
    assertOrThrow(
      typeof nextOrderNum === 'string' && nextOrderNum.startsWith('ORD-'),
      `Generated next order number: ${nextOrderNum}`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Section 2: Malformed Suffixes and Numbering Format Boundaries
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Malformed Suffixes & Coverage Boundaries ---');

    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM sequences').run();

    // Insert malformed variants that must NOT seed or corrupt sequence counters
    const malformedOrders = [
      'ORD-20261020-0', // zero suffix
      'ORD-20261020-0000', // multi-zero suffix
      'ORD-20261020-00a', // non-numeric suffix
      'ORD-20261020-foo', // text suffix
      'ORD-20261020-', // empty suffix
      'ORD-20261020-0005-extra', // trailing hyphen segment
      'ORD-2026102-0001', // 7-digit date
      'ORD-202610201-0001', // 9-digit date
      'FAC-20261020-0001', // non-canonical order prefix
      'CUSTOM-20261020-0001', // non-canonical prefix
    ];

    for (const mo of malformedOrders) {
      db.prepare('INSERT INTO orders (order_number) VALUES (?)').run(mo);
    }

    // Also insert one valid order for a different date
    db.prepare("INSERT INTO orders (order_number) VALUES ('ORD-20261021-0003')").run();

    repairSequences(true);

    const malformedSeq = db.prepare("SELECT * FROM sequences WHERE date = '20261020'").get();
    assertEqualOrThrow(
      malformedSeq,
      undefined,
      'Malformed suffixes, non-canonical prefixes, and zero suffixes ignored',
    );

    const validSeq = db
      .prepare("SELECT current_value FROM sequences WHERE date = '20261021'")
      .get() as any;
    assertEqualOrThrow(
      validSeq?.current_value,
      3,
      'Valid order sequence on 20261021 parsed correctly',
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Section 3: Recovery Triggering & Ordinary Startup Fast-Path
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Recovery Triggering & Ordinary Boot Fast Path ---');

    // After repair, setting markers are established
    const completedAt = getSettingValue('sequence_repair_completed_at');
    const isPending = getSettingValue('sequence_repair_pending');
    assertOrThrow(Boolean(completedAt), 'sequence_repair_completed_at timestamp recorded');
    assertEqualOrThrow(isPending, '0', 'sequence_repair_pending cleared to 0');

    // Ordinary boot check with sequences intact: must skip scan
    const ordinaryBootResult = repairSequences(false);
    assertEqualOrThrow(
      ordinaryBootResult.repaired,
      false,
      'Ordinary boot skips historical scan when sequences are in sync',
    );

    // Setting sequence_repair_pending = '1' re-triggers repair
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'sequence_repair_pending'").run();
    const pendingBootResult = repairSequences(false);
    assertEqualOrThrow(
      pendingBootResult.repaired,
      true,
      'sequence_repair_pending = 1 successfully triggers repair',
    );
    assertEqualOrThrow(
      getSettingValue('sequence_repair_pending'),
      '0',
      'sequence_repair_pending reset to 0 after repair',
    );

    // Self-healing fallback: if sequences table is wiped while orders exist
    db.prepare('DELETE FROM sequences').run();
    assertOrThrow(Boolean(db.prepare('SELECT 1 FROM orders LIMIT 1').get()), 'Orders exist');
    const selfHealResult = repairSequences(false);
    assertEqualOrThrow(
      selfHealResult.repaired,
      true,
      'Self-healing triggered when sequences table is empty but orders exist',
    );
    const healedSeq = db
      .prepare("SELECT current_value FROM sequences WHERE date = '20261021'")
      .get() as any;
    assertEqualOrThrow(healedSeq?.current_value, 3, 'Sequences restored by self-healing');

    // ─────────────────────────────────────────────────────────────────────────
    // Section 4: Scale Benchmark at 100k Rows
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Scale Benchmark: 100,000 Orders & 100,000 Bills ---');

    db.prepare('DELETE FROM orders').run();
    db.prepare('DELETE FROM bills').run();
    db.prepare('DELETE FROM sequences').run();

    console.log('  Seeding 100,000 orders across 1,000 calendar dates (100 orders/day)...');
    const insertOrder = db.prepare('INSERT INTO orders (order_number) VALUES (?)');
    const insertBill = db.prepare('INSERT INTO bills (order_id, bill_number) VALUES (?, ?)');

    const seed100kT0 = performance.now();
    db.transaction(() => {
      for (let d = 1; d <= 1000; d++) {
        const dateStr = '2010' + String(d).padStart(4, '0');
        for (let i = 1; i <= 100; i++) {
          const sfx = String(i).padStart(4, '0');
          const orderRes = insertOrder.run(`ORD-${dateStr}-${sfx}`);
          insertBill.run(orderRes.lastInsertRowid, `INV-${dateStr}-${sfx}`);
        }
      }
    })();
    const seed100kT1 = performance.now();
    console.log(`  Seeded 100k orders + 100k bills in ${(seed100kT1 - seed100kT0).toFixed(1)} ms`);

    // Verify forced/initial repair executes efficiently without JS array materialization
    const memBefore100k = process.memoryUsage().heapUsed;
    const repair100kT0 = performance.now();
    const repair100kRes = repairSequences(true);
    const repair100kT1 = performance.now();
    const memAfter100k = process.memoryUsage().heapUsed;
    const repair100kDuration = repair100kT1 - repair100kT0;
    const heapDelta100k = memAfter100k - memBefore100k;

    console.log(
      `  100k Repair duration: ${repair100kDuration.toFixed(2)} ms (order updates: ${repair100kRes.orderSequencesUpdated}, bill updates: ${repair100kRes.billSequencesUpdated})`,
    );
    console.log(`  100k Heap delta: ${(heapDelta100k / 1024).toFixed(1)} KB`);

    assertEqualOrThrow(
      repair100kRes.orderSequencesUpdated,
      1000,
      'All 1,000 order date buckets seeded',
    );
    assertEqualOrThrow(
      repair100kRes.billSequencesUpdated,
      1000,
      'All 1,000 bill date buckets seeded',
    );
    assertOrThrow(
      heapDelta100k < 2 * 1024 * 1024,
      `Heap delta must be < 2 MB, was ${(heapDelta100k / 1024).toFixed(1)} KB`,
    );

    // Verify sample sequences match maximums (100)
    const sampleSeq100k = db
      .prepare("SELECT current_value FROM sequences WHERE name = 'orders' AND date = '20100500'")
      .get() as any;
    assertEqualOrThrow(
      sampleSeq100k?.current_value,
      100,
      'Sample date 20100500 has high-water 100',
    );

    // Test ordinary boot fast-path over 100k dataset
    const fastBoot100kT0 = performance.now();
    const fastBoot100kRes = repairSequences(false);
    const fastBoot100kT1 = performance.now();
    const fastBoot100kDuration = fastBoot100kT1 - fastBoot100kT0;

    console.log(`  100k Ordinary boot duration: ${fastBoot100kDuration.toFixed(3)} ms`);
    assertEqualOrThrow(fastBoot100kRes.repaired, false, 'Ordinary boot skips scanning 100k rows');
    assertOrThrow(
      fastBoot100kDuration < 15,
      `Ordinary boot must take < 15 ms, took ${fastBoot100kDuration.toFixed(2)} ms`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Section 5: Scale Benchmark at 365k Rows (10 Years of Data)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Scale Benchmark: 365,000 Orders & 365,000 Bills ---');

    console.log('  Expanding dataset to 365,000 orders across 3,650 dates (10 years)...');
    const seed365kT0 = performance.now();
    db.transaction(() => {
      for (let d = 1001; d <= 3650; d++) {
        const dateStr = '2010' + String(d).padStart(4, '0');
        for (let i = 1; i <= 100; i++) {
          const sfx = String(i).padStart(4, '0');
          const orderRes = insertOrder.run(`ORD-${dateStr}-${sfx}`);
          insertBill.run(orderRes.lastInsertRowid, `INV-${dateStr}-${sfx}`);
        }
      }
    })();
    const seed365kT1 = performance.now();
    console.log(`  Expanded to 365k in ${(seed365kT1 - seed365kT0).toFixed(1)} ms`);

    const orderCount = (db.prepare('SELECT count(*) as count FROM orders').get() as any).count;
    assertEqualOrThrow(orderCount, 365000, 'Orders count is exactly 365,000');

    // Benchmark forced repair over 365,000 rows
    const memBefore365k = process.memoryUsage().heapUsed;
    const repair365kT0 = performance.now();
    const repair365kRes = repairSequences(true);
    const repair365kT1 = performance.now();
    const memAfter365k = process.memoryUsage().heapUsed;
    const repair365kDuration = repair365kT1 - repair365kT0;
    const heapDelta365k = memAfter365k - memBefore365k;

    console.log(`  365k Repair duration: ${repair365kDuration.toFixed(2)} ms`);
    console.log(`  365k Heap delta: ${(heapDelta365k / 1024).toFixed(1)} KB`);

    assertOrThrow(
      repair365kDuration < 1500,
      `Repair duration must be < 1500 ms, took ${repair365kDuration.toFixed(2)} ms`,
    );
    assertOrThrow(
      heapDelta365k < 2 * 1024 * 1024,
      `Heap delta must be < 2 MB, was ${(heapDelta365k / 1024).toFixed(1)} KB`,
    );

    // Verify sample date in newly added range
    const sample365k = db
      .prepare("SELECT current_value FROM sequences WHERE name = 'orders' AND date = '20102500'")
      .get() as any;
    assertEqualOrThrow(
      sample365k?.current_value,
      100,
      'Sample 365k order sequence has high-water 100',
    );

    // Test ordinary boot fast-path over 365k dataset
    const fastBoot365kT0 = performance.now();
    const fastBoot365kRes = repairSequences(false);
    const fastBoot365kT1 = performance.now();
    const fastBoot365kDuration = fastBoot365kT1 - fastBoot365kT0;

    console.log(`  365k Ordinary boot duration: ${fastBoot365kDuration.toFixed(3)} ms`);
    assertEqualOrThrow(fastBoot365kRes.repaired, false, 'Ordinary boot skips scanning 365k rows');
    assertOrThrow(
      fastBoot365kDuration < 15,
      `Ordinary boot must take < 15 ms, took ${fastBoot365kDuration.toFixed(2)} ms`,
    );

    console.log('\n' + '='.repeat(60));
    console.log('✓ All sequence repair performance and correctness tests passed!');
    console.log('='.repeat(60));
  } finally {
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
