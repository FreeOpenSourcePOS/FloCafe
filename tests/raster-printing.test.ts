import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  buildRasterDiagnosticBands,
  encodeGsV0Band,
  encodeMixedPrintParts,
  encodeWholeReceiptRaster,
  encodeRasterFeedAndCut,
  isRasterRenderRequest,
  isRasterRenderResult,
  rasterCapabilityEnabled,
  rasterWebUsbPathEnabled,
  type RasterBand,
} from '../shared/print/raster';
import { GENERIC_THERMAL_CAPABILITIES, type ThermalPrinterCapabilities } from '../shared/print/thermal-capabilities';
import { buildBillDocument, buildKotDocument, isKotDocument, isPrintDocument } from '../shared/print/document';
import { buildBackendMixedRasterBytes } from '../main/printers/raster-output';
import { getSupportedPrinterProfiles } from '../main/printers/profiles';
import { buildEscPos, financialRows, itemRows, normalizeThermalText } from '../main/printers/thermal';
import { buildTestPage } from '../main/printers/thermal';
import { buildKotPrintData, renderKotDocumentToLines } from '../main/printers/document-kot';
import { renderBillDocumentToClassicLines } from '../main/printers/document-classic';
import { renderBillDocumentToCompactLines, renderCompactReceiptViaDocument } from '../main/printers/document-compact';
import { ChromiumRasterRenderer, renderRasterSemanticUnit, renderUnsupportedRasterLines } from '../main/printers/raster-renderer';

