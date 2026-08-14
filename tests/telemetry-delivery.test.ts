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
const { sendEvent, TELEMETRY_URL } = require('../main/services/telemetry');

async function main() {
  initDatabase();
  const db = getDatabase();
  const set = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  set.run('telemetry_enabled', 'true', now());
  set.run('country', 'AR', now());

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
    assert.equal(requestBody?.app, 'flocafe');
    assert.equal(requestBody?.app_version, '2.7.2-test');

    let bodyCancelled = false;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 204,
      body: { cancel: async () => { bodyCancelled = true; } },
    }) as unknown as Response) as typeof fetch;
    assert.equal(await sendEvent('app_launch'), true, 'telemetry delivery succeeds with a response body');
    assert.equal(bodyCancelled, true, 'telemetry cancels the response body before settling');

    globalThis.fetch = (async () => new Response('rejected', { status: 503 })) as typeof fetch;
    assert.equal(await sendEvent('daily_ping'), false, 'non-2xx telemetry is reported as undelivered');

    set.run('telemetry_enabled', 'false', now());
    let calledWhileDisabled = false;
    globalThis.fetch = (async () => {
      calledWhileDisabled = true;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    assert.equal(await sendEvent('app_launch'), false, 'disabled telemetry remains a no-op');
    assert.equal(calledWhileDisabled, false);

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
