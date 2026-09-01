import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { E2E_BASE_URL as BASE } from './helpers/urls';

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
 *  - A live (in-page, no reload) direction flip with a toast on screen does
 *    not crash with a DOM insertBefore/NotFoundError (DirectionalToaster
 *    regression — see the settings-page segment at the end of the test).
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

import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await page.waitForFunction(() => !!localStorage.getItem('token'));
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
  // This single test walks ~15 screens plus the DirectionalToaster crash
  // regression below (which needs a real ~4.5s wait for react-hot-toast's
  // removal timer), well past Playwright's 30s default.
  test.setTimeout(90_000);

  // Captured for the DirectionalToaster live-direction-flip regression at the
  // end of this test (insertBefore/NotFoundError crash guard).
  const crashErrors: string[] = [];
  page.on('pageerror', (err) => crashErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /insertBefore|NotFoundError/i.test(msg.text())) {
      crashErrors.push(msg.text());
    }
  });

  // Owner account: the dashboard page redirects non-owner roles to /pos, and
  // one login keeps the suite within the shared server's login rate limit.
  await login(page, 'owner@flo.local');

  // ── English (LTR) baseline on the POS screen ─────────────────────────────
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByTestId('desktop-title-bar')).toHaveCount(0);
  await expect(page.getByTestId('desktop-drag-surface')).toHaveCount(0);
  await expect(page.getByTestId('pos-product-grid')).toBeVisible();
  await expect(page.getByText('E2E Coffee')).toBeVisible();
  await assertSidebarSide(page, 'left');
  await captureScreenshot(page, 'pos-ltr-en.png');

  // ── Persian (RTL) on the POS screen ──────────────────────────────────────
  await setLanguage(page, 'fa');
  try {
    await page.goto(`${BASE}/pos`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('desktop-title-bar')).toHaveCount(0);
    await expect(page.getByTestId('desktop-drag-surface')).toHaveCount(0);
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

    // ── Persian (RTL) on the staff screen & modal ──────────────────────────
    await page.goto(`${BASE}/staff`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('h1')).toBeVisible();
    await assertNoHorizontalOverflow(page, 'staff screen');
    const addStaffBtn = page.locator('button', { has: page.locator('svg') }).filter({ hasText: /افزودن|Add/i }).first();
    if (await addStaffBtn.isVisible()) {
      await addStaffBtn.click();
      const roleSelect = page.locator('select').first();
      await roleSelect.selectOption('manager');
      const pinInput = page.locator('input[placeholder*="PIN"], input[placeholder*="پین"], input[inputmode="numeric"]').first();
      await expect(pinInput).toBeVisible();
      const togglePinBtn = page.locator('button[aria-label="Toggle PIN visibility"]').first();
      await expect(togglePinBtn).toBeVisible();
      const pinBox = await pinInput.boundingBox();
      const toggleBox = await togglePinBtn.boundingBox();
      expect(pinBox).not.toBeNull();
      expect(toggleBox).not.toBeNull();
      // In RTL, end-3 is on the left half of the input.
      expect(toggleBox!.x + toggleBox!.width).toBeLessThan(pinBox!.x + pinBox!.width / 2);
      await captureScreenshot(page, 'staff-modal-rtl-fa.png');
      const closeFormBtn = page.locator('button:has(svg.lucide-x)').first();
      if (await closeFormBtn.isVisible()) {
        await closeFormBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
    }

    // ── Persian (RTL) on addon-groups, print-test, support, customer-display ─
    await page.goto(`${BASE}/addon-groups`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await assertNoHorizontalOverflow(page, 'addon-groups screen');
    await captureScreenshot(page, 'addon-groups-rtl-fa.png');

    await page.goto(`${BASE}/print-test`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await assertNoHorizontalOverflow(page, 'print-test screen');
    await captureScreenshot(page, 'print-test-rtl-fa.png');

    await page.goto(`${BASE}/support`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await assertNoHorizontalOverflow(page, 'support screen');
    await captureScreenshot(page, 'support-rtl-fa.png');

    await page.goto(`${BASE}/customer-display`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await assertNoHorizontalOverflow(page, 'customer-display screen');
    await captureScreenshot(page, 'customer-display-rtl-fa.png');

    // ── Mobile layout & SidebarTrigger on Persian dashboard ─────────────────
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const mobileTrigger = page.locator('button[aria-label="Open navigation"]');
    await expect(mobileTrigger).toBeVisible();
    await captureScreenshot(page, 'mobile-dashboard-appbar-rtl-fa.png');

    await mobileTrigger.click();
    const sheetContent = page.locator('[data-mobile="true"]');
    await expect(sheetContent).toBeVisible();
    const sheetBox = await sheetContent.boundingBox();
    expect(sheetBox).not.toBeNull();
    // In RTL, side="left" (inline-start) is pinned to the right edge.
    expect(sheetBox!.x + sheetBox!.width).toBeGreaterThan(360);
    await captureScreenshot(page, 'mobile-sidebar-sheet-rtl-fa.png');
    await page.keyboard.press('Escape');

    // Restore desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });

    // ── DirectionalToaster live direction-flip crash regression ────────────
    // frontend/src/components/layout/DirectionalToaster.tsx flips the
    // Toaster's `position` prop when the active direction changes. Doing
    // that on a live (already-mounted) Toaster used to crash with
    // `Uncaught (in promise) NotFoundError: Failed to execute 'insertBefore'
    // on 'Node': The node before which the new node is to be inserted is not
    // a child of this node` if a toast was showing at the moment the flip
    // happened — react-hot-toast repositions its DOM in place while its own
    // removal timers run outside React's render cycle. The fix keys the
    // Toaster by direction so React remounts it instead of updating props in
    // place. Reproducing needs a LIVE, in-page direction change (not a page
    // reload, which always boots with the correct position already) with a
    // toast visible at the same moment — the settings language switch is the
    // only in-app control that flips direction without navigating away.
    //
    // Reset to an English baseline first (hard reload) so the locators below
    // can rely on English button text — the rest of this test left the UI in
    // Persian, and reloading also matches the "correct-on-boot" case that
    // isn't affected by this bug (only a LIVE flip is).
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/settings`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    // Fire a toast that is purely client-side (no network round trip): the
    // "add printer" form validates the name field synchronously.
    await page.getByRole('button', { name: 'Printers', exact: true }).click();
    await page.getByRole('button', { name: 'Add Manually' }).click();
    await page.getByRole('button', { name: 'Add Printer', exact: true }).click();
    const toast = page.locator('.flo-toast-card').first();
    await expect(toast).toBeVisible();

    // Switch back to the tab with the language selector — the Toaster lives
    // at the root layout, outside the tabs, so the toast stays visible.
    await page.getByRole('button', { name: 'Store Details', exact: true }).click();
    await expect(toast).toBeVisible();

    // Handle to the actual toast DOM node before the flip — used below to
    // prove the fix's mechanism (full remount) actually ran in the browser.
    // A live crash from the old bug needs a precise, near-unreproducible
    // timing window (the toast's own removal timer firing in the same tick
    // as react-hot-toast's internal reposition), so asserting "no crash"
    // alone would pass even against the unfixed code. Asserting the DOM
    // identity change instead pins down the actual mechanism, deterministically.
    const preFlipToastHandle = await page.evaluateHandle(
      () => document.querySelector('.flo-toast-card')
    );

    // Flip direction live, with the toast still on screen and its removal
    // timer running.
    await page
      .getByText('Languages', { exact: true })
      .locator('xpath=following-sibling::select')
      .selectOption('fa');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // The fix keys <Toaster> by direction, so a live flip fully unmounts and
    // remounts it instead of updating `position` on the same instance — the
    // pre-flip toast's DOM node must be torn down as part of that (a fresh
    // node for the same logical toast appears immediately after, since
    // react-hot-toast's toast queue lives in a store outside the component).
    const preFlipNodeDetached = await preFlipToastHandle.evaluate(
      (el) => !!el && !document.contains(el)
    );
    expect(
      preFlipNodeDetached,
      'DirectionalToaster must fully remount (not update position in place) on a live direction flip, or a showing toast can crash with a DOM insertBefore/NotFoundError — see frontend/src/components/layout/DirectionalToaster.tsx'
    ).toBe(true);

    // Let react-hot-toast's timers (up to its 4s default duration) run past
    // the flip, then confirm the app is still alive and interactive.
    await page.waitForTimeout(4500);
    await expect(page.locator('h1')).toBeVisible();

    expect(
      crashErrors,
      `DirectionalToaster must not crash with a DOM insertBefore/NotFoundError when a toast survives a live direction flip, got: ${JSON.stringify(crashErrors)}`
    ).toEqual([]);
  } finally {
    // Restore English so the shared server does not leak Persian into other specs.
    await setLanguage(page, 'en');
  }
});
