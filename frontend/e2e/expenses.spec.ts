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
// The e2e fixture is pinned to TH/THB, so 2,500 minor units render as 25.00.
const FULL_AMOUNT = /(^|\D)25\.00(\D|$)/;
const ZERO_AMOUNT = /(^|\D)0\.00(\D|$)/;

let categoryId = '';
let ownerToken = '';
let ownerUserId = '';
let ownerTenantId = 1;
let expenseId = '';

const scopedAttemptKey = () => `flo.expenses.attempt.v1:${ownerTenantId}:${ownerUserId}`;

async function ownerAuth(page: Page): Promise<Record<string, string>> {
  const login = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'owner@flo.local', password: E2E_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { access_token, user, tenants } = await login.json();
  ownerToken = access_token;
  expect(typeof user?.id).toBe('string');
  expect(user.id.length).toBeGreaterThan(0);
  ownerUserId = user.id;
  ownerTenantId = Number(tenants?.[0]?.id ?? 1);
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
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Idempotency-Key': `e2e-expense-category-${STAMP}`,
    },
    data: { name: CATEGORY_NAME },
  });
  expect(created.ok()).toBeTruthy();
  categoryId = (await created.json()).category.id;
});

test('the expenses page owns one scroll region and shows filters plus a period-scoped basis', async ({
  page,
}) => {
  const headers = await ownerAuth(page);
  expect(headers.Authorization).toBeTruthy();
  await signIn(page, 'owner@flo.local');

  await page.goto(`${BASE}/expenses`);
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Expenses', exact: true })).toBeVisible();

  for (const id of [
    'expense-filter-from',
    'expense-filter-to',
    'expense-filter-category',
    'expense-filter-status',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId('expense-filter-currency')).toHaveCount(0);

  // Default range: the store's own business month, not the host clock.
  const context = await page.request.get(`${BASE}/api/expenses/context`, { headers });
  const { business_date: businessDate } = await context.json();
  await expect(page.getByTestId('expense-filter-from')).toHaveValue(
    `${businessDate.slice(0, 7)}-01`,
  );
  await expect(page.getByTestId('expense-filter-to')).toHaveValue(businessDate);

  // The summary states its basis and never reports a profit or in-period cash figure.
  const basis = page.getByTestId('expense-summary-basis');
  await expect(basis).toContainText(/incurred in the selected period/i);
  await expect(basis).toContainText(/paid to date/i);
  await expect(basis).not.toContainText(/gross profit|net profit|profit margin|payments made in/i);

  // Exactly one deliberate scroll owner for the list.
  const listScroll = await page
    .getByTestId('expenses-list-scroll')
    .evaluate((node) => getComputedStyle(node).overflowY);
  expect(listScroll).toBe('auto');

  // The sidebar exposes the entry for a user who can read expenses.
  await expect(page.getByRole('link', { name: 'Expenses' })).toBeVisible();
});

test('creating an expense records only the obligation and opens its detail unpaid', async ({
  page,
}) => {
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
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), scopedAttemptKey()),
  ).toBeNull();

  const list = await page.request.get(`${BASE}/api/expenses?status=all&limit=100`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const row = (await list.json()).expenses.find(
    (row: { description: string }) => row.description === DESCRIPTION,
  );
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
  await expect(row.getByTestId('expense-row-replace')).toBeVisible();
  await row.getByTestId('expense-row-pay').click();

  const form = page.getByTestId('expense-payment-form');
  await expect(form).toBeVisible();
  await page.getByTestId('expense-workflow-back').click();
  await expect(page.getByTestId('expense-detail')).toBeVisible();
  await page.getByTestId('expense-record-payment').click();
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
  await expect(page.getByTestId('expense-blocked-by-payments')).toBeVisible();
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), scopedAttemptKey()),
  ).toBeNull();

  const { expense, payments } = await readExpense(page, { Authorization: `Bearer ${ownerToken}` });
  expect(expense.paid_minor).toBe(EXPENSE_MINOR);
  expect(expense.due_minor).toBe(0);
  expect(payments).toHaveLength(1);
  expect(payments[0].method).toBe('card');
  // A card payment never touches the drawer.
  expect(payments[0].cash_movement_id).toBeNull();
  expect(payments[0].reference).toBe(`E2E-REF-${STAMP}`);
});

