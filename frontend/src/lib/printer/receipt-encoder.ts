/**
 * receipt-encoder.ts
 *
 * Converts a Flo POS Bill (+ its nested Order) into raw ESC/POS bytes
 * using `@point-of-sale/receipt-printer-encoder`.
 *
 * Three templates are available:
 *   buildClassicReceiptBytes  — rich legacy-style (default)
 *   buildCompactReceiptBytes  — minimal, fast
 *   buildDetailedReceiptBytes — detailed tax invoice
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
  /** If false (default), replace ₹/€/£/etc. with ASCII (Rs, EUR, GBP…). */
  useUnicode?: boolean;
  /** Print a large "REPRINT" banner at the top so a reprinted receipt can't be mistaken for the original. */
  isReprint?: boolean;
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
 * Column widths for 4-column item tables.
 * Layout: [name, qty, rate, amount]
 */
function col4Widths(cols: number): [number, number, number, number] {
  if (cols >= 48) return [20, 4, 11, 13];
  // 32 cols: 14 + 3 + 7 + 8 = 32
  return [14, 3, 7, 8];
}

function col4Header(cols: number): string {
  const [w0, w1, w2, w3] = col4Widths(cols);
  const item = ' Item'.padEnd(w0);
  const qty = 'Qty'.padStart(w1);
  const rate = 'Rate'.padStart(w2);
  const amt = 'Amt'.padStart(w3);
  return item + qty + rate + amt;
}

