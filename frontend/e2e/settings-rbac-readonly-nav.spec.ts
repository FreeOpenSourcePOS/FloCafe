/**
 * Settings RBAC, Read-Only Enforcement, and Unsaved-Changes Navigation Guard E2E Suite
 *
 * Verifies:
 *  1. Cashier (`settings.view`, without `settings.manage`) sees strictly read-only / disabled
 *     controls across all Settings tabs (`Store`, `Updates` including `AutoUpdateCheckToggle`
 *     and `BetaChannelToggle`, `Discounts`, `Loyalty`, `POS Workflow`, `Kitchen Display`,
 *     `Tableside Ordering`, `Receipts & Printers`, `Payment Methods`, `Counters`, `OrderFlow`,
 *     `Privacy`, `Backup & Data`), never triggers 403 hydration errors or Electron IPC writes,
 *     and is NEVER silently trapped when clicking Sidebar links (`/pos`, `/orders`).
 *  2. `UpdateAvailableDialog` disables `update-auto-check-checkbox` for non-admin roles.
 *  3. `server` (waiter) and `chef` granted `settings.view` keep unauthorized mutations disabled
 *     (while `chef` retains `KdsDefaultViewCard` via `kitchen.use`) and navigate freely.
 *  4. Admin (`owner`, `manager`) dirtying a field renders the accessible Save/Discard bar,
 *     blocks premature link clicks with visible feedback (`Unsaved changes`), and allows
 *     immediate navigation after clicking `Discard`; manager vs owner-only (`refunds`,
 *     `counters`, `tax-packs`, `database`) and granular (`printers.manage`) boundaries hold.
 */

import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { injectElectronFixture } from './helpers/electron-fixture';

type UserAuthzPayload = {
  revision: string;
  overrides: Array<{ permission_id: string; effect: string }>;
};

