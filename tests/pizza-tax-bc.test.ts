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
    await testCase('1. Setup with the pizza profile, then a three-item menu', async () => {
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
