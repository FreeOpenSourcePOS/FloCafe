/**
 * web-print.ts
 *
 * Thermal-width bill printing using the browser's native print dialog —
 * the fallback path for merchants without an ESC/POS hardware printer.
 * Generates HTML that can be printed silently or shown to user.
 *
 * Browser receipts are full HTML, not raw ESC/POS bytes, so they never apply
 * the ASCII currency fallback or `ریال → IRR` downgrade used by the thermal
 * encoders. They follow the tenant's locale preferences (currency display,
 * digit mode, calendar) and the active UI language, and render RTL with
 * isolated LTR islands for Persian (fa).
 */

import type { Bill, Tenant } from '@/lib/types';
import toast from 'react-hot-toast';
import {
  getCountryByCode,
  formatCurrencyForTenant,
  formatNumberForTenant,
  formatDateForTenant,
} from '@/lib/countries';
import { formatTaxComponentLabel, resolveTaxComponents } from './tax-components';
import { RECEIPT_BRANDING_NAME, RECEIPT_BRANDING_URL } from './branding';
import { createTranslator } from 'use-intl/core';
import { getCachedMessages, loadLocaleMessages } from '@/lib/i18n/loader';
import { LANGUAGES, getLanguageDirection, type Language } from '@/lib/i18n/languages';
import { usePosSettingsStore } from '@/store/pos-settings';
import { parseDbTimestamp } from '@/lib/utils';

export type PaperSize = 'thermal58' | 'thermal80';

/** The slice of a tenant a browser receipt needs to render locale-correctly. */
export type ReceiptTenant = Pick<
  Tenant,
  'business_name' | 'currency' | 'country' | 'timezone' | 'currency_display' | 'number_digits' | 'calendar'
>;

/** Encodes HTML entity characters so database-sourced values can't inject markup/scripts into the bill print window. */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wraps inherently-LTR content (bill numbers, phones, tax IDs) in a bidi-isolated LTR span. */
function ltrSpan(value: unknown): string {
  return `<span class="ltr" dir="ltr">${escapeHtml(value)}</span>`;
}

export interface WebPrintOptions {
  paperSize?: PaperSize;
  includeTaxId?: boolean;
  taxRegistrationNumber?: string;
  address?: string;
  phone?: string;
  footerNote?: string;
  businessName?: string;
  showBusinessName?: boolean;
  showTaxBreakdown?: boolean;
  showCustomerName?: boolean;
  showCustomerPhone?: boolean;
  showTableNumber?: boolean;
  /** Ignored for browser receipts: HTML always renders Unicode currency symbols. */
  useUnicode?: boolean;
  /** Show a large "REPRINT" banner so a reprinted bill can't be mistaken for the original. */
  isReprint?: boolean;
  /** Hide trailing .00 on printed amounts while keeping non-zero decimals. */
  trimDecimals?: boolean;
  /** UI language for receipt labels (defaults to the active store language). */
  language?: Language;
}

/** Resolve the active UI language, falling back to `en` outside the client store. */
function resolveLanguage(language?: Language): Language {
  if (language) return language;
  try {
    return usePosSettingsStore.getState().language;
  } catch {
    return 'en';
  }
}

/**
 * Synchronous receipt translator backed by the shared locale loader cache.
 * English is primed at module load; other languages resolve once their bundle
 * has been loaded on demand (#375). Falls back to English so a receipt always
 * renders without raw keys.
 */
function getReceiptTranslator(lang: Language): (key: string) => string {
  const locale = LANGUAGES[lang]?.locale ?? 'en';
  const messages = getCachedMessages(lang) ?? getCachedMessages('en') ?? {};
  // `createTranslator` resolves dotted keys against the whole message tree;
  // the cached messages are untyped (Record<string, unknown>), so the returned
  // translator accepts arbitrary string keys at runtime.
  return createTranslator({ locale, messages }) as unknown as (key: string) => string;
}

