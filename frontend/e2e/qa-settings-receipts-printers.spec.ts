/**
 * Settings > Printers: receipt/KOT/Z-report language policy, receipt footer and
 * bill template.
 *
 * Same shape as the store-tab suite: change through the UI, save the way the UI
 * saves, reload, confirm it came back, restore.
 *
 * Two things this pins down that are easy to get wrong:
 *   - Receipt/KOT/Z-report language is stored server-side as a policy object
 *     ({primary, additional}), not as a bare language code, and the writer
 *     de-duplicates a second language equal to the primary. The assertions read
 *     the persisted policy back rather than the select's value.
 *   - Paper width and print method are NOT server settings (they live in the
 *     POS/printer stores). The suite asserts they are real, visible controls but
 *     does not claim they persist server-side.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

type LanguagePolicy = {
  primary: { mode: string; language?: string };
  additional: Array<{ mode?: string; language?: string }>;
};

async function readSetting(page: Page, key: string): Promise<unknown> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const res = await page.request.get(`${BASE}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `GET /api/settings must succeed (got ${res.status()})`).toBeTruthy();
  const { settings } = (await res.json()) as { settings: Record<string, string> };
  const raw = settings[key];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.getByLabel('Email').fill('owner@flo.local');
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 30_000 });
}

async function openPrintersTab(page: Page): Promise<void> {
  await page.goto(`${BASE}/settings?tab=receipts-printers`);
  await expect(page.locator('select').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

const saveChanges = (page: Page) => page.getByRole('button', { name: 'Save Changes' });

async function saveAndReloadPrintersTab(page: Page): Promise<void> {
  await saveChanges(page).click();
  await expect(page.getByText('Settings saved', { exact: true })).toBeVisible({ timeout: 30_000 });
  await openPrintersTab(page);
}

test.describe('@ci-tier2 Settings > Printers', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await setLanguage(page, 'en');
  });

  test('receipt footer message and bill template persist across a reload', async ({ page }) => {
    await openPrintersTab(page);

    const footer = page.getByLabel('Footer Message', { exact: true });
    const originalFooter = await footer.inputValue();
    const originalTemplate = (await readSetting(page, 'bill_template')) as
      | { id: string }
      | undefined;

    const stamp = `UAT footer ${Date.now()}`;
    try {
      await footer.fill(stamp);
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      await expect(page.getByLabel('Footer Message', { exact: true })).toHaveValue(stamp);
      expect(await readSetting(page, 'bill_footer_message')).toBe(stamp);

      // Switch the bill template away from whatever it is and back-check. The
      // stored value is a selection object ({id, source}), not a bare id.
      const compact = page.getByRole('button', { name: /^Compact/ });
      const classic = page.getByRole('button', { name: /^Classic/ });
      await expect(compact).toBeVisible();
      const target = originalTemplate?.id === 'compact' ? classic : compact;
      await target.click();
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      const expected = originalTemplate?.id === 'compact' ? 'classic' : 'compact';
      expect((await readSetting(page, 'bill_template')) as { id: string }).toMatchObject({
        id: expected,
      });
    } finally {
      await openPrintersTab(page);
      await page.getByLabel('Footer Message', { exact: true }).fill(originalFooter);
      const restore =
        originalTemplate?.id === 'compact'
          ? page.getByRole('button', { name: /^Compact/ })
          : page.getByRole('button', { name: /^Classic/ });
      await restore.click();
      if (
        await saveChanges(page)
          .isVisible()
          .catch(() => false)
      ) {
        await saveAndReloadPrintersTab(page);
      }
      expect(await readSetting(page, 'bill_footer_message')).toBe(originalFooter);
    }
  });

  test('a fixed receipt language persists as a policy object', async ({ page }) => {
    await openPrintersTab(page);

    const receiptPrimary = page.getByLabel('Receipt language', { exact: true });
    const original = (await readSetting(page, 'bill_language_policy')) as LanguagePolicy;
    const originalValue = await receiptPrimary.inputValue();
    const next = originalValue === 'de' ? 'th' : 'de';

    try {
      await receiptPrimary.selectOption(next);
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      await expect(page.getByLabel('Receipt language', { exact: true })).toHaveValue(next);
      // The persisted shape is a policy, not a bare code.
      expect(await readSetting(page, 'bill_language_policy')).toEqual({
        primary: { mode: 'fixed', language: next },
        additional: [],
      });
    } finally {
      await openPrintersTab(page);
      await page.getByLabel('Receipt language', { exact: true }).selectOption(originalValue);
      if (
        await saveChanges(page)
          .isVisible()
          .catch(() => false)
      ) {
        await saveAndReloadPrintersTab(page);
      }
      expect(await readSetting(page, 'bill_language_policy')).toEqual(original);
    }
  });

  test('a second receipt language equal to the primary is de-duplicated on save', async ({
    page,
  }) => {
    await openPrintersTab(page);

    const receiptPrimary = page.getByLabel('Receipt language', { exact: true });
    const receiptSecond = page.getByLabel('Second receipt language', { exact: true });
    const original = (await readSetting(page, 'bill_language_policy')) as LanguagePolicy;

    const primary = (await receiptPrimary.inputValue()) === 'fr' ? 'it' : 'fr';
    try {
      await receiptPrimary.selectOption(primary);
      await receiptSecond.selectOption(primary);
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      // The writer drops a duplicate second language rather than storing it
      // twice; the UI reload then has to show "None" for the second language.
      expect(await readSetting(page, 'bill_language_policy')).toEqual({
        primary: { mode: 'fixed', language: primary },
        additional: [],
      });
      await expect(page.getByLabel('Second receipt language', { exact: true })).toHaveValue('none');
    } finally {
      await openPrintersTab(page);
      await page.getByLabel('Second receipt language', { exact: true }).selectOption('none');
      await page
        .getByLabel('Receipt language', { exact: true })
        .selectOption(
          original?.primary?.mode === 'fixed' && original.primary.language
            ? original.primary.language
            : 'inherit',
        );
      if (
        await saveChanges(page)
          .isVisible()
          .catch(() => false)
      ) {
        await saveAndReloadPrintersTab(page);
      }
      expect(await readSetting(page, 'bill_language_policy')).toEqual(original);
    }
  });

  test('kitchen ticket and Z-report languages persist independently of the receipt', async ({
    page,
  }) => {
    await openPrintersTab(page);

    const kot = page.getByLabel('Kitchen ticket language', { exact: true });
    const zPrimary = page.getByLabel('Z-report language', { exact: true });
    const originalKot = await readSetting(page, 'kot_language_policy');
    const originalZ = await readSetting(page, 'z_report_language_policy');

    const nextKot = (await kot.inputValue()) === 'de' ? 'th' : 'de';
    const nextZ = (await zPrimary.inputValue()) === 'fr' ? 'it' : 'fr';

    try {
      await kot.selectOption(nextKot);
      await zPrimary.selectOption(nextZ);
      await expect(saveChanges(page)).toBeVisible();
      await saveAndReloadPrintersTab(page);

      expect(await readSetting(page, 'kot_language_policy')).toEqual({
        primary: { mode: 'fixed', language: nextKot },
        additional: [],
      });
      expect(await readSetting(page, 'z_report_language_policy')).toEqual({
        primary: { mode: 'fixed', language: nextZ },
        additional: [],
      });
    } finally {
      await openPrintersTab(page);
      await page
        .getByLabel('Kitchen ticket language', { exact: true })
        .selectOption((originalKot as LanguagePolicy)?.primary?.language ?? 'inherit');
      await page
        .getByLabel('Z-report language', { exact: true })
        .selectOption((originalZ as LanguagePolicy)?.primary?.language ?? 'inherit');
      if (
        await saveChanges(page)
          .isVisible()
          .catch(() => false)
      ) {
        await saveAndReloadPrintersTab(page);
      }
      expect(await readSetting(page, 'kot_language_policy')).toEqual(originalKot);
      expect(await readSetting(page, 'z_report_language_policy')).toEqual(originalZ);
    }
  });

  test('the printers tab surfaces print method, bill template and detected devices', async ({
    page,
  }) => {
    await openPrintersTab(page);

    await expect(page.getByRole('heading', { name: 'Printers', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Printing', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bill Template', exact: true })).toBeVisible();
    await expect(page.getByLabel('Footer Message', { exact: true })).toBeVisible();

    // Print method is a real ESC/POS vs browser choice, and the explanatory
    // hint below the select follows the selection.
    const printMethod = page
      .getByText('Print Method', { exact: true })
      .first()
      .locator('xpath=following-sibling::select[1]');
    const selectedMethod = await printMethod.inputValue();
    await expect(printMethod).toHaveValue(/escpos|browser/);
    await expect(
      page.getByText(
        selectedMethod === 'browser'
          ? 'Opens the browser print dialog — works with any printer on this computer'
          : 'Direct thermal printing for USB, Network, and WebUSB printers — keep selected for receipt printers',
      ),
    ).toBeVisible();
    await printMethod.selectOption('escpos');
    await expect(
      page.getByText(
        'Direct thermal printing for USB, Network, and WebUSB printers — keep selected for receipt printers',
      ),
    ).toBeVisible();
    await printMethod.selectOption(selectedMethod);

    // Every receipt-surface language policy has its own control.
    for (const label of [
      'Receipt language',
      'Second receipt language',
      'Kitchen ticket language',
      'Z-report language',
      'Second Z-report language',
    ]) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }

    // The device list is real, not a placeholder: it reports what the OS
    // enumerates (here, one device).
    await expect(page.getByRole('button', { name: /Installed on this computer/ })).toBeVisible();
  });

  test('XP-58 printer text_size, localized Print Method guidance, and live Browser Print scaling work end-to-end', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const evidenceDir = process.env.EVIDENCE_DIR;
    await openPrintersTab(page);

    const token = await page.evaluate(() => localStorage.getItem('token'));
    const headers = { Authorization: `Bearer ${token}` };

    const printMethod = page
      .getByText('Print Method', { exact: true })
      .first()
      .locator('xpath=following-sibling::select[1]');
    const originalMethod = await printMethod.inputValue();

    // 1. Verify English and Spanish Print Method guidance copy in the live UI
    await printMethod.selectOption('escpos');
    await expect(printMethod.locator('option[value="escpos"]')).toHaveText(
      'ESCPOS (USB / Network Thermal Printer)',
    );
    await expect(
      page.getByText(
        'Direct thermal printing for USB, Network, and WebUSB printers — keep selected for receipt printers',
      ),
    ).toBeVisible();

    if (evidenceDir && fs.existsSync(evidenceDir)) {
      await page.screenshot({
        path: path.join(evidenceDir, '14_settings_print_method_escpos_hint.png'),
        fullPage: false,
      });
    }

    await setLanguage(page, 'es');
    await page.goto(`${BASE}/settings?tab=receipts-printers`);
    await expect(
      page.getByText(
        'Impresión térmica directa para impresoras USB, de red y WebUSB: mantenlo seleccionado para impresoras de tickets',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await setLanguage(page, 'en');
    await openPrintersTab(page);

    // 2. Configure an XP-58 SIR printer with Extra Large text size via the UI and verify API shape + adversarial guard
    let createdPrinterId: string | null = null;
    try {
      const initialListRes = await page.request.get(`${BASE}/api/printers`, { headers });
      const initialPrinters = (
        (await initialListRes.json()) as { printers: Array<{ id: string; name: string }> }
      ).printers;
      const preExistingXp58 = initialPrinters.find((p) => p.name === 'XP-58 SIR');
      if (!preExistingXp58) {
        await page.getByRole('button', { name: 'Add Manually', exact: true }).click();
        await page.getByPlaceholder('e.g. Kitchen Printer').fill('XP-58 SIR');
        const formSection = page.locator('h3', { hasText: 'Add Printer' }).locator('..');
        const selects = formSection.locator('select');
        await selects.nth(0).selectOption('usb');
        await selects.nth(1).selectOption('cols-32');
        await selects.nth(2).selectOption('extra_large');
        await formSection.getByRole('button', { name: 'Add Printer', exact: true }).click();
      } else {
        await page.request.put(`${BASE}/api/printers/${preExistingXp58.id}`, {
          headers,
          data: {
            connection_type: 'usb',
            paper_width: 'cols-32',
            text_size: 'extra_large',
            is_default: true,
          },
        });
        await openPrintersTab(page);
      }

      await expect(page.getByText('XP-58 SIR', { exact: true }).first()).toBeVisible({
        timeout: 15_000,
      });

      const listRes = await page.request.get(`${BASE}/api/printers`, { headers });
      expect(listRes.ok()).toBeTruthy();
      const { printers } = (await listRes.json()) as {
        printers: Array<{
          id: string;
          name: string;
          text_size: string;
          is_default: number;
          capabilities: { textSize: string };
        }>;
      };
      const xp58 = printers.find((p) => p.name === 'XP-58 SIR');
      expect(xp58).toBeDefined();
      createdPrinterId = xp58!.id;
      expect(xp58!.text_size).toBe('extra_large');
      expect(xp58!.capabilities.textSize).toBe('extra_large');

      // Ensure XP-58 SIR is the default printer so active printer resolution selects it
      if (xp58!.is_default !== 1) {
        const defaultRes = await page.request.put(`${BASE}/api/printers/${createdPrinterId}`, {
          headers,
          data: { is_default: true },
        });
        expect(defaultRes.ok()).toBeTruthy();
      }

      if (evidenceDir && fs.existsSync(evidenceDir)) {
        await openPrintersTab(page);
        await page.screenshot({
          path: path.join(evidenceDir, '15_settings_xp58_extra_large_printer.png'),
          fullPage: false,
        });
      }

      // Adversarial check: backend rejects unrecognized text_size values on POST and PUT
      const badPost = await page.request.post(`${BASE}/api/printers`, {
        headers,
        data: {
          name: 'Bad Text Size Printer',
          connection_type: 'usb',
          paper_width: 'cols-32',
          text_size: 'gigantic',
        },
      });
      expect(badPost.status()).toBe(400);
      const badPostBody = (await badPost.json()) as { error: string };
      expect(badPostBody.error).toContain('text_size must be normal, large, or extra_large');

      const badPut = await page.request.put(`${BASE}/api/printers/${createdPrinterId}`, {
        headers,
        data: { text_size: 'gigantic' },
      });
      expect(badPut.status()).toBe(400);

      // 3. Switch Print Method to Browser Print and trigger a live receipt print from /orders
      await openPrintersTab(page);
      const pmSelect = page
        .getByText('Print Method', { exact: true })
        .first()
        .locator('xpath=following-sibling::select[1]');
      await pmSelect.selectOption('browser');
      if (
        await saveChanges(page)
          .isVisible()
          .catch(() => false)
      ) {
        await saveAndReloadPrintersTab(page);
      }

      // Create a disposable order and generate its bill via API so /orders has a bill ready to print
      const orderRes = await page.request.post(`${BASE}/api/orders`, {
        headers,
        data: {
          type: 'takeaway',
          items: [{ product_id: 'e2e-product', quantity: 2 }],
        },
      });
      expect(orderRes.ok()).toBeTruthy();
      const { order } = (await orderRes.json()) as { order: { id: number; order_number: string } };

      const billRes = await page.request.post(`${BASE}/api/bills/generate`, {
        headers,
        data: { order_id: order.id },
      });
      expect(billRes.ok()).toBeTruthy();

      // Trigger printBill through the live /orders UI in the running browser app and inspect the popup
      await page.goto(`${BASE}/orders`);
      await page.waitForLoadState('networkidle');
      const orderRow = page.getByText(order.order_number).first();
      await expect(orderRow).toBeVisible({ timeout: 15_000 });
      await orderRow.click();

      type PrintHookWindow = Window & {
        __capturedPrintPopupHtml?: string;
        __origOpen?: typeof window.open;
      };

      await page.evaluate(() => {
        const win = window as PrintHookWindow;
        win.__capturedPrintPopupHtml = '';
        const origOpen = window.open;
        win.__origOpen = origOpen;
        window.open = (() => {
          const docParts: string[] = [];
          const fakeWin = {
            closed: false,
            document: {
              readyState: 'complete',
              open() {},
              write(chunk: string) {
                docParts.push(chunk);
                win.__capturedPrintPopupHtml = docParts.join('');
              },
              close() {},
            },
            print() {},
            close() {
              this.closed = true;
            },
          };
          return fakeWin as unknown as Window;
        }) as typeof window.open;
      });

      const printIconBtn = page.locator('button[title="Print"], button[title="Reprint"]').first();
      await expect(printIconBtn).toBeVisible({ timeout: 15_000 });
      await printIconBtn.click();

      const confirmPrintBtn = page.getByRole('button', { name: /^Confirm (Print|Reprint)$/ });
      await expect(confirmPrintBtn).toBeVisible({ timeout: 10_000 });
      await confirmPrintBtn.click();

      await expect
        .poll(
          async () =>
            await page.evaluate(
              () => String((window as PrintHookWindow).__capturedPrintPopupHtml || '').length,
            ),
          { timeout: 15_000 },
        )
        .toBeGreaterThan(200);

      const capturedHtml = await page.evaluate(() => {
        const win = window as PrintHookWindow;
        if (win.__origOpen) {
          window.open = win.__origOpen;
        }
        return String(win.__capturedPrintPopupHtml || '');
      });

      expect(capturedHtml).toContain('@page { size: 58mm auto; margin: 0; }');
      expect(capturedHtml).toContain(
        '.items-table td { color: #000; border-bottom: 1px dashed #000; font-size: 17px; font-weight: 700; }',
      );
      expect(capturedHtml).not.toMatch(/#(?:c00|ccc|eee|333|555|666|888)/i);

      if (evidenceDir && fs.existsSync(evidenceDir)) {
        const popupHtmlPath = path.join(evidenceDir, '16_live_orders_browser_print_xp58_xl.html');
        fs.writeFileSync(popupHtmlPath, capturedHtml, 'utf8');
        const previewPage = await page.context().newPage();
        await previewPage.setViewportSize({ width: 480, height: 900 });
        await previewPage.setContent(capturedHtml, { waitUntil: 'load' });
        const billContainer = previewPage.locator('.bill-container');
        await billContainer.screenshot({
          path: path.join(evidenceDir, '16_live_orders_browser_print_xp58_xl.png'),
        });
        await previewPage.close();
      }
    } finally {
      if (createdPrinterId) {
        const cleanupListRes = await page.request
          .get(`${BASE}/api/printers`, { headers })
          .catch(() => null);
        const cleanupPrinters = cleanupListRes?.ok()
          ? (((await cleanupListRes.json()) as { printers: Array<{ id: string }> }).printers ?? [])
          : [];
        if (cleanupPrinters.length > 1) {
          await page.request
            .delete(`${BASE}/api/printers/${createdPrinterId}`, { headers })
            .catch(() => undefined);
        }
      }
      await openPrintersTab(page);
      const pmSelect = page
        .getByText('Print Method', { exact: true })
        .first()
        .locator('xpath=following-sibling::select[1]');
      await pmSelect.selectOption(originalMethod);
      if (
        await saveChanges(page)
          .isVisible()
          .catch(() => false)
      ) {
        await saveAndReloadPrintersTab(page);
      }
    }
  });
});
