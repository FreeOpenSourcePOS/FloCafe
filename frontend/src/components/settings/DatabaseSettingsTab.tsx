'use client';

import { useState } from 'react';
import {
  FileText,
  Database,
  RefreshCw,
  HardDrive,
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  UploadCloud,
  Wrench,
  KeyRound,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { Button } from '@/components/ui/button';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useFormatDate } from '@/hooks/useFormatDate';
import api from '@/lib/api';
import toast from 'react-hot-toast';

export type BackupInfo = {
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  kind: 'manual' | 'auto';
  schemaVersion: number | null;
};

export type GoogleDriveStatus = {
  configured: boolean;
  auth_state: 'configuration_unavailable' | 'storage_unavailable' | 'disconnected' | 'connected' | 'reauth_required';
  connected: boolean;
  account_email: string | null;
  frequency: 'daily' | 'weekly';
  retention_count: number;
  destination_folder_id: string | null;
  destination_folder_name: string | null;
  last_backup_at: string | null;
  last_backup_status: 'success' | 'error' | null;
  last_error: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_success_kind: 'automatic' | 'manual' | null;
  next_retry_at: string | null;
  retention_status: 'ok' | 'pending' | 'error' | null;
  revoke_status: 'confirmed' | 'unconfirmed' | null;
  warning_acknowledged: boolean;
  warning_required: boolean;
  job: { id: string; operation: 'backup' | 'restore'; state: string; error_code?: string; bytes_sent?: number; total_bytes?: number } | null;
  secure_storage_available: boolean;
};

export type GoogleDriveRemoteBackup = {
  id: string;
  name: string;
  kind: 'automatic' | 'manual';
  created_at: string;
  bytes: number;
  sha256: string;
  schema_version: number;
  app_version: string;
  compatible: boolean;
};

export type GoogleDriveDestination = {
  id: string;
  name: string;
  current: boolean;
};

export type MasterPinStatus = {
  available: boolean;
  isSet: boolean;
  schemaVersion: number | null;
};

export type ImportPayload = { app: string; schema_version?: string; data: Record<string, unknown[]> };

export type PinGate =
  | { mode: 'set' }
  | { mode: 'backup' }
  | { mode: 'backup-custom' }
  | { mode: 'import'; payload: { data: ImportPayload; overwrite: boolean } }
  | { mode: 'restore'; payload: { backupPath: string } }
  | { mode: 'restore-google-drive'; payload: { fileId: string; sha256: string } }
  | { mode: 'delete-backup'; payload: { fileName: string } }
  | { mode: 'delete-cloud' }
  | { mode: 'cancel-cloud-deletion' }
  | null;

export interface DatabaseSettingsTabProps {
  isOwner: boolean;
  masterPinStatus: MasterPinStatus;
  backups: BackupInfo[];
  backupsLoading: boolean;
  googleDriveStatus: GoogleDriveStatus;
  googleDriveDestinations: GoogleDriveDestination[];
  googleDriveDestinationsLoading: boolean;
  remoteBackups: GoogleDriveRemoteBackup[];
  remoteBackupsLoading: boolean;
  setGoogleDriveStatus: React.Dispatch<React.SetStateAction<GoogleDriveStatus>>;
  connectingGoogleDrive: boolean;
  disconnectingGoogleDrive: boolean;
  savingGoogleDrivePrefs: boolean;
  managingGoogleDriveDestination: boolean;
  backingUpGoogleDrive: boolean;
  onFetchBackups: () => void;
  onCreateBackup: () => void;
  onChooseBackupLocation: () => void;
  onRestoreFromHistory: (backup: BackupInfo) => void;
  onDeleteBackup: (backup: BackupInfo) => void;
  onConnectGoogleDrive: () => void;
  onDisconnectGoogleDrive: () => void;
  onCreateGoogleDriveDestination: () => void;
  onSelectGoogleDriveDestination: (folderId: string) => void;
  onUpdateGoogleDrivePrefs: (prefs: { frequency?: 'daily' | 'weekly'; retention_count?: number }) => void;
  onBackupToGoogleDriveNow: () => void;
  onFetchRemoteBackups: () => void;
  onRestoreRemoteBackup: (backup: GoogleDriveRemoteBackup) => void;
  onRunImport: (data: ImportPayload, overwrite: boolean) => Promise<{ success: boolean; error?: string }>;
  onRequestPinGate: (gate: PinGate) => void;
  onRunHealthCheck: () => void;
  onRequestInitializeDb: () => void;
  confirm: (message: string, options?: { title?: string; confirmLabel?: string; destructive?: boolean }) => Promise<boolean>;
}