/** Static receipt labels in the active UI language. */
function receiptLabels(lang: Language) {
  const t = getReceiptTranslator(lang);
  return {
    billNumber: t('receipt.billNumber'),
    date: t('receipt.date'),
    table: t('receipt.table'),
    customer: t('pos.customer'),
    customerNo: t('receipt.customerNo'),
    phone: t('receipt.phone'),
    item: t('receipt.item'),
    qty: t('receipt.qty'),
    rate: t('receipt.rate'),
    amount: t('receipt.amount'),
    taxDetails: t('receipt.taxDetails'),
    subtotal: t('pos.subtotal'),
    discount: t('pos.discount'),
    totalTax: t('receipt.totalTax'),
    serviceCharge: t('receipt.serviceCharge'),
    deliveryCharge: t('receipt.deliveryCharge'),
    grandTotal: t('receipt.grandTotal'),
    payments: t('receipt.payments'),
    thankYou: t('receipt.thankYou'),
    taxIncluded: t('receipt.taxIncluded'),
    printBill: t('receipt.printBill'),
    reprint: t('receipt.reprint'),
  };
}

/**
 * Tax-id label printed on the receipt. Country-profile labels are acronyms or
 * proper nouns (GSTIN, CUIT, …) and stay as-is; Iran's "Economic Code" is
 * localized so a Persian receipt doesn't show an English phrase.
 */
function resolveTaxIdLabel(country: string | undefined, lang: Language): string {
  if (country?.toUpperCase() === 'IR') return getReceiptTranslator(lang)('receipt.economicCode');
  return getCountryByCode(country ?? 'IN')?.taxIdLabel || 'Tax ID';
}

const PAYMENT_METHOD_KEYS: Record<string, string> = {
  cash: 'pos.methodCash',
  card: 'pos.methodCard',
  wallet: 'pos.methodWallet',
};

function resolvePaymentMethodLabel(method: string, lang: Language): string {
  const key = PAYMENT_METHOD_KEYS[method.toLowerCase()];
  if (key) return getReceiptTranslator(lang)(key);
  return method.charAt(0).toUpperCase() + method.slice(1);
}

/**
 * Ensure the requested receipt language messages are loaded in memory (#377).
 */
export async function ensureReceiptMessagesLoaded(lang: Language): Promise<void> {
  await loadLocaleMessages(lang).catch(() => {});
}

/**
 * Generate HTML for A4/A5 printing and open print dialog.
 *
 * NOTE: The popup window is opened synchronously within the initiating user gesture
 * to preserve browser user activation (preventing popup blocker suppression), and
 * HTML is written into the window once requested language messages are ready.
 */
export async function printWebBill(
  bill: Bill,
  tenant: ReceiptTenant,
  opts: WebPrintOptions = {}
): Promise<void> {
  const lang = resolveLanguage(opts.language);

  // 1. Open popup window synchronously to maintain transient user activation
  const printWindow = typeof window !== 'undefined' ? window.open('', '_blank', 'width=800,height=600') : null;
  if (!printWindow) {
    toast.error('Please allow popups to print bills');
    throw new Error('Popup window was blocked by browser');
  }

  // 2. Ensure the requested language messages are loaded in memory
  await ensureReceiptMessagesLoaded(lang);
  const html = generateBillHtml(bill, tenant, opts);

  // 3. Write HTML and trigger print
  if (printWindow.closed) {
    throw new Error('Print window was closed before receipt could be printed');
  }

  return new Promise<void>((resolve, reject) => {
    try {
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();

      const triggerPrint = () => {
        try {
          if (printWindow.closed) {
            reject(new Error('Print window was closed before receipt could be printed'));
            return;
          }
          printWindow.print();
          resolve();
        } catch (err) {
          console.error('Failed to trigger print on window:', err);
          toast.error('Failed to open print dialog');
          reject(err);
        }
      };

      if (printWindow.document.readyState === 'complete') {
        triggerPrint();
      } else {
        printWindow.onload = () => {
          triggerPrint();
        };
      }
    } catch (err) {
      console.error('Failed to write receipt to print window:', err);
      toast.error('Failed to open print dialog');
      reject(err);
    }
  });
}

