const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getPath: () => os.tmpdir() } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { resolveStaticPage } = require('../main/server');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-static-routes-'));
fs.writeFileSync(path.join(fixture, 'index.html'), 'root');
fs.mkdirSync(path.join(fixture, 'whatsapp'));
fs.writeFileSync(path.join(fixture, 'whatsapp', 'index.html'), 'whatsapp');

assert.equal(resolveStaticPage(fixture, '/whatsapp'), path.join(fixture, 'whatsapp', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/whatsapp/'), path.join(fixture, 'whatsapp', 'index.html'));
assert.equal(resolveStaticPage(fixture, '/unknown'), path.join(fixture, 'index.html'));
assert.equal(resolveStaticPage(fixture, '/../outside'), path.join(fixture, 'index.html'));

fs.rmSync(fixture, { recursive: true, force: true });
console.log('✅ Static route resolution tests passed');
