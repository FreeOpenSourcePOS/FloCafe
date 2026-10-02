/**
 * Run mode and install source detection (telemetry provenance).
 *
 * Pins the signal-to-value mapping one signal at a time so a future refactor
 * cannot quietly repoint a distribution channel, and pins the degradation
 * contract: outside Electron (unit tests, scripts) detection must report `dev`
 * instead of throwing.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/telemetry-install-provenance.test.ts
 */

import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;

// 'throw' stands in for a host where `electron` cannot be resolved at all;
// `undefined` stands in for plain Node, where `require('electron')` returns the
// binary path string and therefore has no `app`.
let appMock: { isPackaged?: boolean } | undefined | 'throw' = { isPackaged: true };

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    if (appMock === 'throw') throw new Error("Cannot find module 'electron'");
    return appMock ? { app: { ...appMock, getVersion: () => '0.0.0-provenance-test' } } : undefined;
  }
  // Nothing here touches the database; stub the module so this test is
  // independent of the better-sqlite3 native ABI.
  if (request.endsWith('/main/db') || request === '../db') {
    return {
      ensureTelemetryAnonId: () => 'anon-test-id',
      isTelemetryEnabled: () => true,
      getSettingValue: () => '',
      parseDbTimestamp: (value: string) => new Date(value),
      upsertTelemetryLastPing: () => {},
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { getRunMode, getInstallSource, sendEvent } = require('../main/services/telemetry');

const ENV_KEYS = ['SNAP', 'APPIMAGE', 'FLATPAK_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};
const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const savedWindowsStore = Object.getOwnPropertyDescriptor(process, 'windowsStore');
const savedMas = Object.getOwnPropertyDescriptor(process, 'mas');

function setProcessFlag(name: 'windowsStore' | 'mas', value: boolean): void {
  Object.defineProperty(process, name, { value, configurable: true, writable: true });
}

function clearProcessFlag(name: 'windowsStore' | 'mas'): void {
  delete (process as unknown as Record<string, unknown>)[name];
}

/** Applies one detection scenario and returns what telemetry would report. */
function detect(overrides: {
  app?: { isPackaged?: boolean } | undefined | 'throw';
  platform?: NodeJS.Platform;
  windowsStore?: boolean;
  mas?: boolean;
  env?: Record<string, string | undefined>;
}) {
  appMock = 'app' in overrides ? overrides.app : { isPackaged: true };
  Object.defineProperty(process, 'platform', { value: overrides.platform ?? 'linux', configurable: true });
  setProcessFlag('windowsStore', overrides.windowsStore ?? false);
  setProcessFlag('mas', overrides.mas ?? false);
  for (const key of ENV_KEYS) {
    const next = overrides.env?.[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  return { runMode: getRunMode(), installSource: getInstallSource() };
}

function restore(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform);
  clearProcessFlag('windowsStore');
  clearProcessFlag('mas');
  if (savedWindowsStore) Object.defineProperty(process, 'windowsStore', savedWindowsStore);
  if (savedMas) Object.defineProperty(process, 'mas', savedMas);
}

async function main() {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

  console.log('Telemetry run mode and install source detection');

  // ── Non-Electron hosts degrade to dev instead of throwing ──────────────────
  assert.deepEqual(
    detect({ app: 'throw' }),
    { runMode: 'dev', installSource: 'dev' },
    'an unresolvable electron module reports dev/dev rather than throwing'
  );
  assert.deepEqual(
    detect({ app: undefined }),
    { runMode: 'dev', installSource: 'dev' },
    'a host with no electron `app` (plain Node, scripts) reports dev/dev'
  );
  assert.deepEqual(
    detect({ app: { isPackaged: false }, platform: 'win32' }),
    { runMode: 'dev', installSource: 'dev' },
    'an unpackaged build reports dev even on a store platform'
  );
  assert.deepEqual(
    detect({ app: { isPackaged: false }, platform: 'linux', env: { SNAP: '/snap/flocafe' } }),
    { runMode: 'dev', installSource: 'dev' },
    'an unpackaged build never claims a distribution channel'
  );

  // ── Store channels, one signal at a time ───────────────────────────────────
  assert.deepEqual(
    detect({ platform: 'win32', windowsStore: true }),
    { runMode: 'packaged', installSource: 'ms_store' },
    'process.windowsStore reports ms_store'
  );
  assert.deepEqual(
    detect({ platform: 'win32', windowsStore: false }),
    { runMode: 'packaged', installSource: 'github' },
    'a packaged Windows build without windowsStore reports github'
  );
  assert.deepEqual(
    detect({ platform: 'darwin', mas: true }),
    { runMode: 'packaged', installSource: 'mac_app_store' },
    'process.mas reports mac_app_store'
  );
  assert.deepEqual(
    detect({ platform: 'darwin', mas: false }),
    { runMode: 'packaged', installSource: 'github' },
    'a packaged macOS build without mas reports github'
  );
  assert.deepEqual(
    detect({ platform: 'linux', env: { SNAP: '/snap/flocafe/current' } }),
    { runMode: 'packaged', installSource: 'snap' },
    'SNAP reports snap'
  );
  assert.deepEqual(
    detect({ platform: 'linux', env: { APPIMAGE: '/opt/FloCafe.AppImage' } }),
    { runMode: 'packaged', installSource: 'appimage' },
    'APPIMAGE reports appimage'
  );
  assert.deepEqual(
    detect({ platform: 'linux', env: { FLATPAK_ID: 'com.flopos.flocafe' } }),
    { runMode: 'packaged', installSource: 'flatpak' },
    'FLATPAK_ID reports flatpak'
  );
  assert.deepEqual(
    detect({ platform: 'linux' }),
    { runMode: 'packaged', installSource: 'linux_package' },
    'a packaged Linux build with no store signal reports the honest linux_package'
  );

  // ── Signal hygiene and precedence ──────────────────────────────────────────
  assert.deepEqual(
    detect({ platform: 'linux', env: { SNAP: '' } }),
    { runMode: 'packaged', installSource: 'linux_package' },
    'an empty SNAP variable is not a snap signal'
  );
  assert.deepEqual(
    detect({ platform: 'linux', env: { APPIMAGE: '   ' } }),
    { runMode: 'packaged', installSource: 'linux_package' },
    'a whitespace APPIMAGE variable is not an appimage signal'
  );
  assert.deepEqual(
    detect({ platform: 'linux', env: { SNAP: '/snap/f', APPIMAGE: '/opt/F.AppImage', FLATPAK_ID: 'com.f' } }),
    { runMode: 'packaged', installSource: 'snap' },
    'store signals are checked in a fixed order (snap before appimage before flatpak)'
  );
  assert.deepEqual(
    detect({ platform: 'win32', windowsStore: true, mas: true, env: { SNAP: '/snap/f' } }),
    { runMode: 'packaged', installSource: 'ms_store' },
    'windowsStore outranks the mac and Linux signals'
  );
  assert.deepEqual(
    detect({ platform: 'darwin', mas: true, env: { SNAP: '/snap/f' } }),
    { runMode: 'packaged', installSource: 'mac_app_store' },
    'mas outranks the Linux signals'
  );

  // ── Both fields ride the existing telemetry payload ───────────────────────
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body || '{}'));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    detect({ platform: 'linux' });
    assert.equal(await sendEvent('app_launch'), true, 'telemetry delivery succeeds');
    assert.deepEqual(
      { run_mode: body?.run_mode, install_source: body?.install_source },
      { run_mode: 'packaged', install_source: 'linux_package' },
      'sendEvent reports the detected run mode and install source alongside existing fields'
    );
    assert.equal(body?.app, 'flocafe', 'existing telemetry fields are preserved');
    assert.equal(body?.event_type, 'app_launch', 'existing event type is preserved');

    detect({ app: { isPackaged: false }, platform: 'darwin' });
    body = null;
    assert.equal(await sendEvent('daily_ping'), true, 'dev telemetry delivery succeeds');
    assert.deepEqual(
      { run_mode: body?.run_mode, install_source: body?.install_source },
      { run_mode: 'dev', install_source: 'dev' },
      'a dev run reports dev/dev over the wire'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('✅ Telemetry install provenance checks passed');
}

main()
  .then(() => {
    restore();
  })
  .catch((error) => {
    restore();
    console.error(error);
    process.exit(1);
  });