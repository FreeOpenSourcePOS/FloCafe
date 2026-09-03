import assert from 'node:assert/strict';

import { buildEscPos, escPosToText, formatKOT } from '../main/printers/thermal';
import { resolvePrinterProfile } from '../main/printers/profiles';
import {
  GENERIC_THERMAL_CAPABILITIES,
  isThermalTextRepresentable,
  normalizeThermalText,
  selectThermalCodePage,
  type ThermalPrinterCapabilities,
} from '../shared/print/thermal-capabilities';

function loadFrontendKotEncoder(): typeof import('../frontend/src/lib/printer/kot-encoder') {
  const path = require('node:path') as typeof import('node:path');
  const moduleApi = require('node:module') as { _resolveFilename: (...args: any[]) => string };
  const originalResolveFilename = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let resolvedRequest = request;
    if (request === '@countries') resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
    else if (request.startsWith('@/')) resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
    else if (request.startsWith('@print/')) resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  try {
    return require('../frontend/src/lib/printer/kot-encoder');
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

const order = {
  order_number: 'CAP-001',
  type: 'dine_in',
  created_at: '2026-08-21 18:42:00',
  table: { name: '4' },
  customer: { name: 'Asha' },
  items: [{ quantity: 1, product_name: 'چای', status: 'pending', addons: [], special_instructions: '' }],
};

const latinCodePageCapabilities: ThermalPrinterCapabilities = {
  ...GENERIC_THERMAL_CAPABILITIES,
  encoding: { codePages: ['cp437', 'cp850', 'cp858'], preferredCodePage: 'cp437' },
  representability: { scripts: ['ascii', 'latin'] },
  transliteration: { enabled: false },
};

const shapingCapabilities: ThermalPrinterCapabilities = {
  ...GENERIC_THERMAL_CAPABILITIES,
  shaping: { arabic: true },
};

function outputPair(capabilities: ThermalPrinterCapabilities, arabicShaping: boolean): { backend: string; webusb: string; backendWarnings: any[]; webusbWarnings: any[] } {
  const backendWarnings: any[] = [];
  const backend = escPosToText(formatKOT(
    order,
    order.items,
    'Kitchen',
    42,
    false,
    'full',
    'en-US',
    { timeZone: 'UTC' },
    backendWarnings,
    arabicShaping,
    'en',
    capabilities,
  ));
  const webusbWarnings: any[] = [];
  const encoder = loadFrontendKotEncoder();
  const webusb = Buffer.from(encoder.buildKotBytes(order as any, {
    paperWidth: 58,
    language: 'en',
    stationName: 'Kitchen',
    locale: 'en-US',
    timezone: 'UTC',
    arabicShaping,
    capabilities,
  }, webusbWarnings)).toString('utf8');
  return { backend, webusb, backendWarnings, webusbWarnings };
}

function run(): void {
  const generic = resolvePrinterProfile({ profile_id: 'generic-escpos-80' });
  assert.deepEqual(generic.capabilities.encoding.codePages, ['ascii']);
  assert.equal(generic.capabilities.warnings.financialText, 'refuse');
  assert.equal(normalizeThermalText('Küche', generic.capabilities), 'Kueche');
  assert.equal(normalizeThermalText('Küche', generic.capabilities), normalizeThermalText('Küche', generic.capabilities));

  assert.equal(selectThermalCodePage('Cafe', latinCodePageCapabilities), 'cp437');
  assert.equal(selectThermalCodePage('€', latinCodePageCapabilities), 'cp858');
  assert.equal(isThermalTextRepresentable('€', latinCodePageCapabilities), true);
  assert.equal(isThermalTextRepresentable('עברית', latinCodePageCapabilities), false);
  const codePageBytes = buildEscPos(['À'], false, { capabilities: latinCodePageCapabilities });
  assert.equal(codePageBytes.includes(Buffer.from([0x1B, 0x74, 2])), true);

  const genericPair = outputPair(GENERIC_THERMAL_CAPABILITIES, false);
  assert.match(genericPair.backend, /Type: DINE IN|Type: Dine in/);
  assert.match(genericPair.webusb, /Type: Dine in/);
  assert.ok(genericPair.backendWarnings.some((warning) => warning.text.includes('چای')));
  assert.ok(genericPair.webusbWarnings.some((warning) => warning.text.includes('چای')));

  const shapedPair = outputPair(shapingCapabilities, true);
  assert.match(shapedPair.backend, /چای/);
  assert.match(shapedPair.webusb, /چای/);
  assert.equal(shapedPair.backendWarnings.some((warning) => warning.text.includes('چای')), false);
  assert.equal(shapedPair.webusbWarnings.some((warning) => warning.text.includes('چای')), false);

  console.log('Thermal capability parity: backend and WebUSB fixtures passed.');
}

run();
