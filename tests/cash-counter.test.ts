const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cash-counter-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { utcTodayDate } = require('../main/db');

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

async function payFullBill(baseUrl: string, billId: number, method: string, amount: number, authHeader: Record<string, string>) {
  return api(baseUrl, `/api/bills/${billId}/payments`, { method: 'POST', body: { payments: [{ method, amount }] }, headers: authHeader });
}

async function main() {
  const db = initTestDb();
  const { authHeader: ownerAuth } = seedOwnerUser(db);
  const mgr = seedManagerUser(db);
  const cashier = seedUserWithRole(db, 'cashier');
  const server = seedUserWithRole(db, 'server');
  const chef = seedUserWithRole(db, 'chef');

  seedCategory(db, 'cc-cat', 'Cash Counter Menu');
  seedProduct(db, 'cc-cash-item', 'cc-cat', 'Cash Item', 100);
  seedProduct(db, 'cc-card-item', 'cc-cat', 'Card Item', 50);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { registerRoutes } = require('../main/routes/index');
  registerRoutes(app);
  const { baseUrl, server: httpServer } = await startServer(app);

  try {
    const today = utcTodayDate();

    // ── Seed one cash-paid bill and one card-paid bill ──────────────────────
    const cashOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 1, items: [{ product_id: 'cc-cash-item', quantity: 1 }] }, headers: ownerAuth });
    const cashBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: cashOrderRes.data.order.id }, headers: ownerAuth });
    const cashPayRes = await payFullBill(baseUrl, cashBillRes.data.bill.id, 'cash', cashBillRes.data.bill.total, ownerAuth);
    assertEqual(cashPayRes.status, 200, 'cash bill payment recorded');

    const cardOrderRes = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count: 1, items: [{ product_id: 'cc-card-item', quantity: 1 }] }, headers: ownerAuth });
    const cardBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: cardOrderRes.data.order.id }, headers: ownerAuth });
    const cardPayRes = await payFullBill(baseUrl, cardBillRes.data.bill.id, 'card', cardBillRes.data.bill.total, ownerAuth);
    assertEqual(cardPayRes.status, 200, 'card bill payment recorded');

    // ── Seed one cash expense payment (needs an expense category) ──────────
    const createCategory = await api(baseUrl, '/api/expenses/categories', { method: 'POST', body: { name: 'Kirana' }, headers: ownerAuth });
    const categoryId = createCategory.data.category.id;
    await api(baseUrl, '/api/expenses/entries', { method: 'POST', body: { category_id: categoryId, amount: 200 }, headers: ownerAuth });
    const cashExpensePay = await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: categoryId, amount: 30, method: 'cash' }, headers: ownerAuth });
    assertEqual(cashExpensePay.status, 201, 'cash expense payment recorded');
    await api(baseUrl, '/api/expenses/payments', { method: 'POST', body: { category_id: categoryId, amount: 15, method: 'card' }, headers: ownerAuth });

    // ── Daily view before any opening float / count ─────────────────────────
    const dailyBefore = await api(baseUrl, `/api/cash-counter/daily?date=${today}`, { headers: ownerAuth });
    assertEqual(dailyBefore.status, 200, 'daily cash counter loads');
    assertEqual(dailyBefore.data.opening_float, null, 'no opening float set yet');
    assertEqual(dailyBefore.data.cash_from_orders.total, cashBillRes.data.bill.total, 'cash-from-orders totals only the cash-paid bill');
    assert(!dailyBefore.data.cash_from_orders.payments.some((p: any) => p.bill_id === cardBillRes.data.bill.id), 'the card-paid bill is excluded from cash-from-orders');
    assertEqual(dailyBefore.data.cash_expenses.total, 30, 'cash-expenses totals only the cash-method expense payment (card payment excluded)');
    assertEqual(dailyBefore.data.expected_cash, Math.round((0 + cashBillRes.data.bill.total - 30) * 100) / 100, 'expected_cash = opening float (0) + cash from orders - cash expenses');
    assertEqual(dailyBefore.data.counts.length, 0, 'no counts logged yet');
    assertEqual(dailyBefore.data.latest_count, null, 'no latest count yet');
    assertEqual(dailyBefore.data.variance, null, 'no variance without a count');

    // ── Opening float ─────────────────────────────────────────────────────
    const setFloat = await api(baseUrl, '/api/cash-counter/opening-float', { method: 'POST', body: { date: today, amount: 20 }, headers: ownerAuth });
    assertEqual(setFloat.status, 201, 'owner sets the opening float');
    const duplicateFloat = await api(baseUrl, '/api/cash-counter/opening-float', { method: 'POST', body: { date: today, amount: 999 }, headers: mgr.authHeader });
    assertEqual(duplicateFloat.status, 409, 'a second opening float for the same date is rejected');
    const negativeFloat = await api(baseUrl, '/api/cash-counter/opening-float', { method: 'POST', body: { date: '2026-01-01', amount: -5 }, headers: ownerAuth });
    assertEqual(negativeFloat.status, 400, 'a negative opening float is rejected');

    const dailyAfterFloat = await api(baseUrl, `/api/cash-counter/daily?date=${today}`, { headers: ownerAuth });
    assertEqual(dailyAfterFloat.data.opening_float.amount, 20, 'opening float now reflected in the daily view');
    const expectedAfterFloat = Math.round((20 + cashBillRes.data.bill.total - 30) * 100) / 100;
    assertEqual(dailyAfterFloat.data.expected_cash, expectedAfterFloat, 'expected_cash includes the opening float');

    // ── Counts: append-only, latest wins for variance ───────────────────────
    const firstCount = await api(baseUrl, '/api/cash-counter/count', { method: 'POST', body: { date: today, counted_amount: expectedAfterFloat + 5 }, headers: cashier.authHeader });
    assertEqual(firstCount.status, 201, 'cashier can record a cash count');
    const secondCount = await api(baseUrl, '/api/cash-counter/count', { method: 'POST', body: { date: today, counted_amount: expectedAfterFloat - 2 }, headers: server.authHeader });
    assertEqual(secondCount.status, 201, 'server can record a second cash count the same day');

    const dailyAfterCounts = await api(baseUrl, `/api/cash-counter/daily?date=${today}`, { headers: ownerAuth });
    assertEqual(dailyAfterCounts.data.counts.length, 2, 'both counts are preserved (append-only)');
    assertEqual(dailyAfterCounts.data.latest_count.counted_amount, expectedAfterFloat - 2, 'latest_count is the most recently recorded count');
    assertEqual(dailyAfterCounts.data.variance, -2, 'variance compares the latest count to expected_cash, never mutating it');
    assertEqual(dailyAfterCounts.data.expected_cash, expectedAfterFloat, 'expected_cash is unchanged by recording counts');

    const negativeCount = await api(baseUrl, '/api/cash-counter/count', { method: 'POST', body: { date: today, counted_amount: -1 }, headers: ownerAuth });
    assertEqual(negativeCount.status, 400, 'a negative counted_amount is rejected');

    // ── Every role can log a float (distinct dates) and a count ─────────────
    const roles = [
      { label: 'owner', auth: ownerAuth, date: '2026-01-02' },
      { label: 'manager', auth: mgr.authHeader, date: '2026-01-03' },
      { label: 'cashier', auth: cashier.authHeader, date: '2026-01-04' },
      { label: 'server', auth: server.authHeader, date: '2026-01-05' },
      { label: 'chef', auth: chef.authHeader, date: '2026-01-06' },
    ];
    for (const role of roles) {
      const floatRes = await api(baseUrl, '/api/cash-counter/opening-float', { method: 'POST', body: { date: role.date, amount: 10 }, headers: role.auth });
      assertEqual(floatRes.status, 201, `${role.label} can set an opening float`);
      const countRes = await api(baseUrl, '/api/cash-counter/count', { method: 'POST', body: { date: role.date, counted_amount: 10 }, headers: role.auth });
      assertEqual(countRes.status, 201, `${role.label} can record a cash count`);
    }

    // ── No mutation routes exist for either resource ────────────────────────
    const floatDeleteStatus = await rawStatus(baseUrl, '/api/cash-counter/opening-float', 'DELETE', ownerAuth);
    assertEqual(floatDeleteStatus, 404, 'no DELETE route exists for opening floats');
    const floatPutStatus = await rawStatus(baseUrl, '/api/cash-counter/opening-float', 'PUT', ownerAuth);
    assertEqual(floatPutStatus, 404, 'no PUT route exists for opening floats');
    const countDeleteStatus = await rawStatus(baseUrl, '/api/cash-counter/count', 'DELETE', ownerAuth);
    assertEqual(countDeleteStatus, 404, 'no DELETE route exists for cash counts');
    const countPutStatus = await rawStatus(baseUrl, '/api/cash-counter/count', 'PUT', ownerAuth);
    assertEqual(countPutStatus, 404, 'no PUT route exists for cash counts');

    // ── Validation ───────────────────────────────────────────────────────
    const futureDate = new Date(new Date(`${today}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const futureFloat = await api(baseUrl, '/api/cash-counter/opening-float', { method: 'POST', body: { date: futureDate, amount: 5 }, headers: ownerAuth });
    assertEqual(futureFloat.status, 400, 'a postdated opening float is rejected');
    const malformedMonth = await api(baseUrl, '/api/cash-counter/monthly?month=2026-13', { headers: ownerAuth });
    assertEqual(malformedMonth.status, 400, 'an invalid month is rejected');

    // ── Monthly view ─────────────────────────────────────────────────────
    const thisMonth = today.slice(0, 7);
    const monthly = await api(baseUrl, `/api/cash-counter/monthly?month=${thisMonth}`, { headers: ownerAuth });
    assertEqual(monthly.status, 200, 'monthly cash counter report loads');
    const todayRow = monthly.data.days.find((d: any) => d.date === today);
    assertEqual(todayRow.opening_float, 20, 'monthly per-day row matches the daily opening float');
    assertEqual(todayRow.cash_from_orders, cashBillRes.data.bill.total, 'monthly per-day row matches the daily cash-from-orders total');
    assertEqual(todayRow.cash_expenses, 30, 'monthly per-day row matches the daily cash-expenses total');
    assertEqual(todayRow.expected_cash, expectedAfterFloat, 'monthly per-day expected_cash matches the daily figure');
    assertEqual(todayRow.variance, -2, 'monthly per-day variance matches the daily figure');

    const inactiveDay = monthly.data.days.find((d: any) => d.date === `${thisMonth}-01` && d.date !== today);
    if (inactiveDay) {
      assertEqual(inactiveDay.opening_float, 0, 'a day with no activity is zero-filled for opening_float');
      assertEqual(inactiveDay.cash_from_orders, 0, 'a day with no activity is zero-filled for cash_from_orders');
      assertEqual(inactiveDay.cash_expenses, 0, 'a day with no activity is zero-filled for cash_expenses');
      assertEqual(inactiveDay.expected_cash, 0, 'a day with no activity has zero expected_cash');
      assertEqual(inactiveDay.latest_count, null, 'a day with no count logged has a null latest_count');
      assertEqual(inactiveDay.variance, null, 'a day with no count logged has a null variance');
    }

    const daysSum = monthly.data.days.reduce((acc: any, d: any) => ({
      cash_from_orders: Math.round((acc.cash_from_orders + d.cash_from_orders) * 100) / 100,
      cash_expenses: Math.round((acc.cash_expenses + d.cash_expenses) * 100) / 100,
    }), { cash_from_orders: 0, cash_expenses: 0 });
    assertEqual(monthly.data.totals.total_cash_from_orders, daysSum.cash_from_orders, 'month totals.total_cash_from_orders equals the sum of daily rows');
    assertEqual(monthly.data.totals.total_cash_expenses, daysSum.cash_expenses, 'month totals.total_cash_expenses equals the sum of daily rows');
    assertEqual(monthly.data.totals.net, Math.round((daysSum.cash_from_orders - daysSum.cash_expenses) * 100) / 100, 'month totals.net = total cash from orders - total cash expenses');
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    closeDatabase();
  }

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  if (results.failed) process.exit(1);
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
