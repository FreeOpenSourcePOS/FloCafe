/**
 * receipt-encoder.ts
 *
 * Converts a Flo POS Bill (+ its nested Order) into raw ESC/POS bytes
 * using `@point-of-sale/receipt-printer-encoder`.
 *
 * Two core receipt templates are available:
 *   buildClassicReceiptBytes  — rich legacy-style (default)
 *   buildCompactReceiptBytes  — minimal, fast
 *
 * `buildReceiptBytes` is kept as a re-export of the classic builder
 * for backward compatibility.
 */

import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Bill, Tenant } from '@/lib/types';
import { normalizeCurrencyToAscii, padCurrencyPrefix } from './unicode';
import { getCountryByCode, getCurrencySymbol } from '@/lib/countries';
import { formatDate } from './format-date';
import { formatTaxComponentLabel, resolveTaxComponents } from './tax-components';
import { safePrinterText, type PrintWarning } from './warnings';
import { RECEIPT_BRANDING_NAME, RECEIPT_BRANDING_URL } from './branding';

export interface ReceiptOptions {
  /** 58 mm (42 chars) or 80 mm (48 chars). Default: 58 */
  paperWidth?: 58 | 80;
  /** Show a "Thank you" footer line. Default: true */
  showFooter?: boolean;
  /** Extra line of custom text printed below the footer. */
  footerNote?: string;
  /** Tax registration number to print in footer / header */
  taxRegistrationNumber?: string;
  /** Business address to print */
  address?: string;
  /** Business phone to print */
  phone?: string;
  /** Show per-tax-rate breakdown lines */
  showTaxBreakdown?: boolean;
  /** Show the restaurant name when available. Default: true */
  showBusinessName?: boolean;
  /** Show the customer name when available. Default: true */
  showCustomerName?: boolean;
  /** Show the customer phone when available. Default: true */
  showCustomerPhone?: boolean;
  /** Show the table number when available. Default: true */
  showTableNumber?: boolean;
  /** If false (default), replace ₹/€/£/etc. with ASCII (Rs, EUR, GBP…). */
  useUnicode?: boolean;
  /**
   * Printer firmware performs Arabic/Persian contextual shaping (#437).
   * Lets pure ASCII+Arabic lines through the unsupported-character guard;
   * other non-ASCII scripts stay blocked. Default: false.
   */
  arabicShaping?: boolean;
  /** Print a large "REPRINT" banner at the top so a reprinted receipt can't be mistaken for the original. */
  isReprint?: boolean;
  /** Hide trailing .00 on printed amounts while keeping non-zero decimals. */
  trimDecimals?: boolean;
}

function printReprintBanner(enc: ReceiptPrinterEncoder): void {
  enc
    .align('center')
    .bold(true)
    .width(2)
    .height(2)
    .text('** REPRINT **')
    .width(1)
    .height(1)
    .bold(false)
    .newline()
    .align('left');
}

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

// Must match main/printers/profiles.ts generic-escpos-58/80 fontAColumns.
const CHARS: Record<58 | 80, number> = { 58: 42, 80: 48 };

/**
 * Mask phone number for receipt display — shows only last 4 digits.
 * Example: "9876543210" → "xxxxx3210"
 */
function maskPhoneOnReceipt(phone: string): string {
  if (!phone || phone.length < 4) return phone;
  return 'x'.repeat(phone.length - 4) + phone.slice(-4);
}

// ---------------------------------------------------------------------------
// 4-column layout helpers
// ---------------------------------------------------------------------------

/**
 * Minimum column widths for 4-column item tables.
 * Layout: [name, qty, rate, amount]
 */
type Col4Widths = [number, number, number, number];

function col4Widths(cols: number): Col4Widths {
  if (cols >= 48) return [20, 4, 11, 13];
  return [14, 3, 7, 8];
}

