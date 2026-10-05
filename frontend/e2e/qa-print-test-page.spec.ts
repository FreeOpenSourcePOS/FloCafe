/** Inspection only: these tests never click Run Test, which triggers real printing or sending. */
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

  test('the preview renders the sample bill data', async ({ page }) => {
    await openPrintTest(page);

    const preview = page.locator('pre').first();
    await expect(preview).toBeVisible();
    const text = (await preview.textContent()) ?? '';
    const parsed = JSON.parse(text) as { bill: string; total: number; items: number; customer: string };

    expect(parsed).toEqual({ bill: 'BILL-001', total: 504, items: 3, customer: 'John Doe' });
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

  test('changing modes and settings sends no matching print or WhatsApp HTTP requests', async ({ page }) => {
    const outbound: Request[] = [];
    const record = (request: Request) => {
      const url = request.url();
      const method = request.method();
      if (/whatsapp\/send|print|receipt|kot/i.test(url) && method !== 'GET') {
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
