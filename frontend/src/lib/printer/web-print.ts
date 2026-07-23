/**
 * web-print.ts
 *
 * A4/A5 bill printing using browser's native print dialog.
 * Generates HTML that can be printed silently or shown to user.
 */

import type { Bill, Tenant } from '@/lib/types';
import toast from 'react-hot-toast';
import { normalizeCurrencyToAscii } from './unicode';
import { getCountryByCode, getCurrencySymbol } from '@/lib/countries';
import { formatDate } from './format-date';

export type PaperSize = 'a4' | 'a5' | 'thermal58' | 'thermal80';

/** Encodes HTML entity characters so database-sourced values can't inject markup/scripts into the bill print window. */
function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface WebPrintOptions {
  paperSize?: PaperSize;
  includeGst?: boolean;
  gstin?: string;
  address?: string;
  phone?: string;
  footerNote?: string;
  businessName?: string;
  useUnicode?: boolean;
  /** Show a large "REPRINT" banner so a reprinted bill can't be mistaken for the original. */
  isReprint?: boolean;
}

/**
 * Generate HTML for A4/A5 printing and open print dialog.
 */
export function printWebBill(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: WebPrintOptions = {}
): void {
  const { paperSize = 'a4', includeGst = false, gstin, address, phone, footerNote, businessName, useUnicode = false, isReprint = false } = opts;

  const html = generateBillHtml(bill, tenant, { paperSize, includeGst, gstin, address, phone, footerNote, businessName, useUnicode, isReprint });

  // Create a new window with the bill HTML
  const printWindow = window.open('', '_blank', 'width=800,height=600');
  if (!printWindow) {
    toast.error('Please allow popups to print bills');
    return;
  }

  printWindow.document.write(html);
  printWindow.document.close();

  // Wait for content to load then print
  printWindow.onload = () => {
    printWindow.print();
    // Close after print dialog is dismissed (optional)
    // printWindow.close();
  };
}

/**
 * Generate HTML string for the bill (without opening print dialog).
 * Useful for preview or PDF generation.
 */
