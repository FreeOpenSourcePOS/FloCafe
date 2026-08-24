import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL } from './helpers/urls';

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

test('LAN/browser sidebar pins to the viewport top with zero title-bar markup on the POS, KDS, and settings routes', async ({ page }) => {
  // One login keeps the suite within the shared server's login rate limit.
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/pos/, { timeout: 20000 });

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

  // Every dashboard layout route shares the same fixed-sidebar chrome, so the
  // capability-absent contract must hold on each of them in expanded and
  // collapsed/rail variants: zero Electron title-bar markup, no CSS desktop
  // flag, viewport-top sidebar geometry. /kds is served by its standalone
  // KDS server (the main LAN app reserves /kds for its WebSocket endpoint),
  // so it is exercised against the same static export on the KDS origin.
  const dashboardRoutes = [
    { name: 'POS', url: `${BASE}/pos` },
    { name: 'KDS', url: `${E2E_KDS_BASE_URL}/kds` },
    { name: 'settings', url: `${BASE}/settings` },
  ];
  for (const route of dashboardRoutes) {
    await page.goto(route.url);
    await expect(sidebar, `${route.name}: sidebar renders`).toBeVisible();

    expect(await page.evaluate(() => Boolean(window.electronAPI)), `${route.name}: capability absent`).toBe(false);
    await expect(page.getByTestId('desktop-title-bar'), route.name).toHaveCount(0);
    await expect(page.getByTestId('desktop-drag-surface'), route.name).toHaveCount(0);
    await expect(page.locator('html'), route.name).not.toHaveAttribute('data-flo-desktop-titlebar');

    await assertViewportTopGeometry(`${route.name} expanded sidebar`);
    await page.keyboard.press('Control+b');
    await expect(sidebar, `${route.name}: rail stays visible when collapsed`).toBeVisible();
    await assertViewportTopGeometry(`${route.name} collapsed sidebar`);
  }

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
