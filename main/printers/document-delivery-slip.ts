
import { parseDbTimestamp } from '../db';
import { formatMoney, getCurrencyMinorUnitFactor, type CurrencyDisplay, type DigitMode } from '../countries';
import { printLabel } from '../print/print-labels.generated';
import type { PrintConceptId } from '../../shared/print/concepts';
import type { PrinterCutMode } from './profiles';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { RasterSemanticLineGroup } from '../../shared/print/raster';
import {
  buildEscPos,

  formatVariantItemHeading,
  parseVariantSelection,
  pushWrapped,
  truncate,
  truncateShapedLine,
  type PrintWarning,
} from './formatting-helpers';
import {
  GENERIC_THERMAL_CAPABILITIES,
  isThermalTextRepresentable,
  mergeThermalCapabilities,
  shouldUseOrderTypeFallback,
  thermalTextFallback,
} from '../../shared/print/thermal-capabilities';
import { detectPrintLanguageDirection } from './document-classic';
import { displayCellWidth } from '../../shared/print/width';
import {
  buildDeliverySlipDocument,
  clampDeliverySlipText,
  MAX_DELIVERY_SLIP_NOTE_CHARS,
  resolveDeliverySlipPaymentSummary,
  sanitizeDeliverySlipPaymentMethod,
  type DeliverySlipAddressSource,
  type DeliverySlipContactBlock,
  type DeliverySlipPaymentBill,
  type DeliverySlipDocument,
  type DeliverySlipDocumentBlock,
  type DeliverySlipHeaderBlock,
  type DeliverySlipItemsBlock,
  type DeliverySlipNotesBlock,
  type DeliverySlipPaymentBlock,
  type DeliverySlipPrintData,
  type PrintContext,
  type SemanticLabel,
} from '../../shared/print';

export { MAX_DELIVERY_SLIP_NOTE_CHARS };

export const MAX_DELIVERY_SLIP_ADDRESS_CHARS = 300;

function parseSlipAddons(value: unknown): Array<{ name: string; quantity?: number }> {
  let candidates = value;
  if (typeof value === 'string') {
    try {
      candidates = JSON.parse(value);
    } catch {
      candidates = null;
    }
  }
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((addon: unknown): addon is { name: string; quantity?: number } =>
      Boolean(addon) && typeof addon === 'object' && typeof (addon as { name?: unknown }).name === 'string')
    .map((addon) => ({
      name: addon.name,
      ...(typeof addon.quantity === 'number' && Number.isFinite(addon.quantity) && addon.quantity > 0
        ? { quantity: addon.quantity }
        : {}),
    }));
}

/** The order fields the slip reads. Rows arrive from SQLite, so all are optional. */
export interface DeliverySlipOrderRow {
  readonly order_number?: unknown;
  readonly created_at?: unknown;
  readonly type?: unknown;
  /** Address confirmed for this delivery; absent on every pre-column order. */
  readonly delivery_address?: unknown;
  /** Order-level note. Item-level instructions arrive on DeliverySlipItemRow. */
  readonly special_instructions?: unknown;
  /** Courier-only note; absent on every pre-column order. */
  readonly delivery_note?: unknown;
  /** Method expected at handover; NULL is unknown. Never a captured payment. */
  readonly expected_payment_method?: unknown;
  readonly total?: unknown;
  readonly bill?: {
    readonly payment_status?: unknown;
    readonly total?: unknown;
    readonly balance?: unknown;
    readonly payment_method?: unknown;
    readonly payment_details?: unknown;
  } | null;
  readonly bills?: readonly DeliverySlipPaymentBill[];
  readonly customer?: { readonly name?: unknown } | null;
}

export interface DeliverySlipItemRow {
  readonly product_name?: unknown;
  readonly quantity?: unknown;
  readonly addons?: unknown;
  readonly special_instructions?: unknown;
}

