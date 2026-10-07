/**
 * Main-window failed-load recovery.
 *
 * Recovery destroys the failed window before its replacement exists - the only
 * way to reuse Electron's persisted window name. Destroying the last window
 * raises `window-all-closed`, so the replacement flag has to be set before the
 * destroy or Windows/Linux quit the app mid-recovery.
 */

export interface RecoverableWindow {
  isDestroyed(): boolean;
  destroy(): void;
}

export interface FailedWindowRecoveryOptions {
  getMainWindow: () => RecoverableWindow | null;
  /** True when a quit or shutdown already owns the lifecycle. */
  isAborted: () => boolean;
  /** False when runtime services are down, so relaunching is the only recovery. */
  isRuntimeHealthy: () => boolean;
  requestRelaunch: (reason: string) => void;
  createWindow: () => void;
  logError?: (message: string, error: unknown) => void;
}

export interface FailedWindowRecovery {
  /** True while a failed window is being replaced. */
  isReplacingWindow(): boolean;
  /** Runs `work` with the all-closed quit suppressed, restoring the prior state. */
  suppressAllClosedQuit<T>(work: () => T): T;
  /** Re-arms in-place recovery after a window loaded successfully. */
  markLoadSucceeded(): void;
  recover(failedWindow: RecoverableWindow): void;
}

/** Windows/Linux quit on the last closed window; macOS keeps the app alive. */
export function shouldQuitOnAllWindowsClosed(platform: string, replacingWindow: boolean): boolean {
  return platform !== 'darwin' && !replacingWindow;
}

export function createFailedWindowRecovery(options: FailedWindowRecoveryOptions): FailedWindowRecovery {
  let recoveryAttempted = false;
  let replacingWindow = false;

  const suppressAllClosedQuit = <T>(work: () => T): T => {
    const previous = replacingWindow;
    replacingWindow = true;
    try {
      return work();
    } finally {
      replacingWindow = previous;
    }
  };

  const recover = (failedWindow: RecoverableWindow): void => {
    if (options.isAborted()) return;
    if (options.getMainWindow() !== failedWindow) return;
    if (!options.isRuntimeHealthy()) {
      options.requestRelaunch('window-load-retry-exhausted');
      return;
    }
    if (recoveryAttempted) {
      options.requestRelaunch('window-load-recovery-failed');
      return;
    }
    recoveryAttempted = true;
    suppressAllClosedQuit(() => {
      try {
        if (!failedWindow.isDestroyed()) failedWindow.destroy();
        options.createWindow();
      } catch (error) {
        options.logError?.('[Window] Window recreation failed:', error);
        options.requestRelaunch('window-load-recovery-create-failed');
      }
    });
  };

  return {
    isReplacingWindow: () => replacingWindow,
    suppressAllClosedQuit,
    markLoadSucceeded: () => { recoveryAttempted = false; },
    recover,
  };
}