function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DatabaseSettingsTab({
  isOwner,
  masterPinStatus,
  backups,
  backupsLoading,
  googleDriveStatus,
  googleDriveDestinations,
  googleDriveDestinationsLoading,
  remoteBackups,
  remoteBackupsLoading,
  setGoogleDriveStatus,
  connectingGoogleDrive,
  disconnectingGoogleDrive,
  savingGoogleDrivePrefs,
  managingGoogleDriveDestination,
  backingUpGoogleDrive,
  onFetchBackups,
  onCreateBackup,
  onChooseBackupLocation,
  onRestoreFromHistory,
  onDeleteBackup,
  onConnectGoogleDrive,
  onDisconnectGoogleDrive,
  onCreateGoogleDriveDestination,
  onSelectGoogleDriveDestination,
  onUpdateGoogleDrivePrefs,
  onBackupToGoogleDriveNow,
  onFetchRemoteBackups,
  onRestoreRemoteBackup,
  onRunImport,
  onRequestPinGate,
  onRunHealthCheck,
  onRequestInitializeDb,
  confirm,
}: DatabaseSettingsTabProps) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const { formatDateTime } = useFormatDate();
  const googleDriveJobActive = ['queued', 'snapshot_created', 'uploading', 'restoring'].includes(googleDriveStatus.job?.state || '');
  const googleDriveRevokePending = googleDriveStatus.revoke_status === 'unconfirmed';

  const [tableInfoOpen, setTableInfoOpen] = useState(false);
  const [tableInfo, setTableInfo] = useState<Array<{ name: string; rows: number }>>([]);

  return (
    <SettingsTabShell title={t('tabBackupData')}>
        {/* Database Export */}
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <FileText size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('exportDatabase')}</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t('exportDatabaseHint')}
          </p>
          <button
            onClick={async () => {
              try {
                const response = await api.get('/db/export', { responseType: 'blob' });
                const blob = new Blob([response.data], { type: 'application/json' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `flo-export-${new Date().toISOString().split('T')[0]}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                toast.success(t('databaseExported'));
              } catch {
                toast.error(t('exportFailed'));
              }
            }}
            className="px-5 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium"
          >
            {t('exportToJson')}
          </button>
        </div>

        {/* Database Backup */}
        <div className="bg-card rounded-xl border border-blue-100 bg-blue-50/30 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Database size={20} className="text-blue-600" />
            <h2 className="font-semibold text-foreground">{t('createBackup')}</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t('createBackupHint')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onCreateBackup}
              className="px-5 py-2 text-sm bg-gray-600 text-white rounded-lg hover:opacity-90 font-medium"
            >
              {t('createBackup')}
            </button>
            <button
              onClick={onChooseBackupLocation}
              className="px-5 py-2 text-sm bg-muted text-foreground rounded-lg hover:bg-muted font-medium"
            >
              {t('chooseBackupLocation')}
            </button>
          </div>
        </div>

        {/* Backup History */}
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Database size={20} className="text-muted-foreground" />
              <h2 className="font-semibold text-foreground">{t('backupHistory')}</h2>
            </div>
            <button
              onClick={onFetchBackups}
              disabled={backupsLoading}
              className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted disabled:opacity-50"
              title={t('refresh')}
            >
              <RefreshCw size={16} className={backupsLoading ? 'animate-spin' : ''} />
            </button>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t('backupHistoryHint')}
          </p>
          {backups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {backupsLoading ? tCommon('loading') : t('backupHistoryEmpty')}
            </p>
          ) : (
            <div className="divide-y divide-border">
              {backups.map((backup) => (
                <div key={backup.path} className="flex items-center justify-between py-3 gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{formatDateTime(backup.createdAt)}</span>
                      {backup.kind === 'auto' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100">
                          {t('backupKindAuto')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {formatBackupSize(backup.sizeBytes)}
                      {backup.schemaVersion != null && ` · ${t('backupSchemaVersion', { version: backup.schemaVersion })}`}
                    </p>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      onClick={() => onRestoreFromHistory(backup)}
                      className="px-3 py-1.5 text-xs bg-muted text-foreground rounded-lg hover:bg-muted font-medium"
                    >
                      {t('restoreBackup')}
                    </button>
                    <button
                      onClick={() => onDeleteBackup(backup)}
                      className="p-1.5 text-muted-foreground hover:text-red-600 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/40"
                      title={t('deleteBackup')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Google Drive - automated off-device backups */}
        {isOwner && <div className="bg-card rounded-xl border border-border p-6 space-y-4">
          <div className="flex items-center gap-2">
            <HardDrive size={20} className="text-muted-foreground" />
            <div>
              <h2 className="font-semibold text-foreground">{t('googleDrive')}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t('googleDriveHint')}</p>
            </div>
          </div>

          {!googleDriveStatus.configured ? (
            <div className="bg-muted rounded-xl p-6 flex flex-col items-center justify-center text-center space-y-2">
              <div className="p-3 bg-card rounded-full shadow-sm">
                <HardDrive className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">{t('googleDriveNotConfigured')}</p>
              <p className="text-xs text-muted-foreground max-w-sm">{t('googleDriveNotConfiguredHint')}</p>
            </div>
          ) : !googleDriveStatus.secure_storage_available ? (
            <div className="flex items-center gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-800/40 rounded-lg px-4 py-3">
              <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-sm text-amber-800 dark:text-amber-300">{t('googleDriveSecureStorageUnavailable')}</p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 rounded-lg px-4 py-3">
                <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                <p className="text-sm text-amber-900 dark:text-amber-200">{t('googleDriveUnencryptedWarning')}</p>
              </div>
              <div className="rounded-lg border border-border px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  {googleDriveStatus.connected ? (
                    <CheckCircle2 size={16} className="text-green-600 shrink-0" />
                  ) : (
                    <CloudOff size={16} className="text-muted-foreground shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {googleDriveStatus.connected ? t('googleDriveConnected') : t('googleDriveNotConnected')}
                    </p>
                    {googleDriveStatus.connected && googleDriveStatus.account_email && (
                      <p className="text-xs text-muted-foreground">{t('googleDriveAccount')}: <Ltr>{googleDriveStatus.account_email}</Ltr></p>
                    )}
                  </div>
                </div>
                {isOwner && (
                  googleDriveStatus.connected || googleDriveRevokePending ? (
                    <button
                      onClick={onDisconnectGoogleDrive}
                      disabled={disconnectingGoogleDrive}
                      className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 font-medium shrink-0"
                    >
                      {disconnectingGoogleDrive ? t('googleDriveDisconnecting') : googleDriveRevokePending ? t('googleDriveRetryDisconnect') : t('googleDriveDisconnect')}
                    </button>
                  ) : (
                    <button
                      onClick={onConnectGoogleDrive}
                      disabled={connectingGoogleDrive}
                      className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium shrink-0"
                    >
                      {connectingGoogleDrive ? t('googleDriveConnecting') : googleDriveStatus.auth_state === 'reauth_required' ? t('googleDriveReauthenticate') : t('googleDriveConnect')}
                    </button>
                  )
                )}
              </div>

              {googleDriveRevokePending && (
                <p className="text-xs text-red-600">{t('googleDriveRevokePending')}</p>
              )}

              {googleDriveStatus.connected && (
                <>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">{t('googleDriveFrequency')}</label>
                      <select
                        value={googleDriveStatus.frequency}
                        disabled={savingGoogleDrivePrefs}
                        onChange={(e) => onUpdateGoogleDrivePrefs({ frequency: e.target.value as 'daily' | 'weekly' })}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg text-sm focus:ring-2 focus:ring-brand outline-none disabled:opacity-50"
                      >
                        <option value="daily">{t('googleDriveFrequencyDaily')}</option>
                        <option value="weekly">{t('googleDriveFrequencyWeekly')}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">{t('googleDriveRetention')}</label>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={googleDriveStatus.retention_count}
                        disabled={savingGoogleDrivePrefs}
                        onChange={(e) => setGoogleDriveStatus((prev) => ({ ...prev, retention_count: Number(e.target.value) || prev.retention_count }))}
                        onBlur={(e) => {
                          const n = Number(e.target.value);
                          if (Number.isInteger(n) && n >= 1 && n <= 100) onUpdateGoogleDrivePrefs({ retention_count: n });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg text-sm focus:ring-2 focus:ring-brand outline-none disabled:opacity-50"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('googleDriveRetentionHint')}</p>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-foreground mb-1">{t('googleDriveDestination')}</label>
                    <div className="flex items-center gap-2">
                      <select
                        value={googleDriveStatus.destination_folder_id || ''}
                        disabled={googleDriveDestinationsLoading || managingGoogleDriveDestination || googleDriveDestinations.length === 0}
                        onChange={(e) => onSelectGoogleDriveDestination(e.target.value)}
                        className="min-w-0 flex-1 px-3 py-2 border border-gray-300 dark:border-border rounded-lg text-sm focus:ring-2 focus:ring-brand outline-none disabled:opacity-50"
                      >
                        {!googleDriveStatus.destination_folder_id && <option value="" disabled>{t('googleDriveDestination')}</option>}
                        {googleDriveStatus.destination_folder_id && !googleDriveDestinations.some((destination) => destination.id === googleDriveStatus.destination_folder_id) && (
                          <option value={googleDriveStatus.destination_folder_id}>{googleDriveStatus.destination_folder_name || googleDriveStatus.destination_folder_id}</option>
                        )}
                        {googleDriveDestinations.map((destination) => <option key={destination.id} value={destination.id}>{destination.name}</option>)}
                      </select>
                      <button
                        onClick={onCreateGoogleDriveDestination}
                        disabled={googleDriveDestinationsLoading || managingGoogleDriveDestination}
                        className="px-3 py-2 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 whitespace-nowrap"
                      >
                        {t('googleDriveCreateDestination')}
                      </button>
                    </div>
                  </div>
                  {googleDriveStatus.last_error && (
                    <p className="text-xs text-red-600">{t('googleDriveLastError', { code: googleDriveStatus.last_error })}</p>
                  )}
                  {googleDriveStatus.job && (
                    <p className="text-xs text-muted-foreground">
                      {googleDriveStatus.job.state === 'offline_pending'
                        ? t('googleDriveBackupRetryPending')
                        : googleDriveStatus.job.state === 'retention_pending'
                          ? t('googleDriveRetentionPending')
                          : t('googleDriveJobStatus', { state: googleDriveStatus.job.state })}
                    </p>
                  )}

                  <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
                    <div className="text-xs text-muted-foreground">
                      {googleDriveStatus.last_backup_at ? (
                        googleDriveStatus.last_backup_status === 'error' ? (
                          <span className="flex items-center gap-1 text-red-600">
                            <AlertTriangle size={13} />
                            {t('googleDriveLastBackupErrorAt', { time: formatDateTime(googleDriveStatus.last_backup_at) })}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <CheckCircle2 size={13} className="text-green-600" />
                            {t('googleDriveLastBackupSuccessAt', { time: formatDateTime(googleDriveStatus.last_backup_at) })}
                          </span>
                        )
                      ) : (
                        <span>{t('googleDriveLastBackup')}: {t('googleDriveLastBackupNever')}</span>
                      )}
                    </div>
                    {isOwner && (
                      <button
                        onClick={onBackupToGoogleDriveNow}
                        disabled={backingUpGoogleDrive}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium shrink-0"
                      >
                        <UploadCloud size={15} />
                        {backingUpGoogleDrive ? t('googleDriveBackingUp') : t('googleDriveBackupNow')}
                      </button>
                    )}
                  </div>
                  <div className="border-t border-border pt-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-foreground">{t('googleDriveRemoteHistory')}</p>
                      <button onClick={onFetchRemoteBackups} disabled={remoteBackupsLoading} className="text-xs px-3 py-1.5 border border-border rounded-lg hover:bg-muted disabled:opacity-50">
                        {remoteBackupsLoading ? t('googleDriveLoadingRemoteHistory') : t('googleDriveRefreshRemoteHistory')}
                      </button>
                    </div>
                    {remoteBackups.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t('googleDriveNoRemoteBackups')}</p>
                    ) : remoteBackups.map((backup) => (
                      <div key={backup.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground">
                              {backup.created_at ? formatDateTime(backup.created_at) : backup.name}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              {backup.kind === 'automatic' ? t('googleDriveAutomaticBadge') : t('googleDriveManualBadge')}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            <span className="font-mono text-[11px]">{backup.name}</span> · {backup.app_version} · {formatBackupSize(backup.bytes)}
                          </p>
                        </div>
                        <button onClick={() => onRestoreRemoteBackup(backup)} disabled={!backup.compatible || googleDriveJobActive} className="px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-muted disabled:opacity-50 shrink-0">
                          {t('googleDriveRestore')}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>}

        {/* Database Import */}
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <FileText size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('importDatabase')}</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t('importDatabaseHint')}
          </p>
          <input
            type="file"
            accept=".json"
            id="import-file"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;

              const reader = new FileReader();
              reader.onload = async (event) => {
                try {
                  const data = JSON.parse(event.target?.result as string) as ImportPayload;
                  if (!data.app || data.app !== 'FloDesktop') {
                    toast.error(t('invalidExportFile'));
                    return;
                  }

                  const overwrite = await confirm(t('importOverwriteConfirm'), { confirmLabel: t('replaceAll') });

                  const rawImportVersion = String(data.schema_version ?? '');
                  const importVersion = /^(?:0|[1-9]\d*)$/.test(rawImportVersion) ? Number(rawImportVersion) : null;
                  const schemaMismatch = masterPinStatus.schemaVersion != null
                    && (importVersion === null || importVersion !== masterPinStatus.schemaVersion);
                  const destructive = overwrite || schemaMismatch;

                  if (destructive && masterPinStatus.available) {
                    if (!masterPinStatus.isSet) {
                      toast.error(t('masterPinRequiredForReplace'));
                      return;
                    }
                    onRequestPinGate({ mode: 'import', payload: { data, overwrite } });
                    return;
                  }

                  await onRunImport(data, overwrite);
                } catch {
                  toast.error(t('importFailed'));
                }
              };
              reader.readAsText(file);
              e.target.value = '';
            }}
          />
          <div className="flex gap-2">
            <label
              htmlFor="import-file"
              className="px-5 py-2 text-sm bg-muted text-foreground rounded-lg hover:bg-muted cursor-pointer font-medium"
            >
              {t('selectFileAndImport')}
            </label>
          </div>
        </div>

        {/* Database Info */}
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <Database size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('databaseInformation')}</h2>
          </div>
          <button
            onClick={async () => {
              try {
                const response = await api.get('/db/tables');
                const { tables } = response.data;
                setTableInfo(tables);
                setTableInfoOpen(true);
              } catch {
                toast.error(t('tableInfoFailed'));
              }
            }}
            className="px-5 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium"
          >
            {t('viewTableInfo')}
          </button>
        </div>

        {/* Database Health Check */}
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <Wrench size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('databaseHealthCheck')}</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t('databaseHealthCheckDescription')}
          </p>
          <button
            onClick={onRunHealthCheck}
            className="px-5 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium"
          >
            {t('databaseHealthCheck')}
          </button>
        </div>

        {/* Master PIN */}
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 mb-4">
            <KeyRound size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('masterPin')}</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t('masterPinDataDescription')}
          </p>
          {!masterPinStatus.available ? (
            <p className="text-sm text-amber-600">{t('notAvailableOnDevice')}</p>
          ) : (
            <div className="flex items-center gap-3">
              <span className={`text-sm font-medium ${masterPinStatus.isSet ? 'text-green-600' : 'text-amber-600'}`}>
                {masterPinStatus.isSet ? t('masterPinStatusSet') : t('masterPinStatusNotSet')}
              </span>
              <button
                onClick={() => onRequestPinGate({ mode: 'set' })}
                className="px-5 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium"
              >
                {masterPinStatus.isSet ? t('masterPinChangeButton') : t('masterPinSetButton')}
              </button>
            </div>
          )}
        </div>

        {/* Danger Zone: Initialize Database */}
        <div className="bg-card rounded-xl border border-red-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle size={20} className="text-red-600" />
            <h2 className="font-semibold text-red-600">{t('initializeDatabase')}</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {t('initializeDatabaseDescription')}
          </p>
          <button
            onClick={onRequestInitializeDb}
            className="px-5 py-2 text-sm bg-red-600 text-white rounded-lg hover:opacity-90 font-medium"
          >
            {t('initializeDatabaseButton')}
          </button>
        </div>

      {/* Table Info Dialog */}
      <Dialog open={tableInfoOpen} onOpenChange={setTableInfoOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('databaseTables')}</DialogTitle>
            <DialogDescription>{t('rowCountsForAll')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-60 overflow-y-auto space-y-1.5">
            {tableInfo.map((row) => (
              <div key={row.name} className="flex justify-between text-sm">
                <span className="text-foreground font-mono">{row.name}</span>
                <span className="text-muted-foreground">{row.rows.toLocaleString()} {t('rows')}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTableInfoOpen(false)}>{t('close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsTabShell>
  );
}
