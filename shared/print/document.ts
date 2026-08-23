/**
 * Renderer-independent PrintDocument v1 (#442, epic #438).
 *
 * A PrintDocument is the authoritative SEMANTIC representation of a printed
 * receipt: an ordered list of blocks (business header, document meta,
 * customer, item table, tax breakdown, totals, payments, messages). It is
 * produced by pure builders from caller-supplied normalized snapshots and
 * consumed by renderers that choose physical layout (ESC/POS token lines,
 * HTML, …). No transport APIs and no byte tokens (`{CENTER}` etc.) exist in
 * this model.
 *
 * PURITY RULES (same contract as the rest of `shared/print/`, see README.md):
 *   - Types + pure functions only. No Electron, DOM, Node built-ins, DB,
 *     filesystem, network, or transport IO of any kind.
 *   - Builders perform NO database IO and NO financial recomputation. Tax
 *     components, totals and payment amounts arrive as printed truth inside
 *     {@link PrintData}; builders only apply presence/show decisions.
 *   - Labels are carried as concept references plus already-resolved strings
 *     (resolved through the injected {@link PrintContext.resolveLabel}
 *     catalog lookup) or explicit bilingual pairs — never pre-concatenated
 *     `"A / B"` strings.
 *   - Every block carries its resolved base direction; embedded values are
 *     annotated via the direction kernel so LTR islands (invoice numbers,
 *     phone numbers, amounts) stay distinguishable inside RTL documents.
 *
 * First consumer: the classic thermal receipt rendered through the backend
 * preview pipeline (#442). Merchant template schemas (#447/#448) and other
 * renderers adopt this model in later issues; schema documentation is owned
 * by #449.
 */

import type { BilingualLabel } from './bilingual';
import type { DirectionSpec } from './direction';
import { resolveDirectionSpec, resolveValueDirection } from './direction';
import type {
  PrintLanguageCode,
  ResolvedPrintLanguages,
  TextDirection,
} from './types';

// ---------------------------------------------------------------------------
// Label & value primitives
// ---------------------------------------------------------------------------

/**
 * Stable concept identifier from the print-label catalog (kernel C, #440).
 * Structural string on purpose: the set of valid concepts is owned by the
 * generated label tables at call sites, not by the kernel.
 */
export type LabelConceptId = string;

/**
 * A semantic label: a concept reference plus its already-resolved renderings.
 * `primary` is the primary receipt language string (fallbacks already
 * applied by the injected resolver); `secondary` is the optional second
 * receipt language rendering of the SAME concept. Renderers decide how the
 * two variants share a line — the model never pre-concatenates them.
 */
export interface SemanticLabel {
  /** Catalog concept this label resolves from, when it has one. */
  readonly conceptId?: LabelConceptId;
  /** Resolved primary-language text. */
  readonly primary: string;
  /** Resolved secondary-language text of the same concept, when configured. */
  readonly secondary?: string;
}

/** Build a {@link SemanticLabel} from an explicit bilingual pair. */
export function bilingualLabel(text: BilingualLabel, conceptId?: LabelConceptId): SemanticLabel {
  return Object.freeze({
    ...(conceptId !== undefined ? { conceptId } : {}),
    ...(text.secondary !== undefined ? { secondary: text.secondary } : {}),
    primary: text.primary,
  });
}

/**
 * A text value annotated with its resolved direction. Values classified as
 * confident LTR islands (see `resolveValueDirection`) carry `'ltr'` even in
 * RTL documents so renderers can embed them without bidi ambiguity.
 */
export interface DirectionalText {
  readonly text: string;
  readonly direction: TextDirection;
}

/** Annotate `text` with its value-scope direction for a document base direction. */
export function directionalText(text: string, base: TextDirection): DirectionalText {
  return Object.freeze({ text, direction: resolveValueDirection(text, base) });
}

// ---------------------------------------------------------------------------
// Snapshots (PrintData) — normalized authoritative values, no live rows
// ---------------------------------------------------------------------------

/** One addon line under an item row. Price is printed truth (0 = unpriced). */
export interface ItemAddonSnapshot {
  readonly name: string;
  readonly price: number;
  /** Addon unit quantity as printed truth, when the surface displays it. */
  readonly quantity?: number;
}

