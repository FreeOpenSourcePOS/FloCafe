/**
 * unicode.ts
 *
 * Fallback map for Unicode currency symbols on ESC/POS thermal printers.
 *
 * ESC/POS thermal printers render bytes against a fixed code page
 * (typically CP437 / CP850 / CP1252), none of which contain modern
 * currency symbols like ₹ (U+20B9, added to Unicode in 2010). When the
 * printer firmware cannot render a symbol, the 2–3 UTF-8 bytes that
 * encode it print as garbage glyphs.
 *
 * When the user marks their printer as *not* Unicode-capable, we replace
 * these symbols with an ASCII equivalent before handing bytes to the
 * printer.
 */

// Currency fallbacks are kept to two or three ASCII characters so receipt
// amount columns remain bounded for common symbols and ISO-style tokens.
export const CURRENCY_ASCII_MAP: Record<string, string> = {
  '₹': 'Rs', // Indian Rupee
  '₨': 'Rs', // Rupee sign
  '€': 'Eu',
  '£': 'Pd',
  '¥': 'Yn',
  '₩': 'Kw',
  '₺': 'Tl',
  '₫': 'Vd',
  '₪': 'Ns',
  '₽': 'Rb',
  '฿': 'Bh',
  '₱': 'Ph',
  '₴': 'Uh',
  '₦': 'Ng',
  '₵': 'Gh',
  '₡': 'Cr',
  '₲': 'Pg',
};

const THERMAL_LATIN_ASCII_MAP: Record<string, string> = {
  'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss',
  'Æ': 'AE', 'Ø': 'O', 'Ð': 'D', 'Þ': 'Th', 'Ł': 'L', 'Œ': 'OE',
  'æ': 'ae', 'ø': 'o', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'œ': 'oe',
};
const THERMAL_CURRENCY_TOKENS = Object.keys(CURRENCY_ASCII_MAP).sort((a, b) => b.length - a.length);

export function normalizeThermalText(text: string): string | null {
  let normalized = '';
  for (let index = 0; index < text.length;) {
    const currencyToken = THERMAL_CURRENCY_TOKENS.find((token) => text.startsWith(token, index));
    if (currencyToken) {
      normalized += currencyToken;
      index += currencyToken.length;
      continue;
    }
    const character = String.fromCodePoint(text.codePointAt(index)!);
    index += character.length;
    if (/^[\x00-\x7F]$/.test(character)) {
      normalized += character;
      continue;
    }
    const mapped = THERMAL_LATIN_ASCII_MAP[character];
    if (mapped) {
      normalized += mapped;
      continue;
    }
    if (CURRENCY_ASCII_MAP[character]) {
      normalized += character;
      continue;
    }
    const decomposed = character.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
    if (/^[\x00-\x7F]$/.test(decomposed)) {
      normalized += decomposed;
      continue;
    }
    return null;
  }
  return normalized;
}

export function normalizeCurrencyToAscii(text: string): string {
  let out = text;
  for (const [sym, ascii] of Object.entries(CURRENCY_ASCII_MAP)) {
    if (out.includes(sym)) out = out.split(sym).join(ascii);
  }
  return out;
}

/**
 * Pads a resolved currency symbol to a fixed 2-character slot when it is
 * shorter than two characters. Three-character fallbacks such as IRR remain
 * unchanged.
 */
export function padCurrencyPrefix(prefix: string): string {
  return prefix.length >= 2 ? prefix : ' '.repeat(2 - prefix.length) + prefix;
}
