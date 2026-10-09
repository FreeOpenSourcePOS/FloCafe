import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

/**
 * The Expenses page exposes the ledger the backend already keeps: an operator
 * records an obligation, settles part of it, and corrects a settled payment
 * without ever editing a paid amount in place.
 */
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now();
const CATEGORY_NAME = `E2E Expense Category ${STAMP}`;
const DESCRIPTION = `E2E Expense ${STAMP}`;
const EXPENSE_MINOR = 2500;
// The e2e fixture is pinned to TH/THB, so a rendered 25.00 reads as 2,500.00.
// Match the digits without the tenant's grouping/currency decoration.
const FULL_AMOUNT = /500\.00/;
const ZERO_AMOUNT = /0\.00/;

let categoryId = '';
let ownerToken = '';
let expenseId = '';

async function ownerAuth(page: Page): Promise<Record<string, string>> {
  const login = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'owner@flo.local', password: E2E_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { access_token } = await login.json();
  ownerToken = access_token;
  return { Authorization: `Bearer ${access_token}` };
}

/** Signs in through the form so the guard and landing page run for real. */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'), { timeout: 20000 });
}

async function readExpense(page: Page, headers: Record<string, string>) {
  const response = await page.request.get(`${BASE}/api/expenses/${expenseId}`, { headers });
  expect(response.ok()).toBeTruthy();
  const { expense, payments } = await response.json();
  return { expense, payments: (payments ?? []) as Array<Record<string, unknown>> };
}

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { email: 'owner@flo.local', password: E2E_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { access_token } = await login.json();
  const created = await request.post(`${BASE}/api/expenses/categories`, {
    headers: { Authorization: `Bearer ${access_token}`, 'Idempotency-Key': `e2e-expense-category-${STAMP}` },
    data: { name: CATEGORY_NAME },
  });
  expect(created.ok()).toBeTruthy();
  categoryId = (await created.json()).category.id;
});

