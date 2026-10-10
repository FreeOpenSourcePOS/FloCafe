/**
 * Customer top items: GET /api/customers/:id/top-items.
 *
 * Covers ranking by total quantity across completed orders, product-level grouping of variants and
 * modifiers, the order-count / name / product-id tie-breaks, the five-item limit, exclusion of
 * cancelled, voided, refunded, and refund-adjustment lines and of non-completed or fully refunded
 * orders, availability flags for deleted and inactive products, and the empty and 404 states.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-top-items-'));

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

const request = require('supertest');
const {
  initTestDb,
  createApp,
  assertEqualOrThrow,
  assertOrThrow,
  getResults,
  closeDatabase,
  now,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  seedCustomer,
} = require('./helpers/test-setup');

const { customerRoutes, getCustomerTopItems } = require('../main/routes/customers');

let orderSeq = 0;
let billSeq = 0;

function insertOrder(db: any, customerId: string, status: string, billStatuses: string[] = ['paid']): number {
  orderSeq += 1;
  const result = db.prepare(`
    INSERT INTO orders (order_number, customer_id, type, status, created_at, updated_at)
    VALUES (?, ?, 'takeaway', ?, ?, ?)
  `).run(`TOP-${orderSeq}`, customerId, status, now(), now());
  const orderId = Number(result.lastInsertRowid);
  for (const paymentStatus of billStatuses) {
    billSeq += 1;
    db.prepare(`
      INSERT INTO bills (bill_number, order_id, customer_id, total, paid_amount, payment_status, created_at, updated_at)
      VALUES (?, ?, ?, 10, 10, ?, ?, ?)
    `).run(`TOP-BILL-${billSeq}`, orderId, customerId, paymentStatus, now(), now());
  }
  return orderId;
}

function insertItem(db: any, orderId: number, productId: string, productName: string, quantity: number, options: {
  status?: string;
  variantId?: string | null;
  modifiers?: string | null;
} = {}) {
  db.prepare(`
    INSERT INTO order_items (
      order_id, product_id, product_name, unit_price, quantity, subtotal, total,
      variant_id, modifier_selection, status, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId, productId, productName, quantity, quantity, quantity,
    options.variantId ?? null, options.modifiers ?? null, options.status ?? 'completed', now(), now(),
  );
}

function summary(items: Array<{ product_id: string; total_quantity: number; order_count: number }>) {
  return items.map((item) => `${item.product_id}:${item.total_quantity}/${item.order_count}`).join(', ');
}

async function main() {
  console.log('Customer Top Items Tests');
  console.log('='.repeat(60));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const app = createApp({ '/api/customers': customerRoutes });

  seedCategory(db, 'cat-main', 'Main');
  seedCategory(db, 'cat-hidden', 'Hidden');
  db.prepare('UPDATE categories SET is_active = 0 WHERE id = ?').run('cat-hidden');

  seedProduct(db, 'p-latte', 'cat-main', 'Latte', 4);
  seedProduct(db, 'p-croissant', 'cat-main', 'Croissant', 3);
  seedProduct(db, 'p-muffin', 'cat-main', 'apple muffin', 3);
  seedProduct(db, 'p-cookie-b', 'cat-main', 'Cookie', 2);
  seedProduct(db, 'p-cookie-a', 'cat-main', 'Cookie', 2);
  seedProduct(db, 'p-tea', 'cat-main', 'Tea', 2);
  seedProduct(db, 'p-burger', 'cat-main', 'Burger', 9);
  seedProduct(db, 'p-inactive', 'cat-main', 'Retired Soup', 5);
  db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run('p-inactive');
  seedProduct(db, 'p-softdel', 'cat-main', 'Soft Deleted Pie', 5);
  db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run(now(), 'p-softdel');
  seedProduct(db, 'p-hidden', 'cat-hidden', 'Hidden Category Bun', 5);
  seedProduct(db, 'p-split', 'cat-main', 'Split Salad', 5);

  for (const [id, name] of [
    ['cust-a', 'Ranked Customer'],
    ['cust-b', 'Other Customer'],
    ['cust-c', 'Unavailable Customer'],
    ['cust-d', 'Partial Refund Customer'],
    ['cust-e', 'New Customer'],
    ['cust-f', 'Cancelled Only Customer'],
  ]) {
    seedCustomer(db, id, name);
  }

  // Customer A: ranking, grouping, and tie-breaks.
  const a1 = insertOrder(db, 'cust-a', 'completed');
  insertItem(db, a1, 'p-latte', 'Latte (old name)', 2, { variantId: 'var-small' });
  insertItem(db, a1, 'p-croissant', 'Croissant', 3);
  insertItem(db, a1, 'p-cookie-b', 'Cookie', 1);
  insertItem(db, a1, 'p-tea', 'Tea', 1);
  const a2 = insertOrder(db, 'cust-a', 'completed');
  insertItem(db, a2, 'p-latte', 'Latte (old name)', 1, { variantId: 'var-large', modifiers: '[{"name":"Oat milk"}]' });
  insertItem(db, a2, 'p-cookie-a', 'Cookie', 1);
  insertItem(db, a2, 'p-muffin', 'Apple Muffin', 1);

  // Customer A: every non-sale shape for a product that would otherwise rank first.
  insertItem(db, a1, 'p-burger', 'Burger', 10, { status: 'cancelled' });
  insertItem(db, a1, 'p-burger', 'Burger', 10, { status: 'voided' });
  insertItem(db, a2, 'p-burger', 'Burger', 10, { status: 'refunded' });
  insertItem(db, a2, 'p-burger', 'Refund: Burger', 10, { status: 'void_adjustment' });
  insertItem(db, insertOrder(db, 'cust-a', 'cancelled', []), 'p-burger', 'Burger', 10, { status: 'pending' });
  insertItem(db, insertOrder(db, 'cust-a', 'pending', []), 'p-burger', 'Burger', 10, { status: 'pending' });
  insertItem(db, insertOrder(db, 'cust-a', 'preparing', []), 'p-burger', 'Burger', 10, { status: 'preparing' });
  insertItem(db, insertOrder(db, 'cust-a', 'completed', ['refunded']), 'p-burger', 'Burger', 10);
  insertItem(db, insertOrder(db, 'cust-a', 'completed', ['refunded', 'refunded']), 'p-burger', 'Burger', 10);

  // Another customer's completed purchases never leak into customer A's list.
  insertItem(db, insertOrder(db, 'cust-b', 'completed'), 'p-burger', 'Burger', 50);

  const ranked = getCustomerTopItems(db, 'cust-a');
  assertEqualOrThrow(
    summary(ranked),
    'p-latte:3/2, p-croissant:3/1, p-muffin:1/1, p-cookie-a:1/1, p-cookie-b:1/1',
    'Ranks by quantity, then order count, then case-insensitive name, then product id; capped at 5',
  );
  assertOrThrow(!ranked.some((item: any) => item.product_id === 'p-burger'), 'Excluded lines and orders never count');
  assertOrThrow(!ranked.some((item: any) => item.product_id === 'p-tea'), 'The sixth-ranked product is cut by the limit');
  assertEqualOrThrow(ranked[0].product_name, 'Latte', 'Uses the current product name, not the historical snapshot');
  assertEqualOrThrow(ranked[0].total_quantity, 3, 'Variants and modifiers are grouped under one product');
  assertOrThrow(ranked.every((item: any) => item.available === true), 'Active catalog products are available');

  const bResult = getCustomerTopItems(db, 'cust-b');
  assertEqualOrThrow(summary(bResult), 'p-burger:50/1', 'Each customer sees only their own purchases');

  // Customer C: unavailable and deleted products stay listed but are flagged; fewer than 5 is fine.
  const c1 = insertOrder(db, 'cust-c', 'completed');
  insertItem(db, c1, 'p-gone', 'Gone Wrap', 4);
  insertItem(db, c1, 'p-inactive', 'Retired Soup', 3);
  insertItem(db, c1, 'p-softdel', 'Soft Deleted Pie', 2);
  insertItem(db, c1, 'p-hidden', 'Hidden Category Bun', 1);
  const unavailable = getCustomerTopItems(db, 'cust-c');
  assertEqualOrThrow(
    summary(unavailable),
    'p-gone:4/1, p-inactive:3/1, p-softdel:2/1, p-hidden:1/1',
    'Unavailable products keep their place in the history, and fewer than 5 are returned as-is',
  );
  assertEqualOrThrow(unavailable[0].product_name, 'Gone Wrap', 'A hard-deleted product falls back to its last sold name');
  assertOrThrow(unavailable.every((item: any) => item.available === false), 'Deleted, inactive, and hidden-category products are unavailable');

  // Customer D: a partially refunded order still counts unless every bill is fully refunded.
  insertItem(db, insertOrder(db, 'cust-d', 'completed', ['refunded', 'paid']), 'p-split', 'Split Salad', 2);
  insertItem(db, insertOrder(db, 'cust-d', 'completed', ['partially_refunded']), 'p-split', 'Split Salad', 1);
  assertEqualOrThrow(summary(getCustomerTopItems(db, 'cust-d')), 'p-split:3/2', 'Partially refunded orders still count');

  // Customer F: only non-sale history is the same as no history.
  insertItem(db, insertOrder(db, 'cust-f', 'cancelled', []), 'p-latte', 'Latte', 4, { status: 'cancelled' });
  insertItem(db, insertOrder(db, 'cust-f', 'completed'), 'p-latte', 'Latte', 4, { status: 'voided' });
  assertEqualOrThrow(getCustomerTopItems(db, 'cust-f').length, 0, 'A customer with only non-sale lines has no top items');

  // HTTP contract.
  const resA = await request(app).get('/api/customers/cust-a/top-items').set(owner.authHeader);
  assertEqualOrThrow(resA.status, 200, 'GET top-items returns 200');
  assertEqualOrThrow(summary(resA.body.items), summary(ranked), 'Route returns the ranked list');
  assertEqualOrThrow(
    JSON.stringify(Object.keys(resA.body.items[0]).sort()),
    JSON.stringify(['available', 'order_count', 'product_id', 'product_name', 'total_quantity']),
    'Each entry carries exactly the documented fields',
  );

  const resEmpty = await request(app).get('/api/customers/cust-e/top-items').set(owner.authHeader);
  assertEqualOrThrow(resEmpty.status, 200, 'A customer with no orders returns 200');
  assertEqualOrThrow(JSON.stringify(resEmpty.body), JSON.stringify({ items: [] }), 'A customer with no orders returns an empty list');

  const resMissing = await request(app).get('/api/customers/cust-missing/top-items').set(owner.authHeader);
  assertEqualOrThrow(resMissing.status, 404, 'An unknown customer returns 404');

  const resAnon = await request(app).get('/api/customers/cust-a/top-items');
  assertEqualOrThrow(resAnon.status, 401, 'An unauthenticated request is rejected');

  closeDatabase();

  const results = getResults();
  console.log('='.repeat(60));
  console.log(`Summary: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unhandled failure:', err);
  process.exit(1);
});
