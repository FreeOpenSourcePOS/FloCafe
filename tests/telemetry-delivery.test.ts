import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-telemetry-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => '2.7.2-test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { telemetry, sendEvent, TELEMETRY_URL } = require('../main/services/telemetry');

async function main() {
  initDatabase();
  const db = getDatabase();
  const set = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  set.run('telemetry_enabled', 'true', now());
  set.run('country', 'AR', now());
  // settings.country is seeded to 'IN' at install, so telemetry only reports a
  // country a human confirmed. Without this stamp 'AR' is indistinguishable
  // from an untouched default and is deliberately withheld — see the
  // unconfirmed case below.
  set.run('country_confirmed_at', new Date().toISOString(), now());
  set.run('currency', 'ARS', now());
  set.run('language', 'es', now());

  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), TELEMETRY_URL);
      requestBody = JSON.parse(String(init?.body || '{}'));
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    assert.equal(await sendEvent('app_launch'), true, '2xx telemetry delivery succeeds');
    assert.equal(requestBody?.country, 'AR', 'telemetry sends the configured ISO country');
    assert.equal(requestBody?.currency, 'ARS', 'telemetry sends the configured currency');
    assert.equal(requestBody?.language, 'es', 'telemetry sends the configured UI language');
    assert.equal(
      Object.prototype.hasOwnProperty.call(requestBody ?? {}, 'tax_pack'),
      false,
      'tax_pack is omitted while taxes are disabled'
    );
    assert.equal(requestBody?.app, 'flocafe');
    assert.equal(requestBody?.app_version, '2.7.2-test');

    // Activating an official tax pack surfaces it as the tax plugin in use —
    // the bundled fallback pack (publisher 'local') never counts as one.
    set.run('taxes_enabled', 'true', now());
    db.prepare(`
      INSERT INTO country_packs (id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at)
      VALUES ('official-ar', 'official', 'AR', 'AR', 'official-ar@1.0.0', 'active', ?, ?)
    `).run(now(), now());
    db.prepare(`
      INSERT INTO country_pack_versions (
        id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
        effective_from, effective_to, min_flo_version, published_at, status, created_at
      ) VALUES ('official-ar@1.0.0', 'official-ar', '1.0.0', 1, '{}', ?, NULL, NULL, ?, NULL, '0.0.0', ?, 'active', ?)
    `).run(JSON.stringify({
      schemaVersion: 1, id: 'official-ar', publisher: 'official', version: '1.0.0', country: 'AR',
      jurisdiction: 'AR', currency: 'ARS', effectiveFrom: now(), publishedAt: now(), minFloVersion: '0.0.0',
      taxPoint: 'order_created', inclusivePricingDefault: false, registrationNumberLabel: '',
      categories: [], rules: [], businessTypes: [],
    }), now(), now(), now());
    requestBody = null;
    assert.equal(await sendEvent('app_launch'), true);
    assert.deepEqual(
      requestBody?.tax_pack,
      { id: 'official-ar', publisher: 'official' },
      'telemetry sends the active official tax plugin'
    );
    set.run('taxes_enabled', 'false', now());

    // An unconfirmed country is omitted rather than sent as the install
    // default. FloAdmin geolocates the request IP when the field is absent, so
    // omitting it is what produces a real country instead of a fake India.
    db.prepare('DELETE FROM settings WHERE key = ?').run('country_confirmed_at');
    requestBody = null;
    assert.equal(await sendEvent('app_launch'), true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(requestBody ?? {}, 'country'),
      false,
      'an unconfirmed country is omitted so the server can geolocate instead'
    );
    set.run('country_confirmed_at', new Date().toISOString(), now());

    let bodyCancelled = false;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 204,
      body: { cancel: async () => { bodyCancelled = true; } },
    }) as unknown as Response) as typeof fetch;
    assert.equal(await sendEvent('app_launch'), true, 'telemetry delivery succeeds with a response body');
    assert.equal(bodyCancelled, true, 'telemetry cancels the response body before settling');

    let non2xxBodyCancelled = false;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      body: { cancel: async () => { non2xxBodyCancelled = true; } },
    }) as unknown as Response) as typeof fetch;
    assert.equal(await sendEvent('daily_ping'), false, 'non-2xx telemetry is reported as undelivered');
    assert.equal(non2xxBodyCancelled, true, 'telemetry cancels the response body on non-2xx responses');

    // Verify telemetry.stop() drains and cancels non-2xx in-flight work before settling
    let stopBodyCancelled = false;
    let finishFetch: () => void = () => {};
    const fetchDeferred = new Promise<Response>((resolve) => {
      finishFetch = () => resolve({
        ok: false,
        status: 500,
        body: { cancel: async () => { stopBodyCancelled = true; } },
      } as unknown as Response);
    });
    globalThis.fetch = (() => fetchDeferred) as unknown as typeof fetch;

    const inFlightOp = sendEvent('app_launch');
    const stopPromise = telemetry.stop();
    finishFetch();
    assert.equal(await inFlightOp, false);
    await stopPromise;
    assert.equal(stopBodyCancelled, true, 'telemetry.stop() drains in-flight non-2xx requests and cancels response body');

    set.run('telemetry_enabled', 'false', now());
    let calledWhileDisabled = false;
    globalThis.fetch = (async () => {
      calledWhileDisabled = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    assert.equal(await sendEvent('app_launch'), false, 'disabled telemetry remains a no-op');
    assert.equal(calledWhileDisabled, false);

    set.run('telemetry_enabled', 'true', now());
    let calledWhileMatrixOffline = false;
    globalThis.fetch = (async () => {
      calledWhileMatrixOffline = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    process.env.FLO_MATRIX_OFFLINE = '1';
    telemetry.start();
    assert.equal(await sendEvent('app_launch'), false, 'matrix fixture telemetry is disabled');
    assert.equal(calledWhileMatrixOffline, false);
    await telemetry.stop();
    delete process.env.FLO_MATRIX_OFFLINE;

    console.log('✅ Telemetry delivery contract checks passed');
  } finally {
    globalThis.fetch = originalFetch;
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
