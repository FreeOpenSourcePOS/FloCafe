import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { injectElectronFixture } from './helpers/electron-fixture';

test.describe('Clean Cashier Status Bar & Telemetry Drawer', () => {
  test('frontline status bar displays cashier identity, printer, shift, and drawer actions', async ({
    page,
    browser,
  }) => {
    let testPrintRequests = 0;
    let kickDrawerRequests = 0;
    let shiftRequestCount = 0;
    let releaseStaleShiftResponse: (() => Promise<void>) | undefined;

    // Inject Electron fixture so desktop capability and system telemetry are simulated
    await injectElectronFixture(page, { api: true, platform: 'darwin' });
    await page.route('**/api/printers', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          printers: [
            {
              id: 'disposable-e2e-printer',
              name: 'Disposable E2E Printer',
              connection_type: 'network',
              ip_address: '127.0.0.1',
              port: 9100,
              paper_width: 'cols-48',
              is_default: 1,
              cash_drawer_pulse_enabled: true,
            },
          ],
        }),
      }),
    );

    // Login as owner/cashier
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill('E2ePass123!');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/pos/, { timeout: 20000 });

    // 1. Verify persistent frontline status bar is rendered
    const statusBar = page.locator('footer').filter({
      has: page.getByTestId('status-bar-cashier'),
    });
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
    if ((await titleBar.count()) > 0) {
      await expect(titleBar).toBeVisible();
      // Identity container in title bar must only have the business name
      const titleBarIdentity = titleBar.locator('.flo-title-bar__identity');
      await expect(titleBarIdentity).toBeVisible();
      // Must not contain UserCircle icon or role badge
      await expect(titleBarIdentity.locator('svg')).toHaveCount(0);
      await expect(roleBadge).not.toBeEmpty();
      await expect(titleBarIdentity).not.toContainText(await cashierName.innerText());
      await expect(titleBarIdentity).not.toContainText(await roleBadge.innerText());
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
    await expect(shiftPill).toContainText('Open shift');
    await expect(page.getByTestId('btn-kick-cash-drawer')).toHaveCount(0);

    const closedShiftKick = await page.evaluate(async () => {
      const token = localStorage.getItem('token');
      if (!token) throw new Error('Authenticated test session is missing');
      const response = await fetch('/api/printers/kick-drawer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      return { status: response.status, error: body.error };
    });
    expect(closedShiftKick).toEqual({ status: 409, error: 'open_cash_shift_required' });

    await page.route('**/cash-sessions/current', async (route) => {
      shiftRequestCount += 1;
      if (shiftRequestCount === 1) {
        await new Promise<void>((resolve) => {
          releaseStaleShiftResponse = async () => {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ status: 'open' }),
            });
            resolve();
          };
        });
        return;
      }

      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Insufficient permissions' }),
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('flo-shift-changed')));
    await expect.poll(() => shiftRequestCount).toBeGreaterThanOrEqual(1);

    const deniedShiftResponse = page.waitForResponse(
      (response) => response.url().includes('/cash-sessions/current') && response.status() === 403,
    );
    await page.evaluate(() => window.dispatchEvent(new Event('flo-shift-changed')));
    await deniedShiftResponse;
    await expect(shiftPill).toContainText('unknown');

    await releaseStaleShiftResponse?.();
    await expect(shiftPill).toContainText('unknown');
    await page.unroute('**/cash-sessions/current');

    const kickDrawerBtn = page.getByTestId('btn-kick-cash-drawer');
    await expect(kickDrawerBtn).toHaveCount(0);

    await page.route('**/cash-sessions/current', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: 'open' }),
      }),
    );
    await page.route('**/api/printers/test-active', (route) => {
      testPrintRequests += 1;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });
    await page.route('**/api/printers/kick-drawer', (route) => {
      kickDrawerRequests += 1;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    });

    await page.reload();
    await expect(shiftPill).toContainText('Shift opened');
    await expect(page.getByTestId('status-bar-printer')).toHaveAttribute('title', /network/i);
    await expect(page.getByTestId('status-bar-printer')).toContainText('Disposable E2E Printer');
    await expect(kickDrawerBtn).toHaveCount(1);

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
    await expect(drawer).toHaveAttribute('aria-modal', 'true');

    // Verify Hardware Actions
    const closeDrawerBtn = page.getByTestId('btn-close-telemetry-drawer');
    await expect(closeDrawerBtn).toBeFocused();
    const testPrintBtn = page.getByTestId('btn-test-receipt-print');
    await expect(testPrintBtn).toBeVisible();

    await expect(kickDrawerBtn).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(kickDrawerBtn).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeDrawerBtn).toBeFocused();

    // Verify Diagnostic Telemetry Metrics
    await expect(page.getByTestId('telemetry-server-status')).toContainText('running');
    await expect(page.getByTestId('telemetry-uptime')).toBeVisible();
    await expect(page.getByTestId('telemetry-port')).toBeVisible();
    await expect(page.getByTestId('telemetry-memory')).toBeVisible();

    // 8. Capture screenshot of open telemetry drawer
    await drawer.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    await page.screenshot({ path: 'test-results/open-telemetry-drawer.png' });

    // 9. Drive both hardware actions through their API requests.
    await testPrintBtn.click();
    await expect(page.getByText('Test print sent!')).toBeVisible();
    await expect.poll(() => testPrintRequests).toBe(1);

    await kickDrawerBtn.click();
    await expect(page.getByText('Cash drawer pulse sent.')).toBeVisible();
    await expect.poll(() => kickDrawerRequests).toBe(1);

    const restrictedPage = await browser.newPage();
    await injectElectronFixture(restrictedPage, { api: true, platform: 'darwin' });
    await restrictedPage.goto(`${BASE}/auth/login`);
    await restrictedPage.locator('#email').fill('server@flo.local');
    await restrictedPage.locator('#password').fill('E2ePass123!');
    await restrictedPage.locator('button[type="submit"]').click();
    await restrictedPage.waitForURL(/\/orders/, { timeout: 20000 });
    await expect(restrictedPage.getByTestId('status-bar-shift')).toContainText(/unknown/i);
    await expect(restrictedPage.getByTestId('btn-kick-cash-drawer')).toHaveCount(0);

    const deniedKickStatus = await restrictedPage.evaluate(async () => {
      const token = localStorage.getItem('token');
      if (!token) throw new Error('Authenticated test session is missing');
      const response = await fetch('/api/printers/kick-drawer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      return response.status;
    });
    expect(deniedKickStatus).toBe(403);
    await restrictedPage.close();

    // 10. Close drawer using close button
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

  test.afterAll(async ({ request }) => {
    try {
      const loginRes = await request.post(`${BASE}/api/auth/login`, {
        data: { email: 'owner@flo.local', password: 'E2ePass123!' },
      });
      if (loginRes.ok()) {
        const { token } = await loginRes.json();
        const authHeaders = { Authorization: `Bearer ${token}` };

        const sessionRes = await request.get(`${BASE}/api/cash-sessions/current`, {
          headers: authHeaders,
        });
        if (sessionRes.ok()) {
          const session = await sessionRes.json();
          if (session?.id && session?.status === 'open') {
            await request.post(`${BASE}/api/cash-sessions/${session.id}/close`, {
              headers: authHeaders,
              data: { counted_cash_cents: 0 },
            });
          }
        }

        const printersRes = await request.get(`${BASE}/api/printers`, { headers: authHeaders });
        if (printersRes.ok()) {
          const { printers = [] } = await printersRes.json();
          for (const printer of printers) {
            if (
              (printer.name === 'Disposable E2E Printer' ||
                printer.name === 'Counter WebUSB Printer') &&
              !printer.is_default
            ) {
              await request.delete(`${BASE}/api/printers/${printer.id}`, { headers: authHeaders });
            }
          }
        }
      }
    } catch {
      // Graceful teardown
    }
  });
});
