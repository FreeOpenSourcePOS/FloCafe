import { test, expect } from '@playwright/test';

/**
 * Rendered RTL/LTR evidence for the Setup, Auth, and Settings screens
 * (Batch D, Refs #241).
 *
 * Persian (`fa`) is intentionally hidden from Setup/Settings language
 * selectors, so these tests drive the internal `fa` language through the
 * runtime plumbing and assert the rendered direction state:
 *
 *  - `<html dir="rtl">` is applied once the active language is Persian
 *    (HtmlLangSync), and stays `ltr` for English.
 *  - Naturally-LTR fields (email, URLs, technical values) are isolated in
 *    `dir="ltr"` islands so they stay readable inside the RTL page.
 *  - The Settings page does not overflow horizontally in RTL.
 *
 * The login-page test sets the store language purely client-side (via the
 * persisted `pos-settings` store) so it never touches the shared e2e server's
 * language setting. The settings-page test must set the server-side language
 * (login syncs the tenant language), so it restores `en` afterwards to avoid
 * leaking Persian into the other e2e specs that use English text locators.
 *
 * The e2e fixture (tests/e2e-server.cjs) seeds manager@flo.local /
 * E2ePass123! and owner@flo.local / E2ePass123!.
 */

const BASE = 'http://localhost:3001';

async function loginAsManager(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
}

async function setLanguage(page: import('@playwright/test').Page, value: string): Promise<void> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const res = await page.request.put(`${BASE}/api/settings/language`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  expect(res.ok(), `setting language=${value} should succeed`).toBeTruthy();
}

async function logout(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('tenant');
  });
}

test('login page is LTR in English', async ({ page }) => {
  await page.goto(`${BASE}/auth/login`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('login page is RTL in Persian with an LTR email field and end-aligned eye toggle', async ({ page }) => {
  // Set the persisted store language to Persian entirely client-side so the
  // shared e2e server's language setting is never modified.
  await page.addInitScript(() => {
    localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'fa' }, version: 3 }));
  });
  await page.goto(`${BASE}/auth/login`);

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // The email field is naturally LTR and must stay an LTR island inside RTL.
  await expect(page.locator('#email')).toHaveAttribute('dir', 'ltr');

  // The password eye toggle sits at the inline-end: in RTL that is the left
  // side of the input, so it must sit on the left half of the input.
  const input = page.locator('#password');
  const toggle = page.locator('button', { has: page.locator('svg') }).last();
  const inputBox = await input.boundingBox();
  const toggleBox = await toggle.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox!.x + toggleBox!.width).toBeLessThan(inputBox!.x + inputBox!.width / 2);
});

test('settings renders RTL without horizontal overflow and keeps emails in LTR islands', async ({ page }) => {
  await loginAsManager(page);
  await setLanguage(page, 'fa');
  try {
    await page.goto(`${BASE}/settings?tab=account`);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // The Settings nav and content render.
    await expect(page.locator('nav')).toBeVisible();

    // No horizontal overflow of the document in RTL.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, 'settings must not overflow horizontally in RTL').toBeLessThanOrEqual(overflow.clientWidth + 1);

    // The account email (manager@flo.local) must be inside a dir="ltr" island.
    const email = page.locator('text=manager@flo.local').first();
    await expect(email).toBeVisible();
    const hasLtrAncestor = await email.evaluate((el) => {
      let node: HTMLElement | null = el as HTMLElement;
      while (node) {
        if (node.getAttribute('dir') === 'ltr') return true;
        node = node.parentElement;
      }
      return false;
    });
    expect(hasLtrAncestor, 'account email must live inside an LTR island').toBeTruthy();
  } finally {
    // Restore the shared e2e server's language so other specs (which use
    // English text locators) are unaffected.
    await setLanguage(page, 'en');
    await logout(page);
  }
});
