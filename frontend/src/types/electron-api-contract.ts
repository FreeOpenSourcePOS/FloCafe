import type {
  DailySummary,
  ElectronAPI,
  ElectronActionResult,
  ElectronAppInfo,
  ElectronDbSafeFixesResult,
  ElectronIpcError,
  ElectronMasterPinStatus,
  ElectronPrinter,
  ElectronPrinterInput,
  ElectronStatus,
  KdsInfo,
  UpdateStatus,
} from './electron';

type Equal<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends
  (<T>() => T extends Expected ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// Type-level regression assertions matching renderer ElectronAPI
// against preload-facing IPC contracts without runtime output.
export type ElectronApiContractChecks = [
  Expect<Equal<ElectronAPI['dbApplySafeFixes'], (findingIds?: string[]) => Promise<ElectronDbSafeFixesResult | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getMasterPinStatus'], () => Promise<ElectronMasterPinStatus | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getSettings'], () => Promise<Record<string, string | null> | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['setSetting'], (key: string, value: string) => Promise<ElectronActionResult | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['setThemeEffective'], (isDark: boolean) => Promise<ElectronActionResult | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getKdsInfo'], () => Promise<KdsInfo | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['openKdsWindow'], () => Promise<void | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getAppInfo'], () => Promise<ElectronAppInfo | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getPrinters'], () => Promise<ElectronPrinter[] | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['savePrinter'], (printer: ElectronPrinterInput) => Promise<ElectronActionResult | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getDailySummary'], () => Promise<DailySummary | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getStatus'], () => Promise<ElectronStatus>>>,
  Expect<Equal<ElectronAPI['onUpdateStatus'], (callback: (status: UpdateStatus) => void) => (() => void)>>,
];

// Ensure the named response models remain structurally usable by callers.
export type ElectronApiMethodPresence = Pick<
  ElectronAPI,
  | 'onMenuAction'
  | 'backupDatabase'
  | 'restoreBackup'
  | 'dbHealthCheck'
  | 'dbApplySafeFixes'
  | 'dbInitialize'
  | 'getMasterPinStatus'
  | 'getSettings'
  | 'setSetting'
  | 'setThemeEffective'
  | 'getKdsInfo'
  | 'openKdsWindow'
  | 'getAppInfo'
  | 'getStatus'
  | 'getPrinters'
  | 'savePrinter'
  | 'getDailySummary'
  | 'onUpdateStatus'
  | 'getUpdateStatus'
  | 'checkForUpdates'
  | 'restartAndInstall'
  | 'platform'
>;

export type ElectronApiContractModels = [
  Expect<Equal<keyof KdsInfo, 'url' | 'wsUrl' | 'localIP' | 'port'>>,
  Expect<Equal<keyof DailySummary, 'date' | 'revenue' | 'bill_count' | 'covers' | 'pending_orders'>>,
  Expect<Equal<ElectronPrinter['connection_type'], 'network' | 'usb' | 'webusb'>>,
  Expect<Equal<ElectronPrinter['port'], number | null>>,
  Expect<Equal<UpdateStatus['releaseNotes'], unknown>>,
];
