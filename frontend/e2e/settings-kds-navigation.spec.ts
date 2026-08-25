import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

test('KDS sidebar link selects the KDS tab after switching Settings tabs', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('manager@flo.local');
  await page.getByLabel('Password').fill('E2ePass123!');
  await page.getByRole('button', { name: 'Sign In' }).click();

  await page.getByRole('button', { name: /manager@flo.local|Manager|User/i }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/?$/);

  await page.getByRole('link', { name: 'KDS', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?\?tab=kds$/);
  await expect(page.getByRole('heading', { name: 'KDS', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'POS Workflow', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?\?tab=pos$/);
  await expect(page.getByRole('heading', { name: 'POS Workflow', exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'KDS', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/?\?tab=kds$/);
  await expect(page.getByRole('heading', { name: 'KDS', exact: true })).toBeVisible();
});
