import { test, expect } from '@playwright/test';
import { E2E_KDS_BASE_URL } from './helpers/urls';

test('KDS standalone logs in and restores its session', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form')).toBeVisible();
  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill('E2ePass123!');
  await page.getByTestId('kds-login-submit').click();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  // The controls must be hydrated on the first authenticated render, not
  // only after a full reload.
  await page.getByRole('button', { name: 'Kanban', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByTestId('kds-login-form')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();
  await expect(page.getByTestId('kds-login-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Kanban', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(pageErrors.filter((error) => /Minified React error #418|Hydration failed/i.test(error.message))).toHaveLength(0);
});
