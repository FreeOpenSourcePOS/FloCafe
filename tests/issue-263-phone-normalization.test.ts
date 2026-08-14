const fs = require('fs');
const path = require('path');
const os = require('os');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-phone-test-'));

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => tempDir,
        getVersion: () => '1.0.0-test',
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { initDatabase, getDatabase, closeDatabase, createSchema } = require('../main/db');
const { parsePhoneE164, stripPhoneDigits, normalizeOptionalPhone } = require('../main/lib/phone');
const { seedSetupProfile, authRoutes } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { customerRoutes } = require('../main/routes/customers');
const { supportTicketRoutes } = require('../main/routes/support-ticket');
const { whatsappRoutes } = require('../main/routes/whatsapp');
const { createApp, seedOwnerUser, startServer, api } = require('./helpers/test-setup');

describe('Issue #263: Phone Normalization, Validation, and Privacy', () => {
  let app;
  let server;
  let baseUrl;
  let ownerAuth;

  before(async () => {
    app = createApp({
      '/api/auth': authRoutes,
      '/api/settings': settingsRoutes,
      '/api/customers': customerRoutes,
      '/api/support-ticket': supportTicketRoutes,
      '/api/whatsapp': whatsappRoutes,
    });
    const s = await startServer(app);
    baseUrl = s.baseUrl;
    server = s.server;
  });

  after(() => {
    if (server) server.close();
    try {
      closeDatabase();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    try {
      closeDatabase();
    } catch {}
    const defaultDb = path.join(tempDir, 'flo.db');
    if (fs.existsSync(defaultDb)) fs.unlinkSync(defaultDb);
    const wal = path.join(tempDir, 'flo.db-wal');
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    const shm = path.join(tempDir, 'flo.db-shm');
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
    initDatabase();
    ownerAuth = seedOwnerUser(getDatabase());
  });

  test('normalizeOptionalPhone helper contract', () => {
    assert.deepEqual(normalizeOptionalPhone(undefined, 'IN'), { valid: true, e164: null, countryCode: null });
    assert.deepEqual(normalizeOptionalPhone(null, 'IN'), { valid: true, e164: null, countryCode: null });
    assert.deepEqual(normalizeOptionalPhone('', 'IN'), { valid: true, e164: null, countryCode: null });
    assert.deepEqual(normalizeOptionalPhone('   ', 'IN'), { valid: true, e164: null, countryCode: null });

    const inRes = normalizeOptionalPhone('9876543210', 'IN');
    assert.equal(inRes.valid, true);
    assert.equal(inRes.e164, '+919876543210');
    assert.equal(inRes.countryCode, '+91');

    const arRes = normalizeOptionalPhone('1145678901', 'AR');
    assert.equal(arRes.valid, true);
    assert.equal(arRes.e164, '+541145678901');
    assert.equal(arRes.countryCode, '+54');

    const usRes = normalizeOptionalPhone('+14155552671', 'IN');
    assert.equal(usRes.valid, true);
    assert.equal(usRes.e164, '+14155552671');
    assert.equal(usRes.countryCode, '+1');

    const invalid1 = normalizeOptionalPhone('12345', 'IN');
    assert.equal(invalid1.valid, false);
    assert.ok(invalid1.error);

    const invalid2 = normalizeOptionalPhone('not-a-phone', 'US');
    assert.equal(invalid2.valid, false);
  });

  test('seedDemoRestaurant creates valid E.164 customer phones with 0 alerts', () => {
    const db = getDatabase();
    seedSetupProfile(db, 'demo', 'finedine', 'en', 'IN');

    const customers = db.prepare('SELECT id, name, phone, phone_digits, country_code FROM customers WHERE is_active = 1').all();
    assert.ok(customers.length >= 3, 'Demo customers should be seeded');

    for (const c of customers) {
      assert.ok(c.phone.startsWith('+'), `Customer ${c.name} phone ${c.phone} must start with +`);
      assert.equal(c.phone, '+' + c.phone_digits, `Customer ${c.name} phone ${c.phone} must match +phone_digits`);
    }

    const alertResult = db.prepare(`
      SELECT COUNT(*) as count 
      FROM customers 
      WHERE is_active = 1 
      AND phone IS NOT NULL AND phone != '' 
      AND phone != '+' || phone_digits
    `).get();

    assert.equal(alertResult.count, 0, 'Fresh demo install must have 0 invalid phone alerts');
  });

  test('seedDemoRestaurant in ES (AR) profile seeds valid Argentine E.164 phones', () => {
    const db = getDatabase();
    seedSetupProfile(db, 'demo', 'qsr', 'es', 'AR');

    const customers = db.prepare('SELECT id, name, phone, phone_digits FROM customers WHERE is_active = 1').all();
    assert.ok(customers.length >= 3);

    for (const c of customers) {
      assert.ok(c.phone.startsWith('+54'), `Argentine customer ${c.name} phone ${c.phone} must start with +54`);
      assert.equal(c.phone, '+' + c.phone_digits);
    }
  });

  test('PUT /api/settings/business validates and normalizes business_phone', async () => {
    // Valid phone normalization
    const resValid = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: {
        business_name: 'FloCafe Main',
        country: 'IN',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        business_phone: '9876543210',
      },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resValid.status, 200);
    assert.equal(resValid.data.business_phone, '+919876543210');

    // Invalid phone rejection
    const resInvalid = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: {
        business_name: 'FloCafe Main',
        country: 'IN',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        business_phone: '12345',
      },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resInvalid.status, 400);
  });

  test('PUT /api/settings/:key validates and normalizes business_phone', async () => {
    const db = getDatabase();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', datetime('now'))").run();

    const resValid = await api(baseUrl, '/api/settings/business_phone', {
      method: 'PUT',
      body: { value: '9876543210' },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resValid.status, 200);
    assert.equal(resValid.data.setting.value, '+919876543210');

    const resInvalid = await api(baseUrl, '/api/settings/business_phone', {
      method: 'PUT',
      body: { value: 'not-a-number' },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resInvalid.status, 400);
  });

  test('POST and PUT /api/customers validate, normalize, and allow phone clearing', async () => {
    // 1. Create customer with valid local number
    const resCreate = await api(baseUrl, '/api/customers', {
      method: 'POST',
      body: {
        name: 'Bob Smith',
        phone: '9876543210',
      },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resCreate.status, 201);
    assert.equal(resCreate.data.customer.phone, '+919876543210');
    assert.equal(resCreate.data.customer.country_code, '+91');

    const custId = resCreate.data.customer.id;

    // 2. Reject duplicate phone
    const resDupe = await api(baseUrl, '/api/customers', {
      method: 'POST',
      body: {
        name: 'Bob Duplicate',
        phone: '+919876543210',
      },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resDupe.status, 409);

    // 3. Clear phone via PUT /api/customers/:id with empty string
    const resClear = await api(baseUrl, `/api/customers/${custId}`, {
      method: 'PUT',
      body: { phone: '' },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resClear.status, 200);
    assert.equal(resClear.data.customer.phone, null);
    assert.equal(resClear.data.customer.phone_digits, null);
    assert.equal(resClear.data.customer.country_code, null);

    // 4. Update with new valid international phone
    const resUpdate = await api(baseUrl, `/api/customers/${custId}`, {
      method: 'PUT',
      body: { phone: '+14155552671' },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resUpdate.status, 200);
    assert.equal(resUpdate.data.customer.phone, '+14155552671');
    assert.equal(resUpdate.data.customer.country_code, '+1');

    // 5. Reject invalid phone on update
    const resBadUpdate = await api(baseUrl, `/api/customers/${custId}`, {
      method: 'PUT',
      body: { phone: 'invalid-num' },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resBadUpdate.status, 400);
  });

  test('POST /api/customers/admin/repair-phones repairs legacy phone records', async () => {
    const db = getDatabase();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', datetime('now'))").run();
    db.prepare(`
      INSERT INTO customers (id, name, phone, country_code, is_active, created_at, updated_at)
      VALUES ('cust-legacy-1', 'Legacy User', '9876543210', '+91', 1, datetime('now'), datetime('now'))
    `).run();

    const resAlertBefore = await api(baseUrl, '/api/customers/alerts', {
      headers: ownerAuth.authHeader,
    });
    assert.equal(resAlertBefore.data.invalidPhonesCount, 1);

    const resRepair = await api(baseUrl, '/api/customers/admin/repair-phones', {
      method: 'POST',
      body: {},
      headers: ownerAuth.authHeader,
    });
    assert.equal(resRepair.status, 200);
    assert.equal(resRepair.data.totalScanned, 1);
    assert.equal(resRepair.data.normalizedCount, 1);
    assert.equal(resRepair.data.unparseableCount, 0);

    const resAlertAfter = await api(baseUrl, '/api/customers/alerts', {
      headers: ownerAuth.authHeader,
    });
    assert.equal(resAlertAfter.data.invalidPhonesCount, 0);
  });

  test('POST /api/support-ticket validates contact_phone', async () => {
    const resValid = await api(baseUrl, '/api/support-ticket', {
      method: 'POST',
      body: {
        subject: 'Need help with printer',
        message: 'Printer not printing receipt',
        contact_phone: '+919876543210',
      },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resValid.status, 202);

    const resInvalid = await api(baseUrl, '/api/support-ticket', {
      method: 'POST',
      body: {
        subject: 'Need help with printer',
        message: 'Printer not printing receipt',
        contact_phone: 'bad-phone-number',
      },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resInvalid.status, 400);
  });

  test('POST /api/whatsapp/blocklist validates phone_e164', async () => {
    const resValid = await api(baseUrl, '/api/whatsapp/blocklist', {
      method: 'POST',
      body: {
        phone_e164: '+919876543210',
        reason: 'Spam',
      },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resValid.status, 200);

    const resInvalid = await api(baseUrl, '/api/whatsapp/blocklist', {
      method: 'POST',
      body: {
        phone_e164: 'not-a-phone',
        reason: 'Spam',
      },
      headers: ownerAuth.authHeader,
    });
    assert.equal(resInvalid.status, 400);
  });

  test('Privacy guarantee: telemetry payloads never include phone numbers', () => {
    const { TELEMETRY_URL } = require('../main/services/telemetry');
    assert.equal(TELEMETRY_URL, 'https://telemetry.flopos.com/collect');

    const db = getDatabase();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_phone', '+919876543210', datetime('now'))").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('phone', '+919876543210', datetime('now'))").run();

    const storedSettings = db.prepare("SELECT key, value FROM settings WHERE key IN ('business_phone', 'phone')").all();
    assert.equal(storedSettings.length, 2);
  });
});
