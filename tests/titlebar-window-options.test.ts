import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mainSource = fs.readFileSync(path.join(process.cwd(), 'main/index.ts'), 'utf8');
const ipcSource = fs.readFileSync(path.join(process.cwd(), 'main/ipc.ts'), 'utf8');

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `source contains ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `source contains ${end} after ${start}`);
  return source.slice(startIndex, endIndex);
}

const mainWindowOptions = section(
  mainSource,
  'mainWindow = new BrowserWindow({',
  'mainWindow.once(\'ready-to-show\''
);
assert.match(
  mainWindowOptions,
  /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset' : 'hidden'/,
  'the main POS window uses hiddenInset on macOS and hidden elsewhere'
);
assert.match(mainWindowOptions, /titleBarOverlay:\s*\{[\s\S]*height:\s*40[\s\S]*\}/, 'the main POS window sets an explicit overlay height');
assert.match(mainWindowOptions, /color:\s*'#ffffff'/, 'the native overlay uses an opaque background color');
assert.match(mainWindowOptions, /symbolColor:\s*'#475569'/, 'the native overlay uses an opaque symbol color');
assert.match(mainWindowOptions, /contextIsolation:\s*true/);
assert.match(mainWindowOptions, /nodeIntegration:\s*false/);
assert.match(mainWindowOptions, /sandbox:\s*false/);
assert.doesNotMatch(mainWindowOptions, /frame:\s*false/, 'the native-controls design does not remove the window frame');

const printPopupHandler = section(
  mainSource,
  "mainWindow.webContents.setWindowOpenHandler(({ url }) => {",
  "  // Intercept all renderer downloads"
);
assert.match(printPopupHandler, /width:\s*isBlank \? 800 : 1280/);
assert.match(printPopupHandler, /height:\s*isBlank \? 600 : 800/);
assert.match(printPopupHandler, /title:\s*isBlank \? 'Print Receipt' : 'Flo - Kitchen Display'/);
assert.match(printPopupHandler, /autoHideMenuBar:\s*isBlank/);
assert.match(printPopupHandler, /contextIsolation:\s*true/);
assert.match(printPopupHandler, /nodeIntegration:\s*false/);
assert.doesNotMatch(printPopupHandler, /titleBarStyle|titleBarOverlay|frame:\s*false/, 'print and local popup options remain stock');

const kdsWindowOptions = section(
  ipcSource,
  'activeKdsWindow = new BrowserWindow({',
  "    activeKdsWindow.on('closed'"
);
assert.match(kdsWindowOptions, /contextIsolation:\s*true/);
assert.match(kdsWindowOptions, /nodeIntegration:\s*false/);
assert.doesNotMatch(kdsWindowOptions, /preload\s*:/, 'KDS keeps the privileged preload bridge removed');
assert.doesNotMatch(kdsWindowOptions, /titleBarStyle|titleBarOverlay|frame:\s*false/, 'KDS keeps stock window chrome');

console.log('Title-bar main-window options and popup/KDS exclusions are preserved.');
