import { test, expect, type Page } from '@playwright/test';
import * as path from 'node:path';
import { E2E_BASE_URL } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

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

  const passwordTab = page
    .getByRole('tab', { name: /password/i })
    .or(page.getByTestId('signin-mode-password'));
  if (await passwordTab.isVisible({ timeout: 2000 }).catch(() => false)) {
    await passwordTab.click();
  }

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
      const kdsPasswordTab = page.getByTestId('signin-mode-password');
      if (await kdsPasswordTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await kdsPasswordTab.click();
      }

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
});
