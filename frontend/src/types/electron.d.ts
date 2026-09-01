/**
 * Shared type definitions for Electron API exposed via preload.ts.
 * Used across frontend components to avoid `any` casts on window.electronAPI.
 */

export interface ElectronAPI {
  // Menu
  onMenuAction: (callback: (action: string) => void) => (() => void);

  // Window controls
  windowAction: (action: WindowControlAction) => Promise<ElectronActionResult | ElectronIpcError>;
  getWindowState?: () => Promise<{ isMaximized: boolean; isFullScreen: boolean }>;
  onWindowStateChanged?: (callback: (state: { isMaximized: boolean; isFullScreen: boolean }) => void) => () => void;

  // Database
  backupDatabase: (pin?: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  restoreBackup: (pin?: string, backupPath?: string) => Promise<{ success: boolean; error?: string }>;
  dbHealthCheck: () => Promise<HealthCheckReport | { error: string }>;
  dbApplySafeFixes: (findingIds?: string[]) => Promise<ElectronDbSafeFixesResult | ElectronIpcError>;
  dbInitialize: (pin: string, confirmationPhrase: string) => Promise<{ success: boolean; backupPath?: string; error?: string }>;
  getMasterPinStatus: () => Promise<ElectronMasterPinStatus | ElectronIpcError>;

  // Settings
  getSettings: () => Promise<Record<string, string | null> | ElectronIpcError>;
  setSetting: (key: string, value: string) => Promise<ElectronActionResult | ElectronIpcError>;
  // Effective-theme push (gh-513): renderer resolves the user's theme_mode
  // and tells main so the native titleBarOverlay can follow.
  setThemeEffective: (isDark: boolean) => Promise<ElectronActionResult | ElectronIpcError>;

  // KDS
  getKdsInfo: () => Promise<KdsInfo | ElectronIpcError>;
  openKdsWindow: () => Promise<void | ElectronIpcError>;

  // App info
  getAppInfo: () => Promise<ElectronAppInfo | ElectronIpcError>;

  // Printers
  getPrinters: () => Promise<ElectronPrinter[] | ElectronIpcError>;
  savePrinter: (printer: ElectronPrinterInput) => Promise<ElectronActionResult | ElectronIpcError>;

  // Reports
  getDailySummary: () => Promise<DailySummary | ElectronIpcError>;

  // Status
  getStatus: () => Promise<ElectronStatus>;
  // Renderer readiness report, used after either native-overlay or HTML
  // fallback controls are available. Reports are bound to the document epoch
  // from getStatus() so main can reject stale reports.
  windowReady: (payload: { epoch: number }) => Promise<ElectronActionResult | ElectronIpcError>;

  // Updates
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => (() => void);
  getUpdateStatus: () => Promise<{ status: UpdateStatus['status']; version?: string; percent?: number; reason?: UpdateFailureReason; error?: string; info: { version: string } }>;
  /** Persisted beta opt-in (#463); returns true if subscribed to the beta feed. */
  getBetaChannel: () => Promise<boolean>;
  /** Change the beta channel opt-in; refused while an update is staged or in flight. */
  setBetaChannel: (enabled: boolean) => Promise<ElectronActionResult>;
  checkForUpdates: () => Promise<void>;
  // #463: the main process authorizes the manager/owner PIN before quitting
  // to install; a denied request resolves with success:false instead of restarting.
  restartAndInstall: (pin?: string) => Promise<ElectronActionResult>;

  // Platform
  platform: string;
}

export interface ElectronIpcError {
  error: string;
}

export interface ElectronActionResult {
  success: boolean;
  error?: string;
}

export interface ElectronDbSafeFixesResult {
  applied: string[];
  skipped: string[];
  errors: { id: string; error: string }[];
}

export interface ElectronMasterPinStatus {
  available: boolean;
  isSet: boolean;
}

export interface ElectronAppInfo {
  version: string;
  name: string;
  electron: string;
  node: string;
  platform: string;
}

export interface ElectronStatus {
  server: string;
  kdsServer: string;
  serverApp: string;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  uptime: number;
  port: number;
  /** How main supplies the window caption controls. Optional so a newer
   * renderer against an older main keeps native-overlay Phase 1 behavior. */
  titleBarMode?: TitleBarMode;
  /** Current readiness epoch of the loaded document; bind windowReady reports
   * to it. Optional for the same older-main compatibility reason. */
  titleBarEpoch?: number;
  /** Opaque document-scoped readiness nonce, paired with titleBarEpoch. */
  titleBarDocumentNonce?: string;
  /** Effective palette main last applied to the overlay; optional for
   * older-main compatibility (gh-513). */
  effectiveTheme?: 'light' | 'dark';
}

export type TitleBarMode = 'native-overlay' | 'html-fallback';

export type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

export interface KdsInfo {
  url: string;
  wsUrl: string;
  localIP: string;
  port: number;
}

export type PrinterConnectionType = 'network' | 'usb' | 'webusb';

/** Raw printer row returned by the legacy Electron IPC settings path. */
export interface ElectronPrinter {
  id: string;
  name: string;
  connection_type: PrinterConnectionType;
  ip_address: string | null;
  port: number | null;
  is_default: number;
  paper_width: string | null;
  created_at: string;
  updated_at: string;
}

/** Input accepted by main/ipc.ts save-printer. */
export interface ElectronPrinterInput {
  id?: string;
  name: string;
  connection_type: PrinterConnectionType;
  ip_address?: string | null;
  port?: number | null;
  is_default?: boolean | number;
}

export interface DailySummary {
  date: string;
  revenue: number;
  bill_count: number;
  covers: number;
  pending_orders: number;
}

export type HealthFindingRisk = 'safe' | 'manual_review';

export interface HealthFinding {
  id: string;
  table: string;
  column?: string;
  index?: string;
  kind: string;
  risk: HealthFindingRisk;
  autoApplicable: boolean;
  description: string;
  suggestedDdl?: string;
  currentState?: string;
  idealState?: string;
}

export interface HealthCheckReport {
  generatedAt: string;
  liveSchemaVersion: number;
  idealSchemaVersion: number;
  findings: HealthFinding[];
  summary: { safeCount: number; manualReviewCount: number };
}

/** Why an update check or download failed, when the main process knows. */
export type UpdateFailureReason = 'manifest-missing' | 'download-failed' | 'unknown';

export interface UpdateStatus {
  // #467 honest state model — mirrors main/update-state.ts.
  status:
    | 'not-checked-yet'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'ready-to-install'
    | 'check-failed'
    | 'offline'
    | 'store-managed'
    | 'linux-managed'
    | 'dev-mode';
  version?: string;
  releaseDate?: string;
  releaseNotes?: unknown;
  percent?: number;
  reason?: UpdateFailureReason;
  error?: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