/** One item row as printed truth. */
export interface OrderItemSnapshot {
  readonly productName: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly total: number;
  readonly addons: readonly ItemAddonSnapshot[];
  readonly specialInstructions: string;
}

/** The order behind the bill, as printed truth. */
export interface OrderSnapshot {
  readonly orderNumber: string;
  /** Canonical stored timestamp; renderers localize for presentation. */
  readonly createdAt: string;
  readonly tableName: string;
  readonly items: readonly OrderItemSnapshot[];
}

/** One captured payment line. */
export interface PaymentSnapshot {
  readonly method: string;
  readonly amount: number;
}

/** One display tax component (already reconciled by the caller). */
export interface TaxComponentSnapshot {
  readonly title: string;
  readonly rate: number | null;
  readonly amount: number;
}

/** The bill's financial truth. Amounts are never recomputed by builders. */
export interface BillSnapshot {
  readonly billNumber: string;
  readonly subtotal: number;
  readonly discountAmount: number;
  readonly taxAmount: number;
  readonly total: number;
  /** Flat service charge, when the bill carries one (frontend bills). */
  readonly serviceCharge?: number;
  /** Flat delivery charge, when the bill carries one (frontend bills). */
  readonly deliveryCharge?: number;
  readonly taxComponents: readonly TaxComponentSnapshot[];
  readonly payments: readonly PaymentSnapshot[];
  readonly pointsEarned: number;
  readonly pointsRedeemed: number;
  readonly pointsBalance: number | null;
}

/**
 * Merchant/business snapshot incl. the receipt show-flags. Builders apply
 * these flags while composing blocks so renderers receive final content.
 */
export interface BusinessSnapshot {
  readonly name: string;
  readonly address: string;
  readonly phone: string;
  readonly taxRegistrationNumber: string;
  /** Country-profile tax ID label (e.g. "GSTIN"), resolved by the caller. */
  readonly taxIdLabel: string;
  readonly instagramHandle: string;
  readonly footerNote: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly showName: boolean;
  readonly showAddress: boolean;
  readonly showPhone: boolean;
  /**
   * Tri-state legacy flag: `'force'` prints the tax ID whenever a number
   * exists, `'never'` suppresses it, `'auto'` prints it when the bill
   * carries applicable tax.
   */
  readonly showTaxId: 'force' | 'never' | 'auto';
  readonly showTaxBreakdown: boolean;
  readonly showTableNumber: boolean;
  readonly showCustomerName: boolean;
  readonly showCustomerPhone: boolean;
}

/**
 * Normalized authoritative values passed in by callers. Renderers and
 * builders perform no DB IO — everything printed must be present here.
 */
export interface PrintData {
  readonly bill: BillSnapshot;
  readonly order: OrderSnapshot;
  readonly business: BusinessSnapshot;
  readonly isReprint: boolean;
}

// ---------------------------------------------------------------------------
// PrintContext — environment/capability facts, all caller-resolved
// ---------------------------------------------------------------------------

/** Injected, pure label-catalog lookup (kernel C view at the call site). */
export type LabelResolver = (conceptId: LabelConceptId, language: PrintLanguageCode) => string;

/**
 * Rendering environment for one document: paper geometry, resolved language
 * policy (kernel C), base direction (caller-injected registry fact), and
 * locale-formatting preferences derived from existing regionalization
 * helpers at the call site.
 */
export interface PrintContext {
  /** Printable paper columns (32…48 for thermal receipts today). */
  readonly columns: number;
  /** Ordered resolved languages, primary first (max 2 in v1). */
  readonly languages: ResolvedPrintLanguages;
  /** Base document direction for the primary language. */
  readonly baseDirection: TextDirection;
  /** BCP-47 locale used for date/number formatting (e.g. `en-IN`). */
  readonly locale: string;
  /** Currency symbol as configured for the business. */
  readonly currencySymbol: string;
  /** Whether trailing `.00` decimals are trimmed on amounts. */
  readonly trimDecimals: boolean;
  /** Optional IANA timezone for business-local date presentation. */
  readonly timezone?: string;
  /** Pure label lookup injected from the generated print-label catalog. */
  readonly resolveLabel: LabelResolver;
}