function col4Row(
  name: string,
  qty: number,
  rate: number | string,
  amount: number | string,
  currency: string,
  cols: number,
  locale: string
): string {
  const [w0, w1, w2, w3] = col4Widths(cols);
  const nameStr = truncate(name, w0).padEnd(w0);
  const qtyStr = String(qty).padStart(w1);
  const rateStr = formatAmount(rate, currency, locale).padStart(w2);
  const amtStr = formatAmount(amount, currency, locale).padStart(w3);
  return nameStr + qtyStr + rateStr + amtStr;
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
    footerNote,
    taxRegistrationNumber,
    address,
    phone,
    showTaxBreakdown = false,
    useUnicode = false,
    isReprint = false,
  } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = padCurrencyPrefix(useUnicode ? rawCurrency : normalizeCurrencyToAscii(rawCurrency));
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const taxIdLabel = getCountryByCode(tenant.country ?? 'IN')?.taxIdLabel || 'Tax ID';
  const order = bill.order;
  const taxComponents = resolveTaxComponents(bill);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (isReprint) printReprintBanner(enc);

  // Header
  enc.align('center').bold(true).width(2).height(2);
  safePrinterText(enc, truncate(tenant.business_name, 16), warnings, true);
  enc.width(1).height(1).bold(false).newline();

  if (order?.table?.name) {
    enc.bold(true);
    safePrinterText(enc, `Table: ${order.table.name}`, warnings);
    enc.bold(false).newline();
  }
  if (order?.customer?.name) {
    safePrinterText(enc, order.customer.name, warnings).newline();
    if (order.customer.phone) {
      enc.text(maskPhoneOnReceipt(order.customer.phone)).newline();
    }
  }

  enc
    .size('small')
    .text(padRow(`Bill #${bill.bill_number}`, formatDate(bill.order?.created_at, locale), cols))
    .newline()
    .size('normal')
    .align('left')
    .rule({ style: 'single' });

  // 4-column header
  enc.text(col4Header(cols)).newline();
  enc.rule({ style: 'single' });

  // Line items
  const items = order?.items ?? [];
  for (const item of items) {
    safePrinterText(
      enc,
      col4Row(item.product_name, item.quantity, item.unit_price, item.total, currency, cols, locale),
      warnings
    ).newline();

    // Addons
    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        const qty = addon.quantity || 1;
        const addonLabel = truncate(`  + ${addon.name}${qty > 1 ? ` x${qty}` : ''}`, cols - 8);
        if (addon.price && Number(addon.price) > 0) {
          const addonTotal = Number(addon.price) * qty * item.quantity;
          safePrinterText(enc, padRow(addonLabel, formatAmount(addonTotal, currency, locale), cols), warnings).newline();
        } else {
          safePrinterText(enc, addonLabel, warnings).newline();
        }
      }
    }

    // Special instructions
    if (item.special_instructions) {
      safePrinterText(enc, truncate(`  >> ${item.special_instructions}`, cols), warnings).newline();
    }
  }

  enc.rule({ style: 'single' });

  // Totals
  enc.text(padRow('Subtotal', formatAmount(bill.subtotal, currency, locale), cols)).newline();
  if (Number(bill.discount_amount) > 0) {
    enc.text(padRow('Discount', `-${formatAmount(bill.discount_amount, currency, locale)}`, cols)).newline();
  }
  if (Number(bill.tax_amount) > 0) {
    enc.text(padRow('Tax', formatAmount(bill.tax_amount, currency, locale), cols)).newline();
  }
  if (Number(bill.service_charge) > 0) {
    enc.text(padRow('Service Charge', formatAmount(bill.service_charge, currency, locale), cols)).newline();
  }
  if (Number(bill.delivery_charge) > 0) {
    enc.text(padRow('Delivery', formatAmount(bill.delivery_charge, currency, locale), cols)).newline();
  }

  enc.rule({ style: 'double' });
  enc
    .bold(true)
    .text(padRow('TOTAL', formatAmount(bill.total, currency, locale), cols))
    .bold(false)
    .newline();
  enc.rule({ style: 'single' });

  // Payment methods
  if (bill.payment_details && bill.payment_details.length > 0) {
    for (const p of bill.payment_details) {
      enc.text(padRow(capitalize(p.method), formatAmount(p.amount, currency, locale), cols)).newline();
    }
  }

  enc.newline();

  // Tax breakdown (optional)
  if (showTaxBreakdown && taxComponents.length > 0) {
    for (const component of taxComponents) {
      enc
        .text(padRow(` ${formatTaxComponentLabel(component)}`, formatAmount(component.amount, currency, locale), cols))
        .newline();
    }
  }

  // Footer
  if (showFooter) {
    if (taxRegistrationNumber) {
      safePrinterText(enc, padRow(`${taxIdLabel}: ${taxRegistrationNumber}`, `Bill #${bill.bill_number}`, cols), warnings).newline();
    }
    if (address) {
      enc.align('center');
      safePrinterText(enc, truncate(address, cols), warnings).newline();
      enc.align('left');
    }
    if (phone) {
      enc.align('center');
      safePrinterText(enc, `Call: ${phone}`, warnings).newline();
      enc.align('left');
    }
    enc.newline();
    enc.align('center').text('Thank you! Please visit again').newline();
    if (footerNote) {
      safePrinterText(enc, truncate(footerNote, cols), warnings).newline();
    }
    enc.align('left');
  }

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
  const { paperWidth = 58, footerNote, useUnicode = false, isReprint = false } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = padCurrencyPrefix(useUnicode ? rawCurrency : normalizeCurrencyToAscii(rawCurrency));
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const order = bill.order;

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (isReprint) printReprintBanner(enc);

  // Header
  enc.align('center').bold(true);
  safePrinterText(enc, truncate(tenant.business_name, cols), warnings, true);
  enc.bold(false).newline().align('left').rule({ style: 'single' });

  // Bill # and date on one line
  enc
    .text(padRow(`Bill #${bill.bill_number}`, formatDate(bill.order?.created_at, locale), cols))
    .newline();

  if (order?.table?.name) {
    safePrinterText(enc, `Table: ${order.table.name}`, warnings).newline();
  }
  if (order?.customer?.name) {
    const maskedPhone = order.customer.phone ? ` (${maskPhoneOnReceipt(order.customer.phone)})` : '';
    safePrinterText(enc, `Cust: ${truncate(order.customer.name + maskedPhone, cols - 6)}`, warnings).newline();
  }

  enc.rule({ style: 'single' });

  // Items — compact: one line per item with total, qty x rate below if qty > 1
  const items = order?.items ?? [];
  for (const item of items) {
    const nameMax = cols - formatAmount(item.total, currency, locale).length - 1;
    safePrinterText(
      enc,
      padRow(truncate(item.product_name, nameMax), formatAmount(item.total, currency, locale), cols),
      warnings
    ).newline();

    if (item.quantity > 1) {
      enc
        .size('small')
        .align('right')
        .text(`${item.quantity} x ${formatAmount(item.unit_price, currency, locale)}`)
        .newline()
        .size('normal')
        .align('left');
    }
  }

  enc.rule({ style: 'single' });

  if (Number(bill.discount_amount) > 0) {
    enc.text(padRow('Discount', `-${formatAmount(bill.discount_amount, currency, locale)}`, cols)).newline();
  }
  if (Number(bill.tax_amount) > 0) {
    enc.text(padRow('Tax', formatAmount(bill.tax_amount, currency, locale), cols)).newline();
  }

  enc.rule({ style: 'double' });
  enc
    .bold(true)
    .text(padRow('TOTAL', formatAmount(bill.total, currency, locale), cols))
    .bold(false)
    .newline();

  if (bill.payment_details && bill.payment_details.length > 0) {
    for (const p of bill.payment_details) {
      enc.text(padRow(capitalize(p.method), formatAmount(p.amount, currency, locale), cols)).newline();
    }
  }

  enc.newline().align('center').text('Thank you!').newline();
  if (footerNote) {
    safePrinterText(enc, truncate(footerNote, cols), warnings).newline();
  }
  enc.align('left');

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Detailed tax template
// ---------------------------------------------------------------------------

