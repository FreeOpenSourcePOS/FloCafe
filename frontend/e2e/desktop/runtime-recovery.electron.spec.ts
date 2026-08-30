import { expect, test } from '@playwright/test';
import type { NativeElectronHarness } from './native-harness';
import { createNativeElectronHarness } from './native-harness';

test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let harness: NativeElectronHarness;

async function countPosWindows(): Promise<number> {
  return harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((window) => !window.webContents.getURL().startsWith('devtools://')).length);
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
    BrowserWindow.getAllWindows()[0]?.destroy();
  });
  await expect.poll(countPosWindows).toBe(0);

  const recoveredWindow = harness.app.waitForEvent('window');
  await harness.app.evaluate(({ app }) => {
    app.emit('activate');
  });
  const recoveredPage = await recoveredWindow;

  await recoveredPage.waitForURL((url) => url.port === String(harness.ports.main), { timeout: 30_000 });
  await expect(recoveredPage.getByTestId('desktop-drag-surface')).toBeVisible();
  await expect.poll(countPosWindows).toBe(1);
  expect(harness.app.process().pid).toBe(originalPid);

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
