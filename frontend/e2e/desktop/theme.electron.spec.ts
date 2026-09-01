/**
 * Native Electron e2e for gh-513 (dark theme + title bar sync).
 *
 * Three serial tests against a real Electron + SQLite stack:
 *
 *   1. Dark toggle applies the .dark class to <html> and the effective-theme
 *      IPC handshake reaches main (getStatus.effectiveTheme === 'dark').
 *   2. System mode follows the OS theme signal — driven through Electron's
 *      main-process nativeTheme.themeSource, which propagates to the
 *      renderer's prefers-color-scheme media query (the real path that
 *      ThemeSync subscribes to; page.emulateMedia is the wrong layer here).
 *   3. The persisted theme_mode survives a full app relaunch: before the
 *      user logs in, the FOUC script and main-side initial-isDark read
 *      already paint dark — the SQLite row is the source of truth.
 */

import { expect, test } from '@playwright/test';
import type { NativeElectronHarness } from './native-harness';
import { createNativeElectronHarness } from './native-harness';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

let harness: NativeElectronHarness;

test.beforeAll(async () => {
  harness = await createNativeElectronHarness();
});

test.afterAll(async () => {
  // After test 3 swaps the harness via relaunch(), `harness` points at the
  // most recently launched instance — close that one. The previous app has
  // already been graceful-quit by relaunch().
  await harness?.close();
});

async function navigateToAppearance(): Promise<void> {
  await harness.page.goto(`http://localhost:${harness.ports.main}/settings`, {
    waitUntil: 'domcontentloaded',
  });
  await harness.page
    .getByRole('button', { name: 'Appearance', exact: true })
    .click();
  await harness.page
    .getByRole('radiogroup', { name: 'Theme' })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function clickThemeRadio(label: 'Light' | 'Dark' | 'System'): Promise<void> {
  const radio = harness.page.getByRole('radio', { name: label, exact: true });
  await expect.poll(() => radio.isDisabled(), { timeout: 10_000 }).toBe(false);
  await radio.click();
  // The previous PUT round-trip may still be in flight (the page disables
  // every radio while a save is pending). Wait for the persistence layer to
  // release so subsequent clicks are not silently dropped.
  await expect.poll(() => radio.isDisabled(), { timeout: 10_000 }).toBe(false);
}

test('real Electron flips the renderer palette when the owner toggles Dark in Settings', async () => {
  await harness.authenticateDashboard();
  await navigateToAppearance();

  await clickThemeRadio('Dark');

  await harness.page.waitForFunction(
    () => document.documentElement.classList.contains('dark'),
    undefined,
    { timeout: 10_000 },
  );

  // html.dark and localStorage are settled by the waitForFunction; only the
  // main-side push (set-theme-effective IPC, fire-and-forget) needs polling.
  await expect.poll(async () => harness.page.evaluate(async () => {
    const status = await window.electronAPI?.getStatus();
    return status?.effectiveTheme;
  }), { timeout: 10_000 }).toBe('dark');

  const runtime = await harness.page.evaluate(() => ({
    htmlHasDark: document.documentElement.classList.contains('dark'),
    mirror: (() => {
      try { return localStorage.getItem('flo-theme-resolved'); } catch { return null; }
    })(),
  }));
  expect(runtime.htmlHasDark).toBe(true);
  expect(runtime.mirror).toBe('dark');

  if (process.env.FLO_E2E_EVIDENCE_DIR) {
    await harness.page.screenshot({
      path: `${process.env.FLO_E2E_EVIDENCE_DIR}/03-theme-dark-toggle.png`,
    });
  }
});

test('real System mode follows nativeTheme.themeSource through the renderer matchMedia listener', async () => {
  // The Settings page is still mounted from test 1 — switch back to System.
  await clickThemeRadio('System');

  // Drive the OS signal at the Electron boundary. themeSource propagation is
  // what ThemeSync subscribes to via matchMedia('(prefers-color-scheme: dark)')
  // — emulating at the page layer would exercise a different code path.
  await harness.app.evaluate((electron) => {
    electron.nativeTheme.themeSource = 'dark';
  });
  await harness.page.waitForFunction(
    () => document.documentElement.classList.contains('dark'),
    undefined,
    { timeout: 10_000 },
  );

  await harness.app.evaluate((electron) => {
    electron.nativeTheme.themeSource = 'light';
  });
  await harness.page.waitForFunction(
    () => !document.documentElement.classList.contains('dark'),
    undefined,
    { timeout: 10_000 },
  );

  await harness.app.evaluate((electron) => {
    electron.nativeTheme.themeSource = 'system';
  });

  if (process.env.FLO_E2E_EVIDENCE_DIR) {
    await harness.page.screenshot({
      path: `${process.env.FLO_E2E_EVIDENCE_DIR}/04-theme-system-mode.png`,
    });
  }
});

test('persisted theme_mode survives a full app relaunch (SQLite round-trip)', async () => {
  await clickThemeRadio('Dark');
  await harness.page.waitForFunction(
    () => document.documentElement.classList.contains('dark'),
    undefined,
    { timeout: 10_000 },
  );
  await expect.poll(async () => harness.page.evaluate(async () => {
    const status = await window.electronAPI?.getStatus();
    return status?.effectiveTheme;
  }), { timeout: 10_000 }).toBe('dark');

  // Only the first harness carries relaunch(); the relaunched one omits it.
  const newHarness = await harness.relaunch!();
  // The new app is parked on /auth/login (no owner session yet). On this
  // boot the SQLite row + ThemeSync hydration + FOUC script are the only
  // reasons the .dark class can be true — there's no user interaction in
  // between.
  const persisted = await newHarness.page.evaluate(async () => {
    const status = await window.electronAPI?.getStatus();
    return {
      htmlHasDark: document.documentElement.classList.contains('dark'),
      effectiveTheme: status?.effectiveTheme,
    };
  });
  expect(persisted.htmlHasDark).toBe(true);
  expect(persisted.effectiveTheme).toBe('dark');

  if (process.env.FLO_E2E_EVIDENCE_DIR) {
    await newHarness.page.screenshot({
      path: `${process.env.FLO_E2E_EVIDENCE_DIR}/05-theme-persistence-after-relaunch.png`,
    });
  }

  harness = newHarness;
});
