import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
let saveDialogDelayMs = 0;
let lastSaveDialogOptions: any = null;
let printToPdfFailure: Error | null = null;
let printToPdfHook: ((win: RecordingWindow, printOptions: any) => Promise<Buffer>) | null = null;
let loadFileHook: ((win: RecordingWindow, filePath: string) => Promise<void>) | null = null;
const pdfWindows: any[] = [];

class RecordingWindow extends EventEmitter {
  options: any;
  destroyed = false;
  loadedUrl: string | null = null;
  loadedHtml: string | null = null;
  pdfOptions: any = null;
  webContents: any;

  constructor(options: any = {}) {
    super();
    this.options = options;
    this.webContents = Object.assign(new EventEmitter(), {
      session: { webRequest: { onBeforeRequest: () => {} } },
      setWindowOpenHandler: () => {},
      printToPDF: async (printOptions: any) => {
        this.pdfOptions = printOptions;
        if (printToPdfHook) return await printToPdfHook(this, printOptions);
        if (printToPdfFailure) throw printToPdfFailure;
        return Buffer.from('%PDF-1.4 recorded');
      },
    });
    pdfWindows.push(this);
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrl = url;
  }
  async loadFile(filePath: string): Promise<void> {
    this.loadedUrl = filePath;
    this.loadedHtml = fs.readFileSync(filePath, 'utf8');
    if (loadFileHook) {
      await loadFileHook(this, filePath);
    }
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
  static fromWebContents(sender: any): any {
    return sender?.ownerWindow ?? null;
  }
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
          if (saveDialogDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, saveDialogDelayMs));
          }
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

const { initDatabase, closeDatabase, getDatabase } = require('../main/db');
const { registerIpcHandlers } = require('../main/ipc');
const {
  PDF_RENDER_TIMEOUT_MS,
  renderHtmlToPdfBuffer,
  setHtmlToPdfTimeoutForTests,
} = require('../main/services/html-to-pdf');
const { getOrdersWithItemsForBills } = require('../main/routes/bills');

