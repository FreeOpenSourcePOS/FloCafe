import {
  classifyUpdateError,
  type StoredUpdateStatus,
  type UpdateErrorPhase,
} from './update-state';

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
  onInstallFailure: (error: unknown) => void;
  warn: (message: string) => void;
  error: (message: string, error: unknown) => void;
};

type AutoUpdaterErrorHandlerOptions = {
  getPhase: () => UpdateErrorPhase;
  setPhase: (phase: UpdateErrorPhase) => void;
  isInstallReady: () => boolean;
  isInstallingUpdate: () => boolean;
  setUpdateStatus: (next: StoredUpdateStatus) => void;
  onInstallFailure: (error: unknown) => void;
  logInfo: (message: string, detail?: unknown) => void;
};

export function createAutoUpdaterErrorHandler(
  {
    getPhase,
    setPhase,
    isInstallReady,
    isInstallingUpdate,
    setUpdateStatus,
    onInstallFailure,
    logInfo,
  }: AutoUpdaterErrorHandlerOptions,
): (error: unknown) => void {
  return (error) => {
    const errorPhase = getPhase();
    const classified = classifyUpdateError(error, errorPhase);
    setPhase('check');
    logInfo(
      `[Update] Updater error classified as ${classified.state}` +
      `/${classified.reason}:`, classified.detail
    );
    if (isInstallingUpdate()) {
      logInfo('[Update] Installation failed after shutdown; relaunching the current version');
      onInstallFailure(error);
      return;
    }
    if (isInstallReady()) {
      logInfo('[Update] Preserving ready-to-install status while staged update awaits installation');
      return;
    }
    setUpdateStatus({
      status: classified.state,
      reason: classified.reason,
      error: classified.detail
    });
  };
}

export function createRestartAndInstallHandler({
  isInstallReady,
  authorize,
  runCleanup,
  quitAndInstall,
  updateState,
  onInstallFailure,
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
      error('[Update] quitAndInstall failed:', installError);
      onInstallFailure(installError);
      return { success: false, error: installError instanceof Error ? installError.message : String(installError) };
    }
  };
}
