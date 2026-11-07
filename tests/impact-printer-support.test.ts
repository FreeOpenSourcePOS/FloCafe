/**
 * Impact Printer Support & Capability-Based Printer Onboarding Tests (Issue #1481)
 *
 * Covers:
 * 1. `escpos-impact-76` profile resolution, `epson-tm-series` alias isolation, and `isValidPrinterProfileId`.
 * 2. `normalizeThermalText` fallback Latin transliteration (preserving `LATIN_ASCII_MAP` + extended Latin foldings + NFD diacritic stripping).
 * 3. `GS v 0` logo (`{RAW_BYTES:...}`) and `GS ( k` payment-ticket QR suppression when `raster.enabled: false`.
 * 4. OS printer detection (`getMacOSPrinterDetails`, `detectWindowsMakeModel`) and `classifyDetectedPrinterCompatibility`.
 * 5. Database migration 125 (`add_printer_profile_id`) and `/api/printers` `profile_id` / `configured_profile_id` persistence & validation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-impact-printer-test-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

import {
  GENERIC_THERMAL_CAPABILITIES,
  LATIN_THERMAL_CAPABILITIES,
  normalizeThermalText,
  isThermalTextRepresentable,
} from '../shared/print/thermal-capabilities';
import { pack1BitPixels, type ReceiptLogoData } from '../shared/print/image-raster';
import {
  getSupportedPrinterProfiles,
  matchSupportedPrinterProfile,
  resolvePrinterProfile,
  capabilitiesForPrinter,
  isValidPrinterProfileId,
} from '../main/printers/profiles';
import {
  formatReceipt,
  prepareReceipt,
  rasterizePrintDocumentForWebUsb,
  receiptDocumentLines,
  classifyDetectedPrinterCompatibility,
  detectWindowsMakeModel,
  getMacOSPrinterDetails,
  annotateProfile,
  guessPaperWidth,
  escPosToText,
} from '../main/printers/thermal';
import { buildBillPrintContext, buildBillPrintData } from '../main/printers/document-classic';
import { buildBillDocument } from '../shared/print/document';
import { loadFrontendPrintModules } from './helpers/receipt-column-measure';

const {
  initTestDb,
  createApp,
  startServer,
  api,
  seedOwnerUser,
  closeDatabase,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
} = require('./helpers/test-setup');
const { getDatabase, MIGRATIONS } = require('../main/db');
const { printerRoutes } = require('../main/routes/printers');

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

function createSampleLogoData(): { logoUrl: string; rasterJson: string } {
  const logoUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const w = 16;
  const h = 16;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      pixels[y * w + x] = (x + y) % 2 === 0 ? 1 : 0;
    }
  }
  const packed = pack1BitPixels(pixels, w, h);
  const dataBase64 = uint8ToBase64(packed);
  const rasterObj: ReceiptLogoData = {
    version: 1,
    originalDataUrl: logoUrl,
    variants: {
      '384': { width: w, height: h, dataBase64 },
      '576': { width: w, height: h, dataBase64 },
    },
  };
  return { logoUrl, rasterJson: JSON.stringify(rasterObj) };
}

function containsSubsequence(haystack: Uint8Array | Buffer, needle: number[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

async function run() {
  console.log('--- 1. Printer profile resolution & alias isolation ---');
  const profiles = getSupportedPrinterProfiles();
  const impactIdx = profiles.findIndex((p) => p.id === 'escpos-impact-76');
  const epsonTmIdx = profiles.findIndex((p) => p.id === 'epson-tm-series');
  assertOrThrow(impactIdx >= 0, 'escpos-impact-76 profile should exist');
  assertOrThrow(
    impactIdx < epsonTmIdx,
    'escpos-impact-76 must appear before epson-tm-series in SUPPORTED_PRINTER_PROFILES',
  );

  const impactProfile = profiles[impactIdx];
  assertEqualOrThrow(impactProfile.defaultPaperWidth, 'cols-32', 'impact defaultPaperWidth');
  assertEqualOrThrow(impactProfile.cutMode, 'partial', 'impact cutMode');
  assertEqualOrThrow(impactProfile.fontAColumns, 32, 'impact fontAColumns');
  assertEqualOrThrow(impactProfile.fontBColumns, 40, 'impact fontBColumns');
  assertEqualOrThrow(impactProfile.printWidthMm, 64, 'impact printWidthMm');
  assertEqualOrThrow(impactProfile.capabilities.raster.enabled, false, 'impact raster.enabled');
  assertEqualOrThrow(impactProfile.capabilities.raster.widthDots, 0, 'impact raster.widthDots');
  assertEqualOrThrow(
    JSON.stringify(impactProfile.capabilities.raster.modes),
    JSON.stringify([]),
    'impact raster.modes',
  );

  for (const impactName of [
    'EPSON TM-U220',
    'EPSON TM-U220D',
    'EPSON TM-U230',
    'Bixolon SRP-275III',
    'Xprinter XP-76IIN',
  ]) {
    const resolved = resolvePrinterProfile({ name: impactName });
    assertEqualOrThrow(
      resolved.id,
      'escpos-impact-76',
      `${impactName} should resolve to escpos-impact-76`,
    );
    const caps = capabilitiesForPrinter(resolved, resolved.defaultPaperWidth);
    assertEqualOrThrow(
      caps.raster.enabled,
      false,
      `${impactName} capabilities.raster.enabled must remain false`,
    );
  }

  for (const thermalName of [
    'EPSON TM-T88VI',
    'EPSON TM-T20III',
    'EPSON TM-m30II',
    'EPSON TM Receipt',
    'EPSON TM T88V',
    'EPSON TM-H6000IV',
    'TM-T100',
    'TM Series',
    'TM-H600',
    'Bixolon SRP-350III',
  ]) {
    const resolved = resolvePrinterProfile({ name: thermalName });
    assertEqualOrThrow(
      resolved.id,
      'epson-tm-series',
      `${thermalName} should resolve to epson-tm-series`,
    );
  }

  for (const nonTmName of [
    'EPSON TM-L90',
    'EPSON EcoTank L3250',
    'EPSON WorkForce WF-2830',
    'EPSON Stylus Photo',
    'EPSON L3150',
    'EPSON L4150',
  ]) {
    const matched = matchSupportedPrinterProfile(nonTmName);
    assertEqualOrThrow(
      matched,
      null,
      `${nonTmName} must not match epson-tm-series or any raw ESC/POS profile by alias`,
    );
  }

  const explicitOverride = resolvePrinterProfile({
    name: 'Kitchen Counter 1',
    profile_id: 'escpos-impact-76',
    paper_width: 'cols-42',
  });
  assertEqualOrThrow(
    explicitOverride.id,
    'escpos-impact-76',
    'explicit profile_id must override generic printer name',
  );

  assertEqualOrThrow(isValidPrinterProfileId('escpos-impact-76'), true, 'valid impact profile id');
  assertEqualOrThrow(isValidPrinterProfileId('epson-tm-series'), true, 'valid epson profile id');
  assertEqualOrThrow(isValidPrinterProfileId('unknown-profile'), false, 'invalid profile id');
  assertEqualOrThrow(isValidPrinterProfileId(null), false, 'null profile id');

  console.log('--- 2. normalizeThermalText Latin fallback transliteration ---');
  // Preserve existing LATIN_ASCII_MAP entries byte-identical on ASCII-only printers
  const german = normalizeThermalText(
    'Käsewürstchen Größe Übung Çaj Ëmbëlsirë',
    GENERIC_THERMAL_CAPABILITIES,
  );
  assertEqualOrThrow(
    german,
    'Kaesewuerstchen Groesse UEbung Caj Embelsire',
    'Existing German/Albanian LATIN_ASCII_MAP foldings must remain byte-identical',
  );
  assertEqualOrThrow(
    isThermalTextRepresentable(
      'Käsewürstchen Größe Übung Çaj Ëmbëlsirë',
      GENERIC_THERMAL_CAPABILITIES,
    ),
    true,
    'German/Albanian text should be representable after transliteration',
  );

  // Extended multi-char/stroke/dotless Latin foldings when no single codepage can represent the string
  const extended = normalizeThermalText(
    'Ærø Œuvre Łódź Đắk Þór Ğıdalar İçecek Şeker',
    LATIN_THERMAL_CAPABILITIES,
  );
  assertEqualOrThrow(
    extended,
    'AEro OEuvre Lodz Dak THor Gidalar Icecek Seker',
    'Extended Latin multi-char/stroke/dotless foldings must transliterate to ASCII',
  );
  assertEqualOrThrow(
    isThermalTextRepresentable(extended, LATIN_THERMAL_CAPABILITIES),
    true,
    'Extended Latin text should be representable after transliteration',
  );

  // NFD combining-mark stripping on arbitrary Latin-script characters
  const nfdLatin = normalizeThermalText(
    'Čevapčići Žemľa Rīga Phở Kraków',
    LATIN_THERMAL_CAPABILITIES,
  );
  assertEqualOrThrow(
    nfdLatin,
    'Cevapcici Zemla Riga Pho Krakow',
    'NFD combining-mark stripping should fold accented Latin characters cleanly',
  );
  assertEqualOrThrow(
    isThermalTextRepresentable(nfdLatin, LATIN_THERMAL_CAPABILITIES),
    true,
    'NFD Latin text should be representable after transliteration',
  );

  // Native codepage + fallback transliteration path on LATIN_THERMAL_CAPABILITIES (used by escpos-impact-76)
  const westernImpact = normalizeThermalText('Café Crème & Crêpes', LATIN_THERMAL_CAPABILITIES);
  assertEqualOrThrow(
    westernImpact,
    'Café Crème & Crêpes',
    'LATIN_THERMAL_CAPABILITIES should preserve Western European Latin characters natively',
  );
  assertEqualOrThrow(
    isThermalTextRepresentable('Café Crème & Crêpes', LATIN_THERMAL_CAPABILITIES),
    true,
    'Western Latin on impact should be representable',
  );

  const turkishImpact = normalizeThermalText(
    'Mercimek Çorbası & İskender',
    LATIN_THERMAL_CAPABILITIES,
  );
  assertEqualOrThrow(
    turkishImpact,
    'Mercimek Corbasi & Iskender',
    'LATIN_THERMAL_CAPABILITIES should transliterate Turkish dotless-i / dotted-I cleanly when not in CP437/CP858',
  );
  assertEqualOrThrow(
    isThermalTextRepresentable(turkishImpact, LATIN_THERMAL_CAPABILITIES),
    true,
    'Turkish on impact should be representable',
  );

  // Vietnamese horned vowels ('Ơ/ơ', 'Ư/ư') and tone-marked forms ('Sườn') on escpos-impact-76
  const vietnameseImpact = normalizeThermalText(
    'Cơm Sườn Nướng & Phở Bò Ơi Ướp',
    impactProfile.capabilities,
  );
  assertEqualOrThrow(
    vietnameseImpact,
    'Com Suon Nuong & Pho Bo Oi Uop',
    'Vietnamese horned vowels and tone-marked forms must fold cleanly to ASCII on escpos-impact-76',
  );
  assertEqualOrThrow(
    isThermalTextRepresentable(
      normalizeThermalText('Sườn', impactProfile.capabilities),
      impactProfile.capabilities,
    ),
    true,
    'Normalized Sườn must be text-representable on escpos-impact-76',
  );

  // Raster-capable thermal profiles (epson-tm-series) must treat 'Tiếng Việt' / 'Đơn vị' as
  // non-representable by native codepages so they render via raster bands instead of losing accents
  const epsonTmCapabilities = resolvePrinterProfile({ name: 'EPSON TM-T88VI' }).capabilities;
  assertEqualOrThrow(
    isThermalTextRepresentable('Tiếng Việt', epsonTmCapabilities),
    false,
    'Tiếng Việt must not be marked text-representable on raster-capable epson-tm-series',
  );
  assertEqualOrThrow(
    isThermalTextRepresentable('Đơn vị', epsonTmCapabilities),
    false,
    'Đơn vị must not be marked text-representable on raster-capable epson-tm-series',
  );
  assertEqualOrThrow(
    normalizeThermalText('Tiếng Việt', epsonTmCapabilities),
    'Tiếng Việt',
    'normalizeThermalText must preserve Tiếng Việt on raster-capable epson-tm-series for raster band rendering',
  );

  console.log('--- 3. Logo & payment-ticket QR suppression when raster.enabled: false ---');
  const { logoUrl, rasterJson } = createSampleLogoData();
  const sampleOrder = {
    order_number: 'ORD-IMPACT-1',
    type: 'dine_in',
    table_number: '4',
    created_at: '2026-10-29 12:00:00',
    items: [{ product_name: 'Espresso', quantity: 2, unit_price: 3.5, subtotal: 7.0, addons: [] }],
  };
  const sampleBill = {
    bill_number: 'INV-IMPACT-1',
    subtotal: 7.0,
    tax_amount: 0,
    discount_amount: 0,
    total: 7.0,
    payment_method: 'cash',
    paid_amount: 7.0,
    change_amount: 0,
    created_at: '2026-10-29 12:05:00',
    order: sampleOrder,
  };
  const sampleBiz = {
    name: 'Flo Impact Cafe',
    currency: 'USD',
    country: 'US',
    timezone: 'UTC',
    show_logo: true,
    receipt_logo: logoUrl,
    receipt_logo_raster: rasterJson,
    show_name: true,
  };

  const impactCaps = capabilitiesForPrinter(impactProfile, 'cols-32');
  const thermalProfile = resolvePrinterProfile({ name: 'EPSON TM-T88VI' });
  const thermalCaps = capabilitiesForPrinter(thermalProfile, 'cols-48');

  for (const tpl of ['classic', 'compact'] as const) {
    const impactDoc = receiptDocumentLines(
      sampleOrder,
      sampleBill,
      sampleBiz,
      tpl,
      32,
      false,
      false,
      false,
      'en',
      undefined,
      'partial',
      impactCaps,
    );
    assertEqualOrThrow(
      impactDoc!.lines.some((line: string) => line.startsWith('{RAW_BYTES:')),
      false,
      `Backend ${tpl} lines must omit {RAW_BYTES:...} logo when raster.enabled is false`,
    );
    const impactBytes = formatReceipt(
      sampleOrder,
      sampleBill,
      sampleBiz,
      tpl,
      32,
      false,
      false,
      'partial',
      undefined,
      false,
      'en',
      undefined,
      impactCaps,
    );
    assertEqualOrThrow(
      containsSubsequence(impactBytes, [0x1d, 0x76, 0x30]),
      false,
      `Backend ${tpl} bytes must not contain GS v 0 (1d 76 30) when raster.enabled is false`,
    );

    const thermalBytes = formatReceipt(
      sampleOrder,
      sampleBill,
      sampleBiz,
      tpl,
      48,
      false,
      false,
      'full',
      undefined,
      false,
      'en',
      undefined,
      thermalCaps,
    );
    assertEqualOrThrow(
      containsSubsequence(thermalBytes, [0x1d, 0x76, 0x30]),
      true,
      `Backend ${tpl} bytes must still emit GS v 0 logo when raster.enabled is true`,
    );
  }

  const webUsbPrintData = buildBillPrintData(sampleOrder, sampleBill, sampleBiz, false);
  const webUsbPrintContext = buildBillPrintContext({
    columns: 48,
    language: 'en',
    business: sampleBiz,
  });
  const webUsbDocument = buildBillDocument(webUsbPrintData, webUsbPrintContext);
  const webUsbThermalResult = await rasterizePrintDocumentForWebUsb(
    webUsbDocument,
    'classic',
    'epson-tm-series',
    {
      columns: 48,
      language: 'en',
      locale: 'en-US',
      currency: 'USD',
      currencySymbol: '$',
      trimDecimals: false,
      useUnicode: false,
      arabicShaping: false,
    },
  );
  assertEqualOrThrow(
    webUsbThermalResult.ok,
    true,
    'rasterizePrintDocumentForWebUsb on epson-tm-series succeeds',
  );
  if (webUsbThermalResult.ok) {
    assertEqualOrThrow(
      webUsbThermalResult.rasterSelected,
      true,
      'rasterizePrintDocumentForWebUsb must set rasterSelected=true when a store logo is present on a native-text receipt',
    );
    assertEqualOrThrow(
      containsSubsequence(webUsbThermalResult.data, [0x1d, 0x76, 0x30]),
      true,
      'rasterizePrintDocumentForWebUsb data must include GS v 0 logo bytes',
    );
  }

  // Frontend receipt encoder logo guard
  const fe = loadFrontendPrintModules();
  const feTenant = {
    business_name: 'Flo Impact Cafe',
    currency: 'USD',
    country: 'US',
    timezone: 'UTC',
  };
  const feImpactClassic = fe.receiptEncoder.buildClassicReceiptBytes(
    sampleBill as any,
    feTenant as any,
    {
      paperWidth: 58,
      configuredPaperWidth: 'cols-32',
      capabilities: impactCaps,
      showLogo: true,
      receiptLogo: logoUrl,
      receiptLogoRaster: rasterJson,
    },
  );
  assertEqualOrThrow(
    containsSubsequence(feImpactClassic, [0x1d, 0x76, 0x30]),
    false,
    'Frontend classic encoder must omit GS v 0 logo when capabilities.raster.enabled is false',
  );
  const feImpactCompact = fe.receiptEncoder.buildCompactReceiptBytes(
    sampleBill as any,
    feTenant as any,
    {
      paperWidth: 58,
      configuredPaperWidth: 'cols-32',
      capabilities: impactCaps,
      showLogo: true,
      receiptLogo: logoUrl,
      receiptLogoRaster: rasterJson,
    },
  );
  assertEqualOrThrow(
    containsSubsequence(feImpactCompact, [0x1d, 0x76, 0x30]),
    false,
    'Frontend compact encoder must omit GS v 0 logo when capabilities.raster.enabled is false',
  );

  console.log('--- 4. OS printer detection & classifyDetectedPrinterCompatibility ---');
  const winImpact = detectWindowsMakeModel('EPSON TM-U220 Receipt', 'EPSON TM-U220');
  assertEqualOrThrow(winImpact.make, 'Epson', 'Windows TM-U220 make');
  assertEqualOrThrow(winImpact.model, 'TM-U Series', 'Windows TM-U220 model');
  assertEqualOrThrow(
    guessPaperWidth('EPSON TM-U220 Receipt', winImpact.model),
    'cols-32',
    'TM-U220 guessed paperWidth must be cols-32',
  );
  const impactDetected = annotateProfile({
    name: 'EPSON TM-U220 Receipt',
    make: winImpact.make,
    model: winImpact.model,
    connectionType: 'usb',
    deviceUri: 'usb://EPSON/TM-U220',
    status: 'idle',
    isDefault: false,
    paperWidth: guessPaperWidth('EPSON TM-U220 Receipt', winImpact.model),
  });
  assertEqualOrThrow(impactDetected.profileId, 'escpos-impact-76', 'TM-U220 annotated profileId');
  assertEqualOrThrow(
    impactDetected.compatibility,
    'escpos_impact',
    'TM-U220 compatibility must be escpos_impact',
  );

  const macImpact = await getMacOSPrinterDetails('EPSON_TM_U220');
  assertEqualOrThrow(macImpact.make, 'Epson', 'macOS TM-U220 make');
  assertEqualOrThrow(macImpact.model, 'TM-U Series', 'macOS TM-U220 model');

  const winEcoTank = detectWindowsMakeModel('EPSON EcoTank L3250', 'EPSON L3250 Series');
  assertEqualOrThrow(winEcoTank.make, 'Epson', 'EcoTank make');
  assertEqualOrThrow(
    winEcoTank.model,
    'Epson Inkjet',
    'EcoTank must not be classified as TM Series',
  );
  assertEqualOrThrow(
    classifyDetectedPrinterCompatibility({
      name: 'EPSON EcoTank L3250',
      make: winEcoTank.make,
      model: winEcoTank.model,
      deviceUri: 'usb://EPSON/L3250',
    }),
    'driver_only',
    'EcoTank must be classified as driver_only',
  );

  for (const driverOnlyCase of [
    { name: 'Star TSP100 Cutter (TSP143)', make: 'Star Micronics', model: 'Star POS' },
    { name: 'Star SP700', make: 'Star Micronics', model: 'Star POS' },
    { name: 'Star mC-Print3', make: 'Star Micronics', model: 'Star POS' },
    { name: 'HP LaserJet Pro M404n', make: 'Unknown', model: 'Generic Printer' },
    { name: 'Zebra ZD420', make: 'Unknown', model: 'Generic Printer' },
    { name: 'EPSON TM-L90', make: 'Epson', model: 'EPSON TM-L90' },
    { name: 'Microsoft Print to PDF', make: 'Unknown', model: 'Generic Printer' },
    { name: 'PDFwriter', make: 'Unknown', model: 'Thermal Printer', deviceUri: 'pdfwriter:/' },
  ]) {
    assertEqualOrThrow(
      classifyDetectedPrinterCompatibility(driverOnlyCase),
      'driver_only',
      `${driverOnlyCase.name} must be classified as driver_only`,
    );
  }

  for (const thermalDetectedCase of [
    { name: 'EPSON TM-T88VI', make: 'Epson', model: 'TM Series', profileId: 'epson-tm-series' },
    { name: 'EPSON TM Receipt', make: 'Epson', model: 'TM Series' },
    { name: 'EPSON TM T88V', make: 'Epson', model: 'TM-T88' },
    { name: 'EPSON TM-H6000IV', make: 'Epson', model: 'TM-H600' },
    { name: 'TM-T100', make: 'Epson', model: 'TM-T100' },
  ]) {
    assertEqualOrThrow(
      classifyDetectedPrinterCompatibility(thermalDetectedCase),
      'escpos_thermal',
      `${thermalDetectedCase.name} must be classified as escpos_thermal`,
    );
  }

  console.log('--- 5. Migration 125 & /api/printers profile_id persistence + payment ticket ---');
  initTestDb();
  const db = getDatabase();
  const mig125 = MIGRATIONS.find((m: any) => m.name === 'add_printer_profile_id');
  assertOrThrow(Boolean(mig125), 'Migration add_printer_profile_id must be registered');
  assertEqualOrThrow(mig125.version, 125, 'add_printer_profile_id must be migration version 125');

  const printerCols = (
    db.prepare('PRAGMA table_info(printers)').all() as Array<{ name: string }>
  ).map((c) => c.name);
  assertOrThrow(printerCols.includes('profile_id'), 'printers table must include profile_id');

  // Test printPaymentTicket QR suppression on escpos-impact-76 vs thermal
  const { printPaymentTicketDetailed } = require('../main/printers/thermal');
  const ticketSettings = {
    business_name: 'Flo Impact Cafe',
    country: 'US',
    currency: 'USD',
    timezone: 'UTC',
  };
  const ticketItems = [
    { product_name: 'Bagel', quantity: 1, unit_price: 12.5, total: 12.5 },
    { product_name: 'Cơm Sườn Nướng', quantity: 1, unit_price: 15.0, total: 15.0 },
  ];

  const ticketRes = await printPaymentTicketDetailed(
    {
      order_number: 'ORD-7601',
      type: 'takeaway',
      created_at: '2026-10-29 12:00:00',
      total: 27.5,
    },
    ticketItems,
    {
      preview: true,
      settings: ticketSettings,
      targetPrinter: {
        id: 'pr-impact-ticket',
        name: 'Kitchen Counter Printer',
        connection_type: 'usb',
        paper_width: 'cols-32',
        profile_id: 'escpos-impact-76',
      },
    },
  );
  assertEqualOrThrow(ticketRes.ok, true, 'printPaymentTicketDetailed on impact printer succeeds');
  const capturedImpactTicket = Buffer.from(ticketRes.bytes || []);
  assertOrThrow(capturedImpactTicket.length > 0, 'Impact payment ticket bytes should be generated');
  assertEqualOrThrow(
    containsSubsequence(capturedImpactTicket, [0x1d, 0x28, 0x6b]),
    false,
    'Impact payment ticket must not emit GS ( k (1d 28 6b) QR code bytes',
  );
  const decodedTicket = escPosToText(capturedImpactTicket);
  assertIncludesOrThrow(
    decodedTicket,
    'Com Suon Nuong',
    'Impact payment ticket must fold priced Vietnamese horned-vowel item Sườn cleanly to ASCII',
  );
  assertIncludesOrThrow(
    decodedTicket,
    'FLOCAFE-TICKET:ORD-7601',
    'Impact payment ticket must still print centered FLOCAFE-TICKET:<order_number> text line',
  );

  // Switch printer to thermal profile and verify QR code IS emitted
  const thermalTicketRes = await printPaymentTicketDetailed(
    {
      order_number: 'ORD-7602',
      type: 'takeaway',
      created_at: '2026-10-29 12:00:00',
      total: 12.5,
    },
    [{ product_name: 'Bagel', quantity: 1, unit_price: 12.5, total: 12.5 }],
    {
      preview: true,
      settings: ticketSettings,
      targetPrinter: {
        id: 'pr-thermal-ticket',
        name: 'EPSON TM-T88VI',
        connection_type: 'usb',
        paper_width: 'cols-48',
        profile_id: 'epson-tm-series',
      },
    },
  );
  assertEqualOrThrow(
    thermalTicketRes.ok,
    true,
    'printPaymentTicketDetailed on thermal printer succeeds',
  );
  const capturedThermalTicket = Buffer.from(thermalTicketRes.bytes || []);
  assertEqualOrThrow(
    containsSubsequence(capturedThermalTicket, [0x1d, 0x28, 0x6b]),
    true,
    'Thermal payment ticket must emit GS ( k (1d 28 6b) QR code bytes',
  );

  db.prepare(
    `INSERT INTO printers (id, name, connection_type, is_default, paper_width, profile_id) VALUES ('pr-prep-test', 'Receipt Test Printer', 'usb', 1, 'cols-48', 'epson-tm-series')`,
  ).run();
  const extendedLatinBiz = {
    ...sampleBiz,
    address: 'Ulica Świętokrzyska 123, Śródmieście, Warszawa, Polska 00-001',
  };
  const preparedThermal = prepareReceipt(
    sampleOrder,
    sampleBill,
    extendedLatinBiz,
    'classic',
    false,
    false,
    false,
    'en',
  );
  assertEqualOrThrow(
    containsSubsequence(preparedThermal.data, [0x1d, 0x76, 0x30]),
    true,
    'prepareReceipt must emit GS v 0 logo when the default printer profile has raster.enabled=true',
  );
  const preparedThermalText = escPosToText(preparedThermal.data);
  assertEqualOrThrow(
    preparedThermalText.includes('Warszawa') && preparedThermalText.includes('00-001'),
    true,
    'prepareReceipt must wrap extended-Latin address across lines rather than truncating it at 48 columns',
  );

  db.prepare(
    `UPDATE printers SET is_default = 1, profile_id = 'escpos-impact-76', paper_width = 'cols-32' WHERE id = 'pr-prep-test'`,
  ).run();
  const preparedImpact = prepareReceipt(
    sampleOrder,
    sampleBill,
    extendedLatinBiz,
    'classic',
    false,
    false,
    false,
    'en',
  );
  assertEqualOrThrow(
    containsSubsequence(preparedImpact.data, [0x1d, 0x76, 0x30]),
    false,
    'prepareReceipt must omit GS v 0 logo when the default printer profile has raster.enabled=false',
  );
  const preparedImpactText = escPosToText(preparedImpact.data);
  assertEqualOrThrow(
    preparedImpactText.includes('Warszawa') && preparedImpactText.includes('00-001'),
    true,
    'prepareReceipt on impact profile must wrap extended-Latin address across lines',
  );
  db.prepare(`DELETE FROM printers WHERE id = 'pr-prep-test'`).run();

  // Test HTTP routes POST /api/printers and PUT /api/printers/:id
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({ '/api/printers': printerRoutes });
  const srv = await startServer(app);
  try {
    const createRes = await api(srv.baseUrl, '/api/printers', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Kitchen Impact Queue',
        connection_type: 'usb',
        profile_id: 'escpos-impact-76',
      },
    });
    assertEqualOrThrow(createRes.status, 201, 'POST /api/printers with profile_id status 201');
    assertEqualOrThrow(
      createRes.data.printer.configured_profile_id,
      'escpos-impact-76',
      'POST /api/printers returns configured_profile_id',
    );
    assertEqualOrThrow(
      createRes.data.printer.profile_id,
      'escpos-impact-76',
      'POST /api/printers returns resolved profile_id',
    );
    assertEqualOrThrow(
      createRes.data.printer.paper_width,
      'cols-32',
      'POST /api/printers defaults paper_width to profile defaultPaperWidth (cols-32)',
    );
    assertEqualOrThrow(
      createRes.data.printer.capabilities.raster.enabled,
      false,
      'POST /api/printers returns raster.enabled=false for escpos-impact-76',
    );

    const createdId = createRes.data.printer.id;

    // Invalid profile_id on POST returns 400
    const badCreateRes = await api(srv.baseUrl, '/api/printers', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Bad Profile Queue',
        connection_type: 'usb',
        profile_id: 'not-a-valid-profile',
      },
    });
    assertEqualOrThrow(
      badCreateRes.status,
      400,
      'POST /api/printers with invalid profile_id must return 400',
    );

    // Invalid profile_id on PUT returns 400
    const badUpdateRes = await api(srv.baseUrl, `/api/printers/${createdId}`, {
      method: 'PUT',
      headers: authHeader,
      body: {
        profile_id: 'invalid-profile-id',
      },
    });
    assertEqualOrThrow(
      badUpdateRes.status,
      400,
      'PUT /api/printers/:id with invalid profile_id must return 400',
    );

    // Clear profile_id on PUT -> falls back to auto-detection
    const clearProfileRes = await api(srv.baseUrl, `/api/printers/${createdId}`, {
      method: 'PUT',
      headers: authHeader,
      body: {
        profile_id: null,
        paper_width: 'cols-42',
      },
    });
    assertEqualOrThrow(clearProfileRes.status, 200, 'PUT /api/printers/:id clear profile_id 200');
    assertEqualOrThrow(
      clearProfileRes.data.printer.configured_profile_id,
      null,
      'configured_profile_id cleared to null',
    );
    assertEqualOrThrow(
      clearProfileRes.data.printer.profile_id,
      'generic-escpos-80',
      'resolved profile_id falls back to generic-escpos-80 after clearing configured_profile_id',
    );
  } finally {
    await new Promise<void>((resolve) => srv.server.close(() => resolve()));
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('✅ All impact printer support tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