async function run(): Promise<void> {
  const mainFrame = { frameToken: 'frame-main', detached: false };
  const mainWin = { isDestroyed: () => false };
  const trustedSender = {
    sender: {
      ownerWindow: mainWin,
      mainFrame,
      getURL: () => 'http://localhost:3001/',
    },
    senderFrame: mainFrame,
  };

  try {
    initDatabase();
    registerIpcHandlers(undefined, () => mainWin as any);

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

    const printDocument = buildBillDocument(
      {
        isReprint: false,
        order: {
          orderNumber: '',
          createdAt: '',
          tableName: '',
          onlinePlatform: '',
          externalOrderId: '',
          deliveryAddress: '',
          items: [],
        },
        bill: {
          billNumber: '',
          subtotal: 0,
          discountAmount: 0,
          taxAmount: 0,
          total: 0,
          taxComponents: [],
          payments: [],
          pointsEarned: 0,
          pointsRedeemed: 0,
          pointsBalance: null,
        },
        business: {
          name: '',
          address: '',
          phone: '',
          taxRegistrationNumber: '',
          taxIdLabel: '',
          instagramHandle: '',
          footerNote: '',
          customerName: '',
          customerPhone: '',
          showName: true,
          showAddress: false,
          showPhone: false,
          showTaxId: 'never',
          showTaxBreakdown: false,
          showTableNumber: false,
          showCustomerName: false,
          showCustomerPhone: false,
        },
      },
      {
        columns: 42,
        languages: ['en'],
        baseDirection: 'ltr',
        locale: 'en-US',
        currency: 'USD',
        currencySymbol: '$',
        trimDecimals: false,
        resolveLabel: (conceptId: string) => conceptId,
      },
    );
    const kotDocument = buildKotDocument(
      {
        stationName: 'Kitchen',
        order: { orderNumber: 'K-1', createdAt: '', tableName: '', orderType: '' },
        items: [],
      },
      {
        columns: 42,
        languages: ['en'],
        baseDirection: 'ltr',
        locale: 'en-US',
        currency: '',
        currencySymbol: '',
        trimDecimals: false,
        resolveLabel: (conceptId: string) => conceptId,
      },
    );
    const rasterPrint = registered.get('rasterize-print-document');
    const rasterKot = registered.get('rasterize-kot-document');
    assert.deepEqual(
      await rasterPrint!(trustedSender, {
        document: printDocument,
        template: 'classic',
        profileId: 'profile',
        options: {
          columns: 100000000,
          language: 'en',
          locale: 'en-US',
          currency: 'INR',
          currencySymbol: '₹',
          trimDecimals: false,
          useUnicode: false,
          arabicShaping: false,
        },
      }),
      { ok: false, error: 'Invalid raster document options' },
      'print raster IPC rejects oversized column counts',
    );
    assert.deepEqual(
      await rasterKot!(trustedSender, {
        document: kotDocument,
        profileId: 'profile',
        options: {
          columns: 100000000,
          language: 'en',
          locale: 'en-US',
          useUnicode: false,
          arabicShaping: false,
        },
      }),
      { ok: false, error: 'Invalid raster KOT options' },
      'KOT raster IPC rejects oversized column counts',
    );
    // Saves the renderer-built menu as a PDF without a printer attached.
    const saveHtmlAsPdf = registered.get('save-html-as-pdf');
    assert.ok(saveHtmlAsPdf, 'save-html-as-pdf IPC handler is registered');

    assert.deepEqual(
      await saveHtmlAsPdf!(
        { sender: { getURL: () => 'https://example.com/' } },
        { html: '<html></html>' },
      ),
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
      await saveHtmlAsPdf!(trustedSender, { html: `<p>${'x'.repeat(15 * 1024 * 1024)}</p>` }),
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
      await saveHtmlAsPdf!(trustedSender, {
        html: '<html><body>Menu</body></html>',
        defaultFileName: 'menu',
        pageSize: 'Letter',
      }),
      { success: true, path: pdfPath },
      'an accepted save reports the written path',
    );
    assert.equal(
      fs.readFileSync(pdfPath, 'utf8'),
      '%PDF-1.4 recorded',
      'the rendered PDF bytes land in the chosen file',
    );
    assert.equal(pdfWindows.length, 1, 'exactly one offscreen window renders the document');
    const pdfWindow = pdfWindows[0];
    assert.equal(pdfWindow.options.show, false, 'the PDF window is never shown');
    assert.deepEqual(
      pdfWindow.options.webPreferences,
      {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false,
        partition: pdfWindow.options.webPreferences.partition,
      },
      'the PDF window is isolated and runs no scripts',
    );
    assert.equal(
      pdfWindow.loadedHtml,
      '<html><body>Menu</body></html>',
      'the secure temporary HTML file contains the requested document',
    );
    assert.ok(
      String(pdfWindow.loadedUrl).endsWith('.html'),
      'the document is loaded from a temporary HTML file',
    );
    assert.equal(
      fs.existsSync(pdfWindow.loadedUrl),
      false,
      'the temporary HTML file is removed after rendering',
    );
    assert.deepEqual(
      pdfWindow.pdfOptions,
      { printBackground: true, pageSize: 'Letter', preferCSSPageSize: true },
      'the requested page size reaches the print call',
    );
    assert.equal(pdfWindow.destroyed, true, 'the offscreen window is destroyed after export');
    assert.deepEqual(
      lastSaveDialogOptions.filters,
      [{ name: 'PDF', extensions: ['pdf'] }],
      'the save dialog offers PDF files',
    );
    assert.equal(
      path.basename(lastSaveDialogOptions.defaultPath),
      'menu.pdf',
      'a suggested name without an extension gets one',
    );
    assert.equal(
      path.dirname(lastSaveDialogOptions.defaultPath),
      testDir,
      'the save dialog opens in the documents folder',
    );

    saveDialogResult = { canceled: false, filePath: path.join(testDir, 'menu-a4.pdf') };
    await saveHtmlAsPdf!(trustedSender, {
      html: '<html></html>',
      defaultFileName: '../escape:name',
      pageSize: 'A5',
    });
    assert.equal(
      pdfWindows[1].pdfOptions.pageSize,
      'A4',
      'an unsupported page size falls back to A4',
    );
    assert.equal(
      path.basename(lastSaveDialogOptions.defaultPath),
      '..-escape-name.pdf',
      'a directory separator in the suggested name is neutralised',
    );
    assert.equal(
      path.dirname(lastSaveDialogOptions.defaultPath),
      testDir,
      'the suggested name cannot steer the save outside the documents folder',
    );

    printToPdfFailure = new Error('render surface crashed');
    saveDialogResult = { canceled: false, filePath: path.join(testDir, 'menu-failed.pdf') };
    assert.deepEqual(
      await saveHtmlAsPdf!(trustedSender, { html: '<html></html>' }),
      { success: false, error: 'render surface crashed' },
      'a render failure is reported to the renderer',
    );
    assert.equal(
      pdfWindows[2].destroyed,
      true,
      'the offscreen window is destroyed even when rendering fails',
    );
    assert.equal(
      fs.existsSync(path.join(testDir, 'menu-failed.pdf')),
      false,
      'a failed render writes no file',
    );
    printToPdfFailure = null;

    // PDF rendering deadline, save-dialog exclusion, renderer termination, and window closure:
    assert.equal(PDF_RENDER_TIMEOUT_MS, 30_000, 'default PDF render deadline is 30 seconds');

    // (a) Time spent in the save dialog is excluded from the PDF rendering deadline
    setHtmlToPdfTimeoutForTests(30);
    saveDialogDelayMs = 60;
    const delayedDialogPdfPath = path.join(testDir, 'delayed-dialog.pdf');
    saveDialogResult = { canceled: false, filePath: delayedDialogPdfPath };
    assert.deepEqual(
      await saveHtmlAsPdf!(trustedSender, { html: '<html><body>Delayed dialog</body></html>' }),
      { success: true, path: delayedDialogPdfPath },
      'save dialog delay does not count against the PDF rendering deadline',
    );
    saveDialogDelayMs = 0;

    // (b) Stalled printToPDF times out, destroys the BrowserWindow, deletes staging HTML, and cleans up listeners
    printToPdfHook = () => new Promise<Buffer>(() => {});
    const timedOutPdfPath = path.join(testDir, 'timed-out.pdf');
    saveDialogResult = { canceled: false, filePath: timedOutPdfPath };
    const timeoutIpcRes = await saveHtmlAsPdf!(trustedSender, {
      html: '<html><body>Stalled</body></html>',
    });
    assert.equal(timeoutIpcRes.success, false, 'stalled PDF export fails on timeout');
    assert.match(
      String(timeoutIpcRes.error),
      /PDF rendering timed out after 30ms/,
      'timeout error message identifies the rendering deadline',
    );
    const timedOutWin = pdfWindows[pdfWindows.length - 1];
    assert.equal(
      timedOutWin.destroyed,
      true,
      'timed-out PDF render destroys the hidden BrowserWindow so work cannot continue in background',
    );
    assert.equal(
      fs.existsSync(timedOutWin.loadedUrl),
      false,
      'timed-out PDF render deletes the staging HTML file',
    );
    assert.equal(
      fs.existsSync(timedOutPdfPath),
      false,
      'timed-out PDF render writes no output PDF file',
    );
    assert.equal(
      timedOutWin.listenerCount('closed'),
      0,
      'timed-out PDF render removes closed listener from BrowserWindow',
    );
    assert.equal(
      timedOutWin.webContents.listenerCount('render-process-gone'),
      0,
      'timed-out PDF render removes render-process-gone listener from webContents',
    );
    assert.equal(
      timedOutWin.webContents.listenerCount('will-navigate'),
      0,
      'timed-out PDF render removes will-navigate listener from webContents',
    );
    printToPdfHook = null;
    setHtmlToPdfTimeoutForTests(null);

    // (c) Renderer process termination (render-process-gone) rejects immediately and cleans up
    printToPdfHook = (win) =>
      new Promise<Buffer>(() => {
        setImmediate(() => {
          win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
        });
      });
    await assert.rejects(
      () => renderHtmlToPdfBuffer({ html: '<html><body>Crash</body></html>' }),
      /PDF renderer process terminated unexpectedly \(crashed\)/,
      'render-process-gone rejects renderHtmlToPdfBuffer with termination reason',
    );
    const crashedWin = pdfWindows[pdfWindows.length - 1];
    assert.equal(
      crashedWin.destroyed,
      true,
      'render-process-gone destroys the hidden BrowserWindow',
    );
    assert.equal(
      fs.existsSync(crashedWin.loadedUrl),
      false,
      'render-process-gone deletes the staging HTML file',
    );
    assert.equal(crashedWin.listenerCount('closed'), 0, 'closed listener cleaned up after crash');
    assert.equal(
      crashedWin.webContents.listenerCount('render-process-gone'),
      0,
      'render-process-gone listener cleaned up after crash',
    );
    printToPdfHook = null;

    // (d) Unexpected window closure (closed) rejects immediately and cleans up
    printToPdfHook = (win) =>
      new Promise<Buffer>(() => {
        setImmediate(() => {
          win.destroyed = true;
          win.emit('closed');
        });
      });
    await assert.rejects(
      () => renderHtmlToPdfBuffer({ html: '<html><body>Closed</body></html>' }),
      /PDF rendering window closed unexpectedly/,
      'unexpected window closure rejects renderHtmlToPdfBuffer',
    );
    const closedWin = pdfWindows[pdfWindows.length - 1];
    assert.equal(closedWin.destroyed, true, 'closed window remains destroyed');
    assert.equal(
      fs.existsSync(closedWin.loadedUrl),
      false,
      'unexpected window closure deletes the staging HTML file',
    );
    assert.equal(closedWin.listenerCount('closed'), 0, 'closed listener cleaned up after close');
    printToPdfHook = null;

    // (e) loadFile() rejection propagates directly without redundant did-fail-load listener
    loadFileHook = async (win) => {
      assert.equal(
        win.webContents.listenerCount('did-fail-load'),
        0,
        'no redundant did-fail-load listener is registered on webContents',
      );
      throw new Error('ERR_FILE_NOT_FOUND');
    };
    await assert.rejects(
      () => renderHtmlToPdfBuffer({ html: '<html><body>LoadFail</body></html>' }),
      /ERR_FILE_NOT_FOUND/,
      'loadFile rejection is propagated directly',
    );
    const loadFailWin = pdfWindows[pdfWindows.length - 1];
    assert.equal(loadFailWin.destroyed, true, 'loadFile failure destroys the BrowserWindow');
    assert.equal(
      fs.existsSync(loadFailWin.loadedUrl),
      false,
      'loadFile failure deletes the staging HTML file',
    );
    assert.equal(
      loadFailWin.listenerCount('closed'),
      0,
      'loadFile failure cleans up closed listener',
    );
    assert.equal(
      loadFailWin.webContents.listenerCount('render-process-gone'),
      0,
      'loadFile failure cleans up render-process-gone listener',
    );
    loadFileHook = null;

    // (f) getOrdersWithItemsForBills hoists currency lookup outside the per-bill loop
    {
      const db = getDatabase();
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'US', CURRENT_TIMESTAMP), ('currency', 'USD', CURRENT_TIMESTAMP)",
      ).run();
      db.prepare(
        "INSERT OR IGNORE INTO categories (id, name, sort_order, is_active, created_at, updated_at) VALUES ('cat-hoist', 'Hoist Cat', 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      ).run();
      db.prepare(
        "INSERT OR IGNORE INTO products (id, category_id, name, price, is_active, created_at, updated_at) VALUES ('prod-hoist', 'cat-hoist', 'Hoist Product', 10, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      ).run();
      const batchBills: any[] = [];
      for (let i = 1; i <= 5; i++) {
        const orderRes = db
          .prepare(
            "INSERT INTO orders (order_number, status, type, subtotal, tax_amount, discount_amount, total, created_at, updated_at) VALUES (?, 'completed', 'dine-in', 10, 1, 0, 11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          )
          .run(`ORD-HOIST-${i}`);
        const orderId = Number(orderRes.lastInsertRowid);
        db.prepare(
          "INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, tax_amount, total, status, created_at, updated_at) VALUES (?, 'prod-hoist', ?, 1, 10, 10, 1, 11, 'ready', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        ).run(orderId, `Item ${i}`);
        const billRes = db
          .prepare(
            "INSERT INTO bills (bill_number, order_id, subtotal, discount_amount, service_charge, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at) VALUES (?, ?, 10, 0, 0, 1, 11, 11, 0, 'paid', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          )
          .run(`BILL-HOIST-${i}`, orderId);
        const billId = Number(billRes.lastInsertRowid);
        batchBills.push(db.prepare('SELECT * FROM bills WHERE id = ?').get(billId));
      }

      const originalPrepare = db.prepare.bind(db);
      let settingsQueries = 0;
      db.prepare = ((sql: string) => {
        if (/FROM\s+settings\b/i.test(sql)) {
          settingsQueries++;
        }
        return originalPrepare(sql);
      }) as typeof db.prepare;

      try {
        const ordersByBill = getOrdersWithItemsForBills(db, batchBills);
        assert.equal(ordersByBill.size, 5, 'all 5 bills are projected');
        assert.equal(
          settingsQueries,
          2,
          'getOrdersWithItemsForBills queries settings once per call (currency + country) instead of per bill',
        );
      } finally {
        db.prepare = originalPrepare;
      }
    }

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
