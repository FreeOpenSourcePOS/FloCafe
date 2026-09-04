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
import { getCountryByCode, getCurrencyFractionDigits } from '../countries';
import { resolveTaxComponents } from '../services/tax-components';
import {
  printLabel,
  isGeneratedPrintLanguage,
  type PrintConceptId,
} from '../print/print-labels.generated';
import type { PrinterCutMode } from './profiles';
import { isThermalTextRepresentable, type ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { RasterSemanticLineGroup } from '../../shared/print/raster';
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
  normalizePrintLanguage,
  maskPhoneOnReceipt,
  pushCenteredWrapped,
  resolveCurrencyPrefix,
  truncate,
  truncateShapedLine,
} from './thermal';
import {
  buildBillDocument,
  containsRtlScript,
  type ItemTableBlock,
  type PrintContext,
  type PrintData,
  type PrintDocument,
  type PrintDocumentBlock,
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
      onlinePlatform: String(order?.online_platform ?? ''),
      externalOrderId: String(order?.external_order_id ?? ''),
      items: items.map((item: any) => ({
        productName: String(item?.product_name ?? ''),
        quantity: Number(item?.quantity) || 0,
        unitPrice: Number(item?.unit_price ?? item?.price ?? 0) || 0,
        total: Number(item?.total) || 0,
        addons: (Array.isArray(item?.addons) ? item.addons : []).map((addon: any) => {
          const addonQuantity = (addon !== null && typeof addon === 'object' && 'quantity' in addon
            && typeof addon.quantity === 'number' && addon.quantity) || 1;
          return {
            name: String(addon?.name ?? ''),
            price: (Number(addon?.price) || 0) * addonQuantity * (Number(item?.quantity) || 0),
            quantity: addonQuantity,
          };
        }),
        specialInstructions: String(item?.special_instructions ?? ''),
      })),
    },
    bill: {
      billNumber: String(bill?.bill_number ?? ''),
      subtotal: Number(bill?.subtotal) || 0,
      discountAmount: Number(bill?.discount_amount) || 0,
      taxAmount: Number(bill?.tax_amount) || 0,
      total: Number(bill?.total) || 0,
      ...(Object.prototype.hasOwnProperty.call(bill || {}, 'service_charge')
        ? { serviceCharge: Number(bill?.service_charge) || 0 }
        : {}),
      deliveryCharge: Number(bill?.delivery_charge) || 0,
      packagingCharge: Number(bill?.packaging_charge) || 0,
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
  readonly currency?: string;
  readonly trimDecimals: boolean;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly cutMode: PrinterCutMode;
  readonly capabilities?: ThermalPrinterCapabilities;
  readonly maskCustomerPhone?: boolean;
  readonly rasterGroups?: RasterSemanticLineGroup[];
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
function classicItemHeader(block: ItemTableBlock, nameLen: number, amtLen: number, language: string, capabilities?: ThermalPrinterCapabilities): string {
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
 * Map a PrintDocument onto the legacy classic token-line layout. Pure with
 * respect to business data: everything rendered comes from the document.
 */
export function renderBillDocumentToClassicLines(
  document: PrintDocument,
  options: ClassicDocumentRenderOptions,
): string[] {
  const cols = options.columns;
  const lines: string[] = [];
  const blocks = document.blocks;
  const breakdownIndex = blocks.findIndex((block) => block.kind === 'tax-breakdown');
  const totalsIndex = blocks.findIndex((block) => block.kind === 'totals');

  const prefix = resolveCurrencyPrefix(options.currencySymbol ?? '₹', options.useUnicode, options.capabilities);
  const fractionDigits = getCurrencyFractionDigits(options.currency || 'INR');
  const trimDecimals = options.trimDecimals === true;
  const tzOptions = options.timezone ? { timeZone: options.timezone } : undefined;
  const dash = '-'.repeat(cols);
  const normalize = (text: string): string => normalizeThermalText(text, options.capabilities);

  lines.push('{INIT}');

  // ---------------------------------------------------------------------
  // Ordered semantic composition (#447): EVERY block-owned line is
  // generated inside this loop, attributed to its own block, so a
  // merchant template's ordering/omission moves each block's FULL
  // content (banner, loyalty, header contact footer, footer note
  // included) with its position. Nothing is emitted outside the loop
  // except non-block-owned framing ({INIT}, powered-by, {CUT}).
  //
  // Blocks whose legacy layout splits across the receipt (business
  // header name vs contact footer, totals rows vs loyalty lines,
  // message banner / thank-you / footer note) contribute ordered
  // SEGMENTS: pre / main / post. Documents whose selected blocks appear
  // in the canonical relative order assemble those segments in the
  // pinned legacy arrangement (explicit canonical parity contract —
  // byte equality with the oracle); genuinely reordered compositions
  // emit each block's complete segment group strictly at its template
  // position.
  // ---------------------------------------------------------------------
  interface BlockSegments {
    pre: string[];
    main: string[];
    post: string[];
    sourceLines: { pre: string[]; main: string[]; post: string[] };
    groups: Array<{ groupId: string; start: number; count: number; sourceLines?: readonly string[] }>;
  }
  const segments = new Map<PrintDocumentBlock['kind'], BlockSegments>();
  const segmentOf = (kind: PrintDocumentBlock['kind']): BlockSegments => {
    let segment = segments.get(kind);
    if (!segment) {
      segment = { pre: [], main: [], post: [], sourceLines: { pre: [], main: [], post: [] }, groups: [] };
      segments.set(kind, segment);
    }
    return segment;
  };

  const renderGrandTotal = (block: TotalsBlock, target = segmentOf('totals')): void => {
    const label = labelOf(block.grandTotal.label);
    const value = formatCurrency(block.grandTotal.amount, prefix, options.locale, trimDecimals, fractionDigits);
    target.main.push(...financialRows(label, value, cols, options.language, options.capabilities).map((line) => `{BOLD}${line}{/BOLD}`));
    target.sourceLines.main.push(`${label}: ${value}`);
  };

  const renderCharges = (block: TotalsBlock, target: BlockSegments): void => {
    if (block.serviceCharge) {
      const label = labelOf(block.serviceCharge.label);
      const value = formatCurrency(block.serviceCharge.amount, prefix, options.locale, trimDecimals, fractionDigits);
      target.main.push(...financialRows(label, value, cols, options.language, options.capabilities));
      target.sourceLines.main.push(`${label}: ${value}`);
    }
    if (block.deliveryCharge) {
      const label = labelOf(block.deliveryCharge.label);
      const value = formatCurrency(block.deliveryCharge.amount, prefix, options.locale, trimDecimals, fractionDigits);
      target.main.push(...financialRows(label, value, cols, options.language, options.capabilities));
      target.sourceLines.main.push(`${label}: ${value}`);
    }
    if (block.packagingCharge) {
      const label = labelOf(block.packagingCharge.label);
      const value = formatCurrency(block.packagingCharge.amount, prefix, options.locale, trimDecimals, fractionDigits);
      target.main.push(...financialRows(label, value, cols, options.language, options.capabilities));
      target.sourceLines.main.push(`${label}: ${value}`);
    }
  };

  for (const block of blocks) {
    switch (block.kind) {
      case 'business-header': {
        const segment = segmentOf('business-header');
        if (block.name) {
          segment.main.push('{STORE_NAME}{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}' + truncateShapedLine(block.name.text, Math.floor(cols / 2), options.arabicShaping, options.language, options.capabilities) + '{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
          segment.sourceLines.main.push(block.name.text);
        }
        // Contact/tax facts are header-owned content; they travel with
        // the header block's position in reordered compositions.
        const footerLines: string[] = [];
        const footerSourceLines: string[] = [];
        if (block.address) {
          footerLines.push(block.address.text);
          footerSourceLines.push(block.address.text);
        }
        if (block.phone && block.phoneLabel) {
          footerLines.push(normalize(labelOf(block.phoneLabel) + ': ' + block.phone.text));
          footerSourceLines.push(labelOf(block.phoneLabel) + ': ' + block.phone.text);
        }
        if (block.taxId) {
          footerLines.push(normalize(labelOf(block.taxId.label) + ': ' + block.taxId.value.text));
          footerSourceLines.push(labelOf(block.taxId.label) + ': ' + block.taxId.value.text);
        }
        if (block.instagramHandle) {
          footerLines.push(block.instagramHandle.text);
          footerSourceLines.push(block.instagramHandle.text);
        }
        if (footerLines.length > 0) {
          segment.post.push(dash);
          for (const footerLine of footerLines) pushCenteredWrapped(segment.post, footerLine, cols, options.language, options.capabilities);
          segment.sourceLines.post.push(dash, ...footerSourceLines);
        }
        break;
      }
      case 'customer': {
        const segment = segmentOf('customer');
        const start = segment.main.length;
        if (block.name) {
          segment.main.push('{CENTER}{FONT_B}' + truncateShapedLine(block.name.text, cols, options.arabicShaping, options.language, options.capabilities) + '{/FONT_B}{/CENTER}');
          segment.sourceLines.main.push(block.name.text);
        }
        if (block.phone) {
          const phone = options.maskCustomerPhone ? maskPhoneOnReceipt(block.phone.text) : block.phone.text;
          segment.main.push('{CENTER}' + phone + '{/CENTER}');
          segment.sourceLines.main.push(phone);
        }
        if (segment.main.length > start) segment.groups.push({ groupId: 'customer', start, count: segment.main.length - start });
        break;
      }
      case 'document-meta': {
        const segment = segmentOf('document-meta');
        segment.main.push(dash);
        segment.sourceLines.main.push(dash);
        const defaultTitle = block.title.conceptId === 'print.taxInvoiceTitle'
          ? printLabel(options.language, 'print.taxInvoiceTitle')
          : printLabel(options.language, 'print.invoiceTitle');
        if (labelOf(block.title) !== defaultTitle) {
          segment.main.push('{CENTER}' + normalize(labelOf(block.title)) + '{/CENTER}');
          segment.sourceLines.main.push(labelOf(block.title));
        }
        segment.main.push('{CENTER}' + normalize(labelOf(block.invoiceNumberLabel) + ' ' + block.invoiceNumber.text) + '{/CENTER}');
        segment.sourceLines.main.push(labelOf(block.invoiceNumberLabel) + ' ' + block.invoiceNumber.text);
        const date = parseDbTimestamp(block.timestamp.text);
        segment.main.push('{CENTER}' + date.toLocaleDateString(options.locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(options.locale + '-u-nu-latn', tzOptions) + '{/CENTER}');
        segment.sourceLines.main.push(date.toLocaleDateString(options.locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(options.locale + '-u-nu-latn', tzOptions));
        if (block.table) {
          segment.main.push('{CENTER}' + truncateShapedLine(block.table.label.primary.replace('{name}', block.table.name.text), cols, options.arabicShaping, options.language, options.capabilities) + '{/CENTER}');
          segment.sourceLines.main.push(block.table.label.primary.replace('{name}', block.table.name.text));
        }
        segment.main.push(dash);
        segment.sourceLines.main.push(dash);
        break;
      }
      case 'item-table': {
        const segment = segmentOf('item-table');
        const amtLen = itemAmountWidth(
          { items: block.rows.map((row) => ({ total: row.amount, addons: row.addons.map((addon) => ({ price: addon.price })) })) },
          prefix,
          options.locale,
          trimDecimals,
          cols,
          fractionDigits,
        );
        const nameLen = itemNameWidth(cols, amtLen);
        segment.main.push(classicItemHeader(block, nameLen, amtLen, options.language, options.capabilities));
        segment.main.push(dash);
        for (const [rowIndex, row] of block.rows.entries()) {
          const start = segment.main.length;
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
          segment.main.push(...rowLines);
          const sourceLines = [`${row.name.text} ${row.quantity} ${formatCurrency(row.amount, prefix, options.locale, trimDecimals, fractionDigits)}`];
          for (const addon of row.addons) {
            const addonLines = addonRows({ name: addon.name.text, price: addon.price, quantity: addon.quantity }, nameLen, amtLen, cols, prefix, options.locale, trimDecimals, options.language, fractionDigits, options.capabilities);
            segment.main.push(...addonLines);
            const quantitySuffix = addon.quantity > 1 ? ` x${addon.quantity}` : '';
            sourceLines.push(`  + ${addon.name.text}${quantitySuffix}${addon.price ? ` ${formatCurrency(addon.price, prefix, options.locale, trimDecimals, fractionDigits)}` : ''}`);
          }
          if (row.specialInstructions) {
            segment.main.push(normalize('  ' + labelOf(block.noteLabel) + ': ' + truncate(row.specialInstructions.text, cols - 8, options.language, options.capabilities)));
            sourceLines.push('  ' + labelOf(block.noteLabel) + ': ' + row.specialInstructions.text);
          }
          if (segment.main.length > start) {
            const group = { groupId: `item-table-row-${rowIndex}`, start, count: segment.main.length - start };
            segment.groups.push({ ...group, sourceLines });
          }
        }
        segment.main.push(dash);
        break;
      }
      case 'tax-breakdown': {
        const segment = segmentOf('tax-breakdown');
        for (const line of block.lines) {
          const rateSuffix = line.rate === null ? '' : ` @${line.rate}%`;
          const label = truncate(labelOf(line.label) + rateSuffix, cols - 12, options.language, options.capabilities);
          const value = formatCurrency(line.amount, prefix, options.locale, trimDecimals, fractionDigits);
          segment.main.push(...financialRows(label, value, cols, options.language, options.capabilities));
          segment.sourceLines.main.push(`${labelOf(line.label)}${rateSuffix}: ${value}`);
        }
        // Explicit canonical tax/totals parity handling: when the
        // breakdown FOLLOWS the totals block (non-canonical order), the
        // bold grand total closes the breakdown segment instead.
        if (
          block.lines.length > 0
          && totalsIndex >= 0
          && breakdownIndex > totalsIndex
        ) {
          const totalsBlock = blocks[totalsIndex] as TotalsBlock;
          renderCharges(totalsBlock, segment);
          renderGrandTotal(totalsBlock, segment);
        }
        break;
      }
      case 'totals': {
        const segment = segmentOf('totals');
        if (block.pointsRedeemed) {
          const label = labelOf(block.pointsRedeemed.label);
          const value = '-' + block.pointsRedeemed.points + ' pts';
          segment.main.push(...financialRows(label, value, cols, options.language, options.capabilities));
          segment.sourceLines.main.push(`${label}: ${value}`);
        }
        {
          const label = labelOf(block.subtotal.label);
          const value = formatCurrency(block.subtotal.amount, prefix, options.locale, trimDecimals, fractionDigits);
          segment.main.push(...financialRows(label, value, cols, options.language, options.capabilities));
          segment.sourceLines.main.push(`${label}: ${value}`);
        }
        if (block.discount) {
          const label = labelOf(block.discount.label);
          const value = '-' + formatCurrency(block.discount.amount, prefix, options.locale, trimDecimals, fractionDigits);
          segment.main.push(...financialRows(label, value, cols, options.language, options.capabilities));
          segment.sourceLines.main.push(`${label}: ${value}`);
        }
        const hasBreakdownLines = blocks.some(
          (candidate) => candidate.kind === 'tax-breakdown'
            && (candidate as TaxBreakdownBlock).lines.length > 0,
        );
        if (!hasBreakdownLines && block.tax) {
          const label = labelOf(block.tax.label);
          const value = formatCurrency(block.tax.amount, prefix, options.locale, trimDecimals, fractionDigits);
          segment.main.push(...financialRows(label, value, cols, options.language, options.capabilities));
          segment.sourceLines.main.push(`${label}: ${value}`);
        }
        if (!hasBreakdownLines || breakdownIndex < totalsIndex) {
          renderCharges(block, segment);
        }
        if (!hasBreakdownLines) {
          renderGrandTotal(block);
        } else if (breakdownIndex < totalsIndex) {
          renderGrandTotal(block);
        }
        // Loyalty earned/balance is totals-owned content.
        if (block.pointsEarned || block.pointsBalance) {
          segment.post.push(dash);
          segment.sourceLines.post.push(dash);
          if (block.pointsEarned) {
            const label = labelOf(block.pointsEarned.label);
            const value = String(block.pointsEarned.points);
            segment.post.push(...financialRows(label, value, cols, options.language, options.capabilities));
            segment.sourceLines.post.push(`${label}: ${value}`);
          }
          if (block.pointsBalance) {
            const label = labelOf(block.pointsBalance.label);
            const value = String(block.pointsBalance.points);
            segment.post.push(...financialRows(label, value, cols, options.language, options.capabilities));
            segment.sourceLines.post.push(`${label}: ${value}`);
          }
        }
        break;
      }
      case 'payments': {
        const segment = segmentOf('payments');
        for (const line of block.lines) {
          const methodLabel = truncate(paymentLabel(line.label), cols - 12, options.language, options.capabilities);
          const value = formatCurrency(line.amount, prefix, options.locale, trimDecimals, fractionDigits);
          segment.main.push(...financialRows(methodLabel, value, cols, options.language, options.capabilities));
          segment.sourceLines.main.push(`${paymentLabel(line.label)}: ${value}`);
        }
        break;
      }
      case 'message': {
        const segment = segmentOf('message');
        if (block.reprintBanner) {
          segment.pre.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + normalize(labelOf(block.reprintBanner)) + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
          segment.sourceLines.pre.push(labelOf(block.reprintBanner));
        }
        if (block.onlineOrderBanner) {
          const banner = block.onlineOrderBanner;
          segment.pre.push('{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' + normalize(labelOf(banner.label)) + ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}');
          segment.sourceLines.pre.push(labelOf(banner.label));
          if (banner.platform.text) {
            segment.pre.push('{CENTER}' + normalize(banner.platform.text) + '{/CENTER}');
            segment.sourceLines.pre.push(banner.platform.text);
          }
          if (banner.externalOrderId.text) {
            segment.pre.push('{CENTER}#' + normalize(banner.externalOrderId.text) + '{/CENTER}');
            segment.sourceLines.pre.push('#' + banner.externalOrderId.text);
          }
        }
        if (block.thankYou && labelOf(block.thankYou) !== printLabel(options.language, 'print.thankYouShort')) {
          segment.main.push('{CENTER}' + normalize(labelOf(block.thankYou)) + '{/CENTER}');
          segment.sourceLines.main.push(labelOf(block.thankYou));
        }
        if (block.footerNote) {
          pushCenteredWrapped(segment.post, block.footerNote.text, cols, options.language, options.capabilities);
          segment.sourceLines.post.push(block.footerNote.text);
        }
        break;
      }
    }
  }

  // Assemble. Documents whose selected blocks appear in the canonical
  // relative order use the pinned legacy segment arrangement (byte parity
  // with the oracle); reordered compositions concatenate each block's
  // full segment group strictly in template order.
  // Canonical block sequence of PrintDocument v1 (mirrors buildBillDocument;
  // asserted in tests/print-document.test.ts).
  const CANONICAL_LAYOUT: PrintDocumentBlock['kind'][] = [
    'business-header',
    'customer',
    'document-meta',
    'item-table',
    'totals',
    'tax-breakdown',
    'payments',
    'message',
  ];
  const canonicalRank = new Map(CANONICAL_LAYOUT.map((kind, index) => [kind, index]));
  let lastRank = -1;
  const isCanonicalRelativeOrder = blocks.every((block) => {
    const rank = canonicalRank.get(block.kind);
    if (rank === undefined || rank <= lastRank) return false;
    lastRank = rank;
    return true;
  });

  const emit = (kind: PrintDocumentBlock['kind'], part: 'pre' | 'main' | 'post'): void => {
    const segment = segments.get(kind);
    if (!segment) return;
    const start = lines.length;
    lines.push(...segment[part]);
    if (options.rasterGroups && segment[part].length > 0) {
      if (part === 'main' && segment.groups.length > 0) {
        for (const group of segment.groups) {
          options.rasterGroups.push({ groupId: group.groupId, lineIndex: start + group.start, lineCount: group.count, ...(group.sourceLines ? { sourceLines: group.sourceLines } : {}) });
        }
      } else {
        options.rasterGroups.push({ groupId: kind, lineIndex: start, lineCount: segment[part].length, sourceLines: segment.sourceLines[part] });
      }
    }
  };

  if (isCanonicalRelativeOrder) {
    // Pinned legacy arrangement (canonical parity contract). With the
    // canonical totals-before-breakdown sequence, the bold grand total
    // closes the breakdown segment (see the totals/breakdown cases).
    emit('message', 'pre');
    emit('business-header', 'main');
    emit('customer', 'main');
    emit('document-meta', 'main');
    emit('item-table', 'main');
    emit('totals', 'main');
    emit('tax-breakdown', 'main');
    emit('payments', 'main');
    emit('message', 'main');
    emit('totals', 'post');
    emit('business-header', 'post');
    emit('message', 'post');
  } else {
    // Strict template order: each block's complete content at its own
    // position — nothing moves across merchant-selected positions.
    for (const block of blocks) {
      const segment = segments.get(block.kind);
      if (!segment) continue;
      emit(block.kind, 'pre');
      emit(block.kind, 'main');
      emit(block.kind, 'post');
    }
  }

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
  readonly rasterGroups: readonly RasterSemanticLineGroup[];
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
    capabilities?: import('../../shared/print/thermal-capabilities').ThermalPrinterCapabilities;
    maskCustomerPhone?: boolean;
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
  const rasterGroups: RasterSemanticLineGroup[] = [];
  const lines = renderBillDocumentToClassicLines(document, {
    columns: opts.columns,
    language: printContext.languages[0],
    locale: printContext.locale,
    ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
    currencySymbol: printContext.currencySymbol,
    currency: String(business?.currency || 'INR'),
    trimDecimals: printContext.trimDecimals,
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
    capabilities: opts.capabilities,
    maskCustomerPhone: opts.maskCustomerPhone,
    rasterGroups,
  });
  const data = buildEscPos(lines, opts.useUnicode, { cutMode: opts.cutMode, arabicShaping: opts.arabicShaping, columns: opts.columns, language: opts.language, capabilities: opts.capabilities }, warnings);
  return { document, lines, data, warnings, rasterGroups };
}
