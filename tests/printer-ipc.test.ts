import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const registered = new Map<string, (...args: any[]) => any>();
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-printer-ipc-'));
const { buildBillDocument, buildKotDocument } = require('../shared/print/document');

// Offscreen PDF export builds a hidden BrowserWindow and asks it to print. A
// recording stand-in lets the suite assert the surface it is handed, the page
// size it asks for, and the window teardown, without a real Chromium renderer.
let saveDialogResult: any = { canceled: true };
let lastSaveDialogOptions: any = null;
let printToPdfFailure: Error | null = null;
const pdfWindows: any[] = [];

class RecordingWindow {
  options: any;
  destroyed = false;
  loadedUrl: string | null = null;
  pdfOptions: any = null;
  webContents: any;

  constructor(options: any = {}) {
    this.options = options;
    this.webContents = {
      printToPDF: async (printOptions: any) => {
        this.pdfOptions = printOptions;
        if (printToPdfFailure) throw printToPdfFailure;
        return Buffer.from('%PDF-1.4 recorded');
      },
    };
    pdfWindows.push(this);
  }

  async loadURL(url: string): Promise<void> { this.loadedUrl = url; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
  static fromWebContents(): null { return null; }
}

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
        showSaveDialog: async (options: any) => {
          lastSaveDialogOptions = options;
          return saveDialogResult;
        },
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showMessageBox: async () => ({ response: 1 }),
      },
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'test',
        getName: () => 'FloCafe',
      },
      BrowserWindow: RecordingWindow,
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
      order: { orderNumber: '', createdAt: '', tableName: '', onlinePlatform: '', externalOrderId: '', deliveryAddress: '', items: [] },
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
    // Saves the renderer-built menu as a PDF without a printer attached.
    const saveHtmlAsPdf = registered.get('save-html-as-pdf');
    assert.ok(saveHtmlAsPdf, 'save-html-as-pdf IPC handler is registered');

    assert.deepEqual(
      await saveHtmlAsPdf!({ sender: { getURL: () => 'https://example.com/' } }, { html: '<html></html>' }),
      { error: 'Unauthorized sender' },
      'PDF export refuses a sender that is not the local POS renderer',
    );

    for (const payload of [null, 'html', 42, {}, { html: '' }, { html: 42 }]) {
      assert.deepEqual(
        await saveHtmlAsPdf!(trustedSender, payload),
        { success: false, error: 'Invalid PDF request' },
        `PDF export rejects ${JSON.stringify(payload)}`,
      );
    }

    assert.deepEqual(
      await saveHtmlAsPdf!(trustedSender, { html: `<p>${'x'.repeat(2_000_001)}</p>` }),
      { success: false, error: 'Document too large to export' },
      'PDF export refuses a document over the size cap',
    );

    saveDialogResult = { canceled: true };
    assert.deepEqual(
      await saveHtmlAsPdf!(trustedSender, { html: '<html><body>Menu</body></html>' }),
      { success: false, canceled: true },
      'a cancelled save reports cancellation rather than failure',
    );
    assert.equal(pdfWindows.length, 0, 'a cancelled save never opens an offscreen window');

    const pdfPath = path.join(testDir, 'menu.pdf');
    saveDialogResult = { canceled: false, filePath: pdfPath };
    assert.deepEqual(
      await saveHtmlAsPdf!(trustedSender, { html: '<html><body>Menu</body></html>', defaultFileName: 'menu', pageSize: 'Letter' }),
      { success: true, path: pdfPath },
      'an accepted save reports the written path',
    );
    assert.equal(fs.readFileSync(pdfPath, 'utf8'), '%PDF-1.4 recorded', 'the rendered PDF bytes land in the chosen file');
    assert.equal(pdfWindows.length, 1, 'exactly one offscreen window renders the document');
    const pdfWindow = pdfWindows[0];
    assert.equal(pdfWindow.options.show, false, 'the PDF window is never shown');
    assert.deepEqual(
      pdfWindow.options.webPreferences,
      { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false },
      'the PDF window is isolated and runs no scripts',
    );
    assert.ok(String(pdfWindow.loadedUrl).startsWith('data:text/html'), 'the document is loaded as inline HTML rather than a file path');
    assert.deepEqual(pdfWindow.pdfOptions, { printBackground: true, pageSize: 'Letter' }, 'the requested page size reaches the print call');
    assert.equal(pdfWindow.destroyed, true, 'the offscreen window is destroyed after export');
    assert.deepEqual(lastSaveDialogOptions.filters, [{ name: 'PDF', extensions: ['pdf'] }], 'the save dialog offers PDF files');
    assert.equal(path.basename(lastSaveDialogOptions.defaultPath), 'menu.pdf', 'a suggested name without an extension gets one');
    assert.equal(path.dirname(lastSaveDialogOptions.defaultPath), testDir, 'the save dialog opens in the documents folder');

    saveDialogResult = { canceled: false, filePath: path.join(testDir, 'menu-a4.pdf') };
    await saveHtmlAsPdf!(trustedSender, { html: '<html></html>', defaultFileName: '../escape:name', pageSize: 'A5' });
    assert.equal(pdfWindows[1].pdfOptions.pageSize, 'A4', 'an unsupported page size falls back to A4');
    assert.equal(path.basename(lastSaveDialogOptions.defaultPath), '..-escape-name.pdf', 'a directory separator in the suggested name is neutralised');
    assert.equal(path.dirname(lastSaveDialogOptions.defaultPath), testDir, 'the suggested name cannot steer the save outside the documents folder');

    printToPdfFailure = new Error('render surface crashed');
    saveDialogResult = { canceled: false, filePath: path.join(testDir, 'menu-failed.pdf') };
    assert.deepEqual(
      await saveHtmlAsPdf!(trustedSender, { html: '<html></html>' }),
      { success: false, error: 'render surface crashed' },
      'a render failure is reported to the renderer',
    );
    assert.equal(pdfWindows[2].destroyed, true, 'the offscreen window is destroyed even when rendering fails');
    assert.equal(fs.existsSync(path.join(testDir, 'menu-failed.pdf')), false, 'a failed render writes no file');
    printToPdfFailure = null;

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