test('a reversal is a reasoned row that restores the balance and blanks the paid amount', async ({
  page,
}) => {
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

  await expect(page.getByTestId('expense-detail-due')).toContainText(FULL_AMOUNT, {
    timeout: 15000,
  });
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
  await expect(
    page.getByTestId('expense-row').filter({ hasText: DESCRIPTION }).first(),
  ).toBeVisible({ timeout: 15000 });

  // The summary follows the filters, not just the fetched page.
  await expect(page.getByTestId('expense-summary')).toBeVisible();
});

test('a user without expenses.view is sent to their own landing page instead of the expenses page', async ({
  page,
}) => {
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
  const denied = [
    'pos.use',
    'dashboard.view',
    'orders.read',
    'tables.view',
    'whatsapp.use',
    'catalog.manage',
    'inventory.view',
  ];
  const overrides = [
    ...denied.map((permission_id) => ({ permission_id, effect: 'deny' as const })),
    { permission_id: 'expenses.view', effect: 'allow' as const },
  ];
  const updated = await page.request.put(`${BASE}/api/authorization/users/${userId}`, {
    headers,
    data: { overrides, revision },
  });
  expect(
    updated.ok(),
    `permission overrides must be accepted (got ${updated.status()})`,
  ).toBeTruthy();

  await signIn(page, email);
  // The static export serves the folder with a trailing slash.
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/expenses');
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });
  // Reading is not writing: the manage-only affordances stay hidden.
  await expect(page.getByTestId('expense-add')).toHaveCount(0);
});

