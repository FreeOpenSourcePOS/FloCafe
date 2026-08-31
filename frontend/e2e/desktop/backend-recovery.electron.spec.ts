import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import type { NativeElectronHarness } from './native-harness';
import { createNativeElectronHarness } from './native-harness';

// Retry-exhaustion escalation (the other trigger into the same recovery
// gate) is covered at the unit level in tests/window-load-retry.test.ts and
// tests/backend-lifecycle.test.ts. Reproducing it here would need the app to
// load with the backend already dead, which this harness's startup sequence
// (which waits on health before returning) does not support without a
// second, more invasive harness path. The Dock-activation trigger below is
// the literal scenario reported in issue #548 and the harder one to cover
// outside a real Electron process.
test.describe.configure({ mode: 'serial' });
test.setTimeout(90_000);

let harness: NativeElectronHarness;
let backendDied = false;

test.beforeAll(async () => {
  harness = await createNativeElectronHarness();
});

test.afterAll(async () => {
  // The relaunch test below intentionally kills this process's owned
  // servers and lets the real recovery path relaunch and quit it. Once that
  // has happened, harness.close()'s own app.evaluate(() => app.quit()) call
  // has nothing left to talk to, so it cleans up the relaunched process
  // itself instead of relying on this hook.
  if (backendDied) return;
  await harness?.close();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return true;
    } catch {
      // Server not listening yet — keep polling.
    }
    await delay(100);
  }
  return false;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await delay(100);
  }
  return false;
}

/** Best-effort: find whichever process is now listening on `port` (the relaunched app). */
function findListenerPid(port: number): number | null {
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
    const pid = Number(output.split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

test('healthy Dock activation restores an existing hidden window without relaunching', async () => {
  const pidBefore = harness.app.process().pid;
  expect(pidBefore).toBeTruthy();

  await harness.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.hide();
  });
  await expect
    .poll(() => harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false))
    .toBe(false);

  // Simulates the macOS Dock activation event. app is a real Node EventEmitter.
  await harness.app.evaluate(({ app }) => {
    app.emit('activate', {}, true);
  });

  await expect
    .poll(() => harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false), {
      timeout: 15_000,
    })
    .toBe(true);
  expect(harness.app.process().pid).toBe(pidBefore);
});

test('repeated Dock activation after the backend dies triggers exactly one recovery and preserves data', async () => {
  const pidBefore = harness.app.process().pid;
  expect(pidBefore).toBeTruthy();

  // Simulate the reported bug: the owned HTTP services die while the
  // Electron main process and database stay alive. FLO_E2E_ALLOW_TEST_HOOKS
  // (set by native-harness.ts) makes main/index.ts install a global hook
  // that calls the real stopServer/stopKdsServer/stopServerApp on the exact
  // running server instances — Playwright's evaluate() sandbox has no
  // `require`, so this is the only way to reach into the live process.
  await harness.app.evaluate(async () => {
    await (globalThis as unknown as { __floTestHooks__: { stopAllBackendServers: () => Promise<void> } })
      .__floTestHooks__.stopAllBackendServers();
  });

  const stillHealthy = await waitForHealthy(harness.ports.main, 3_000);
  expect(stillHealthy, 'servers should be down after the simulated crash').toBe(false);

  const recoveryLogLines: string[] = [];
  const goodbyeSeen = new Promise<void>((resolve) => {
    harness.app.on('console', (message) => {
      const text = message.text();
      if (text.includes('[Lifecycle] Backend recovery triggered')) recoveryLogLines.push(text);
      if (text === '[Flo] Goodbye!') resolve();
    });
  });

  // Fire the same synthetic Dock activation used in the healthy-path test —
  // twice, back to back, simulating a user clicking the Dock icon
  // repeatedly while it's unresponsive. This must detect the dead backend,
  // relaunch instead of showing a blank error page, and — critically —
  // must not start a second recovery/relaunch for the second activation.
  await harness.app.evaluate(({ app }) => {
    app.emit('activate', {}, true);
    app.emit('activate', {}, true);
  });

  await Promise.race([
    goodbyeSeen,
    delay(30_000).then(() => { throw new Error('Timed out waiting for graceful shutdown after recovery'); }),
  ]);
  backendDied = true;

  expect(recoveryLogLines.length, 'exactly one recovery attempt should start despite two activate events').toBe(1);

  // The cleanup coordinator closes the database last, only after both HTTP
  // servers have fully drained — a clean "[Flo] Goodbye!" is only reached if
  // that full sequence succeeded without throwing, which is what guarantees
  // the database file was not left mid-write. Confirm the seeded fixture
  // row is still readable from the closed file.
  const dbPath = path.join(harness.profileDir, 'flo.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const owner = db.prepare('SELECT id, email FROM users WHERE id = ?').get('native-e2e-owner') as
      | { id: string; email: string }
      | undefined;
    expect(owner?.id, 'the seeded owner account must survive the recovery shutdown').toBe('native-e2e-owner');
  } finally {
    db.close();
  }

  // Cleanup already ran before "Goodbye!" logged, so the actual OS-level
  // exit and relaunch should now follow within a couple of seconds — this
  // is the guard against a regression back to the reactive will-quit dance
  // that made this take minutes before backend-lifecycle.ts started
  // awaiting runCleanup() proactively (see runRelaunch's comment).
  const exited = await waitForProcessExit(pidBefore!, 15_000);
  expect(exited, 'the original process should exit promptly once cleanup has already completed').toBe(true);

  const healthyAgain = await waitForHealthy(harness.ports.main, 30_000);
  expect(healthyAgain, 'a relaunched process should come back healthy on the same ports').toBe(true);

  // Best-effort cleanup of the relaunched process; harness.close() cannot
  // reach it since it was never launched through Playwright. SIGKILL (not
  // SIGTERM) deliberately: main/shutdown.ts installs a SIGTERM handler that
  // runs the full graceful shutdown coordinator, which is correct product
  // behavior but not something a discarded test double needs to wait on.
  const newPid = findListenerPid(harness.ports.main);
  if (newPid) {
    try { process.kill(newPid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
