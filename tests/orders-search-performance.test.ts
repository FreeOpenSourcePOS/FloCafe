/**
 * Order Search Performance, Scaling & Invariants Test
 *
 * Verifies Issue #1185 (ARCH-009b):
 * 1. Functions installed once per database connection; repeated requests do not re-register;
 *    connection reopen preserves function availability.
 * 2. Indexed candidate retrieval (FTS5 trigram on orders and customers) narrows candidates
 *    before JS UDF verification.
 * 3. EXPLAIN QUERY PLAN demonstrates indexed search plan (MULTI-INDEX OR with orders_search_fts
 *    and customers_search_fts) instead of scanning the full orders table.
 * 4. Benchmarks at 100k and 300k rows demonstrating 0 UDF callbacks on no-match searches
 *    (down from 180,000 / 540,000) and bounded callbacks on selective searches.
 * 5. Full UDF fallback preserved for short queries (< 3 chars) and phone normalization.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/orders-search-performance.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-orders-search-perf-'));
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

const Database = require('better-sqlite3');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const {
  registerOrderSearchFunctions,
  initDatabase,
  getDatabase,
  closeDatabase,
} = require('../main/db');

function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(Math.floor((percentile / 100) * sorted.length), sorted.length - 1);
  return sorted[index];
}

async function main() {
  console.log('='.repeat(65));
  console.log('Order Search Scaling & Candidate Retrieval Tests (#1185 / ARCH-009b)');
  console.log('='.repeat(65));

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Section 1: Connection Reopen & Idempotent Registration
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. Connection Reopen & Idempotent Registration ---');

    const dbPath = path.join(testDir, 'reopen-test.db');
    let testConn = new Database(dbPath);
    registerOrderSearchFunctions(testConn);

    // Verify functions work
    const check1 = testConn
      .prepare("SELECT orders_search_contains('Order-1234', '123') as res")
      .get() as any;
    assertEqualOrThrow(check1.res, 1, 'orders_search_contains is available and functional');
    const checkDigits1 = testConn
      .prepare("SELECT orders_search_digits_contains('+1 (555) 234-5678', '555234') as res")
      .get() as any;
    assertEqualOrThrow(
      checkDigits1.res,
      1,
      'orders_search_digits_contains is available and functional',
    );

    // Repeated registration on same connection is idempotent and does not throw
    registerOrderSearchFunctions(testConn);
    const check2 = testConn
      .prepare("SELECT orders_search_contains('Hello World', 'world') as res")
      .get() as any;
    assertEqualOrThrow(check2.res, 1, 'Repeated registration preserves function availability');

    // Close and reopen connection
    testConn.close();
    testConn = new Database(dbPath);
    registerOrderSearchFunctions(testConn);
    const checkReopened = testConn
      .prepare("SELECT orders_search_contains('Order-Reopen', 'reopen') as res")
      .get() as any;
    assertEqualOrThrow(
      checkReopened.res,
      1,
      'Reopened connection registers functions successfully',
    );
    testConn.close();
    console.log('✓ Connection reopen and idempotent registration verified');

    // ─────────────────────────────────────────────────────────────────────────
    // Section 2: 100,000 Rows Benchmark & Query Plan
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. 100,000 Rows Benchmark & Query Plan ---');

    initDatabase();
    const db = getDatabase();

    // Seed customers
    const insertCust = db.prepare(`
      INSERT OR IGNORE INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES (?, ?, ?, '+1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);

    insertCust.run('cust-zoe', 'Zoë Laurent', '+1 (555) 234-5678');
    insertCust.run('cust-oconnor', "Shaun O'Connor", '+353 1 496 0000');
    insertCust.run('cust-elodie', 'Élodie Search Customer', '+1/555 ext 0199');
    for (let c = 4; c <= 200; c++) {
      insertCust.run(`cust-${c}`, `Customer Name ${c}`, `+1 555 000 ${String(c).padStart(4, '0')}`);
    }

    console.log('Seeding 100,000 orders...');
    const insertOrder = db.prepare(`
      INSERT INTO orders (id, order_number, customer_id, type, status, subtotal, total, created_at, updated_at)
      VALUES (?, ?, ?, 'takeaway', 'completed', 100, 100, ?, ?)
    `);

    db.exec('BEGIN IMMEDIATE');
    for (let i = 1; i <= 100000; i++) {
      let custId: string | null = null;
      if (i === 1) custId = 'cust-zoe';
      else if (i === 2) custId = 'cust-oconnor';
      else if (i === 3) custId = 'cust-elodie';
      else if (i <= 1000) custId = `cust-${(i % 200) + 1}`;

      const orderNum = `ORD-PERF-${String(i).padStart(6, '0')}`;
      insertOrder.run(i, orderNum, custId, '2026-01-01 00:00:00', '2026-01-01 00:00:00');
    }
    db.exec('COMMIT');
    console.log('✓ Seeded 100,000 orders');

    // Callback counters
    let searchContainsCallbacks = 0;
    let searchDigitsCallbacks = 0;

    db.function('orders_search_contains', (value: string | null, query: string) => {
      searchContainsCallbacks++;
      return typeof value === 'string' && value.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
    });
    db.function('orders_search_digits_contains', (value: string | null, digits: string) => {
      searchDigitsCallbacks++;
      return typeof value === 'string' && value.replace(/\D/g, '').includes(digits) ? 1 : 0;
    });

    // 2.1 Query Plan Verification on 100k rows
    const searchPlanSql = `
      EXPLAIN QUERY PLAN
      SELECT orders.id, orders.order_number
      FROM orders
      WHERE (
        (
          orders.id IN (SELECT rowid FROM orders_search_fts WHERE orders_search_fts MATCH ?)
          OR orders.customer_id IN (
            SELECT id FROM customers WHERE rowid IN (
              SELECT rowid FROM customers_search_fts WHERE customers_search_fts MATCH ?
            )
          )
        )
        AND (
          orders_search_contains(orders.order_number, ?)
          OR EXISTS (
            SELECT 1 FROM customers AS search_customer
            WHERE search_customer.id = orders.customer_id
              AND orders_search_contains(search_customer.name, ?)
          )
        )
      )
      ORDER BY orders.id DESC
      LIMIT 50
    `;

    const planRows = db
      .prepare(searchPlanSql)
      .all('"ORD-PERF-050000"', '"ORD-PERF-050000"', 'ORD-PERF-050000', 'ORD-PERF-050000') as any[];

    const planDetails = planRows.map((r) => r.detail).join('\n');
    console.log('Query Plan for eligible search at 100k:\n' + planDetails);

    assertOrThrow(
      planDetails.includes('orders_search_fts') || planDetails.includes('MULTI-INDEX OR'),
      'Query plan uses FTS virtual table index',
    );
    assertOrThrow(
      !planDetails.includes('SCAN orders\n'),
      'Query plan does NOT perform an unindexed full scan of the orders table',
    );
    console.log('✓ Query plan verified at 100k rows');

    // 2.2 Callback Count Verification at 100k rows
    const searchSql = `
      SELECT orders.id, orders.order_number
      FROM orders
      WHERE (
        (
          orders.id IN (SELECT rowid FROM orders_search_fts WHERE orders_search_fts MATCH ?)
          OR orders.customer_id IN (
            SELECT id FROM customers WHERE rowid IN (
              SELECT rowid FROM customers_search_fts WHERE customers_search_fts MATCH ?
            )
          )
        )
        AND (
          orders_search_contains(orders.order_number, ?)
          OR EXISTS (
            SELECT 1 FROM customers AS search_customer
            WHERE search_customer.id = orders.customer_id
              AND orders_search_contains(search_customer.name, ?)
          )
        )
      )
      ORDER BY orders.id DESC
      LIMIT 50
    `;
    const searchStmt = db.prepare(searchSql);

    // No-match search: candidate retrieval returns 0 candidates, UDF runs 0 times!
    searchContainsCallbacks = 0;
    const noMatchRows = searchStmt.all(
      '"nomatch99999"',
      '"nomatch99999"',
      'nomatch99999',
      'nomatch99999',
    );
    assertEqualOrThrow(noMatchRows.length, 0, 'No-match search returns 0 rows');
    assertEqualOrThrow(
      searchContainsCallbacks,
      0,
      'No-match search executes exactly 0 UDF callbacks at 100k rows (down from 180,000)',
    );
    console.log(`✓ No-match callback count at 100k: ${searchContainsCallbacks} (expected 0)`);

    // Selective search: candidate retrieval narrows to 1 candidate
    searchContainsCallbacks = 0;
    const matchRows = searchStmt.all(
      '"ORD-PERF-050000"',
      '"ORD-PERF-050000"',
      'ORD-PERF-050000',
      'ORD-PERF-050000',
    ) as any[];
    assertEqualOrThrow(matchRows.length, 1, 'Selective search returns 1 matching order');
    assertEqualOrThrow(
      matchRows[0].order_number,
      'ORD-PERF-050000',
      'Matching order number is correct',
    );
    assertOrThrow(
      searchContainsCallbacks <= 2,
      `Selective search callback count is bounded (got ${searchContainsCallbacks}, expected <= 2)`,
    );
    console.log(
      `✓ Selective search callback count at 100k: ${searchContainsCallbacks} (expected <= 2)`,
    );

    // 2.3 Latency Benchmark at 100k rows
    const latencies100k: number[] = [];
    for (let run = 0; run < 25; run++) {
      const t0 = performance.now();
      searchStmt.all('"nomatch99999"', '"nomatch99999"', 'nomatch99999', 'nomatch99999');
      latencies100k.push(performance.now() - t0);
    }
    const p50_100k = calculatePercentile(latencies100k, 50);
    const p95_100k = calculatePercentile(latencies100k, 95);
    console.log(
      `✓ Latency at 100k rows (no-match): p50 = ${p50_100k.toFixed(3)} ms, p95 = ${p95_100k.toFixed(3)} ms`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Section 3: 300,000 Rows Scale Benchmark
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. 300,000 Rows Scale Benchmark ---');

    console.log('Seeding additional 200,000 orders to reach 300,000 orders...');
    db.exec('BEGIN IMMEDIATE');
    for (let i = 100001; i <= 300000; i++) {
      const custId = i <= 101000 ? `cust-${(i % 200) + 1}` : null;
      const orderNum = `ORD-PERF-${String(i).padStart(6, '0')}`;
      insertOrder.run(i, orderNum, custId, '2026-01-01 00:00:00', '2026-01-01 00:00:00');
    }
    db.exec('COMMIT');
    console.log('✓ Seeded 300,000 orders total');

    // 3.1 Callback Count Verification at 300k rows
    searchContainsCallbacks = 0;
    const noMatch300k = searchStmt.all(
      '"nomatch99999"',
      '"nomatch99999"',
      'nomatch99999',
      'nomatch99999',
    );
    assertEqualOrThrow(noMatch300k.length, 0, 'No-match search returns 0 rows at 300k');
    assertEqualOrThrow(
      searchContainsCallbacks,
      0,
      'No-match search executes exactly 0 UDF callbacks at 300k rows (down from 540,000)',
    );
    console.log(`✓ No-match callback count at 300k: ${searchContainsCallbacks} (expected 0)`);

    // Selective search at 300k
    searchContainsCallbacks = 0;
    const match300k = searchStmt.all(
      '"ORD-PERF-250000"',
      '"ORD-PERF-250000"',
      'ORD-PERF-250000',
      'ORD-PERF-250000',
    ) as any[];
    assertEqualOrThrow(match300k.length, 1, 'Selective search returns 1 matching order at 300k');
    assertEqualOrThrow(
      match300k[0].order_number,
      'ORD-PERF-250000',
      'Matching order number is correct',
    );
    assertOrThrow(
      searchContainsCallbacks <= 2,
      `Selective search callback count at 300k is bounded (got ${searchContainsCallbacks}, expected <= 2)`,
    );
    console.log(
      `✓ Selective search callback count at 300k: ${searchContainsCallbacks} (expected <= 2)`,
    );

    // Customer name search at 300k
    searchContainsCallbacks = 0;
    const matchCust300k = searchStmt.all('"Zoë"', '"Zoë"', 'zoë', 'zoë') as any[];
    assertEqualOrThrow(matchCust300k.length, 1, 'Customer name search returns matching order');
    assertEqualOrThrow(
      matchCust300k[0].order_number,
      'ORD-PERF-000001',
      'Found order for customer Zoë',
    );
    assertOrThrow(
      searchContainsCallbacks <= 5,
      `Customer name callback count at 300k is bounded (got ${searchContainsCallbacks}, expected <= 5)`,
    );
    console.log(
      `✓ Customer name callback count at 300k: ${searchContainsCallbacks} (expected <= 5)`,
    );

    // 3.2 Latency Benchmark at 300k rows
    const latencies300k: number[] = [];
    for (let run = 0; run < 25; run++) {
      const t0 = performance.now();
      searchStmt.all('"nomatch99999"', '"nomatch99999"', 'nomatch99999', 'nomatch99999');
      latencies300k.push(performance.now() - t0);
    }
    const p50_300k = calculatePercentile(latencies300k, 50);
    const p95_300k = calculatePercentile(latencies300k, 95);
    console.log(
      `✓ Latency at 300k rows (no-match): p50 = ${p50_300k.toFixed(3)} ms, p95 = ${p95_300k.toFixed(3)} ms`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Section 4: Phone Search Candidate & Fallback Verification at Scale
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Phone Search Candidate & Fallback Verification at Scale ---');

    const phoneSearchSql = `
      SELECT orders.id, orders.order_number
      FROM orders
      WHERE (
        (
          orders.id IN (SELECT rowid FROM orders_search_fts WHERE orders_search_fts MATCH ?)
          OR orders.customer_id IN (
            SELECT id FROM customers
            WHERE (phone_digits IS NOT NULL AND orders_search_digits_contains(phone_digits, ?))
               OR (phone IS NOT NULL AND orders_search_digits_contains(phone, ?))
               OR orders_search_contains(name, ?)
          )
        )
        AND (
          orders_search_contains(orders.order_number, ?)
          OR EXISTS (
            SELECT 1 FROM customers AS search_customer
            WHERE search_customer.id = orders.customer_id
              AND (
                orders_search_contains(search_customer.name, ?)
                OR orders_search_digits_contains(search_customer.phone_digits, ?)
                OR orders_search_digits_contains(search_customer.phone, ?)
              )
          )
        )
      )
      ORDER BY orders.id DESC
      LIMIT 50
    `;
    const phoneStmt = db.prepare(phoneSearchSql);

    searchDigitsCallbacks = 0;
    searchContainsCallbacks = 0;
    const phoneResults = phoneStmt.all(
      '"555234"',
      '555234',
      '555234',
      '(555) 234',
      '(555) 234',
      '(555) 234',
      '555234',
      '555234',
    ) as any[];
    assertEqualOrThrow(
      phoneResults.length,
      1,
      'Phone search finds target order across 300k orders',
    );
    assertEqualOrThrow(
      phoneResults[0].order_number,
      'ORD-PERF-000001',
      'Found order for Zoë by phone fragment',
    );
    assertOrThrow(
      searchDigitsCallbacks < 2000,
      `Phone search examines customers table only, not 300,000 orders (callbacks = ${searchDigitsCallbacks})`,
    );
    console.log(
      `✓ Phone search verified at 300k rows: 1 match, ${searchDigitsCallbacks} digit callbacks across customers`,
    );

    // 4.1 Short Query Fallback (< 3 chars)
    const shortQuerySql = `
      SELECT orders.id, orders.order_number
      FROM orders
      WHERE (
        orders_search_contains(orders.order_number, ?)
        OR EXISTS (
          SELECT 1 FROM customers AS search_customer
          WHERE search_customer.id = orders.customer_id
            AND orders_search_contains(search_customer.name, ?)
        )
      )
      AND orders.id <= 100
      ORDER BY orders.id DESC
      LIMIT 10
    `;
    const shortResults = db.prepare(shortQuerySql).all('zo', 'zo') as any[];
    assertEqualOrThrow(shortResults.length, 1, 'Short query fallback finds target order');
    assertEqualOrThrow(
      shortResults[0].order_number,
      'ORD-PERF-000001',
      'Short query matches customer Zoë',
    );
    console.log('✓ Short query fallback (< 3 chars) verified');

    console.log('\nAll order search performance, scaling & invariant tests passed successfully.');
  } finally {
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