function resolveCol4Widths(
  cols: number,
  items: Array<{ unit_price?: number | string; total?: number | string }>,
  currency: string,
  locale: string,
  trimDecimals: boolean,
): Col4Widths {
  const [, qtyWidth, minimumRateWidth, minimumAmountWidth] = col4Widths(cols);
  let rateWidth = minimumRateWidth;
  let amountWidth = minimumAmountWidth;

  for (const item of items) {
    rateWidth = Math.max(rateWidth, formatAmount(item.unit_price ?? 0, currency, locale, trimDecimals).length);
    amountWidth = Math.max(amountWidth, formatAmount(item.total ?? 0, currency, locale, trimDecimals).length);
  }

  const valueBudget = cols - qtyWidth - 4;
  if (rateWidth + amountWidth > valueBudget) {
    amountWidth = Math.min(amountWidth, valueBudget - minimumRateWidth);
    rateWidth = valueBudget - amountWidth;
  }

  const nameWidth = cols - qtyWidth - rateWidth - amountWidth;
  return [nameWidth, qtyWidth, rateWidth, amountWidth];
}

function col4Header(widths: Col4Widths): string {
  const [w0, w1, w2, w3] = widths;
  const item = 'Item'.padEnd(w0);
  const qty = 'Qty'.padStart(w1);
  const rate = 'Rate'.padStart(w2);
  const amt = 'Amt'.padStart(w3);
  return item + qty + rate + amt;
}

function col4Rows(
  name: string,
  qty: number,
  rate: number | string,
  amount: number | string,
  currency: string,
  widths: Col4Widths,
  locale: string,
  trimDecimals: boolean = false
): string[] {
  const [nameWidth, qtyWidth, rateWidth, amountWidth] = widths;
  const rateStr = formatAmount(rate, currency, locale, trimDecimals);
  const amtStr = formatAmount(amount, currency, locale, trimDecimals);
  const qtyStr = String(qty);

  if (qtyStr.length > qtyWidth || rateStr.length > rateWidth || amtStr.length > amountWidth) {
    const itemWidth = Math.max(1, widths[0] + widths[1] - 1, colsForCol4(widths) - qtyStr.length - 1);
    const itemLine = truncate(name, itemWidth).padEnd(itemWidth) + ' ' + qtyStr;
    return [
      itemLine,
      ...fitLabeledValue('Rate', rateStr, colsForCol4(widths)),
      ...fitLabeledValue('Amount', amtStr, colsForCol4(widths)),
    ];
  }

  const nameColumn = truncate(name, nameWidth).padEnd(nameWidth);
  const qtyColumn = qtyStr.padStart(qtyWidth);
  return [nameColumn + qtyColumn + rateStr.padStart(rateWidth) + amtStr.padStart(amountWidth)];
}

function colsForCol4(widths: Col4Widths): number {
  return widths.reduce((total, width) => total + width, 0);
}

function fitLabeledValue(label: string, value: string, cols: number): string[] {
  const prefix = `${label}: `;
  const valueWidth = Math.max(1, cols - prefix.length);
  const lines: string[] = [];
  for (let offset = 0; offset < value.length; offset += valueWidth) {
    const chunk = value.slice(offset, offset + valueWidth);
    lines.push(offset === 0 ? prefix + chunk : chunk);
  }
  return lines.length > 0 ? lines : [prefix];
}

// ---------------------------------------------------------------------------
// Classic template
// ---------------------------------------------------------------------------

