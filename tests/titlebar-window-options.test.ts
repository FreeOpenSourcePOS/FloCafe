import * as assert from 'node:assert/strict';
import { isAllowedLocalWindowUrl } from '../main/security/url-allowlist';
import {
  createKdsWindow,
  createLocalWindowOpenHandler,
  createMainWindow,
} from '../main/window-options';

class FakeBrowserWindow {
  constructor(public readonly options: any) {}
}

const macMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'darwin');
const windowsMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'win32');
const linuxMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'linux');

assert.equal(macMainWindow.options.titleBarStyle, 'hiddenInset');
assert.equal(windowsMainWindow.options.titleBarStyle, 'hidden');
assert.equal(linuxMainWindow.options.titleBarStyle, 'hidden');
assert.deepEqual(macMainWindow.options.titleBarOverlay, {
  color: '#ffffff',
  symbolColor: '#475569',
  height: 40,
});
assert.equal(macMainWindow.options.webPreferences.preload, '/tmp/preload.js');
assert.equal(macMainWindow.options.webPreferences.contextIsolation, true);
assert.equal(macMainWindow.options.webPreferences.nodeIntegration, false);
assert.equal(macMainWindow.options.webPreferences.sandbox, false);
assert.equal('frame' in macMainWindow.options, false, 'the native-controls design does not remove the window frame');

const localWindowOpenHandler = createLocalWindowOpenHandler(
  isAllowedLocalWindowUrl,
  () => 3001,
  () => '192.168.1.50',
);
const printPopup = localWindowOpenHandler({ url: 'about:blank' });
assert.equal(printPopup?.action, 'allow');
assert.deepEqual(printPopup?.overrideBrowserWindowOptions, {
  width: 800,
  height: 600,
  title: 'Print Receipt',
  autoHideMenuBar: true,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
  },
});
assert.equal('titleBarStyle' in (printPopup?.overrideBrowserWindowOptions || {}), false);
assert.equal('titleBarOverlay' in (printPopup?.overrideBrowserWindowOptions || {}), false);
assert.equal('frame' in (printPopup?.overrideBrowserWindowOptions || {}), false);

const kitchenPopup = localWindowOpenHandler({ url: 'http://localhost:3001/kds' });
assert.equal(kitchenPopup?.action, 'allow');
assert.equal(kitchenPopup?.overrideBrowserWindowOptions.title, 'Flo - Kitchen Display');
assert.equal(kitchenPopup?.overrideBrowserWindowOptions.width, 1280);
assert.equal(kitchenPopup?.overrideBrowserWindowOptions.height, 800);

const kdsWindow = createKdsWindow(FakeBrowserWindow as any);
assert.equal(kdsWindow.options.webPreferences.preload, undefined, 'KDS keeps the privileged preload bridge removed');
assert.equal(kdsWindow.options.webPreferences.contextIsolation, true);
assert.equal(kdsWindow.options.webPreferences.nodeIntegration, false);
assert.equal('titleBarStyle' in kdsWindow.options, false, 'KDS keeps stock window chrome');
assert.equal('titleBarOverlay' in kdsWindow.options, false, 'KDS keeps stock window chrome');
assert.equal('frame' in kdsWindow.options, false, 'KDS keeps stock window chrome');

console.log('Title-bar main-window options and popup/KDS exclusions are preserved.');
