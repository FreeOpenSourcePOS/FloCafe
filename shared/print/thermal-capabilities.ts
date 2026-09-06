import { CURRENCY_TOKEN_PATTERN } from './currency';

/**
 * Capability policy shared by the backend ESC/POS and WebUSB encoders.
 * Raster support is additive and remains profile-owned; locale never enables it.
 */

export type ThermalCodePage = 'ascii' | 'cp437' | 'cp850' | 'cp858' | 'windows1252';
export type ThermalScript = 'ascii' | 'latin' | 'arabic';
export type UnsupportedTextPolicy = 'skip';
export type FinancialTextPolicy = 'refuse';
export type OrderTypeFallbackPolicy = 'ascii';
export type ThermalRasterMode = 'mixed' | 'whole-receipt';

export interface ThermalRasterCapabilities {
  /** False unless this exact profile has been validated on real hardware. */
  readonly enabled: boolean;
  /** Printable head width in dots, supplied by the profile, not locale. */
  readonly widthDots: number;
  /** Maximum rows in one GS v 0 command. */
  readonly maxBandHeight: number;
  readonly modes: readonly ThermalRasterMode[];
  readonly font?: { readonly family: string; readonly dataUrl: string };
}

export interface ThermalPrinterCapabilities {
  encoding: {
    codePages: readonly ThermalCodePage[];
    preferredCodePage: ThermalCodePage;
  };
  shaping: {
    arabic: boolean;
  };
  representability: {
    scripts: readonly ThermalScript[];
  };
  transliteration: {
    enabled: boolean;
  };
  warnings: {
    unsupportedText: UnsupportedTextPolicy;
    financialText: FinancialTextPolicy;
    orderTypeFallback: OrderTypeFallbackPolicy;
  };
  /** Additive raster contract; disabled for all unverified shipped profiles. */
  readonly raster: ThermalRasterCapabilities;
}

export const GENERIC_THERMAL_CAPABILITIES: ThermalPrinterCapabilities = {
  encoding: { codePages: ['ascii'], preferredCodePage: 'ascii' },
  shaping: { arabic: false },
  representability: { scripts: ['ascii'] },
  transliteration: { enabled: true },
  warnings: { unsupportedText: 'skip', financialText: 'refuse', orderTypeFallback: 'ascii' },
  raster: { enabled: false, widthDots: 0, maxBandHeight: 0, modes: [] },
};

export const LATIN_THERMAL_CAPABILITIES: ThermalPrinterCapabilities = {
  ...GENERIC_THERMAL_CAPABILITIES,
  encoding: { codePages: ['cp437', 'cp850', 'cp858', 'windows1252', 'ascii'], preferredCodePage: 'cp437' },
  representability: { scripts: ['ascii', 'latin'] },
  transliteration: { enabled: true },
};

// The shipped fallback preserves the established German thermal transliteration
// without claiming quality coverage for every accented locale.
const LATIN_ASCII_MAP: Record<string, string> = {
  Ä: 'AE', Ö: 'OE', Ü: 'UE', ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
};

const CODE_PAGE_CHARACTERS: Record<Exclude<ThermalCodePage, 'ascii'>, string> = {
  cp437: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
  cp850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ',
  cp858: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ',
  windows1252: '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜š›œžŸÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ',
};

const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_SCRIPT_GLOBAL_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const SHAPING_ALLOWED_GLOBAL_RE = /[\u200C\u200D\u200F\u2026]/g;
const THERMAL_CURRENCY_TOKEN_RE = new RegExp(`(?:${CURRENCY_TOKEN_PATTERN})`, 'g');
const LATIN_LETTER_RE = /\p{Script=Latin}/u;
const LETTER_RE = /\p{Letter}/u;

function codePageCanRepresent(text: string, codePage: ThermalCodePage): boolean {
  if (codePage === 'ascii') return !/[^\x00-\x7F]/.test(text);
  const characters = CODE_PAGE_CHARACTERS[codePage];
  return [...text].every((character) => character <= '\x7F' || characters.includes(character));
}

export function normalizeThermalText(text: string, capabilities: ThermalPrinterCapabilities): string {
  if (!capabilities.transliteration.enabled) return text;
  if (capabilities.representability.scripts.includes('latin')) {
    const hasNativeCodePage = capabilities.encoding.codePages.some(
      (codePage) => codePage !== 'ascii' && codePageCanRepresent(text, codePage),
    );
    if (hasNativeCodePage) return text;
  }
  return text.replace(/[À-ÿ]/g, (character) => LATIN_ASCII_MAP[character] ?? character);
}

export function hasArabicScript(text: string): boolean {
  return ARABIC_SCRIPT_RE.test(text);
}

export function isArabicShapingSafeLine(text: string): boolean {
  if (!hasArabicScript(text)) return false;
  const textWithoutCurrency = text.replace(THERMAL_CURRENCY_TOKEN_RE, '');
  return !/[^\x00-\x7F]/.test(
    textWithoutCurrency.replace(ARABIC_SCRIPT_GLOBAL_RE, '').replace(SHAPING_ALLOWED_GLOBAL_RE, ''),
  );
}

export function selectThermalCodePage(text: string, capabilities: ThermalPrinterCapabilities): ThermalCodePage | null {
  const normalized = normalizeThermalText(text, capabilities);
  for (const codePage of capabilities.encoding.codePages) {
    if (codePageCanRepresent(normalized, codePage)) return codePage;
  }
  return null;
}

export function isThermalTextRepresentable(text: string, capabilities: ThermalPrinterCapabilities): boolean {
  const normalized = normalizeThermalText(text, capabilities);
  if (capabilities.shaping.arabic && isArabicShapingSafeLine(normalized)) return true;
  if (hasArabicScript(normalized)) return false;
  if (
    capabilities.representability.scripts.includes('latin')
    && [...normalized].some((character) => LETTER_RE.test(character) && !LATIN_LETTER_RE.test(character))
  ) {
    return false;
  }
  return selectThermalCodePage(normalized, capabilities) !== null
    && capabilities.representability.scripts.includes('ascii')
    && (!/[^\x00-\x7F]/.test(normalized) || capabilities.representability.scripts.includes('latin'));
}

export function thermalTextFallback(value: string, fallback: string, capabilities: ThermalPrinterCapabilities): string {
  const normalized = normalizeThermalText(value, capabilities);
  return isThermalTextRepresentable(normalized, capabilities) ? normalized : fallback;
}

export function shouldUseOrderTypeFallback(localizedText: string, capabilities: ThermalPrinterCapabilities): boolean {
  if (capabilities.warnings.orderTypeFallback !== 'ascii') return false;
  const nativeCapabilities = capabilities.transliteration.enabled
    ? { ...capabilities, transliteration: { enabled: false } }
    : capabilities;
  return !isThermalTextRepresentable(localizedText, nativeCapabilities);
}

export function escPosCodePageId(codePage: ThermalCodePage): number {
  // ESC/POS values are the Epson-compatible IDs used by the shipped profiles.
  return { ascii: 0, cp437: 0, cp850: 2, cp858: 19, windows1252: 16 }[codePage];
}

export function mergeThermalCapabilities(
  capabilities: ThermalPrinterCapabilities | undefined,
  arabicShapingOverride?: boolean,
): ThermalPrinterCapabilities {
  const base = capabilities ?? GENERIC_THERMAL_CAPABILITIES;
  if (typeof arabicShapingOverride !== 'boolean') return base;
  return { ...base, shaping: { ...base.shaping, arabic: arabicShapingOverride } };
}
