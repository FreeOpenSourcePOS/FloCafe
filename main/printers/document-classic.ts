/**
 * PrintDocument v1 → classic thermal receipt renderer (#442, epic #438).
 *
 * This is the first document-driven consumer of the shared PrintDocument
 * model: it maps `shared/print` blocks onto the SAME ESC/POS token lines the
 * legacy classic layout (`formatClassicReceipt`) produces, so the preview
 * pipeline can switch to `data → document → lines → bytes` without changing
 * printed semantics.
 *
 * Layering: this module lives in `main/` (it touches transport token syntax
 * and the generated label catalog); all SEMANTICS come from the document —
 * no bill/order row is read here beyond the caller's normalization step
 * (`buildBillPrintData`). Since #443 the classic receipt surface (preview AND
 * actual printing) renders through this pipeline; `formatClassicReceipt`
 * delegates here.
 */

import { parseDbTimestamp } from '../db';
import { getCountryByCode } from '../countries';
import { resolveTaxComponents } from '../services/tax-components';
import {
  printLabel,
  isGeneratedPrintLanguage,
  type PrintConceptId,
} from '../print/print-labels.generated';
import type { PrinterCutMode } from './profiles';
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
  normalizePrintLanguage,
  pushCenteredWrapped,
  pushWrapped,
  resolveCurrencyPrefix,
  rightAlign,
  truncate,
  truncateShapedLine,
} from './thermal';
import {
  buildBillDocument,
  getBlock,
  containsRtlScript,
  type BusinessHeaderBlock,
  type CustomerBlock,
  type DirectionalText,
  type DocumentMetaBlock,
  type ItemTableBlock,
  type MessageBlock,
  type PaymentsBlock,
  type PrintContext,
  type PrintData,
  type PrintDocument,
  type SemanticLabel,
  type TaxBreakdownBlock,
  type TextDirection,
  type TotalsBlock,
} from '../../shared/print';

// ---------------------------------------------------------------------------
// Direction facts (registry-derived, no language unions)
// ---------------------------------------------------------------------------

/** Concepts whose generated strings are stable enough to reveal script. */
const DIRECTION_PROBE_CONCEPTS: readonly PrintConceptId[] = [
  'print.thankYouShort',
  'receipt.reprint',
  'pos.subtotal',
  'receipt.item',
  'print.grandTotal',
];

/**
 * Derive a language's base direction from its own generated label strings.
 * Registry-derived fact injection: the kernel never hardcodes language
 * unions, and this backend view reads only the generated print-label table.
 */
export function detectPrintLanguageDirection(lang: string): TextDirection {
  if (!isGeneratedPrintLanguage(lang)) return 'ltr';
  const sample = DIRECTION_PROBE_CONCEPTS.map((conceptId) => printLabel(lang, conceptId)).join(' ');
  return containsRtlScript(sample) ? 'rtl' : 'ltr';
}

// ---------------------------------------------------------------------------
// PrintData / PrintContext normalization (caller-side, main-process layer)
// ---------------------------------------------------------------------------

function parsePaymentDetails(raw: unknown): Array<{ method: string; amount: number }> {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      method: String(entry.method ?? ''),
      amount: Number(entry.amount) || 0,
    }));
}

/**
 * Normalize the raw bill/order/business rows into authoritative PrintData.
 * This is the ONLY step allowed to touch raw rows; it resolves display tax
 * components (persisted snapshots/breakdowns — no recomputation of totals)
 * and parses stored JSON so builders stay pure.
 */
