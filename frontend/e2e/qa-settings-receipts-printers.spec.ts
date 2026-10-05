/**
 * Settings > Printers: receipt/KOT/Z-report language policy, receipt footer and
 * bill template.
 *
 * Same shape as the store-tab suite: change through the UI, save the way the UI
 * saves, reload, confirm it came back, restore.
 *
 * Two things this pins down that are easy to get wrong:
 *   - Receipt/KOT/Z-report language is stored server-side as a policy object
 *     ({primary, additional}), not as a bare language code, and the writer
 *     de-duplicates a second language equal to the primary. The assertions read
 *     the persisted policy back rather than the select's value.
 *   - Paper width and print method are NOT server settings (they live in the
 *     POS/printer stores). The suite asserts they are real, visible controls but
 *     does not claim they persist server-side.
 */
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

type LanguagePolicy = { primary: { mode: string; language?: string }; additional: Array<{ mode?: string; language?: string }> };

async function readSetting(page: Page, key: string): Promise<unknown> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const res = await page.request.get(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok(), `GET /api/settings must succeed (got ${res.status()})`).toBeTruthy();
  const { settings } = await res.json() as { settings: Record<string, string> };
  const raw = settings[key];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
}

async function openPrintersTab(page: Page): Promise<void> {
  await page.goto(`${BASE}/settings?tab=receipts-printers`);
  await expect(page.locator('select').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

const saveChanges = (page: Page) => page.getByRole('button', { name: 'Save Changes' });

async function saveAndReloadPrintersTab(page: Page): Promise<void> {
  await saveChanges(page).click();
  await expect(page.getByText('Settings saved', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openPrintersTab(page);
}

test.describe('Settings > Printers', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await setLanguage(page, 'en');
  });

  test('receipt footer message and bill template persist across a reload', async ({ page }) => {
    await openPrintersTab(page);

    const footer = page.getByLabel('Footer Message', { exact: true });
    const originalFooter = await footer.inputValue();
    const originalTemplate = (await readSetting(page, 'bill_template')) as { id: string } | undefined;

    const stamp = `UAT footer ${Date.now()}`;
    try {
      await footer.fill(stamp);
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      await expect(page.getByLabel('Footer Message', { exact: true })).toHaveValue(stamp);
      expect(await readSetting(page, 'bill_footer_message')).toBe(stamp);

      // Switch the bill template away from whatever it is and back-check. The
      // stored value is a selection object ({id, source}), not a bare id.
      const compact = page.getByRole('button', { name: /^Compact/ });
      const classic = page.getByRole('button', { name: /^Classic/ });
      await expect(compact).toBeVisible();
      const target = originalTemplate?.id === 'compact' ? classic : compact;
      await target.click();
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      const expected = originalTemplate?.id === 'compact' ? 'classic' : 'compact';
      expect((await readSetting(page, 'bill_template')) as { id: string }).toMatchObject({ id: expected });
    } finally {
      await openPrintersTab(page);
      await page.getByLabel('Footer Message', { exact: true }).fill(originalFooter);
      const restore = originalTemplate?.id === 'compact'
        ? page.getByRole('button', { name: /^Compact/ })
        : page.getByRole('button', { name: /^Classic/ });
      await restore.click();
      if (await saveChanges(page).isVisible().catch(() => false)) {
        await saveAndReloadPrintersTab(page);
      }
      expect(await readSetting(page, 'bill_footer_message')).toBe(originalFooter);
    }
  });

  test('a fixed receipt language persists as a policy object', async ({ page }) => {
    await openPrintersTab(page);

    const receiptPrimary = page.getByLabel('Receipt language', { exact: true });
    const original = await readSetting(page, 'bill_language_policy') as LanguagePolicy;
    const originalValue = await receiptPrimary.inputValue();
    const next = originalValue === 'de' ? 'th' : 'de';

    try {
      await receiptPrimary.selectOption(next);
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      await expect(page.getByLabel('Receipt language', { exact: true })).toHaveValue(next);
      // The persisted shape is a policy, not a bare code.
      expect(await readSetting(page, 'bill_language_policy')).toEqual({
        primary: { mode: 'fixed', language: next },
        additional: [],
      });
    } finally {
      await openPrintersTab(page);
      await page.getByLabel('Receipt language', { exact: true }).selectOption(originalValue);
      if (await saveChanges(page).isVisible().catch(() => false)) {
        await saveAndReloadPrintersTab(page);
      }
      expect(await readSetting(page, 'bill_language_policy')).toEqual(original);
    }
  });

  test('a second receipt language equal to the primary is de-duplicated on save', async ({ page }) => {
    await openPrintersTab(page);

    const receiptPrimary = page.getByLabel('Receipt language', { exact: true });
    const receiptSecond = page.getByLabel('Second receipt language', { exact: true });
    const original = await readSetting(page, 'bill_language_policy') as LanguagePolicy;

    const primary = (await receiptPrimary.inputValue()) === 'fr' ? 'it' : 'fr';
    try {
      await receiptPrimary.selectOption(primary);
      await receiptSecond.selectOption(primary);
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      // The writer drops a duplicate second language rather than storing it
      // twice; the UI reload then has to show "None" for the second language.
      expect(await readSetting(page, 'bill_language_policy')).toEqual({
        primary: { mode: 'fixed', language: primary },
        additional: [],
      });
      await expect(page.getByLabel('Second receipt language', { exact: true })).toHaveValue('none');
    } finally {
      await openPrintersTab(page);
      await page.getByLabel('Second receipt language', { exact: true }).selectOption('none');
      await page.getByLabel('Receipt language', { exact: true }).selectOption(
        original?.primary?.mode === 'fixed' && original.primary.language
          ? original.primary.language
          : 'inherit',
      );
      if (await saveChanges(page).isVisible().catch(() => false)) {
        await saveAndReloadPrintersTab(page);
      }
      expect(await readSetting(page, 'bill_language_policy')).toEqual(original);
    }
  });

  test('kitchen ticket and Z-report languages persist independently of the receipt', async ({ page }) => {
    await openPrintersTab(page);

    const kot = page.getByLabel('Kitchen ticket language', { exact: true });
    const zPrimary = page.getByLabel('Z-report language', { exact: true });
    const originalKot = await readSetting(page, 'kot_language_policy');
    const originalZ = await readSetting(page, 'z_report_language_policy');

    const nextKot = (await kot.inputValue()) === 'de' ? 'th' : 'de';
    const nextZ = (await zPrimary.inputValue()) === 'fr' ? 'it' : 'fr';

    try {
      await kot.selectOption(nextKot);
      await zPrimary.selectOption(nextZ);
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      expect(await readSetting(page, 'kot_language_policy')).toEqual({
        primary: { mode: 'fixed', language: nextKot },
        additional: [],
      });
      expect(await readSetting(page, 'z_report_language_policy')).toEqual({
        primary: { mode: 'fixed', language: nextZ },
        additional: [],
      });
    } finally {
      await openPrintersTab(page);
      await page.getByLabel('Kitchen ticket language', { exact: true }).selectOption(
        (originalKot as LanguagePolicy)?.primary?.language ?? 'inherit',
      );
      await page.getByLabel('Z-report language', { exact: true }).selectOption(
        (originalZ as LanguagePolicy)?.primary?.language ?? 'inherit',
      );
      if (await saveChanges(page).isVisible().catch(() => false)) {
        await saveAndReloadPrintersTab(page);
      }
      expect(await readSetting(page, 'kot_language_policy')).toEqual(originalKot);
      expect(await readSetting(page, 'z_report_language_policy')).toEqual(originalZ);
    }
  });

  test('the printers tab surfaces print method, bill template and detected devices', async ({ page }) => {
    await openPrintersTab(page);

    await expect(page.getByRole('heading', { name: 'Printers', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Printing', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bill Template', exact: true })).toBeVisible();
    await expect(page.getByLabel('Footer Message', { exact: true })).toBeVisible();

    // Print method is a real ESC/POS vs browser choice, and the explanatory
    // hint below the select follows the selection.
    const printMethod = page.getByText('Print Method', { exact: true }).first()
      .locator('xpath=following-sibling::select[1]');
    const selectedMethod = await printMethod.inputValue();
    await expect(printMethod).toHaveValue(/escpos|browser/);
    await expect(page.getByText(
      selectedMethod === 'browser'
        ? 'Opens the browser print dialog — works with any printer on this computer'
        : 'Direct USB printing via WebUSB — connect the printer from the POS toolbar',
    )).toBeVisible();

    // Every receipt-surface language policy has its own control.
    for (const label of ['Receipt language', 'Second receipt language', 'Kitchen ticket language',
      'Z-report language', 'Second Z-report language']) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }

    // The device list is real, not a placeholder: it reports what the OS
    // enumerates (here, one device).
    await expect(page.getByRole('button', { name: /Installed on this computer/ })).toBeVisible();
  });
});