export function buildDeliverySlipPrintData(
  order: DeliverySlipOrderRow,
  items: readonly DeliverySlipItemRow[],
  contact: { name?: string; phone?: string; address?: string; addressSource?: DeliverySlipAddressSource | null },
  options: {
    showCustomerPhone?: boolean;
    locale?: string;
    currency?: string;
    currencyDisplay?: CurrencyDisplay;
    digits?: DigitMode;
  } = {},
): DeliverySlipPrintData {
  const orderAddress = typeof order?.delivery_address === 'string' ? order.delivery_address.trim() : '';
  const customerAddress = typeof contact?.address === 'string' ? contact.address.trim() : '';
  const { text: address, truncatedChars } = clampAddress(orderAddress.length > 0 ? orderAddress : customerAddress);
  const addressSource: DeliverySlipAddressSource | null = address.length === 0
    ? null
    : (orderAddress.length > 0 ? 'order' : (contact?.addressSource ?? 'customer'));
  const { text: note, truncatedChars: noteTruncatedChars } = clampDeliverySlipText(
    String(order?.special_instructions ?? '').trim(),
  );
  const { text: deliveryNote, truncatedChars: deliveryNoteTruncatedChars } = clampDeliverySlipText(
    String(order?.delivery_note ?? '').trim(),
  );
  const expectedMethod = sanitizeDeliverySlipPaymentMethod(order?.expected_payment_method);

  const ticketItems = Array.isArray(items) ? items : [];
  const paymentBills = Array.isArray(order?.bills) ? order.bills : order?.bill;
  const paymentSummary = resolveDeliverySlipPaymentSummary(
    order?.total,
    paymentBills,
    getCurrencyMinorUnitFactor(String(options.currency ?? '')),
  );
  const formatAmount = (amount: number) => formatMoney(amount, String(options.currency ?? ''), options.locale ?? 'en-US', {
    currencyDisplay: options.currencyDisplay,
    digits: options.digits,
  });
  const payment = paymentSummary
    ? {
      ...paymentSummary,
      formattedAmount: formatAmount(paymentSummary.amount),
      formattedAmountDue: formatAmount(paymentSummary.amountDue),
      ...(expectedMethod ? { expectedMethod } : {}),
    }
    : undefined;
  return {
    order: {
      orderNumber: String(order?.order_number ?? ''),
      createdAt: String(order?.created_at ?? ''),
      orderType: String(order?.type ?? '').trim(),
    },
    // Courier instruction for the whole delivery, printed once rather than per
    // item. Stored on every order; printed on none before this.
    note,
    noteTruncatedChars,
    deliveryNote,
    deliveryNoteTruncatedChars,
    contact: {
      name: String(contact?.name ?? order?.customer?.name ?? '').trim(),
      // The delivery override, or the receipt setting when it is off: both
      // documents then agree about the same merchant choice.
      phone: options.showCustomerPhone === false ? '' : String(contact?.phone ?? '').trim(),
      address,
      addressSource,
      addressTruncatedChars: truncatedChars,
    },
    ...(payment ? { payment } : {}),
    items: ticketItems.map((item) => ({
      productName: formatVariantItemHeading(
        String(item?.product_name ?? ''),
        parseVariantSelection(item?.variant_selection),
      ),
      quantity: Number(item?.quantity) || 0,
      addons: parseSlipAddons(item?.addons),
      specialInstructions: String(item?.special_instructions ?? ''),
    })),
  };
}

function clampAddress(address: string): { text: string; truncatedChars: number } {
  return clampDeliverySlipText(address, MAX_DELIVERY_SLIP_ADDRESS_CHARS);
}

export function buildDeliverySlipPrintContext(opts: {
  columns: number;
  language: string;
  locale?: string;
  currency?: string;
  currencySymbol?: string;
  timezone?: string;
}): PrintContext {
  return {
    columns: opts.columns,
    languages: [opts.language],
    baseDirection: detectPrintLanguageDirection(opts.language),
    locale: opts.locale ?? 'en-US',
    currency: opts.currency ?? '',
    currencySymbol: opts.currencySymbol ?? '',
    trimDecimals: false,
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
    resolveLabel: (conceptId, language) => printLabel(language, conceptId as PrintConceptId),
  };
}

// Document to delivery-slip ESC/POS token lines.

/** Renderer options: physical/locale presentation only, no business data. */
export interface DeliverySlipDocumentRenderOptions {
  readonly columns: number;
  readonly language: string;
  readonly locale?: string;
  readonly timezone?: string;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly cutMode: PrinterCutMode;
  readonly capabilities?: ThermalPrinterCapabilities;
  readonly rasterGroups?: RasterSemanticLineGroup[];
  readonly financialLineRanges?: Array<{ lineIndex: number; lineCount: number }>;
}

