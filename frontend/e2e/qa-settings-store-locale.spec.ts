/**
 * Settings > Store Details: locale, language, currency and store fields.
 *
 * Every case follows the same shape the captain asked for: change the value
 * through the real UI, save the way the UI saves, reload, then confirm the value
 * came back. Nothing asserts a hard-coded "should" value — each case reads the
 * current value first and asserts it moved, then restores the original.
 *
 * Two things this suite deliberately does NOT rely on:
 *   - English copy. The store tab carries the UI-language selector, so one case
 *     renders the entire app in another language. Every readiness check here is
 *     structural, and each case pins the language to English in beforeEach via
 *     the shared setLanguage helper.
 *   - Order. The store tab is stateful (one server, one database), so every case
 *     restores everything it changed.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

/** Reads a raw settings row from the API, independent of the UI's own fetch. */
async function readSetting(page: Page, key: string): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const res = await page.request.get(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok(), `GET /api/settings must succeed (got ${res.status()})`).toBeTruthy();
  const { settings } = await res.json() as { settings: Record<string, string> };
  return settings[key] ?? '';
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
}

/**
 * Language-independent readiness. Copy assertions live in the cases that need
 * them; this only waits for the tab to have actually finished hydrating.
 */
async function openStoreTab(page: Page): Promise<void> {
  await page.goto(`${BASE}/settings?tab=store`);
  // The store tab's first control is the country select; the settings nav has
  // no selects, so this is the tab content and not the shell.
  await expect(page.locator('select').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

/**
 * Store Details renders most labels as bare <label> siblings with no htmlFor, so
 * getByLabel cannot see them. Reach the control the label actually describes.
 */
function fieldAfterLabel(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true }).first()
    .locator('xpath=following-sibling::*[self::input or self::select or self::textarea][1]');
}

/** The floating save bar only exists once something is dirty. */
const saveChanges = (page: Page) => page.getByRole('button', { name: 'Save Changes' });

