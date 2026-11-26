/**
 * Pizza fork: the pizza setup profile configures British Columbia tax. Food is charged GST
 * 5%; soda is charged GST 5% and PST 7%; prices are tax-exclusive; a product with no tax
 * category is untaxed.
 *
 * The totals are worked out by hand. Each tax line is rounded half-up to the cent per order
 * line (the manual configuration's rounding):
 *   food $23.00: GST 23.00 x 0.05 = 1.15
 *   soda  $1.75: GST  1.75 x 0.05 = 0.0875 -> 0.09, PST 1.75 x 0.07 = 0.1225 -> 0.12
 *   together: subtotal 24.75, GST 1.15 + 0.09 = 1.24, PST 0.12, total 26.11
 *
 * Usage: node tests/run-electron-node-test.cjs tests/pizza-tax-bc.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pizza-tax-bc-'));
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-pizza-tax-bc';

const {
  createApp,
  startServer,
  api,
  assertEqual,
  assertEqualOrThrow,
  getResults,
  resetCounters,
} = require('./helpers/test-setup');
const { initDatabase, closeDatabase, getDatabase } = require('../main/db');
const { registerRoutes } = require('../main/routes/index');

const failedCases: string[] = [];
async function testCase(name: string, run: () => unknown) {
  console.log(`\n--- ${name} ---`);
  try {
    await run();
  } catch (error: any) {
    failedCases.push(name);
    console.error(`  case failed: ${error?.message ?? error}`);
  }
}

/** Tax lines of an order or bill, added up by label and rate as the reports do. */
function taxLines(breakdown: unknown): string {
  const merged = new Map<string, number>();
  for (const line of [breakdown].flat(3) as Array<{
    title: string;
    rate: number;
    amount: number;
  }>) {
    const key = `${line.title} ${line.rate}%`;
    merged.set(key, Math.round(((merged.get(key) ?? 0) + line.amount) * 100) / 100);
  }
  return [...merged].map(([key, amount]) => `${key} ${amount.toFixed(2)}`).join(', ');
}

