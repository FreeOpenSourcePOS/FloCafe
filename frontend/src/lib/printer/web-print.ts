/** Thermal-width bill printing using browser print dialog for merchants without hardware printers. */

import type { Bill, Tenant } from '@/lib/types';
import toast from 'react-hot-toast';
import type { PrintWarning } from './warnings';
import {
  getCountryByCode,
  getCurrencyFractionDigits,
  getCurrencySymbol,
  formatCurrencyForTenant,
  formatNumberForTenant,
  formatDateForTenant,
} from '@/lib/countries';
import { parseDbTimestamp } from '@/lib/utils';
import { loadLocaleMessages } from '@/lib/i18n/loader';
import {
  buildFrontendBillDocument,
  ensurePrintLanguagesLoaded,
  printLabelResolver,
  resolveBillPrintLanguages,
} from './print-document';
import { RECEIPT_BRANDING_NAME, RECEIPT_BRANDING_URL } from './branding';
import { LANGUAGES, type Language } from '@/lib/i18n/languages';
import {
  getBlock,
  type BusinessHeaderBlock,
  type CustomerBlock,
  type DirectionalText,
  type DocumentMetaBlock,
  type ItemTableBlock,
  type MessageBlock,
  type PaymentsBlock,
  type TaxBreakdownBlock,
  type TotalsBlock,
} from '@print/document';
import type { ResolvedPrintLanguages, TextDirection } from '@print/types';

export type PaperSize = 'thermal58' | 'thermal80';

/** The slice of a tenant a browser receipt needs to render locale-correctly. */
export type ReceiptTenant = Pick<
  Tenant,
  'business_name' | 'currency' | 'country' | 'timezone' | 'currency_display' | 'number_digits' | 'calendar'
>;

/** Encodes HTML entity characters so database-sourced values can't inject markup/scripts into the bill print window. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render one kernel-annotated value with bidi-isolated LTR span when RTL. */
function directionalValue(value: DirectionalText | null, base: TextDirection): string {
  if (!value) return '';
  if (value.direction === 'ltr' && base === 'rtl') {
    return `<span class="ltr" dir="ltr">${escapeHtml(value.text)}</span>`;
  }
  return escapeHtml(value.text);
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
  /** Ignored for browser receipts: HTML uses locale currency formatting and code fallback. */
  useUnicode?: boolean;
  /** Show a large "REPRINT" banner so a reprinted bill can't be mistaken for the original. */
  isReprint?: boolean;
  /** Hide trailing .00 on printed amounts while keeping non-zero decimals. */
  trimDecimals?: boolean;
  /** UI language used when resolving an inherited receipt language policy. */
  language?: Language;
  /** Resolved receipt languages supplied by the caller's print policy. */
  languages?: ResolvedPrintLanguages;
}

/** Resolve tax-id label printed on receipt (special case for Iranian Economic Code). */
function resolveTaxIdLabel(country: string | undefined, lang: Language): string {
  if (country?.toUpperCase() === 'IR') return printLabelResolver('receipt.economicCode', lang);
  return getCountryByCode(country ?? 'IN')?.taxIdLabel || 'Tax ID';
}

/** Ensure the requested receipt language messages are loaded in memory. */
export async function ensureReceiptMessagesLoaded(lang: Language): Promise<Language[]> {
  try {
    await loadLocaleMessages(lang);
    return [];
  } catch {
    return [lang];
  }
}

