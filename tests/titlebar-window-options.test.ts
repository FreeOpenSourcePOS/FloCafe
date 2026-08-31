import * as assert from 'node:assert/strict';
import { isAllowedLocalWindowUrl } from '../main/security/url-allowlist';
import {
  applyTitleBarOverlayTheme,
  appendThemeQueryParam,
  attachTitleBarThemeSync,
  isThemeMode,
  resolveInitialIsDark,
  resolveThemeMode,
  resolveTitleBarOverlayColors,
  supportsTitleBarOverlay,
  TITLE_BAR_HEIGHT,
  TITLE_BAR_OVERLAY_COLORS,
} from '../main/title-bar-theme';
import {
  applyWindowControlAction,
  createKdsWindow,
  createLocalWindowOpenHandler,
  createMainWindow,
  resolveTitleBarMode,
} from '../main/window-options';

class FakeBrowserWindow {
  constructor(public readonly options: any) {}
}

const macMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'darwin');
const windowsMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'win32');
const linuxMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'linux');
const darkMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'darwin', true);

assert.equal(macMainWindow.options.titleBarStyle, 'hiddenInset');
assert.equal(windowsMainWindow.options.titleBarStyle, 'hidden');
assert.equal(linuxMainWindow.options.titleBarStyle, 'hidden');
assert.deepEqual(macMainWindow.options.titleBarOverlay, {
  color: '#ffffff',
  symbolColor: '#0a0a0a',
  height: 40,
});
assert.deepEqual(darkMainWindow.options.titleBarOverlay, {
  color: '#0a0a0a',
  symbolColor: '#fafafa',
  height: 40,
});
assert.equal(macMainWindow.options.webPreferences.preload, '/tmp/preload.js');
assert.equal(macMainWindow.options.webPreferences.contextIsolation, true);
assert.equal(macMainWindow.options.webPreferences.nodeIntegration, false);
assert.equal(macMainWindow.options.webPreferences.sandbox, false);
assert.equal('frame' in macMainWindow.options, false, 'the native-controls design does not remove the window frame');

// macOS traffic lights are vertically centered in the 40px bar (buttons are 12px tall).
assert.deepEqual(macMainWindow.options.trafficLightPosition, { x: 16, y: 14 });
assert.equal('trafficLightPosition' in windowsMainWindow.options, false, 'trafficLightPosition is macOS-only');
assert.equal('trafficLightPosition' in linuxMainWindow.options, false, 'trafficLightPosition is macOS-only');

const localWindowOpenHandler = createLocalWindowOpenHandler(
  isAllowedLocalWindowUrl,
  () => 3001,
  () => '192.168.1.50',
);

// ── Title-bar mode resolution (Phase 2 fallback gating) ───────────────────────

// Captain-verified configuration: Debian + GNOME on real hardware with a
// modern Electron keeps native overlay controls.
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '43.4.0', overlayApiPresent: true }),
  'native-overlay',
);
assert.equal(
  resolveTitleBarMode({ platform: 'darwin', electronVersion: '43.4.0', overlayApiPresent: true }),
  'native-overlay',
);
assert.equal(
  resolveTitleBarMode({ platform: 'darwin', electronVersion: '43.4.0', overlayApiPresent: false }),
  'native-overlay',
  'macOS supplies native traffic lights and resolves to native-overlay even without WCO overlay API',
);
assert.equal(
  resolveTitleBarMode({ platform: 'darwin', electronVersion: '32.0.0', overlayApiPresent: false }),
  'native-overlay',
  'macOS supplies native traffic lights across runtime versions',
);
assert.equal(
  resolveTitleBarMode({ platform: 'win32', electronVersion: '33.0.0', overlayApiPresent: true }),
  'native-overlay',
);
// Pre-33 Electron builds can end up hidden-with-no-controls when the overlay
// silently fails; they must fall back instead.
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '32.3.1', overlayApiPresent: true }),
  'html-fallback',
);
assert.equal(
  resolveTitleBarMode({ platform: 'win32', electronVersion: '32.3.1', overlayApiPresent: true }),
  'html-fallback',
);
// Missing runtime overlay API (defensive probe) forces the fallback on Windows/Linux.
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '43.4.0', overlayApiPresent: false }),
  'html-fallback',
);
assert.equal(
  resolveTitleBarMode({ platform: 'win32', electronVersion: '43.4.0', overlayApiPresent: false }),
  'html-fallback',
);
assert.equal(
  resolveTitleBarMode({ platform: 'freebsd', electronVersion: '43.4.0', overlayApiPresent: true }),
  'html-fallback',
);
// Malformed version strings must fail closed.
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '', overlayApiPresent: true }),
  'html-fallback',
);
assert.equal(
  resolveTitleBarMode({ platform: 'linux', electronVersion: '33oops', overlayApiPresent: true }),
  'html-fallback',
);