export function buildBillPrintData(order: any, bill: any, business: any, isReprint: boolean): PrintData {
  const items = Array.isArray(order?.items) ? order.items : [];
  return {
    isReprint,
    order: {
      orderNumber: String(order?.order_number ?? ''),
      createdAt: String(order?.created_at ?? ''),
      tableName: String(order?.table?.name ?? ''),
      items: items.map((item: any) => ({
        productName: String(item?.product_name ?? ''),
        quantity: Number(item?.quantity) || 0,
        unitPrice: Number(item?.unit_price ?? item?.price ?? 0) || 0,
        total: Number(item?.total) || 0,
        addons: (Array.isArray(item?.addons) ? item.addons : []).map((addon: any) => ({
          name: String(addon?.name ?? ''),
          price: Number(addon?.price) || 0,
        })),
        specialInstructions: String(item?.special_instructions ?? ''),
      })),
    },
    bill: {
      billNumber: String(bill?.bill_number ?? ''),
      subtotal: Number(bill?.subtotal) || 0,
      discountAmount: Number(bill?.discount_amount) || 0,
      taxAmount: Number(bill?.tax_amount) || 0,
      total: Number(bill?.total) || 0,
      taxComponents: resolveTaxComponents({ ...bill, items }),
      payments: parsePaymentDetails(bill?.payment_details),
      pointsEarned: Number(business?.points_earned) || 0,
      pointsRedeemed: Number(business?.points_redeemed) || 0,
      pointsBalance: business?.points_balance === null || business?.points_balance === undefined
        ? null
        : Number(business.points_balance) || 0,
    },
    business: {
      name: String(business?.name ?? ''),
      address: String(business?.address ?? ''),
      phone: String(business?.phone ?? ''),
      taxRegistrationNumber: String(business?.taxRegistrationNumber ?? ''),
      taxIdLabel: getCountryByCode(String(business?.country ?? ''))?.taxIdLabel || '',
      instagramHandle: String(business?.instagram_handle ?? ''),
      footerNote: String(business?.footer_note ?? ''),
      customerName: String(business?.customer_name ?? ''),
      customerPhone: String(business?.customer_phone ?? ''),
      showName: business?.show_name !== false,
      showAddress: business?.show_address !== false,
      showPhone: business?.show_phone !== false,
      showTaxId: business?.show_tax_id === true ? 'force' : business?.show_tax_id === false ? 'never' : 'auto',
      showTaxBreakdown: business?.show_tax_breakdown === true,
      showTableNumber: business?.show_table_number !== false,
      showCustomerName: business?.show_customer_name !== false,
      showCustomerPhone: business?.show_customer_phone !== false,
    },
  };
}

/**
 * Build the PrintContext for a classic receipt: paper columns, resolved
 * languages, registry-derived direction, and locale-formatting prefs from
 * the existing regionalization helpers.
 */
export function buildBillPrintContext(opts: {
  columns: number;
  /** Receipt language (already resolved from settings/policy by the caller). */
  language: string;
  /** Optional second receipt language from the resolved policy (max 2, v1). */
  additionalLanguage?: string;
  business: any;
}): PrintContext {
  const lang = normalizePrintLanguage(opts.language);
  const languages: PrintContext['languages'] = opts.additionalLanguage !== undefined
    && opts.additionalLanguage !== lang
    ? [lang, normalizePrintLanguage(opts.additionalLanguage)]
    : [lang];
  return {
    columns: opts.columns,
    languages,
    baseDirection: detectPrintLanguageDirection(lang),
    locale: getCountryByCode(String(opts.business?.country ?? ''))?.locale ?? 'en-US',
    currencySymbol: String(opts.business?.currency_symbol || '₹'),
    trimDecimals: opts.business?.trim_decimals === true,
    ...(opts.business?.timezone ? { timezone: String(opts.business.timezone) } : {}),
    resolveLabel: (conceptId, language) => printLabel(language, conceptId as PrintConceptId),
  };
}

// ---------------------------------------------------------------------------
// Document → classic ESC/POS token lines
// ---------------------------------------------------------------------------