// ---------------------------------------------------------------------------
// Document blocks v1
// ---------------------------------------------------------------------------

/** Business identity: big header name plus contact/tax facts used in footers. */
export interface BusinessHeaderBlock {
  readonly kind: 'business-header';
  readonly direction: TextDirection;
  readonly name: DirectionalText | null;
  readonly address: DirectionalText | null;
  readonly phone: DirectionalText | null;
  readonly instagramHandle: DirectionalText | null;
  /** Tax registration line, present per merchant flag + tax applicability. */
  readonly taxId: { readonly label: SemanticLabel; readonly value: DirectionalText } | null;
  /** Label used when the business phone renders as a labeled contact line. */
  readonly phoneLabel: SemanticLabel | null;
}

/** Invoice identity: title concept, number, canonical timestamp, table. */
export interface DocumentMetaBlock {
  readonly kind: 'document-meta';
  readonly direction: TextDirection;
  /** Tax-invoice vs plain-invoice title, chosen by tax applicability. */
  readonly title: SemanticLabel;
  /** Label rendered alongside the invoice/order number. */
  readonly invoiceNumberLabel: SemanticLabel;
  /** Alternate bill-number label; layouts that head the receipt with "Bill #". */
  readonly billNumberLabel: SemanticLabel;
  /** Date label for layouts that print a labeled date line (e.g. compact). */
  readonly dateLabel: SemanticLabel;
  readonly invoiceNumber: DirectionalText;
  /** Canonical stored timestamp; presentation formatting is a renderer duty. */
  readonly timestamp: DirectionalText;
  /** Table reference with its (uninterpolated) label concept. */
  readonly table: { readonly label: SemanticLabel; readonly name: DirectionalText } | null;
}

/** Customer identity lines (name / phone), when present and shown. */
export interface CustomerBlock {
  readonly kind: 'customer';
  readonly direction: TextDirection;
  readonly name: DirectionalText | null;
  readonly phone: DirectionalText | null;
  /** Labels for layouts that render labeled customer lines (compact). */
  readonly nameLabel: SemanticLabel;
  readonly phoneLabel: SemanticLabel;
}

/** One addon under an item row. `price === 0` means unpriced extra. */
export interface ItemAddonValue {
  readonly name: DirectionalText;
  readonly price: number;
  /** Addon unit quantity as printed truth, when the snapshot carries one. */
  readonly quantity?: number;
}

/** One item row: semantic fields only — no layout widths, no byte tokens. */
export interface ItemTableRow {
  readonly direction: TextDirection;
  readonly name: DirectionalText;
  readonly quantity: number;
  /** Per-unit price as printed truth, when the surface prints a rate column. */
  readonly unitPrice?: number;
  /** Line total as printed truth. */
  readonly amount: number;
  readonly addons: readonly ItemAddonValue[];
  readonly specialInstructions: DirectionalText | null;
}

/** Column-header labels for the item table (concepts + resolved strings). */
export interface ItemTableHeaderLabels {
  readonly item: SemanticLabel;
  readonly quantity: SemanticLabel;
  readonly amount: SemanticLabel;
}

/** Ordered item rows including addons and special instructions. */
export interface ItemTableBlock {
  readonly kind: 'item-table';
  readonly direction: TextDirection;
  readonly header: ItemTableHeaderLabels;
  /** Label rendered before an item's special instruction text. */
  readonly noteLabel: SemanticLabel;
  readonly rows: readonly ItemTableRow[];
}

/**
 * Per-component tax lines (only when the merchant shows the breakdown).
 * Component titles are printed truth from the caller's tax resolution.
 */
export interface TaxBreakdownBlock {
  readonly kind: 'tax-breakdown';
  readonly direction: TextDirection;
  readonly lines: readonly {
    readonly label: SemanticLabel;
    readonly rate: number | null;
    readonly amount: number;
  }[];
}

