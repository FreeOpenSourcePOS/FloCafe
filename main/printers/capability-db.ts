import CodepageEncoder from '@point-of-sale/codepage-encoder';
import {
  GENERIC_THERMAL_CAPABILITIES,
  LATIN_THERMAL_CAPABILITIES,
  type ThermalCodePage,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';
import type { PrinterCutMode, SupportedPrinterProfile } from './profiles';
import snapshot from './escpos-printer-db.json';

interface DbProfile {
  name: string;
  vendor: string;
  columns: { fontA?: number; fontB?: number };
  media: { widthMm?: number; dpi?: number; widthPixels?: number };
  /** `ESC t` number the printer uses -> our code page name. */
  codePages: Record<string, string>;
  features: {
    bitImageRaster: boolean;
    qrCode: boolean;
    paperFullCut: boolean;
    paperPartCut: boolean;
  };
}

/** Code pages FloCafe can actually emit; the snapshot may list more. */
const EMITTABLE_CODE_PAGES: readonly ThermalCodePage[] = ['cp437', 'cp850', 'cp858', 'windows1252'];
const PAPER_WIDTHS: readonly SupportedPrinterProfile['defaultPaperWidth'][] = [
  'cols-32',
  'cols-36',
  'cols-40',
  'cols-42',
  'cols-44',
  'cols-48',
];

const DB_PROFILES = snapshot.profiles as Record<string, DbProfile>;

function codepageList(profile: DbProfile): ThermalCodePage[] {
  const pages = Object.keys(profile.codePages)
    .sort((a, b) => Number(a) - Number(b))
    .map((index) => profile.codePages[index])
    .filter((page): page is ThermalCodePage =>
      (EMITTABLE_CODE_PAGES as readonly string[]).includes(page),
    );
  return pages.length > 0 ? pages : ['ascii'];
}

function columnsToPaperWidth(columns: number): SupportedPrinterProfile['defaultPaperWidth'] {
  const exact = `cols-${columns}` as SupportedPrinterProfile['defaultPaperWidth'];
  if (PAPER_WIDTHS.includes(exact)) return exact;
  return columns <= 32 ? 'cols-32' : columns <= 42 ? 'cols-42' : 'cols-48';
}

function toCapabilities(profile: DbProfile): ThermalPrinterCapabilities {
  const codePages = codepageList(profile);
  const base = codePages[0] === 'ascii' ? GENERIC_THERMAL_CAPABILITIES : LATIN_THERMAL_CAPABILITIES;
  return {
    ...base,
    encoding: { codePages, preferredCodePage: codePages[0] },
    raster:
      profile.features.bitImageRaster && (profile.media.widthPixels ?? 0) > 0
        ? {
            enabled: true,
            widthDots: profile.media.widthPixels as number,
            maxBandHeight: 200,
            modes: ['mixed', 'whole-receipt'],
          }
        : { ...GENERIC_THERMAL_CAPABILITIES.raster },
  };
}

function toSupportedProfile(id: string, profile: DbProfile): SupportedPrinterProfile {
  const fontA = profile.columns.fontA ?? 42;
  const cutMode: PrinterCutMode = profile.features.paperPartCut ? 'partial' : 'full';
  return {
    id: `escpos-db-${id.toLowerCase()}`,
    make: profile.vendor,
    model: profile.name,
    aliases: [profile.name.toLowerCase(), id.toLowerCase()],
    commandSet: 'escpos',
    defaultPaperWidth: columnsToPaperWidth(fontA),
    defaultPort: 9100,
    fontAColumns: fontA,
    fontBColumns: profile.columns.fontB ?? fontA,
    ...(profile.media.widthMm !== undefined ? { printWidthMm: profile.media.widthMm } : {}),
    cutMode,
    capabilities: toCapabilities(profile),
  };
}

/** Separators are dropped so `XP-58`, `xp58`, and `Xprinter XP-58IIH` normalize alike. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const MATCH_TOKENS: Array<{ token: string; id: string }> = Object.entries(DB_PROFILES)
  .flatMap(([id, profile]) =>
    [id, profile.name, `${profile.vendor} ${profile.name}`].map((candidate) => ({
      token: normalize(candidate),
      id,
    })),
  )
  .filter(({ token }) => token.length >= 4)
  .sort((a, b) => b.token.length - a.token.length);

/** Conservative fallback lookup: a real DB model or nothing. */
export function findDbProfile(text: string | null | undefined): SupportedPrinterProfile | null {
  const haystack = normalize(String(text ?? ''));
  if (!haystack) return null;
  const hit = MATCH_TOKENS.find(({ token }) => haystack.includes(token));
  return hit ? toSupportedProfile(hit.id, DB_PROFILES[hit.id]) : null;
}

/** Snapshot code pages for the sync test; every entry must be encoder-supported. */
export function listDbCodePages(): string[] {
  return [
    ...new Set(Object.values(DB_PROFILES).flatMap((profile) => Object.values(profile.codePages))),
  ].sort();
}

export function isEncoderCodePage(name: string): boolean {
  return CodepageEncoder.supports(name);
}