function slipBlock<K extends DeliverySlipDocumentBlock['kind']>(
  document: DeliverySlipDocument,
  kind: K,
): Extract<DeliverySlipDocumentBlock, { kind: K }> | undefined {
  return document.blocks.find((block): block is Extract<DeliverySlipDocumentBlock, { kind: K }> => block.kind === kind);
}

function labelOf(label: SemanticLabel): string {
  return label.primary;
}

const UNSUPPORTED_METADATA_PLACEHOLDER = '[UNSUPPORTED]';

function thermalSafeText(value: string, fallback: string, arabicShaping: boolean, capabilities?: ThermalPrinterCapabilities): string {
  const merged = mergeThermalCapabilities(capabilities ?? GENERIC_THERMAL_CAPABILITIES, arabicShaping);
  if (merged.raster.enabled === true && !isThermalTextRepresentable(value, merged)) return value;
  return thermalTextFallback(value, fallback, merged);
}

function thermalSafeMetadataValue(value: string, arabicShaping: boolean, capabilities?: ThermalPrinterCapabilities): string {
  return thermalSafeText(value, UNSUPPORTED_METADATA_PLACEHOLDER, arabicShaping, capabilities);
}

function slipHeaderLines(
  header: DeliverySlipHeaderBlock,
  options: DeliverySlipDocumentRenderOptions,
  sourceLines: string[],
  sourceControlLines: string[],
): string[] {
  const cols = options.columns;
  const lines: string[] = [];
  const tzOptions = options.timezone ? { timeZone: options.timezone } : undefined;
  const thermalCapabilities = mergeThermalCapabilities(options.capabilities, options.arabicShaping);

  const banner = thermalSafeText(labelOf(header.banner), 'DELIVERY SLIP', options.arabicShaping, options.capabilities);
  lines.push('{CENTER}{BOLD}' + truncateShapedLine(banner, cols, options.arabicShaping, options.language, options.capabilities) + '{/BOLD}{/CENTER}');
  sourceLines.push(labelOf(header.banner));
  sourceControlLines.push(lines.at(-1) ?? '');
  lines.push('');
  sourceLines.push('');
  sourceControlLines.push('');

  const orderNumberLabel = thermalSafeText(
    labelOf(header.orderNumberLabel).replace('{number}', header.orderNumber.text),
    `Order #${thermalSafeMetadataValue(header.orderNumber.text, options.arabicShaping, options.capabilities)}`,
    options.arabicShaping,
    options.capabilities,
  );
  lines.push(truncateShapedLine(orderNumberLabel, cols, options.arabicShaping, options.language, options.capabilities));
  sourceLines.push(labelOf(header.orderNumberLabel).replace('{number}', header.orderNumber.text));
  sourceControlLines.push(lines.at(-1) ?? '');

  if (header.orderType) {
    const localized = `${labelOf(header.orderType.label)}: ${header.orderType.value.text}`;
    const fallback = `Type: ${header.orderType.code.replace(/_/g, ' ').trim().toUpperCase()}`;
    const orderType = shouldUseOrderTypeFallback(localized, thermalCapabilities)
      ? fallback
      : thermalSafeText(localized, fallback, options.arabicShaping, options.capabilities);
    lines.push(truncateShapedLine(orderType, cols, options.arabicShaping, options.language, options.capabilities));
    sourceLines.push(`${labelOf(header.orderType.label)}: ${header.orderType.value.text}`);
    sourceControlLines.push(lines.at(-1) ?? '');
  }

  const time = parseDbTimestamp(header.timestamp.text).toLocaleTimeString((options.locale ?? 'en-US') + '-u-nu-latn', tzOptions);
  const timeLine = thermalSafeText(
    `${labelOf(header.timeLabel)}: ${time}`,
    `Time: ${parseDbTimestamp(header.timestamp.text).toLocaleTimeString('en-US-u-nu-latn', tzOptions)}`,
    options.arabicShaping,
    options.capabilities,
  );
  lines.push(truncateShapedLine(timeLine, cols, options.arabicShaping, options.language, options.capabilities));
  sourceLines.push(`${labelOf(header.timeLabel)}: ${time}`);
  sourceControlLines.push(lines.at(-1) ?? '');
  return lines;
}

