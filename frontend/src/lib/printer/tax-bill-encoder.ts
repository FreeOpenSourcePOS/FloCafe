/**
 * tax-bill-encoder.ts
 *
 * Detailed tax billing receipt encoder for ESC/POS thermal printers.
 * Supports both 58mm (2.5") and 80mm (3.5") paper widths.
 * Includes: tax registration number, HSN/reference codes, and item tax details.
 *
 * LEGACY-FROZEN (#444 decision, epic #438): this diagnostic encoder is only
 * reachable from the print-test page ('tax' mode). It is deliberately NOT
 * migrated onto the shared PrintDocument model and keeps its historical
 * raw-bill rendering; this is a documented exemption, not an endorsement —
 * it must not gain new business behavior. The browser path of the same test
 * surface renders through the document-driven web-print pipeline.
 */

import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Bill, Tenant } from '@/lib/types';
import { normalizeCurrencyToAscii, padCurrencyPrefix } from './unicode';
import { getCountryByCode, getCurrencySymbol } from '@/lib/countries';
import { formatDate } from './format-date';
import { formatTaxComponentLabel, resolveTaxComponents } from './tax-components';
import { safePrinterText, type PrintWarning } from './warnings';
import { RECEIPT_BRANDING_NAME, RECEIPT_BRANDING_URL } from './branding';
import { printLabelResolver } from './print-document';

export interface TaxBillOptions {
  /** 58 mm (2.5", 42 chars) or 80 mm (3.5", 48 chars). Default: 58 */
  paperWidth?: 58 | 80;
  /** Show "Thank you" footer. Default: true */
  showFooter?: boolean;
  /** Business tax registration number */
  taxRegistrationNumber?: string;
  /** Business address */
  address?: string;
  /** Business phone */
  phone?: string;
  /** Show the restaurant name when available. Default: true */
  showBusinessName?: boolean;
  /** Show per-tax-rate breakdown lines. Default: true */
  showTaxBreakdown?: boolean;
  /** Show the customer name when available. Default: true */
  showCustomerName?: boolean;
  /** Show the customer phone when available. Default: true */
  showCustomerPhone?: boolean;
  /** Show the table number when available. Default: true */
  showTableNumber?: boolean;
  /** State code for tax calculation */
  stateCode?: string;
  /** If false (default), replace ₹/€/£/etc. with ASCII (Rs, EUR, GBP…). */
  useUnicode?: boolean;
  /** Use raw ESC/POS-safe currency and Latin-digit formatting; false preserves locale formatting. Default: true. */
  rawEscPos?: boolean;
  /** Hide trailing .00 on printed amounts while keeping non-zero decimals. */
  trimDecimals?: boolean;
  /**
   * Printer firmware performs Arabic/Persian contextual shaping (#437).
   * Lets pure ASCII+Arabic lines through the unsupported-character guard.
   * Default: false.
   */
  arabicShaping?: boolean;
  /** Print language resolved from the receipt language policy. */
  language?: string;
}

// Must match main/printers/profiles.ts generic-escpos-58/80 fontAColumns.
const CHARS: Record<58 | 80, number> = { 58: 42, 80: 48 };

function printPoweredByFooter(enc: ReceiptPrinterEncoder): void {
  enc
    .align('center')
    .size('small')
    .text(RECEIPT_BRANDING_NAME)
    .newline()
    .text(RECEIPT_BRANDING_URL)
    .newline()
    .size('normal')
    .align('left');
}

/**
 * Mask phone number for receipt display — shows only last 4 digits.
 */
function maskPhoneOnReceipt(phone: string): string {
  if (!phone || phone.length < 4) return phone;
  return 'x'.repeat(phone.length - 4) + phone.slice(-4);
}

/**
 * Build a detailed tax bill byte array from a Bill object.
 */
function resolveEncoderCurrency(rawCurrency: string, useUnicode: boolean, rawEscPos: boolean): string {
  if (!rawEscPos) {
    return padCurrencyPrefix(useUnicode ? rawCurrency : normalizeCurrencyToAscii(rawCurrency));
  }
  // fa-IR resolves IRR to the textual token "ریال". Generic ESC/POS
  // printers cannot shape that token, so normalize this known currency even
  // when the caller requests Unicode. Preserve the existing useUnicode
  // behavior for every other currency value.
  const normalizedCurrency = rawCurrency === 'ریال' ? 'IRR' : rawCurrency;
  return padCurrencyPrefix(
    useUnicode ? normalizedCurrency : normalizeCurrencyToAscii(normalizedCurrency),
  );
}

