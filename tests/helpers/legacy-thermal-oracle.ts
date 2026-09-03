/**
 * LEGACY THERMAL RENDERER ORACLE (#443, epic #438) — TEST-ONLY.
 *
 * Verbatim copies of the pre-migration `formatClassicReceipt`,
 * `formatCompactReceipt` and `formatKOT` bodies from
 * `main/printers/thermal.ts`, captured before the backend migrated to the
 * PrintDocument model. Nothing in `main/` imports this module; it exists so
 * tests/print-parity.test.ts can enforce byte-equivalence between the
 * document-driven production renderers and the expected printed output at
 * every supported width (32/42/48 columns).
 *
 * The receipt oracle preserves the legacy layout, but its add-on amount is
 * materialized from the authoritative financial semantics
 * (`price × addonQty × itemQty`) so parity tests do not preserve the
 * confirmed undercharged output. Do not make unrelated changes here.
 */

import { parseDbTimestamp } from '../../main/db';
import { getCountryByCode } from '../../main/countries';
import { resolveTaxComponents } from '../../main/services/tax-components';
import type { PrinterCutMode } from '../../main/printers/profiles';
import {
  addonRows,
  appendPoweredByFooter,
  buildEscPos,
  financialRows,
  formatCurrency,
  formatTableLabel,
  itemAmountWidth,
  itemRows,
  itemNameWidth,
  normalizePrintLanguage,
  pushCenteredWrapped,
  pushWrapped,
  resolveCurrencyPrefix,
  rightAlign,
  truncate,
  truncateShapedLine,
} from '../../main/printers/thermal';
import { printLabel } from '../../main/print/print-labels.generated';

function parseAddons(addons: any): any[] {
  return Array.isArray(addons) ? addons : [];
}

function withExtendedAddonAmounts(order: any): any {
  return {
    ...order,
    items: Array.isArray(order?.items) ? order.items.map((item: any) => ({
      ...item,
      addons: parseAddons(item.addons).map((addon: any) => ({
        ...addon,
        price: (Number(addon?.price) || 0) * (Number(addon?.quantity) || 1) * (Number(item?.quantity) || 0),
      })),
    })) : order?.items,
  };
}

function itemHeaderLegacy(lang: string, nameLen: number, amtLen: number): string {
  const qtyW = 4;
  const item = printLabel(lang, 'receipt.item').slice(0, nameLen).padEnd(nameLen);
  const qty = printLabel(lang, 'receipt.qty').slice(0, qtyW).padEnd(qtyW);
  const amount = printLabel(lang, 'receipt.amount').slice(0, Math.max(1, amtLen - 1));
  return (
    item + qty + ' '.repeat(amtLen - amount.length) + amount
  );
}

