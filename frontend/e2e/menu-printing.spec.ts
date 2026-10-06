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
  await dialog.getByRole('radio', { name: 'Paper (A4 / Letter)' }).click();
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

test('print menu offers receipt, paper, and PDF destinations', async ({ page, context }) => {
  await context.addInitScript(() => { window.print = () => {}; });
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/(pos|orders)/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('token'))).not.toBeNull();
  await page.goto(`${BASE}/pos`);
  await expect(page.getByRole('button', { name: /E2E Coffee/ })).toBeVisible();
  await page.getByRole('button', { name: 'Print Menu', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Every destination the operator can reach is offered up front; A4/Letter is
  // a detail of the paper choice rather than the only way to print.
  const destinations = dialog.getByRole('radiogroup', { name: 'Print destination' });
  await expect(destinations.getByRole('radio')).toHaveCount(3);
  await expect(destinations.getByRole('radio', { name: 'Receipt printer' })).toBeVisible();
  const paperDestination = destinations.getByRole('radio', { name: 'Paper (A4 / Letter)' });
  await expect(paperDestination).toHaveAttribute('aria-checked', 'false');
  await expect(destinations.getByRole('radio', { name: 'Save as PDF' })).toBeVisible();
  const destinationBox = await destinations.boundingBox();
  const filterBox = await dialog.getByRole('checkbox').first().boundingBox();
  expect(destinationBox).not.toBeNull();
  expect(filterBox).not.toBeNull();
  expect(destinationBox!.y).toBeLessThan(filterBox!.y);
  const printButton = dialog.getByRole('button', { name: 'Print Menu', exact: true });
  await expect(printButton).toBeDisabled();
  await paperDestination.click();
  await expect(printButton).toBeEnabled();

  // The receipt destination swaps the sheet size for the thermal roll width,
  // and a missing picker never dead-ends the operator.
  await destinations.getByRole('radio', { name: 'Receipt printer' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Paper Size' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Print Menu', exact: true })).toBeEnabled();

  // Without the desktop bridge, saving as PDF still produces a printable
  // document through the browser print dialog.
  await destinations.getByRole('radio', { name: 'Save as PDF' }).click();
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Save as PDF' }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Menu', level: 1 })).toBeVisible();
  await expect.poll(() => popup.locator('style').textContent()).toContain('size: A4 portrait');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await popup.close();
});
