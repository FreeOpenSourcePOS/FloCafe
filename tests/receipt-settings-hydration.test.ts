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
  Module._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options?: any,
  ) {
    let resolvedRequest = request;
    if (request === '@countries') {
      resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
    } else if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
    } else if (request.startsWith('@print/')) {
      resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
    } else if (request.startsWith('@shared/')) {
      resolvedRequest = path.resolve(__dirname, '../shared', request.slice('@shared/'.length));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };

  try {
    const apiModule = require('../frontend/src/lib/api');
    return {
      posSettings: require('../frontend/src/store/pos-settings'),
      webPrint: require('../frontend/src/lib/printer/web-print'),
      i18n: require('../frontend/src/lib/i18n'),
      receiptSync: require('../frontend/src/hooks/useReceiptSettingsSync'),
      printerHook: require('../frontend/src/hooks/usePrinter'),
      authStore: require('../frontend/src/store/auth'),
      frontendApi: apiModule.default || apiModule,
    };
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }
}

const { posSettings, webPrint, i18n, receiptSync, printerHook, authStore, frontendApi } =
  loadFrontendModules();
const { usePosSettingsStore } = posSettings;
const { generateBillHtml } = webPrint;
const {
  canSyncReceiptSettings,
  syncReceiptSettings,
  ensureReceiptSettingsLoaded,
  resetReceiptSettingsSyncForTests,
} = receiptSync;
const { usePrinterStore, PrintCancelledOnTenantChangeError, isPrintCancelledOnTenantChangeError } =
  printerHook;
