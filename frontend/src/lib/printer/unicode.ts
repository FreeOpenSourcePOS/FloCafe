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

const GERMAN_THERMAL_ASCII_MAP: Record<string, string> = {
  'Ä': 'AE', 'Ö': 'OE', 'Ü': 'UE', 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss',
};

export function normalizeGermanThermalText(text: string): string {
  return text.replace(/[ÄÖÜäöüß]/g, (character) => GERMAN_THERMAL_ASCII_MAP[character]);
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