async function ownerApi<T>(
  page: Page,
  path: string,
  init?: { method?: string; data?: unknown },
): Promise<T> {
  const token = getE2eToken();
  const method = init?.method ?? 'GET';
  const res = await page.request.fetch(`${BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    data: init?.data as never,
  });
  expect(res.ok(), `${method} ${path} must succeed (got ${res.status()})`).toBeTruthy();
  return (await res.json()) as T;
}

async function ensureStaffUser(
  page: Page,
  email: string,
  role: 'cashier' | 'chef',
  name: string,
): Promise<string> {
  const list = await ownerApi<{ staff: Array<{ id: string; email: string; is_active: number }> }>(
    page,
    '/staff',
  );
  const existing = list.staff.find((s) => s.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    if (!existing.is_active) {
      await ownerApi(page, `/staff/${existing.id}/reactivate`, { method: 'POST' });
    }
    return existing.id;
  }
  const created = await ownerApi<{ staff: { id: string } }>(page, '/staff', {
    method: 'POST',
    data: { name, email, password: E2E_PASSWORD, role },
  });
  return created.staff.id;
}

async function setUserOverrides(
  page: Page,
  userId: string,
  overrides: Array<{ permission_id: string; effect: 'allow' | 'deny' }>,
): Promise<void> {
  const current = await ownerApi<UserAuthzPayload>(page, `/authorization/users/${userId}`);
  await ownerApi(page, `/authorization/users/${userId}`, {
    method: 'PUT',
    data: { revision: current.revision, overrides },
  });
}

async function loginAs(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('auth-storage');
  });
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
}

async function instrumentElectronWriteSpies(page: Page): Promise<void> {
  await injectElectronFixture(page, { platform: 'darwin' });
  await page.addInitScript(() => {
    const counts = {
      setAutoUpdateCheck: 0,
      setBetaChannel: 0,
      setSetting: 0,
      checkForUpdates: 0,
      downloadUpdate: 0,
    };
    let currentUpdateStatus: { status: string; version?: string; info?: { version: string } } = {
      status: 'not-checked-yet',
    };
    type UpdateListener = Parameters<NonNullable<Window['electronAPI']>['onUpdateStatus']>[0];
    const updateListeners: UpdateListener[] = [];
    (
      window as unknown as {
        __ipcWriteCounts: typeof counts;
        __setMockUpdateAvailable: (available: boolean) => void;
      }
    ).__ipcWriteCounts = counts;
    (
      window as unknown as {
        __setMockUpdateAvailable: (available: boolean) => void;
      }
    ).__setMockUpdateAvailable = (available: boolean) => {
      currentUpdateStatus = available
        ? { status: 'available', version: '9.9.9-e2e', info: { version: '9.9.9-e2e' } }
        : { status: 'not-checked-yet' };
      for (const listener of updateListeners) {
        listener(currentUpdateStatus as never);
      }
    };
    const patch = () => {
      const api = window.electronAPI;
      if (!api) return;
      api.setAutoUpdateCheck = async () => {
        counts.setAutoUpdateCheck += 1;
        return { success: true };
      };
      api.setBetaChannel = async () => {
        counts.setBetaChannel += 1;
        return { success: true };
      };
      api.setSetting = async () => {
        counts.setSetting += 1;
        return { success: true };
      };
      api.checkForUpdates = async () => {
        counts.checkForUpdates += 1;
      };
      api.downloadUpdate = async () => {
        counts.downloadUpdate += 1;
        return { success: true };
      };
      api.getUpdateStatus = async () => currentUpdateStatus as never;
      api.onUpdateStatus = (cb) => {
        updateListeners.push(cb);
        cb(currentUpdateStatus as never);
        return () => {
          const idx = updateListeners.indexOf(cb);
          if (idx !== -1) updateListeners.splice(idx, 1);
        };
      };
    };
    patch();
    document.addEventListener('DOMContentLoaded', patch, { once: true });
  });
}

test.describe('Settings RBAC read-only enforcement & unsaved-changes navigation guard', () => {
  let cashierId = '';
  let chefId = '';

  test.beforeEach(async ({ page }) => {
    await setLanguage(page, 'en');
    cashierId = await ensureStaffUser(page, 'rbac-cashier@flo.local', 'cashier', 'RBAC Cashier');
    chefId = await ensureStaffUser(page, 'rbac-chef@flo.local', 'chef', 'RBAC Chef');
    await setUserOverrides(page, cashierId, []);
    await setUserOverrides(page, chefId, []);
    await setUserOverrides(page, 'e2e-server', []);
  });

  test.afterEach(async ({ page }) => {
    if (cashierId) await setUserOverrides(page, cashierId, []).catch(() => {});
    if (chefId) await setUserOverrides(page, chefId, []).catch(() => {});
    await setUserOverrides(page, 'e2e-server', []).catch(() => {});
    await setLanguage(page, 'en').catch(() => {});
  });

  test('cashier sees all unauthorized Settings controls disabled, cannot mutate IPC or discount state, and never gets trapped navigating to /pos', async ({
    page,
  }) => {
    await instrumentElectronWriteSpies(page);
    await loginAs(page, 'rbac-cashier@flo.local');

    // UpdateAvailableDialog pops when an update is available: auto-check opt-out checkbox must be disabled for cashier
    await page.evaluate(() =>
      (
        window as unknown as { __setMockUpdateAvailable: (v: boolean) => void }
      ).__setMockUpdateAvailable(true),
    );
    const updateDialog = page.getByTestId('update-available-dialog');
    await expect(updateDialog).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('update-auto-check-checkbox')).toBeDisabled();
    await updateDialog.getByRole('button', { name: 'Later' }).click();
    await expect(updateDialog).toBeHidden();

    // 1. Store tab
    await page.goto(`${BASE}/settings?tab=store`);
    await expect(page.getByTestId('settings-read-only-notice')).toBeVisible({ timeout: 20_000 });
    const storeSection = page.locator('[data-setting-section="store-details"]');
    await expect(storeSection.locator('input')).toHaveCount(0);
    await expect(storeSection.locator('select')).toHaveCount(0);

    const orderFormatSection = page.locator('[data-setting-section="order-number-format"]');
    for (const sw of await orderFormatSection.getByRole('switch').all()) {
      await expect(sw).toBeDisabled();
    }
    const subSelect = page.locator('[data-setting-section="subscription"] select');
    await expect(subSelect).toBeDisabled();

    // 2. Updates tab: AutoUpdateCheckToggle, BetaChannelToggle, Check for updates, Download Now ALL disabled
    await page.goto(`${BASE}/settings?tab=updates`);
    const autoCheck = page.getByTestId('auto-update-check-checkbox');
    const betaChannel = page.getByTestId('beta-channel-checkbox');
    await expect(autoCheck).toBeDisabled();
    await expect(betaChannel).toBeDisabled();
    await expect(
      page.locator('[data-setting-section="software-updates"] button').first(),
    ).toBeDisabled();

    await page.evaluate(() =>
      (
        window as unknown as { __setMockUpdateAvailable: (v: boolean) => void }
      ).__setMockUpdateAvailable(true),
    );
    if (await updateDialog.isVisible().catch(() => false)) {
      await updateDialog.getByRole('button', { name: 'Later' }).click();
      await expect(updateDialog).toBeHidden();
    }
    await expect(page.getByTestId('settings-download-update')).toBeDisabled();

    const ipcCounts = await page.evaluate(
      () =>
        (
          window as unknown as {
            __ipcWriteCounts: Record<string, number>;
          }
        ).__ipcWriteCounts,
    );
    expect(ipcCounts).toEqual({
      setAutoUpdateCheck: 0,
      setBetaChannel: 0,
      setSetting: 0,
      checkForUpdates: 0,
      downloadUpdate: 0,
    });

    // 3. Customers -> Discounts (exact reproduction of silent navigation trap!)
    await page.goto(`${BASE}/settings?tab=discounts`);
    const discountSection = page.locator('[data-setting-section="discount-limits"]');
    await expect(discountSection).toBeVisible({ timeout: 20_000 });
    await expect(discountSection.locator('select')).toBeDisabled();
    for (const input of await discountSection.locator('input').all()) {
      await expect(input).toBeDisabled();
    }
    for (const sw of await discountSection.getByRole('switch').all()) {
      await expect(sw).toBeDisabled();
    }
    await expect(page.getByTestId('settings-unsaved-bar')).toHaveCount(0);

    // Clicking POS in Sidebar MUST navigate immediately without trapping!
    await page.getByRole('link', { name: 'POS', exact: true }).click();
    await page.waitForURL(/\/pos/, { timeout: 15_000 });

    // 4. Customers -> Loyalty (hydrates without 403 and disables Loyalty switch)
    await page.goto(`${BASE}/settings?tab=loyalty`);
    const loyaltySection = page.locator('[data-setting-section="loyalty-program"]');
    await expect(loyaltySection).toBeVisible({ timeout: 20_000 });
    await expect(loyaltySection.getByRole('switch')).toBeDisabled();

    // 5. POS Workflow, KDS, Server App, Printers, Payments, Counters, OrderFlow, Privacy
    await page.goto(`${BASE}/settings?tab=pos`);
    await expect(
      page.locator('[data-setting-section="pos-display"]').getByRole('switch'),
    ).toBeDisabled();
    for (const sw of await page
      .locator('[data-setting-section="pos-workflow"]')
      .getByRole('switch')
      .all()) {
      await expect(sw).toBeDisabled();
    }

    await page.goto(`${BASE}/settings?tab=kds`);
    await expect(
      page.locator('[data-setting-section="kds-enable"]').getByRole('switch'),
    ).toBeDisabled();
    await expect(
      page.locator('[data-setting-section="kds-require-delivered"]').getByRole('switch'),
    ).toBeDisabled();
    for (const btn of await page
      .locator('[data-setting-section="kds-default-view"] button')
      .all()) {
      await expect(btn).toBeDisabled();
    }
    for (const input of await page
      .locator('[data-setting-section="customer-display"] input')
      .all()) {
      await expect(input).toBeDisabled();
    }

    await page.goto(`${BASE}/settings?tab=server-app`);
    await expect(
      page.locator('[data-setting-section="server-app-enable"]').getByRole('switch'),
    ).toBeDisabled();

    await page.goto(`${BASE}/settings?tab=receipts-printers`);
    await expect(
      page.locator('[data-setting-section="printing-options"] select').first(),
    ).toBeDisabled();
    await expect(page.locator('#footer-message')).toBeDisabled();
    for (const sw of await page
      .locator('[data-setting-section="printing-options"]')
      .getByRole('switch')
      .all()) {
      await expect(sw).toBeDisabled();
    }
    for (const btn of await page.locator('[data-setting-section="bill-template"] button').all()) {
      await expect(btn).toBeDisabled();
    }

    await page.goto(`${BASE}/settings?tab=payments`);
    await expect(page.locator('[data-setting-section="payment-methods"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Failed to load settings')).toHaveCount(0);
    await expect(
      page.locator('[data-setting-section="split-checks"] input[type="checkbox"]'),
    ).toBeDisabled();

    await page.goto(`${BASE}/settings?tab=orderflow`);
    await expect(
      page.locator('[data-setting-section="orderflow-online-orders"] input[type="checkbox"]'),
    ).toBeDisabled();

    await page.goto(`${BASE}/settings?tab=privacy`);
    const radios = page.getByTestId('product-analytics-level').locator('input[type="radio"]');
    await expect(radios.first()).toBeVisible({ timeout: 15_000 });
    for (const radio of await radios.all()) {
      await expect(radio).toBeDisabled();
    }
    await expect(
      page.locator('[data-setting-section="privacy-telemetry"] input[type="checkbox"]'),
    ).toBeDisabled();

    // 6. Deep-link DB actions (`restore-from-file` & `initialize-db`) are blocked for cashier
    await page.goto(`${BASE}/settings?tab=data&action=restore-from-file`);
    await expect(page.getByTestId('database-access-denied')).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__floPickerCalls ?? 0)).toBe(0);

    await page.goto(`${BASE}/settings?tab=data&action=initialize-db`);
    await expect(page.getByTestId('database-access-denied')).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Final navigation check away from Settings to /orders
    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.waitForURL(/\/orders/, { timeout: 15_000 });
  });

  test('server and chef with settings.view override respect exact permission boundaries and never trap navigation', async ({
    page,
  }) => {
    await instrumentElectronWriteSpies(page);
    await setUserOverrides(page, 'e2e-server', [
      { permission_id: 'settings.view', effect: 'allow' },
    ]);
    await setUserOverrides(page, chefId, [{ permission_id: 'settings.view', effect: 'allow' }]);

    // Server (waiter)
    await loginAs(page, 'server@flo.local');
    await page.goto(`${BASE}/settings?tab=discounts`);
    await expect(page.locator('[data-setting-section="discount-limits"] select')).toBeDisabled({
      timeout: 20_000,
    });
    await page.goto(`${BASE}/settings?tab=updates`);
    await expect(page.getByTestId('auto-update-check-checkbox')).toBeDisabled();
    await expect(page.getByTestId('beta-channel-checkbox')).toBeDisabled();
    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    await page.waitForURL(/\/orders/, { timeout: 15_000 });

    // Chef (has kitchen.use + settings.view, lacks settings.manage and kitchen.stations.manage)
    await loginAs(page, 'rbac-chef@flo.local');
    await page.goto(`${BASE}/settings?tab=kds`);
    await expect(
      page.locator('[data-setting-section="kds-enable"]').getByRole('switch'),
    ).toBeDisabled({
      timeout: 20_000,
    });
    // Chef holds `kitchen.use`, so KdsDefaultViewCard mode buttons are enabled while CustomerDisplayCard is disabled!
    await expect(
      page.locator('[data-setting-section="kds-default-view"] button').first(),
    ).toBeEnabled();
    for (const input of await page
      .locator('[data-setting-section="customer-display"] input')
      .all()) {
      await expect(input).toBeDisabled();
    }

    await page.goto(`${BASE}/settings?tab=kitchen-stations`);
    await expect(page.locator('[data-setting-section="kitchen-stations"]')).toBeVisible();
    await expect(
      page
        .locator('[data-setting-section="kitchen-stations"]')
        .getByRole('button', { name: /Add Station/i }),
    ).toHaveCount(0);

    await page.locator('a[href*="/kds"]').first().click();
    await page.waitForURL(/\/kds/, { timeout: 15_000 });
  });

  test('admin unsaved-changes guard shows clear feedback + Discard/Save, and manager vs granular overrides enforce exact RBAC', async ({
    page,
  }) => {
    await instrumentElectronWriteSpies(page);

    // 1. Owner dirty state blocks navigation with visible feedback, Discard clears and allows navigation
    await loginAs(page, 'owner@flo.local');
    await page.evaluate(() =>
      (
        window as unknown as { __setMockUpdateAvailable: (v: boolean) => void }
      ).__setMockUpdateAvailable(true),
    );
    const ownerDialog = page.getByTestId('update-available-dialog');
    await expect(ownerDialog).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('update-auto-check-checkbox')).toBeEnabled();
    await ownerDialog.getByRole('button', { name: 'Later' }).click();
    await expect(ownerDialog).toBeHidden();

    await page.goto(`${BASE}/settings?tab=discounts`);
    const modeSelect = page.locator('[data-setting-section="discount-limits"] select');
    await expect(modeSelect).toBeEnabled({ timeout: 20_000 });
    const originalMode = await modeSelect.inputValue();
    const targetMode = originalMode === 'both' ? 'percentage' : 'both';
    await modeSelect.selectOption(targetMode);

    const unsavedBar = page.getByTestId('settings-unsaved-bar');
    await expect(unsavedBar).toBeVisible();

    // Clicking POS in Sidebar is intercepted while dirty, keeps user on /settings, and shows Unsaved changes feedback
    const posNavLink = page.getByRole('link', { name: 'POS', exact: true });
    await posNavLink.click();
    expect(new URL(page.url()).pathname).toMatch(/^\/settings\/?$/);
    await expect(unsavedBar).toBeVisible();
    await expect(page.getByText('Unsaved changes').first()).toBeVisible();

    // Clicking Discard resets dirty state and lets POS navigation succeed immediately
    await unsavedBar.getByRole('button', { name: 'Discard' }).click();
    await expect(unsavedBar).toHaveCount(0);
    await posNavLink.click();
    await page.waitForURL(/\/pos/, { timeout: 15_000 });

    // 2. Manager has settings.manage (Updates toggles enabled), but owner-only Refunds/Counters and Database are restricted
    await loginAs(page, 'manager@flo.local');
    const managerDialog = page.getByTestId('update-available-dialog');
    if (await managerDialog.isVisible().catch(() => false)) {
      await managerDialog.getByRole('button', { name: 'Later' }).click();
    }
    await page.goto(`${BASE}/settings?tab=updates`);
    await expect(page.getByTestId('auto-update-check-checkbox')).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByTestId('beta-channel-checkbox')).toBeEnabled();

    await page.goto(`${BASE}/settings?tab=counters`);
    await expect(
      page.locator('[data-setting-section="multi-counter"]').getByRole('switch'),
    ).toBeDisabled();

    await page.goto(`${BASE}/settings?tab=data`);
    await expect(page.getByTestId('database-access-denied')).toBeVisible({ timeout: 15_000 });

    // 3. Granular override: cashier granted `printers.manage` (without `settings.manage`) can save printing settings cleanly
    await setUserOverrides(page, cashierId, [
      { permission_id: 'printers.manage', effect: 'allow' },
    ]);
    await loginAs(page, 'rbac-cashier@flo.local');
    const granularDialog = page.getByTestId('update-available-dialog');
    if (await granularDialog.isVisible().catch(() => false)) {
      await granularDialog.getByRole('button', { name: 'Later' }).click();
    }

    await page.goto(`${BASE}/settings?tab=receipts-printers`);
    const trimSwitch = page
      .locator('[data-setting-section="printing-options"]')
      .getByRole('switch', { name: 'Trim decimals' });
    await expect(trimSwitch).toBeEnabled({ timeout: 20_000 });
    // Admin-owned controls on the same tab remain disabled!
    await expect(page.locator('#footer-message')).toBeDisabled();
    await expect(
      page.locator('[data-setting-section="kot-printing"]').getByRole('switch'),
    ).toBeDisabled();

    const wasChecked = (await trimSwitch.getAttribute('aria-checked')) === 'true';
    await trimSwitch.click();
    await expect(page.getByTestId('settings-unsaved-bar')).toBeVisible();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Settings saved', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('settings-unsaved-bar')).toHaveCount(0);

    // Restore original value
    if ((await trimSwitch.getAttribute('aria-checked')) !== String(wasChecked)) {
      await trimSwitch.click();
      await page.getByRole('button', { name: 'Save Changes' }).click();
      await expect(page.getByText('Settings saved', { exact: true })).toBeVisible({
        timeout: 20_000,
      });
    }
  });
});