function loadFrontendRasterEncoder(): typeof import('../frontend/src/lib/printer/raster-encoder') {
  const path = require('node:path') as typeof import('node:path');
  const moduleApi = require('node:module') as { _resolveFilename: (...args: any[]) => string };
  const originalResolveFilename = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    const resolvedRequest = request === '@print/raster'
      ? path.resolve(__dirname, '../shared/print/raster.ts')
      : request === '@print/thermal-capabilities'
        ? path.resolve(__dirname, '../shared/print/thermal-capabilities.ts')
        : request;
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  try {
    return require('../frontend/src/lib/printer/raster-encoder');
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

function loadFrontendPrintDocument(): typeof import('../frontend/src/lib/printer/print-document') {
  const path = require('node:path') as typeof import('node:path');
  const moduleApi = require('node:module') as { _resolveFilename: (...args: any[]) => string };
  const originalResolveFilename = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let resolvedRequest = request;
    if (request === '@countries') {
      resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
    } else if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
    } else if (request.startsWith('@print/')) {
      resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  try {
    return require('../frontend/src/lib/printer/print-document');
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

function capability(): ThermalPrinterCapabilities {
  return {
    ...GENERIC_THERMAL_CAPABILITIES,
    raster: {
      enabled: true,
      widthDots: 9,
      maxBandHeight: 2,
      modes: ['mixed', 'whole-receipt'],
      font: { family: 'FloRaster', dataUrl: 'data:font/woff2;base64,AA==' },
    },
  };
}

async function run(): Promise<void> {
  const twoRows: RasterBand = { widthDots: 9, heightDots: 2, pixels: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1]) };
  assert.deepEqual(Array.from(encodeGsV0Band(twoRows, 2)), [
    0x1D, 0x76, 0x30, 0x00, 0x02, 0x00, 0x02, 0x00,
    0x81, 0x80, 0x40, 0x80,
  ]);
  assert.throws(() => encodeGsV0Band({ ...twoRows, heightDots: 3, pixels: new Uint8Array(27) }, 2), /maximum height/);
  assert.throws(() => encodeGsV0Band({ ...twoRows, pixels: new Uint8Array(1) }, 2), /one value per pixel/);
  assert.throws(() => encodeGsV0Band({ widthDots: 524288, heightDots: 1, pixels: new Uint8Array(524288) }), /GS v 0 limit/);
  assert.throws(() => encodeGsV0Band({ widthDots: 8, heightDots: 65536, pixels: new Uint8Array(8 * 65536) }, 0xFFFF), /GS v 0 limit/);
  assert.throws(() => encodeGsV0Band(twoRows, 0x10000), /maximum raster band height/);

  const caps = capability();
  assert.equal(rasterCapabilityEnabled(caps), true);
  assert.equal(rasterCapabilityEnabled(caps, 'whole-receipt'), true);
  assert.equal(rasterWebUsbPathEnabled(caps, false, 'validated-profile'), false);
  assert.equal(rasterWebUsbPathEnabled(caps, true, undefined), false);
  assert.equal(rasterWebUsbPathEnabled(caps, true, 'validated-profile'), true);
  assert.equal(rasterCapabilityEnabled(GENERIC_THERMAL_CAPABILITIES), false);
  assert.equal(getSupportedPrinterProfiles().every((profile) => profile.capabilities.raster.enabled === false), true);
  assert.equal(isPrintDocument({
    version: 1,
    direction: { base: 'ltr', document: 'ltr', block: 'ltr', value: 'ltr' },
    languages: ['en'],
    blocks: [],
  }), false);
  const printDocument = buildBillDocument({
    isReprint: false,
    order: { orderNumber: '', createdAt: '', tableName: '', onlinePlatform: '', externalOrderId: '', items: [] },
    bill: { billNumber: '', subtotal: 0, discountAmount: 0, taxAmount: 0, total: 0, taxComponents: [], payments: [], pointsEarned: 0, pointsRedeemed: 0, pointsBalance: null },
    business: { name: '', address: '', phone: '', taxRegistrationNumber: '', taxIdLabel: '', instagramHandle: '', footerNote: '', customerName: '', customerPhone: '', showName: true, showAddress: false, showPhone: false, showTaxId: 'never', showTaxBreakdown: false, showTableNumber: false, showCustomerName: false, showCustomerPhone: false },
  }, { columns: 42, languages: ['en'], baseDirection: 'ltr', locale: 'en-US', currencySymbol: '$', trimDecimals: false, resolveLabel: (conceptId) => conceptId });
  assert.equal(isPrintDocument(printDocument), true);
  assert.equal(isPrintDocument({ ...printDocument, blocks: printDocument.blocks.slice(0, -1) }), false);
  assert.equal(isPrintDocument({ ...printDocument, blocks: [...printDocument.blocks, printDocument.blocks[0]] }), false);
  const longAddon = 'ASCII addon content that must remain available to pixel wrapping';
  const longInstruction = 'ASCII instruction content that must remain available to pixel wrapping';
  const sourceDocument = buildBillDocument({
    isReprint: false,
    order: { orderNumber: '', createdAt: '', tableName: '', onlinePlatform: '', externalOrderId: '', items: [{ productName: 'فارسی محصول', quantity: 1, unitPrice: 1, total: 1, addons: [{ name: longAddon, price: 1, quantity: 1 }], specialInstructions: longInstruction }] },
    bill: { billNumber: '', subtotal: 1, discountAmount: 0, taxAmount: 0, total: 1, taxComponents: [], payments: [], pointsEarned: 0, pointsRedeemed: 0, pointsBalance: null },
    business: { name: '', address: '', phone: '', taxRegistrationNumber: '', taxIdLabel: '', instagramHandle: '', footerNote: '', customerName: '', customerPhone: '', showName: true, showAddress: false, showPhone: false, showTaxId: 'never', showTaxBreakdown: false, showTableNumber: false, showCustomerName: false, showCustomerPhone: false },
  }, { columns: 42, languages: ['en'], baseDirection: 'ltr', locale: 'en-US', currencySymbol: '$', trimDecimals: false, resolveLabel: (conceptId) => conceptId });
  const sourceGroups: any[] = [];
  const sourceLines = renderBillDocumentToClassicLines(sourceDocument, {
    columns: 42,
    language: 'en',
    locale: 'en-US',
    currencySymbol: '$',
    trimDecimals: false,
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'full',
    capabilities: caps,
    rasterGroups: sourceGroups,
  });
  const sourceRequests: any[] = [];
  await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      sourceRequests.push(rasterRequest);
      return { version: 1, requestId: (rasterRequest as any).requestId, ok: true, unit: { unitId: (rasterRequest as any).requestId, financial: false, complete: true, bands: [twoRows] } };
    },
  }, sourceLines, caps, 'source-siblings', sourceGroups);
  assert.equal(sourceRequests.some((request) => request.text.includes(longAddon)), true);
  assert.equal(sourceRequests.some((request) => request.text.includes(longInstruction)), true);
  const compactDocument = buildBillDocument({
    isReprint: true,
    order: { orderNumber: '', createdAt: '', tableName: '', onlinePlatform: 'کافه', externalOrderId: 'K-7', items: [] },
    bill: { billNumber: '', subtotal: 0, discountAmount: 0, taxAmount: 0, total: 0, taxComponents: [], payments: [], pointsEarned: 0, pointsRedeemed: 0, pointsBalance: null },
    business: { name: 'فروشگاه فارسی', address: 'آدرس فارسی', phone: '', taxRegistrationNumber: '', taxIdLabel: '', instagramHandle: '', footerNote: 'پیام فارسی', customerName: '', customerPhone: '', showName: true, showAddress: true, showPhone: false, showTaxId: 'never', showTaxBreakdown: false, showTableNumber: false, showCustomerName: false, showCustomerPhone: false },
  }, { columns: 42, languages: ['en'], baseDirection: 'ltr', locale: 'en-US', currencySymbol: '$', trimDecimals: false, resolveLabel: (conceptId) => conceptId });
  const compactGroups: any[] = [];
  renderBillDocumentToCompactLines(compactDocument, {
    columns: 42,
    language: 'en',
    locale: 'en-US',
    currencySymbol: '$',
    trimDecimals: false,
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'full',
    capabilities: caps,
    rasterGroups: compactGroups,
  });
  const compactBusinessGroups = compactGroups.filter((group) => group.groupId === 'business-header');
  const compactMessageGroups = compactGroups.filter((group) => group.groupId === 'message');
  assert.equal(compactBusinessGroups.length, 2);
  assert.equal(compactBusinessGroups[0].lineIndex < compactBusinessGroups[1].lineIndex, true);
  assert.equal(compactMessageGroups.length, 2);
  assert.equal(compactMessageGroups[0].lineIndex < compactMessageGroups[1].lineIndex, true);
  const kotDocument = buildKotDocument({
    stationName: 'ایستگاه',
    order: { orderNumber: 'K-1', createdAt: '2026-01-01T12:00:00.000Z', tableName: '', orderType: '' },
    items: [],
  }, {
    columns: 42,
    languages: ['fa'],
    baseDirection: 'rtl',
    locale: 'fa-IR',
    currencySymbol: '',
    trimDecimals: false,
    resolveLabel: (conceptId) => ({ conceptId, primary: conceptId }),
  });
  assert.equal(isKotDocument(kotDocument), true);
  assert.equal(isKotDocument({ ...kotDocument, blocks: [...kotDocument.blocks, kotDocument.blocks[1]] }), false);
  assert.equal(isKotDocument({ ...kotDocument, blocks: [kotDocument.blocks[0]] }), false);
  const frontendKotDocument = loadFrontendPrintDocument().buildFrontendKotDocument({
    order_number: 'K-2',
    created_at: '2026-01-01T12:00:00.000Z',
    items: [{ product_name: 'Tea', quantity: 1, status: 'pending', addons: '[{"name":"Extra sauce","quantity":2}]', special_instructions: null }],
  } as any, {
    stationName: 'Main Kitchen',
    columns: 42,
    language: 'en',
  });
  const frontendKotItems = frontendKotDocument.blocks.find((block) => block.kind === 'kot-items') as any;
  assert.deepEqual(frontendKotItems.rows[0].addons.map((addon: any) => ({ text: addon.text, quantity: addon.quantity })), [{ text: 'Extra sauce', quantity: 2 }]);
  const kotLines = renderKotDocumentToLines(kotDocument, {
    columns: 42,
    language: 'fa',
    locale: 'fa-IR',
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'full',
    capabilities: caps,
  });
  assert.equal(kotLines.some((line) => line.includes('ایستگاه')), true);
  const longUnsupportedName = 'فارسی خیلی طولانی برای اندازه‌گیری';
  assert.equal(normalizeThermalText('Müsli فارسی', caps), 'Müsli فارسی');
  assert.equal(itemRows({ product_name: longUnsupportedName, quantity: 1, total: 1 }, 4, 4, 12, '₹', 'en-US', false, 'fa', 2, caps)[0].includes('..'), false);
  assert.equal(financialRows('برچسب مالی بسیار طولانی', '1', 12, 'fa', caps)[0].includes('..'), false);
  const unit = { unitId: 'row-1', financial: false, complete: true, bands: [twoRows] } as const;
  const native = Uint8Array.from([0x1B, 0x40, 0x41, 0x0A]);
  const mixed = encodeMixedPrintParts([{ kind: 'native', bytes: native }, { kind: 'raster', unit }], caps, 'partial');
  assert.deepEqual(Array.from(mixed.slice(0, native.length)), Array.from(native));
  assert.deepEqual(Array.from(mixed.slice(-7)), Array.from(encodeRasterFeedAndCut('partial')));
  assert.deepEqual(Array.from(mixed), Array.from(buildBackendMixedRasterBytes([{ kind: 'native', bytes: native }, { kind: 'raster', unit }], caps, 'partial')));
  assert.deepEqual(Array.from(mixed), Array.from(loadFrontendRasterEncoder().buildWebUsbMixedRasterBytes([{ kind: 'native', bytes: native }, { kind: 'raster', unit }], caps, 'partial')));
  assert.deepEqual(
    Array.from(encodeWholeReceiptRaster(unit, caps, 'partial')),
    Array.from(encodeMixedPrintParts([{ kind: 'raster', unit }], caps, 'partial')),
  );
  assert.throws(() => encodeMixedPrintParts([{ kind: 'raster', unit: { ...unit, complete: false, financial: true } }], caps, 'full'), /incomplete/);
  assert.throws(() => encodeMixedPrintParts([{ kind: 'raster', unit: { ...unit, bands: [{ ...twoRows, widthDots: 8 }] } }], caps, 'full'), /does not match/);
  const mixedWarnings: any[] = [];
  const mixedEscPos = buildEscPos(['A', 'raster'], false, {
    capabilities: caps,
    rasterUnits: [{ lineIndex: 1, unit }],
  }, mixedWarnings);
  assert.equal(mixedWarnings.length, 0);
  assert.equal(mixedEscPos.includes(0x41), true);
  assert.equal(mixedEscPos.includes(0x1D) && mixedEscPos.includes(0x76), true);
  const financialWarnings: any[] = [];
  const refused = buildEscPos(['raster'], false, {
    capabilities: caps,
    rasterUnits: [{ lineIndex: 0, unit: { ...unit, financial: true, complete: false } }],
  }, financialWarnings);
  assert.equal(refused.length, 0);
  assert.equal(financialWarnings[0]?.kind, 'financial');
  assert.equal(buildEscPos(['raster'], false, {
    capabilities: caps,
    rasterUnits: [{ lineIndex: 0, unit: { ...unit, financial: true, complete: false } }],
  }).length, 0);
  const metadataWarnings: any[] = [];
  assert.equal(buildEscPos(['{FINANCIAL}raster'], false, {
    capabilities: caps,
    rasterUnits: [{ lineIndex: 0, unit: { ...unit, complete: false } }],
  }, metadataWarnings).length, 0);
  assert.equal(metadataWarnings[0]?.kind, 'financial');
  assert.equal(buildEscPos(['raster'], false, {
    capabilities: caps,
    rasterUnits: [{ lineIndex: 9, unit: { ...unit, financial: true } }],
  }).length, 0);
  const bindingWarnings: any[] = [];
  buildEscPos(['raster'], false, {
    capabilities: caps,
    rasterUnits: [{ lineIndex: 0, unit }, { lineIndex: 0, unit: { ...unit, unitId: 'row-2' } }],
  }, bindingWarnings);
  assert.equal(bindingWarnings.length, 2);

  const diagnostic = buildRasterDiagnosticBands(17, 32);
  assert.deepEqual(diagnostic.map((band) => band.heightDots), [32, 16, 32, 16, 24]);
  assert.equal(diagnostic[0].pixels[0], 0);
  assert.equal(diagnostic[0].pixels[8], 1);
  const diagnosticPage = buildTestPage('80mm', 'partial', 'en-US', undefined, { ...caps, raster: { ...caps.raster, maxBandHeight: 32, widthDots: 17 } });
  assert.equal(diagnosticPage.includes(0x1D) && diagnosticPage.includes(0x76), true);
  assert.deepEqual(Array.from(diagnosticPage.slice(-7)), Array.from(encodeRasterFeedAndCut('partial')));
  const failedRender = await renderRasterSemanticUnit({ render: async () => ({ version: 1, requestId: 'r1', ok: false, code: 'font-unavailable', detail: 'missing' }) }, {} as any, true);
  assert.equal(failedRender.ok, false);
  assert.equal(failedRender.financial, true);
  const renderRequests: any[] = [];
  const renderedLines = await renderUnsupportedRasterLines({
    render: async (request) => {
      const typedRequest = request as any;
      renderRequests.push(typedRequest);
      return { version: 1, requestId: typedRequest.requestId, ok: true, unit: { unitId: typedRequest.requestId, financial: false, complete: true, bands: [twoRows] } };
    },
  }, ['{DOUBLE_HEIGHT}{BOLD}فارسی{/BOLD}{/DOUBLE_HEIGHT}', '  + native'], caps, 'receipt');
  assert.equal(renderedLines.units[0]?.lineIndex, 0);
  assert.equal(renderedLines.units[0]?.lineCount, 2);
  assert.equal(renderRequests[0].style, 'double-height');
  assert.deepEqual(renderRequests[0].styles, ['bold', 'double-height']);
  assert.equal(renderRequests[0].direction, 'rtl');
  assert.equal(renderRequests[0].align, 'left');
  assert.equal(renderRequests.length, 2);
  const financialRequests: any[] = [];
  await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      financialRequests.push(rasterRequest);
      return { version: 1, requestId: (rasterRequest as any).requestId, ok: true, unit: { unitId: (rasterRequest as any).requestId, financial: true, complete: true, bands: [twoRows] } };
    },
  }, ['{FINANCIAL}فارسی {FINANCIAL}'], caps, 'financial', [
    { groupId: 'financial', lineIndex: 0, lineCount: 1, sourceLines: ['فارسی {FINANCIAL}'], financial: true },
  ]);
  assert.equal(financialRequests[0].financial, true);
  const alignedStyleRequests: any[] = [];
  await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      alignedStyleRequests.push(rasterRequest);
      return { version: 1 as const, requestId: (rasterRequest as any).requestId, ok: true as const, unit: { ...unit, unitId: (rasterRequest as any).requestId } };
    },
  }, ['{FINANCIAL}فارسی row', '{FINANCIAL}wrapped continuation', '{FINANCIAL}{BOLD}فارسی total{/BOLD}'], caps, 'aligned-style', [
    {
      groupId: 'totals',
      lineIndex: 0,
      lineCount: 3,
      sourceLines: ['فارسی row', 'فارسی total'],
      sourceControlLines: ['{FINANCIAL}فارسی row', '{FINANCIAL}{BOLD}فارسی total{/BOLD}'],
      financial: true,
    },
  ]);
  assert.equal(alignedStyleRequests[1].style, 'bold');
  const groupedCustomer = await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      const typedRequest = rasterRequest as any;
      renderRequests.push(typedRequest);
      return { version: 1, requestId: typedRequest.requestId, ok: true, unit: { unitId: typedRequest.requestId, financial: false, complete: true, bands: [twoRows] } };
    },
  }, ['{CENTER}فارسی{/CENTER}', '{CENTER}555-0100{/CENTER}'], caps, 'customer', [{ groupId: 'customer', lineIndex: 0, lineCount: 2 }]);
  assert.equal(groupedCustomer.units[0]?.unit.unitId, 'customer');
  assert.equal(groupedCustomer.units[0]?.lineCount, 2);
  assert.equal(renderRequests.at(-2)?.text, 'فارسی');
  assert.equal(renderRequests.at(-1)?.text, '555-0100');
  const controlCollisionRequests: any[] = [];
  const controlCollision = await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      controlCollisionRequests.push(rasterRequest);
      return { version: 1 as const, requestId: (rasterRequest as any).requestId, ok: true as const, unit: { ...unit, unitId: (rasterRequest as any).requestId } };
    },
  }, ['{CENTER}فارسی {CUT}{/CENTER}', '{CENTER}ASCII{/CENTER}'], caps, 'control-collision', [
    { groupId: 'item', lineIndex: 0, lineCount: 2, sourceLines: ['فارسی {CUT}', 'ASCII'] },
  ]);
  assert.equal(controlCollision.failures.length, 0);
  assert.equal(controlCollisionRequests[0].text, 'فارسی {CUT}');
  assert.equal(controlCollision.units[0]?.lineCount, 2);
  const styleCollisionRequests: any[] = [];
  await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      styleCollisionRequests.push(rasterRequest);
      return { version: 1 as const, requestId: (rasterRequest as any).requestId, ok: true as const, unit: { ...unit, unitId: (rasterRequest as any).requestId } };
    },
  }, ['{BOLD}BOLD{/BOLD}', 'فارسی'], caps, 'style-collision', [
    { groupId: 'item', lineIndex: 0, lineCount: 2, sourceLines: ['BOLD', 'فارسی'] },
  ]);
  assert.equal(styleCollisionRequests[0].style, 'bold');
  const splitHeaderRequests: any[] = [];
  const splitHeader = await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      splitHeaderRequests.push(rasterRequest);
      return { version: 1 as const, requestId: (rasterRequest as any).requestId, ok: true as const, unit: { ...unit, unitId: (rasterRequest as any).requestId } };
    },
  }, ['فارسی', 'native body', 'Address'], caps, 'split-header', [
    { groupId: 'business-header', lineIndex: 0, lineCount: 1 },
    { groupId: 'business-header', lineIndex: 2, lineCount: 1 },
  ]);
  assert.equal(splitHeaderRequests.length, 2);
  assert.equal(splitHeader.units.length, 2);
  assert.equal(splitHeader.units.every((entry) => entry.unit.unitId.startsWith('business-header-')), true);
  const sourceTextRequests: any[] = [];
  await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      sourceTextRequests.push(rasterRequest);
      return { version: 1, requestId: (rasterRequest as any).requestId, ok: true, unit: { unitId: (rasterRequest as any).requestId, financial: false, complete: true, bands: [twoRows] } };
    },
  }, ['فارسی {L}'], caps, 'source-text');
  assert.equal(sourceTextRequests[0].text, 'فارسی {L}');
  const fontBRequests: any[] = [];
  await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      const typedRequest = rasterRequest as any;
      fontBRequests.push(typedRequest);
      return { version: 1, requestId: typedRequest.requestId, ok: true, unit: { unitId: typedRequest.requestId, financial: false, complete: true, bands: [twoRows] } };
    },
  }, ['{CENTER}{FONT_B}فارسی{/FONT_B}{/CENTER}'], caps, 'font-b');
  assert.deepEqual(fontBRequests[0].styles, ['font-b']);
  assert.equal(fontBRequests[0].style, 'font-b');
  const presentationFormRequests: any[] = [];
  await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      presentationFormRequests.push(rasterRequest);
      return { version: 1 as const, requestId: (rasterRequest as any).requestId, ok: true as const, unit };
    },
  }, ['\uFB50'], caps, 'presentation-form');
  assert.equal(presentationFormRequests[0].direction, 'rtl');
  const kotHeaderGroups: any[] = [];
  const longKotDocument = buildKotDocument({
    stationName: 'ایستگاه',
    order: { orderNumber: 'ORDER-123456789012345678901234567890', createdAt: '2026-01-01T12:00:00.000Z', tableName: '', orderType: '' },
    items: [],
  }, {
    columns: 42,
    languages: ['fa'],
    baseDirection: 'rtl',
    locale: 'fa-IR',
    currencySymbol: '',
    trimDecimals: false,
    resolveLabel: (conceptId) => ({ conceptId, primary: conceptId }),
  });
  renderKotDocumentToLines(longKotDocument, {
    columns: 42,
    language: 'fa',
    locale: 'fa-IR',
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'full',
    capabilities: caps,
    rasterGroups: kotHeaderGroups,
  });
  assert.equal(kotHeaderGroups[0].sourceLines.some((line: string) => line.includes('ایستگاه')), true);
  assert.equal(kotHeaderGroups[0].sourceLines.some((line: string) => line.includes('ORDER-123456789012345678901234567890')), true);
  const jpyReceipt = renderCompactReceiptViaDocument(
    { items: [] },
    { total: 12.34, subtotal: 12.34, discount_amount: 0, tax_amount: 0, delivery_charge: 0, packaging_charge: 0, payment_details: '[]' },
    { country: 'JP', currency_symbol: '¥', name: 'Cafe', customer_name: '', customer_phone: '' },
    { columns: 42, language: 'en', isReprint: false, useUnicode: true, arabicShaping: false, cutMode: 'full', capabilities: caps },
  );
  assert.equal(jpyReceipt.lines.some((line) => line.includes('12.34')), false);
  const backendKotData = buildKotPrintData(
    { order_number: 'K-2', created_at: '2026-01-01T12:00:00.000Z' },
    [{ status: 'pending', product_name: 'Tea', quantity: 1, addons: '[{"name":"Extra sauce","quantity":2}]' }],
    'Kitchen',
  );
  assert.deepEqual(backendKotData.items[0]?.addons, [{ name: 'Extra sauce', quantity: 2 }]);
  const styledBanner = await renderUnsupportedRasterLines({
    render: async (rasterRequest) => ({
      version: 1 as const,
      requestId: (rasterRequest as any).requestId,
      ok: true as const,
      unit: { unitId: (rasterRequest as any).requestId, financial: false, complete: true, bands: [twoRows] },
    }),
  }, ['{STORE_NAME}{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}فارسی{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}'], caps, 'banner');
  assert.equal(styledBanner.failures.length, 0);
  assert.equal(styledBanner.units.length, 1);
  assert.equal(renderedLines.failures.length, 0);

  const blankLineRequests: any[] = [];
  const groupedHeader = await renderUnsupportedRasterLines({
    render: async (rasterRequest) => {
      blankLineRequests.push(rasterRequest);
      return { version: 1 as const, requestId: (rasterRequest as any).requestId, ok: true as const, unit: { ...unit, unitId: (rasterRequest as any).requestId } };
    },
  }, ['فارسی', '', '555-0100'], caps, 'header', [{ groupId: 'header', lineIndex: 0, lineCount: 3 }]);
  assert.equal(blankLineRequests.length, 3);
  assert.equal(blankLineRequests[1].text, ' ');
  assert.equal(groupedHeader.units[0]?.lineCount, 3);

  const failedGroup = await renderUnsupportedRasterLines({
    render: async () => ({ version: 1 as const, requestId: 'failed', ok: false as const, code: 'font-unavailable' as const, detail: 'missing' }),
  }, ['{CENTER}فارسی{/CENTER}', '{CENTER}555-0100{/CENTER}'], caps, 'failed', [{ groupId: 'customer', lineIndex: 0, lineCount: 2 }]);
  assert.equal(failedGroup.failures[0]?.lineCount, 2);
  const suppressed = buildEscPos(['{CENTER}فارسی{/CENTER}', '{CENTER}555-0100{/CENTER}'], false, {
    capabilities: caps,
    rasterFailures: failedGroup.failures,
  });
  assert.equal(suppressed.includes(0x35), false);
  const refusedFailedGroup = buildEscPos(['{FINANCIAL}فارسی', '555-0100'], false, {
    capabilities: caps,
    rasterFailures: [{ lineIndex: 0, lineCount: 2, financial: true }],
  });
  assert.equal(refusedFailedGroup.length, 0);

  const request = {
    version: 1 as const,
    requestId: 'r1',
    text: 'فارسی',
    widthDots: 576,
    maxBandHeight: 200,
    direction: 'rtl' as const,
    style: 'normal' as const,
    financial: false,
    maxLines: 2,
    bundledFont: { family: 'FloRaster', dataUrl: 'data:font/woff2;base64,AA==' },
  };
  const ipc = new EventEmitter();
  const webContents = new EventEmitter() as EventEmitter & {
    sent?: unknown;
    loadURL?: (url: string) => Promise<void>;
    send?: (channel: string, message: unknown) => void;
  };
  webContents.loadURL = async () => undefined;
  webContents.send = (_channel, message) => { webContents.sent = message; };
  const surface = new EventEmitter() as EventEmitter & {
    webContents: typeof webContents;
    isDestroyed: () => boolean;
    close: () => void;
  };
  surface.webContents = webContents;
  surface.isDestroyed = () => false;
  surface.close = () => surface.emit('closed');
  const renderer = new ChromiumRasterRenderer({
    timeoutMs: 100,
    ipc: ipc as any,
    windowFactory: () => surface as any,
  });
  ipc.emit('flo:raster-ready', { sender: webContents });
  const renderPromise = renderer.render(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual((webContents.sent as any).request, request);
  ipc.emit('flo:raster-result', { sender: webContents }, { version: 1, result: { version: 1, requestId: request.requestId, ok: true, unit } });
  assert.deepEqual(await renderPromise, { version: 1, requestId: request.requestId, ok: true, unit });
  renderer.destroy();
  assert.equal(isRasterRenderRequest(request), true);
  assert.equal(isRasterRenderRequest({ ...request, bundledFont: { ...request.bundledFont, dataUrl: 'https://example.invalid/font.woff2' } }), false);
  assert.equal(isRasterRenderRequest({ ...request, bundledFont: { ...request.bundledFont, dataUrl: null } }), false);
  assert.equal(isRasterRenderRequest({ ...request, bundledFont: { ...request.bundledFont, family: 'bad;url(x)' } }), false);
  assert.equal(isRasterRenderResult({ version: 1, requestId: 'r1', ok: true }), false);
  assert.equal(isRasterRenderResult({ version: 1, requestId: 'r1', ok: false, code: 'render-failed', detail: 'failed' }), true);

  console.log('Raster encoder and mixed-mode contract checks passed.');
}

void run();
