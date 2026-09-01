import { expect, test } from '@playwright/test';
import type { NativeElectronHarness } from './native-harness';
import { createNativeElectronHarness } from './native-harness';

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let harness: NativeElectronHarness;

test.beforeAll(async () => {
  harness = await createNativeElectronHarness();
});

test.afterAll(async () => {
  await harness?.close();
});

test('real Electron mounts the root drag surface before authentication', async () => {
  await expect(harness.page.getByTestId('desktop-drag-surface')).toBeVisible();
  await expect(harness.page.locator('html')).toHaveAttribute('data-flo-desktop-titlebar', 'true');
  if (process.env.FLO_E2E_EVIDENCE_DIR) {
    await harness.page.screenshot({
      path: `${process.env.FLO_E2E_EVIDENCE_DIR}/01-native-electron-login-screen.png`,
    });
  }
});

test('real preload, renderer, and main boundaries reach an authenticated dashboard', async () => {
  await harness.authenticateDashboard();
  await expect(harness.page.locator('[data-slot="sidebar-container"]')).toBeVisible();
  await expect(harness.page.getByTestId('desktop-title-bar')).toBeVisible();
  if (process.env.FLO_E2E_EVIDENCE_DIR) {
    await harness.page.screenshot({
      path: `${process.env.FLO_E2E_EVIDENCE_DIR}/02-native-electron-authenticated-dashboard.png`,
    });
  }

  const runtime = await harness.page.evaluate(async () => {
    const api = window.electronAPI;
    if (!api) throw new Error('Native E2E preload did not expose electronAPI');
    const status = await api.getStatus();
    const appInfo = await api.getAppInfo();
    const updateStatus = await api.getUpdateStatus();
    const readiness = await api.windowReady({ epoch: status.titleBarEpoch ?? 0 });
    return {
      hasApi: true,
      platform: api.platform,
      titleBarMode: status?.titleBarMode,
      titleBarEpoch: status?.titleBarEpoch,
      titleBarDocumentNonce: status?.titleBarDocumentNonce,
      focusedAttribute: document.documentElement.dataset.floWindowFocused,
      desktopAttribute: document.documentElement.dataset.floDesktopTitlebar,
      appInfo,
      updateStatus,
      readiness,
    };
  });

  expect(runtime.hasApi).toBe(true);
  expect(runtime.platform).toBe(process.platform);
  expect(runtime.titleBarMode).toBe('native-overlay');
  expect(runtime.titleBarEpoch).toBeGreaterThan(0);
  expect(runtime.titleBarDocumentNonce).toMatch(/^[0-9a-f-]{36}$/i);
  expect(runtime.focusedAttribute).toBe('true');
  expect(runtime.desktopAttribute).toBe('true');
  expect(runtime.appInfo).toMatchObject({ name: 'flo-desktop', platform: process.platform });
  expect(runtime.updateStatus.status).toBeTruthy();
  expect(runtime.updateStatus.info.version).toBeTruthy();
  expect(runtime.readiness).toEqual({ success: true });
});

test('POS topbar fullscreen toggle stays synchronized with native window state', async () => {
  test.skip(process.platform === 'linux', 'Linux CI uses Xvfb without a window manager, so native maximize state is not observable');
  await harness.authenticateDashboard();

  const readNativeWindowState = async () => harness.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try { return new URL(candidate.webContents.getURL()).pathname.replace(/\/+$/, '') === '/pos'; } catch { return false; }
    });
    if (!window) return null;
    return { isMaximized: window.isMaximized(), isFullScreen: window.isFullScreen() };
  });
  const topbarToggle = harness.page.getByRole('button', { name: /full-screen POS/i });

  await harness.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try { return new URL(candidate.webContents.getURL()).pathname.replace(/\/+$/, '') === '/pos'; } catch { return false; }
    });
    if (!window) throw new Error('POS BrowserWindow not found');
    if (window.isFullScreen()) window.setFullScreen(false);
    if (window.isMaximized()) window.unmaximize();
  });
  await expect.poll(readNativeWindowState).toEqual({ isMaximized: false, isFullScreen: false });
  await expect(topbarToggle).toHaveAttribute('aria-label', 'Enter full-screen POS');

  if (process.env.FLO_E2E_EVIDENCE_DIR) {
    await harness.page.screenshot({
      path: `${process.env.FLO_E2E_EVIDENCE_DIR}/06-pos-topbar-restored.png`,
    });
  }

  await topbarToggle.click();
  await expect.poll(readNativeWindowState).toMatchObject({ isMaximized: true, isFullScreen: false });
  await expect(topbarToggle).toHaveAttribute('aria-label', 'Exit full-screen POS');
  if (process.env.FLO_E2E_EVIDENCE_DIR) {
    await harness.page.screenshot({
      path: `${process.env.FLO_E2E_EVIDENCE_DIR}/07-pos-topbar-maximized.png`,
    });
  }

  await harness.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try { return new URL(candidate.webContents.getURL()).pathname.replace(/\/+$/, '') === '/pos'; } catch { return false; }
    });
    if (!window) throw new Error('POS BrowserWindow not found');
    window.unmaximize();
  });
  await expect.poll(readNativeWindowState).toMatchObject({ isMaximized: false, isFullScreen: false });
  await expect(topbarToggle).toHaveAttribute('aria-label', 'Enter full-screen POS');

  await harness.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try { return new URL(candidate.webContents.getURL()).pathname.replace(/\/+$/, '') === '/pos'; } catch { return false; }
    });
    if (!window) throw new Error('POS BrowserWindow not found');
    window.setFullScreen(true);
  });
  await expect.poll(readNativeWindowState).toMatchObject({ isMaximized: false, isFullScreen: true });
  await expect(topbarToggle).toHaveAttribute('aria-label', 'Exit full-screen POS');
  if (process.env.FLO_E2E_EVIDENCE_DIR) {
    await harness.page.screenshot({
      path: `${process.env.FLO_E2E_EVIDENCE_DIR}/08-pos-topbar-native-fullscreen.png`,
    });
  }

  await topbarToggle.click();
  await expect.poll(readNativeWindowState).toMatchObject({ isFullScreen: false });
  await expect(topbarToggle).toHaveAttribute('aria-label', 'Enter full-screen POS');
});

test('native window lifecycle is observable through the Electron boundary', async () => {
  test.skip(!['darwin', 'win32', 'linux'].includes(process.platform), 'FloCafe native window lifecycle is unsupported on this platform');
  test.skip(process.platform === 'linux', 'Linux CI uses Xvfb without a window manager, so native minimize/restore is not observable');
  await harness.app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  const nativeWindow = await harness.app.browserWindow(harness.page);
  await nativeWindow.evaluate((window) => window.minimize());
  await expect.poll(() => nativeWindow.evaluate((window) => window.isMinimized())).toBe(true);
  await nativeWindow.evaluate((window) => window.restore());
  await expect.poll(() => nativeWindow.evaluate((window) => !window.isMinimized())).toBe(true);
});

test('native shell geometry remains an explicit platform boundary', async () => {
  test.skip(true, 'Traffic-light and caption-button geometry is OS-managed and is not observable through Playwright in this harness; platform unit/runtime probes own that evidence');
});
