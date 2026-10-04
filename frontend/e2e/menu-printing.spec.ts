import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('menu modal suspends barcode scans and browser fallback includes selected details on Letter paper', async ({ page, context }) => {
  await context.addInitScript(() => { window.print = () => {}; });
  await page.route('**/api/products*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    data.products = data.products.map((product: { id: string }) => product.id === 'e2e-product' ? {
      ...product,
      barcode: '9780123456789',
      description: 'Fresh menu coffee',
      addon_groups: [{ id: 'menu-milk', name: 'Milk', is_active: true, addons: [{ id: 'menu-oat', name: 'Oat milk', price: 2, is_active: true }] }],
    } : product);
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/printers/print-menu', (route) => route.fulfill({ status: 502, json: { error: 'Printer offline' } }));
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('token'))).not.toBeNull();
  await page.goto(`${BASE}/pos`);
  await expect(page.getByRole('button', { name: /E2E Coffee/ })).toBeVisible();
  await page.evaluate(() => {
    for (const key of '9780123456789') window.dispatchEvent(new KeyboardEvent('keydown', { key }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  });
  await expect(page.getByRole('heading', { name: 'E2E Coffee', exact: true, level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'E2E Coffee', exact: true, level: 2 })).toHaveCount(0);
  await page.getByRole('button', { name: 'Print Menu', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.evaluate(() => {
    for (const key of '9780123456789') window.dispatchEvent(new KeyboardEvent('keydown', { key }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(dialog.getByRole('heading', { name: 'Print Menu', exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Include descriptions' }).click();
  await dialog.getByRole('checkbox', { name: 'Include modifiers' }).click();
  await dialog.getByRole('combobox', { name: 'Paper Size' }).selectOption('Letter');
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Print Menu', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup.getByText('Fresh menu coffee', { exact: true })).toBeVisible();
  await expect(popup.getByText(/Milk: Oat milk/)).toBeVisible();
  await expect.poll(() => popup.locator('style').textContent()).toContain('size: Letter portrait');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'E2E Coffee', exact: true, level: 2 })).toHaveCount(0);
  await popup.close();
});
