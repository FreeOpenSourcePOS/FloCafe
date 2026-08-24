import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE, E2E_KDS_BASE_URL } from './helpers/urls';

/**
 * Platform test-matrix rows for the custom title-bar work (Refs #457/#462)
 * that are verifiable against the LAN/browser build:
 *
 *  - Browser/LAN at multiple viewports: zero Electron-only title-bar markup
 *    and unchanged viewport-top sidebar layout (matrix row 4).
 *  - Sidebar-offset regression from #504: on every dashboard route state
 *    (expanded and collapsed/rail) at md+ breakpoints, the browser build
 *    keeps the fixed sidebar pinned to the viewport top, while forcing the
 *    desktop capability flag offsets it below the 40px title bar (row 5).
 *
 * These rows run in plain Chromium against the static export; the Electron
 * presentation rows live in docs/title-bar-platform-matrix.md with their own
 * evidence (unit suites + runtime probes). A single login per test keeps the
 * shared e2e server's login rate limit (10 POSTs / 15 min) safe.
 */

const VIEWPORTS = [
  { name: 'md 1024x768', width: 1024, height: 768 },
  { name: 'lg 1440x900', width: 1440, height: 900 },
  { name: 'xl 1920x1080', width: 1920, height: 1080 },
] as const;

test('browser/LAN has zero title-bar markup and unchanged layout at md+ viewports', async ({ page }) => {
  await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/pos/, { timeout: 20000 });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const dashboardRoutes = [
      { name: 'POS', url: `${BASE}/pos` },
      { name: 'settings', url: `${BASE}/settings` },
      { name: 'KDS', url: `${E2E_KDS_BASE_URL}/kds` },
    ];
    for (const route of dashboardRoutes) {
      await page.goto(route.url);
      const label = `${viewport.name} ${route.name}`;

      // Capability-based detection must keep all Electron-only chrome out of
      // the browser/LAN DOM at every breakpoint.
      expect(await page.evaluate(() => Boolean(window.electronAPI)), `${label}: capability absent`).toBe(false);
      await expect(page.getByTestId('desktop-title-bar'), label).toHaveCount(0);
      await expect(page.getByTestId('desktop-drag-surface'), label).toHaveCount(0);
      await expect(page.locator('.flo-title-bar'), label).toHaveCount(0);
      await expect(page.locator('.flo-title-bar__fallback-controls'), label).toHaveCount(0);
      await expect(page.locator('html'), `${label}: no desktop CSS flag`).not.toHaveAttribute(
        'data-flo-desktop-titlebar',
      );

      // Unchanged layout contract: the CSS variable that offsets fixed app
      // chrome below the title bar stays at its browser default.
      const sidebarBlockStart = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--flo-sidebar-block-start').trim(),
      );
      expect(sidebarBlockStart, `${label}: no title-bar offset`).toBe('0px');
    }
  }
});

test('sidebar offset regression (#504): expanded/collapsed states at md+ viewports', async ({ page }) => {
  await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/pos/, { timeout: 20000 });

  const assertViewportTopGeometry = async (label: string, viewportHeight: number) => {
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    const box = await sidebar.boundingBox();
    expect(box, `${label}: sidebar has bounds`).not.toBeNull();
    expect(box!.y, `${label}: sidebar starts at viewport top`).toBe(0);
    expect(box!.height, `${label}: sidebar spans the viewport`).toBeCloseTo(viewportHeight, 0);
    const computed = await sidebar.evaluate((element) => ({
      top: getComputedStyle(element).top,
      insetBlockStart: getComputedStyle(element).insetBlockStart,
    }));
    expect(parseFloat(computed.insetBlockStart), `${label}: block-start inset stays 0`).toBe(0);
  };

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const routes = [
      { name: 'POS', url: `${BASE}/pos` },
      { name: 'settings', url: `${BASE}/settings` },
      { name: 'KDS', url: `${E2E_KDS_BASE_URL}/kds` },
    ];
    for (const route of routes) {
      await page.goto(route.url);
      const sidebar = page.locator('[data-slot="sidebar-container"]');
      await expect(sidebar, `${viewport.name} ${route.name}: sidebar renders`).toBeVisible();

      await assertViewportTopGeometry(`${viewport.name} ${route.name} expanded`, viewport.height);

      // Collapse to rail (the same toggle #505 had to keep below the bar) and
      // re-check; Control+b is the app's sidebar shortcut.
      await page.keyboard.press('Control+b');
      await expect(sidebar, `${viewport.name} ${route.name}: rail stays visible when collapsed`).toBeVisible();
      await assertViewportTopGeometry(`${viewport.name} ${route.name} collapsed`, viewport.height);
      await page.keyboard.press('Control+b');
    }
  }

  // Desktop-path regression guard (CSS wiring only, capability forced): the
  // flag must move the fixed sidebar below the 40px bar at md+ widths.
  const sidebar = page.locator('[data-slot="sidebar-container"]');
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
});
