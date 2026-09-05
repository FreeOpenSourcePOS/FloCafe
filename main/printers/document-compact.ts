/**
 * PrintDocument v1 → compact thermal receipt renderer (#443, epic #438).
 *
 * Maps `shared/print` blocks onto the SAME ESC/POS token lines the legacy
 * compact layout (`formatCompactReceipt`) produces, byte for byte, so the
 * compact surface renders through `data → document → lines → bytes` without
 * changing printed semantics.
 *
 * Layering: this module lives in `main/` (transport token syntax + generated
 * label catalog); all SEMANTICS come from the document — no bill/order row
 * is read here beyond the caller's normalization step (`buildBillPrintData`,
 * reused from the classic pipeline).
 */

import { parseDbTimestamp } from '../db';
import { getCurrencyFractionDigits } from '../countries';
import type { PrinterCutMode } from './profiles';
import { isThermalTextRepresentable, type ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { RasterSemanticLineGroup, RasterTextLayout } from '../../shared/print/raster';
import type { PrintWarning } from './thermal';
import {
  addonRows,
  appendPoweredByFooter,
  buildEscPos,
  financialRows,
  formatCurrency,
  itemAmountWidth,
  itemRows,
  itemNameWidth,
  normalizeThermalText,
  maskPhoneOnReceipt,
  pushCenteredWrapped,
  pushWrapped,
  resolveCurrencyPrefix,
  truncate,
  truncateShapedLine,
} from './thermal';
import { buildBillPrintContext, buildBillPrintData } from './document-classic';
import {
  buildBillDocument,
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
} from '../../shared/print';

// ---------------------------------------------------------------------------
// Document → compact ESC/POS token lines
// ---------------------------------------------------------------------------

/** Renderer options: physical/locale presentation only, no business data. */
export interface CompactDocumentRenderOptions {
  readonly columns: number;
  readonly language: string;
  readonly locale: string;
  readonly timezone?: string;
  /** Currency prefix preference (symbol + unicode mode). */
  readonly currency: string;
  readonly currencySymbol: string;
  readonly trimDecimals: boolean;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly preserveCurrencySymbol?: boolean;
  readonly cutMode: PrinterCutMode;
  readonly capabilities?: ThermalPrinterCapabilities;
  readonly maskCustomerPhone?: boolean;
  readonly rasterGroups?: RasterSemanticLineGroup[];
  readonly financialLineRanges?: Array<{ lineIndex: number; lineCount: number }>;
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

/** Column header row, composed from the document's own header labels. */
function compactItemHeader(block: ItemTableBlock, nameLen: number, amtLen: number, language: string, capabilities?: ThermalPrinterCapabilities): string {
  const qtyW = 4;
  const itemLabel = normalizeThermalText(labelOf(block.header.item), capabilities);
  const qtyLabel = normalizeThermalText(labelOf(block.header.quantity), capabilities);
  const amountLabel = normalizeThermalText(labelOf(block.header.amount), capabilities);
  const fit = (value: string, length: number): string => capabilities?.raster.enabled === true && !isThermalTextRepresentable(value, capabilities)
    ? value
    : value.slice(0, length);
  const item = fit(itemLabel, nameLen).padEnd(nameLen);
  const qty = fit(qtyLabel, qtyW).padEnd(qtyW);
  const amount = fit(amountLabel, Math.max(1, amtLen - 1));
  return item + qty + ' '.repeat(Math.max(0, amtLen - amount.length)) + amount;
}

/**
 * Map a PrintDocument onto the legacy compact token-line layout. Pure with
 * respect to business data: everything rendered comes from the document.
 */
export function renderBillDocumentToCompactLines(
  document: PrintDocument,
  options: CompactDocumentRenderOptions,
): string[] {
  const cols = options.columns;
  const lines: string[] = [];

  const header = getBlock(document, 'business-header') as BusinessHeaderBlock | undefined;
  const meta = getBlock(document, 'document-meta') as DocumentMetaBlock | undefined;
  const customer = getBlock(document, 'customer') as CustomerBlock | undefined;
  const items = getBlock(document, 'item-table') as ItemTableBlock | undefined;
  const breakdown = getBlock(document, 'tax-breakdown') as TaxBreakdownBlock | undefined;
  const totals = getBlock(document, 'totals') as TotalsBlock | undefined;
  const payments = getBlock(document, 'payments') as PaymentsBlock | undefined;
  const messages = getBlock(document, 'message') as MessageBlock | undefined;

  const prefix = resolveCurrencyPrefix(options.currencySymbol ?? '₹', options.useUnicode, options.capabilities, options.preserveCurrencySymbol === true, options.currency);
  const fractionDigits = getCurrencyFractionDigits(options.currency || 'INR');
  const trimDecimals = options.trimDecimals === true;
  const tzOptions = options.timezone ? { timeZone: options.timezone } : undefined;
  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);
  const normalize = (text: string): string => normalizeThermalText(text, options.capabilities);
  const markGroup = (groupId: string, start: number, sourceLines?: readonly string[], sourceControlLines?: readonly string[], financial = false, sourceLayouts?: readonly (RasterTextLayout | undefined)[]): void => {
    if (options.rasterGroups && lines.length > start) options.rasterGroups.push({ groupId, lineIndex: start, lineCount: lines.length - start, ...(sourceLines ? { sourceLines } : {}), ...(sourceControlLines ? { sourceControlLines } : {}), ...(sourceLayouts ? { sourceLayouts } : {}), ...(financial ? { financial: true } : {}) });
  };
  const recordFinancialLines = (start: number, rendered: readonly string[], financial = true): void => {
    if (!financial) return;
    if (!options.financialLineRanges) return;
    rendered.forEach((line, offset) => {
      options.financialLineRanges!.push({ lineIndex: start + offset, lineCount: 1 });
    });
  };

  lines.push('{INIT}');

  // Reprint banner (MessageBlock).
  const messageStart = lines.length;
  const messageSourceLines: string[] = [];
  const messageSourceControlLines: string[] = [];
  if (messages?.reprintBanner) {
    lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + normalize(labelOf(messages.reprintBanner)) + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
    messageSourceLines.push(`** ${labelOf(messages.reprintBanner)} **`);
    messageSourceControlLines.push(lines.at(-1) ?? '');
  }

  // Online-order banner (#284, MessageBlock).
  if (messages?.onlineOrderBanner) {
    const banner = messages.onlineOrderBanner;
    lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + normalize(labelOf(banner.label)) + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
    messageSourceLines.push(`** ${labelOf(banner.label)} **`);
    messageSourceControlLines.push(lines.at(-1) ?? '');
    if (banner.platform.text) {
      lines.push('{CENTER}' + normalize(banner.platform.text) + '{/CENTER}');
      messageSourceLines.push(banner.platform.text);
      messageSourceControlLines.push(lines.at(-1) ?? '');
    }
    if (banner.externalOrderId.text) {
      lines.push('{CENTER}#' + normalize(banner.externalOrderId.text) + '{/CENTER}');
      messageSourceLines.push('#' + banner.externalOrderId.text);
      messageSourceControlLines.push(lines.at(-1) ?? '');
    }
  }
  markGroup('message', messageStart, messageSourceLines, messageSourceControlLines);

  // Business header (store name only — compact keeps contact facts in the footer).
  const headerStart = lines.length;
  if (header?.name) lines.push('{STORE_NAME}{CENTER}{BOLD}' + truncateShapedLine(header.name.text, cols, options.arabicShaping, options.language, options.capabilities) + '{/BOLD}{/CENTER}');
  markGroup('business-header', headerStart, header?.name ? [header.name.text] : [], header?.name ? [lines[headerStart] ?? ''] : []);
  lines.push(bar);

  // Document meta.
  const metaStart = lines.length;
  const metaSourceLines: string[] = [];
  if (meta) {
    lines.push(normalize(labelOf(meta.billNumberLabel) + ': ' + meta.invoiceNumber.text));
    metaSourceLines.push(labelOf(meta.billNumberLabel) + ': ' + meta.invoiceNumber.text);
    const date = parseDbTimestamp(meta.timestamp.text);
    const dateText = date.toLocaleDateString(options.locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(options.locale + '-u-nu-latn', tzOptions);
    lines.push(normalize(labelOf(meta.dateLabel) + ': ' + dateText));
    metaSourceLines.push(labelOf(meta.dateLabel) + ': ' + dateText);
    if (meta.table) {
      lines.push(truncateShapedLine(meta.table.label.primary.replace('{name}', meta.table.name.text), cols, options.arabicShaping, options.language, options.capabilities));
      metaSourceLines.push(meta.table.label.primary.replace('{name}', meta.table.name.text));
    }
  }
  markGroup('document-meta', metaStart, metaSourceLines);
  const customerStart = lines.length;
  const customerSourceLines: string[] = [];
  const customerSourceControlLines: string[] = [];
  if (customer?.name) {
    lines.push(truncateShapedLine(labelOf(customer.nameLabel) + ': ' + customer.name.text, cols, options.arabicShaping, options.language, options.capabilities));
    customerSourceLines.push(labelOf(customer.nameLabel) + ': ' + customer.name.text);
    customerSourceControlLines.push(lines.at(-1) ?? '');
  }
  if (customer?.phone) {
    const phone = options.maskCustomerPhone ? maskPhoneOnReceipt(customer.phone.text) : customer.phone.text;
    lines.push(normalize(labelOf(customer.phoneLabel) + ': ' + phone));
    customerSourceLines.push(labelOf(customer.phoneLabel) + ': ' + phone);
    customerSourceControlLines.push(lines.at(-1) ?? '');
  }
  if (options.rasterGroups && lines.length > customerStart) options.rasterGroups.push({ groupId: 'customer', lineIndex: customerStart, lineCount: lines.length - customerStart, sourceLines: customerSourceLines, sourceControlLines: customerSourceControlLines });
  lines.push(dash);

  // Item table.
  if (items) {
    const amtLen = itemAmountWidth(
      { items: items.rows.map((row) => ({ total: row.amount, addons: row.addons.map((addon) => ({ price: addon.price })) })) },
      prefix,
      options.locale,
      trimDecimals,
      cols,
      fractionDigits,
    );
    const nameLen = itemNameWidth(cols, amtLen);
    lines.push(compactItemHeader(items, nameLen, amtLen, options.language, options.capabilities));
    lines.push(dash);

    for (const [rowIndex, row] of items.rows.entries()) {
      const rowStart = lines.length;
      const rowLines = itemRows(
        { product_name: row.name.text, quantity: row.quantity, total: row.amount },
        nameLen,
        amtLen,
        cols,
        prefix,
        options.locale,
        trimDecimals,
        options.language,
        fractionDigits,
        options.capabilities,
      );
      lines.push(...rowLines);
      recordFinancialLines(rowStart, rowLines);
      const amount = formatCurrency(row.amount, prefix, options.locale, trimDecimals, fractionDigits);
      const sourceLines = [`${row.name.text} ${row.quantity} ${amount}`];
      const sourceControlLines = [rowLines[0] ?? ''];
      const sourceLayouts: Array<RasterTextLayout | undefined> = [{
        kind: 'financial-item',
        columns: [
          { text: row.name.text, align: 'left' },
          { text: String(row.quantity), align: 'left' },
          { text: amount.trimStart(), align: 'right' },
        ],
      }];
      const financialSourceLines = [true];
      for (const addon of row.addons) {
        const addonLines = addonRows({ name: addon.name.text, price: addon.price, quantity: addon.quantity }, nameLen, amtLen, cols, prefix, options.locale, trimDecimals, options.language, fractionDigits, options.capabilities);
        const addonStart = lines.length;
        lines.push(...addonLines);
        if (addon.price) recordFinancialLines(addonStart, addonLines);
        const quantitySuffix = (addon.quantity ?? 1) > 1 ? ` x${addon.quantity}` : '';
        const addonLabel = `  + ${addon.name.text}${quantitySuffix}`;
        const addonAmount = addon.price ? formatCurrency(addon.price, prefix, options.locale, trimDecimals, fractionDigits) : '';
        sourceLines.push(`${addonLabel}${addon.price ? ` ${addonAmount}` : ''}`);
        sourceControlLines.push(addonLines[0] ?? '');
        sourceLayouts.push(addon.price ? {
          kind: 'financial-summary',
          columns: [
            { text: addonLabel, align: 'left' },
            { text: addonAmount.trimStart(), align: 'right' },
          ],
        } : undefined);
        financialSourceLines.push(Boolean(addon.price));
      }
      if (row.specialInstructions) {
        const instructionLine = normalize('  ' + labelOf(items.noteLabel) + ': ' + truncate(row.specialInstructions.text, cols - 8, options.language, options.capabilities));
        lines.push(instructionLine);
        sourceLines.push('  ' + labelOf(items.noteLabel) + ': ' + row.specialInstructions.text);
        sourceControlLines.push(instructionLine);
        sourceLayouts.push(undefined);
        financialSourceLines.push(false);
      }
      if (options.rasterGroups && lines.length > rowStart) {
        const group = { groupId: `item-table-row-${rowIndex}`, lineIndex: rowStart, lineCount: lines.length - rowStart };
        options.rasterGroups.push({ ...group, sourceLines, sourceControlLines, sourceLayouts, financialSourceLines, financial: true });
      }
    }
  }

  lines.push(dash);

  // Totals (compact has no loyalty points section).
  const totalsStart = lines.length;
  const totalsSourceLines: string[] = [];
  const totalsSourceControlLines: string[] = [];
  const totalsSourceLayouts: Array<RasterTextLayout | undefined> = [];
  const pushTotalRow = (rendered: string[], bold = false, sourceLabel?: string, sourceValue?: string): void => {
    const start = lines.length;
    const tokenLines = bold ? rendered.map((line) => `{BOLD}${line}{/BOLD}`) : rendered;
    lines.push(...tokenLines);
    recordFinancialLines(start, tokenLines);
    totalsSourceLines.push(sourceLabel !== undefined && sourceValue !== undefined ? `${sourceLabel} ${sourceValue.trimStart()}` : rendered.join(' '));
    totalsSourceControlLines.push(tokenLines[0] ?? '');
    totalsSourceLayouts.push(sourceLabel !== undefined && sourceValue !== undefined ? {
      kind: 'financial-summary',
      columns: [
        { text: sourceLabel, align: 'left' },
        { text: sourceValue.trimStart(), align: 'right' },
      ],
    } : undefined);
  };
  if (totals) {
    const subtotalValue = formatCurrency(totals.subtotal.amount, prefix, options.locale, trimDecimals, fractionDigits);
    pushTotalRow(financialRows(labelOf(totals.subtotal.label), subtotalValue, cols, options.language, options.capabilities), false, labelOf(totals.subtotal.label), subtotalValue);
    if (totals.discount) {
      const discountValue = '-' + formatCurrency(totals.discount.amount, prefix, options.locale, trimDecimals, fractionDigits);
      pushTotalRow(financialRows(labelOf(totals.discount.label), discountValue, cols, options.language, options.capabilities), false, labelOf(totals.discount.label), discountValue);
    }
    if (breakdown && breakdown.lines.length > 0) {
      for (const line of breakdown.lines) {
        const rateSuffix = line.rate === null ? '' : ` @${line.rate}%`;
        const rawLabel = labelOf(line.label) + rateSuffix;
        const label = truncate(rawLabel, cols - 12, options.language, options.capabilities);
        const value = formatCurrency(line.amount, prefix, options.locale, trimDecimals, fractionDigits);
        pushTotalRow(financialRows(label, value, cols, options.language, options.capabilities), false, rawLabel, value);
      }
    } else if (totals.tax) {
      const value = formatCurrency(totals.tax.amount, prefix, options.locale, trimDecimals, fractionDigits);
      pushTotalRow(financialRows(labelOf(totals.tax.label), value, cols, options.language, options.capabilities), false, labelOf(totals.tax.label), value);
    }
    if (totals.serviceCharge) {
      const value = formatCurrency(totals.serviceCharge.amount, prefix, options.locale, trimDecimals, fractionDigits);
      pushTotalRow(financialRows(labelOf(totals.serviceCharge.label), value, cols, options.language, options.capabilities), false, labelOf(totals.serviceCharge.label), value);
    }
    if (totals.deliveryCharge) {
      const value = formatCurrency(totals.deliveryCharge.amount, prefix, options.locale, trimDecimals, fractionDigits);
      pushTotalRow(financialRows(labelOf(totals.deliveryCharge.label), value, cols, options.language, options.capabilities), false, labelOf(totals.deliveryCharge.label), value);
    }
    if (totals.packagingCharge) {
      const value = formatCurrency(totals.packagingCharge.amount, prefix, options.locale, trimDecimals, fractionDigits);
      pushTotalRow(financialRows(labelOf(totals.packagingCharge.label), value, cols, options.language, options.capabilities), false, labelOf(totals.packagingCharge.label), value);
    }
    const grandTotalValue = formatCurrency(totals.grandTotal.amount, prefix, options.locale, trimDecimals, fractionDigits);
    pushTotalRow(financialRows(labelOf(totals.grandTotal.label), grandTotalValue, cols, options.language, options.capabilities), true, labelOf(totals.grandTotal.label), grandTotalValue);
  }
  markGroup('totals', totalsStart, totalsSourceLines, totalsSourceControlLines, true, totalsSourceLayouts);

  // Payments.
  const paymentsStart = lines.length;
  const paymentSourceLines: string[] = [];
  const paymentSourceControlLines: string[] = [];
  const paymentSourceLayouts: Array<RasterTextLayout | undefined> = [];
  if (payments && payments.lines.length > 0) {
    lines.push(dash);
    paymentSourceLines.push(dash);
    paymentSourceControlLines.push(dash);
    paymentSourceLayouts.push(undefined);
    for (const line of payments.lines) {
      const rawMethodLabel = paymentLabel(line.label);
      const methodLabel = truncate(rawMethodLabel, cols - 12, options.language, options.capabilities);
      const value = formatCurrency(line.amount, prefix, options.locale, trimDecimals, fractionDigits);
      const rendered = financialRows(methodLabel, value, cols, options.language, options.capabilities);
      recordFinancialLines(lines.length, rendered);
      lines.push(...rendered);
      paymentSourceLines.push(`${rawMethodLabel} ${value.trimStart()}`);
      paymentSourceControlLines.push(rendered[0] ?? '');
      paymentSourceLayouts.push({
        kind: 'financial-summary',
        columns: [
          { text: rawMethodLabel, align: 'left' },
          { text: value.trimStart(), align: 'right' },
        ],
      });
    }
  }
  markGroup('payments', paymentsStart, paymentSourceLines, paymentSourceControlLines, true, paymentSourceLayouts);

  // Footer contact details.
  lines.push(bar);
  const businessFooterStart = lines.length;
  const businessFooterSourceLines: string[] = [];
  const businessFooterSourceControlLines: string[] = [];
  if (header?.address) {
    const start = lines.length;
    pushWrapped(lines, header.address.text, cols, options.language, options.capabilities);
    businessFooterSourceLines.push(header.address.text);
    businessFooterSourceControlLines.push(lines[start] ?? '');
  }
  if (header?.phone && header.phoneLabel) {
    const start = lines.length;
    pushWrapped(lines, labelOf(header.phoneLabel) + ': ' + header.phone.text, cols, options.language, options.capabilities);
    businessFooterSourceLines.push(labelOf(header.phoneLabel) + ': ' + header.phone.text);
    businessFooterSourceControlLines.push(lines[start] ?? '');
  }
  if (header?.taxId) {
    const start = lines.length;
    pushWrapped(lines, labelOf(header.taxId.label) + ': ' + header.taxId.value.text, cols, options.language, options.capabilities);
    businessFooterSourceLines.push(labelOf(header.taxId.label) + ': ' + header.taxId.value.text);
    businessFooterSourceControlLines.push(lines[start] ?? '');
  }
  markGroup('business-header', businessFooterStart, businessFooterSourceLines, businessFooterSourceControlLines);

  const messageFooterStart = lines.length;
  const messageFooterSourceLines: string[] = [];
  const messageFooterSourceControlLines: string[] = [];
  if (messages?.footerNote) {
    const start = lines.length;
    pushCenteredWrapped(lines, messages.footerNote.text, cols, options.language, options.capabilities);
    messageFooterSourceLines.push(messages.footerNote.text);
    messageFooterSourceControlLines.push(lines[start] ?? '');
  } else if (messages?.thankYou) {
    lines.push('{CENTER}' + normalize(labelOf(messages.thankYou)) + '{/CENTER}');
    messageFooterSourceLines.push(labelOf(messages.thankYou));
    messageFooterSourceControlLines.push(lines.at(-1) ?? '');
  }
  markGroup('message', messageFooterStart, messageFooterSourceLines, messageFooterSourceControlLines);
  appendPoweredByFooter(lines);
  lines.push('{CUT}');

  return lines;
}

// ---------------------------------------------------------------------------
// Entry: data → document → lines → bytes
// ---------------------------------------------------------------------------

export interface CompactDocumentRenderResult {
  readonly document: PrintDocument;
  readonly lines: string[];
  readonly data: Buffer;
  readonly warnings: PrintWarning[];
  readonly rasterGroups: readonly RasterSemanticLineGroup[];
}

/**
 * Full document-driven compact pipeline: authoritative rows → PrintData /
 * PrintContext → buildBillDocument → compact token lines → buildEscPos.
 */
export function renderCompactReceiptViaDocument(
  order: any,
  bill: any,
  business: any,
  opts: {
    columns: number;
    language: string;
    additionalLanguage?: string;
    isReprint: boolean;
    useUnicode: boolean;
    arabicShaping: boolean;
    cutMode: PrinterCutMode;
    capabilities?: import('../../shared/print/thermal-capabilities').ThermalPrinterCapabilities;
    maskCustomerPhone?: boolean;
    preserveCurrencySymbol?: boolean;
  },
): CompactDocumentRenderResult {
  const semanticBusiness = opts.maskCustomerPhone
    ? { ...(business || {}), customer_phone: maskPhoneOnReceipt(String(business?.customer_phone ?? '')) }
    : business;
  const printData = buildBillPrintData(order, bill, semanticBusiness, opts.isReprint);
  const printContext = buildBillPrintContext({
    columns: opts.columns,
    language: opts.language,
    ...(opts.additionalLanguage !== undefined ? { additionalLanguage: opts.additionalLanguage } : {}),
    business: semanticBusiness,
  });
  const document = buildBillDocument(printData, printContext);
  const warnings: PrintWarning[] = [];
  const rasterGroups: RasterSemanticLineGroup[] = [];
  const financialLineRanges: Array<{ lineIndex: number; lineCount: number }> = [];
  const lines = renderBillDocumentToCompactLines(document, {
    columns: opts.columns,
    language: printContext.languages[0],
    locale: printContext.locale,
    ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
    currency: printContext.currency,
    currencySymbol: printContext.currencySymbol,
    trimDecimals: printContext.trimDecimals,
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
    capabilities: opts.capabilities,
    maskCustomerPhone: false,
    preserveCurrencySymbol: opts.preserveCurrencySymbol,
    rasterGroups,
    financialLineRanges,
  });
  const data = buildEscPos(lines, opts.useUnicode, { cutMode: opts.cutMode, arabicShaping: opts.arabicShaping, columns: opts.columns, language: opts.language, capabilities: opts.capabilities, financialLineRanges }, warnings);
  return { document, lines, data, warnings, rasterGroups };
}
