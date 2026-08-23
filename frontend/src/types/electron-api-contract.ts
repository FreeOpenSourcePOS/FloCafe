import type {
  DailySummary,
  ElectronAPI,
  ElectronActionResult,
  ElectronIpcError,
  ElectronPrinter,
  ElectronPrinterInput,
  KdsInfo,
} from './electron';

type Equal<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends
  (<T>() => T extends Expected ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// Keep the renderer declaration tied to the exact preload-facing contracts.
// These aliases intentionally have no runtime output; the frontend type-check is
// the regression test and fails if a method is removed or widened/narrowed.
export type ElectronApiContractChecks = [
  Expect<Equal<ElectronAPI['getSettings'], () => Promise<Record<string, string> | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['setSetting'], (key: string, value: string) => Promise<ElectronActionResult | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getKdsInfo'], () => Promise<KdsInfo | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['openKdsWindow'], () => Promise<void | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getPrinters'], () => Promise<ElectronPrinter[] | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['savePrinter'], (printer: ElectronPrinterInput) => Promise<ElectronActionResult | ElectronIpcError>>>,
  Expect<Equal<ElectronAPI['getDailySummary'], () => Promise<DailySummary | ElectronIpcError>>>,
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
];
