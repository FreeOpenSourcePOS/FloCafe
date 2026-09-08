/** Canonical configured thermal layout widths shared by every renderer. */

export type PrintPaperWidth =
  | '58mm'
  | '58mm-36'
  | '80mm-42'
  | '80mm'
  | `cols-${32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48}`;

export type ReceiptPaperSize = 58 | 80;

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
  return Array.from(String(text)).slice(0, maxColumns).join('');
}
