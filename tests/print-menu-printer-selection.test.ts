/**
 * Print-menu printer selection.
 *
 * The POS print dialog lets a cashier pick which configured printer receives
 * the menu. That choice rides on `printerId`; omitting it must keep the
 * previously-implicit behaviour (the configured default decides), and an id
 * that matches no printer must refuse instead of quietly printing somewhere
 * else.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/print-menu-printer-selection.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-print-menu-select-'));

// Menu rendering constructs the shared Chromium raster surface, but only asks
// it to render lines the printer charset cannot carry. This suite's fixture is
// ASCII-only, so the surface is constructed and never drawn on; the raster
// encoder itself is covered by the dedicated Electron raster suites.
class RasterSurfaceStub {
  destroyed = false;
  webContents = {
    on: () => {},
    removeListener: () => {},
    send: () => {},
    loadURL: async () => {},
  };
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; }
  on() {}
  removeListener() {}
}

Module._load = function (request: string) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      ipcMain: { on: () => {}, removeListener: () => {}, handle: () => {} },
      BrowserWindow: RasterSurfaceStub,
    };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-print-menu-printer-selection';

const assert = require('node:assert/strict');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api, closeDatabase, now,
} = require('./helpers/test-setup');
const { printerRoutes } = require('../main/routes/printers');
const { destroySharedRasterRenderer } = require('../main/printers/raster-renderer');

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);

  // An ASCII-only regional profile keeps the rendered menu inside the printer
  // charset, so a successful dispatch is what these assertions measure.
  const setSetting = db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  for (const [key, value] of [
    ['country', 'US'],
    ['currency', 'USD'],
    ['currency_symbol', '$'],
    ['timezone', 'America/New_York'],
    ['business_name', 'Flo Test Cafe'],
  ] as const) {
    setSetting.run(key, value, now());
  }

  seedCategory(db, 'cat-drinks', 'Drinks');
  seedProduct(db, 'prod-filter-coffee', 'cat-drinks', 'Filter Coffee', 120);

  const app = createApp({ '/api/printers': printerRoutes });
  const { baseUrl, server } = await startServer(app);

  // WebUSB printers answer with their encoded bytes instead of opening a
  // socket, which keeps the printed-to printer observable without hardware.
  const createPrinter = async (name: string, isDefault: boolean): Promise<string> => {
    const res = await api(baseUrl, '/api/printers', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        name,
        connection_type: 'webusb',
        paper_width: 'cols-42',
        ...(isDefault ? { is_default: true } : {}),
      },
    });
    assert.equal(res.status, 201, `${name} fixture is created (${JSON.stringify(res.data)})`);
    return res.data.printer.id;
  };

  const printMenu = (body: Record<string, unknown>) => api(baseUrl, '/api/printers/print-menu', {
    method: 'POST',
    headers: owner.authHeader,
    body,
  });

  try {
    const frontCounterId = await createPrinter('Front Counter Printer', true);
    const backBarId = await createPrinter('Back Bar Printer', false);

    const explicit = await printMenu({ printerId: backBarId });
    assert.equal(explicit.status, 200, `an explicit printerId prints the menu (${JSON.stringify(explicit.data)})`);
    assert.equal(explicit.data.printerName, 'Back Bar Printer', 'the picked printer is the one printed to');
    assert.ok(Array.isArray(explicit.data.bytes) && explicit.data.bytes.length > 0, 'the picked printer receives the encoded menu');

    const byDefault = await printMenu({});
    assert.equal(byDefault.status, 200, `omitting printerId still prints the menu (${JSON.stringify(byDefault.data)})`);
    assert.equal(byDefault.data.printerName, 'Front Counter Printer', 'omitting printerId keeps the configured default in charge');

    const widthOverride = await printMenu({ printerId: backBarId, paperWidth: 58 });
    assert.equal(widthOverride.status, 200, `an explicit printerId still honours paperWidth (${JSON.stringify(widthOverride.data)})`);
    assert.equal(widthOverride.data.printerName, 'Back Bar Printer', 'choosing a paper width does not change which printer is targeted');

    const unknown = await printMenu({ printerId: 'no-such-printer' });
    assert.equal(unknown.status, 404, `an unknown printerId is refused (${unknown.status})`);
    assert.equal(unknown.data.code, 'printer_not_found', 'an unknown printerId is refused as printer_not_found');

    const numericId = await printMenu({ printerId: 999999 });
    assert.equal(numericId.status, 400, `a numeric printerId is rejected (${numericId.status})`);
    assert.equal(numericId.data.error, 'printerId must be a string', 'a numeric printerId reports the expected message');

    const selectedByDefault = await printMenu({ printerId: frontCounterId });
    assert.equal(selectedByDefault.data.printerName, 'Front Counter Printer', 'picking the default printer explicitly is also honoured');

    const malformed = await printMenu({ printerId: { id: backBarId } });
    assert.equal(malformed.status, 400, `a non-scalar printerId is rejected (${malformed.status})`);
    assert.equal(malformed.data.error, 'printerId must be a string', 'a non-scalar printerId reports the expected message');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // The shared raster singleton idles for five minutes; tear it down so the
  // suite exits with its own result instead of a timer firing during teardown.
  destroySharedRasterRenderer();
  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✅ Print-menu printer selection tests passed');
}

main().catch((error) => {
  try { closeDatabase(); } catch { }
  console.error(error);
  process.exit(1);
});
