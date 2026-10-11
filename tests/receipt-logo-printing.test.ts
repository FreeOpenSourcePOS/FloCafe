/**
 * Receipt Logo Printing Tests
 *
 * Verifies:
 * 1. 1-bit raster packing, unpacking, dithering, centering, and band extraction.
 * 2. Document model populating logo fields based on showLogo toggle.
 * 3. ESC/POS raster band generation and GS v 0 byte emission.
 * 4. KOT tickets never printing business logo.
 * 5. Multi-width raster variant selection (384 dots for 58mm, 576 dots for 80mm).
 * 6. Settings API logo validation (payload size limits, data URL validation).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock electron before importing db / app modules
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-receipt-logo-test-'));

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
  pack1BitPixels,
  unpack1BitPixels,
  ditherGrayscalePixels,
  centerPixels,
  getLogoRasterBands,
  type ReceiptLogoData,
} from '../shared/print/image-raster';
import { buildBillDocument, getBlock, type BusinessHeaderBlock } from '../shared/print/document';
import { buildBillPrintData } from '../main/printers/document-classic';
import { formatReceipt, formatKOT } from '../main/printers/thermal';
import { settingsRoutes } from '../main/routes/settings';
import {
  initTestDb,
  createApp,
  startServer,
  api,
  seedOwnerUser,
  closeDatabase,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
} from './helpers/test-setup';

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

  // 16x16 dummy bitmap with alternating black/white pixels
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

  return {
    logoUrl,
    rasterJson: JSON.stringify(rasterObj),
  };
}

async function run() {
  console.log('--- 1. Image Raster pure functions ---');

  // pack1BitPixels and unpack1BitPixels
  const w = 8;
  const h = 2;
  const original = new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1]);
  const packed = pack1BitPixels(original, w, h);
  assertEqualOrThrow(packed.length, 2, 'Packed bytes length should be 2 for 8x2 1-bit pixels');
  assertEqualOrThrow(packed[0], 0xaa, 'Row 0 packed MSB-first should be 0xAA (10101010)');
  assertEqualOrThrow(packed[1], 0x55, 'Row 1 packed MSB-first should be 0x55 (01010101)');

  const unpacked = unpack1BitPixels(packed, w, h);
  for (let i = 0; i < original.length; i += 1) {
    assertEqualOrThrow(unpacked[i], original[i], `Unpacked pixel ${i} should match original`);
  }

  // ditherGrayscalePixels (Floyd-Steinberg error diffusion)
  const grayscale = new Float32Array([
    255,
    255, // Pure white
    0,
    0, // Pure black
  ]);
  const dithered = ditherGrayscalePixels(grayscale, 2, 2);
  assertEqualOrThrow(dithered[0], 0, 'White grayscale pixel should dither to 0 (no ink)');
  assertEqualOrThrow(dithered[1], 0, 'White grayscale pixel should dither to 0 (no ink)');
  assertEqualOrThrow(dithered[2], 1, 'Black grayscale pixel should dither to 1 (ink)');
  assertEqualOrThrow(dithered[3], 1, 'Black grayscale pixel should dither to 1 (ink)');

  // centerPixels
  const uncentered = new Uint8Array([1, 1]); // 2x1
  const centered = centerPixels(uncentered, 2, 1, 6); // pad to 6
  assertEqualOrThrow(centered.length, 6, 'Centered row length should equal target width');
  // Left pad should be (6 - 2) / 2 = 2
  assertEqualOrThrow(centered[0], 0, 'Left padding pixel 0 should be 0');
  assertEqualOrThrow(centered[1], 0, 'Left padding pixel 1 should be 0');
  assertEqualOrThrow(centered[2], 1, 'Centered pixel 2 should be 1');
  assertEqualOrThrow(centered[3], 1, 'Centered pixel 3 should be 1');
  assertEqualOrThrow(centered[4], 0, 'Right padding pixel 4 should be 0');
  assertEqualOrThrow(centered[5], 0, 'Right padding pixel 5 should be 0');

  // getLogoRasterBands variant resolution
  const { logoUrl, rasterJson } = createSampleLogoData();
  const bands58 = getLogoRasterBands(rasterJson, 384);
  assertOrThrow(bands58.length > 0, 'Should resolve bands for 384 dots');
  assertEqualOrThrow(bands58[0].widthDots, 384, 'Resolved band width should be 384 dots');

  const bands80 = getLogoRasterBands(rasterJson, 576);
  assertOrThrow(bands80.length > 0, 'Should resolve bands for 576 dots');
  assertEqualOrThrow(bands80[0].widthDots, 576, 'Resolved band width should be 576 dots');

  const tallPixels = new Uint8Array(576 * 288);
  tallPixels[tallPixels.length - 1] = 1;
  const tallPacked = pack1BitPixels(tallPixels, 576, 288);
  const tallLogo = JSON.stringify({
    version: 1,
    originalDataUrl: logoUrl,
    variants: { '576': { width: 576, height: 288, dataBase64: uint8ToBase64(tallPacked) } },
  });
  const tallBands = getLogoRasterBands(tallLogo, 576);
  assertEqualOrThrow(tallBands.length, 2, 'Tall logos should be split into bounded bands');
  assertEqualOrThrow(
    tallBands[0].heightDots,
    200,
    'First tall logo band should use the height limit',
  );
  assertEqualOrThrow(
    tallBands[1].heightDots,
    88,
    'Second tall logo band should retain remaining rows',
  );
  assertEqualOrThrow(
    tallBands[1].pixels.at(-1),
    1,
    'Last row should be preserved in the final band',
  );

  const malformedLogo = JSON.stringify({
    version: 1,
    originalDataUrl: logoUrl,
    variants: { '576': { width: Number.MAX_SAFE_INTEGER, height: 2, dataBase64: 'AAAA' } },
  });
  assertEqualOrThrow(
    getLogoRasterBands(malformedLogo, 576).length,
    0,
    'Invalid dimensions should be rejected',
  );

  console.log('--- 2. Document model logo integration ---');
  const dummyBill = {
    bill_number: 'INV-100',
    subtotal: 10,
    tax_amount: 0,
    total: 10,
  };
  const dummyOrder = {
    order_number: 'ORD-100',
    created_at: new Date().toISOString(),
    items: [{ product_name: 'Espresso', quantity: 1, unit_price: 10, total: 10 }],
  };

  const printContext = {
    columns: 32,
    languages: ['en'] as readonly string[],
    baseDirection: 'ltr' as const,
    locale: 'en-US',
    currency: 'USD',
    currencySymbol: '$',
    resolveLabel: (_concept: string, _lang: string) => 'Text',
  };

  const printDataWithLogo = buildBillPrintData(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      show_logo: true,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    false,
  );

  const docWithLogo = buildBillDocument(printDataWithLogo, printContext);

  const headerBlockWithLogo = getBlock(docWithLogo, 'business-header') as BusinessHeaderBlock;
  assertOrThrow(headerBlockWithLogo !== undefined, 'Business header block should exist');
  assertEqualOrThrow(headerBlockWithLogo.logo, logoUrl, 'Header block should contain logo URL');
  assertEqualOrThrow(
    headerBlockWithLogo.logoRaster,
    rasterJson,
    'Header block should contain logo raster JSON',
  );

  const printDataWithoutLogo = buildBillPrintData(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      show_logo: false,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    false,
  );

  const docWithoutLogo = buildBillDocument(printDataWithoutLogo, printContext);

  const headerBlockWithoutLogo = getBlock(docWithoutLogo, 'business-header') as BusinessHeaderBlock;
  assertEqualOrThrow(
    headerBlockWithoutLogo.logo,
    null,
    'Header block logo should be null when showLogo is false',
  );
  assertEqualOrThrow(
    headerBlockWithoutLogo.logoRaster,
    null,
    'Header block logoRaster should be null when showLogo is false',
  );

  console.log('--- 3. ESC/POS byte generation ---');

  const receiptBytesWithLogo = formatReceipt(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      country: 'US',
      currency: 'USD',
      show_logo: true,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    'classic',
    32,
  );

  // GS v 0 signature: 0x1D 0x76 0x30 0x00
  let foundGsV0 = false;
  for (let i = 0; i < receiptBytesWithLogo.length - 4; i += 1) {
    if (
      receiptBytesWithLogo[i] === 0x1d &&
      receiptBytesWithLogo[i + 1] === 0x76 &&
      receiptBytesWithLogo[i + 2] === 0x30 &&
      receiptBytesWithLogo[i + 3] === 0x00
    ) {
      foundGsV0 = true;
      break;
    }
  }
  assertOrThrow(
    foundGsV0,
    'Receipt ESC/POS bytes should contain GS v 0 raster command when show_logo is true',
  );

  const receiptBytesWithoutLogo = formatReceipt(
    dummyOrder,
    dummyBill,
    {
      name: 'Flo Cafe',
      country: 'US',
      currency: 'USD',
      show_logo: false,
      receipt_logo: logoUrl,
      receipt_logo_raster: rasterJson,
      show_name: true,
    },
    'classic',
    32,
  );

  let foundGsV0WithoutLogo = false;
  for (let i = 0; i < receiptBytesWithoutLogo.length - 4; i += 1) {
    if (
      receiptBytesWithoutLogo[i] === 0x1d &&
      receiptBytesWithoutLogo[i + 1] === 0x76 &&
      receiptBytesWithoutLogo[i + 2] === 0x30 &&
      receiptBytesWithoutLogo[i + 3] === 0x00
    ) {
      foundGsV0WithoutLogo = true;
      break;
    }
  }
  assertOrThrow(
    !foundGsV0WithoutLogo,
    'Receipt ESC/POS bytes should not contain GS v 0 command when show_logo is false',
  );

  console.log('--- 4. KOT kitchen tickets invariant: never print logo ---');
  const kotBytes = formatKOT(dummyOrder, dummyOrder.items, 'Kitchen', 32);

  let kotHasGsV0 = false;
  for (let i = 0; i < kotBytes.length - 4; i += 1) {
    if (
      kotBytes[i] === 0x1d &&
      kotBytes[i + 1] === 0x76 &&
      kotBytes[i + 2] === 0x30 &&
      kotBytes[i + 3] === 0x00
    ) {
      kotHasGsV0 = true;
      break;
    }
  }
  assertOrThrow(!kotHasGsV0, 'KOT ticket must never contain GS v 0 logo command');

  console.log('--- 5. Settings API validation and persistence ---');
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const app = createApp({ '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const authHeaders = owner.authHeader;

    // Reject oversized logo (> 250KB)
    const hugeLogo = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
    const rejectRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo: hugeLogo,
      },
    });
    assertEqualOrThrow(
      rejectRes.status,
      400,
      'PUT /api/settings/business with oversized logo should return 400',
    );
    assertIncludesOrThrow(rejectRes.data.error, '250 KB', 'Error should mention 250 KB size limit');

    // Reject non-data URI
    const invalidUriRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo: 'https://example.com/logo.png',
      },
    });
    assertEqualOrThrow(
      invalidUriRes.status,
      400,
      'PUT /api/settings/business with non-data URI should return 400',
    );

    // Reject malformed receipt_logo_raster
    const malformedRasterRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo_raster: '{"invalid":"json_structure"}',
      },
    });
    assertEqualOrThrow(
      malformedRasterRes.status,
      400,
      'PUT /api/settings/business with malformed raster should return 400',
    );

    // Accept valid logo and persist
    const acceptRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        receipt_logo: logoUrl,
        receipt_logo_raster: rasterJson,
      },
    });
    assertEqualOrThrow(
      acceptRes.status,
      200,
      'PUT /api/settings/business with valid logo should succeed',
    );

    // Fetch via GET /api/settings/business
    const getRes = await api(baseUrl, '/api/settings/business', {
      headers: authHeaders,
    });
    assertEqualOrThrow(getRes.status, 200, 'GET /api/settings/business should succeed');
    assertEqualOrThrow(
      getRes.data.receipt_logo,
      logoUrl,
      'GET should return persisted receipt_logo',
    );
    assertEqualOrThrow(
      getRes.data.receipt_logo_raster,
      rasterJson,
      'GET should return persisted receipt_logo_raster',
    );

    // Update bill_show_logo toggle via PUT /api/settings/printing
    const toggleRes = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        printer_trim_decimals: true,
        bill_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
        kot_language_policy: { primary: { mode: 'fixed', language: 'en' }, additional: [] },
        bill_show_name: true,
        bill_show_address: true,
        bill_show_phone: true,
        bill_show_tax_id: false,
        bill_show_tax_breakdown: true,
        bill_show_customer_name: true,
        bill_show_customer_phone: true,
        bill_show_table_number: true,
        bill_delivery_show_customer_phone_always: true,
        bill_show_logo: true,
      },
    });
    assertEqualOrThrow(
      toggleRes.status,
      200,
      'PUT /api/settings/printing with bill_show_logo should succeed',
    );

    const getAfterToggle = await api(baseUrl, '/api/settings/business', {
      headers: authHeaders,
    });
    assertEqualOrThrow(
      getAfterToggle.data.bill_show_logo,
      true,
      'bill_show_logo should be true after toggle',
    );

    // Also update bill_show_logo toggle via PUT /api/settings/business
    const businessToggleRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeaders,
      body: {
        bill_show_logo: false,
      },
    });
    assertEqualOrThrow(
      businessToggleRes.status,
      200,
      'PUT /api/settings/business with bill_show_logo should succeed',
    );

    const getAfterBusinessToggle = await api(baseUrl, '/api/settings/business', {
      headers: authHeaders,
    });
    assertEqualOrThrow(
      getAfterBusinessToggle.data.bill_show_logo,
      false,
      'bill_show_logo should be false after business toggle',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  }

  console.log('✅ All receipt logo printing tests passed successfully!');
}

run().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
