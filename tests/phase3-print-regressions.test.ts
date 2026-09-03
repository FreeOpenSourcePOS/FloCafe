import assert from 'node:assert/strict';

import { formatKOT, escPosToText } from '../main/printers/thermal';
import { printLabel } from '../main/print/print-labels.generated';

const languages = ['en', 'es', 'de', 'tr', 'fil', 'fr', 'pt', 'fa'] as const;
const order = {
  order_number: 'KOT-PHASE3-001',
  type: 'dine_in',
  created_at: '2026-04-21 10:30:00',
  table: { name: 'T3' },
  customer: { name: 'Asha Kumar' },
  items: [
    { quantity: 1, product_name: 'Pending coffee', status: 'pending', addons: [{ name: 'Oat milk', quantity: 3 }], special_instructions: 'Less sugar' },
    { quantity: 1, product_name: 'Ready coffee', status: 'ready', addons: [], special_instructions: '' },
    { quantity: 1, product_name: 'Served coffee', status: 'served', addons: [], special_instructions: '' },
  ],
};

function loadFrontendModules(): {
  kotEncoder: typeof import('../frontend/src/lib/printer/kot-encoder');
  kotWebPrint: typeof import('../frontend/src/lib/printer/kot-web-print');
  taxBillEncoder: typeof import('../frontend/src/lib/printer/tax-bill-encoder');
  warnings: typeof import('../frontend/src/lib/printer/warnings');
  loadLocaleMessages: (language: any) => Promise<unknown>;
} {
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
    return {
      kotEncoder: require('../frontend/src/lib/printer/kot-encoder'),
      kotWebPrint: require('../frontend/src/lib/printer/kot-web-print'),
      taxBillEncoder: require('../frontend/src/lib/printer/tax-bill-encoder'),
      warnings: require('../frontend/src/lib/printer/warnings'),
      loadLocaleMessages: require('../frontend/src/lib/i18n/loader').loadLocaleMessages,
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

async function run(): Promise<void> {
  const frontend = loadFrontendModules();
  await Promise.all(languages.map((language) => frontend.loadLocaleMessages(language)));

  for (const language of languages) {
    const expectedTypes = ['dine_in', 'delivery', 'online', 'takeaway'].map((type) => ({
      type,
      label: printLabel(language, `pos.orderType${type === 'dine_in' ? 'DineIn' : type[0].toUpperCase() + type.slice(1)}` as any),
    }));
    const browserHtml = frontend.kotWebPrint.generateKotHtml(order as any, { language, stationName: 'Main Kitchen', timezone: 'UTC' });
    assert.match(browserHtml, new RegExp(`>${printLabel(language, 'print.kot.banner').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`), `${language}: browser banner`);
    assert.match(browserHtml, /KOT-PHASE3-001/, `${language}: browser order number`);
    assert.match(browserHtml, /Pending coffee/, `${language}: browser pending item`);
    assert.match(browserHtml, /Oat milk.*x3/, `${language}: browser preserves addon quantity`);
    assert.match(browserHtml, /Less sugar/, `${language}: browser preserves special-instruction content`);
    assert.match(browserHtml, /Asha Kumar/, `${language}: browser preserves customer field`);
    assert.doesNotMatch(browserHtml, /Ready coffee|Served coffee/, `${language}: browser filters served/ready items`);
    for (const { type, label } of expectedTypes) {
      const typeHtml = frontend.kotWebPrint.generateKotHtml({ ...order, type } as any, { language, stationName: 'Main Kitchen', timezone: 'UTC' });
      assert.match(typeHtml, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${language}: browser order type ${label}`);
    }

    const thermalWarnings: any[] = [];
    const thermalText = escPosToText(formatKOT(
      order,
      order.items,
      'Main Kitchen',
      42,
      false,
      'full',
      'en-US',
      { timeZone: 'UTC' },
      thermalWarnings,
      false,
      language,
    ));
    assert.match(thermalText, /KOT-PHASE3-001/, `${language}: thermal order number remains visible`);
    assert.match(thermalText, /Main Kitchen/, `${language}: thermal station remains visible`);
    assert.match(thermalText, /(?:Time|Hora|Uhrzeit|Saat|Oras|Heure)/, `${language}: thermal time remains visible`);
    assert.match(thermalText, /KITCHEN ORDER TICKET|COMANDA DE COCINA|KUECHENBESTELLSCHEIN|BON DE COMMANDE CUISINE|COMANDA DE COZINHA/, `${language}: thermal banner remains visible`);
    assert.match(thermalText, /Pending coffee/, `${language}: thermal pending item`);
    assert.match(thermalText, /\+ Oat milk x3/, `${language}: thermal preserves addon quantity`);
    assert.match(thermalText, />> Less sugar/, `${language}: thermal preserves special-instruction marker`);
    const localizedCustomerLine = `${printLabel(language, 'pos.customer')}: Asha Kumar`;
    const thermalCustomerLine = /[^\x00-\x7F]/.test(localizedCustomerLine) ? 'Customer: Asha Kumar' : localizedCustomerLine;
    assert.match(thermalText, new RegExp(thermalCustomerLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${language}: thermal preserves customer field`);
    assert.doesNotMatch(thermalText, /Ready coffee|Served coffee/, `${language}: thermal filters served/ready items`);
    for (const { type, label } of expectedTypes) {
      const typeOrder = { ...order, type };
      const localizedTypeLine = `${printLabel(language, 'print.kot.type')}: ${label}`;
      const thermalTypeLine = /[^\x00-\x7F]/.test(localizedTypeLine)
        ? `Type: ${type.replace(/_/g, ' ').toUpperCase()}`
        : localizedTypeLine;
      const typeThermalText = escPosToText(formatKOT(
        typeOrder,
        typeOrder.items,
        'Main Kitchen',
        42,
        false,
        'full',
        'en-US',
        { timeZone: 'UTC' },
        [],
        false,
        language,
      ));
      assert.ok(typeThermalText.includes(thermalTypeLine), `${language}: thermal order type ${thermalTypeLine}`);
    }

    const webUsbWarnings: any[] = [];
    const webUsbText = Buffer.from(frontend.kotEncoder.buildKotBytes(order as any, {
      paperWidth: 58,
      language,
      stationName: 'Main Kitchen',
      locale: 'en-US',
      timezone: 'UTC',
    }, webUsbWarnings)).toString('utf8');
    assert.match(webUsbText, /KOT-PHASE3-001/, `${language}: WebUSB order number remains visible`);
    assert.match(webUsbText, /Main Kitchen/, `${language}: WebUSB station remains visible`);
    assert.match(webUsbText, /Pending coffee/, `${language}: WebUSB pending item`);
    assert.match(webUsbText, /\+ Oat milk x3/, `${language}: WebUSB preserves addon quantity`);
    assert.match(webUsbText, />> Less sugar/, `${language}: WebUSB preserves special-instruction marker`);
    const webUsbCustomerLine = /[^\x00-\x7F]/.test(localizedCustomerLine) ? 'Customer: Asha Kumar' : localizedCustomerLine;
    assert.match(webUsbText, new RegExp(webUsbCustomerLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${language}: WebUSB preserves customer field`);
    assert.doesNotMatch(webUsbText, /Ready coffee|Served coffee/, `${language}: WebUSB filters served/ready items`);
    for (const { type, label } of expectedTypes) {
      const typeOrder = { ...order, type };
      const localizedTypeLine = `${printLabel(language, 'print.kot.type')}: ${label}`;
      const webUsbTypeLine = /[^\x00-\x7F]/.test(localizedTypeLine)
        ? `Type: ${type.replace(/_/g, ' ').toUpperCase()}`
        : localizedTypeLine;
      const typeWebUsbText = Buffer.from(frontend.kotEncoder.buildKotBytes(typeOrder as any, {
        paperWidth: 58,
        language,
        stationName: 'Main Kitchen',
        locale: 'en-US',
        timezone: 'UTC',
      }, [])).toString('utf8');
      assert.ok(typeWebUsbText.includes(webUsbTypeLine), `${language}: WebUSB order type ${webUsbTypeLine}`);
    }
  }

  const nonAsciiMetadataOrder = {
    ...order,
    order_number: 'شماره-001',
    table: { name: 'میز ۱' },
    customer: { name: 'مشتری' },
  };
  const metadataThermalWarnings: any[] = [];
  const metadataThermalText = escPosToText(formatKOT(
    nonAsciiMetadataOrder,
    nonAsciiMetadataOrder.items,
    'آشپزخانه',
    42,
    false,
    'full',
    'fa-IR',
    { timeZone: 'UTC' },
    metadataThermalWarnings,
    false,
    'fa',
  ));
  assert.match(metadataThermalText, /Station: \[UNSUPPORTED\]/, 'thermal KOT preserves non-ASCII station visibility with an explicit placeholder');
  assert.match(metadataThermalText, /Order #\[UNSUPPORTED\]/, 'thermal KOT preserves non-ASCII order-number visibility with an explicit placeholder');
  assert.match(metadataThermalText, /Table: \[UNSUPPORTED\]/, 'thermal KOT preserves non-ASCII table visibility with an explicit placeholder');

  const metadataWebUsbWarnings: any[] = [];
  const metadataWebUsbText = Buffer.from(frontend.kotEncoder.buildKotBytes(nonAsciiMetadataOrder as any, {
    paperWidth: 58,
    language: 'fa',
    stationName: 'آشپزخانه',
    locale: 'fa-IR',
    timezone: 'UTC',
  }, metadataWebUsbWarnings)).toString('utf8');
  assert.match(metadataWebUsbText, /Station: \[UNSUPPORTED\]/, 'WebUSB KOT preserves non-ASCII station visibility with an explicit placeholder');
  assert.match(metadataWebUsbText, /Order #\[UNSUPPORTED\]/, 'WebUSB KOT preserves non-ASCII order-number visibility with an explicit placeholder');
  assert.match(metadataWebUsbText, /Table: \[UNSUPPORTED\]/, 'WebUSB KOT preserves non-ASCII table visibility with an explicit placeholder');
  assert.match(metadataWebUsbText, /Customer: \[UNSUPPORTED\]/, 'WebUSB KOT preserves non-ASCII customer visibility with an explicit placeholder');

  const shapedMetadataOrder = {
    ...order,
    order_number: 'ORD-Café-001',
    table: { name: 'Table Café' },
    customer: { name: 'Customer Café' },
  };
  const shapedMetadataThermalText = escPosToText(formatKOT(
    shapedMetadataOrder,
    shapedMetadataOrder.items,
    'Kitchen Café',
    42,
    false,
    'full',
    'en-US',
    { timeZone: 'UTC' },
    [],
    true,
    'en',
  ));
  assert.match(shapedMetadataThermalText, /Station: \[UNSUPPORTED\]/, 'shaped thermal KOT preserves non-Arabic station visibility');
  assert.match(shapedMetadataThermalText, /Order #\[UNSUPPORTED\]/, 'shaped thermal KOT preserves non-Arabic order-number visibility');
  assert.match(shapedMetadataThermalText, /Table: \[UNSUPPORTED\]/, 'shaped thermal KOT preserves non-Arabic table visibility');

  const shapedMetadataWebUsbText = Buffer.from(frontend.kotEncoder.buildKotBytes(shapedMetadataOrder as any, {
    paperWidth: 58,
    language: 'en',
    stationName: 'Kitchen Café',
    locale: 'en-US',
    timezone: 'UTC',
    arabicShaping: true,
  }, [])).toString('utf8');
  assert.match(shapedMetadataWebUsbText, /Station: \[UNSUPPORTED\]/, 'shaped WebUSB KOT preserves non-Arabic station visibility');
  assert.match(shapedMetadataWebUsbText, /Order #\[UNSUPPORTED\]/, 'shaped WebUSB KOT preserves non-Arabic order-number visibility');
  assert.match(shapedMetadataWebUsbText, /Table: \[UNSUPPORTED\]/, 'shaped WebUSB KOT preserves non-Arabic table visibility');
  assert.match(shapedMetadataWebUsbText, /Customer: \[UNSUPPORTED\]/, 'shaped WebUSB KOT preserves non-Arabic customer visibility');

  const taxWarnings: any[] = [];
  const taxBillText = Buffer.from(frontend.taxBillEncoder.buildTaxBillBytes({
    bill_number: 'INV-PHASE3-001',
    subtotal: 100,
    discount_amount: 0,
    tax_amount: 10,
    total: 110,
    order: {
      created_at: '2026-04-21 10:30:00',
      items: [{ product_name: 'Coffee', quantity: 1, total: 100, addons: [] }],
    },
  } as any, { business_name: 'Cafe', country: 'IR', currency: 'IRR', timezone: 'UTC' } as any, {
    rawEscPos: true,
    useUnicode: false,
    language: 'en',
  }, taxWarnings)).toString('utf8');
  assert.match(taxBillText, /Date: Apr 21, 2026/, 'raw tax bill uses an explicit ASCII-safe fallback for Persian country data');

  const germanTaxWarnings: any[] = [];
  const germanTaxText = Buffer.from(frontend.taxBillEncoder.buildTaxBillBytes({
    bill_number: 'INV-PHASE3-003', subtotal: 100, discount_amount: 0, tax_amount: 0, total: 100,
    order: { created_at: '2026-03-21 10:30:00', items: [{ product_name: 'Coffee', quantity: 1, total: 100, addons: [] }] },
  } as any, { business_name: 'Cafe', country: 'DE', currency: 'EUR', timezone: 'UTC' } as any, {
    rawEscPos: true, useUnicode: false, language: 'de',
  }, germanTaxWarnings)).toString('utf8');
  assert.match(germanTaxText, /Datum: .*Maer/, 'raw tax bill keeps a representable country locale date');
  assert.doesNotMatch(germanTaxWarnings.map((warning) => warning.text).join('\n'), /Datum:/, 'raw tax bill date fallback does not create a date omission warning');

  const taxHeaderWarnings: any[] = [];
  frontend.taxBillEncoder.buildTaxBillBytes({
    bill_number: 'INV-PHASE3-002', subtotal: 100, discount_amount: 0, tax_amount: 0, total: 100,
    order: { created_at: '2026-04-21 10:30:00', items: [{ product_name: 'Coffee', quantity: 1, total: 100, addons: [] }] },
  } as any, { business_name: 'Cafe', country: 'IN', currency: 'INR' } as any, {
    rawEscPos: true, useUnicode: false, language: 'fa',
  }, taxHeaderWarnings);
  assert.ok(taxHeaderWarnings.some((warning) => /اقلام|تعداد|نرخ|مبلغ/.test(warning.text)), 'tax-bill item header uses the safe text warning path');

  const unsupportedFinancialWarnings: any[] = [];
  const unsupportedFinancialBytes = frontend.taxBillEncoder.buildTaxBillBytes({
    bill_number: 'INV-PHASE3-004', subtotal: 100, discount_amount: 0, tax_amount: 0, total: 100,
    order: { created_at: '2026-04-21 10:30:00', items: [{ product_name: 'قهوه', quantity: 1, total: 100, addons: [] }] },
  } as any, { business_name: 'Cafe', country: 'IN', currency: 'INR' } as any, {
    rawEscPos: true, useUnicode: false, language: 'fa',
  }, unsupportedFinancialWarnings);
  assert.ok(frontend.warnings.hasFinancialPrintWarning(unsupportedFinancialWarnings), 'unsupported tax-bill item rows are classified as financial');
  assert.doesNotMatch(Buffer.from(unsupportedFinancialBytes).toString('utf8'), /قهوه/, 'unsupported tax-bill item text is not transported');

  const truncatedUnsupportedName = `${'A'.repeat(40)}قهوه`;
  const truncatedUnsupportedWarnings: any[] = [];
  frontend.taxBillEncoder.buildTaxBillBytes({
    bill_number: 'INV-PHASE3-005', subtotal: 100, discount_amount: 0, tax_amount: 0, total: 100,
    order: { created_at: '2026-04-21 10:30:00', items: [{ product_name: truncatedUnsupportedName, quantity: 1, total: 100, addons: [] }] },
  } as any, { business_name: 'Cafe', country: 'IN', currency: 'INR' } as any, {
    rawEscPos: true, useUnicode: false, language: 'fa',
  }, truncatedUnsupportedWarnings);
  assert.ok(frontend.warnings.hasFinancialPrintWarning(truncatedUnsupportedWarnings), 'financial safety checks the full item name before layout truncation');
  assert.ok(truncatedUnsupportedWarnings.some((warning) => warning.text.includes(truncatedUnsupportedName)), 'financial warning preserves the unsupported suffix that layout would truncate');

  const truncatedUnsupportedAddonName = `${'A'.repeat(40)}قهوه`;
  const truncatedUnsupportedAddonWarnings: any[] = [];
  frontend.taxBillEncoder.buildTaxBillBytes({
    bill_number: 'INV-PHASE3-006', subtotal: 110, discount_amount: 0, tax_amount: 0, total: 110,
    order: { created_at: '2026-04-21 10:30:00', items: [{ product_name: 'Coffee', quantity: 1, total: 100, addons: [{ name: truncatedUnsupportedAddonName, price: 10 }] }] },
  } as any, { business_name: 'Cafe', country: 'IN', currency: 'INR' } as any, {
    rawEscPos: true, useUnicode: false, language: 'fa',
  }, truncatedUnsupportedAddonWarnings);
  assert.ok(frontend.warnings.hasFinancialPrintWarning(truncatedUnsupportedAddonWarnings), 'financial safety checks priced add-ons before layout truncation');
  assert.ok(truncatedUnsupportedAddonWarnings.some((warning) => warning.text.includes(truncatedUnsupportedAddonName)), 'priced add-on warning preserves unsupported text that layout would truncate');

  const faShapedWarnings: any[] = [];
  const faGenericWarnings: any[] = [];
  const faGenericText = escPosToText(formatKOT(order, order.items, 'Main Kitchen', 42, false, 'full', 'fa-IR', { timeZone: 'UTC' }, faGenericWarnings, false, 'fa'));
  assert.match(faGenericText, /Type: DINE IN/, 'generic thermal path keeps an ASCII order type fallback');
  const faShapedText = escPosToText(formatKOT(order, order.items, 'Main Kitchen', 42, false, 'full', 'fa-IR', { timeZone: 'UTC' }, faShapedWarnings, true, 'fa'));
  assert.match(faShapedText, /برگ سفارش آشپزخانه/, 'fa shaping path keeps localized KOT banner');
  assert.match(faShapedText, /نوع: خوردن در محل/, 'fa shaping path keeps localized order type');

  console.log(`Phase 3 print regressions: ${languages.length} locales covered across browser, backend thermal-safe, and WebUSB KOT paths.`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
