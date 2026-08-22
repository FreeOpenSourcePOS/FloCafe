/**
 * Issue #390: enforce country-scoped regional preference invariants.
 *
 * Locks the backend half of the acceptance criteria for locale display
 * preferences (currency_display, number_digits, calendar):
 *   - Unsupported preferences for a country are rejected with HTTP 400.
 *   - Valid Iran (IR) preferences continue to save.
 *   - Switching IR -> US (and back) normalizes stale values to neutral defaults.
 *   - Legacy non-IR databases with stale Iran values can still save without
 *     being rejected, and both storage and businessShape() are cleansed.
 *   - Canonical currency storage (IRR) is never altered by display preferences.
 *
 * Run: node tests/run-electron-node-test.cjs tests/issue-390-locale-preference-invariants.test.ts
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-390-'));

// Electron must be mocked BEFORE any main/* import reads app.getPath.
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

const assert = require('node:assert/strict');

const {
  createApp,
  startServer,
  seedOwnerUser,
  api,
  initTestDb,
  getDatabase,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { settingsRoutes } = require('../main/routes/settings');
const { cloudSync } = require('../main/services/cloud-sync');

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, String(value), now());
}

function settingValue(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

async function main() {
  console.log('Issue #390: country-scoped regional preference invariants');
  console.log('='.repeat(60));

  const originalRefreshRegistrationProfile = cloudSync.refreshRegistrationProfile.bind(cloudSync);
  cloudSync.refreshRegistrationProfile = () => {};

  const db = initTestDb();
  const app = createApp({ '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    const owner = seedOwnerUser(db);

    // ── 1. Explicitly unsupported preferences for US are rejected ──
    const usPersian = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: { business_name: 'US Cafe', country: 'US', currency: 'USD', calendar: 'persian' },
      headers: owner.authHeader,
    });
    assert.equal(usPersian.status, 400, 'US + calendar "persian" returns HTTP 400');
    assert.equal(usPersian.data.error, 'Invalid calendar for country US', 'calendar rejection message is country-scoped');

    const usToman = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: { business_name: 'US Cafe', country: 'US', currency: 'USD', currency_display: 'toman' },
      headers: owner.authHeader,
    });
    assert.equal(usToman.status, 400, 'US + currency_display "toman" returns HTTP 400');
    assert.equal(usToman.data.error, 'Invalid currency_display for country US', 'currency_display rejection message is country-scoped');

    const usLatin = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: { business_name: 'US Cafe', country: 'US', currency: 'USD', number_digits: 'latin' },
      headers: owner.authHeader,
    });
    assert.equal(usLatin.status, 400, 'US + number_digits "latin" returns HTTP 400');
    assert.equal(usLatin.data.error, 'Invalid number_digits for country US', 'number_digits rejection message is country-scoped');

    // ── 2. Valid IR preferences save and keep canonical IRR storage ──
    const irSave = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: {
        business_name: 'Tehran Cafe',
        country: 'IR',
        currency: 'IRR',
        currency_display: 'toman',
        number_digits: 'latin',
        calendar: 'persian',
      },
      headers: owner.authHeader,
    });
    assert.equal(irSave.status, 200, 'IR + supported locale preferences returns 200');
    assert.equal(irSave.data.currency_display, 'toman', 'IR currency_display "toman" persists');
    assert.equal(irSave.data.number_digits, 'latin', 'IR number_digits "latin" persists');
    assert.equal(irSave.data.calendar, 'persian', 'IR calendar "persian" persists');
    assert.equal(settingValue(db, 'currency'), 'IRR', 'canonical currency storage remains IRR (no Toman in DB)');

    // ── 3. IR -> US transition neutralizes stale display preferences ──
    const usTransition = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: { business_name: 'US Cafe', country: 'US', currency: 'USD' },
      headers: owner.authHeader,
    });
    assert.equal(usTransition.status, 200, 'IR -> US transition saves without error');
    assert.equal(usTransition.data.currency_display, 'rial', 'IR -> US resets currency_display to neutral');
    assert.equal(usTransition.data.number_digits, 'locale', 'IR -> US resets number_digits to neutral');
    assert.equal(usTransition.data.calendar, 'locale', 'IR -> US resets calendar to neutral');
    assert.equal(settingValue(db, 'currency_display'), 'rial', 'stored currency_display is neutralized after IR -> US');
    assert.equal(settingValue(db, 'number_digits'), 'locale', 'stored number_digits is neutralized after IR -> US');
    assert.equal(settingValue(db, 'calendar'), 'locale', 'stored calendar is neutralized after IR -> US');

    // ── 4. US -> IR transition re-accepts Iran preferences ──
    const usToIr = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: {
        business_name: 'Tehran Cafe 2',
        country: 'IR',
        currency: 'IRR',
        currency_display: 'toman_short',
        number_digits: 'latin',
        calendar: 'gregorian',
      },
      headers: owner.authHeader,
    });
    assert.equal(usToIr.status, 200, 'US -> IR transition with valid preferences returns 200');
    assert.equal(usToIr.data.currency_display, 'toman_short', 'US -> IR persists currency_display "toman_short"');
    assert.equal(usToIr.data.calendar, 'gregorian', 'US -> IR persists calendar "gregorian"');

    // ── 5. Legacy non-IR DB with stale Iran values normalizes on save ──
    setSetting(db, 'country', 'US');
    setSetting(db, 'currency', 'USD');
    setSetting(db, 'currency_display', 'toman');
    setSetting(db, 'number_digits', 'latin');
    setSetting(db, 'calendar', 'persian');

    const legacyRead = await api(baseUrl, '/api/settings/business', { headers: owner.authHeader });
    assert.equal(legacyRead.status, 200, 'legacy non-IR DB GET /settings/business returns 200');
    assert.equal(legacyRead.data.currency_display, 'rial', 'businessShape neutralizes stale currency_display for non-IR');
    assert.equal(legacyRead.data.number_digits, 'locale', 'businessShape neutralizes stale number_digits for non-IR');
    assert.equal(legacyRead.data.calendar, 'locale', 'businessShape neutralizes stale calendar for non-IR');

    const legacySave = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: { business_name: 'Legacy US Cafe' },
      headers: owner.authHeader,
    });
    assert.equal(legacySave.status, 200, 'legacy non-IR DB general business save does not error');
    assert.equal(settingValue(db, 'currency_display'), 'rial', 'legacy stale currency_display is cleansed on save');
    assert.equal(settingValue(db, 'number_digits'), 'locale', 'legacy stale number_digits is cleansed on save');
    assert.equal(settingValue(db, 'calendar'), 'locale', 'legacy stale calendar is cleansed on save');
    assert.equal(settingValue(db, 'currency'), 'USD', 'canonical currency storage remains USD after normalization');

    console.log('\n✅ Issue #390 locale-preference invariant checks passed');
  } finally {
    cloudSync.refreshRegistrationProfile = originalRefreshRegistrationProfile;
    server.close();
    try { closeDatabase(); } catch {}
    Module._load = originalLoad;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