function slipContactLines(
  contact: DeliverySlipContactBlock,
  options: DeliverySlipDocumentRenderOptions,
  sourceLines: string[],
  sourceControlLines: string[],
): string[] {
  const cols = options.columns;
  const lines: string[] = [];
  if (contact.name) {
    lines.push('{CENTER}{FONT_B}' + truncateShapedLine(contact.name.text, cols, options.arabicShaping, options.language, options.capabilities) + '{/FONT_B}{/CENTER}');
    sourceLines.push(contact.name.text);
    sourceControlLines.push(lines.at(-1) ?? '');
  }
  if (contact.phone) {
    lines.push('{CENTER}' + contact.phone.text + '{/CENTER}');
    sourceLines.push(contact.phone.text);
    sourceControlLines.push(lines.at(-1) ?? '');
  }
  if (contact.address) {
    // Wrapped, not truncated: a wrapped address stays readable at every rung.
    // pushWrapped is the helper the receipt uses for the shop's own address.
    const labeled = thermalSafeText(
      `${labelOf(contact.addressLabel)}: `,
      'Delivery address: ',
      options.arabicShaping,
      options.capabilities,
    ) + contact.address.text;
    const start = lines.length;
    pushWrapped(lines, labeled, cols, options.language, options.capabilities);
    sourceLines.push(labeled);
    sourceControlLines.push(lines[start] ?? '');
    if (contact.addressTruncatedChars > 0) {
      const marker = printLabel(options.language, 'print.deliverySlip.addressTruncated')
        .replace('{count}', String(contact.addressTruncatedChars));
      pushWrapped(lines, marker, cols, options.language, options.capabilities);
      sourceLines.push(marker);
      sourceControlLines.push(lines.at(-1) ?? '');
    }
  }
  return lines;
}

function slipNoteLines(
  notes: DeliverySlipNotesBlock,
  options: DeliverySlipDocumentRenderOptions,
  sourceLines: string[],
  sourceControlLines: string[],
): string[] {
  const lines: string[] = [];
  for (const [label, fallback, text, truncatedChars] of [
    [notes.deliveryNoteLabel, 'Delivery note: ', notes.deliveryNote, notes.deliveryNoteTruncatedChars],
    [notes.label, 'Note: ', notes.note, notes.noteTruncatedChars],
  ] as const) {
    // Wrapped, never truncated: a courier instruction cut mid-sentence is worse
    // than one that runs long. pushWrapped is the same helper the address uses.
    if (text) {
      const labeled = thermalSafeText(
        `${labelOf(label)}: `,
        fallback,
        options.arabicShaping,
        options.capabilities,
      ) + text.text;
      const start = lines.length;
      pushWrapped(lines, labeled, options.columns, options.language, options.capabilities);
      sourceLines.push(labeled);
      sourceControlLines.push(lines[start] ?? '');
    }
    // A courier instruction that ends without saying it was cut reads as the whole
    // instruction, so the drop is stated on the paper rather than only in the data.
    if (truncatedChars > 0) {
      const marker = printLabel(options.language, 'print.deliverySlip.addressTruncated')
        .replace('{count}', String(truncatedChars));
      pushWrapped(lines, marker, options.columns, options.language, options.capabilities);
      sourceLines.push(marker);
      sourceControlLines.push(lines.at(-1) ?? '');
    }
  }
  return lines;
}

