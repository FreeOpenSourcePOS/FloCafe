import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

test('POS product grid has no horizontal clipping and touchable product cards', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();

  // The LAN/browser build must not render Electron-only title-bar markup.
  expect(await page.evaluate(() => Boolean(window.electronAPI))).toBe(false);
  await expect(page.getByTestId('desktop-title-bar')).toHaveCount(0);
  await expect(page.getByTestId('desktop-drag-surface')).toHaveCount(0);

  const productGrid = page.getByTestId('pos-product-grid');
  await expect(productGrid).toBeVisible();
  await expect(page.getByTestId('pos-product-card')).toHaveCount(1);

  const grid = await productGrid.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(grid.scrollWidth, 'POS grid does not overflow horizontally').toBeLessThanOrEqual(grid.clientWidth);

  const card = await page.getByTestId('pos-product-card').boundingBox();
  expect(card, 'product card has bounds').not.toBeNull();
  expect(card!.width, 'product card width').toBeGreaterThanOrEqual(44);
  expect(card!.height, 'product card height').toBeGreaterThanOrEqual(44);
});
