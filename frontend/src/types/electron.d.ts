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
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<void>;

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

export interface UpdateStatus {
  status: 'checking' | 'available' | 'downloading' | 'installing' | 'up-to-date' | 'error' | 'dev-mode';
  info?: {
    version?: string;
    releaseDate?: string;
  };
  progress?: number;
  error?: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
