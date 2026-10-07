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

const { initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api, assertOrThrow, assertEqualOrThrow, now } = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes, allocateMinorUnits, allocateTaxSnapshots, projectOrderItems } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');
const { getCurrencyFractionDigits, getCurrencyMinorUnitFactor, getCurrencyUnitAdapter } = require('../main/countries');

async function main() {
  console.log('--- Currency Split Checks & Minor-Unit Math Test Suite ---');

  // ── 1. Unit Tests: Currency Fraction & Minor Unit Factors ─────────
  console.log('\n1. Currency Fraction & Minor Unit Factors:');
  assertEqualOrThrow(getCurrencyFractionDigits('JPY'), 0, 'JPY fraction digits is 0');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('JPY'), 1, 'JPY minor unit factor is 1');

  assertEqualOrThrow(getCurrencyFractionDigits('KRW'), 0, 'KRW fraction digits is 0');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('KRW'), 1, 'KRW minor unit factor is 1');

  assertEqualOrThrow(getCurrencyFractionDigits('USD'), 2, 'USD fraction digits is 2');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('USD'), 100, 'USD minor unit factor is 100');

  assertEqualOrThrow(getCurrencyFractionDigits('EUR'), 2, 'EUR fraction digits is 2');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('EUR'), 100, 'EUR minor unit factor is 100');

  assertEqualOrThrow(getCurrencyFractionDigits('KWD'), 3, 'KWD fraction digits is 3');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('KWD'), 1000, 'KWD minor unit factor is 1000');

  // Invariance check: IRR with Rial display
  const rialAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'rial' });
  assertEqualOrThrow(rialAdapter.step, '0.01', 'IRR rial adapter preserves step 0.01');
  assertEqualOrThrow(rialAdapter.maxDecimals, 2, 'IRR rial adapter preserves maxDecimals 2');

  // Invariance check: IRR with Toman display
  const tomanAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman' });
  assertEqualOrThrow(tomanAdapter.scale, 0.1, 'IRR toman adapter preserves scale 0.1');
  assertEqualOrThrow(tomanAdapter.step, '0.001', 'IRR toman adapter preserves step 0.001');
  assertEqualOrThrow(tomanAdapter.maxDecimals, 3, 'IRR toman adapter preserves maxDecimals 3');

  // ── 2. Mathematical Allocation: JPY vs USD ───────────────────────
  console.log('\n2. Mathematical Allocation:');
  // JPY 1000 split 3 ways with minorFactor = 1:
  const jpyFactor = getCurrencyMinorUnitFactor('JPY');
  const jpyTotalMinor = Math.round(1000 * jpyFactor);
  const jpyAllocated = allocateMinorUnits(jpyTotalMinor, [1, 1, 1]).map((m) => m / jpyFactor);
  assertEqualOrThrow(JSON.stringify(jpyAllocated), JSON.stringify([334, 333, 333]), '1000 JPY split 3 ways allocates whole yen [334, 333, 333]');
  assertOrThrow(jpyAllocated.every((val) => Number.isInteger(val)), 'Every JPY allocated check is an integer');
  assertEqualOrThrow(jpyAllocated.reduce((a, b) => a + b, 0), 1000, 'Sum of JPY split checks equals 1000 JPY');

  // USD 10.00 split 3 ways with minorFactor = 100:
  const usdFactor = getCurrencyMinorUnitFactor('USD');
  const usdTotalMinor = Math.round(10.00 * usdFactor);
  const usdAllocated = allocateMinorUnits(usdTotalMinor, [1, 1, 1]).map((m) => m / usdFactor);
  assertEqualOrThrow(JSON.stringify(usdAllocated), JSON.stringify([3.34, 3.33, 3.33]), '$10.00 USD split 3 ways allocates [3.34, 3.33, 3.33]');
  assertEqualOrThrow(Number((usdAllocated.reduce((a, b) => a + b, 0)).toFixed(2)), 10.00, 'Sum of USD split checks equals $10.00');

  const jpySnapshot = JSON.stringify({
    lines: [{
      grossAmount: 1000,
      taxableBase: 1000,
      components: [{ amount: 1, rate: 10 }],
    }],
  });
  const jpySnapshots = allocateTaxSnapshots(jpySnapshot, [1, 1], undefined, jpyFactor)
    .map((raw) => JSON.parse(raw));
  assertEqualOrThrow(jpySnapshots[0].lines[0].components[0].amount, 1, 'JPY snapshot keeps one-yen tax on first child');
  assertEqualOrThrow(jpySnapshots[1].lines[0].components[0].amount, 0, 'JPY snapshot allocates zero tax to second child');
  assertEqualOrThrow(jpySnapshots[0].lines[0].taxAmount, 1, 'JPY snapshot taxAmount uses whole-yen units');

  const projectedJpy = projectOrderItems(
    { subtotal: 1000, discount_amount: 0 },
    [{ id: 1, quantity: 1, subtotal: 1000, tax_amount: 1, total: 1001, tax_breakdown: JSON.stringify([{ amount: 1 }]), tax_snapshot: null }],
    [{ order_item_id: 1, quantity: 1 }],
    new Map(),
    jpyFactor,
  )[0];
  assertEqualOrThrow(projectedJpy.tax_amount, 1, 'Projected JPY item tax keeps whole-yen precision');

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
    assertEqualOrThrow(orderRes.status, 201, 'JPY order created');
    const order = orderRes.data.order;
    const ramen = order.items.find((i) => i.product_id === 'jpy-ramen');
    const gyoza = order.items.find((i) => i.product_id === 'jpy-gyoza');

    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order.id },
      headers: authHeader,
    });
    assertEqualOrThrow(billRes.status, 201, 'JPY bill generated');
    assertEqualOrThrow(billRes.data.bill.total, 1400, 'JPY bill total is 1400');

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
    assertEqualOrThrow(splitRes.status, 201, 'JPY check split successfully');
    assertEqualOrThrow(splitRes.data.bills.length, 2, 'Two split bills created');
    assertEqualOrThrow(splitRes.data.bills[0].total, 950, 'Guest 1 bill total is exactly 950 JPY');
    assertEqualOrThrow(splitRes.data.bills[1].total, 450, 'Guest 2 bill total is exactly 450 JPY');
    assertOrThrow(Number.isInteger(splitRes.data.bills[0].total), 'Guest 1 bill total is an integer');
    assertOrThrow(Number.isInteger(splitRes.data.bills[1].total), 'Guest 2 bill total is an integer');

    // Verify DB persistence
    const dbBills = db.prepare('SELECT id, total, subtotal, balance FROM bills WHERE split_group_id = ?').all(splitRes.data.bills[0].split_group_id);
    assertEqualOrThrow(dbBills.length, 2, 'Two bills in split group in DB');
    for (const b of dbBills) {
      assertOrThrow(Number.isInteger(b.total), `Persisted bill ${b.id} total is integer: ${b.total}`);
      assertOrThrow(Number.isInteger(b.subtotal), `Persisted bill ${b.id} subtotal is integer: ${b.subtotal}`);
      assertOrThrow(Number.isInteger(b.balance), `Persisted bill ${b.id} balance is integer: ${b.balance}`);
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
    assertEqualOrThrow(billPlatterRes.data.bill.total, 3000, 'Platter bill total is 3000 JPY');

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
    assertEqualOrThrow(splitPlatterRes.status, 201, '3-way JPY platter split succeeded');
    assertEqualOrThrow(splitPlatterRes.data.bills.length, 3, 'Three bills created');
    for (const b of splitPlatterRes.data.bills) {
      assertEqualOrThrow(b.total, 1000, `Child check ${b.split_label} has total 1000 JPY`);
      assertOrThrow(Number.isInteger(b.total), `Child check ${b.split_label} is integer`);
    }

    // ── 4b. JPY Re-split: settle a guest, divide the untouched remainder ──
    console.log('\n4b. JPY Re-split of an Untouched Remainder:');
    seedProduct(db, 'jpy-sushi', 'jpy-cat', 'Sushi Set', 1000);
    const jpyResplitOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 3,
        items: [{ product_id: 'jpy-sushi', quantity: 3 }],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(jpyResplitOrderRes.status, 201, 'JPY three-guest order created');
    const jpyResplitOrder = jpyResplitOrderRes.data.order;
    const jpySushi = jpyResplitOrder.items[0];
    const jpyResplitBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: jpyResplitOrder.id },
      headers: authHeader,
    });
    assertEqualOrThrow(jpyResplitBillRes.data.bill.total, 3000, 'JPY sushi bill total is 3000');
    const jpyFirstSplit = await api(baseUrl, `/api/bills/${jpyResplitBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'First guest', items: [{ order_item_id: jpySushi.id, quantity: 1 }] },
          { label: 'Waiting guests', items: [{ order_item_id: jpySushi.id, quantity: 2 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(jpyFirstSplit.status, 201, 'JPY first split succeeds');
    assertEqualOrThrow(jpyFirstSplit.data.bills[1].total, 2000, 'the JPY remainder holds 2000');
    const jpyFirstGuestPay = await api(baseUrl, `/api/bills/${jpyFirstSplit.data.bills[0].id}/payments`, {
      method: 'POST',
      body: { payments: [{ method: 'cash', amount: jpyFirstSplit.data.bills[0].total }] },
      headers: authHeader,
    });
    assertEqualOrThrow(jpyFirstGuestPay.status, 200, 'the first JPY guest settles');
    const jpyGroupId = jpyFirstSplit.data.bills[0].split_group_id;
    const jpyGroupBefore = Number((db.prepare('SELECT SUM(total) AS total FROM bills WHERE split_group_id = ?').get(jpyGroupId) as any).total);
    const jpyRemainderId = Number(jpyFirstSplit.data.bills[1].id);
    const jpySettledRowBefore = JSON.stringify(db.prepare('SELECT * FROM bills WHERE id = ?').get(jpyFirstSplit.data.bills[0].id));

    const jpyResplit = await api(baseUrl, `/api/bills/${jpyRemainderId}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'Second guest', items: [{ order_item_id: jpySushi.id, quantity: 1 }] },
          { label: 'Third guest', items: [{ order_item_id: jpySushi.id, quantity: 1 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(jpyResplit.status, 201, 'the untouched JPY remainder splits again');
    assertEqualOrThrow(Number(jpyResplit.data.bills[0].id), jpyRemainderId, 'the JPY remainder keeps its bill id');
    for (const bill of jpyResplit.data.bills) {
      assertEqualOrThrow(bill.total, 1000, `JPY replacement ${bill.split_label} holds exactly 1000`);
      assertOrThrow(Number.isInteger(bill.total) && Number.isInteger(bill.balance), `JPY replacement ${bill.split_label} stays in whole yen`);
    }
    assertEqualOrThrow(Number(jpyResplit.data.bills.reduce((sum: number, bill: any) => sum + bill.total, 0)), 2000, 'JPY replacements sum exactly to the remainder');
    assertEqualOrThrow(
      JSON.stringify(db.prepare('SELECT * FROM bills WHERE id = ?').get(jpyFirstSplit.data.bills[0].id)),
      jpySettledRowBefore,
      'the settled JPY guest bill row is untouched by the later re-split',
    );
    for (const bill of jpyResplit.data.bills) {
      const pay = await api(baseUrl, `/api/bills/${bill.id}/payments`, {
        method: 'POST',
        body: { payments: [{ method: 'cash', amount: bill.total }] },
        headers: authHeader,
      });
      assertEqualOrThrow(pay.status, 200, `JPY replacement ${bill.split_label} settles`);
    }
    assertEqualOrThrow((db.prepare('SELECT status FROM orders WHERE id = ?').get(jpyResplitOrder.id) as any).status, 'completed', 'the JPY order completes after three successive settlements');
    assertEqualOrThrow(Number((db.prepare('SELECT SUM(total) AS total FROM bills WHERE split_group_id = ?').get(jpyGroupId) as any).total), jpyGroupBefore, 'the JPY group total is unchanged by the re-split');
    assertEqualOrThrow(Number((db.prepare('SELECT SUM(paid_amount) AS total FROM bills WHERE split_group_id = ?').get(jpyGroupId) as any).total), jpyGroupBefore, 'the JPY group collects exactly its pre-split total');

    // ── 4c. KWD Re-split: three-decimal currency keeps its precision ──
    console.log('\n4c. KWD Re-split in a Three-Decimal Currency:');
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'KW', ?)").run(now());
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'KWD', ?)").run(now());
    seedCategory(db, 'kwd-cat', 'Kuwait Kitchen');
    seedProduct(db, 'kwd-meal', 'kwd-cat', 'Mixed Grill', 10.001);
    const kwdOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 3,
        items: [{ product_id: 'kwd-meal', quantity: 3 }],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(kwdOrderRes.status, 201, 'KWD three-guest order created');
    const kwdOrder = kwdOrderRes.data.order;
    const kwdMeal = kwdOrder.items[0];
    const kwdBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: kwdOrder.id },
      headers: authHeader,
    });
    assertEqualOrThrow(kwdBillRes.data.bill.total.toFixed(3), '30.003', 'KWD bill total keeps three decimals');
    const kwdFirstSplit = await api(baseUrl, `/api/bills/${kwdBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'KWD first', items: [{ order_item_id: kwdMeal.id, quantity: 1 }] },
          { label: 'KWD waiting', items: [{ order_item_id: kwdMeal.id, quantity: 2 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(kwdFirstSplit.status, 201, 'KWD first split succeeds');
    assertEqualOrThrow(kwdFirstSplit.data.bills[1].total.toFixed(3), '20.002', 'the KWD remainder holds 20.002');
    const kwdFirstPay = await api(baseUrl, `/api/bills/${kwdFirstSplit.data.bills[0].id}/payments`, {
      method: 'POST',
      body: { payments: [{ method: 'cash', amount: '10.001' }] },
      headers: authHeader,
    });
    assertEqualOrThrow(kwdFirstPay.status, 200, 'the first KWD guest settles');
    const kwdResplit = await api(baseUrl, `/api/bills/${kwdFirstSplit.data.bills[1].id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'KWD second', items: [{ order_item_id: kwdMeal.id, quantity: 1 }] },
          { label: 'KWD third', items: [{ order_item_id: kwdMeal.id, quantity: 1 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(kwdResplit.status, 201, 'the untouched KWD remainder splits again');
    for (const bill of kwdResplit.data.bills) {
      assertEqualOrThrow(bill.total.toFixed(3), '10.001', `KWD replacement ${bill.split_label} keeps three-decimal precision`);
    }
    assertEqualOrThrow(Number(kwdResplit.data.bills.reduce((sum: number, bill: any) => sum + bill.total, 0).toFixed(3)), 20.002, 'KWD replacements sum exactly to the remainder');

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
    assertEqualOrThrow(usdBillRes.data.bill.total, 20.00, 'USD bill total is $20.00');

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
    assertEqualOrThrow(usdSplitRes.status, 201, 'USD check split succeeded');
    assertEqualOrThrow(usdSplitRes.data.bills[0].total, 10.00, 'Seat 1 bill is $10.00');
    assertEqualOrThrow(usdSplitRes.data.bills[1].total, 10.00, 'Seat 2 bill is $10.00');

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