const linuxFallbackMainWindow = createMainWindow(FakeBrowserWindow as any, '/tmp/preload.js', 'linux', 'html-fallback');
assert.equal(linuxFallbackMainWindow.options.titleBarStyle, 'hidden');
assert.equal(
  'titleBarOverlay' in linuxFallbackMainWindow.options,
  false,
  'fallback mode must not ship hidden-with-no-controls: renderer draws the caption buttons',
);
assert.equal(linuxFallbackMainWindow.options.webPreferences.contextIsolation, true);

// ── Window-control action application (IPC verb set) ─────────────────────────

class FakeWindow {
  calls: string[] = [];
  maximized = false;
  isDestroyed() { return false; }
  minimize() { this.calls.push('minimize'); }
  isMaximized() { return this.maximized; }
  maximize() { this.maximized = true; this.calls.push('maximize'); }
  unmaximize() { this.maximized = false; this.calls.push('unmaximize'); }
  close() { this.calls.push('close'); }
}

const win = new FakeWindow();
assert.deepEqual(applyWindowControlAction(win as any, 'minimize'), { success: true });
assert.deepEqual(applyWindowControlAction(win as any, 'toggle-maximize'), { success: true });
assert.equal(win.maximized, true, 'toggle-maximize maximizes a restored window');
assert.deepEqual(applyWindowControlAction(win as any, 'toggle-maximize'), { success: true });
assert.equal(win.maximized, false, 'toggle-maximize restores a maximized window');
assert.deepEqual(applyWindowControlAction(win as any, 'close'), { success: true });
assert.deepEqual(win.calls, ['minimize', 'maximize', 'unmaximize', 'close']);

for (const bad of ['destroy', '', 'minimize ', 'MAXIMIZE', undefined, null, 42]) {
  assert.deepEqual(
    applyWindowControlAction(win as any, bad),
    { error: 'Unsupported window action' },
    `action ${String(bad)} must be rejected`,
  );
}
assert.deepEqual(win.calls, ['minimize', 'maximize', 'unmaximize', 'close'], 'rejected actions must not touch the window');
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

// ── Theme-following overlay colors (#458) ────────────────────────────────────

// The static constructor options use the light tokens.
assert.deepEqual(resolveTitleBarOverlayColors(false), TITLE_BAR_OVERLAY_COLORS.light);
assert.deepEqual(resolveTitleBarOverlayColors(true), TITLE_BAR_OVERLAY_COLORS.dark);
assert.deepEqual(TITLE_BAR_OVERLAY_COLORS.light, { color: '#ffffff', symbolColor: '#0a0a0a' });
assert.deepEqual(TITLE_BAR_OVERLAY_COLORS.dark, { color: '#0a0a0a', symbolColor: '#fafafa' });
assert.equal(TITLE_BAR_HEIGHT, 40);

// Platform gating: overlay updates only where setTitleBarOverlay works.
assert.equal(supportsTitleBarOverlay('darwin'), true);
assert.equal(supportsTitleBarOverlay('win32'), true);
assert.equal(supportsTitleBarOverlay('linux'), false);

function makeOverlaySpy(): { calls: unknown[]; win: unknown } {
  const calls: unknown[] = [];
  return {
    calls,
    win: {
      setTitleBarOverlay(options: unknown) {
        calls.push(options);
      },
    },
  };
}

const darkCall = makeOverlaySpy();
assert.equal(applyTitleBarOverlayTheme(darkCall.win, true, 'darwin'), true);
assert.deepEqual(darkCall.calls, [{ color: '#0a0a0a', symbolColor: '#fafafa', height: 40 }]);

const lightCall = makeOverlaySpy();
assert.equal(applyTitleBarOverlayTheme(lightCall.win, false, 'win32'), true);
assert.deepEqual(lightCall.calls, [{ color: '#ffffff', symbolColor: '#0a0a0a', height: 40 }]);

