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

test('LAN/browser sidebar pins to the viewport top with zero title-bar markup', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();

  // Capability absent: no Electron title-bar markup and no CSS desktop flag.
  expect(await page.evaluate(() => Boolean(window.electronAPI))).toBe(false);
  await expect(page.getByTestId('desktop-title-bar')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-flo-desktop-titlebar');

  const sidebar = page.locator('[data-slot="sidebar-container"]');
  await expect(sidebar).toBeVisible();

  const viewportHeight = page.viewportSize()?.height ?? 0;
  expect(viewportHeight).toBeGreaterThan(0);

  const assertViewportTopGeometry = async (label: string) => {
    const box = await sidebar.boundingBox();
    expect(box, `${label}: sidebar has bounds`).not.toBeNull();
    expect(box!.y, `${label}: sidebar starts at viewport top`).toBe(0);
    expect(box!.height, `${label}: sidebar spans the viewport`).toBeCloseTo(viewportHeight, 0);
    const top = await sidebar.evaluate((element) => getComputedStyle(element).top);
    expect(top, `${label}: computed block-start inset`).toBe('0px');
  };

  // Expanded and collapsed/rail variants must both keep viewport-top geometry.
  await assertViewportTopGeometry('expanded sidebar');
  await page.keyboard.press('Control+b');
  await expect(sidebar).toBeVisible();
  await assertViewportTopGeometry('collapsed sidebar');

  // CSS wiring sanity for the Electron path: forcing the capability flag on
  // <html> must offset the fixed sidebar below the title bar height.
  const forced = await sidebar.evaluate((element) => {
    const html = document.documentElement;
    try {
      html.dataset.floDesktopTitlebar = 'true';
      const rect = element.getBoundingClientRect();
      return { y: rect.y, height: rect.height };
    } finally {
      delete html.dataset.floDesktopTitlebar;
    }
  });
  expect(forced.y, 'desktop flag offsets sidebar below title bar').toBeCloseTo(40, 0);
  expect(forced.height, 'desktop flag shrinks sidebar by title-bar height')
    .toBeCloseTo(viewportHeight - 40, 0);
});
