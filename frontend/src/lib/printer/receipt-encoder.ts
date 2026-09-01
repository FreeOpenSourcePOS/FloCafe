/**
 * receipt-encoder.ts
 *
 * Converts a Flo POS Bill (+ its nested Order) into raw ESC/POS bytes
 * using `@point-of-sale/receipt-printer-encoder` — now driven by the shared
 * renderer-independent PrintDocument (#444, epic #438): raw rows are
 * normalized once in `print-document.ts`, the semantic document is built via
 * `buildBillDocument`, and the classic/compact renderers below map document
 * blocks onto token lines. Labels arrive already resolved inside the
 * document (SemanticLabel) or through the injected catalog resolver — no
 * per-template label literals remain in the classic/compact paths.
 *
 * Two core receipt templates are available:
 *   buildClassicReceiptBytes  — rich legacy-style (default)
 *   buildCompactReceiptBytes  — minimal, fast
 *
 * `buildReceiptBytes` is kept as a re-export of the classic builder
 * for backward compatibility.
 *
 * LEGACY-FROZEN (#444 decision): `buildDetailedReceiptBytes` below is a
 * diagnostic/print-test-only template that is NOT migrated onto the
 * PrintDocument model. It keeps its historical raw-bill rendering and is
 * exempted from the document-driven contract so it cannot silently fork
 * semantics; future country-specific templates must come from the active
 * tax pack/plugin contract instead (see the block comment above it).
 */

import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Bill, Tenant } from '@/lib/types';
import { normalizeCurrencyToAscii, padCurrencyPrefix } from './unicode';
import { getCountryByCode, getCurrencySymbol } from '@/lib/countries';
import { formatDate } from './format-date';
import { formatTaxComponentLabel, resolveTaxComponents } from './tax-components';
import { parseDbTimestamp } from '@/lib/utils';
import { safePrinterText, type PrintWarning } from './warnings';
import { RECEIPT_BRANDING_NAME, RECEIPT_BRANDING_URL } from './branding';
import {
  buildFrontendBillDocument,
  printLabelResolver,
  resolveBillPrintLanguages,
} from './print-document';
import {
  getBlock,
  type BusinessHeaderBlock,
  type CustomerBlock,
  type DocumentMetaBlock,
  type ItemTableBlock,
  type MessageBlock,
  type PaymentsBlock,
  type PrintDocument,
  type SemanticLabel,
  type TaxBreakdownBlock,
  type TotalsBlock,
} from '@print/document';
import type { ResolvedPrintLanguages } from '@print/types';

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
  /**
   * Ordered receipt languages (primary first), resolved by the caller from
   * the print language policy. Defaults to the client policy resolution.
   */
  languages?: ResolvedPrintLanguages;
}

function printReprintBanner(
  enc: ReceiptPrinterEncoder,
  bannerLabel: string,
  warnings: PrintWarning[] | undefined,
  arabicShaping: boolean,
  cols: number,
): void {
  enc
    .align('center')
    .bold(true)
    .width(2)
    .height(2);
  safePrinterText(enc, `** ${bannerLabel} **`, warnings, false, arabicShaping, Math.floor(cols / 2));
  enc
    .width(1)
    .height(1)
    .bold(false)
    .newline()
    .align('left');
}

