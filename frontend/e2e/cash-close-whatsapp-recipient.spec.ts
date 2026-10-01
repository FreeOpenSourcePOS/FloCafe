import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD } from './helpers/test-auth';

test('editing the WhatsApp recipient survives delayed business settings', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));

  await page.goto(`${BASE}/dashboard?action=cash-close&view=x-report`);
  await expect(page.getByRole('dialog').first()).toBeVisible();

  let releaseSettings!: () => void;
  let markSettingsStarted!: () => void;
  let markSettingsFulfilled!: () => void;
  let holdSettings = false;
  let delayedSettingsRequests = 0;
  const settingsCanContinue = new Promise<void>((resolve) => { releaseSettings = resolve; });
  const settingsStarted = new Promise<void>((resolve) => { markSettingsStarted = resolve; });
  const settingsFulfilled = new Promise<void>((resolve) => { markSettingsFulfilled = resolve; });
  await page.route('**/api/settings*', async (route) => {
    if (!holdSettings) return route.continue();
    delayedSettingsRequests += 1;
    markSettingsStarted();
    await settingsCanContinue;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ settings: { business_phone: '+14165551234' } }),
    });
    markSettingsFulfilled();
  });

  await page.getByRole('button', { name: 'Export sales' }).click();
  holdSettings = true;
  await page.getByRole('menuitem', { name: 'Send to WhatsApp' }).click();
  const recipient = page.getByLabel('Recipient Phone Number');
  await expect(recipient).toBeVisible();
  await settingsStarted;
  await recipient.fill('+14165559876');
  releaseSettings();
  expect(delayedSettingsRequests).toBe(1);
  await settingsFulfilled;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(recipient).toHaveValue('+14165559876');
});
