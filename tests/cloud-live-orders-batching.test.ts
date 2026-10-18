/**
 * Tests for CloudSyncService live-orders batched decoration (ARCH-009a / Issue #1187).
 *
 * Verifies that:
 * 1. CloudSyncService.liveOrders batches lookups for order items, addons, table
 *    details, and bills across all retrieved order IDs into single bulk queries
 *    instead of an N+1 query loop.
 * 2. Exact response shape, field structure, and PII sanitization properties are
 *    preserved identically to single-order decoration.
 * 3. Query count remains constant (<= 6 queries) regardless of the number of orders.
 * 4. Status filtering and edge cases (empty orders, missing tables, multiple bills)
 *    work correctly.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cloud-live-orders-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'keychain',
        encryptString: (value: string) => Buffer.from(value, 'utf8'),
        decryptString: (value: Buffer) => value.toString('utf8'),
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  getDatabase,
  closeDatabase,
  now,
  assertEqualOrThrow: assertEqual,
  assertOrThrow: customAssert,
} = require('./helpers/test-setup');
const { CloudSyncService } = require('../main/services/cloud-sync');

async function run() {
  console.log('Cloud live-orders batching tests (ARCH-009a / Issue #1187)');
  console.log('='.repeat(60));

  try {
    initTestDb();
    const db = getDatabase();
    const service = new CloudSyncService();

    // ------------------------------------------------------------------------
    // Test 1: Empty state and invalid statuses
    // ------------------------------------------------------------------------
    {
      const emptyResult = (service as any).liveOrders();
      assert.deepStrictEqual(emptyResult, { orders: [] }, 'Empty database returns { orders: [] }');

      const invalidResult = (service as any).liveOrders({
        statuses: ['invalid_status', 'cancelled'],
      });
      assert.deepStrictEqual(
        invalidResult,
        { orders: [] },
        'Invalid statuses return { orders: [] }',
      );
      console.log('  ✓ empty database and invalid statuses return empty orders');
    }

    // ------------------------------------------------------------------------
    // Test 2: Exact shape and sanitization parity with diverse order structures
    // ------------------------------------------------------------------------
    {
      db.prepare(`INSERT INTO tables (id, number, capacity, status) VALUES (?, ?, ?, ?)`).run(
        'table-1',
        'T-01',
        4,
        'occupied',
      );
      db.prepare(`INSERT INTO addon_groups (id, name) VALUES (?, ?)`).run('ag-1', 'Extras');
      db.prepare(`INSERT INTO addons (id, addon_group_id, name, price) VALUES (?, ?, ?, ?)`).run(
        'addon-cheese',
        'ag-1',
        'Extra Cheddar',
        1.5,
      );
      db.prepare(`INSERT INTO addons (id, addon_group_id, name, price) VALUES (?, ?, ?, ?)`).run(
        'addon-bacon',
        'ag-1',
        'Crispy Bacon',
        2.0,
      );

      // Order 1: Has table, items with addons, and multiple bills (one unpaid, one paid)
      const order1Id = db
        .prepare(
          `INSERT INTO orders (order_number, table_id, customer_id, type, status, subtotal, total, delivery_address, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'ORD-001',
          'table-1',
          'cust-123',
          'dine_in',
          'pending',
          25.0,
          27.5,
          '123 Secret St',
          now(),
          now(),
        ).lastInsertRowid;

      const item1Id = db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          order1Id,
          'prod-burger',
          'Gourmet Burger',
          2,
          10.0,
          20.0,
          20.0,
          now(),
          now(),
        ).lastInsertRowid;

      db.prepare(
        `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(item1Id, 'addon-cheese', 'Extra Cheddar', 1.5, 1, now());

      db.prepare(
        `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(item1Id, 'addon-bacon', 'Crispy Bacon', 2.0, 1, now());

      const item2Id = db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          order1Id,
          'prod-fries',
          'Truffle Fries',
          1,
          5.0,
          5.0,
          5.0,
          now(),
          now(),
        ).lastInsertRowid;

      // Bill 1 (unpaid) and Bill 2 (paid)
      db.prepare(
        `INSERT INTO bills (order_id, bill_number, subtotal, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        order1Id,
        'BILL-001',
        25.0,
        27.5,
        0.0,
        27.5,
        'pending',
        JSON.stringify({ method: 'cash' }),
        now(),
        now(),
      );

      db.prepare(
        `INSERT INTO bills (order_id, bill_number, subtotal, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        order1Id,
        'BILL-002',
        25.0,
        27.5,
        27.5,
        0.0,
        'paid',
        JSON.stringify({ method: 'card' }),
        now(),
        now(),
      );

      // Order 2: No table, one item, one paid bill
      const order2Id = db
        .prepare(
          `INSERT INTO orders (order_number, table_id, customer_id, type, status, subtotal, total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'ORD-002',
          null,
          'cust-456',
          'takeaway',
          'preparing',
          8.0,
          8.0,
          now(),
          now(),
        ).lastInsertRowid;

      db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(order2Id, 'prod-latte', 'Iced Latte', 1, 8.0, 8.0, 8.0, now(), now());

      db.prepare(
        `INSERT INTO bills (order_id, bill_number, subtotal, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        order2Id,
        'BILL-003',
        8.0,
        8.0,
        8.0,
        0.0,
        'paid',
        JSON.stringify({ method: 'qr' }),
        now(),
        now(),
      );

      // Order 3: Has table, no items, no bills
      const order3Id = db
        .prepare(
          `INSERT INTO orders (order_number, table_id, customer_id, type, status, subtotal, total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'ORD-003',
          'table-1',
          null,
          'dine_in',
          'ready',
          0.0,
          0.0,
          now(),
          now(),
        ).lastInsertRowid;

      // Order 4: Non-existent table_id, status served
      const order4Id = db
        .prepare(
          `INSERT INTO orders (order_number, table_id, customer_id, type, status, subtotal, total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'ORD-004',
          'table-nonexistent',
          null,
          'dine_in',
          'served',
          12.0,
          12.0,
          now(),
          now(),
        ).lastInsertRowid;

      db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(order4Id, 'prod-sandwich', 'Club Sandwich', 1, 12.0, 12.0, 12.0, now(), now());

      // Fetch all 4 orders raw
      const rawOrders = db
        .prepare('SELECT * FROM orders WHERE id IN (?, ?, ?, ?) ORDER BY created_at ASC')
        .all(order1Id, order2Id, order3Id, order4Id) as any[];

      // Compare single decoration vs batched decoration
      const batchedDecorated = (service as any).decorateOrders(rawOrders);
      assertEqual(batchedDecorated.length, 4, 'Batched decoration returns all 4 orders');

      for (let i = 0; i < rawOrders.length; i++) {
        const singleDecorated = (service as any).decorateOrder(rawOrders[i]);
        assert.deepStrictEqual(
          batchedDecorated[i],
          singleDecorated,
          `Order ${rawOrders[i].order_number} batched output matches single-order decoration exactly`,
        );

        // Verify PII is stripped in both
        customAssert(!('customer_id' in batchedDecorated[i]), 'customer_id is stripped');
        customAssert(!('delivery_address' in batchedDecorated[i]), 'delivery_address is stripped');
      }

      // Check specific properties on Order 1
      const ord1 = batchedDecorated[0];
      assertEqual(ord1.items.length, 2, 'Order 1 has 2 items');
      assertEqual(ord1.items[0].addons.length, 2, 'Order 1 Item 1 has 2 addons');
      assertEqual(ord1.items[0].addons[0].name, 'Extra Cheddar', 'Addon 1 name matches');
      assertEqual(ord1.items[0].addons[1].name, 'Crispy Bacon', 'Addon 2 name matches');
      assertEqual(ord1.table.number, 'T-01', 'Order 1 table number matches');
      assertEqual(ord1.table.name, 'T-01', 'Order 1 table name normalized to number');
      assertEqual(ord1.bills.length, 2, 'Order 1 has 2 bills');
      customAssert(
        !('payment_details' in ord1.bill),
        'payment_details is stripped by sanitizeOrderSnapshot',
      );

      // Check Order 2
      const ord2 = batchedDecorated[1];
      assertEqual(ord2.table, null, 'Order 2 has null table');
      assertEqual(ord2.bills.length, 1, 'Order 2 has 1 bill');
      assertEqual(ord2.bill.payment_status, 'paid', 'Order 2 selects only bill');

      // Check Order 3
      const ord3 = batchedDecorated[2];
      assertEqual(ord3.items.length, 0, 'Order 3 has empty items');
      assertEqual(ord3.bills.length, 0, 'Order 3 has empty bills');
      assertEqual(ord3.bill, null, 'Order 3 has null bill');

      // Check Order 4
      const ord4 = batchedDecorated[3];
      assertEqual(ord4.table, null, 'Order 4 with non-existent table resolves to null table');

      console.log(
        '  ✓ exact shape, addons, bills, tables, and PII sanitization match single-order decoration',
      );
    }

    // ------------------------------------------------------------------------
    // Test 3: Query count bound (N+1 elimination verification)
    // ------------------------------------------------------------------------
    {
      // Clean orders and seed 50 active orders
      db.prepare('DELETE FROM order_item_addons').run();
      db.prepare('DELETE FROM order_items').run();
      db.prepare('DELETE FROM bills').run();
      db.prepare('DELETE FROM orders').run();

      const orderCount = 50;
      const statuses = ['pending', 'preparing', 'ready', 'served'];

      for (let i = 1; i <= orderCount; i++) {
        const status = statuses[i % statuses.length];
        const ordId = db
          .prepare(
            `INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `ORD-BATCH-${String(i).padStart(4, '0')}`,
            'table-1',
            'dine_in',
            status,
            20.0,
            22.0,
            now(),
            now(),
          ).lastInsertRowid;

        const itmId = db
          .prepare(
            `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ordId,
            `prod-${i}`,
            `Product ${i}`,
            1,
            20.0,
            20.0,
            20.0,
            now(),
            now(),
          ).lastInsertRowid;

        db.prepare(
          `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(itmId, null, `Addon ${i}`, 2.0, 1, now());

        db.prepare(
          `INSERT INTO bills (order_id, bill_number, subtotal, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          ordId,
          `BILL-BATCH-${i}`,
          20.0,
          22.0,
          0.0,
          22.0,
          'pending',
          JSON.stringify({ note: `Bill ${i}` }),
          now(),
          now(),
        );
      }

      // Spy on db.prepare to track query count
      let prepareCount = 0;
      const originalPrepare = db.prepare.bind(db);
      db.prepare = function (sql: string, ...args: any[]) {
        prepareCount++;
        return originalPrepare(sql, ...args);
      };

      const result = (service as any).liveOrders();

      // Restore db.prepare
      db.prepare = originalPrepare;

      assertEqual(result.orders.length, orderCount, `Returns all ${orderCount} live orders`);
      console.log(`  Query count for ${orderCount} orders: ${prepareCount} queries`);

      // Unbatched N+1 loop would have executed at least 1 + 50 * 4 = 201 queries.
      // Batched execution must execute at most 6 queries:
      // 1. SELECT * FROM orders WHERE status IN (...)
      // 2. SELECT * FROM order_items WHERE order_id IN (...)
      // 3. SELECT * FROM order_item_addons WHERE order_item_id IN (...)
      // 4. (optional) SELECT ... FROM order_audit_log WHERE order_item_id IN (...)
      // 5. SELECT * FROM tables WHERE id IN (...)
      // 6. SELECT * FROM bills WHERE order_id IN (...)
      customAssert(
        prepareCount <= 6,
        `Expected at most 6 database queries for ${orderCount} orders, got ${prepareCount}`,
      );

      // Verify every order is decorated
      for (const ord of result.orders) {
        assertEqual(ord.items.length, 1, 'Order has 1 item');
        assertEqual(ord.items[0].addons.length, 1, 'Item has 1 addon');
        assertEqual(ord.table.number, 'T-01', 'Table attached');
        assertEqual(ord.bills.length, 1, 'Bill attached');
      }

      console.log(
        `  ✓ N+1 query pattern eliminated: ${orderCount} orders resolved in ${prepareCount} queries (<= 6)`,
      );
    }

    // ------------------------------------------------------------------------
    // Test 4: Timing benchmark at 100 orders
    // ------------------------------------------------------------------------
    {
      // Add 50 more orders to reach 100
      for (let i = 51; i <= 100; i++) {
        const ordId = db
          .prepare(
            `INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `ORD-BATCH-${String(i).padStart(4, '0')}`,
            'table-1',
            'dine_in',
            'pending',
            15.0,
            16.5,
            now(),
            now(),
          ).lastInsertRowid;

        const itmId = db
          .prepare(
            `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ordId,
            `prod-${i}`,
            `Product ${i}`,
            1,
            15.0,
            15.0,
            15.0,
            now(),
            now(),
          ).lastInsertRowid;

        db.prepare(
          `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(itmId, null, `Addon ${i}`, 1.5, 1, now());

        db.prepare(
          `INSERT INTO bills (order_id, bill_number, subtotal, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(ordId, `BILL-BATCH-${i}`, 15.0, 16.5, 0.0, 16.5, 'pending', null, now(), now());
      }

      // Warm up
      (service as any).liveOrders();

      const iterations = 10;
      const start = performance.now();
      for (let iter = 0; iter < iterations; iter++) {
        const res = (service as any).liveOrders();
        assertEqual(res.orders.length, 100, 'Returns 100 orders');
      }
      const duration = performance.now() - start;
      const avgMs = duration / iterations;
      console.log(`  100 orders benchmark: average ${avgMs.toFixed(2)} ms per liveOrders call`);
      customAssert(avgMs < 100, `Expected avg execution under 100ms, took ${avgMs.toFixed(2)}ms`);

      console.log('  ✓ timing benchmark for 100 orders verified');
    }

    // ------------------------------------------------------------------------
    // Test 5: Status filtering
    // ------------------------------------------------------------------------
    {
      const readyOnly = (service as any).liveOrders({ statuses: ['ready'] });
      customAssert(readyOnly.orders.length > 0, 'Found ready orders');
      customAssert(
        readyOnly.orders.every((o: any) => o.status === 'ready'),
        'All returned orders have status "ready"',
      );

      const multipleStatuses = (service as any).liveOrders({ statuses: ['pending', 'ready'] });
      customAssert(
        multipleStatuses.orders.every((o: any) => o.status === 'pending' || o.status === 'ready'),
        'All returned orders have status "pending" or "ready"',
      );

      console.log('  ✓ status filtering restricts returned orders to requested statuses');
    }

    // ------------------------------------------------------------------------
    // Test 6: SQLite bind limit protection with large order/item counts (Issue #1223)
    // ------------------------------------------------------------------------
    {
      console.log('Testing large order/item batching exceeding SQLite bind limit (Issue #1223)...');
      db.prepare('DELETE FROM order_item_addons').run();
      db.prepare('DELETE FROM order_audit_log').run();
      db.prepare('DELETE FROM order_items').run();
      db.prepare('DELETE FROM bills').run();
      db.prepare('DELETE FROM orders').run();

      const insertOrder = db.prepare(
        `INSERT INTO orders (order_number, table_id, type, status, subtotal, total, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertItem = db.prepare(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertAddon = db.prepare(
        `INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      // Seed 164 orders with 200 items each = 32,800 items (exceeds SQLite 32,766 max bind limit)
      const numOrders = 164;
      const itemsPerOrder = 200;
      const nowIso = now();

      db.transaction(() => {
        for (let i = 0; i < numOrders; i++) {
          const ordId = insertOrder.run(
            `ORD-SCALE-${String(i).padStart(4, '0')}`,
            null,
            'takeaway',
            'pending',
            100.0,
            100.0,
            nowIso,
            nowIso,
          ).lastInsertRowid;

          for (let j = 0; j < itemsPerOrder; j++) {
            const itmId = insertItem.run(
              ordId,
              `prod-${j}`,
              `Item ${j}`,
              1,
              0.5,
              0.5,
              0.5,
              nowIso,
              nowIso,
            ).lastInsertRowid;

            if (j === 0) {
              insertAddon.run(itmId, null, 'Extra Sauce', 0.25, 1, nowIso);
            }
          }
        }
      })();

      const totalItems = db.prepare('SELECT COUNT(*) as count FROM order_items').get() as {
        count: number;
      };
      assertEqual(totalItems.count, 32800, 'Seeded exactly 32,800 order items');

      // Call liveOrders - must succeed without throwing "too many SQL variables"
      const result = (service as any).liveOrders();
      assertEqual(result.orders.length, 164, 'Successfully returned all 164 orders');
      const firstOrder = result.orders[0];
      assertEqual(firstOrder.items.length, 200, 'First order has 200 items');
      assertEqual(firstOrder.items[0].addons.length, 1, 'First item has addon attached');
      assertEqual(firstOrder.items[0].addons[0].name, 'Extra Sauce', 'Addon name matches');

      console.log('  ✓ 164 orders with 32,800 items handled cleanly without exceeding bind limits');
    }

    console.log('='.repeat(60));
    console.log('✅ All cloud live-orders batching tests passed successfully!');
  } finally {
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore temp dir cleanup errors
    }
  }
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
