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

// Every ASCII fallback is exactly 2 characters, so the currency slot in a
// monospace receipt line is always 2 columns wide, unicode or not.
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
  'Kč': 'Kc', // Czech Koruna
};

export function normalizeCurrencyToAscii(text: string): string {
  let out = text;
  for (const [sym, ascii] of Object.entries(CURRENCY_ASCII_MAP)) {
    if (out.includes(sym)) out = out.split(sym).join(ascii);
  }
  return out;
}

/**
 * Pads a resolved currency symbol to a fixed 2-character slot so amount
 * columns line up whether the symbol is 1 or 2 characters wide, and keeps
 * the Czech receipt currency ASCII even when Unicode printing is enabled.
 */
export function padCurrencyPrefix(prefix: string): string {
  const normalized = prefix.replaceAll('Kč', 'Kc');
  return normalized.length >= 2 ? normalized : ' '.repeat(2 - normalized.length) + normalized;
}
