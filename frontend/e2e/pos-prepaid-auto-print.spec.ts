import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

const MANAGER_TOKEN = getE2eToken('e2e-manager', 'manager@flo.local', 'manager');
const AUTH = { Authorization: `Bearer ${MANAGER_TOKEN}` };

type PrintProbe = Window & { receiptWindowOpens?: number };

/** Pays one prepaid cash order and returns how many receipt print windows it opened. */
async function payPrepaidOrder(page: Page, autoPrintBill: boolean): Promise<number> {
  await page.addInitScript((enabled) => {
    const stored = JSON.parse(localStorage.getItem('pos-settings') || '{"state":{},"version":6}');
    stored.state.autoPrintBill = enabled;
    localStorage.setItem('pos-settings', JSON.stringify(stored));
    // Isolate from configured host printers left by earlier specs in the serial E2E suite.
    const printerStored = JSON.parse(
      localStorage.getItem('flo-printer-settings') || '{"state":{},"version":1}',
    );
    printerStored.state.printMethod = 'browser';
    localStorage.setItem('flo-printer-settings', JSON.stringify(printerStored));
    const probe = window as PrintProbe;
    probe.receiptWindowOpens = 0;
    window.open = (() => {
      probe.receiptWindowOpens = (probe.receiptWindowOpens ?? 0) + 1;
      return null;
    }) as typeof window.open;
  }, autoPrintBill);

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await page.getByTestId('pos-product-card').first().click();
  const addToCart = page.getByRole('button', { name: /Add to Cart/ });
  if (await addToCart.count()) await addToCart.click();

  await page.getByRole('button', { name: 'Place Order' }).click();
  const checkout = page.getByTestId('prepaid-checkout-modal');
  await expect(checkout.getByRole('button', { name: /^Tax / })).toBeVisible();
  await checkout.getByRole('button', { name: 'Cash', exact: true }).click();
  await checkout.getByRole('button', { name: /Confirm Payment/ }).click();
  // The success state renders only after the checkout handler has awaited auto-print.
  await expect(checkout.getByText('Payment recorded!', { exact: true })).toBeVisible();
  return page.evaluate(() => (window as PrintProbe).receiptWindowOpens ?? 0);
}

test.describe('prepaid checkout receipt auto-print', () => {
  let originalBusiness: Record<string, unknown>;

  test.beforeEach(async ({ page }) => {
    const response = await page.request.get(`${BASE}/api/settings/business`, { headers: AUTH });
    expect(response.ok()).toBeTruthy();
    originalBusiness = await response.json();
    const updated = await page.request.put(`${BASE}/api/settings/business`, {
      headers: AUTH,
      data: { ...originalBusiness, billing_type: 'prepaid' },
    });
    expect(updated.ok()).toBeTruthy();
  });

  test.afterEach(async ({ page }) => {
    const restored = await page.request.put(`${BASE}/api/settings/business`, {
      headers: AUTH,
      data: originalBusiness,
    });
    expect(restored.ok()).toBeTruthy();
  });

  test('does not print when Auto-print Bill is off', async ({ page }) => {
    expect(await payPrepaidOrder(page, false)).toBe(0);
  });

  test('prints once when Auto-print Bill is on', async ({ page }) => {
    expect(await payPrepaidOrder(page, true)).toBe(1);
  });
});
