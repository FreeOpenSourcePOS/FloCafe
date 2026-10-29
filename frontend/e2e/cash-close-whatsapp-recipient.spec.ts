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
  const settingsCanContinue = new Promise<void>((resolve) => {
    releaseSettings = resolve;
  });
  const settingsStarted = new Promise<void>((resolve) => {
    markSettingsStarted = resolve;
  });
  const settingsFulfilled = new Promise<void>((resolve) => {
    markSettingsFulfilled = resolve;
  });
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
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(recipient).toHaveValue('+14165559876');
});

test('daily-sales WhatsApp send distinguishes confirmed transport delivery from manual-share fallback', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));

  await page.goto(`${BASE}/dashboard`);
  await expect(page.getByRole('button', { name: 'Export sales' })).toBeVisible();

  await page.evaluate(() => {
    const win = window as unknown as {
      __openedPopups?: Array<{ href: string; closed: boolean }>;
      open: typeof window.open;
    };
    win.__openedPopups = [];
    win.open = (() => {
      const record = { href: '', closed: false };
      win.__openedPopups!.push(record);
      return {
        opener: {} as unknown,
        location: {
          get href() {
            return record.href;
          },
          set href(val: string) {
            record.href = val;
          },
        },
        get closed() {
          return record.closed;
        },
        close() {
          record.closed = true;
        },
      } as unknown as Window;
    }) as typeof window.open;
  });

  const sentBodies: Array<Record<string, unknown>> = [];
  let routeMode: 'sent' | 'submitted' | 'fallback' = 'sent';
  await page.route('**/api/reports/daily-sales/whatsapp', async (route) => {
    const reqBody = route.request().postDataJSON() as Record<string, unknown>;
    sentBodies.push(reqBody);
    if (routeMode === 'sent') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          deliveryStatus: 'sent',
          messageId: 101,
          body: '*FloCafe*\nDaily Sales Report\n*Net Collections: ฿250.00*',
        }),
      });
      return;
    }
    if (routeMode === 'submitted') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          deliveryStatus: 'submitted',
          messageId: 102,
          body: '*FloCafe*\nDaily Sales Report\n*Net Collections: ฿250.00*',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        fallback: true,
        reason: 'not_connected',
        body: '*FloCafe*\nDaily Sales Report\n*Net Collections: ฿250.00*',
      }),
    });
  });

  // 1. Confirmed transport send closes modal + pre-opened popup and shows confirmed toast
  await page.getByRole('button', { name: 'Export sales' }).click();
  await page.getByRole('menuitem', { name: 'Send to WhatsApp' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const recipient = dialog.getByLabel('Recipient Phone Number');
  await recipient.fill('+66812345678');
  await dialog.getByRole('button', { name: 'Send to WhatsApp' }).click();

  await expect(page.getByText('Report sent to WhatsApp successfully')).toBeVisible();
  await expect(dialog).toBeHidden();
  expect(sentBodies.length).toBe(1);
  expect(sentBodies[0].phone_e164).toBe('+66812345678');
  expect(typeof sentBodies[0].date).toBe('string');

  const popupsAfterConfirmed = await page.evaluate(
    () =>
      (window as unknown as { __openedPopups: Array<{ href: string; closed: boolean }> })
        .__openedPopups,
  );
  expect(popupsAfterConfirmed).toEqual([{ href: '', closed: true }]);

  // 2. Unacknowledged socket submission closes pre-opened popup and shows pending-confirmation toast
  routeMode = 'submitted';
  await page.getByRole('button', { name: 'Export sales' }).click();
  await page.getByRole('menuitem', { name: 'Send to WhatsApp' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Recipient Phone Number').fill('+66812345678');
  await dialog.getByRole('button', { name: 'Send to WhatsApp' }).click();

  await expect(
    page.getByText('Report submitted to WhatsApp; awaiting delivery confirmation'),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  const popupsAfterSubmitted = await page.evaluate(
    () =>
      (window as unknown as { __openedPopups: Array<{ href: string; closed: boolean }> })
        .__openedPopups,
  );
  expect(popupsAfterSubmitted).toEqual([
    { href: '', closed: true },
    { href: '', closed: true },
  ]);

  // 3. Disconnected fallback opens manual wa.me share window and shows manual-share toast
  routeMode = 'fallback';
  await page.getByRole('button', { name: 'Export sales' }).click();
  await page.getByRole('menuitem', { name: 'Send to WhatsApp' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Recipient Phone Number').fill('+66812345678');
  await dialog.getByRole('button', { name: 'Send to WhatsApp' }).click();

  await expect(page.getByText('Opening WhatsApp with report...')).toBeVisible();
  await expect(dialog).toBeHidden();
  const popupsAfterFallback = await page.evaluate(
    () =>
      (window as unknown as { __openedPopups: Array<{ href: string; closed: boolean }> })
        .__openedPopups,
  );
  expect(popupsAfterFallback.length).toBe(3);
  expect(popupsAfterFallback[2].closed).toBe(false);
  expect(popupsAfterFallback[2].href).toContain('https://wa.me/66812345678?text=');
});

test('Z-on-day-close rule starts disabled without business-phone inference and saves normalized E.164 recipient', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();

  const authHeaders = { Authorization: `Bearer ${token}` };
  const origPhoneRes = await page.request.get(`${BASE}/api/settings/business_phone`, {
    headers: authHeaders,
  });
  const origPhone = origPhoneRes.ok()
    ? String((await origPhoneRes.json())?.setting?.value ?? '')
    : '';
  const origAutoRes = await page.request.get(`${BASE}/api/whatsapp/automation`, {
    headers: authHeaders,
  });
  expect(origAutoRes.ok()).toBeTruthy();
  const origAutoConfig = (await origAutoRes.json()).config;

  try {
    // Configure a store business_phone to verify z_report_day_close NEVER infers its recipient from it.
    const setBizPhone = await page.request.put(`${BASE}/api/settings/business_phone`, {
      headers: authHeaders,
      data: { value: '+66899990000' },
    });
    expect(setBizPhone.ok()).toBeTruthy();

    await page.goto(`${BASE}/whatsapp`);
    await page.getByRole('tab', { name: 'Templates & Rules' }).click();

    const recipientInput = page.locator('#wa-rule-recipient-z_report_day_close');
    await expect(recipientInput).toBeVisible();
    await expect(recipientInput).toHaveValue('');

    const ruleCheckbox = page
      .locator('label')
      .filter({ hasText: 'Z-Report on day close' })
      .locator('input[type="checkbox"]');
    await expect(ruleCheckbox).not.toBeChecked();

    // Enabling without recipient shows validation error from backend
    await ruleCheckbox.check();
    await page.getByRole('button', { name: 'Save automation settings' }).first().click();
    await expect(ruleCheckbox).toBeChecked();

    // Entering local phone normalizes and persists E.164 recipient
    await recipientInput.fill('081 234 5678');
    await page.getByRole('button', { name: 'Save automation settings' }).first().click();
    await expect(page.getByText('Automation settings saved.')).toBeVisible();
    await expect(recipientInput).toHaveValue('+66812345678');

    const savedRes = await page.request.get(`${BASE}/api/whatsapp/automation`, {
      headers: authHeaders,
    });
    expect(savedRes.ok()).toBeTruthy();
    const savedRule = (await savedRes.json()).config.rules.find(
      (r: { trigger: string }) => r.trigger === 'z_report_day_close',
    );
    expect(savedRule).toMatchObject({
      trigger: 'z_report_day_close',
      enabled: true,
      recipientPhone: '+66812345678',
    });
  } finally {
    await page.request.put(`${BASE}/api/settings/business_phone`, {
      headers: authHeaders,
      data: { value: origPhone },
    });
    await page.request.put(`${BASE}/api/whatsapp/automation`, {
      headers: authHeaders,
      data: origAutoConfig,
    });
  }
});
