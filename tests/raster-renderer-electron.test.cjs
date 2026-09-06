const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { ChromiumRasterRenderer, getSharedRasterRenderer, destroySharedRasterRenderer } = require('../dist/main/printers/raster-renderer.js');

const font = { family: 'FloRaster', dataUrl: 'data:font/woff2;base64,AA==' };

function area(unit) {
  return unit.bands.reduce((total, band) => total + band.pixels.reduce((sum, pixel) => sum + pixel, 0), 0);
}

async function run() {
  await app.whenReady();
  let surface;
  const renderer = new ChromiumRasterRenderer({
    preloadPath: path.join(__dirname, '../dist/main/raster-preload.js'),
    windowFactory: (options) => {
      surface = new BrowserWindow(options);
      return surface;
    },
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Raster surface did not load')), 5000);
      surface.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await surface.webContents.executeJavaScript(`
      window.__floNativeFontFace = window.FontFace;
      window.FontFace = class extends window.__floNativeFontFace {
        load() { return Promise.reject(new Error('bundled font unavailable')); }
      };
      true;
    `);
    const fontFailure = await renderer.render({
      version: 1,
      requestId: 'electron-font-failure',
      text: 'שלום עולם',
      widthDots: 120,
      maxBandHeight: 200,
      direction: 'rtl',
      align: 'center',
      style: 'normal',
      financial: false,
      maxLines: 4,
      bundledFont: font,
    });
    assert.deepEqual(fontFailure, {
      version: 1,
      requestId: 'electron-font-failure',
      ok: false,
      code: 'font-unavailable',
      detail: 'bundled font unavailable',
    });
    await surface.webContents.executeJavaScript(`
      window.FontFace = class extends window.__floNativeFontFace {
        load() { return Promise.resolve(this); }
      };
      true;
    `);
    const base = {
      version: 1,
      text: 'שלום עולם',
      widthDots: 120,
      maxBandHeight: 200,
      direction: 'rtl',
      align: 'center',
      style: 'normal',
      financial: false,
      maxLines: 4,
      bundledFont: font,
    };
    const normal = await renderer.render({ ...base, requestId: 'electron-normal', style: 'normal' });
    const styled = await renderer.render({
      ...base,
      requestId: 'electron-styled',
      style: 'bold',
      styles: ['bold', 'double-height', 'double-width'],
    });
    assert.equal(normal.ok, true);
    assert.equal(styled.ok, true);
    const fontCount = await surface.webContents.executeJavaScript('document.fonts.size');
    assert.equal(fontCount, 1);
    assert.equal(normal.unit.complete, true);
    assert.equal(styled.unit.complete, true);
    assert.equal(normal.unit.bands[0].widthDots, 120);
    assert.equal(styled.unit.bands[0].widthDots, 120);
    assert.ok(area(normal.unit) > 0);
    assert.ok(area(styled.unit) > area(normal.unit));
    const financialOverflow = await renderer.render({
      ...base,
      requestId: 'electron-financial-overflow',
      text: 'שלום '.repeat(200),
      financial: true,
      maxLines: 1,
    });
    assert.equal(financialOverflow.ok, false);
    assert.equal(financialOverflow.code, 'render-failed');
    const nonFinancialOverflow = await renderer.render({
      ...base,
      requestId: 'electron-nonfinancial-overflow',
      text: 'שלום '.repeat(200),
      financial: false,
      maxLines: 1,
    });
    assert.equal(nonFinancialOverflow.ok, false);
    assert.equal(nonFinancialOverflow.code, 'render-failed');

    // Verify system font rendering for pure CJK and pure Arabic when bundledFont is omitted
    const cjkRender = await renderer.render({
      version: 1,
      requestId: 'electron-cjk-system-font',
      text: '煎饼',
      widthDots: 120,
      maxBandHeight: 200,
      direction: 'ltr',
      align: 'left',
      style: 'normal',
      financial: true,
      maxLines: 4,
    });
    assert.equal(cjkRender.ok, true);
    assert.equal(cjkRender.unit.complete, true);
    assert.ok(area(cjkRender.unit) > 0);

    const arabicRender = await renderer.render({
      version: 1,
      requestId: 'electron-arabic-system-font',
      text: 'چای',
      widthDots: 120,
      maxBandHeight: 200,
      direction: 'rtl',
      align: 'left',
      style: 'normal',
      financial: true,
      maxLines: 4,
    });
    assert.equal(arabicRender.ok, true);
    assert.equal(arabicRender.unit.complete, true);
    assert.ok(area(arabicRender.unit) > 0);

    surface.webContents.emit('render-process-gone');
    const processFailure = await renderer.render({ ...base, requestId: 'electron-process-failure' });
    assert.deepEqual(processFailure, {
      version: 1,
      requestId: 'electron-process-failure',
      ok: false,
      code: 'render-failed',
      detail: 'Raster renderer process exited',
    });
    console.log('Chromium raster surface rendered styled RTL output.');

    // Verify shared singleton operates cleanly under real Electron
    destroySharedRasterRenderer();
    const shared1 = getSharedRasterRenderer({
      preloadPath: path.join(__dirname, '../dist/main/raster-preload.js'),
    });
    assert.equal(shared1.isDestroyed(), false);
    const shared2 = getSharedRasterRenderer();
    assert.equal(shared1, shared2);
    destroySharedRasterRenderer();
    assert.equal(shared1.isDestroyed(), true);
    console.log('Warm Chromium raster singleton lifecycle passed.');
  } finally {
    renderer.destroy();
    destroySharedRasterRenderer();
    if (app.isReady()) app.quit();
  }
}

run().catch((error) => {
  console.error(error);
  if (app.isReady()) app.exit(1);
  else process.exit(1);
});