function printOnlineOrderBanner(
  enc: ReceiptPrinterEncoder,
  bannerLabel: string,
  platform: string,
  externalOrderId: string,
  warnings: PrintWarning[] | undefined,
  arabicShaping: boolean,
  cols: number,
): void {
  enc
    .align('center')
    .bold(true)
    .width(2)
    .height(2);
  safePrinterText(enc, `** ${bannerLabel} **`, warnings, false, arabicShaping, Math.floor(cols / 2));
  enc
    .width(1)
    .height(1)
    .newline();
  if (platform) safePrinterText(enc, platform, warnings, false, arabicShaping, cols).newline();
  if (externalOrderId) safePrinterText(enc, `#${externalOrderId}`, warnings, false, arabicShaping, cols).newline();
  enc
    .bold(false)
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
// Document render environment (shared by classic + compact)
// ---------------------------------------------------------------------------

interface DocumentBlocks {
  document: PrintDocument;
  header: BusinessHeaderBlock | undefined;
  meta: DocumentMetaBlock | undefined;
  customer: CustomerBlock | undefined;
  items: ItemTableBlock | undefined;
  breakdown: TaxBreakdownBlock | undefined;
  totals: TotalsBlock | undefined;
  payments: PaymentsBlock | undefined;
  messages: MessageBlock | undefined;
  languages: ResolvedPrintLanguages;
}

function labelOf(label: SemanticLabel): string {
  return label.primary;
}

/** Literal payment methods keep the legacy capitalize fallback. */
function paymentLabel(label: SemanticLabel): string {
  return label.conceptId !== undefined ? label.primary : capitalize(label.primary);
}

function capitalize(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

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

/**
 * Thermal-safe timestamp: numeric calendar fields on Latin digits, mirroring
 * the desktop document-classic renderer so the meta line stays printable by
 * generic ESC/POS printers for every locale.
 */
function formatThermalTimestamp(iso: string, locale: string): string {
  const parsed = parseDbTimestamp(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const safeLocale = getSafeLatnLocale(locale);
  return `${parsed.toLocaleDateString(safeLocale)} ${parsed.toLocaleTimeString(safeLocale)}`;
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

/**
 * Build the semantic document + resolved blocks for one thermal receipt.
 * Raw bill fields are read only here, via the shared normalization bridge.
 */
function buildReceiptEnvironment(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: ReceiptOptions,
  cols: number,
): DocumentBlocks {
  const languages = opts.languages ?? resolveBillPrintLanguages();
  const document = buildFrontendBillDocument(bill, tenant, {
    columns: cols,
    businessName: tenant.business_name,
    address: opts.address,
    phone: opts.phone,
    footerNote: opts.footerNote,
    taxRegistrationNumber: opts.taxRegistrationNumber,
    includeTaxId: !!opts.taxRegistrationNumber,
    taxIdLabel: getCountryByCode(tenant.country ?? 'IN')?.taxIdLabel || 'Tax ID',
    showTaxBreakdown: opts.showTaxBreakdown === true,
    showBusinessName: opts.showBusinessName,
    showCustomerName: opts.showCustomerName,
    showCustomerPhone: opts.showCustomerPhone,
    showTableNumber: opts.showTableNumber,
    isReprint: opts.isReprint,
    trimDecimals: opts.trimDecimals,
    languages,
  });
  return {
    document,
    header: getBlock(document, 'business-header'),
    meta: getBlock(document, 'document-meta'),
    customer: getBlock(document, 'customer'),
    items: getBlock(document, 'item-table'),
    breakdown: getBlock(document, 'tax-breakdown'),
    totals: getBlock(document, 'totals'),
    payments: getBlock(document, 'payments'),
    messages: getBlock(document, 'message'),
    languages,
  };
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
  rows: Array<{ unitPrice?: number; amount: number }>,
  currency: string,
  locale: string,
  trimDecimals: boolean,
): Col4Widths {
  const [, qtyWidth, minimumRateWidth, minimumAmountWidth] = col4Widths(cols);
  let rateWidth = minimumRateWidth;
  let amountWidth = minimumAmountWidth;

  for (const row of rows) {
    rateWidth = Math.max(rateWidth, formatAmount(row.unitPrice ?? 0, currency, locale, trimDecimals).length);
    amountWidth = Math.max(amountWidth, formatAmount(row.amount ?? 0, currency, locale, trimDecimals).length);
  }

  const valueBudget = cols - qtyWidth - 4;
  if (rateWidth + amountWidth > valueBudget) {
    amountWidth = Math.min(amountWidth, valueBudget - minimumRateWidth);
    rateWidth = valueBudget - amountWidth;
  }

  const nameWidth = cols - qtyWidth - rateWidth - amountWidth;
  return [nameWidth, qtyWidth, rateWidth, amountWidth];
}

function col4Header(widths: Col4Widths, labels: { item: string; qty: string; rate: string; amount: string }): string {
  const [w0, w1, w2, w3] = widths;
  const item = labels.item.padEnd(w0);
  const qty = labels.qty.padStart(w1);
  const rate = labels.rate.padStart(w2);
  const amt = labels.amount.padStart(w3);
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

export function buildClassicReceiptBytes(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: ReceiptOptions = {},
  warnings?: PrintWarning[]
): Uint8Array {
  const {
    paperWidth = 58,
    showFooter = true,
    useUnicode = false,
    arabicShaping = false,
  } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = resolveEncoderCurrency(rawCurrency, useUnicode);
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const env = buildReceiptEnvironment(bill, tenant, opts, cols);
  const { header, meta, customer, items, breakdown, totals, payments, messages, languages } = env;
  const primaryLang = languages[0];

  const col4Layout = resolveCol4Widths(
    cols,
    (items?.rows ?? []).map((row) => ({ unitPrice: row.unitPrice, amount: row.amount })),
    currency,
    locale,
    opts.trimDecimals === true,
  );
  const col4Labels = {
    item: labelOf(items?.header.item ?? { primary: '' }),
    qty: labelOf(items?.header.quantity ?? { primary: '' }),
    rate: printLabelResolver('receipt.rate', primaryLang),
    amount: printLabelResolver('printTest.amt', primaryLang),
  };

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (messages?.reprintBanner) printReprintBanner(enc, labelOf(messages.reprintBanner), warnings, arabicShaping, cols);
  if (messages?.onlineOrderBanner) {
    printOnlineOrderBanner(
      enc,
      labelOf(messages.onlineOrderBanner.label),
      messages.onlineOrderBanner.platform.text,
      messages.onlineOrderBanner.externalOrderId.text,
      warnings,
      arabicShaping,
      cols,
    );
  }

  // Business header (document block).
  if (header?.name) {
    enc.align('center').bold(true).width(2).height(2);
    safePrinterText(enc, truncate(header.name.text, 16), warnings, true, arabicShaping, Math.floor(cols / 2));
    enc.width(1).height(1).bold(false).newline();
  }

  // Document meta: table, customer, invoice number + timestamp.
  if (meta?.table) {
    enc.bold(true);
    safePrinterText(enc, meta.table.label.primary.replace('{name}', meta.table.name.text), warnings, false, arabicShaping, cols);
    enc.bold(false).newline();
  }
  if (customer?.name) {
    safePrinterText(enc, customer.name.text, warnings, false, arabicShaping, cols).newline();
  }
  if (customer?.phone) {
    enc.text(maskPhoneOnReceipt(customer.phone.text)).newline();
  }

  if (meta) {
    enc.size('small');
    safePrinterText(
      enc,
      padRow(
        `${labelOf(meta.invoiceNumberLabel)} ${meta.invoiceNumber.text}`,
        formatThermalTimestamp(meta.timestamp.text, locale),
        cols,
      ),
      warnings,
      false,
      arabicShaping,
    );
    enc
      .newline()
      .size('normal')
      .align('left')
      .rule({ style: 'single' });
  } else {
    enc.rule({ style: 'single' });
  }

  // 4-column header (labels from the document's item-table block).
  safePrinterText(enc, col4Header(col4Layout, col4Labels), warnings, false, arabicShaping).newline();
  enc.rule({ style: 'single' });

  // Line items
  for (const row of items?.rows ?? []) {
    for (const line of col4Rows(
      row.name.text,
      row.quantity,
      row.unitPrice ?? 0,
      row.amount,
      currency,
      col4Layout,
      locale,
      opts.trimDecimals === true,
    )) {
      safePrinterText(enc, line, warnings, false, arabicShaping).newline();
    }

    // Addons (extended amount arrives as printed truth in the document).
    for (const addon of row.addons) {
      const addonQty = addon.quantity ?? 1;
      const addonLabel = truncate(`  + ${addon.name.text}${addonQty > 1 ? ` x${addonQty}` : ''}`, cols - 8);
      if (addon.price > 0) {
        safePrinterText(enc, padRow(addonLabel, formatAmount(addon.price, currency, locale, opts.trimDecimals === true), cols), warnings, false, arabicShaping).newline();
      } else {
        safePrinterText(enc, addonLabel, warnings, false, arabicShaping).newline();
      }
    }

    // Special instructions
    if (row.specialInstructions) {
      safePrinterText(enc, truncate(`  >> ${row.specialInstructions.text}`, cols), warnings, false, arabicShaping).newline();
    }
  }

  enc.rule({ style: 'single' });

  // Totals
  if (totals) {
    safePrinterText(enc, padRow(labelOf(totals.subtotal.label), formatAmount(totals.subtotal.amount, currency, locale, opts.trimDecimals === true), cols), warnings, false, arabicShaping).newline();
    if (totals.discount) {
      safePrinterText(enc, padRow(labelOf(totals.discount.label), `-${formatAmount(totals.discount.amount, currency, locale, opts.trimDecimals === true)}`, cols), warnings, false, arabicShaping).newline();
    }
    if (totals.tax) {
      safePrinterText(enc, padRow(labelOf(totals.tax.label), formatAmount(totals.tax.amount, currency, locale, opts.trimDecimals === true), cols), warnings, false, arabicShaping).newline();
    }
    if (totals.serviceCharge) {
      safePrinterText(enc, padRow(labelOf(totals.serviceCharge.label), formatAmount(totals.serviceCharge.amount, currency, locale, opts.trimDecimals === true), cols), warnings, false, arabicShaping).newline();
    }
    if (totals.deliveryCharge) {
      safePrinterText(enc, padRow(labelOf(totals.deliveryCharge.label), formatAmount(totals.deliveryCharge.amount, currency, locale, opts.trimDecimals === true), cols), warnings, false, arabicShaping).newline();
    }

    enc.rule({ style: 'double' });
    enc.bold(true);
    safePrinterText(enc, padRow(labelOf(totals.grandTotal.label), formatAmount(totals.grandTotal.amount, currency, locale, opts.trimDecimals === true), cols), warnings, false, arabicShaping);
    enc
      .bold(false)
      .newline();
    enc.rule({ style: 'single' });
  }

  // Payment methods
  for (const line of payments?.lines ?? []) {
    safePrinterText(enc, padRow(paymentLabel(line.label), formatAmount(line.amount, currency, locale, opts.trimDecimals === true), cols), warnings, false, arabicShaping).newline();
  }

  enc.newline();

  // Tax breakdown (optional)
  if (breakdown && breakdown.lines.length > 0) {
    for (const line of breakdown.lines) {
      const rateSuffix = line.rate === null ? '' : ` @${line.rate}%`;
      safePrinterText(
        enc,
        padRow(` ${line.label.primary}${rateSuffix}`, formatAmount(line.amount, currency, locale, opts.trimDecimals === true), cols),
        warnings,
        false,
        arabicShaping,
      ).newline();
    }
  }

  // Footer
  if (showFooter) {
    if (header?.taxId && meta) {
      safePrinterText(enc, padRow(`${labelOf(header.taxId.label)}: ${header.taxId.value.text}`, `${labelOf(meta.invoiceNumberLabel)} ${meta.invoiceNumber.text}`, cols), warnings, false, arabicShaping).newline();
    }
    if (header?.address) {
      enc.align('center');
      safePrinterText(enc, truncate(header.address.text, cols), warnings, false, arabicShaping, cols).newline();
      enc.align('left');
    }
    if (header?.phone) {
      enc.align('center');
      safePrinterText(enc, `${printLabelResolver('print.call', primaryLang)}: ${header.phone.text}`, warnings, false, arabicShaping, cols).newline();
      enc.align('left');
    }
    enc.newline();
    enc.align('center');
    safePrinterText(enc, printLabelResolver('print.thankYouVisitAgain', primaryLang), warnings, false, arabicShaping, cols);
    enc.newline();
    if (messages?.footerNote) {
      safePrinterText(enc, truncate(messages.footerNote.text, cols), warnings, false, arabicShaping, cols).newline();
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
    useUnicode = false,
    arabicShaping = false,
  } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = resolveEncoderCurrency(rawCurrency, useUnicode);
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  // Business/show flags flow into the document via `opts`; the renderer only
  // sees resolved blocks.
  const env = buildReceiptEnvironment(bill, tenant, opts, cols);
  const { header, meta, customer, items, breakdown, totals, payments, messages, languages } = env;
  const primaryLang = languages[0];
  const trim = opts.trimDecimals === true;

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (messages?.reprintBanner) printReprintBanner(enc, labelOf(messages.reprintBanner), warnings, arabicShaping, cols);
  if (messages?.onlineOrderBanner) {
    printOnlineOrderBanner(
      enc,
      labelOf(messages.onlineOrderBanner.label),
      messages.onlineOrderBanner.platform.text,
      messages.onlineOrderBanner.externalOrderId.text,
      warnings,
      arabicShaping,
      cols,
    );
  }

  // Header (document business-header block)
  if (header?.name) {
    enc.align('center').bold(true);
    safePrinterText(enc, truncate(header.name.text, cols), warnings, true, arabicShaping, cols);
    enc.bold(false).newline();
  }
  enc.align('left').rule({ style: 'single' });

  // Invoice number and timestamp on one line (document-meta block)
  if (meta) {
    safePrinterText(
      enc,
      padRow(
        `${labelOf(meta.invoiceNumberLabel)} ${meta.invoiceNumber.text}`,
        formatThermalTimestamp(meta.timestamp.text, locale),
        cols,
      ),
      warnings,
      false,
      arabicShaping,
    ).newline();

    if (meta.table) {
      safePrinterText(enc, meta.table.label.primary.replace('{name}', meta.table.name.text), warnings, false, arabicShaping, undefined, cols).newline();
    }
  }
  if (customer?.name) {
    safePrinterText(enc, `${printLabelResolver('print.customerShort', primaryLang)}: ${truncate(customer.name.text, cols - 6)}`, warnings, false, arabicShaping, undefined, cols).newline();
  }
  if (customer?.phone) {
    safePrinterText(enc, `${printLabelResolver('print.numberShort', primaryLang)}: ${maskPhoneOnReceipt(customer.phone.text)}`, warnings, false, arabicShaping).newline();
  }

  enc.rule({ style: 'single' });

  // Items — compact: one line per item with total, qty x rate below if qty > 1
  for (const row of items?.rows ?? []) {
    const nameMax = cols - formatAmount(row.amount, currency, locale, trim).length - 1;
    safePrinterText(
      enc,
      padRow(truncate(row.name.text, nameMax), formatAmount(row.amount, currency, locale, trim), cols),
      warnings,
      false,
      arabicShaping,
      undefined,
      cols
    ).newline();

    if (row.quantity > 1) {
      enc
        .size('small')
        .align('right')
        .text(`${row.quantity} x ${formatAmount(row.unitPrice ?? 0, currency, locale, trim)}`)
        .newline()
        .size('normal')
        .align('left');
    }
  }

  enc.rule({ style: 'single' });

  if (totals?.discount) {
    safePrinterText(enc, padRow(labelOf(totals.discount.label), `-${formatAmount(totals.discount.amount, currency, locale, trim)}`, cols), warnings, false, arabicShaping).newline();
  }
  if (totals?.tax) {
    safePrinterText(enc, padRow(labelOf(totals.tax.label), formatAmount(totals.tax.amount, currency, locale, trim), cols), warnings, false, arabicShaping).newline();
  }
  if (totals?.serviceCharge) {
    safePrinterText(enc, padRow(labelOf(totals.serviceCharge.label), formatAmount(totals.serviceCharge.amount, currency, locale, trim), cols), warnings, false, arabicShaping).newline();
  }
  if (totals?.deliveryCharge) {
    safePrinterText(enc, padRow(labelOf(totals.deliveryCharge.label), formatAmount(totals.deliveryCharge.amount, currency, locale, trim), cols), warnings, false, arabicShaping).newline();
  }
  if (breakdown && breakdown.lines.length > 0) {
    for (const line of breakdown.lines) {
      const rateSuffix = line.rate === null ? '' : ` @${line.rate}%`;
      safePrinterText(enc, padRow(`${line.label.primary}${rateSuffix}`, formatAmount(line.amount, currency, locale, trim), cols), warnings, false, arabicShaping).newline();
    }
  }

  enc.rule({ style: 'double' });
  if (totals) {
    enc.bold(true);
    safePrinterText(enc, padRow(labelOf(totals.grandTotal.label), formatAmount(totals.grandTotal.amount, currency, locale, trim), cols), warnings, false, arabicShaping);
    enc
      .bold(false)
      .newline();
  }

  for (const line of payments?.lines ?? []) {
    safePrinterText(enc, padRow(paymentLabel(line.label), formatAmount(line.amount, currency, locale, trim), cols), warnings, false, arabicShaping).newline();
  }

  enc.newline().align('center');
  if (header?.taxId) {
    safePrinterText(enc, `${labelOf(header.taxId.label)}: ${header.taxId.value.text}`, warnings, false, arabicShaping, cols).newline();
  }
  if (header?.address) safePrinterText(enc, truncate(header.address.text, cols), warnings, false, arabicShaping, cols).newline();
  if (header?.phone) safePrinterText(enc, `${printLabelResolver('receipt.phone', primaryLang)}: ${header.phone.text}`, warnings, false, arabicShaping, cols).newline();
  safePrinterText(enc, printLabelResolver('print.thankYouShort', primaryLang), warnings, false, arabicShaping, cols).newline();
  if (messages?.footerNote) {
    safePrinterText(enc, truncate(messages.footerNote.text, cols), warnings, false, arabicShaping, cols).newline();
  }
  printPoweredByFooter(enc);

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Legacy detailed tax encoder — LEGACY-FROZEN (#444 decision, epic #438).
// Tax-specific templates are no longer exposed as core bill templates; this
// diagnostic renderer intentionally stays on the raw-bill path and is exempt
// from the PrintDocument migration so it cannot silently fork document
// semantics. Future country-specific templates should come from the active
// tax pack/plugin contract instead.
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
  const col4Layout = resolveCol4Widths(cols, (order?.items ?? []).map((item) => ({ unitPrice: Number(item?.unit_price) || 0, amount: Number(item?.total) || 0 })), currency, locale, trimDecimals);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (isReprint) printReprintBanner(enc, 'REPRINT', warnings, arabicShaping, cols);

  // Header
  if (showBusinessName && tenant.business_name) {
    enc.align('center').bold(true).width(2).height(2);
    safePrinterText(enc, truncate(tenant.business_name, 16), warnings, true, arabicShaping, Math.floor(cols / 2));
    enc.width(1).height(1).bold(false).newline();
  }

  if (taxRegistrationNumber) {
    enc.bold(true);
    safePrinterText(enc, `${taxIdLabel}: ${taxRegistrationNumber}`, warnings, false, arabicShaping, cols);
    enc.bold(false).newline();
  }

  enc.bold(true).text('TAX INVOICE').bold(false).newline();

  if (address) {
    safePrinterText(enc, truncate(address, cols), warnings, false, arabicShaping, cols).newline();
  }
  if (phone) {
    safePrinterText(enc, phone, warnings, false, arabicShaping, cols).newline();
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
      arabicShaping,
      undefined,
      cols
    ).newline();
  }
  if (showCustomerPhone && order?.customer?.phone) {
    safePrinterText(enc, `Customer No: ${maskPhoneOnReceipt(order.customer.phone)}`, warnings, false, arabicShaping).newline();
  }
  if (showTableNumber && order?.table?.name) {
    safePrinterText(enc, `Table: ${order.table.name}`, warnings, false, arabicShaping, undefined, cols).newline();
  }

  enc.rule({ style: 'single' });

  // 4-column items header
  enc.text(col4Header(col4Layout, { item: 'Item', qty: 'Qty', rate: 'Rate', amount: 'Amt' })).newline();

  // Line items
  const items = order?.items ?? [];
  for (const item of items) {
    for (const row of col4Rows(item.product_name, item.quantity, item.unit_price, item.total, currency, col4Layout, locale, trimDecimals)) {
      safePrinterText(enc, row, warnings, false, arabicShaping).newline();
    }

    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        const qty = addon.quantity || 1;
        const addonLabel = truncate(`  + ${addon.name}${qty > 1 ? ` x${qty}` : ''}`, cols - 8);
        if (addon.price && Number(addon.price) > 0) {
          const addonTotal = Number(addon.price) * qty * item.quantity;
          safePrinterText(enc, padRow(addonLabel, formatAmount(addonTotal, currency, locale, trimDecimals), cols), warnings, false, arabicShaping).newline();
        } else {
          safePrinterText(enc, addonLabel, warnings, false, arabicShaping).newline();
        }
      }
    }

    if (item.special_instructions) {
      safePrinterText(enc, truncate(`  >> ${item.special_instructions}`, cols), warnings, false, arabicShaping).newline();
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
    safePrinterText(enc, truncate(footerNote, cols), warnings, false, arabicShaping).newline();
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
