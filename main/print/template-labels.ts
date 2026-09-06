import { printLabel } from './print-labels.generated';
import type { PrintConceptId } from '../../shared/print/concepts';

/** Semantic label IDs for compliance templates, mapping to concepts in the print-labels catalog. */
export const TEMPLATE_LABEL_IDS = {
  /** Receipt title when no tax applies. */
  invoice: 'print.invoiceTitle',
  /** Receipt title when tax applies (compliance "tax invoice"). */
  taxInvoice: 'print.taxInvoiceTitle',
  subtotal: 'pos.subtotal',
  discount: 'pos.discount',
  tax: 'pos.tax',
  /** Bold grand-total row label. */
  total: 'print.grandTotal',
  /** Persisted service-charge row label. */
  serviceCharge: 'receipt.serviceCharge',
  /** Persisted delivery-charge row label. */
  deliveryCharge: 'pos.delivery',
  /** Persisted packaging-charge row label. */
  packagingCharge: 'pos.packaging',
  /** Tax-inclusive pricing note (reserved; mapped to receipt.taxIncluded). */
  taxIncluded: 'receipt.taxIncluded',
  /** Default footer message when no configured footer note applies. */
  footerThanks: 'print.thankYouShort',
} as const satisfies Record<string, PrintConceptId>;

export type TemplateLabelId = keyof typeof TEMPLATE_LABEL_IDS;

/** Explicit charge-row capabilities in the v1 country-pack template contract. */
export const TEMPLATE_CHARGE_ROW_IDS = ['serviceCharge', 'deliveryCharge', 'packagingCharge'] as const;
export type TemplateChargeRowId = typeof TEMPLATE_CHARGE_ROW_IDS[number];

/** Install-time caps for the `labels` map (#445): fail closed on misuse. */
export const TEMPLATE_LABELS_MAX_ENTRIES = 64;
export const TEMPLATE_LABELS_MAX_VALUE_LENGTH = 120;

/** Printer control grammar recognized by receipt builder; stripped from untrusted labels. */
const PRINTER_TOKEN_PATTERN = /\{[A-Z_/]+\}/g;

/** Strip reserved printer tokens from template label text. */
export function sanitizeTemplateLabelText(text: string): string {
  return String(text ?? '').replace(PRINTER_TOKEN_PATTERN, '');
}

/** Sanitize a template label and clamp it to the printable column count. */
export function fitTemplateLabel(text: string, columns: number): string {
  const clean = sanitizeTemplateLabelText(text);
  if (!Number.isInteger(columns) || columns < 1 || clean.length <= columns) return clean;
  return columns <= 3 ? clean.slice(0, columns) : clean.slice(0, columns - 2) + '..';
}

/** Validate optional totals.chargeRows capability declaration at install time. */
export function validateTemplateChargeRows(rows: unknown): void {
  if (rows === undefined || rows === null) return;
  if (!Array.isArray(rows)) {
    throw new Error('Print template totals.chargeRows must be an array of supported charge-row ids');
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row !== 'string' || !(TEMPLATE_CHARGE_ROW_IDS as readonly string[]).includes(row)) {
      throw new Error(
        `Unknown print template charge row "${String(row)}". Supported ids: ${TEMPLATE_CHARGE_ROW_IDS.join(', ')}`,
      );
    }
    if (seen.has(row)) throw new Error(`Duplicate print template charge row "${row}"`);
    seen.add(row);
  }
}

/** Resolve declared rows in the contract's stable legal order. */
export function declaredTemplateChargeRows(rows: unknown): TemplateChargeRowId[] {
  if (!Array.isArray(rows)) return [];
  const declared = new Set(rows);
  return TEMPLATE_CHARGE_ROW_IDS.filter((row) => declared.has(row));
}

/** Validate optional payload-root labels map of a template payload at install time. */
export function validateTemplateLabelsMap(labels: unknown): void {
  if (labels === undefined || labels === null) return;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new Error('Print template labels must be an object mapping semantic label ids to strings');
  }
  const entries = Object.entries(labels as Record<string, unknown>);
  if (entries.length > TEMPLATE_LABELS_MAX_ENTRIES) {
    throw new Error(`Print template labels exceed the maximum of ${TEMPLATE_LABELS_MAX_ENTRIES} entries`);
  }
  for (const [key, value] of entries) {
    if (!Object.prototype.hasOwnProperty.call(TEMPLATE_LABEL_IDS, key)) {
      throw new Error(
        `Unknown print template label id "${key}". Supported ids: ${Object.keys(TEMPLATE_LABEL_IDS).join(', ')}`,
      );
    }
    if (typeof value !== 'string' || value.length < 1 || value.length > TEMPLATE_LABELS_MAX_VALUE_LENGTH) {
      throw new Error(
        `Print template label "${key}" must be a non-empty string of at most ${TEMPLATE_LABELS_MAX_VALUE_LENGTH} characters`,
      );
    }
  }
}

/** Resolve one template label at render time, falling back to built-in catalog. */
export function resolveTemplateLabel(labels: unknown, id: TemplateLabelId, lang: string, columns?: number): string {
  const override = labels && typeof labels === 'object' && !Array.isArray(labels)
    ? (labels as Record<string, unknown>)[id]
    : undefined;
  let resolved = typeof override === 'string' && override.length > 0
    ? sanitizeTemplateLabelText(override)
    : '';
  if (!resolved) resolved = printLabel(lang, TEMPLATE_LABEL_IDS[id]);
  return columns === undefined ? resolved : fitTemplateLabel(resolved, columns);
}