/**
 * Financial summary. All labels are semantic (bilingual pairs allowed);
 * sign/points suffixes ("−", "pts") are presentation choices renderers make.
 */
export interface TotalsBlock {
  readonly kind: 'totals';
  readonly direction: TextDirection;
  readonly subtotal: { readonly label: SemanticLabel; readonly amount: number };
  readonly discount: { readonly label: SemanticLabel; readonly amount: number } | null;
  /** Flat tax line, present only when no breakdown lines are emitted. */
  readonly tax: { readonly label: SemanticLabel; readonly amount: number } | null;
  /** Flat service-charge line, present when the snapshot carries a nonzero charge. */
  readonly serviceCharge: { readonly label: SemanticLabel; readonly amount: number } | null;
  /** Flat delivery-charge line, present when the snapshot carries a nonzero charge. */
  readonly deliveryCharge: { readonly label: SemanticLabel; readonly amount: number } | null;
  readonly grandTotal: { readonly label: SemanticLabel; readonly amount: number };
  readonly pointsRedeemed: { readonly label: SemanticLabel; readonly points: number } | null;
  readonly pointsEarned: { readonly label: SemanticLabel; readonly points: number } | null;
  readonly pointsBalance: { readonly label: SemanticLabel; readonly points: number } | null;
}

/** Captured payment lines; unknown methods keep their raw code as literal. */
export interface PaymentsBlock {
  readonly kind: 'payments';
  readonly direction: TextDirection;
  readonly lines: readonly {
    /** Raw payment-method code (e.g. `cash`). */
    readonly method: string;
    readonly label: SemanticLabel;
    readonly amount: number;
  }[];
}

/**
 * Banner/footer/thank-you messaging. Designed so future banners (e.g. the
 * online-order banner, #284) become additional semantic entries rather than
 * ad-hoc renderer strings; the reprint banner lives here today.
 */
export interface MessageBlock {
  readonly kind: 'message';
  readonly direction: TextDirection;
  readonly reprintBanner: SemanticLabel | null;
  readonly footerNote: DirectionalText | null;
  readonly thankYou: SemanticLabel | null;
}

/** Ordered union of every PrintDocument v1 block kind. */
export type PrintDocumentBlock =
  | BusinessHeaderBlock
  | DocumentMetaBlock
  | CustomerBlock
  | ItemTableBlock
  | TaxBreakdownBlock
  | TotalsBlock
  | PaymentsBlock
  | MessageBlock;

/**
 * Renderer-independent semantic receipt document, version 1. Blocks appear
 * in canonical document order; each carries its resolved direction.
 */
export interface PrintDocument {
  readonly version: 1;
  /** Per-scope direction spec for the whole document (direction kernel). */
  readonly direction: DirectionSpec;
  /** Ordered resolved languages the document's labels were resolved in. */
  readonly languages: ResolvedPrintLanguages;
  readonly blocks: readonly PrintDocumentBlock[];
}

