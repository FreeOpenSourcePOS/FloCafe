/* Live end-to-end verification of Tamil (ta, ta-IN, தமிழ்) across FloCafe */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR || '/Users/gurkiratkhaira/.no-mistakes/evidence/01M6TFBB5N9D8YH81YP42GPK9E';
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tamil-live-'));
const MAIN_PORT = 13101;
const KDS_PORT = 13102;
const SERVER_APP_PORT = 13103;
const BASE_URL = `http://127.0.0.1:${MAIN_PORT}`;
const KDS_BASE_URL = `http://127.0.0.1:${KDS_PORT}`;
const SERVER_APP_BASE_URL = `http://127.0.0.1:${SERVER_APP_PORT}`;

process.env.PORT = String(MAIN_PORT);
process.env.KDS_PORT = String(KDS_PORT);
process.env.SERVER_APP_PORT = String(SERVER_APP_PORT);
process.env.JWT_SECRET = 'tamil-live-test-secret';
process.env.FLO_AUTH_RATE_LIMIT_MAX = '1000';
process.env.FLO_SETTINGS_READ_RATE_LIMIT_MAX = '100000';
process.env.FLO_SETTINGS_WRITE_RATE_LIMIT_MAX = '1000';
process.env.FLO_WHATSAPP_SOCKET_DISABLED = '1';
process.env.FLO_MATRIX_OFFLINE = '1';
process.env.NODE_ENV = 'test';

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => '3.13.23' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (val) => Buffer.from(val),
        decryptString: (buf) => buf.toString(),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const {
  initDatabase,
  getDatabase,
  closeDatabase,
  beginDatabaseShutdown,
  waitForDatabaseRequests,
  now,
} = require('../dist/main/db');
const { startServer, stopServer } = require('../dist/main/server');
const { startKdsServer, stopKdsServer } = require('../dist/main/kds-server');
const { startServerApp, stopServerApp } = require('../dist/main/server-app');
const { startStandaloneServers } = require('../dist/main/standalone-startup');
const { getStatusMessage, resolveStatusLanguage } = require('../dist/main/status-messages');
const { printLabel } = require('../dist/main/print/print-labels.generated');
const { formatDailySalesWhatsAppMessage } = require('../dist/main/routes/reports');
const officialIndiaPackData = require('./fixtures/legacy-tax-packs/official-india.json');
const flatRatePackData = require('./fixtures/synthetic-flat-rate-pack.json');