function slipPaymentLines(
  payment: DeliverySlipPaymentBlock,
  options: DeliverySlipDocumentRenderOptions,
): string[] {
  const fallbackStatus = payment.status === 'paid'
    ? 'PAID'
    : payment.status === 'refunded'
      ? 'REFUNDED'
      : payment.status === 'partially_refunded'
        ? 'PARTIAL REFUND'
        : !payment.detailsText
          ? 'AMOUNT DUE'
          : 'TO COLLECT';
  const status = thermalSafeText(labelOf(payment.label), fallbackStatus, options.arabicShaping, options.capabilities);
  const method = payment.methodLabel?.primary ?? payment.methodName?.text ?? '';
  const totalLabel = thermalSafeText(printLabel(options.language, 'pos.total'), 'Total', options.arabicShaping, options.capabilities);
  const summary = payment.status === 'paid'
    ? `${status}: ${method ? `${method} ` : ''}(${totalLabel}: ${payment.amountText.text})`
    : payment.status === 'unpaid' && payment.detailsText
      ? `${status}: ${payment.amountText.text} (${payment.detailsText.text})`
      : `${status}${payment.amountText.text ? `: ${payment.amountText.text}` : ''}`;
  const lines: string[] = [];
  pushWrapped(lines, summary, options.columns, options.language, options.capabilities);
  if (lines.length > 0) lines[0] = `{BOLD}${lines[0]}{/BOLD}`;
  if ((payment.status === 'paid' || payment.status === 'refunded' || payment.status === 'partially_refunded') && payment.detailsText) {
    pushWrapped(lines, payment.detailsText.text, options.columns, options.language, options.capabilities);
  }
  return lines;
}

function slipItemLines(row: DeliverySlipItemsBlock['rows'][number], cols: number, arabicShaping: boolean, language: string, capabilities?: ThermalPrinterCapabilities): string[] {
  const lines: string[] = [];
  const itemPrefix = row.quantity + 'x  ';
  // These all arrive through directionalText, which already neutralised control
  // tokens, so the renderer only has to fit them to the column.
  lines.push('{BOLD}' + itemPrefix + truncateShapedLine(row.name.text, Math.max(1, cols - displayCellWidth(itemPrefix)), arabicShaping, language, capabilities) + '{/BOLD}');
  for (const addon of row.addons) {
    const quantity = addon.quantity ?? 1;
    const quantitySuffix = quantity > 1 ? ` x${quantity}` : '';
    const name = truncate(addon.text, Math.max(1, cols - 4 - displayCellWidth(quantitySuffix)), language, capabilities);
    lines.push('  + ' + name + quantitySuffix);
  }
  if (row.specialInstructions) {
    lines.push('  >> ' + truncateShapedLine(row.specialInstructions.text, Math.max(1, cols - 8), arabicShaping, language, capabilities));
  }
  return lines;
}

/** Map a DeliverySlipDocument onto the ESC/POS token-line layout. */
export function renderDeliverySlipDocumentToLines(document: DeliverySlipDocument, options: DeliverySlipDocumentRenderOptions): string[] {
  const lines: string[] = [];
  const cols = options.columns;
  const bar = '='.repeat(cols);

  const header = slipBlock(document, 'delivery-slip-header');
  const contact = slipBlock(document, 'delivery-slip-contact');
  const notes = slipBlock(document, 'delivery-slip-notes');
  const payment = slipBlock(document, 'delivery-slip-payment');
  const items = slipBlock(document, 'delivery-slip-items');

  lines.push('{INIT}');

  if (header) {
    const headerStart = lines.length;
    const headerSourceLines: string[] = [];
    const headerControlLines: string[] = [];
    lines.push(...slipHeaderLines(header, options, headerSourceLines, headerControlLines));
    options.rasterGroups?.push({
      groupId: 'delivery-slip-header',
      lineIndex: headerStart,
      lineCount: lines.length - headerStart,
      sourceLines: headerSourceLines,
      sourceControlLines: headerControlLines,
    });
  }

  lines.push(bar);
  lines.push('');

  if (contact) {
    const contactStart = lines.length;
    const contactSourceLines: string[] = [];
    const contactControlLines: string[] = [];
    lines.push(...slipContactLines(contact, options, contactSourceLines, contactControlLines));
    options.rasterGroups?.push({
      groupId: 'delivery-slip-contact',
      lineIndex: contactStart,
      lineCount: lines.length - contactStart,
      sourceLines: contactSourceLines,
      sourceControlLines: contactControlLines,
    });
  }

  if (notes) {
    const notesStart = lines.length;
    const notesSourceLines: string[] = [];
    const notesControlLines: string[] = [];
    lines.push(...slipNoteLines(notes, options, notesSourceLines, notesControlLines));
    if (lines.length > notesStart) {
      options.rasterGroups?.push({
        groupId: 'delivery-slip-notes',
        lineIndex: notesStart,
        lineCount: lines.length - notesStart,
        sourceLines: notesSourceLines,
        sourceControlLines: notesControlLines,
      });
    }
  }

  if (payment) {
    lines.push('');
    const paymentStart = lines.length;
    const paymentLines = slipPaymentLines(payment, options);
    lines.push(...paymentLines);
    if (paymentLines.length > 0) {
      options.rasterGroups?.push({
        groupId: 'delivery-slip-payment',
        lineIndex: paymentStart,
        lineCount: paymentLines.length,
        sourceLines: paymentLines.map((line) => line.replace(/\{\/?BOLD\}/g, '')),
        sourceControlLines: paymentLines,
        financial: true,
      });
      options.financialLineRanges?.push({ lineIndex: paymentStart, lineCount: paymentLines.length });
      lines.push('-'.repeat(cols));
    }
  }

  if (items) {
    for (const [rowIndex, row] of items.rows.entries()) {
      const rowStart = lines.length;
      const rowLines = slipItemLines(row, cols, options.arabicShaping, options.language, options.capabilities);
      lines.push(...rowLines);
      const sourceLines = [`${row.quantity}x  ${row.name.text}`];
      const sourceControlLines = [rowLines[0] ?? ''];
      let offset = 1;
      for (const addon of row.addons) {
        const quantitySuffix = (addon.quantity ?? 1) > 1 ? ` x${addon.quantity}` : '';
        sourceLines.push(`  + ${addon.text}${quantitySuffix}`);
        sourceControlLines.push(rowLines[offset] ?? '');
        offset += 1;
      }
      if (row.specialInstructions) {
        sourceLines.push('  >> ' + row.specialInstructions.text);
        sourceControlLines.push(rowLines[offset] ?? '');
      }
      if (options.rasterGroups) {
        options.rasterGroups.push({
          groupId: `delivery-slip-items-row-${rowIndex}`,
          lineIndex: rowStart,
          lineCount: lines.length - rowStart,
          sourceLines,
          sourceControlLines,
        });
      }
    }
  }

  lines.push('');
  lines.push(bar);
  lines.push('{CUT}');

  return lines;
}

