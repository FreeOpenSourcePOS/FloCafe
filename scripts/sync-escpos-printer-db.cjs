'use strict';

// Trims receipt-print-hq/escpos-printer-db capabilities.json into the fallback
// snapshot main/printers/escpos-printer-db.json. Run: node scripts/sync-escpos-printer-db.cjs [local.json]

const fs = require('node:fs');
const path = require('node:path');
const CodepageEncoder = require('@point-of-sale/codepage-encoder');

const SOURCE =
  'https://raw.githubusercontent.com/receipt-print-hq/escpos-printer-db/master/dist/capabilities.json';
const OUT = path.join(__dirname, '../main/printers/escpos-printer-db.json');
// Catch-all vendor profiles; real models are what the fallback lookup wants.
const SKIP_IDS = new Set(['default', 'safe', 'simple']);
// ESC t numbers FloCafe sends per page (shared/print/thermal-capabilities.ts).
// A DB page is only usable when the printer's own index matches our number.
const CODE_PAGE_IDS = { cp437: 0, cp850: 2, windows1252: 16, cp858: 19 };
const MIN_FONT_A_COLUMNS = 24;

function encoderName(raw) {
  const name = String(raw || '').trim();
  const upper = name.toUpperCase();
  let candidate = name.toLowerCase();
  const cp125x = upper.match(/^CP125(\d)$/);
  const cp = upper.match(/^CP(\d+)$/);
  const iso = upper.match(/^ISO[_-]8859[_-](\d+)$/);
  if (cp125x) candidate = `windows125${cp125x[1]}`;
  else if (cp) candidate = `cp${cp[1]}`;
  else if (iso) candidate = `iso8859-${iso[1]}`;
  else if (upper === 'TCVN-3-1' || upper === 'TCVN-3-2') candidate = 'tcvn3';
  else if (upper === 'KATAKANA') candidate = 'katakana';
  return CodepageEncoder.supports(candidate) ? candidate : null;
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function fontColumns(profile, needle) {
  for (const font of Object.values(profile.fonts || {})) {
    if (String(font?.name || '').toLowerCase() === needle) return numeric(font.columns);
  }
  return undefined;
}

function trimProfile(profile) {
  const features = profile.features || {};
  const media = profile.media || {};
  const width = media.width || {};
  const codePages = {};
  for (const [index, raw] of Object.entries(profile.codePages || {})) {
    const name = encoderName(raw);
    if (name && CODE_PAGE_IDS[name] === Number(index)) codePages[index] = name;
  }
  const fontB = fontColumns(profile, 'font b');
  const kept = {
    name: String(profile.name || ''),
    vendor: String(profile.vendor || ''),
    columns: { fontA: fontColumns(profile, 'font a'), fontB },
    media: {
      widthMm: numeric(width.mm),
      dpi: numeric(media.dpi),
      widthPixels: numeric(width.pixels),
    },
    codePages,
    features: {
      bitImageRaster: features.bitImageRaster === true,
      qrCode: features.qrCode === true,
      paperFullCut: features.paperFullCut === true,
      paperPartCut: features.paperPartCut === true,
    },
  };
  return JSON.parse(JSON.stringify(kept));
}

async function load(localPath) {
  if (localPath) return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function main() {
  const db = await load(process.argv[2]);
  const profiles = {};
  const dropped = { starCommands: 0, catchAll: 0, noColumns: 0, notAPrinter: 0 };

  for (const [id, profile] of Object.entries(db.profiles || {})) {
    if (SKIP_IDS.has(id)) {
      dropped.catchAll += 1;
      continue;
    }
    if (profile?.features?.starCommands === true) {
      dropped.starCommands += 1;
      continue;
    }
    const trimmed = trimProfile(profile);
    if (!trimmed.columns.fontA) {
      dropped.noColumns += 1;
      continue;
    }
    if (/display/i.test(trimmed.name) || trimmed.columns.fontA < MIN_FONT_A_COLUMNS) {
      dropped.notAPrinter += 1;
      continue;
    }
    profiles[id] = trimmed;
  }

  const snapshot = {
    source: SOURCE,
    license: 'CC-BY-4.0',
    attribution:
      'Printer capability data derived from escpos-printer-db by Michael Billington and contributors (https://github.com/receipt-print-hq/escpos-printer-db), licensed CC-BY-4.0.',
    snapshotDate: new Date().toISOString().slice(0, 10),
    profiles,
  };

  fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 1)}\n`, 'utf8');
  console.log(
    `kept ${Object.keys(profiles).length}, dropped ${dropped.starCommands} Star, ${dropped.catchAll} catch-all, ${dropped.noColumns} without Font A, ${dropped.notAPrinter} non-printer -> ${path.relative(process.cwd(), OUT)}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
