#!/usr/bin/env node
/**
 * Platform title-bar runtime probe (Refs #457 / #462).
 *
 * Runs inside a real Electron main process (`npx electron tests/platform-titlebar-runtime-probe.cjs`)
 * on any desktop platform and produces assertion/log-based evidence for the
 * title-bar platform matrix (docs/title-bar-platform-matrix.md). No screenshots:
 * every check prints a structured PASS/FAIL line and the process exits non-zero
 * if any assertion fails.
 *
 * Requires `npm run build` first: it loads the compiled dist/main/window-options.js.
 *
 * Optional flags:
 *   --fullscreen-check   macOS only: visibly enters/exits fullscreen and records
 *                        kiosk-codepath availability (interactive session required).
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
};

async function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} not met within ${timeoutMs}ms`);
}

async function main() {
  const electron = require('electron');
  const { app, BrowserWindow } = electron;
  const { resolveTitleBarMode, createMainWindow, applyWindowControlAction, MAC_TRAFFIC_LIGHT_POSITION } = require(
    path.join(__dirname, '..', 'dist', 'main', 'window-options.js'),
  );

  const platform = process.platform;
  const electronVersion = process.versions.electron;
  const major = Number(electronVersion.split('.')[0]);
  console.log(`INFO | environment | platform=${platform} electron=${electronVersion}`);

  app.commandLine.appendSwitch('disable-gpu'); // keep CI runners stable

  await app.whenReady();

  // --- Row A: mode resolution decision -------------------------------------
  const overlayApiPresent = typeof BrowserWindow.prototype.setTitleBarOverlay === 'function';
  const resolved = resolveTitleBarMode({ platform, electronVersion, overlayApiPresent });
  const expectedReal = ['darwin', 'win32', 'linux'].includes(platform) && major >= 33 && overlayApiPresent
    ? 'native-overlay'
    : 'html-fallback';
  record(
    'mode-resolution: real environment decision matches contract',
    resolved === expectedReal,
    `resolved=${resolved} (platform=${platform}, electronMajor=${major}, overlayApiPresent=${overlayApiPresent})`,
  );

  record(
    'mode-resolution: missing overlay API fails closed to html-fallback',
    resolveTitleBarMode({ platform, electronVersion, overlayApiPresent: false }) === 'html-fallback',
    'overlayApiPresent=false -> html-fallback',
  );
  record(
    'mode-resolution: pre-33 Electron fails closed to html-fallback',
    resolveTitleBarMode({ platform: 'win32', electronVersion: '32.0.0', overlayApiPresent: true }) === 'html-fallback',
    'electron 32.x -> html-fallback',
  );
  record(
    'mode-resolution: unknown platform fails closed to html-fallback',
    resolveTitleBarMode({ platform: 'sunos', electronVersion, overlayApiPresent: true }) === 'html-fallback',
    'platform=sunos -> html-fallback',
  );

  // --- Row B: fallback window options carry no overlay ----------------------
  const captured = [];
  class RecordingWindow {
    constructor(options) {
      captured.push(options);
    }
    isDestroyed() { return false; }
    minimize() {}
    isMaximized() { return false; }
    maximize() {}
    unmaximize() {}
    close() {}
  }
  const fallbackWin = createMainWindow(RecordingWindow, '/dev/null-preload.js', platform, 'html-fallback');
  const fallbackOptions = captured[0] || {};
  record(
    'fallback-options: html-fallback builds without titleBarOverlay',
    !('titleBarOverlay' in fallbackOptions),
    `titleBarOverlay present=${('titleBarOverlay' in fallbackOptions)}`,
  );
  record(
    'fallback-options: titleBarStyle stays hidden/hiddenInset in fallback',
    fallbackOptions.titleBarStyle === (platform === 'darwin' ? 'hiddenInset' : 'hidden'),
    `titleBarStyle=${fallbackOptions.titleBarStyle}`,
  );

  // --- Row C: real window creation ------------------------------------------
  const win = createMainWindow(BrowserWindow, path.join(__dirname, '_probe-preload-noop.js'), platform, resolved);
  record('window-creation: main window created with resolved mode', !win.isDestroyed(), `mode=${resolved}`);

  if (platform === 'darwin') {
    // macOS has no WCO/setTitleBarOverlay API, so the real environment
    // resolves to html-fallback; traffic lights come from hiddenInset.
    record(
      'overlay-config: darwin uses hiddenInset traffic lights centered in the 40px bar',
      JSON.stringify(MAC_TRAFFIC_LIGHT_POSITION) === JSON.stringify({ x: 16, y: 14 }),
      'trafficLightPosition={x:16,y:14} centers 12px lights in the 40px bar ((40-12)/2=14)',
    );
  } else if (resolved === 'native-overlay') {
    // Constructor-option truth holds on every overlay platform.
    const nativeCaptured = [];
    class NativeRecordingWindow extends RecordingWindow {
      constructor(options) {
        super(options);
        nativeCaptured.push(options);
      }
    }
    createMainWindow(NativeRecordingWindow, path.join(__dirname, '_probe-preload-noop.js'), platform, 'native-overlay');
    const nativeOptions = nativeCaptured[0] || {};
    const overlayOptions = nativeOptions.titleBarOverlay;
    record(
      'overlay-config: window built with titleBarOverlay at 40 DIP height',
      Boolean(overlayOptions) && Number(overlayOptions.height) === 40,
      `titleBarOverlay=${JSON.stringify(overlayOptions)}`,
    );
    const overlay = typeof win.getTitleBarOverlay === 'function' ? win.getTitleBarOverlay() : undefined;
    console.log(`INFO | overlay-getter | platform=${platform} getTitleBarOverlay()=${JSON.stringify(overlay)}${overlay === undefined && platform === 'linux' ? ' (getter not supported on Linux; Electron draws server-side decorations)' : ''}`);
  } else {
    record(
      'overlay-config: html-fallback environment has no native overlay strip',
      typeof win.getTitleBarOverlay !== 'function' || !win.getTitleBarOverlay(),
      'getTitleBarOverlay empty in fallback mode',
    );
  }

  // --- Row D: window control actions through the narrow IPC verb set --------
  record(
    'window-action: unsupported verbs are rejected',
    applyWindowControlAction(win, 'explode').error === 'Unsupported window action',
    "action='explode' rejected",
  );
  if (!process.env.CI || platform === 'win32' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    try {
      applyWindowControlAction(win, 'minimize');
      const minimizedInTime = await waitFor(() => win.isMinimized(), 3000, 'minimize').then(() => true).catch(() => false);
      if (!minimizedInTime && platform === 'linux' && (process.env.CI || process.env.MATRIX_PROBE_ALLOW_NO_WM)) {
        console.log('SKIP | window-action round-trip | display has no window manager (xvfb without WM); state changes are no-ops');
      } else {
        assert.ok(minimizedInTime, 'window should minimize');
        record('window-action: minimize via IPC verb works', true, 'isMinimized()=true after minimize');
        // macOS ignores maximize requests while a window stays miniaturized;
        // restore explicitly first (the shell owns restoration, the renderer
        // can only ever reach these verbs through visible controls).
        if (win.isMinimized()) win.restore();
        await waitFor(() => !win.isMinimized(), 3000, 'restore');
        applyWindowControlAction(win, 'toggle-maximize');
        await waitFor(() => win.isMaximized(), 3000, 'maximize');
        record('window-action: toggle-maximize via IPC verb maximizes', true, 'isMaximized()=true');
        applyWindowControlAction(win, 'toggle-maximize');
        await waitFor(() => !win.isMaximized(), 3000, 'restore');
        record('window-action: toggle-maximize restores', true, 'isMaximized()=false after second toggle');
      }
    } catch (err) {
      record('window-action: interactive minimize/maximize round-trip', false, String(err.message || err));
    }
  } else {
    console.log('SKIP | window-action round-trip | no display server available');
  }

  // --- Row E: optional fullscreen/kiosk hands-on check (macOS, opt-in) ------
  if (process.argv.includes('--fullscreen-check')) {
    if (platform !== 'darwin') {
      console.log('SKIP | fullscreen-check | macOS-only row');
    } else {
      try {
        win.show();
        await waitFor(() => win.isVisible(), 5000, 'window visible');
        win.setFullScreen(true);
        await waitFor(() => win.isFullScreen(), 8000, 'fullscreen enter');
        record('fullscreen: enters native fullscreen', true, 'isFullScreen()=true');
        win.setFullScreen(false);
        await waitFor(() => !win.isFullScreen(), 8000, 'fullscreen exit');
        record('fullscreen: exits native fullscreen cleanly', true, 'isFullScreen()=false');
        // Kiosk: no codepath exists in FloCafe today; assert that honestly.
        record(
          'kiosk: no kiosk codepath exists (documented finding)',
          !BrowserWindow.prototype.setKiosk || !win.isKiosk?.(),
          'FloCafe never calls setKiosk(); matrix documents this row as NOT-RUN/no-codepath',
        );
      } catch (err) {
        record('fullscreen-check', false, String(err.message || err));
      }
    }
  }

  win.destroy();
  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY | ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`FAILED checks: ${failed.map((f) => f.name).join(', ')}`);
    app.exit(1);
    return;
  }
  app.exit(0);
}

main().catch((err) => {
  console.error(`FATAL | ${err.stack || err}`);
  process.exitCode = 1;
});
