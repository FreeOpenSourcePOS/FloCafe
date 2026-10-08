/**
 * Integration Test: Order hold, discount, tax, and payment flow
 *
 * Walks the documented lifecycle end to end (docs/architecture/order-lifecycle.md):
 * a cart is held against a table, the hold is resumed into a dine-in order, an
 * order-level discount rescales tax, the bill is settled in installments, and
 * the order completes only once the bill is paid. It also pins the hold
 * cleanup contract (stale deletes are no-ops), the discount cap, the cash-shift
 * gate, cash over-tender change, and an idempotent payment replay after the
 * shift closed.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/integration-order-hold-payment.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-hold-payment-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct, seedTable,
  installAndActivateTestTaxPack,
  api, assertOrThrow, assertEqualOrThrow, assertIncludesOrThrow, assertGreaterThanOrThrow,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { heldOrderRoutes } = require('../main/routes/held-orders');
const dualRatePackData = require('./fixtures/synthetic-dual-rate-pack.json');
// Country/currency stay IN/INR so the pack resolves as the active country pack.
const testTaxPack = { ...dualRatePackData, id: 'test-in-pack', publisher: 'FreeOpenSourcePOS', country: 'IN', currency: 'INR' };

interface AuthHeader { Authorization: string }

async function main() {
  console.log('Integration Test: Order hold, discount, tax, and payment flow');
  console.log('='.repeat(50));

  const db = initTestDb();
  installAndActivateTestTaxPack(db, testTaxPack);

  const { authHeader } = seedOwnerUser(db) as { authHeader: AuthHeader };
  seedCategory(db, 'cat-flow', 'Flow Test Menu');
  seedProduct(db, 'prod-flow-a', 'cat-flow', 'Cappuccino', 500, { tax_category_id: 'standard', tax_behavior: 'exclusive' });
  seedProduct(db, 'prod-flow-b', 'cat-flow', 'Sandwich', 300, { tax_category_id: 'standard', tax_behavior: 'exclusive' });
  seedTable(db, 'tbl-flow-1', 11, 4);
  seedTable(db, 'tbl-flow-2', 12, 2);

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/held-orders': heldOrderRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const tableStatus = (tableId: string): string =>
    (db.prepare('SELECT status FROM tables WHERE id = ?').get(tableId) as { status: string }).status;
  const setSetting = (key: string, value: string) =>
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now());
  // `payment_details` is stored as JSON text and parsed on the way out; tolerate both shapes.
  const paymentLines = (bill: any): any[] => (Array.isArray(bill.payment_details) ? bill.payment_details : JSON.parse(bill.payment_details));
  const heldCartItems = [
    { id: 'line-a', product: { id: 'prod-flow-a' }, quantity: 1, addons: [] },
    { id: 'line-b', product: { id: 'prod-flow-b' }, quantity: 1, addons: [] },
  ];

  try {
    // ── A. A cart is held against a table ────────────────────────────────
    console.log('\nA. Hold a cart on a table');
    const hold = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: { tableId: 'tbl-flow-1', items: heldCartItems, guestCount: 2, orderNotes: 'No onions', waivedChargeIds: [], optedInChargeIds: [] },
      headers: authHeader,
    });
    assertEqualOrThrow(hold.status, 200, 'the cart is held');
    assertEqualOrThrow(hold.data.success, true, 'the hold reports success');
    assertOrThrow(typeof hold.data.id === 'string' && hold.data.id.startsWith('ho-'), 'the hold returns its identity');
    const firstHeldOrderId = hold.data.id as string;
    assertEqualOrThrow(tableStatus('tbl-flow-1'), 'held', 'holding marks the table as held');

    const heldList = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    assertEqualOrThrow(heldList.status, 200, 'held carts are readable');
    assertEqualOrThrow(heldList.data.orders.length, 1, 'the table carries exactly one held cart');
    assertEqualOrThrow(heldList.data.orders[0].items.length, 2, 'both cart lines survive the round trip');
    assertEqualOrThrow(heldList.data.orders[0].orderNotes, 'No onions', 'the cart note survives the round trip');
    assertEqualOrThrow(heldList.data.orders[0].guestCount, 2, 'the guest count survives the round trip');

    const malformedHold = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: { tableId: 'tbl-flow-1', items: [], guestCount: 2 },
      headers: authHeader,
    });
    assertEqualOrThrow(malformedHold.status, 400, 'a hold without items is rejected');
    const badChargeHold = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: { tableId: 'tbl-flow-1', items: heldCartItems, waivedChargeIds: ['not a charge id!'] },
      headers: authHeader,
    });
    assertEqualOrThrow(badChargeHold.status, 400, 'a malformed charge selection is rejected before it is stored');
    const surviveMalformed = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    assertEqualOrThrow(surviveMalformed.data.orders.length, 1, 'a rejected hold leaves the stored cart untouched');

    const rehold = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: { tableId: 'tbl-flow-1', items: heldCartItems, guestCount: 3, waivedChargeIds: [], optedInChargeIds: [] },
      headers: authHeader,
    });
    assertEqualOrThrow(rehold.status, 200, 'holding the same table again is accepted');
    const heldOrderId = rehold.data.id as string;
    assertOrThrow(firstHeldOrderId !== heldOrderId, 're-holding assigns a new hold id');
    const afterRehold = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    assertEqualOrThrow(afterRehold.data.orders.length, 1, 're-holding replaces the table cart instead of adding one');
    assertEqualOrThrow(afterRehold.data.orders[0].guestCount, 3, 'the replaced cart carries the newer values');

    const staleDelete = await api(baseUrl, `/api/held-orders/tbl-flow-1?heldOrderId=${firstHeldOrderId}`, { method: 'DELETE', headers: authHeader });
    assertEqualOrThrow(staleDelete.status, 200, 'a stale delete is still a success response');
    assertEqualOrThrow(staleDelete.data.deleted, false, 'a stale delete removes nothing');
    const holdAfterStaleDelete = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    assertEqualOrThrow(holdAfterStaleDelete.data.orders.length, 1, 'a stale id leaves the newer cart in place');
    assertEqualOrThrow(holdAfterStaleDelete.data.orders[0].id, heldOrderId, 'the newer hold id remains current');

    // ── B. Resuming creates the order and clears the hold ────────────────
    console.log('\nB. Resume the hold into an order');
    const resumedHold = afterRehold.data.orders[0];
    const deleteHold = await api(baseUrl, `/api/held-orders/tbl-flow-1?heldOrderId=${heldOrderId}`, { method: 'DELETE', headers: authHeader });
    assertEqualOrThrow(deleteHold.status, 200, 'the hold is deleted before the cart is loaded');
    assertEqualOrThrow(deleteHold.data.deleted, true, 'the restore removes the persisted cart');
    const holdsAfterRestore = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    assertEqualOrThrow(holdsAfterRestore.data.orders.length, 0, 'the restored cart is no longer persisted');
    assertEqualOrThrow(tableStatus('tbl-flow-1'), 'available', 'restoring the held cart releases the held table');

    const orderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        table_id: 'tbl-flow-1',
        customer_id: resumedHold.customerId,
        guest_count: resumedHold.guestCount,
        special_instructions: resumedHold.orderNotes,
        waived_charge_ids: resumedHold.waivedChargeIds,
        opted_in_charge_ids: resumedHold.optedInChargeIds,
        items: resumedHold.items.map((item: any) => ({ product_id: item.product.id, quantity: item.quantity, addons: item.addons })),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(orderRes.status, 201, 'the resumed cart becomes an order');
    const orderId = orderRes.data.order.id;
    assertEqualOrThrow(orderRes.data.order.status, 'pending', 'the order starts pending');
    assertEqualOrThrow(tableStatus('tbl-flow-1'), 'occupied', 'creating a dine-in order occupies the table');

    const unguardedDelete = await api(baseUrl, '/api/held-orders/tbl-flow-1', { method: 'DELETE', headers: authHeader });
    assertEqualOrThrow(unguardedDelete.data.deleted, false, 'a delete without the expected hold id is a no-op');

    // ── C. Discount and tax recomputation ────────────────────────────────
    console.log('\nC. Discount rescales tax');
    assertEqualOrThrow(orderRes.data.order.subtotal, 800, 'order subtotal is the sum of the item lines');
    assertEqualOrThrow(orderRes.data.order.tax_amount, 40, 'tax is applied on the pre-discount subtotal');
    assertEqualOrThrow(orderRes.data.order.total, 840, 'total is subtotal plus tax');

    const discount = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10, discount_reason: 'Regular' },
      headers: authHeader,
    });
    assertEqualOrThrow(discount.status, 200, 'an order-level discount is applied');
    assertEqualOrThrow(discount.data.order.discount_amount, 80, 'the discount is 10% of the item subtotal');
    assertEqualOrThrow(discount.data.order.tax_amount, 36, 'tax is rescaled to the discounted subtotal');
    assertEqualOrThrow(discount.data.order.total, 756, 'the discounted total is 720 plus 36 tax');

    const overLimit = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 30 },
      headers: authHeader,
    });
    assertEqualOrThrow(overLimit.status, 400, 'a discount above the configured cap is rejected');

    const cleared = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 0 },
      headers: authHeader,
    });
    assertEqualOrThrow(cleared.data.order.discount_amount, 0, 'a zero discount clears the previous one');
    assertEqualOrThrow(cleared.data.order.total, 840, 'clearing the discount restores the undiscounted total');
    const reapplied = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 10, discount_reason: 'Regular' },
      headers: authHeader,
    });
    assertEqualOrThrow(reapplied.data.order.discount_amount, 80, 're-applying a discount does not compound it');
    assertEqualOrThrow(reapplied.data.order.total, 756, 'the re-applied discount lands on the same total');

    // ── D. Bill and installment settlement ───────────────────────────────
    console.log('\nD. Bill, installments, and completion');
    const billRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: orderId }, headers: authHeader });
    assertEqualOrThrow(billRes.status, 201, 'the bill is generated for the order');
    const billId = billRes.data.bill.id;
    assertEqualOrThrow(billRes.data.bill.total, 756, 'the bill carries the discounted order total');
    assertEqualOrThrow(billRes.data.bill.balance, 756, 'the unpaid bill owes its full total');
    assertEqualOrThrow(billRes.data.bill.payment_status, 'unpaid', 'a fresh bill is unpaid');

    const firstInstallment = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 300 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-installment-1' },
    });
    assertEqualOrThrow(firstInstallment.status, 200, 'a partial cash installment is accepted');
    assertEqualOrThrow(firstInstallment.data.bill.payment_status, 'partial', 'a short payment marks the bill partial');
    assertEqualOrThrow(firstInstallment.data.bill.paid_amount, 300, 'the paid amount records the installment');
    assertEqualOrThrow(firstInstallment.data.bill.balance, 456, 'the balance keeps the unpaid remainder');
    const midOrder = await api(baseUrl, `/api/orders/${orderId}`, { headers: authHeader });
    assertOrThrow(midOrder.data.order.status !== 'completed', 'a partially paid order is not completed');

    const replayInstallment = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 300 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-installment-1' },
    });
    assertEqualOrThrow(replayInstallment.status, 200, 'the same idempotency key replays the committed payment');
    assertEqualOrThrow(replayInstallment.data.bill.paid_amount, 300, 'the replay does not charge twice');
    const detailsAfterReplay = paymentLines(replayInstallment.data.bill);
    assertEqualOrThrow(detailsAfterReplay.length, 1, 'the replayed payment keeps one ledger line');
    const changedReplay = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 301 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-installment-1' },
    });
    assertEqualOrThrow(changedReplay.status, 409, 'the same key with a different amount conflicts');

    const settlement = await api(baseUrl, `/api/bills/${billId}/payment`, {
      method: 'POST',
      body: { method: 'card', amount: 456 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-settlement' },
    });
    assertEqualOrThrow(settlement.status, 200, 'the remaining balance is settled by card');
    assertEqualOrThrow(settlement.data.bill.payment_status, 'paid', 'settling the balance marks the bill paid');
    assertEqualOrThrow(settlement.data.bill.balance, 0, 'a paid bill has no balance left');
    const settledDetails = paymentLines(settlement.data.bill);
    assertEqualOrThrow(settledDetails.length, 2, 'both installments are recorded on the bill');
    assertEqualOrThrow(settledDetails[1].method, 'card', 'the second ledger line keeps its method');

    const completedOrder = await api(baseUrl, `/api/orders/${orderId}`, { headers: authHeader });
    assertEqualOrThrow(completedOrder.data.order.status, 'completed', 'the order completes when its bill is paid');
    assertEqualOrThrow(tableStatus('tbl-flow-1'), 'available', 'completion frees the dine-in table');
    const lateDiscount = await api(baseUrl, `/api/orders/${orderId}/discount`, {
      method: 'PATCH',
      body: { discount_type: 'percentage', discount_value: 5 },
      headers: authHeader,
    });
    assertEqualOrThrow(lateDiscount.status, 400, 'a completed order cannot be discounted afterwards');

    // ── E. Cash over-tender, the shift gate, and replay after close ──────
    console.log('\nE. Cash gate and replay after the shift closed');
    const cashOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-flow-a', quantity: 1 }] },
      headers: authHeader,
    });
    const cashBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: cashOrderRes.data.order.id }, headers: authHeader });
    assertEqualOrThrow(cashBillRes.data.bill.total, 525, 'the takeaway bill is 500 plus 5% tax');

    setSetting('require_open_shift', 'true');
    const gatedCash = await api(baseUrl, `/api/bills/${cashBillRes.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 525 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-gated-cash' },
    });
    assertEqualOrThrow(gatedCash.status, 409, 'cash without an open shift is rejected while the setting is on');
    assertIncludesOrThrow(String(gatedCash.data.error), 'open shift', 'the gate names the missing shift');
    const gatedBill = await api(baseUrl, `/api/bills/${cashBillRes.data.bill.id}`, { headers: authHeader });
    assertEqualOrThrow(gatedBill.data.bill.paid_amount, 0, 'the rejected cash payment leaves no ledger line');

    const ungatedCard = await api(baseUrl, `/api/bills/${cashBillRes.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'card', amount: 525 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-ungated-card' },
    });
    assertEqualOrThrow(ungatedCard.status, 200, 'a non-cash tender is not gated by the shift setting');
    assertEqualOrThrow(ungatedCard.data.bill.payment_status, 'paid', 'the card tender settles the bill');

    const sessionDb = db.prepare("INSERT INTO cash_sessions (opened_by, opened_at, opening_float_cents, status) VALUES (?, ?, 0, 'open')")
      .run('owner-test-001', now());
    const sessionId = Number(sessionDb.lastInsertRowid);
    const overTenderOrder = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-flow-b', quantity: 2 }] },
      headers: authHeader,
    });
    const overTenderBill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: overTenderOrder.data.order.id }, headers: authHeader });
    assertEqualOrThrow(overTenderBill.data.bill.total, 630, 'the second takeaway bill is 600 plus 5% tax');
    const overTender = await api(baseUrl, `/api/bills/${overTenderBill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 1000 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-over-tender' },
    });
    assertEqualOrThrow(overTender.status, 200, 'an over-tendered cash payment is accepted');
    assertEqualOrThrow(overTender.data.bill.payment_status, 'paid', 'cash is applied up to the remaining balance');
    const overTenderLine = paymentLines(overTender.data.bill)[0];
    assertEqualOrThrow(overTenderLine.amount, 630, 'only the balance owed is applied');
    assertEqualOrThrow(overTenderLine.tendered_amount, 1000, 'the tendered amount is recorded');
    assertEqualOrThrow(overTenderLine.change_amount, 370, 'the difference is recorded as change');
    assertEqualOrThrow(overTenderLine.cash_session_id, sessionId, 'the cash line attributes the open session');
    const secondPayment = await api(baseUrl, `/api/bills/${overTenderBill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 100 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-second-payment' },
    });
    assertEqualOrThrow(secondPayment.status, 400, 'a settled bill refuses a further payment');

    db.prepare("UPDATE cash_sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), sessionId);
    const replayAfterClose = await api(baseUrl, `/api/bills/${overTenderBill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: 1000 },
      headers: { ...authHeader, 'Idempotency-Key': 'flow-over-tender' },
    });
    assertEqualOrThrow(replayAfterClose.status, 200, 'a committed payment replays after its shift closed');
    assertEqualOrThrow(replayAfterClose.data.bill.paid_amount, 630, 'the replay keeps the committed paid amount');
    assertEqualOrThrow(paymentLines(replayAfterClose.data.bill).length, 1, 'the replay writes no second ledger line');
    const replayMatchesCommitted = JSON.stringify(replayAfterClose.data.bill.payment_details) === JSON.stringify(overTender.data.bill.payment_details);
    assertOrThrow(replayMatchesCommitted, 'the replayed response carries the committed ledger line unchanged');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup must not mask failures */ }
  }

  const results = getResults();
  console.log('\n' + '='.repeat(50));
  console.log(`${results.passed}/${results.total} passed, ${results.failed} failed`);
  assertGreaterThanOrThrow(results.total, 0, 'the suite ran its assertions');
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((err: any) => {
  console.error('Test runner error:', err);
  try { closeDatabase(); } catch { /* already closed */ }
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  process.exit(1);
});