/** Ported legacy payment-method label resolution (#440). */
function resolvePaymentMethodLabel(method: string, lang: string): string {
  const concepts: Record<string, string> = { cash: 'pos.methodCash', card: 'pos.methodCard', wallet: 'pos.methodWallet' };
  const concept = concepts[String(method || '').toLowerCase()];
  if (concept) return printLabel(lang, concept as any);
  const text = String(method || '');
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Classic receipt (verbatim pre-#443 body)
// ---------------------------------------------------------------------------

export function formatClassicReceiptLegacy(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full', warnings?: any[], arabicShaping: boolean = false, lang: string = 'en'): Buffer {
  const lines: string[] = [];
  const date = parseDbTimestamp(order.created_at);

  const dash = '-'.repeat(cols);

  const prefix = resolveCurrencyPrefix(biz.currency_symbol || '₹', useUnicode);
  const trimDecimals = biz.trim_decimals === true;
  const locale = getCountryByCode(biz.country)?.locale ?? 'en-US';
  const amtLen = itemAmountWidth(withExtendedAddonAmounts(order), prefix, locale, trimDecimals, cols);
  const itemNameLen = itemNameWidth(cols, amtLen);
  const taxComponents = resolveTaxComponents({ ...bill, items: order.items });
  const hasTax = Number(bill.tax_amount) !== 0
    || taxComponents.some((component) => component.amount !== 0);

  const tzOptions = biz.timezone ? { timeZone: biz.timezone } : undefined;

  lines.push('{INIT}');
  if (isReprint) lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + printLabel(lang, 'receipt.reprint') + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');

  // Header: store name (Font A, big + bold), then customer name (Font B) and
  // mobile number, each only if the bill actually has that data.
  if (biz.show_name !== false && biz.name) lines.push('{STORE_NAME}{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}' + truncateShapedLine(String(biz.name), Math.floor(cols / 2), arabicShaping) + '{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  if (biz.show_customer_name !== false && biz.customer_name) lines.push('{CENTER}{FONT_B}' + truncateShapedLine(String(biz.customer_name), cols, arabicShaping) + '{/FONT_B}{/CENTER}');
  if (biz.show_customer_phone !== false && biz.customer_phone) lines.push('{CENTER}' + biz.customer_phone + '{/CENTER}');

  lines.push(dash);
  lines.push('{CENTER}' + printLabel(lang, 'print.invoiceNumber') + ' ' + (bill.bill_number || order.order_number) + '{/CENTER}');
  lines.push('{CENTER}' + date.toLocaleDateString(locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(locale + '-u-nu-latn', tzOptions) + '{/CENTER}');
  if (biz.show_table_number !== false && order.table?.name) lines.push('{CENTER}' + truncateShapedLine(formatTableLabel(order.table.name, lang), cols, arabicShaping) + '{/CENTER}');
  lines.push(dash);

  lines.push(itemHeaderLegacy(lang, itemNameLen, amtLen));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(...itemRows(item, itemNameLen, amtLen, cols, prefix, locale, trimDecimals));

      const addons = parseAddons(item.addons);
      for (const addon of addons) {
        lines.push(...addonRows({
          ...addon,
          price: (Number(addon?.price) || 0) * (Number(addon?.quantity) || 1) * (Number(item?.quantity) || 0),
        }, itemNameLen, amtLen, cols, prefix, locale, trimDecimals));
      }
      if (item.special_instructions) {
        lines.push('  ' + printLabel(lang, 'print.note') + ': ' + truncate(item.special_instructions, cols - 8));
      }
    }
  }

  lines.push(dash);

  // Redeemed points sit above the subtotal, only if present.
  if (biz.points_redeemed > 0) {
    const label = printLabel(lang, 'print.pointsRedeemed');
    lines.push(label + rightAlign('-' + biz.points_redeemed + ' pts', cols - label.length));
  }

  lines.push(...financialRows(printLabel(lang, 'pos.subtotal'), formatCurrency(bill.subtotal, prefix, locale, trimDecimals), cols));
  if (bill.discount_amount > 0) {
    lines.push(...financialRows(printLabel(lang, 'pos.discount'), '-' + formatCurrency(bill.discount_amount, prefix, locale, trimDecimals), cols));
  }
  if (biz.show_tax_breakdown === true && taxComponents.length > 0) {
    for (const tax of taxComponents) {
      if (tax.amount === 0) continue;
      const rawLabel = tax.rate === null ? tax.title : `${tax.title} @${tax.rate}%`;
      const label = truncate(rawLabel, cols - 12);
      lines.push(...financialRows(label, formatCurrency(tax.amount, prefix, locale, trimDecimals), cols));
    }
  } else if (Number(bill.tax_amount) !== 0) {
    lines.push(...financialRows(printLabel(lang, 'pos.tax'), formatCurrency(bill.tax_amount, prefix, locale, trimDecimals), cols));
  }
  if ((Number(bill.service_charge) || 0) !== 0) {
    lines.push(...financialRows(printLabel(lang, 'receipt.serviceCharge'), formatCurrency(bill.service_charge, prefix, locale, trimDecimals), cols));
  }
  if (Number(bill.delivery_charge) !== 0) {
    lines.push(...financialRows(printLabel(lang, 'pos.delivery'), formatCurrency(bill.delivery_charge, prefix, locale, trimDecimals), cols));
  }
  if (Number(bill.packaging_charge) !== 0) {
    lines.push(...financialRows(printLabel(lang, 'pos.packaging'), formatCurrency(bill.packaging_charge, prefix, locale, trimDecimals), cols));
  }
  lines.push(...financialRows(printLabel(lang, 'print.grandTotal'), formatCurrency(bill.total, prefix, locale, trimDecimals), cols).map((line: string) => `{BOLD}${line}{/BOLD}`));

  if (bill.payment_details) {
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            const methodLabel = truncate(resolvePaymentMethodLabel(String(payment.method), lang), cols - 12);
            lines.push(...financialRows(methodLabel, formatCurrency(payment.amount, prefix, locale, trimDecimals), cols));
          }
        }
      }
    } catch (err: any) {
      console.warn('[Printer] Failed to parse payment details JSON:', err.message);
    }
  }

  // Earned points this bill + running balance, each only if nonzero.
  const hasEarned = biz.points_earned > 0;
  const hasBalance = biz.points_balance !== null && biz.points_balance !== undefined && biz.points_balance !== 0;
  if (hasEarned || hasBalance) {
    lines.push(dash);
    if (hasEarned) {
      const earnedLabel = printLabel(lang, 'print.pointsEarned');
      lines.push(earnedLabel + rightAlign(String(biz.points_earned), cols - earnedLabel.length));
    }
    if (hasBalance) {
      const balanceLabel = printLabel(lang, 'print.pointsBalance');
      lines.push(balanceLabel + rightAlign(String(biz.points_balance), cols - balanceLabel.length));
    }
  }

  // Footer: store contact details, only the ones actually configured.
  const footerLines: string[] = [];
  if (biz.show_address !== false && biz.address) footerLines.push(biz.address);
  if (biz.show_phone !== false && biz.phone) footerLines.push(printLabel(lang, 'receipt.phone') + ': ' + biz.phone);
  if ((biz.show_tax_id === true || (biz.show_tax_id !== false && hasTax)) && biz.taxRegistrationNumber) footerLines.push((getCountryByCode(biz.country)?.taxIdLabel || 'Tax ID') + ': ' + biz.taxRegistrationNumber);
  if (biz.instagram_handle) footerLines.push(biz.instagram_handle);
  if (footerLines.length > 0) {
    lines.push(dash);
    for (const footerLine of footerLines) pushCenteredWrapped(lines, footerLine, cols);
  }

  if (biz.footer_note) pushCenteredWrapped(lines, biz.footer_note, cols);

  appendPoweredByFooter(lines);
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode, { cutMode, arabicShaping, columns: cols }, warnings);
}