/** Typed accessor for one block kind within a document. */
export function getBlock<K extends PrintDocumentBlock['kind']>(
  document: PrintDocument,
  kind: K,
): Extract<PrintDocumentBlock, { kind: K }> | undefined {
  return document.blocks.find((block): block is Extract<PrintDocumentBlock, { kind: K }> => block.kind === kind);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface LabelContext {
  readonly ctx: PrintContext;
  readonly primary: PrintLanguageCode;
  readonly secondary?: PrintLanguageCode;
}

/** Concept ids for known payment methods; unknown methods stay literal. */
const PAYMENT_METHOD_CONCEPTS: Readonly<Record<string, LabelConceptId>> = Object.freeze({
  cash: 'pos.methodCash',
  card: 'pos.methodCard',
  wallet: 'pos.methodWallet',
});

function resolveSemanticLabel(labels: LabelContext, conceptId: LabelConceptId): SemanticLabel {
  return Object.freeze({
    conceptId,
    primary: labels.ctx.resolveLabel(conceptId, labels.primary),
    ...(labels.secondary !== undefined
      ? { secondary: labels.ctx.resolveLabel(conceptId, labels.secondary) }
      : {}),
  });
}

function literalLabel(primary: string): SemanticLabel {
  return Object.freeze({ primary });
}

function paymentLabel(labels: LabelContext, method: string): SemanticLabel {
  const conceptId = PAYMENT_METHOD_CONCEPTS[method.toLowerCase()];
  return conceptId !== undefined ? resolveSemanticLabel(labels, conceptId) : literalLabel(method);
}

function optionalDirectional(text: string | undefined | null, base: TextDirection): DirectionalText | null {
  if (text === undefined || text === null || String(text).length === 0) return null;
  return directionalText(String(text), base);
}

function toFiniteNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Build a PrintDocument v1 from normalized print data. Pure: reads only its
 * arguments; performs no IO and no financial recomputation (totals, taxes
 * and payments are copied verbatim from `printData.bill`).
 */
export function buildBillDocument(printData: PrintData, printContext: PrintContext): PrintDocument {
  const { bill, order, business } = printData;
  const base = printContext.baseDirection;

  const labels: LabelContext = {
    ctx: printContext,
    primary: printContext.languages[0],
    ...(printContext.languages.length > 1 ? { secondary: printContext.languages[1] } : {}),
  };

  const taxComponents = bill.taxComponents.filter(
    (component) => toFiniteNumber(component.amount) !== 0,
  );
  const hasTax = toFiniteNumber(bill.taxAmount) !== 0 || taxComponents.length > 0;

  const showBreakdown = business.showTaxBreakdown && taxComponents.length > 0;
  const showTaxIdLine = business.taxRegistrationNumber.length > 0
    && (business.showTaxId === 'force'
      || (business.showTaxId === 'auto' && hasTax));

  const header: BusinessHeaderBlock = Object.freeze({
    kind: 'business-header',
    direction: base,
    name: business.showName ? optionalDirectional(business.name, base) : null,
    address: business.showAddress ? optionalDirectional(business.address, base) : null,
    phone: business.showPhone ? optionalDirectional(business.phone, base) : null,
    instagramHandle: optionalDirectional(business.instagramHandle, base),
    taxId: showTaxIdLine
      ? Object.freeze({
        label: literalLabel(business.taxIdLabel.length > 0 ? business.taxIdLabel : 'Tax ID'),
        value: directionalText(business.taxRegistrationNumber, base),
      })
      : null,
    phoneLabel: business.showPhone && business.phone.length > 0
      ? resolveSemanticLabel(labels, 'receipt.phone')
      : null,
  });

  const meta: DocumentMetaBlock = Object.freeze({
    kind: 'document-meta',
    direction: base,
    title: resolveSemanticLabel(labels, hasTax ? 'print.taxInvoiceTitle' : 'print.invoiceTitle'),
    invoiceNumberLabel: resolveSemanticLabel(labels, 'print.invoiceNumber'),
    billNumberLabel: resolveSemanticLabel(labels, 'receipt.billNumber'),
    dateLabel: resolveSemanticLabel(labels, 'receipt.date'),
    invoiceNumber: directionalText(
      bill.billNumber.length > 0 ? bill.billNumber : order.orderNumber,
      base,
    ),
    timestamp: directionalText(order.createdAt, base),
    table: business.showTableNumber && order.tableName.length > 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'pos.tableLabel'),
        name: directionalText(order.tableName, base),
      })
      : null,
  });

  const customer: CustomerBlock = Object.freeze({
    kind: 'customer',
    direction: base,
    name: business.showCustomerName ? optionalDirectional(business.customerName, base) : null,
    phone: business.showCustomerPhone ? optionalDirectional(business.customerPhone, base) : null,
    nameLabel: resolveSemanticLabel(labels, 'pos.customer'),
    phoneLabel: resolveSemanticLabel(labels, 'print.numberShort'),
  });

  const items: ItemTableBlock = Object.freeze({
    kind: 'item-table',
    direction: base,
    header: Object.freeze({
      item: resolveSemanticLabel(labels, 'receipt.item'),
      quantity: resolveSemanticLabel(labels, 'receipt.qty'),
      amount: resolveSemanticLabel(labels, 'receipt.amount'),
    }),
    noteLabel: resolveSemanticLabel(labels, 'print.note'),
    rows: Object.freeze(order.items.map((item) => Object.freeze({
      direction: base,
      name: directionalText(item.productName, base),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      amount: item.total,
      addons: Object.freeze(item.addons.map((addon) => Object.freeze({
        name: directionalText(addon.name, base),
        price: addon.price,
        quantity: addon.quantity,
      }))),
      specialInstructions: optionalDirectional(item.specialInstructions, base),
    }))),
  });

  const breakdown: TaxBreakdownBlock = Object.freeze({
    kind: 'tax-breakdown',
    direction: base,
    lines: Object.freeze((showBreakdown ? taxComponents : []).map((component) => Object.freeze({
      label: literalLabel(component.title),
      rate: component.rate,
      amount: component.amount,
    }))),
  });

  const totals: TotalsBlock = Object.freeze({
    kind: 'totals',
    direction: base,
    subtotal: Object.freeze({
      label: resolveSemanticLabel(labels, 'pos.subtotal'),
      amount: bill.subtotal,
    }),
    discount: bill.discountAmount > 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'pos.discount'),
        amount: bill.discountAmount,
      })
      : null,
    tax: !showBreakdown && toFiniteNumber(bill.taxAmount) !== 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'pos.tax'),
        amount: bill.taxAmount,
      })
      : null,
    serviceCharge: toFiniteNumber(bill.serviceCharge) !== 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'receipt.serviceCharge'),
        amount: toFiniteNumber(bill.serviceCharge),
      })
      : null,
    deliveryCharge: toFiniteNumber(bill.deliveryCharge) !== 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'pos.delivery'),
        amount: toFiniteNumber(bill.deliveryCharge),
      })
      : null,
    grandTotal: Object.freeze({
      label: resolveSemanticLabel(labels, 'print.grandTotal'),
      amount: bill.total,
    }),
    pointsRedeemed: bill.pointsRedeemed > 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'print.pointsRedeemed'),
        points: bill.pointsRedeemed,
      })
      : null,
    pointsEarned: bill.pointsEarned > 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'print.pointsEarned'),
        points: bill.pointsEarned,
      })
      : null,
    pointsBalance: bill.pointsBalance !== null && bill.pointsBalance !== 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'print.pointsBalance'),
        points: bill.pointsBalance,
      })
      : null,
  });

  const payments: PaymentsBlock = Object.freeze({
    kind: 'payments',
    direction: base,
    lines: Object.freeze(bill.payments
      .filter((payment) => payment.method.length > 0)
      .map((payment) => Object.freeze({
        method: payment.method,
        label: paymentLabel(labels, payment.method),
        amount: payment.amount,
      }))),
  });

  const messages: MessageBlock = Object.freeze({
    kind: 'message',
    direction: base,
    reprintBanner: printData.isReprint ? resolveSemanticLabel(labels, 'receipt.reprint') : null,
    footerNote: business.footerNote.length > 0 ? directionalText(business.footerNote, base) : null,
    thankYou: resolveSemanticLabel(labels, 'print.thankYouShort'),
  });

  return Object.freeze({
    version: 1 as const,
    direction: resolveDirectionSpec(base),
    languages: printContext.languages,
    blocks: Object.freeze([
      header,
      customer,
      meta,
      items,
      totals,
      breakdown,
      payments,
      messages,
    ] as readonly PrintDocumentBlock[]),
  });
}

