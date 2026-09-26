import { test, expect, Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';
import { LANGUAGES } from '../src/lib/i18n/languages';

/** Phase 7 browser coverage for visible print-test labels across every locale. */

const LABELS: Record<string, { basic: string; web: string; whatsapp: string }> = {
  en: { basic: 'Basic Receipt (Thermal)', web: 'Web Print (Browser)', whatsapp: 'WhatsApp Share' },
  es: { basic: 'Recibo básico (térmica)', web: 'Impresión web (navegador)', whatsapp: 'Compartir por WhatsApp' },
  fr: { basic: 'Reçu simple (thermique)', web: 'Impression web (navigateur)', whatsapp: 'Partage WhatsApp' },
  pt: { basic: 'Comprovante Básico (Térmico)', web: 'Impressão web (navegador)', whatsapp: 'Compartilhamento via WhatsApp' },
  ru: { basic: 'Базовый чек (термопринтер)', web: 'Веб-печать (браузер)', whatsapp: 'Поделиться в WhatsApp' },
  de: { basic: 'Einfacher Kassenbon (Thermodruck)', web: 'Webdruck (Browser)', whatsapp: 'Über WhatsApp teilen' },
  tr: { basic: 'Temel Fiş (Termal)', web: 'Web Yazdırma (Tarayıcı)', whatsapp: 'WhatsApp Paylaşımı' },
  fil: { basic: 'Basic Resibo (Thermal)', web: 'Web Print (Browser)', whatsapp: 'Ibahagi sa WhatsApp' },
  fa: { basic: 'رسید ساده (حرارتی)', web: 'چاپ وب (مرورگر)', whatsapp: 'اشتراک‌گذاری واتساپ' },
  ur: { basic: 'بنیادی رسید (تھرمل)', web: 'وب پرنٹ (براؤزر)', whatsapp: 'WhatsApp شیئر' },
  it: { basic: 'Ricevuta base (termica)', web: 'Stampa web (browser)', whatsapp: 'Condivisione WhatsApp' },
  ja: { basic: '基本レシート（感熱）', web: 'ウェブ印刷（ブラウザ）', whatsapp: 'WhatsApp共有' },
  zh: { basic: '基础小票（热敏）', web: '网页打印（浏览器）', whatsapp: 'WhatsApp 分享' },
  'zh-tw': { basic: '基礎收據（熱敏）', web: '網頁列印（瀏覽器）', whatsapp: 'WhatsApp 分享' },
  ko: { basic: '기본 영수증 (열전사)', web: '웹 인쇄 (브라우저)', whatsapp: 'WhatsApp 공유' },
  id: { basic: 'Struk Dasar (Termal)', web: 'Cetak Web (Browser)', whatsapp: 'Bagikan WhatsApp' },
  nl: { basic: 'Basisbon (thermisch)', web: 'Webafdruk (browser)', whatsapp: 'Delen via WhatsApp' },
  hi: { basic: 'मूल रसीद (थर्मल)', web: 'वेब प्रिंट (ब्राउज़र)', whatsapp: 'WhatsApp शेयर' },
  bn: { basic: 'মৌলিক রসিদ (থার্মাল)', web: 'ওয়েব প্রিন্ট (ব্রাউজার)', whatsapp: 'হোয়াটসঅ্যাপ শেয়ার করুন' },
  sq: { basic: 'Dëftesë bazë (termike)', web: 'Printim në web (shfletues)', whatsapp: 'Ndarje përmes WhatsApp' },
  vi: { basic: 'Biên nhận đơn giản (máy in nhiệt)', web: 'In web (trình duyệt)', whatsapp: 'Chia sẻ WhatsApp' },
  th: { basic: 'ใบเสร็จพื้นฐาน (เครื่องพิมพ์ความร้อน)', web: 'พิมพ์เว็บ (เบราว์เซอร์)', whatsapp: 'แชร์ผ่าน WhatsApp' },
  ne: { basic: 'आधारभूत रसिद (थर्मल)', web: 'वेब प्रिन्ट (ब्राउजर)', whatsapp: 'व्हाट्सएप सेयर गर्नुहोस्' },
  ar: { basic: 'إيصال أساسي (حراري)', web: 'الطباعة من الويب (المتصفح)', whatsapp: 'مشاركة عبر WhatsApp' },
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
    // Driven from the registry so a newly registered locale cannot be skipped:
    // a missing LABELS entry fails here instead of silently dropping coverage.
    for (const language of Object.keys(LANGUAGES)) {
      const labels = LABELS[language];
      expect(labels, `print-test label literals are missing for registered locale ${language}`).toBeTruthy();
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
