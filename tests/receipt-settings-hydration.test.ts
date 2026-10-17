/**
 * Receipt Settings Hydration Tests (ARCH-011b / Issue #1188)
 *
 * Verifies that:
 * 1. Receipt display settings (business address, phone, tax registration number,
 *    footer message, logo, and visibility flags) are hydrated into posSettings.
 * 2. Terminal-local hardware printer settings (paper size, print mode, device, unicode)
 *    remain strictly preserved and untouched during hydration.
 * 3. Clearing or updating fields updates posSettings accurately.
 * 4. Browser print generation (generateBillHtml) receives hydrated settings and renders
 *    the current backend store headers, footers, and tax info without visiting Settings.
 * 5. Backend GET /api/settings/business returns bill_footer_message and bill_template
 *    so the entire receipt display configuration is fetched in a single request.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock electron before importing main modules
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-receipt-settings-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { createApp, assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const { getDatabase } = require('../main/db');

// Dynamically resolve frontend modules for testing
function loadFrontendModules() {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
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
      posSettings: require('../frontend/src/store/pos-settings'),
      webPrint: require('../frontend/src/lib/printer/web-print'),
      i18n: require('../frontend/src/lib/i18n'),
    };
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }
}

const { posSettings, webPrint, i18n } = loadFrontendModules();
const { usePosSettingsStore } = posSettings;
const { generateBillHtml } = webPrint;

async function runTests() {
  console.log('==================================================');
  console.log('Receipt Settings Hydration Tests (ARCH-011b / #1188)');
  console.log('==================================================\n');

  // Load locale for browser bill rendering
  await i18n.loadLocaleMessages('en');

  // ── Test 1: hydrateReceiptSettings populates posSettings fields ──
  console.log('1. hydrateReceiptSettings populates receipt display settings in posSettings');
  const store = usePosSettingsStore.getState();

  // Reset store to initial defaults
  usePosSettingsStore.setState({
    billAddress: '',
    billPhone: '',
    billTaxRegistrationNumber: '',
    billFooterMessage: '',
    billShowLogo: false,
    billShowName: true,
    billShowAddress: true,
    billShowPhone: true,
    billShowTaxId: false,
    billShowTaxBreakdown: true,
    billShowCustomerName: true,
    billShowCustomerPhone: true,
    billDeliveryShowCustomerPhoneAlways: true,
    billShowTableNumber: true,
    receiptLogo: '',
    receiptLogoRaster: '',
    billTemplate: 'classic',
    billingType: 'postpaid',
    tablesRequired: true,
    // Custom terminal-local hardware settings to verify preservation
    printerPaperSize: 'thermal80',
    printerEnabled: true,
    printerPrintMode: 'browser',
    autoPrintKot: true,
    autoPrintBill: true,
    whatsappShareEnabled: false,
    defaultPrintMode: 'web',
    printerUseUnicode: true,
    printerArabicShaping: true,
    printerTrimDecimals: true,
  });

  const backendSettings = {
    business_address: '456 Ocean Boulevard, Suite 100, Vancouver, BC',
    business_phone: '+1 604-555-0199',
    tax_registration_number: 'CA123456789RT0001',
    bill_footer_message: 'Thank you for dining with us! Follow @blueharbor',
    bill_show_logo: true,
    receipt_logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY44YAAAAASUVORK5CYII=',
    receipt_logo_raster: '1,1:ff',
    bill_show_name: true,
    bill_show_address: true,
    bill_show_phone: true,
    bill_show_tax_id: true,
    bill_show_tax_breakdown: true,
    bill_show_customer_name: false,
    bill_show_customer_phone: true,
    bill_delivery_show_customer_phone_always: true,
    bill_show_table_number: true,
    bill_template: 'compact',
    billing_type: 'prepaid',
    tables_required: false,
  };

  store.hydrateReceiptSettings(backendSettings);

  const updatedState = usePosSettingsStore.getState();
  assertEqualOrThrow(
    updatedState.billAddress,
    '456 Ocean Boulevard, Suite 100, Vancouver, BC',
    'billAddress hydrated from business_address',
  );
  assertEqualOrThrow(
    updatedState.billPhone,
    '+1 604-555-0199',
    'billPhone hydrated from business_phone',
  );
  assertEqualOrThrow(
    updatedState.billTaxRegistrationNumber,
    'CA123456789RT0001',
    'billTaxRegistrationNumber hydrated from tax_registration_number',
  );
  assertEqualOrThrow(
    updatedState.billFooterMessage,
    'Thank you for dining with us! Follow @blueharbor',
    'billFooterMessage hydrated from bill_footer_message',
  );
  assertEqualOrThrow(updatedState.billShowLogo, true, 'billShowLogo hydrated');
  assertEqualOrThrow(
    updatedState.receiptLogo,
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY44YAAAAASUVORK5CYII=',
    'receiptLogo hydrated',
  );
  assertEqualOrThrow(updatedState.receiptLogoRaster, '1,1:ff', 'receiptLogoRaster hydrated');
  assertEqualOrThrow(updatedState.billShowTaxId, true, 'billShowTaxId hydrated');
  assertEqualOrThrow(updatedState.billShowCustomerName, false, 'billShowCustomerName hydrated');
  assertEqualOrThrow(updatedState.billTemplate, 'compact', 'billTemplate hydrated');
  assertEqualOrThrow(updatedState.billingType, 'prepaid', 'billingType hydrated');
  assertEqualOrThrow(updatedState.tablesRequired, false, 'tablesRequired hydrated');

  // ── Test 2: Terminal-local hardware settings remain preserved ──
  console.log('\n2. Terminal-local hardware printer settings remain preserved');
  assertEqualOrThrow(updatedState.printerPaperSize, 'thermal80', 'printerPaperSize preserved');
  assertEqualOrThrow(updatedState.printerEnabled, true, 'printerEnabled preserved');
  assertEqualOrThrow(updatedState.printerPrintMode, 'browser', 'printerPrintMode preserved');
  assertEqualOrThrow(updatedState.autoPrintKot, true, 'autoPrintKot preserved');
  assertEqualOrThrow(updatedState.autoPrintBill, true, 'autoPrintBill preserved');
  assertEqualOrThrow(updatedState.whatsappShareEnabled, false, 'whatsappShareEnabled preserved');
  assertEqualOrThrow(updatedState.defaultPrintMode, 'web', 'defaultPrintMode preserved');
  assertEqualOrThrow(updatedState.printerUseUnicode, true, 'printerUseUnicode preserved');
  assertEqualOrThrow(updatedState.printerArabicShaping, true, 'printerArabicShaping preserved');
  assertEqualOrThrow(updatedState.printerTrimDecimals, true, 'printerTrimDecimals preserved');

  // ── Test 3: Updating or clearing fields updates posSettings ──
  console.log('\n3. Re-hydration accurately updates or clears settings');
  store.hydrateReceiptSettings({
    business_address: '',
    bill_footer_message: 'New Season Greetings!',
    bill_show_logo: false,
    tax_registration_number: '',
  });

  const rehydrated = usePosSettingsStore.getState();
  assertEqualOrThrow(rehydrated.billAddress, '', 'cleared business_address updates billAddress to empty');
  assertEqualOrThrow(rehydrated.taxRegistrationNumber, undefined, 'form-only taxRegistrationNumber undefined');
  assertEqualOrThrow(rehydrated.billTaxRegistrationNumber, '', 'cleared tax_registration_number updates to empty');
  assertEqualOrThrow(rehydrated.billFooterMessage, 'New Season Greetings!', 'updated bill_footer_message reflected');
  assertEqualOrThrow(rehydrated.billShowLogo, false, 'billShowLogo updated to false');
  // Phone should remain from previous state since not passed in this partial update
  assertEqualOrThrow(rehydrated.billPhone, '+1 604-555-0199', 'omitted fields retain previous value');

  // ── Test 4: Browser print HTML reflects hydrated store settings ──
  console.log('\n4. Browser print generation reflects current backend store settings without visiting Settings');

  // Hydrate full store settings
  store.hydrateReceiptSettings({
    business_address: '789 Sunset Strip, Los Angeles, CA',
    business_phone: '+1 310-555-0144',
    tax_registration_number: 'US-987654321',
    bill_footer_message: 'Please keep this receipt for returns. Have a great day!',
    bill_show_logo: false,
    bill_show_name: true,
    bill_show_address: true,
    bill_show_phone: true,
    bill_show_tax_id: true,
    bill_show_tax_breakdown: true,
  });

  const currentState = usePosSettingsStore.getState();
  const sampleBill = {
    id: 999,
    order_id: 888,
    bill_number: 'BILL-1001',
    subtotal: 50.0,
    tax_total: 5.0,
    discount_total: 0,
    total: 55.0,
    balance: 0,
    payment_status: 'paid',
    created_at: '2026-10-17T12:00:00.000Z',
    items: [
      {
        id: 1,
        order_id: 888,
        product_name: 'Avocado Toast',
        quantity: 2,
        unit_price: 25.0,
        subtotal: 50.0,
      },
    ],
    payments: [
      {
        id: 1,
        bill_id: 999,
        payment_method: 'card',
        amount: 55.0,
        created_at: '2026-10-17T12:05:00.000Z',
      },
    ],
  };

  const sampleTenant = {
    id: 1,
    business_name: 'Sunset Cafe',
    country: 'US',
    currency: 'USD',
    timezone: 'America/Los_Angeles',
  };

  // Render receipt HTML using options directly sourced from posSettings
  const receiptHtml = generateBillHtml(sampleBill as any, sampleTenant as any, {
    paperSize: currentState.printerPaperSize,
    columns: 48,
    languages: ['en'],
    includeTaxId: currentState.billShowTaxId,
    taxRegistrationNumber:
      currentState.billShowTaxId && currentState.billTaxRegistrationNumber
        ? currentState.billTaxRegistrationNumber
        : undefined,
    address: currentState.billShowAddress && currentState.billAddress ? currentState.billAddress : undefined,
    phone: currentState.billShowPhone && currentState.billPhone ? currentState.billPhone : undefined,
    footerNote: currentState.billFooterMessage || undefined,
    businessName: sampleTenant.business_name,
    showBusinessName: currentState.billShowName,
    showLogo: currentState.billShowLogo,
    showTaxBreakdown: currentState.billShowTaxBreakdown,
  });

  assertOrThrow(
    receiptHtml.includes('789 Sunset Strip, Los Angeles, CA'),
    'Browser print receipt HTML contains hydrated business address',
  );
  assertOrThrow(
    receiptHtml.includes('+1 310-555-0144'),
    'Browser print receipt HTML contains hydrated business phone',
  );
  assertOrThrow(
    receiptHtml.includes('US-987654321'),
    'Browser print receipt HTML contains hydrated tax registration number',
  );
  assertOrThrow(
    receiptHtml.includes('Please keep this receipt for returns. Have a great day!'),
    'Browser print receipt HTML contains hydrated footer message',
  );
  assertOrThrow(
    receiptHtml.includes('Sunset Cafe'),
    'Browser print receipt HTML contains business name',
  );

  // ── Test 5: Backend API GET and PUT /api/settings/business ──
  console.log('\n5. Backend GET /api/settings/business returns bill_footer_message and bill_template');
  const { initDatabase, closeDatabase, now } = require('../main/db');
  initDatabase();
  const { startServer, seedOwnerUser, api } = require('./helpers/test-setup');
  const { settingsRoutes } = require('../main/routes/settings');
  const app = createApp({ '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);
  const db = getDatabase();
  const seedData = seedOwnerUser(db);

  try {
    // Seed backend settings in SQLite
    db.prepare(`
      INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
      ('business_name', 'Harbor POS Cafe', datetime('now')),
      ('business_address', '123 Pier Way, Seattle, WA', datetime('now')),
      ('business_phone', '+1 206-555-0100', datetime('now')),
      ('tax_registration_number', 'WA-777888999', datetime('now')),
      ('bill_footer_message', 'Fresh seafood daily. Thank you!', datetime('now')),
      ('bill_template', 'classic', datetime('now')),
      ('bill_show_logo', 'false', datetime('now')),
      ('bill_show_tax_id', 'true', datetime('now'))
    `).run();

    const getRes = await api(baseUrl, '/api/settings/business', {
      headers: seedData.authHeader,
    });
    assertEqualOrThrow(getRes.status, 200, 'GET /api/settings/business returns 200');
    assertEqualOrThrow(getRes.data.business_address, '123 Pier Way, Seattle, WA', 'business_address in API');
    assertEqualOrThrow(getRes.data.business_phone, '+1 206-555-0100', 'business_phone in API');
    assertEqualOrThrow(getRes.data.tax_registration_number, 'WA-777888999', 'tax_registration_number in API');
    assertEqualOrThrow(
      getRes.data.bill_footer_message,
      'Fresh seafood daily. Thank you!',
      'bill_footer_message in GET /api/settings/business',
    );
    assertEqualOrThrow(
      getRes.data.bill_template,
      'classic',
      'bill_template in GET /api/settings/business',
    );

    // Test updating bill_footer_message via PUT /api/settings/bill_footer_message
    const putRes = await api(baseUrl, '/api/settings/bill_footer_message', {
      method: 'PUT',
      headers: seedData.authHeader,
      body: {
        value: 'Updated footer: Visit us online!',
      },
    });
    assertEqualOrThrow(putRes.status, 200, 'PUT /api/settings/bill_footer_message accepts footer message');

    const updatedBusinessRes = await api(baseUrl, '/api/settings/business', {
      headers: seedData.authHeader,
    });
    assertEqualOrThrow(
      updatedBusinessRes.data.bill_footer_message,
      'Updated footer: Visit us online!',
      'GET /api/settings/business returns updated bill_footer_message',
    );

    // Verify direct hydration from the API response
    store.hydrateReceiptSettings(updatedBusinessRes.data);
    const finalState = usePosSettingsStore.getState();
    assertEqualOrThrow(
      finalState.billFooterMessage,
      'Updated footer: Visit us online!',
      'posSettings hydrated directly from API response',
    );
    assertEqualOrThrow(
      finalState.billAddress,
      '123 Pier Way, Seattle, WA',
      'posSettings retains address from API',
    );
  } finally {
    server.close();
  }

    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n==================================================');
  console.log('✓ All Receipt Settings Hydration tests passed successfully!');
  console.log('==================================================');
}

runTests().catch((err) => {
  console.error('\n✗ Test failed with error:', err);
  process.exit(1);
});
