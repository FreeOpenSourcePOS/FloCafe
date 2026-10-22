/**
 * Integration Test: Tax Correctness
 *
 * Verifies a dual-component tax split (5% total — 2.5% + 2.5%) is calculated
 * correctly, especially after discount is applied. This is a compliance risk
 * for real restaurants — incorrect tax filings on real orders.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-tax.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tax-test-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  installAndActivateTestTaxPack,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { registerRoutes } = require('../main/routes/index');
const { resolveTaxComponents } = require('../main/services/tax-components');

/** Operational staff with a live token: authorization resolves from the users row, not the claim. */
function seedStaffUser(db: any, role: string, reuse = false) {
  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const { getJWTSecret } = require('../main/routes/auth');
  const userId = `${role}-test-001`;
  if (!reuse) {
    db.prepare(`
      INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      userId,
      `Test ${role}`,
      `${role}@test.local`,
      bcrypt.hashSync('testpass123', 10),
      role,
      now(),
      now(),
    );
  }
  const token = jwt.sign({ userId, email: `${role}@test.local`, role }, getJWTSecret(), {
    expiresIn: '1h',
  });
  return { Authorization: `Bearer ${token}` };
}
// Same dual-rate / flat-rate structure the real country tax packs use, kept
// generic (no brand-specific tax names) — the country/currency fields stay
// 'IN'/'TH' only so getActiveCountryPack() resolves them and the currency
// (₹/฿) assertions below keep testing real formatting behavior.
const dualRatePackData = require('./fixtures/synthetic-dual-rate-pack.json');
const flatRatePackData = require('./fixtures/synthetic-flat-rate-pack.json');
const indiaTaxPack = { ...dualRatePackData, id: 'test-in-pack', country: 'IN', currency: 'INR' };
const thailandTaxPack = { ...flatRatePackData, id: 'test-th-pack', country: 'TH', currency: 'THB' };

async function main() {
  console.log('Integration Test: Tax Correctness');
  console.log('='.repeat(50));

  const db = initTestDb();

  // Force a dual-rate-tax country's settings
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_type', 'restaurant', ?)",
  ).run(now());
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('state_code', '27', ?)",
  ).run(now());
  installAndActivateTestTaxPack(db, indiaTaxPack);
  installAndActivateTestTaxPack(db, thailandTaxPack);

  // Seed data
  const { authHeader } = seedOwnerUser(db);
  const { authHeader: managerAuth } = seedManagerUser(db);
  seedCategory(db, 'cat-tax', 'Tax Test Menu');
  seedProduct(db, 'prod-tax-1', 'cat-tax', 'Premium Coffee', 1000, {
    tax_category_id: 'standard',
    tax_behavior: 'exclusive',
  });

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
  });
  registerRoutes(app); // adds the inline cancel/restore endpoints used below
  const { baseUrl, server } = await startServer(app);

  try {
    // ── Step 1: Create order and verify initial tax ──────────────────
    console.log('\n1. Create order — verify tax on ₹1000');
    const createRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-tax-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(createRes.status, 201, 'order created');
    const orderId = createRes.data.order.id;

    // India restaurant: fixed 5% tax
    const initialTax = createRes.data.order.tax_amount;
    const initialTotal = createRes.data.order.total;
    assertEqual(createRes.data.order.subtotal, 1000, 'subtotal = ₹1000');
    assertEqual(initialTax, 50, 'tax = ₹50 (5% of ₹1000)');
    assertEqual(initialTotal, 1050, 'total = ₹1050 (₹1000 + ₹50 tax)');

    // ── Step 2: Apply 20% discount and verify tax recalculation ─────
    console.log('\n2. Apply 20% discount — verify tax recalculated on ₹800');
    const discountRes = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 20 },
      headers: authHeader,
    });
    assertEqual(discountRes.status, 200, 'discount applied');
    assertEqual(discountRes.data.order.discount_amount, 200, 'discount = ₹200 (20% of ₹1000)');

    // Tax should be recalculated: 5% of ₹800 = ₹40
    const discountedTax = discountRes.data.order.tax_amount;
    const discountedTotal = discountRes.data.order.total;
    assertEqual(discountedTax, 40, 'tax recalculated = ₹40 (5% of ₹800)');
    assertEqual(discountedTotal, 840, 'total = ₹840 (₹800 + ₹40 tax)');
    const orderDiscountComponents = Array.isArray(discountRes.data.order.tax_breakdown?.[0])
      ? discountRes.data.order.tax_breakdown.flat()
      : discountRes.data.order.tax_breakdown;
    assertEqual(
      Math.round(
        orderDiscountComponents.reduce((sum: number, part: any) => sum + part.amount, 0) * 100,
      ) / 100,
      40,
      'order tax breakdown is scaled to the final discounted tax',
    );

    // ── Step 3: Generate bill and verify tax matches ─────────────────
    console.log('\n3. Generate bill — verify bill tax matches order');
    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderId },
      headers: authHeader,
    });
    assertEqual(billRes.status, 201, 'bill created');
    assertEqual(billRes.data.bill.tax_amount, discountedTax, `bill tax = ₹${discountedTax}`);
    assertEqual(billRes.data.bill.total, discountedTotal, `bill total = ₹${discountedTotal}`);

    // ── Step 4: Verify tax breakdown structure (Tax A + Tax B) ─────────
    console.log('\n4. Verify tax breakdown (Tax A + Tax B)');
    // Check the initial order's tax breakdown (before discount, which has the per-item breakdown)
    const rawBreakdown = createRes.data.order.tax_breakdown;
    assert(rawBreakdown !== null && rawBreakdown !== undefined, 'tax breakdown exists on order');
    if (rawBreakdown) {
      const parsed = typeof rawBreakdown === 'string' ? JSON.parse(rawBreakdown) : rawBreakdown;
      // tax_breakdown is stored as array of per-item breakdowns: [[{title, rate, amount}, ...], ...]
      // Flatten to get all entries
      const allEntries = Array.isArray(parsed[0]) ? parsed.flat() : parsed;
      const taxAEntry = allEntries.find((b: any) => b.title === 'Tax A');
      const taxBEntry = allEntries.find((b: any) => b.title === 'Tax B');
      assert(taxAEntry !== undefined, 'breakdown contains Tax A entry');
      assert(taxBEntry !== undefined, 'breakdown contains Tax B entry');
      // Tax A + Tax B should equal initial tax (₹50 on ₹1000)
      if (taxAEntry && taxBEntry) {
        const totalBreakdownTax = Math.round((taxAEntry.amount + taxBEntry.amount) * 100) / 100;
        assertEqual(
          totalBreakdownTax,
          initialTax,
          `Tax A (₹${taxAEntry.amount}) + Tax B (₹${taxBEntry.amount}) = ₹${initialTax}`,
        );
      }
    }

    // ── Step 5: Categorized product carries a tax_snapshot end to end ────
    console.log('\n5. Categorized product — tax_snapshot persists on item/order/bill');
    seedProduct(db, 'prod-tax-none', 'cat-tax', 'Uncategorized Coffee', 1000, {
      tax_category_id: null,
    });
    seedProduct(db, 'prod-tax-2', 'cat-tax', 'Categorized Latte', 500);
    db.prepare(
      `UPDATE products SET tax_category_id = 'standard', tax_behavior = 'exclusive' WHERE id = 'prod-tax-2'`,
    ).run();

    const mixedOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-tax-none', quantity: 1 }, // no category: tax-free
          { product_id: 'prod-tax-2', quantity: 1 }, // engine path, categorized
        ],
      },
      headers: authHeader,
    });
    assertEqual(mixedOrderRes.status, 201, 'mixed order created');
    const [uncategorizedItem, categorizedItem] = mixedOrderRes.data.order.items;
    assert(!uncategorizedItem.tax_snapshot, 'uncategorized item has no tax_snapshot');
    assertEqual(uncategorizedItem.tax_amount, 0, 'uncategorized item has zero tax');
    assertEqual(
      uncategorizedItem.tax_breakdown.length,
      0,
      'uncategorized item has no tax breakdown',
    );
    assert(!!categorizedItem.tax_snapshot, 'categorized item carries a tax_snapshot');
    const orderSnapshotRaw = mixedOrderRes.data.order.tax_snapshot;
    assert(!!orderSnapshotRaw, 'order rolls up a tax_snapshot from its categorized item');
    const orderSnapshot =
      typeof orderSnapshotRaw === 'string' ? JSON.parse(orderSnapshotRaw) : orderSnapshotRaw;
    assertEqual(
      orderSnapshot.length,
      1,
      'order tax_snapshot has exactly one entry (only the categorized item)',
    );

    // ── Step 6: cancelled taxable items must stay excluded from item-discount recompute ──
    console.log(
      '\n6. Cancel one taxable item, then discount the other - cancelled tax data must stay excluded',
    );
    const itemDiscountOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-tax-1', quantity: 1 },
          { product_id: 'prod-tax-2', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(itemDiscountOrderRes.status, 201, 'item discount regression order created');
    const itemDiscountOrderId = itemDiscountOrderRes.data.order.id;
    const itemDiscountVoidedItem = itemDiscountOrderRes.data.order.items.find(
      (item: any) => item.product_id === 'prod-tax-1',
    );
    const itemDiscountActiveItem = itemDiscountOrderRes.data.order.items.find(
      (item: any) => item.product_id === 'prod-tax-2',
    );

    const cancelRes = await api(
      baseUrl,
      `/api/orders/${itemDiscountOrderId}/items/${itemDiscountVoidedItem.id}/cancel`,
      {
        method: 'PATCH',
        body: {},
        headers: authHeader,
      },
    );
    assertEqual(cancelRes.status, 200, 'taxable item cancelled');

    const itemDiscountRes = await api(
      baseUrl,
      `/api/orders/${itemDiscountOrderId}/items/${itemDiscountActiveItem.id}/discount`,
      {
        method: 'PATCH',
        body: { discount_type: 'percentage', discount_value: 10 }, // 10% of ₹500 = ₹50
        headers: authHeader,
      },
    );
    assertEqual(itemDiscountRes.status, 200, 'item discount applied after sibling cancel');
    assertEqual(itemDiscountRes.data.item.subtotal, 450, 'discounted item subtotal (₹500 - ₹50)');
    const afterOrder = (
      await api(baseUrl, `/api/orders/${itemDiscountOrderId}`, { headers: authHeader })
    ).data.order;
    assertEqual(
      afterOrder.subtotal,
      450,
      "order subtotal excludes the cancelled item — didn't silently un-cancel it",
    );
    assertEqual(afterOrder.tax_amount, 22.5, 'item discount tax uses only the active taxable item');
    const itemDiscountBreakdown = afterOrder.tax_breakdown;
    const itemDiscountBreakdownGroups = Array.isArray(itemDiscountBreakdown?.[0])
      ? itemDiscountBreakdown
      : [itemDiscountBreakdown];
    assertEqual(
      itemDiscountBreakdownGroups.length,
      1,
      'item discount tax breakdown contains only the active item',
    );
    const itemDiscountSnapshot =
      typeof afterOrder.tax_snapshot === 'string'
        ? JSON.parse(afterOrder.tax_snapshot)
        : afterOrder.tax_snapshot;
    assertEqual(
      itemDiscountSnapshot.length,
      1,
      'item discount tax snapshot contains only the active item',
    );

    // -- Step 7: voided items must stay excluded from order-discount tax recompute --
    console.log(
      '\n7. Void one taxable item, then discount the order - void data must stay excluded',
    );
    const voidOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-tax-1', quantity: 1 },
          { product_id: 'prod-tax-2', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(voidOrderRes.status, 201, 'void regression order created');
    const voidOrderId = voidOrderRes.data.order.id;
    const voidedItem = voidOrderRes.data.order.items.find(
      (item: any) => item.product_id === 'prod-tax-1',
    );

    const prepareVoidItemRes = await api(baseUrl, `/api/order-items/${voidedItem.id}/status`, {
      method: 'PATCH',
      body: { status: 'preparing' },
      headers: authHeader,
    });
    assertEqual(prepareVoidItemRes.status, 200, 'taxable item moved to preparing before void');

    const voidItemRes = await api(
      baseUrl,
      `/api/orders/${voidOrderId}/items/${voidedItem.id}/cancel`,
      {
        method: 'PATCH',
        body: { override_pin: '1234' },
        headers: managerAuth,
      },
    );
    assertEqual(voidItemRes.status, 200, 'taxable item voided with manager PIN');

    const discountAfterVoidRes = await api(baseUrl, `/api/orders/${voidOrderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10 },
      headers: authHeader,
    });
    assertEqual(discountAfterVoidRes.status, 200, 'order discount applied after item void');
    assertEqual(
      discountAfterVoidRes.data.order.subtotal,
      500,
      'subtotal excludes the voided taxable item',
    );
    assertEqual(
      discountAfterVoidRes.data.order.discount_amount,
      50,
      'discount uses only the active taxable item',
    );
    assertEqual(
      discountAfterVoidRes.data.order.tax_amount,
      22.5,
      'tax is 5% of the discounted active subtotal',
    );
    assertEqual(
      discountAfterVoidRes.data.order.total,
      472.5,
      'total includes only the discounted active item and its tax',
    );

    const postVoidBreakdown = discountAfterVoidRes.data.order.tax_breakdown;
    const postVoidBreakdownGroups = Array.isArray(postVoidBreakdown?.[0])
      ? postVoidBreakdown
      : [postVoidBreakdown];
    assertEqual(postVoidBreakdownGroups.length, 1, 'tax breakdown contains only the active item');
    const postVoidBreakdownEntries = postVoidBreakdownGroups.flat();
    assertEqual(
      Math.round(
        postVoidBreakdownEntries.reduce((sum: number, part: any) => sum + part.amount, 0) * 100,
      ) / 100,
      22.5,
      'tax breakdown reconciles to the active item tax',
    );
    const postVoidSnapshot =
      typeof discountAfterVoidRes.data.order.tax_snapshot === 'string'
        ? JSON.parse(discountAfterVoidRes.data.order.tax_snapshot)
        : discountAfterVoidRes.data.order.tax_snapshot;
    assertEqual(postVoidSnapshot.length, 1, 'tax snapshot contains only the active item');

    // -- Step 7b: legacy NULL item statuses must stay included in recalculation --
    console.log(
      '\n7b. Discount an order with a legacy NULL item status - item tax must stay included',
    );
    const nullStatusOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-tax-2', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(nullStatusOrderRes.status, 201, 'legacy NULL status regression order created');
    const nullStatusOrderId = nullStatusOrderRes.data.order.id;
    const nullStatusItem = nullStatusOrderRes.data.order.items[0];
    db.prepare('UPDATE order_items SET status = NULL WHERE id = ?').run(nullStatusItem.id);

    const nullStatusDiscountRes = await api(baseUrl, `/api/orders/${nullStatusOrderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10 },
      headers: authHeader,
    });
    assertEqual(
      nullStatusDiscountRes.status,
      200,
      'order discount applied with legacy NULL item status',
    );
    assertEqual(
      nullStatusDiscountRes.data.order.subtotal,
      500,
      'NULL-status item remains in subtotal',
    );
    assertEqual(
      nullStatusDiscountRes.data.order.tax_amount,
      22.5,
      'NULL-status item tax remains included',
    );
    assertEqual(
      nullStatusDiscountRes.data.order.total,
      472.5,
      'total includes discounted NULL-status item and tax',
    );
    const nullStatusSnapshot =
      typeof nullStatusDiscountRes.data.order.tax_snapshot === 'string'
        ? JSON.parse(nullStatusDiscountRes.data.order.tax_snapshot)
        : nullStatusDiscountRes.data.order.tax_snapshot;
    assertEqual(nullStatusSnapshot.length, 1, 'tax snapshot retains the NULL-status item');

    const nullStatusBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: nullStatusOrderId },
      headers: authHeader,
    });
    assertEqual(nullStatusBillRes.status, 201, 'bill created for legacy NULL-status order');
    const nullStatusBillDiscountRes = await api(
      baseUrl,
      `/api/bills/${nullStatusBillRes.data.bill.id}/applyDiscount`,
      {
        method: 'POST',
        body: { type: 'percentage', value: 10 },
        headers: authHeader,
      },
    );
    assertEqual(
      nullStatusBillDiscountRes.status,
      200,
      'bill discount applied with legacy NULL item status',
    );
    assertEqual(
      nullStatusBillDiscountRes.data.bill.tax_amount,
      22.5,
      'bill discount retains tax from the NULL-status item',
    );
    assertEqual(
      nullStatusBillDiscountRes.data.bill.total,
      472.5,
      'bill total includes discounted NULL-status item tax',
    );

    // ── Step 8: bill discount edits must use item tax, not prior bill tax ──
    console.log('\n8. Edit a bill discount — tax must not compound on the prior edit');
    const mixedBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: itemDiscountOrderId },
      headers: authHeader,
    });
    assertEqual(mixedBillRes.status, 201, 'bill generated for discounted categorized order');
    const mixedBillId = mixedBillRes.data.bill.id;

    const billDiscount10 = await api(baseUrl, `/api/bills/${mixedBillId}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 10 },
      headers: authHeader,
    });
    assertEqual(billDiscount10.status, 200, '10% bill discount applied');
    assertEqual(
      billDiscount10.data.bill.tax_amount,
      20.25,
      '10% discount scales original ₹22.50 tax to ₹20.25',
    );

    const billDiscount20 = await api(baseUrl, `/api/bills/${mixedBillId}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 20 },
      headers: authHeader,
    });
    assertEqual(billDiscount20.status, 200, 'bill discount edited to 20%');
    assertEqual(
      billDiscount20.data.bill.tax_amount,
      18,
      '20% edit scales original tax to ₹18 (not prior ₹20.25)',
    );
    assert(!!billDiscount20.data.bill.tax_snapshot, 'bill discount refreshes tax_snapshot');
    const discountedBreakdown = billDiscount20.data.bill.tax_breakdown;
    const discountedComponents = Array.isArray(discountedBreakdown?.[0])
      ? discountedBreakdown.flat()
      : discountedBreakdown;
    assertEqual(
      Math.round(
        discountedComponents.reduce((sum: number, part: any) => sum + part.amount, 0) * 100,
      ) / 100,
      18,
      'bill discount refreshes component amounts to the final tax',
    );

    // ── Step 9: engine-resolved inclusive behavior survives persistence ──
    console.log('\n9. Inclusive categorized product — tax stays inside the displayed price');
    seedProduct(db, 'prod-tax-inclusive', 'cat-tax', 'Inclusive Meal', 105);
    db.prepare(
      `UPDATE products SET tax_category_id = 'standard', tax_behavior = 'inclusive'
       WHERE id = 'prod-tax-inclusive'`,
    ).run();
    const inclusiveOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-tax-inclusive', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(inclusiveOrderRes.status, 201, 'inclusive categorized order created');
    assertEqual(inclusiveOrderRes.data.order.tax_amount, 5, '₹105 inclusive price contains ₹5 tax');
    assertEqual(
      inclusiveOrderRes.data.order.total,
      105,
      'inclusive tax is not added to the ₹105 price',
    );
    assertEqual(
      inclusiveOrderRes.data.order.items[0].tax_type,
      'inclusive',
      'effective engine behavior persisted on item',
    );

    const inclusiveBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: inclusiveOrderRes.data.order.id },
      headers: authHeader,
    });
    const inclusiveDiscountRes = await api(
      baseUrl,
      `/api/bills/${inclusiveBillRes.data.bill.id}/applyDiscount`,
      {
        method: 'POST',
        body: { type: 'percentage', value: 10 },
        headers: authHeader,
      },
    );
    assertEqual(inclusiveDiscountRes.status, 200, 'discount applied to inclusive-tax bill');
    assertEqual(
      inclusiveDiscountRes.data.bill.tax_amount,
      4.5,
      'inclusive tax scales to ₹4.50 after discount',
    );
    // #170: the bill's payable total must reflect the pack's configured payableRounding
    // (0.01 for the bundled IN pack) rather than being force-rounded to a whole rupee.
    assertEqual(
      inclusiveDiscountRes.data.bill.total,
      94.5,
      'inclusive tax is not added again after discount, and total is not force-rounded to a whole unit',
    );

    // ── Step 10: category writes validate and allow explicit no-tax fallback ──
    console.log('\n10. Product/add-on tax category writes are validated and reversible');
    const invalidCategoryRes = await api(baseUrl, '/api/products/prod-tax-2', {
      method: 'PUT',
      body: { tax_category_id: 'does-not-exist' },
      headers: authHeader,
    });
    assertEqual(invalidCategoryRes.status, 400, 'unknown product tax category rejected');

    const clearCategoryRes = await api(baseUrl, '/api/products/prod-tax-2', {
      method: 'PUT',
      body: { tax_category_id: null },
      headers: authHeader,
    });
    assertEqual(clearCategoryRes.status, 200, 'categorized product can return to no tax');
    assertEqual(
      clearCategoryRes.data.product.tax_category_id,
      null,
      'explicit null clears product tax category',
    );

    const invalidAddonCategoryRes = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      body: {
        name: 'Invalid tax add-ons',
        min_selection: 0,
        max_selection: 1,
        addons: [{ name: 'Extra', price: 10, tax_category_id: 'does-not-exist' }],
      },
      headers: authHeader,
    });
    assertEqual(invalidAddonCategoryRes.status, 400, 'unknown add-on tax category rejected');

    const validAddonGroupRes = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      body: {
        name: 'Valid tax add-ons',
        min_selection: 0,
        max_selection: 1,
        addons: [{ name: 'Extra', price: 10, tax_category_id: 'addon' }],
      },
      headers: authHeader,
    });
    assertEqual(validAddonGroupRes.status, 201, 'valid add-on tax category accepted');
    const validAddon = validAddonGroupRes.data.addon_group.addons[0];
    const clearAddonCategoryRes = await api(
      baseUrl,
      `/api/addon-groups/${validAddonGroupRes.data.addon_group.id}/addons/${validAddon.id}`,
      {
        method: 'PUT',
        body: { tax_category_id: null },
        headers: authHeader,
      },
    );
    assertEqual(
      clearAddonCategoryRes.status,
      200,
      'categorized add-on can return to no explicit tax category',
    );
    assertEqual(
      clearAddonCategoryRes.data.addon.tax_category_id,
      null,
      'explicit null clears add-on tax category',
    );

    const legacyCsvRes = await api(baseUrl, '/api/menu-csv/import/products', {
      method: 'POST',
      body: {
        csv: [
          'id,name,category,price,tax_type,tax_rate,is_active',
          'prod-tax-inclusive,Inclusive Meal,Tax Test Menu,105,inclusive,5,yes',
        ].join('\n'),
      },
      headers: authHeader,
    });
    assertEqual(legacyCsvRes.status, 200, 'legacy product CSV still imports');
    assertEqual(
      (
        db
          .prepare("SELECT tax_category_id FROM products WHERE id = 'prod-tax-inclusive'")
          .get() as any
      ).tax_category_id,
      'standard',
      'legacy CSV without new columns preserves an assigned tax category',
    );
    assertEqual(
      (
        db
          .prepare(
            "SELECT tax_type || ':' || tax_rate AS legacy_tax FROM products WHERE id = 'prod-tax-inclusive'",
          )
          .get() as any
      ).legacy_tax,
      'none:0.0',
      'legacy CSV tax_type/tax_rate values are ignored and cleared',
    );

    db.prepare("UPDATE settings SET value = 'US' WHERE key = 'country'").run();
    const genericCategoriesRes = await api(baseUrl, '/api/tax/categories', { headers: authHeader });
    assertEqual(genericCategoriesRes.status, 200, 'generic pack category endpoint responds');
    assertEqual(
      genericCategoriesRes.data.configuration_ready,
      false,
      'rule-less generic pack is not assignable',
    );
    assertEqual(
      genericCategoriesRes.data.categories.length,
      0,
      'rule-less categories cannot migrate products to zero tax',
    );
    const genericCheckoutRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-tax-inclusive', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(
      genericCheckoutRes.status,
      400,
      'country change cannot silently turn a categorized product into zero tax',
    );
    db.prepare("UPDATE settings SET value = 'IN' WHERE key = 'country'").run();

    const clearCategoryCsvRes = await api(baseUrl, '/api/menu-csv/import/products', {
      method: 'POST',
      body: {
        csv: [
          'id,name,category,price,tax_category,tax_behavior,is_active',
          'prod-tax-inclusive,Inclusive Meal,Tax Test Menu,105,,,yes',
        ].join('\n'),
      },
      headers: authHeader,
    });
    assertEqual(
      clearCategoryCsvRes.status,
      200,
      'new product CSV imports explicit blank tax fields',
    );
    assertEqual(
      (
        db
          .prepare("SELECT tax_category_id FROM products WHERE id = 'prod-tax-inclusive'")
          .get() as any
      ).tax_category_id,
      null,
      'blank tax_category in the new CSV format explicitly returns a product to no tax',
    );
    const noTaxCheckoutRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-tax-inclusive', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(noTaxCheckoutRes.status, 201, 'product without a tax category still checks out');
    assertEqual(
      noTaxCheckoutRes.data.order.tax_amount,
      0,
      'product without a tax category has zero tax',
    );
    assertEqual(
      noTaxCheckoutRes.data.order.tax_breakdown.length,
      0,
      'product without a tax category has no order tax breakdown',
    );
    assert(
      !noTaxCheckoutRes.data.order.tax_snapshot,
      'product without a tax category has no order tax snapshot',
    );

    // ── Step 11: payable preview, bill settlement, and payment stay reconciled ──
    console.log('\n11. Tax preview and bill settlement use the same active-pack payable rounding');
    db.prepare("UPDATE settings SET value = 'TH' WHERE key = 'country'").run();
    seedProduct(db, 'prod-tax-th-preview', 'cat-tax', 'Thai Preview Coffee', 60, {
      tax_category_id: 'standard',
      tax_behavior: 'exclusive',
    });

    const decimalPreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: {
        items: [{ product_id: 'prod-tax-th-preview', quantity: 1, addons: [] }],
      },
      headers: authHeader,
    });
    assertEqual(decimalPreview.status, 200, 'Thailand tax preview succeeds');
    assertEqual(decimalPreview.data.summary.subtotal, 60, 'preview subtotal = ฿60.00');
    assertEqual(decimalPreview.data.summary.tax_amount, 4.2, 'preview VAT = ฿4.20');
    assertEqual(
      decimalPreview.data.summary.round_off,
      0,
      '0.01 pack does not force whole-unit rounding',
    );
    assertEqual(decimalPreview.data.summary.total, 64.2, 'preview payable total = ฿64.20');

    const discountedPreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: {
        items: [{ product_id: 'prod-tax-th-preview', quantity: 1, addons: [] }],
        discount_type: 'percentage',
        discount_value: 10,
      },
      headers: authHeader,
    });
    assertEqual(discountedPreview.status, 200, 'discounted Thailand tax preview succeeds');
    assertEqual(discountedPreview.data.summary.discount_amount, 6, 'preview discount = ฿6.00');
    assertEqual(
      discountedPreview.data.summary.discounted_subtotal,
      54,
      'discounted preview subtotal = ฿54.00',
    );
    assertEqual(discountedPreview.data.summary.tax_amount, 3.78, 'discounted preview VAT = ฿3.78');
    assertEqual(discountedPreview.data.summary.total, 57.78, 'discounted preview total = ฿57.78');

    const decimalOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-tax-th-preview', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(decimalOrder.status, 201, 'Thailand order created');
    assertEqual(decimalOrder.data.order.total, 64.2, 'order keeps exact total = ฿64.20');
    assertEqual(
      decimalOrder.data.order.round_off,
      0,
      'order remains unrounded at the commercial-total layer',
    );

    const decimalBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: decimalOrder.data.order.id },
      headers: authHeader,
    });
    assertEqual(decimalBill.status, 201, 'Thailand bill generated');
    assertEqual(
      decimalBill.data.bill.total,
      decimalPreview.data.summary.total,
      'bill total matches authoritative preview',
    );
    assertEqual(
      decimalBill.data.bill.round_off,
      decimalPreview.data.summary.round_off,
      'bill round-off matches authoritative preview',
    );

    const decimalPayment = await api(baseUrl, `/api/bills/${decimalBill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: decimalPreview.data.summary.total },
      headers: authHeader,
    });
    assertEqual(decimalPayment.status, 200, 'full decimal payment accepted');
    assertEqual(decimalPayment.data.bill.payment_status, 'paid', '฿64.20 payment settles the bill');
    assertEqual(decimalPayment.data.bill.balance, 0, 'decimal bill balance = 0');
    const paidDecimalOrder = await api(baseUrl, `/api/orders/${decimalOrder.data.order.id}`, {
      headers: authHeader,
    });
    assertEqual(
      paidDecimalOrder.data.order.status,
      'completed',
      'decimal-total order completes after payment',
    );

    // ── Step 11b: prepaid previews price the same applied charges as checkout ──
    console.log('\n11b. Prepaid charge preview matches the created order and bill');
    const prepaidCharges = [
      {
        id: 'service_charge',
        name: 'Service Charge',
        type: 'percentage',
        value: 10,
        calculation_basis: 'net',
        order_types: ['takeaway'],
        is_optional: true,
        is_default_active: true,
        is_active: true,
      },
      {
        id: 'waived_fee',
        name: 'Waived Fee',
        type: 'fixed',
        value: 2,
        calculation_basis: 'gross',
        order_types: ['takeaway'],
        is_optional: true,
        is_default_active: true,
        is_active: true,
      },
      {
        id: 'optional_retry_fee',
        name: 'Optional Retry Fee',
        type: 'fixed',
        value: 5,
        calculation_basis: 'gross',
        order_types: ['takeaway'],
        is_optional: true,
        is_default_active: false,
        is_active: true,
      },
      {
        id: 'required_fee',
        name: 'Required Fee',
        type: 'fixed',
        value: 3,
        calculation_basis: 'gross',
        order_types: ['takeaway'],
        is_optional: false,
        is_default_active: true,
        is_active: true,
      },
    ];
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('custom_charges', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(prepaidCharges), now());
    const prepaidChargeContext = {
      items: [{ product_id: 'prod-tax-th-preview', quantity: 1, addons: [] }],
      order_type: 'takeaway',
      waived_charge_ids: ['waived_fee'],
      opted_in_charge_ids: ['optional_retry_fee'],
      discount_type: 'percentage',
      discount_value: 10,
    };
    const prepaidChargePreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: prepaidChargeContext,
      headers: authHeader,
    });
    assertEqual(prepaidChargePreview.status, 200, 'charge-aware prepaid preview succeeds');
    const prepaidSummary = prepaidChargePreview.data.summary;
    assertEqual(prepaidSummary.subtotal, 60, 'charge-aware preview uses the item subtotal');
    assertEqual(
      prepaidSummary.discounted_subtotal,
      54,
      'charge-aware preview applies the order discount',
    );
    assertEqual(
      prepaidSummary.tax_amount,
      3.78,
      'charge-aware preview retains discounted item tax',
    );
    assertEqual(
      prepaidSummary.service_charge,
      5.4,
      'percentage service fee uses the discounted net subtotal',
    );
    assertEqual(
      prepaidSummary.charges_breakdown.find((charge: any) => charge.id === 'service_charge').amount,
      5.4,
      'preview returns the resolved service fee',
    );
    assertEqual(
      prepaidSummary.charges_breakdown.find((charge: any) => charge.id === 'waived_fee').amount,
      0,
      'preview returns the waived fee row',
    );
    assertEqual(
      prepaidSummary.charges_breakdown.find((charge: any) => charge.id === 'optional_retry_fee')
        .amount,
      5,
      'preview includes the opted-in fee',
    );
    assertEqual(prepaidSummary.total, 71.18, 'preview includes each custom fee once');

    const prepaidOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        waived_charge_ids: prepaidChargeContext.waived_charge_ids,
        opted_in_charge_ids: prepaidChargeContext.opted_in_charge_ids,
        items: prepaidChargeContext.items,
      },
      headers: authHeader,
    });
    assertEqual(prepaidOrder.status, 201, 'charge-aware prepaid order is created');
    const prepaidDiscount = await api(
      baseUrl,
      `/api/orders/${prepaidOrder.data.order.id}/discount`,
      {
        method: 'PATCH',
        body: { discount_type: 'percentage', discount_value: 10 },
        headers: authHeader,
      },
    );
    assertEqual(prepaidDiscount.status, 200, 'prepaid order discount is applied');
    assertEqual(
      prepaidDiscount.data.order.total,
      prepaidSummary.total,
      'preview matches discounted order total',
    );
    const prepaidBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: prepaidOrder.data.order.id },
      headers: authHeader,
    });
    assertEqual(prepaidBill.status, 201, 'prepaid order bill is generated');
    assertEqual(
      prepaidBill.data.bill.total,
      prepaidSummary.total,
      'preview matches payable bill total',
    );
    const prepaidBillCharges =
      typeof prepaidBill.data.bill.charges_breakdown === 'string'
        ? JSON.parse(prepaidBill.data.bill.charges_breakdown)
        : prepaidBill.data.bill.charges_breakdown;
    assertEqual(prepaidBillCharges.length, 4, 'bill retains the same applied fee rows');

    const invalidChargeContext = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: {
        items: [{ product_id: 'prod-tax-th-preview', quantity: 1, addons: [] }],
        order_type: 'invalid',
      },
      headers: authHeader,
    });
    assertEqual(invalidChargeContext.status, 400, 'invalid charge order types are rejected');

    const manualFallbackBody = {
      items: [{ product_id: 'prod-tax-th-preview', quantity: 1, addons: [] }],
      packaging_charge: 4,
      service_charge: 6,
    };
    const legacyManualPreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: manualFallbackBody,
      headers: authHeader,
    });
    const noMatchingChargePreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: {
        ...manualFallbackBody,
        order_type: 'online',
        waived_charge_ids: [],
        opted_in_charge_ids: [],
      },
      headers: authHeader,
    });
    assertEqual(legacyManualPreview.status, 200, 'legacy manual-charge preview remains available');
    assertEqual(
      noMatchingChargePreview.status,
      200,
      'charge context with no matching definitions succeeds',
    );
    assertEqual(
      noMatchingChargePreview.data.summary.packaging_charge,
      4,
      'manual packaging amount survives an unmatched charge context',
    );
    assertEqual(
      noMatchingChargePreview.data.summary.service_charge,
      6,
      'manual service amount survives an unmatched charge context',
    );
    assertEqual(
      noMatchingChargePreview.data.summary.total,
      legacyManualPreview.data.summary.total,
      'unmatched charge context preserves legacy pricing',
    );
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('custom_charges', '[]', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(now());

    const activeThailandVersion = db
      .prepare(`
      SELECT version.id, version.pack_json
      FROM country_packs AS pack
      JOIN country_pack_versions AS version ON version.id = pack.active_version_id
      WHERE pack.id = 'test-th-pack'
    `)
      .get() as { id: string; pack_json: string };
    const coarsePack = JSON.parse(activeThailandVersion.pack_json);
    coarsePack.payableRounding = { increment: '1', method: 'half_up' };
    db.prepare('UPDATE country_pack_versions SET pack_json = ? WHERE id = ?').run(
      JSON.stringify(coarsePack),
      activeThailandVersion.id,
    );

    const coarsePreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: {
        items: [{ product_id: 'prod-tax-th-preview', quantity: 1, addons: [] }],
      },
      headers: authHeader,
    });
    assertEqual(coarsePreview.status, 200, 'coarse-rounding tax preview succeeds');
    assertEqual(
      coarsePreview.data.summary.tax_amount,
      4.2,
      'coarse pack leaves VAT component unchanged',
    );
    assertEqual(
      coarsePreview.data.summary.round_off,
      -0.2,
      'coarse pack exposes its -฿0.20 settlement adjustment',
    );
    assertEqual(
      coarsePreview.data.summary.total,
      64,
      'coarse pack preview rounds payable total to ฿64.00',
    );

    const coarseOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-tax-th-preview', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(coarseOrder.status, 201, 'coarse-pack order created');
    assertEqual(
      coarseOrder.data.order.total,
      64.2,
      'coarse pack still keeps the order total exact',
    );
    assertEqual(coarseOrder.data.order.round_off, 0, 'coarse pack does not round the order layer');

    const coarseBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: coarseOrder.data.order.id },
      headers: authHeader,
    });
    assertEqual(coarseBill.status, 201, 'coarse-pack bill generated');
    assertEqual(
      coarseBill.data.bill.total,
      coarsePreview.data.summary.total,
      'coarse bill total matches preview',
    );
    assertEqual(
      coarseBill.data.bill.round_off,
      coarsePreview.data.summary.round_off,
      'coarse bill adjustment matches preview',
    );

    const coarsePayment = await api(baseUrl, `/api/bills/${coarseBill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: coarsePreview.data.summary.total },
      headers: authHeader,
    });
    assertEqual(coarsePayment.status, 200, 'coarse rounded payment accepted');
    assertEqual(
      coarsePayment.data.bill.payment_status,
      'paid',
      '฿64.00 payment settles the coarse-rounded bill',
    );
    assertEqual(coarsePayment.data.bill.balance, 0, 'coarse-rounded bill balance = 0');

    db.prepare('UPDATE country_pack_versions SET pack_json = ? WHERE id = ?').run(
      activeThailandVersion.pack_json,
      activeThailandVersion.id,
    );
    db.prepare("UPDATE settings SET value = 'IN' WHERE key = 'country'").run();

    // ── Step 12: an ordinary cashier and server can still price a basket ──
    // The POS prepaid-checkout modal previews tax on every cart change, so a
    // 403 here would also trip the API client's global auth-context refresh.
    console.log('\n12. Tax preview stays open to operational staff');
    for (const role of ['cashier', 'server']) {
      const staffAuth = seedStaffUser(db, role);
      const staffPreview = await api(baseUrl, '/api/tax/preview', {
        method: 'POST',
        body: { items: [{ product_id: 'prod-tax-1', quantity: 1, addons: [] }] },
        headers: staffAuth,
      });
      assertEqual(staffPreview.status, 200, `${role} can price a basket`);
      assertEqual(staffPreview.data.summary.subtotal, 1000, `${role} preview subtotal = ₹1000.00`);
      assertEqual(staffPreview.data.summary.tax_amount, 50, `${role} preview CGST+SGST = ₹50.00`);
      assertEqual(
        staffPreview.data.summary.total,
        1050,
        `${role} preview payable total = ₹1050.00`,
      );
    }

    const noAuthPreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: { items: [{ product_id: 'prod-tax-1', quantity: 1 }] },
    });
    assertEqual(noAuthPreview.status, 401, 'an unauthenticated caller cannot price a basket');

    // Denying every sale permission is what actually closes the endpoint.
    const ownerOverride = db
      .prepare(`
      INSERT INTO role_permission_overrides (role, permission_id, effect, updated_by, created_at, updated_at)
      VALUES ('cashier', 'pos.use', 'deny', ?, ?, ?)
    `)
      .run('owner-test-001', now(), now());
    const cashierAuth = seedStaffUser(db, 'cashier', true);
    db.prepare(`
      INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
      VALUES ('cashier-test-001', 'orders.create', 'deny', ?, ?, ?)
    `).run('owner-test-001', now(), now());
    const deniedPreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: { items: [{ product_id: 'prod-tax-1', quantity: 1, addons: [] }] },
      headers: cashierAuth,
    });
    assertEqual(
      deniedPreview.status,
      403,
      'a cashier denied every sale permission loses basket pricing',
    );
    assertEqual(
      deniedPreview.data.code,
      'permission_denied',
      'the refusal carries the code the API client reacts to',
    );
    db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run('cashier-test-001');
    db.prepare('DELETE FROM role_permission_overrides WHERE rowid = ?').run(
      ownerOverride.lastInsertRowid,
    );

    // ── Step 13: Full HTTP lifecycle with signed official-india (100.10 + 100.10) ────
    console.log('\n13. Signed official-india document tax rounding end-to-end lifecycle');
    const officialIndiaPack = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, 'fixtures/legacy-tax-packs/official-india.json'),
        'utf8',
      ),
    );
    installAndActivateTestTaxPack(db, officialIndiaPack);
    db.prepare("UPDATE country_packs SET status = 'inactive' WHERE id = 'test-in-pack'").run();
    db.prepare("UPDATE settings SET value = 'IN' WHERE key = 'country'").run();
    db.prepare("UPDATE settings SET value = 'restaurant' WHERE key = 'business_type'").run();
    db.prepare("UPDATE settings SET value = '27' WHERE key = 'state_code'").run();

    seedProduct(db, 'prod-doc-1', 'cat-tax', 'Doc Item 1', 100.1, {
      tax_category_id: 'standard',
      tax_behavior: 'exclusive',
    });
    seedProduct(db, 'prod-doc-2', 'cat-tax', 'Doc Item 2', 100.1, {
      tax_category_id: 'standard',
      tax_behavior: 'exclusive',
    });
    db.prepare(
      "INSERT OR IGNORE INTO tables (id, number, status) VALUES ('tbl-doc-1', 'D-1', 'available')",
    ).run();

    // 1. Preview
    const docPreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: {
        items: [
          { product_id: 'prod-doc-1', quantity: 1, addons: [] },
          { product_id: 'prod-doc-2', quantity: 1, addons: [] },
        ],
      },
      headers: authHeader,
    });
    assertEqual(docPreview.status, 200, 'doc tax preview succeeds');
    assertEqual(docPreview.data.summary.subtotal, 200.2, 'preview subtotal = 200.20');
    assertEqual(
      docPreview.data.summary.tax_amount,
      10.01,
      'preview tax_amount = 10.01 under document rounding',
    );
    assertEqual(docPreview.data.summary.total, 210.21, 'preview payable total = 210.21');

    // 2. Order creation
    const docOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        table_id: 'tbl-doc-1',
        items: [
          { product_id: 'prod-doc-1', quantity: 1 },
          { product_id: 'prod-doc-2', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(docOrder.status, 201, 'doc order created');
    assertEqual(docOrder.data.order.subtotal, 200.2, 'order subtotal = 200.20');
    assertEqual(docOrder.data.order.tax_amount, 10.01, 'order tax_amount = 10.01');
    assertEqual(docOrder.data.order.total, 210.21, 'order total = 210.21');

    // 3. Bill generation
    const docBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: docOrder.data.order.id },
      headers: authHeader,
    });
    assertEqual(docBill.status, 201, 'doc bill generated');
    assertEqual(docBill.data.bill.subtotal, 200.2, 'bill subtotal = 200.20');
    assertEqual(docBill.data.bill.tax_amount, 10.01, 'bill tax_amount = 10.01');
    assertEqual(docBill.data.bill.total, 210.21, 'bill total = 210.21');

    // resolveTaxComponents(bill)
    const components = resolveTaxComponents({
      ...docBill.data.bill,
      items: docOrder.data.order.items,
    });
    const cgstComponent = components.find((c: any) => c.title === 'CGST');
    const sgstComponent = components.find((c: any) => c.title === 'SGST');
    assert(!!cgstComponent, 'CGST component present');
    assert(!!sgstComponent, 'SGST component present');
    assertEqual(cgstComponent.amount, 5.0, 'resolveTaxComponents CGST = 5.00');
    assertEqual(sgstComponent.amount, 5.01, 'resolveTaxComponents SGST = 5.01');
    assertEqual(
      Number((cgstComponent.amount + sgstComponent.amount).toFixed(2)),
      10.01,
      'CGST + SGST = 10.01',
    );

    // 4. Payment
    const docPayment = await api(baseUrl, `/api/bills/${docBill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 210.21 },
      headers: authHeader,
    });
    assertEqual(docPayment.status, 200, 'doc bill payment accepted');
    assertEqual(docPayment.data.bill.payment_status, 'paid', 'bill is settled');

    // 5. Reports tax-components
    const docReport = await api(baseUrl, '/api/reports/tax-components', {
      headers: authHeader,
    });
    assertEqual(docReport.status, 200, 'tax-components report succeeds');
    const reportComponents = docReport.data.taxComponents?.components || [];
    const reportCgst = reportComponents.find((c: any) => c.title === 'CGST');
    const reportSgst = reportComponents.find((c: any) => c.title === 'SGST');
    assert(!!reportCgst, 'report has CGST');
    assert(!!reportSgst, 'report has SGST');
    assertEqual(reportCgst.amount, 5.0, 'report CGST = 5.00');
    assertEqual(reportSgst.amount, 5.01, 'report SGST = 5.01');

    console.log('\n13b. Signed official-india document tax rounding across items and charges');
    db.prepare(`
      INSERT INTO tax_overrides (id, pack_version_id, entity_type, entity_id, field_name, value_json, created_at, updated_at)
      SELECT 'ovr-pkg-std', pack.active_version_id, 'packaging', NULL, 'tax_category_id', '"standard"', datetime('now'), datetime('now')
      FROM country_packs AS pack WHERE pack.id = 'official-india'
      ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run();

    const itemChargePreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: {
        items: [{ product_id: 'prod-doc-1', quantity: 1, addons: [] }],
        packaging_charge: 100.1,
      },
      headers: authHeader,
    });
    assertEqual(itemChargePreview.status, 200, 'item + charge preview succeeds');
    assertEqual(itemChargePreview.data.summary.subtotal, 100.1, 'preview item subtotal = 100.10');
    assertEqual(
      itemChargePreview.data.summary.packaging_charge,
      100.1,
      'preview packaging charge = 100.10',
    );
    assertEqual(
      itemChargePreview.data.summary.tax_amount,
      10.01,
      'preview tax across item + charge = 10.01 under document rounding',
    );
    assertEqual(itemChargePreview.data.summary.total, 210.21, 'preview total = 210.21');

    const itemChargeOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        packaging_charge: 100.1,
        items: [{ product_id: 'prod-doc-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(itemChargeOrder.status, 201, 'item + charge order created');
    assertEqual(itemChargeOrder.data.order.subtotal, 100.1, 'order item subtotal = 100.10');
    assertEqual(
      itemChargeOrder.data.order.packaging_charge,
      100.1,
      'order packaging charge = 100.10',
    );
    assertEqual(
      itemChargeOrder.data.order.tax_amount,
      10.01,
      'order tax_amount across item + charge = 10.01',
    );
    assertEqual(itemChargeOrder.data.order.total, 210.21, 'order total = 210.21');

    const itemChargeBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: itemChargeOrder.data.order.id },
      headers: authHeader,
    });
    assertEqual(itemChargeBill.status, 201, 'item + charge bill generated');
    assertEqual(itemChargeBill.data.bill.subtotal, 100.1, 'bill subtotal = 100.10');
    assertEqual(itemChargeBill.data.bill.tax_amount, 10.01, 'bill tax_amount = 10.01');
    assertEqual(itemChargeBill.data.bill.total, 210.21, 'bill total = 210.21');

    // ── Step 14: Order & item mutations under scope: document ──────────
    console.log('\n14. Order and item mutations under document tax rounding');
    const mutOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        table_id: 'tbl-doc-1',
        items: [{ product_id: 'prod-doc-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(mutOrderRes.status, 201, 'mutation order created with 1 item');
    const mutOrderId = mutOrderRes.data.order.id;
    const initialItem1 = mutOrderRes.data.order.items[0];
    assertEqual(mutOrderRes.data.order.tax_amount, 5.01, 'initial 1-item tax = 5.01');
    assertEqual(mutOrderRes.data.order.total, 105.11, 'initial 1-item total = 105.11');

    // a. Add item
    const addItemRes = await api(baseUrl, `/api/orders/${mutOrderId}/items`, {
      method: 'POST',
      body: {
        items: [{ product_id: 'prod-doc-2', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(addItemRes.status, 200, 'added 2nd item to order');
    assertEqual(addItemRes.data.order.tax_amount, 10.01, '2-item order tax reconciled to 10.01');
    assertEqual(addItemRes.data.order.total, 210.21, '2-item order total reconciled to 210.21');
    const item2 = addItemRes.data.order.items.find((it: any) => it.product_id === 'prod-doc-2');

    // b. Cancel item
    const cancelItemRes = await api(baseUrl, `/api/orders/${mutOrderId}/items/${item2.id}/cancel`, {
      method: 'PATCH',
      headers: authHeader,
    });
    assertEqual(cancelItemRes.status, 200, 'item 2 cancelled');
    assertEqual(
      cancelItemRes.data.order.tax_amount,
      5.01,
      'cancelled item excluded, remaining tax = 5.01',
    );
    assertEqual(
      cancelItemRes.data.order.total,
      105.11,
      'cancelled item excluded, remaining total = 105.11',
    );

    // c. Restore item
    const restoreItemRes = await api(
      baseUrl,
      `/api/orders/${mutOrderId}/items/${item2.id}/restore`,
      {
        method: 'PATCH',
        headers: authHeader,
        body: {},
      },
    );
    assertEqual(restoreItemRes.status, 200, 'item 2 restored');
    assertEqual(restoreItemRes.data.order.tax_amount, 10.01, 'restored order tax = 10.01');
    assertEqual(restoreItemRes.data.order.total, 210.21, 'restored order total = 210.21');

    // d. Void item
    const prepRes = await api(baseUrl, `/api/order-items/${item2.id}/status`, {
      method: 'PATCH',
      body: { status: 'preparing' },
      headers: authHeader,
    });
    assertEqual(prepRes.status, 200, 'item 2 moved to preparing');
    const voidRes = await api(baseUrl, `/api/orders/${mutOrderId}/items/${item2.id}/cancel`, {
      method: 'PATCH',
      body: { override_pin: '1234' },
      headers: authHeader,
    });
    assertEqual(voidRes.status, 200, 'item 2 voided');
    assertEqual(voidRes.data.order.tax_amount, 5.01, 'voided item excluded, remaining tax = 5.01');

    // e. Edit item
    const editRes = await api(baseUrl, `/api/orders/${mutOrderId}/items/${initialItem1.id}/edit`, {
      method: 'PATCH',
      headers: { ...authHeader, 'Idempotency-Key': 'edit-doc-test-1' },
      body: { quantity: 2, expected_edit_version: 0 },
    });
    assertEqual(editRes.status, 200, 'item 1 quantity edited to 2');
    assertEqual(editRes.data.order.subtotal, 200.2, 'edited subtotal = 200.20');
    assertEqual(editRes.data.order.tax_amount, 10.01, 'edited tax = 10.01');
    assertEqual(editRes.data.order.total, 210.21, 'edited total = 210.21');

    // f. Item discount
    const itemToDiscount = editRes.data.order.items.find(
      (it: any) => !['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(it.status),
    );
    const itemDiscRes = await api(
      baseUrl,
      `/api/orders/${mutOrderId}/items/${itemToDiscount.id}/discount`,
      {
        method: 'PATCH',
        body: { discount_type: 'percentage', discount_value: 10 },
        headers: authHeader,
      },
    );
    assertEqual(itemDiscRes.status, 200, 'item discount applied');
    const afterItemDiscOrder = (
      await api(baseUrl, `/api/orders/${mutOrderId}`, { headers: authHeader })
    ).data.order;
    assert(afterItemDiscOrder.tax_amount > 0, 'tax recalculated after item discount');

    // g. Order discount
    const orderDiscRes = await api(baseUrl, `/api/orders/${mutOrderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10 },
      headers: authHeader,
    });
    assertEqual(orderDiscRes.status, 200, 'order discount applied');
    assert(orderDiscRes.data.order.tax_amount > 0, 'tax scaled after order discount');

    // h. Bill discount
    const mutBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: mutOrderId },
      headers: authHeader,
    });
    assertEqual(mutBillRes.status, 201, 'bill generated for discounted order');
    const billDiscRes = await api(baseUrl, `/api/bills/${mutBillRes.data.bill.id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 10 },
      headers: authHeader,
    });
    assertEqual(billDiscRes.status, 200, 'bill discount applied');

    // i. Bill split
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('split_checks_enabled', 'true', ?)",
    ).run(now());
    const splitOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        table_id: 'tbl-doc-1',
        items: [
          { product_id: 'prod-doc-1', quantity: 1 },
          { product_id: 'prod-doc-2', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(splitOrderRes.status, 201, 'split order created');
    const splitBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: splitOrderRes.data.order.id },
      headers: authHeader,
    });
    assertEqual(splitBillRes.status, 201, 'split bill generated');
    const splitItems = splitOrderRes.data.order.items;
    const splitCheckRes = await api(
      baseUrl,
      `/api/bills/${splitBillRes.data.bill.id}/split-check`,
      {
        method: 'POST',
        body: {
          checks: [
            { label: 'Guest 1', items: [{ order_item_id: splitItems[0].id, quantity: 1 }] },
            { label: 'Guest 2', items: [{ order_item_id: splitItems[1].id, quantity: 1 }] },
          ],
        },
        headers: authHeader,
      },
    );
    assertEqual(splitCheckRes.status, 201, 'bill split succeeded');
    assertEqual(splitCheckRes.data.bills.length, 2, 'split produced 2 guest checks');
    for (const childBill of splitCheckRes.data.bills) {
      assertEqual(childBill.subtotal, 100.1, 'child bill subtotal = 100.10');
      assert(childBill.tax_amount > 0, 'child bill carries allocated tax');
    }

    // ── Step 14b: Takeaway conversion and mutations with charges under scope: document ──
    console.log('\n14b. Takeaway conversion and item addition with charges');
    const takeawayCharges = [
      {
        id: 'packaging_charge',
        name: 'Packaging Charge',
        type: 'fixed',
        value: 100.1,
        calculation_basis: 'gross',
        order_types: ['takeaway'],
        is_optional: false,
        is_default_active: true,
        is_active: true,
      },
    ];
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('custom_charges', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(takeawayCharges), now());

    const dineInOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        table_id: 'tbl-doc-1',
        items: [{ product_id: 'prod-doc-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(dineInOrderRes.status, 201, 'dine-in order created');
    assertEqual(dineInOrderRes.data.order.packaging_charge, 0, 'dine-in packaging charge = 0');
    assertEqual(dineInOrderRes.data.order.tax_amount, 5.01, 'dine-in tax = 5.01');

    const convertRes = await api(
      baseUrl,
      `/api/orders/${dineInOrderRes.data.order.id}/convert-to-takeaway`,
      {
        method: 'PATCH',
        headers: authHeader,
      },
    );
    assertEqual(convertRes.status, 200, 'converted to takeaway');
    assertEqual(
      convertRes.data.order.packaging_charge,
      100.1,
      'takeaway resolved packaging charge = 100.10',
    );
    assertEqual(
      convertRes.data.order.tax_amount,
      10.01,
      'takeaway conversion calculates packaging charge tax unified with item',
    );
    assertEqual(convertRes.data.order.total, 210.21, 'takeaway total = 210.21');

    const addTakeawayItemRes = await api(
      baseUrl,
      `/api/orders/${dineInOrderRes.data.order.id}/items`,
      {
        method: 'POST',
        body: {
          items: [{ product_id: 'prod-doc-2', quantity: 1 }],
        },
        headers: authHeader,
      },
    );
    assertEqual(addTakeawayItemRes.status, 200, 'item added to takeaway order');
    assertEqual(addTakeawayItemRes.data.order.subtotal, 200.2, 'updated subtotal = 200.20');
    assertEqual(
      addTakeawayItemRes.data.order.packaging_charge,
      100.1,
      'packaging charge preserved',
    );
    assertEqual(
      addTakeawayItemRes.data.order.tax_amount,
      15.02,
      'updated order tax across items + packaging charge = 15.02',
    );
    assertEqual(addTakeawayItemRes.data.order.total, 315.32, 'updated order total = 315.32');

    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('custom_charges', '[]', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(now());

    // ── Step 15: Untaxed lines, overrides, and zero-price items ────────
    console.log('\n15. Edge cases: untaxed lines, overrides, and zero-price items');

    // Existing untaxed item does not absorb document rounding remainders
    seedProduct(db, 'prod-untaxed', 'cat-tax', 'Untaxed Item', 100.1, {
      tax_type: 'none',
      tax_rate: 0,
    });
    const s15MixedOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-doc-1', quantity: 1 },
          { product_id: 'prod-untaxed', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(s15MixedOrderRes.status, 201, 'mixed order created');
    assertEqual(s15MixedOrderRes.data.order.subtotal, 200.2, 'subtotal = 200.20');
    assertEqual(s15MixedOrderRes.data.order.tax_amount, 5.01, 'only taxed line generates tax');
    const s15UntaxedItem = s15MixedOrderRes.data.order.items.find(
      (it: any) => it.product_id === 'prod-untaxed',
    );
    assertEqual(s15UntaxedItem.tax_amount, 0, 'untaxed line tax = 0');
    assertEqual(s15UntaxedItem.tax_snapshot, null, 'untaxed line has null snapshot');

    // Add another item to trigger order recomputation across existing items
    const s15RecomputeMixedRes = await api(
      baseUrl,
      `/api/orders/${s15MixedOrderRes.data.order.id}/items`,
      {
        method: 'POST',
        body: {
          items: [{ product_id: 'prod-doc-2', quantity: 1 }],
        },
        headers: authHeader,
      },
    );
    assertEqual(s15RecomputeMixedRes.status, 200, 'item added to mixed order');
    const s15RecomputedUntaxed = s15RecomputeMixedRes.data.order.items.find(
      (it: any) => it.product_id === 'prod-untaxed',
    );
    assertEqual(
      s15RecomputedUntaxed.tax_amount,
      0,
      'untaxed line still has 0 tax after recomputation',
    );
    assertEqual(s15RecomputedUntaxed.tax_snapshot, null, 'untaxed line still has null snapshot');
    assertEqual(
      s15RecomputeMixedRes.data.order.tax_amount,
      10.01,
      'two taxed lines receive document rounded 10.01 tax',
    );
    assertEqual(
      s15RecomputeMixedRes.data.order.total,
      310.31,
      'total = 300.30 subtotal + 10.01 tax',
    );

    // Subsequent override changes do not reprice existing snapshotted items
    const s15OverrideOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-doc-1', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(s15OverrideOrderRes.status, 201, 'override test order created');
    assertEqual(s15OverrideOrderRes.data.order.tax_amount, 5.01, 'initial item tax = 5.01');

    // Merchant adds an override for prod-doc-1 changing category to exempt
    const s15ActivePackVersion = (
      db
        .prepare("SELECT active_version_id FROM country_packs WHERE id = 'official-india'")
        .get() as any
    )?.active_version_id;
    db.prepare(`
      INSERT INTO tax_overrides (id, pack_version_id, entity_type, entity_id, field_name, value_json, created_at, updated_at)
      VALUES (?, ?, 'product', 'prod-doc-1', 'tax_category_id', ?, ?, ?)
    `).run(
      'override-prod-doc-1',
      s15ActivePackVersion,
      JSON.stringify({ categoryId: 'exempt' }),
      now(),
      now(),
    );

    // Trigger recomputation on existing order by applying a 0-value discount
    const s15PatchedOrderRes = await api(
      baseUrl,
      `/api/orders/${s15OverrideOrderRes.data.order.id}/discount`,
      {
        method: 'PATCH',
        body: { discount_type: 'amount', discount_value: 0 },
        headers: authHeader,
      },
    );
    assertEqual(s15PatchedOrderRes.status, 200, 'discount patched');
    assertEqual(
      s15PatchedOrderRes.data.order.tax_amount,
      5.01,
      'existing snapshotted item preserves historical category and is not repriced by new override',
    );
    const s15FetchedOrder = (
      await api(baseUrl, `/api/orders/${s15OverrideOrderRes.data.order.id}`, {
        headers: authHeader,
      })
    ).data.order;
    const s15PatchedItem = s15FetchedOrder.items[0];
    const s15PatchedSnapshot =
      typeof s15PatchedItem.tax_snapshot === 'string'
        ? JSON.parse(s15PatchedItem.tax_snapshot)
        : s15PatchedItem.tax_snapshot;
    assertEqual(
      s15PatchedSnapshot.lines[0].categoryId,
      'standard',
      'saved tax snapshot preserves standard category',
    );

    // Clean up the override
    db.prepare("DELETE FROM tax_overrides WHERE id = 'override-prod-doc-1'").run();

    // Zero-price categorized item receives tax snapshots without error
    seedProduct(db, 'prod-free', 'cat-tax', 'Free Promotion', 0, {
      tax_category_id: 'standard',
      tax_behavior: 'exclusive',
    });
    const s15FreePreview = await api(baseUrl, '/api/tax/preview', {
      method: 'POST',
      body: {
        items: [{ product_id: 'prod-free', quantity: 1, addons: [] }],
      },
      headers: authHeader,
    });
    assertEqual(s15FreePreview.status, 200, 'preview succeeds for free categorized item');
    assertEqual(s15FreePreview.data.summary.subtotal, 0, 'free item subtotal = 0');
    assertEqual(s15FreePreview.data.items[0].tax_amount, 0, 'free item tax = 0');
    assertEqual(
      Array.isArray(s15FreePreview.data.items[0].tax_breakdown),
      true,
      'free categorized item has tax breakdown',
    );

    const s15FreeOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-free', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(s15FreeOrderRes.status, 201, 'free order created');
    assertEqual(s15FreeOrderRes.data.order.items[0].subtotal, 0, 'free order item subtotal = 0');
    assertEqual(
      Boolean(s15FreeOrderRes.data.order.items[0].tax_snapshot),
      true,
      'free categorized item receives tax snapshot without being skipped',
    );

    // ── Step 16: Open order mutations survive active tax pack category rename/rate change ────
    console.log(
      '\n16. Open order mutations survive active tax pack category rename and rate change',
    );
    const s16OrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-doc-1', quantity: 1 },
          { product_id: 'prod-doc-2', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqual(s16OrderRes.status, 201, 's16 order created');
    assertEqual(s16OrderRes.data.order.subtotal, 200.2, 's16 order subtotal = 200.20');
    assertEqual(s16OrderRes.data.order.tax_amount, 10.01, 's16 order tax = 10.01');
    assertEqual(s16OrderRes.data.order.total, 210.21, 's16 order total = 210.21');
    const s16OrderId = s16OrderRes.data.order.id;
    const s16Item2Id = s16OrderRes.data.order.items.find(
      (it: any) => it.product_id === 'prod-doc-2',
    )?.id;

    const s16ActiveVersionId = (
      db
        .prepare("SELECT active_version_id FROM country_packs WHERE id = 'official-india'")
        .get() as any
    )?.active_version_id;

    db.prepare(
      "UPDATE tax_categories SET id = 'standard_renamed' WHERE id = 'standard' AND pack_version_id = ?",
    ).run(s16ActiveVersionId);
    db.prepare(
      "UPDATE tax_rules SET rate = 9.0 WHERE id IN ('b-cgst', 'a-sgst') AND pack_version_id = ?",
    ).run(s16ActiveVersionId);

    const s16DiscountRes = await api(baseUrl, `/api/orders/${s16OrderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'amount', discount_value: 0 },
      headers: authHeader,
    });
    assertEqual(s16DiscountRes.status, 200, 'discount succeeds after category rename/rate change');
    assertEqual(
      s16DiscountRes.data.order.tax_amount,
      10.01,
      'order tax preserves saved 5% rate and document rounding',
    );
    assertEqual(s16DiscountRes.data.order.total, 210.21, 'order total preserved');

    const s16CancelRes = await api(
      baseUrl,
      `/api/orders/${s16OrderId}/items/${s16Item2Id}/cancel`,
      {
        method: 'PATCH',
        headers: authHeader,
      },
    );
    assertEqual(s16CancelRes.status, 200, 'item cancel succeeds after category rename');
    assertEqual(
      s16CancelRes.data.order.tax_amount,
      5.01,
      'remaining item retains 5% rate with document rounding reallocated',
    );
    assertEqual(s16CancelRes.data.order.total, 105.11, 'cancelled item total updated');

    db.prepare(
      "UPDATE tax_categories SET id = 'standard' WHERE id = 'standard_renamed' AND pack_version_id = ?",
    ).run(s16ActiveVersionId);
    db.prepare(
      "UPDATE tax_rules SET rate = 2.5 WHERE id IN ('b-cgst', 'a-sgst') AND pack_version_id = ?",
    ).run(s16ActiveVersionId);
  } finally {
    server.close();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: any) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