export function generateBillHtml(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: WebPrintOptions = {}
): string {
  const { paperSize = 'a4', includeGst = false, gstin, address, phone, footerNote, businessName, useUnicode = false, isReprint = false } = opts;
  const displayName = businessName ?? tenant.business_name;
  const rawCurrency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const currency = useUnicode ? rawCurrency : normalizeCurrencyToAscii(rawCurrency);
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';
  const order = bill.order;

  const styles = getPaperStyles(paperSize);
  const taxBreakdown = bill.tax_breakdown || [];

  // Calculate GST components
  let cgst = 0, sgst = 0, igst = 0;
  for (const tax of taxBreakdown) {
    if (tax.title === 'CGST') cgst += tax.amount;
    else if (tax.title === 'SGST') sgst += tax.amount;
    else if (tax.title === 'IGST') igst += tax.amount;
  }

  const items = order?.items ?? [];

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bill #${escapeHtml(bill.bill_number)}</title>
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
    ${isReprint ? `<div class="reprint-banner">** REPRINT **</div>` : ''}
    <!-- Header -->
    <div class="header">
      ${displayName ? `<h1>${escapeHtml(displayName)}</h1>` : ''}
      ${address ? `<p>${escapeHtml(address).replace(/\n/g, '<br>')}</p>` : ''}
      ${phone ? `<p>Ph: ${escapeHtml(phone)}</p>` : ''}
      ${gstin ? `<p>GSTIN: ${escapeHtml(gstin)}</p>` : ''}
    </div>

    <!-- Bill Details -->
    <div class="bill-details">
      <table>
        <tr>
          <td><strong>Bill #:</strong> ${escapeHtml(bill.bill_number)}</td>
          <td><strong>Date:</strong> ${formatDate(order?.created_at, locale)}</td>
        </tr>
        ${order?.table?.name ? `<tr><td><strong>Table:</strong> ${escapeHtml(order.table.name)}</td><td></td></tr>` : ''}
        ${order?.customer?.name ? `<tr><td><strong>Customer:</strong> ${escapeHtml(order.customer.name)}${order.customer.phone ? ` (${escapeHtml(order.customer.phone)})` : ''}</td><td></td></tr>` : ''}
      </table>
    </div>

    <!-- Items Table -->
    <table class="items-table">
      <thead>
        <tr>
          <th>Item</th>
          <th class="text-right">Qty</th>
          <th class="text-right">Rate</th>
          <th class="text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
          <tr>
            <td>
              ${escapeHtml(item.product_name)}
              ${item.addons && item.addons.length > 0 ? `<br><small class="text-muted">${item.addons.map(a => `+ ${escapeHtml(a.name)}`).join(', ')}</small>` : ''}
              ${item.special_instructions ? `<br><small class="text-italic">${escapeHtml(item.special_instructions)}</small>` : ''}
            </td>
            <td class="text-right">${item.quantity}</td>
            <td class="text-right">${formatAmount(Number(item.unit_price), currency, locale)}</td>
            <td class="text-right">${formatAmount(item.total, currency, locale)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <!-- Tax Breakdown (GST) -->
    ${includeGst && taxBreakdown.length > 0 ? `
    <table class="tax-table">
      <thead>
        <tr><th colspan="2">Tax Details</th></tr>
      </thead>
      <tbody>
        ${igst > 0 ? `
          <tr><td>IGST @${taxBreakdown.find(t => t.title === 'IGST')?.rate || 12}%</td><td class="text-right">${formatAmount(igst, currency, locale)}</td></tr>
        ` : `
          ${cgst > 0 ? `<tr><td>CGST @${taxBreakdown.find(t => t.title === 'CGST')?.rate || 6}%</td><td class="text-right">${formatAmount(cgst, currency, locale)}</td></tr>` : ''}
          ${sgst > 0 ? `<tr><td>SGST @${taxBreakdown.find(t => t.title === 'SGST')?.rate || 6}%</td><td class="text-right">${formatAmount(sgst, currency, locale)}</td></tr>` : ''}
        `}
      </tbody>
    </table>
    ` : ''}

    <!-- Totals -->
    <table class="totals-table">
      <tr><td>Subtotal</td><td class="text-right">${formatAmount(bill.subtotal, currency, locale)}</td></tr>
      ${Number(bill.discount_amount) > 0 ? `<tr><td>Discount</td><td class="text-right">-${formatAmount(bill.discount_amount, currency, locale)}</td></tr>` : ''}
      ${Number(bill.tax_amount) > 0 ? `<tr><td>Total Tax</td><td class="text-right">${formatAmount(bill.tax_amount, currency, locale)}</td></tr>` : ''}
      ${Number(bill.service_charge) > 0 ? `<tr><td>Service Charge</td><td class="text-right">${formatAmount(bill.service_charge, currency, locale)}</td></tr>` : ''}
      ${Number(bill.delivery_charge) > 0 ? `<tr><td>Delivery Charge</td><td class="text-right">${formatAmount(bill.delivery_charge, currency, locale)}</td></tr>` : ''}
      <tr class="total-row"><td><strong>Grand Total</strong></td><td class="text-right"><strong>${formatAmount(bill.total, currency, locale)}</strong></td></tr>
    </table>

    <!-- Payments -->
    ${bill.payment_details && bill.payment_details.length > 0 ? `
    <table class="payments-table">
      <thead>
        <tr><th colspan="2">Payments</th></tr>
      </thead>
      <tbody>
        ${bill.payment_details.map(p => `
          <tr><td>${capitalize(p.method)}</td><td class="text-right">${formatAmount(p.amount, currency, locale)}</td></tr>
        `).join('')}
      </tbody>
    </table>
    ` : ''}

    <!-- Footer -->
    <div class="footer">
      ${footerNote ? `<p>${escapeHtml(footerNote)}</p>` : '<p>Thank you for your visit!</p>'}
      ${includeGst ? '<p>Rates inclusive of GST</p>' : ''}
    </div>
  </div>

  <div class="no-print" style="text-align:center;margin-top:20px;">
    <button onclick="window.print()" style="padding:10px 20px;font-size:16px;cursor:pointer;">Print Bill</button>
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
    body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 12px; line-height: 1.4; color: #333; }
    .bill-container { max-width: 100%; margin: 0 auto; }
    .reprint-banner { text-align: center; font-size: 22px; font-weight: bold; letter-spacing: 2px; color: #c00; border: 3px solid #c00; padding: 6px; margin-bottom: 15px; }
    .header { text-align: center; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #ccc; }
    .header h1 { font-size: 24px; margin-bottom: 5px; }
    .bill-details { margin-bottom: 15px; }
    .bill-details table { width: 100%; }
    .items-table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
    .items-table th, .items-table td { padding: 8px; border-bottom: 1px solid #eee; text-align: left; }
    .items-table th { background: #f5f5f5; font-weight: bold; }
    .tax-table, .payments-table { width: 50%; margin-left: 50%; border-collapse: collapse; margin-bottom: 15px; }
    .tax-table th, .tax-table td, .payments-table th, .payments-table td { padding: 6px 8px; }
    .tax-table th, .payments-table th { background: #f9f9f9; text-align: left; }
    .totals-table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
    .totals-table td { padding: 6px 8px; }
    .total-row { border-top: 2px solid #333; font-size: 16px; }
    .footer { text-align: center; margin-top: 30px; padding-top: 15px; border-top: 1px solid #ccc; }
    .text-right { text-align: right !important; }
    .text-muted { color: #666; }
    .text-italic { font-style: italic; color: #888; }
  `;

  switch (size) {
    case 'a4':
      return baseStyles + `
        .bill-container { padding: 40px; max-width: 210mm; min-height: 297mm; }
      `;
    case 'a5':
      return baseStyles + `
        .bill-container { padding: 20px; max-width: 148mm; min-height: 210mm; font-size: 11px; }
        .header h1 { font-size: 18px; }
      `;
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

function formatAmount(value: number | string, currency: string, locale: string): string {
  return `${currency}${Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
