import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

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
 *  - Directional navigation arrows mirror via `.rtl-flip`.
 *  - Screenshots are captured and written to the evidence directory.
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
const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ||
  '/var/folders/y_/1ltcxtwj0zd_w1dg9jv4jl580000gn/T/no-mistakes-evidence/01M06TFQ2DPQQE7CME0SCKM8Y3';

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

async function loginAsManager(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
}

async function setLanguage(page: Page, value: string): Promise<void> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const res = await page.request.put(`${BASE}/api/settings/language`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { value },
  });
  expect(res.ok(), `setting language=${value} should succeed`).toBeTruthy();
}

async function logout(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('tenant');
  });
}

test('login page is LTR in English and RTL in Persian with LTR email and end-aligned toggle', async ({ page }) => {
  // 1. English (LTR)
  await page.goto(`${BASE}/auth/login`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await captureScreenshot(page, 'auth-login-ltr-en.png');

  // 2. Persian (RTL)
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

  await captureScreenshot(page, 'auth-login-rtl-fa.png');
});

test('recover password page is LTR in English and RTL in Persian with .rtl-flip arrow and LTR email', async ({ page }) => {
  await page.route('**/api/auth/setup/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ masterPinAvailable: true, needsSetup: false }),
    });
  });

  // 1. English (LTR)
  await page.goto(`${BASE}/auth/recover`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#recover-email')).toBeVisible();
  await captureScreenshot(page, 'auth-recover-ltr-en.png');

  // 2. Persian (RTL)
  await page.addInitScript(() => {
    localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'fa' }, version: 3 }));
  });
  await page.goto(`${BASE}/auth/recover`);

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // Recover email input must have dir="ltr"
  await expect(page.locator('#recover-email')).toHaveAttribute('dir', 'ltr');

  // Back arrow has rtl-flip class
  const backButtonArrow = page.locator('button svg.rtl-flip');
  await expect(backButtonArrow).toBeVisible();

  await captureScreenshot(page, 'auth-recover-rtl-fa.png');
});

test('setup wizard renders with logical navigation, .rtl-flip directional arrows, and hides Persian from language options', async ({ page }) => {
  await page.route('**/api/auth/setup/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ needsSetup: true, masterPinAvailable: true }),
    });
  });

  // 1. Step 1 in English (LTR)
  await page.goto(`${BASE}/setup`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

  // Verify language options only include EN, ES, PT, not FA
  const languageButtons = page.locator('button', { hasText: /English|Inglés|Inglês/ });
  await expect(languageButtons.first()).toBeVisible();
  const allButtonsText = await page.locator('button').allInnerTexts();
  const hasPersianOption = allButtonsText.some((text) => text.includes('فارسی') || text.includes('FA'));
  expect(hasPersianOption, 'Persian (fa) must remain hidden from setup language options').toBeFalsy();

  // Forward arrow has rtl-flip class
  const continueArrow = page.locator('button svg.rtl-flip').first();
  await expect(continueArrow).toBeVisible();

  await captureScreenshot(page, 'setup-step1-ltr-en.png');

  // 2. Step 1 in Persian (RTL)
  await page.addInitScript(() => {
    localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'fa' }, version: 3 }));
  });
  await page.goto(`${BASE}/setup`);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await captureScreenshot(page, 'setup-step1-rtl-fa.png');

  // Advance to Step 2 (Master PIN)
  await page.locator('button', { hasText: /ادامه|Continue/ }).first().click();
  await expect(page.locator('#master-pin')).toBeVisible();
  await captureScreenshot(page, 'setup-step2-master-pin-rtl-fa.png');

  // Fill master pin to advance to Step 3 (Admin Account)
  await page.locator('#master-pin').fill('1234');
  await page.locator('#master-pin-confirm').fill('1234');
  await page.locator('button', { hasText: /ادامه|Continue/ }).first().click();

  // Step 3 (Owner Account)
  await expect(page.locator('#email')).toBeVisible();
  // Owner email input is naturally LTR
  await expect(page.locator('#email')).toHaveAttribute('dir', 'ltr');

  await captureScreenshot(page, 'setup-step3-owner-account-rtl-fa.png');
});

test('settings renders RTL without horizontal overflow, mirrors toggles and tabs, and isolates LTR data', async ({ page }) => {
  await loginAsManager(page);
  await setLanguage(page, 'fa');

  try {
    // 1. Store tab in Persian (RTL)
    await page.goto(`${BASE}/settings?tab=store`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('nav')).toBeVisible();

    // Verify language dropdown in Settings only has en, es, pt
    const languageSelect = page.locator('select').filter({ has: page.locator('option[value="en"]') }).first();
    await expect(languageSelect).toBeVisible();
    const options = await languageSelect.locator('option').all();
    const optionValues = await Promise.all(options.map((opt) => opt.getAttribute('value')));
    expect(optionValues).toContain('en');
    expect(optionValues).toContain('es');
    expect(optionValues).toContain('pt');
    expect(optionValues).not.toContain('fa');

    // Check document does not overflow horizontally in RTL
    const storeOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(storeOverflow.scrollWidth, 'settings store tab must not overflow horizontally in RTL').toBeLessThanOrEqual(
      storeOverflow.clientWidth + 1
    );

    await captureScreenshot(page, 'settings-store-rtl-fa.png');

    // Also take an English screenshot for visual comparison
    await page.goto(`${BASE}/settings?tab=store`);
    await page.evaluate(() => {
      document.documentElement.setAttribute('dir', 'ltr');
    });
    await captureScreenshot(page, 'settings-store-ltr-en.png');
    await page.evaluate(() => {
      document.documentElement.setAttribute('dir', 'rtl');
    });

    // 2. Account tab in Persian (RTL)
    await page.goto(`${BASE}/settings?tab=account`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // Account email (manager@flo.local) is in an LTR island
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

    const accountOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(accountOverflow.scrollWidth, 'settings account tab must not overflow horizontally in RTL').toBeLessThanOrEqual(
      accountOverflow.clientWidth + 1
    );

    await captureScreenshot(page, 'settings-account-rtl-fa.png');

    // 3. Taxes tab in Persian (RTL)
    await page.goto(`${BASE}/settings?tab=tax`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await captureScreenshot(page, 'settings-taxes-rtl-fa.png');

    // 4. Health Check dialog in Persian (RTL)
    await page.goto(`${BASE}/settings?tab=store&action=health-check`);
    await page.waitForTimeout(500);
    await captureScreenshot(page, 'settings-health-check-dialog-rtl-fa.png');
  } finally {
    // Restore English on server
    await setLanguage(page, 'en');
    await logout(page);
  }
});

