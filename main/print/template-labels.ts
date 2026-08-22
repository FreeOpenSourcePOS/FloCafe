import { printLabel } from './print-labels.generated';
import type { PrintConceptId } from './print-labels.generated';

/**
 * Semantic label ids accepted on the optional payload-root `labels` map of
 * the `escpos-line-template-v1` compliance contract (#445, epic #438).
 *
 * These are stable PUBLIC identifiers for pack authors — deliberately NOT
 * internal i18n keys, which are not public API. Each id maps to exactly one
 * concept in the canonical print-labels catalog (#440), which supplies the
 * localized built-in default when a pack ships no override.
 *
 * Stability: once shipped, a semantic id never changes meaning or mapping;
 * unsupported ids are rejected at install time so authors get an immediate,
 * clear error instead of silently ignored copy.
 */
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
  /** Tax-inclusive pricing note (reserved; mapped to receipt.taxIncluded). */
  taxIncluded: 'receipt.taxIncluded',
  /** Default footer message when no configured footer note applies. */
  footerThanks: 'print.thankYouShort',
} as const satisfies Record<string, PrintConceptId>;

export type TemplateLabelId = keyof typeof TEMPLATE_LABEL_IDS;

/** Install-time caps for the `labels` map (#445): fail closed on misuse. */
export const TEMPLATE_LABELS_MAX_ENTRIES = 64;
export const TEMPLATE_LABELS_MAX_VALUE_LENGTH = 120;

/**
 * Validate the optional payload-root `labels` map of an
 * `escpos-line-template-v1` payload at install time (#445).
 *
 * Absent/null maps pass (the field is additive and optional). Structural
 * misuse — non-object maps, unknown semantic ids, more than
 * TEMPLATE_LABELS_MAX_ENTRIES entries, or non-string/empty/oversized values —
 * throws with a clear rejection message that surfaces through pack install.
 * The renderer version stays 1: this is validation only, never a schema bump.
 */
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

/**
 * Resolve one template label at render time: a valid pack-supplied `labels`
 * entry wins; otherwise the localized built-in default resolves through the
 * canonical catalog using the receipt language. Non-string or empty entries
 * are ignored at render time (install already rejects them), so a partially
 * damaged payload still renders real labels, never raw keys.
 */
export function resolveTemplateLabel(labels: unknown, id: TemplateLabelId, lang: string): string {
  const override = labels && typeof labels === 'object' && !Array.isArray(labels)
    ? (labels as Record<string, unknown>)[id]
    : undefined;
  if (typeof override === 'string' && override.length > 0) return override;
  return printLabel(lang, TEMPLATE_LABEL_IDS[id]);
}
