import { expect, test } from '@playwright/test';
import type { NativeElectronHarness } from './native-harness';
import { createNativeElectronHarness } from './native-harness';

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let harness: NativeElectronHarness;

async function countPosWindows(): Promise<number> {
  return harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((window) => window.webContents.getURL().startsWith('http://localhost:')).length);
}

test.beforeAll(async () => {
  harness = await createNativeElectronHarness();
});

test.afterAll(async () => {
  await harness?.close();
});

test('activation recreates a usable window after the renderer window is destroyed', async () => {
  await harness.authenticateDashboard();
  const originalPid = harness.app.process().pid;

  await harness.app.evaluate(({ BrowserWindow }) => {
    new BrowserWindow({ show: false });
    const pos = BrowserWindow.getAllWindows().find((win) => {
      try { return win.webContents.getURL().startsWith('http://localhost:'); } catch { return false; }
    });
    pos?.destroy();
  });
  await expect.poll(countPosWindows).toBe(0);

  const recoveredWindow = harness.app.waitForEvent('window');
  await harness.app.evaluate(({ app }) => {
    app.emit('activate');
  });
  const recoveredPage = await recoveredWindow;

  await recoveredPage.waitForURL((url) => url.port === String(harness.ports.main), { timeout: 30_000 });
  await expect(recoveredPage.getByTestId('desktop-drag-surface')).toBeVisible();
  harness.setActivePage(recoveredPage);
  await harness.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .filter((win) => !win.webContents.getURL().startsWith('http://localhost:'))
      .forEach((win) => win.destroy());
  });
  await expect.poll(countPosWindows).toBe(1);
  expect(harness.app.process().pid).toBe(originalPid);

  const evidenceDir = '/Users/gurkiratkhaira/.no-mistakes/evidence/01M1AC5JTRTHW6GJT21WHX933N';
  try {
    await recoveredPage.screenshot({ path: `${evidenceDir}/recovered-window-after-renderer-destroyed.png` });
  } catch (err) {
    console.warn('[Evidence] Could not capture screenshot 1:', err);
  }

  const runtime = await recoveredPage.evaluate(async () => window.electronAPI?.getStatus());
  expect(runtime).toMatchObject({
    server: 'running',
    kdsServer: 'running',
    serverApp: 'running',
  });

  await harness.app.evaluate(({ app }) => {
    app.emit('activate');
  });
  await expect.poll(countPosWindows).toBe(1);
});

test('activation relaunches once after terminal runtime loss', async ({ }, testInfo) => {
  testInfo.setTimeout(480_000);
  await harness.authenticateDashboard();
  let relaunchCalls = 0;
  harness.app.on('console', (message) => {
    if (message.text() === '[Native E2E] runtime relaunch requested') relaunchCalls += 1;
  });
  await harness.app.evaluate(({ app }) => {
    const originalRelaunch = app.relaunch.bind(app);
    app.relaunch = (options?: Parameters<typeof originalRelaunch>[0]) => {
      console.log('[Native E2E] runtime relaunch requested');
      originalRelaunch(options);
    };
  });

  await harness.simulateTerminalRuntimeLoss();
  await harness.app.evaluate(({ app }) => {
    app.emit('activate');
    app.emit('activate');
  });
  await expect.poll(() => relaunchCalls, { timeout: 30_000 }).toBe(1);

  const recoveredPage = await harness.relaunchAndWaitForPage();
  await recoveredPage.waitForURL((url) => url.port === String(harness.ports.main), { timeout: 30_000 });
  await expect(recoveredPage.getByTestId('desktop-drag-surface')).toBeVisible();
  await expect(recoveredPage.locator('[data-slot="sidebar-container"]')).toBeVisible();

  const evidenceDir = '/Users/gurkiratkhaira/.no-mistakes/evidence/01M1AC5JTRTHW6GJT21WHX933N';
  try {
    await recoveredPage.screenshot({ path: `${evidenceDir}/recovered-window-after-terminal-runtime-loss.png` });
  } catch (err) {
    console.warn('[Evidence] Could not capture screenshot 2:', err);
  }

  await expect.poll(async () => recoveredPage.evaluate(async () => window.electronAPI?.getStatus())).toMatchObject({
    server: 'running',
    kdsServer: 'running',
    serverApp: 'running',
  });
});