// ---------------------------------------------------------------------------
// Compact receipt (verbatim pre-#443 body)
// ---------------------------------------------------------------------------

export function formatCompactReceiptLegacy(order: any, bill: any, biz: any, cols: number = 48, useUnicode: boolean = false, isReprint: boolean = false, cutMode: PrinterCutMode = 'full', warnings?: any[], arabicShaping: boolean = false, lang: string = 'en'): Buffer {
  const lines: string[] = [];
  const date = parseDbTimestamp(order.created_at);

  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);

  const prefix = resolveCurrencyPrefix(biz.currency_symbol || '₹', useUnicode);
  const trimDecimals = biz.trim_decimals === true;
  const locale = getCountryByCode(biz.country)?.locale ?? 'en-US';
  const amtLen = itemAmountWidth(withExtendedAddonAmounts(order), prefix, locale, trimDecimals, cols);
  const itemNameLen = itemNameWidth(cols, amtLen);
  const taxIdLabel = getCountryByCode(biz.country)?.taxIdLabel || 'Tax ID';
  const taxComponents = resolveTaxComponents({ ...bill, items: order.items });
  const hasTax = Number(bill.tax_amount) !== 0
    || taxComponents.some((component) => component.amount !== 0);

  const tzOptions = biz.timezone ? { timeZone: biz.timezone } : undefined;

  lines.push('{INIT}');
  if (isReprint) lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + printLabel(lang, 'receipt.reprint') + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  if (biz.show_name !== false && biz.name) lines.push('{STORE_NAME}{CENTER}{BOLD}' + truncateShapedLine(String(biz.name), cols, arabicShaping) + '{/BOLD}{/CENTER}');
  lines.push(bar);
  lines.push(printLabel(lang, 'receipt.billNumber') + ': ' + (bill.bill_number || order.order_number));
  lines.push(printLabel(lang, 'receipt.date') + ': ' + date.toLocaleDateString(locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(locale + '-u-nu-latn', tzOptions));
  if (biz.show_table_number !== false && order.table?.name) lines.push(truncateShapedLine(formatTableLabel(order.table.name, lang), cols, arabicShaping));
  if (biz.show_customer_name !== false && biz.customer_name) lines.push(truncateShapedLine(printLabel(lang, 'pos.customer') + ': ' + biz.customer_name, cols, arabicShaping));
  if (biz.show_customer_phone !== false && biz.customer_phone) lines.push(printLabel(lang, 'print.numberShort') + ': ' + biz.customer_phone);
  lines.push(dash);
  lines.push(itemHeaderLegacy(lang, itemNameLen, amtLen));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      lines.push(...itemRows(item, itemNameLen, amtLen, cols, prefix, locale, trimDecimals));

      const addons = parseAddons(item.addons);
      for (const addon of addons) {
        lines.push(...addonRows({
          ...addon,
          price: (Number(addon?.price) || 0) * (Number(addon?.quantity) || 1) * (Number(item?.quantity) || 0),
        }, itemNameLen, amtLen, cols, prefix, locale, trimDecimals));
      }
      if (item.special_instructions) {
        lines.push('  ' + printLabel(lang, 'print.note') + ': ' + truncate(item.special_instructions, cols - 8));
      }
    }
  }

  lines.push(dash);
  lines.push(...financialRows(printLabel(lang, 'pos.subtotal'), formatCurrency(bill.subtotal, prefix, locale, trimDecimals), cols));
  if (bill.discount_amount > 0) {
    lines.push(...financialRows(printLabel(lang, 'pos.discount'), '-' + formatCurrency(bill.discount_amount, prefix, locale, trimDecimals), cols));
  }
  if (biz.show_tax_breakdown === true && taxComponents.length > 0) {
    for (const tax of taxComponents) {
      if (tax.amount === 0) continue;
      const rawLabel = tax.rate === null ? tax.title : `${tax.title} @${tax.rate}%`;
      const label = truncate(rawLabel, cols - 12);
      lines.push(...financialRows(label, formatCurrency(tax.amount, prefix, locale, trimDecimals), cols));
    }
  } else if (Number(bill.tax_amount) !== 0) {
    lines.push(...financialRows(printLabel(lang, 'pos.tax'), formatCurrency(bill.tax_amount, prefix, locale, trimDecimals), cols));
  }
  if ((Number(bill.service_charge) || 0) !== 0) {
    lines.push(...financialRows(printLabel(lang, 'receipt.serviceCharge'), formatCurrency(bill.service_charge, prefix, locale, trimDecimals), cols));
  }
  if (Number(bill.delivery_charge) !== 0) {
    lines.push(...financialRows(printLabel(lang, 'pos.delivery'), formatCurrency(bill.delivery_charge, prefix, locale, trimDecimals), cols));
  }
  if (Number(bill.packaging_charge) !== 0) {
    lines.push(...financialRows(printLabel(lang, 'pos.packaging'), formatCurrency(bill.packaging_charge, prefix, locale, trimDecimals), cols));
  }
  lines.push(...financialRows(printLabel(lang, 'print.grandTotal'), formatCurrency(bill.total, prefix, locale, trimDecimals), cols).map((line: string) => `{BOLD}${line}{/BOLD}`));

  if (bill.payment_details) {
    lines.push(dash);
    try {
      const payments = typeof bill.payment_details === 'string' ? JSON.parse(bill.payment_details) : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            const methodLabel = truncate(resolvePaymentMethodLabel(String(payment.method), lang), cols - 12);
            lines.push(...financialRows(methodLabel, formatCurrency(payment.amount, prefix, locale, trimDecimals), cols));
          }
        }
      }
    } catch (err: any) {
      console.warn('[Printer] Failed to parse payment details JSON:', err.message);
    }
  }

  lines.push(bar);
  if (biz.show_address !== false && biz.address) pushWrapped(lines, biz.address, cols);
  if (biz.show_phone !== false && biz.phone) pushWrapped(lines, printLabel(lang, 'receipt.phone') + ': ' + biz.phone, cols);
  if ((biz.show_tax_id === true || (biz.show_tax_id !== false && hasTax)) && biz.taxRegistrationNumber) pushWrapped(lines, taxIdLabel + ': ' + biz.taxRegistrationNumber, cols);
  if (biz.footer_note) pushCenteredWrapped(lines, biz.footer_note, cols);
  else lines.push('{CENTER}' + printLabel(lang, 'print.thankYouShort') + '{/CENTER}');
  appendPoweredByFooter(lines);
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode, { cutMode, arabicShaping, columns: cols }, warnings);
}

