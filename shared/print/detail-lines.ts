/** Ready-formatted lines an order item prints under its heading, before add-ons. */
import { displayCellWidth, wrapToDisplayCells } from './width';

/** Indent of every detail-line row, on tickets and receipts. */
export const DETAIL_LINE_INDENT = '   ';

/** Text without C0 control bytes and DEL, so nothing typed or imported can command a printer. */
export const stripControlBytes = (text: string): string => text.replace(/[\x00-\x1F\x7F]/g, '');

/** The `detailLines` a raw order item carries: its non-blank strings, in order. */
export function readDetailLines(item: unknown): string[] {
  const lines = (item as { detailLines?: unknown } | null | undefined)?.detailLines;
  return Array.isArray(lines)
    ? lines
        .filter((line): line is string => typeof line === 'string')
        .map(stripControlBytes)
        .filter((line) => line.trim().length > 0)
    : [];
}

/**
 * Printed rows for one detail line. A line that fits the columns left after
 * the indent keeps its text exactly, runs of spaces included; a longer line is
 * wrapped on whitespace, and no text is dropped.
 */
export function detailLineRows(text: string, columns: number): string[] {
  const available = Math.max(1, columns - DETAIL_LINE_INDENT.length);
  const fitted = displayCellWidth(text) <= available ? [text] : wrapToDisplayCells(text, available);
  return fitted.map((row) => DETAIL_LINE_INDENT + row);
}
