import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

const STAMP = Date.now();
const CATEGORY_NAME = `Coffee Beans ${STAMP}`;

test('drive all expenses UX scenarios live and capture visual evidence', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Authenticate owner via API to create a clean category
  const login = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email: 'owner@flo.local', password: E2E_PASSWORD },
  });
  expect(login.ok()).toBeTruthy();
  const { access_token } = await login.json();
  const headers = { Authorization: `Bearer ${access_token}` };

  const catRes = await page.request.post(`${BASE}/api/expenses/categories`, {
    headers: { ...headers, 'Idempotency-Key': `evidence-cat-${STAMP}` },
    data: { name: CATEGORY_NAME },
  });
  expect(catRes.ok()).toBeTruthy();
  const categoryId = (await catRes.json()).category.id;

  // Sign in through the real login UI
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'), { timeout: 20000 });

  // Navigate to /expenses
  await page.goto(`${BASE}/expenses`);
  await expect(page.getByTestId('expenses-page')).toBeVisible({ timeout: 20000 });

  // Scenario 1: Single-currency filter omitted, Amount (THB) label on create form, unpaid row with plain hyphen '-' for blank payee
  await expect(page.getByTestId('expense-filter-currency')).toHaveCount(0);
  await page.getByTestId('expense-add').click();
  await expect(page.getByTestId('expense-workflow')).toBeVisible();
  await expect(page.locator('label[for="expense-amount"]')).toContainText('Amount (THB)');
  await expect(page.getByTestId('expense-workflow-close')).toHaveText('Cancel');

  const desc1 = `Espresso Machine Maintenance ${STAMP}`;
  await page.getByTestId('expense-form-category').selectOption(categoryId);
  await page.getByTestId('expense-form-description').fill(desc1);
  await page.getByTestId('expense-form-amount').fill('40.00');
  // Leave payee blank to verify '-' instead of em dash '—'
  await page.getByTestId('expense-form-submit').click();

  await expect(page.getByTestId('expense-detail')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('expense-workflow-close')).toHaveText('Close');
  await page.getByTestId('expense-workflow-close').click();
  await expect(page.getByTestId('expense-workflow')).toHaveCount(0);

  // Filter to our category so summary groups and rows are focused
  await page.getByTestId('expense-filter-category').selectOption(categoryId);

  const row1 = page.getByTestId('expense-row').filter({ hasText: desc1 }).first();
  await expect(row1).toBeVisible();
  // Verify plain hyphen '-' in Payee column (3rd td) and no em dash
  await expect(row1.locator('td').nth(2)).toHaveText('-');
  await expect(row1.locator('td').nth(6)).toContainText('Unpaid');
  await expect(row1.getByTestId('expense-row-pay')).toBeVisible();
  await expect(row1.getByTestId('expense-row-replace')).toBeVisible();
  await expect(row1.getByTestId('expense-open-detail')).toBeVisible();
  await expect(page.getByTestId('expense-summary-groups')).toContainText(CATEGORY_NAME);
  await expect(page.getByTestId('expense-summary-groups')).toContainText('40.00');
  await expect(page.getByTestId('expense-summary-groups')).toContainText('Due:');

  // Scenario 2: Row-level Edit (expense-row-replace) opens Replace sub-view directly, Back returns to Detail, and Replace replaces the unpaid expense
  await row1.getByTestId('expense-row-replace').click();
  await expect(page.getByTestId('expense-form')).toBeVisible();
  await expect(page.getByTestId('expense-form-description')).toHaveValue(desc1);
  await expect(page.getByTestId('expense-form-amount')).toHaveValue('40.00');
  await expect(page.locator('label[for="expense-amount"]')).toContainText('Amount (THB)');
  await expect(page.getByTestId('expense-workflow-back')).toHaveText('Back');

  // Click Back -> returns to Detail main view instead of closing the modal
  await page.getByTestId('expense-workflow-back').click();
  await expect(page.getByTestId('expense-detail')).toBeVisible();
  await expect(page.getByTestId('expense-workflow-close')).toHaveText('Close');

  // Open Replace from Detail view (verifying openReplace() uses record and getCurrencyMinorUnitFactor)
  await page.getByTestId('expense-replace').click();
  await expect(page.getByTestId('expense-form-amount')).toHaveValue('40.00');
  const descReplaced = `Espresso Machine Overhaul ${STAMP}`;
  await page.getByTestId('expense-form-description').fill(descReplaced);
  await page.getByTestId('expense-form-amount').fill('60.00');
  await page.getByTestId('expense-form-payee').fill('Bangkok Espresso Service');
  await page.getByTestId('expense-form-reason').fill('Updated invoice total from technician');
  await page.getByTestId('expense-form-submit').click();

  // After replace, modal shows the new active record in Detail view
  await expect(page.getByTestId('expense-detail')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('expense-detail-description')).toHaveText(descReplaced);
  await page.getByTestId('expense-workflow-close').click();

  // Verify old row shows 'Replaced' badge and no Edit/Pay buttons when filtering by 'replaced'
  await page.getByTestId('expense-filter-status').selectOption('replaced');
  const oldRow = page.getByTestId('expense-row').filter({ hasText: desc1 }).first();
  await expect(oldRow).toBeVisible();
  await expect(oldRow.locator('td').nth(6)).toContainText('Replaced');
  await expect(oldRow.getByTestId('expense-row-pay')).toHaveCount(0);
  await expect(oldRow.getByTestId('expense-row-replace')).toHaveCount(0);
  await page.getByTestId('expense-filter-status').selectOption('active');

  // Scenario 3: Row-level Record payment opens payment form with Total / Net paid / Due summary, rejects overpayment, and records partial payment
  const activeRow = page.getByTestId('expense-row').filter({ hasText: descReplaced }).first();
  await expect(activeRow).toBeVisible();
  await activeRow.getByTestId('expense-row-pay').click();

  await expect(page.getByTestId('expense-payment-form')).toBeVisible();
  const paymentSummary = page.getByTestId('expense-payment-summary');
  await expect(paymentSummary).toBeVisible();
  await expect(paymentSummary).toContainText('Total:');
  await expect(paymentSummary).toContainText('60.00');
  await expect(paymentSummary).toContainText('Net paid:');
  await expect(paymentSummary).toContainText('0.00');
  await expect(paymentSummary).toContainText('Due:');
  await expect(page.locator('label[for="expense-payment-amount"]')).toContainText('Amount (THB)');
  await expect(page.getByTestId('expense-payment-amount')).toHaveValue('60.00');
  await expect(page.getByTestId('expense-workflow-back')).toHaveText('Back');

  // Adversarial check: attempt to pay 75.00 (> 60.00 due) -> rejected with alert
  await page.getByTestId('expense-payment-method').selectOption('card');
  await page.getByTestId('expense-payment-amount').fill('75.00');
  await page.getByTestId('expense-payment-submit').click();
  await expect(page.getByTestId('expense-payment-form').getByRole('alert')).toBeVisible();

  // Record a partial payment of 25.00
  await page.getByTestId('expense-payment-amount').fill('25.00');
  await page.getByTestId('expense-payment-reference').fill(`PARTIAL-${STAMP}`);
  await page.getByTestId('expense-payment-submit').click();

  // Scenario 4: Detail view after partial payment shows blockedByPayments and disables Void/Replace
  await expect(page.getByTestId('expense-detail')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('expense-blocked-by-payments')).toBeVisible();
  await expect(page.getByTestId('expense-void')).toBeDisabled();
  await expect(page.getByTestId('expense-replace')).toBeDisabled();
  await page.getByTestId('expense-workflow-close').click();

  // Row now shows 'Partially Paid', keeps 'Record payment' button, and hides 'Edit' button
  await expect(activeRow.locator('td').nth(6)).toContainText('Partially Paid');
  await expect(activeRow.getByTestId('expense-row-pay')).toBeVisible();
  await expect(activeRow.getByTestId('expense-row-replace')).toHaveCount(0);
  // Summary groups still shows incurred 60.00 and remaining Due 35.00
  await expect(page.getByTestId('expense-summary-groups')).toContainText('60.00');
  await expect(page.getByTestId('expense-summary-groups')).toContainText('35.00');

  // Create two more expenses to show all settlement status badges (Paid, Partially Paid, Unpaid) and Voided:
  // 1) Settle one expense completely -> Paid
  const descPaid = `Milk Delivery Settled ${STAMP}`;
  await page.getByTestId('expense-add').click();
  await page.getByTestId('expense-form-category').selectOption(categoryId);
  await page.getByTestId('expense-form-description').fill(descPaid);
  await page.getByTestId('expense-form-amount').fill('30.00');
  await page.getByTestId('expense-form-submit').click();
  await expect(page.getByTestId('expense-detail')).toBeVisible();
  await page.getByTestId('expense-record-payment').click();
  await page.getByTestId('expense-payment-method').selectOption('card');
  await page.getByTestId('expense-payment-submit').click();
  await expect(page.getByTestId('expense-detail-due')).toContainText('0.00');
  await page.getByTestId('expense-workflow-close').click();

  const paidRow = page.getByTestId('expense-row').filter({ hasText: descPaid }).first();
  await expect(paidRow.locator('td').nth(6)).toContainText('Paid');
  await expect(paidRow.getByTestId('expense-row-pay')).toHaveCount(0);
  await expect(paidRow.getByTestId('expense-row-replace')).toHaveCount(0);

  // 2) Create and void an expense -> Voided (and verify Back from Void sub-view)
  const descVoided = `Duplicate Napkin Order ${STAMP}`;
  await page.getByTestId('expense-add').click();
  await page.getByTestId('expense-form-category').selectOption(categoryId);
  await page.getByTestId('expense-form-description').fill(descVoided);
  await page.getByTestId('expense-form-amount').fill('15.00');
  await page.getByTestId('expense-form-submit').click();
  await expect(page.getByTestId('expense-detail')).toBeVisible();
  await page.getByTestId('expense-void').click();
  await expect(page.getByTestId('expense-void-form')).toBeVisible();
  await page.getByTestId('expense-workflow-back').click();
  await expect(page.getByTestId('expense-detail')).toBeVisible();
  await page.getByTestId('expense-void').click();
  await page.getByTestId('expense-void-reason').fill('Entered twice by mistake');
  await page.getByTestId('expense-void-submit').click();
  await expect(page.getByTestId('expense-detail-status')).toContainText('Voided');
  await page.getByTestId('expense-workflow-close').click();

  await page.getByTestId('expense-filter-status').selectOption('voided');
  const voidedRow = page.getByTestId('expense-row').filter({ hasText: descVoided }).first();
  await expect(voidedRow.locator('td').nth(6)).toContainText('Voided');
  await page.getByTestId('expense-filter-status').selectOption('active');

  // 3) Create one fresh Unpaid expense so the table simultaneously shows Unpaid, Paid, Partially Paid
  const descUnpaid = `Filter Cartridges ${STAMP}`;
  await page.getByTestId('expense-add').click();
  await page.getByTestId('expense-form-category').selectOption(categoryId);
  await page.getByTestId('expense-form-description').fill(descUnpaid);
  await page.getByTestId('expense-form-amount').fill('20.00');
  await page.getByTestId('expense-form-submit').click();
  await expect(page.getByTestId('expense-detail')).toBeVisible();
  await page.getByTestId('expense-workflow-close').click();

  await expect(
    page.getByTestId('expense-row').filter({ hasText: descUnpaid }).first().locator('td').nth(6),
  ).toContainText('Unpaid');

  // Scenario 5: 4xx API rejection surfaces actionable server error message in expense-attempt-banner
  await page.route(`${BASE}/api/expenses`, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid expense payload: business date is closed' }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByTestId('expense-add').click();
  await page.getByTestId('expense-form-category').selectOption(categoryId);
  await page.getByTestId('expense-form-description').fill(`Rejected Expense ${STAMP}`);
  await page.getByTestId('expense-form-amount').fill('18.00');
  await page.getByTestId('expense-form-submit').click();

  await expect(page.getByTestId('expense-attempt-banner')).toContainText(
    'Invalid expense payload: business date is closed',
  );
  await page.unroute(`${BASE}/api/expenses`);
});
