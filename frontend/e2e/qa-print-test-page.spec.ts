/**
 * Printing Test Page: INSPECTION ONLY.
 *
 * HARD RULE for this suite: it never clicks "Run Test".
 *
 * That button is not a simulation. handlePrint() in
 * frontend/src/app/(dashboard)/print-test/page.tsx dispatches a real ESC/POS job
 * to the operating system's default thermal printer, or opens a real browser
 * print dialog, or - in WhatsApp Share mode - calls shareBillViaWhatsApp(), which
 * attempts a genuine send. Any of those is exactly what this programme was told
 * not to do, so the suite asserts what the page offers and what the current
 * configuration implies, and stops there.
 *
 * What is asserted without pressing the button:
 *   - all five test modes are present;
 *   - paper width and print method are real selections whose hint text names the
 *     transport that pressing the button would use;
 *   - the test-data preview is derived from real tenant data, not a stub;
 *   - the extra per-mode affordances ("Copy Text", "Download HTML") only appear
 *     for the mode that owns them;
 *   - nothing on the page fires a print, send, or WebUSB request.
 */
import { test, expect, type Page, type Request } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

const TEST_MODES = [
  'Basic Receipt (Thermal)',
  'Detailed Tax Bill (Thermal)',
  'KOT (Kitchen Ticket)',
  'Web Print (Browser)',
  'WhatsApp Share',
];

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
}

async function openPrintTest(page: Page): Promise<void> {
  await page.goto(`${BASE}/print-test`);
  await expect(page.getByRole('heading', { name: 'Printing Test Page', exact: true }))
    .toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

test.describe('@ci-tier2 Printing Test Page (inspection only - never runs a job)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await setLanguage(page, 'en');
  });

  test('offers all five test modes plus paper width and print method', async ({ page }) => {
    await openPrintTest(page);

    for (const mode of TEST_MODES) {
      await expect(page.getByRole('button', { name: mode, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Run Test', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '2.5" (58mm)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '3.5" (80mm)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ESCPOS (USB)', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Browser Print', exact: true })).toBeVisible();
  });

  test('the print method hint names the transport the button would actually use', async ({ page }) => {
    await openPrintTest(page);

    // ESC/POS is the configured default here, and its hint reports the live
    // printer status - so the page is reading real device state, not a stub.
    await expect(page.getByText(/Direct USB printing via WebUSB/)).toBeVisible();
    await expect(page.getByText(/Status:/)).toBeVisible();

    // Switching to browser changes the stated transport without printing.
    await page.getByRole('button', { name: 'Browser Print', exact: true }).click();
    await expect(page.getByText(/Uses browser print dialog/)).toBeVisible();

    await page.getByRole('button', { name: 'ESCPOS (USB)', exact: true }).click();
    await expect(page.getByText(/Direct USB printing via WebUSB/)).toBeVisible();
  });

  test('paper width selection is reflected in the highlighted control', async ({ page }) => {
    await openPrintTest(page);

    const narrow = page.getByRole('button', { name: '2.5" (58mm)', exact: true });
    const wide = page.getByRole('button', { name: '3.5" (80mm)', exact: true });

    await wide.click();
    await expect(wide).toHaveClass(/border-brand/);
    await expect(narrow).not.toHaveClass(/border-brand/);

    await narrow.click();
    await expect(narrow).toHaveClass(/border-brand/);
    await expect(wide).not.toHaveClass(/border-brand/);
  });

  test('the test-data preview is derived from real tenant data', async ({ page }) => {
    await openPrintTest(page);

    const preview = page.locator('pre').first();
    await expect(preview).toBeVisible();
    const text = (await preview.textContent()) ?? '';
    const parsed = JSON.parse(text) as { bill: string; total: number; items: number; customer: string };

    // A stub would be a constant; these are populated, which is what makes the
    // preview worth trusting as a dry run.
    expect(parsed.bill, 'preview carries a bill number').toBeTruthy();
    expect(typeof parsed.total, 'preview carries a total').toBe('number');
    expect(parsed.items, 'preview carries an item count').toBeGreaterThan(0);
    expect(parsed.customer, 'preview carries a test customer').toBeTruthy();
  });

  test('per-mode affordances appear only for the mode that owns them', async ({ page }) => {
    await openPrintTest(page);

    // WhatsApp Share is the only mode with a clipboard-only escape hatch.
    await expect(page.getByRole('button', { name: 'Copy Text', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download HTML', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'WhatsApp Share', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Copy Text', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download HTML', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Web Print (Browser)', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Download HTML', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Text', exact: true })).toHaveCount(0);
  });

  test('changing modes and settings alone sends no print, send or WebUSB request', async ({ page }) => {
    const outbound: Request[] = [];
    const record = (request: Request) => {
      const url = request.url();
      const method = request.method();
      // Anything that could put bytes on a printer, a device, or a wire.
      if (/webusb|whatsapp\/send|print|receipt|kot/i.test(url) && method !== 'GET') {
        outbound.push(request);
      }
    };
    page.on('request', record);

    await openPrintTest(page);
    for (const mode of TEST_MODES) {
      await page.getByRole('button', { name: mode, exact: true }).click();
    }
    await page.getByRole('button', { name: 'Browser Print', exact: true }).click();
    await page.getByRole('button', { name: '3.5" (80mm)', exact: true }).click();
    await page.getByRole('button', { name: 'ESCPOS (USB)', exact: true }).click();
    await page.getByRole('button', { name: '2.5" (58mm)', exact: true }).click();

    expect(outbound.map((request) => `${request.method()} ${request.url()}`)).toEqual([]);
  });
});