/**
 * Shared type definitions for Electron API exposed via preload.ts.
 * Used across frontend components to avoid `any` casts on window.electronAPI.
 */

export interface ElectronAPI {
  // Menu
  onMenuAction: (callback: (action: string) => void) => (() => void);

  // Database
  backupDatabase: (pin?: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  restoreBackup: (pin?: string, backupPath?: string) => Promise<{ success: boolean; error?: string }>;
  dbHealthCheck: () => Promise<HealthCheckReport | { error: string }>;
  dbApplySafeFixes: (findingIds?: string[]) => Promise<{ applied: string[]; skipped: string[]; errors: { id: string; error: string }[] }>;
  dbInitialize: (pin: string, confirmationPhrase: string) => Promise<{ success: boolean; backupPath?: string; error?: string }>;
  getMasterPinStatus: () => Promise<{ available: boolean; isSet: boolean }>;

  // Settings
  getSettings: () => Promise<Record<string, string> | ElectronIpcError>;
  setSetting: (key: string, value: string) => Promise<ElectronActionResult | ElectronIpcError>;

  // KDS
  getKdsInfo: () => Promise<KdsInfo | ElectronIpcError>;
  openKdsWindow: () => Promise<void | ElectronIpcError>;

  // App info
  getAppInfo: () => Promise<{
    version: string;
    name: string;
    electron: string;
    node: string;
    platform: string;
  }>;

  // Printers
  getPrinters: () => Promise<ElectronPrinter[] | ElectronIpcError>;
  savePrinter: (printer: ElectronPrinterInput) => Promise<ElectronActionResult | ElectronIpcError>;

  // Reports
  getDailySummary: () => Promise<DailySummary | ElectronIpcError>;

  // Status
  getStatus: () => Promise<{
    server: string;
    memory: { heapUsed: number; heapTotal: number; rss: number };
    uptime: number;
    port: number;
  }>;

  // Updates
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => (() => void);
  getUpdateStatus: () => Promise<{ status: UpdateStatus['status']; version?: string; percent?: number; reason?: UpdateFailureReason; error?: string; info: { version: string } }>;
  checkForUpdates: () => Promise<void>;
  restartAndInstall: () => Promise<void>;

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
  port: number;
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
  /** Legacy fields still bound by the Electron handler when supplied. */
  type?: string;
  usb_vendor_id?: number | null;
  usb_product_id?: number | null;
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
  releaseNotes?: string;
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
