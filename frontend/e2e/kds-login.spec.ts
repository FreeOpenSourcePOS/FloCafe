import { test, expect } from '@playwright/test';

test('KDS standalone logs in and restores its session', async ({ page }) => {
  await page.goto('http://localhost:3002/kds-standalone');
  await expect(page.getByTestId('kds-login-form')).toBeVisible();
  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill('E2ePass123!');
  await page.getByTestId('kds-login-submit').click();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
});
