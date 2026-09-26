import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const registered = new Map<string, (...args: any[]) => any>();
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-ipc-'));
const { buildBillDocument, buildKotDocument } = require('../shared/print/document');

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      ipcMain: {
        on: () => {},
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

const { initDatabase, closeDatabase } = require('../main/db');
const { registerIpcHandlers } = require('../main/ipc');

async function run(): Promise<void> {
  const trustedSender = { sender: { getURL: () => 'http://localhost:3001/' } };

  try {
    initDatabase();
    registerIpcHandlers();

    const getPrinters = registered.get('get-printers');
    assert.ok(getPrinters, 'get-printers IPC handler is registered');

    // Writing a printer is a permission-gated HTTP route (printers.manage).
    // The IPC channel that bypassed that gate is removed, not locked down, so
    // the handler must not be registered at all.
    assert.equal(
      registered.has('save-printer'),
      false,
      'save-printer IPC handler is no longer registered',
    );

    const printDocument = buildBillDocument({
      isReprint: false,
      order: { orderNumber: '', createdAt: '', tableName: '', onlinePlatform: '', externalOrderId: '', items: [] },
      bill: { billNumber: '', subtotal: 0, discountAmount: 0, taxAmount: 0, total: 0, taxComponents: [], payments: [], pointsEarned: 0, pointsRedeemed: 0, pointsBalance: null },
      business: { name: '', address: '', phone: '', taxRegistrationNumber: '', taxIdLabel: '', instagramHandle: '', footerNote: '', customerName: '', customerPhone: '', showName: true, showAddress: false, showPhone: false, showTaxId: 'never', showTaxBreakdown: false, showTableNumber: false, showCustomerName: false, showCustomerPhone: false },
    }, { columns: 42, languages: ['en'], baseDirection: 'ltr', locale: 'en-US', currency: 'USD', currencySymbol: '$', trimDecimals: false, resolveLabel: (conceptId: string) => conceptId });
    const kotDocument = buildKotDocument({
      stationName: 'Kitchen',
      order: { orderNumber: 'K-1', createdAt: '', tableName: '', orderType: '' },
      items: [],
    }, { columns: 42, languages: ['en'], baseDirection: 'ltr', locale: 'en-US', currency: '', currencySymbol: '', trimDecimals: false, resolveLabel: (conceptId: string) => conceptId });
    const rasterPrint = registered.get('rasterize-print-document');
    const rasterKot = registered.get('rasterize-kot-document');
    assert.deepEqual(await rasterPrint!(trustedSender, {
      document: printDocument,
      template: 'classic',
      profileId: 'profile',
      options: { columns: 100000000, language: 'en', locale: 'en-US', currency: 'INR', currencySymbol: '₹', trimDecimals: false, useUnicode: false, arabicShaping: false },
    }), { ok: false, error: 'Invalid raster document options' }, 'print raster IPC rejects oversized column counts');
    assert.deepEqual(await rasterKot!(trustedSender, {
      document: kotDocument,
      profileId: 'profile',
      options: { columns: 100000000, language: 'en', locale: 'en-US', useUnicode: false, arabicShaping: false },
    }), { ok: false, error: 'Invalid raster KOT options' }, 'KOT raster IPC rejects oversized column counts');
    console.log('Electron printer IPC surface matches the live SQLite schema.');
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