async function main() {
  console.log('Pizza fork: British Columbia tax');
  console.log('='.repeat(60));
  resetCounters();
  initDatabase();
  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  let headers: Record<string, string> = {};
  const productIds: Record<string, string> = {};

  const order = async (...names: string[]) => {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers,
      body: {
        type: 'takeaway',
        items: names.map((name) => ({ product_id: productIds[name], quantity: 1 })),
      },
    });
    assertEqualOrThrow(created.status, 201, `an order of ${names.join(' + ')} is created`);
    return created.data.order;
  };

  try {
    await testCase('1. Setup with the pizza profile, then a four-item menu', async () => {
      const setup = await api(baseUrl, '/api/auth/setup/initialize', {
        method: 'POST',
        body: {
          name: 'Pizza Owner',
          email: 'owner@example.com',
          password: 'TestPass123',
          business_type: 'restaurant',
          business_name: 'Sample Pizza Shop',
          setup_profile: 'pizza',
          terms_accepted: true,
          owner_approval_pin: '5678',
          owner_approval_pin_confirmation: '5678',
          country: 'CA',
          currency: 'CAD',
          timezone: 'America/Vancouver',
        },
      });
      assertEqualOrThrow(setup.status, 200, 'the setup route accepts the pizza profile');
      headers = { Authorization: `Bearer ${setup.data.access_token}` };

      const category = await api(baseUrl, '/api/categories', {
        method: 'POST',
        headers,
        body: { name: 'Sample menu' },
      });
      assertEqualOrThrow(category.status, 201, 'a menu category is created');
      const menu: Array<[string, number, string | null]> = [
        ['Sample large pizza', 23, 'food'],
        ['Sample can of soda', 1.75, 'soda'],
        ['Sample gift card', 10, null],
        ['Sample side', 10.7, 'food'],
      ];
      for (const [name, price, taxCategory] of menu) {
        const product = await api(baseUrl, '/api/products', {
          method: 'POST',
          headers,
          body: {
            name,
            price,
            category_id: category.data.category.id,
            tax_category_id: taxCategory,
          },
        });
        assertEqualOrThrow(product.status, 201, `${name} is created in ${taxCategory ?? 'no'} tax`);
        productIds[name] = product.data.product.id;
      }
    });

    await testCase('2. The two tax categories are found by a stable id', async () => {
      const stored = getDatabase()
        .prepare(`
          SELECT category.category_id, category.label
          FROM tax_categories AS category
          JOIN country_packs AS pack ON pack.active_version_id = category.pack_version_id
          WHERE pack.status = 'active' AND category.category_id IN ('food', 'soda')
          ORDER BY category.category_id
        `)
        .all();
      assertEqualOrThrow(
        JSON.stringify(stored),
        JSON.stringify([
          { category_id: 'food', label: 'Food' },
          { category_id: 'soda', label: 'Soda' },
        ]),
        'tax_categories.category_id holds exactly one food and one soda in the active pack',
      );

      const listed = await api(baseUrl, '/api/tax/categories', { headers });
      assertEqualOrThrow(listed.status, 200, 'the tax category list loads');
      assertEqualOrThrow(listed.data.pack_id, 'manual-ca', 'the store runs its own manual pack');
      assertEqualOrThrow(
        listed.data.categories
          .map((category: any) => `${category.id}=${category.rate_percent}`)
          .join(', '),
        'food=5, soda=12, unclassified=null',
        'the product editor offers food at 5% and soda at 12%',
      );
    });

    await testCase('3. Food is charged GST only, on top of the price', async () => {
      const food = await order('Sample large pizza');
      assertEqualOrThrow(food.subtotal, 23, 'the price is the subtotal: tax is not inside it');
      assertEqualOrThrow(taxLines(food.tax_breakdown), 'GST 5% 1.15', 'GST 5% only');
      assertEqualOrThrow(food.tax_amount, 1.15, 'tax is $1.15');
      assertEqualOrThrow(food.total, 24.15, 'total is $24.15');
      assertEqualOrThrow(food.items[0].tax_type, 'exclusive', 'the line is tax-exclusive');
    });

    await testCase('4. Soda is charged GST and PST', async () => {
      const soda = await order('Sample can of soda');
      assertEqualOrThrow(soda.subtotal, 1.75, 'subtotal is $1.75');
      assertEqualOrThrow(taxLines(soda.tax_breakdown), 'GST 5% 0.09, PST 7% 0.12', 'GST and PST');
      assertEqualOrThrow(soda.total, 1.96, 'total is $1.96');
    });

    await testCase('5. A $23.00 pizza and a $1.75 soda come to $26.11', async () => {
      const both = await order('Sample large pizza', 'Sample can of soda');
      assertEqualOrThrow(both.subtotal, 24.75, 'subtotal is $24.75');
      assertEqualOrThrow(
        taxLines(both.tax_breakdown),
        'GST 5% 1.24, PST 7% 0.12',
        'GST $1.24 and PST $0.12',
      );
      // The order adds its line taxes as binary floats (1.15 + 0.21), so compare to the cent.
      assertEqualOrThrow(both.tax_amount.toFixed(2), '1.36', 'tax is $1.36');
      assertEqualOrThrow(both.total, 26.11, 'total is $26.11');

      const bill = await api(baseUrl, '/api/bills/generate', {
        method: 'POST',
        headers,
        body: { order_id: both.id },
      });
      assertEqualOrThrow(bill.status, 201, 'the bill is generated');
      assertEqualOrThrow(
        JSON.stringify(bill.data.bill.tax_breakdown),
        JSON.stringify([
          { title: 'GST', rate: 5, amount: 1.24 },
          { title: 'PST', rate: 7, amount: 0.12 },
        ]),
        'the bill shows one GST line and one PST line: both GST rules share a label',
      );
      assertEqualOrThrow(bill.data.bill.total, 26.11, 'the bill total is $26.11');
    });

    await testCase('6. A product with no tax category is untaxed', async () => {
      const untaxed = await order('Sample gift card');
      assertEqualOrThrow(untaxed.tax_amount, 0, 'no tax');
      assertEqualOrThrow(taxLines(untaxed.tax_breakdown), '', 'no tax lines');
      assertEqualOrThrow(untaxed.total, 10, 'total is the price');
    });
    await testCase('7. Rounding is per order line', async () => {
      // Each tax is rounded on each order line, so two lines of one soda and one line of two
      // sodas differ by a cent: 2 x round(1.75 x 0.07) = 0.24, but round(3.50 x 0.07) = 0.25.
      const twoLines = await order('Sample can of soda', 'Sample can of soda');
      assertEqualOrThrow(twoLines.items.length, 2, 'the two sodas stay on two lines');
      assertEqualOrThrow(twoLines.subtotal, 3.5, 'subtotal is $3.50');
      assertEqualOrThrow(
        taxLines(twoLines.tax_breakdown),
        'GST 5% 0.18, PST 7% 0.24',
        'two lines: GST 0.09 + 0.09 and PST 0.12 + 0.12',
      );
      assertEqualOrThrow(twoLines.total, 3.92, 'two lines come to $3.92');

      const oneLine = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers,
        body: {
          type: 'takeaway',
          items: [{ product_id: productIds['Sample can of soda'], quantity: 2 }],
        },
      });
      assertEqualOrThrow(oneLine.status, 201, 'an order of two sodas on one line is created');
      assertEqualOrThrow(
        taxLines(oneLine.data.order.tax_breakdown),
        'GST 5% 0.18, PST 7% 0.25',
        'one line: GST on 3.50 is 0.175 -> 0.18 and PST is 0.245 -> 0.25',
      );
      assertEqualOrThrow(oneLine.data.order.total, 3.93, 'one line comes to $3.93');
    });

    await testCase('8. A charge is untaxed until the owner gives it a tax category', async () => {
      const charged = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers,
        body: {
          type: 'takeaway',
          packaging_charge: 1,
          items: [{ product_id: productIds['Sample large pizza'], quantity: 1 }],
        },
      });
      assertEqualOrThrow(charged.status, 201, 'an order with a packaging charge is created');
      assertEqualOrThrow(charged.data.order.packaging_charge, 1, 'the charge is on the order');
      assertEqualOrThrow(
        taxLines(charged.data.order.tax_breakdown),
        'GST 5% 1.15',
        'only the pizza is taxed',
      );
      assertEqualOrThrow(charged.data.order.total, 25.15, 'total is 23.00 + 1.15 + 1.00');
    });

    await testCase(
      '10. Three at $10.70 are taxed on $32.10, however the line is made',
      async () => {
        // 10.70 x 3 is 32.099999999999994 in binary floating point; 5% of that rounds to 1.60.
        // The line is worth 32.10 and its GST is 1.605 -> 1.61.
        const side = productIds['Sample side'];
        const db = getDatabase();
        const line = (itemId: number) =>
          db
            .prepare('SELECT subtotal, tax_amount FROM order_items WHERE id = ?')
            .get(itemId) as any;
        const stored = (orderId: number) =>
          db.prepare('SELECT subtotal, tax_amount, total FROM orders WHERE id = ?').get(orderId);
        const three = JSON.stringify({ subtotal: 32.1, tax_amount: 1.61, total: 33.71 });
        const items = [{ product_id: side, quantity: 3 }];

        const created = await api(baseUrl, '/api/orders', {
          method: 'POST',
          headers,
          body: { type: 'takeaway', items },
        });
        assertEqualOrThrow(created.status, 201, 'create: three on one line');
        assertEqualOrThrow(JSON.stringify(stored(created.data.order.id)), three, 'create: order');
        assertEqualOrThrow(
          JSON.stringify(line(created.data.order.items[0].id)),
          JSON.stringify({ subtotal: 32.1, tax_amount: 1.61 }),
          'create: the line holds 32.10 and 1.61',
        );

        const preview = await api(baseUrl, '/api/tax/preview', {
          method: 'POST',
          headers,
          body: { items },
        });
        assertEqualOrThrow(preview.status, 200, 'preview: answered');
        assertEqualOrThrow(
          JSON.stringify([
            preview.data.summary.subtotal,
            preview.data.summary.tax_amount,
            preview.data.summary.total,
          ]),
          '[32.1,1.61,33.71]',
          'preview: quotes what the order charges',
        );

        const bill = await api(baseUrl, '/api/bills/generate', {
          method: 'POST',
          headers,
          body: { order_id: created.data.order.id },
        });
        assertEqualOrThrow(bill.status, 201, 'bill: generated');
        assertEqualOrThrow(
          JSON.stringify([
            bill.data.bill.subtotal,
            bill.data.bill.tax_amount,
            bill.data.bill.total,
          ]),
          '[32.1,1.61,33.71]',
          'bill: the same three figures',
        );

        const gift = await order('Sample gift card');
        const appended = await api(baseUrl, `/api/orders/${gift.id}/items`, {
          method: 'POST',
          headers,
          body: { items },
        });
        assertEqualOrThrow(appended.status, 200, 'append: three added to an open order');
        assertEqualOrThrow(
          JSON.stringify(line(appended.data.added_item_ids[0])),
          JSON.stringify({ subtotal: 32.1, tax_amount: 1.61 }),
          'append: the line holds 32.10 and 1.61',
        );
        assertEqualOrThrow(
          JSON.stringify(stored(gift.id)),
          JSON.stringify({ subtotal: 42.1, tax_amount: 1.61, total: 43.71 }),
          'append: order',
        );

        const one = await order('Sample side');
        const version = (
          db
            .prepare(
              'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
            )
            .get(one.id, one.items[0].id) as any
        ).v;
        const edited = await api(baseUrl, `/api/orders/${one.id}/items/${one.items[0].id}/edit`, {
          method: 'PATCH',
          headers: { ...headers, 'Idempotency-Key': 'pizza-tax-bc-three' },
          body: { expected_edit_version: version, quantity: 3 },
        });
        assertEqualOrThrow(edited.status, 200, 'edit: one made three');
        assertEqualOrThrow(JSON.stringify(stored(one.id)), three, 'edit: order');

        // Three lines of one: each line's GST is 0.535 -> 0.54, and the lines add up to 32.10.
        const lines = await order('Sample side', 'Sample side', 'Sample side');
        assertEqualOrThrow(
          JSON.stringify(stored(lines.id)),
          JSON.stringify({ subtotal: 32.1, tax_amount: 1.62, total: 33.72 }),
          'three lines of one: the stored subtotal is 32.10, not 32.099999999999994',
        );

        // 10% off 32.10 is 3.21, leaving 28.89.
        const discounted = await api(
          baseUrl,
          `/api/orders/${created.data.order.id}/items/${created.data.order.items[0].id}/discount`,
          { method: 'POST', headers, body: { discount_type: 'percentage', discount_value: 10 } },
        );
        assertEqualOrThrow(discounted.status, 200, 'item discount: applied');
        assertEqualOrThrow(
          JSON.stringify(line(created.data.order.items[0].id)),
          JSON.stringify({ subtotal: 28.89, tax_amount: 1.44 }),
          'item discount: the line holds 28.89, not 28.889999999999993',
        );
      },
    );

    await testCase('11. A note change on a sold pizza keeps the tax it was sold with', async () => {
      const db = getDatabase();
      const created = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers,
        body: {
          name: 'Sample menu pizza',
          price: 23,
          category_id: (
            db.prepare("SELECT id FROM categories WHERE name = 'Sample menu'").get() as any
          ).id,
          tax_category_id: 'food',
        },
      });
      assertEqualOrThrow(created.status, 201, 'a pizza product is created in food tax');
      const productId = created.data.product.id;
      // What a menu load adds to a pizza: its size and its pizza_products row.
      db.prepare(
        `INSERT INTO product_variants (id, product_id, name, price, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, 'Large', 23, 1, 0, datetime('now'), datetime('now'))`,
      ).run(`${productId}-large`, productId);
      db.prepare(
        `INSERT INTO pizza_products (product_id, menu_id, kind, created_at, updated_at)
         VALUES (?, 'sample', 'pizza', datetime('now'), datetime('now'))`,
      ).run(productId);
      const line = { product_id: productId, variant_id: `${productId}-large`, quantity: 1 };
      const sold = await api(baseUrl, '/api/orders', {
        method: 'POST',
        headers,
        body: { type: 'takeaway', items: [line] },
      });
      assertEqualOrThrow(sold.status, 201, 'the pizza is sold');
      assertEqualOrThrow(taxLines(sold.data.order.tax_breakdown), 'GST 5% 1.15', 'with GST only');

      // A line sold before amounts were rounded holds a subtotal that is not whole cents.
      db.prepare('UPDATE order_items SET subtotal = 22.999999999999996 WHERE order_id = ?').run(
        sold.data.order.id,
      );
      // The product moves to another tax category after the sale.
      db.prepare("UPDATE products SET tax_category_id = 'soda' WHERE id = ?").run(productId);
      let edits = 0;
      const replace = async (replacement: object) => {
        const live = db
          .prepare("SELECT id FROM order_items WHERE order_id = ? AND status = 'pending'")
          .get(sold.data.order.id) as any;
        const version = (
          db
            .prepare(
              'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
            )
            .get(sold.data.order.id, live.id) as any
        ).v;
        const edited = await api(
          baseUrl,
          `/api/orders/${sold.data.order.id}/items/${live.id}/edit`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Idempotency-Key': `pizza-tax-bc-note-${++edits}` },
            body: { expected_edit_version: version, replacement },
          },
        );
        assertEqualOrThrow(edited.status, 200, 'the replacement is accepted');
        return db
          .prepare('SELECT tax_breakdown, tax_amount, total FROM orders WHERE id = ?')
          .get(sold.data.order.id) as any;
      };

      const noted = await replace({ ...line, special_instructions: 'Ring the bell' });
      assertEqualOrThrow(
        `${taxLines(JSON.parse(noted.tax_breakdown))} = ${noted.tax_amount}, ${noted.total}`,
        'GST 5% 1.15 = 1.15, 24.15',
        'note only: taxed as it was sold',
      );
      const two = await replace({ ...line, quantity: 2 });
      assertEqualOrThrow(
        `${taxLines(JSON.parse(two.tax_breakdown))}, ${two.total}`,
        'GST 5% 2.30, PST 7% 3.22, 51.52',
        'a second pizza is a new sale: taxed as the product is now',
      );
    });

    await testCase(
      '12. Five percent off three at $10.70 is $1.61 wherever it is applied',
      async () => {
        // 5% of 32.10 is 1.605, which rounds half-up to 1.61. In binary floating point the product
        // falls just under the half cent and gives 1.60.
        const side = productIds['Sample side'];
        const db = getDatabase();
        const items = [{ product_id: side, quantity: 3 }];
        const five = { discount_type: 'percentage', discount_value: 5 };
        const place = async (quantity: number) => {
          const created = await api(baseUrl, '/api/orders', {
            method: 'POST',
            headers,
            body: { type: 'takeaway', items: [{ product_id: side, quantity }] },
          });
          assertEqualOrThrow(created.status, 201, `an order of ${quantity} is created`);
          return created.data.order;
        };
        const lines = (orderId: number) =>
          JSON.stringify(
            db
              .prepare(
                "SELECT quantity, discount_amount, subtotal, tax_amount FROM order_items WHERE order_id = ? AND status = 'pending'",
              )
              .all(orderId),
          );
        const discountedLine = JSON.stringify([
          { quantity: 3, discount_amount: 1.61, subtotal: 30.49, tax_amount: 1.52 },
        ]);

        const onItem = await place(3);
        const itemDiscount = await api(
          baseUrl,
          `/api/orders/${onItem.id}/items/${onItem.items[0].id}/discount`,
          { method: 'POST', headers, body: five },
        );
        assertEqualOrThrow(itemDiscount.status, 200, 'item discount: applied');
        assertEqualOrThrow(
          lines(onItem.id),
          discountedLine,
          'item discount: 1.61 off, GST on 30.49',
        );

        const grown = await place(1);
        const one = await api(
          baseUrl,
          `/api/orders/${grown.id}/items/${grown.items[0].id}/discount`,
          { method: 'POST', headers, body: five },
        );
        assertEqualOrThrow(one.status, 200, 'quantity edit: one is discounted first');
        const version = (
          db
            .prepare(
              'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
            )
            .get(grown.id, grown.items[0].id) as any
        ).v;
        const edited = await api(
          baseUrl,
          `/api/orders/${grown.id}/items/${grown.items[0].id}/edit`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Idempotency-Key': 'pizza-tax-bc-discount-three' },
            body: { expected_edit_version: version, quantity: 3 },
          },
        );
        assertEqualOrThrow(edited.status, 200, 'quantity edit: one made three');
        assertEqualOrThrow(lines(grown.id), discountedLine, 'quantity edit: the same line');

        const preview = await api(baseUrl, '/api/tax/preview', {
          method: 'POST',
          headers,
          body: { items, ...five },
        });
        assertEqualOrThrow(preview.status, 200, 'preview: answered');
        const quoted = JSON.stringify([
          preview.data.summary.discount_amount,
          preview.data.summary.tax_amount,
          preview.data.summary.total,
        ]);
        assertEqualOrThrow(quoted, '[1.61,1.53,32.02]', 'preview: 1.61 off, 30.49 + 1.53');
        const stored = (table: string, id: number) => {
          const row = db
            .prepare(`SELECT discount_amount, tax_amount, total FROM ${table} WHERE id = ?`)
            .get(id) as any;
          return JSON.stringify([row.discount_amount, row.tax_amount, row.total]);
        };

        const onOrder = await place(3);
        const orderDiscount = await api(baseUrl, `/api/orders/${onOrder.id}/discount`, {
          method: 'POST',
          headers,
          body: five,
        });
        assertEqualOrThrow(orderDiscount.status, 200, 'order discount: applied');
        assertEqualOrThrow(stored('orders', onOrder.id), quoted, 'order discount: as quoted');

        const onBill = await place(3);
        const bill = await api(baseUrl, '/api/bills/generate', {
          method: 'POST',
          headers,
          body: { order_id: onBill.id },
        });
        assertEqualOrThrow(bill.status, 201, 'bill discount: the bill is generated');
        const billDiscount = await api(baseUrl, `/api/bills/${bill.data.bill.id}/discount`, {
          method: 'POST',
          headers,
          body: { type: 'percentage', value: 5 },
        });
        assertEqualOrThrow(billDiscount.status, 200, 'bill discount: applied');
        assertEqualOrThrow(stored('bills', bill.data.bill.id), quoted, 'bill discount: as quoted');

        // A later change to the order works the order discount out again.
        const added = await api(baseUrl, `/api/orders/${onOrder.id}/items`, {
          method: 'POST',
          headers,
          body: { items: [{ product_id: productIds['Sample gift card'], quantity: 1 }] },
        });
        assertEqualOrThrow(added.status, 200, 'recalculation: an untaxed 10.00 is added');
        const cancelled = await api(
          baseUrl,
          `/api/orders/${onOrder.id}/items/${added.data.added_item_ids[0]}/cancel`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Idempotency-Key': 'pizza-tax-bc-discount-cancel' },
            body: {},
          },
        );
        assertEqualOrThrow(cancelled.status, 200, 'recalculation: and taken off again');
        assertEqualOrThrow(stored('orders', onOrder.id), quoted, 'recalculation: back to 1.61 off');
      },
    );

    await testCase(
      '13. A line stored before amounts were rounded is discounted as 32.10',
      async () => {
        const side = productIds['Sample side'];
        const db = getDatabase();
        const legacyOrder = async () => {
          const created = await api(baseUrl, '/api/orders', {
            method: 'POST',
            headers,
            body: { type: 'takeaway', items: [{ product_id: side, quantity: 3 }] },
          });
          assertEqualOrThrow(created.status, 201, 'an order of three is created');
          // As the line and the order were stored before this change.
          db.prepare('UPDATE order_items SET subtotal = 32.099999999999994 WHERE order_id = ?').run(
            created.data.order.id,
          );
          db.prepare('UPDATE orders SET subtotal = 32.099999999999994 WHERE id = ?').run(
            created.data.order.id,
          );
          return created.data.order;
        };
        const stored = (table: string, id: number) => {
          const row = db
            .prepare(
              `SELECT subtotal, discount_amount, tax_amount, total FROM ${table} WHERE id = ?`,
            )
            .get(id) as any;
          return JSON.stringify([row.subtotal, row.discount_amount, row.tax_amount, row.total]);
        };
        const asFresh = '[32.1,1.61,1.53,32.02]';

        const onOrder = await legacyOrder();
        const orderDiscount = await api(baseUrl, `/api/orders/${onOrder.id}/discount`, {
          method: 'POST',
          headers,
          body: { discount_type: 'percentage', discount_value: 5 },
        });
        assertEqualOrThrow(orderDiscount.status, 200, 'order discount: applied');
        assertEqualOrThrow(
          stored('orders', onOrder.id),
          asFresh,
          'order discount: 1.61, as a new line',
        );

        const onBill = await legacyOrder();
        const bill = await api(baseUrl, '/api/bills/generate', {
          method: 'POST',
          headers,
          body: { order_id: onBill.id },
        });
        assertEqualOrThrow(bill.status, 201, 'bill discount: the bill is generated');
        const billDiscount = await api(baseUrl, `/api/bills/${bill.data.bill.id}/discount`, {
          method: 'POST',
          headers,
          body: { type: 'percentage', value: 5 },
        });
        assertEqualOrThrow(billDiscount.status, 200, 'bill discount: applied');
        assertEqualOrThrow(stored('bills', bill.data.bill.id), asFresh, 'bill discount: 1.61 too');
      },
    );

    await testCase(
      '14. A flat discount of 1.005 stays 1.01 through every later change',
      async () => {
        // 1.005 is just under 1.005 in binary, so toFixed(2) gives 1.00; discountOn gives 1.01.
        const db = getDatabase();
        db.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('discount_mode', 'both', datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run();
        const created = await order('Sample side');
        const applied = await api(baseUrl, `/api/orders/${created.id}/discount`, {
          method: 'POST',
          headers,
          body: { discount_type: 'amount', discount_value: 1.005 },
        });
        assertEqualOrThrow(applied.status, 200, 'the flat discount is applied');
        const discount = () =>
          JSON.stringify(
            db
              .prepare('SELECT discount_amount, discount_value FROM orders WHERE id = ?')
              .get(created.id),
          );
        const kept = JSON.stringify({ discount_amount: 1.01, discount_value: 1.005 });
        assertEqualOrThrow(discount(), kept, 'applied: 1.01 off, 1.005 configured');

        let edits = 0;
        const edit = async (itemId: number, body: object) => {
          const version = (
            db
              .prepare(
                'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
              )
              .get(created.id, itemId) as any
          ).v;
          return api(baseUrl, `/api/orders/${created.id}/items/${itemId}/edit`, {
            method: 'PATCH',
            headers: { ...headers, 'Idempotency-Key': `pizza-tax-bc-flat-${++edits}` },
            body: { expected_edit_version: version, ...body },
          });
        };
        const liveSide = () =>
          (
            db
              .prepare(
                "SELECT id FROM order_items WHERE order_id = ? AND status = 'pending' AND product_id = ?",
              )
              .get(created.id, productIds['Sample side']) as any
          ).id;

        const added = await api(baseUrl, `/api/orders/${created.id}/items`, {
          method: 'POST',
          headers,
          body: { items: [{ product_id: productIds['Sample gift card'], quantity: 1 }] },
        });
        assertEqualOrThrow(added.status, 200, 'append: an item is added');
        assertEqual(discount(), kept, 'append: still 1.01 off');

        const noted = await edit(liveSide(), {
          replacement: {
            product_id: productIds['Sample side'],
            quantity: 1,
            special_instructions: 'No napkins',
          },
        });
        assertEqualOrThrow(noted.status, 200, 'note edit: accepted');
        assertEqual(discount(), kept, 'note edit: still 1.01 off');

        const two = await edit(liveSide(), { quantity: 2 });
        assertEqualOrThrow(two.status, 200, 'quantity change: accepted');
        assertEqual(discount(), kept, 'quantity change: still 1.01 off');

        const cancelled = await api(
          baseUrl,
          `/api/orders/${created.id}/items/${added.data.added_item_ids[0]}/cancel`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Idempotency-Key': 'pizza-tax-bc-flat-cancel' },
            body: {},
          },
        );
        assertEqualOrThrow(cancelled.status, 200, 'cancel: the added item is taken off');
        assertEqual(discount(), kept, 'cancel: still 1.01 off');
        // Two sides at 10.70 less 1.01 is 20.39; GST 1.07 prorated by 20.39 / 21.40 is 1.02.
        assertEqualOrThrow(
          JSON.stringify(
            db
              .prepare(
                'SELECT subtotal, discount_amount, tax_amount, total FROM orders WHERE id = ?',
              )
              .get(created.id),
          ),
          JSON.stringify({ subtotal: 21.4, discount_amount: 1.01, tax_amount: 1.02, total: 21.41 }),
          'the amount owed counts 1.01 off',
        );
      },
    );

    await testCase('9. The tax configuration is recorded as the owner saving it', () => {
      const audit = getDatabase()
        .prepare(
          `SELECT audit.action, audit.pack_id, user.role
           FROM tax_config_audit AS audit LEFT JOIN users AS user ON user.id = audit.actor_user_id
           WHERE audit.pack_id = 'manual-ca' ORDER BY audit.id`,
        )
        .all();
      assertEqualOrThrow(
        JSON.stringify(audit),
        JSON.stringify([
          { action: 'activate_pack', pack_id: 'manual-ca', role: 'owner' },
          { action: 'save_manual_config', pack_id: 'manual-ca', role: 'owner' },
        ]),
        'the audit table has the activation and the save_manual_config entry, by the owner',
      );
    });
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (failedCases.length > 0) console.error(`Failed cases:\n  ${failedCases.join('\n  ')}`);
  process.exit(failedCases.length > 0 || results.failed > 0 ? 1 : 0);
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
