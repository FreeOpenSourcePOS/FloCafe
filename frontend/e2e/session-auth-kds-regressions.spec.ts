import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import * as path from 'node:path';
import { E2E_BASE_URL, E2E_KDS_BASE_URL, E2E_SERVER_APP_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

function ownerHeaders() {
  return {
    Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
  };
}

async function createDisposableStaff(
  request: APIRequestContext,
  data: { name: string; email: string; password: string; role: string; pin?: string },
): Promise<string> {
  const res = await request.post(`${E2E_BASE_URL}/api/staff`, {
    headers: ownerHeaders(),
    data,
  });
  expect(res.status(), `Failed to create staff ${data.email}`).toBe(201);
  return (await res.json()).staff.id as string;
}

async function cleanupDisposableStaff(request: APIRequestContext, staffId: string): Promise<void> {
  try {
    await request.put(`${E2E_BASE_URL}/api/staff/${staffId}`, {
      headers: ownerHeaders(),
      data: { pin: null },
    });
  } catch {}
  try {
    await request.post(`${E2E_BASE_URL}/api/staff/${staffId}/deactivate`, {
      headers: ownerHeaders(),
    });
  } catch {}
}

async function ensurePasswordTabSelected(page: Page) {
  const passwordTab = page.getByTestId('signin-mode-password');
  try {
    await passwordTab.waitFor({ state: 'visible', timeout: 3000 });
    await passwordTab.click();
  } catch {
    // Password form is already active when no PIN users are configured.
  }
}

async function loginViaUi(
  page: Page,
  email: string,
  password = E2E_PASSWORD,
  baseUrl = E2E_BASE_URL,
) {
  await page.goto(`${baseUrl}/auth/login`);
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }
    }
  });
  await page.goto(`${baseUrl}/auth/login`);

  await ensurePasswordTabSelected(page);

  const emailInput = page.locator('#email').or(page.locator('input[type="email"]'));
  await expect(emailInput).toBeVisible({ timeout: 15_000 });
  await emailInput.fill(email);

  const passwordInput = page.locator('#password').or(page.locator('input[type="password"]'));
  await passwordInput.fill(password);

  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 30_000 });
}

