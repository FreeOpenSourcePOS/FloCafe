import type { BrowserWindow, IpcMain } from 'electron';
import { isTrustedMainWindowSender } from './ipc';
import {
  initialUpdateState,
  isInstallReady,
  isUpdateCheckInFlight,
  toIpcUpdateStatus,
  type StoredUpdateStatus,
  type UpdateErrorPhase,
} from './update-state';
import type { TitleBarMode } from './window-options';

export type DirectUpdateIpcOptions = {
  ipcMain: Pick<IpcMain, 'handle'>;
  getMainWindow: () => BrowserWindow | null;
  getServerPort: () => number;
  getStoredUpdateStatus: () => StoredUpdateStatus;
  getStagedUpdateReady: () => boolean;
  getUpdaterPhase: () => UpdateErrorPhase;
  getAppVersion: () => string;
  checkForUpdates: () => void;
  downloadUpdate: () => Promise<unknown> | unknown;
  readAutoUpdateCheckEnabled: () => boolean;
  writeAutoUpdateCheckEnabled: (enabled: boolean) => void;
  readBetaChannelEnabled: () => boolean;
  writeBetaChannelEnabled: (enabled: boolean) => void;
  enqueueBetaChannelTransition: <T>(action: () => Promise<T>) => Promise<T>;
  configureAutoUpdaterChannel: (enabled: boolean) => void;
  setUpdateStatus: (status: StoredUpdateStatus) => void;
  restartAndInstallHandler: (
    event: unknown,
    pin?: unknown,
  ) => Promise<{ success: boolean; error?: string }>;
  isServerRunning: () => boolean;
  isKdsServerRunning: () => boolean;
  isServerAppRunning: () => boolean;
  getResolvedTitleBarMode: () => TitleBarMode;
  getRendererReadinessEpoch: () => number;
  getRendererDocumentNonce: () => string | null | undefined;
  getCurrentEffectiveIsDark: () => boolean;
  setCurrentEffectiveIsDark: (isDark: boolean) => void;
  applyTitleBarOverlayTheme: (
    win: BrowserWindow,
    isDark: boolean,
    platform: NodeJS.Platform,
  ) => void;
  resolveTitleBarOverlayColors: (isDark: boolean) => { color: string; symbolColor: string };
  withDatabaseRequest: <T>(action: () => T | Promise<T>) => Promise<T>;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
  validateSender?: (event: unknown) => boolean;
};

