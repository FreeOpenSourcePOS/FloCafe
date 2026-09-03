import { test, expect, Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';

/** Phase 7 browser coverage for visible print-test labels across every locale. */

const LABELS: Record<string, { basic: string; web: string; whatsapp: string }> = {
  en: { basic: 'Basic Receipt (Thermal)', web: 'Web Print (Browser)', whatsapp: 'WhatsApp Share' },
  es: { basic: 'Recibo básico (térmica)', web: 'Impresión web (navegador)', whatsapp: 'Compartir por WhatsApp' },
  fr: { basic: 'Reçu simple (thermique)', web: 'Impression web (navigateur)', whatsapp: 'Partage WhatsApp' },
  pt: { basic: 'Comprovante Básico (Térmico)', web: 'Impressão web (navegador)', whatsapp: 'Compartilhamento via WhatsApp' },
  de: { basic: 'Einfacher Kassenbon (Thermodruck)', web: 'Webdruck (Browser)', whatsapp: 'Über WhatsApp teilen' },
  tr: { basic: 'Temel Fiş (Termal)', web: 'Web Yazdırma (Tarayıcı)', whatsapp: 'WhatsApp Paylaşımı' },
  fil: { basic: 'Basic Resibo (Thermal)', web: 'Web Print (Browser)', whatsapp: 'Ibahagi sa WhatsApp' },
  fa: { basic: 'رسید ساده (حرارتی)', web: 'چاپ وب (مرورگر)', whatsapp: 'اشتراک‌گذاری واتساپ' },
};

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
}

test('print-test visible labels use the selected UI locale', async ({ page }) => {
  await loginAsOwner(page);
  try {
    for (const [language, labels] of Object.entries(LABELS)) {
      await setLanguage(page, language);
      await page.goto(`${BASE}/print-test`);
      await expect(page.getByRole('button', { name: labels.basic, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: labels.web, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: labels.whatsapp, exact: true })).toBeVisible();
    }
  } finally {
    await setLanguage(page, 'en').catch(() => {});
  }
});
