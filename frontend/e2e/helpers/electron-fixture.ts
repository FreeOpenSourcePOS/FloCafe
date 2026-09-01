import type { Page } from '@playwright/test';
import type {
  DailySummary,
  ElectronAPI,
  ElectronActionResult,
  ElectronAppInfo,
  ElectronDbSafeFixesResult,
  ElectronIpcError,
  ElectronMasterPinStatus,
  ElectronStatus,
  HealthCheckReport,
  KdsInfo,
  TitleBarMode,
  UpdateStatus,
  WindowControlAction,
} from '../../src/types/electron';

export interface ElectronFixtureOptions {
  platform?: 'darwin' | 'win32' | 'linux';
  titleBarMode?: TitleBarMode;
  titleBarEpoch?: number;
  titleBarDocumentNonce?: string;
  focused?: boolean;
  api?: boolean;
}

interface SerializedElectronFixtureOptions {
  platform: ElectronFixtureOptions['platform'];
  titleBarMode: TitleBarMode;
  titleBarEpoch: number;
  titleBarDocumentNonce: string;
  focused: boolean;
  api: boolean;
}

const DEFAULT_DOCUMENT_NONCE = '00000000-0000-4000-8000-000000000000';

export async function injectElectronFixture(
  page: Page,
  options: ElectronFixtureOptions = {},
): Promise<void> {
  const fixture: SerializedElectronFixtureOptions = {
    platform: options.platform ?? 'darwin',
    titleBarMode: options.titleBarMode ?? 'native-overlay',
    titleBarEpoch: options.titleBarEpoch ?? 1,
    titleBarDocumentNonce: options.titleBarDocumentNonce ?? DEFAULT_DOCUMENT_NONCE,
    focused: options.focused ?? true,
    api: options.api ?? true,
  };

  await page.addInitScript((config: SerializedElectronFixtureOptions) => {
    if (!config.api) return;

    const actions: WindowControlAction[] = [];
    const status: ElectronStatus = {
      server: 'running',
      kdsServer: 'running',
      serverApp: 'running',
      memory: { heapUsed: 1, heapTotal: 1, rss: 1 },
      uptime: 1,
      port: 3001,
      titleBarMode: config.titleBarMode,
      titleBarEpoch: config.titleBarEpoch,
      titleBarDocumentNonce: config.titleBarDocumentNonce,
    };
    const result: ElectronActionResult = { success: true };
    const ipcError: ElectronIpcError = { error: 'unsupported in browser fixture' };
    const appInfo: ElectronAppInfo = {
      version: 'e2e',
      name: 'Flo Cafe',
      electron: 'fixture',
      node: 'fixture',
      platform: config.platform ?? 'darwin',
    };
    const updateStatus: UpdateStatus = { status: 'dev-mode' };
    const healthReport: HealthCheckReport = {
      generatedAt: new Date(0).toISOString(),
      liveSchemaVersion: 0,
      idealSchemaVersion: 0,
      findings: [],
      summary: { safeCount: 0, manualReviewCount: 0 },
    };
    const kdsInfo: KdsInfo = {
      url: 'http://127.0.0.1:3002',
      wsUrl: 'ws://127.0.0.1:3002/kds',
      localIP: '127.0.0.1',
      port: 3002,
    };
    const dailySummary: DailySummary = {
      date: '1970-01-01',
      revenue: 0,
      bill_count: 0,
      covers: 0,
      pending_orders: 0,
    };
    const masterPinStatus: ElectronMasterPinStatus = { available: false, isSet: false };
    const safeFixes: ElectronDbSafeFixesResult = { applied: [], skipped: [], errors: [] };

    const api: ElectronAPI = {
      platform: config.platform ?? 'darwin',
      onMenuAction: () => () => {},
      windowAction: async (action) => {
        actions.push(action);
        return result;
      },
      backupDatabase: async () => ({ success: false, error: ipcError.error }),
      restoreBackup: async () => ({ success: false, error: ipcError.error }),
      dbHealthCheck: async () => healthReport,
      dbApplySafeFixes: async () => safeFixes,
      dbInitialize: async () => ({ success: false, error: ipcError.error }),
      getMasterPinStatus: async () => masterPinStatus,
      getSettings: async () => ({}),
      setSetting: async () => result,
      // gh-513: effective-theme push verb; tracked by the harness to verify
      // the renderer notifies main when the resolved palette changes.
      setThemeEffective: async (_isDark: boolean) => result,
      getKdsInfo: async () => kdsInfo,
      openKdsWindow: async () => undefined,
      getAppInfo: async () => appInfo,
      getPrinters: async () => [],
      savePrinter: async () => result,
      getDailySummary: async () => dailySummary,
      getStatus: async () => status,
      windowReady: async () => result,
      onUpdateStatus: (callback) => {
        callback(updateStatus);
        return () => {};
      },
      getUpdateStatus: async () => ({ status: updateStatus.status, info: { version: appInfo.version } }),
      getBetaChannel: async () => false,
      setBetaChannel: async () => result,
      checkForUpdates: async () => undefined,
      restartAndInstall: async () => result,
    };

    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api });
    Object.defineProperty(window, '__floElectronFixture', {
      configurable: true,
      value: { actions, status, ipcError },
    });
    // Initial focus is explicit before application scripts execute. TitleBar
    // owns later focus/blur transitions on dashboard routes.
    const setInitialFocus = (): void => {
      if (document.documentElement) {
        document.documentElement.dataset.floWindowFocused = String(config.focused);
      }
    };
    setInitialFocus();
    document.addEventListener('DOMContentLoaded', setInitialFocus, { once: true });
  }, fixture);
}

export async function readFixtureActions(page: Page): Promise<WindowControlAction[]> {
  return page.evaluate(() => {
    const state = window.__floElectronFixture;
    return state ? [...state.actions] : [];
  });
}

declare global {
  interface Window {
    __floElectronFixture?: {
      actions: WindowControlAction[];
      status: ElectronStatus;
      ipcError: ElectronIpcError;
    };
  }
}

export {};
