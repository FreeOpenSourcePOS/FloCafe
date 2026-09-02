const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-currency-split-'));
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const { initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api, assert, assertEqual, now } = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes, allocateMinorUnits, allocateTaxSnapshots, projectOrderItems } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');
const { getCurrencyFractionDigits, getCurrencyMinorUnitFactor, getCurrencyUnitAdapter } = require('../main/countries');

async function main() {
  console.log('--- Currency Split Checks & Minor-Unit Math Test Suite ---');

  // ── 1. Unit Tests: Currency Fraction & Minor Unit Factors ─────────
  console.log('\n1. Currency Fraction & Minor Unit Factors:');
  assertEqual(getCurrencyFractionDigits('JPY'), 0, 'JPY fraction digits is 0');
  assertEqual(getCurrencyMinorUnitFactor('JPY'), 1, 'JPY minor unit factor is 1');

  assertEqual(getCurrencyFractionDigits('KRW'), 0, 'KRW fraction digits is 0');
  assertEqual(getCurrencyMinorUnitFactor('KRW'), 1, 'KRW minor unit factor is 1');

  assertEqual(getCurrencyFractionDigits('USD'), 2, 'USD fraction digits is 2');
  assertEqual(getCurrencyMinorUnitFactor('USD'), 100, 'USD minor unit factor is 100');

  assertEqual(getCurrencyFractionDigits('EUR'), 2, 'EUR fraction digits is 2');
  assertEqual(getCurrencyMinorUnitFactor('EUR'), 100, 'EUR minor unit factor is 100');

  assertEqual(getCurrencyFractionDigits('KWD'), 3, 'KWD fraction digits is 3');
  assertEqual(getCurrencyMinorUnitFactor('KWD'), 1000, 'KWD minor unit factor is 1000');

  // Invariance check: IRR with Rial display
  const rialAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'rial' });
  assertEqual(rialAdapter.step, '0.01', 'IRR rial adapter preserves step 0.01');
  assertEqual(rialAdapter.maxDecimals, 2, 'IRR rial adapter preserves maxDecimals 2');

  // Invariance check: IRR with Toman display
  const tomanAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman' });
  assertEqual(tomanAdapter.scale, 0.1, 'IRR toman adapter preserves scale 0.1');
  assertEqual(tomanAdapter.step, '0.001', 'IRR toman adapter preserves step 0.001');
  assertEqual(tomanAdapter.maxDecimals, 3, 'IRR toman adapter preserves maxDecimals 3');

  // ── 2. Mathematical Allocation: JPY vs USD ───────────────────────
  console.log('\n2. Mathematical Allocation:');
  // JPY 1000 split 3 ways with minorFactor = 1:
  const jpyFactor = getCurrencyMinorUnitFactor('JPY');
  const jpyTotalMinor = Math.round(1000 * jpyFactor);
  const jpyAllocated = allocateMinorUnits(jpyTotalMinor, [1, 1, 1]).map((m) => m / jpyFactor);
  assertEqual(JSON.stringify(jpyAllocated), JSON.stringify([334, 333, 333]), '1000 JPY split 3 ways allocates whole yen [334, 333, 333]');
  assert(jpyAllocated.every((val) => Number.isInteger(val)), 'Every JPY allocated check is an integer');
  assertEqual(jpyAllocated.reduce((a, b) => a + b, 0), 1000, 'Sum of JPY split checks equals 1000 JPY');

  // USD 10.00 split 3 ways with minorFactor = 100:
  const usdFactor = getCurrencyMinorUnitFactor('USD');
  const usdTotalMinor = Math.round(10.00 * usdFactor);
  const usdAllocated = allocateMinorUnits(usdTotalMinor, [1, 1, 1]).map((m) => m / usdFactor);
  assertEqual(JSON.stringify(usdAllocated), JSON.stringify([3.34, 3.33, 3.33]), '$10.00 USD split 3 ways allocates [3.34, 3.33, 3.33]');
  assertEqual(Number((usdAllocated.reduce((a, b) => a + b, 0)).toFixed(2)), 10.00, 'Sum of USD split checks equals $10.00');

  const jpySnapshot = JSON.stringify({
    lines: [{
      grossAmount: 1000,
      taxableBase: 1000,
      components: [{ amount: 1, rate: 10 }],
    }],
  });
  const jpySnapshots = allocateTaxSnapshots(jpySnapshot, [1, 1], undefined, jpyFactor)
    .map((raw) => JSON.parse(raw));
  assertEqual(jpySnapshots[0].lines[0].components[0].amount, 1, 'JPY snapshot keeps one-yen tax on first child');
  assertEqual(jpySnapshots[1].lines[0].components[0].amount, 0, 'JPY snapshot allocates zero tax to second child');
  assertEqual(jpySnapshots[0].lines[0].taxAmount, 1, 'JPY snapshot taxAmount uses whole-yen units');

  const projectedJpy = projectOrderItems(
    { subtotal: 1000, discount_amount: 0 },
    [{ id: 1, quantity: 1, subtotal: 1000, tax_amount: 1, total: 1001, tax_breakdown: JSON.stringify([{ amount: 1 }]), tax_snapshot: null }],
    [{ order_item_id: 1, quantity: 1 }],
    new Map(),
    jpyFactor,
  )[0];
  assertEqual(projectedJpy.tax_amount, 1, 'Projected JPY item tax keeps whole-yen precision');

  // ── 3. End-to-End API Split Check: JPY Store ─────────────────────
  console.log('\n3. End-to-End JPY Split Check via API:');
  const db = initTestDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'false', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('split_checks_enabled', 'true', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'JP', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'JPY', ?)").run(now());

  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'jpy-cat', 'Tokyo Kitchen');
  seedProduct(db, 'jpy-ramen', 'jpy-cat', 'Miso Ramen', 950);
  seedProduct(db, 'jpy-gyoza', 'jpy-cat', 'Gyoza', 450);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/settings': settingsRoutes });
  const { registerRoutes } = require('../main/routes/index');
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    // Create an order in JPY: 1 Ramen (950) + 1 Gyoza (450) = 1400 JPY
    const orderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        items: [
          { product_id: 'jpy-ramen', quantity: 1 },
          { product_id: 'jpy-gyoza', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(orderRes.status, 201, 'JPY order created');
    const order = orderRes.data.order;
    const ramen = order.items.find((i) => i.product_id === 'jpy-ramen');
    const gyoza = order.items.find((i) => i.product_id === 'jpy-gyoza');

    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order.id },
      headers: authHeader,
    });
    assertEqual(billRes.status, 201, 'JPY bill generated');
    assertEqual(billRes.data.bill.total, 1400, 'JPY bill total is 1400');

    // Split check: Guest 1 takes Ramen (950), Guest 2 takes Gyoza (450)
    const splitRes = await api(baseUrl, `/api/bills/${billRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'Guest 1', items: [{ order_item_id: ramen.id, quantity: 1 }] },
          { label: 'Guest 2', items: [{ order_item_id: gyoza.id, quantity: 1 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqual(splitRes.status, 201, 'JPY check split successfully');
    assertEqual(splitRes.data.bills.length, 2, 'Two split bills created');
    assertEqual(splitRes.data.bills[0].total, 950, 'Guest 1 bill total is exactly 950 JPY');
    assertEqual(splitRes.data.bills[1].total, 450, 'Guest 2 bill total is exactly 450 JPY');
    assert(Number.isInteger(splitRes.data.bills[0].total), 'Guest 1 bill total is an integer');
    assert(Number.isInteger(splitRes.data.bills[1].total), 'Guest 2 bill total is an integer');

    // Verify DB persistence
    const dbBills = db.prepare('SELECT id, total, subtotal, balance FROM bills WHERE split_group_id = ?').all(splitRes.data.bills[0].split_group_id);
    assertEqual(dbBills.length, 2, 'Two bills in split group in DB');
    for (const b of dbBills) {
      assert(Number.isInteger(b.total), `Persisted bill ${b.id} total is integer: ${b.total}`);
      assert(Number.isInteger(b.subtotal), `Persisted bill ${b.id} subtotal is integer: ${b.subtotal}`);
      assert(Number.isInteger(b.balance), `Persisted bill ${b.id} balance is integer: ${b.balance}`);
    }

    // ── 4. Uneven Split in JPY: 3-Way Split on Shared Item ────────────
    console.log('\n4. Uneven 3-Way JPY Split on 1,000 JPY Order:');
    seedProduct(db, 'jpy-platter', 'jpy-cat', 'Shared Platter', 1000);
    const orderPlatterRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 3,
        items: [{ product_id: 'jpy-platter', quantity: 3 }],
      },
      headers: authHeader,
    });
    const platterOrder = orderPlatterRes.data.order;
    const platterItem = platterOrder.items[0];
    const billPlatterRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: platterOrder.id },
      headers: authHeader,
    });
    assertEqual(billPlatterRes.data.bill.total, 3000, 'Platter bill total is 3000 JPY');

    const splitPlatterRes = await api(baseUrl, `/api/bills/${billPlatterRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'Guest A', items: [{ order_item_id: platterItem.id, quantity: 1 }] },
          { label: 'Guest B', items: [{ order_item_id: platterItem.id, quantity: 1 }] },
          { label: 'Guest C', items: [{ order_item_id: platterItem.id, quantity: 1 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqual(splitPlatterRes.status, 201, '3-way JPY platter split succeeded');
    assertEqual(splitPlatterRes.data.bills.length, 3, 'Three bills created');
    for (const b of splitPlatterRes.data.bills) {
      assertEqual(b.total, 1000, `Child check ${b.split_label} has total 1000 JPY`);
      assert(Number.isInteger(b.total), `Child check ${b.split_label} is integer`);
    }

    // ── 5. End-to-End USD Split Check Regression ─────────────────────
    console.log('\n5. End-to-End USD Split Check Regression:');
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'US', ?)").run(now());
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'USD', ?)").run(now());

    seedCategory(db, 'usd-cat', 'US Diner');
    seedProduct(db, 'usd-burger', 'usd-cat', 'Cheeseburger', 10.00);

    const usdOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        items: [{ product_id: 'usd-burger', quantity: 2 }],
      },
      headers: authHeader,
    });
    const usdOrder = usdOrderRes.data.order;
    const usdBurgers = usdOrder.items[0];

    const usdBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: usdOrder.id },
      headers: authHeader,
    });
    assertEqual(usdBillRes.data.bill.total, 20.00, 'USD bill total is $20.00');

    const usdSplitRes = await api(baseUrl, `/api/bills/${usdBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'Seat 1', items: [{ order_item_id: usdBurgers.id, quantity: 1 }] },
          { label: 'Seat 2', items: [{ order_item_id: usdBurgers.id, quantity: 1 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqual(usdSplitRes.status, 201, 'USD check split succeeded');
    assertEqual(usdSplitRes.data.bills[0].total, 10.00, 'Seat 1 bill is $10.00');
    assertEqual(usdSplitRes.data.bills[1].total, 10.00, 'Seat 2 bill is $10.00');

    console.log('\n✅ All currency split-check and precision tests passed successfully!');
  } finally {
    server.close();
    db.close();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
