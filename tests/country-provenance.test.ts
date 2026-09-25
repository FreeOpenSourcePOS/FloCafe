/**
 * Country provenance — what a store's configured country is actually worth.
 *
 * settings.country is seeded to 'IN' by seedInstallDefaults(), so reading it
 * says nothing about whether anyone chose India. Reporting it outward as fact
 * filed every install that had not finished setup under India: on FloAdmin,
 * two installs of one Dominican restaurant appeared as India and the Dominican
 * Republic, and 19 stores across 15 countries sat in the Indian column.
 *
 * These tests pin the distinction the fix depends on — a chosen country is
 * reported, an install default is withheld — and the OS signal that no default
 * can fake.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-country-provenance-'));

let stubLocale = 'es-DO';
let stubLocaleCountry = 'DO';

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
        getLocale: () => stubLocale,
        getLocaleCountryCode: () => stubLocaleCountry,
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  seedOwnerUser,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  now,
} = require('./helpers/test-setup');
const {
  readCountryProvenance,
  isCountryConfirmed,
  countryConfirmationPatch,
} = require('../main/services/country-provenance');
const { cloudSync } = require('../main/services/cloud-sync');

function setSettings(entries: Record<string, string>) {
  const db = getDatabase();
  for (const [key, value] of Object.entries(entries)) {
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now());
  }
}

function clearSettings(...keys: string[]) {
  const db = getDatabase();
  for (const key of keys) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

async function run() {
  const originalFetch = globalThis.fetch;

  try {
    const db = initTestDb();
    seedOwnerUser(db);

    // ── A fresh install declares nothing ──────────────────────────────────
    // seedInstallDefaults() has put country='IN' in settings, and nobody has
    // confirmed it. That is the exact state that produced the phantom Indian
    // stores, so it must report as unconfirmed rather than as India.
    clearSettings('country_confirmed_at', 'onboarding_completed');
    setSettings({ country: 'IN' });

    assertEqual(isCountryConfirmed(), false, 'a seeded country is not a confirmed one');
    let provenance = readCountryProvenance();
    assertEqual(provenance.country, null, 'an unconfirmed country is withheld, not reported as IN');
    assertEqual(provenance.countrySource, 'default', 'source is default until a human chooses');

    // The OS signal is available regardless, and is what distinguishes a real
    // Indian store from an untouched default.
    assertEqual(provenance.osCountry, 'DO', 'OS region comes from the platform, not from settings');
    assertEqual(provenance.osLocale, 'es-DO', 'OS locale is reported alongside the region');
    assert(
      typeof provenance.osTimezone === 'string' && provenance.osTimezone.length > 0,
      'a resolved IANA timezone is always available'
    );

    // ── The confirmation stamp makes the choice real ──────────────────────
    setSettings({ country_confirmed_at: new Date().toISOString() });
    assertEqual(isCountryConfirmed(), true, 'the confirmation stamp marks the country as chosen');
    provenance = readCountryProvenance();
    assertEqual(provenance.country, 'IN', 'a confirmed country is reported');
    assertEqual(provenance.countrySource, 'user', 'source is user once confirmed');

    // A merchant who genuinely is in India is now distinguishable from an
    // install that never set anything, which is the whole point.
    setSettings({ country: 'DO' });
    assertEqual(readCountryProvenance().country, 'DO', 'the confirmed country tracks settings');

    // ── Completing setup is not itself a choice ───────────────────────────
    // The wizard preselects IN and submits it whether or not the picker was
    // touched, so onboarding_completed must not launder the install default
    // into "the merchant chose India".
    clearSettings('country_confirmed_at');
    setSettings({ onboarding_completed: 'true' });
    assertEqual(isCountryConfirmed(), false, 'completing onboarding is not a country choice');
    assertEqual(readCountryProvenance().countrySource, 'default', 'setup completion alone stays default');

    // ── What does and does not count as an affirmative selection ──────────
    const changed = countryConfirmationPatch('DO', 'IN');
    assert(typeof changed.country_confirmed_at === 'string', 'a changed country is a choice');

    assertEqual(
      Object.keys(countryConfirmationPatch('IN', 'IN')).length, 0,
      'resubmitting the stored country is not a choice'
    );
    // The whole-form PUT from Settings -> Business, with the country untouched.
    assertEqual(
      Object.keys(countryConfirmationPatch('IN', 'IN', undefined)).length, 0,
      'a full-form save that echoes the default does not confirm it'
    );
    assertEqual(
      Object.keys(countryConfirmationPatch(undefined, 'IN')).length, 0,
      'omitting the country is not a choice'
    );
    assertEqual(
      Object.keys(countryConfirmationPatch('not-a-code', 'IN')).length, 0,
      'an unparseable country is not a choice'
    );
    // Case and whitespace must not read as a change.
    assertEqual(
      Object.keys(countryConfirmationPatch(' do ', 'DO')).length, 0,
      'a differently-cased resubmission is not a choice'
    );
    // The one case a diff cannot see: deliberately picking the current value.
    assert(
      typeof countryConfirmationPatch('IN', 'IN', true).country_confirmed_at === 'string',
      'an explicit selection signal confirms even without a change'
    );

    // ── Malformed codes never reach the wire ──────────────────────────────
    // Re-confirm first: the block above deliberately left the store
    // unconfirmed, and an unconfirmed country reads as null whatever it holds,
    // which would pass these two assertions without testing normalisation.
    setSettings({ country_confirmed_at: new Date().toISOString() });
    setSettings({ country: 'Dominican Republic' });
    assertEqual(readCountryProvenance().country, null, 'a non ISO-3166 code is dropped');
    setSettings({ country: 'do' });
    assertEqual(readCountryProvenance().country, 'DO', 'a lowercase code is normalised');

    // ── A platform that cannot answer is not an error ─────────────────────
    // Older Electron, a stripped Linux box, or the test stub: a missing signal
    // is a null, never a failed registration.
    const savedLocale = stubLocale;
    const savedCountry = stubLocaleCountry;
    stubLocale = '';
    stubLocaleCountry = 'not-a-code';
    provenance = readCountryProvenance();
    assertEqual(provenance.osCountry, null, 'an unusable OS region degrades to null');
    assertEqual(provenance.osLocale, null, 'an empty OS locale degrades to null');
    stubLocale = savedLocale;
    stubLocaleCountry = savedCountry;

    // ── The register payload carries all of it ────────────────────────────
    let body: any = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      // Capture only the registration call. A successful register also fires a
      // welcome-email request, which would otherwise clobber the body under test.
      if (String(url).includes('/api/pos/register')) {
        body = JSON.parse(String(init?.body || '{}'));
      }
      return new Response(
        JSON.stringify({ api_key: 'fac_live_test', store_id: '1', pos_id: 'pos_1' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    clearSettings('country_confirmed_at', 'onboarding_completed');
    // Suppresses the post-registration welcome email so this test exercises the
    // register call and nothing else.
    setSettings({ country: 'IN', cloud_sync_enabled: '1', cloud_verification_welcome_requested: '1' });
    await cloudSync.register();
    assertEqual(body?.business?.country, null, 'an unconfirmed install registers without a country');
    assertEqual(body?.business?.country_source, 'default', 'the payload says the value is a default');
    assertEqual(body?.business?.os_country, 'DO', 'the payload carries the OS region');
    assertEqual(body?.business?.os_locale, 'es-DO', 'the payload carries the OS locale');
    assert(
      typeof body?.business?.os_timezone === 'string' && body.business.os_timezone.length > 0,
      'the payload carries the OS timezone'
    );

    setSettings({ country: 'DO', country_confirmed_at: new Date().toISOString() });
    body = null;
    await cloudSync.register();
    assertEqual(body?.business?.country, 'DO', 'a confirmed country is registered');
    assertEqual(body?.business?.country_source, 'user', 'the payload says a human chose it');

    // The shared assertion helpers tally failures instead of throwing, so a
    // test that never reads the tally always reports success.
    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} country provenance assertions failed`);
    console.log('✅ Country provenance checks passed');
  } finally {
    globalThis.fetch = originalFetch;
    cloudSync.stop();
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
