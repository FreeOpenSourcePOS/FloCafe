/**
 * Refunds on already-completed orders: business-day approval tiers, expanded
 * item eligibility, and store-credit refunds (docs/business-decisions.md).
 *
 * Kept separate from tests/refunds.test.ts because that file's PIN
 * rate-limit budget is deliberately tuned to exactly 5 attempts; adding more
 * PIN-reaching calls there would perturb its throttling assertion.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-refund-completed-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct, seedCustomer,
  api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { customerRoutes } = require('../main/routes/customers');

async function main() {
  console.log('Refunds on completed orders: business-day tiers, item eligibility, store credit');
  const db = initTestDb();
  db.prepare("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'").run();
  if ((db.prepare("SELECT COUNT(*) as c FROM settings WHERE key = 'timezone'").get() as any).c === 0) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('timezone', 'UTC')").run();
  }
  const { userId: ownerId, authHeader: ownerAuth } = seedOwnerUser(db);
  const { userId: managerId, authHeader: managerAuth } = seedManagerUser(db);
  // seedOwnerUser doesn't set a PIN by default — completed-order refunds need one to approve.
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync('9999', 10), ownerId);
  seedCategory(db, 'cat-refund-co', 'Refund menu (completed orders)');
  seedProduct(db, 'prod-refund-co', 'cat-refund-co', 'Refund item', 100);
  seedCustomer(db, 'cust-refund-co', 'Refund Customer', '+10000000099');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
    '/api/customers': customerRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  // Freeze the clock so business-day fixtures can't flake near a real day boundary.
  const originalDateNow = Date.now;
  const FIXED_NOW = Date.UTC(2025, 5, 15, 12, 0, 0);
  Date.now = () => FIXED_NOW;

  async function newPaidBill(productId: string, quantity = 1, headers = ownerAuth) {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: productId, quantity }] },
      headers,
    });
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: order.data.order.id }, headers,
    });
    const paid = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payment`, {
      method: 'POST', body: { method: 'cash', amount: null }, headers,
    });
    return { order: order.data.order, bill: paid.data.bill };
  }

  try {
    // ── Same business day, past the 1-hour window: manager PIN insufficient ──
    const lateBill = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-15 10:30:00' WHERE id = ?").run(lateBill.order.id);

    const managerAttempt = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: lateBill.bill.id, amount: lateBill.bill.paid_amount, method: 'cash', override_pin: '1234', manager_id: managerId },
      headers: managerAuth,
    });
    assertEqual(managerAttempt.status, 403, 'a manager PIN cannot approve a refund once the 1-hour window has passed');
    assertEqual(
      (db.prepare('SELECT COUNT(*) AS count FROM refunds WHERE bill_id = ?').get(lateBill.bill.id) as any).count,
      0,
      'the rejected late refund attempt does not create a refund row',
    );

    // ── Same bill, owner PIN: accepted, and recorded in the order audit log ──
    const ownerApproval = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: lateBill.bill.id, amount: lateBill.bill.paid_amount, method: 'cash', override_pin: '9999', approver_id: ownerId },
      headers: managerAuth,
    });
    assertEqual(ownerApproval.status, 201, 'an owner PIN can approve a refund after the 1-hour window, same business day');
    assertEqual(ownerApproval.data.refund.approved_by, ownerId, 'the owner is recorded as the approver');
    assertEqual(ownerApproval.data.bill.payment_status, 'refunded', 'the late refund marks the bill refunded');

    const auditRow = db.prepare(
      "SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'refund_issued' ORDER BY id DESC LIMIT 1",
    ).get(lateBill.order.id) as any;
    assert(!!auditRow, 'the late refund is recorded in order_audit_log');
    assertEqual(auditRow.actor_user_id, managerId, 'the audit row attributes the refund to the initiating manager');
    const auditDetails = JSON.parse(auditRow.details_json);
    assertEqual(auditDetails.lateRefund, true, 'the audit details flag this as a late refund');
    assertEqual(auditDetails.approvedBy, ownerId, 'the audit details record the owner as approver');

    // ── A prior business day is closed even to an owner PIN ─────────────────
    const priorDayBill = await newPaidBill('prod-refund-co');
    db.prepare("UPDATE orders SET created_at = '2025-06-13 12:00:00' WHERE id = ?").run(priorDayBill.order.id);
    const priorDayAttempt = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: priorDayBill.bill.id, amount: priorDayBill.bill.paid_amount, method: 'cash', override_pin: '9999', manager_id: ownerId },
      headers: ownerAuth,
    });
    assertEqual(priorDayAttempt.status, 409, 'even an owner PIN cannot refund an order from a prior business day');

    // ── A completed item is refundable once the order is past the short window ──
    const itemBill = await newPaidBill('prod-refund-co');
    const itemRow = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(itemBill.order.id) as any;
    db.prepare("UPDATE order_items SET status = 'completed' WHERE id = ?").run(itemRow.id);
    db.prepare("UPDATE orders SET created_at = '2025-06-15 10:30:00' WHERE id = ?").run(itemBill.order.id);
    const completedItemRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: itemBill.bill.id, order_item_id: itemRow.id, method: 'cash', override_pin: '9999', manager_id: ownerId },
      headers: ownerAuth,
    });
    assertEqual(completedItemRefund.status, 201, 'a completed item is refundable once the order is past the in-progress window');

    // ── Store-credit refund ─────────────────────────────────────────────────
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('loyalty_enabled', 'true', ?)").run(now());

    const creditBill = await newPaidBill('prod-refund-co');
    db.prepare('UPDATE bills SET customer_id = ? WHERE id = ?').run('cust-refund-co', creditBill.bill.id);
    const storeCreditRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: creditBill.bill.id, amount: creditBill.bill.paid_amount, method: 'wallet', override_pin: '9999', manager_id: ownerId },
      headers: ownerAuth,
    });
    assertEqual(storeCreditRefund.status, 201, 'a store-credit refund is accepted for a bill with a customer');
    const ledgerRow = db.prepare(
      "SELECT * FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit' ORDER BY id DESC LIMIT 1",
    ).get(creditBill.bill.id) as any;
    assert(!!ledgerRow, 'the store-credit refund creates a loyalty_ledger credit entry');
    assertEqual(Number(ledgerRow.amount), Number(creditBill.bill.paid_amount), 'the credited amount matches the refunded amount');
    assertEqual(ledgerRow.customer_id, 'cust-refund-co', 'the credit is attributed to the bill customer');

    const walletBalance = await api(baseUrl, '/api/customers/cust-refund-co/wallet', { headers: ownerAuth });
    assertEqual(Number(walletBalance.data.balance), Number(creditBill.bill.paid_amount), 'the customer wallet balance reflects the refund credit');

    // ── Store credit requires a customer on the bill ─────────────────────────
    const noCustomerBill = await newPaidBill('prod-refund-co');
    const noCustomerCreditRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: noCustomerBill.bill.id, amount: noCustomerBill.bill.paid_amount, method: 'wallet', override_pin: '9999', manager_id: ownerId },
      headers: ownerAuth,
    });
    assertEqual(noCustomerCreditRefund.status, 400, 'a store-credit refund without a bill customer is rejected');

    // ── Store credit requires loyalty to be enabled ──────────────────────────
    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'loyalty_enabled'").run();
    const loyaltyDisabledBill = await newPaidBill('prod-refund-co');
    db.prepare('UPDATE bills SET customer_id = ? WHERE id = ?').run('cust-refund-co', loyaltyDisabledBill.bill.id);
    const disabledCreditRefund = await api(baseUrl, '/api/refunds', {
      method: 'POST',
      body: { bill_id: loyaltyDisabledBill.bill.id, amount: loyaltyDisabledBill.bill.paid_amount, method: 'wallet', override_pin: '9999', manager_id: ownerId },
      headers: ownerAuth,
    });
    assertEqual(disabledCreditRefund.status, 400, 'a store-credit refund is rejected when loyalty is disabled');
  } finally {
    Date.now = originalDateNow;
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
  }
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