// ---------------------------------------------------------------------------
// KOT document variant (kitchen order ticket) — #443
// ---------------------------------------------------------------------------

/** One addon under a KOT item row. Kitchen tickets print names only. */
export interface KotAddonSnapshot {
  readonly name: string;
}
/** One item on the kitchen ticket, as printed truth. */
export interface KotItemSnapshot {
  readonly productName: string;
  readonly quantity: number;
  readonly addons: readonly KotAddonSnapshot[];
  readonly specialInstructions: string;
}

/** The order behind the ticket (order number, canonical timestamp, table). */
export interface KotOrderSnapshot {
  readonly orderNumber: string;
  readonly createdAt: string;
  readonly tableName: string;
}

/**
 * Normalized authoritative values for one kitchen ticket. Pure snapshot —
 * no live rows; callers normalize before building.
 */
export interface KotPrintData {
  readonly stationName: string;
  readonly order: KotOrderSnapshot;
  readonly items: readonly KotItemSnapshot[];
}

/** Ticket header: banner, station, order number, table, time. */
export interface KotHeaderBlock {
  readonly kind: 'kot-header';
  readonly direction: TextDirection;
  readonly banner: SemanticLabel;
  readonly stationLabel: SemanticLabel;
  readonly stationName: DirectionalText;
  /**
   * Order reference. The legacy renderer keeps an unaudited literal
   * `Order:` prefix (#440/#441 note); label adoption is a later decision,
   * so the document carries only the value here.
   */
  readonly orderNumber: DirectionalText;
  /** Table reference with its (uninterpolated) label concept. */
  readonly table: { readonly label: SemanticLabel; readonly name: DirectionalText } | null;
  readonly timeLabel: SemanticLabel;
  /** Canonical stored timestamp; presentation formatting is a renderer duty. */
  readonly timestamp: DirectionalText;
}

