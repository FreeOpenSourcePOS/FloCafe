/** Canonical configured thermal layout widths shared by every renderer. */

const COMBINING_MARK_RE = /\p{Mark}/u;
const GRAPHEME_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('und', { granularity: 'grapheme' })
  : null;
const THAI_SARA_AM_CODE_POINT = 0x0e33;
const INDIC_VIRAMA_CODE_POINTS = new Set([0x094d, 0x09cd]);
const EMOJI_BASE_RE = /\p{Extended_Pictographic}/u;

export type PrintPaperWidth =
  | '58mm'
  | '58mm-36'
  | '80mm-42'
  | '80mm'
  | `cols-${32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48}`;

export type ReceiptPaperSize = 58 | 80;

function codePointBefore(value: string): number | undefined {
  if (!value) return undefined;
  const last = value.charCodeAt(value.length - 1);
  if (last >= 0xdc00 && last <= 0xdfff && value.length >= 2) {
    return value.codePointAt(value.length - 2);
  }
  return last;
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function trailingRegionalIndicatorCount(value: string): number {
  let count = 0;
  for (const character of Array.from(value).reverse()) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isRegionalIndicator(codePoint)) break;
    count += 1;
  }
  return count;
}

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
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || COMBINING_MARK_RE.test(String.fromCodePoint(codePoint));
}

function fallbackGraphemeSegments(value: string): string[] {
  const segments: string[] = [];
  let current = '';
  let pendingIndicConjunct = false;
  for (const character of Array.from(value)) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isMark = COMBINING_MARK_RE.test(character);
    const isVirama = INDIC_VIRAMA_CODE_POINTS.has(codePoint);
    const isJoiner = codePoint === 0x200d;
    const isVariationSelector = (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
      || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
    const isThaiSaraAm = codePoint === THAI_SARA_AM_CODE_POINT;
    const previousCodePoint = current ? codePointBefore(current) : undefined;
    const continuesCurrent = !current
      || isMark
      || isVirama
      || isJoiner
      || isVariationSelector
      || isThaiSaraAm
      || (isRegionalIndicator(codePoint) && trailingRegionalIndicatorCount(current) % 2 === 1)
      || (isEmojiModifier(codePoint) && previousCodePoint !== undefined
        && EMOJI_BASE_RE.test(String.fromCodePoint(previousCodePoint)))
      || (EMOJI_BASE_RE.test(character) && previousCodePoint !== undefined
        && isEmojiModifier(previousCodePoint))
      || current.endsWith('\u200d')
      || pendingIndicConjunct;

    if (continuesCurrent) {
      current += character;
      pendingIndicConjunct = isVirama || (pendingIndicConjunct && (isJoiner || isMark));
    } else {
      segments.push(current);
      current = character;
      pendingIndicConjunct = isVirama;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** Keep script clusters together when the runtime supports Unicode segmentation. */
export function graphemeSegments(text: string): string[] {
  const value = String(text ?? '');
  if (GRAPHEME_SEGMENTER) return Array.from(GRAPHEME_SEGMENTER.segment(value), (part) => part.segment);
  return fallbackGraphemeSegments(value);
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

function graphemeDisplayWidth(grapheme: string): number {
  let hasVisibleCharacter = false;
  let hasFullWidthCharacter = false;
  for (const character of Array.from(grapheme)) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(codePoint)) continue;
    hasVisibleCharacter = true;
    hasFullWidthCharacter ||= isFullWidthCodePoint(codePoint);
  }
  return hasVisibleCharacter ? (hasFullWidthCharacter ? 2 : 1) : 0;
}

/** Measure text in monospaced thermal-printer display cells. */
export function displayCellWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemeSegments(text)) width += graphemeDisplayWidth(grapheme);
  return width;
}

/** Pad text to a display-cell budget without splitting grapheme clusters. */
export function padToDisplayCells(
  text: string,
  columns: number,
  alignment: 'left' | 'right' | 'center' = 'left',
): string {
  const value = String(text ?? '');
  const target = Math.max(0, Math.floor(columns));
  const padding = Math.max(0, target - displayCellWidth(value));
  if (alignment === 'right') return ' '.repeat(padding) + value;
  if (alignment === 'center') {
    const left = Math.floor(padding / 2);
    return ' '.repeat(left) + value + ' '.repeat(padding - left);
  }
  return value + ' '.repeat(padding);
}

/** Keep complete grapheme clusters that fit in a thermal display-cell budget. */
export function truncateToDisplayCells(text: string, columns: number): string {
  const maxColumns = Math.max(0, Math.floor(columns));
  let width = 0;
  let result = '';
  for (const grapheme of graphemeSegments(text)) {
    const graphemeWidth = displayCellWidth(grapheme);
    if (graphemeWidth > 0 && width + graphemeWidth > maxColumns) break;
    result += grapheme;
    width += graphemeWidth;
  }
  return result;
}

/** Keep the suffix that fits in a thermal display-cell budget. */
export function truncateToDisplayCellsFromEnd(text: string, columns: number): string {
  const maxColumns = Math.max(0, Math.floor(columns));
  let width = 0;
  let result = '';
  for (const grapheme of graphemeSegments(text).reverse()) {
    const graphemeWidth = displayCellWidth(grapheme);
    if (graphemeWidth > 0 && width + graphemeWidth > maxColumns) break;
    result = grapheme + result;
    width += graphemeWidth;
  }
  return result;
}

/** Wrap whitespace-delimited text without exceeding a thermal display-cell budget. */
export function wrapToDisplayCells(text: string, columns: number): string[] {
  const maxColumns = Math.max(1, Math.floor(columns));
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (displayCellWidth(word) > maxColumns) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (const grapheme of graphemeSegments(word)) {
        if (current && displayCellWidth(current + grapheme) > maxColumns) {
          lines.push(current);
          current = '';
        }
        current += grapheme;
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (displayCellWidth(candidate) <= maxColumns) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }

  if (current || lines.length === 0) lines.push(current);
  return lines;
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
