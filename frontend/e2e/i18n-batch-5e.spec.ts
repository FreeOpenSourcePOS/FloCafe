import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:3001';

async function captureScreenshot(page: Page, filename: string): Promise<void> {
  // Playwright writes to a per-test output dir (test-results/), which is
  // gitignored and writable on every platform/CI runner.
  await page.screenshot({ path: test.info().outputPath(filename), fullPage: true });
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));
}

async function setLanguage(page: Page, value: string): Promise<void> {
  let token = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
  if (!token) {
    const loginRes = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: 'owner@flo.local', password: 'E2ePass123!' },
    }).catch(() => null);
    if (loginRes && loginRes.ok()) {
      const data = await loginRes.json().catch(() => ({}));
      token = data.access_token;
    }
  }
  if (token) {
    const res = await page.request.put(`${BASE}/api/settings/language`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { value },
    });
    expect(res.ok(), `setting language=${value} should succeed (status ${res.status()})`).toBeTruthy();
  }
  await page.evaluate((lang) => {
    try {
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: lang };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    } catch {}
  }, value).catch(() => {});
}

test.describe('Batch 5E Migrated Pages & Components E2E Validation', () => {
  test('Batch 5E Pages render correctly in English, Spanish, and Persian with useTranslations and valid leaf keys', async ({ page }) => {
    await login(page, 'owner@flo.local');

    // ==========================================
    // 1. ENGLISH (EN) BASELINE
    // ==========================================
    await setLanguage(page, 'en');

    // 1a. Settings (EN)
    await page.goto(`${BASE}/settings`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(page.getByText('Store Details').first()).toBeVisible();
    await captureScreenshot(page, 'batch-5e-settings-en.png');

    // Settings -> Tax configuration panel
    const taxTab = page.locator('button', { hasText: 'Tax Configuration' }).first();
    if (await taxTab.isVisible()) {
      await taxTab.click();
      await page.waitForTimeout(300);
      await captureScreenshot(page, 'batch-5e-settings-tax-en.png');
    }

    // Settings -> Payment methods
    const paymentsTab = page.locator('button', { hasText: 'Payments' }).first();
    if (await paymentsTab.isVisible()) {
      await paymentsTab.click();
      await page.waitForTimeout(300);
      await captureScreenshot(page, 'batch-5e-settings-payments-en.png');
    }

    // 1b. Products (EN)
    await page.goto(`${BASE}/products`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Products');
    await captureScreenshot(page, 'batch-5e-products-en.png');

    // 1c. Addon Groups (EN)
    await page.goto(`${BASE}/addon-groups`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Addon Groups');
    await captureScreenshot(page, 'batch-5e-addon-groups-en.png');

    // 1d. Staff (EN)
    await page.goto(`${BASE}/staff`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Staff');
    await expect(page.getByText('Add Staff').first()).toBeVisible();
    await captureScreenshot(page, 'batch-5e-staff-en.png');

    // 1e. Support (EN)
    await page.goto(`${BASE}/support`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Help & Support');
    await captureScreenshot(page, 'batch-5e-support-en.png');

    // 1f. WhatsApp (EN)
    await page.goto(`${BASE}/whatsapp`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('WhatsApp');
    await captureScreenshot(page, 'batch-5e-whatsapp-en.png');

    // 1g. Print Test (EN)
    await page.goto(`${BASE}/print-test`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Printing Test Page');
    await captureScreenshot(page, 'batch-5e-print-test-en.png');

    // ==========================================
    // 2. SPANISH (ES)
    // ==========================================
    await setLanguage(page, 'es');

    // 2a. Settings (ES)
    await page.goto(`${BASE}/settings`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Configuración');
    await expect(page.getByText('Datos del Negocio').first()).toBeVisible();
    await captureScreenshot(page, 'batch-5e-settings-es.png');

    // 2b. Products (ES)
    await page.goto(`${BASE}/products`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Productos');
    await captureScreenshot(page, 'batch-5e-products-es.png');

    // 2c. Addon Groups (ES)
    await page.goto(`${BASE}/addon-groups`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Grupos de adicionales');
    await captureScreenshot(page, 'batch-5e-addon-groups-es.png');

    // 2d. Staff (ES)
    await page.goto(`${BASE}/staff`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Personal');
    await captureScreenshot(page, 'batch-5e-staff-es.png');

    // 2e. Support (ES)
    await page.goto(`${BASE}/support`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ayuda y soporte');
    await captureScreenshot(page, 'batch-5e-support-es.png');

    // 2f. WhatsApp (ES)
    await page.goto(`${BASE}/whatsapp`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('WhatsApp');
    await captureScreenshot(page, 'batch-5e-whatsapp-es.png');

    // 2g. Print Test (ES)
    await page.goto(`${BASE}/print-test`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Página de prueba de impresión');
    await captureScreenshot(page, 'batch-5e-print-test-es.png');

    // ==========================================
    // 3. PERSIAN (FA) RTL
    // ==========================================
    try {
      await setLanguage(page, 'fa');

      // 3a. Settings (FA)
      await page.goto(`${BASE}/settings`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('تنظیمات');
      await expect(page.getByText('جزئیات فروشگاه').first()).toBeVisible();
      await captureScreenshot(page, 'batch-5e-settings-fa.png');

      // 3b. Products (FA)
      await page.goto(`${BASE}/products`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('کالاها');
      await captureScreenshot(page, 'batch-5e-products-fa.png');

      // 3c. Addon Groups (FA)
      await page.goto(`${BASE}/addon-groups`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('گروه‌های افزونه');
      await captureScreenshot(page, 'batch-5e-addon-groups-fa.png');

      // 3d. Staff (FA)
      await page.goto(`${BASE}/staff`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('کارمند');
      await captureScreenshot(page, 'batch-5e-staff-fa.png');

      // 3e. Support (FA)
      await page.goto(`${BASE}/support`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('راهنما و پشتیبانی');
      await captureScreenshot(page, 'batch-5e-support-fa.png');

      // 3f. WhatsApp (FA)
      await page.goto(`${BASE}/whatsapp`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('واتساپ');
      await captureScreenshot(page, 'batch-5e-whatsapp-fa.png');

      // 3g. Print Test (FA)
      await page.goto(`${BASE}/print-test`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('صفحه آزمون چاپ');
      await captureScreenshot(page, 'batch-5e-print-test-fa.png');

    } finally {
      await setLanguage(page, 'en');
    }
  });
});
