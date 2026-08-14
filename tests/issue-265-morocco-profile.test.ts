/**
 * Regression test for #265.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-265-morocco-profile.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-265-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  api,
  assert,
  assertEqual,
  assertIncludes,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');

const {
  COUNTRIES,
  countryName,
  formatCurrency,
  getCountryByCode,
  getCurrencySymbol,
} = require('../main/countries');
const { authRoutes } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');

function countrySearch(query: string) {
  const q = query.trim().toLowerCase();
  return COUNTRIES.filter((country: any) => (
    countryName(country.code).toLowerCase().includes(q)
    || country.code.toLowerCase().includes(q)
    || country.currency.toLowerCase().includes(q)
    || country.locale.toLowerCase().includes(q)
  ));
}

async function main() {
  console.log('Issue #265: Morocco / MAD country profile');
  console.log('='.repeat(60));

  let server;
  const db = initTestDb();
  const app = createApp({
    '/api/auth': authRoutes,
    '/api/settings': settingsRoutes,
  });
  const started = await startServer(app);
  server = started.server;
  const baseUrl = started.baseUrl;

  try {
    console.log('\n1. Shared country registry exposes Morocco');
    const morocco = getCountryByCode('MA');
    assert(!!morocco, 'MA country profile exists');
    assertEqual(morocco.currency, 'MAD', 'MA currency is MAD');
    assertEqual(morocco.timezone, 'Africa/Casablanca', 'MA timezone is Africa/Casablanca');
    assertEqual(morocco.locale, 'fr-MA', 'MA locale is fr-MA');
    assertEqual(morocco.dialCode, '+212', 'MA dial code is +212');
    assertEqual(getCurrencySymbol('MAD', morocco.locale), 'MAD', 'MAD symbol policy uses ISO code');
    assertIncludes(formatCurrency(12.5, 'MAD', morocco.locale), 'MAD', 'fr-MA currency format includes MAD');

    console.log('\n2. Setup and Settings search inputs can find Morocco');
    assert(countrySearch('Morocco').some((country: any) => country.code === 'MA'), 'search by country name finds MA');
    assert(countrySearch('MA').some((country: any) => country.code === 'MA'), 'search by country code finds MA');
    assert(countrySearch('MAD').some((country: any) => country.code === 'MA'), 'search by currency finds MA');
    assert(countrySearch('fr-MA').some((country: any) => country.code === 'MA'), 'search by locale finds MA');

    console.log('\n3. First-run setup persists the Morocco profile');
    const setupRes = await api(baseUrl, '/api/auth/setup/initialize', {
      method: 'POST',
      body: {
        name: 'Morocco Owner',
        email: 'ma-owner@test.local',
        password: 'Test1234',
        business_type: 'restaurant',
        business_name: 'Cafe Maroc',
        setup_profile: 'empty',
        service_model: 'qsr',
        country: 'MA',
        currency: 'MAD',
        timezone: 'Africa/Casablanca',
        language: 'en',
        terms_accepted: true,
      },
    });
    assertEqual(setupRes.status, 200, 'setup/initialize returns 200 for MA');
    assertEqual(setupRes.data.tenant.country, 'MA', 'setup tenant country is MA');
    assertEqual(setupRes.data.tenant.currency, 'MAD', 'setup tenant currency is MAD');
    assertEqual(setupRes.data.tenant.currency_symbol, 'MAD', 'setup tenant symbol is MAD');
    assertEqual(setupRes.data.tenant.timezone, 'Africa/Casablanca', 'setup tenant timezone is Africa/Casablanca');

    const authHeader = { Authorization: `Bearer ${setupRes.data.access_token}` };
    const stored = Object.fromEntries(
      (db.prepare("SELECT key, value FROM settings WHERE key IN ('country', 'currency', 'currency_symbol', 'timezone')").all() as any[])
        .map((row: any) => [row.key, row.value]),
    );
    assertEqual(stored.country, 'MA', 'settings.country persisted as MA');
    assertEqual(stored.currency, 'MAD', 'settings.currency persisted as MAD');
    assertEqual(stored.currency_symbol, 'MAD', 'settings.currency_symbol persisted as MAD');
    assertEqual(stored.timezone, 'Africa/Casablanca', 'settings.timezone persisted as Africa/Casablanca');

    console.log('\n4. Settings round-trip and auth tenant refresh keep the profile');
    const settingsRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: authHeader,
      body: {
        business_name: 'Cafe Maroc Updated',
        country: 'MA',
        currency: 'MAD',
        timezone: 'Africa/Casablanca',
      },
    });
    assertEqual(settingsRes.status, 200, 'business settings update succeeds');
    assertEqual(settingsRes.data.country, 'MA', 'business settings response keeps MA');
    assertEqual(settingsRes.data.currency, 'MAD', 'business settings response keeps MAD');

    const meRes = await api(baseUrl, '/api/auth/me', { headers: authHeader });
    assertEqual(meRes.status, 200, 'auth/me succeeds');
    const refreshedTenant = meRes.data.tenants?.[0];
    assertEqual(refreshedTenant?.country, 'MA', 'auth/me tenant country is MA');
    assertEqual(refreshedTenant?.currency, 'MAD', 'auth/me tenant currency is MAD');
    assertEqual(refreshedTenant?.currency_symbol, 'MAD', 'auth/me tenant symbol is MAD');
    assertEqual(refreshedTenant?.timezone, 'Africa/Casablanca', 'auth/me tenant timezone is Africa/Casablanca');
  } finally {
    if (server) server.close();
    closeDatabase();
    Module._load = originalLoad;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  try { closeDatabase(); } catch { /* ignore */ }
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  Module._load = originalLoad;
  process.exit(1);
});