const { useAuthStore } = authStore;

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
    receipt_logo:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY44YAAAAASUVORK5CYII=',
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
  assertEqualOrThrow(
    rehydrated.billAddress,
    '',
    'cleared business_address updates billAddress to empty',
  );
  assertEqualOrThrow(
    rehydrated.taxRegistrationNumber,
    undefined,
    'form-only taxRegistrationNumber undefined',
  );
  assertEqualOrThrow(
    rehydrated.billTaxRegistrationNumber,
    '',
    'cleared tax_registration_number updates to empty',
  );
  assertEqualOrThrow(
    rehydrated.billFooterMessage,
    'New Season Greetings!',
    'updated bill_footer_message reflected',
  );
  assertEqualOrThrow(rehydrated.billShowLogo, false, 'billShowLogo updated to false');
  // Phone should remain from previous state since not passed in this partial update
  assertEqualOrThrow(
    rehydrated.billPhone,
    '+1 604-555-0199',
    'omitted fields retain previous value',
  );

  // ── Test 4: Browser print HTML reflects hydrated store settings ──
  console.log(
    '\n4. Browser print generation reflects current backend store settings without visiting Settings',
  );

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
    address:
      currentState.billShowAddress && currentState.billAddress
        ? currentState.billAddress
        : undefined,
    phone:
      currentState.billShowPhone && currentState.billPhone ? currentState.billPhone : undefined,
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
  console.log(
    '\n5. Backend GET /api/settings/business returns bill_footer_message and bill_template',
  );
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
    assertEqualOrThrow(
      getRes.data.business_address,
      '123 Pier Way, Seattle, WA',
      'business_address in API',
    );
    assertEqualOrThrow(getRes.data.business_phone, '+1 206-555-0100', 'business_phone in API');
    assertEqualOrThrow(
      getRes.data.tax_registration_number,
      'WA-777888999',
      'tax_registration_number in API',
    );
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
    assertEqualOrThrow(
      putRes.status,
      200,
      'PUT /api/settings/bill_footer_message accepts footer message',
    );

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

    // ── Test 6: Role-based authorization on GET /api/settings/business vs protected settings ──
    console.log(
      '\n6. Role-based authorization allows bill/order roles to read storefront settings without granting admin access',
    );
    const { getJWTSecret } = require('../main/routes/auth');
    const jwt = require('jsonwebtoken');
    const bcrypt = require('bcryptjs');

    function createTestUser(id: string, name: string, email: string, role: string) {
      const passwordHash = bcrypt.hashSync('testpass123', 10);
      db.prepare(
        `INSERT OR REPLACE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, email, passwordHash, role, 1, now(), now());
      const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
      return { id, token, authHeader: { Authorization: `Bearer ${token}` } };
    }

    const cashier = createTestUser('cashier-001', 'Test Cashier', 'cashier@test.local', 'cashier');
    const serverStaff = createTestUser('server-001', 'Test Server', 'server@test.local', 'server');
    const chef = createTestUser('chef-001', 'Test Chef', 'chef@test.local', 'chef');

    // Restrict cashier, server, and chef from general settings access via user permission overrides
    db.prepare(
      `INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
       VALUES (?, 'settings.view', 'deny', 'owner-test-001', ?, ?)`,
    ).run('cashier-001', now(), now());
    db.prepare(
      `INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
       VALUES (?, 'settings.view', 'deny', 'owner-test-001', ?, ?)`,
    ).run('server-001', now(), now());
    db.prepare(
      `INSERT OR REPLACE INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
       VALUES (?, 'settings.view', 'deny', 'owner-test-001', ?, ?)`,
    ).run('chef-001', now(), now());

    // Cashier (bills.read, bills.print, bills.generate) can read business settings for printing receipts even without settings.view
    const cashierGetRes = await api(baseUrl, '/api/settings/business', {
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(cashierGetRes.status, 200, 'Cashier GET /api/settings/business returns 200');
    assertEqualOrThrow(
      cashierGetRes.data.business_address,
      '123 Pier Way, Seattle, WA',
      'Cashier reads storefront address',
    );

    // Server (orders.read only) cannot read business settings (preserves charges-engine security boundary)
    const serverGetRes = await api(baseUrl, '/api/settings/business', {
      headers: serverStaff.authHeader,
    });
    assertEqualOrThrow(serverGetRes.status, 403, 'Server GET /api/settings/business returns 403');

    // Chef (only kitchen.use, no billing or orders.read, and settings.view denied) cannot read business settings
    const chefGetRes = await api(baseUrl, '/api/settings/business', {
      headers: chef.authHeader,
    });
    assertEqualOrThrow(chefGetRes.status, 403, 'Chef GET /api/settings/business returns 403');

    // Unauthenticated request cannot read business settings
    const unauthGetRes = await api(baseUrl, '/api/settings/business');
    assertEqualOrThrow(
      unauthGetRes.status,
      401,
      'Unauthenticated GET /api/settings/business returns 401',
    );

    // Cashier CANNOT mutate business settings (requires settings.manage)
    const cashierPutRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: cashier.authHeader,
      body: { business_name: 'Hacked Cafe' },
    });
    assertEqualOrThrow(cashierPutRes.status, 403, 'Cashier PUT /api/settings/business returns 403');

    // Cashier CANNOT read general tax settings (requires settings.view)
    const cashierTaxRes = await api(baseUrl, '/api/settings/tax', {
      headers: cashier.authHeader,
    });
    assertEqualOrThrow(cashierTaxRes.status, 403, 'Cashier GET /api/settings/tax returns 403');

    // ── Test 7: Client-side permission helper & ensureReceiptSettingsLoaded prevent startup race ──
    console.log(
      '\n7. Client-side permission helper & ensureReceiptSettingsLoaded prevent startup race',
    );
    // canSyncReceiptSettings checks role/permissions
    assertEqualOrThrow(
      canSyncReceiptSettings(null),
      false,
      'canSyncReceiptSettings(null) is false',
    );
    assertEqualOrThrow(
      canSyncReceiptSettings({ role: 'owner', permission_ids: ['settings.view'] }),
      true,
      'canSyncReceiptSettings(owner) with settings.view is true',
    );
    assertEqualOrThrow(
      canSyncReceiptSettings({ role: 'cashier', permission_ids: ['bills.read', 'bills.print'] }),
      true,
      'canSyncReceiptSettings(cashier) with bills permissions is true',
    );
    assertEqualOrThrow(
      canSyncReceiptSettings({ role: 'server', permission_ids: ['orders.read'] }),
      false,
      'canSyncReceiptSettings(server) with orders.read only is false',
    );
    assertEqualOrThrow(
      canSyncReceiptSettings({ role: 'chef', permission_ids: ['kitchen.use'] }),
      false,
      'canSyncReceiptSettings(chef) with only kitchen.use is false',
    );
    assertEqualOrThrow(
      canSyncReceiptSettings({ role: 'chef', permission_ids: ['kitchen.use', 'bills.print'] }),
      true,
      'canSyncReceiptSettings with bills.print override is true',
    );
    assertEqualOrThrow(
      canSyncReceiptSettings({ role: 'invalid_role' as any }),
      false,
      'canSyncReceiptSettings(invalid_role) is false',
    );

    // Test ensureReceiptSettingsLoaded with mocked tenant in authStore
    resetReceiptSettingsSyncForTests();
    usePosSettingsStore.setState({
      billAddress: '',
      billFooterMessage: '',
    });
    frontendApi.defaults.baseURL = `${baseUrl}/api`;
    frontendApi.defaults.headers.common['Authorization'] = `Bearer ${cashier.token}`;

    useAuthStore.setState({
      currentTenant: {
        id: 'tenant-1',
        business_name: 'Test Tenant',
        role: 'cashier',
        permission_ids: ['bills.read', 'bills.print'],
      } as any,
    });

    // Calling ensureReceiptSettingsLoaded joins in-flight requests and resolves
    const ensurePromise1 = ensureReceiptSettingsLoaded();
    const ensurePromise2 = ensureReceiptSettingsLoaded();
    await Promise.all([ensurePromise1, ensurePromise2]);

    const stateAfterSync = usePosSettingsStore.getState();
    assertEqualOrThrow(
      stateAfterSync.billAddress,
      '123 Pier Way, Seattle, WA',
      'ensureReceiptSettingsLoaded hydrates billAddress from API',
    );
    assertEqualOrThrow(
      stateAfterSync.billFooterMessage,
      'Updated footer: Visit us online!',
      'ensureReceiptSettingsLoaded hydrates billFooterMessage from API',
    );

    // Subsequent call resolves immediately
    await ensureReceiptSettingsLoaded();

    delete frontendApi.defaults.headers.common['Authorization'];
    frontendApi.defaults.baseURL = '/api';

    // Verify offline resilience: failure resolves without throwing
    resetReceiptSettingsSyncForTests();
    useAuthStore.setState({
      currentTenant: {
        id: 'tenant-1',
        role: 'unauthorized_role',
      } as any,
    });
    // For unauthorized role or network failure, ensureReceiptSettingsLoaded resolves cleanly
    await ensureReceiptSettingsLoaded();

    // ── Test 8: Receipt settings hydration under network rejection ──
    console.log(
      '\n8. Receipt settings hydration recovers cleanly after transient network rejection',
    );
    resetReceiptSettingsSyncForTests();
    usePosSettingsStore.setState({
      billAddress: 'Default Address',
      billFooterMessage: 'Default Footer',
    });

    frontendApi.defaults.baseURL = `${baseUrl}/api`;
    frontendApi.defaults.headers.common['Authorization'] = `Bearer ${cashier.token}`;
    useAuthStore.setState({
      currentTenant: {
        id: 'tenant-1',
        business_name: 'Test Tenant',
        role: 'cashier',
        permission_ids: ['bills.read', 'bills.print'],
      } as any,
    });

    // 1. Initial attempt rejects due to network error; resolves cleanly without throwing
    const originalGet = frontendApi.get;
    try {
      frontendApi.get = () =>
        Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      await ensureReceiptSettingsLoaded();
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        'Default Address',
        'Settings remain on default when network rejects',
      );
      assertEqualOrThrow(
        usePosSettingsStore.getState().billFooterMessage,
        'Default Footer',
        'Footer remains on default when network rejects',
      );
    } finally {
      frontendApi.get = originalGet;
    }

    // 2. Retry via ensureReceiptSettingsLoaded(): detects not hydrated and recovers cleanly
    await ensureReceiptSettingsLoaded();
    const recoveredState = usePosSettingsStore.getState();
    assertEqualOrThrow(
      recoveredState.billAddress,
      '123 Pier Way, Seattle, WA',
      'billAddress hydrates cleanly after network recovery',
    );
    assertEqualOrThrow(
      recoveredState.billFooterMessage,
      'Updated footer: Visit us online!',
      'billFooterMessage hydrates cleanly after network recovery',
    );

    // ── Test 9: Tenant switch bypasses 60s throttle and ignores stale in-flight responses ──
    console.log(
      '\n9. Tenant switch within 60s throttle window immediately re-syncs and ignores stale in-flight responses',
    );
    resetReceiptSettingsSyncForTests();
    usePosSettingsStore.setState({
      billAddress: '',
      billFooterMessage: '',
    });

    const originalGetForTenantSwitch = frontendApi.get;
    try {
      let fetchCalls = 0;
      const tenantResponses: Record<string, any> = {
        'tenant-a': {
          business_address: '100 Alpha Ave, Austin, TX',
          bill_footer_message: 'Welcome to Alpha Cafe',
        },
        'tenant-b': {
          business_address: '200 Bravo Blvd, Boston, MA',
          bill_footer_message: 'Welcome to Bravo Bistro',
        },
      };

      frontendApi.get = async () => {
        fetchCalls += 1;
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        return { data: tenantResponses[activeTenantId] };
      };

      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });

      await syncReceiptSettings();
      assertEqualOrThrow(fetchCalls, 1, 'initial tenant-a sync triggers 1 fetch');
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '100 Alpha Ave, Austin, TX',
        'tenant-a address hydrated',
      );
      assertEqualOrThrow(
        usePosSettingsStore.getState().billFooterMessage,
        'Welcome to Alpha Cafe',
        'tenant-a footer hydrated',
      );

      // Same tenant within 60s throttle window should be a no-op
      await syncReceiptSettings();
      assertEqualOrThrow(fetchCalls, 1, 'same-tenant sync within 60s throttle window is skipped');

      // Switch to tenant-b within the 60s throttle window -> must bypass throttle and re-sync immediately
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });

      await syncReceiptSettings();
      assertEqualOrThrow(
        fetchCalls,
        2,
        'switching currentTenant within 60s throttle window forces immediate fetch',
      );
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '200 Bravo Blvd, Boston, MA',
        'tenant-b address hydrated immediately on tenant switch',
      );
      assertEqualOrThrow(
        usePosSettingsStore.getState().billFooterMessage,
        'Welcome to Bravo Bistro',
        'tenant-b footer hydrated immediately on tenant switch',
      );

      // Verify stale in-flight response from tenant-a cannot overwrite tenant-b after tenant switch
      resetReceiptSettingsSyncForTests();
      usePosSettingsStore.setState({
        billAddress: 'Initial Address',
        billFooterMessage: 'Initial Footer',
      });

      let resolveTenantA!: (value: any) => void;
      const tenantAPromise = new Promise((resolve) => {
        resolveTenantA = resolve;
      });

      frontendApi.get = (url: string) => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        if (activeTenantId === 'tenant-a' && url === '/settings/business') {
          return tenantAPromise;
        }
        return Promise.resolve({ data: tenantResponses[activeTenantId] });
      };

      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });

      // Start in-flight sync for tenant-a (does not resolve yet)
      const inFlightA = syncReceiptSettings();

      // Switch to tenant-b while tenant-a request is still in flight
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });

      // Trigger tenant-b sync while tenant-a fetch is still in flight
      await syncReceiptSettings();
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '200 Bravo Blvd, Boston, MA',
        'tenant-b syncs immediately even while tenant-a fetch is still in flight',
      );

      // Resolve stale tenant-a response after tenant-b has already hydrated
      resolveTenantA({ data: tenantResponses['tenant-a'] });
      await inFlightA;

      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '200 Bravo Blvd, Boston, MA',
        'stale in-flight response from tenant-a does not overwrite tenant-b settings in posSettings',
      );
      assertEqualOrThrow(
        usePosSettingsStore.getState().billFooterMessage,
        'Welcome to Bravo Bistro',
        'stale in-flight response from tenant-a does not overwrite tenant-b footer in posSettings',
      );

      // Also verify stale in-flight response resolving before tenant-b sync starts leaves tenant-b unthrottled
      resetReceiptSettingsSyncForTests();
      usePosSettingsStore.setState({
        billAddress: 'Initial Address',
        billFooterMessage: 'Initial Footer',
      });
      let resolveStaleA!: (value: any) => void;
      const staleAPromise = new Promise((resolve) => {
        resolveStaleA = resolve;
      });
      frontendApi.get = () => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        if (activeTenantId === 'tenant-a') {
          return staleAPromise;
        }
        return Promise.resolve({ data: tenantResponses[activeTenantId] });
      };
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const pendingStaleA = syncReceiptSettings();
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      resolveStaleA({ data: tenantResponses['tenant-a'] });
      await pendingStaleA;
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        'Initial Address',
        'stale in-flight response resolving before new sync does not overwrite posSettings',
      );
      await syncReceiptSettings();
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '200 Bravo Blvd, Boston, MA',
        'subsequent tenant-b sync remains unthrottled after stale tenant-a response',
      );

      // Verify ensureReceiptSettingsLoaded also re-hydrates when tenant switches
      frontendApi.get = async () => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        return { data: tenantResponses[activeTenantId] };
      };
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      await ensureReceiptSettingsLoaded();
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '100 Alpha Ave, Austin, TX',
        'ensureReceiptSettingsLoaded re-hydrates when currentTenant changes',
      );

      // Verify A finishing while deferred B remains pending preserves B's in-flight syncPromise
      resetReceiptSettingsSyncForTests();
      let resolveDeferredA!: (value: any) => void;
      const deferredAPromise = new Promise((resolve) => {
        resolveDeferredA = resolve;
      });
      let resolveDeferredB!: (value: any) => void;
      const deferredBPromise = new Promise((resolve) => {
        resolveDeferredB = resolve;
      });
      let deferredBFetchCount = 0;
      frontendApi.get = () => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        if (activeTenantId === 'tenant-a') {
          return deferredAPromise;
        }
        deferredBFetchCount += 1;
        return deferredBPromise;
      };
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const deferredFlightA = syncReceiptSettings();
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const deferredFlightB1 = syncReceiptSettings();
      assertEqualOrThrow(deferredBFetchCount, 1, 'initial tenant-b sync starts 1 deferred fetch');

      // Release A first while B is still pending
      resolveDeferredA({ data: tenantResponses['tenant-a'] });
      await deferredFlightA;

      // Another B sync must join the existing pending B request instead of starting a duplicate fetch
      const deferredFlightB2 = syncReceiptSettings();
      assertEqualOrThrow(
        deferredBFetchCount,
        1,
        'second tenant-b sync joins existing pending B request after A settles',
      );
      resolveDeferredB({ data: tenantResponses['tenant-b'] });
      await Promise.all([deferredFlightB1, deferredFlightB2]);
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '200 Bravo Blvd, Boston, MA',
        'deferred tenant-b response hydrates posSettings after joined sync resolves',
      );

      // Verify A -> B -> A race: older A1 response resolving after newer A2 response does not overwrite A2
      resetReceiptSettingsSyncForTests();
      let resolveA1!: (value: any) => void;
      const a1Promise = new Promise((resolve) => {
        resolveA1 = resolve;
      });
      let resolveA2!: (value: any) => void;
      const a2Promise = new Promise((resolve) => {
        resolveA2 = resolve;
      });
      let aRequestCall = 0;
      frontendApi.get = () => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        if (activeTenantId === 'tenant-a') {
          aRequestCall += 1;
          return aRequestCall === 1 ? a1Promise : a2Promise;
        }
        return Promise.resolve({ data: tenantResponses[activeTenantId] });
      };
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const inFlightA1 = syncReceiptSettings();
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      await syncReceiptSettings();
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const inFlightA2 = syncReceiptSettings();
      resolveA2({
        data: {
          business_address: '102 Fresh Alpha Ave, Austin, TX',
          bill_footer_message: 'Fresh Alpha Footer',
        },
      });
      await inFlightA2;
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '102 Fresh Alpha Ave, Austin, TX',
        'newer A2 response hydrates fresh tenant-a settings',
      );
      resolveA1({
        data: {
          business_address: '100 Stale Alpha Ave, Austin, TX',
          bill_footer_message: 'Stale Alpha Footer',
        },
      });
      await inFlightA1;
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '102 Fresh Alpha Ave, Austin, TX',
        'older A1 response resolving after A2 does not overwrite newer tenant-a settings',
      );
      assertEqualOrThrow(
        usePosSettingsStore.getState().billFooterMessage,
        'Fresh Alpha Footer',
        'older A1 response resolving after A2 does not overwrite newer tenant-a footer',
      );

      // Verify returning to A after Settings mutates posSettings on B while B's request is pending re-hydrates A
      resetReceiptSettingsSyncForTests();
      let resolvePendingBForReturn!: (value: any) => void;
      const pendingBForReturnPromise = new Promise((resolve) => {
        resolvePendingBForReturn = resolve;
      });
      frontendApi.get = () => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        if (activeTenantId === 'tenant-b') {
          return pendingBForReturnPromise;
        }
        return Promise.resolve({ data: tenantResponses[activeTenantId] });
      };
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      await syncReceiptSettings();
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '100 Alpha Ave, Austin, TX',
        'tenant-a hydrated before switching to tenant-b',
      );
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const pendingBOnSwitch = syncReceiptSettings();
      // Simulate Settings page hydrating tenant-b values while B's background sync is still pending
      usePosSettingsStore.getState().hydrateReceiptSettings(tenantResponses['tenant-b']);
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '200 Bravo Blvd, Boston, MA',
        'Settings page populates tenant-b address while B background request is pending',
      );
      // Return to tenant-a within 60 seconds -> must re-fetch tenant-a and not skip due to stale hydratedTenantId
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const readyOnReturnToA = await ensureReceiptSettingsLoaded('tenant-a');
      assertEqualOrThrow(
        readyOnReturnToA,
        true,
        'ensureReceiptSettingsLoaded succeeds when returning to tenant-a',
      );
      assertEqualOrThrow(
        usePosSettingsStore.getState().billAddress,
        '100 Alpha Ave, Austin, TX',
        'returning to tenant-a within 60s re-hydrates tenant-a address over tenant-b Settings values',
      );
      resolvePendingBForReturn({ data: tenantResponses['tenant-b'] });
      await pendingBOnSwitch;

      // Verify ensureReceiptSettingsLoaded returns false when tenant changes during a pending print wait
      resetReceiptSettingsSyncForTests();
      let resolvePendingPrintA!: (value: any) => void;
      const pendingPrintAPromise = new Promise((resolve) => {
        resolvePendingPrintA = resolve;
      });
      frontendApi.get = () => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        if (activeTenantId === 'tenant-a') {
          return pendingPrintAPromise;
        }
        return Promise.resolve({ data: tenantResponses[activeTenantId] });
      };
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const printWaitForA = ensureReceiptSettingsLoaded('tenant-a');
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      await syncReceiptSettings();
      resolvePendingPrintA({ data: tenantResponses['tenant-a'] });
      const printReadyForA = await printWaitForA;
      assertEqualOrThrow(
        printReadyForA,
        false,
        'ensureReceiptSettingsLoaded returns false when tenant switches to B while A print is waiting',
      );

      // Verify printBill and printTaxBill reject with PrintCancelledOnTenantChangeError on mid-print tenant switch
      resetReceiptSettingsSyncForTests();
      let resolveCancelledPrintA!: (value: any) => void;
      const cancelledPrintAPromise = new Promise((resolve) => {
        resolveCancelledPrintA = resolve;
      });
      frontendApi.get = () => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        if (activeTenantId === 'tenant-a') {
          return cancelledPrintAPromise;
        }
        return Promise.resolve({ data: tenantResponses[activeTenantId] });
      };
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const fakeWindow = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      const printBillPromise = usePrinterStore.getState().printBill(
        sampleBill as any,
        {
          business_name: 'Alpha Cafe',
          currency: 'USD',
          country: 'US',
          timezone: 'UTC',
        },
        undefined,
        fakeWindow as any,
      );
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      resolveCancelledPrintA({ data: tenantResponses['tenant-a'] });
      let caughtPrintBillErr: unknown = null;
      try {
        await printBillPromise;
      } catch (err) {
        caughtPrintBillErr = err;
      }
      assertOrThrow(
        caughtPrintBillErr instanceof PrintCancelledOnTenantChangeError &&
          isPrintCancelledOnTenantChangeError(caughtPrintBillErr),
        'printBill rejects with PrintCancelledOnTenantChangeError when tenant changes mid-print',
      );
      assertEqualOrThrow(
        fakeWindow.closed,
        true,
        'printBill closes reservedWindow when tenant changes mid-print',
      );
      assertEqualOrThrow(
        usePrinterStore.getState().lastError,
        null,
        'printBill leaves lastError null when cancelled by tenant change',
      );

      resetReceiptSettingsSyncForTests();
      let resolveCancelledTaxPrintA!: (value: any) => void;
      const cancelledTaxPrintAPromise = new Promise((resolve) => {
        resolveCancelledTaxPrintA = resolve;
      });
      frontendApi.get = () => {
        const activeTenantId = String(useAuthStore.getState().currentTenant?.id ?? '');
        if (activeTenantId === 'tenant-a') {
          return cancelledTaxPrintAPromise;
        }
        return Promise.resolve({ data: tenantResponses[activeTenantId] });
      };
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-a',
          business_name: 'Alpha Cafe',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      const printTaxBillPromise = usePrinterStore.getState().printTaxBill(sampleBill as any, {
        business_name: 'Alpha Cafe',
        currency: 'USD',
        country: 'US',
        timezone: 'UTC',
      });
      useAuthStore.setState({
        currentTenant: {
          id: 'tenant-b',
          business_name: 'Bravo Bistro',
          role: 'owner',
          permission_ids: ['settings.view'],
        } as any,
      });
      resolveCancelledTaxPrintA({ data: tenantResponses['tenant-a'] });
      let caughtPrintTaxBillErr: unknown = null;
      try {
        await printTaxBillPromise;
      } catch (err) {
        caughtPrintTaxBillErr = err;
      }
      assertOrThrow(
        caughtPrintTaxBillErr instanceof PrintCancelledOnTenantChangeError &&
          isPrintCancelledOnTenantChangeError(caughtPrintTaxBillErr),
        'printTaxBill rejects with PrintCancelledOnTenantChangeError when tenant changes mid-print',
      );
      assertEqualOrThrow(
        usePrinterStore.getState().lastError,
        null,
        'printTaxBill leaves lastError null when cancelled by tenant change',
      );
    } finally {
      frontendApi.get = originalGetForTenantSwitch;
    }
  } finally {
    delete frontendApi.defaults.headers.common['Authorization'];
    frontendApi.defaults.baseURL = '/api';
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
