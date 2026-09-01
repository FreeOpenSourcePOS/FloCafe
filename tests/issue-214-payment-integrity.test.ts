/** Issue #214 payment integrity and split-report regression coverage. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-214-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  seedCustomer, seedWalletCredit, api, assert, assertEqual, assertIncludes,
  getResults, closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { reportRoutes } = require('../main/routes/reports');
const { seedSetupProfile } = require('../main/routes/auth');

async function main() {
  console.log('Issue #214: payment integrity and reports');
  const db = initTestDb();
  db.prepare("INSERT INTO payment_methods (name, is_active, sort_order, created_at, updated_at) VALUES ('UPI', 1, 10, ?, ?)").run(now(), now());
  const { authHeader } = seedOwnerUser(db);
  const { authHeader: secondUserAuth } = seedManagerUser(db);
  seedCategory(db, 'cat-214', 'Issue 214 menu');
  seedProduct(db, 'prod-214', 'cat-214', 'Issue 214 item', 100);
  seedCustomer(db, 'cust-214', 'Issue 214 customer', '9999999999');
  seedSetupProfile(db, 'demo', 'qsr', 'en', 'IN');
  const demoUsers = db.prepare("SELECT id, is_active, password FROM users WHERE id LIKE 'user-demo-%' ORDER BY id").all() as any[];
  assertEqual(demoUsers.length, 3, 'fresh demo profile creates sample staff rows');
  assert(demoUsers.every((user: any) => user.is_active === 0), 'fresh demo staff rows are inactive');
  assert(demoUsers.every((user: any) => !String(user.password).includes('demo12345')), 'fresh demo credentials are random');
  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/reports': reportRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  async function newBill(customerId?: string, headers = authHeader) {
    const order = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', ...(customerId ? { customer_id: customerId } : {}), items: [{ product_id: 'prod-214', quantity: 1 }] },
      headers,
    });
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST', body: { order_id: order.data.order.id }, headers,
    });
    return bill.data.bill;
  }

  try {
    const idempotentOrderBody = { type: 'takeaway', items: [{ product_id: 'prod-214', quantity: 1 }] };
    const orderKeyHeaders = { ...authHeader, 'Idempotency-Key': 'issue-214-order-retry' };
    const firstOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', body: idempotentOrderBody, headers: orderKeyHeaders,
    });
    const retriedOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', body: idempotentOrderBody, headers: orderKeyHeaders,
    });
    assertEqual(firstOrder.status, 201, 'idempotent order creation is accepted');
    assertEqual(retriedOrder.status, 200, 'order creation retry replays the original response');
    assertEqual(retriedOrder.data.order.id, firstOrder.data.order.id, 'order retry does not create a second order');

    const ownerScopedBill = await newBill();
    const secondUserScopedBill = await newBill(undefined, secondUserAuth);
    const scopedPayload = { payments: [{ method: 'card', amount: 100 }] };
    const ownerScoped = await api(baseUrl, `/api/bills/${ownerScopedBill.id}/payments`, {
      method: 'POST', body: scopedPayload, headers: { ...authHeader, 'Idempotency-Key': 'shared-user-scoped-key' },
    });
    const secondUserScoped = await api(baseUrl, `/api/bills/${secondUserScopedBill.id}/payments`, {
      method: 'POST', body: scopedPayload, headers: { ...secondUserAuth, 'Idempotency-Key': 'shared-user-scoped-key' },
    });
    assertEqual(ownerScoped.status, 200, 'first user-scoped idempotent payment is accepted');
    assertEqual(secondUserScoped.status, 200, 'another user may independently reuse the idempotency key');

    const legacyPaymentBill = await newBill();
    const legacyPaymentKey = 'legacy-payment-retry';
    const legacyPayment = await api(baseUrl, `/api/bills/${legacyPaymentBill.id}/payments`, {
      method: 'POST', body: scopedPayload, headers: { ...authHeader, 'Idempotency-Key': legacyPaymentKey },
    });
    db.prepare('UPDATE orders SET user_id = NULL WHERE id = ?').run(legacyPaymentBill.order_id);
    db.prepare('UPDATE payment_idempotency SET user_id = \'legacy\' WHERE idempotency_key = ?').run(legacyPaymentKey);
    const legacyPaymentReplay = await api(baseUrl, `/api/bills/${legacyPaymentBill.id}/payments`, {
      method: 'POST', body: scopedPayload, headers: { ...secondUserAuth, 'Idempotency-Key': legacyPaymentKey },
    });
    assertEqual(legacyPayment.status, 200, 'legacy payment record is created for compatibility coverage');
    assertEqual(legacyPaymentReplay.status, 200, 'ownerless legacy payment retry replays exactly');
    assertEqual(legacyPaymentReplay.data.bill.payment_details.length, 1, 'ownerless legacy payment retry does not duplicate the payment');

    const legacyOrderKey = 'legacy-order-retry';
    const legacyOrderBody = { type: 'takeaway', items: [{ product_id: 'prod-214', quantity: 1 }] };
    const legacyOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', body: legacyOrderBody, headers: { ...authHeader, 'Idempotency-Key': legacyOrderKey },
    });
    db.prepare('UPDATE orders SET user_id = NULL WHERE id = ?').run(legacyOrder.data.order.id);
    db.prepare('UPDATE order_idempotency SET user_id = \'legacy\' WHERE idempotency_key = ?').run(legacyOrderKey);
    const legacyOrderReplay = await api(baseUrl, '/api/orders', {
      method: 'POST', body: legacyOrderBody, headers: { ...secondUserAuth, 'Idempotency-Key': legacyOrderKey },
    });
    assertEqual(legacyOrderReplay.status, 200, 'ownerless legacy order retry replays exactly');
    assertEqual(legacyOrderReplay.data.order.id, legacyOrder.data.order.id, 'ownerless legacy order retry does not create a second order');

    // Single-payment compatibility: null means omitted/full remaining.
    const omitted = await newBill();
    const full = await api(baseUrl, `/api/bills/${omitted.id}/payment`, {
      method: 'POST', body: { method: 'card', amount: null }, headers: authHeader,
    });
    assertEqual(full.status, 200, 'single payment amount=null remains full-payment compatible');
    assertEqual(full.data.bill.payment_status, 'paid', 'null amount settles the remaining balance');

    const repeatedLegacy = await newBill();
    const firstRepeated = await api(baseUrl, `/api/bills/${repeatedLegacy.id}/payment`, {
      method: 'POST', body: { method: 'cash', amount: 10 }, headers: authHeader,
    });
    const secondRepeated = await api(baseUrl, `/api/bills/${repeatedLegacy.id}/payment`, {
      method: 'POST', body: { method: 'cash', amount: 10 }, headers: authHeader,
    });
    assertEqual(firstRepeated.status, 200, 'first identical legacy payment is accepted');
    assertEqual(secondRepeated.status, 200, 'second identical legacy payment is recorded separately');
    assertEqual(secondRepeated.data.bill.paid_amount, 20, 'identical legacy payments are not request-deduplicated');

    const malformedBodyBill = await newBill();
    const malformedSingle = await api(baseUrl, `/api/bills/${malformedBodyBill.id}/payment`, {
      method: 'POST', body: {}, headers: authHeader,
    });
    assertEqual(malformedSingle.status, 400, 'missing single-payment fields are rejected without a server error');
    for (const payload of [{ payments: null }, { payments: {} }, { payments: [] }]) {
      const malformedBatch = await api(baseUrl, `/api/bills/${malformedBodyBill.id}/payments`, {
        method: 'POST', body: payload, headers: authHeader,
      });
      assertEqual(malformedBatch.status, 400, `malformed batch body ${JSON.stringify(payload)} is rejected`);
    }
    for (const [label, amount] of [['omitted', undefined], ['null', null]] as const) {
      const legacyBatchBill = await newBill();
      const legacyPayment = await api(baseUrl, `/api/bills/${legacyBatchBill.id}/payments`, {
        method: 'POST', body: { payments: [{ method: 'card', ...(amount === undefined ? {} : { amount }) }] }, headers: authHeader,
      });
      assertEqual(legacyPayment.status, 200, `single-line batch ${label} amount remains compatible`);
      assertEqual(legacyPayment.data.bill.payment_status, 'paid', `single-line batch ${label} settles the bill`);
    }

    // Batch allocation is independent of array order and preserves cash tender/change.
    for (const [label, payments, expectedMethods] of [
      ['cash first', [{ method: 'cash', amount: 60 }, { method: 'card', amount: 60 }], ['cash', 'card']],
      ['card first', [{ method: 'card', amount: 60 }, { method: 'cash', amount: 60 }], ['card', 'cash']],
    ] as const) {
      const splitBill = await newBill();
      const split = await api(baseUrl, `/api/bills/${splitBill.id}/payments`, {
        method: 'POST', body: { payments }, headers: authHeader,
      });
      const details = split.data.bill.payment_details;
      assertEqual(split.status, 200, `${label} split is accepted`);
      assertEqual(split.data.bill.paid_amount, 100, `${label} split settles the bill`);
      assertEqual(details.map((line: any) => line.method).join(','), expectedMethods.join(','), `${label} preserves payment line order`);
      const cashLine = details.find((line: any) => line.method === 'cash');
      assertEqual(cashLine.amount, 40, `${label} records net cash retained`);
      assertEqual(cashLine.tendered_amount, 60, `${label} records cash tendered`);
      assertEqual(cashLine.change_amount, 20, `${label} records cash change`);
      assertEqual(details.find((line: any) => line.method === 'card').amount, 60, `${label} preserves card amount exactly`);
    }

    // A new batch must not rewrite an independently recorded earlier payment.
    const partial = await newBill();
    const prior = await api(baseUrl, `/api/bills/${partial.id}/payment`, {
      method: 'POST', body: { method: 'cash', amount: 10 }, headers: authHeader,
    });
    const priorDetails = JSON.stringify(prior.data.bill.payment_details[0]);
    const followup = await api(baseUrl, `/api/bills/${partial.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'cash', amount: 20 }, { method: 'card', amount: 70 }] }, headers: authHeader,
    });
    assertEqual(followup.status, 200, 'batch after a partial payment is accepted');
    assertEqual(JSON.stringify(followup.data.bill.payment_details[0]), priorDetails, 'prior payment detail remains unchanged');
    assertEqual(followup.data.bill.paid_amount, 100, 'partial bill plus batch settles the bill');

    const replayBill = await newBill();
    const replayPayload = { payments: [{ method: 'card', amount: 100, transaction_id: 'tx-214-replay' }] };
    const replayHeaders = { ...authHeader, 'Idempotency-Key': 'issue-214-replay' };
    const firstReplay = await api(baseUrl, `/api/bills/${replayBill.id}/payments`, {
      method: 'POST', body: replayPayload, headers: replayHeaders,
    });
    const secondReplay = await api(baseUrl, `/api/bills/${replayBill.id}/payments`, {
      method: 'POST', body: replayPayload, headers: replayHeaders,
    });
    const changedReplay = await api(baseUrl, `/api/bills/${replayBill.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'card', amount: 99, transaction_id: 'tx-214-replay' }] }, headers: replayHeaders,
    });
    const changedTransaction = await api(baseUrl, `/api/bills/${replayBill.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'card', amount: 99, transaction_id: 'tx-214-replay' }] }, headers: { ...authHeader, 'Idempotency-Key': 'issue-214-changed-transaction' },
    });
    const malformedTransaction = await api(baseUrl, `/api/bills/${replayBill.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'card', amount: 99.001, transaction_id: 'tx-214-replay' }] }, headers: { ...authHeader, 'Idempotency-Key': 'issue-214-malformed-transaction' },
    });
    assertEqual(firstReplay.status, 200, 'transaction-id payment is accepted');
    assertEqual(secondReplay.status, 200, 'replaying transaction-id payment is idempotent');
    assertEqual(changedReplay.status, 409, 'reusing an idempotency key for changed data is rejected');
    assertEqual(changedTransaction.status, 409, 'changing a transaction-id payment is rejected');
    assertEqual(malformedTransaction.status, 400, 'malformed transaction-id payment is rejected');
    assertEqual(secondReplay.data.bill.paid_amount, 100, 'replay does not inflate paid amount');
    assertEqual(secondReplay.data.bill.payment_details.length, 1, 'replay does not duplicate payment history');

    const globalTransactionA = await newBill();
    const globalTransactionFirst = await api(baseUrl, `/api/bills/${globalTransactionA.id}/payment`, {
      method: 'POST', body: { method: 'card', amount: 100, transaction_id: 'tx-214-global' }, headers: authHeader,
    });
    const globalTransactionB = await newBill();
    const globalTransactionSecond = await api(baseUrl, `/api/bills/${globalTransactionB.id}/payment`, {
      method: 'POST', body: { method: 'upi', amount: 100, transaction_id: 'tx-214-global' }, headers: authHeader,
    });
    assertEqual(globalTransactionFirst.status, 200, 'first method-scoped transaction reference is accepted');
    assertEqual(globalTransactionSecond.status, 200, 'same opaque reference is allowed for a different payment method');
    const duplicateTransactionBatch = await newBill();
    const duplicateTransactionResult = await api(baseUrl, `/api/bills/${duplicateTransactionBatch.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'card', amount: 50, transaction_id: 'tx-214-batch' }, { method: 'upi', amount: 50, transaction_id: 'tx-214-batch' }] }, headers: authHeader,
    });
    assertEqual(duplicateTransactionResult.status, 400, 'cross-method transaction IDs are rejected within one batch');

    const zeroCash = await newBill();
    const zeroCashResult = await api(baseUrl, `/api/bills/${zeroCash.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'card', amount: 100 }, { method: 'cash', amount: 10 }] }, headers: authHeader,
    });
    assertEqual(zeroCashResult.status, 200, 'cash-only change line does not fail settlement');
    assertEqual(zeroCashResult.data.bill.payment_details.length, 1, 'zero-applied cash line is omitted');
    assertEqual(zeroCashResult.data.bill.payment_details[0].method, 'card', 'zero-applied cash is not counted as a method');
    const zeroCashWithReference = await newBill();
    const zeroCashReferenceResult = await api(baseUrl, `/api/bills/${zeroCashWithReference.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'card', amount: 100 }, { method: 'cash', amount: 10, transaction_id: 'tx-214-zero-cash' }] }, headers: authHeader,
    });
    assertEqual(zeroCashReferenceResult.status, 400, 'zero-applied cash transaction reference is rejected');

    // Wallet affordability is checked for the whole batch before any write, and
    // wallet debits require the order/bill to carry the same customer.
    const unboundWallet = await newBill();
    const unboundWalletResult = await api(baseUrl, `/api/bills/${unboundWallet.id}/payment`, {
      method: 'POST', body: { method: 'wallet', amount: 1, customer_id: 'cust-214' }, headers: authHeader,
    });
    assertEqual(unboundWalletResult.status, 400, 'unbound wallet payment is rejected');
    const walletRollback = await newBill('cust-214');
    seedWalletCredit(db, 'cust-214', 5);
    const walletBefore = db.prepare("SELECT COUNT(*) AS count FROM loyalty_ledger WHERE bill_id = ? AND type = 'debit'").get(walletRollback.id) as any;
    const walletBatch = await api(baseUrl, `/api/bills/${walletRollback.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'cash', amount: 10 }, { method: 'wallet', amount: 10 }], customer_id: 'cust-214' }, headers: authHeader,
    });
    const walletAfter = db.prepare('SELECT paid_amount, balance FROM bills WHERE id = ?').get(walletRollback.id) as any;
    const walletDebits = db.prepare("SELECT COUNT(*) AS count FROM loyalty_ledger WHERE bill_id = ? AND type = 'debit'").get(walletRollback.id) as any;
    assertEqual(walletBatch.status, 400, 'insufficient wallet batch is rejected');
    assertEqual(walletAfter.paid_amount, 0, 'insufficient wallet batch leaves bill unpaid');
    assertEqual(walletAfter.balance, 100, 'insufficient wallet batch leaves balance unchanged');
    assertEqual(walletDebits.count, walletBefore.count, 'insufficient wallet batch creates no debit');

    // Batch validation happens before writes, including noncash affordability.
    const rollbackBill = await newBill();
    const before = db.prepare('SELECT paid_amount, payment_details FROM bills WHERE id = ?').get(rollbackBill.id) as any;
    const overfund = await api(baseUrl, `/api/bills/${rollbackBill.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'card', amount: 1 }, { method: 'upi', amount: 999 }] }, headers: authHeader,
    });
    const after = db.prepare('SELECT paid_amount, payment_details FROM bills WHERE id = ?').get(rollbackBill.id) as any;
    assertEqual(overfund.status, 400, 'noncash overfund is rejected');
    assertEqual(after.paid_amount, before.paid_amount, 'noncash rejection rolls back bill writes');
    assertEqual(after.payment_details, before.payment_details, 'noncash rejection rolls back payment details');

    const malformed = await newBill();
    db.prepare("UPDATE bills SET payment_details = '{bad json' WHERE id = ?").run(malformed.id);
    const malformedPay = await api(baseUrl, `/api/bills/${malformed.id}/payment`, {
      method: 'POST', body: { method: 'cash', amount: malformed.total }, headers: authHeader,
    });
    assertEqual(malformedPay.status, 200, 'malformed legacy payment JSON does not block settlement');
    const recoveredDetails = Array.isArray(malformedPay.data.bill.payment_details)
      ? malformedPay.data.bill.payment_details : JSON.parse(malformedPay.data.bill.payment_details);
    assertEqual(recoveredDetails.length, 1, 'new payment is recoverably appended');

    const cash = await newBill();
    const cashPay = await api(baseUrl, `/api/bills/${cash.id}/payment`, {
      method: 'POST', body: { method: 'cash', amount: Number(cash.total) + 10 }, headers: authHeader,
    });
    const cashDetails = Array.isArray(cashPay.data.bill.payment_details)
      ? cashPay.data.bill.payment_details : JSON.parse(cashPay.data.bill.payment_details);
    const cashLine = cashDetails[0];
    assertEqual(cashLine.amount, Number(cash.total), 'cash records applied net amount');
    assertEqual(cashLine.tendered_amount, Number(cash.total) + 10, 'cash records tendered amount');
    assertEqual(cashLine.change_amount, 10, 'cash records change amount');

    const invalid = await newBill();
    const unsupported = await api(baseUrl, `/api/bills/${invalid.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'bitcoin', amount: 1 }] }, headers: authHeader,
    });
    const precise = await api(baseUrl, `/api/bills/${invalid.id}/payments`, {
      method: 'POST', body: { payments: [{ method: 'card', amount: 1.001 }] }, headers: authHeader,
    });
    assertEqual(unsupported.status, 400, 'unsupported method is rejected');
    assertEqual(precise.status, 400, 'amount over two decimals is rejected');
    assertIncludes(precise.data.error, 'at most 2 decimal', 'precision error is clear');

    // Wallet debits are aggregate-checked and retain cent precision.
    const walletBill = await newBill('cust-214');
    db.prepare('UPDATE bills SET total = .01, balance = .01 WHERE id = ?').run(walletBill.id);
    seedWalletCredit(db, 'cust-214', 1);
    const walletPay = await api(baseUrl, `/api/bills/${walletBill.id}/payment`, {
      method: 'POST', body: { method: 'wallet', amount: .01, customer_id: 'cust-214' }, headers: authHeader,
    });
    const debit = db.prepare("SELECT amount FROM loyalty_ledger WHERE bill_id = ? AND type = 'debit'").get(walletBill.id) as any;
    assertEqual(walletPay.status, 200, 'wallet accepts exact one-cent amount');
    assertEqual(debit.amount, 0.01, 'one-cent wallet payment debits exactly 0.01 points (1 point = 1 currency unit)');

    // Split timestamps, legacy object fallback, and invalid JSON are all safe.
    const reportBill = await newBill();
    const reportBill2 = await newBill();
    const partialReportBill = await newBill();
    db.prepare(`UPDATE bills SET payment_status='paid', paid_amount=10, balance=0,
      created_at='2026-01-10 09:00:00', paid_at='2026-01-11 09:00:00',
      payment_details=? WHERE id=?`).run(JSON.stringify([
      { method: 'cash', amount: 4, timestamp: '2026-01-10T23:59:59Z' },
      { method: 'card', amount: 6, timestamp: '2026-01-11T00:00:00Z' },
    ]), reportBill.id);
    db.prepare(`UPDATE bills SET payment_status='paid', paid_amount=2, balance=0,
      created_at='2026-01-10 12:00:00', paid_at='2026-01-10 12:01:00',
      payment_details=? WHERE id=?`).run(JSON.stringify({ method: 'upi', amount: 2 }), reportBill2.id);
    db.prepare(`UPDATE bills SET payment_status='partial', paid_amount=1, balance=99,
      created_at='2026-01-01 12:00:00', paid_at=NULL,
      payment_details=? WHERE id=?`).run(JSON.stringify([{ method: 'cash', amount: 1, timestamp: '2026-01-10 10:00:00' }]), partialReportBill.id);
    const report = await api(baseUrl, '/api/reports/sales?start_date=2026-01-10&end_date=2026-01-11', { headers: authHeader });
    assertEqual(report.status, 200, 'split report handles date ranges');
    const methods = report.data.sales.byPaymentMethod;
    assertEqual(methods.find((m: any) => m.method === 'cash')?.count, 1, 'split method count is line count');
    assertEqual(methods.find((m: any) => m.method === 'card')?.total, 6, 'split card line uses its timestamp date');
    assertEqual(methods.find((m: any) => m.method === 'upi')?.total, 2, 'legacy object falls back to bill paid/created timestamp');
    const dayOne = await api(baseUrl, '/api/reports/sales?start_date=2026-01-10&end_date=2026-01-10', { headers: authHeader });
    const dayOneMethods = dayOne.data.sales.byPaymentMethod;
    assertEqual(dayOneMethods.find((m: any) => m.method === 'cash')?.total, 4, 'sales report includes only paid split lines');
    assertEqual(dayOneMethods.find((m: any) => m.method === 'card'), undefined, 'half-open day boundary excludes the next-day card line');
    const summary = await api(baseUrl, '/api/reports/summary?date=2026-01-10', { headers: authHeader });
    assertEqual(summary.data.summary.paymentMethods.find((m: any) => m.method === 'cash')?.total, 5, 'dashboard summary includes partial payment lines');
    db.prepare("UPDATE bills SET payment_details = '{bad json' WHERE id = ?").run(reportBill2.id);
    const invalidReport = await api(baseUrl, '/api/reports/sales?start_date=2026-01-10&end_date=2026-01-11', { headers: authHeader });
    assertEqual(invalidReport.status, 200, 'invalid payment JSON does not cause report 500');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
  }
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: any) => { console.error(error); process.exit(1); });