async function saveAndReloadStoreTab(page: Page): Promise<void> {
  await saveChanges(page).click();
  await expect(page.getByText('Settings saved', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openStoreTab(page);
}

test.describe('@ci-tier2 Settings > Store Details', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await setLanguage(page, 'en');
  });

  test('business name, business day start, billing type and table requirement persist across a reload', async ({ page }) => {
    await openStoreTab(page);
    await expect(page.getByRole('heading', { name: 'Store Details', exact: true })).toBeVisible();

    const nameField = fieldAfterLabel(page, 'Business Name');
    const dayStart = page.getByLabel('Business day start time');
    const billing = fieldAfterLabel(page, 'Billing Type');
    const tables = fieldAfterLabel(page, 'Tables Required');

    const originalName = await nameField.inputValue();
    const originalDayStart = await dayStart.inputValue();
    const originalBilling = await billing.inputValue();
    const originalTables = await tables.inputValue();

    const stamp = `UAT store ${Date.now()}`;
    // Pick a target that differs from whatever the fixture seeded, so the
    // assertion proves a write happened rather than matching a default.
    const nextDayStart = originalDayStart === '04:30' ? '05:30' : '04:30';
    const nextBilling = originalBilling === 'postpaid' ? 'prepaid' : 'postpaid';
    const nextTables = originalTables === 'yes' ? 'no' : 'yes';

    try {
      await nameField.fill(stamp);
      await dayStart.selectOption(nextDayStart);
      await billing.selectOption(nextBilling);
      await tables.selectOption(nextTables);

      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadStoreTab(page);

      await expect(fieldAfterLabel(page, 'Business Name')).toHaveValue(stamp);
      await expect(page.getByLabel('Business day start time')).toHaveValue(nextDayStart);
      await expect(fieldAfterLabel(page, 'Billing Type')).toHaveValue(nextBilling);
      await expect(fieldAfterLabel(page, 'Tables Required')).toHaveValue(nextTables);

      // Cross-check the API so a passing UI assertion cannot be explained by a
      // value that never left the browser.
      expect(await readSetting(page, 'business_name')).toBe(stamp);
      expect(await readSetting(page, 'business_day_start_time')).toBe(nextDayStart);
      expect(await readSetting(page, 'billing_type')).toBe(nextBilling);
      expect(await readSetting(page, 'tables_required')).toBe(nextTables === 'yes' ? 'true' : 'false');
    } finally {
      await openStoreTab(page);
      await fieldAfterLabel(page, 'Business Name').fill(originalName);
      await page.getByLabel('Business day start time').selectOption(originalDayStart);
      await fieldAfterLabel(page, 'Billing Type').selectOption(originalBilling);
      await fieldAfterLabel(page, 'Tables Required').selectOption(originalTables);
      if (await saveChanges(page).isVisible().catch(() => false)) {
        await saveAndReloadStoreTab(page);
      }
      expect(await readSetting(page, 'business_name')).toBe(originalName);
      expect(await readSetting(page, 'business_day_start_time')).toBe(originalDayStart);
      expect(await readSetting(page, 'billing_type')).toBe(originalBilling);
    }
  });

  test('the language selector persists on change, without the Save Changes bar', async ({ page }) => {
    await openStoreTab(page);

    const original = await readSetting(page, 'language');
    const next = original === 'es' ? 'fr' : 'es';

    // The language selector is the one store field that writes on change, so
    // the dirty save bar must not be what persists it. Assert that rather than
    // assuming it.
    const languageSelect = page.getByText('Languages', { exact: true }).first()
      .locator('xpath=following-sibling::select[1]');
    await expect(languageSelect).toBeVisible();
    await expect(saveChanges(page)).toHaveCount(0);

    try {
      await languageSelect.selectOption(next);
      await expect.poll(async () => readSetting(page, 'language'), { timeout: 20_000 }).toBe(next);

      // Reload and confirm the whole app rehydrates the persisted language.
      // Assert <html lang>, not the selector's value: after the switch the app
      // renders in the new language, so the English label this suite used to
      // reach the select no longer exists. <html lang> is synced by
      // HtmlLangSync from the active locale, so it proves the persisted row took
      // effect app-wide rather than just re-rendering one control.
      await openStoreTab(page);
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.lang), { timeout: 20_000 })
        .toBe(next);
    } finally {
      // Restore through the shared helper so the UI store and the backend row
      // cannot drift apart, whichever assertion above failed.
      await setLanguage(page, original);
      expect(await readSetting(page, 'language')).toBe(original);
    }
  });

  test('changing the store currency is refused inline and routed to the currency reset dialog', async ({ page }) => {
    await openStoreTab(page);

    const originalCurrency = await readSetting(page, 'currency');
    // exact: getByLabel is substring-based by default, and the currency reset
    // dialog's accessible name also contains "Currency".
    const currency = page.getByLabel('Currency', { exact: true });
    await expect(currency).toHaveValue(originalCurrency);

    const nextCurrency = originalCurrency === 'USD' ? 'EUR' : 'USD';
    await currency.selectOption(nextCurrency).catch(() => {
      // A typed/virtualised picker may reject selectOption; the dialog is the
      // assertion target either way.
    });

    // Store settings refuse the change outright (409
    // currency_change_requires_reset) and hand the operator to the currency
    // reset dialog instead.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText(`CHANGE TO ${nextCurrency}`);
    // The destructive button stays disabled until the phrase is typed.
    await expect(dialog.getByRole('button', { name: new RegExp(nextCurrency) })).toBeDisabled();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Currency', { exact: true })).toHaveValue(originalCurrency);
    expect(await readSetting(page, 'currency')).toBe(originalCurrency);

    await openStoreTab(page);
    await expect(page.getByLabel('Currency', { exact: true })).toHaveValue(originalCurrency);
  });

  test('the store tab exposes the sections the settings tree advertises', async ({ page }) => {
    await openStoreTab(page);

    for (const heading of ['Store Details', 'Number Formats', 'Subscription']) {
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    await expect(page.getByText('Order numbers', { exact: true })).toBeVisible();
    await expect(page.getByText('Invoice numbers', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Country', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Timezone', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Currency', { exact: true })).toBeVisible();
  });
});