export type DirectUpdateHandlers = Record<
  string,
  (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
>;

export function createDirectUpdateIpcHandlers(
  options: DirectUpdateIpcOptions,
): DirectUpdateHandlers {
  const {
    getMainWindow,
    getServerPort,
    getStoredUpdateStatus,
    getStagedUpdateReady,
    getUpdaterPhase,
    getAppVersion,
    checkForUpdates,
    downloadUpdate,
    readAutoUpdateCheckEnabled,
    writeAutoUpdateCheckEnabled,
    readBetaChannelEnabled,
    writeBetaChannelEnabled,
    enqueueBetaChannelTransition,
    configureAutoUpdaterChannel,
    setUpdateStatus,
    restartAndInstallHandler,
    isServerRunning,
    isKdsServerRunning,
    isServerAppRunning,
    getResolvedTitleBarMode,
    getRendererReadinessEpoch,
    getRendererDocumentNonce,
    getCurrentEffectiveIsDark,
    setCurrentEffectiveIsDark,
    applyTitleBarOverlayTheme,
    resolveTitleBarOverlayColors,
    withDatabaseRequest,
    log,
    validateSender,
  } = options;

  const isSenderAuthorized = (event: unknown): boolean => {
    if (validateSender) return validateSender(event);
    return isTrustedMainWindowSender(
      event as Parameters<typeof isTrustedMainWindowSender>[0],
      getMainWindow,
      getServerPort(),
    );
  };

  return {
    'get-update-status': (event: unknown) => {
      if (!isSenderAuthorized(event)) return { error: 'Unauthorized sender' };
      return toIpcUpdateStatus(getStoredUpdateStatus(), getAppVersion());
    },

    'check-for-updates': (event: unknown) => {
      if (!isSenderAuthorized(event)) return { error: 'Unauthorized sender' };
      checkForUpdates();
    },

    'download-update': (event: unknown) => {
      if (!isSenderAuthorized(event)) return { error: 'Unauthorized sender' };
      return downloadUpdate();
    },

    'updates:get-auto-check': (event: unknown) => {
      if (!isSenderAuthorized(event)) return { error: 'Unauthorized sender' };
      return withDatabaseRequest(() => readAutoUpdateCheckEnabled());
    },

    'updates:set-auto-check': (event: unknown, enabled: unknown) => {
      if (!isSenderAuthorized(event)) {
        return { success: false, error: 'Unauthorized sender' };
      }
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'enabled must be a boolean' };
      }
      return withDatabaseRequest(() => {
        try {
          writeAutoUpdateCheckEnabled(enabled);
        } catch (error) {
          log?.error('[Update] Failed to persist automatic update preference:', error);
          return { success: false, error: 'Could not save the automatic update preference' };
        }
        log?.info(`[Update] Automatic update checks ${enabled ? 'enabled' : 'disabled'} by user`);
        return { success: true };
      });
    },

    'updates:get-beta-channel': (event: unknown) => {
      if (!isSenderAuthorized(event)) return { error: 'Unauthorized sender' };
      return withDatabaseRequest(() => readBetaChannelEnabled());
    },

    'updates:set-beta-channel': (event: unknown, enabled: unknown) => {
      if (!isSenderAuthorized(event)) {
        return { success: false, error: 'Unauthorized sender' };
      }
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'enabled must be a boolean' };
      }
      return enqueueBetaChannelTransition(() =>
        withDatabaseRequest(async () => {
          if (isInstallReady(getStoredUpdateStatus(), getStagedUpdateReady())) {
            return {
              success: false,
              error:
                'A downloaded update is waiting to be installed — install it before switching channels',
            };
          }
          if (isUpdateCheckInFlight(getStoredUpdateStatus(), getUpdaterPhase())) {
            return {
              success: false,
              error: 'An update check or download is in progress — try again once it finishes',
            };
          }
          try {
            writeBetaChannelEnabled(enabled);
          } catch (error) {
            log?.error('[Update] Failed to persist beta-channel preference:', error);
            return { success: false, error: 'Could not save the channel preference' };
          }
          log?.info(`[Update] Beta channel ${enabled ? 'enabled' : 'disabled'} by user`);
          configureAutoUpdaterChannel(enabled);
          setUpdateStatus(initialUpdateState());
          checkForUpdates();
          return { success: true };
        }),
      );
    },

    'restart-and-install': (event: unknown, pin?: unknown) => {
      if (!isSenderAuthorized(event)) {
        return Promise.resolve({ success: false, error: 'Unauthorized sender' });
      }
      return restartAndInstallHandler(event, pin);
    },

    'get-status': (event: unknown) => {
      if (!isSenderAuthorized(event)) return { error: 'Unauthorized sender' };
      const mem = process.memoryUsage();
      return {
        server: isServerRunning() ? 'running' : 'stopped',
        kdsServer: isKdsServerRunning() ? 'running' : 'stopped',
        serverApp: isServerAppRunning() ? 'running' : 'stopped',
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024),
        },
        uptime: process.uptime(),
        port: getServerPort(),
        titleBarMode: getResolvedTitleBarMode(),
        titleBarEpoch: getRendererReadinessEpoch(),
        titleBarDocumentNonce: getRendererDocumentNonce() ?? undefined,
        effectiveTheme: getCurrentEffectiveIsDark() ? 'dark' : 'light',
      };
    },

    'set-theme-effective': (event: unknown, isDark: unknown) => {
      if (!isSenderAuthorized(event)) {
        return { success: false, error: 'Unauthorized sender' };
      }
      if (typeof isDark !== 'boolean') {
        return { success: false, error: 'isDark must be boolean' };
      }
      setCurrentEffectiveIsDark(isDark);
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        applyTitleBarOverlayTheme(mainWindow, isDark, process.platform);
        mainWindow.setBackgroundColor(resolveTitleBarOverlayColors(isDark).color);
      }
      return { success: true };
    },
  };
}

export function registerDirectUpdateIpcHandlers(options: DirectUpdateIpcOptions): void {
  const handlers = createDirectUpdateIpcHandlers(options);
  for (const [channel, handler] of Object.entries(handlers)) {
    options.ipcMain.handle(channel, handler as Parameters<IpcMain['handle']>[1]);
  }
}