// ---------------------------------------------------------------------------
// KOT (verbatim pre-#443 body)
// ---------------------------------------------------------------------------

export function formatKOTLegacy(order: any, items: any[], stationName: string, cols: number = 48, useUnicode: boolean = false, cutMode: PrinterCutMode = 'full', locale: string = 'en-US', tzOptions?: any, warnings?: any[], arabicShaping: boolean = false, language?: string): Buffer {
  const lang = normalizePrintLanguage(language);
  const lines: string[] = [];
  const bar = '='.repeat(cols);

  lines.push('{INIT}');
  lines.push('{CENTER}{BOLD}' + printLabel(lang, 'print.kot.banner') + '{/BOLD}{/CENTER}');
  lines.push('');
  lines.push(truncateShapedLine(printLabel(lang, 'print.kot.station') + ': ' + stationName, cols, arabicShaping));
  // NOTE (#440/#441): keep this unaudited technical prefix verbatim; label
  // adoption remains outside this renderer change.
  lines.push(truncateShapedLine('Order: ' + order.order_number, cols, arabicShaping));
  if (order.table) {
    lines.push(truncateShapedLine(formatTableLabel(order.table.name, lang), cols, arabicShaping));
  }
  lines.push(printLabel(lang, 'print.time') + ': ' + parseDbTimestamp(order.created_at).toLocaleTimeString(locale + '-u-nu-latn', tzOptions));
  lines.push(bar);
  lines.push('');

  for (const item of items) {
    const itemPrefix = item.quantity + 'x  ';
    lines.push('{DOUBLE_HEIGHT}{BOLD}' + itemPrefix + truncateShapedLine(String(item.product_name), Math.max(1, cols - itemPrefix.length), arabicShaping) + '{/BOLD}{/DOUBLE_HEIGHT}');
    const addons = parseAddons(item.addons);
    for (const addon of addons) {
      if (addon?.name) {
        const quantity = typeof addon.quantity === 'number' && addon.quantity > 1 ? ` x${addon.quantity}` : '';
        lines.push('  + ' + truncate(String(addon.name) + quantity, cols - 4));
      }
    }
    if (item.special_instructions) {
      lines.push('  ** ' + truncateShapedLine(String(item.special_instructions), Math.max(1, cols - 8), arabicShaping) + ' **');
    }
  }

  lines.push('');
  lines.push(bar);
  lines.push('{CUT}');

  return buildEscPos(lines, useUnicode, { cutMode, arabicShaping, columns: cols }, warnings);
}
