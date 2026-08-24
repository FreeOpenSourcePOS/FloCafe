import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const registered = new Map<string, (...args: any[]) => any>();
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-ipc-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      ipcMain: {
        handle: (channel: string, listener: (...args: any[]) => any) => {
          registered.set(channel, listener);
        },
      },
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => ({ response: 1 }),
      },
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
        getName: () => 'FloCafe',
      },
      BrowserWindow: class {},
    };
  }
  if (request === './middleware/security') {
    return { clearInMemoryRevokedTokens: () => {}, clearUserAuthCache: () => {} };
  }
  if (request === './routes/auth') return { clearJWTSecretCache: () => {} };
  if (request === './server') return { getLocalIP: () => '127.0.0.1' };
  if (request === './kds-server') return { getKdsPort: () => 3002 };
  if (request === './services/master-pin') {
    return {
      authorizeMasterPin: () => ({ ok: false, error: 'Invalid master PIN' }),
      isMasterPinAvailable: () => true,
      isMasterPinSet: () => true,
    };
  }
  if (request === './services/schema-health') {
    return {
      runHealthCheck: () => ({ status: 'healthy', findings: [] }),
      applySafeFixes: () => ({ applied: [], skipped: [], errors: [] }),
    };
  }
  if (request === './services/whatsapp') return { getStatus: () => ({ connected: false }) };
  if (request === './window-options') return { createKdsWindow: () => ({}) };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase } = require('../main/db');
const { registerIpcHandlers } = require('../main/ipc');

async function run(): Promise<void> {
  const trustedSender = { sender: { getURL: () => 'http://localhost:3001/' } };

  try {
    initDatabase();
    registerIpcHandlers();

    const savePrinter = registered.get('save-printer');
    const getPrinters = registered.get('get-printers');
    assert.ok(savePrinter, 'save-printer IPC handler is registered');
    assert.ok(getPrinters, 'get-printers IPC handler is registered');

    const created = await savePrinter!(trustedSender, {
      name: 'Kitchen Printer',
      connection_type: 'network',
      ip_address: '192.168.1.50',
      port: 9100,
      is_default: true,
    });
    assert.deepEqual(created, { success: true }, 'save-printer creates a row using the current schema');

    const db = getDatabase();
    const inserted = db.prepare('SELECT * FROM printers WHERE name = ?').get('Kitchen Printer') as any;
    assert.equal(typeof inserted.id, 'string', 'new printers receive a usable identifier');
    assert.equal(inserted.connection_type, 'network');
    assert.equal(inserted.ip_address, '192.168.1.50');
    assert.equal(inserted.port, 9100);
    assert.equal(inserted.is_default, 1);

    const updated = await savePrinter!(trustedSender, {
      id: inserted.id,
      name: 'Updated Kitchen Printer',
      connection_type: 'network',
      ip_address: null,
      port: 9200,
      is_default: false,
    });
    assert.deepEqual(updated, { success: true }, 'save-printer updates a row using the current schema');

    const persisted = db.prepare('SELECT * FROM printers WHERE id = ?').get(inserted.id) as any;
    assert.equal(persisted.name, 'Updated Kitchen Printer');
    assert.equal(persisted.ip_address, null);
    assert.equal(persisted.port, 9200);
    assert.equal(persisted.is_default, 0);

    const listed = await getPrinters!(trustedSender);
    assert.equal(Array.isArray(listed), true, 'get-printers returns persisted rows through IPC');
    assert.equal(listed[0].id, inserted.id);
    console.log('Electron printer IPC create/update behavior matches the live SQLite schema.');
  } finally {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