function installAndActivateTaxPack(db, pack) {
  const installedAt = now();
  const versionId = `${pack.id}@${pack.version}`;
  const packJson = JSON.stringify(pack);
  const digest = crypto.createHash('sha256').update(packJson).digest('hex');

  db.prepare(`
    INSERT INTO country_packs (
      id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      publisher = excluded.publisher,
      country = excluded.country,
      jurisdiction = excluded.jurisdiction,
      active_version_id = excluded.active_version_id,
      status = 'active',
      updated_at = excluded.updated_at
  `).run(
    pack.id,
    pack.publisher,
    pack.country,
    pack.jurisdiction,
    versionId,
    installedAt,
    installedAt,
  );

  db.prepare(`
    INSERT OR REPLACE INTO country_pack_versions (
      id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
      effective_from, effective_to, min_flo_version, published_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?)
  `).run(
    versionId,
    pack.id,
    pack.version,
    pack.schemaVersion,
    JSON.stringify({
      id: pack.id,
      publisher: pack.publisher,
      country: pack.country,
      jurisdiction: pack.jurisdiction,
      version: pack.version,
      publishedAt: pack.publishedAt,
    }),
    packJson,
    digest,
    pack.effectiveFrom,
    pack.effectiveTo || null,
    pack.minFloVersion,
    pack.publishedAt,
    installedAt,
  );

  const insertCategory = db.prepare(`
    INSERT OR REPLACE INTO tax_categories (
      id, pack_version_id, category_id, label, default_behavior, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const category of pack.categories) {
    insertCategory.run(
      `${versionId}:category:${category.id}`,
      versionId,
      category.id,
      category.label,
      category.defaultBehavior || null,
      JSON.stringify(category),
      installedAt,
    );
  }

  const insertRule = db.prepare(`
    INSERT OR REPLACE INTO tax_rules (
      id, pack_version_id, rule_id, label, calculation_type, rate, amount,
      applies_per, base_rule_ids, definition_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rule of pack.rules) {
    insertRule.run(
      `${versionId}:rule:${rule.id}`,
      versionId,
      rule.id,
      rule.label,
      rule.type,
      rule.rate || null,
      rule.amount || null,
      rule.appliesPer || null,
      JSON.stringify(rule.baseRuleIds || []),
      JSON.stringify(rule),
      installedAt,
    );
  }
}

async function main() {
  let browser;
  try {
    await startStandaloneServers({
      initializeDatabase: initDatabase,
      prepare: () => {},
      startServer,
      startKdsServer,
      startServerApp,
      isShutdownRequested: () => false,
    });
    console.log('[Live] Standalone Main (:13101), KDS (:13102), and Server App (:13103) started');

    const playwright = require(path.resolve(__dirname, '../frontend/node_modules/@playwright/test'));
    browser = await playwright.chromium.launch({ headless: true });

    // -------------------------------------------------------------------------
    // SCENARIO 1: First-run Setup Wizard in Tamil (ta, ta-IN, தமிழ்) & Seed Data
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 1: First-run Setup Wizard in Tamil (ta-IN) & Tamil Sample Seed Data ---');
    const setupContext = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: 'ta-IN',
      deviceScaleFactor: 2,
    });
    const page = await setupContext.newPage();

    await page.goto(`${BASE_URL}/setup`);
    await page.waitForSelector('[data-slot="card"] button');

    // Wait for post-hydration requestAnimationFrame to sort தமிழ் (TA) to first option
    const tamilLangBtn = page.locator('[data-slot="card"] button', { hasText: 'தமிழ்' }).first();
    await tamilLangBtn.waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-slot="card"] button');
      return btn && btn.textContent && btn.textContent.includes('தமிழ்');
    });
    const firstLangBtn = page.locator('[data-slot="card"] button').first();
    const firstLangText = await firstLangBtn.innerText();
    assert.ok(
      firstLangText.includes('தமிழ்') && firstLangText.includes('TA'),
      `Expected first language option to be தமிழ் (TA) for ta-IN browser locale, got: ${firstLangText}`,
    );
    await tamilLangBtn.click();
    await page.getByText('தொடர்க').first().waitFor({ state: 'visible' });

    const htmlDir = await page.locator('html').getAttribute('dir');
    const htmlLang = await page.locator('html').getAttribute('lang');
    assert.equal(htmlDir, 'ltr', 'Tamil UI must set <html dir="ltr">');
    assert.ok(
      htmlLang === 'ta-IN' || htmlLang === 'ta',
      `Expected <html lang="ta-IN"|"ta">, got ${htmlLang}`,
    );

    // Search/select India (IN) in country selector
    const countrySearch = page.locator('input.ps-9').first();
    await countrySearch.fill('IN');
    const indiaBtn = page.locator('.max-h-72 button', { hasText: /India|இந்தியா|INR/ }).first();
    await indiaBtn.click();

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, '01-setup-wizard-tamil.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 01-setup-wizard-tamil.png');

    // Advance Step 1 -> Step 2 (Master PIN & Approval PIN)
    await page.locator('button', { hasText: 'தொடர்க' }).first().click();
    await page.waitForSelector('#owner-approval-pin');
    const masterPinInput = page.locator('#master-pin');
    if ((await masterPinInput.count()) > 0 && (await masterPinInput.isVisible())) {
      await masterPinInput.fill('1234');
      await page.locator('#master-pin-confirm').fill('1234');
    }
    await page.locator('#owner-approval-pin').fill('5678');
    await page.locator('#owner-approval-pin-confirm').fill('5678');

    // Advance Step 2 -> Step 3 (Owner Account)
    await page.locator('button', { hasText: 'தொடர்க' }).first().click();
    await page.waitForSelector('#email');
    await page.locator('#name').fill('கார்த்திக்');
    await page.locator('#email').fill('owner@flocafe.com');
    await page.locator('#password').fill('E2ePass123!');
    await page.locator('#confirmPassword').fill('E2ePass123!');
    await page.locator('#business_name').fill('சென்னை ஃப்ளோகஃபே');
    await page.locator('input[type="checkbox"]').first().check();
    await page.locator('input[name="setup-analytics-level"][value="off"]').check({ force: true });

    // Advance Step 3 -> Step 4 (Setup Profile: select 'demo' -> மாதிரி (Demo))
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(300);
    // Click Demo profile button (3rd card in .grid.gap-4)
    const profileButtons = page.locator('.grid.gap-4 > button');
    await profileButtons.nth(2).click();

    // Advance Step 4 -> Step 5 (Cloud Backup)
    await page.locator('button', { hasText: 'தொடர்க' }).first().click();
    await page.waitForTimeout(300);

    // Advance Step 5 -> Step 6 (Service Model: select 'finedine' -> ஃபைன்டைன் (FineDine))
    await page.locator('button', { hasText: 'தொடர்க' }).first().click();
    await page.waitForTimeout(300);
    const serviceModelButtons = page.locator('.grid.gap-4.md\\:grid-cols-2 > button');
    await serviceModelButtons.nth(1).click();

    // Complete setup -> redirects to /auth/login
    await page.locator('button', { hasText: /அமைப்பை முடி|தொடர்க/ }).last().click();
    await page.waitForURL('**/auth/login**', { timeout: 25000 });
    await page.locator('#email').waitFor({ state: 'visible' });
    await page.locator('#email').fill('owner@flocafe.com');
    await page.locator('#password').fill('E2ePass123!');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos**', { timeout: 25000 });

    // Verify database seeded Tamil categories, products, customers, and staff
    const db = getDatabase();
    installAndActivateTaxPack(db, officialIndiaPackData);
    installAndActivateTaxPack(db, {
      ...flatRatePackData,
      id: 'test-us-pack',
      country: 'US',
      currency: 'USD',
      publisher: 'FreeOpenSourcePOS',
    });
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('whatsapp_enabled', 'true', ?)`,
    ).run(now());

    const seededCategories = db
      .prepare('SELECT name FROM categories ORDER BY sort_order ASC')
      .all()
      .map((r) => r.name);
    assert.deepEqual(
      seededCategories,
      ['தொடக்க உணவுகள்', 'முக்கிய உணவுகள்', 'பானங்கள்', 'இனிப்புகள்'],
      'Setup wizard must seed Tamil category names',
    );

    const seededProducts = db
      .prepare('SELECT name FROM products ORDER BY category_id, sort_order ASC')
      .all()
      .map((r) => r.name);
    for (const expectedProd of [
      'மெது வடை',
      'பனீர் டிக்கா',
      'மசாலா தோசை',
      'சாம்பார் சாதம்',
      'தயிர் சாதம்',
      'பில்டர் காபி',
      'தண்ணீர்',
      'பாயசம்',
    ]) {
      assert.ok(
        seededProducts.includes(expectedProd),
        `Expected Tamil seeded product ${expectedProd}, got ${seededProducts.join(', ')}`,
      );
    }

    const seededCustomers = db
      .prepare('SELECT name, phone FROM customers ORDER BY id ASC')
      .all();
    assert.deepEqual(
      seededCustomers.map((c) => c.name),
      ['கார்த்திக் சுப்பிரமணியன்', 'திவ்யா நடராஜன்', 'செந்தில் குமார்'],
      'Setup wizard must seed Tamil customer names',
    );
    assert.deepEqual(
      seededCustomers.map((c) => c.phone),
      ['+919876543210', '+919876543211', '+919876543212'],
      'Setup wizard must seed E.164 Indian phone numbers for Tamil demo customers',
    );
    console.log('  ✓ Verified Tamil setup wizard completion and Tamil sample seed data in SQLite');

    // -------------------------------------------------------------------------
    // SCENARIO 2: Main POS App and Settings in Tamil (ta)
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 2: Main POS App & Settings in Tamil (ta) ---');
    await page.goto(`${BASE_URL}/pos`);
    await page.waitForSelector('[data-testid="pos-product-grid"]');
    await page.getByText('மசாலா தோசை').first().waitFor({ state: 'visible' });
    await page.getByText('பில்டர் காபி').first().waitFor({ state: 'visible' });

    // Click Tamil products to add them to cart
    await page.getByText('மசாலா தோசை').first().click();
    await page.getByText('பில்டர் காபி').first().click();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: path.join(EVIDENCE_DIR, '02-pos-tamil-catalog-and-cart.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 02-pos-tamil-catalog-and-cart.png');

    // Navigate to Settings and verify Tamil language selection & zero horizontal overflow
    await page.goto(`${BASE_URL}/settings`);
    await page.getByText('அமைப்புகள்').first().waitFor({ state: 'visible', timeout: 15000 });
    const settingsOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    assert.equal(settingsOverflow, false, 'Settings page in Tamil must not overflow horizontally');
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, '03-settings-tamil.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 03-settings-tamil.png');

    // -------------------------------------------------------------------------
    // SCENARIO 3: Customer Display, Standalone KDS (:13102), and Server App (:13103)
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 3: Customer Display, Standalone KDS, and Server App in Tamil (ta) ---');
    const ownerToken = await page.evaluate(() => localStorage.getItem('token'));
    assert.ok(ownerToken, 'Owner JWT token must be present after setup completion');
    const authHeaders = { Authorization: `Bearer ${ownerToken}` };

    // Create two live takeaway orders (one preparing, one ready) with Tamil products
    const ord1Res = await page.request.post(`${BASE_URL}/api/orders`, {
      headers: authHeaders,
      data: {
        type: 'takeaway',
        items: [
          { product_id: 'prod-demo-masala-dosa', quantity: 2 },
          { product_id: 'prod-demo-filter-coffee', quantity: 1 },
        ],
      },
    });
    assert.equal(ord1Res.status(), 201, 'Creating Tamil takeaway order 1 must succeed');
    const { order: order1 } = await ord1Res.json();
    await page.request.patch(`${BASE_URL}/api/orders/${order1.id}/status`, {
      headers: authHeaders,
      data: { status: 'preparing' },
    });

    const ord2Res = await page.request.post(`${BASE_URL}/api/orders`, {
      headers: authHeaders,
      data: {
        type: 'takeaway',
        items: [{ product_id: 'prod-demo-payasam', quantity: 1 }],
      },
    });
    assert.equal(ord2Res.status(), 201, 'Creating Tamil takeaway order 2 must succeed');
    const { order: order2 } = await ord2Res.json();
    await page.request.patch(`${BASE_URL}/api/orders/${order2.id}/status`, {
      headers: authHeaders,
      data: { status: 'ready' },
    });

    // Open Customer Display in Tamil
    await page.goto(`${BASE_URL}/customer-display`);
    await page.getByTestId('customer-display-preparing-scroll').waitFor({ state: 'visible' });
    const preparingText = await page.getByTestId('customer-display-preparing-scroll').innerText();
    const readyText = await page.getByTestId('customer-display-ready-scroll').innerText();
    assert.ok(
      preparingText.includes(order1.order_number),
      `Customer display preparing column must show ${order1.order_number}`,
    );
    assert.ok(
      readyText.includes(order2.order_number),
      `Customer display ready column must show ${order2.order_number}`,
    );
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, '04-customer-display-tamil.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 04-customer-display-tamil.png');

    // Open Standalone KDS (:13102/kds-standalone) in Tamil
    const kdsPage = await setupContext.newPage();
    await kdsPage.addInitScript(() => {
      localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'ta' }, version: 3 }));
    });
    await kdsPage.goto(`${KDS_BASE_URL}/kds-standalone`);
    await kdsPage.getByTestId('kds-login-form').waitFor({ state: 'visible' });
    await kdsPage.getByTestId('kds-login-email').fill('owner@flocafe.com');
    await kdsPage.getByTestId('kds-login-password').fill('E2ePass123!');
    await kdsPage.getByTestId('kds-login-submit').click();
    await kdsPage.getByTestId('kds-workspace').waitFor({ state: 'visible' });
    await kdsPage.getByText('மசாலா தோசை').first().waitFor({ state: 'visible' });
    await kdsPage.screenshot({
      path: path.join(EVIDENCE_DIR, '05-kds-standalone-tamil.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 05-kds-standalone-tamil.png');

    // Open Standalone Server App (:13103/server-standalone) in Tamil
    const serverPage = await setupContext.newPage();
    await serverPage.goto(`${SERVER_APP_BASE_URL}/server-standalone`);
    await serverPage.evaluate(
      ([tok]) => {
        localStorage.setItem('flocafe:server-app-token', tok);
        localStorage.setItem('pos-settings', JSON.stringify({ state: { language: 'ta' }, version: 3 }));
      },
      [ownerToken],
    );
    await serverPage.reload();
    await serverPage.getByRole('button', { name: /T1/ }).first().waitFor({ state: 'visible' });
    await serverPage.getByRole('button', { name: /T1/ }).first().click();
    await serverPage.getByTestId('pos-product-grid').waitFor({ state: 'visible' });
    await serverPage.getByText('மசாலா தோசை').first().waitFor({ state: 'visible' });
    await serverPage.screenshot({
      path: path.join(EVIDENCE_DIR, '06-server-app-tamil.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 06-server-app-tamil.png');

    // -------------------------------------------------------------------------
    // SCENARIO 4: Print-Test Surface, Browser/HTML Receipts, KOT, Order Slip,
    // Thermal Print Labels, and Electron Status Messages in Tamil (ta)
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 4: Print-Test Surface, Browser Receipts/KOT/Order Slip & Print Labels in Tamil ---');
    await page.goto(`${BASE_URL}/print-test`);
    await page.getByRole('button', { name: 'அடிப்படை ரசீது (தெர்மல்)', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'வெப் அச்சு (உலாவி)', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'WhatsApp பகிர்வு', exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, '07-print-test-tamil.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 07-print-test-tamil.png');

    // Verify generated print labels and status messages for Tamil
    assert.equal(printLabel('ta', 'print.grandTotal'), 'மொத்தத் தொகை');
    assert.equal(printLabel('ta', 'receipt.cashReceived'), 'பெற்ற ரொக்கம்');
    assert.equal(printLabel('ta', 'print.kot.title'), 'சமையலறை ஆர்டர் சீட்டு');
    assert.deepEqual(getStatusMessage('starting', 'ta'), [
      'Flo தொடங்குகிறது',
      'அனைத்தையும் தயார்ப்படுத்துகிறது…',
    ]);
    assert.deepEqual(getStatusMessage('closing', resolveStatusLanguage('ta-IN')), [
      'Flo மூடப்படுகிறது',
      'உங்கள் தரவு சேமிக்கப்படுகிறது. கணினியை அணைக்க வேண்டாம்.',
    ]);

    // Copy the Tamil HTML receipt and KOT screenshots generated by browser-receipts into named evidence files
    const receiptPage = await setupContext.newPage();
    await receiptPage.setViewportSize({ width: 520, height: 980 });
    const moduleApi = require('module');
    const origResolve = moduleApi._resolveFilename;
    moduleApi._resolveFilename = function (req, parent, isMain, opts) {
      if (req === '@countries') return origResolve.call(this, path.resolve(__dirname, '../main/countries.ts'), parent, isMain, opts);
      if (req.startsWith('@/')) return origResolve.call(this, path.resolve(__dirname, '../frontend/src', req.slice(2)), parent, isMain, opts);
      if (req.startsWith('@print/')) return origResolve.call(this, path.resolve(__dirname, '../shared/print', req.slice('@print/'.length)), parent, isMain, opts);
      return origResolve.call(this, req, parent, isMain, opts);
    };
    require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, 'tsconfig.json') });
    const { loadLocaleMessages } = require('../frontend/src/lib/i18n');
    const { generateBillHtml } = require('../frontend/src/lib/printer/web-print');
    const { generateKotHtml } = require('../frontend/src/lib/printer/kot-web-print');
    const { generateOrderSlipHtml } = require('../frontend/src/lib/printer/order-slip-web-print');
    await loadLocaleMessages('ta');

    const sampleOrder = {
      id: 501,
      order_number: 'ORD-TA-501',
      status: 'completed',
      type: 'dine_in',
      subtotal: 410,
      tax_amount: 20.5,
      discount_amount: 0,
      total: 430.5,
      created_at: '2026-11-07T08:00:00.000Z',
      items: [
        {
          id: 1,
          order_id: 501,
          product_id: 'prod-demo-masala-dosa',
          product_name: 'மசாலா தோசை',
          unit_price: 160,
          quantity: 2,
          subtotal: 320,
          tax_amount: 16,
          total: 336,
          addons: [{ id: 1, name: 'நெய்', price: 20, quantity: 1 }],
          special_instructions: 'நன்றாக மொறுமொறுப்பாக',
          status: 'served',
        },
        {
          id: 2,
          order_id: 501,
          product_id: 'prod-demo-filter-coffee',
          product_name: 'ஃபில்டர் காபி',
          unit_price: 90,
          quantity: 1,
          subtotal: 90,
          tax_amount: 4.5,
          total: 94.5,
          addons: null,
          special_instructions: null,
          status: 'served',
        },
      ],
      table: { id: 'tbl-demo-1', name: 'T1', number: 'T1', capacity: 4, status: 'occupied', is_active: true },
      customer: {
        id: 'cust-demo-1',
        name: 'கார்த்திக் சுப்பிரமணியன்',
        phone: '+919840123456',
        country_code: '+91',
      },
    };
    const sampleBill = {
      id: 501,
      bill_number: 'BILL-TA-501',
      order_id: 501,
      subtotal: 410,
      discount_amount: 0,
      tax_amount: 20.5,
      service_charge: 0,
      total: 430.5,
      paid_amount: 500,
      change_amount: 69.5,
      payment_method: 'cash',
      payment_status: 'paid',
      created_at: '2026-11-07T08:05:00.000Z',
      order: sampleOrder,
      payments: [{ id: 1, bill_id: 501, amount: 500, method: 'cash', created_at: '2026-11-07T08:05:00.000Z' }],
    };

    const tamilBillHtml = generateBillHtml(
      sampleBill,
      {
        business_name: 'சென்னை ஃப்ளோகஃபே',
        currency: 'INR',
        country: 'IN',
        timezone: 'Asia/Kolkata',
      },
      {
        language: 'ta',
        paperSize: 'thermal80',
        address: 'அண்ணா சாலை, சென்னை',
        phone: '+91 44 2852 1234',
        showTaxBreakdown: true,
      },
    );
    const tamilKotHtml = generateKotHtml(sampleOrder, {
      paperWidth: 80,
      language: 'ta',
      stationName: 'சூடான சமையலறை',
    });
    const tamilOrderSlipHtml = generateOrderSlipHtml(
      sampleOrder,
      {
        title: 'ஆர்டர் சீட்டு',
        subtotal: 'உப மொத்தம்',
        discount: 'தள்ளுபடி',
        serviceCharge: 'சேவை கட்டணம்',
        deliveryCharge: 'டெலிவரி கட்டணம்',
        packagingCharge: 'பேக்கேஜிங் கட்டணம்',
        tax: 'வரி',
        total: 'மொத்தம்',
      },
      {
        paperWidth: 80,
        country: 'IN',
        currency: 'INR',
      },
    );

    assert.ok(tamilBillHtml.includes('Noto Sans Tamil'), 'Bill HTML must include Noto Sans Tamil font stack');
    assert.ok(tamilBillHtml.includes('மொத்தத் தொகை'), 'Bill HTML must include Tamil grand total label');
    assert.ok(tamilBillHtml.includes('பெற்ற ரொக்கம்'), 'Bill HTML must include Tamil cash received label');
    assert.ok(tamilKotHtml.includes('Noto Sans Tamil'), 'KOT HTML must include Noto Sans Tamil font stack');
    assert.ok(tamilOrderSlipHtml.includes('Noto Sans Tamil'), 'Order Slip HTML must include Noto Sans Tamil font stack');

    await receiptPage.setContent(tamilBillHtml, { waitUntil: 'load' });
    await receiptPage.screenshot({
      path: path.join(EVIDENCE_DIR, '08a-tamil-browser-receipt.png'),
      fullPage: true,
    });
    await receiptPage.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${tamilKotHtml}</body></html>`,
      { waitUntil: 'load' },
    );
    await receiptPage.screenshot({
      path: path.join(EVIDENCE_DIR, '08b-tamil-kot-slip.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 08a-tamil-browser-receipt.png and 08b-tamil-kot-slip.png');

    // -------------------------------------------------------------------------
    // SCENARIO 5: WhatsApp Plain-Text Reports & Cash Close Z-Report in Tamil (ta)
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 5: WhatsApp Plain-Text Reports & Cash Close Z-Report in Tamil (ta) ---');
    const { formatCashCloseWhatsAppMessage, generateWhatsAppMessage } = require('../frontend/src/lib/whatsapp-share');
    const taMessages = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../frontend/src/lib/i18n/messages/ta.json'), 'utf8'),
    );
    const taZReportText = formatCashCloseWhatsAppMessage(
      {
        businessDate: '2026-11-07',
        periodStart: '2026-11-07T04:00:00.000Z',
        periodEnd: '2026-11-07T16:00:00.000Z',
        grossSales: 2450,
        refunds: 50,
        netCollections: 2400,
        billCount: 14,
        expectedCash: 1500,
        openingFloat: 500,
        payIn: 200,
        payOut: 100,
        safeDrops: 0,
        paymentMethods: [
          { method: 'Cash', count: 9, total: 1400 },
          { method: 'UPI', count: 5, total: 1000 },
        ],
        zNumber: 1,
        closedAt: '2026-11-07T16:05:00.000Z',
        closedBy: 'கார்த்திக்',
        notes: 'சரியாக உள்ளது',
        countedCash: 1500,
        cashVariance: 0,
      },
      {
        business_name: 'சென்னை ஃப்ளோகஃபே',
        currency: 'INR',
        country: 'IN',
        timezone: 'Asia/Kolkata',
      },
      'ta-IN',
      {
        zReport: taMessages.dashboard.zReport,
        date: taMessages.dashboard.businessDateLabel,
        closedBy: taMessages.dashboard.ticketSectionOperator,
        grossSales: taMessages.dashboard.grossCollections,
        refunds: taMessages.dashboard.refunds,
        netCollections: taMessages.dashboard.netCollections,
        billCount: (c) => taMessages.dashboard.billsCount.replace('{count}', String(c)),
        openingFloat: taMessages.dashboard.openingFloat,
        expectedCash: taMessages.dashboard.expectedCash,
        countedCash: taMessages.dashboard.countedCash,
        variance: taMessages.dashboard.variance,
        notes: taMessages.dashboard.closureNotes,
        none: taMessages.print.zReport.none,
        varianceExact: taMessages.dashboard.varianceExact,
        salesSummary: taMessages.dashboard.salesSummary,
        paymentBreakdown: taMessages.dashboard.paymentBreakdown,
        drawerReconciliation: taMessages.dashboard.drawerReconciliation,
      },
    );

    const taDailySalesText = formatDailySalesWhatsAppMessage(
      {
        business_name: 'சென்னை ஃப்ளோகஃபே',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        from_date: '2026-11-07',
        to_date: '2026-11-07',
        summary: {
          gross_collected: 2450,
          refunded_amount: 50,
          net_collected: 2400,
          bill_count: 14,
          refund_count: 1,
          tax_amount: 120,
          discount_amount: 30,
          service_charge: 0,
          packaging_charge: 20,
          delivery_charge: 40,
          total_ingredient_cost: 800,
          total_profit: 1480,
          overall_margin_percent: 61.67,
          cost_status: 'complete',
          unlinked_item_count: 0,
        },
        payment_methods: [
          { method: 'cash', bill_count: 9, amount: 1400 },
          { method: 'upi', bill_count: 5, amount: 1000 },
        ],
        items: [
          {
            product_id: 'prod-demo-masala-dosa',
            product_name: 'மசாலா தோசை',
            product_sku: null,
            quantity: 10,
            gross_item_sales: 1600,
            item_discounts: 0,
            net_item_sales: 1600,
            tax_amount: 80,
            ingredient_cost: 500,
            profit: 1100,
            margin_percent: 68.75,
            cost_status: 'complete',
          },
        ],
      },
      { language: 'ta', locale: 'ta-IN' },
    );

    const taBillWhatsAppText = generateWhatsAppMessage(
      sampleBill,
      {
        business_name: 'சென்னை ஃப்ளோகஃபே',
        currency: 'INR',
        country: 'IN',
        timezone: 'Asia/Kolkata',
      },
      sampleOrder.customer,
      {},
      'ta',
    );

    assert.ok(!/\{[a-zA-Z0-9_]+\}/.test(taZReportText), 'Tamil Z-Report WhatsApp message must not contain raw placeholders');
    assert.ok(!/\{[a-zA-Z0-9_]+\}/.test(taDailySalesText), 'Tamil Daily Sales WhatsApp message must not contain raw placeholders');
    assert.ok(!/\{[a-zA-Z0-9_]+\}/.test(taBillWhatsAppText), 'Tamil Bill WhatsApp message must not contain raw placeholders');
    assert.equal(taDailySalesText, taDailySalesText.normalize('NFC'), 'Tamil Daily Sales WhatsApp message must be NFC normalized');

    const combinedWhatsAppEvidence = [
      '=== 1. TAMIL DAILY SALES WHATSAPP REPORT (ta / ta-IN) ===',
      taDailySalesText,
      '',
      '=== 2. TAMIL Z-REPORT WHATSAPP SUMMARY (ta / ta-IN) ===',
      taZReportText,
      '',
      '=== 3. TAMIL CUSTOMER BILL WHATSAPP SHARE (ta / ta-IN) ===',
      taBillWhatsAppText,
      '',
    ].join('\n');
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, '09-whatsapp-reports-tamil.txt'),
      combinedWhatsAppEvidence,
      'utf8',
    );
    console.log('  ✓ Saved 09-whatsapp-reports-tamil.txt');

    // -------------------------------------------------------------------------
    // SCENARIO 6 (Adversarial): UI Language (ta) Decoupled from Store Country/Currency
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario 6 (Adversarial): UI Language (ta) Decoupled from Store Country (US/USD) ---');
    // Switch country to US and currency to USD on the live database while language remains 'ta'
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'US', ?)`).run(now());
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'USD', ?)`).run(now());
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('timezone', 'America/New_York', ?)`).run(now());

    await page.goto(`${BASE_URL}/pos`);
    await page.waitForSelector('[data-testid="pos-product-grid"]');
    await page.getByText('மசாலா தோசை').first().waitFor({ state: 'visible' });
    const posGridText = await page.getByTestId('pos-product-grid').innerText();
    assert.ok(
      posGridText.includes('$') && posGridText.includes('மசாலா தோசை'),
      `Expected Tamil UI with USD ($) currency formatting when country=US & language=ta, got: ${posGridText.slice(0, 200)}`,
    );
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, '10-pos-tamil-decoupled-usd.png'),
      fullPage: true,
    });
    console.log('  ✓ Captured 10-pos-tamil-decoupled-usd.png');

    console.log('\n✅ All 6 live end-to-end Tamil (ta) scenarios passed with visual and textual evidence!');
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      await stopServerApp();
      await stopServer();
      await stopKdsServer();
      beginDatabaseShutdown();
      await waitForDatabaseRequests();
      closeDatabase();
    } catch {}
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Live verification failed:', err);
  process.exit(1);
});
