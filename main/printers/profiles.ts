import {
  GENERIC_THERMAL_CAPABILITIES,
  mergeThermalCapabilities,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';

export type PrinterCommandSet = 'escpos';
export type PrinterCutMode = 'full' | 'partial';

export interface SupportedPrinterProfile {
  id: string;
  make: string;
  model: string;
  aliases: string[];
  commandSet: PrinterCommandSet;
  defaultPaperWidth: 'cols-32' | 'cols-36' | 'cols-40' | 'cols-42' | 'cols-44' | 'cols-48' | '58mm' | '58mm-36' | '80mm-42' | '80mm';
  defaultPort: number;
  fontAColumns: number;
  fontBColumns: number;
  printWidthMm?: number;
  cutMode: PrinterCutMode;
  /**
   * Whether the printer's firmware performs Arabic/Persian contextual shaping
   * and bidirectional ordering. Generic ESC/POS printers do NOT — they render
   * isolated glyph forms or garbage for Persian — so this defaults to unset
   * (false), which makes the encoders skip Arabic-script text instead of
   * printing corrupted output. Only set true after a real print on the
   * specific hardware proves shaped Persian output.
   */
  /** @deprecated Use capabilities.shaping.arabic. Kept for stored profile compatibility. */
  arabicShaping?: boolean;
  /** Text encoding, shaping, representability, transliteration, and warning policy. */
  capabilities: ThermalPrinterCapabilities;
  notes?: string;
}

export const SUPPORTED_PRINTER_PROFILES: SupportedPrinterProfile[] = [
  {
    id: 'xprinter-xp-v320m-v330m',
    make: 'Xprinter',
    model: 'XP-V320M / XP-V330M',
    aliases: ['xprinter xp-v320m', 'xprinter xp-v330m', 'xp-v320m', 'xp-v330m', 'v320m', 'v330m'],
    commandSet: 'escpos',
    defaultPaperWidth: 'cols-42',
    defaultPort: 9100,
    fontAColumns: 42,
    fontBColumns: 64,
    printWidthMm: 72,
    cutMode: 'partial',
    capabilities: GENERIC_THERMAL_CAPABILITIES,
    notes: '80mm ESC/POS receipt printer. Vendor specs list 72mm print width, 576 dots/line, Font A 42/48 columns, Font B 56/64 columns.',
  },
  {
    id: 'epson-tm-series',
    make: 'Epson',
    model: 'TM Series ESC/POS',
    aliases: ['epson tm', 'tm-t88', 'tm-t82', 'tm-t20', 'tm-m30'],
    commandSet: 'escpos',
    defaultPaperWidth: 'cols-48',
    defaultPort: 9100,
    fontAColumns: 48,
    fontBColumns: 64,
    cutMode: 'partial',
    capabilities: GENERIC_THERMAL_CAPABILITIES,
  },
  {
    id: 'generic-escpos-80',
    make: 'Generic',
    model: 'ESC/POS 80mm',
    aliases: ['generic 80mm', '80mm thermal', 'thermal 80'],
    commandSet: 'escpos',
    defaultPaperWidth: 'cols-42',
    defaultPort: 9100,
    fontAColumns: 42,
    fontBColumns: 64,
    cutMode: 'full',
    capabilities: {
      ...GENERIC_THERMAL_CAPABILITIES,
      encoding: { codePages: ['ascii'], preferredCodePage: 'ascii' },
    },
  },
  {
    id: 'generic-escpos-58',
    make: 'Generic',
    model: 'ESC/POS 58mm',
    aliases: ['generic 58mm', '58mm thermal', 'thermal 58'],
    commandSet: 'escpos',
    defaultPaperWidth: 'cols-32',
    defaultPort: 9100,
    fontAColumns: 32,
    fontBColumns: 56,
    cutMode: 'full',
    capabilities: {
      ...GENERIC_THERMAL_CAPABILITIES,
      encoding: { codePages: ['ascii'], preferredCodePage: 'ascii' },
    },
  },
];

export function getSupportedPrinterProfiles(): SupportedPrinterProfile[] {
  return SUPPORTED_PRINTER_PROFILES;
}

export function matchSupportedPrinterProfile(...parts: Array<string | null | undefined>): SupportedPrinterProfile | null {
  const haystack = parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_]+/g, '-');

  if (!haystack) return null;

  for (const profile of SUPPORTED_PRINTER_PROFILES) {
    const tokens = [`${profile.make} ${profile.model}`, profile.model, ...profile.aliases].map((s) => s.toLowerCase());
    if (tokens.some((token) => haystack.includes(token))) return profile;
  }

  return null;
}

export function resolvePrinterProfile(printer: any): SupportedPrinterProfile {
  const explicit = printer?.profile_id || printer?.profileId;
  if (explicit) {
    const profile = SUPPORTED_PRINTER_PROFILES.find((p) => p.id === explicit);
    if (profile) return profile;
  }

  const matched = matchSupportedPrinterProfile(printer?.name, printer?.make, printer?.model);
  if (matched) return matched;

  const paperWidth = printer?.paper_width || printer?.paperWidth;
  return String(paperWidth || '').startsWith('58mm')
    ? SUPPORTED_PRINTER_PROFILES.find((p) => p.id === 'generic-escpos-58')!
    : SUPPORTED_PRINTER_PROFILES.find((p) => p.id === 'generic-escpos-80')!;
}

export function getPrinterCapabilities(
  profile: SupportedPrinterProfile,
  arabicShapingOverride?: boolean,
): ThermalPrinterCapabilities {
  return mergeThermalCapabilities(profile.capabilities || GENERIC_THERMAL_CAPABILITIES, arabicShapingOverride);
}
