export type BackendLifecycleState = 'starting' | 'healthy' | 'recovering' | 'terminal';

const RELAUNCH_ATTEMPT_FLAG = '--flo-relaunch-attempt';

export type BackendLifecycleApp = {
  relaunch: (options?: { args?: string[]; execPath?: string }) => void;
  quit: () => void;
};

export type BackendLifecycleDialog = {
  showErrorBox: (title: string, content: string) => void;
};

export type BackendLifecycleLogger = {
  error: (...args: unknown[]) => void;
};

export interface BackendLifecycleDeps {
  app: BackendLifecycleApp;
  dialog: BackendLifecycleDialog;
  /** The same idempotent cleanup coordinator createShutdownEntrypoints() returns. */
  runCleanup: () => Promise<void>;
  /** Marks the app as intentionally quitting so the window's close handler
   *  doesn't veto/hide it instead of letting it close (mirrors every other
   *  app.quit() call site in index.ts). */
  setQuitting: () => void;
  log?: BackendLifecycleLogger;
  argv?: string[];
}

let deps: BackendLifecycleDeps | null = null;
let lifecycleState: BackendLifecycleState = 'starting';
let recoveryPromise: Promise<void> | null = null;

/** Wires the real electron app/dialog (or test doubles) — call once, before 'activate' can fire. */
export function initBackendLifecycle(nextDeps: BackendLifecycleDeps): void {
  deps = nextDeps;
}

/** Called once startup has confirmed the server, KDS, and server-app are all up. */
export function markBackendHealthy(): void {
  if (lifecycleState === 'starting') {
    lifecycleState = 'healthy';
  }
}

export function getBackendLifecycleState(): BackendLifecycleState {
  return lifecycleState;
}

/** Test-only: resets module state between test cases. Never called from production code. */
export function resetBackendLifecycleForTests(): void {
  deps = null;
  lifecycleState = 'starting';
  recoveryPromise = null;
}

/**
 * Guarded recovery gate for a confirmed-dead backend. Idempotent: concurrent
 * callers (e.g. Dock activation firing while a load-retry exhaustion is
 * already recovering) share the same in-flight attempt and trigger at most
 * one relaunch. The database shutdown latch in db.ts and Electron's
 * throw-on-duplicate-ipcMain.handle both make in-process re-initialization
 * unsafe, so recovery always relaunches the whole app rather than retrying
 * startup in this process.
 */
export function beginBackendRecovery(reason: string): Promise<void> {
  if (!deps) throw new Error('[Lifecycle] beginBackendRecovery called before initBackendLifecycle.');
  if (lifecycleState === 'terminal') {
    return recoveryPromise ?? Promise.resolve();
  }
  if (!recoveryPromise) {
    lifecycleState = 'recovering';
    deps.log?.error(`[Lifecycle] Backend recovery triggered (${reason}); relaunching.`);
    recoveryPromise = runRelaunch(deps, reason).finally(() => {
      lifecycleState = 'terminal';
    });
  }
  return recoveryPromise;
}

async function runRelaunch(activeDeps: BackendLifecycleDeps, reason: string): Promise<void> {
  const argv = activeDeps.argv ?? process.argv;
  const alreadyAttempted = argv.includes(RELAUNCH_ATTEMPT_FLAG);

  // Mark the app as intentionally quitting and run the exact same shutdown
  // coordinator normal quit paths use, and AWAIT it here rather than
  // relying on app.quit()'s own reactive will-quit handler to trigger it.
  // main/updater-shutdown.ts's createRestartAndInstallHandler documents why:
  // calling app.quit() before cleanup has already finished sends this app's
  // close-to-tray window handling and the will-quit coordinator through an
  // extra preventDefault()/re-quit round-trip that — combined with
  // app.relaunch() already being scheduled — leaves the process eligible to
  // exit but not reliably prompted to; running cleanup first means
  // cleanupFinished is already true by the time will-quit fires, so the
  // first quit call is the one that actually exits.
  activeDeps.setQuitting();
  try {
    await activeDeps.runCleanup();
  } catch (error) {
    activeDeps.log?.error(`[Lifecycle] Cleanup before relaunch failed (${reason}):`, error);
  }

  if (alreadyAttempted) {
    activeDeps.log?.error(`[Lifecycle] Relaunch already attempted once (${reason}); not relaunching again.`);
    activeDeps.dialog.showErrorBox(
      'Flo needs to restart',
      'Flo could not recover automatically. Please quit and reopen the app.',
    );
    activeDeps.app.quit();
    return;
  }

  activeDeps.app.relaunch({ args: argv.slice(1).concat([RELAUNCH_ATTEMPT_FLAG]) });
  activeDeps.app.quit();
}
