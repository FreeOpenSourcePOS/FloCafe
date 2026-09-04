const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { ChromiumRasterRenderer } = require('../dist/main/printers/raster-renderer.js');

const font = { family: 'FloRaster', dataUrl: 'data:font/woff2;base64,AA==' };

function area(unit) {
  return unit.bands.reduce((total, band) => total + band.pixels.reduce((sum, pixel) => sum + pixel, 0), 0);
}

async function run() {
  await app.whenReady();
  let surface;
  const renderer = new ChromiumRasterRenderer({
    preloadPath: path.join(__dirname, '../dist/raster-preload.js'),
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
      window.FontFace = class {
        constructor(family) { this.family = family; }
        load() { return Promise.resolve(this); }
      };
    `);
    const base = {
      version: 1,
      text: 'שלום עולם',
      widthDots: 120,
      maxBandHeight: 200,
      direction: 'rtl',
      align: 'center',
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
    assert.equal(normal.unit.complete, true);
    assert.equal(styled.unit.complete, true);
    assert.equal(normal.unit.bands[0].widthDots, 120);
    assert.equal(styled.unit.bands[0].widthDots, 120);
    assert.ok(area(normal.unit) > 0);
    assert.ok(area(styled.unit) > area(normal.unit));
    console.log('Chromium raster surface rendered styled RTL output.');
  } finally {
    renderer.destroy();
    if (app.isReady()) app.quit();
  }
}

run().catch((error) => {
  console.error(error);
  if (app.isReady()) app.exit(1);
  else process.exit(1);
});
