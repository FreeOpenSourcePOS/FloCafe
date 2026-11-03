import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getStatusMessage,
  resolveStatusLanguage,
  RTL_STATUS_LANGUAGES,
  STATUS_LANGUAGES,
  type StatusKey,
} from '../main/status-messages';
import { shouldQuitOnAllWindowsClosed } from '../main/window-recovery';

const KEYS: StatusKey[] = [
  'starting',
  'checking',
  'backingUp',
  'services',
  'welcome',
  'closing',
  'shutdownBackup',
  'saved',
];

const languagesSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'lib', 'i18n', 'languages.ts'),
  'utf8',
);
const block = languagesSource.slice(
  languagesSource.indexOf('export const LANGUAGES = {'),
  languagesSource.indexOf('export type Language ='),
);
const appLanguages = [...block.matchAll(/^ {2}(?:'([a-z-]+)'|([a-z]+)): \{$/gm)].map(
  (match) => match[1] ?? match[2],
);

assert.ok(appLanguages.length >= 24, 'the app language registry was parsed');
for (const language of appLanguages) {
  assert.ok(STATUS_LANGUAGES.includes(language), `${language} has startup/shutdown messages`);
  for (const key of KEYS) {
    const [title, detail] = getStatusMessage(key, language);
    assert.ok(title.trim().length > 0 && detail.trim().length > 0, `${language}.${key} is filled`);
  }
}
for (const language of STATUS_LANGUAGES) {
  assert.ok(appLanguages.includes(language), `${language} is a registered app language`);
}
for (const rtl of RTL_STATUS_LANGUAGES) assert.ok(appLanguages.includes(rtl));

assert.equal(resolveStatusLanguage('es'), 'es');
assert.equal(resolveStatusLanguage('es-MX'), 'es');
assert.equal(resolveStatusLanguage('en-US'), 'en');
assert.equal(resolveStatusLanguage('zh-TW'), 'zh-tw');
assert.equal(resolveStatusLanguage('zh-Hant-HK'), 'zh-tw');
assert.equal(resolveStatusLanguage('zh-CN'), 'zh');
assert.equal(resolveStatusLanguage('tl-PH'), 'fil');
assert.equal(resolveStatusLanguage('xx'), 'en');
assert.equal(resolveStatusLanguage(null), 'en');
assert.equal(getStatusMessage('starting', 'unknown')[0], 'Starting Flo');

assert.equal(
  shouldQuitOnAllWindowsClosed('win32', false, true),
  false,
  'Windows does not quit when all windows close while runtime is starting',
);
assert.equal(
  shouldQuitOnAllWindowsClosed('linux', false, true),
  false,
  'Linux does not quit when all windows close while runtime is starting',
);
assert.equal(
  shouldQuitOnAllWindowsClosed('win32', false, false),
  true,
  'Windows still quits when all windows close after startup',
);

const Module = require('module');
const originalLoad = Module._load;
const originalNodeEnv = process.env.NODE_ENV;
const originalHiddenWindow = process.env.FLO_E2E_HIDDEN_WINDOW;
const originalDbPath = process.env.FLO_E2E_DB_PATH;

interface FakeWindowInstance {
  destroyed: boolean;
  shown: boolean;
  alwaysOnTop: boolean;
  loadURLCalls: string[];
  executedScripts: string[];
  destroy(): void;
}

(async () => {
  const createdWindows: FakeWindowInstance[] = [];
  let loadBehavior: 'resolve' | 'reject' | 'hang' = 'resolve';
  let executeBehavior: 'resolve' | 'reject' = 'resolve';
  let quitCalls = 0;
  let runtimeStarting = true;

  const emitAllWindowsClosedIfNoneOpen = () => {
    if (createdWindows.every((win) => win.destroyed)) {
      if (shouldQuitOnAllWindowsClosed('win32', false, runtimeStarting)) {
        quitCalls += 1;
      }
    }
  };

  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      class FakeBrowserWindow implements FakeWindowInstance {
        destroyed = false;
        shown = false;
        alwaysOnTop: boolean;
        loadURLCalls: string[] = [];
        executedScripts: string[] = [];
        private listeners = new Map<string, Array<() => void>>();
        webContents = {
          on: () => {},
          setWindowOpenHandler: () => {},
          executeJavaScript: async (code: string) => {
            this.executedScripts.push(code);
            if (executeBehavior === 'reject') {
              throw new Error('simulated executeJavaScript failure');
            }
          },
        };

        constructor(options: { alwaysOnTop?: boolean }) {
          this.alwaysOnTop = Boolean(options?.alwaysOnTop);
          createdWindows.push(this);
        }

        on(event: string, cb: () => void) {
          const list = this.listeners.get(event) || [];
          list.push(cb);
          this.listeners.set(event, list);
        }

        loadURL(url: string): Promise<void> {
          this.loadURLCalls.push(url);
          if (loadBehavior === 'reject') {
            return Promise.reject(new Error('simulated status window load failure'));
          }
          if (loadBehavior === 'hang') {
            return new Promise<void>(() => {});
          }
          return Promise.resolve();
        }

        show() {
          this.shown = true;
        }

        setAlwaysOnTop(flag: boolean) {
          this.alwaysOnTop = flag;
        }

        isDestroyed() {
          return this.destroyed;
        }

        destroy() {
          if (this.destroyed) return;
          this.destroyed = true;
          for (const cb of this.listeners.get('closed') || []) cb();
          emitAllWindowsClosedIfNoneOpen();
        }
      }

      return {
        app: {
          getLocale: () => 'en-US',
        },
        BrowserWindow: FakeBrowserWindow,
      };
    }
    return originalLoad.apply(this, arguments as any);
  };

  try {
    delete process.env.NODE_ENV;
    delete process.env.FLO_E2E_HIDDEN_WINDOW;
    delete process.env.FLO_E2E_DB_PATH;

    const statusWindowModulePath = require.resolve('../main/status-window');
    delete require.cache[statusWindowModulePath];
    const { showStatus, closeStatus, closeStatusWhenSeen, hasStatusWindow } =
      require('../main/status-window') as typeof import('../main/status-window');

    // 1. Rejected loadURL during startup destroys the broken window without showing it or quitting,
    //    and latches statusUnavailable so subsequent startup steps do not repeatedly open new windows.
    loadBehavior = 'reject';
    runtimeStarting = true;
    await showStatus('starting');
    assert.equal(createdWindows.length, 1, 'status window creation attempted');
    assert.equal(createdWindows[0].shown, false, 'failed status window is never shown');
    assert.equal(createdWindows[0].destroyed, true, 'failed status window is destroyed');
    assert.equal(hasStatusWindow(), false, 'no open status window remains after load failure');
    assert.equal(quitCalls, 0, 'destroying failed status window during startup does not quit app');

    await showStatus('checking');
    await showStatus('backingUp');
    await showStatus('services');
    await showStatus('welcome');
    assert.equal(
      createdWindows.length,
      1,
      'subsequent startup showStatus calls return immediately without creating another BrowserWindow',
    );

    // 2. Resetting via closeStatusWhenSeen allows a fresh open attempt; if executeJavaScript fails,
    //    closeStatus() destroys it without quitting during startup and latches statusUnavailable.
    await closeStatusWhenSeen(0);
    loadBehavior = 'resolve';
    executeBehavior = 'resolve';
    await showStatus('starting');
    assert.equal(createdWindows.length, 2, 'second status window created after reset');
    assert.equal(createdWindows[1].shown, true, 'healthy status window is shown');
    assert.equal(hasStatusWindow(), true, 'status window is open');

    executeBehavior = 'reject';
    await showStatus('checking');
    assert.equal(
      createdWindows[1].destroyed,
      true,
      'status window is destroyed when executeJavaScript fails',
    );
    assert.equal(hasStatusWindow(), false, 'status window is closed after update failure');
    assert.equal(quitCalls, 0, 'update failure closure during startup does not quit app');

    await showStatus('services');
    assert.equal(
      createdWindows.length,
      2,
      'after executeJavaScript failure, subsequent startup showStatus calls do not create another BrowserWindow',
    );

    // 3. Shutdown ('closing') resets statusUnavailable so shutdown can still try once, and a timed-out
    //    loadURL destroys the hung window without showing it or retrying on shutdownBackup/saved.
    loadBehavior = 'hang';
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      return originalSetTimeout(fn, ms === 2000 ? 10 : ms, ...args);
    }) as typeof setTimeout;
    try {
      await showStatus('closing', true);
      await showStatus('shutdownBackup', true);
      await showStatus('saved', true);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
    assert.equal(
      createdWindows.length,
      3,
      'third status window created once for closing timeout check',
    );
    assert.equal(createdWindows[2].shown, false, 'timed-out status window is never shown');
    assert.equal(createdWindows[2].destroyed, true, 'timed-out status window is destroyed');
    assert.equal(hasStatusWindow(), false, 'no open status window remains after timeout');
    assert.equal(
      quitCalls,
      0,
      'destroying timed-out status window during startup does not quit app',
    );

    closeStatus();
    console.log('Status messages cover every app language and startup failure guards pass.');
  } finally {
    Module._load = originalLoad;
    if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    if (originalHiddenWindow !== undefined)
      process.env.FLO_E2E_HIDDEN_WINDOW = originalHiddenWindow;
    if (originalDbPath !== undefined) process.env.FLO_E2E_DB_PATH = originalDbPath;
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
