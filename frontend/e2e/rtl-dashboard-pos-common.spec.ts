import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Rendered RTL/LTR evidence for the Dashboard, POS, and common order flow
 * screens (Batch E, Refs #241).
 *
 * Persian (`fa`) is a user-selectable UI language (Batch J, Refs #241).
 * These tests drive it through the server-side tenant language that login
 * syncs and assert the rendered direction state on the core cashier screens:
 *
 *  - `<html dir="rtl">` is applied once the active language is Persian
 *    (HtmlLangSync), and stays `ltr` for English.
 *  - The POS customer-search phone input stays `dir="ltr"` inside RTL.
 *  - Directional arrows (dashboard "view all") mirror via `.rtl-flip`.
 *  - The screens do not overflow horizontally in RTL.
 *  - Screenshots are captured and written to the evidence directory.
 *
 * These screens sit behind auth, and login syncs the tenant language from the
 * server, so the language is set server-side (PUT /api/settings/language)
 * after the target page has loaded, and restored to `en` afterwards to avoid
 * leaking Persian into the other e2e specs that use English text locators.
 * Each test also re-establishes an explicit English baseline so it does not
 * depend on the language any earlier spec left on the shared e2e server.
 *
 * All operational screens are exercised in a SINGLE test with a single login: the
 * shared e2e server's auth endpoint is rate-limited (10 login POSTs per 15
 * minutes per IP) and the rest of the suite already performs ~8 logins, so a
 * per-screen login would trip the limiter and break unrelated specs.
 *
 * The e2e fixture (tests/e2e-server.cjs) seeds manager@flo.local /
 * E2ePass123! and owner@flo.local / E2ePass123! with a restaurant tenant
 * (tables_required=false) and one product ("E2E Coffee").
 */

const BASE = 'http://localhost:3001';
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  path.join(os.tmpdir(), 'no-mistakes-evidence', '01M06ZR8QPAYE8HF2XV90DDKGY');

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

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));
}

async function setLanguage(page: Page, value: string): Promise<void> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token, 'auth token must be present before changing language').toBeTruthy();
  const res = await page.request.put(`${BASE}/api/settings/language`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  expect(res.ok(), `setting language=${value} should succeed (status ${res.status()})`).toBeTruthy();
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, `${label} must not overflow horizontally in RTL`).toBeLessThanOrEqual(
    overflow.clientWidth + 1
  );
}

/**
 * The fixed app sidebar rail must sit at the inline-start: left edge in LTR,
 * right edge in RTL (Persian). Regression coverage for the physical left-0
 * pinning that kept it stuck on the left in RTL (Refs #241).
 */
async function assertSidebarSide(page: Page, expected: 'left' | 'right'): Promise<void> {
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeVisible();
  const box = await container.boundingBox();
  expect(box, 'sidebar container must have a bounding box').not.toBeNull();
  const vw = page.viewportSize()?.width ?? 0;
  if (expected === 'left') {
    expect(box!.x, 'sidebar must be pinned to the left edge in LTR').toBeLessThan(5);
  } else {
    expect(box!.x + box!.width, 'sidebar must be pinned to the right edge in RTL').toBeGreaterThan(vw - 5);
  }
}

test('Dashboard, POS, and orders screens render LTR in English and RTL in Persian with LTR phone input, mirrored arrows, and no overflow', async ({ page }) => {
  // Owner account: the dashboard page redirects non-owner roles to /pos, and
  // one login keeps the suite within the shared server's login rate limit.
  await login(page, 'owner@flo.local');

  // ── English (LTR) baseline on the POS screen ─────────────────────────────
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
  await expect(page.getByText('E2E Coffee')).toBeVisible();
  await assertSidebarSide(page, 'left');
  await captureScreenshot(page, 'pos-ltr-en.png');

  // ── Persian (RTL) on the POS screen ──────────────────────────────────────
  await setLanguage(page, 'fa');
  try {
    await page.goto(`${BASE}/pos`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('pos-product-grid')).toBeVisible();
    await expect(page.getByText('E2E Coffee')).toBeVisible();
    await assertSidebarSide(page, 'right');

    // The customer-search phone input is naturally LTR and must stay dir="ltr" inside RTL.
    const phoneInput = page.locator('input[type="tel"]').first();
    await expect(phoneInput).toHaveAttribute('dir', 'ltr');

    await assertNoHorizontalOverflow(page, 'POS screen');
    await captureScreenshot(page, 'pos-rtl-fa.png');

    // ── Persian (RTL) on the dashboard ─────────────────────────────────────
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('h1')).toBeVisible();

    // The "view all" arrows carry the shared rtl-flip class so they point the
    // correct way in RTL.
    const viewAllArrows = page.locator('svg.rtl-flip');
    await expect(viewAllArrows.first()).toBeVisible();

    await assertNoHorizontalOverflow(page, 'dashboard');
    await captureScreenshot(page, 'dashboard-rtl-fa.png');

    // ── Persian (RTL) on the orders screen ─────────────────────────────────
    await page.goto(`${BASE}/orders`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('h1')).toBeVisible();
    await assertNoHorizontalOverflow(page, 'orders screen');
    await captureScreenshot(page, 'orders-rtl-fa.png');

    // ── Persian (RTL) on the products screen ───────────────────────────────
    await page.goto(`${BASE}/products`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('h1')).toBeVisible();
    await assertNoHorizontalOverflow(page, 'products screen');
    await captureScreenshot(page, 'products-rtl-fa.png');

    // ── Persian (RTL) on the customers screen ──────────────────────────────
    await page.goto(`${BASE}/customers`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('h1')).toBeVisible();
    await assertNoHorizontalOverflow(page, 'customers screen');
    await captureScreenshot(page, 'customers-rtl-fa.png');

    // ── Persian (RTL) on the tables screen ─────────────────────────────────
    await page.goto(`${BASE}/tables`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('h1')).toBeVisible();
    await assertNoHorizontalOverflow(page, 'tables screen');
    await captureScreenshot(page, 'tables-rtl-fa.png');
  } finally {
    // Restore English so the shared server does not leak Persian into other specs.
    await setLanguage(page, 'en');
  }
});
