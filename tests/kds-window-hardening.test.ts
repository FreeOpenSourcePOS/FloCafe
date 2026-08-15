import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  closeHandlers: Function[] = [];
  constructor(opts: any) {
    this.webPreferences = opts.webPreferences;
    windows.push(this);
  }
  on(event: string, cb: Function) {
    if (event === 'closed') {
      this.closeHandlers.push(cb);
    }
  }
  loadURL(url: string) {
    this.loadedUrl = url;
  }
  focus() {}
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.destroyed = true;
    this.closeHandlers.forEach((cb) => cb());
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
      dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/flo-backup.db' }),
        showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/flo-backup.db'] }),
        showMessageBox: async () => ({ response: 0 }),
      },
      app: { getPath: () => '/tmp/flo-kds-test', getVersion: () => '3.2.0', getName: () => 'FloCafe' },
      BrowserWindow: FakeBrowserWindow,
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  if (request === './db') {
    const fakeDb = {
      prepare: (sql: string) => ({
        all: () => (sql.includes('settings') ? [{ key: 'business_name', value: 'Flo Cafe' }] : [{ id: 1, name: 'Thermal Kitchen' }]),
        get: () => ({ bill_count: 5, revenue: 120.50, covers: 12, count: 2 }),
        run: () => ({ changes: 1 }),
      }),
    };
    return {
      getDatabase: () => fakeDb,
      createBackup: async () => ({ path: '/tmp/flo-backup.db', schemaVersion: 68 }),
      restoreBackup: async () => ({ success: true, mode: 'full', tablesRestored: 20 }),
      now: () => new Date().toISOString(),
      getCurrentSchemaVersion: () => 68,
      getSchemaVersionFromBackup: () => 68,
      resetDatabaseWithBackup: async () => ({ backupPath: '/tmp/flo-backup.db' }),
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
      authorizeMasterPin: (pin?: string) => (pin === '1234' ? { ok: true } : { ok: false, error: 'Invalid master PIN' }),
      isMasterPinAvailable: () => true,
      isMasterPinSet: () => true,
    };
  }
  if (request === './services/schema-health') {
    return {
      runHealthCheck: () => ({ status: 'healthy', findings: [] }),
      applySafeFixes: () => ({ applied: ['fix1'], skipped: [], errors: [] }),
    };
  }
  if (request === './services/whatsapp') {
    return { getStatus: () => ({ connected: false, qrCode: null }) };
  }
  return originalLoad.apply(this, arguments as any);
};

import { registerIpcHandlers } from '../main/ipc';