function resolveEncoderCurrency(rawCurrency: string, useUnicode: boolean): string {
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

export function buildClassicReceiptBytes(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: ReceiptOptions = {},
  warnings?: PrintWarning[]
): Uint8Array {
  const {
    paperWidth = 58,
    showFooter = true,
    footerNote,
    taxRegistrationNumber,
    address,
    phone,
    showTaxBreakdown = false,
    showBusinessName = true,
    showCustomerName = true,
    showCustomerPhone = true,
    showTableNumber = true,
    useUnicode = false,
    arabicShaping = false,
    isReprint = false,
    trimDecimals = false,
  } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = resolveEncoderCurrency(rawCurrency, useUnicode);
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const taxIdLabel = getCountryByCode(tenant.country ?? 'IN')?.taxIdLabel || 'Tax ID';
  const order = bill.order;
  const taxComponents = resolveTaxComponents(bill);
  const col4Layout = resolveCol4Widths(cols, order?.items ?? [], currency, locale, trimDecimals);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (isReprint) printReprintBanner(enc);

  // Header
  if (showBusinessName && tenant.business_name) {
    enc.align('center').bold(true).width(2).height(2);
    safePrinterText(enc, truncate(tenant.business_name, 16), warnings, true, arabicShaping);
    enc.width(1).height(1).bold(false).newline();
  }

  if (showTableNumber && order?.table?.name) {
    enc.bold(true);
    safePrinterText(enc, `Table: ${order.table.name}`, warnings, arabicShaping);
    enc.bold(false).newline();
  }
  if (showCustomerName && order?.customer?.name) {
    safePrinterText(enc, order.customer.name, warnings, arabicShaping).newline();
  }
  if (showCustomerPhone && order?.customer?.phone) {
    enc.text(maskPhoneOnReceipt(order.customer.phone)).newline();
  }

  enc
    .size('small')
    .text(padRow(`Bill #${bill.bill_number}`, formatDate(bill.order?.created_at, locale), cols))
    .newline()
    .size('normal')
    .align('left')
    .rule({ style: 'single' });

  // 4-column header
  enc.text(col4Header(col4Layout)).newline();
  enc.rule({ style: 'single' });

  // Line items
  const items = order?.items ?? [];
  for (const item of items) {
    for (const row of col4Rows(item.product_name, item.quantity, item.unit_price, item.total, currency, col4Layout, locale, trimDecimals)) {
      safePrinterText(enc, row, warnings, arabicShaping).newline();
    }

    // Addons
    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        const qty = addon.quantity || 1;
        const addonLabel = truncate(`  + ${addon.name}${qty > 1 ? ` x${qty}` : ''}`, cols - 8);
        if (addon.price && Number(addon.price) > 0) {
          const addonTotal = Number(addon.price) * qty * item.quantity;
          safePrinterText(enc, padRow(addonLabel, formatAmount(addonTotal, currency, locale, trimDecimals), cols), warnings, arabicShaping).newline();
        } else {
          safePrinterText(enc, addonLabel, warnings, arabicShaping).newline();
        }
      }
    }

    // Special instructions
    if (item.special_instructions) {
      safePrinterText(enc, truncate(`  >> ${item.special_instructions}`, cols), warnings, arabicShaping).newline();
    }
  }

  enc.rule({ style: 'single' });

  // Totals
  enc.text(padRow('Subtotal', formatAmount(bill.subtotal, currency, locale, trimDecimals), cols)).newline();
  if (Number(bill.discount_amount) > 0) {
    enc.text(padRow('Discount', `-${formatAmount(bill.discount_amount, currency, locale, trimDecimals)}`, cols)).newline();
  }
  if (Number(bill.tax_amount) > 0) {
    enc.text(padRow('Tax', formatAmount(bill.tax_amount, currency, locale, trimDecimals), cols)).newline();
  }
  if (Number(bill.service_charge) > 0) {
    enc.text(padRow('Service Charge', formatAmount(bill.service_charge, currency, locale, trimDecimals), cols)).newline();
  }
  if (Number(bill.delivery_charge) > 0) {
    enc.text(padRow('Delivery', formatAmount(bill.delivery_charge, currency, locale, trimDecimals), cols)).newline();
  }

  enc.rule({ style: 'double' });
  enc
    .bold(true)
    .text(padRow('TOTAL', formatAmount(bill.total, currency, locale, trimDecimals), cols))
    .bold(false)
    .newline();
  enc.rule({ style: 'single' });

  // Payment methods
  if (bill.payment_details && bill.payment_details.length > 0) {
    for (const p of bill.payment_details) {
      enc.text(padRow(capitalize(p.method), formatAmount(p.amount, currency, locale, trimDecimals), cols)).newline();
    }
  }

  enc.newline();

  // Tax breakdown (optional)
  if (showTaxBreakdown && taxComponents.length > 0) {
    for (const component of taxComponents) {
      enc
        .text(padRow(` ${formatTaxComponentLabel(component)}`, formatAmount(component.amount, currency, locale, trimDecimals), cols))
        .newline();
    }
  }

  // Footer
  if (showFooter) {
    if (taxRegistrationNumber) {
      safePrinterText(enc, padRow(`${taxIdLabel}: ${taxRegistrationNumber}`, `Bill #${bill.bill_number}`, cols), warnings, arabicShaping).newline();
    }
    if (address) {
      enc.align('center');
      safePrinterText(enc, truncate(address, cols), warnings, arabicShaping).newline();
      enc.align('left');
    }
    if (phone) {
      enc.align('center');
      safePrinterText(enc, `Call: ${phone}`, warnings, arabicShaping).newline();
      enc.align('left');
    }
    enc.newline();
    enc.align('center').text('Thank you! Please visit again').newline();
    if (footerNote) {
      safePrinterText(enc, truncate(footerNote, cols), warnings, arabicShaping).newline();
    }
  }
  printPoweredByFooter(enc);

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Compact template
// ---------------------------------------------------------------------------