/**
 * Generate HTML string for the bill (without opening print dialog).
 * Useful for preview or PDF generation.
 */
export function generateBillHtml(
  bill: Bill,
  tenant: ReceiptTenant,
  opts: WebPrintOptions = {}
): string {
  const {
    paperSize = 'thermal58',
    includeTaxId = false,
    taxRegistrationNumber,
    address,
    phone,
    footerNote,
    businessName,
    showBusinessName = true,
    showTaxBreakdown = true,
    showCustomerName = true,
    showCustomerPhone = true,
    showTableNumber = true,
    isReprint = false,
    trimDecimals = false,
  } = opts;

  const lang = resolveLanguage(opts.language);
  const dir = getLanguageDirection(lang);
  const localeTag = LANGUAGES[lang]?.locale ?? lang;
  const L = receiptLabels(lang);
  const displayName = showBusinessName ? (businessName ?? tenant.business_name) : '';
  const taxIdLabel = resolveTaxIdLabel(tenant.country, lang);
  const order = bill.order;

  const styles = getPaperStyles(paperSize);
  const taxComponents = resolveTaxComponents(bill);
  const hasTax = Number(bill.tax_amount) !== 0
    || taxComponents.some((component) => Number(component.amount) !== 0);

  const items = order?.items ?? [];
  const fmtAmount = (value: number | string) => formatAmount(value, tenant, trimDecimals);
  const fmtQuantity = (value: number | string) => formatNumberForTenant(
    Number(value) || 0,
    tenant.country,
    { digits: tenant.number_digits },
  );

  return `<!DOCTYPE html>
<html lang="${localeTag}" dir="${dir}">
<head>
  <meta charset="utf-8">
  <title>${L.billNumber} ${escapeHtml(bill.bill_number)}</title>
  <style>
    ${styles}
    @media print {
      .no-print { display: none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="bill-container">
    ${isReprint ? `<div class="reprint-banner">${escapeHtml(L.reprint)}</div>` : ''}
    <!-- Header -->
    <div class="header">
      ${displayName ? `<h1>${escapeHtml(displayName)}</h1>` : ''}
      ${address ? `<p>${escapeHtml(address).replace(/\n/g, '<br>')}</p>` : ''}
      ${phone ? `<p>${escapeHtml(L.phone)}: ${ltrSpan(phone)}</p>` : ''}
      ${includeTaxId && taxRegistrationNumber ? `<p>${escapeHtml(taxIdLabel)}: ${ltrSpan(taxRegistrationNumber)}</p>` : ''}
    </div>

    <!-- Bill Details -->
    <div class="bill-details">
      <table>
        <tr>
          <td><strong>${escapeHtml(L.billNumber)}</strong> ${ltrSpan(bill.bill_number)}</td>
          <td class="text-end"><strong>${escapeHtml(L.date)}</strong> ${escapeHtml(formatReceiptDate(order?.created_at, tenant))}</td>
        </tr>
        ${showTableNumber && order?.table?.name ? `<tr><td><strong>${escapeHtml(L.table)}</strong> ${escapeHtml(order.table.name)}</td><td></td></tr>` : ''}
        ${showCustomerName && order?.customer?.name ? `<tr><td><strong>${escapeHtml(L.customer)}</strong> ${escapeHtml(order.customer.name)}</td><td></td></tr>` : ''}
        ${showCustomerPhone && order?.customer?.phone ? `<tr><td><strong>${escapeHtml(L.customerNo)}</strong> ${ltrSpan(order.customer.phone)}</td><td></td></tr>` : ''}
      </table>
    </div>

    <!-- Items Table -->
    <table class="items-table">
      <thead>
        <tr>
          <th>${escapeHtml(L.item)}</th>
          <th class="text-end">${escapeHtml(L.qty)}</th>
          <th class="text-end">${escapeHtml(L.rate)}</th>
          <th class="text-end">${escapeHtml(L.amount)}</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
          <tr>
            <td>
              ${escapeHtml(item.product_name)}
              ${item.addons && item.addons.length > 0 ? `<br><small class="text-muted">${item.addons.map(a => `+ ${escapeHtml(a.name)}${(a.quantity || 1) > 1 ? ` ×${escapeHtml(a.quantity)}` : ''}`).join(', ')}</small>` : ''}
              ${item.special_instructions ? `<br><small class="text-italic">${escapeHtml(item.special_instructions)}</small>` : ''}
            </td>
            <td class="text-end num">${fmtQuantity(item.quantity)}</td>
            <td class="text-end num">${fmtAmount(Number(item.unit_price))}</td>
            <td class="text-end num">${fmtAmount(item.total)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <!-- Tax Breakdown -->
    ${showTaxBreakdown && taxComponents.length > 0 ? `
    <table class="tax-table">
      <thead>
        <tr><th colspan="2">${escapeHtml(L.taxDetails)}</th></tr>
      </thead>
      <tbody>
        ${taxComponents.map((component) => `
          <tr><td>${escapeHtml(formatTaxComponentLabel(component))}</td><td class="text-end num">${fmtAmount(component.amount)}</td></tr>
        `).join('')}
      </tbody>
    </table>
    ` : ''}

    <!-- Totals -->
    <table class="totals-table">
      <tr><td>${escapeHtml(L.subtotal)}</td><td class="text-end num">${fmtAmount(bill.subtotal)}</td></tr>
      ${Number(bill.discount_amount) > 0 ? `<tr><td>${escapeHtml(L.discount)}</td><td class="text-end num">-${fmtAmount(bill.discount_amount)}</td></tr>` : ''}
      ${Number(bill.tax_amount) > 0 ? `<tr><td>${escapeHtml(L.totalTax)}</td><td class="text-end num">${fmtAmount(bill.tax_amount)}</td></tr>` : ''}
      ${Number(bill.service_charge) > 0 ? `<tr><td>${escapeHtml(L.serviceCharge)}</td><td class="text-end num">${fmtAmount(bill.service_charge)}</td></tr>` : ''}
      ${Number(bill.delivery_charge) > 0 ? `<tr><td>${escapeHtml(L.deliveryCharge)}</td><td class="text-end num">${fmtAmount(bill.delivery_charge)}</td></tr>` : ''}
      <tr class="total-row"><td><strong>${escapeHtml(L.grandTotal)}</strong></td><td class="text-end num"><strong>${fmtAmount(bill.total)}</strong></td></tr>
    </table>

    <!-- Payments -->
    ${bill.payment_details && bill.payment_details.length > 0 ? `
    <table class="payments-table">
      <thead>
        <tr><th colspan="2">${escapeHtml(L.payments)}</th></tr>
      </thead>
      <tbody>
        ${bill.payment_details.map(p => `
          <tr><td>${escapeHtml(resolvePaymentMethodLabel(p.method, lang))}</td><td class="text-end num">${fmtAmount(p.amount)}</td></tr>
        `).join('')}
      </tbody>
    </table>
    ` : ''}

    <!-- Footer -->
    <div class="footer">
      ${footerNote ? `<p>${escapeHtml(footerNote)}</p>` : `<p>${escapeHtml(L.thankYou)}</p>`}
      ${hasTax ? `<p>${escapeHtml(L.taxIncluded)}</p>` : ''}
      <p class="powered-by">${escapeHtml(RECEIPT_BRANDING_NAME)}<br>${escapeHtml(RECEIPT_BRANDING_URL)}</p>
    </div>
  </div>

  <div class="no-print" style="text-align:center;margin-top:20px;">
    <button onclick="window.print()" style="padding:10px 20px;font-size:16px;cursor:pointer;">${escapeHtml(L.printBill)}</button>
  </div>
</body>
</html>
  `;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPaperStyles(size: PaperSize): string {
  const baseStyles = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Segoe UI', Tahoma, 'Noto Naskh Arabic', 'Helvetica Neue', Arial, sans-serif; font-size: 12px; line-height: 1.4; color: #333; }
    .bill-container { max-width: 100%; margin: 0 auto; }
    .reprint-banner { text-align: center; font-size: 22px; font-weight: bold; letter-spacing: 2px; color: #c00; border: 3px solid #c00; padding: 6px; margin-bottom: 15px; }
    .header { text-align: center; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #ccc; }
    .header h1 { font-size: 24px; margin-bottom: 5px; }
    .bill-details { margin-bottom: 15px; }
    .bill-details table { width: 100%; }
    .items-table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
    .items-table th, .items-table td { padding: 8px; border-bottom: 1px solid #eee; text-align: start; }
    .items-table th { background: #f5f5f5; font-weight: bold; }
    .tax-table, .payments-table { width: 50%; margin-inline-start: 50%; border-collapse: collapse; margin-bottom: 15px; }
    .tax-table th, .tax-table td, .payments-table th, .payments-table td { padding: 6px 8px; }
    .tax-table th, .payments-table th { background: #f9f9f9; text-align: start; }
    .totals-table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
    .totals-table td { padding: 6px 8px; }
    .total-row { border-top: 2px solid #333; font-size: 16px; }
    .footer { text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #ccc; }
    .powered-by { font-size: 10px; margin-top: 8px; color: #555; }
    .text-end { text-align: end !important; }
    .num { unicode-bidi: isolate; white-space: nowrap; }
    .ltr { direction: ltr; unicode-bidi: isolate; }
    .text-muted { color: #666; }
    .text-italic { font-style: italic; color: #888; }
  `;

  switch (size) {
    case 'thermal58':
      return baseStyles + `
        .bill-container { padding: 5px; max-width: 58mm; font-size: 10px; }
        .header h1 { font-size: 14px; }
        .items-table th, .items-table td, .tax-table td, .totals-table td, .payments-table td { padding: 2px 4px; }
      `;
    case 'thermal80':
      return baseStyles + `
        .bill-container { padding: 10px; max-width: 80mm; font-size: 11px; }
        .header h1 { font-size: 16px; }
      `;
    default:
      return baseStyles;
  }
}

/**
 * Format an amount following the tenant's currency display (Iran rial/toman),
 * digit mode, and `trimDecimals` preference. Browser output is always Unicode.
 */
function formatAmount(value: number | string, tenant: ReceiptTenant, trimDecimals = false): string {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
  const prefs = { currencyDisplay: tenant.currency_display, digits: tenant.number_digits };
  const hasDecimals = Math.round(numeric * 100) % 100 !== 0;
  const isToman =
    (tenant.currency === 'IRR' || (!tenant.currency && tenant.country === 'IR')) &&
    (tenant.currency_display === 'toman' || tenant.currency_display === 'toman_short');

  // trimDecimals hides trailing .00 only when there is no fractional part.
  if (trimDecimals && !hasDecimals && !isToman) {
    const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
    const numberingSystem = tenant.number_digits === 'latin' ? 'latn' : undefined;
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: tenant.currency || 'INR',
        currencyDisplay: 'narrowSymbol',
        ...(numberingSystem ? { numberingSystem } : {}),
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(numeric);
    } catch {
      return formatCurrencyForTenant(numeric, tenant.country, tenant.currency, prefs);
    }
  }

  return formatCurrencyForTenant(numeric, tenant.country, tenant.currency, prefs);
}

function formatReceiptDate(iso: string | undefined, tenant: ReceiptTenant): string {
  if (!iso) return '';
  try {
    const d = parseDbTimestamp(iso);
    if (isNaN(d.getTime())) return iso;
    return formatDateForTenant(
      d,
      tenant.country,
      tenant.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      { digits: tenant.number_digits, calendar: tenant.calendar },
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    );
  } catch {
    return iso;
  }
}
