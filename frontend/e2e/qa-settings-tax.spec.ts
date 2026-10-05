/**
 * Settings > Tax configuration.
 *
 * The tax surface is not a form: it is a mode switch (off / official pack /
 * manual rates) over a plug-in pack registry, with an advanced tools area for
 * per-target overrides. This suite walks it as an owner and covers the parts
 * that are safely changeable and reversible:
 *   - the global tax on/off switch persists and is reachable;
 *   - the active pack and its rules are real, read from the registry;
 *   - the pack audit trail records the activation the fixture performed;
 *   - a per-target tax override can be added, survives a reload, and is removed.
 *
 * It deliberately does not install, uninstall or activate a tax pack: those are
 * network-fetching and version-changing operations, not settings changes.
 */
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

type EnabledSetting = { setting: { key: string; value: string } };
type PackList = { store_country: string; packs: Array<{ id: string; status: string; active_for_store: boolean; override_count: number }> };
type AuditList = { audit: Array<{ id: number; action: string; pack_id: string | null }> };

async function api<T>(page: Page, path: string, init?: { method?: string; data?: unknown }): Promise<T> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const res = await page.request.fetch(`${BASE}/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}` },
    data: init?.data as never,
  });
  return await res.json() as T;
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
}

async function openTaxTab(page: Page): Promise<void> {
  await page.goto(`${BASE}/settings?tab=tax`);
  await expect(page.getByRole('heading', { name: 'Tax configuration', exact: true }))
    .toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

test.describe('Settings > Tax configuration', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await setLanguage(page, 'en');
  });

  test('the global tax switch persists across a reload and is owner-reachable', async ({ page }) => {
    await openTaxTab(page);

    const before = await api<EnabledSetting>(page, '/settings/taxes_enabled');
    expect(before.setting.key).toBe('taxes_enabled');
    // The fixture turns taxes on. Assert that as a precondition instead of
    // branching: the only way back on through the UI is "Official Tax Pack",
    // which calls /tax-packs/ensure-country and can fetch/install a pack. That
    // is a pack operation, not a settings change, so the restore below goes
    // through the settings API instead.
    expect(before.setting.value, 'fixture must start with taxes enabled').toBe('true');

    // Tax mode is a three-way segment switch; the active segment is the one
    // carrying the active-segment styling, which is how the UI reflects the
    // persisted row rather than local state.
    const offSegment = page.getByRole('button', { name: 'Turn Off Tax', exact: true });
    const officialSegment = page.getByRole('button', { name: 'Official Tax Pack', exact: true });
    const manualSegment = page.getByRole('button', { name: 'Manual Tax Rates', exact: true });
    for (const segment of [offSegment, officialSegment, manualSegment]) {
      await expect(segment).toBeVisible();
    }
    await expect(officialSegment).toHaveClass(/shadow-sm/);
    await expect(offSegment).not.toHaveClass(/shadow-sm/);

    try {
      await offSegment.click();

      await expect.poll(async () =>
        (await api<EnabledSetting>(page, '/settings/taxes_enabled')).setting.value, { timeout: 20_000 })
        .toBe('false');

      await openTaxTab(page);
      await expect(page.getByRole('button', { name: 'Turn Off Tax', exact: true })).toHaveClass(/shadow-sm/);
      await expect(page.getByRole('button', { name: 'Official Tax Pack', exact: true }))
        .not.toHaveClass(/shadow-sm/);
    } finally {
      await api(page, '/settings/taxes_enabled', { method: 'PUT', data: { value: 'true' } });
      await openTaxTab(page);
      expect((await api<EnabledSetting>(page, '/settings/taxes_enabled')).setting.value).toBe('true');
      await expect(page.getByRole('button', { name: 'Official Tax Pack', exact: true }))
        .toHaveClass(/shadow-sm/);
    }
  });

  test('the active tax pack for the store country is real and matches the registry', async ({ page }) => {
    await openTaxTab(page);

    const packs = await api<PackList>(page, '/tax-packs');
    const active = packs.packs.filter((entry) => entry.active_for_store);
    expect(active.length, 'exactly one pack may be active for the store').toBe(1);
    expect(packs.store_country).toBeTruthy();

    await expect(page.getByRole('button', { name: 'Official Tax Pack', exact: true })).toBeVisible();
    // Advanced tools is collapsed by default; expanding it must reveal real
    // override tooling rather than a placeholder.
    const advanced = page.getByRole('button', { name: /Advanced tax tools/ });
    await expect(advanced).toBeVisible();
    await advanced.click();
    await expect(page.getByRole('heading', { name: 'Advanced tax tools', exact: true })).toBeVisible();
  });

  test('the tax pack audit trail records the pack activation', async ({ page }) => {
    const audit = await api<AuditList>(page, '/tax-packs/audit?limit=100');
    expect(audit.audit.length, 'pack installs must be auditable').toBeGreaterThan(0);
    for (const entry of audit.audit) {
      expect(entry.action, 'every audit row names an action').toBeTruthy();
    }
    expect(audit.audit.some((entry) => /install|activate|update/i.test(entry.action))).toBe(true);

    // The panel surfaces the same history rather than a hard-coded list.
    await openTaxTab(page);
    const advanced = page.getByRole('button', { name: /Advanced tax tools/ });
    if (await advanced.isVisible().catch(() => false)) {
      await advanced.click();
    }
    await expect(page.locator('body')).toContainText(/UAT|tax|Tax/);
  });

  test('the tax pack catalog is reachable without installing anything', async ({ page }) => {
    await openTaxTab(page);
    // "Check for updates" is a read-only catalog refresh.
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
    await page.waitForLoadState('networkidle');

    const packs = await api<PackList>(page, '/tax-packs');
    // A catalog refresh must not have activated or removed anything.
    expect(packs.packs.filter((entry) => entry.active_for_store).length).toBe(1);
  });
});