export function buildDetailedReceiptBytes(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: ReceiptOptions = {},
  warnings?: PrintWarning[]
): Uint8Array {
  const { paperWidth = 58, footerNote, taxRegistrationNumber, address, phone, useUnicode = false, isReprint = false } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = padCurrencyPrefix(useUnicode ? rawCurrency : normalizeCurrencyToAscii(rawCurrency));
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const taxIdLabel = getCountryByCode(tenant.country ?? 'IN')?.taxIdLabel || 'Tax ID';
  const order = bill.order;
  const taxComponents = resolveTaxComponents(bill);

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  enc.initialize();
  if (isReprint) printReprintBanner(enc);

  // Header
  enc.align('center').bold(true).width(2).height(2);
  safePrinterText(enc, truncate(tenant.business_name, 16), warnings, true);
  enc.width(1).height(1).bold(false).newline();

  if (taxRegistrationNumber) {
    enc.bold(true);
    safePrinterText(enc, `${taxIdLabel}: ${taxRegistrationNumber}`, warnings);
    enc.bold(false).newline();
  }

  enc.bold(true).text('TAX INVOICE').bold(false).newline();

  if (address) {
    safePrinterText(enc, truncate(address, cols), warnings).newline();
  }
  if (phone) {
    safePrinterText(enc, phone, warnings).newline();
  }

  enc.align('left').rule({ style: 'single' });

  // Bill info
  enc
    .text(padRow(`Bill #: ${bill.bill_number}`, formatDate(bill.order?.created_at, locale), cols))
    .newline();

  if (order?.customer?.name) {
    safePrinterText(
      enc,
      padRow(
        `Customer: ${truncate(order.customer.name, cols - 20)}`,
        order.customer.phone ? maskPhoneOnReceipt(order.customer.phone) : '',
        cols
      ),
      warnings
    ).newline();
  }
  if (order?.table?.name) {
    safePrinterText(enc, `Table: ${order.table.name}`, warnings).newline();
  }

  enc.rule({ style: 'single' });

  // 4-column items header
  enc.text(col4Header(cols)).newline();

  // Line items
  const items = order?.items ?? [];
  for (const item of items) {
    safePrinterText(
      enc,
      col4Row(item.product_name, item.quantity, item.unit_price, item.total, currency, cols, locale),
      warnings
    ).newline();

    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        const qty = addon.quantity || 1;
        const addonLabel = truncate(`  + ${addon.name}${qty > 1 ? ` x${qty}` : ''}`, cols - 8);
        if (addon.price && Number(addon.price) > 0) {
          const addonTotal = Number(addon.price) * qty * item.quantity;
          safePrinterText(enc, padRow(addonLabel, formatAmount(addonTotal, currency, locale), cols), warnings).newline();
        } else {
          safePrinterText(enc, addonLabel, warnings).newline();
        }
      }
    }

    if (item.special_instructions) {
      safePrinterText(enc, truncate(`  >> ${item.special_instructions}`, cols), warnings).newline();
    }
  }

  enc.rule({ style: 'single' });

  // Subtotal (excl. tax)
  enc
    .text(padRow('Subtotal (excl. tax)', formatAmount(bill.subtotal, currency, locale), cols))
    .newline();

  enc.rule({ style: 'single' });

  // Tax breakdown — always shown in detailed mode
  if (taxComponents.length > 0) {
    for (const component of taxComponents) {
      enc
        .text(padRow(` ${formatTaxComponentLabel(component)}`, formatAmount(component.amount, currency, locale), cols))
        .newline();
    }
  } else if (Number(bill.tax_amount) > 0) {
    enc.text(padRow('Tax', formatAmount(bill.tax_amount, currency, locale), cols)).newline();
  }

  enc.rule({ style: 'double' });
  enc
    .bold(true)
    .text(padRow('TOTAL', formatAmount(bill.total, currency, locale), cols))
    .bold(false)
    .newline();
  enc.rule({ style: 'single' });

  // Payment methods
  if (bill.payment_details && bill.payment_details.length > 0) {
    for (const p of bill.payment_details) {
      enc.text(padRow(capitalize(p.method), formatAmount(p.amount, currency, locale), cols)).newline();
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
    safePrinterText(enc, truncate(footerNote, cols), warnings).newline();
  }
  enc.align('left');

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

function formatAmount(value: number | string, currency: string, locale: string): string {
  return `${currency}${Number(value).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
