/**
 * Backend recovery lifecycle verification (issue #548).
 *
 * Verifies that a confirmed-dead backend (Express/KDS/Server App all
 * unreachable) triggers exactly one guarded app relaunch, never a
 * same-process retry:
 *   1. beginBackendRecovery relaunches exactly once and quits.
 *   2. Concurrent recovery triggers (activate + load-retry exhaustion firing
 *      together) share one in-flight attempt — relaunch/quit called once.
 *   3. State is 'terminal' after recovery settles; further calls are no-ops.
 *   4. With the relaunch-attempt marker already present in argv (i.e. this
 *      is the relaunched process and it died again), no second relaunch is
 *      attempted — a native error dialog is shown and the app quits cleanly.
 *   5. markBackendHealthy only transitions out of 'starting' once, and never
 *      downgrades a 'recovering'/'terminal' state.
 *   6. setQuitting and runCleanup are both invoked, and cleanup completes,
 *      before relaunch/quit fire — the ordering main/updater-shutdown.ts
 *      documents as required to avoid this app's close-to-tray window
 *      handling turning a relaunch into an unreliable, slow-to-exit quit.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/backend-lifecycle.test.ts
 */

import * as assert from 'node:assert/strict';
import {
  beginBackendRecovery,
  getBackendLifecycleState,
  initBackendLifecycle,
  markBackendHealthy,
  resetBackendLifecycleForTests,
  type BackendLifecycleApp,
  type BackendLifecycleDeps,
  type BackendLifecycleDialog,
} from '../main/backend-lifecycle';

function log(msg: string): void {
  console.log(msg);
}

class AppDouble implements BackendLifecycleApp {
  relaunchCalls: Array<{ args?: string[]; execPath?: string }> = [];
  quitCount = 0;
  callOrder: string[];

  constructor(callOrder: string[]) {
    this.callOrder = callOrder;
  }

  relaunch(options?: { args?: string[]; execPath?: string }): void {
    this.callOrder.push('relaunch');
    this.relaunchCalls.push(options ?? {});
  }

  quit(): void {
    this.callOrder.push('quit');
    this.quitCount++;
  }
}

class DialogDouble implements BackendLifecycleDialog {
  errorBoxes: Array<{ title: string; content: string }> = [];

  showErrorBox(title: string, content: string): void {
    this.errorBoxes.push({ title, content });
  }
}

/** Builds a full BackendLifecycleDeps double, tracking call order across setQuitting/runCleanup/relaunch/quit. */
function createTrackedDeps(argv: string[]): {
  app: AppDouble;
  dialog: DialogDouble;
  callOrder: string[];
  deps: BackendLifecycleDeps;
} {
  const callOrder: string[] = [];
  const app = new AppDouble(callOrder);
  const dialog = new DialogDouble();
  const deps: BackendLifecycleDeps = {
    app,
    dialog,
    argv,
    setQuitting: () => { callOrder.push('setQuitting'); },
    runCleanup: async () => { callOrder.push('cleanup'); },
  };
  return { app, dialog, callOrder, deps };
}

