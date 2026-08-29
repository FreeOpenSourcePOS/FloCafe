export type UpdateShutdownState = {
  setInstallingUpdate: (value: boolean) => void;
  setQuitting: (value: boolean) => void;
};

type UpdateAuthorizationResult =
  | { ok: true }
  | { ok: false; error: string };

type RestartAndInstallResult =
  | { success: true }
  | { success: false; error: string };

type RestartAndInstallOptions = {
  isInstallReady: () => boolean;
  authorize: (pin: string | undefined) => UpdateAuthorizationResult;
  runCleanup: () => Promise<void>;
  quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void;
  updateState: UpdateShutdownState;
  warn: (message: string) => void;
  error: (message: string, error: unknown) => void;
};

export function resetUpdateShutdownState(updateState: UpdateShutdownState): void {
  updateState.setInstallingUpdate(false);
  updateState.setQuitting(false);
}

export function createRestartAndInstallHandler({
  isInstallReady,
  authorize,
  runCleanup,
  quitAndInstall,
  updateState,
  warn,
  error,
}: RestartAndInstallOptions): (event: unknown, pin?: unknown) => Promise<RestartAndInstallResult> {
  return async (_event, pin) => {
    if (!isInstallReady()) {
      warn('[Update] Ignoring install request before an update is downloaded');
      return { success: false, error: 'No downloaded update is ready to install.' };
    }
    const auth = authorize(typeof pin === 'string' ? pin : undefined);
    if (!auth.ok) {
      warn(`[Update] Restart-to-install denied by Master PIN gate: ${auth.error}`);
      return { success: false, error: auth.error };
    }
    updateState.setInstallingUpdate(true);
    updateState.setQuitting(true);
    try {
      await runCleanup();
    } catch (cleanupError) {
      error('[Update] Pre-install cleanup failed (proceeding with install):', cleanupError);
    }
    try {
      quitAndInstall(false, true);
      return { success: true };
    } catch (installError) {
      resetUpdateShutdownState(updateState);
      error('[Update] quitAndInstall failed:', installError);
      return { success: false, error: installError instanceof Error ? installError.message : String(installError) };
    }
  };
}
