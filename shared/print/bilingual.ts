/**
 * Shared print kernel — bilingual label semantics (#441).
 * Pure functions only. Renderers choose presentation later; the kernel only
 * decides which width-fit strategy applies.
 */

/**
 * A semantic label carrying an optional secondary-language variant. The
 * primary text is always present; `secondary` is the second receipt
 * language's rendering of the same concept (see #442/#443 adoption).
 */
export interface BilingualLabel<P extends string = string, S extends string = string> {
  readonly primary: P;
  readonly secondary?: S;
}

/** How a bilingual label fits a fixed thermal column count. */
export type BilingualFitStrategy = 'inline' | 'stacked';

/**
 * Columns reserved between inline primary and secondary text. One space on
 * each side keeps the two variants readable when both fit on one line.
 */
export const INLINE_SEPARATOR_COLUMNS = 2;

/**
 * Visible width of a label in printer columns. v1 measures UTF-16 code units
 * (thermal fonts are effectively monospaced for Latin and Persian/Arabic at
 * the code points FloCafe prints today); renderers may pre-shape text before
 * applying these strategies. Keep pure: no Intl, no DOM measurement.
 */
export function labelWidth(text: string): number {
  return typeof text === 'string' ? text.length : 0;
}

/**
 * Select the width-fit strategy for a bilingual label at a given paper
 * column count:
 *   - single-language labels are trivially `'inline'`;
 *   - bilingual labels go `'inline'` when primary + separator + secondary
 *     fits within `columns`, otherwise `'stacked'` (one line each);
 *   - non-positive or non-finite column counts force `'stacked'`.
 *
 * Callers test this at 32/36/42/48 columns (58mm…80mm paper).
 */
export function selectBilingualFit(
  label: BilingualLabel,
  columns: number,
): BilingualFitStrategy {
  if (label.secondary === undefined) return 'inline';
  if (!Number.isFinite(columns) || columns <= 0) return 'stacked';
  const total = labelWidth(label.primary) + INLINE_SEPARATOR_COLUMNS + labelWidth(label.secondary);
  return total <= columns ? 'inline' : 'stacked';
}

/**
 * Ordered lines a renderer should emit for `label` under its selected
 * strategy. Pure view-model helper so every renderer stacks identically.
 */
export function bilingualLabelLines(
  label: BilingualLabel,
  strategy: BilingualFitStrategy,
): readonly string[] {
  if (strategy === 'inline' && label.secondary !== undefined) {
    const pad = ' '.repeat(INLINE_SEPARATOR_COLUMNS);
    return [`${label.primary}${pad}${label.secondary}`];
  }
  return label.secondary !== undefined && strategy === 'stacked'
    ? [label.primary, label.secondary]
    : [label.primary];
}