// Unsupported platform and missing/unusable API must no-op without throwing.
const linuxCall = makeOverlaySpy();
assert.equal(applyTitleBarOverlayTheme(linuxCall.win, true, 'linux'), false);
assert.equal(linuxCall.calls.length, 0);
assert.equal(applyTitleBarOverlayTheme({}, true, 'darwin'), false);
assert.equal(applyTitleBarOverlayTheme(null, true, 'win32'), false);
const throwingWin = {
  setTitleBarOverlay() {
    throw new Error('overlay rejected');
  },
};
assert.equal(applyTitleBarOverlayTheme(throwingWin, true, 'darwin'), false, 'runtime rejection degrades to no-op');

// Theme sync wiring follows nativeTheme 'updated' events with live state.
function makeFakeNativeTheme(initialDark: boolean): {
  shouldUseDarkColors: boolean;
  listeners: Array<() => void>;
  emitUpdated(): void;
} {
  return {
    shouldUseDarkColors: initialDark,
    listeners: [],
    emitUpdated() {
      for (const listener of this.listeners) listener();
    },
    on(_event: string, listener: () => void) {
      this.listeners.push(listener);
      return this;
    },
    off(_event: string, listener: () => void) {
      this.listeners = this.listeners.filter((l) => l !== listener);
      return this;
    },
  } as any;
}

const syncTheme = makeFakeNativeTheme(false);
const synced = makeOverlaySpy();
const unsubscribe = attachTitleBarThemeSync(syncTheme, () => synced.win, 'darwin');
syncTheme.shouldUseDarkColors = true;
syncTheme.emitUpdated();
assert.deepEqual(synced.calls, [{ color: '#0a0a0a', symbolColor: '#fafafa', height: 40 }]);
syncTheme.shouldUseDarkColors = false;
syncTheme.emitUpdated();
assert.deepEqual(synced.calls[1], { color: '#ffffff', symbolColor: '#0a0a0a', height: 40 });
unsubscribe();
syncTheme.emitUpdated();
assert.equal(synced.calls.length, 2, 'unsubscribed listeners stop receiving updates');

// No listener is registered on unsupported platforms, and missing windows no-op.
const linuxTheme = makeFakeNativeTheme(true);
const linuxUnsubscribe = attachTitleBarThemeSync(linuxTheme, () => null, 'linux');
linuxUnsubscribe(); // must be safe even when nothing was subscribed
assert.equal(linuxTheme.listeners.length, 0, 'Linux does not subscribe to nativeTheme updates');
const missingWindowTheme = makeFakeNativeTheme(true);
attachTitleBarThemeSync(missingWindowTheme, () => null, 'darwin');
missingWindowTheme.emitUpdated(); // must not throw while the window is absent

console.log('Title-bar dynamic theme overlay resolution and platform guards pass.');
console.log('Title-bar main-window options, fallback gating, and popup/KDS exclusions are preserved.');

// gh-513: theme-mode helpers
assert.equal(resolveThemeMode(undefined), 'system');
assert.equal(resolveThemeMode(null), 'system');
assert.equal(resolveThemeMode('bogus'), 'system');
assert.equal(resolveThemeMode('light'), 'light');
assert.equal(resolveThemeMode('dark'), 'dark');
assert.equal(resolveThemeMode('system'), 'system');
assert.equal(isThemeMode('light'), true);
assert.equal(isThemeMode('DARK'), false);
assert.equal(isThemeMode(42), false);
assert.equal(resolveInitialIsDark('dark', false), true);
assert.equal(resolveInitialIsDark('system', true), true);
assert.equal(resolveInitialIsDark('system', false), false);
assert.equal(resolveInitialIsDark('light', true), false);
assert.equal(
  appendThemeQueryParam('http://192.168.1.5:3002/kds', true),
  'http://192.168.1.5:3002/kds?theme=dark',
);
assert.equal(
  appendThemeQueryParam('http://192.168.1.5:3002/kds?table=3', false),
  'http://192.168.1.5:3002/kds?table=3&theme=light',
);
assert.equal(
  appendThemeQueryParam('http://192.168.1.5:3002/kds?theme=dark', false),
  'http://192.168.1.5:3002/kds?theme=light',
);
assert.equal(appendThemeQueryParam('not a url', true), 'not a url');
console.log('Theme-mode helpers (gh-513) resolve, validate, and rewrite URLs.');
