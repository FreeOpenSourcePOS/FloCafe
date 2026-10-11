import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { injectElectronFixture } from './helpers/electron-fixture';

test.describe('Clean Cashier Status Bar & Telemetry Drawer', () => {
  test('frontline status bar displays cashier identity, printer, shift, and drawer actions', async ({
    page,
  }) => {
    await page.route('**/cash-sessions/current', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Insufficient permissions' }),
      }),
    );

    // Inject Electron fixture so desktop capability and system telemetry are simulated
    await injectElectronFixture(page, { api: true, platform: 'darwin' });

    // Login as owner/cashier
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill('E2ePass123!');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/pos/, { timeout: 20000 });

    // 1. Verify persistent frontline status bar is rendered
    const statusBar = page.locator('footer[role="status"]');
    await expect(statusBar).toBeVisible();

    // 2. Verify Cashier Name & Role badge are rendered on bottom-left
    const cashierContainer = page.getByTestId('status-bar-cashier');
    await expect(cashierContainer).toBeVisible();

    const cashierName = page.getByTestId('status-bar-cashier-name');
    await expect(cashierName).toBeVisible();
    await expect(cashierName).not.toBeEmpty();

    const roleBadge = page.getByTestId('status-bar-role-badge');
    await expect(roleBadge).toBeVisible();

    // 3. Verify desktop TitleBar does NOT render duplicate user name or role
    const titleBar = page.getByTestId('desktop-title-bar');
    if (await titleBar.count() > 0) {
      await expect(titleBar).toBeVisible();
      // Identity container in title bar must only have the business name
      const titleBarIdentity = titleBar.locator('.flo-title-bar__identity');
      await expect(titleBarIdentity).toBeVisible();
      // Must not contain UserCircle icon or role badge
      await expect(titleBarIdentity.locator('svg')).toHaveCount(0);
    }

    // 4. Verify developer 'Heap' and 'Port' numbers are absent from persistent frontline bar
    const statusBarText = await statusBar.innerText();
    expect(statusBarText).not.toMatch(/Heap:\s*\d+/i);
    expect(statusBarText).not.toMatch(/Port:\s*\d+/i);

    // 5. Verify Thermal Printer and Shift status pills
    const printerPill = page.getByTestId('status-bar-printer');
    await expect(printerPill).toBeVisible();

    const shiftPill = page.getByTestId('status-bar-shift');
    await expect(shiftPill).toBeVisible();
    await expect(shiftPill).toContainText('unknown');

    // 6. Capture screenshot of clean frontline bar
    await page.screenshot({ path: 'test-results/clean-frontline-status-bar.png' });

    // 7. Test Slide-Up Telemetry Drawer
    const drawerToggleBtn = page.getByTestId('btn-toggle-telemetry-drawer');
    await expect(drawerToggleBtn).toBeVisible();

    const drawer = page.getByTestId('telemetry-drawer');
    // Initially drawer is closed
    await expect(drawer).toHaveClass(/translate-y-full/);
    await expect(drawer).toHaveAttribute('aria-hidden', 'true');
    await expect(drawer).toHaveAttribute('inert', '');

    for (const testId of [
      'btn-close-telemetry-drawer',
      'btn-test-receipt-print',
      'btn-kick-cash-drawer',
    ]) {
      const canReceiveFocus = await page.getByTestId(testId).evaluate((element) => {
        (element as HTMLElement).focus();
        return document.activeElement === element;
      });
      expect(canReceiveFocus).toBe(false);
    }

    // Click to open drawer
    await drawerToggleBtn.click();
    await expect(drawer).toHaveClass(/translate-y-0/);
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');

    // Verify Hardware Actions
    const testPrintBtn = page.getByTestId('btn-test-receipt-print');
    await expect(testPrintBtn).toBeVisible();

    const kickDrawerBtn = page.getByTestId('btn-kick-cash-drawer');
    await expect(kickDrawerBtn).toBeVisible();

    // Verify Diagnostic Telemetry Metrics
    await expect(page.getByTestId('telemetry-uptime')).toBeVisible();
    await expect(page.getByTestId('telemetry-port')).toBeVisible();
    await expect(page.getByTestId('telemetry-memory')).toBeVisible();

    // 8. Capture screenshot of open telemetry drawer
    await page.screenshot({ path: 'test-results/open-telemetry-drawer.png' });

    // 9. Close drawer using close button
    const closeDrawerBtn = page.getByTestId('btn-close-telemetry-drawer');
    await closeDrawerBtn.click();
    await expect(drawer).toHaveClass(/translate-y-full/);
    await expect(drawerToggleBtn).toBeFocused();

    await drawerToggleBtn.click();
    await page.keyboard.press('Escape');
    await expect(drawerToggleBtn).toBeFocused();

    await drawerToggleBtn.click();
    await page.getByTestId('telemetry-drawer-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(drawerToggleBtn).toBeFocused();
  });
});