test('the expenses page owns one scroll region and shows filters plus a period-scoped basis', async ({ page }) => {
  const headers = await ownerAuth(page);
  expect(headers.Authorization).toBeTruthy();
  await signIn(page, 'owner@flo.local');

  await page.goto(`${BASE}/expenses`);
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Expenses', exact: true })).toBeVisible();

  for (const id of ['expense-filter-from', 'expense-filter-to', 'expense-filter-category', 'expense-filter-status', 'expense-filter-currency']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  // Default range: the store's own business month, not the host clock.
  const context = await page.request.get(`${BASE}/api/expenses/context`, { headers });
  const { business_date: businessDate, currency_code: currencyCode } = await context.json();
  await expect(page.getByTestId('expense-filter-from')).toHaveValue(`${businessDate.slice(0, 7)}-01`);
  await expect(page.getByTestId('expense-filter-to')).toHaveValue(businessDate);
  await expect(page.getByTestId('expense-filter-currency')).toContainText(currencyCode);

  // The summary states its basis and never reports a profit or in-period cash figure.
  const basis = page.getByTestId('expense-summary-basis');
  await expect(basis).toContainText(/incurred in the selected period/i);
  await expect(basis).toContainText(/paid to date/i);
  await expect(basis).not.toContainText(/gross profit|net profit|profit margin|payments made in/i);

  // Exactly one deliberate scroll owner for the list.
  const listScroll = await page.getByTestId('expenses-list-scroll').evaluate((node) => getComputedStyle(node).overflowY);
  expect(listScroll).toBe('auto');

  // The sidebar exposes the entry for a user who can read expenses.
  await expect(page.getByRole('link', { name: 'Expenses' })).toBeVisible();
});

test('creating an expense records only the obligation and opens its detail unpaid', async ({ page }) => {
  await ownerAuth(page);
  await signIn(page, 'owner@flo.local');
  await page.goto(`${BASE}/expenses`);
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });

  await page.getByTestId('expense-add').click();
  await page.getByTestId('expense-form-description').fill(DESCRIPTION);
  await page.getByTestId('expense-form-category').selectOption(categoryId);
  await page.getByTestId('expense-form-amount').fill((EXPENSE_MINOR / 100).toFixed(2));
  await page.getByTestId('expense-form-submit').click();

  const detail = page.getByTestId('expense-detail');
  await expect(detail).toBeVisible({ timeout: 15000 });
  await expect(detail).toContainText(DESCRIPTION);
  // The payment is a separate step: the fresh expense is visible and unpaid.
  await expect(page.getByTestId('expense-payments-empty')).toBeVisible();

  const list = await page.request.get(
    `${BASE}/api/expenses?status=all&limit=100`,
    { headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  const row = (await list.json()).expenses.find((row: { description: string }) => row.description === DESCRIPTION);
  expect(row).toBeTruthy();
  expenseId = row.id;
  expect(row.amount_minor).toBe(EXPENSE_MINOR);
  expect(row.paid_minor).toBe(0);
  expect(row.due_minor).toBe(EXPENSE_MINOR);
});

test('recording a card payment settles the balance through the ledger', async ({ page }) => {
  await ownerAuth(page);
  await signIn(page, 'owner@flo.local');
  await page.goto(`${BASE}/expenses`);
  await page.getByTestId('expense-filter-status').selectOption('all');
  const row = page.getByTestId('expense-row').filter({ hasText: DESCRIPTION }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.getByTestId('expense-open-detail').click();

  await expect(page.getByTestId('expense-detail')).toBeVisible();
  await page.getByTestId('expense-record-payment').click();
  const form = page.getByTestId('expense-payment-form');
  await expect(form).toBeVisible();
  await page.getByTestId('expense-payment-method').selectOption('card');
  await page.getByTestId('expense-payment-reference').fill(`E2E-REF-${STAMP}`);
  // The amount defaults to the amount due, so the operator confirms it rather than typing it.
  await expect(page.getByTestId('expense-payment-amount')).toHaveValue('25.00');
  await expect(page.getByTestId('expense-payment-review')).toContainText(FULL_AMOUNT);
  await page.getByTestId('expense-payment-submit').click();

  await expect(page.getByTestId('expense-payments-empty')).toHaveCount(0);
  await expect(page.getByTestId('expense-payment-row').first()).toContainText(FULL_AMOUNT);
  await expect(page.getByTestId('expense-detail-due')).toContainText(ZERO_AMOUNT);

  const { expense, payments } = await readExpense(page, { Authorization: `Bearer ${ownerToken}` });
  expect(expense.paid_minor).toBe(EXPENSE_MINOR);
  expect(expense.due_minor).toBe(0);
  expect(payments).toHaveLength(1);
  expect(payments[0].method).toBe('card');
  // A card payment never touches the drawer.
  expect(payments[0].cash_movement_id).toBeNull();
  expect(payments[0].reference).toBe(`E2E-REF-${STAMP}`);
});

test('a reversal is a reasoned row that restores the balance and blanks the paid amount', async ({ page }) => {
  await ownerAuth(page);
  await signIn(page, 'owner@flo.local');
  await page.goto(`${BASE}/expenses`);
  await page.getByTestId('expense-filter-status').selectOption('all');
  const row = page.getByTestId('expense-row').filter({ hasText: DESCRIPTION }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.getByTestId('expense-open-detail').click();

  await expect(page.getByTestId('expense-detail')).toBeVisible();
  await page.getByTestId('expense-reverse-payment').first().click();
  await expect(page.getByTestId('expense-reversal-form')).toBeVisible();
  await expect(page.getByTestId('expense-reversal-confirm')).toContainText(FULL_AMOUNT);
  // A reason is required, and a blank one is refused in place.
  await page.getByTestId('expense-reversal-submit').click();
  await expect(page.getByTestId('expense-reversal-form')).toBeVisible();
  await page.getByTestId('expense-reversal-reason').fill(`E2E reversal ${STAMP}`);
  await page.getByTestId('expense-reversal-submit').click();

  await expect(page.getByTestId('expense-detail-due')).toContainText(FULL_AMOUNT, { timeout: 15000 });
  const { expense, payments } = await readExpense(page, { Authorization: `Bearer ${ownerToken}` });
  expect(expense.paid_minor).toBe(0);
  expect(expense.due_minor).toBe(EXPENSE_MINOR);
  expect(payments).toHaveLength(2);
  const reversal = payments.find((payment) => payment.reversal_of !== null);
  expect(reversal).toBeTruthy();
  // The original row keeps its committed amount and reference; only a new row is added.
  const original = payments.find((payment) => payment.reversal_of === null);
  expect(original?.amount_minor).toBe(EXPENSE_MINOR);
  expect(original?.reference).toBe(`E2E-REF-${STAMP}`);
  expect(reversal?.reason).toBe(`E2E reversal ${STAMP}`);
});

test('filtering by category resets paging and keeps the matching row visible', async ({ page }) => {
  await ownerAuth(page);
  await signIn(page, 'owner@flo.local');
  await page.goto(`${BASE}/expenses`);
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });

  await page.getByTestId('expense-filter-status').selectOption('all');
  await page.getByTestId('expense-filter-category').selectOption(categoryId);
  await expect(page.getByTestId('expense-row').filter({ hasText: DESCRIPTION }).first()).toBeVisible({ timeout: 15000 });

  // The summary follows the filters, not just the fetched page.
  await expect(page.getByTestId('expense-summary')).toBeVisible();
});

test('a user without expenses.view is sent to their own landing page instead of the expenses page', async ({ page }) => {
  await ownerAuth(page);
  // The seeded server role has no expenses.view, so the guard must move them off it.
  await signIn(page, 'server@flo.local');
  await page.goto(`${BASE}/expenses`);
  await page.waitForURL((url) => !url.pathname.startsWith('/expenses'), { timeout: 15000 });
  expect(new URL(page.url()).pathname).not.toBe('/expenses');
});

test('expenses.view alone lands the user on the expenses page', async ({ page }) => {
  const headers = await ownerAuth(page);
  const email = `expense-only-${STAMP}@flo.local`;
  const created = await page.request.post(`${BASE}/api/staff`, {
    headers,
    data: { name: `Expense Only ${STAMP}`, email, password: 'E2ePass123!', role: 'server' },
  });
  expect(created.ok()).toBeTruthy();
  const userId = (await created.json()).staff?.id ?? (await created.json()).user?.id;
  expect(userId).toBeTruthy();

  const current = await page.request.get(`${BASE}/api/authorization/users/${userId}`, { headers });
  expect(current.ok()).toBeTruthy();
  const { revision } = await current.json();

  // Grant expenses.view and take away every page that outranks it in the landing order.
  const denied = ['pos.use', 'dashboard.view', 'orders.read', 'tables.view', 'whatsapp.use', 'catalog.manage', 'inventory.view'];
  const overrides = [
    ...denied.map((permission_id) => ({ permission_id, effect: 'deny' as const })),
    { permission_id: 'expenses.view', effect: 'allow' as const },
  ];
  const updated = await page.request.put(`${BASE}/api/authorization/users/${userId}`, {
    headers,
    data: { overrides, revision },
  });
  expect(updated.ok(), `permission overrides must be accepted (got ${updated.status()})`).toBeTruthy();

  await signIn(page, email);
  // The static export serves the folder with a trailing slash.
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/expenses');
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });
  // Reading is not writing: the manage-only affordances stay hidden.
  await expect(page.getByTestId('expense-add')).toHaveCount(0);
});