async function run(): Promise<void> {
  log('================================================================');
  log('   BACKEND RECOVERY LIFECYCLE VERIFICATION (issue #548)        ');
  log('================================================================\n');

  // ── 1. Single Guarded Relaunch ──────────────────────────────────────
  log('[Step 1] Verifying beginBackendRecovery relaunches exactly once...');
  resetBackendLifecycleForTests();
  const { app: app1, deps: deps1 } = createTrackedDeps(['/usr/bin/flo']);
  initBackendLifecycle(deps1);

  assert.equal(getBackendLifecycleState(), 'starting', 'Initial state is starting');
  await beginBackendRecovery('activate');

  assert.equal(app1.relaunchCalls.length, 1, 'app.relaunch() called exactly once');
  assert.equal(app1.quitCount, 1, 'app.quit() called exactly once');
  assert.ok(
    app1.relaunchCalls[0].args?.includes('--flo-relaunch-attempt'),
    'relaunch args carry the one-shot attempt marker',
  );
  assert.equal(getBackendLifecycleState(), 'terminal', 'State settles to terminal after relaunch');
  log('  ✓ Recovery performs exactly one relaunch and marks the attempt.');

  // ── 2. Concurrent Triggers Share One In-Flight Attempt ──────────────
  log('\n[Step 2] Verifying concurrent recovery triggers share a single attempt...');
  resetBackendLifecycleForTests();
  const { app: app2, deps: deps2 } = createTrackedDeps(['/usr/bin/flo']);
  initBackendLifecycle(deps2);

  const promiseA = beginBackendRecovery('activate');
  const promiseB = beginBackendRecovery('load-retry-exhausted');
  assert.equal(promiseA, promiseB, 'Both triggers share the exact same in-flight recovery promise');
  await Promise.all([promiseA, promiseB]);
  assert.equal(app2.relaunchCalls.length, 1, 'Concurrent triggers still relaunch exactly once');
  assert.equal(app2.quitCount, 1, 'Concurrent triggers still quit exactly once');
  log('  ✓ Two simultaneous recovery triggers do not double-relaunch.');

  // ── 3. Terminal State is a One-Way Latch ────────────────────────────
  log('\n[Step 3] Verifying terminal state is absorbing (further calls are no-ops)...');
  await beginBackendRecovery('activate-again');
  assert.equal(app2.relaunchCalls.length, 1, 'A later call after terminal does not relaunch again');
  assert.equal(app2.quitCount, 1, 'A later call after terminal does not quit again');
  assert.equal(getBackendLifecycleState(), 'terminal', 'State remains terminal');
  log('  ✓ Terminal state absorbs further recovery attempts, preventing a relaunch loop.');

  // ── 4. Relaunch Marker Prevents a Second Relaunch ───────────────────
  log('\n[Step 4] Verifying a process that already relaunched once shows a dialog instead of looping...');
  resetBackendLifecycleForTests();
  const { app: app3, dialog: dialog3, deps: deps3 } = createTrackedDeps(['/usr/bin/flo', '--flo-relaunch-attempt']);
  initBackendLifecycle(deps3);

  await beginBackendRecovery('activate');
  assert.equal(app3.relaunchCalls.length, 0, 'A second relaunch is never attempted');
  assert.equal(app3.quitCount, 1, 'The process still quits cleanly');
  assert.equal(dialog3.errorBoxes.length, 1, 'A native error dialog is shown instead of looping');
  assert.equal(getBackendLifecycleState(), 'terminal', 'State settles to terminal');
  log('  ✓ Relaunch is bounded at one attempt; a repeat failure surfaces a clear dialog.');

  // ── 5. markBackendHealthy Only Transitions Out of "starting" ────────
  log('\n[Step 5] Verifying markBackendHealthy cannot downgrade recovering/terminal state...');
  resetBackendLifecycleForTests();
  const { deps: deps4 } = createTrackedDeps(['/usr/bin/flo']);
  initBackendLifecycle(deps4);

  markBackendHealthy();
  assert.equal(getBackendLifecycleState(), 'healthy', 'starting -> healthy on markBackendHealthy()');
  markBackendHealthy();
  assert.equal(getBackendLifecycleState(), 'healthy', 'Calling markBackendHealthy again is a no-op');

  await beginBackendRecovery('load-retry-exhausted');
  assert.equal(getBackendLifecycleState(), 'terminal', 'healthy -> terminal via recovery');
  markBackendHealthy();
  assert.equal(getBackendLifecycleState(), 'terminal', 'markBackendHealthy cannot resurrect a terminal state');
  log('  ✓ markBackendHealthy only ever advances starting -> healthy, never overrides recovery/terminal.');

  // ── 6. Cleanup Runs, and Completes, Before Relaunch/Quit ────────────
  log('\n[Step 6] Verifying setQuitting + runCleanup complete before relaunch/quit fire...');
  resetBackendLifecycleForTests();
  const { callOrder: callOrder6, deps: deps6 } = createTrackedDeps(['/usr/bin/flo']);
  initBackendLifecycle(deps6);

  await beginBackendRecovery('activate');
  assert.deepEqual(
    callOrder6,
    ['setQuitting', 'cleanup', 'relaunch', 'quit'],
    'setQuitting and a completed cleanup must precede relaunch/quit, not follow reactively',
  );
  log('  ✓ Cleanup is awaited proactively before the terminal relaunch/quit call.');

  // Same ordering must hold on the already-attempted (dialog) branch too.
  resetBackendLifecycleForTests();
  const { callOrder: callOrder7, deps: deps7 } = createTrackedDeps(['/usr/bin/flo', '--flo-relaunch-attempt']);
  initBackendLifecycle(deps7);

  await beginBackendRecovery('activate');
  assert.deepEqual(
    callOrder7,
    ['setQuitting', 'cleanup', 'quit'],
    'the already-attempted branch also runs cleanup before quitting, with no relaunch call',
  );
  log('  ✓ The already-attempted branch also cleans up before its single quit call.');

  log('\n================================================================');
  log('✅ ALL BACKEND RECOVERY LIFECYCLE CHECKS PASSED (7/7)');
  log('================================================================');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
