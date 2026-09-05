/**
 * Issue #389: tenant timezone override independent of country default.
 *
 * Locks the backend half of the acceptance criteria for the Settings route:
 *   - PUT /api/settings/business persists any valid IANA timezone (e.g. a
 *     Vancouver store keeps CAD currency while overriding America/Toronto).
 *   - Invalid IANA timezone strings are rejected with the documented 400
 *     "Invalid timezone, currency, or country" shape.
 *
 * Run: node tests/run-electron-node-test.cjs tests/issue-389-timezone-override.test.ts
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-389-'));

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
} = require('./helpers/test-setup');

const { settingsRoutes } = require('../main/routes/settings');
const { cloudSync } = require('../main/services/cloud-sync');

async function main() {
  console.log('Issue #389: tenant timezone override independent of country default');
  console.log('='.repeat(60));

  // refreshRegistrationProfile is best-effort FloAdmin telemetry; there is no
  // cloud account in this fixture, so pin it to a no-op for determinism.
  const originalRefreshRegistrationProfile = cloudSync.refreshRegistrationProfile.bind(cloudSync);
  cloudSync.refreshRegistrationProfile = () => {};

  const db = initTestDb();
  const app = createApp({ '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    const owner = seedOwnerUser(db);

    // ── Custom timezone for a multi-timezone country persists + round-trips ──
    const putRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: {
        business_name: 'Vancouver Cafe',
        country: 'CA',
        currency: 'CAD',
        timezone: 'America/Vancouver',
      },
      headers: owner.authHeader,
    });
    assert.equal(putRes.status, 200, 'PUT /api/settings/business accepts a custom IANA timezone');
    assert.equal(putRes.data.country, 'CA', 'PUT preserves country = CA');
    assert.equal(putRes.data.currency, 'CAD', 'PUT keeps currency governed by the country profile');
    assert.equal(putRes.data.timezone, 'America/Vancouver', 'PUT persists America/Vancouver instead of the America/Toronto default');

    const getRes = await api(baseUrl, '/api/settings/business', { headers: owner.authHeader });
    assert.equal(getRes.status, 200, 'GET /api/settings/business returns 200');
    assert.equal(getRes.data.timezone, 'America/Vancouver', 'custom timezone survives a fresh read (page refresh / restart path)');

    const stored = db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string };
    assert.equal(stored.value, 'America/Vancouver', 'settings.timezone row persists the custom timezone');

    const lowercaseCurrencyRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: { currency: 'xxx' },
      headers: owner.authHeader,
    });
    assert.equal(lowercaseCurrencyRes.status, 200, 'PUT /api/settings/business accepts lowercase currency codes');
    assert.equal(lowercaseCurrencyRes.data.currency, 'XXX', 'business settings response canonicalizes currency codes');
    const storedCurrency = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value: string };
    assert.equal(storedCurrency.value, 'XXX', 'settings.currency row persists the canonical uppercase code');

    const wildcardCurrencyRes = await api(baseUrl, '/api/settings/currency', {
      method: 'PUT',
      body: { value: 'jpy' },
      headers: owner.authHeader,
    });
    assert.equal(wildcardCurrencyRes.status, 200, 'wildcard currency settings accept lowercase input');
    assert.equal(wildcardCurrencyRes.data.setting.value, 'JPY', 'wildcard currency settings canonicalize input');

    const invalidWildcardCurrencyRes = await api(baseUrl, '/api/settings/currency', {
      method: 'PUT',
      body: { value: 'US' },
      headers: owner.authHeader,
    });
    assert.equal(invalidWildcardCurrencyRes.status, 400, 'wildcard currency settings reject invalid codes');

    // ── Invalid IANA timezone → documented 400 shape ──
    const badRes = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      body: {
        business_name: 'Bad Timezone',
        country: 'CA',
        currency: 'CAD',
        timezone: 'Not/A_Real_Zone',
      },
      headers: owner.authHeader,
    });
    assert.equal(badRes.status, 400, 'PUT /api/settings/business rejects an invalid IANA timezone');
    assert.equal(badRes.data.error, 'Invalid timezone, currency, or country', '400 error matches the documented message');

    console.log('  ✓ custom timezone persists and invalid timezones are rejected');
    console.log('\n✅ Issue #389 settings-route timezone checks passed');
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
