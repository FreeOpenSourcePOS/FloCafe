/**
 * Expense API: permission matrix, idempotency, validation, and read consistency.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/expense-api.test.ts
 *
 * The transport contract the operator surfaces (and the payment work that
 * follows) build on: reads need `expenses.view`, writes need view + manage,
 * every mutation carries an actor-scoped idempotency key, and the list, detail
 * and summary views describe the same rows.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-expense-api-'));
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
const { getDatabase } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { expenseRoutes } = require('../main/routes/expenses');

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

function expectErrorCode(body: any, code: string, label: string): void {
  assertEqualOrThrow(body?.code, code, label);
}

async function main(): Promise<number> {
  resetCounters();
  console.log('Expense API test');
  console.log('='.repeat(50));

  const db = initTestDb();
  const owner = seedOwnerUser(db).authHeader;
  const manager = seedManagerUser(db).authHeader;
  const cashier = seedRoleUser(db, 'expense-cashier', 'cashier');
  const server = seedRoleUser(db, 'expense-server', 'server');
  const chef = seedRoleUser(db, 'expense-chef', 'chef');
  const app = createApp({ '/api/expenses': expenseRoutes });

  // ── Authentication and shipped role defaults ──
  const endpoints: Array<[string, string]> = [
    ['get', '/api/expenses'],
    ['get', '/api/expenses/context'],
    ['get', '/api/expenses/summary'],
    ['get', '/api/expenses/categories'],
    ['get', '/api/expenses/anything'],
    ['post', '/api/expenses'],
    ['post', '/api/expenses/anything/void'],
    ['post', '/api/expenses/anything/replace'],
    ['post', '/api/expenses/categories'],
    ['patch', '/api/expenses/categories/anything'],
  ];
  for (const [method, url] of endpoints) {
    const response = await (request(app) as any)[method](url).send({});
    assertEqualOrThrow(response.status, 401, `${method.toUpperCase()} ${url} rejects an anonymous request`);
  }

  for (const [label, user] of [['cashier', cashier], ['server', server], ['chef', chef]] as Array<[string, Record<string, string>]>) {
    const read = await request(app).get('/api/expenses').set(user);
    assertEqualOrThrow(read.status, 403, `${label} cannot list expenses by default`);
    expectErrorCode(read.body, 'permission_denied', `${label} denial names its code`);
    const write = await request(app).post('/api/expenses').set(user).set('Idempotency-Key', `denied-${label}`).send({});
    assertEqualOrThrow(write.status, 403, `${label} cannot create an expense by default`);
  }
  assertEqualOrThrow((await request(app).get('/api/expenses').set(owner)).status, 200, 'an owner can list expenses');
  assertEqualOrThrow((await request(app).get('/api/expenses').set(manager)).status, 200, 'a manager can list expenses');

  // ── Context is the only place the browser learns store currency and business date ──
  const context = await request(app).get('/api/expenses/context').set(owner);
  assertEqualOrThrow(context.status, 200, 'context is readable');
  assertEqualOrThrow(
    Object.keys(context.body).sort().join(','),
    'business_date,cash_session_open,currency_code',
    'context exposes only currency, business date, and drawer state',
  );
  assertEqualOrThrow(context.body.currency_code, 'INR', 'context reports the configured store currency');
  assertEqualOrThrow(context.body.cash_session_open, false, 'context reports no open drawer in this fixture');
  const today = context.body.business_date as string;

  // ── Category mutations: explicit values, idempotent, same key scope as expenses ──
  const categoryCreate = await request(app).post('/api/expenses/categories').set(manager).set('Idempotency-Key', 'api-cat-rent').send({ name: 'Rent' });
  assertEqualOrThrow(categoryCreate.status, 201, 'a manager can create a category');
  const rentCategoryId = categoryCreate.body.category.id;
  const categoryReplay = await request(app).post('/api/expenses/categories').set(manager).set('Idempotency-Key', 'api-cat-rent').send({ name: 'Rent' });
  assertEqualOrThrow(categoryReplay.status, 201, 'a replayed category create keeps its original status');
  assertEqualOrThrow(categoryReplay.headers['idempotent-replay'], 'true', 'a replayed create is labelled');
  assertEqualOrThrow(categoryReplay.body.category.id, rentCategoryId, 'a replayed create returns the committed id');
  const categoryConflict = await request(app).post('/api/expenses/categories').set(manager).set('Idempotency-Key', 'api-cat-rent').send({ name: 'Rent renamed' });
  assertEqualOrThrow(categoryConflict.status, 409, 'a reused key with a different payload is a conflict');
  expectErrorCode(categoryConflict.body, 'idempotency_conflict', 'the conflict names its code');
  const categoryNoKey = await request(app).post('/api/expenses/categories').set(manager).send({ name: 'Supplies' });
  assertEqualOrThrow(categoryNoKey.status, 400, 'a mutation without an idempotency key is rejected');
  expectErrorCode(categoryNoKey.body, 'idempotency_key_required', 'the missing key names its code');
  const categoryDuplicate = await request(app).post('/api/expenses/categories').set(manager).set('Idempotency-Key', 'api-cat-rent-2').send({ name: '  rent  ' });
  assertEqualOrThrow(categoryDuplicate.status, 409, 'category names are unique case-insensitively through the API');
  const categoryMissing = await request(app).patch('/api/expenses/categories/missing').set(manager).set('Idempotency-Key', 'api-cat-missing').send({ name: 'Ghost' });
  assertEqualOrThrow(categoryMissing.status, 404, 'patching an unknown category is a 404');
  assertEqualOrThrow(categoryMissing.body.error, 'Expense category not found', 'the 404 body is human-readable');
  const categoryNoop = await request(app).patch(`/api/expenses/categories/${rentCategoryId}`).set(manager).set('Idempotency-Key', 'api-cat-noop').send({});
  assertEqualOrThrow(categoryNoop.status, 400, 'a category patch must set an explicit value');
  const categoryDeactivate = await request(app).patch(`/api/expenses/categories/${rentCategoryId}`).set(manager).set('Idempotency-Key', 'api-cat-off').send({ is_active: false });
  assertEqualOrThrow(categoryDeactivate.status, 200, 'a category can be deactivated with an explicit value');
  assertEqualOrThrow(categoryDeactivate.body.category.is_active, 0, 'the deactivation is stored, not toggled');
  assertOrThrow(
    !(await request(app).get('/api/expenses/categories').set(manager)).body.categories.some((row: any) => row.id === rentCategoryId),
    'the default category list hides deactivated categories',
  );
  assertOrThrow(
    (await request(app).get('/api/expenses/categories?include_inactive=true').set(manager)).body.categories.some((row: any) => row.id === rentCategoryId),
    'include_inactive keeps deactivated categories readable',
  );
  const activeCategory = await request(app).post('/api/expenses/categories').set(manager).set('Idempotency-Key', 'api-cat-utilities').send({ name: 'Utilities' });
  assertEqualOrThrow(activeCategory.status, 201, 'a second category is created');
  const utilitiesCategoryId = activeCategory.body.category.id;

  const inactiveExpense = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'api-exp-inactive').send({
    category_id: rentCategoryId, description: 'Inactive category', amount_minor: 500, incurred_on: today,
  });
  assertEqualOrThrow(inactiveExpense.status, 409, 'a deactivated category cannot receive a new expense');
  expectErrorCode(inactiveExpense.body, 'category_inactive', 'the inactive category names its code');

  // ── Expense creation validates, then replays ──
  const createPayload = {
    category_id: utilitiesCategoryId, description: 'October utilities', amount_minor: 420000, incurred_on: today, payee: 'City Power', notes: 'meter 12',
  };
  const created = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'api-exp-utilities').send(createPayload);
  assertEqualOrThrow(created.status, 201, 'a manager can create an expense');
  assertEqualOrThrow(created.body.expense.paid_minor, 0, 'a new expense never starts paid');
  assertEqualOrThrow(created.body.expense.due_minor, 420000, 'the full amount is due');
  assertEqualOrThrow(created.body.expense.currency_code, 'INR', 'the expense snapshots the store currency');
  assertEqualOrThrow(created.body.expense.created_by, 'mgr-test-001', 'the expense attributes the authenticated actor');
  const expenseId = created.body.expense.id;
  const createReplay = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'api-exp-utilities').send(createPayload);
  assertEqualOrThrow(createReplay.status, 201, 'a replayed expense create keeps its original status');
  assertEqualOrThrow(createReplay.headers['idempotent-replay'], 'true', 'a replayed expense create is labelled');
  assertEqualOrThrow(createReplay.body.expense.id, expenseId, 'a replayed expense create returns the committed id');
  assertEqualOrThrow(
    Number(db.prepare('SELECT COUNT(*) AS count FROM expenses').get().count),
    1,
    'the replay wrote only one expense row',
  );
  const changedPayload = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'api-exp-utilities').send({ ...createPayload, amount_minor: 1 });
  assertEqualOrThrow(changedPayload.status, 409, 'the same key with a changed amount conflicts');
  expectErrorCode(changedPayload.body, 'idempotency_conflict', 'the changed payload names its code');

  const malformed: Array<[Record<string, unknown>, string]> = [
    [{ ...createPayload, amount_minor: 0 }, 'a zero amount'],
    [{ ...createPayload, amount_minor: -5 }, 'a negative amount'],
    [{ ...createPayload, amount_minor: 10.5 }, 'a fractional amount'],
    [{ ...createPayload, amount_minor: '420000' }, 'a string amount'],
    [{ ...createPayload, amount_minor: Number.MAX_SAFE_INTEGER + 2 }, 'an unsafe amount'],
    [{ ...createPayload, incurred_on: '2026-02-30' }, 'an impossible date'],
    [{ ...createPayload, incurred_on: '01-02-2026' }, 'a non-ISO date'],
    [{ ...createPayload, description: '' }, 'a blank description'],
    [{ ...createPayload, description: 'x'.repeat(201) }, 'an over-long description'],
    [{ ...createPayload, notes: 'x'.repeat(501) }, 'over-long notes'],
    [{ ...createPayload, currency_code: 'USD' }, 'a foreign currency'],
    [{ ...createPayload, replaces_expense_id: expenseId }, 'a create-time replace link'],
  ];
  for (const [payload, label] of malformed) {
    const response = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', `api-malformed-${label.replace(/\W+/g, '-')}`).send(payload);
    assertEqualOrThrow(response.status, 400, `${label} is rejected with 400`);
    assertOrThrow(typeof response.body.error === 'string' && response.body.error.length > 0, `${label} returns an error message`);
  }
  const future = new Date(`${today}T00:00:00Z`);
  future.setUTCDate(future.getUTCDate() + 1);
  const futureResponse = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'api-future').send({ ...createPayload, incurred_on: future.toISOString().slice(0, 10) });
  assertEqualOrThrow(futureResponse.status, 400, 'a future incurred date is rejected');
  const unknownCategory = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'api-unknown-cat').send({ ...createPayload, category_id: 'missing-category' });
  assertEqualOrThrow(unknownCategory.status, 404, 'an unknown category is a 404');

  // ── Read consistency: list, detail and summary describe the same rows ──
  const historical = new Date(`${today}T00:00:00Z`);
  historical.setUTCDate(historical.getUTCDate() - 10);
  const historicalDate = historical.toISOString().slice(0, 10);
  const second = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'api-exp-historical').send({
    category_id: utilitiesCategoryId, description: 'Earlier utilities', amount_minor: 80000, incurred_on: historicalDate,
  });
  assertEqualOrThrow(second.status, 201, 'an earlier business date is accepted');

  const list = await request(app).get('/api/expenses').set(manager);
  assertEqualOrThrow(list.status, 200, 'the expense list is readable');
  assertEqualOrThrow(list.body.expenses.length, 2, 'the list returns both expenses');
  assertEqualOrThrow(list.body.maxLimit, 100, 'the list advertises its page cap');
  const listTotal = list.body.expenses.reduce((sum: number, row: any) => sum + row.amount_minor, 0);
  assertEqualOrThrow(listTotal, 500000, 'the list exposes amounts in minor units without scaling');
  const bounded = await request(app).get('/api/expenses?limit=1').set(manager);
  assertEqualOrThrow(bounded.body.expenses.length, 1, 'limit bounds the list');
  assertEqualOrThrow(typeof bounded.body.nextCursor, 'string', 'a truncated list exposes a cursor');
  const nextPage = await request(app).get(`/api/expenses?limit=1&cursor=${encodeURIComponent(bounded.body.nextCursor)}`).set(manager);
  assertEqualOrThrow(nextPage.body.expenses.length, 1, 'the cursor continues the list');
  assertOrThrow(nextPage.body.expenses[0].id !== bounded.body.expenses[0].id, 'the next page returns a different expense');
  const badLimit = await request(app).get('/api/expenses?limit=0').set(manager);
  assertEqualOrThrow(badLimit.status, 400, 'a non-positive limit is rejected');
  const badCursor = await request(app).get('/api/expenses?cursor=nonsense').set(manager);
  assertEqualOrThrow(badCursor.status, 400, 'a malformed cursor is rejected');

  const detail = await request(app).get(`/api/expenses/${expenseId}`).set(manager);
  assertEqualOrThrow(detail.status, 200, 'the detail endpoint is readable');
  assertEqualOrThrow(detail.body.expense.id, expenseId, 'the detail returns the requested expense');
  assertEqualOrThrow(detail.body.payments.length, 0, 'a new expense has no payment history');
  assertEqualOrThrow((await request(app).get('/api/expenses/missing-expense').set(manager)).status, 404, 'an unknown expense id is a 404');

  const summary = await request(app).get(`/api/expenses/summary?category_id=${utilitiesCategoryId}`).set(manager);
  assertEqualOrThrow(summary.status, 200, 'the summary endpoint is routed before the expense id route');
  assertEqualOrThrow(summary.body.basis, 'active_expenses_incurred_in_range_paid_to_date', 'the summary states its basis');
  assertEqualOrThrow(summary.body.groups.length, 1, 'the summary groups by currency and category');
  assertEqualOrThrow(summary.body.groups[0].expense_count, 2, 'the summary counts both expenses');
  assertEqualOrThrow(summary.body.groups[0].incurred_minor, 500000, 'the summary reconciles the listed amounts');
  assertEqualOrThrow(summary.body.groups[0].net_paid_minor, 0, 'nothing is paid yet');
  assertEqualOrThrow(summary.body.groups[0].due_minor, 500000, 'due equals incurred while nothing is paid');
  const totals = summary.body.totals.find((row: any) => row.currency_code === 'INR');
  assertEqualOrThrow(totals.incurred_minor, 500000, 'currency totals reconcile with the grouped amounts');

  // ── Void and replace through HTTP ──
  const voidMissingReason = await request(app).post(`/api/expenses/${expenseId}/void`).set(manager).set('Idempotency-Key', 'api-void-no-reason').send({});
  assertEqualOrThrow(voidMissingReason.status, 400, 'a void without a reason is rejected');
  const voided = await request(app).post(`/api/expenses/${expenseId}/void`).set(manager).set('Idempotency-Key', 'api-void-1').send({ reason: 'Billed twice' });
  assertEqualOrThrow(voided.status, 200, 'a manager can void an expense');
  assertEqualOrThrow(voided.body.expense.status, 'voided', 'the void is reflected in the row');
  assertEqualOrThrow(voided.body.expense.amount_minor, 420000, 'the void preserves the original amount');
  const voidReplay = await request(app).post(`/api/expenses/${expenseId}/void`).set(manager).set('Idempotency-Key', 'api-void-1').send({ reason: 'Billed twice' });
  assertEqualOrThrow(voidReplay.status, 200, 'a replayed void answers 200');
  assertEqualOrThrow(voidReplay.headers['idempotent-replay'], 'true', 'a replayed void is labelled');
  const doubleVoid = await request(app).post(`/api/expenses/${expenseId}/void`).set(manager).set('Idempotency-Key', 'api-void-2').send({ reason: 'Again' });
  assertEqualOrThrow(doubleVoid.status, 409, 'an already voided expense cannot be voided again');

  const afterVoidSummary = await request(app).get(`/api/expenses/summary?category_id=${utilitiesCategoryId}`).set(manager);
  assertEqualOrThrow(afterVoidSummary.body.groups[0].expense_count, 1, 'headline totals exclude the voided expense');
  assertEqualOrThrow(afterVoidSummary.body.groups[0].incurred_minor, 80000, 'headline incurred drops the voided amount');
  const voidHistory = await request(app).get(`/api/expenses?status=voided&category_id=${utilitiesCategoryId}`).set(manager);
  assertEqualOrThrow(voidHistory.body.expenses.length, 1, 'the history filter still reaches the voided expense');
  assertEqualOrThrow(voidHistory.body.expenses[0].id, expenseId, 'the history filter returns the voided row');
  const inactiveStatus = await request(app).get('/api/expenses?status=paid').set(manager);
  assertEqualOrThrow(inactiveStatus.status, 400, 'an unknown status filter is rejected');

  const replacePayload = { category_id: utilitiesCategoryId, description: 'Corrected utilities', amount_minor: 90000, incurred_on: historicalDate, reason: 'Tighter reading' };
  const replaced = await request(app).post(`/api/expenses/${second.body.expense.id}/replace`).set(manager).set('Idempotency-Key', 'api-replace-1').send(replacePayload);
  assertEqualOrThrow(replaced.status, 201, 'replace returns the replacement');
  assertEqualOrThrow(replaced.body.replaced_expense_id, second.body.expense.id, 'replace names the source');
  assertEqualOrThrow(replaced.body.expense.replaces_expense_id, second.body.expense.id, 'the replacement links back');
  const sourceAfterReplace = await request(app).get(`/api/expenses/${second.body.expense.id}`).set(manager);
  assertEqualOrThrow(sourceAfterReplace.body.expense.status, 'replaced', 'the source is reported as replaced');
  assertEqualOrThrow(sourceAfterReplace.body.expense.void_reason, 'Tighter reading', 'the source records the replacement reason');
  const replaceAgain = await request(app).post(`/api/expenses/${second.body.expense.id}/replace`).set(manager).set('Idempotency-Key', 'api-replace-2').send(replacePayload);
  assertEqualOrThrow(replaceAgain.status, 409, 'a replaced source cannot be replaced twice');

  // ── A paid expense is protected from void and replacement ──
  const paid = await request(app).post('/api/expenses').set(manager).set('Idempotency-Key', 'api-exp-paid').send({
    category_id: utilitiesCategoryId, description: 'Partially settled', amount_minor: 100000, incurred_on: today,
  });
  db.prepare(`INSERT INTO expense_payments (id, expense_id, amount_minor, method, business_date, created_by, created_at)
    VALUES ('api-seed-payment', ?, 25000, 'cash', ?, 'mgr-test-001', ?)`).run(paid.body.expense.id, today, `${today} 12:00:00`);
  const paidDetail = await request(app).get(`/api/expenses/${paid.body.expense.id}`).set(manager);
  assertEqualOrThrow(paidDetail.body.expense.paid_minor, 25000, 'the detail reports net paid from the ledger');
  assertEqualOrThrow(paidDetail.body.payments.length, 1, 'the detail returns the payment history');
  assertEqualOrThrow(paidDetail.body.expense.due_minor, 75000, 'the detail reports due against net paid');
  const paidVoid = await request(app).post(`/api/expenses/${paid.body.expense.id}/void`).set(manager).set('Idempotency-Key', 'api-void-paid').send({ reason: 'Try' });
  assertEqualOrThrow(paidVoid.status, 409, 'a paid expense cannot be voided');
  expectErrorCode(paidVoid.body, 'expense_has_payments', 'the paid guard names its code');
  const paidSummary = await request(app).get(`/api/expenses/summary?category_id=${utilitiesCategoryId}`).set(manager);
  const paidGroup = paidSummary.body.groups[0];
  assertEqualOrThrow(paidGroup.net_paid_minor, 25000, 'the summary reflects the recorded payment');
  assertEqualOrThrow(paidGroup.incurred_minor - paidGroup.net_paid_minor, paidGroup.due_minor, 'the summary reconciles incurred = paid + due');
  const paidReplace = await request(app).post(`/api/expenses/${paid.body.expense.id}/replace`).set(manager).set('Idempotency-Key', 'api-replace-paid').send({ ...replacePayload, category_id: utilitiesCategoryId });
  assertEqualOrThrow(paidReplace.status, 409, 'a paid expense cannot be replaced');

  // ── Live grants and revocation are evaluated per request ──
  const cashierId = 'expense-cashier-user';
  const deniedWrite = await request(app).post('/api/expenses').set(cashier).set('Idempotency-Key', 'api-cashier-1').send({
    category_id: utilitiesCategoryId, description: 'Cashier attempt', amount_minor: 1000, incurred_on: today,
  });
  assertEqualOrThrow(deniedWrite.status, 403, 'a cashier cannot write expenses before a grant');
  setOverride(db, cashierId, 'expenses.view', 'allow');
  assertEqualOrThrow((await request(app).get('/api/expenses').set(cashier)).status, 200, 'a granted view reaches the live read path');
  const viewOnlyWrite = await request(app).post('/api/expenses').set(cashier).set('Idempotency-Key', 'api-cashier-2').send({
    category_id: utilitiesCategoryId, description: 'View only', amount_minor: 1000, incurred_on: today,
  });
  assertEqualOrThrow(viewOnlyWrite.status, 403, 'view alone cannot write an expense');
  setOverride(db, cashierId, 'expenses.manage', 'allow');
  const grantedCreate = await request(app).post('/api/expenses').set(cashier).set('Idempotency-Key', 'api-cashier-3').send({
    category_id: utilitiesCategoryId, description: 'Granted cashier expense', amount_minor: 1000, incurred_on: today,
  });
  assertEqualOrThrow(grantedCreate.status, 201, 'a granted cashier can create an expense');
  assertEqualOrThrow(grantedCreate.body.expense.created_by, cashierId, 'the granted write attributes the cashier');
  setOverride(db, cashierId, 'expenses.view', 'deny');
  const deniedAfterRevoke = await request(app).post('/api/expenses').set(cashier).set('Idempotency-Key', 'api-cashier-4').send({
    category_id: utilitiesCategoryId, description: 'After revocation', amount_minor: 1000, incurred_on: today,
  });
  assertEqualOrThrow(deniedAfterRevoke.status, 403, 'revoking view also blocks the write path that needs it');
  db.prepare('DELETE FROM user_permission_overrides WHERE user_id = ?').run(cashierId);
  assertEqualOrThrow((await request(app).get('/api/expenses').set(cashier)).status, 403, 'clearing the grant restores the shipped default');
  assertOrThrow(
    !db.prepare('SELECT 1 FROM expenses WHERE description = ?').get('After revocation'),
    'a denied write leaves no expense row behind',
  );

  const results = getResults();
  console.log(`\nExpense API: ${results.passed}/${results.total} checks passed`);
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
  console.log(failures > 0 ? '❌ Expense API test finished with failures' : '✅ Expense API test passed');
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
