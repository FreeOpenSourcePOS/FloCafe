/**
 * Integration Test: Tax Correctness
 *
 * Verifies India GST (5% — 2.5% CGST + 2.5% SGST) is calculated correctly,
 * especially after discount is applied. This is a compliance risk for real
 * restaurants — incorrect GST means wrong filings.
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
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { registerRoutes } = require('../main/routes/index');

async function main() {
  console.log('Integration Test: Tax Correctness');
  console.log('='.repeat(50));

  const db = initTestDb();

  // Force India GST settings
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_type', 'restaurant', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('state_code', '27', ?)").run(now());

  // Seed data
  const { authHeader } = seedOwnerUser(db);
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
    console.log('\n1. Create order — verify GST on ₹1000');
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

    // India restaurant: fixed 5% GST
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
      Math.round(orderDiscountComponents.reduce((sum: number, part: any) => sum + part.amount, 0) * 100) / 100,
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

    // ── Step 4: Verify tax breakdown structure (CGST + SGST) ─────────
    console.log('\n4. Verify tax breakdown (CGST + SGST)');
    // Check the initial order's tax breakdown (before discount, which has the per-item breakdown)
    const rawBreakdown = createRes.data.order.tax_breakdown;
    assert(rawBreakdown !== null && rawBreakdown !== undefined, 'tax breakdown exists on order');
    if (rawBreakdown) {
      const parsed = typeof rawBreakdown === 'string' ? JSON.parse(rawBreakdown) : rawBreakdown;
      // tax_breakdown is stored as array of per-item breakdowns: [[{title, rate, amount}, ...], ...]
      // Flatten to get all entries
      const allEntries = Array.isArray(parsed[0]) ? parsed.flat() : parsed;
      const cgstEntry = allEntries.find((b: any) => b.title === 'CGST');
      const sgstEntry = allEntries.find((b: any) => b.title === 'SGST');
      assert(cgstEntry !== undefined, 'breakdown contains CGST entry');
      assert(sgstEntry !== undefined, 'breakdown contains SGST entry');
      // CGST + SGST should equal initial tax (₹50 on ₹1000)
      if (cgstEntry && sgstEntry) {
        const totalBreakdownTax = Math.round((cgstEntry.amount + sgstEntry.amount) * 100) / 100;
        assertEqual(totalBreakdownTax, initialTax, `CGST (₹${cgstEntry.amount}) + SGST (₹${sgstEntry.amount}) = ₹${initialTax}`);
      }
    }

    // ── Step 5: Categorized product carries a tax_snapshot end to end ────
    console.log('\n5. Categorized product — tax_snapshot persists on item/order/bill');
    seedProduct(db, 'prod-tax-none', 'cat-tax', 'Uncategorized Coffee', 1000, {
      tax_category_id: null,
    });
    seedProduct(db, 'prod-tax-2', 'cat-tax', 'Categorized Latte', 500);
    db.prepare(`UPDATE products SET tax_category_id = 'standard', tax_behavior = 'exclusive' WHERE id = 'prod-tax-2'`).run();

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
    const mixedOrderId = mixedOrderRes.data.order.id;
    const [uncategorizedItem, categorizedItem] = mixedOrderRes.data.order.items;
    assert(!uncategorizedItem.tax_snapshot, 'uncategorized item has no tax_snapshot');
    assertEqual(uncategorizedItem.tax_amount, 0, 'uncategorized item has zero tax');
    assertEqual(uncategorizedItem.tax_breakdown.length, 0, 'uncategorized item has no tax breakdown');
    assert(!!categorizedItem.tax_snapshot, 'categorized item carries a tax_snapshot');
    const orderSnapshotRaw = mixedOrderRes.data.order.tax_snapshot;
    assert(!!orderSnapshotRaw, 'order rolls up a tax_snapshot from its categorized item');
    const orderSnapshot = typeof orderSnapshotRaw === 'string' ? JSON.parse(orderSnapshotRaw) : orderSnapshotRaw;
    assertEqual(orderSnapshot.length, 1, 'order tax_snapshot has exactly one entry (only the categorized item)');

    // ── Step 6: cancelled items must not re-enter later item-discount recompute ──
    console.log('\n6. Cancel one item, then discount the other — cancelled item must stay excluded');
    const cancelRes = await api(baseUrl, `/api/orders/${mixedOrderId}/items/${uncategorizedItem.id}/cancel`, {
      method: 'PATCH',
      body: {},
      headers: authHeader,
    });
    assertEqual(cancelRes.status, 200, 'uncategorized item cancelled');

    const itemDiscountRes = await api(baseUrl, `/api/orders/${mixedOrderId}/items/${categorizedItem.id}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10 }, // 10% of ₹500 = ₹50
      headers: authHeader,
    });
    assertEqual(itemDiscountRes.status, 200, 'item discount applied after sibling cancel');
    // Regression check: before the fix, this recompute summed ALL items
    // (including the cancelled one), so subtotal would include the
    // cancelled ₹1000 item on top of the discounted ₹500 one.
    assertEqual(itemDiscountRes.data.item.subtotal, 450, 'discounted item subtotal (₹500 - ₹50)');
    const afterOrder = (await api(baseUrl, `/api/orders/${mixedOrderId}`, { headers: authHeader })).data.order;
    assertEqual(afterOrder.subtotal, 450, "order subtotal excludes the cancelled item — didn't silently un-cancel it");

    // ── Step 7: bill discount edits must use item tax, not prior bill tax ──
    console.log('\n7. Edit a bill discount — tax must not compound on the prior edit');
    const mixedBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: mixedOrderId },
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
    assertEqual(billDiscount10.data.bill.tax_amount, 20.25, '10% discount scales original ₹22.50 tax to ₹20.25');

    const billDiscount20 = await api(baseUrl, `/api/bills/${mixedBillId}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 20 },
      headers: authHeader,
    });
    assertEqual(billDiscount20.status, 200, 'bill discount edited to 20%');
    assertEqual(billDiscount20.data.bill.tax_amount, 18, '20% edit scales original tax to ₹18 (not prior ₹20.25)');
    assert(!!billDiscount20.data.bill.tax_snapshot, 'bill discount refreshes tax_snapshot');
    const discountedBreakdown = billDiscount20.data.bill.tax_breakdown;
    const discountedComponents = Array.isArray(discountedBreakdown?.[0])
      ? discountedBreakdown.flat()
      : discountedBreakdown;
    assertEqual(
      Math.round(discountedComponents.reduce((sum: number, part: any) => sum + part.amount, 0) * 100) / 100,
      18,
      'bill discount refreshes component amounts to the final tax',
    );

    // ── Step 8: engine-resolved inclusive behavior survives persistence ──
    console.log('\n8. Inclusive categorized product — tax stays inside the displayed price');
    seedProduct(db, 'prod-tax-inclusive', 'cat-tax', 'Inclusive Meal', 105);
    db.prepare(
      `UPDATE products SET tax_category_id = 'standard', tax_behavior = 'inclusive'
       WHERE id = 'prod-tax-inclusive'`
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
    assertEqual(inclusiveOrderRes.data.order.total, 105, 'inclusive tax is not added to the ₹105 price');
    assertEqual(inclusiveOrderRes.data.order.items[0].tax_type, 'inclusive', 'effective engine behavior persisted on item');

    const inclusiveBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: inclusiveOrderRes.data.order.id },
      headers: authHeader,
    });
    const inclusiveDiscountRes = await api(baseUrl, `/api/bills/${inclusiveBillRes.data.bill.id}/applyDiscount`, {
      method: 'POST',
      body: { type: 'percentage', value: 10 },
      headers: authHeader,
    });
    assertEqual(inclusiveDiscountRes.status, 200, 'discount applied to inclusive-tax bill');
    assertEqual(inclusiveDiscountRes.data.bill.tax_amount, 4.5, 'inclusive tax scales to ₹4.50 after discount');
    // #170: the bill's payable total must reflect the pack's configured payableRounding
    // (0.01 for the bundled IN pack) rather than being force-rounded to a whole rupee.
    assertEqual(inclusiveDiscountRes.data.bill.total, 94.5, 'inclusive tax is not added again after discount, and total is not force-rounded to a whole unit');

    // ── Step 9: category writes validate and allow explicit no-tax fallback ──
    console.log('\n9. Product/add-on tax category writes are validated and reversible');
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
    assertEqual(clearCategoryRes.data.product.tax_category_id, null, 'explicit null clears product tax category');

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
    assertEqual(clearAddonCategoryRes.status, 200, 'categorized add-on can return to no explicit tax category');
    assertEqual(clearAddonCategoryRes.data.addon.tax_category_id, null, 'explicit null clears add-on tax category');

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
      (db.prepare("SELECT tax_category_id FROM products WHERE id = 'prod-tax-inclusive'").get() as any).tax_category_id,
      'standard',
      'legacy CSV without new columns preserves an assigned tax category',
    );
    assertEqual(
      (db.prepare("SELECT tax_type || ':' || tax_rate AS legacy_tax FROM products WHERE id = 'prod-tax-inclusive'").get() as any).legacy_tax,
      'none:0.0',
      'legacy CSV tax_type/tax_rate values are ignored and cleared',
    );

    db.prepare("UPDATE settings SET value = 'US' WHERE key = 'country'").run();
    const genericCategoriesRes = await api(baseUrl, '/api/tax/categories', { headers: authHeader });
    assertEqual(genericCategoriesRes.status, 200, 'generic pack category endpoint responds');
    assertEqual(genericCategoriesRes.data.configuration_ready, false, 'rule-less generic pack is not assignable');
    assertEqual(genericCategoriesRes.data.categories.length, 0, 'rule-less categories cannot migrate products to zero tax');
    const genericCheckoutRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        items: [{ product_id: 'prod-tax-inclusive', quantity: 1 }],
      },
      headers: authHeader,
    });
    assertEqual(genericCheckoutRes.status, 400, 'country change cannot silently turn a categorized product into zero tax');
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
    assertEqual(clearCategoryCsvRes.status, 200, 'new product CSV imports explicit blank tax fields');
    assertEqual(
      (db.prepare("SELECT tax_category_id FROM products WHERE id = 'prod-tax-inclusive'").get() as any).tax_category_id,
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
    assertEqual(noTaxCheckoutRes.data.order.tax_amount, 0, 'product without a tax category has zero tax');
    assertEqual(noTaxCheckoutRes.data.order.tax_breakdown.length, 0, 'product without a tax category has no order tax breakdown');
    assert(!noTaxCheckoutRes.data.order.tax_snapshot, 'product without a tax category has no order tax snapshot');

  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
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