/** Ordered kitchen item rows with addons and preparation instructions. */
export interface KotItemsBlock {
  readonly kind: 'kot-items';
  readonly direction: TextDirection;
  readonly rows: readonly {
    readonly quantity: number;
    readonly name: DirectionalText;
    readonly addons: readonly DirectionalText[];
    readonly specialInstructions: DirectionalText | null;
  }[];
}

/** Ordered union of KOT v1 block kinds. */
export type KotDocumentBlock = KotHeaderBlock | KotItemsBlock;

/**
 * Renderer-independent semantic kitchen-ticket document, version 1.
 * KOT language policy is single-primary (v1): exactly one resolved language.
 */
export interface KotDocument {
  readonly version: 1;
  readonly direction: DirectionSpec;
  readonly languages: ResolvedPrintLanguages;
  readonly blocks: readonly KotDocumentBlock[];
}

/**
 * Build a KotDocument v1 from normalized kitchen-ticket data. Pure: reads
 * only its arguments and performs no IO or recomputation.
 */
export function buildKotDocument(printData: KotPrintData, printContext: PrintContext): KotDocument {
  const base = printContext.baseDirection;
  const primary = printContext.languages[0];

  const labels: LabelContext = { ctx: printContext, primary };

  const header: KotHeaderBlock = Object.freeze({
    kind: 'kot-header',
    direction: base,
    banner: resolveSemanticLabel(labels, 'print.kot.banner'),
    stationLabel: resolveSemanticLabel(labels, 'print.kot.station'),
    stationName: directionalText(String(printData.stationName ?? ''), base),
    orderNumber: directionalText(String(printData.order?.orderNumber ?? ''), base),
    table: typeof printData.order?.tableName === 'string' && printData.order.tableName.length > 0
      ? Object.freeze({
        label: resolveSemanticLabel(labels, 'pos.tableLabel'),
        name: directionalText(printData.order.tableName, base),
      })
      : null,
    timeLabel: resolveSemanticLabel(labels, 'print.time'),
    timestamp: directionalText(String(printData.order?.createdAt ?? ''), base),
  });

  const items: KotItemsBlock = Object.freeze({
    kind: 'kot-items',
    direction: base,
    rows: Object.freeze((Array.isArray(printData.items) ? printData.items : []).map((item) => Object.freeze({
      quantity: Number(item?.quantity) || 0,
      name: directionalText(String(item?.productName ?? ''), base),
      addons: Object.freeze((item?.addons ?? new Array<KotAddonSnapshot>())
        .filter((addon: KotAddonSnapshot) => typeof addon?.name === 'string' && addon.name.length > 0)
        .map((addon: KotAddonSnapshot) => directionalText(String(addon.name), base))),
      specialInstructions: optionalDirectional(item?.specialInstructions, base),
    }))),
  });

  return Object.freeze({
    version: 1 as const,
    direction: resolveDirectionSpec(base),
    languages: printContext.languages,
    blocks: Object.freeze([header, items] as readonly KotDocumentBlock[]),
  });
}
