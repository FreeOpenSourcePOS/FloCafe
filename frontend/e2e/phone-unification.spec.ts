import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join(os.tmpdir(), 'no-mistakes-evidence', '01M017SAY4WPNZWT0YAB197D9H');
if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

test('Frontend Phone Unification End-to-End Visual Suite (Issue #263)', async ({ page }) => {
  // Log in as owner for full administrative access
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: 15000 });
  await setLanguage(page, 'en');

  // ── 1. Customer Management: validates, normalizes, clears, and updates phone numbers ──
    await page.goto(`${BASE}/customers`);
    await expect(page.locator('table')).toBeVisible();

    // 1. Add customer with local Thai/national phone
    const addBtn = page.getByRole('button', { name: /Add Customer|Add/i }).first();
    await addBtn.click();

    // Target the input elements inside the modal form specifically
    const modal = page.locator('.fixed.inset-0 form');
    await expect(modal).toBeVisible();

    await modal.locator('input[type="text"]').first().fill('Somchai Prasert');
    await modal.locator('input[type="tel"]').fill('0812345678');

    const addModalScreenshot = path.join(EVIDENCE_DIR, '01-customers-add-modal.png');
    await page.screenshot({ path: addModalScreenshot });

    await modal.locator('button[type="submit"]').click();
    await expect(modal).not.toBeVisible();
    await expect(page.locator('table')).toContainText('Somchai Prasert');
    // For TH tenant (+66), 0812345678 normalizes to +66812345678
    await expect(page.locator('table')).toContainText('+66812345678');

    const tableNormalizedScreenshot = path.join(EVIDENCE_DIR, '02-customers-table-normalized.png');
    await page.screenshot({ path: tableNormalizedScreenshot });

    // 2. Reject invalid phone number
    await addBtn.click();
    await expect(modal).toBeVisible();
    await modal.locator('input[type="text"]').first().fill('Invalid Phone Customer');
    await modal.locator('input[type="tel"]').fill('12345');
    await modal.locator('button[type="submit"]').click();

    // Should see error toast and modal stays open
    const errorToast = page.locator('.react-hot-toast, [role="status"]').first();
    await expect(errorToast).toBeVisible({ timeout: 5000 });
    const invalidToastScreenshot = path.join(EVIDENCE_DIR, '03-customers-invalid-phone-toast.png');
    await page.screenshot({ path: invalidToastScreenshot });

    // Close add modal
    const closeBtn = page.locator('.fixed.inset-0 button:has(svg.lucide-x), .fixed.inset-0 button').first();
    await closeBtn.click();

    // 3. Clear phone number on existing customer edit
    const row = page.locator('tr:has-text("Somchai Prasert")');
    await row.locator('button').first().click(); // edit button
    await expect(modal).toBeVisible();

    await modal.locator('input[type="tel"]').fill('');
    const editClearedModalScreenshot = path.join(EVIDENCE_DIR, '04-customers-edit-modal-cleared.png');
    await page.screenshot({ path: editClearedModalScreenshot });

    await modal.locator('button[type="submit"]').click();
    await expect(modal).not.toBeVisible();

    // Verify phone is cleared in the customer table
    await expect(page.locator('tr:has-text("Somchai Prasert")')).not.toContainText('+66812345678');
    const tableClearedScreenshot = path.join(EVIDENCE_DIR, '05-customers-table-phone-cleared.png');
    await page.screenshot({ path: tableClearedScreenshot });

    // 4. Update customer with international phone format
    await row.locator('button').first().click();
    await expect(modal).toBeVisible();
    await modal.locator('input[type="tel"]').fill('+1 650 253 0000');
    await modal.locator('button[type="submit"]').click();
    await expect(modal).not.toBeVisible();

    await expect(page.locator('tr:has-text("Somchai Prasert")')).toContainText('+16502530000');
    const tableIntlScreenshot = path.join(EVIDENCE_DIR, '06-customers-table-intl-phone.png');
    await page.screenshot({ path: tableIntlScreenshot });

    // ── 2. Business Settings: normalizes and validates business contact phone ──
    await page.goto(`${BASE}/settings`);
    await page.waitForLoadState('networkidle');

    // Locate the phone input in business information section
    const phoneInput = page.locator('div:has(> label:has-text("Phone")) input').first();
    await expect(phoneInput).toBeVisible();

    // 1. Enter local national phone format
    await phoneInput.fill('0898765432');
    const saveBtn = page.getByRole('button', { name: /Save Changes/i });
    await saveBtn.click();

    // Verify normalization in input
    await expect(phoneInput).toHaveValue('+66898765432');
    const settingsNormalizedScreenshot = path.join(EVIDENCE_DIR, '07-settings-business-phone-normalized.png');
    await page.screenshot({ path: settingsNormalizedScreenshot });

    // 2. Reject invalid phone format
    await phoneInput.fill('invalid-phone-123');
    await saveBtn.click();
    const settingsErrorToast = page.locator('.react-hot-toast, [role="status"]').first();
    await expect(settingsErrorToast).toBeVisible({ timeout: 5000 });
    const settingsInvalidToastScreenshot = path.join(EVIDENCE_DIR, '08-settings-business-phone-invalid-toast.png');
    await page.screenshot({ path: settingsInvalidToastScreenshot });

    // 3. Clear phone and save
    await phoneInput.fill('');
    await saveBtn.click();
    await expect(phoneInput).toHaveValue('');
    const settingsClearedScreenshot = path.join(EVIDENCE_DIR, '09-settings-business-phone-cleared.png');
    await page.screenshot({ path: settingsClearedScreenshot });

    // ── 3. WhatsApp Blocklist: normalizes entered phone with tenant country ──
    await page.goto(`${BASE}/whatsapp`);
    await page.waitForLoadState('networkidle');

    // WhatsApp blocklist form inputs
    const blockPhoneInput = page.locator('input[placeholder*="+66" i], input[inputmode="tel"], input[placeholder*="+CC" i]').first();
    await expect(blockPhoneInput).toBeVisible();

    await blockPhoneInput.fill('0812345678');
    const blockReasonInput = page.locator('input[placeholder*="reason" i], input[placeholder*="Reason" i]').first();
    if (await blockReasonInput.count() > 0) {
      await blockReasonInput.fill('Spam / Marketing bot');
    }

    const blockFormScreenshot = path.join(EVIDENCE_DIR, '10-whatsapp-blocklist-form.png');
    await page.screenshot({ path: blockFormScreenshot });

    const blockCta = page.getByRole('button', { name: /^Add$/i }).first();
    await blockCta.click();

    // Verify normalized E.164 phone appears in blocklist table
    await expect(page.locator('table')).toContainText('+66812345678');
    const whatsappBlocklistScreenshot = path.join(EVIDENCE_DIR, '11-whatsapp-blocklist-normalized.png');
    await page.screenshot({ path: whatsappBlocklistScreenshot });
});