export function buildCompactReceiptBytes(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: ReceiptOptions = {},
  warnings?: PrintWarning[]
): Uint8Array {
  const {
    paperWidth = 58,
    footerNote,
    taxRegistrationNumber,
    address,
    phone,
    showTaxBreakdown = false,
    showBusinessName = true,
    showCustomerName = true,
    showCustomerPhone = true,
    showTableNumber = true,
    useUnicode = false,
    arabicShaping = false,
    isReprint = false,
    trimDecimals = false,
  } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = resolveEncoderCurrency(rawCurrency, useUnicode);
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const taxIdLabel = getCountryByCode(tenant.country ?? 'IN')?.taxIdLabel || 'Tax ID';
  const order = bill.order;
  const taxComponents = resolveTaxComponents(bill);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (isReprint) printReprintBanner(enc);

  // Header
  if (showBusinessName && tenant.business_name) {
    enc.align('center').bold(true);
    safePrinterText(enc, truncate(tenant.business_name, cols), warnings, true, arabicShaping);
    enc.bold(false).newline();
  }
  enc.align('left').rule({ style: 'single' });

  // Bill # and date on one line
  enc
    .text(padRow(`Bill #${bill.bill_number}`, formatDate(bill.order?.created_at, locale), cols))
    .newline();

  if (showTableNumber && order?.table?.name) {
    safePrinterText(enc, `Table: ${order.table.name}`, warnings, arabicShaping).newline();
  }
  if (showCustomerName && order?.customer?.name) {
    safePrinterText(enc, `Cust: ${truncate(order.customer.name, cols - 6)}`, warnings, arabicShaping).newline();
  }
  if (showCustomerPhone && order?.customer?.phone) {
    safePrinterText(enc, `No: ${maskPhoneOnReceipt(order.customer.phone)}`, warnings, arabicShaping).newline();
  }

  enc.rule({ style: 'single' });

  // Items — compact: one line per item with total, qty x rate below if qty > 1
  const items = order?.items ?? [];
  for (const item of items) {
    const nameMax = cols - formatAmount(item.total, currency, locale, trimDecimals).length - 1;
    safePrinterText(
      enc,
      padRow(truncate(item.product_name, nameMax), formatAmount(item.total, currency, locale, trimDecimals), cols),
      warnings,
      false,
      arabicShaping
    ).newline();

    if (item.quantity > 1) {
      enc
        .size('small')
        .align('right')
        .text(`${item.quantity} x ${formatAmount(item.unit_price, currency, locale, trimDecimals)}`)
        .newline()
        .size('normal')
        .align('left');
    }
  }

  enc.rule({ style: 'single' });

  if (Number(bill.discount_amount) > 0) {
    enc.text(padRow('Discount', `-${formatAmount(bill.discount_amount, currency, locale, trimDecimals)}`, cols)).newline();
  }
  if (Number(bill.tax_amount) > 0) {
    enc.text(padRow('Tax', formatAmount(bill.tax_amount, currency, locale, trimDecimals), cols)).newline();
  }
  if (showTaxBreakdown && taxComponents.length > 0) {
    for (const component of taxComponents) {
      enc.text(padRow(formatTaxComponentLabel(component), formatAmount(component.amount, currency, locale, trimDecimals), cols)).newline();
    }
  }

  enc.rule({ style: 'double' });
  enc
    .bold(true)
    .text(padRow('TOTAL', formatAmount(bill.total, currency, locale, trimDecimals), cols))
    .bold(false)
    .newline();

  if (bill.payment_details && bill.payment_details.length > 0) {
    for (const p of bill.payment_details) {
      enc.text(padRow(capitalize(p.method), formatAmount(p.amount, currency, locale, trimDecimals), cols)).newline();
    }
  }

  enc.newline().align('center');
  if (taxRegistrationNumber) {
    safePrinterText(enc, `${taxIdLabel}: ${taxRegistrationNumber}`, warnings, arabicShaping).newline();
  }
  if (address) safePrinterText(enc, truncate(address, cols), warnings, arabicShaping).newline();
  if (phone) safePrinterText(enc, `Ph: ${phone}`, warnings, arabicShaping).newline();
  enc.text('Thank you!').newline();
  if (footerNote) {
    safePrinterText(enc, truncate(footerNote, cols), warnings, arabicShaping).newline();
  }
  printPoweredByFooter(enc);

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Legacy detailed tax encoder. Tax-specific templates are no longer exposed
// as core bill templates; future country-specific templates should come from
// the active tax pack/plugin contract instead.
// ---------------------------------------------------------------------------

export function buildDetailedReceiptBytes(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: ReceiptOptions = {},
  warnings?: PrintWarning[]
): Uint8Array {
  const {
    paperWidth = 58,
    footerNote,
    taxRegistrationNumber,
    address,
    phone,
    showTaxBreakdown = true,
    showBusinessName = true,
    showCustomerName = true,
    showCustomerPhone = true,
    showTableNumber = true,
    useUnicode = false,
    arabicShaping = false,
    isReprint = false,
    trimDecimals = false,
  } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = resolveEncoderCurrency(rawCurrency, useUnicode);
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const taxIdLabel = getCountryByCode(tenant.country ?? 'IN')?.taxIdLabel || 'Tax ID';
  const order = bill.order;
  const taxComponents = resolveTaxComponents(bill);
  const col4Layout = resolveCol4Widths(cols, order?.items ?? [], currency, locale, trimDecimals);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (isReprint) printReprintBanner(enc);

  // Header
  if (showBusinessName && tenant.business_name) {
    enc.align('center').bold(true).width(2).height(2);
    safePrinterText(enc, truncate(tenant.business_name, 16), warnings, true, arabicShaping);
    enc.width(1).height(1).bold(false).newline();
  }

  if (taxRegistrationNumber) {
    enc.bold(true);
    safePrinterText(enc, `${taxIdLabel}: ${taxRegistrationNumber}`, warnings, arabicShaping);
    enc.bold(false).newline();
  }

  enc.bold(true).text('TAX INVOICE').bold(false).newline();

  if (address) {
    safePrinterText(enc, truncate(address, cols), warnings, arabicShaping).newline();
  }
  if (phone) {
    safePrinterText(enc, phone, warnings, arabicShaping).newline();
  }

  enc.align('left').rule({ style: 'single' });

  // Bill info
  enc
    .text(padRow(`Bill #: ${bill.bill_number}`, formatDate(bill.order?.created_at, locale), cols))
    .newline();

  if (showCustomerName && order?.customer?.name) {
    safePrinterText(
      enc,
      padRow(
        `Customer: ${truncate(order.customer.name, cols - 20)}`,
        '',
        cols
      ),
      warnings,
      false,
      arabicShaping
    ).newline();
  }
  if (showCustomerPhone && order?.customer?.phone) {
    safePrinterText(enc, `Customer No: ${maskPhoneOnReceipt(order.customer.phone)}`, warnings, arabicShaping).newline();
  }
  if (showTableNumber && order?.table?.name) {
    safePrinterText(enc, `Table: ${order.table.name}`, warnings, arabicShaping).newline();
  }

  enc.rule({ style: 'single' });

  // 4-column items header
  enc.text(col4Header(col4Layout)).newline();

  // Line items
  const items = order?.items ?? [];
  for (const item of items) {
    for (const row of col4Rows(item.product_name, item.quantity, item.unit_price, item.total, currency, col4Layout, locale, trimDecimals)) {
      safePrinterText(enc, row, warnings, arabicShaping).newline();
    }

    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        const qty = addon.quantity || 1;
        const addonLabel = truncate(`  + ${addon.name}${qty > 1 ? ` x${qty}` : ''}`, cols - 8);
        if (addon.price && Number(addon.price) > 0) {
          const addonTotal = Number(addon.price) * qty * item.quantity;
          safePrinterText(enc, padRow(addonLabel, formatAmount(addonTotal, currency, locale, trimDecimals), cols), warnings, arabicShaping).newline();
        } else {
          safePrinterText(enc, addonLabel, warnings, arabicShaping).newline();
        }
      }
    }

    if (item.special_instructions) {
      safePrinterText(enc, truncate(`  >> ${item.special_instructions}`, cols), warnings, arabicShaping).newline();
    }
  }

  enc.rule({ style: 'single' });

  // Subtotal (excl. tax)
  enc
    .text(padRow('Subtotal (excl. tax)', formatAmount(bill.subtotal, currency, locale, trimDecimals), cols))
    .newline();

  enc.rule({ style: 'single' });

  if (showTaxBreakdown && taxComponents.length > 0) {
    for (const component of taxComponents) {
      enc
        .text(padRow(` ${formatTaxComponentLabel(component)}`, formatAmount(component.amount, currency, locale, trimDecimals), cols))
        .newline();
    }
  } else if (Number(bill.tax_amount) > 0) {
    enc.text(padRow('Tax', formatAmount(bill.tax_amount, currency, locale, trimDecimals), cols)).newline();
  }

  enc.rule({ style: 'double' });
  enc
    .bold(true)
    .text(padRow('TOTAL', formatAmount(bill.total, currency, locale, trimDecimals), cols))
    .bold(false)
    .newline();
  enc.rule({ style: 'single' });

  // Payment methods
  if (bill.payment_details && bill.payment_details.length > 0) {
    for (const p of bill.payment_details) {
      enc.text(padRow(capitalize(p.method), formatAmount(p.amount, currency, locale, trimDecimals), cols)).newline();
    }
  }

  enc.newline();
  enc
    .size('small')
    .align('center')
    .text('Rates inclusive of all applicable taxes')
    .newline()
    .size('normal')
    .align('left');

  if (footerNote) {
    safePrinterText(enc, truncate(footerNote, cols), warnings, arabicShaping).newline();
  }
  printPoweredByFooter(enc);

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Backward-compat alias
// ---------------------------------------------------------------------------

/** @deprecated Use buildClassicReceiptBytes directly */
export const buildReceiptBytes = buildClassicReceiptBytes;

// ---------------------------------------------------------------------------
// Formatting helpers (shared)
// ---------------------------------------------------------------------------

function padRow(left: string, right: string, cols: number): string {
  const gap = cols - left.length - right.length;
  return gap > 0
    ? left + ' '.repeat(gap) + right
    : left.slice(0, cols - right.length - 1) + ' ' + right;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

function formatAmount(value: number | string, currency: string, locale: string, trimDecimals: boolean = false): string {
  const amount = Number(value);
  const numeric = Number.isFinite(amount) ? amount : 0;
  const hasDecimals = Math.round(numeric * 100) % 100 !== 0;
  const safeLocale = getSafeLatnLocale(locale);
  const formattedNum = numeric.toLocaleString(safeLocale, {
    minimumFractionDigits: trimDecimals && !hasDecimals ? 0 : 2,
    maximumFractionDigits: 2,
  }).replace(/[\u00A0\u202F]/g, ' ');
  return `${currency}${formattedNum}`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