// Entry: data -> document -> lines -> bytes.

export interface DeliverySlipDocumentRenderResult {
  readonly document: DeliverySlipDocument;
  readonly lines: string[];
  readonly data: Buffer;
  readonly warnings: PrintWarning[];
  readonly rasterGroups: readonly RasterSemanticLineGroup[];
}

/** Full document-driven delivery slip pipeline: data -> document -> lines -> bytes. */
export function renderDeliverySlipViaDocument(
  order: DeliverySlipOrderRow,
  items: readonly DeliverySlipItemRow[],
  contact: { name?: string; phone?: string; address?: string; addressSource?: DeliverySlipAddressSource | null },
  opts: {
    columns: number;
    language: string;
    locale?: string;
    currency?: string;
    currencySymbol?: string;
    currencyDisplay?: CurrencyDisplay;
    digits?: DigitMode;
    timezone?: string;
    useUnicode: boolean;
    arabicShaping: boolean;
    cutMode: PrinterCutMode;
    capabilities?: ThermalPrinterCapabilities;
    /** Merchant override for the delivery customer-number exception. Default on. */
    showCustomerPhone?: boolean;
  },
): DeliverySlipDocumentRenderResult {
  const printData = buildDeliverySlipPrintData(order, items, contact, opts);
  const printContext = buildDeliverySlipPrintContext({
    columns: opts.columns,
    language: opts.language,
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
    ...(opts.currencySymbol !== undefined ? { currencySymbol: opts.currencySymbol } : {}),
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
  });
  const document = buildDeliverySlipDocument(printData, printContext);
  const warnings: PrintWarning[] = [];
  const rasterGroups: RasterSemanticLineGroup[] = [];
  const financialLineRanges: Array<{ lineIndex: number; lineCount: number }> = [];
  const lines = renderDeliverySlipDocumentToLines(document, {
    columns: opts.columns,
    language: opts.language,
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
    capabilities: opts.capabilities,
    rasterGroups,
    financialLineRanges,
  });
  const data = buildEscPos(lines, opts.useUnicode, {
    cutMode: opts.cutMode,
    arabicShaping: opts.arabicShaping,
    columns: opts.columns,
    language: opts.language,
    capabilities: opts.capabilities,
    financialLineRanges,
  }, warnings);
  return { document, lines, data, warnings, rasterGroups };
}
