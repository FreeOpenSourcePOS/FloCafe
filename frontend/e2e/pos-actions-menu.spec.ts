import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('POS shortcuts stay suspended while the more-actions menu is open', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();

  await page.getByTestId('pos-product-card').first().click();
  await expect(page.getByTestId('cart-item')).toHaveCount(1);

  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Space');

  await expect(page.getByTestId('cart-item')).toHaveCount(1);
});
