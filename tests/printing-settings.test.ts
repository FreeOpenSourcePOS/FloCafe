/**
 * Printing settings save contract.
 *
 * Covers the atomic backend batch endpoint and the frontend contract that
 * prevents the settings page from recreating the old per-key request flood.
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printing-settings-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  api,
  seedOwnerUser,
  seedManagerUser,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { settingsRoutes } = require('../main/routes/settings');

const basePayload = {
  printer_trim_decimals: true,
  bill_language_policy: { primary: { mode: 'fixed', language: 'de' }, additional: ['fa'] },
  kot_language_policy: { primary: { mode: 'fixed', language: 'tr' }, additional: [] },
  z_report_language_policy: { primary: { mode: 'fixed', language: 'fr' }, additional: [] },
  bill_show_name: false,
  bill_show_address: false,
  bill_show_phone: true,
  bill_show_tax_id: true,
  bill_show_tax_breakdown: false,
  bill_show_customer_name: false,
  bill_show_customer_phone: true,
  bill_show_table_number: false,
  bill_show_large_order_number: false,
  bill_delivery_show_customer_phone_always: true,
  bill_show_logo: true,
  cash_drawer_pulse_enabled: true,
  cash_drawer_pulse_methods: ['cash', 'card'],
};

function settingValue(db: any, key: string): string | null {
  return (
    (
      db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value?: string }
        | undefined
    )?.value ?? null
  );
}

function assertPersisted(db: any, key: string, expected: string, message: string): void {
  assertEqual(settingValue(db, key), expected, message);
}

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const app = createApp({ '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('Printing settings batch endpoint');

    assertPersisted(
      db,
      'bill_show_large_order_number',
      'true',
      'fresh database seeds bill_show_large_order_number enabled by default',
    );
    const initialAllSettings = await api(baseUrl, '/api/settings', {
      headers: owner.authHeader,
    });
    assertEqual(
      initialAllSettings.data.settings.bill_show_large_order_number,
      'true',
      'GET /api/settings returns bill_show_large_order_number: "true" by default',
    );
    const initialBusinessSettings = await api(baseUrl, '/api/settings/business', {
      headers: owner.authHeader,
    });
    assertEqual(
      initialBusinessSettings.data.bill_show_large_order_number,
      true,
      'GET /api/settings/business returns bill_show_large_order_number: true by default',
    );

    const initialPrintingRead = await api(baseUrl, '/api/settings/printing', {
      headers: owner.authHeader,
    });
    assertEqual(initialPrintingRead.status, 200, 'GET /api/settings/printing succeeds for owner');
    assertEqual(
      initialPrintingRead.data.bill_show_large_order_number,
      true,
      'GET /api/settings/printing defaults bill_show_large_order_number to true',
    );
    assertEqual(
      initialPrintingRead.data.bill_show_customer_phone,
      true,
      'GET /api/settings/printing defaults bill_show_customer_phone to true',
    );

    const ownerResponse = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: owner.authHeader,
      body: basePayload,
    });
    assertEqual(
      ownerResponse.status,
      200,
      'owner can save the complete printing settings payload atomically',
    );
    assertPersisted(db, 'printer_trim_decimals', 'true', 'trim decimals is persisted');
    assertPersisted(
      db,
      'bill_language_policy',
      JSON.stringify({ primary: { mode: 'fixed', language: 'de' }, additional: ['fa'] }),
      'receipt policy is normalized and persisted',
    );
    assertPersisted(
      db,
      'kot_language_policy',
      JSON.stringify({ primary: { mode: 'fixed', language: 'tr' }, additional: [] }),
      'KOT policy is normalized and persisted',
    );
    assertPersisted(
      db,
      'z_report_language_policy',
      JSON.stringify({ primary: { mode: 'fixed', language: 'fr' }, additional: [] }),
      'Z-report policy is normalized and persisted',
    );
    const zReportRead = await api(baseUrl, '/api/settings/z_report_language_policy', {
      headers: owner.authHeader,
    });
    assertEqual(zReportRead.status, 200, 'Z-report policy can be read through the settings API');
    assertEqual(
      zReportRead.data.setting.value,
      JSON.stringify({ primary: { mode: 'fixed', language: 'fr' }, additional: [] }),
      'settings API returns the persisted Z-report policy',
    );
    assertPersisted(db, 'bill_show_name', 'false', 'bill name visibility is persisted');
    assertPersisted(
      db,
      'bill_delivery_show_customer_phone_always',
      'true',
      'the delivery customer-number override is persisted',
    );
    assertPersisted(db, 'bill_show_tax_id', 'true', 'tax ID visibility is persisted');
    assertPersisted(db, 'bill_show_logo', 'true', 'logo visibility is persisted');
    assertPersisted(
      db,
      'bill_show_large_order_number',
      'false',
      'large bold order number toggle is persisted via PUT /api/settings/printing',
    );
    const businessAfterDisable = await api(baseUrl, '/api/settings/business', {
      headers: owner.authHeader,
    });
    assertEqual(
      businessAfterDisable.data.bill_show_large_order_number,
      false,
      'GET /api/settings/business reflects disabled bill_show_large_order_number',
    );
    assertPersisted(
      db,
      'cash_drawer_pulse_methods',
      JSON.stringify(['cash', 'card']),
      'cash drawer methods are persisted',
    );

    const managerResponse = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: manager.authHeader,
      body: { ...basePayload, printer_trim_decimals: false },
    });
    assertEqual(managerResponse.status, 200, 'manager can save printing settings');
    assertPersisted(db, 'printer_trim_decimals', 'false', 'manager update is persisted');

    const unauthorizedResponse = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      body: basePayload,
    });
    assertEqual(
      unauthorizedResponse.status,
      401,
      'unauthenticated printing-settings write is rejected',
    );

    const deniedResponse = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${owner.token}.invalid` },
      body: basePayload,
    });
    assertEqual(deniedResponse.status, 401, 'invalid printing-settings credentials are rejected');

    const beforeInvalid = Object.fromEntries(
      [
        'printer_trim_decimals',
        'bill_show_name',
        'bill_language_policy',
        'cash_drawer_pulse_methods',
      ].map((key) => [key, settingValue(db, key)]),
    );
    const invalidPolicyResponse = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        ...basePayload,
        printer_trim_decimals: true,
        bill_show_name: true,
        bill_language_policy: { primary: { mode: 'fixed', language: 'xx' }, additional: [] },
      },
    });
    assertEqual(
      invalidPolicyResponse.status,
      400,
      'invalid receipt policy is rejected before persistence',
    );
    for (const [key, expected] of Object.entries(beforeInvalid)) {
      assertEqual(settingValue(db, key), expected, `${key} is unchanged after invalid policy`);
    }

    const invalidBooleanResponse = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { ...basePayload, printer_trim_decimals: 'true' },
    });
    assertEqual(invalidBooleanResponse.status, 400, 'non-boolean printing flags are rejected');
    assertPersisted(
      db,
      'printer_trim_decimals',
      beforeInvalid.printer_trim_decimals as string,
      'invalid boolean does not change trim decimals',
    );

    const invalidMethodsResponse = await api(baseUrl, '/api/settings/printing', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { ...basePayload, cash_drawer_pulse_methods: ['cash', 7] },
    });
    assertEqual(invalidMethodsResponse.status, 400, 'invalid cash drawer methods are rejected');
    assertPersisted(
      db,
      'cash_drawer_pulse_methods',
      beforeInvalid.cash_drawer_pulse_methods as string,
      'invalid cash drawer methods do not partially persist',
    );

    // Existing wildcard writes remain available for unrelated callers.
    const wildcardResponse = await api(baseUrl, '/api/settings/printer_trim_decimals', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { value: 'true' },
    });
    assertEqual(wildcardResponse.status, 200, 'legacy wildcard setting writes remain compatible');
    assertPersisted(db, 'printer_trim_decimals', 'true', 'legacy wildcard write still persists');

    const largeOrderWildcard = await api(baseUrl, '/api/settings/bill_show_large_order_number', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { value: 'true' },
    });
    assertEqual(
      largeOrderWildcard.status,
      200,
      'PUT /api/settings/bill_show_large_order_number accepts wildcard write',
    );
    assertPersisted(
      db,
      'bill_show_large_order_number',
      'true',
      'PUT /api/settings/bill_show_large_order_number persists true',
    );
    const largeOrderRead = await api(baseUrl, '/api/settings/bill_show_large_order_number', {
      headers: owner.authHeader,
    });
    assertEqual(largeOrderRead.status, 200, 'GET /api/settings/bill_show_large_order_number works');
    assertEqual(
      largeOrderRead.data.setting.value,
      'true',
      'GET /api/settings/bill_show_large_order_number returns persisted value',
    );

    // Scoped read for a delegated printer specialist lacking settings.view and bills.* permissions.
    const specialistId = 'printer-specialist-001';
    db.prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES (?, 'Printer Specialist', 'printer@test.local', ?, 'cashier', 1, ?, ?)`,
    ).run(specialistId, bcrypt.hashSync('testpass123', 10), now(), now());
    const upsertOverride = db.prepare(
      `INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    upsertOverride.run(specialistId, 'printers.manage', 'allow', owner.userId, now(), now());
    for (const deniedPerm of ['settings.view', 'bills.read', 'bills.print', 'bills.generate']) {
      upsertOverride.run(specialistId, deniedPerm, 'deny', owner.userId, now(), now());
    }
    const specialistToken = jwt.sign(
      { userId: specialistId, email: 'printer@test.local', role: 'cashier' },
      getJWTSecret(),
      { expiresIn: '1h' },
    );
    const specialistHeaders = { Authorization: `Bearer ${specialistToken}` };

    const specialistBusinessDenied = await api(baseUrl, '/api/settings/business', {
      headers: specialistHeaders,
    });
    assertEqual(
      specialistBusinessDenied.status,
      403,
      'printer specialist without settings.view/bills.* cannot read /api/settings/business',
    );
    const specialistWildcardDenied = await api(baseUrl, '/api/settings/printer_trim_decimals', {
      headers: specialistHeaders,
    });
    assertEqual(
      specialistWildcardDenied.status,
      403,
      'printer specialist without settings.view cannot read /api/settings/:key',
    );

    const specialistPrintingRead = await api(baseUrl, '/api/settings/printing', {
      headers: specialistHeaders,
    });
    assertEqual(
      specialistPrintingRead.status,
      200,
      'printer specialist can read scoped /api/settings/printing',
    );
    assertEqual(
      specialistPrintingRead.data.bill_show_customer_phone,
      true,
      'scoped GET /api/settings/printing returns bill_show_customer_phone',
    );
    assertEqual(
      specialistPrintingRead.data.bill_show_name,
      false,
      'scoped GET /api/settings/printing returns persisted bill_show_name',
    );

    // User without printers.manage or settings.view is rejected with 403.
    const unprivilegedId = 'unprivileged-server-001';
    db.prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES (?, 'Unprivileged Server', 'unpriv@test.local', ?, 'server', 1, ?, ?)`,
    ).run(unprivilegedId, bcrypt.hashSync('testpass123', 10), now(), now());
    upsertOverride.run(unprivilegedId, 'settings.view', 'deny', owner.userId, now(), now());
    const unprivToken = jwt.sign(
      { userId: unprivilegedId, email: 'unpriv@test.local', role: 'server' },
      getJWTSecret(),
      { expiresIn: '1h' },
    );
    const unprivDenied = await api(baseUrl, '/api/settings/printing', {
      headers: { Authorization: `Bearer ${unprivToken}` },
    });
    assertEqual(
      unprivDenied.status,
      403,
      'GET /api/settings/printing rejects caller lacking printers.manage and settings.view',
    );

    const unauthPrintingGet = await api(baseUrl, '/api/settings/printing', {});
    assertEqual(
      unauthPrintingGet.status,
      401,
      'GET /api/settings/printing rejects unauthenticated',
    );

    console.log(`\n${getResults().passed}/${getResults().total} passed`);
    if (getResults().failed) process.exit(1);
  } catch (error: any) {
    console.error(`\n✗ Test crashed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  }
}

main();