test('string-actor attempt clears on 4xx and create/pay, locks on 5xx, and replays exact key after dropped response', async ({
  page,
}) => {
  const headers = await ownerAuth(page);
  await signIn(page, 'owner@flo.local');
  await page.goto(`${BASE}/expenses`);
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });

  const key = scopedAttemptKey();
  const contextRes = await page.request.get(`${BASE}/api/expenses/context`, { headers });
  expect(contextRes.ok()).toBeTruthy();
  const { business_date: businessDate } = await contextRes.json();

  // 1. Definitive 4xx rejection removes the scoped attempt so reload + create/pay succeed.
  let rejectOnce = true;
  await page.route(`${BASE}/api/expenses`, async (route) => {
    if (route.request().method() === 'POST' && rejectOnce) {
      rejectOnce = false;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid expense payload' }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByTestId('expense-add').click();
  await page.getByTestId('expense-form-description').fill(`E2E 4xx Rejected ${STAMP}`);
  await page.getByTestId('expense-form-category').selectOption(categoryId);
  await page.getByTestId('expense-form-amount').fill('12.00');
  await page.getByTestId('expense-form-submit').click();

  await expect(page.getByTestId('expense-attempt-banner')).toContainText('Invalid expense payload');
  expect(await page.evaluate((k) => window.localStorage.getItem(k), key)).toBeNull();
  await page.unroute(`${BASE}/api/expenses`);

  // Reload and create + pay a fresh expense to verify no stale record blocks the workflow.
  await page.reload();
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });
  const followUpDescription = `E2E FollowUp Expense ${STAMP}`;
  await page.getByTestId('expense-add').click();
  await expect(page.getByTestId('expense-attempt-banner')).toHaveCount(0);
  await page.getByTestId('expense-form-description').fill(followUpDescription);
  await page.getByTestId('expense-form-category').selectOption(categoryId);
  await page.getByTestId('expense-form-amount').fill('15.00');
  await page.getByTestId('expense-form-submit').click();

  await expect(page.getByTestId('expense-detail')).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate((k) => window.localStorage.getItem(k), key)).toBeNull();

  await page.getByTestId('expense-record-payment').click();
  await page.getByTestId('expense-payment-method').selectOption('card');
  await page.getByTestId('expense-payment-submit').click();
  await expect(page.getByTestId('expense-detail-due')).toContainText(ZERO_AMOUNT);
  expect(await page.evaluate((k) => window.localStorage.getItem(k), key)).toBeNull();

  // 2. Seed an unresolved string-actor attempt whose request committed before the response dropped.
  const seededIdempotencyKey = `e2e-seeded-string-actor-${STAMP}`;
  const seededDescription = `E2E Dropped Response Expense ${STAMP}`;
  const seededBody = {
    category_id: categoryId,
    description: seededDescription,
    amount_minor: 3100,
    incurred_on: businessDate,
  };

  // Commit the mutation on the backend under seededIdempotencyKey as if the response were lost in transit.
  const preCommitted = await page.request.post(`${BASE}/api/expenses`, {
    headers: { ...headers, 'Idempotency-Key': seededIdempotencyKey },
    data: seededBody,
  });
  expect(preCommitted.ok()).toBeTruthy();

  const seededSnapshot = {
    kind: 'expense.create',
    path: '/expenses',
    expenseId: null,
    paymentId: null,
    idempotencyKey: seededIdempotencyKey,
    body: seededBody,
    actorId: ownerUserId,
    tenantId: ownerTenantId,
    createdAt: new Date().toISOString(),
  };
  await page.evaluate(
    ([k, val]) => window.localStorage.setItem(k, val),
    [key, JSON.stringify(seededSnapshot)],
  );

  // Reload and open the workflow: the string-actor attempt is recovered and locks new submissions.
  await page.reload();
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('expense-add').click();
  await expect(page.getByTestId('expense-attempt-banner')).toBeVisible();
  await expect(page.getByTestId('expense-attempt-retry')).toBeVisible();
  await expect(page.getByTestId('expense-form-submit')).toBeDisabled();

  // 3. A network failure and a 5xx failure on retry keep the attempt locked in localStorage with the same key and body.
  let failurePhase: 'network' | '503' | 'none' = 'network';
  const replayedKeys: string[] = [];
  await page.route(`${BASE}/api/expenses`, async (route) => {
    if (route.request().method() === 'POST') {
      const idemHeader = route.request().headers()['idempotency-key'] ?? '';
      replayedKeys.push(idemHeader);
      if (failurePhase === 'network') {
        failurePhase = '503';
        await route.abort('failed');
        return;
      }
      if (failurePhase === '503') {
        failurePhase = 'none';
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary server fault' }),
        });
        return;
      }
    }
    await route.continue();
  });

  await page.getByTestId('expense-attempt-retry').click();
  await expect.poll(() => replayedKeys.length).toBe(1);
  await expect(page.getByTestId('expense-attempt-retry')).toBeEnabled();
  await expect(page.getByTestId('expense-attempt-banner')).toBeVisible();
  await expect(page.getByTestId('expense-form-submit')).toBeDisabled();

  await page.getByTestId('expense-attempt-retry').click();
  await expect.poll(() => replayedKeys.length).toBe(2);
  await expect(page.getByTestId('expense-attempt-retry')).toBeEnabled();
  await expect(page.getByTestId('expense-attempt-banner')).toBeVisible();
  await expect(page.getByTestId('expense-form-submit')).toBeDisabled();
  const stillLockedRaw = await page.evaluate((k) => window.localStorage.getItem(k), key);
  expect(stillLockedRaw).not.toBeNull();
  const stillLocked = JSON.parse(stillLockedRaw!);
  expect(stillLocked.idempotencyKey).toBe(seededIdempotencyKey);
  expect(stillLocked.actorId).toBe(ownerUserId);
  expect(stillLocked.body).toEqual(seededBody);

  // 4. Subsequent retry reaches the backend with the exact idempotency key, clears localStorage, and leaves 1 row.
  await page.getByTestId('expense-attempt-retry').click();
  await expect(page.getByTestId('expense-detail')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('expense-detail')).toContainText(seededDescription);
  expect(await page.evaluate((k) => window.localStorage.getItem(k), key)).toBeNull();
  expect(replayedKeys).toEqual([seededIdempotencyKey, seededIdempotencyKey, seededIdempotencyKey]);
  await page.unroute(`${BASE}/api/expenses`);

  const listAfterReplay = await page.request.get(`${BASE}/api/expenses?status=all&limit=100`, {
    headers,
  });
  expect(listAfterReplay.ok()).toBeTruthy();
  const matchingRows = (await listAfterReplay.json()).expenses.filter(
    (row: { description: string }) => row.description === seededDescription,
  );
  expect(matchingRows).toHaveLength(1);
  expect(matchingRows[0].amount_minor).toBe(3100);
});
