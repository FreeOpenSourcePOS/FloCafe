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

  // App info
  getAppInfo: () => Promise<{
    version: string;
    name: string;
    electron: string;
    node: string;
    platform: string;
  }>;

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
