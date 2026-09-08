/** Canonical configured thermal layout widths shared by every renderer. */

export type PrintPaperWidth =
  | '58mm'
  | '58mm-36'
  | '80mm-42'
  | '80mm'
  | `cols-${32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48}`;

export type ReceiptPaperSize = 58 | 80;

function isZeroWidthCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0x300 && codePoint <= 0x36f)
    || (codePoint >= 0x610 && codePoint <= 0x61a)
    || (codePoint >= 0x64b && codePoint <= 0x65f)
    || codePoint === 0x670
    || (codePoint >= 0x6d6 && codePoint <= 0x6ed)
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2060 && codePoint <= 0x206f)
    || codePoint === 0xfeff
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1f64f)
    || (codePoint >= 0x1f900 && codePoint <= 0x1f9ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Measure text in monospaced thermal-printer display cells. */
export function displayCellWidth(text: string): number {
  let width = 0;
  for (const character of Array.from(String(text))) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(codePoint)) continue;
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/** Keep complete code points that fit in a thermal display-cell budget. */
export function truncateToDisplayCells(text: string, columns: number): string {
  const maxColumns = Math.max(0, Math.floor(columns));
  let width = 0;
  let result = '';
  for (const character of Array.from(String(text))) {
    const characterWidth = displayCellWidth(character);
    if (characterWidth > 0 && width + characterWidth > maxColumns) break;
    result += character;
    width += characterWidth;
  }
  return result;
}

/** Resolve the configured logical columns used by browser/WebUSB receipt settings. */
export function columnsForReceiptPaperSize(paperWidth: ReceiptPaperSize): number {
  return paperWidth === 58 ? 32 : 48;
}

/** Resolve configured text columns independently of physical printer capability. */
export function columnsForPaperWidth(paperWidth: string | null | undefined): number | null {
  const colsMatch = String(paperWidth || '').match(/^cols-(3[2-9]|4[0-8])$/);
  if (colsMatch) return Number(colsMatch[1]);

  switch (paperWidth) {
    case '58mm':
      return 32;
    case '58mm-36':
      return 36;
    case '80mm-42':
      return 42;
    case '80mm':
      return null;
    default:
      return null;
  }
}

/** Keep a native ESC/POS text line inside its logical character budget. */
export function fitThermalLine(text: string, columns: number, doubleWidth = false): string {
  const maxColumns = Math.max(1, doubleWidth ? Math.floor(columns / 2) : columns);
  return truncateToDisplayCells(text, maxColumns);
}
