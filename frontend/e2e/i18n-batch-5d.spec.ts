import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const BASE_API = 'http://localhost:3001';
const BASE_KDS = 'http://localhost:3002';
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  path.join(os.tmpdir(), 'no-mistakes-evidence', '01M0D9465DMYWJPCZS0XR240HB');

async function captureScreenshot(page: Page, filename: string): Promise<void> {
  if (!fs.existsSync(EVIDENCE_DIR)) {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  }
  await page.screenshot({ path: path.join(EVIDENCE_DIR, filename), fullPage: true });
}

async function loginPos(page: Page, email: string): Promise<string> {
  await page.goto(`${BASE_API}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();
  return token as string;
}

async function setLanguage(page: Page, token: string, value: string): Promise<void> {
  const res = await page.request.put(`${BASE_API}/api/settings/language`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  expect(res.ok(), `setting language=${value} should succeed (status ${res.status()})`).toBeTruthy();
  await page.evaluate((lang) => {
    try {
      const raw = localStorage.getItem('pos-settings');
      const parsed = raw ? JSON.parse(raw) : { state: {} };
      parsed.state = { ...parsed.state, language: lang };
      localStorage.setItem('pos-settings', JSON.stringify(parsed));
    } catch {}
  }, value);
}

test('Batch 5D: KDS and Server App render and function correctly in English and Persian (RTL)', async ({ page }) => {
  // 1. Setup session & seed data
  const token = await loginPos(page, 'manager@flo.local');

  // Create table if not present
  await page.request.post(`${BASE_API}/api/tables`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { number: 'Table 1', capacity: 4 },
  });

  // Create a dine-in order with items
  const orderRes = await page.request.post(`${BASE_API}/api/orders`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {
      type: 'dine_in',
      items: [{ product_id: 'e2e-product', quantity: 2, notes: 'Extra hot' }],
    },
  });
  expect(orderRes.ok()).toBeTruthy();
  const { order } = await orderRes.json();
  const orderNumStr = `#${order.order_number}`;

  // =========================================================================
  // 1. ENGLISH (EN) VERIFICATION
  // =========================================================================
  await setLanguage(page, token, 'en');

  // 1a. Standalone KDS Login Form (EN)
  await page.goto(`${BASE_KDS}/kds-standalone`);
  await page.evaluate(() => {
    localStorage.removeItem('token');
  });
  await page.goto(`${BASE_KDS}/kds-standalone`);
  await expect(page.getByTestId('kds-login-form')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kitchen Display');
  await expect(page.getByText('Sign in with your kitchen staff account')).toBeVisible();
  await expect(page.getByText('Email', { exact: true })).toBeVisible();
  await expect(page.getByText('Password', { exact: true })).toBeVisible();
  await expect(page.getByText('Keep me logged in')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  await expect(page.getByText('Only chef, manager, or owner roles can access the kitchen display.')).toBeVisible();
  await captureScreenshot(page, 'kds-login-en.png');

  // Log in to KDS
  await page.getByTestId('kds-login-email').fill('manager@flo.local');
  await page.getByTestId('kds-login-password').fill('E2ePass123!');
  await page.getByTestId('kds-login-submit').click();
  await expect(page.getByTestId('kds-workspace')).toBeVisible();

  // 1b. Standalone KDS Tabs View (EN)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kitchen Display');
  await expect(page.getByRole('button', { name: 'Tabs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kanban' })).toBeVisible();
  await expect(page.getByText('Dine In').first()).toBeVisible();
  await captureScreenshot(page, 'kds-tabs-en.png');

  // 1c. KDS Item Modal (EN)
  await page.getByText('E2E Coffee').first().click();
  const modalHeader = page.locator('#kds-item-modal-title');
  await expect(modalHeader).toBeVisible();
  await expect(page.getByText(`Order ${orderNumStr}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as Preparing' })).toBeVisible();
  await captureScreenshot(page, 'kds-item-modal-en.png');
  await page.getByLabel('Close').click();
  await expect(modalHeader).toBeHidden();

  // 1d. Standalone KDS Kanban View (EN)
  await page.getByRole('button', { name: 'Kanban' }).click();
  await expect(page.getByText('Waiting', { exact: true })).toBeVisible();
  await expect(page.getByText('Preparing', { exact: true })).toBeVisible();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await expect(page.getByText('Delivered', { exact: true })).toBeVisible();
  await captureScreenshot(page, 'kds-kanban-en.png');

  // 1e. Server App Login Form (EN)
  await page.goto(`${BASE_API}/server-standalone`);
  await page.evaluate(() => {
    localStorage.removeItem('flocafe:server-app-token');
  });
  await page.goto(`${BASE_API}/server-standalone`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Server App');
  await expect(page.getByText('Tableside ordering for service staff')).toBeVisible();
  await expect(page.getByPlaceholder('server@flo.local')).toBeVisible();
  await expect(page.getByPlaceholder('Password')).toBeVisible();
  await expect(page.getByText('Keep me logged in')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  await captureScreenshot(page, 'server-login-en.png');

  // Log in to Server App
  await page.getByPlaceholder('server@flo.local').fill('manager@flo.local');
  await page.getByPlaceholder('Password').fill('E2ePass123!');
  await page.getByRole('button', { name: 'Sign In' }).click();

  // 1f. Server App Main UI (EN)
  await expect(page.getByRole('heading', { name: 'Server App' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Current ticket' })).toBeVisible();
  await expect(page.getByText('New items', { exact: true })).toBeVisible();
  await expect(page.getByText('Draft total', { exact: true })).toBeVisible();
  await expect(page.getByText('All', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('Search menu')).toBeVisible();
  await expect(page.getByPlaceholder('Customer name')).toBeVisible();
  await expect(page.getByPlaceholder('Phone')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  // Click a table and an item
  await page.getByRole('button', { name: /Table 1/i }).first().click();
  await page.getByText('E2E Coffee').first().click();
  await expect(page.getByPlaceholder('Item note')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send to kitchen' })).toBeVisible();
  await captureScreenshot(page, 'server-standalone-en.png');

  // =========================================================================
  // 2. PERSIAN (FA) RTL VERIFICATION
  // =========================================================================
  try {
    await setLanguage(page, token, 'fa');

    // 2a. Standalone KDS Login Form (FA)
    await page.goto(`${BASE_KDS}/kds-standalone`);
    await page.evaluate(() => {
      localStorage.removeItem('token');
    });
    await page.goto(`${BASE_KDS}/kds-standalone`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('kds-login-form')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('نمایشگر آشپزخانه');
    await expect(page.getByText('با حساب کاربری کارکنان آشپزخانه وارد شوید')).toBeVisible();
    await expect(page.getByText('ایمیل', { exact: true })).toBeVisible();
    await expect(page.getByText('گذرواژه', { exact: true })).toBeVisible();
    await expect(page.getByText('ورود من را به یاد بسپار')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ورود' })).toBeVisible();
    await expect(page.getByText('تنها سرآشپز، سرپرست یا دارنده می‌تواند به نمایشگر آشپزخانه دسترسی داشته باشد.')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await captureScreenshot(page, 'kds-login-fa.png');

    // Log in to KDS in FA
    await page.getByTestId('kds-login-email').fill('manager@flo.local');
    await page.getByTestId('kds-login-password').fill('E2ePass123!');
    await page.getByTestId('kds-login-submit').click();
    await expect(page.getByTestId('kds-workspace')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // 2b. Standalone KDS Tabs View (FA)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('نمایشگر آشپزخانه');
    await expect(page.getByRole('button', { name: 'زبانه‌ها' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'کانبان' })).toBeVisible();
    await expect(page.getByText('خوردن در محل').first()).toBeVisible();
    await captureScreenshot(page, 'kds-tabs-fa.png');

    // 2c. KDS Item Modal (FA)
    await page.getByText('E2E Coffee').first().click();
    const modalHeaderFa = page.locator('#kds-item-modal-title');
    await expect(modalHeaderFa).toBeVisible();
    await expect(page.getByText(`سفارش شماره ${order.order_number}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'تغییر وضعیت به در حال آماده‌سازی' })).toBeVisible();
    await captureScreenshot(page, 'kds-item-modal-fa.png');
    await page.getByLabel('بستن').click();
    await expect(modalHeaderFa).toBeHidden();

    // 2d. Standalone KDS Kanban View (FA)
    await page.getByRole('button', { name: 'کانبان' }).click();
    await expect(page.getByText('در انتظار', { exact: true })).toBeVisible();
    await expect(page.getByText('در حال آماده‌سازی', { exact: true })).toBeVisible();
    await expect(page.getByText('آماده', { exact: true })).toBeVisible();
    await expect(page.getByText('تحویل‌شده', { exact: true })).toBeVisible();
    await captureScreenshot(page, 'kds-kanban-fa.png');

    // 2e. Server App Login Form (FA)
    await page.goto(`${BASE_API}/server-standalone`);
    await page.evaluate(() => {
      localStorage.removeItem('flocafe:server-app-token');
    });
    await page.goto(`${BASE_API}/server-standalone`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('برنامه سرور');
    await expect(page.getByText('ثبت سفارش کنار میز برای کارکنان خدمات')).toBeVisible();
    await expect(page.getByPlaceholder('server@flo.local')).toBeVisible();
    await expect(page.getByPlaceholder('گذرواژه')).toBeVisible();
    await expect(page.getByText('ورود من را به یاد بسپار')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ورود' })).toBeVisible();
    await captureScreenshot(page, 'server-login-fa.png');

    // Log in to Server App in FA
    await page.getByPlaceholder('server@flo.local').fill('manager@flo.local');
    await page.getByPlaceholder('گذرواژه').fill('E2ePass123!');
    await page.getByRole('button', { name: 'ورود' }).click();

    // 2f. Server App Main UI (FA)
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { name: 'برنامه سرور' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'میزها' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'صورتحساب جاری' })).toBeVisible();
    await expect(page.getByText('کالاهای تازه', { exact: true })).toBeVisible();
    await expect(page.getByText('جمع پیش‌نویس', { exact: true })).toBeVisible();
    await expect(page.getByText('همه', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('جست‌وجو در منو')).toBeVisible();
    await expect(page.getByPlaceholder('نام مشتری')).toBeVisible();
    await expect(page.getByPlaceholder('تلفن')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // Select table and item
    await page.getByRole('button', { name: /Table 1/i }).first().click();
    await page.getByText('E2E Coffee').first().click();
    await expect(page.getByPlaceholder('یادداشت کالا')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ارسال به آشپزخانه' })).toBeVisible();
    await captureScreenshot(page, 'server-standalone-fa.png');

  } finally {
    await setLanguage(page, token, 'en');
  }
});
