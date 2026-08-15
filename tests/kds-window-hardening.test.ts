import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;

const registered = new Map<string, (...args: any[]) => any>();
const windows: any[] = [];

class FakeWebContents {
  handlers = new Map<string, Function[]>();
  windowOpenHandler: ((...args: any[]) => any) | null = null;
  on(event: string, cb: Function) {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  setWindowOpenHandler(cb: (...args: any[]) => any) {
    this.windowOpenHandler = cb;
  }
}

class FakeBrowserWindow {
  webPreferences: any;
  webContents = new FakeWebContents();
  loadedUrl = '';
  destroyed = false;
  constructor(opts: any) {
    this.webPreferences = opts.webPreferences;
    windows.push(this);
  }
  on() {}
  loadURL(url: string) {
    this.loadedUrl = url;
  }
  focus() {}
  isDestroyed() {
    return this.destroyed;
  }
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      ipcMain: {
        handle: (channel: string, listener: (...args: any[]) => any) => {
          registered.set(channel, listener);
        },
      },
      dialog: {},
      app: { getPath: () => '/tmp/flo-kds-test', getVersion: () => 'test' },
      BrowserWindow: FakeBrowserWindow,
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  if (request === './db') {
    return {
      getDatabase: () => ({}),
      createBackup: async () => ({ path: '', schemaVersion: 0 }),
      restoreBackup: async () => ({ success: true }),
      now: () => new Date().toISOString(),
      getCurrentSchemaVersion: () => 1,
      getSchemaVersionFromBackup: () => 1,
      resetDatabaseWithBackup: async () => ({ backupPath: '' }),
      withDatabaseMaintenanceLock: async (fn: any) => fn(),
      withDatabaseRequest: async (fn: any) => fn(),
    };
  }
  if (request === './middleware/security') {
    return { clearInMemoryRevokedTokens: () => {}, clearUserAuthCache: () => {} };
  }
  if (request === './server') {
    return { getLocalIP: () => '192.168.1.50' };
  }
  if (request === './routes/auth') {
    return { clearJWTSecretCache: () => {} };
  }
  if (request === './kds-server') {
    return { getKdsPort: () => 3002 };
  }
  if (request === './services/master-pin') {
    return {
      authorizeMasterPin: () => ({ ok: true }),
      isMasterPinAvailable: () => true,
      isMasterPinSet: () => true,
    };
  }
  if (request === './services/schema-health') {
    return { runHealthCheck: () => ({}), applySafeFixes: () => ({}) };
  }
  if (request === './services/whatsapp') {
    return { getStatus: () => ({}) };
  }
  return originalLoad.apply(this, arguments as any);
};

import { registerIpcHandlers } from '../main/ipc';

async function run(): Promise<void> {
  registerIpcHandlers();

  const trustedEvent = { sender: { getURL: () => 'http://localhost:3001/' } };
  const untrustedEvent = { sender: { getURL: () => 'http://192.168.1.50:3002/kds' } };

  // 1. Non-PIN-gated handlers reject a non-local sender (defense-in-depth).
  const masterPinListener = registered.get('master-pin-status')!;
  assert.deepEqual(
    await masterPinListener(untrustedEvent),
    { error: 'Unauthorized sender' },
    'non-localhost sender is rejected',
  );
  assert.deepEqual(
    await masterPinListener(trustedEvent),
    { available: true, isSet: true },
    'localhost sender is allowed',
  );

  // 2. KDS window is created without the privileged preload bridge.
  const openKdsListener = registered.get('open-kds-window')!;
  await openKdsListener(trustedEvent);
  assert.equal(windows.length, 1, 'a KDS window is created');
  const kdsWindow = windows[0];
  assert.equal(kdsWindow.webPreferences.preload, undefined, 'KDS window has no privileged preload');
  assert.equal(kdsWindow.webPreferences.contextIsolation, true, 'context isolation remains enabled');
  assert.equal(kdsWindow.webPreferences.nodeIntegration, false, 'node integration remains disabled');
  assert.equal(kdsWindow.loadedUrl, 'http://192.168.1.50:3002/kds', 'KDS window loads the KDS URL');

  // 3. Navigation is confined to the KDS origin.
  const navigateHandlers = kdsWindow.webContents.handlers.get('will-navigate')!;
  assert.ok(navigateHandlers && navigateHandlers.length === 1, 'will-navigate handler is installed');
  const navigate = navigateHandlers[0];

  let prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'http://evil.example.com/');
  assert.equal(prevented, true, 'navigation to an external origin is prevented');

  prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'http://192.168.1.50:3002/kds');
  assert.equal(prevented, false, 'navigation within the KDS origin is allowed');

  prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'http://localhost:3001/');
  assert.equal(prevented, true, 'navigation to the main POS origin is prevented');

  // 4. New windows are denied.
  assert.deepEqual(kdsWindow.webContents.windowOpenHandler!(), { action: 'deny' }, 'new windows are denied');

  console.log('✅ KDS window hardening tests passed');
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    Module._load = originalLoad;
  });