/** Renderer options: physical/locale presentation only, no business data. */
export interface ClassicDocumentRenderOptions {
  readonly columns: number;
  /** Primary receipt language for labels (resolved by the caller). */
  readonly language: string;
  readonly locale: string;
  readonly timezone?: string;
  /** Currency prefix preference (symbol + unicode mode). */
  readonly currencySymbol: string;
  readonly trimDecimals: boolean;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly cutMode: PrinterCutMode;
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
function classicItemHeader(block: ItemTableBlock, nameLen: number, amtLen: number): string {
  const qtyW = 4;
  const item = labelOf(block.header.item).slice(0, nameLen).padEnd(nameLen);
  const qty = labelOf(block.header.quantity).slice(0, qtyW).padEnd(qtyW);
  const amount = labelOf(block.header.amount).slice(0, Math.max(1, amtLen - 1));
  return item + qty + ' '.repeat(amtLen - amount.length) + amount;
}

/**
 * Map a PrintDocument onto the legacy classic token-line layout. Pure with
 * respect to business data: everything rendered comes from the document.
 */
export function renderBillDocumentToClassicLines(
  document: PrintDocument,
  options: ClassicDocumentRenderOptions,
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

  const prefix = resolveCurrencyPrefix(options.currencySymbol ?? '₹', options.useUnicode);
  const trimDecimals = options.trimDecimals === true;
  const tzOptions = options.timezone ? { timeZone: options.timezone } : undefined;
  const dash = '-'.repeat(cols);

  lines.push('{INIT}');

  // Reprint banner (MessageBlock).
  if (messages?.reprintBanner) {
    lines.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + labelOf(messages.reprintBanner) + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  }

  // Business header + customer lines.
  if (header?.name) lines.push('{STORE_NAME}{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}' + truncateShapedLine(header.name.text, Math.floor(cols / 2), options.arabicShaping) + '{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
  if (customer?.name) lines.push('{CENTER}{FONT_B}' + truncateShapedLine(customer.name.text, cols, options.arabicShaping) + '{/FONT_B}{/CENTER}');
  if (customer?.phone) lines.push('{CENTER}' + customer.phone.text + '{/CENTER}');

  // Document meta.
  lines.push(dash);
  if (meta) {
    lines.push('{CENTER}' + labelOf(meta.invoiceNumberLabel) + ' ' + meta.invoiceNumber.text + '{/CENTER}');
    const date = parseDbTimestamp(meta.timestamp.text);
    lines.push('{CENTER}' + date.toLocaleDateString(options.locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(options.locale + '-u-nu-latn', tzOptions) + '{/CENTER}');
    if (meta.table) {
      lines.push('{CENTER}' + truncateShapedLine(meta.table.label.primary.replace('{name}', meta.table.name.text), cols, options.arabicShaping) + '{/CENTER}');
    }
  }
  lines.push(dash);

  // Item table.
  if (items) {
    const amtLen = itemAmountWidth(
      { items: items.rows.map((row) => ({ total: row.amount, addons: row.addons.map((addon) => ({ price: addon.price })) })) },
      prefix,
      options.locale,
      trimDecimals,
      cols,
    );
    const nameLen = itemNameWidth(cols, amtLen);
    lines.push(classicItemHeader(items, nameLen, amtLen));
    lines.push(dash);

    for (const row of items.rows) {
      lines.push(...itemRows(
        { product_name: row.name.text, quantity: row.quantity, total: row.amount },
        nameLen,
        amtLen,
        cols,
        prefix,
        options.locale,
        trimDecimals,
      ));
      for (const addon of row.addons) {
        lines.push(...addonRows({ name: addon.name.text, price: addon.price }, nameLen, amtLen, cols, prefix, options.locale, trimDecimals));
      }
      if (row.specialInstructions) {
        lines.push('  ' + labelOf(items.noteLabel) + ': ' + truncate(row.specialInstructions.text, cols - 8));
      }
    }
    lines.push(dash);
  }

  // Totals.
  if (totals) {
    if (totals.pointsRedeemed) {
      const label = labelOf(totals.pointsRedeemed.label);
      lines.push(label + rightAlign('-' + totals.pointsRedeemed.points + ' pts', cols - label.length));
    }
    lines.push(...financialRows(labelOf(totals.subtotal.label), formatCurrency(totals.subtotal.amount, prefix, options.locale, trimDecimals), cols));
    if (totals.discount) {
      lines.push(...financialRows(labelOf(totals.discount.label), '-' + formatCurrency(totals.discount.amount, prefix, options.locale, trimDecimals), cols));
    }
    if (breakdown && breakdown.lines.length > 0) {
      for (const line of breakdown.lines) {
        const rateSuffix = line.rate === null ? '' : ` @${line.rate}%`;
        const label = truncate(labelOf(line.label) + rateSuffix, cols - 12);
        lines.push(...financialRows(label, formatCurrency(line.amount, prefix, options.locale, trimDecimals), cols));
      }
    } else if (totals.tax) {
      lines.push(...financialRows(labelOf(totals.tax.label), formatCurrency(totals.tax.amount, prefix, options.locale, trimDecimals), cols));
    }
    lines.push(...financialRows(labelOf(totals.grandTotal.label), formatCurrency(totals.grandTotal.amount, prefix, options.locale, trimDecimals), cols).map((line) => `{BOLD}${line}{/BOLD}`));
  }

  // Payments.
  if (payments && payments.lines.length > 0) {
    for (const line of payments.lines) {
      const methodLabel = truncate(paymentLabel(line.label), cols - 12);
      lines.push(...financialRows(methodLabel, formatCurrency(line.amount, prefix, options.locale, trimDecimals), cols));
    }
  }

  // Loyalty points earned / running balance.
  if (totals && (totals.pointsEarned || totals.pointsBalance)) {
    lines.push(dash);
    if (totals.pointsEarned) {
      const label = labelOf(totals.pointsEarned.label);
      lines.push(label + rightAlign(String(totals.pointsEarned.points), cols - label.length));
    }
    if (totals.pointsBalance) {
      const label = labelOf(totals.pointsBalance.label);
      lines.push(label + rightAlign(String(totals.pointsBalance.points), cols - label.length));
    }
  }

  // Footer contact lines (business header facts, legacy placement).
  const footerLines: string[] = [];
  if (header?.address) footerLines.push(header.address.text);
  if (header?.phone && header.phoneLabel) footerLines.push(labelOf(header.phoneLabel) + ': ' + header.phone.text);
  if (header?.taxId) footerLines.push(labelOf(header.taxId.label) + ': ' + header.taxId.value.text);
  if (header?.instagramHandle) footerLines.push(header.instagramHandle.text);
  if (footerLines.length > 0) {
    lines.push(dash);
    for (const footerLine of footerLines) pushCenteredWrapped(lines, footerLine, cols);
  }

  if (messages?.footerNote) pushCenteredWrapped(lines, messages.footerNote.text, cols);

  appendPoweredByFooter(lines);
  lines.push('{CUT}');

  return lines;
}

// ---------------------------------------------------------------------------
// Preview entry: data → document → lines → bytes
// ---------------------------------------------------------------------------

export interface ClassicDocumentPreviewResult {
  readonly document: PrintDocument;
  readonly lines: string[];
  readonly data: Buffer;
  readonly warnings: PrintWarning[];
}

/**
 * Full document-driven classic preview pipeline:
 * authoritative rows → PrintData/PrintContext → buildBillDocument →
 * classic token lines → buildEscPos. Used by the print-bill preview branch;
 * actual printing keeps the legacy path this issue.
 */
export function renderClassicReceiptViaDocument(
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
  },
): ClassicDocumentPreviewResult {
  const printData = buildBillPrintData(order, bill, business, opts.isReprint);
  const printContext = buildBillPrintContext({
    columns: opts.columns,
    language: opts.language,
    ...(opts.additionalLanguage !== undefined ? { additionalLanguage: opts.additionalLanguage } : {}),
    business,
  });
  const document = buildBillDocument(printData, printContext);
  const warnings: PrintWarning[] = [];
  const lines = renderBillDocumentToClassicLines(document, {
    columns: opts.columns,
    language: printContext.languages[0],
    locale: printContext.locale,
    ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
    currencySymbol: printContext.currencySymbol,
    trimDecimals: printContext.trimDecimals,
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
  });
  const data = buildEscPos(lines, opts.useUnicode, { cutMode: opts.cutMode, arabicShaping: opts.arabicShaping, columns: opts.columns }, warnings);
  return { document, lines, data, warnings };
}