test.describe.serial('Session, Authentication & KDS Identity Regressions', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.route('**/sw.js', (route) => route.abort());
    await setLanguage(page, 'en');
  });

  test('delayed password change response cannot restore session after logout', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    let markIntercepted: () => void = () => {};
    let releaseGate: () => void = () => {};
    const interceptedPromise = new Promise<void>((resolve) => {
      markIntercepted = resolve;
    });
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    try {
      // 1. Log into POS as manager
      await loginViaUi(page, 'manager@flo.local', E2E_PASSWORD);

      // 2. Set up route interception to pause the password change response in-flight
      await page.route('**/api/auth/password/change', async (route) => {
        markIntercepted();
        await gatePromise;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Password changed successfully',
            token: 'mock-delayed-token-12345',
          }),
        });
      });

      // 3. Open AccountCredentialsDialog from sidebar user menu
      const userMenuButton = page
        .locator('[data-sidebar="footer"] [data-sidebar="menu-button"]')
        .last()
        .or(page.locator('button:has(svg.lucide-user-circle)'));
      await expect(userMenuButton).toBeVisible({ timeout: 10_000 });
      await userMenuButton.click();

      const changeCredentialsButton = page.getByTestId('sidebar-change-credentials-button');
      await expect(changeCredentialsButton).toBeVisible({ timeout: 5_000 });
      await changeCredentialsButton.click();

      const credentialsDialog = page.getByTestId('account-credentials-dialog');
      await expect(credentialsDialog).toBeVisible({ timeout: 5_000 });

      // 4. Fill password change form and submit
      await page.getByTestId('self-current-password').fill(E2E_PASSWORD);
      await page.getByTestId('self-new-password').fill(E2E_PASSWORD);
      await page.getByTestId('self-confirm-password').fill(E2E_PASSWORD);
      await page.getByTestId('self-password-submit').click();

      // 5. Await interception confirmation: request is held in-flight
      await interceptedPromise;

      // 6. Dismiss dialog via Escape key
      await page.keyboard.press('Escape');
      await expect(credentialsDialog).toBeHidden({ timeout: 5_000 });

      // 7. Perform UI logout
      await userMenuButton.click();
      await page.getByRole('menuitem', { name: /log\s*out/i }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /confirm|log\s*out/i })
        .click();
      await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15_000 });

      // 8. Fulfill the delayed password change response after logout
      releaseGate();
      await page.waitForTimeout(500);

      // 9. Assert session was not restored
      const token = await page.evaluate(() => localStorage.getItem('token'));
      const user = await page.evaluate(() => localStorage.getItem('user'));
      expect(token).toBeNull();
      expect(user).toBeNull();
      await expect(page).toHaveURL(/\/auth\/login/);

      // 10. Attempt navigation to protected route and assert redirect
      await page.goto(`${E2E_BASE_URL}/pos`);
      await expect(page).toHaveURL(/\/auth\/login/, { timeout: 15_000 });
      const tokenAfterRedirect = await page.evaluate(() => localStorage.getItem('token'));
      expect(tokenAfterRedirect).toBeNull();

      expect(pageErrors).toHaveLength(0);
    } finally {
      releaseGate();
      await page.unroute('**/api/auth/password/change').catch(() => {});
    }
  });

  test('Server App committed password change delayed past logout does not restore session on reload', async ({
    page,
    request,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    const waiterEmail = `sa-late-logout-${Date.now()}@flo.local`;
    const staffId = await createDisposableStaff(request, {
      name: 'Delayed SA Waiter',
      email: waiterEmail,
      password: E2E_PASSWORD,
      role: 'server',
    });

    let markCommitted: () => void = () => {};
    let releaseGate: () => void = () => {};
    const committedPromise = new Promise<void>((resolve) => {
      markCommitted = resolve;
    });
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    try {
      await page.goto(`${E2E_SERVER_APP_BASE_URL}/server-standalone`);
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'en' } }));
      });
      await page.reload();

      await ensurePasswordTabSelected(page);
      await page.locator('input[type="email"]').fill(waiterEmail);
      await page.locator('input[type="password"]').fill(E2E_PASSWORD);
      await page.locator('form button').last().click();

      const credButton = page.getByTestId('server-app-change-credentials-button');
      await expect(credButton).toBeVisible({ timeout: 15_000 });

      // Let backend commit the real password change, then delay delivering the 200 response
      await page.route('**/api/auth/password/change', async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        markCommitted();
        await gatePromise;
        await route.fulfill({ response });
      });

      await credButton.click();
      const dialog = page.getByTestId('account-credentials-dialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      const newPassword = 'UpdatedWaiterPass9!';
      await page.getByTestId('self-current-password').fill(E2E_PASSWORD);
      await page.getByTestId('self-new-password').fill(newPassword);
      await page.getByTestId('self-confirm-password').fill(newPassword);
      await page.getByTestId('self-password-submit').click();

      await committedPromise;

      // Dismiss dialog and log out of Server App before the committed response arrives
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });

      await page.getByRole('button', { name: /log\s*out/i }).click();
      await expect(
        page.locator('input[type="email"]').or(page.getByTestId('signin-mode-password')),
      ).toBeVisible({
        timeout: 15_000,
      });

      releaseGate();
      await page.waitForTimeout(500);

      const tokenAfterResponse = await page.evaluate(() =>
        localStorage.getItem('flocafe:server-app-token'),
      );
      expect(tokenAfterResponse).toBeNull();

      // Reloading must NOT reopen the signed-out Server App account
      await page.reload();
      await expect(
        page.locator('input[type="email"]').or(page.getByTestId('signin-mode-password')),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(credButton).toHaveCount(0);
      expect(
        await page.evaluate(() => localStorage.getItem('flocafe:server-app-token')),
      ).toBeNull();

      expect(pageErrors).toHaveLength(0);
    } finally {
      releaseGate();
      await page.unroute('**/api/auth/password/change').catch(() => {});
      await cleanupDisposableStaff(request, staffId);
    }
  });

  test('KDS standalone committed password change delayed past logout does not restore session on reload', async ({
    page,
    request,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    const chefEmail = `kds-late-logout-${Date.now()}@flo.local`;
    const staffId = await createDisposableStaff(request, {
      name: 'Delayed KDS Chef',
      email: chefEmail,
      password: E2E_PASSWORD,
      role: 'chef',
    });

    let markCommitted: () => void = () => {};
    let releaseGate: () => void = () => {};
    const committedPromise = new Promise<void>((resolve) => {
      markCommitted = resolve;
    });
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    try {
      await page.goto(`${E2E_KDS_BASE_URL}/kds-standalone`);
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'en' } }));
      });
      await page.reload();

      await ensurePasswordTabSelected(page);
      await page.getByTestId('kds-login-email').fill(chefEmail);
      await page.getByTestId('kds-login-password').fill(E2E_PASSWORD);
      await page.getByTestId('kds-login-submit').click();
      await expect(page.getByTestId('kds-workspace')).toBeVisible({ timeout: 15_000 });

      await page.route('**/api/auth/password/change', async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        markCommitted();
        await gatePromise;
        await route.fulfill({ response });
      });

      await page.getByTestId('kds-change-credentials-button').click();
      const dialog = page.getByTestId('account-credentials-dialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      const newPassword = 'UpdatedChefPass9!';
      await page.getByTestId('self-current-password').fill(E2E_PASSWORD);
      await page.getByTestId('self-new-password').fill(newPassword);
      await page.getByTestId('self-confirm-password').fill(newPassword);
      await page.getByTestId('self-password-submit').click();

      await committedPromise;

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden({ timeout: 5_000 });

      await page.locator('button[title="Logout"]').click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /confirm|log\s*out/i })
        .click();
      await expect(
        page.getByTestId('kds-login-form').or(page.getByTestId('signin-mode-password')),
      ).toBeVisible({
        timeout: 15_000,
      });

      releaseGate();
      await page.waitForTimeout(500);

      expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();

      await page.reload();
      await expect(page.getByTestId('kds-workspace')).toHaveCount(0);
      await expect(
        page.getByTestId('kds-login-form').or(page.getByTestId('signin-mode-password')),
      ).toBeVisible({
        timeout: 15_000,
      });
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();

      expect(pageErrors).toHaveLength(0);
    } finally {
      releaseGate();
      await page.unroute('**/api/auth/password/change').catch(() => {});
      await cleanupDisposableStaff(request, staffId);
    }
  });

  test('account switching after KDS access denial synchronously updates identity, status bar, and POS sidebar', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    const kdsHtmlPath = path.resolve(__dirname, '../out/kds/index.html');
    const kdsNavPattern = /\/kds(?:\/|$|\?)/;
    await page.route(kdsNavPattern, async (route) => {
      if (route.request().isNavigationRequest()) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          path: kdsHtmlPath,
        });
      } else {
        await route.continue();
      }
    });

    try {
      // 1. Clean session state and log in as server@flo.local
      await loginViaUi(page, 'server@flo.local', E2E_PASSWORD);

      // 2. Assert initial server state: sidebar footer, status bar cashier, and role badge
      const sidebarFooter = page.locator('[data-sidebar="footer"]');
      await expect(sidebarFooter).toContainText('E2E server');
      await expect(page.getByTestId('status-bar-cashier-name')).toHaveText('E2E server');
      await expect(page.getByTestId('status-bar-role-badge')).toHaveText('Server');

      // Manager-only nav links are absent for server
      await expect(page.locator('a[href^="/staff"]')).toHaveCount(0);
      await expect(page.locator('a[href^="/pos"]')).toHaveCount(0);

      // 3. Navigate to /kds and verify access denial
      await page.goto(`${E2E_BASE_URL}/kds`);

      // If PIN quick switch mode is shown, switch to password tab
      await ensurePasswordTabSelected(page);

      // Verify KDS login form appears with access denial error
      const kdsLoginForm = page.getByTestId('kds-login-form');
      await expect(kdsLoginForm).toBeVisible({ timeout: 15_000 });
      await expect(kdsLoginForm.locator('[role="alert"]')).toContainText(
        /kitchen|authentication failed/i,
      );

      // Verify sidebar and status bar STILL display server identity while access denial is visible
      await expect(sidebarFooter).toContainText('E2E server');
      await expect(page.getByTestId('status-bar-cashier-name')).toHaveText('E2E server');
      await expect(page.locator('a[href^="/staff"]')).toHaveCount(0);

      // 4. Sign in as manager@flo.local on the embedded KDS login form
      await page.getByTestId('kds-login-email').fill('manager@flo.local');
      await page.getByTestId('kds-login-password').fill(E2E_PASSWORD);
      await page.getByTestId('kds-login-submit').click();

      // 5. Assert synchronous update without page reload
      // KDS workspace mounts and login form unmounts
      await expect(page.getByTestId('kds-workspace')).toBeVisible({ timeout: 15_000 });
      await expect(kdsLoginForm).toHaveCount(0);

      // POS sidebar footer updates to manager
      await expect(sidebarFooter).toContainText('E2E manager');

      // Status bar updates to manager cashier and badge
      await expect(page.getByTestId('status-bar-cashier-name')).toHaveText('E2E manager');
      await expect(page.getByTestId('status-bar-role-badge')).toHaveText('Manager');

      // Manager-level navigation items become visible in sidebar
      await expect(page.locator('a[href^="/staff"]')).toBeVisible();
      await expect(page.locator('a[href^="/pos"]').first()).toBeVisible();
      await expect(page.locator('a[href^="/products"]')).toBeVisible();

      // Storage reflects manager session
      const storedUser = await page.evaluate(() => localStorage.getItem('user'));
      expect(JSON.parse(storedUser || '{}').email).toBe('manager@flo.local');

      expect(pageErrors).toHaveLength(0);
    } finally {
      await page.unroute(kdsNavPattern).catch(() => {});
    }
  });

  test('PIN account switching after KDS access denial synchronously updates identity, status bar, and POS sidebar', async ({
    page,
    request,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    const pinManagerEmail = `pin-kds-mgr-${Date.now()}@flo.local`;
    const pinManagerId = await createDisposableStaff(request, {
      name: 'PIN KDS Manager',
      email: pinManagerEmail,
      password: E2E_PASSWORD,
      role: 'manager',
      pin: '2468',
    });

    const kdsHtmlPath = path.resolve(__dirname, '../out/kds/index.html');
    const kdsNavPattern = /\/kds(?:\/|$|\?)/;
    await page.route(kdsNavPattern, async (route) => {
      if (route.request().isNavigationRequest()) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          path: kdsHtmlPath,
        });
      } else {
        await route.continue();
      }
    });

    try {
      await loginViaUi(page, 'server@flo.local', E2E_PASSWORD);

      const sidebarFooter = page.locator('[data-sidebar="footer"]');
      await expect(sidebarFooter).toContainText('E2E server');
      await expect(page.locator('a[href^="/staff"]')).toHaveCount(0);

      await page.goto(`${E2E_BASE_URL}/kds`);
      const pinPicker = page.getByTestId('pin-user-picker');
      await expect(pinPicker).toBeVisible({ timeout: 15_000 });

      const managerTile = page.getByTestId(`pin-user-tile-${pinManagerId}`);
      await expect(managerTile).toBeVisible({ timeout: 10_000 });
      await managerTile.click();

      await page.getByTestId('pin-login-input').fill('2468');
      await page.getByTestId('pin-login-submit').click();

      await expect(page.getByTestId('kds-workspace')).toBeVisible({ timeout: 15_000 });
      await expect(sidebarFooter).toContainText('PIN KDS Manager');
      await expect(page.getByTestId('status-bar-cashier-name')).toHaveText('PIN KDS Manager');
      await expect(page.getByTestId('status-bar-role-badge')).toHaveText('Manager');
      await expect(page.locator('a[href^="/staff"]')).toBeVisible();
      await expect(page.locator('a[href^="/pos"]').first()).toBeVisible();

      const storedUser = await page.evaluate(() => localStorage.getItem('user'));
      expect(JSON.parse(storedUser || '{}').email).toBe(pinManagerEmail);

      expect(pageErrors).toHaveLength(0);
    } finally {
      await page.unroute(kdsNavPattern).catch(() => {});
      await cleanupDisposableStaff(request, pinManagerId);
    }
  });

  test('dashboard KDS reload preserves token when shared session hydration hits transient 503', async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    const kdsHtmlPath = path.resolve(__dirname, '../out/kds/index.html');
    const kdsNavPattern = /\/kds(?:\/|$|\?)/;
    await page.route(kdsNavPattern, async (route) => {
      if (route.request().isNavigationRequest()) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          path: kdsHtmlPath,
        });
      } else {
        await route.continue();
      }
    });

    let failedOnce = false;
    await page.route('**/api/auth/me', async (route) => {
      if (!failedOnce) {
        failedOnce = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Service temporarily unavailable' }),
        });
        return;
      }
      await route.continue();
    });

    try {
      await loginViaUi(page, 'manager@flo.local', E2E_PASSWORD);
      const tokenBefore = await page.evaluate(() => localStorage.getItem('token'));
      expect(tokenBefore).toBeTruthy();

      await page.goto(`${E2E_BASE_URL}/kds`);
      await expect(page.getByTestId('kds-workspace')).toBeVisible({ timeout: 15_000 });
      expect(failedOnce).toBe(true);

      const tokenAfter = await page.evaluate(() => localStorage.getItem('token'));
      expect(tokenAfter).toBe(tokenBefore);
      await expect(page.locator('[data-sidebar="footer"]')).toContainText('E2E manager');

      expect(pageErrors).toHaveLength(0);
    } finally {
      await page.unroute('**/api/auth/me').catch(() => {});
      await page.unroute(kdsNavPattern).catch(() => {});
    }
  });
});