/** Generate HTML for A4/A5 printing and open print dialog. */
export async function printWebBill(
  bill: Bill,
  tenant: ReceiptTenant,
  opts: WebPrintOptions = {}
): Promise<PrintWarning[]> {
  const languages = resolvePrintLanguages(opts);

  // 1. Open popup window synchronously to maintain transient user activation
  const printWindow = typeof window !== 'undefined' ? window.open('', '_blank', 'width=800,height=600') : null;
  if (!printWindow) {
    toast.error('Please allow popups to print bills');
    throw new Error('Popup window was blocked by browser');
  }

  // Ensure print languages are loaded before synchronous document build.
  const failedLanguages = await ensurePrintLanguagesLoaded(languages);
  const warnings: PrintWarning[] = failedLanguages.map((language) => ({
    field: 'receipt language',
    text: language,
    message: `Receipt language "${language}" could not be loaded, so English labels were used. Check the locale bundle and retry.`,
    kind: 'locale' as const,
  }));
  const html = generateBillHtml(bill, tenant, { ...opts, languages });

  // 3. Write HTML and trigger print
  if (printWindow.closed) {
    throw new Error('Print window was closed before receipt could be printed');
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const triggerPrint = () => {
      try {
        if (printWindow.closed) {
          settle(new Error('Print window was closed before receipt could be printed'));
          return;
        }
        printWindow.print();
        settle();
      } catch (err) {
        console.error('Failed to trigger print on window:', err);
        toast.error('Failed to open print dialog');
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    };

    try {
      printWindow.document.open();
      printWindow.document.write(html);
      printWindow.document.close();

      if (printWindow.document.readyState === 'complete') {
        triggerPrint();
      } else {
        printWindow.onload = () => {
          triggerPrint();
        };

        // Poll window state to prevent hanging promise if user closes popup while loading
        let elapsed = 0;
        pollTimer = setInterval(() => {
          elapsed += 50;
          if (printWindow.closed) {
            settle(new Error('Print window was closed before receipt could be printed'));
          } else if (printWindow.document.readyState === 'complete' || elapsed >= 3000) {
            triggerPrint();
          }
        }, 50);
      }
    } catch (err) {
      console.error('Failed to write receipt to print window:', err);
      toast.error('Failed to open print dialog');
      settle(err instanceof Error ? err : new Error(String(err)));
    }
  }).then(() => warnings);
}