function getSafeLatnLocale(locale: string | undefined): string {
  if (!locale) return 'en-US-u-nu-latn';
  if (/-nu-[a-z0-9]+/i.test(locale)) {
    return locale.replace(/-nu-[a-z0-9]+/i, '-nu-latn');
  }
  if (locale.includes('-u-')) {
    return `${locale}-nu-latn`;
  }
  return `${locale}-u-nu-latn`;
}

export function buildTaxBillBytes(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: TaxBillOptions = {},
  warnings?: PrintWarning[]
): Uint8Array {
  const {
    paperWidth = 58,
    showFooter = true,
    taxRegistrationNumber,
    address,
    phone,
    showBusinessName = true,
    showTaxBreakdown = true,
    showCustomerName = true,
    showCustomerPhone = true,
    showTableNumber = true,
    useUnicode = false,
    trimDecimals = false,
    rawEscPos = true,
    arabicShaping = false,
    language = 'en',
  } = opts;
  const labelFor = (key: string): string => printLabelResolver(key, language);
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = resolveEncoderCurrency(rawCurrency, useUnicode, rawEscPos);
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const amountLocale = rawEscPos ? getSafeLatnLocale(locale) : locale;
  const taxIdLabel = getCountryByCode(tenant.country ?? 'IN')?.taxIdLabel || 'Tax ID';
  const order = bill.order;
  const taxComponents = resolveTaxComponents(bill);
  const hasTax = Number(bill.tax_amount) !== 0
    || taxComponents.some((component) => Number(component.amount) !== 0);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  // ── Header ────────────────────────────────────────────────────────────────
  enc.initialize().align('center');
  if (showBusinessName && tenant.business_name) {
    enc.bold(true).width(2).height(2);
    safePrinterText(enc, truncate(tenant.business_name, 16), warnings, true, arabicShaping, Math.floor(cols / 2));
    enc.width(1).height(1);
    enc.bold(false).newline();
  }

  if (address) {
    safePrinterText(enc, truncate(address, cols), warnings, false, arabicShaping, cols).newline();
  }
  if (phone) {
    safePrinterText(enc, `${labelFor('receipt.phone')}: ${phone}`, warnings, false, arabicShaping, cols).newline();
  }
  if (taxRegistrationNumber) {
    safePrinterText(enc, `${taxIdLabel}: ${taxRegistrationNumber}`, warnings, false, arabicShaping, cols).newline();
  }

  enc.newline();

  // ── Bill Details ─────────────────────────────────────────────────────────
  enc.align('left');
  safePrinterText(enc, `${labelFor('receipt.billNumber')}: ${bill.bill_number}`, warnings, false, arabicShaping, undefined, cols).newline();
  safePrinterText(enc, `${labelFor('receipt.date')}: ${formatDate(bill.order?.created_at, locale)}`, warnings, false, arabicShaping, undefined, cols).newline();

  if (showTableNumber && order?.table?.name) {
    safePrinterText(enc, labelFor('pos.tableLabel').replace('{name}', String(order.table.name)), warnings, false, arabicShaping, undefined, cols).newline();
  }
  if (showCustomerName && order?.customer?.name) {
    safePrinterText(enc, `${labelFor('pos.customer')}: ${order.customer.name}`, warnings, false, arabicShaping, undefined, cols).newline();
  }
  if (showCustomerPhone && order?.customer?.phone) {
    safePrinterText(enc, `${labelFor('print.numberShort')}: ${maskPhoneOnReceipt(order.customer.phone)}`, warnings, false, arabicShaping, undefined, cols).newline();
  }

  enc.rule({ style: 'single' });

  // ── Line Items with HSN ─────────────────────────────────────────────────
  enc.text(padRow(labelFor('receipt.item'), `${labelFor('receipt.qty')} ${labelFor('receipt.rate')} ${labelFor('receipt.amount')}`, cols)).newline();
  enc.rule({ style: 'single' });

  const items = order?.items ?? [];
  for (const item of items) {
    const line = `${item.product_name}`;

    safePrinterText(enc, padRow(line, formatAmount(item.total, currency, amountLocale, trimDecimals, rawEscPos), cols), warnings, false, arabicShaping).newline();

    // Show HSN if available
    const hsnCode = 'hsn_code' in item ? (item as { hsn_code?: string }).hsn_code : undefined;
    if (hsnCode) {
      enc.size('small');
      safePrinterText(enc, `    ${labelFor('print.hsn')}: ${hsnCode}`, warnings, false, arabicShaping).size('normal').newline();
    }

    // Addons
    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        const qty = ('quantity' in addon && typeof addon.quantity === 'number') ? addon.quantity : 1;
        const addonLine = `   + ${addon.name}${qty > 1 ? ` x${qty}` : ''}`;
        const addonPrice = addon.price && Number(addon.price) > 0
          ? formatAmount(Number(addon.price) * qty * item.quantity, currency, amountLocale, trimDecimals, rawEscPos)
          : '';
        safePrinterText(enc, padRow(addonLine, addonPrice, cols), warnings, false, arabicShaping).newline();
      }
    }
  }

  enc.rule({ style: 'single' });

  // ── Tax Breakdown ───────────────────────────────────────────────────────
  if (showTaxBreakdown && taxComponents.length > 0) {
    safePrinterText(enc, `${labelFor('receipt.taxDetails')}:`, warnings, false, arabicShaping).newline();
    for (const component of taxComponents) {
      safePrinterText(
        enc,
        padRow(formatTaxComponentLabel(component), formatAmount(component.amount, currency, amountLocale, trimDecimals, rawEscPos), cols),
        warnings,
        false,
        arabicShaping,
      ).newline();
    }
  }

  // ── Totals ───────────────────────────────────────────────────────────────
  enc.rule({ style: 'single' });

  const totals: [string, string][] = [
    [labelFor('pos.subtotal'), formatAmount(bill.subtotal, currency, amountLocale, trimDecimals, rawEscPos)],
  ];

  if (Number(bill.discount_amount) > 0) {
    totals.push([labelFor('pos.discount'), `-${formatAmount(bill.discount_amount, currency, amountLocale, trimDecimals, rawEscPos)}`]);
  }

  if (Number(bill.tax_amount) > 0) {
    totals.push([labelFor('receipt.totalTax'), formatAmount(bill.tax_amount, currency, amountLocale, trimDecimals, rawEscPos)]);
  }

  if (Number(bill.service_charge) > 0) {
    totals.push([labelFor('receipt.serviceCharge'), formatAmount(bill.service_charge, currency, amountLocale, trimDecimals, rawEscPos)]);
  }

  if (Number(bill.delivery_charge) > 0) {
    totals.push([labelFor('receipt.deliveryCharge'), formatAmount(bill.delivery_charge, currency, amountLocale, trimDecimals, rawEscPos)]);
  }

  for (const [label, value] of totals) {
    safePrinterText(enc, padRow(label, value, cols), warnings, false, arabicShaping).newline();
  }

  enc.rule({ style: 'double' });
  enc.bold(true).width(2);
  safePrinterText(enc, padRow(labelFor('print.grandTotal'), formatAmount(bill.total, currency, amountLocale, trimDecimals, rawEscPos), cols), warnings, false, arabicShaping).width(1);
  enc.bold(false).newline();

  // ── Payment Details ───────────────────────────────────────────────────────
  if (bill.payment_details && bill.payment_details.length > 0) {
    enc.newline();
    safePrinterText(enc, `${labelFor('receipt.payments')}:`, warnings, false, arabicShaping).newline();
    for (const p of bill.payment_details) {
      safePrinterText(enc, padRow(resolvePaymentLabel(p.method, labelFor), formatAmount(p.amount, currency, amountLocale, trimDecimals, rawEscPos), cols), warnings, false, arabicShaping).newline();
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  if (showFooter) {
    enc.newline().align('center');
    safePrinterText(enc, labelFor('print.thankYouVisitAgain'), warnings, false, arabicShaping).newline();
    safePrinterText(enc, labelFor('print.pleaseComeAgain'), warnings, false, arabicShaping).newline();
    if (hasTax) {
      safePrinterText(enc, labelFor('receipt.taxIncluded'), warnings, false, arabicShaping).newline();
    }
  }
  printPoweredByFooter(enc);

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padRow(left: string, right: string, cols: number): string {
  const safeRight = right.length > cols ? right.slice(-cols) : right;
  const leftWidth = Math.max(0, cols - safeRight.length - 1);
  return left.slice(0, leftWidth) + (leftWidth > 0 ? ' ' : '') + safeRight;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function formatAmount(value: number | string, currency: string, locale: string, trimDecimals: boolean = false, rawEscPos: boolean = true): string {
  const amount = Number(value);
  const numeric = Number.isFinite(amount) ? amount : 0;
  const hasDecimals = Math.round(numeric * 100) % 100 !== 0;
  const formattedNum = numeric.toLocaleString(locale, {
    minimumFractionDigits: trimDecimals && !hasDecimals ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const normalizedNum = rawEscPos ? formattedNum.replace(/[\u00A0\u202F]/g, ' ') : formattedNum;
  return `${currency}${normalizedNum}`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function resolvePaymentLabel(method: string, label: (key: string) => string): string {
  const keys: Record<string, string> = {
    cash: 'pos.methodCash',
    card: 'pos.methodCard',
    wallet: 'pos.methodWallet',
  };
  const key = keys[String(method || '').toLowerCase()];
  return key ? label(key) : capitalize(String(method || ''));
}