async function run(): Promise<void> {
  const evidenceLogs: string[] = [];
  const log = (msg: string) => {
    console.log(msg);
    evidenceLogs.push(msg);
  };

  log('=== GHSA-jmmq-fjg5-g6px KDS Window & IPC Hardening Verification ===');

  registerIpcHandlers();

  const trustedLocalhost = { sender: { getURL: () => 'http://localhost:3001/' } };
  const trusted127 = { sender: { getURL: () => 'http://127.0.0.1:3001/pos' } };
  const untrustedKds = { sender: { getURL: () => 'http://192.168.1.50:3002/kds' } };
  const untrustedExternal = { sender: { getURL: () => 'http://evil.example.com/' } };
  const untrustedSpoofedPrefix = { sender: { getURL: () => 'http://localhost.evil.com/' } };
  const untrustedNullSender = { sender: { getURL: () => null } };

  // 1. Verify ALL non-PIN-gated handlers enforce sender identity
  const nonPinGatedHandlers = [
    { channel: 'db-health-check', args: [] },
    { channel: 'db-apply-safe-fixes', args: [['finding-1']] },
    { channel: 'master-pin-status', args: [] },
    { channel: 'get-settings', args: [] },
    { channel: 'set-setting', args: ['business_name', 'My Cafe'] },
    { channel: 'whatsapp-get-status', args: [] },
    { channel: 'get-kds-info', args: [] },
    { channel: 'open-kds-window', args: [] },
    { channel: 'get-app-info', args: [] },
    { channel: 'get-printers', args: [] },
    { channel: 'save-printer', args: [{ name: 'Kitchen Printer', type: 'thermal', connection_type: 'network' }] },
    { channel: 'get-daily-summary', args: [] },
  ];

  log(`\n[Phase 1] Verifying sender identity across ${nonPinGatedHandlers.length} non-PIN-gated IPC channels...`);

  for (const { channel, args } of nonPinGatedHandlers) {
    const listener = registered.get(channel);
    assert.ok(listener, `IPC channel '${channel}' is registered`);

    // Test rejection of untrusted senders
    const kdsRes = await listener(untrustedKds, ...args);
    assert.deepEqual(kdsRes, { error: 'Unauthorized sender' }, `${channel} rejected KDS origin sender`);

    const extRes = await listener(untrustedExternal, ...args);
    assert.deepEqual(extRes, { error: 'Unauthorized sender' }, `${channel} rejected external origin sender`);

    const spoofRes = await listener(untrustedSpoofedPrefix, ...args);
    assert.deepEqual(spoofRes, { error: 'Unauthorized sender' }, `${channel} rejected spoofed prefix sender`);

    const nullRes = await listener(untrustedNullSender, ...args);
    assert.deepEqual(nullRes, { error: 'Unauthorized sender' }, `${channel} rejected null sender`);

    // Test acceptance of trusted localhost and 127.0.0.1 senders
    const localRes = await listener(trustedLocalhost, ...args);
    assert.notDeepEqual(localRes, { error: 'Unauthorized sender' }, `${channel} accepted localhost sender`);

    const loopbackRes = await listener(trusted127, ...args);
    assert.notDeepEqual(loopbackRes, { error: 'Unauthorized sender' }, `${channel} accepted 127.0.0.1 sender`);

    log(`  ✓ ${channel}: successfully blocks untrusted senders and admits trusted origins`);
  }

  // 2. PIN-gated handlers enforce master PIN
  log('\n[Phase 2] Verifying PIN-gated handlers require authorization...');
  const backupListener = registered.get('backup-database')!;
  const invalidPinRes = await backupListener(trustedLocalhost, 'wrong-pin');
  assert.equal(invalidPinRes.success, false, 'backup rejected invalid PIN');
  assert.equal(invalidPinRes.error, 'Invalid master PIN');
  const validPinRes = await backupListener(trustedLocalhost, '1234');
  assert.equal(validPinRes.success, true, 'backup accepted valid PIN');
  log('  ✓ backup-database: successfully protected by master PIN');

  // 3. KDS window webPreferences: privileged preload bridge removed, isolation intact
  log('\n[Phase 3] Verifying KDS window construction and bridge removal...');
  while (windows.length > 0) {
    const w = windows.pop();
    w.close();
  }
  const openKdsListener = registered.get('open-kds-window')!;
  await openKdsListener(trustedLocalhost);
  assert.equal(windows.length, 1, 'a KDS window is created');
  const kdsWindow = windows[0];

  assert.equal(kdsWindow.webPreferences.preload, undefined, 'KDS window webPreferences.preload is undefined (bridge removed)');
  assert.equal(kdsWindow.webPreferences.contextIsolation, true, 'context isolation remains enabled');
  assert.equal(kdsWindow.webPreferences.nodeIntegration, false, 'node integration remains disabled');
  assert.equal(kdsWindow.loadedUrl, 'http://192.168.1.50:3002/kds', 'KDS window loads http://192.168.1.50:3002/kds');
  log('  ✓ BrowserWindow webPreferences: preload=undefined, contextIsolation=true, nodeIntegration=false');

  // 4. Navigation confinement to KDS origin and window-open denial
  log('\n[Phase 4] Verifying KDS window navigation confinement...');
  const navigateHandlers = kdsWindow.webContents.handlers.get('will-navigate')!;
  assert.ok(navigateHandlers && navigateHandlers.length === 1, 'will-navigate handler is installed');
  const navigate = navigateHandlers[0];

  let prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'http://evil.example.com/');
  assert.equal(prevented, true, 'navigation to external origin is prevented');

  prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'http://192.168.1.50:3002/kds/station/1');
  assert.equal(prevented, false, 'navigation within KDS origin is allowed');

  prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'http://localhost:3001/');
  assert.equal(prevented, true, 'navigation to main POS origin is prevented');

  prevented = false;
  navigate({ preventDefault: () => { prevented = true; } }, 'javascript:alert(1)');
  assert.equal(prevented, true, 'navigation to javascript pseudo-protocol is prevented');

  assert.deepEqual(kdsWindow.webContents.windowOpenHandler!(), { action: 'deny' }, 'new windows via window.open are denied');
  log('  ✓ will-navigate strictly confines navigation to http://192.168.1.50:3002');
  log('  ✓ windowOpenHandler denies all popup/new-window requests');

  log('\n✅ All KDS window hardening and IPC security checks passed successfully.');

  // Write evidence to output directory if present
  const evidenceDir = '/var/folders/y_/1ltcxtwj0zd_w1dg9jv4jl580000gn/T/no-mistakes-evidence/01M03SG09151P3VMMYNWFRVWA2';
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, 'kds-window-hardening-verification.txt');
    fs.writeFileSync(evidencePath, evidenceLogs.join('\n') + '\n', 'utf8');
    console.log(`[Evidence] Written verification log to: ${evidencePath}`);
  } catch (e: any) {
    console.warn(`[Evidence] Could not write to ${evidenceDir}: ${e.message}`);
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    Module._load = originalLoad;
  });