// Document → HTML rendering
/** Generate HTML string for bill (for preview or PDF generation). */
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

  const languages = resolvePrintLanguages(opts);
  const lang = languages[0] as Language;

  const document = buildFrontendBillDocument(bill, tenant, {
    columns: paperSize === 'thermal80' ? 48 : 42,
    businessName: showBusinessName ? (businessName ?? tenant.business_name) : undefined,
    address,
    phone,
    footerNote,
    taxRegistrationNumber,
    includeTaxId: includeTaxId && !!taxRegistrationNumber,
    taxIdLabel: resolveTaxIdLabel(tenant.country, lang),
    showBusinessName,
    showTaxBreakdown,
    showCustomerName,
    showCustomerPhone,
    showTableNumber,
    isReprint,
    trimDecimals,
    languages,
  });
  const base = document.direction.base;
  const dir = base;
  const localeTag = LANGUAGES[lang]?.locale ?? lang;

  const header = getBlock(document, 'business-header') as BusinessHeaderBlock | undefined;
  const meta = getBlock(document, 'document-meta') as DocumentMetaBlock | undefined;
  const customer = getBlock(document, 'customer') as CustomerBlock | undefined;
  const itemsBlock = getBlock(document, 'item-table') as ItemTableBlock | undefined;
  const breakdown = getBlock(document, 'tax-breakdown') as TaxBreakdownBlock | undefined;
  const totals = getBlock(document, 'totals') as TotalsBlock | undefined;
  const payments = getBlock(document, 'payments') as PaymentsBlock | undefined;
  const messages = getBlock(document, 'message') as MessageBlock | undefined;

  // Presentation labels come from the document or fallback to shared catalog.
  const metaTableLabel = documentLabel(meta?.table?.label, 'pos.tableLabel', lang);
  const L = {
    billNumber: documentLabel(meta?.billNumberLabel, 'receipt.billNumber', lang),
    date: documentLabel(meta?.dateLabel, 'receipt.date', lang),
    table: stripLabelPlaceholder(metaTableLabel),
    customer: documentLabel(customer?.nameLabel, 'pos.customer', lang),
    customerNo: documentLabel(customer?.phoneLabel, 'print.numberShort', lang),
    rate: printLabelResolver('receipt.rate', lang),
    totalTax: surfaceLabel(totals?.tax?.label, 'pos.tax', 'receipt.totalTax', lang),
    deliveryCharge: surfaceLabel(totals?.deliveryCharge?.label, 'pos.delivery', 'receipt.deliveryCharge', lang),
    packagingCharge: documentLabel(totals?.packagingCharge?.label, 'pos.packaging', lang),
    grandTotal: surfaceLabel(totals?.grandTotal?.label, 'print.grandTotal', 'receipt.grandTotal', lang),
    taxDetails: printLabelResolver('receipt.taxDetails', lang),
    paymentsHeader: printLabelResolver('receipt.payments', lang),
    thankYou: surfaceLabel(messages?.thankYou, 'print.thankYouShort', 'receipt.thankYou', lang),
    taxIncluded: printLabelResolver('receipt.taxIncluded', lang),
    printBill: printLabelResolver('receipt.printBill', lang),
  };

  const invoiceNumberLabel = L.billNumber;
  const styles = getPaperStyles(paperSize);

  const items = itemsBlock?.rows ?? [];
  const fmtAmount = (value: number) => formatAmount(value, tenant, trimDecimals);
  const fmtQuantity = (value: number) => formatNumberForTenant(
    Number(value) || 0,
    tenant.country,
    { digits: tenant.number_digits },
  );

  const hasTax = (totals?.tax != null)
    || (breakdown != null && breakdown.lines.length > 0);

  return `<!DOCTYPE html>
<html lang="${localeTag}" dir="${dir}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(invoiceNumberLabel)} ${escapeHtml(meta?.invoiceNumber.text ?? '')}</title>
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
    ${messages?.reprintBanner ? `<div class="reprint-banner">${escapeHtml(messages.reprintBanner.primary)}</div>` : ''}
    ${messages?.onlineOrderBanner ? `<div class="online-order-banner">${escapeHtml(messages.onlineOrderBanner.label.primary)}${messages.onlineOrderBanner.platform.text ? `<div class="online-order-detail">${escapeHtml(messages.onlineOrderBanner.platform.text)}</div>` : ''}${messages.onlineOrderBanner.externalOrderId.text ? `<div class="online-order-detail">#${escapeHtml(messages.onlineOrderBanner.externalOrderId.text)}</div>` : ''}</div>` : ''}
    <!-- Header -->
    <div class="header">
      ${header?.name ? `<h1>${escapeHtml(header.name.text)}</h1>` : ''}
      ${header?.address ? `<p>${escapeHtml(header.address.text).replace(/\n/g, '<br>')}</p>` : ''}
      ${header?.phone && header.phoneLabel ? `<p>${escapeHtml(header.phoneLabel.primary)}: ${directionalValue(header.phone, base)}</p>` : ''}
      ${header?.taxId ? `<p>${escapeHtml(header.taxId.label.primary)}: ${directionalValue(header.taxId.value, base)}</p>` : ''}
    </div>

    <!-- Bill Details -->
    <div class="bill-details">
      <table>
        <tr>
          <td><strong>${escapeHtml(invoiceNumberLabel)}</strong> ${meta ? directionalValue(meta.invoiceNumber, base) : ''}</td>
          <td class="text-end"><strong>${escapeHtml(L.date)}</strong> ${meta ? escapeHtml(formatReceiptDate(meta.timestamp.text, tenant, LANGUAGES[lang]?.locale ?? lang)) : ''}</td>
        </tr>
        ${meta?.table ? `<tr><td><strong>${escapeHtml(L.table)}</strong> ${escapeHtml(meta.table.name.text)}</td><td></td></tr>` : ''}
        ${customer?.name ? `<tr><td><strong>${escapeHtml(L.customer)}</strong> ${escapeHtml(customer.name.text)}</td><td></td></tr>` : ''}
        ${customer?.phone ? `<tr><td><strong>${escapeHtml(L.customerNo)}</strong> ${directionalValue(customer.phone, base)}</td><td></td></tr>` : ''}
      </table>
    </div>

    <!-- Items Table -->
    <table class="items-table">
      <thead>
        <tr>
          <th>${escapeHtml(itemsBlock?.header.item.primary ?? '')}</th>
          <th class="text-end">${escapeHtml(itemsBlock?.header.quantity.primary ?? '')}</th>
          <th class="text-end">${escapeHtml(L.rate)}</th>
          <th class="text-end">${escapeHtml(itemsBlock?.header.amount.primary ?? '')}</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(row => `
          <tr>
            <td>
              ${escapeHtml(row.name.text)}
              ${row.addons.length > 0 ? `<br><small class="text-muted">${row.addons.map(a => `+ ${escapeHtml(a.name.text)}${(a.quantity ?? 1) > 1 ? ` ×${escapeHtml(a.quantity)}` : ''}`).join(', ')}</small>` : ''}
              ${row.specialInstructions ? `<br><small class="text-italic">${escapeHtml(row.specialInstructions.text)}</small>` : ''}
            </td>
            <td class="text-end num">${fmtQuantity(row.quantity)}</td>
            <td class="text-end num">${fmtAmount(row.unitPrice ?? 0)}</td>
            <td class="text-end num">${fmtAmount(row.amount)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <!-- Tax Breakdown -->
    ${breakdown && breakdown.lines.length > 0 ? `
    <table class="tax-table">
      <thead>
        <tr><th colspan="2">${escapeHtml(L.taxDetails)}</th></tr>
      </thead>
      <tbody>
        ${breakdown.lines.map((line) => `
          <tr><td>${escapeHtml(line.rate === null ? line.label.primary : `${line.label.primary} @${line.rate}%`)}</td><td class="text-end num">${fmtAmount(line.amount)}</td></tr>
        `).join('')}
      </tbody>
    </table>
    ` : ''}

    <!-- Totals -->
    <table class="totals-table">
      ${totals ? `
      ${totals.pointsRedeemed ? `<tr><td>${escapeHtml(totals.pointsRedeemed.label.primary)}</td><td class="text-end num">-${escapeHtml(totals.pointsRedeemed.points)} pts</td></tr>` : ''}
      <tr><td>${escapeHtml(totals.subtotal.label.primary)}</td><td class="text-end num">${fmtAmount(totals.subtotal.amount)}</td></tr>
      ${totals.discount ? `<tr><td>${escapeHtml(totals.discount.label.primary)}</td><td class="text-end num">-${fmtAmount(totals.discount.amount)}</td></tr>` : ''}
      ${totals.tax ? `<tr><td>${escapeHtml(L.totalTax)}</td><td class="text-end num">${fmtAmount(totals.tax.amount)}</td></tr>` : ''}
      ${totals.serviceCharge ? `<tr><td>${escapeHtml(totals.serviceCharge.label.primary)}</td><td class="text-end num">${fmtAmount(totals.serviceCharge.amount)}</td></tr>` : ''}
      ${totals.deliveryCharge ? `<tr><td>${escapeHtml(L.deliveryCharge)}</td><td class="text-end num">${fmtAmount(totals.deliveryCharge.amount)}</td></tr>` : ''}
      ${totals.packagingCharge ? `<tr><td>${escapeHtml(L.packagingCharge)}</td><td class="text-end num">${fmtAmount(totals.packagingCharge.amount)}</td></tr>` : ''}
      <tr class="total-row"><td><strong>${escapeHtml(L.grandTotal)}</strong></td><td class="text-end num"><strong>${fmtAmount(totals.grandTotal.amount)}</strong></td></tr>
      ${totals.pointsEarned ? `<tr><td>${escapeHtml(totals.pointsEarned.label.primary)}</td><td class="text-end num">${escapeHtml(totals.pointsEarned.points)} pts</td></tr>` : ''}
      ${totals.pointsBalance ? `<tr><td>${escapeHtml(totals.pointsBalance.label.primary)}</td><td class="text-end num">${escapeHtml(totals.pointsBalance.points)} pts</td></tr>` : ''}
      ` : ''}
    </table>

    <!-- Payments -->
    ${payments && payments.lines.length > 0 ? `
    <table class="payments-table">
      <thead>
        <tr><th colspan="2">${escapeHtml(L.paymentsHeader)}</th></tr>
      </thead>
      <tbody>
        ${payments.lines.map((line) => `
          <tr><td>${escapeHtml(paymentLineLabel(line.label))}</td><td class="text-end num">${fmtAmount(line.amount)}</td></tr>
        `).join('')}
      </tbody>
    </table>
    ` : ''}

    <!-- Footer -->
    <div class="footer">
      ${messages?.footerNote ? `<p>${escapeHtml(messages.footerNote.text)}</p>` : `<p>${escapeHtml(L.thankYou)}</p>`}
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

// Helpers
/** Resolve the receipt language list through the shared policy bridge. */
function resolvePrintLanguages(opts: Pick<WebPrintOptions, 'language' | 'languages'>): ResolvedPrintLanguages {
  return opts.languages ?? resolveBillPrintLanguages(opts.language);
}

/** Read a semantic document label, retaining the canonical resolver fallback. */
function documentLabel(
  label: { primary: string } | null | undefined,
  conceptId: string,
  lang: Language,
): string {
  return label?.primary ?? printLabelResolver(conceptId, lang);
}

/** Retain browser wording while honoring semantic label override from merchant document. */
function surfaceLabel(
  semanticLabel: { primary: string } | null | undefined,
  semanticConceptId: string,
  browserConceptId: string,
  lang: Language,
): string {
  const semanticDefault = printLabelResolver(semanticConceptId, lang);
  return semanticLabel && semanticLabel.primary !== semanticDefault
    ? semanticLabel.primary
    : printLabelResolver(browserConceptId, lang);
}

/** Remove the semantic table label's interpolation token for a separate value cell. */
function stripLabelPlaceholder(label: string): string {
  return label.replace('{name}', '').replace(/[:：]\s*$/, '').trim();
}

/** Unknown payment methods keep their legacy capitalized literal rendering. */
function paymentLineLabel(label: { conceptId?: string; primary: string }): string {
  return label.conceptId !== undefined
    ? label.primary
    : label.primary.charAt(0).toUpperCase() + label.primary.slice(1);
}

function getPaperStyles(size: PaperSize): string {
  const baseStyles = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Segoe UI', Tahoma, 'Noto Naskh Arabic', 'Helvetica Neue', Arial, sans-serif; font-size: 12px; line-height: 1.4; color: #333; }
    .bill-container { max-width: 100%; margin: 0 auto; }
    .reprint-banner { text-align: center; font-size: 22px; font-weight: bold; letter-spacing: 2px; color: #c00; border: 3px solid #c00; padding: 6px; margin-bottom: 15px; }
    .online-order-banner { text-align: center; font-size: 18px; font-weight: bold; letter-spacing: 1px; border: 2px solid #333; padding: 6px; margin-bottom: 15px; }
    .online-order-banner .online-order-detail { font-size: 13px; font-weight: normal; letter-spacing: normal; margin-top: 2px; }
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

/** Format amount per tenant currency display, digit mode, and trimDecimals prefs. */
function formatAmount(value: number, tenant: ReceiptTenant, trimDecimals = false): string {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
  const prefs = { currencyDisplay: tenant.currency_display, digits: tenant.number_digits };
  const fractionDigits = getCurrencyFractionDigits(tenant.currency ?? 'INR');
  const factor = 10 ** fractionDigits;
  const hasDecimals = fractionDigits > 0 && Math.round(numeric * factor) % factor !== 0;
  const isToman =
    (tenant.currency === 'IRR' || (!tenant.currency && tenant.country === 'IR')) &&
    (tenant.currency_display === 'toman' || tenant.currency_display === 'toman_short');

  // trimDecimals hides trailing .00 only when there is no fractional part.
  if (trimDecimals && !hasDecimals && !isToman) {
    const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
    const numberingSystem = tenant.number_digits === 'latin' ? 'latn' : undefined;
    const currency = tenant.currency || 'INR';
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: getCurrencySymbol(currency, locale) === currency ? 'code' : 'narrowSymbol',
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

function formatReceiptDate(iso: string, tenant: ReceiptTenant, locale?: string): string {
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
      locale,
    );
  } catch {
    return iso;
  }
}
