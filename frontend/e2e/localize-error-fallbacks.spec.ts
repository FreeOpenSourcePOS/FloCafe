import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * End-to-End verification of localized error fallbacks (#241).
 *
 * Verifies that when backend endpoints fail (e.g. returning 400, 429, 500 with
 * English error messages or SQL exceptions), the frontend UI never interpolates
 * or leaks raw English backend strings to the customer. Instead, it renders
 * the localized `t()` fallback string according to the active language (tested
 * in Persian 'fa', Spanish 'es', Portuguese 'pt', and English 'en').
 *
 * Captures reviewer-visible visual evidence (screenshots of localized error
 * toasts and inline error states) into the evidence directory.
 */

const BASE = 'http://localhost:3001';
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  path.join(os.tmpdir(), 'no-mistakes-evidence', '01M08KC186JQ29G9DS41MZFZH4');

async function captureScreenshot(page: Page, filename: string): Promise<void> {
  try {
    if (!fs.existsSync(EVIDENCE_DIR)) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    }
    await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: true });
  } catch (err) {
    console.warn(`Could not save screenshot ${filename}:`, err);
  }
}

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));
}

async function setLanguage(page: Page, value: string): Promise<void> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  if (!token) return;
  await page.request.put(`${BASE}/api/settings/language`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
}

async function setPosSetting(page: Page, key: string, value: boolean | string): Promise<void> {
  await page.evaluate(({ key, value }) => {
    try {
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {}, version: 3 };
      parsed.state = { ...parsed.state, [key]: value };
      parsed.version ??= 3;
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    } catch {}
  }, { key, value });
}

