import { bilingualLabelLines, selectBilingualFit, type BilingualLabel } from './bilingual';
import type { ThermalPrinterCapabilities } from './thermal-capabilities';
import type { TextDirection, ResolvedPrintLanguages } from './types';
import type { PrintWarning } from './warnings';
import { displayCellWidth, wrapToDisplayCells } from './width';

export interface ThermalLayoutContext {
  readonly logicalColumns: number;
  readonly rasterWidthDots?: number;
  readonly direction: TextDirection;
  readonly languages: ResolvedPrintLanguages;
  readonly capabilities?: ThermalPrinterCapabilities;
  readonly locale?: string;
  readonly currency?: string;
  readonly currencySymbol?: string;
}

export type ThermalLayoutAlignment = 'left' | 'center' | 'right';

export interface StyledLayoutUnit {
  readonly text?: string;
  readonly label?: BilingualLabel;
  readonly alignment?: ThermalLayoutAlignment;
  readonly widthMultiplier?: 1 | 2;
  readonly field: string;
  readonly financial?: boolean;
}

export interface ThermalLayoutResult {
  readonly lines: readonly string[];
  readonly widthMultiplier: 1 | 2;
  readonly warnings: readonly PrintWarning[];
}

function displayWidth(text: string): number {
  return displayCellWidth(text);
}

function warningFor(unit: StyledLayoutUnit, message: string): PrintWarning {
  return {
    field: unit.field,
    text: unit.text ?? unit.label?.primary ?? '',
    message,
    kind: unit.financial ? 'financial' : 'line',
  };
}

/**
 * Lay out one complete semantic unit before ESC/POS encoding. A style is
 * downgraded before text is wrapped, and text is never sliced to make a style
 * fit. This is intentionally pure so every transport can use the same rule.
 */
export function layoutStyledUnit(
  unit: StyledLayoutUnit,
  context: ThermalLayoutContext,
): ThermalLayoutResult {
  const columns = Math.max(1, Math.floor(context.logicalColumns));
  const requestedMultiplier = unit.widthMultiplier ?? 1;
  const styleColumns = requestedMultiplier === 2 ? Math.max(1, Math.floor(columns / 2)) : columns;
  const label = unit.label ?? { primary: unit.text ?? '' };
  const bilingualStrategy = selectBilingualFit(label, styleColumns);
  const variants = bilingualLabelLines(label, bilingualStrategy);
  const warnings: PrintWarning[] = [];
  let multiplier: 1 | 2 = requestedMultiplier;
  let available = styleColumns;
  const longestVariant = Math.max(0, ...variants.map(displayWidth));

  if (requestedMultiplier === 2 && longestVariant > styleColumns && longestVariant <= columns) {
    multiplier = 1;
    available = columns;
    warnings.push(warningFor(unit, 'Double-width style was downgraded so the complete text remains printable.'));
  } else if (requestedMultiplier === 2 && longestVariant > styleColumns) {
    multiplier = 1;
    available = columns;
    warnings.push(warningFor(unit, 'Double-width style was downgraded and the complete text was wrapped.'));
  }

  const lines = variants.flatMap((variant) => wrapToDisplayCells(variant, available));
  if (lines.length > variants.length) {
    warnings.push(warningFor(unit, 'Text was wrapped to the printer width without truncation.'));
  }
  return Object.freeze({ lines: Object.freeze(lines), widthMultiplier: multiplier, warnings: Object.freeze(warnings) });
}

/** Width-only invariant used by the ESC/POS safety layer after semantic layout. */
export function thermalDisplayWidth(text: string): number {
  return displayWidth(String(text));
}
