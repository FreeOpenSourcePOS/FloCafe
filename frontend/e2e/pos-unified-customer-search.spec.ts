import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

test('POS unified customer search: name/phone lookup, predictive create, and field swap', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  const attemptId = Date.now();
  const existingName = `Unified Existing ${attemptId}`;
  const existingPhone = `+668${String(attemptId).slice(-8)}`;
  const newCustomerPhone = `081${String(attemptId).slice(-7)}`;
  const newCustomerName = `Unified Created ${attemptId}`;

  const token = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
  const authHeaders = { Authorization: `Bearer ${token}` };

  const customerResponse = await page.request.post(`${BASE}/api/customers`, {
    headers: authHeaders,
    data: { name: existingName, phone: existingPhone, country_code: '+66' },
  });
  expect(customerResponse.ok()).toBeTruthy();

  // Log in via UI
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20_000 });
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();

  const customerSearchInput = page.getByTestId('pos-customer-search-input').first();
  await expect(customerSearchInput).toBeVisible();
  const modal = page.locator('div.fixed.inset-0').filter({
    has: page.getByRole('heading', { name: 'Add Customer' }),
  });

  // 1. Search by Name
  const nameLookupQuery = existingName.slice(0, 10);
  let resolveLookupStarted!: () => void;
  let releaseLookup!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    resolveLookupStarted = resolve;
  });
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  await page.route('**/api/customers-search**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === nameLookupQuery) {
      resolveLookupStarted();
      await lookupGate;
    }
    await route.continue();
  });
  await customerSearchInput.fill(nameLookupQuery);
  await lookupStarted;
  try {
    await customerSearchInput.press('Enter');
    await expect(modal).not.toBeVisible();
  } finally {
    releaseLookup();
  }
  const nameResult = page.getByRole('button').filter({ hasText: existingName }).first();
  await expect(nameResult).toBeVisible({ timeout: 5_000 });
  await page.unroute('**/api/customers-search**');
  await customerSearchInput.fill(`${existingName} no match`);
  await expect(nameResult).toBeHidden();
  await customerSearchInput.fill(existingName.slice(0, 10));
  await expect(nameResult).toBeVisible({ timeout: 5_000 });
  await nameResult.click();
  await expect(page.getByText(existingName, { exact: true })).toBeVisible();

  // Remove customer from cart
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(customerSearchInput).toBeVisible();

  const failedLookupQuery = 'lookup failure';
  await page.route('**/api/customers-search**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === failedLookupQuery) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'lookup failed' }),
      });
      return;
    }
    await route.continue();
  });
  await customerSearchInput.fill(failedLookupQuery);
  await expect(page.getByText('Something went wrong', { exact: true })).toBeVisible({
    timeout: 5_000,
  });
  await expect(
    page.getByRole('button').filter({ hasText: failedLookupQuery }).first(),
  ).toBeHidden();
  await customerSearchInput.press('Enter');
  await expect(modal).not.toBeVisible();
  await page.unroute('**/api/customers-search**');

  const unmatchedEmailQuery = `unmatched-${attemptId}@example.com`;
  await page.route('**/api/customers-search**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === unmatchedEmailQuery) {
      await route.fulfill({ json: [] });
      return;
    }
    await route.continue();
  });
  await customerSearchInput.fill(unmatchedEmailQuery);
  await expect(page.getByText('No matching results')).toBeVisible({ timeout: 5_000 });
  await expect(
    page.getByRole('button').filter({ hasText: unmatchedEmailQuery }).first(),
  ).toBeHidden();
  await customerSearchInput.press('Enter');
  await expect(modal).not.toBeVisible();
  await page.unroute('**/api/customers-search**');

  // Ambiguous digits require an explicit action choice.
  await page.route('**/api/customers-search?q=123', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/customers-search?q=234', (route) => route.fulfill({ json: [] }));
  await customerSearchInput.fill('123');
  await expect(page.getByText('No matching results')).toBeVisible({ timeout: 5_000 });
  await customerSearchInput.press('Enter');
  await expect(modal).not.toBeVisible();
  await customerSearchInput.press('ArrowDown');
  await customerSearchInput.press('Enter');
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('textbox').first()).toHaveValue('123');
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).not.toBeVisible();

  await customerSearchInput.fill('234');
  await expect(page.getByText('No matching results')).toBeVisible({ timeout: 5_000 });
  await customerSearchInput.press('Enter');
  await expect(modal).not.toBeVisible();
  await customerSearchInput.press('ArrowUp');
  await customerSearchInput.press('Enter');
  await expect(modal).toBeVisible();
  await expect(modal.locator('input[type="tel"]')).toHaveValue('234');
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).not.toBeVisible();

  // 2. Search by Phone digits
  const phoneDigits = existingPhone.replace(/\D/g, '').slice(-7);
  await customerSearchInput.fill(phoneDigits);
  const phoneResult = page.getByRole('button').filter({ hasText: existingName }).first();
  await expect(phoneResult).toBeVisible({ timeout: 5_000 });
  await phoneResult.click();
  await expect(page.getByText(existingName, { exact: true })).toBeVisible();

  // Remove customer again
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(customerSearchInput).toBeVisible();

  // 3. Search by non-existent phone number -> predictive action
  await customerSearchInput.fill(newCustomerPhone);
  await expect(page.getByText('No matching results')).toBeVisible({ timeout: 5_000 });

  const createAction = page.getByRole('button').filter({ hasText: newCustomerPhone }).first();
  await expect(createAction).toBeVisible();
  await createAction.click();

  // 4. Modal opens with pre-filled phone number
  await expect(modal).toBeVisible();

  const phoneField = modal.locator('input[type="tel"]');
  const nameField = modal.getByRole('textbox').first();
  await expect(phoneField).toHaveValue(newCustomerPhone);
  await expect(phoneField).toBeFocused();
  await expect(nameField).toHaveValue('');

  // 5. Test Swap Name & Phone
  const swapButton = modal.getByRole('button', { name: /Swap Name & Phone/i });
  await expect(swapButton).toBeVisible();
  await swapButton.click();

  await expect(nameField).toHaveValue(newCustomerPhone);
  await expect(phoneField).toHaveValue('');

  // Swap back
  await swapButton.click();
  await expect(phoneField).toHaveValue(newCustomerPhone);
  await expect(nameField).toHaveValue('');

  // Fill real name and save
  await nameField.fill(newCustomerName);

  const saveButton = modal.getByRole('button', { name: 'Save', exact: true });
  await saveButton.click();
  await expect(modal).not.toBeVisible();

  // Verify created customer is selected in cart
  await expect(page.getByText(newCustomerName, { exact: true })).toBeVisible({ timeout: 10_000 });
});
