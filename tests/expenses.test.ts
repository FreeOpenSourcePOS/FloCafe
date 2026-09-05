const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-expenses-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser,
  api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { expenseRoutes } = require('../main/routes/expenses');
const { utcTodayDate } = require('../main/db');

// Express's default handler for an unmatched route returns an HTML body, not
// JSON — the api() helper's automatic response.json() would throw on that, so
// route-non-existence checks use a raw fetch and only look at the status.
async function rawStatus(baseUrl: string, urlPath: string, method: string, headers: Record<string, string>): Promise<number> {
  const response = await (globalThis as any).fetch(baseUrl + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
  return response.status;
}

function seedUserWithRole(db: any, role: string): { userId: string; authHeader: Record<string, string> } {
  const { getJWTSecret } = require('../main/routes/auth');
  const userId = `${role}-test-001`;
  const passwordHash = bcrypt.hashSync('testpass123', 10);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, `Test ${role}`, `${role}@test.local`, passwordHash, role, 1, now(), now());
  const token = jwt.sign({ userId, email: `${role}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' });
  return { userId, authHeader: { Authorization: `Bearer ${token}` } };
}

async function main() {
  const db = initTestDb();
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const mgr = seedManagerUser(db);
  const cashier = seedUserWithRole(db, 'cashier');
  const server = seedUserWithRole(db, 'server');
  const chef = seedUserWithRole(db, 'chef');

  const app = createApp({ '/api/expenses': expenseRoutes });
  const { baseUrl, server: httpServer } = await startServer(app);

  try {
    // ── Category CRUD ──────────────────────────────────────────────────────
    const emptyList = await api(baseUrl, '/api/expenses/categories', { headers: ownerAuth });
    assertEqual(emptyList.status, 200, 'fresh install lists expense categories');
    assertEqual(emptyList.data.categories.length, 0, 'fresh install has no expense categories');

    const cashierCreateAttempt = await api(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: 'Chicken' }, headers: cashier.authHeader });
    assertEqual(cashierCreateAttempt.status, 403, 'cashier cannot create an expense category');

    const createChicken = await api(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: 'Chicken' }, headers: ownerAuth });
    assertEqual(createChicken.status, 201, 'owner creates an expense category');
    const chickenId = createChicken.data.category.id;

    const managerCreateVeg = await api(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: 'Vegetables' }, headers: mgr.authHeader });
    assertEqual(managerCreateVeg.status, 201, 'manager creates an expense category');
    const vegId = managerCreateVeg.data.category.id;

    const duplicate = await api(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: 'chicken' }, headers: ownerAuth });
    assertEqual(duplicate.status, 409, 'duplicate category name (case-insensitive) is rejected');

    const emptyName = await api(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: '  ' }, headers: ownerAuth });
    assertEqual(emptyName.status, 400, 'blank category name is rejected');

    // ── Entries: every role can record an expense ──────────────────────────
    const roles = [
      { label: 'owner', auth: ownerAuth },
      { label: 'manager', auth: mgr.authHeader },
      { label: 'cashier', auth: cashier.authHeader },
      { label: 'server', auth: server.authHeader },
      { label: 'chef', auth: chef.authHeader },
    ];
    for (const role of roles) {
      const res = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: chickenId, amount: 100, note: `${role.label} bought chicken` }, headers: role.auth });
      assertEqual(res.status, 201, `${role.label} can record an expense entry`);
    }

    const badCategoryEntry = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: 'does-not-exist', amount: 10 }, headers: ownerAuth });
    assertEqual(badCategoryEntry.status, 404, 'entry against an unknown category is rejected');

    const zeroAmountEntry = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: chickenId, amount: 0 }, headers: ownerAuth });
    assertEqual(zeroAmountEntry.status, 400, 'zero-amount entry is rejected');

    const negativeAmountEntry = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: chickenId, amount: -5 }, headers: ownerAuth });
    assertEqual(negativeAmountEntry.status, 400, 'negative-amount entry is rejected');

    // No mutate/delete route exists for entries — Express returns its own
    // "not found" 404 (no matching route), proving the endpoint is absent
    // rather than merely role-blocked.
    const entriesDeleteStatus = await rawStatus(baseUrl, '/api/expenses/entries/1', 'DELETE', ownerAuth);
    assertEqual(entriesDeleteStatus, 404, 'no DELETE route exists for expense entries');
    const entriesPutStatus = await rawStatus(baseUrl, '/api/expenses/entries/1', 'PUT', ownerAuth);
    assertEqual(entriesPutStatus, 404, 'no PUT route exists for expense entries');

    // ── Entry date: defaults to today, may be backdated, never postdated ───
    // Uses its own category so these entries don't perturb chickenId's due
    // arithmetic asserted later.
    const createEgg = await api(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: 'Egg' }, headers: ownerAuth });
    const eggId = createEgg.data.category.id;

    const today = utcTodayDate();
    const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const tomorrow = new Date(new Date(`${today}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const defaultDateEntry = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: eggId, amount: 5 }, headers: ownerAuth });
    assertEqual(defaultDateEntry.data.entry.date, today, 'an entry with no date defaults to today (UTC)');

    const backdatedEntry = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: eggId, amount: 5, date: yesterday }, headers: ownerAuth });
    assertEqual(backdatedEntry.status, 201, 'a backdated entry is accepted');
    assertEqual(backdatedEntry.data.entry.date, yesterday, 'a backdated entry keeps the caller-supplied date');

    const postdatedEntry = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: eggId, amount: 5, date: tomorrow }, headers: ownerAuth });
    assertEqual(postdatedEntry.status, 400, 'a postdated (future) entry is rejected');

    const malformedDateEntry = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: eggId, amount: 5, date: '04-09-2026' }, headers: ownerAuth });
    assertEqual(malformedDateEntry.status, 400, 'a non-ISO date format is rejected');

    const yesterdayFiltered = await api(baseUrl, `/api/expenses/entries?category_id=${eggId}&date=${yesterday}`, { headers: ownerAuth });
    assertEqual(yesterdayFiltered.data.entries.length, 1, 'filtering entries by date returns only that day\'s rows');
    assertEqual(yesterdayFiltered.data.entries[0].date, yesterday, 'the date-filtered entry carries the filtered date');

    // ── Payments: every role can record a due payment ──────────────────────
    for (const role of roles) {
      const res = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: chickenId, amount: 50, note: `${role.label} paid vendor`, method: 'cash' }, headers: role.auth });
      assertEqual(res.status, 201, `${role.label} can record a due payment`);
    }

    // ── Payment method: required, must be cash/card/upi ─────────────────────
    const missingMethod = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: chickenId, amount: 10 }, headers: ownerAuth });
    assertEqual(missingMethod.status, 400, 'a payment with no method is rejected');
    const invalidMethod = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: chickenId, amount: 10, method: 'bitcoin' }, headers: ownerAuth });
    assertEqual(invalidMethod.status, 400, 'a payment with an unrecognized method is rejected');

    // ── Monthly report: uses its own category so month totals aren't ───────
    // perturbed by chicken/veg/egg activity created earlier in this run.
    const createCurd = await api(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: 'Curd' }, headers: ownerAuth });
    const curdId = createCurd.data.category.id;
    const thisMonth = utcTodayDate().slice(0, 7);

    const curdExpense = await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: curdId, amount: 300 }, headers: ownerAuth });
    assertEqual(curdExpense.status, 201, 'curd expense recorded for the monthly report');

    const curdCash = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: curdId, amount: 100, method: 'cash' }, headers: ownerAuth });
    assertEqual(curdCash.data.payment.method, 'cash', 'a cash payment echoes back its method');
    const curdCard = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: curdId, amount: 50, method: 'card' }, headers: ownerAuth });
    assertEqual(curdCard.data.payment.method, 'card', 'a card payment echoes back its method');
    const curdUpi = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: curdId, amount: 25, method: 'upi' }, headers: ownerAuth });
    assertEqual(curdUpi.data.payment.method, 'upi', 'a upi payment echoes back its method');

    const noMonthSummary = await api(baseUrl, '/api/expenses/summary', { headers: ownerAuth });
    assertEqual(noMonthSummary.status, 200, 'summary with no month param defaults to the current month');
    assertEqual(noMonthSummary.data.month, thisMonth, 'the default summary month is the current UTC month');

    const summary = await api(baseUrl, `/api/expenses/summary?month=${thisMonth}`, { headers: ownerAuth });
    assertEqual(summary.status, 200, 'monthly summary is fetched');
    const curdSummary = summary.data.categories.find((c: any) => c.category_id === curdId);
    assertEqual(curdSummary.total_expenses, 300, 'monthly summary totals this month\'s expenses for the category');
    assertEqual(curdSummary.total_payments, 175, 'monthly summary totals this month\'s payments for the category');
    assertEqual(curdSummary.payments_by_method.cash, 100, 'monthly summary breaks down cash payments');
    assertEqual(curdSummary.payments_by_method.card, 50, 'monthly summary breaks down card payments');
    assertEqual(curdSummary.payments_by_method.upi, 25, 'monthly summary breaks down upi payments');
    assertEqual(curdSummary.due, 125, 'monthly summary also reports the category\'s lifetime due for reference');

    const recomputedOverall = summary.data.categories.reduce((acc: any, c: any) => ({
      total_expenses: Number((acc.total_expenses + c.total_expenses).toFixed(2)),
      total_payments: Number((acc.total_payments + c.total_payments).toFixed(2)),
    }), { total_expenses: 0, total_payments: 0 });
    assertEqual(summary.data.overall.total_expenses, recomputedOverall.total_expenses, 'overall total_expenses is the sum across every category');
    assertEqual(summary.data.overall.total_payments, recomputedOverall.total_payments, 'overall total_payments is the sum across every category');

    const badMonth = await api(baseUrl, '/api/expenses/summary?month=2026-13', { headers: ownerAuth });
    assertEqual(badMonth.status, 400, 'an invalid month is rejected');

    const paymentsDeleteStatus = await rawStatus(baseUrl, '/api/expenses/payments/1', 'DELETE', ownerAuth);
    assertEqual(paymentsDeleteStatus, 404, 'no DELETE route exists for due payments');
    const paymentsPutStatus = await rawStatus(baseUrl, '/api/expenses/payments/1', 'PUT', ownerAuth);
    assertEqual(paymentsPutStatus, 404, 'no PUT route exists for due payments');

    // ── Due computation ──────────────────────────────────────────────────
    // Chicken: 5 entries of 100 = 500, 5 payments of 50 = 250 -> due 250
    const afterChicken = await api(baseUrl, '/api/expenses/categories', { headers: ownerAuth });
    const chickenRow = afterChicken.data.categories.find((c: any) => c.id === chickenId);
    assertEqual(chickenRow.total_expenses, 500, 'chicken category totals every recorded expense');
    assertEqual(chickenRow.total_payments, 250, 'chicken category totals every recorded payment');
    assertEqual(chickenRow.due, 250, 'chicken due = total expenses - total payments');

    // Vegetables: untouched category has zero due and does not leak Chicken's ledger.
    const vegRow = afterChicken.data.categories.find((c: any) => c.id === vegId);
    assertEqual(vegRow.due, 0, 'an untouched category has zero due');
    assertEqual(vegRow.total_expenses, 0, 'categories do not leak each other\'s ledger totals');

    // A payment larger than the outstanding due is allowed and can go negative.
    const overpay = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: vegId, amount: 1000, method: 'card' }, headers: ownerAuth });
    assertEqual(overpay.status, 201, 'a payment exceeding the current due is accepted, not rejected');
    const afterOverpay = await api(baseUrl, '/api/expenses/categories', { headers: ownerAuth });
    assertEqual(afterOverpay.data.categories.find((c: any) => c.id === vegId).due, -1000, 'due can legitimately go negative after an overpayment');

    // ── Category deletion rule ─────────────────────────────────────────────
    const deleteWithDue = await api(baseUrl, `/api/expenses/categories/${chickenId}`, { method: 'DELETE', headers: ownerAuth });
    assertEqual(deleteWithDue.status, 400, 'a category with a nonzero due cannot be deleted');

    const cashierDeleteAttempt = await api(baseUrl, `/api/expenses/categories/${vegId}`, { method: 'DELETE', headers: cashier.authHeader });
    assertEqual(cashierDeleteAttempt.status, 403, 'cashier cannot delete an expense category');

    // Settle chicken's due to zero, then deletion should succeed.
    const settle = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: chickenId, amount: 250, method: 'upi' }, headers: ownerAuth });
    assertEqual(settle.status, 201, 'settling payment recorded');
    const deleteSettled = await api(baseUrl, `/api/expenses/categories/${chickenId}`, { method: 'DELETE', headers: ownerAuth });
    assertEqual(deleteSettled.status, 200, 'a fully-settled category can be deleted');

    const listAfterDelete = await api(baseUrl, '/api/expenses/categories', { headers: ownerAuth });
    assert(!listAfterDelete.data.categories.some((c: any) => c.id === chickenId), 'deleted category no longer appears in the default list');

    // Historical entries/payments against the deleted category are preserved.
    const historicalEntries = await api(baseUrl, `/api/expenses/entries?category_id=${chickenId}`, { headers: ownerAuth });
    assertEqual(historicalEntries.data.entries.length, 5, 'deleting a category preserves its historical expense entries');

    const inactiveListForOwner = await api(baseUrl, '/api/expenses/categories?include_inactive=true', { headers: ownerAuth });
    assert(inactiveListForOwner.data.categories.some((c: any) => c.id === chickenId), 'owner can still see the soft-deleted category with include_inactive');
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    closeDatabase();
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (results.failed) process.exit(1);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