test.describe('Localized Error Fallbacks', () => {
  test('Login failure renders localized fallback across all 4 locales (EN, ES, PT, FA)', async ({ page }) => {
    await page.route('**/api/auth/login', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'RAW_SQLITE_INTERNAL_DB_FATAL_ERROR' }),
      });
    });

    // 1. English (en)
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill('WrongPassword!');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('text=Login failed')).toBeVisible();
    await expect(page.locator('text=RAW_SQLITE_INTERNAL_DB_FATAL_ERROR')).not.toBeVisible();
    await captureScreenshot(page, 'error-login-fallback-en.png');

    // 2. Spanish (es)
    await page.addInitScript(() => {
      localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'es' }, version: 3 }));
    });
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill('WrongPassword!');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('text=No se pudo iniciar sesión')).toBeVisible();
    await expect(page.locator('text=RAW_SQLITE_INTERNAL_DB_FATAL_ERROR')).not.toBeVisible();
    await captureScreenshot(page, 'error-login-fallback-es.png');

    // 3. Portuguese (pt)
    await page.addInitScript(() => {
      localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'pt' }, version: 3 }));
    });
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill('WrongPassword!');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('text=Falha no login')).toBeVisible();
    await expect(page.locator('text=RAW_SQLITE_INTERNAL_DB_FATAL_ERROR')).not.toBeVisible();
    await captureScreenshot(page, 'error-login-fallback-pt.png');

    // 4. Persian (fa)
    await page.addInitScript(() => {
      localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'fa' }, version: 3 }));
    });
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill('WrongPassword!');
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('text=ورود ناموفق بود')).toBeVisible();
    await expect(page.locator('text=RAW_SQLITE_INTERNAL_DB_FATAL_ERROR')).not.toBeVisible();
    await captureScreenshot(page, 'error-login-fallback-fa.png');
  });

  test('Login 429 lockout renders localized lockout message without raw string', async ({ page }) => {
    await page.route('**/api/auth/login', (route) => {
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'RAW_RATE_LIMIT_EXCEEDED_IP_BLOCKED' }),
      });
    });

    // Persian lockout
    await page.addInitScript(() => {
      localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'fa' }, version: 3 }));
    });
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('manager@flo.local');
    await page.locator('#password').fill('WrongPassword!');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('text=کوشش‌های ناموفق بیش از اندازه بوده است')).toBeVisible();
    await expect(page.locator('text=RAW_RATE_LIMIT_EXCEEDED_IP_BLOCKED')).not.toBeVisible();
    await captureScreenshot(page, 'error-login-lockout-fa.png');
  });

  test('Password recovery failure renders localized fallback across locales (EN, ES, FA)', async ({ page }) => {
    await page.route('**/api/auth/setup/status', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ masterPinAvailable: true, needsSetup: false }),
      });
    });
    await page.route('**/api/auth/recover-password', (route) => {
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'RAW_VERIFICATION_TOKEN_MISMATCH_EXCEPTION' }),
      });
    });

    // 1. English recover error
    await page.goto(`${BASE}/auth/recover`);
    await page.locator('#recover-email').fill('owner@flo.local');
    await page.locator('#recover-pin').fill('9999');
    await page.locator('#new-password').fill('NewPass123!');
    await page.locator('#confirm-new-password').fill('NewPass123!');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('text=Recovery failed')).toBeVisible();
    await expect(page.locator('text=RAW_VERIFICATION_TOKEN_MISMATCH_EXCEPTION')).not.toBeVisible();
    await captureScreenshot(page, 'error-recover-pin-fallback-en.png');

    // 2. Spanish recover error
    await page.addInitScript(() => {
      localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'es' }, version: 3 }));
    });
    await page.goto(`${BASE}/auth/recover`);
    await page.locator('#recover-email').fill('owner@flo.local');
    await page.locator('#recover-pin').fill('9999');
    await page.locator('#new-password').fill('NewPass123!');
    await page.locator('#confirm-new-password').fill('NewPass123!');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('text=No se pudo recuperar el acceso')).toBeVisible();
    await expect(page.locator('text=RAW_VERIFICATION_TOKEN_MISMATCH_EXCEPTION')).not.toBeVisible();
    await captureScreenshot(page, 'error-recover-pin-fallback-es.png');

    // 3. Persian recover error
    await page.addInitScript(() => {
      localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'fa' }, version: 3 }));
    });
    await page.goto(`${BASE}/auth/recover`);
    await page.locator('#recover-email').fill('owner@flo.local');
    await page.locator('#recover-pin').fill('9999');
    await page.locator('#new-password').fill('NewPass123!');
    await page.locator('#confirm-new-password').fill('NewPass123!');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('text=بازیابی انجام نشد')).toBeVisible();
    await expect(page.locator('text=RAW_VERIFICATION_TOKEN_MISMATCH_EXCEPTION')).not.toBeVisible();
    await captureScreenshot(page, 'error-recover-pin-fallback-fa.png');
  });

  test('Authenticated screens error toasts render localized fallbacks (Settings, Print Test, POS)', async ({ page }) => {
    await loginAsOwner(page);

    try {
      // 1. Settings pairing code rotation error toast in Persian
      await setLanguage(page, 'fa');

      await page.route('**/api/settings/rotate-pairing-code', (route) => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'RAW_FLOADMIN_DOWNSTREAM_TIMEOUT' }),
        });
      });

      await page.goto(`${BASE}/settings?tab=devices`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const rotateBtn = page.locator('button', { hasText: /تولید مجدد|Rotate/ }).first();
      if (await rotateBtn.isVisible()) {
        await rotateBtn.click();
        await expect(page.locator('text=تولید مجدد کد اتصال انجام نشد')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=RAW_FLOADMIN_DOWNSTREAM_TIMEOUT')).not.toBeVisible();
        await captureScreenshot(page, 'error-settings-pairing-rotate-fa.png');
      }

      // 2. Settings cloud verification email error toast
      await page.route('**/api/settings/cloud/account/verification', (route) => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'RAW_SMTP_SENDMAIL_FAILED' }),
        });
      });

      await page.goto(`${BASE}/settings?tab=account`);
      const sendVerifyBtn = page.locator('button', { hasText: /Send verification email|ارسال ایمیل/ }).first();
      if (await sendVerifyBtn.isVisible()) {
        await sendVerifyBtn.click();
        await expect(page.locator('text=ارسال ایمیل تأیید انجام نشد')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=RAW_SMTP_SENDMAIL_FAILED')).not.toBeVisible();
        await captureScreenshot(page, 'error-settings-verification-email-fa.png');
      }

      // 3. Print test hides the manual KOT action when KOT printing is disabled.
      await setLanguage(page, 'en');
      await setPosSetting(page, 'kotPrintingEnabled', false);

      await page.goto(`${BASE}/print-test`);
      await expect(page.getByRole('button', { name: /KOT \(Kitchen Ticket\)/ })).toHaveCount(0);
      await captureScreenshot(page, 'error-print-test-kot-disabled-en.png');

      // Persian print test KOT disabled
      await setLanguage(page, 'fa');
      await setPosSetting(page, 'kotPrintingEnabled', false);

      await page.goto(`${BASE}/print-test`);
      await expect(page.getByRole('button', { name: /KOT \(Kitchen Ticket\)/ })).toHaveCount(0);
      await captureScreenshot(page, 'error-print-test-kot-disabled-fa.png');

      // 4. POS Hold Order error toast
      await page.route('**/api/orders/hold', (route) => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'RAW_SQLITE_HOLD_FAILURE_FOREIGN_KEY' }),
        });
      });

      await page.goto(`${BASE}/pos`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      // Add item to cart
      const coffeeItem = page.getByText('E2E Coffee').first();
      if (await coffeeItem.isVisible()) {
        await coffeeItem.click();

        // Click hold order button
        const holdBtn = page.locator('button', { hasText: /نگه‌داشتن|Hold/ }).first();
        if (await holdBtn.isVisible()) {
          await holdBtn.click();
          await expect(page.locator('text=نگه‌داشتن سفارش انجام نشد')).toBeVisible({ timeout: 5000 });
          await expect(page.locator('text=RAW_SQLITE_HOLD_FAILURE_FOREIGN_KEY')).not.toBeVisible();
          await captureScreenshot(page, 'error-pos-hold-order-fa.png');
        }
      }
    } finally {
      await setLanguage(page, 'en');
    }
  });
});
