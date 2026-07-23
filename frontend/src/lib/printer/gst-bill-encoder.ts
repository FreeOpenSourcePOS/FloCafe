/**
 * gst-bill-encoder.ts
 *
 * Indian GST-compliant billing receipt encoder for ESC/POS thermal printers.
 * Supports both 58mm (2.5") and 80mm (3.5") paper widths.
 * Includes: GSTIN, HSN codes, CGST/SGST or IGST breakdown, item-wise tax.
 */

import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import type { Bill, Tenant } from '@/lib/types';
import { normalizeCurrencyToAscii, padCurrencyPrefix } from './unicode';
import { getCountryByCode, getCurrencySymbol } from '@/lib/countries';
import { formatDate } from './format-date';

export interface GstBillOptions {
  /** 58 mm (2.5", 32 chars) or 80 mm (3.5", 48 chars). Default: 58 */
  paperWidth?: 58 | 80;
  /** Show "Thank you" footer. Default: true */
  showFooter?: boolean;
  /** Business GSTIN number */
  gstin?: string;
  /** Business address */
  address?: string;
  /** Business phone */
  phone?: string;
  /** State code for GST calculation */
  stateCode?: string;
  /** If false (default), replace ₹/€/£/etc. with ASCII (Rs, EUR, GBP…). */
  useUnicode?: boolean;
}

const CHARS: Record<58 | 80, number> = { 58: 32, 80: 48 };

/**
 * Mask phone number for receipt display — shows only last 4 digits.
 */
function maskPhoneOnReceipt(phone: string): string {
  if (!phone || phone.length < 4) return phone;
  return 'x'.repeat(phone.length - 4) + phone.slice(-4);
}

/**
 * Build a GST-compliant bill byte array from a Bill object.
 */
export function buildGstBillBytes(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: GstBillOptions = {}
): Uint8Array {
  const { paperWidth = 58, showFooter = true, gstin, address, phone, useUnicode = false } = opts;
  const cols = CHARS[paperWidth];
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = padCurrencyPrefix(useUnicode ? rawCurrency : normalizeCurrencyToAscii(rawCurrency));
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const order = bill.order;

  const enc = new ReceiptPrinterEncoder({ columns: cols });

  // ── Header ────────────────────────────────────────────────────────────────
  enc.initialize().align('center');
  enc.bold(true).width(2).height(2).text(truncate(tenant.business_name, 16)).width(1).height(1);
  enc.bold(false).newline();

  if (address) {
    enc.text(truncate(address, cols)).newline();
  }
  if (phone) {
    enc.text(`Ph: ${phone}`).newline();
  }
  if (gstin) {
    enc.text(`GSTIN: ${gstin}`).newline();
  }

  enc.newline();

  // ── Bill Details ─────────────────────────────────────────────────────────
  enc.align('left');
  enc.text(`Bill #: ${bill.bill_number}`).newline();
  enc.text(`Date: ${formatDate(bill.order?.created_at, locale)}`).newline();

  if (order?.table?.name) {
    enc.text(`Table: ${order.table.name}`).newline();
  }
  if (order?.customer?.name) {
    enc.text(`Customer: ${order.customer.name}`);
    if (order.customer.phone) {
      enc.text(` (${maskPhoneOnReceipt(order.customer.phone)})`);
    }
    enc.newline();
  }

  enc.rule({ style: 'single' });

  // ── Line Items with HSN ─────────────────────────────────────────────────
  enc.text(padRow('Item', 'Qty Rate Amount', cols)).newline();
  enc.rule({ style: 'single' });

  const items = order?.items ?? [];
  for (const item of items) {
    const line = `${item.product_name}`;

    enc.text(padRow(line, formatAmount(item.total, currency, locale), cols)).newline();

    // Show HSN if available
    const hsnCode = 'hsn_code' in item ? (item as { hsn_code?: string }).hsn_code : undefined;
    if (hsnCode) {
      enc.size('small').text(`    HSN: ${hsnCode}`).size('normal').newline();
    }

    // Addons
    if (item.addons && item.addons.length > 0) {
      for (const addon of item.addons) {
        const qty = ('quantity' in addon && typeof addon.quantity === 'number') ? addon.quantity : 1;
        const addonLine = `   + ${addon.name}${qty > 1 ? ` x${qty}` : ''}`;
        const addonPrice = addon.price && Number(addon.price) > 0
          ? formatAmount(Number(addon.price) * qty * item.quantity, currency, locale)
          : '';
        enc.text(padRow(addonLine, addonPrice, cols)).newline();
      }
    }
  }

  enc.rule({ style: 'single' });

  // ── Tax Breakdown (GST) ─────────────────────────────────────────────────
  const taxBreakdown = bill.tax_breakdown || [];
  if (taxBreakdown.length > 0) {
    enc.text('Tax Details:').newline();

    let cgst = 0, sgst = 0, igst = 0;
    for (const tax of taxBreakdown) {
      if (tax.title === 'CGST') cgst += tax.amount;
      else if (tax.title === 'SGST') sgst += tax.amount;
      else if (tax.title === 'IGST') igst += tax.amount;
    }

    if (igst > 0) {
      // Inter-state - IGST
      enc.text(padRow('IGST @12%', formatAmount(igst, currency, locale), cols)).newline();
    } else {
      // Intra-state - CGST + SGST
      if (cgst > 0) {
        enc.text(padRow('CGST @6%', formatAmount(cgst, currency, locale), cols)).newline();
      }
      if (sgst > 0) {
        enc.text(padRow('SGST @6%', formatAmount(sgst, currency, locale), cols)).newline();
      }
    }
  }

  // ── Totals ───────────────────────────────────────────────────────────────
  enc.rule({ style: 'single' });

  const totals: [string, string][] = [
    ['Subtotal', formatAmount(bill.subtotal, currency, locale)],
  ];

  if (Number(bill.discount_amount) > 0) {
    totals.push(['Discount', `-${formatAmount(bill.discount_amount, currency, locale)}`]);
  }

  if (Number(bill.tax_amount) > 0) {
    totals.push(['Total Tax', formatAmount(bill.tax_amount, currency, locale)]);
  }

  if (Number(bill.service_charge) > 0) {
    totals.push(['Service Chg', formatAmount(bill.service_charge, currency, locale)]);
  }

  if (Number(bill.delivery_charge) > 0) {
    totals.push(['Delivery', formatAmount(bill.delivery_charge, currency, locale)]);
  }

  for (const [label, value] of totals) {
    enc.text(padRow(label, value, cols)).newline();
  }

  enc.rule({ style: 'double' });
  enc.bold(true).width(2).text(padRow('TOTAL', formatAmount(bill.total, currency, locale), cols)).width(1);
  enc.bold(false).newline();

  // ── Payment Details ───────────────────────────────────────────────────────
  if (bill.payment_details && bill.payment_details.length > 0) {
    enc.newline();
    enc.text('Payments:').newline();
    for (const p of bill.payment_details) {
      enc.text(padRow(capitalize(p.method), formatAmount(p.amount, currency, locale), cols)).newline();
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  if (showFooter) {
    enc.newline().align('center');
    enc.text('Thank you for your visit!').newline();
    enc.text('Please come again').newline();
    enc.text('Rates inclusive of GST').newline();
  }

  enc.newline().newline().newline().cut();

  return enc.encode();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padRow(left: string, right: string, cols: number): string {
  const gap = cols - left.length - right.length;
  return gap > 0 ? left + ' '.repeat(gap) + right : left.slice(0, cols - right.length - 1) + ' ' + right;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function formatAmount(value: number | string, currency: string, locale: string): string {
  return `${currency}${Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
