/**
 * Expense payments and reversals: ledger rules, cash linkage, and recovery.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/expense-payments.test.ts
 *
 * The write half of the expense boundary: a payment settles against the
 * immutable ledger, a cash payment moves the active drawer exactly once and
 * only with a real open session, and a reversal is a reasoned second entry
 * that never edits or voids the original payment.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-expense-payments-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const request = require('supertest');
const jwt = require('jsonwebtoken');
const {
  initTestDb, createApp, seedOwnerUser, seedManagerUser,
  assertOrThrow, assertEqualOrThrow, getResults, resetCounters, now,
} = require('./helpers/test-setup');
const { getDatabase, MIGRATIONS } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { expenseRoutes } = require('../main/routes/expenses');
const { cashClosureRoutes } = require('../main/routes/cash-closures');
const service = require('../main/services/expenses');

function seedRoleUser(db: any, label: string, role: string): Record<string, string> {
  const userId = `${label}-user`;
  db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 'unused-test-hash', ?, 1, ?, ?)`).run(userId, label, `${label}@test.local`, role, now(), now());
  return { Authorization: `Bearer ${jwt.sign({ userId, role }, getJWTSecret(), { expiresIn: '1h' })}` };
}

function setOverride(db: any, userId: string, permissionId: string, effect: 'allow' | 'deny'): void {
  db.prepare(`INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 'owner-test-001', ?, ?)`).run(userId, permissionId, effect, now(), now());
}

async function main(): Promise<number> {
  resetCounters();
  console.log('Expense payments and reversals test');
  console.log('='.repeat(50));

  // ── The payment reference is a nullable, additive column ──
  const referenceMigration = MIGRATIONS.find((migration: any) => migration.name === 'add_expense_payment_reference');
  assertOrThrow(referenceMigration, 'the payment reference migration is registered');
  assertEqualOrThrow(referenceMigration.version, 109, 'the payment reference migration keeps its registered version');

  const db = initTestDb();
  const managerUser = seedManagerUser(db);
  const paymentColumns = (db.prepare('PRAGMA table_info(expense_payments)').all() as { name: string }[]).map((row) => row.name);
  assertOrThrow(paymentColumns.includes('reference'), 'expense_payments carries an optional reference column');

  const countRows = (table: string, where = '', ...params: unknown[]): number =>
    Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get(...params) as { count: number }).count);

  const setSetting = (key: string, value: string) =>
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now());
  const openSession = (): number => {
    const result = db.prepare(`INSERT INTO cash_sessions (opened_by, opened_at, opening_float_cents, status)
      VALUES ('mgr-test-001', ?, 20000, 'open')`).run(now());
    return Number(result.lastInsertRowid);
  };
  const closeOpenSessions = () => db.prepare(`UPDATE cash_sessions SET status = 'closed' WHERE status = 'open'`).run();

  const actor = 'mgr-test-001';
  const today = service.currentBusinessDate();
  const category = service.createExpenseCategory(db, { name: 'Payment fixtures', actorUserId: actor, idempotencyKey: 'pay-cat' });
  const categoryId = category.body.category.id;
  const createExpense = (amountMinor: number, key: string, description = 'Fixture expense') =>
    service.createExpense(db, {
      category_id: categoryId, description, amount_minor: amountMinor, incurred_on: today,
      actorUserId: actor, idempotencyKey: key,
    }).body.expense;

  const expectError = (fn: () => unknown, statusCode: number, label: string, code: string | null = null): void => {
    try {
      fn();
      assertOrThrow(false, `${label} (expected status ${statusCode}, nothing was thrown)`);
    } catch (error: any) {
      assertEqualOrThrow(error?.statusCode, statusCode, label);
      if (code) assertEqualOrThrow(error?.code, code, `${label} carries code ${code}`);
    }
  };

  // ── Method, amount, and reference validation ──
  const payTarget = createExpense(100000, 'pay-target');
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 1000, actorUserId: actor, idempotencyKey: 'pay-no-method' }), 400, 'a payment without a method is rejected');
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 1000, method: 'loyalty', actorUserId: actor, idempotencyKey: 'pay-bad-method' }), 400, 'an unsupported payment method is rejected');
  for (const [amount, label] of [[0, 'zero'], [-100, 'negative'], [12.5, 'fractional'], ['1000', 'string'], [Number.MAX_SAFE_INTEGER + 1, 'unsafe']] as Array<[unknown, string]>) {
    expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: amount, method: 'other', actorUserId: actor, idempotencyKey: `pay-amount-${label}` }), 400, `a ${label} payment amount is rejected`);
  }
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 1000, method: 'other', reference: 'x'.repeat(201), actorUserId: actor, idempotencyKey: 'pay-long-ref' }), 400, 'an over-long reference is rejected');
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 1000, method: 'other', currency_code: 'USD', actorUserId: actor, idempotencyKey: 'pay-currency' }), 400, 'a payment currency other than the expense currency is rejected');
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 1000, method: 'other', currency_code: 'IN', actorUserId: actor, idempotencyKey: 'pay-currency-short' }), 400, 'a malformed payment currency is rejected');
  expectError(() => service.recordExpensePayment(db, 'missing-expense', { amount_minor: 1000, method: 'cash', actorUserId: actor, idempotencyKey: 'pay-missing' }), 404, 'paying an unknown expense is a 404');
  assertEqualOrThrow(countRows('expense_payments'), 0, 'no rejected payment wrote a ledger row');

  const voidTarget = createExpense(5000, 'pay-void-target');
  service.voidExpense(db, voidTarget.id, { reason: 'Duplicate', actorUserId: actor, idempotencyKey: 'pay-void' });
  expectError(() => service.recordExpensePayment(db, voidTarget.id, { amount_minor: 1000, method: 'other', actorUserId: actor, idempotencyKey: 'pay-voided' }), 409, 'a voided expense cannot receive a payment', 'expense_voided');
  const replaceTarget = createExpense(5000, 'pay-replace-target');
  const replacement = service.replaceExpense(db, replaceTarget.id, {
    category_id: categoryId, description: 'Replacement', amount_minor: 6000, incurred_on: today, reason: 'Correction',
    actorUserId: actor, idempotencyKey: 'pay-replace',
  });
  expectError(() => service.recordExpensePayment(db, replaceTarget.id, { amount_minor: 1000, method: 'other', actorUserId: actor, idempotencyKey: 'pay-replaced' }), 409, 'a replaced expense cannot receive a payment', 'expense_replaced');

  // ── Non-cash payment: ledger-only, replayable, reference stored trimmed ──
  const movementsBefore = countRows('cash_drawer_movements');
  const card1 = service.recordExpensePayment(db, payTarget.id, {
    amount_minor: 25000, method: 'card', reference: '  slip 4471  ', currency_code: 'inr',
    actorUserId: actor, idempotencyKey: 'pay-card-1',
  });
  assertEqualOrThrow(card1.status, 201, 'a card payment returns 201');
  assertEqualOrThrow(card1.body.payment.amount_minor, 25000, 'the payment stores the paid amount');
  assertEqualOrThrow(card1.body.payment.method, 'card', 'the payment stores its method');
  assertEqualOrThrow(card1.body.payment.reference, 'slip 4471', 'the reference is stored trimmed');
  assertEqualOrThrow(card1.body.payment.business_date, today, 'the payment lands on the store business date');
  assertEqualOrThrow(card1.body.payment.reversal_of, null, 'a payment is not a reversal');
  assertEqualOrThrow(card1.body.payment.reason, null, 'a payment carries no reversal reason');
  assertEqualOrThrow(card1.body.payment.cash_movement_id, null, 'a card payment links no drawer movement');
  assertEqualOrThrow(card1.body.payment.created_by, actor, 'the payment attributes the authenticated actor');
  assertOrThrow(card1.body.payment.id.startsWith('exppay_'), 'payment ids use the repo UUID convention');
  assertEqualOrThrow(card1.body.expense.paid_minor, 25000, 'the expense reports the partial payment');
  assertEqualOrThrow(card1.body.expense.due_minor, 75000, 'the expense reports the remaining due');
  assertEqualOrThrow(countRows('cash_drawer_movements'), movementsBefore, 'a card payment leaves the drawer untouched');
  assertEqualOrThrow(countRows('expense_payments', 'WHERE expense_id = ?', payTarget.id), 1, 'a card payment writes exactly one ledger row');

  setSetting('currency', 'EUR');
  const cardReplay = service.recordExpensePayment(db, payTarget.id, {
    amount_minor: 25000, method: 'card', reference: 'slip 4471',
    actorUserId: actor, idempotencyKey: 'pay-card-1',
  });
  setSetting('currency', 'INR');
  assertEqualOrThrow(cardReplay.replayed, true, 'an omitted currency_code still replays the committed payment after currency switch');
  assertEqualOrThrow(cardReplay.body.payment.id, card1.body.payment.id, 'the replay returns the committed payment id');
  assertEqualOrThrow(countRows('expense_payments', 'WHERE expense_id = ?', payTarget.id), 1, 'a replay writes no second ledger row');
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 25001, method: 'card', reference: 'slip 4471', actorUserId: actor, idempotencyKey: 'pay-card-1' }), 409, 'a reused payment key with a changed amount conflicts', 'idempotency_conflict');
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 25000, method: 'cash', reference: 'slip 4471', actorUserId: actor, idempotencyKey: 'pay-card-1' }), 409, 'a reused payment key with a changed method conflicts', 'idempotency_conflict');

  // ── A payment never exceeds the outstanding due ──
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 75001, method: 'other', actorUserId: actor, idempotencyKey: 'pay-over' }), 409, 'a payment larger than the outstanding due is rejected', 'expense_overpaid');
  const filled = service.recordExpensePayment(db, payTarget.id, { amount_minor: 75000, method: 'bank_transfer', actorUserId: actor, idempotencyKey: 'pay-fill' });
  assertEqualOrThrow(filled.body.expense.due_minor, 0, 'a payment equal to the due settles the expense');
  assertEqualOrThrow(filled.body.expense.status, 'active', 'a settled expense stays active');
  expectError(() => service.recordExpensePayment(db, payTarget.id, { amount_minor: 1, method: 'other', actorUserId: actor, idempotencyKey: 'pay-after-fill' }), 409, 'a fully paid expense accepts no further payment', 'expense_overpaid');

  // ── Cash payment: the drawer gate is real, not the configurable one ──
  const cashTarget = createExpense(100000, 'pay-cash-target');
  expectError(() => service.recordExpensePayment(db, cashTarget.id, { amount_minor: 40000, method: 'cash', actorUserId: actor, idempotencyKey: 'pay-cash-nosession' }), 409, 'a cash payment without an open session is rejected even while require_open_shift is off', 'cash_session_required');
  assertEqualOrThrow(countRows('expense_payments', 'WHERE expense_id = ?', cashTarget.id), 0, 'a cash payment without a session writes nothing');
  assertEqualOrThrow(countRows('cash_drawer_movements'), movementsBefore, 'a cash payment without a session moves no money');

  const sessionOne = openSession();
  const cash1 = service.recordExpensePayment(db, cashTarget.id, {
    amount_minor: 40000, method: 'cash', reference: 'Receipt 12', actorUserId: actor, idempotencyKey: 'pay-cash-1',
  });
  assertEqualOrThrow(cash1.status, 201, 'a cash payment succeeds with an open session');
  assertOrThrow(Number.isInteger(cash1.body.payment.cash_movement_id), 'a cash payment links its drawer movement');
  const cashMovement = db.prepare('SELECT * FROM cash_drawer_movements WHERE id = ?').get(cash1.body.payment.cash_movement_id) as any;
  assertEqualOrThrow(cashMovement.movement_type, 'pay_out', 'a cash payment writes a Pay Out');
  assertEqualOrThrow(cashMovement.amount_cents, 40000, 'the Pay Out carries the paid amount');
  assertEqualOrThrow(cashMovement.business_date, today, 'the Pay Out lands on the store business date');
  assertEqualOrThrow(cashMovement.cash_session_id, sessionOne, 'the Pay Out belongs to the open session');
  assertEqualOrThrow(cashMovement.created_by, actor, 'the Pay Out attributes the authenticated actor');
  assertOrThrow(typeof cashMovement.reason === 'string' && cashMovement.reason.length > 0, 'the Pay Out records a reason');
  assertEqualOrThrow(countRows('cash_drawer_movements'), movementsBefore + 1, 'a cash payment writes exactly one movement');

  closeOpenSessions();
  const cashReplay = service.recordExpensePayment(db, cashTarget.id, {
    amount_minor: 40000, method: 'cash', reference: 'Receipt 12', actorUserId: actor, idempotencyKey: 'pay-cash-1',
  });
  assertEqualOrThrow(cashReplay.replayed, true, 'a committed cash payment replays after its session closed');
  assertEqualOrThrow(countRows('cash_drawer_movements'), movementsBefore + 1, 'a cash replay writes no second movement');

  // A currency change after the expense was recorded blocks only the cash path.
  setSetting('currency', 'USD');
  expectError(() => service.recordExpensePayment(db, cashTarget.id, { amount_minor: 1000, method: 'cash', actorUserId: actor, idempotencyKey: 'pay-cash-foreign' }), 409, 'a cash payment in a mismatched store currency is rejected', 'currency_mismatch');
  setSetting('currency', 'INR');

  // A closed business day refuses new drawer money even while a session is open.
  openSession();
  db.prepare(`INSERT INTO cash_closures (
    scope, business_date, period_start, period_end, expected_cash_cents, counted_cash_cents, variance_cents,
    gross_collected_cents, refunded_cents, net_collected_cents, bill_count, refund_count, z_number, closed_by, created_at
  ) VALUES ('day', ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 99001, 'mgr-test-001', ?)`).run(today, `${today} 00:00:00`, `${today} 23:59:59`, now());
  expectError(() => service.recordExpensePayment(db, cashTarget.id, { amount_minor: 1000, method: 'cash', actorUserId: actor, idempotencyKey: 'pay-cash-closed' }), 409, 'a cash payment on a closed business day is rejected');
  assertEqualOrThrow(countRows('cash_drawer_movements'), movementsBefore + 1, 'a closed-day rejection writes no movement');
  db.prepare(`DELETE FROM cash_closures WHERE business_date = ? AND scope = 'day' AND z_number = 99001`).run(today);

  const cash2 = service.recordExpensePayment(db, cashTarget.id, { amount_minor: 60000, method: 'cash', actorUserId: actor, idempotencyKey: 'pay-cash-2' });
  assertEqualOrThrow(cash2.body.expense.due_minor, 0, 'the second cash payment settles the expense');
  assertEqualOrThrow(countRows('cash_drawer_movements'), movementsBefore + 2, 'each cash payment writes its own movement');

  // ── Reversal: reasoned, linked, and never an edit of the original ──
  const cardPaymentId = card1.body.payment.id;
  const otherExpense = createExpense(1000, 'pay-other');
  expectError(() => service.reverseExpensePayment(db, payTarget.id, 'missing-payment', { reason: 'Nope', actorUserId: actor, idempotencyKey: 'rev-missing' }), 404, 'reversing an unknown payment is a 404');
  expectError(() => service.reverseExpensePayment(db, otherExpense.id, cardPaymentId, { reason: 'Wrong expense', actorUserId: actor, idempotencyKey: 'rev-wrong-expense' }), 404, 'a payment cannot be reversed through another expense');
  expectError(() => service.reverseExpensePayment(db, payTarget.id, cardPaymentId, { actorUserId: actor, idempotencyKey: 'rev-no-reason' }), 400, 'a reversal without a reason is rejected');
  expectError(() => service.reverseExpensePayment(db, payTarget.id, cardPaymentId, { reason: '   ', actorUserId: actor, idempotencyKey: 'rev-blank-reason' }), 400, 'a blank reversal reason is rejected');
  expectError(() => service.reverseExpensePayment(db, payTarget.id, cardPaymentId, { reason: 'x'.repeat(501), actorUserId: actor, idempotencyKey: 'rev-long-reason' }), 400, 'an over-long reversal reason is rejected');
  assertEqualOrThrow(countRows('expense_payments', 'WHERE expense_id = ?', payTarget.id), 2, 'no rejected reversal wrote a ledger row');

  const cardReversal = service.reverseExpensePayment(db, payTarget.id, cardPaymentId, { reason: 'Slip was for a different vendor', actorUserId: actor, idempotencyKey: 'rev-card-1' });
  assertEqualOrThrow(cardReversal.status, 201, 'a reversal returns 201');
  assertEqualOrThrow(cardReversal.body.payment.amount_minor, 25000, 'a reversal copies the original amount');
  assertEqualOrThrow(cardReversal.body.payment.method, 'card', 'a reversal copies the original method');
  assertEqualOrThrow(cardReversal.body.payment.reversal_of, cardPaymentId, 'the reversal names the payment it reverses');
  assertEqualOrThrow(cardReversal.body.payment.reason, 'Slip was for a different vendor', 'the reversal stores its reason');
  assertEqualOrThrow(cardReversal.body.payment.reference, null, 'a reversal carries no reference');
  assertEqualOrThrow(cardReversal.body.payment.business_date, today, 'the reversal lands on the store business date');
  assertEqualOrThrow(cardReversal.body.payment.cash_movement_id, null, 'a card reversal moves no drawer money');
  assertEqualOrThrow(cardReversal.body.expense.paid_minor, 75000, 'net paid drops by the reversed amount');
  assertEqualOrThrow(cardReversal.body.expense.due_minor, 25000, 'due reconciles after the reversal');

  const reversalReplay = service.reverseExpensePayment(db, payTarget.id, cardPaymentId, { reason: 'Slip was for a different vendor', actorUserId: actor, idempotencyKey: 'rev-card-1' });
  assertEqualOrThrow(reversalReplay.replayed, true, 'a replayed reversal returns the committed result');
  expectError(() => service.reverseExpensePayment(db, payTarget.id, cardPaymentId, { reason: 'Different', actorUserId: actor, idempotencyKey: 'rev-card-1' }), 409, 'a reused reversal key with a changed reason conflicts', 'idempotency_conflict');
  expectError(() => service.reverseExpensePayment(db, payTarget.id, cardPaymentId, { reason: 'Again', actorUserId: actor, idempotencyKey: 'rev-card-2' }), 409, 'an already reversed payment cannot be reversed again', 'payment_already_reversed');
  expectError(() => service.reverseExpensePayment(db, payTarget.id, cardReversal.body.payment.id, { reason: 'Undo the undo', actorUserId: actor, idempotencyKey: 'rev-reversal' }), 409, 'a reversal entry cannot itself be reversed', 'reversal_not_reversible');

  const afterPayHistory = service.listExpensePayments(db, payTarget.id);
  assertEqualOrThrow(afterPayHistory.payments.length, 3, 'the history keeps payments and their reversals as separate entries');
  assertOrThrow(afterPayHistory.payments.some((row: any) => row.id === cardReversal.body.payment.id), 'the recorded reversal is readable through the history');
  const afterPaySummary = service.summarizeExpenses(db, { from: today, to: today, categoryId });
  const afterPayTotals = afterPaySummary.totals.find((row: any) => row.currency_code === 'INR');
  assertEqualOrThrow(afterPayTotals.incurred_minor - afterPayTotals.net_paid_minor, afterPayTotals.due_minor, 'the summary reconciles incurred = net paid + due after reversals');

  // ── Cash reversal: today's drawer, a linked Pay In, original Pay Out untouched ──
  closeOpenSessions();
  expectError(() => service.reverseExpensePayment(db, cashTarget.id, cash1.body.payment.id, { reason: 'Paid from the wrong drawer', actorUserId: actor, idempotencyKey: 'rev-cash-nosession' }), 409, 'a cash reversal without an open session is rejected', 'cash_session_required');

  // The original payment may have landed on an earlier day; the reversal always uses today.
  db.prepare('UPDATE expense_payments SET business_date = ? WHERE id = ?').run('2026-01-05', cash1.body.payment.id);
  const sessionTwo = openSession();
  const cashReversal = service.reverseExpensePayment(db, cashTarget.id, cash1.body.payment.id, { reason: 'Paid from the wrong drawer', actorUserId: actor, idempotencyKey: 'rev-cash-1' });
  assertEqualOrThrow(cashReversal.status, 201, 'a cash reversal succeeds with an open session');
  assertEqualOrThrow(cashReversal.body.payment.method, 'cash', 'the cash reversal keeps the original method');
  assertEqualOrThrow(cashReversal.body.expense.paid_minor, 60000, 'net paid drops by the reversed cash amount');
  const reversalMovement = db.prepare('SELECT * FROM cash_drawer_movements WHERE id = ?').get(cashReversal.body.payment.cash_movement_id) as any;
  assertEqualOrThrow(reversalMovement.movement_type, 'pay_in', 'a cash reversal writes a Pay In');
  assertEqualOrThrow(reversalMovement.amount_cents, 40000, 'the Pay In carries the reversed amount');
  assertEqualOrThrow(reversalMovement.cash_session_id, sessionTwo, "the Pay In belongs to today's open session");
  assertEqualOrThrow(reversalMovement.business_date, today, 'the Pay In lands on today, not the original payment day');
  const originalMovement = db.prepare('SELECT * FROM cash_drawer_movements WHERE id = ?').get(cash1.body.payment.cash_movement_id) as any;
  assertEqualOrThrow(originalMovement.voided_at, null, 'reversing a payment never voids its original Pay Out');
  assertEqualOrThrow(countRows('cash_drawer_movements'), movementsBefore + 3, 'the cash reversal writes exactly one new movement');

  // ── A failure after the drawer movement rolls the whole payment back ──
  const rollbackTarget = createExpense(50000, 'pay-rollback-target');
  const movementsBeforeInjected = countRows('cash_drawer_movements');
  db.exec(`CREATE TRIGGER expense_payments_injected_failure BEFORE INSERT ON expense_payments
    BEGIN SELECT RAISE(ABORT, 'injected payment insert failure'); END`);
  let injectedError = false;
  try {
    service.recordExpensePayment(db, rollbackTarget.id, { amount_minor: 5000, method: 'cash', actorUserId: actor, idempotencyKey: 'pay-rollback' });
  } catch {
    injectedError = true;
  }
  db.exec('DROP TRIGGER expense_payments_injected_failure');
  assertEqualOrThrow(injectedError, true, 'the injected ledger failure surfaces instead of being swallowed');
  assertEqualOrThrow(countRows('cash_drawer_movements'), movementsBeforeInjected, 'a failed cash payment rolls back its drawer movement');
  assertEqualOrThrow(countRows('expense_payments', 'WHERE expense_id = ?', rollbackTarget.id), 0, 'a failed payment writes no ledger row');
  assertEqualOrThrow(countRows('expense_mutations', 'WHERE idempotency_key = ?', 'pay-rollback'), 0, 'a failed payment records no receipt');
  const afterInjection = service.recordExpensePayment(db, rollbackTarget.id, { amount_minor: 5000, method: 'cash', actorUserId: actor, idempotencyKey: 'pay-rollback' });
  assertEqualOrThrow(afterInjection.status, 201, 'the same key succeeds once the failure clears');

  // ── HTTP surface: permissions, idempotency, and the drawer guard ──
  const owner = seedOwnerUser(db).authHeader;
  const manager = managerUser.authHeader;
  const cashier = seedRoleUser(db, 'pay-cashier', 'cashier');
  const serverUser = seedRoleUser(db, 'pay-server', 'server');
  const app = createApp({ '/api/expenses': expenseRoutes, '/api/cash-closures': cashClosureRoutes });

  for (const [method, url] of [
    ['post', '/api/expenses/anything/payments'],
    ['post', '/api/expenses/anything/payments/anything/reverse'],
  ] as Array<[string, string]>) {
    const response = await (request(app) as any)[method](url).send({});
    assertEqualOrThrow(response.status, 401, `${method.toUpperCase()} ${url} rejects an anonymous request`);
  }
  const deniedPayment = await request(app).post('/api/expenses/http-target/payments').set(cashier).set('Idempotency-Key', 'pay-denied').send({ amount_minor: 100, method: 'other' });
  assertEqualOrThrow(deniedPayment.status, 403, 'a cashier cannot record an expense payment by default');
  assertEqualOrThrow((await request(app).get('/api/expenses').set(owner)).status, 200, 'an owner keeps the expense reads');

  const httpCategory = await request(app).post('/api/expenses/categories').set(manager).set('Idempotency-Key', 'pay-http-cat').send({ name: 'HTTP fixtures' });
  const httpExpense = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'pay-http-exp').send({
    category_id: httpCategory.body.category.id, description: 'HTTP fixture expense', amount_minor: 200000, incurred_on: today,
  });
  const httpExpenseId = httpExpense.body.expense.id;

  const noKey = await request(app).post(`/api/expenses/${httpExpenseId}/payments`).set(manager).send({ amount_minor: 100, method: 'other' });
  assertEqualOrThrow(noKey.status, 400, 'a payment without an idempotency key is rejected');
  assertEqualOrThrow(noKey.body.code, 'idempotency_key_required', 'the missing payment key names its code');

  const httpCard = await request(app).post(`/api/expenses/${httpExpenseId}/payments`).set(manager).set('Idempotency-Key', 'pay-http-card').send({ amount_minor: 50000, method: 'card', reference: 'POS slip' });
  assertEqualOrThrow(httpCard.status, 201, 'a manager can record a card payment');
  assertEqualOrThrow(httpCard.body.payment.reference, 'POS slip', 'the payment reference round-trips through HTTP');
  assertEqualOrThrow(httpCard.body.payment.cash_movement_id, null, 'the HTTP card payment links no drawer movement');
  assertEqualOrThrow(httpCard.body.expense.due_minor, 150000, 'the payment updates the returned balance');
  const httpCardReplay = await request(app).post(`/api/expenses/${httpExpenseId}/payments`).set(manager).set('Idempotency-Key', 'pay-http-card').send({ amount_minor: 50000, method: 'card', reference: 'POS slip' });
  assertEqualOrThrow(httpCardReplay.headers['idempotent-replay'], 'true', 'a replayed payment is labelled');

  // Cash needs drawer authority on top of pay authority: a server role has no
  // drawer access by default, so the same grant pays by card but not in cash.
  const serverUserId = 'pay-server-user';
  setOverride(db, serverUserId, 'expenses.view', 'allow');
  setOverride(db, serverUserId, 'expenses.pay', 'allow');
  const cashDenied = await request(app).post(`/api/expenses/${httpExpenseId}/payments`).set(serverUser).set('Idempotency-Key', 'pay-http-server-cash').send({ amount_minor: 1000, method: 'cash' });
  assertEqualOrThrow(cashDenied.status, 403, 'a cash payment needs drawer authority, not just pay authority');
  assertEqualOrThrow(cashDenied.body.code, 'permission_denied', 'the cash denial names its code');
  const serverCard = await request(app).post(`/api/expenses/${httpExpenseId}/payments`).set(serverUser).set('Idempotency-Key', 'pay-http-server-card').send({ amount_minor: 1000, method: 'other' });
  assertEqualOrThrow(serverCard.status, 201, 'the granted non-cash payment succeeds');

  closeOpenSessions();
  const noSessionCash = await request(app).post(`/api/expenses/${httpExpenseId}/payments`).set(manager).set('Idempotency-Key', 'pay-http-nosession').send({ amount_minor: 1000, method: 'cash' });
  assertEqualOrThrow(noSessionCash.status, 409, 'a cash payment without an open session is a 409');
  assertEqualOrThrow(noSessionCash.body.code, 'cash_session_required', 'the missing session names its code');
  assertOrThrow(typeof noSessionCash.body.error === 'string' && noSessionCash.body.error.length > 0, 'the missing session returns an actionable message');

  openSession();
  const httpCash = await request(app).post(`/api/expenses/${httpExpenseId}/payments`).set(manager).set('Idempotency-Key', 'pay-http-cash').send({ amount_minor: 25000, method: 'cash' });
  assertEqualOrThrow(httpCash.status, 201, 'a manager can record a cash payment');
  assertOrThrow(Number.isInteger(httpCash.body.payment.cash_movement_id), 'the HTTP cash payment links a drawer movement');

  // Reversal: separate authority, reasoned, and linked back through the route.
  const cashierReversal = await request(app).post(`/api/expenses/${httpExpenseId}/payments/${httpCard.body.payment.id}/reverse`).set(cashier).set('Idempotency-Key', 'pay-http-rev-denied').send({ reason: 'Try' });
  assertEqualOrThrow(cashierReversal.status, 403, 'reversal needs its own granted authority');
  const noReason = await request(app).post(`/api/expenses/${httpExpenseId}/payments/${httpCard.body.payment.id}/reverse`).set(manager).set('Idempotency-Key', 'pay-http-rev-noreason').send({});
  assertEqualOrThrow(noReason.status, 400, 'a reversal without a reason is rejected over HTTP');
  const httpReversal = await request(app).post(`/api/expenses/${httpExpenseId}/payments/${httpCard.body.payment.id}/reverse`).set(manager).set('Idempotency-Key', 'pay-http-rev').send({ reason: 'Slip voided by the bank' });
  assertEqualOrThrow(httpReversal.status, 201, 'a manager can reverse a payment');
  assertEqualOrThrow(httpReversal.body.payment.reversal_of, httpCard.body.payment.id, 'the reversal links its payment over HTTP');
  const detailAfter = await request(app).get(`/api/expenses/${httpExpenseId}`).set(manager);
  assertOrThrow(detailAfter.body.payments.some((row: any) => row.id === httpReversal.body.payment.id), 'the detail history exposes the reversal');

  // ── A drawer movement linked to an expense entry is corrected through expenses ──
  const linkedVoid = await request(app).post(`/api/cash-closures/movements/${httpCash.body.payment.cash_movement_id}/void`).set(manager).send({ reason: 'Wrong amount' });
  assertEqualOrThrow(linkedVoid.status, 409, 'a movement backing an expense payment cannot be voided directly');
  assertOrThrow(typeof linkedVoid.body.error === 'string' && /expense/i.test(linkedVoid.body.error), 'the linked-void message routes the correction to the expense ledger');
  const linkedRow = db.prepare('SELECT voided_at FROM cash_drawer_movements WHERE id = ?').get(httpCash.body.payment.cash_movement_id) as any;
  assertEqualOrThrow(linkedRow.voided_at, null, 'the rejected void leaves the linked movement active');
  const cashReverseRoute = await request(app).post(`/api/expenses/${httpExpenseId}/payments/${httpCash.body.payment.id}/reverse`).set(manager).set('Idempotency-Key', 'pay-http-rev-cash').send({ reason: 'Money returned to the drawer' });
  assertEqualOrThrow(cashReverseRoute.status, 201, 'the cash payment is reversed through the expense ledger');
  const reversalVoid = await request(app).post(`/api/cash-closures/movements/${cashReverseRoute.body.payment.cash_movement_id}/void`).set(manager).send({ reason: 'Wrong' });
  assertEqualOrThrow(reversalVoid.status, 409, 'the reversal Pay In is protected by the same guard');

  const standalone = await request(app).post('/api/cash-closures/movements').set(manager).send({ business_date: today, movement_type: 'pay_in', amount_cents: 250, reason: 'Unlinked fixture' });
  assertEqualOrThrow(standalone.status, 201, 'an unlinked movement is still created directly');
  const standaloneVoid = await request(app).post(`/api/cash-closures/movements/${standalone.body.movement.id}/void`).set(manager).send({ reason: 'Entered twice' });
  assertEqualOrThrow(standaloneVoid.status, 200, 'an unlinked movement still voids directly');

  db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(serverUserId);
  assertEqualOrThrow((await request(app).get('/api/expenses').set(serverUser)).status, 403, 'clearing the grant restores the shipped default');

  const results = getResults();
  console.log(`\nExpense payments: ${results.passed}/${results.total} checks passed`);
  if (results.failed > 0) {
    console.error(`   ${results.failed} failing check(s)`);
    process.exitCode = 1;
  }
  return results.failed;
}

main().then((failures: number) => {
  const { closeDatabase } = require('../main/db');
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log(failures > 0 ? '❌ Expense payments test finished with failures' : '✅ Expense payments test passed');
}).catch((error: unknown) => {
  try {
    const { closeDatabase } = require('../main/db');
    closeDatabase();
  } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
