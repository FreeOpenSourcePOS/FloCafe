'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore, type PaperSize, type BillTemplate } from '@/store/pos-settings';
import type { Language } from '@/lib/i18n';
import { usePrinterStore, usePrinterStatusSync } from '@/hooks/usePrinter';
import { Settings, Building2, CreditCard, Monitor, Users, Gift, Printer, Share2, FileText, Lock, Smartphone, RefreshCw, Copy, Check, Wifi, Usb, Trash2, Plus, Star, TestTube2, ChefHat, QrCode, CheckCircle2, Database, Cloud, CloudOff, Zap, Percent, KeyRound, AlertTriangle, Wrench, HardDrive, UploadCloud, Hash, ChevronDown } from 'lucide-react';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { COUNTRIES, countryName, getCountryByCode, type CurrencyDisplay, type DigitMode, type CalendarMode } from '@/lib/countries';
import { dialCodeFor, normalizeOptionalPhone } from '@/lib/phone';
import { useConfirm } from '@/hooks/use-confirm';
import { MasterPinPrompt } from '@/components/settings/MasterPinPrompt';
import { HealthCheckDialog } from '@/components/settings/HealthCheckDialog';
import { InitializeDatabaseDialog } from '@/components/settings/InitializeDatabaseDialog';
import { WhatsAppEnableCard } from '@/components/settings/WhatsAppEnableCard';
import { TaxConfigurationPanel } from '@/components/settings/TaxConfigurationPanel';
import { PaymentMethodsSettings } from '@/components/settings/PaymentMethodsSettings';
import { LocalePreferencesPanel } from '@/components/settings/LocalePreferencesPanel';
import type { HealthCheckReport } from '@/types/electron';
import { useI18n } from '@/hooks/useI18n';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { TENANT_STATUS_LABEL_KEYS } from '@/lib/i18n-enums';

const CLOUD_ACCOUNT_STATUS_CHANGED_EVENT = 'flo:cloud-account-status-changed';

function notifyCloudAccountStatusChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CLOUD_ACCOUNT_STATUS_CHANGED_EVENT));
}

const CLASSIC_PREVIEW = `   STORE NAME
   Jane Doe
  +91 98765...
---------------
Invoice #: B-1
 1 Jan, 12:30pm
---------------
Item      Qty Amt
---------------
Burger      1   99
  + Sauce        9
---------------
Discount       -5
Subtotal      103
TOTAL         109
Cash          109
---------------
Points Earned  10
Pts Balance   210
---------------
  123 Main St
  Ph: 98765...`;

const COMPACT_PREVIEW = `  STORE NAME
-----------
Bill #1    12:30
-----------
Burger           99
  2 x 49.50
-----------
TOTAL            99
Cash             99
-----------
  Thank you!`;

function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TemplateCard {
  id: BillTemplate;
  nameKey?: string;
  displayName?: string;
  preview: string;
  source: 'core' | 'plugin';
  description?: string;
}

const TEMPLATE_CARDS: TemplateCard[] = [
  { id: 'classic', nameKey: 'settings.billTemplateClassicName', preview: CLASSIC_PREVIEW, source: 'core' },
  { id: 'compact', nameKey: 'settings.billTemplateCompactName', preview: COMPACT_PREVIEW, source: 'core' },
];

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${value ? 'bg-brand' : 'bg-gray-300'}`}
    >
      {/* start-0.5 + rtl:-translate-x-5 keeps the knob at the inline-start and slides it toward the inline-end in both directions. */}
      <span className={`absolute top-0.5 start-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

type InvoiceResetPeriod = 'never' | 'daily' | 'monthly' | 'financial_year';

function invoicePreviewSegment(period: InvoiceResetPeriod, month: number, day: number): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  if (period === 'monthly') return `${yyyy}${mm}`;
  if (period === 'financial_year') {
    const startsThisYear = now.getMonth() + 1 > month || (now.getMonth() + 1 === month && now.getDate() >= day);
    const startYear = startsThisYear ? yyyy : yyyy - 1;
    return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }
  return `${yyyy}${mm}${dd}`;
}

function SettingsNavItem({
  label, value, active, onClick, indent, attention,
}: {
  label: string;
  value: string;
  active: string;
  onClick: (v: string) => void;
  indent?: boolean;
  attention?: boolean;
}) {
  const isActive = active === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={[
        'flex items-center w-full min-w-0 text-start text-sm rounded-md py-1.5 transition-colors',
        indent ? 'ps-5 pe-2 border-s-2 ms-1 text-xs md:ms-0' : 'px-3',
        isActive
          ? 'bg-brand/10 text-brand font-semibold' + (indent ? ' border-brand' : '')
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900' + (indent ? ' border-transparent' : ''),
      ].join(' ')}
    >
      <span className="min-w-0 truncate">{label}</span>
      {attention && <span className="ms-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white" aria-label="Action required">1</span>}
    </button>
  );
}

function KdsDefaultViewCard() {
  const { t } = useI18n();
  const [view, setView] = useState<'tabs' | 'kanban'>('tabs');
  const [savedView, setSavedView] = useState<'tabs' | 'kanban'>('tabs');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/settings/kds').then((res) => {
      const v = res.data?.kds_default_view === 'kanban' ? 'kanban' : 'tabs';
      setView(v);
      setSavedView(v);
    }).catch(() => {});
  }, []);

  const dirty = view !== savedView;

  async function save() {
    setSaving(true);
    try {
      const { data } = await api.put('/settings/kds', { kds_default_view: view });
      const next = data?.kds_default_view === 'kanban' ? 'kanban' : 'tabs';
      setSavedView(next);
      setView(next);
      toast.success(t('settings.kdsViewSaved'));
    } catch {
      toast.error(t('settings.kdsViewSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Monitor size={20} className="text-gray-500" />
        <h2 className="font-semibold text-gray-900">{t('settings.kdsDefaultView')}</h2>
      </div>
      <p className="text-sm text-gray-500 mb-5">{t('settings.kdsDefaultViewHint')}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setView('tabs')}
          className={`text-start rounded-lg border-2 px-4 py-3 transition ${
            view === 'tabs'
              ? 'border-brand bg-brand/5'
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <input type="radio" readOnly checked={view === 'tabs'} className="text-brand" />
            <span className="font-medium text-gray-900">{t('settings.kdsDefaultViewTabs')}</span>
          </div>
          <p className="text-xs text-gray-500 ms-6">{t('settings.kdsDefaultViewTabsHint')}</p>
        </button>
        <button
          type="button"
          onClick={() => setView('kanban')}
          className={`text-start rounded-lg border-2 px-4 py-3 transition ${
            view === 'kanban'
              ? 'border-brand bg-brand/5'
              : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <input type="radio" readOnly checked={view === 'kanban'} className="text-brand" />
            <span className="font-medium text-gray-900">{t('settings.kdsDefaultViewKanban')}</span>
          </div>
          <p className="text-xs text-gray-500 ms-6">{t('settings.kdsDefaultViewKanbanHint')}</p>
        </button>
      </div>

      <div className="flex justify-end mt-5 pt-4 border-t border-gray-100">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium text-sm"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}


export default function SettingsPage() {
  const { currentTenant, user, updateCurrentTenant } = useAuthStore();
  const posSettings = usePosSettingsStore();
  const whatsappEnabled = posSettings.whatsappEnabled;
  const { printMethod, setPrintMethod, refreshHardwarePrinter } = usePrinterStore();
  usePrinterStatusSync();
  const { t, language, setLanguage } = useI18n();
  const { formatDate, formatTime, formatDateTime } = useFormatDate();
  const isAdmin = currentTenant?.role === 'admin' || currentTenant?.role === 'owner';
  const canViewTaxConfiguration = currentTenant?.role === 'owner' || currentTenant?.role === 'manager';
  const { confirm, ConfirmDialog } = useConfirm();

  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [savedLoyaltyEnabled, setSavedLoyaltyEnabled] = useState(false);
  const [globalCashbackPercent, setGlobalCashbackPercent] = useState('0');
  const [savedGlobalCashbackPercent, setSavedGlobalCashbackPercent] = useState('0');
  const [globalRateCandidates, setGlobalRateCandidates] = useState(0);
  const [applyingGlobalRate, setApplyingGlobalRate] = useState(false);
  const [savingLoyalty, setSavingLoyalty] = useState(false);

  // Discount settings
  const normalizeDiscountPercentage = (value: unknown) => Math.min(100, Math.max(1, Number(value) || 25));
  const normalizeDiscountAmount = (value: unknown) => Math.min(999999, Math.max(0, Number(value) || 0));
  const [discountMaxPct, setDiscountMaxPct] = useState(25);
  const [savedDiscountMaxPct, setSavedDiscountMaxPct] = useState(25);
  const [discountMaxAmount, setDiscountMaxAmount] = useState(0);
  const [savedDiscountMaxAmount, setSavedDiscountMaxAmount] = useState(0);
  const [discountMode, setDiscountMode] = useState('percentage');
  const [savedDiscountMode, setSavedDiscountMode] = useState('percentage');
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [savedDiscountRequiresApproval, setSavedDiscountRequiresApproval] = useState(false);
  const [savingDiscount, setSavingDiscount] = useState(false);

  // Table info dialog
  const [tableInfoOpen, setTableInfoOpen] = useState(false);
  const [tableInfo, setTableInfo] = useState<{ name: string; rows: number }[]>([]);

  const searchParams = useSearchParams();
  // ── DB tools: master PIN, health check, initialize ──────────────────────
  // activeTab/healthCheckOpen/initializeDbOpen/pinGate all read their initial value from the
  // ?tab=/?action= deep-link params directly (lazy init, once at mount) instead of being set
  // by the mount effect below — that effect now only owns the actual async fetches.
  const [activeTab, setActiveTab] = useState(() => searchParams?.get('tab') || 'store');
  const [masterPinStatus, setMasterPinStatus] = useState<{ available: boolean; isSet: boolean; schemaVersion: number | null }>({ available: false, isSet: false, schemaVersion: null });
  const [healthCheckOpen, setHealthCheckOpen] = useState(() => searchParams?.get('action') === 'health-check');
  const [healthReport, setHealthReport] = useState<HealthCheckReport | null>(null);
  const [applyingFixes, setApplyingFixes] = useState(false);
  const [initializeDbOpen, setInitializeDbOpen] = useState(() => searchParams?.get('action') === 'initialize-db');
  const [shakeSaveBar, setShakeSaveBar] = useState(false);

  // Unified PIN gate: 'set' opens the set/change-PIN dialog; 'backup'/'backup-custom'/
  // 'import'/'restore' open a verify prompt and, on success, run the pending action.
  type ImportPayload = { app: string; schema_version?: string; data: Record<string, unknown[]> };
  type BackupInfo = { fileName: string; path: string; sizeBytes: number; createdAt: string; kind: 'manual' | 'auto'; schemaVersion: number | null };
  type PinGate =
    | { mode: 'set' }
    | { mode: 'backup' }
    | { mode: 'backup-custom' }
    | { mode: 'import'; payload: { data: ImportPayload; overwrite: boolean } }
    | { mode: 'restore'; payload: { backupPath: string } }
    | { mode: 'delete-backup'; payload: { fileName: string } }
    | { mode: 'delete-cloud' }
    | { mode: 'cancel-cloud-deletion' }
    | null;
  const [pinGate, setPinGate] = useState<PinGate>(() => searchParams?.get('action') === 'master-pin' ? { mode: 'set' } : null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  // The mount effect below always fetches backups unconditionally, so this starts true
  // rather than being set synchronously inside that effect.
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [cloudAccount, setCloudAccount] = useState<{ email?: string | null; cloud_account_available?: boolean; verified?: boolean; verified_at?: string | null; verification_sent_at?: string | null; product_updates?: boolean; marketing?: boolean; deletion_request?: { id?: string; status?: 'pending' | 'processing' | 'approved' | 'completed' | 'deleted' | 'failed' | 'rejected' | 'cancelled'; requested_at?: string; reviewed_at?: string | null; decision_note?: string | null } | null } | null>(null);
  const [cloudAccountBusy, setCloudAccountBusy] = useState(false);
  const [cloudAccountLoadFailed, setCloudAccountLoadFailed] = useState(false);
  const [refreshingDeletionStatus, setRefreshingDeletionStatus] = useState(false);
  const cloudAccountAvailable = !cloudAccountLoadFailed && cloudAccount?.cloud_account_available !== false;
  const cloudDeletionStatus = cloudAccount?.deletion_request?.status || '';
  const cloudDeletionPending = cloudDeletionStatus === 'pending';
  const cloudDeletionNeedsResolution = ['pending', 'processing', 'failed'].includes(cloudDeletionStatus);
  const cloudDeletionCanCancel = ['pending', 'processing'].includes(cloudDeletionStatus) && Boolean(cloudAccount?.deletion_request?.id);

  const fetchCloudAccount = async () => {
    try {
      const { data } = await api.get('/settings/cloud/account');
      setCloudAccount(data);
      setCloudAccountLoadFailed(false);
    } catch {
      setCloudAccountLoadFailed(true);
    }
  };

  const fetchMasterPinStatus = async () => {
    try {
      const { data } = await api.get('/db-tools/master-pin/status');
      setMasterPinStatus(data);
    } catch {
      // ignore — card just shows "Unknown" state until retried
    }
  };

  const fetchBackups = async () => {
    setBackupsLoading(true);
    try {
      const { data } = await api.get('/db-tools/backups');
      setBackups(data.backups ?? []);
    } catch {
      // ignore — history card just shows empty state until retried
    } finally {
      setBackupsLoading(false);
    }
  };

  const runHealthCheck = async () => {
    setHealthCheckOpen(true);
    try {
      const { data } = await api.get('/db-tools/health-check');
      setHealthReport(data);
    } catch {
      toast.error(t('settings.healthCheckFailed'));
      setHealthCheckOpen(false);
    }
  };

  useEffect(() => {
    api.get('/db-tools/master-pin/status')
      .then(({ data }) => setMasterPinStatus(data))
      .catch(() => {
        // ignore — card just shows "Unknown" state until retried
      });

    api.get('/db-tools/backups')
      .then(({ data }) => setBackups(data.backups ?? []))
      .catch(() => {
        // ignore — history card just shows empty state until retried
      })
      .finally(() => setBackupsLoading(false));
    if (currentTenant?.role === 'owner') {
      api.get('/settings/cloud/account')
        .then(({ data }) => {
          setCloudAccount(data);
          setCloudAccountLoadFailed(false);
        })
        .catch(() => setCloudAccountLoadFailed(true));
    }

    if (searchParams?.get('action') === 'health-check') {
      api.get('/db-tools/health-check')
        .then(({ data }) => setHealthReport(data))
        .catch(() => {
          toast.error(t('settings.healthCheckFailed'));
          setHealthCheckOpen(false);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySafeFixes = async () => {
    setApplyingFixes(true);
    try {
      const { data } = await api.post('/db-tools/apply-safe-fixes', {});
      if (data.errors?.length) {
        toast.error(t('settings.fixesAppliedPartial', { applied: data.applied.length, failed: data.errors.length }));
      } else {
        toast.success(t('settings.fixesApplied', { count: data.applied.length }));
      }
      await runHealthCheck();
    } catch {
      toast.error(t('settings.applyingFixesFailed'));
    } finally {
      setApplyingFixes(false);
    }
  };

  const runImport = async (data: ImportPayload, overwrite: boolean, master_pin?: string) => {
    try {
      const response = await api.post('/db/import', { data, overwrite, master_pin });
      if (response.data.success) toast.success(t('settings.importSuccess'));
      return { success: true };
    } catch {
      const message = t('settings.importFailed');
      toast.error(message);
      return { success: false, error: message };
    }
  };

  const handlePinGateSubmit = async (pin: string): Promise<{ success: boolean; error?: string }> => {
    if (!pinGate) return { success: false, error: t('settings.nothingPending') };

    if (pinGate.mode === 'set') {
      try {
        await api.post('/db-tools/master-pin/reset', { pin, confirm_pin: pin });
        await fetchMasterPinStatus();
        toast.success(t('settings.masterPinSaved'));
        setPinGate(null);
        return { success: true };
      } catch {
        return { success: false, error: t('settings.savePinFailed') };
      }
    }

    if (pinGate.mode === 'backup') {
      try {
        const response = await api.post('/db/backup', { master_pin: pin });
        toast.success(`${t('settings.backupCreated')} ${response.data.path}`, { duration: 5000 });
        setPinGate(null);
        fetchBackups();
        return { success: true };
      } catch {
        return { success: false, error: t('settings.backupFailedGeneric') };
      }
    }

    if (pinGate.mode === 'backup-custom') {
      if (!window.electronAPI?.backupDatabase) {
        return { success: false, error: t('common.notAvailable') };
      }
      const result = await window.electronAPI.backupDatabase(pin);
      if (result.success) {
        toast.success(`${t('settings.backupCreated')} ${result.path}`, { duration: 5000 });
        setPinGate(null);
        return { success: true };
      }
      if (result.error === 'Cancelled') {
        setPinGate(null);
        return { success: true };
      }
      return { success: false, error: result.error || t('settings.backupFailedGeneric') };
    }

    if (pinGate.mode === 'restore') {
      if (!window.electronAPI?.restoreBackup) {
        return { success: false, error: t('common.notAvailable') };
      }
      const result = await window.electronAPI.restoreBackup(pin, pinGate.payload.backupPath);
      if (result.success) {
        toast.success(t('restore.success'));
        setPinGate(null);
        setTimeout(() => window.location.reload(), 1500);
        return { success: true };
      }
      if (result.error === 'Cancelled') {
        setPinGate(null);
        return { success: true };
      }
      return { success: false, error: result.error || t('settings.restoreFailedGeneric') };
    }

    if (pinGate.mode === 'delete-backup') {
      try {
        await api.post(`/db-tools/backups/${encodeURIComponent(pinGate.payload.fileName)}/delete`, { master_pin: pin });
        toast.success(t('settings.backupDeleted'));
        setPinGate(null);
        fetchBackups();
        return { success: true };
      } catch {
        return { success: false, error: t('settings.backupDeleteFailed') };
      }
    }

    if (pinGate.mode === 'delete-cloud') {
      try {
        await api.post('/settings/cloud/delete-data', { master_pin: pin, confirmation: 'DELETE CLOUD DATA' });
        toast.success(t('settings.cloudDeletionSubmitted'));
        await Promise.all([fetchCloudAccount(), refreshCloudStatus()]);
        notifyCloudAccountStatusChanged();
        setPinGate(null);
        return { success: true };
      } catch {
        await Promise.all([fetchCloudAccount(), refreshCloudStatus()]);
        notifyCloudAccountStatusChanged();
        return { success: false, error: t('settings.cloudDeletionFailed') };
      }
    }

    if (pinGate.mode === 'cancel-cloud-deletion') {
      try {
        await api.post('/settings/cloud/delete-data/cancel', { master_pin: pin });
        toast.success(t('settings.cloudDeletionCancelled'));
        await Promise.all([fetchCloudAccount(), refreshCloudStatus()]);
        notifyCloudAccountStatusChanged();
        setPinGate(null);
        return { success: true };
      } catch {
        return { success: false, error: t('settings.cloudDeletionCancelFailed') };
      }
    }

    // mode === 'import'
    const result = await runImport(pinGate.payload.data, pinGate.payload.overwrite, pin);
    if (result.success) setPinGate(null);
    return result;
  };

  const handleCreateBackup = async () => {
    if (masterPinStatus.available && !masterPinStatus.isSet) {
      toast.error(t('settings.masterPinRequiredForBackup'));
      return;
    }
    if (!masterPinStatus.available) {
      try {
        const response = await api.post('/db/backup', {});
        toast.success(`${t('settings.backupCreated')} ${response.data.path}`, { duration: 5000 });
      } catch {
        toast.error(t('settings.backupFailed'));
      }
      return;
    }
    setPinGate({ mode: 'backup' });
  };

  // Lets the owner pick a custom save location (external drive, cloud-synced
  // folder, etc.) via the same native save dialog the File menu's "Export
  // Backup" action already uses. A backup saved this way does not appear in
  // the Backup History list below — same as it never has for the menu
  // action — since it's outside the managed backups/ directory. See #120.
  const handleChooseBackupLocation = async () => {
    if (masterPinStatus.available && !masterPinStatus.isSet) {
      toast.error(t('settings.masterPinRequiredForBackup'));
      return;
    }
    if (!masterPinStatus.available) {
      if (!window.electronAPI?.backupDatabase) {
        toast.error(t('common.notAvailable'));
        return;
      }
      const result = await window.electronAPI.backupDatabase('');
      if (result.success) {
        toast.success(`${t('settings.backupCreated')} ${result.path}`, { duration: 5000 });
      } else if (result.error !== 'Cancelled') {
        toast.error(result.error || t('settings.backupFailedGeneric'));
      }
      return;
    }
    setPinGate({ mode: 'backup-custom' });
  };

  const handleRestoreFromHistory = async (backup: BackupInfo) => {
    const ok = await confirm(t('settings.restoreConfirm', { fileName: backup.fileName }), {
      title: t('settings.confirmRestoreTitle'),
      confirmLabel: t('settings.restoreBackup'),
      destructive: true,
    });
    if (!ok) return;

    if (masterPinStatus.available && !masterPinStatus.isSet) {
      toast.error(t('settings.setMasterPinFirst'));
      return;
    }
    if (!masterPinStatus.available) {
      if (!window.electronAPI?.restoreBackup) {
        toast.error(t('common.notAvailable'));
        return;
      }
      const result = await window.electronAPI.restoreBackup('', backup.path);
      if (result.success) {
        toast.success(t('restore.success'));
        setTimeout(() => window.location.reload(), 1500);
      } else if (result.error !== 'Cancelled') {
        toast.error(result.error || t('settings.restoreFailedGeneric'));
      }
      return;
    }
    setPinGate({ mode: 'restore', payload: { backupPath: backup.path } });
  };

  const handleDeleteBackup = async (backup: BackupInfo) => {
    const ok = await confirm(t('settings.deleteBackupConfirm', { fileName: backup.fileName }), {
      title: t('settings.confirmDeleteBackupTitle'),
      confirmLabel: t('settings.deleteBackup'),
      destructive: true,
    });
    if (!ok) return;

    if (masterPinStatus.available && !masterPinStatus.isSet) {
      toast.error(t('settings.setMasterPinFirst'));
      return;
    }
    if (!masterPinStatus.available) {
      try {
        await api.post(`/db-tools/backups/${encodeURIComponent(backup.fileName)}/delete`, {});
        toast.success(t('settings.backupDeleted'));
        fetchBackups();
      } catch {
        toast.error(t('settings.backupDeleteFailed'));
      }
      return;
    }
    setPinGate({ mode: 'delete-backup', payload: { fileName: backup.fileName } });
  };

  const handleInitializeDatabase = async (pin: string) => {
    try {
      const { data } = await api.post('/db-tools/initialize', { master_pin: pin, confirmation_phrase: 'INITIALIZE' });
      return { success: true, backupPath: data.backupPath };
    } catch {
      return { success: false, error: t('settings.initializeFailedGeneric') };
    }
  };

  // ── KDS pairing ──────────────────────────────────────────────────────────
  const [kdsInfo, setKdsInfo] = useState<{ 
    mdns_url: string; 
    ip_url: string; 
    qr_url: string; 
    qr_data_url: string | null;
    ips_data?: { ip: string; url: string; qr_data: string | null }[];
  } | null>(null);
  // The mount effect below always fetches this unconditionally, so this starts true rather
  // than being set synchronously inside that effect (fetchKdsInfo, used by the manual
  // "refresh" button, still sets it explicitly for that path).
  const [kdsInfoLoading, setKdsInfoLoading] = useState(true);

  const fetchKdsInfo = () => {
    setKdsInfoLoading(true);
    api.get('/kds-info').then((res) => {
      setKdsInfo(res.data);
    }).catch(() => {
      toast.error(t('settings.kdsInfoFetchFailed'));
    }).finally(() => setKdsInfoLoading(false));
  };

  // ── Server App pairing (tableside ordering) ───────────────────────────────
  const [serverAppInfo, setServerAppInfo] = useState<{
    mdns_url: string;
    ip_url: string;
    qr_url: string;
    qr_data_url: string | null;
    ips_data?: { ip: string; url: string; qr_data: string | null }[];
  } | null>(null);
  const [serverAppInfoLoading, setServerAppInfoLoading] = useState(false);

  const fetchServerAppInfo = () => {
    setServerAppInfoLoading(true);
    api.get('/server-app-info').then((res) => {
      setServerAppInfo(res.data);
    }).catch(() => {
      toast.error(t('settings.serverAppInfoFetchFailed', { defaultValue: 'Could not load Server App info' }));
    }).finally(() => setServerAppInfoLoading(false));
  };

  // ── POS pairing (add a cashier device) ────────────────────────────────────
  const [posInfo, setPosInfo] = useState<{
    mdns_url: string;
    ip_url: string;
    qr_url: string;
    qr_data_url: string | null;
    ips_data?: { ip: string; url: string; qr_data: string | null }[];
  } | null>(null);
  const [posInfoLoading, setPosInfoLoading] = useState(false);

  const fetchPosInfo = () => {
    setPosInfoLoading(true);
    api.get('/pos-info').then((res) => {
      setPosInfo(res.data);
    }).catch(() => {
      toast.error(t('settings.posInfoFetchFailed'));
    }).finally(() => setPosInfoLoading(false));
  };

  // ── More Apps ───────────────────────────────────────────────────────────────
  type MoreApp = {
    id: string;
    name: string;
    tagline: string;
    ios_url: string | null;
    android_url: string | null;
    qr_data_url: string | null;
    available: boolean;
  };
  const [moreApps, setMoreApps] = useState<MoreApp[]>([]);
  // The mount effect below always fetches this unconditionally, so this starts true rather
  // than being set synchronously inside that effect.
  const [moreAppsLoading, setMoreAppsLoading] = useState(true);
  const [revflo, setRevflo] = useState<MoreApp | null>(null);

  useEffect(() => {
    api.get('/more-apps').then((res) => {
      setMoreApps(res.data.apps || []);
    }).catch(() => {
      // Silent — this tab is informational, not critical
    }).finally(() => setMoreAppsLoading(false));

    api.get('/more-apps/revflo').then((res) => {
      setRevflo(res.data.app || null);
    }).catch(() => {
      // Silent — the card still shows the pairing code without the QR promo
    });
  }, []);

  // ── Updates ─────────────────────────────────────────────────────────────────
  const { updateStatus, appVersion, checkForUpdates: handleCheckUpdates } = useUpdateStatus();

  // ── Printers ─────────────────────────────────────────────────────────────
  type HwPrinter = {
    id: string; name: string; connection_type: 'network' | 'usb' | 'webusb';
    ip_address?: string; port?: number;
    paper_width: string; is_default: number; profile_id?: string; profile_name?: string;
  };

  type PrinterForm = {
    name: string; connection_type: 'network' | 'usb' | 'webusb';
    ip_address: string; port: string; paper_width: string;
  };

  const emptyPrinterForm: PrinterForm = {
    name: '', connection_type: 'network', ip_address: '', port: '9100',
    paper_width: 'cols-42',
  };

  type DetectedPrinter = {
    name: string; make: string; model: string;
    connectionType: 'usb' | 'network' | 'bluetooth';
    deviceUri: string; status: 'idle' | 'printing' | 'offline';
    isDefault: boolean; ipAddress?: string; port?: number; paperWidth?: string; profileId?: string;
  };

  const [hwPrinters, setHwPrinters] = useState<HwPrinter[]>([]);
  const [printerForm, setPrinterForm] = useState<PrinterForm>(emptyPrinterForm);
  const [showPrinterForm, setShowPrinterForm] = useState(false);
  const [editingPrinterId, setEditingPrinterId] = useState<string | null>(null);
  const [savingPrinter, setSavingPrinter] = useState(false);
  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const [detectedPrinters, setDetectedPrinters] = useState<DetectedPrinter[]>([]);
  // The mount effect below always detects printers unconditionally, so this starts true
  // rather than being set synchronously inside that effect (fetchDetectedPrinters, used by
  // the manual "refresh" button, still sets it explicitly for that path).
  const [detectingPrinters, setDetectingPrinters] = useState(true);
  const [addingDetectedName, setAddingDetectedName] = useState<string | null>(null);
  const [installedPrintersOpen, setInstalledPrintersOpen] = useState(false);

  const normalizePrinterWidthValue = (value?: string | null): string => {
    if (value === '58mm') return 'cols-32';
    if (value === '58mm-36') return 'cols-36';
    if (value === '80mm-42') return 'cols-42';
    if (value === '80mm') return 'cols-48';
    return /^cols-(32|36|40|42|44|48)$/.test(value || '') ? value! : 'cols-42';
  };

  const printWidthLabel = (value?: string | null): string => {
    const cols = normalizePrinterWidthValue(value).replace('cols-', '');
    return t('settings.printColumnsShort', { cols });
  };

  const fetchPrinters = () => {
    api.get('/printers').then((res) => setHwPrinters(res.data.printers || [])).catch(() => {});
  };

  const fetchDetectedPrinters = () => {
    setDetectingPrinters(true);
    api.get('/printers/detect')
      .then((res) => setDetectedPrinters(res.data.printers || []))
      .catch(() => setDetectedPrinters([]))
      .finally(() => setDetectingPrinters(false));
  };

  const quickAddDetected = async (p: DetectedPrinter) => {
    setAddingDetectedName(p.name);
    try {
      const payload: {
        name: string;
        connection_type: 'network' | 'usb';
        paper_width: string;
        ip_address?: string;
        port?: number;
      } = {
        name: p.name,
        connection_type: p.connectionType === 'network' ? 'network' : 'usb',
        paper_width: normalizePrinterWidthValue(p.paperWidth),
      };
      if (p.connectionType === 'network') {
        payload.ip_address = p.ipAddress || '';
        payload.port = p.port || 9100;
      }
      await api.post('/printers', payload);
      toast.success(t('settings.printerQuickAdded', { name: p.name }));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch {
      toast.error(t('settings.printerAddFailed'));
    } finally {
      setAddingDetectedName(null);
    }
  };

  const openAddPrinter = () => {
    setPrinterForm(emptyPrinterForm);
    setEditingPrinterId(null);
    setShowPrinterForm(true);
  };

  const openEditPrinter = (p: HwPrinter) => {
    setPrinterForm({
      name: p.name, connection_type: p.connection_type,
      ip_address: p.ip_address || '', port: String(p.port || 9100),
      paper_width: normalizePrinterWidthValue(p.paper_width),
    });
    setEditingPrinterId(p.id);
    setShowPrinterForm(true);
  };

  const savePrinterHw = async () => {
    if (!printerForm.name) { toast.error(t('settings.printerNameRequired')); return; }
    setSavingPrinter(true);
    try {
      const payload = {
        name: printerForm.name,
        connection_type: printerForm.connection_type,
        ip_address: printerForm.connection_type === 'network' ? printerForm.ip_address : undefined,
        port: printerForm.connection_type === 'network' ? Number(printerForm.port) : undefined,
        paper_width: printerForm.paper_width,
      };
      if (editingPrinterId) {
        await api.put(`/printers/${editingPrinterId}`, payload);
        toast.success(t('settings.printerUpdated'));
      } else {
        await api.post('/printers', payload);
        toast.success(t('settings.printerSaved'));
      }
      fetchPrinters();
      refreshHardwarePrinter();
      setShowPrinterForm(false);
    } catch {
      toast.error(t('settings.printerSaveFailed'));
    } finally {
      setSavingPrinter(false);
    }
  };

  const deletePrinterHw = async (id: string) => {
    if (!await confirm(t('settings.printerDeleteConfirm'), { destructive: true, confirmLabel: t('common.delete') })) return;
    try {
      await api.delete(`/printers/${id}`);
      toast.success(t('settings.printerDeleted'));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch { toast.error(t('settings.printerDeleteFailed')); }
  };

  const setDefaultPrinter = async (id: string) => {
    try {
      await api.post(`/printers/${id}/set-default`);
      toast.success(t('settings.defaultPrinterSet'));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch { toast.error(t('settings.actionFailed')); }
  };

  const testPrinterHw = async (printer: HwPrinter) => {
    if (printer.connection_type === 'webusb') {
      toast(t('settings.webusbTestHint'));
      return;
    }
    setTestingPrinterId(printer.id);
    try {
      await api.post(`/printers/${printer.id}/test`);
      toast.success(t('settings.testPrintSent'));
    } catch {
      toast.error(t('settings.testPrintFailed'));
    } finally {
      setTestingPrinterId(null);
    }
  };

  // ── Kitchen Stations ─────────────────────────────────────────────────────
  type KitchenStation = {
    id: string; name: string; description?: string; category_ids?: string;
    printer_id?: string | null; is_active: number; sort_order: number;
  };
  type StaffOption = { id: string; name: string; role: string };
  type CategoryOption = { id: string; name: string };

  const [stations, setStations] = useState<KitchenStation[]>([]);
  const [stationCategories, setStationCategories] = useState<CategoryOption[]>([]);
  const [stationStaff, setStationStaff] = useState<StaffOption[]>([]);
  const [stationUsersByStation, setStationUsersByStation] = useState<Record<string, StaffOption[]>>({});
  const [showStationForm, setShowStationForm] = useState(false);
  const [editingStationId, setEditingStationId] = useState<string | null>(null);
  const [stationForm, setStationForm] = useState<{
    name: string; category_ids: string[]; printer_id: string; user_ids: string[];
  }>({ name: '', category_ids: [], printer_id: '', user_ids: [] });
  const [savingStation, setSavingStation] = useState(false);

  const fetchStations = () => {
    api.get('/kitchen-stations').then((res) => setStations(res.data.kitchenStations || [])).catch(() => {});
  };
  const fetchStationCategories = () => {
    api.get('/categories').then((res) => setStationCategories(res.data.categories || [])).catch(() => {});
  };
  const fetchStationStaff = () => {
    api.get('/staff').then((res) => setStationStaff(res.data.staff || [])).catch(() => {});
  };
  const fetchStationUsers = async (stationId: string) => {
    try {
      const res = await api.get(`/kitchen-stations/${stationId}`);
      setStationUsersByStation((prev) => ({ ...prev, [stationId]: res.data.kitchenStation.users || [] }));
    } catch { /* ignore */ }
  };

  const openAddStation = () => {
    setEditingStationId(null);
    setStationForm({ name: '', category_ids: [], printer_id: '', user_ids: [] });
    setShowStationForm(true);
  };

  const openEditStation = async (station: KitchenStation) => {
    setEditingStationId(station.id);
    let categoryIds: string[] = [];
    try { categoryIds = station.category_ids ? JSON.parse(station.category_ids) : []; } catch { categoryIds = []; }
    let userIds: string[] = stationUsersByStation[station.id]?.map((u) => u.id) || [];
    if (!stationUsersByStation[station.id]) {
      try {
        const res = await api.get(`/kitchen-stations/${station.id}`);
        const users = res.data.kitchenStation.users || [];
        setStationUsersByStation((prev) => ({ ...prev, [station.id]: users }));
        userIds = users.map((u: StaffOption) => u.id);
      } catch { /* ignore */ }
    }
    setStationForm({ name: station.name, category_ids: categoryIds, printer_id: station.printer_id || '', user_ids: userIds });
    setShowStationForm(true);
  };

  const toggleStationFormValue = (field: 'category_ids' | 'user_ids', value: string) => {
    setStationForm((prev) => {
      const set = new Set(prev[field]);
      if (set.has(value)) set.delete(value); else set.add(value);
      return { ...prev, [field]: Array.from(set) };
    });
  };

  const saveStation = async () => {
    if (!stationForm.name.trim()) { toast.error(t('settings.stationNameRequired')); return; }
    setSavingStation(true);
    try {
      const payload = {
        name: stationForm.name.trim(),
        category_ids: stationForm.category_ids,
        printer_id: stationForm.printer_id || null,
      };
      let stationId = editingStationId;
      if (editingStationId) {
        await api.put(`/kitchen-stations/${editingStationId}`, payload);
      } else {
        const res = await api.post('/kitchen-stations', payload);
        stationId = res.data.kitchenStation.id;
      }
      if (stationId) {
        await api.put(`/kitchen-stations/${stationId}/users`, { user_ids: stationForm.user_ids });
        await fetchStationUsers(stationId);
      }
      toast.success(editingStationId ? t('settings.stationUpdated') : t('settings.stationSaved'));
      setShowStationForm(false);
      fetchStations();
    } catch {
      toast.error(t('settings.stationSaveFailed'));
    } finally {
      setSavingStation(false);
    }
  };

  const deleteStation = async (id: string) => {
    if (!await confirm(t('settings.stationDeleteConfirm'), { destructive: true, confirmLabel: t('common.delete') })) return;
    try {
      await api.delete(`/kitchen-stations/${id}`);
      toast.success(t('settings.stationDeleted'));
      fetchStations();
    } catch {
      toast.error(t('settings.stationDeleteFailed'));
    }
  };

  useEffect(() => {
    stations.forEach((s) => {
      if (!stationUsersByStation[s.id]) fetchStationUsers(s.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations]);

  // Mobile App Pairing
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState<string | null>(null);
  // Defaults to true (not false) so the "Generate Pairing Code" button can't
  // render — and be clicked — before the /settings/cloud fetch below has told
  // us whether this store is actually registered. Clicking it in that window
  // used to hit the backend while registration status was still unknown and
  // fail with a generic error even on stores that end up fully registered.
  const [pairingUnavailable, setPairingUnavailable] = useState(true);
  const [rotatingCode, setRotatingCode] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [pairedDevices, setPairedDevices] = useState<Array<{
    id: string; platform: string | null; app_version: string | null;
    user_agent: string | null; country: string | null;
    first_seen_at: string | null; last_seen_at: string | null;
  }>>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);

  // Printing local state (buffered — saved only on explicit Save)
  type PrintingForm = {
    printerEnabled: boolean; printerPaperSize: PaperSize;
    printMethod: 'escpos' | 'browser';
    autoPrintKot: boolean; autoPrintBill: boolean;
    whatsappShareEnabled: boolean;
    printerUseUnicode: boolean;
    printerTrimDecimals: boolean;
    billShowName: boolean; billShowAddress: boolean; billShowPhone: boolean; billShowTaxId: boolean;
    billShowTaxBreakdown: boolean; billShowCustomerName: boolean; billShowCustomerPhone: boolean; billShowTableNumber: boolean;
  };
  const initPrinting = (): PrintingForm => ({
    printerEnabled: posSettings.printerEnabled,
    printerPaperSize: posSettings.printerPaperSize,
    printMethod: printMethod as 'escpos' | 'browser',
    autoPrintKot: posSettings.autoPrintKot,
    autoPrintBill: posSettings.autoPrintBill,
    whatsappShareEnabled: posSettings.whatsappShareEnabled,
    printerUseUnicode: posSettings.printerUseUnicode,
    printerTrimDecimals: posSettings.printerTrimDecimals,
    billShowName: posSettings.billShowName,
    billShowAddress: posSettings.billShowAddress,
    billShowPhone: posSettings.billShowPhone,
    billShowTaxId: posSettings.billShowTaxId,
    billShowTaxBreakdown: posSettings.billShowTaxBreakdown,
    billShowCustomerName: posSettings.billShowCustomerName,
    billShowCustomerPhone: posSettings.billShowCustomerPhone,
    billShowTableNumber: posSettings.billShowTableNumber,
  });
  const [printingForm, setPrintingForm] = useState<PrintingForm>(initPrinting);
  const [savedPrinting, setSavedPrinting] = useState<PrintingForm>(initPrinting);
  const savePrinting = async (silent: boolean = false) => {
    posSettings.setPrinterEnabled(printingForm.printerEnabled);
    posSettings.setPrinterPaperSize(printingForm.printerPaperSize);
    setPrintMethod(printingForm.printMethod);
    posSettings.setAutoPrintKot(printingForm.autoPrintKot);
    posSettings.setAutoPrintBill(printingForm.autoPrintBill);
    posSettings.setWhatsappShareEnabled(printingForm.whatsappShareEnabled);
    posSettings.setPrinterUseUnicode(printingForm.printerUseUnicode);
    posSettings.setPrinterTrimDecimals(printingForm.printerTrimDecimals);
    posSettings.setBillShowName(printingForm.billShowName);
    posSettings.setBillShowAddress(printingForm.billShowAddress);
    posSettings.setBillShowPhone(printingForm.billShowPhone);
    posSettings.setBillShowTaxId(printingForm.billShowTaxId);
    posSettings.setBillShowTaxBreakdown(printingForm.billShowTaxBreakdown);
    posSettings.setBillShowCustomerName(printingForm.billShowCustomerName);
    posSettings.setBillShowCustomerPhone(printingForm.billShowCustomerPhone);
    posSettings.setBillShowTableNumber(printingForm.billShowTableNumber);
    await Promise.all([
      api.put('/settings/printer_trim_decimals', { value: printingForm.printerTrimDecimals ? 'true' : 'false' }),
      ...([
        ['bill_show_name', printingForm.billShowName],
        ['bill_show_address', printingForm.billShowAddress],
        ['bill_show_phone', printingForm.billShowPhone],
        ['bill_show_tax_id', printingForm.billShowTaxId],
        ['bill_show_tax_breakdown', printingForm.billShowTaxBreakdown],
        ['bill_show_customer_name', printingForm.billShowCustomerName],
        ['bill_show_customer_phone', printingForm.billShowCustomerPhone],
        ['bill_show_table_number', printingForm.billShowTableNumber],
      ] as const).map(([key, value]) => api.put(`/settings/${key}`, { value: value ? 'true' : 'false' })),
    ]);
    setSavedPrinting(printingForm);
    if (!silent) toast.success(t('settings.printingSettingsSaved'));
  };
  const resetPrinting = () => setPrintingForm(savedPrinting);

  // Bill template local state
  type BillTemplateForm = { billTemplate: BillTemplate; billFooterMessage: string };
  const initBillTemplate = (): BillTemplateForm => ({
    billTemplate: posSettings.billTemplate,
    billFooterMessage: posSettings.billFooterMessage,
  });
  const [billForm, setBillForm] = useState<BillTemplateForm>(initBillTemplate);
  const [savedBillForm, setSavedBillForm] = useState<BillTemplateForm>(initBillTemplate);
  const [billTemplateCards, setBillTemplateCards] = useState<TemplateCard[]>(TEMPLATE_CARDS);
  const saveBillTemplate = async (silent: boolean = false) => {
    posSettings.setBillTemplate(billForm.billTemplate);
    posSettings.setBillFooterMessage(billForm.billFooterMessage);
    await Promise.all([
      api.put('/settings/bill_template', { value: billForm.billTemplate }),
      api.put('/settings/bill_footer_message', { value: billForm.billFooterMessage }),
    ]);
    setSavedBillForm(billForm);
    if (!silent) toast.success(t('settings.billTemplateSaved'));
  };
  const resetBillTemplate = () => setBillForm(savedBillForm);

  // Store / business fields — local form state (saved only on explicit Save)
  type BusinessForm = {
    businessName: string; countryCode: string; timezone: string; currency: string;
    billingType: 'postpaid' | 'prepaid';
    tablesRequired: boolean;
    taxRegistered: boolean;
    taxRegistrationNumber: string; businessAddress: string; businessPhone: string; instagramHandle: string;
    currencyDisplay: CurrencyDisplay;
    numberDigits: DigitMode;
    calendar: CalendarMode;
  };
  const [savedBusiness, setSavedBusiness] = useState<BusinessForm>({
    businessName: '', countryCode: '', timezone: '', currency: '', billingType: 'postpaid',
    tablesRequired: true,
    taxRegistered: false,
    taxRegistrationNumber: '', businessAddress: '', businessPhone: '', instagramHandle: '',
    currencyDisplay: 'rial',
    numberDigits: 'locale',
    calendar: 'locale',
  });
  const [form, setForm] = useState<BusinessForm>(savedBusiness);
  const [savingBusiness, setSavingBusiness] = useState(false);

  const [cloudSettings, setCloudSettings] = useState({
    cloud_api_key: '',
    cloud_store_id: '',
    cloud_sync_enabled: false,
    cloud_orders_enabled: false,
    cloud_last_sync: null as string | null,
  });
  const [savedCloudSettings, setSavedCloudSettings] = useState(cloudSettings);
  const [cloudStatus, setCloudStatus] = useState({
    cloud_registration_status: 'unregistered',
    cloud_services_disabled_by_user: false,
    cloud_connected: false,
    cloud_relay_mode: 'disconnected',
    cloud_last_heartbeat: null as string | null,
    cloud_last_error: null as string | null,
    cloud_deletion_status: '',
  });
   
  const [savingCloud, setSavingCloud] = useState(false);
  const [registeringCloud, setRegisteringCloud] = useState(false);
  const [showInitializeCloudConfirm, setShowInitializeCloudConfirm] = useState(false);

  const cloudServicesStopped = cloudStatus.cloud_services_disabled_by_user;
  const cloudDeletionFinal = cloudStatus.cloud_registration_status === 'deleted' || ['approved', 'completed', 'deleted'].includes(cloudStatus.cloud_deletion_status);
  const cloudDeletionNeedsAction = !cloudDeletionFinal && (cloudDeletionNeedsResolution || ['processing', 'failed'].includes(cloudStatus.cloud_deletion_status));

  const refreshCloudStatus = async () => {
    try {
      const { data } = await api.get('/settings/cloud');
      setCloudStatus({
        cloud_registration_status: data.cloud_registration_status || 'unregistered',
        cloud_services_disabled_by_user: !!data.cloud_services_disabled_by_user,
        cloud_connected: !!data.cloud_connected,
        cloud_relay_mode: data.cloud_relay_mode || 'disconnected',
        cloud_last_heartbeat: data.cloud_last_heartbeat || null,
        cloud_last_error: data.cloud_last_error || null,
        cloud_deletion_status: data.cloud_deletion_status || '',
      });
      setCloudSettings((previous) => ({
        ...previous,
        cloud_sync_enabled: !!data.cloud_sync_enabled,
        cloud_orders_enabled: !!data.cloud_orders_enabled,
        cloud_last_sync: data.cloud_last_sync || null,
      }));
      setSavedCloudSettings((previous) => ({
        ...previous,
        cloud_sync_enabled: !!data.cloud_sync_enabled,
        cloud_orders_enabled: !!data.cloud_orders_enabled,
        cloud_last_sync: data.cloud_last_sync || null,
      }));
    } catch {
      // Keep the last known status if the local settings request fails.
    }
  };

  const refreshDeletionStatus = async () => {
    setRefreshingDeletionStatus(true);
    try {
      await api.get('/settings/cloud/delete-data/status');
      await Promise.all([fetchCloudAccount(), refreshCloudStatus()]);
      notifyCloudAccountStatusChanged();
      toast.success(t('settings.cloudDeletionStatusRefreshed'));
    } catch {
      toast.error(t('settings.cloudDeletionStatusRefreshFailed'));
    } finally {
      setRefreshingDeletionStatus(false);
    }
  };

  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [savingTelemetry, setSavingTelemetry] = useState(false);

  const [diagnosticsConsent, setDiagnosticsConsent] = useState(false);
  const [savingDiagnosticsConsent, setSavingDiagnosticsConsent] = useState(false);

  type GoogleDriveStatus = {
    configured: boolean;
    secure_storage_available: boolean;
    connected: boolean;
    account_email: string | null;
    frequency: 'daily' | 'weekly';
    retention_count: number;
    last_backup_at: string | null;
    last_backup_status: 'success' | 'error' | null;
    last_backup_filename: string | null;
    last_error: string | null;
  };
  const [googleDriveStatus, setGoogleDriveStatus] = useState<GoogleDriveStatus>({
    configured: false,
    secure_storage_available: true,
    connected: false,
    account_email: null,
    frequency: 'daily',
    retention_count: 10,
    last_backup_at: null,
    last_backup_status: null,
    last_backup_filename: null,
    last_error: null,
  });
  const [connectingGoogleDrive, setConnectingGoogleDrive] = useState(false);
  const [disconnectingGoogleDrive, setDisconnectingGoogleDrive] = useState(false);
  const [backingUpGoogleDrive, setBackingUpGoogleDrive] = useState(false);
  const [savingGoogleDrivePrefs, setSavingGoogleDrivePrefs] = useState(false);

  // Kitchen workflow toggles (issue #133) — independent on/off switches,
  // default true to match pre-toggle always-on behavior.
  const [kdsEnabledSetting, setKdsEnabledSetting] = useState(true);
  const [savingKdsEnabled, setSavingKdsEnabled] = useState(false);
  const [serverAppEnabledSetting, setServerAppEnabledSetting] = useState(true);
  const [savingServerAppEnabled, setSavingServerAppEnabled] = useState(false);
  const [kotPrintingEnabledSetting, setKotPrintingEnabledSetting] = useState(true);
  const [savingKotPrintingEnabled, setSavingKotPrintingEnabled] = useState(false);

  type OrderNumberForm = {
    prefix: string;
    includeDate: boolean;
    resetDaily: boolean;
    invoicePrefix: string;
    invoiceIncludePeriod: boolean;
    invoiceResetPeriod: InvoiceResetPeriod;
    invoiceFinancialYearStartMonth: number;
    invoiceFinancialYearStartDay: number;
  };
  const [savedOrderNumberForm, setSavedOrderNumberForm] = useState<OrderNumberForm>({
    prefix: 'ORD',
    includeDate: true,
    resetDaily: true,
    invoicePrefix: 'INV',
    invoiceIncludePeriod: true,
    invoiceResetPeriod: 'daily',
    invoiceFinancialYearStartMonth: 4,
    invoiceFinancialYearStartDay: 1,
  });
  const [orderNumberForm, setOrderNumberForm] = useState<OrderNumberForm>(savedOrderNumberForm);
  const [savingOrderNumbering, setSavingOrderNumbering] = useState(false);

  const resetBusiness = async () => {
    try {
      const [businessRes, loyaltyRes, discountRes, orderNumberingRes] = await Promise.all([
        api.get('/settings/business'),
        api.get('/settings/loyalty'),
        api.get('/settings/discount'),
        api.get('/settings/order-numbering'),
      ]);

      const d = businessRes.data;
      const matchedCountry = COUNTRIES.find(c => c.currency === d.currency && c.timezone === d.timezone);
      const loaded: BusinessForm = {
        businessName: d.business_name || '',
        countryCode: matchedCountry?.code || '',
        timezone: d.timezone || '',
        currency: d.currency || '',
        billingType: d.billing_type === 'prepaid' ? 'prepaid' : 'postpaid',
        tablesRequired: typeof d.tables_required === 'boolean' ? d.tables_required : true,
        taxRegistered: d.tax_registered === 'true' || d.tax_registered === true || d.tax_registered === 1,
        taxRegistrationNumber: d.tax_registration_number || '',
        businessAddress: d.business_address || '',
        businessPhone: d.business_phone || '',
        instagramHandle: d.instagram_handle || '',
        currencyDisplay: d.currency_display === 'toman' ? 'toman' : d.currency_display === 'toman_short' ? 'toman_short' : 'rial',
        numberDigits: d.number_digits === 'latin' ? 'latin' : 'locale',
        calendar: d.calendar === 'persian' ? 'persian' : d.calendar === 'gregorian' ? 'gregorian' : 'locale',
      };
      setSavedBusiness(loaded);
      setForm(loaded);
      const billDisplay = {
        billShowName: d.bill_show_name !== false,
        billShowAddress: d.bill_show_address !== false,
        billShowPhone: d.bill_show_phone !== false,
        billShowTaxId: d.bill_show_tax_id === true,
        billShowTaxBreakdown: d.bill_show_tax_breakdown !== false,
        billShowCustomerName: d.bill_show_customer_name !== false,
        billShowCustomerPhone: d.bill_show_customer_phone !== false,
        billShowTableNumber: d.bill_show_table_number !== false,
      };
      setPrintingForm((previous) => ({ ...previous, ...billDisplay }));
      setSavedPrinting((previous) => ({ ...previous, ...billDisplay }));
      posSettings.setBillShowName(billDisplay.billShowName);
      posSettings.setBillShowAddress(billDisplay.billShowAddress);
      posSettings.setBillShowPhone(billDisplay.billShowPhone);
      posSettings.setBillShowTaxId(billDisplay.billShowTaxId);
      posSettings.setBillShowTaxBreakdown(billDisplay.billShowTaxBreakdown);
      posSettings.setBillShowCustomerName(billDisplay.billShowCustomerName);
      posSettings.setBillShowCustomerPhone(billDisplay.billShowCustomerPhone);
      posSettings.setBillShowTableNumber(billDisplay.billShowTableNumber);

      setLoyaltyEnabled(!!loyaltyRes.data.loyalty_enabled);
      setSavedLoyaltyEnabled(!!loyaltyRes.data.loyalty_enabled);
      setGlobalCashbackPercent(String(loyaltyRes.data.global_cashback_percent ?? 0));
      setSavedGlobalCashbackPercent(String(loyaltyRes.data.global_cashback_percent ?? 0));

      if (discountRes.data.discount_max_percentage !== undefined) {
        const value = normalizeDiscountPercentage(discountRes.data.discount_max_percentage);
        setDiscountMaxPct(value);
        setSavedDiscountMaxPct(value);
      }
      if (discountRes.data.discount_max_amount !== undefined) {
        const value = normalizeDiscountAmount(discountRes.data.discount_max_amount);
        setDiscountMaxAmount(value);
        setSavedDiscountMaxAmount(value);
      }
      if (discountRes.data.discount_mode) { setDiscountMode(discountRes.data.discount_mode); setSavedDiscountMode(discountRes.data.discount_mode); }
      if (discountRes.data.discount_requires_approval !== undefined) { setDiscountRequiresApproval(!!discountRes.data.discount_requires_approval); setSavedDiscountRequiresApproval(!!discountRes.data.discount_requires_approval); }

      const loadedOrderNumbering: OrderNumberForm = {
        prefix: orderNumberingRes.data.order_number_prefix ?? 'ORD',
        includeDate: orderNumberingRes.data.order_number_include_date !== false,
        resetDaily: orderNumberingRes.data.order_number_reset_daily !== false,
        invoicePrefix: orderNumberingRes.data.invoice_number_prefix ?? 'INV',
        invoiceIncludePeriod: orderNumberingRes.data.invoice_number_include_period !== false,
        invoiceResetPeriod: (orderNumberingRes.data.invoice_number_reset_period || 'daily') as InvoiceResetPeriod,
        invoiceFinancialYearStartMonth: Number(orderNumberingRes.data.invoice_financial_year_start_month) || 4,
        invoiceFinancialYearStartDay: Number(orderNumberingRes.data.invoice_financial_year_start_day) || 1,
      };
      setOrderNumberForm(loadedOrderNumbering);
      setSavedOrderNumberForm(loadedOrderNumbering);

      toast.success(t('settings.reloadedFromDb'));
    } catch {
      toast.error(t('settings.reloadFailed'));
    }
  };

  const fetchGoogleDriveStatus = () => {
    api.get('/settings/google-drive').then((res) => {
      setGoogleDriveStatus({
        configured: !!res.data.configured,
        secure_storage_available: res.data.secure_storage_available !== false,
        connected: !!res.data.connected,
        account_email: res.data.account_email || null,
        frequency: res.data.frequency === 'weekly' ? 'weekly' : 'daily',
        retention_count: Number(res.data.retention_count) || 10,
        last_backup_at: res.data.last_backup_at || null,
        last_backup_status: res.data.last_backup_status || null,
        last_backup_filename: res.data.last_backup_filename || null,
        last_error: res.data.last_error || null,
      });
    }).catch(() => {
      // Leave defaults (not configured / not connected) — this section is
      // optional and must never block the rest of Settings from loading.
    });
  };

  const loadPairedDevices = async () => {
    setDevicesLoading(true);
    try {
      const res = await api.get('/mobile/devices');
      setPairedDevices(res.data.devices || []);
    } catch {
      setPairedDevices([]);
    } finally {
      setDevicesLoading(false);
    }
  };

  useEffect(() => {
    fetchPrinters();
    // Inlined rather than calling fetchDetectedPrinters() (used by the manual "refresh"
    // button too) — detectingPrinters already starts true for this initial detection.
    api.get('/printers/detect')
      .then((res) => setDetectedPrinters(res.data.printers || []))
      .catch(() => setDetectedPrinters([]))
      .finally(() => setDetectingPrinters(false));
    // Inlined rather than calling fetchKdsInfo() (used by the manual "refresh" button too) —
    // kdsInfoLoading already starts true for this initial fetch.
    api.get('/kds-info')
      .then((res) => setKdsInfo(res.data))
      .catch(() => toast.error(t('settings.kdsInfoFetchFailed')))
      .finally(() => setKdsInfoLoading(false));
    fetchStations();
    fetchStationCategories();
    fetchStationStaff();

    api.get('/settings/loyalty').then((res) => {
      setLoyaltyEnabled(!!res.data.loyalty_enabled);
      setSavedLoyaltyEnabled(!!res.data.loyalty_enabled);
      setGlobalCashbackPercent(String(res.data.global_cashback_percent ?? 0));
      setSavedGlobalCashbackPercent(String(res.data.global_cashback_percent ?? 0));
    }).catch(() => {});

    api.get('/products/loyalty/global-rate-candidates')
      .then((res) => setGlobalRateCandidates(Number(res.data.count) || 0))
      .catch(() => {});

    api.get('/settings/discount').then((res) => {
      if (res.data.discount_max_percentage !== undefined) {
        const value = normalizeDiscountPercentage(res.data.discount_max_percentage);
        setDiscountMaxPct(value);
        setSavedDiscountMaxPct(value);
      }
      if (res.data.discount_max_amount !== undefined) {
        const value = normalizeDiscountAmount(res.data.discount_max_amount);
        setDiscountMaxAmount(value);
        setSavedDiscountMaxAmount(value);
      }
      if (res.data.discount_mode) { setDiscountMode(res.data.discount_mode); setSavedDiscountMode(res.data.discount_mode); }
      if (res.data.discount_requires_approval !== undefined) { setDiscountRequiresApproval(!!res.data.discount_requires_approval); setSavedDiscountRequiresApproval(!!res.data.discount_requires_approval); }
    }).catch(() => {});

    api.get('/settings/telemetry_enabled').then((res) => {
      setTelemetryEnabled(res.data.setting?.value === 'true');
    }).catch(() => {
      // No row yet = consent never given (setup predates this feature, or
      // declined) = stays off until explicitly turned on here.
      setTelemetryEnabled(false);
    });

    api.get('/settings/diagnostics_consent').then((res) => {
      setDiagnosticsConsent(res.data.setting?.value !== 'false');
    }).catch(() => {
      setDiagnosticsConsent(true);
    });

    fetchGoogleDriveStatus();

    api.get('/settings/kds_enabled').then((res) => {
      const enabled = res.data.setting?.value !== 'false';
      setKdsEnabledSetting(enabled);
      posSettings.setKdsEnabled(enabled);
    }).catch(() => {});

    api.get('/settings/server_app_enabled').then((res) => {
      setServerAppEnabledSetting(res.data.setting?.value !== 'false');
    }).catch(() => {});

    api.get('/settings/kot_printing_enabled').then((res) => {
      const enabled = res.data.setting?.value !== 'false';
      setKotPrintingEnabledSetting(enabled);
      posSettings.setKotPrintingEnabled(enabled);
    }).catch(() => {});
    api.get('/settings/printer_trim_decimals').then((res) => {
      const enabled = res.data.setting?.value === 'true';
      posSettings.setPrinterTrimDecimals(enabled);
      setPrintingForm((p) => ({ ...p, printerTrimDecimals: enabled }));
      setSavedPrinting((p) => ({ ...p, printerTrimDecimals: enabled }));
    }).catch(() => {});
    Promise.all([
      api.get('/settings/bill-templates').catch(() => null),
      api.get('/settings/bill_template').catch(() => null),
      api.get('/settings/bill_footer_message').catch(() => null),
    ]).then(([templatesResponse, templateResponse, footerResponse]) => {
      const pluginCards: TemplateCard[] = (templatesResponse?.data?.plugins || []).map((template: {
        id: string;
        displayName: string;
        country: string;
        paperColumns: number[];
      }) => ({
        id: template.id,
        displayName: template.displayName,
        preview: `  ${template.displayName}\n-----------\nTax invoice\n${template.country} · ${template.paperColumns.join('/')} cols\n-----------\nTOTAL`,
        source: 'plugin' as const,
        description: `${template.country} tax template · ${template.paperColumns.join(', ')} columns`,
      }));
      const availableTemplateIds = new Set([...TEMPLATE_CARDS, ...pluginCards].map((card) => card.id));
      setBillTemplateCards([...TEMPLATE_CARDS, ...pluginCards]);
      const storedTemplate = templateResponse?.data.setting?.value;
      const billTemplate: BillTemplate = availableTemplateIds.has(storedTemplate)
        ? storedTemplate as BillTemplate
        : 'classic';
      const billFooterMessage = footerResponse?.data.setting?.value ?? posSettings.billFooterMessage;
      const loadedBillForm = { billTemplate, billFooterMessage };
      posSettings.setBillTemplate(billTemplate);
      posSettings.setBillFooterMessage(billFooterMessage);
      setBillForm(loadedBillForm);
      setSavedBillForm(loadedBillForm);
    });

    api.get('/settings/order-numbering').then((res) => {
      const loaded: OrderNumberForm = {
        prefix: res.data.order_number_prefix ?? 'ORD',
        includeDate: res.data.order_number_include_date !== false,
        resetDaily: res.data.order_number_reset_daily !== false,
        invoicePrefix: res.data.invoice_number_prefix ?? 'INV',
        invoiceIncludePeriod: res.data.invoice_number_include_period !== false,
        invoiceResetPeriod: (res.data.invoice_number_reset_period || 'daily') as InvoiceResetPeriod,
        invoiceFinancialYearStartMonth: Number(res.data.invoice_financial_year_start_month) || 4,
        invoiceFinancialYearStartDay: Number(res.data.invoice_financial_year_start_day) || 1,
      };
      setOrderNumberForm(loaded);
      setSavedOrderNumberForm(loaded);
    }).catch(() => {});


    api.get('/settings/cloud').then((res) => {
      const settings = {
        cloud_api_key: res.data.cloud_api_key || '',
        cloud_store_id: res.data.cloud_store_id || '',
        cloud_sync_enabled: !!res.data.cloud_sync_enabled,
        cloud_orders_enabled: !!res.data.cloud_orders_enabled,
        cloud_last_sync: res.data.cloud_last_sync || null,
      };
      setCloudSettings(settings);
      setSavedCloudSettings(settings);
      setCloudStatus({
        cloud_registration_status: res.data.cloud_registration_status || 'unregistered',
        cloud_services_disabled_by_user: !!res.data.cloud_services_disabled_by_user,
        cloud_connected: !!res.data.cloud_connected,
        cloud_relay_mode: res.data.cloud_relay_mode || 'disconnected',
        cloud_last_heartbeat: res.data.cloud_last_heartbeat || null,
        cloud_last_error: res.data.cloud_last_error || null,
        cloud_deletion_status: res.data.cloud_deletion_status || '',
      });

      // Mobile pairing requires cloud registration — skip the requests entirely
      // for unregistered stores to avoid 502 noise in the console.
      if (res.data.cloud_registration_status === 'registered') {
        api.get('/mobile/pairing-code').then((pcRes) => {
          setPairingCode(pcRes.data.pairing_code);
          setPairingExpiresAt(pcRes.data.expires_at);
          setPairingQrDataUrl(pcRes.data.qr_data_url || null);
          setPairingUnavailable(false);
        }).catch(() => {
          setPairingUnavailable(true);
        });
        loadPairedDevices();
      } else {
        setPairingUnavailable(true);
      }
    }).catch(() => {});

    api.get('/settings/business').then((res) => {
      const d = res.data;
      const matchedCountry = COUNTRIES.find(c => c.currency === d.currency && c.timezone === d.timezone);
      const loaded: BusinessForm = {
        businessName: d.business_name || '',
        countryCode: matchedCountry?.code || '',
        timezone: d.timezone || '',
        currency: d.currency || '',
        billingType: d.billing_type === 'prepaid' ? 'prepaid' : 'postpaid',
        tablesRequired: typeof d.tables_required === 'boolean' ? d.tables_required : true,
        taxRegistered: d.tax_registered === 'true' || d.tax_registered === true || d.tax_registered === 1,
        taxRegistrationNumber: d.tax_registration_number || '',
        businessAddress: d.business_address || '',
        businessPhone: d.business_phone || '',
        instagramHandle: d.instagram_handle || '',
        currencyDisplay: d.currency_display === 'toman' ? 'toman' : d.currency_display === 'toman_short' ? 'toman_short' : 'rial',
        numberDigits: d.number_digits === 'latin' ? 'latin' : 'locale',
        calendar: d.calendar === 'persian' ? 'persian' : d.calendar === 'gregorian' ? 'gregorian' : 'locale',
      };
      setSavedBusiness(loaded);
      setForm(loaded);
      // Sync to pos-settings store for bill printing
      const billDisplay = {
        billShowName: d.bill_show_name !== false,
        billShowAddress: d.bill_show_address !== false,
        billShowPhone: d.bill_show_phone !== false,
        billShowTaxId: d.bill_show_tax_id === true,
        billShowTaxBreakdown: d.bill_show_tax_breakdown !== false,
        billShowCustomerName: d.bill_show_customer_name !== false,
        billShowCustomerPhone: d.bill_show_customer_phone !== false,
        billShowTableNumber: d.bill_show_table_number !== false,
      };
      setPrintingForm((previous) => ({ ...previous, ...billDisplay }));
      setSavedPrinting((previous) => ({ ...previous, ...billDisplay }));
      posSettings.setBillShowName(billDisplay.billShowName);
      posSettings.setBillShowAddress(billDisplay.billShowAddress);
      posSettings.setBillShowPhone(billDisplay.billShowPhone);
      posSettings.setBillShowTaxId(billDisplay.billShowTaxId);
      posSettings.setBillShowTaxBreakdown(billDisplay.billShowTaxBreakdown);
      posSettings.setBillShowCustomerName(billDisplay.billShowCustomerName);
      posSettings.setBillShowCustomerPhone(billDisplay.billShowCustomerPhone);
      posSettings.setBillShowTableNumber(billDisplay.billShowTableNumber);
      if (d.tax_registration_number) posSettings.setBillTaxRegistrationNumber(d.tax_registration_number);
      if (d.business_address) posSettings.setBillAddress(d.business_address);
      if (d.business_phone) posSettings.setBillPhone(d.business_phone);
      posSettings.setBillingType(d.billing_type === 'prepaid' ? 'prepaid' : 'postpaid');
      posSettings.setTablesRequired(typeof d.tables_required === 'boolean' ? d.tables_required : true);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveCloud = async (silent = false) => {
    setSavingCloud(true);
    try {
      const resumingStoppedCloud = cloudServicesStopped && cloudSettings.cloud_sync_enabled;
      const res = await api.put('/settings/cloud', {
        cloud_sync_enabled: cloudSettings.cloud_sync_enabled,
        cloud_orders_enabled: resumingStoppedCloud ? true : cloudSettings.cloud_orders_enabled,
        cloud_reports_enabled: resumingStoppedCloud ? true : undefined,
        cloud_command_polling_enabled: resumingStoppedCloud ? true : undefined,
      });
      const next = { ...cloudSettings, ...res.data };
      setCloudSettings(next);
      setSavedCloudSettings(next);
      setCloudStatus({
        cloud_registration_status: res.data.cloud_registration_status || 'unregistered',
        cloud_services_disabled_by_user: !!res.data.cloud_services_disabled_by_user,
        cloud_connected: !!res.data.cloud_connected,
        cloud_relay_mode: res.data.cloud_relay_mode || 'disconnected',
        cloud_last_heartbeat: res.data.cloud_last_heartbeat || null,
        cloud_last_error: res.data.cloud_last_error || null,
        cloud_deletion_status: res.data.cloud_deletion_status || '',
      });
      await fetchCloudAccount();
      notifyCloudAccountStatusChanged();
      if (!silent) toast.success(t('settings.cloudSaved'));
    } catch (err) {
      if (!silent) toast.error(t('settings.cloudSaveFailed'));
      throw err;
    } finally {
      setSavingCloud(false);
    }
  };

  const resetCloud = () => {
    setCloudSettings(savedCloudSettings);
  };

  const registerCloud = async (email: string) => {
    setRegisteringCloud(true);
    try {
      const res = await api.post('/settings/cloud/register', { email });
      setCloudStatus({
        cloud_registration_status: res.data.cloud_registration_status || 'unregistered',
        cloud_services_disabled_by_user: !!res.data.cloud_services_disabled_by_user,
        cloud_connected: !!res.data.cloud_connected,
        cloud_relay_mode: res.data.cloud_relay_mode || 'disconnected',
        cloud_last_heartbeat: res.data.cloud_last_heartbeat || null,
        cloud_last_error: res.data.cloud_last_error || null,
        cloud_deletion_status: res.data.cloud_deletion_status || '',
      });
      setCloudSettings((prev) => ({
        ...prev,
        cloud_api_key: res.data.cloud_api_key || prev.cloud_api_key,
        cloud_store_id: res.data.cloud_store_id || prev.cloud_store_id,
      }));
      await fetchCloudAccount();
      notifyCloudAccountStatusChanged();
      if (res.data.cloud_registration_status === 'registered') {
        toast.success(t('settings.cloudRegistrationSuccess'));
      }
    } catch {
      toast.error(t('settings.cloudRegistrationFailed'));
    } finally {
      setRegisteringCloud(false);
    }
  };

  const saveTelemetry = async (enabled: boolean) => {
    const previous = telemetryEnabled;
    setTelemetryEnabled(enabled);
    setSavingTelemetry(true);
    try {
      await api.put('/settings/telemetry_enabled', { value: enabled ? 'true' : 'false' });
    } catch {
      setTelemetryEnabled(previous);
      toast.error(t('settings.saveFailed'));
    } finally {
      setSavingTelemetry(false);
    }
  };

  const saveDiagnosticsConsent = async (enabled: boolean) => {
    const previous = diagnosticsConsent;
    setDiagnosticsConsent(enabled);
    setSavingDiagnosticsConsent(true);
    try {
      await api.put('/settings/diagnostics_consent', { value: enabled ? 'true' : 'false' });
    } catch {
      setDiagnosticsConsent(previous);
      toast.error(t('settings.saveFailed'));
    } finally {
      setSavingDiagnosticsConsent(false);
    }
  };

  const connectGoogleDrive = async () => {
    setConnectingGoogleDrive(true);
    try {
      const res = await api.post('/settings/google-drive/connect');
      setGoogleDriveStatus((prev) => ({ ...prev, ...res.data }));
      toast.success(t('settings.googleDriveConnectedSuccess'));
      fetchBackups();
    } catch {
      toast.error(t('settings.googleDriveConnectFailed'));
    } finally {
      setConnectingGoogleDrive(false);
    }
  };

  const disconnectGoogleDrive = async () => {
    const ok = await confirm(t('settings.googleDriveDisconnectConfirm'), {
      confirmLabel: t('settings.googleDriveDisconnect'),
      destructive: true,
    });
    if (!ok) return;
    setDisconnectingGoogleDrive(true);
    try {
      const res = await api.post('/settings/google-drive/disconnect');
      setGoogleDriveStatus((prev) => ({ ...prev, ...res.data }));
      toast.success(t('settings.googleDriveDisconnectedSuccess'));
    } catch {
      toast.error(t('settings.googleDriveDisconnectFailed'));
    } finally {
      setDisconnectingGoogleDrive(false);
    }
  };

  const backupToGoogleDriveNow = async () => {
    setBackingUpGoogleDrive(true);
    try {
      const res = await api.post('/settings/google-drive/backup-now');
      setGoogleDriveStatus((prev) => ({ ...prev, ...res.data }));
      toast.success(t('settings.googleDriveBackupSuccess'));
      fetchBackups();
    } catch {
      toast.error(t('settings.googleDriveBackupFailed'));
      fetchGoogleDriveStatus();
    } finally {
      setBackingUpGoogleDrive(false);
    }
  };

  const updateGoogleDrivePrefs = async (patch: { frequency?: 'daily' | 'weekly'; retention_count?: number }) => {
    const previous = googleDriveStatus;
    setGoogleDriveStatus((prev) => ({ ...prev, ...patch }));
    setSavingGoogleDrivePrefs(true);
    try {
      const res = await api.put('/settings/google-drive', patch);
      setGoogleDriveStatus((prev) => ({ ...prev, ...res.data }));
    } catch {
      setGoogleDriveStatus(previous);
      toast.error(t('settings.googleDriveSavePreferencesFailed'));
    } finally {
      setSavingGoogleDrivePrefs(false);
    }
  };

  // Kitchen workflow toggles (issue #133) — saved immediately on toggle
  // (not batched with the rest of the form) since turning KDS off also
  // invalidates outstanding pairing tokens server-side; a stale local
  // "unsaved" toggle would be misleading about that security-relevant effect.
  const saveKdsEnabled = async (enabled: boolean) => {
    const previous = kdsEnabledSetting;
    setKdsEnabledSetting(enabled);
    posSettings.setKdsEnabled(enabled);
    setSavingKdsEnabled(true);
    try {
      await api.put('/settings/kds_enabled', { value: enabled ? 'true' : 'false' });
      toast.success(enabled ? t('settings.kdsEnabledOn', { defaultValue: 'Kitchen Display System enabled' }) : t('settings.kdsEnabledOff', { defaultValue: 'Kitchen Display System disabled' }));
    } catch {
      setKdsEnabledSetting(previous);
      posSettings.setKdsEnabled(previous);
      toast.error(t('settings.saveFailed'));
    } finally {
      setSavingKdsEnabled(false);
    }
  };

  const saveServerAppEnabled = async (enabled: boolean) => {
    const previous = serverAppEnabledSetting;
    setServerAppEnabledSetting(enabled);
    setSavingServerAppEnabled(true);
    try {
      await api.put('/settings/server_app_enabled', { value: enabled ? 'true' : 'false' });
      if (!enabled) setServerAppInfo(null);
      toast.success(enabled
        ? t('settings.serverAppEnabledOn', { defaultValue: 'Server App enabled' })
        : t('settings.serverAppEnabledOff', { defaultValue: 'Server App disabled' }));
    } catch {
      setServerAppEnabledSetting(previous);
      toast.error(t('settings.saveFailed'));
    } finally {
      setSavingServerAppEnabled(false);
    }
  };

  const saveKotPrintingEnabled = async (enabled: boolean) => {
    const previous = kotPrintingEnabledSetting;
    setKotPrintingEnabledSetting(enabled);
    posSettings.setKotPrintingEnabled(enabled);
    setSavingKotPrintingEnabled(true);
    try {
      await api.put('/settings/kot_printing_enabled', { value: enabled ? 'true' : 'false' });
      toast.success(enabled ? t('settings.kotPrintingEnabledOn', { defaultValue: 'KOT printing enabled' }) : t('settings.kotPrintingEnabledOff', { defaultValue: 'KOT printing disabled' }));
    } catch {
      setKotPrintingEnabledSetting(previous);
      posSettings.setKotPrintingEnabled(previous);
      toast.error(t('settings.saveFailed'));
    } finally {
      setSavingKotPrintingEnabled(false);
    }
  };

  const saveLoyalty = async (silent = false) => {
    setSavingLoyalty(true);
    try {
      const parsedRate = Math.min(100, Math.max(0, parseFloat(globalCashbackPercent) || 0));
      await api.put('/settings/loyalty', {
        loyalty_enabled: loyaltyEnabled,
        global_cashback_percent: parsedRate,
      });
      setSavedLoyaltyEnabled(loyaltyEnabled);
      setGlobalCashbackPercent(String(parsedRate));
      setSavedGlobalCashbackPercent(String(parsedRate));
      if (!silent) toast.success(t('settings.loyaltySaved'));
    } catch (err) {
      if (!silent) toast.error(t('settings.saveFailed'));
      throw err;
    } finally {
      setSavingLoyalty(false);
    }
  };

  const applyGlobalRateToProducts = async () => {
    setApplyingGlobalRate(true);
    try {
      const res = await api.post('/products/loyalty/apply-global-rate');
      const updated = Number(res.data.updated) || 0;
      setGlobalRateCandidates(0);
      toast.success(t('settings.applyGlobalRateDone', { count: updated }));
    } catch {
      toast.error(t('settings.saveFailed'));
    } finally {
      setApplyingGlobalRate(false);
    }
  };

  const saveDiscount = async (silent = false) => {
    setSavingDiscount(true);
    try {
      await api.put('/settings/discount', {
        discount_max_percentage: normalizeDiscountPercentage(discountMaxPct),
        discount_max_amount: normalizeDiscountAmount(discountMaxAmount),
        discount_mode: discountMode,
        discount_requires_approval: discountRequiresApproval,
      });
      setSavedDiscountMaxPct(normalizeDiscountPercentage(discountMaxPct));
      setSavedDiscountMaxAmount(normalizeDiscountAmount(discountMaxAmount));
      setSavedDiscountMode(discountMode);
      setSavedDiscountRequiresApproval(discountRequiresApproval);
      if (!silent) toast.success(t('settings.discountSaved'));
    } catch (err) {
      if (!silent) toast.error(t('settings.saveFailed'));
      throw err;
    } finally {
      setSavingDiscount(false);
    }
  };

  const saveBusinessInfo = async (silent = false) => {
    const norm = normalizeOptionalPhone(form.businessPhone, form.countryCode || 'IN');
    if (!norm.valid) {
      toast.error(t('settings.invalidPhoneFormat', { defaultValue: 'Invalid phone number format' }));
      return;
    }
    const normalizedBusinessPhone = norm.e164 ?? '';

    setSavingBusiness(true);
    try {
      await api.put('/settings/business', {
        business_name: form.businessName,
        timezone: form.timezone,
        currency: form.currency,
        country: form.countryCode,
        billing_type: form.billingType,
        tables_required: form.tablesRequired,
        tax_registered: form.taxRegistered,
        tax_registration_number: form.taxRegistrationNumber,
        business_address: form.businessAddress,
        business_phone: normalizedBusinessPhone,
        instagram_handle: form.instagramHandle,
        currency_display: form.currencyDisplay,
        number_digits: form.numberDigits,
        calendar: form.calendar,
      });
      if (savedBusiness.countryCode !== form.countryCode) {
        const taxSetting = await api.get('/settings/taxes_enabled').catch(() => null);
        if (taxSetting?.data.setting?.value === 'true') {
          try {
            await api.post('/tax-packs/ensure-country', { country: form.countryCode });
          } catch (error) {
            const status = (error as { response?: { status?: number } }).response?.status;
            if (status === 404) {
              const key = `tax_plugin_request:${form.countryCode}`;
              const requestSetting = await api.get(`/settings/${key}`).catch(() => null);
              const clientTicketId = requestSetting?.data.setting?.value || crypto.randomUUID();
              if (!requestSetting?.data.setting?.value) {
                await api.put(`/settings/${key}`, { value: clientTicketId });
              }
              await api.post('/support-ticket', {
                client_ticket_id: clientTicketId,
                subject: `Request tax support for ${form.countryCode}`,
                event_code: 'tax.country_plugin_unavailable',
                message: `The merchant changed country to ${form.countryCode} while taxes were enabled, but no verified country tax plugin is available. Please create and publish it.`,
                diagnostics: { country: form.countryCode },
              }).catch(() => {});
              await api.put('/settings/taxes_enabled', { value: 'false' }).catch(() => {});
              toast.error(t('settings.taxSupportUnavailable', { country: form.countryCode }));
            } else {
              toast.error(t('settings.countrySavedTaxPluginFailed'));
            }
          }
        }
      }
      const updatedForm = { ...form, businessPhone: normalizedBusinessPhone };
      setSavedBusiness(updatedForm);
      setForm(updatedForm);
      posSettings.setBillTaxRegistrationNumber(form.taxRegistrationNumber);
      posSettings.setBillAddress(form.businessAddress);
      posSettings.setBillPhone(normalizedBusinessPhone);
      posSettings.setBillingType(form.billingType);
      posSettings.setTablesRequired(form.tablesRequired);
      updateCurrentTenant({ currency: form.currency, timezone: form.timezone, country: form.countryCode, currency_display: form.currencyDisplay, number_digits: form.numberDigits, calendar: form.calendar });
      if (!silent) toast.success(t('settings.storeSaved'));
    } catch (err) {
      if (!silent) {
        const message = t('settings.saveFailed');
        toast.error(message);
      }
      throw err;
    } finally {
      setSavingBusiness(false);
    }
  };

  const saveOrderNumbering = async (silent = false) => {
    const prefix = orderNumberForm.prefix.trim();
    if (prefix && !/^[A-Za-z0-9_-]{0,12}$/.test(prefix)) {
      toast.error(t('settings.orderNumberPrefixInvalid', { defaultValue: 'Prefix must be up to 12 characters (letters, numbers, - or _)' }));
      return;
    }
    const invoicePrefix = orderNumberForm.invoicePrefix.trim();
    if (invoicePrefix && !/^[A-Za-z0-9_-]{0,12}$/.test(invoicePrefix)) {
      toast.error(t('settings.invoiceNumberPrefixInvalid', { defaultValue: 'Invoice prefix must be up to 12 characters (letters, numbers, - or _)' }));
      return;
    }
    setSavingOrderNumbering(true);
    try {
      await api.put('/settings/order-numbering', {
        order_number_prefix: prefix,
        order_number_include_date: orderNumberForm.includeDate,
        order_number_reset_daily: orderNumberForm.resetDaily,
        invoice_number_prefix: invoicePrefix,
        invoice_number_include_period: orderNumberForm.invoiceIncludePeriod,
        invoice_number_reset_period: orderNumberForm.invoiceResetPeriod,
        invoice_financial_year_start_month: orderNumberForm.invoiceFinancialYearStartMonth,
        invoice_financial_year_start_day: orderNumberForm.invoiceFinancialYearStartDay,
      });
      const saved = { ...orderNumberForm, prefix, invoicePrefix };
      setOrderNumberForm(saved);
      setSavedOrderNumberForm(saved);
      if (!silent) toast.success(t('settings.orderNumberingSaved', { defaultValue: 'Numbering settings saved' }));
    } catch (err) {
      if (!silent) toast.error(t('settings.saveFailed'));
      throw err;
    } finally {
      setSavingOrderNumbering(false);
    }
  };

  const resetAllSettings = async () => {
    resetPrinting();
    resetBillTemplate();
    resetCloud();
    await resetBusiness();
  };

  const saveAllSettings = async () => {
    try {
      await Promise.all([saveBusinessInfo(true), saveLoyalty(true), saveDiscount(true), saveCloud(true), saveOrderNumbering(true)]);
      await savePrinting(true);
      await saveBillTemplate(true);
      toast.success(t('settings.allSaved'));
    } catch {
      toast.error(t('settings.allSaveFailed'));
    }
  };

  const rotatePairingCode = async () => {
    setRotatingCode(true);
    try {
      const res = await api.post('/mobile/rotate-code');
      setPairingCode(res.data.pairing_code);
      setPairingExpiresAt(res.data.expires_at);
      setPairingQrDataUrl(res.data.qr_data_url || null);
      setPairingUnavailable(false);
      toast.success(t('settings.pairingCodeRotated'));
      loadPairedDevices();
    } catch {
      // Show a localized failure; the specific backend reason stays in logs.
      toast.error(t('settings.pairingCodeFailed'));
    } finally {
      setRotatingCode(false);
    }
  };

  const copyPairingCode = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode.toUpperCase()).then(() => {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    });
  };

  const paperSizeOptions: { value: PaperSize; label: string }[] = [
    { value: 'thermal58', label: t('settings.paperSize58') },
    { value: 'thermal80', label: t('settings.paperSize80') },
  ];

  const isDirty = 
    JSON.stringify(form) !== JSON.stringify(savedBusiness) ||
    JSON.stringify(printingForm) !== JSON.stringify(savedPrinting) ||
    JSON.stringify(billForm) !== JSON.stringify(savedBillForm) ||
    loyaltyEnabled !== savedLoyaltyEnabled ||
    globalCashbackPercent !== savedGlobalCashbackPercent ||
    discountMaxPct !== savedDiscountMaxPct ||
    discountMaxAmount !== savedDiscountMaxAmount ||
    discountMode !== savedDiscountMode ||
    discountRequiresApproval !== savedDiscountRequiresApproval ||
    JSON.stringify(cloudSettings) !== JSON.stringify(savedCloudSettings);

  useEffect(() => {
    if (!isDirty) return;

    // Block browser reload/close
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Block Next.js client-side navigation (clicking links)
    const handleClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('a');
      if (target && target.href && !target.href.includes(window.location.pathname) && target.target !== '_blank') {
        e.preventDefault();
        e.stopPropagation();
        setShakeSaveBar(true);
        setTimeout(() => setShakeSaveBar(false), 500);
      }
    };
    document.addEventListener('click', handleClick, { capture: true });

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleClick, { capture: true });
    };
  }, [isDirty]);

  return (
    <div>
      <Tabs orientation="vertical" value={activeTab} onValueChange={setActiveTab} className="flex flex-col md:flex-row gap-6 items-start">

        {/* Settings sidebar nav */}
        <div className="w-full md:w-40 md:min-w-[10rem] shrink-0 md:sticky md:top-0">
          <div className="flex items-center gap-3 mb-6">
            <Settings size={28} className="text-brand" />
            <h1 className="text-2xl font-bold text-gray-900">{t('settings.title')}</h1>
          </div>

           <nav className="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-x-visible border-b md:border-b-0 md:border-e border-gray-200 pb-2 md:pb-0 md:pe-2">

            {/* General group */}
            <div className="hidden md:block px-3 pt-3 pb-2 mt-2 mb-1 border-b border-gray-100">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('settings.navGroupGeneral')}</p>
            </div>
            <SettingsNavItem label={t('settings.storeDetails')} value="store" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.tabPrinters')} value="receipts-printers" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.paymentMethods', { defaultValue: 'Payments' })} value="payments" active={activeTab} onClick={setActiveTab} />
            {canViewTaxConfiguration && (
              <SettingsNavItem label={t('settings.taxConfiguration')} value="tax" active={activeTab} onClick={setActiveTab} />
            )}

            {/* Operations group */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-gray-100">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('settings.navGroupOperations')}</p>
            </div>
            <SettingsNavItem label={t('settings.posWorkflow')} value="pos" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.tabKds')} value="kds" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.tablesideOrdering')} value="server-app" active={activeTab} onClick={setActiveTab} />
            {/* WhatsApp opt-in lives under Operations because the receive-bill
                workflow is what the cashier touches every time a customer pays. */}
            <SettingsNavItem label={t('settings.tabWhatsapp')} value="whatsapp" active={activeTab} onClick={setActiveTab} />

            {/* Customers group */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-gray-100">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('settings.navGroupCustomers')}</p>
            </div>
            <SettingsNavItem label={t('settings.loyalty')} value="loyalty" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.discounts')} value="discounts" active={activeTab} onClick={setActiveTab} />

            {/* Integrations group (formerly "Data") */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-gray-100">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('settings.navGroupData')}</p>
            </div>
            <SettingsNavItem label={t('settings.tabMobileAccess')} value="mobile-access" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.tabBackupData')} value="data" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.tabOrderflow')} value="orderflow" active={activeTab} onClick={setActiveTab} />

            {/* Account group */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-gray-100">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('settings.navGroupAccount')}</p>
            </div>
            <SettingsNavItem label={t('settings.account')} value="account" active={activeTab} onClick={setActiveTab} attention={cloudDeletionNeedsAction || (cloudAccountAvailable && Boolean(cloudAccount?.email && !cloudAccount?.verified))} />
            <SettingsNavItem label={t('settings.privacy')} value="privacy" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.tabUpdates')} value="updates" active={activeTab} onClick={setActiveTab} />
            <SettingsNavItem label={t('settings.tabAbout')} value="about" active={activeTab} onClick={setActiveTab} />

          </nav>
        </div>

        <div className="flex-1 min-w-0 overflow-hidden pb-32">

        <TabsContent value="store">
          <div className="pb-6 max-w-3xl space-y-6">
            {/* Store Details — editable for admin, readonly otherwise */}
            <div className="lg:col-span-2 bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Building2 size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.storeDetails')}</h2>
                {!isAdmin && (
                  <span className="ms-auto flex items-center gap-1 text-xs text-gray-400">
                    <Lock size={12} /> {t('settings.adminOnly')}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.businessName')}</label>
                  {isAdmin ? (
                    <input type="text" value={form.businessName} onChange={(e) => setForm((p) => ({ ...p, businessName: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                  ) : (
                    <p className="font-medium text-gray-900">{form.businessName || currentTenant?.business_name}</p>
                  )}
                </div>
                {/* Country, Timezone, Currency in single line with individual headings */}
                <div className="md:col-span-2 space-y-2">
                  {/* Headings */}
                  <div className="grid grid-cols-3 gap-2">
                    <label className="text-sm text-gray-500">{t('settings.country')}</label>
                    <label className="text-sm text-gray-500">{t('settings.timezone')}</label>
                    <label className="text-sm text-gray-500">{t('settings.currency')}</label>
                  </div>
                  
                  {/* Input fields */}
                  {isAdmin ? (
                    <div className="grid grid-cols-3 gap-2">
                      <select
                        value={form.countryCode}
                        onChange={(e) => {
                          const country = COUNTRIES.find(c => c.code === e.target.value);
                          setForm((p) => ({
                            ...p,
                            countryCode: e.target.value,
                            currency: country?.currency || p.currency,
                            timezone: country?.timezone || p.timezone,
                          }));
                        }}
                        aria-label={t('common.search')}
                        className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-white"
                      >
                        <option value="">{t('settings.selectCountry')}</option>
                        {COUNTRIES.map((c) => (
                          <option key={c.code} value={c.code}>{countryName(c.code)}</option>
                        ))}
                      </select>
                      <input 
                        type="text" 
                        value={form.timezone} 
                        onChange={(e) => setForm((p) => ({ ...p, timezone: e.target.value }))}
                        placeholder={t('settings.timezoneAutoFilled')}
                        className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-gray-50" 
                        readOnly
                        dir="ltr"
                      />
                      <input 
                        type="text" 
                        value={form.currency} 
                        onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
                        placeholder={t('settings.currencyAutoFilled')}
                        className="px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-gray-50" 
                        readOnly
                        dir="ltr"
                      />
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      <p className="font-medium text-gray-900">
                        {form.countryCode ? countryName(form.countryCode) : '—'}
                      </p>
                      <p className="font-medium text-gray-900">
                        <Ltr>{form.timezone || '—'}</Ltr>
                      </p>
                      <p className="font-medium text-gray-900">
                        <Ltr>{form.currency || '—'}</Ltr>
                      </p>
                    </div>
                  )}
                </div>
                <LocalePreferencesPanel
                  options={getCountryByCode(form.countryCode)?.localeOptions}
                  currencyDisplay={form.currencyDisplay}
                  digits={form.numberDigits}
                  calendar={form.calendar}
                  isAdmin={isAdmin}
                  onChange={(patch) => setForm((p) => ({
                    ...p,
                    ...(patch.currencyDisplay !== undefined ? { currencyDisplay: patch.currencyDisplay } : {}),
                    ...(patch.digits !== undefined ? { numberDigits: patch.digits } : {}),
                    ...(patch.calendar !== undefined ? { calendar: patch.calendar } : {}),
                  }))}
                />
                <div>
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.billingType')}</label>
                  {isAdmin ? (
                    <select value={form.billingType}
                      onChange={(e) => setForm((p) => ({ ...p, billingType: e.target.value as 'postpaid' | 'prepaid' }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-white">
                      <option value="postpaid">{t('settings.billingTypePostpaid')}</option>
                      <option value="prepaid">{t('settings.billingTypePrepaid')}</option>
                    </select>
                  ) : (
                    <p className="font-medium text-gray-900 capitalize">{form.billingType}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.tablesRequired')}</label>
                  {isAdmin ? (
                    <select
                      value={form.tablesRequired ? 'yes' : 'no'}
                      onChange={(e) => setForm((p) => ({ ...p, tablesRequired: e.target.value === 'yes' }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-white"
                    >
                      <option value="yes">{t('settings.tablesRequiredYes')}</option>
                      <option value="no">{t('settings.tablesRequiredNo')}</option>
                    </select>
                  ) : (
                    <p className="font-medium text-gray-900">{form.tablesRequired ? t('settings.yes') : t('settings.no')}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.taxRegistered', { defaultValue: 'Tax Registered' })}</label>
                  {isAdmin ? (
                    <select
                      value={form.taxRegistered ? 'yes' : 'no'}
                      onChange={(e) => setForm((p) => ({ ...p, taxRegistered: e.target.value === 'yes' }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-white"
                    >
                      <option value="yes">{t('settings.yes')}</option>
                      <option value="no">{t('settings.no')}</option>
                    </select>
                  ) : (
                    <p className="font-medium text-gray-900">{form.taxRegistered ? t('settings.yes') : t('settings.no')}</p>
                  )}
                </div>
                {form.taxRegistered ? (
                  <div>
                    <label className="block text-sm text-gray-500 mb-1">{t('settings.taxIdLabel')}</label>
                    {isAdmin ? (
                      <input type="text" value={form.taxRegistrationNumber} onChange={(e) => setForm((p) => ({ ...p, taxRegistrationNumber: e.target.value }))}
                        placeholder={t('settings.taxIdPlaceholder')}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand" dir="ltr" />
                    ) : (
                      <p className="font-medium text-gray-900"><Ltr>{form.taxRegistrationNumber || '—'}</Ltr></p>
                    )}
                  </div>
                ) : <div className="hidden md:block" />}
                <div>
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.phone')}</label>
                  {isAdmin ? (
                    <input type="text" value={form.businessPhone} onChange={(e) => setForm((p) => ({ ...p, businessPhone: e.target.value }))}
                      placeholder={t('settings.phonePlaceholder', { dialCode: dialCodeFor(form.countryCode) || '+1', defaultValue: '+1 555 000 0000' })}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand" dir="ltr" />
                  ) : (
                    <p className="font-medium text-gray-900"><Ltr>{form.businessPhone || '—'}</Ltr></p>
                  )}
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.address')}</label>
                  {isAdmin ? (
                    <textarea value={form.businessAddress} onChange={(e) => setForm((p) => ({ ...p, businessAddress: e.target.value }))}
                      rows={2} placeholder={t('settings.addressPlaceholder')}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand resize-none" />
                  ) : (
                    <p className="font-medium text-gray-900">{form.businessAddress || '—'}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.instagramHandle')}</label>
                  {isAdmin ? (
                    <input type="text" value={form.instagramHandle} onChange={(e) => setForm((p) => ({ ...p, instagramHandle: e.target.value }))}
                      placeholder={t('settings.instagramPlaceholder')}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                  ) : (
                    <p className="font-medium text-gray-900">{form.instagramHandle || '—'}</p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">{t('settings.instagramHint')}</p>
                </div>
              </div>

              {isAdmin && (
                <div className="mt-4 flex gap-2">
                </div>
              )}
            </div>

            {/* Number Formats */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Hash size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.orderNumberFormat', { defaultValue: 'Number Formats' })}</h2>
                {!isAdmin && (
                  <span className="ms-auto flex items-center gap-1 text-xs text-gray-400">
                    <Lock size={12} /> {t('settings.adminOnly')}
                  </span>
                )}
              </div>

              <h3 className="text-sm font-semibold text-gray-800 mb-3">{t('settings.orderNumbers', { defaultValue: 'Order numbers' })}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.orderNumberPrefix', { defaultValue: 'Prefix' })}</label>
                  {isAdmin ? (
                    <input
                      type="text"
                      value={orderNumberForm.prefix}
                      onChange={(e) => setOrderNumberForm((p) => ({ ...p, prefix: e.target.value.toUpperCase() }))}
                      placeholder="ORD"
                      maxLength={12}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    />
                  ) : (
                    <p className="font-medium text-gray-900">{orderNumberForm.prefix || '—'}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-gray-500 mb-1">{t('settings.orderNumberPreview', { defaultValue: 'Preview' })}</label>
                  <p className="font-mono font-medium text-gray-900 px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                    <Ltr>{[
                      orderNumberForm.prefix,
                      orderNumberForm.includeDate ? new Date().toISOString().slice(0, 10).replace(/-/g, '') : '',
                      '0001',
                    ].filter(Boolean).join('-')}</Ltr>
                  </p>
                </div>
              </div>

              <div className="mt-5 pt-5 border-t border-gray-100 space-y-3">
                <div className="flex items-center justify-between py-2">
                  <div>
                    <span className="text-sm text-gray-700">{t('settings.orderNumberIncludeDate', { defaultValue: 'Include date in order number' })}</span>
                    <p className="text-xs text-gray-500">{t('settings.orderNumberIncludeDateHint', { defaultValue: 'Adds the current date (YYYYMMDD) after the prefix.' })}</p>
                  </div>
                  <Toggle
                    value={orderNumberForm.includeDate}
                    onChange={isAdmin ? (v) => setOrderNumberForm((p) => ({ ...p, includeDate: v })) : () => {}}
                  />
                </div>
                <div className="flex items-center justify-between py-2">
                  <div>
                    <span className="text-sm text-gray-700">{t('settings.orderNumberResetDaily', { defaultValue: 'Reset series every 24 hours' })}</span>
                    <p className="text-xs text-gray-500">{t('settings.orderNumberResetDailyHint', { defaultValue: 'Numbering restarts from 1 at midnight in the store’s timezone.' })}</p>
                  </div>
                  <Toggle
                    value={orderNumberForm.resetDaily}
                    onChange={isAdmin ? (v) => setOrderNumberForm((p) => ({ ...p, resetDaily: v })) : () => {}}
                  />
                </div>
              </div>

              <div className="mt-6 pt-5 border-t border-gray-100">
                <h3 className="text-sm font-semibold text-gray-800 mb-3">{t('settings.invoiceNumbers', { defaultValue: 'Invoice numbers' })}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-500 mb-1">{t('settings.invoiceNumberPrefix', { defaultValue: 'Prefix' })}</label>
                    {isAdmin ? (
                      <input
                        type="text"
                        value={orderNumberForm.invoicePrefix}
                        onChange={(e) => setOrderNumberForm((p) => ({ ...p, invoicePrefix: e.target.value.toUpperCase() }))}
                        placeholder="INV"
                        maxLength={12}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand"
                      />
                    ) : (
                      <p className="font-medium text-gray-900">{orderNumberForm.invoicePrefix || '—'}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-gray-500 mb-1">{t('settings.invoiceNumberPreview', { defaultValue: 'Preview' })}</label>
                    <p className="font-mono font-medium text-gray-900 px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <Ltr>{[
                        orderNumberForm.invoicePrefix,
                        orderNumberForm.invoiceIncludePeriod ? invoicePreviewSegment(
                          orderNumberForm.invoiceResetPeriod,
                          orderNumberForm.invoiceFinancialYearStartMonth,
                          orderNumberForm.invoiceFinancialYearStartDay,
                        ) : '',
                        '0001',
                      ].filter(Boolean).join('-')}</Ltr>
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-500 mb-1">{t('settings.invoiceResetPeriod', { defaultValue: 'Reset series' })}</label>
                    {isAdmin ? (
                      <select
                        value={orderNumberForm.invoiceResetPeriod}
                        onChange={(e) => setOrderNumberForm((p) => ({ ...p, invoiceResetPeriod: e.target.value as InvoiceResetPeriod }))}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand bg-white"
                      >
                        <option value="daily">{t('settings.invoiceResetDaily', { defaultValue: 'Daily' })}</option>
                        <option value="monthly">{t('settings.invoiceResetMonthly', { defaultValue: 'Monthly' })}</option>
                        <option value="financial_year">{t('settings.invoiceResetFinancialYear', { defaultValue: 'Financial year' })}</option>
                        <option value="never">{t('settings.invoiceResetNever', { defaultValue: 'Never' })}</option>
                      </select>
                    ) : (
                      <p className="font-medium text-gray-900">{orderNumberForm.invoiceResetPeriod.replace('_', ' ')}</p>
                    )}
                  </div>
                  {orderNumberForm.invoiceResetPeriod === 'financial_year' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm text-gray-500 mb-1">{t('settings.financialYearStartMonth', { defaultValue: 'FY start month' })}</label>
                        <input
                          type="number"
                          min={1}
                          max={12}
                          value={orderNumberForm.invoiceFinancialYearStartMonth}
                          disabled={!isAdmin}
                          onChange={(e) => setOrderNumberForm((p) => ({ ...p, invoiceFinancialYearStartMonth: Number(e.target.value) }))}
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand disabled:bg-gray-50"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-500 mb-1">{t('settings.financialYearStartDay', { defaultValue: 'FY start day' })}</label>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={orderNumberForm.invoiceFinancialYearStartDay}
                          disabled={!isAdmin}
                          onChange={(e) => setOrderNumberForm((p) => ({ ...p, invoiceFinancialYearStartDay: Number(e.target.value) }))}
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand disabled:bg-gray-50"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-5 pt-5 border-t border-gray-100">
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <span className="text-sm text-gray-700">{t('settings.invoiceNumberIncludePeriod', { defaultValue: 'Include period in invoice number' })}</span>
                      <p className="text-xs text-gray-500">{t('settings.invoiceNumberIncludePeriodHint', { defaultValue: 'Adds the date, month, or financial year after the prefix.' })}</p>
                    </div>
                    <Toggle
                      value={orderNumberForm.invoiceIncludePeriod}
                      onChange={isAdmin ? (v) => setOrderNumberForm((p) => ({ ...p, invoiceIncludePeriod: v })) : () => {}}
                    />
                  </div>
                </div>
              </div>
            </div>


            {/* Subscription */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <CreditCard size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.subscription')}</h2>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-500">{t('settings.plan')}</p>
                  <p className="font-medium text-gray-900 capitalize">{currentTenant?.plan}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">{t('settings.status')}</p>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                    currentTenant?.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {t(TENANT_STATUS_LABEL_KEYS[currentTenant?.status ?? ''] ?? currentTenant?.status ?? '')}
                  </span>
                </div>
                <div>
                  <p className="text-sm text-gray-500 mb-1">{t('settings.languages')}</p>
                  <select
                    value={language}
                    onChange={(e) => {
                      const lang = e.target.value as Language;
                      setLanguage(lang);
                      api.put('/settings/business', { language: lang }).catch(() => toast.error(t('settings.saveFailed')));
                    }}
                    className="block w-full rounded-md border-gray-200 shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                  >
                    <option value="en">{t('settings.languageEn')}</option>
                    <option value="es">{t('settings.languageEs')}</option>
                    <option value="pt">{t('settings.languagePt')}</option>
                  </select>
                </div>
              </div>
            </div>

            
          </div>
        </TabsContent>

        <TabsContent value="payments">
          <PaymentMethodsSettings isAdmin={isAdmin} />
        </TabsContent>

        {canViewTaxConfiguration && (
          <TabsContent value="tax">
            <TaxConfigurationPanel isOwner={currentTenant?.role === 'owner'} />
          </TabsContent>
        )}

        <TabsContent value="pos">
          <div className="pb-6 max-w-3xl space-y-6">
            {/* POS Display */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Monitor size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.posDisplay')}</h2>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900">{t('settings.showProductImages')}</p>
                  <p className="text-sm text-gray-500">{t('settings.showProductImagesHint')}</p>
                </div>
                <Toggle value={posSettings.showProductImages} onChange={(v) => {
                  posSettings.setShowProductImages(v);
                  toast.success(v ? t('settings.productImagesEnabled', { defaultValue: 'Product images enabled' }) : t('settings.productImagesDisabled', { defaultValue: 'Product images disabled' }), { id: 'pos-local' });
                }} />
              </div>
            </div>

            {/* POS Workflow */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Users size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.posWorkflow')}</h2>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t('settings.customerMandatory')}</p>
                    <p className="text-sm text-gray-500">{t('settings.customerMandatoryHint')}</p>
                  </div>
                  <Toggle value={posSettings.customerMandatory} onChange={(v) => {
                    posSettings.setCustomerMandatory(v);
                    toast.success(v ? t('settings.customerMandatoryEnabled', { defaultValue: 'Mandatory customer enabled' }) : t('settings.customerMandatoryDisabled', { defaultValue: 'Mandatory customer disabled' }), { id: 'pos-local' });
                  }} />
                </div>
                <p className="text-sm text-gray-500">{t('settings.phoneDigitsDerived')}</p>
                <div className="flex items-center justify-between gap-4 pt-2 border-t border-gray-100">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t('settings.enforcePhoneLength', { defaultValue: 'Enforce Phone Number Length' })}</p>
                    <p className="text-sm text-gray-500">{t('settings.enforcePhoneLengthHint', { defaultValue: 'Automatically jump to the Name field once a valid phone number for your country has been typed — e.g. 10 digits for India.' })}</p>
                  </div>
                  <Toggle value={posSettings.enforcePhoneLength} onChange={(v) => {
                    posSettings.setEnforcePhoneLength(v);
                    toast.success(v ? t('settings.enforcePhoneLengthEnabled', { defaultValue: 'Phone length enforcement enabled' }) : t('settings.enforcePhoneLengthDisabled', { defaultValue: 'Phone length enforcement disabled' }), { id: 'pos-local' });
                  }} />
                </div>
              </div>
            </div>

            {/* Add a cashier — pair another device onto the same POS over the local network */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Smartphone size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.posPairing')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-5">
                {t('settings.posPairingHint')}
              </p>

              {posInfoLoading && (
                <div className="flex items-center justify-center py-10">
                  <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {posInfo && !posInfoLoading && (
                <div className="flex flex-col gap-6 w-full">
                  {posInfo.ips_data && posInfo.ips_data.length > 0 ? (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
                        {posInfo.ips_data.map((ipInfo: { ip: string; url: string; qr_data: string | null }, idx: number) => (
                          <div key={idx} className="flex flex-col items-center p-4 bg-gray-50 border border-gray-200 rounded-lg">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                              {ipInfo.ip.startsWith('100.') ? t('settings.vpnMeshNetwork') : t('settings.localNetwork')}
                            </p>
                            {ipInfo.qr_data ? (
                              <img src={ipInfo.qr_data} alt={`QR Code for ${ipInfo.ip}`} className="w-40 h-40 rounded-lg mb-3 bg-white p-2 border border-gray-100" />
                            ) : (
                              <div className="w-40 h-40 bg-gray-100 rounded-lg flex items-center justify-center mb-3">
                                <QrCode size={40} className="text-gray-400" />
                              </div>
                            )}
                            <Ltr as="a" href={ipInfo.url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-brand hover:underline break-all text-center">
                              {ipInfo.url}
                            </Ltr>
                          </div>
                        ))}
                      </div>
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex-1">
                            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">{t('settings.appleDevices')}</p>
                            <Ltr as="a" href={posInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 break-all hover:underline">
                              {posInfo.mdns_url}
                            </Ltr>
                            <p className="text-xs text-blue-600 mt-2">
                              {t('settings.appleDevicesHint')}
                            </p>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-6 items-start">
                      <div className="shrink-0">
                        {posInfo.qr_data_url ? (
                          <img src={posInfo.qr_data_url} alt={t('settings.posQrAlt')} className="w-48 h-48 rounded-xl border border-gray-200" />
                        ) : (
                          <div className="w-48 h-48 rounded-xl border border-gray-200 flex items-center justify-center text-gray-400">
                            <QrCode size={48} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 space-y-4">
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('settings.directIp')}</p>
                          <Ltr as="a" href={posInfo.ip_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-brand break-all hover:underline">
                            {posInfo.ip_url}
                          </Ltr>
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('settings.mdnsAlwaysStable')}</p>
                          <Ltr as="a" href={posInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-gray-700 break-all hover:underline">
                            {posInfo.mdns_url}
                          </Ltr>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end border-t border-gray-200 pt-4">
                    <button onClick={fetchPosInfo} disabled={posInfoLoading}
                      className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800">
                      <RefreshCw size={14} className={posInfoLoading ? 'animate-spin' : ''} />
                      {t('settings.refreshUrls')}
                    </button>
                  </div>
                </div>
              )}

              {!posInfo && !posInfoLoading && (
                <>
                  <p className="text-sm text-gray-500 mb-3">
                    {t('settings.posLoadHint')}
                  </p>
                  <button onClick={fetchPosInfo}
                    className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium">
                    {t('settings.loadPosInfo')}
                  </button>
                </>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Kitchen Display — own tab under Operations */}
        <TabsContent value="kds">
          <div className="pb-6 max-w-3xl space-y-6">
            {/* KDS on/off (issue #133) — not every business runs a Kitchen Display. */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900">{t('settings.kdsEnabledToggle', { defaultValue: 'Kitchen Display System' })}</p>
                  <p className="text-sm text-gray-500">{t('settings.kdsEnabledToggleHint', { defaultValue: 'Show the Kitchen Display and allow devices to pair over your network. Turn this off if this business doesn’t use a KDS.' })}</p>
                </div>
                <Toggle value={kdsEnabledSetting} onChange={(v) => { if (!savingKdsEnabled) saveKdsEnabled(v); }} />
              </div>
              {!kdsEnabledSetting && !kotPrintingEnabledSetting && (
                <div className="mt-4 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800">
                    {t('settings.kitchenWorkflowBothOffNote', { defaultValue: 'Both the Kitchen Display and KOT printing are off. Kitchen items won’t display or print anywhere — orders will need to be marked served directly at the counter.' })}
                  </p>
                </div>
              )}
            </div>

            {!kdsEnabledSetting && (
              <p className="text-sm text-gray-400 italic">
                {t('settings.kdsPairingHiddenHint', { defaultValue: 'Pairing is hidden while the Kitchen Display System is disabled.' })}
              </p>
            )}

            {kdsEnabledSetting && (
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <ChefHat size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.kds')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-5">
                {t('settings.kdsPairingHint')}
              </p>

              {kdsInfoLoading && (
                <div className="flex items-center justify-center py-10">
                  <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {kdsInfo && !kdsInfoLoading && (
                <div className="flex flex-col gap-6 w-full">
                  {kdsInfo.ips_data && kdsInfo.ips_data.length > 0 ? (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
                        {kdsInfo.ips_data.map((ipInfo: { ip: string; url: string; qr_data: string | null }, idx: number) => (
                          <div key={idx} className="flex flex-col items-center p-4 bg-gray-50 border border-gray-200 rounded-lg">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                              {ipInfo.ip.startsWith('100.') ? t('settings.vpnMeshNetwork') : t('settings.localNetwork')}
                            </p>
                            {ipInfo.qr_data ? (
                              <img src={ipInfo.qr_data} alt={`QR Code for ${ipInfo.ip}`} className="w-40 h-40 rounded-lg mb-3 bg-white p-2 border border-gray-100" />
                            ) : (
                              <div className="w-40 h-40 bg-gray-100 rounded-lg flex items-center justify-center mb-3">
                                <QrCode size={40} className="text-gray-400" />
                              </div>
                            )}
                            <Ltr as="a" href={ipInfo.url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-brand hover:underline break-all text-center">
                              {ipInfo.url}
                            </Ltr>
                          </div>
                        ))}
                      </div>
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex-1">
                            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">{t('settings.appleDevices')}</p>
                            <Ltr as="a" href={kdsInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 break-all hover:underline">
                              {kdsInfo.mdns_url}
                            </Ltr>
                            <p className="text-xs text-blue-600 mt-2">
                              {t('settings.appleDevicesHint')}
                            </p>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-6 items-start">
                      <div className="shrink-0">
                        {kdsInfo.qr_data_url ? (
                          <img src={kdsInfo.qr_data_url} alt={t('settings.kdsQrAlt')} className="w-48 h-48 rounded-xl border border-gray-200" />
                        ) : (
                          <div className="w-48 h-48 rounded-xl border border-gray-200 flex items-center justify-center text-gray-400">
                            <QrCode size={48} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 space-y-4">
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('settings.directIp')}</p>
                          <Ltr as="a" href={kdsInfo.ip_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-brand break-all hover:underline">
                            {kdsInfo.ip_url}
                          </Ltr>
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('settings.mdnsAlwaysStable')}</p>
                          <Ltr as="a" href={kdsInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-gray-700 break-all hover:underline">
                            {kdsInfo.mdns_url}
                          </Ltr>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end border-t border-gray-200 pt-4">
                    <button onClick={fetchKdsInfo} disabled={kdsInfoLoading}
                      className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800">
                      <RefreshCw size={14} className={kdsInfoLoading ? 'animate-spin' : ''} />
                      {t('settings.refreshUrls')}
                    </button>
                  </div>
                </div>
              )}

              {!kdsInfo && !kdsInfoLoading && (
                <>
                  <p className="text-sm text-gray-500 mb-3">
                    {t('settings.kdsLoadHint', { defaultValue: 'Load connection details to pair kitchen display devices on your local network.' })}
                  </p>
                  <button onClick={fetchKdsInfo}
                    className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium">
                    {t('settings.loadKdsInfo')}
                  </button>
                </>
              )}
            </div>
            )}

            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <ChefHat size={20} className="text-gray-500" />
                  <h2 className="font-semibold text-gray-900">{t('settings.kitchenStations')}</h2>
                </div>
                <button onClick={openAddStation}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium">
                  <Plus size={14} />
                  {t('settings.addStation')}
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-5">{t('settings.kitchenStationsHint')}</p>

              {stations.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">{t('settings.noStationsYet')}</p>
              ) : (
                <div className="space-y-2">
                  {stations.map((station) => {
                    let categoryIds: string[] = [];
                    try { categoryIds = station.category_ids ? JSON.parse(station.category_ids) : []; } catch { categoryIds = []; }
                    const categoryNames = categoryIds
                      .map((id) => stationCategories.find((c) => c.id === id)?.name)
                      .filter(Boolean);
                    const printer = hwPrinters.find((p) => p.id === station.printer_id);
                    const users = stationUsersByStation[station.id] || [];
                    return (
                      <div key={station.id} className="flex items-center justify-between p-3 border border-gray-100 rounded-lg">
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900">{station.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {categoryNames.length > 0 ? categoryNames.join(', ') : t('settings.stationNoCategories')}
                            {' · '}
                            {printer ? printer.name : t('settings.stationNoPrinter')}
                            {users.length > 0 && ` · ${users.map((u) => u.name).join(', ')}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => openEditStation(station)}
                            className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded">
                            {t('common.edit')}
                          </button>
                          <button onClick={() => deleteStation(station.id)}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {showStationForm && (
                <Dialog open={showStationForm} onOpenChange={setShowStationForm}>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{editingStationId ? t('settings.editStation') : t('settings.addStation')}</DialogTitle>
                      <DialogDescription>{t('settings.stationFormHint')}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.stationName')}</label>
                        <input type="text" value={stationForm.name}
                          onChange={(e) => setStationForm((f) => ({ ...f, name: e.target.value }))}
                          placeholder={t('settings.stationNamePlaceholder')}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.stationCategories')}</label>
                        {stationCategories.length === 0 ? (
                          <p className="text-xs text-gray-400">{t('settings.noCategoriesYet')}</p>
                        ) : (
                          <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                            {stationCategories.map((cat) => (
                              <label key={cat.id} className="flex items-center gap-1.5 px-2.5 py-1 border border-gray-200 rounded-full text-xs cursor-pointer hover:bg-gray-50">
                                <input type="checkbox" checked={stationForm.category_ids.includes(cat.id)}
                                  onChange={() => toggleStationFormValue('category_ids', cat.id)}
                                  className="rounded border-gray-300 text-brand focus:ring-brand" />
                                {cat.name}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.stationPrinter')}</label>
                        <select value={stationForm.printer_id}
                          onChange={(e) => setStationForm((f) => ({ ...f, printer_id: e.target.value }))}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                          <option value="">{t('settings.stationUseDefaultPrinter')}</option>
                          {hwPrinters.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.stationStaff')}</label>
                        {stationStaff.length === 0 ? (
                          <p className="text-xs text-gray-400">{t('settings.noStaffYet')}</p>
                        ) : (
                          <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                            {stationStaff.map((u) => (
                              <label key={u.id} className="flex items-center gap-1.5 px-2.5 py-1 border border-gray-200 rounded-full text-xs cursor-pointer hover:bg-gray-50">
                                <input type="checkbox" checked={stationForm.user_ids.includes(u.id)}
                                  onChange={() => toggleStationFormValue('user_ids', u.id)}
                                  className="rounded border-gray-300 text-brand focus:ring-brand" />
                                {u.name}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setShowStationForm(false)}>{t('common.cancel')}</Button>
                      <Button onClick={saveStation} disabled={savingStation}>
                        {savingStation ? t('common.saving') : t('common.save')}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>

            <KdsDefaultViewCard />

            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
              <strong>{t('settings.howItWorks')}</strong> {t('settings.howItWorksBody')}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="server-app">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900">{t('settings.serverApp', { defaultValue: 'Server App' })}</p>
                  <p className="text-sm text-gray-500">
                    {t('settings.serverAppEnabledHint', { defaultValue: 'Let service staff open a mobile/tablet-friendly order pad for tableside ordering.' })}
                  </p>
                </div>
                <Toggle value={serverAppEnabledSetting} onChange={(v) => { if (!savingServerAppEnabled) saveServerAppEnabled(v); }} />
              </div>
            </div>

            {!serverAppEnabledSetting && (
              <p className="text-sm text-gray-400 italic">
                {t('settings.serverAppPairingHiddenHint', { defaultValue: 'Pairing is hidden while the Server App is disabled.' })}
              </p>
            )}

            {serverAppEnabledSetting && (
              <div className="bg-white rounded-xl border border-gray-100 p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Smartphone size={20} className="text-gray-500" />
                  <h2 className="font-semibold text-gray-900">{t('settings.tablesideOrdering', { defaultValue: 'Tableside Ordering' })}</h2>
                </div>
                <p className="text-sm text-gray-500 mb-5">
                  {t('settings.serverAppPairingHint', { defaultValue: 'Pair servers’ phones or tablets on your local network. They can punch table orders and see compact kitchen status icons.' })}
                </p>

                {serverAppInfoLoading && (
                  <div className="flex items-center justify-center py-10">
                    <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                )}

                {serverAppInfo && !serverAppInfoLoading && (
                  <div className="flex flex-col gap-6 w-full">
                    {serverAppInfo.ips_data && serverAppInfo.ips_data.length > 0 ? (
                      <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
                          {serverAppInfo.ips_data.map((ipInfo: { ip: string; url: string; qr_data: string | null }, idx: number) => (
                            <div key={idx} className="flex flex-col items-center p-4 bg-gray-50 border border-gray-200 rounded-lg">
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                                {ipInfo.ip.startsWith('100.') ? t('settings.vpnMeshNetwork') : t('settings.localNetwork')}
                              </p>
                              {ipInfo.qr_data ? (
                                <img src={ipInfo.qr_data} alt={`QR Code for ${ipInfo.ip}`} className="w-40 h-40 rounded-lg mb-3 bg-white p-2 border border-gray-100" />
                              ) : (
                                <div className="w-40 h-40 bg-gray-100 rounded-lg flex items-center justify-center mb-3">
                                  <QrCode size={40} className="text-gray-400" />
                                </div>
                              )}
                              <Ltr as="a" href={ipInfo.url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-brand hover:underline break-all text-center">
                                {ipInfo.url}
                              </Ltr>
                            </div>
                          ))}
                        </div>
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">{t('settings.appleDevices')}</p>
                          <Ltr as="a" href={serverAppInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 break-all hover:underline">
                            {serverAppInfo.mdns_url}
                          </Ltr>
                          <p className="text-xs text-blue-600 mt-2">{t('settings.appleDevicesHint')}</p>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col sm:flex-row gap-6 items-start">
                        <div className="shrink-0">
                          {serverAppInfo.qr_data_url ? (
                            <img src={serverAppInfo.qr_data_url} alt={t('settings.serverAppQrAlt', { defaultValue: 'Server App QR code' })} className="w-48 h-48 rounded-xl border border-gray-200" />
                          ) : (
                            <div className="w-48 h-48 rounded-xl border border-gray-200 flex items-center justify-center text-gray-400">
                              <QrCode size={48} />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 space-y-4">
                          <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('settings.directIp')}</p>
                            <Ltr as="a" href={serverAppInfo.ip_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-brand break-all hover:underline">
                              {serverAppInfo.ip_url}
                            </Ltr>
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{t('settings.mdnsAlwaysStable')}</p>
                            <Ltr as="a" href={serverAppInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-gray-700 break-all hover:underline">
                              {serverAppInfo.mdns_url}
                            </Ltr>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end border-t border-gray-200 pt-4">
                      <button onClick={fetchServerAppInfo} disabled={serverAppInfoLoading}
                        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800">
                        <RefreshCw size={14} className={serverAppInfoLoading ? 'animate-spin' : ''} />
                        {t('settings.refreshUrls')}
                      </button>
                    </div>
                  </div>
                )}

                {!serverAppInfo && !serverAppInfoLoading && (
                  <>
                    <p className="text-sm text-gray-500 mb-3">
                      {t('settings.serverAppLoadHint', { defaultValue: 'Load connection details to pair tableside ordering devices on your local network.' })}
                    </p>
                    <button onClick={fetchServerAppInfo}
                      className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium">
                      {t('settings.loadServerAppInfo', { defaultValue: 'Load Server App Info' })}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="loyalty">
          <div className="pb-6 max-w-3xl space-y-6">
            {/* Loyalty */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Gift size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.loyaltyProgram')}</h2>
              </div>
              <div className="space-y-5">
                {/* Enable toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{t('settings.enableLoyalty')}</p>
                    <p className="text-sm text-gray-500">{t('settings.loyaltyHint')}</p>
                  </div>
                  <button
                    onClick={() => setLoyaltyEnabled(!loyaltyEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      loyaltyEnabled ? 'bg-brand' : 'bg-gray-200'
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      loyaltyEnabled ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'
                    }`} />
                  </button>
                </div>
                {/* Global Cashback Input */}
                {loyaltyEnabled && (
                  <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-gray-900">{t('settings.globalLoyaltyRate')}</p>
                      <p className="text-sm text-gray-500">{t('settings.globalLoyaltyRateHint')}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={globalCashbackPercent}
                        onChange={(e) => setGlobalCashbackPercent(e.target.value)}
                        placeholder="0"
                        className="w-20 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand transition-shadow text-end"
                      />
                      <span className="text-gray-500 font-medium">%</span>
                    </div>
                  </div>
                )}
                {/* Products upgraded from before the tri-state all sit at 0%
                    ("earns nothing"), so the global rate does nothing for them
                    until the owner explicitly opts them in. */}
                {loyaltyEnabled && globalRateCandidates > 0 && (
                  <div className="pt-4 border-t border-gray-100">
                    <p className="font-medium text-gray-900">{t('settings.applyGlobalRateTitle')}</p>
                    <p className="text-sm text-gray-500 mt-1">
                      {t('settings.applyGlobalRateHint', { count: globalRateCandidates })}
                    </p>
                    <button
                      type="button"
                      onClick={applyGlobalRateToProducts}
                      disabled={applyingGlobalRate}
                      className="mt-3 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {applyingGlobalRate
                        ? t('settings.applyGlobalRateWorking')
                        : t('settings.applyGlobalRateAction', { count: globalRateCandidates })}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="discounts">
          <div className="pb-6 max-w-3xl space-y-6">
            {/* Discount Limits */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Percent size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.discountLimits')}</h2>
              </div>
              <div className="space-y-5">
                {/* Discount mode */}
                <div>
                  <p className="font-medium text-gray-900">{t('settings.discountMode')}</p>
                  <p className="text-sm text-gray-500 mb-2">{t('settings.discountModeHint')}</p>
                  <select value={discountMode}
                    onChange={(e) => setDiscountMode(e.target.value)}
                    className="w-48 px-3 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-brand bg-white">
                    <option value="both">{t('settings.discountBoth')}</option>
                    <option value="percentage">{t('settings.discountPercentageOnly')}</option>
                    <option value="flat">{t('settings.discountFlatOnly')}</option>
                  </select>
                </div>

                {(discountMode === 'percentage' || discountMode === 'both') && (
                  <div>
                    <p className="font-medium text-gray-900">{t('settings.maxDiscountPercentage')}</p>
                    <p className="text-sm text-gray-500 mb-2">{t('settings.maxDiscountPercentageHint')}</p>
                    <div className="flex items-center gap-3">
                      <input type="number" min={1} max={100} value={discountMaxPct}
                        onChange={(e) => setDiscountMaxPct(normalizeDiscountPercentage(e.target.value))}
                        className="w-24 px-3 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      <span className="text-sm text-gray-500">{t('settings.percentMaximum')}</span>
                    </div>
                  </div>
                )}

                {(discountMode === 'flat' || discountMode === 'both') && (
                  <div>
                    <p className="font-medium text-gray-900">{t('settings.maxDiscountAmount')}</p>
                    <p className="text-sm text-gray-500 mb-2">{t('settings.maxDiscountAmountHint')}</p>
                    <div className="flex items-center gap-3">
                      <input type="number" min={0} max={999999} value={discountMaxAmount}
                        onChange={(e) => setDiscountMaxAmount(normalizeDiscountAmount(e.target.value))}
                        className="w-24 px-3 py-1.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      <span className="text-sm text-gray-500">{t('settings.zeroNoLimit')}</span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-gray-900">{t('settings.requireApproval')}</p>
                    <p className="text-sm text-gray-500">{t('settings.requireApprovalHint')}</p>
                  </div>
                  <button
                    onClick={() => setDiscountRequiresApproval(!discountRequiresApproval)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      discountRequiresApproval ? 'bg-brand' : 'bg-gray-200'
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      discountRequiresApproval ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'
                    }`} />
                  </button>
                </div>

              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="account">
          <div className="pb-6 max-w-3xl space-y-6">
            {/* Account */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <h2 className="font-semibold text-gray-900 mb-4">{t('settings.account')}</h2>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-gray-500">{t('settings.name')}</p>
                  <p className="font-medium text-gray-900">{user?.name}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">{t('settings.email')}</p>
                  <p className="font-medium text-gray-900"><Ltr>{user?.email}</Ltr></p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">{t('settings.role')}</p>
                  <p className="font-medium text-gray-900 capitalize">{currentTenant?.role || '—'}</p>
                </div>
              </div>
            </div>
            {currentTenant?.role === 'owner' && (
              <div className={`rounded-xl border p-6 ${cloudAccountAvailable && cloudAccount?.email && !cloudAccount.verified ? 'border-red-200 bg-red-50/40' : 'border-gray-100 bg-white'}`}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-gray-900">Contact email</h2>
                    <p className="mt-1 text-sm text-gray-600">{cloudAccountLoadFailed ? 'Unable to load cloud account status' : cloudAccountAvailable ? <Ltr>{cloudAccount?.email || user?.email || 'No cloud contact email'}</Ltr> : 'Cloud account services are currently unavailable'}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${!cloudAccountAvailable ? 'bg-gray-100 text-gray-600' : cloudAccount?.verified ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {cloudAccountLoadFailed ? 'Status unavailable' : !cloudAccountAvailable ? 'Unavailable' : cloudAccount?.verified ? 'Verified' : 'Pending verification'}
                  </span>
                </div>
                <p className="mt-3 text-sm text-gray-600">{cloudAccountLoadFailed ? 'Check the local API connection and retry. No cloud account changes were made.' : cloudAccountAvailable ? 'Verification is important for product service notices, security updates, and other account communication.' : cloudDeletionPending ? 'A cloud deletion request is pending review. Cancel it or wait for review before re-enabling Cloud Services.' : cloudDeletionStatus === 'processing' ? 'Cloud deletion is being processed. Refresh its status or cancel it if cancellation is available.' : cloudDeletionStatus === 'failed' || cloudStatus.cloud_deletion_status === 'failed' ? 'The cloud deletion request needs attention. Refresh its status or retry the request from the privacy controls.' : 'Enable Cloud Services from Mobile Access to use cloud account features.'}</p>
                {cloudAccountLoadFailed && (
                  <Button variant="outline" className="mt-4" onClick={() => void fetchCloudAccount()}>Retry</Button>
                )}
                {cloudAccountAvailable && !cloudAccount?.verified && (
                  <Button className="mt-4" disabled={cloudAccountBusy} onClick={async () => {
                    setCloudAccountBusy(true);
                    try { await api.post('/settings/cloud/account/verification'); toast.success(t('settings.verificationEmailQueued')); await fetchCloudAccount(); }
                    catch {
                      toast.error(t('settings.verificationEmailFailed'));
                    }
                    finally { setCloudAccountBusy(false); }
                  }}>{cloudAccountBusy ? 'Sending…' : 'Send verification email'}</Button>
                )}
                {cloudAccountAvailable && (
                  <div className="mt-5 space-y-3 border-t border-gray-200 pt-4">
                    <label className="flex items-center justify-between gap-4 text-sm"><span>Product updates and release notes</span><Toggle value={Boolean(cloudAccount?.product_updates)} onChange={async (value) => { setCloudAccountBusy(true); try { const { data } = await api.put('/settings/cloud/account/preferences', { product_updates: value }); setCloudAccount(data); } catch { toast.error(t('settings.couldNotSavePreference')); } finally { setCloudAccountBusy(false); } }} /></label>
                    <label className="flex items-center justify-between gap-4 text-sm"><span>Marketing messages, offers, and surveys</span><Toggle value={Boolean(cloudAccount?.marketing)} onChange={async (value) => { setCloudAccountBusy(true); try { const { data } = await api.put('/settings/cloud/account/preferences', { marketing: value }); setCloudAccount(data); } catch { toast.error(t('settings.couldNotSavePreference')); } finally { setCloudAccountBusy(false); } }} /></label>
                    <p className="text-xs text-gray-500">Essential service and security notices are separate from these optional subscriptions.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Privacy — anonymous telemetry (from the old Integrations tab) + cloud privacy controls (from Account) */}
        <TabsContent value="privacy">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Lock size={20} className="text-gray-500" />
                <div>
                  <h2 className="font-semibold text-gray-900">{t('settings.privacy')}</h2>
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={telemetryEnabled}
                  disabled={savingTelemetry}
                  onChange={(e) => saveTelemetry(e.target.checked)}
                  className="rounded border-gray-300 text-brand focus:ring-brand"
                />
                <span className="text-sm text-gray-700">{t('settings.anonymousTelemetry')}</span>
              </label>
              <p className="text-xs text-gray-500">{t('settings.anonymousTelemetryHint')}</p>

              <div className="border-t border-gray-100 pt-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={diagnosticsConsent}
                    disabled={savingDiagnosticsConsent}
                    onChange={(e) => saveDiagnosticsConsent(e.target.checked)}
                    className="rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  <span className="text-sm text-gray-700">{t('settings.storeDiagnostics')}</span>
                </label>
                <p className="text-xs text-gray-500 mt-1">{t('settings.storeDiagnosticsHint')}</p>
              </div>
            </div>

            {currentTenant?.role === 'owner' && (
              <div className="rounded-xl border border-gray-100 bg-white p-6">
                <h2 className="font-semibold text-gray-900">Cloud privacy controls</h2>
                <p className="mt-2 text-sm text-gray-600">Stopping cloud services is reversible. A cloud deletion request is reviewed manually in FloAdmin before data is permanently removed. Neither action deletes your local orders, bills, customers, products, or database.</p>
                {cloudAccount?.deletion_request && (
                  <div className={`mt-4 rounded-lg border p-3 text-sm ${cloudAccount.deletion_request.status === 'pending' || cloudAccount.deletion_request.status === 'processing' ? 'border-amber-200 bg-amber-50 text-amber-900' : cloudAccount.deletion_request.status === 'approved' || cloudAccount.deletion_request.status === 'completed' || cloudAccount.deletion_request.status === 'deleted' ? 'border-green-200 bg-green-50 text-green-800' : cloudAccount.deletion_request.status === 'failed' ? 'border-red-200 bg-red-50 text-red-800' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
                    <p className="font-semibold">Deletion request: {cloudAccount.deletion_request.status}</p>
                    {cloudAccount.deletion_request.id && <p className="mt-1 font-mono text-xs"><Ltr>{cloudAccount.deletion_request.id}</Ltr></p>}
                    {cloudAccount.deletion_request.decision_note && <p className="mt-2">{cloudAccount.deletion_request.decision_note}</p>}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button variant="outline" onClick={async () => {
                    if (!await confirm('Stop all FloCafe cloud services, identified diagnostics, and future anonymous telemetry on this device? Local POS data will remain available.')) return;
                    try {
                      const { data } = await api.post('/settings/cloud/stop-all');
                      setCloudStatus({
                        cloud_registration_status: data.cloud_registration_status || 'unregistered',
                        cloud_services_disabled_by_user: !!data.cloud_services_disabled_by_user,
                        cloud_connected: !!data.cloud_connected,
                        cloud_relay_mode: data.cloud_relay_mode || 'disconnected',
                        cloud_last_heartbeat: data.cloud_last_heartbeat || null,
                        cloud_last_error: data.cloud_last_error || null,
                        cloud_deletion_status: data.cloud_deletion_status || '',
                      });
                      setCloudSettings((previous) => ({ ...previous, cloud_sync_enabled: !!data.cloud_sync_enabled, cloud_orders_enabled: !!data.cloud_orders_enabled, cloud_last_sync: data.cloud_last_sync || null }));
                      setSavedCloudSettings((previous) => ({ ...previous, cloud_sync_enabled: !!data.cloud_sync_enabled, cloud_orders_enabled: !!data.cloud_orders_enabled, cloud_last_sync: data.cloud_last_sync || null }));
                      setTelemetryEnabled(false);
                      setDiagnosticsConsent(false);
                      await fetchCloudAccount();
                      notifyCloudAccountStatusChanged();
                      toast.success(t('settings.cloudAllStopped'));
                    }
                    catch { toast.error(t('settings.cloudStopFailed')); }
                  }}><CloudOff size={16} className="me-2" />Stop all cloud services</Button>
                  {!cloudDeletionFinal && <Button variant="destructive" disabled={cloudAccount?.deletion_request?.status === 'pending' || cloudAccount?.deletion_request?.status === 'processing' || cloudAccount?.deletion_request?.status === 'approved' || cloudStatus.cloud_deletion_status === 'processing'} onClick={() => {
                    const phrase = window.prompt('This submits a deletion request to FloAdmin for manual review and immediately stops cloud services here. After approval, store-linked server data is permanently deleted. Local POS data stays on this device. Type DELETE CLOUD DATA to continue.');
                    if (phrase === 'DELETE CLOUD DATA') setPinGate({ mode: 'delete-cloud' });
                    else if (phrase !== null) toast.error(t('settings.confirmationPhraseMismatch'));
                  }}><Trash2 size={16} className="me-2" />Request cloud data deletion</Button>}
                  {cloudDeletionNeedsAction && (
                    <>
                      <Button variant="outline" onClick={() => void refreshDeletionStatus()} disabled={refreshingDeletionStatus}>
                        {refreshingDeletionStatus ? 'Refreshing…' : 'Refresh deletion status'}
                      </Button>
                      {cloudDeletionCanCancel && <Button variant="outline" onClick={() => setPinGate({ mode: 'cancel-cloud-deletion' })}>Cancel deletion request</Button>}
                    </>
                  )}
                </div>
                <p className="mt-3 text-xs text-gray-500">Anonymous telemetry has no store or email link, so existing anonymous events cannot be identified as yours. This action stops future telemetry and rotates the anonymous identifier.</p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* Printers sub-page */}
        <TabsContent value="receipts-printers">
          <div className="pb-6 max-w-6xl space-y-6">
            <div className="space-y-6">
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Printer size={20} className="text-gray-500" />
                  <h2 className="font-semibold text-gray-900">{t('settings.printers')}</h2>
                </div>
                {!showPrinterForm && (
                  <div className="flex items-center gap-2">
                    <button onClick={fetchDetectedPrinters} disabled={detectingPrinters}
                      title={t('settings.refreshList')}
                      className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 font-medium disabled:opacity-50">
                      <RefreshCw size={14} className={detectingPrinters ? 'animate-spin' : ''} /> {t('settings.refresh')}
                    </button>
                    <button onClick={openAddPrinter}
                      className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 font-medium">
                      <Plus size={14} /> {t('settings.addPrinterManually')}
                    </button>
                  </div>
                )}
              </div>

              {/* Detected (OS-installed) printers — one-click add */}
              {!showPrinterForm && (
                <div className="mb-5">
                  <button
                    type="button"
                    onClick={() => setInstalledPrintersOpen((open) => !open)}
                    className="flex w-full items-center justify-between gap-3 border-y border-gray-100 py-3 text-start"
                    aria-expanded={installedPrintersOpen}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {t('settings.installedOnThisComputer')} ({detectedPrinters.length})
                    </span>
                    <ChevronDown size={16} className={`text-gray-400 transition-transform ${installedPrintersOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {installedPrintersOpen && (detectingPrinters && detectedPrinters.length === 0 ? (
                    <div className="py-6 text-center text-gray-400 text-sm">{t('settings.scanningForPrinters')}</div>
                  ) : detectedPrinters.length === 0 ? (
                    <div className="mt-2 py-6 text-center text-gray-400 text-sm border border-dashed border-gray-200 rounded-lg">
                      {t('settings.noInstalledPrinters')}
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {detectedPrinters.map((p) => {
                        const alreadyAdded = hwPrinters.some((h) => h.name.toLowerCase() === p.name.toLowerCase());
                        const isAdding = addingDetectedName === p.name;
                        const dotColor = p.status === 'idle' ? 'bg-green-500' : p.status === 'printing' ? 'bg-yellow-500' : 'bg-gray-300';
                        const statusLabel = p.status === 'idle' ? t('settings.printerOnline') : p.status === 'printing' ? t('settings.printerPrinting') : t('settings.printerOffline');
                        return (
                          <div key={p.name} className="flex items-center gap-3 rounded-xl border border-gray-200 p-3">
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-gray-100 shrink-0">
                              {p.connectionType === 'network' ? <Wifi size={18} className="text-gray-500" /> : <Usb size={18} className="text-gray-500" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-gray-900 text-sm truncate">{p.name}</span>
                                <span className="flex items-center gap-1 text-[11px] text-gray-500">
                                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                                  {statusLabel}
                                </span>
                              </div>
                              <p className="text-xs text-gray-500 mt-0.5 truncate">
                                {p.make !== 'Unknown' ? `${p.make} ${p.model}` : p.model}
                                {p.connectionType === 'network' && p.ipAddress ? <> · <Ltr>{p.ipAddress}{p.port ? ':' + p.port : ''}</Ltr></> : ''}
                                {p.paperWidth ? ` · ${printWidthLabel(p.paperWidth)}` : ''}
                                {p.profileId ? ` · ${t('settings.printerSupportedProfile')}` : ''}
                              </p>
                            </div>
                            {alreadyAdded ? (
                              <span className="text-xs text-gray-400 px-3 py-1.5 flex items-center gap-1">
                                <CheckCircle2 size={14} className="text-green-500" /> {t('settings.printerAdded')}
                              </span>
                            ) : (
                              <button onClick={() => quickAddDetected(p)} disabled={isAdding}
                                className="px-3 py-1.5 text-xs bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium flex items-center gap-1">
                                <Plus size={13} /> {isAdding ? t('settings.printerAdding') : t('common.add')}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}

              {/* Configured printer list */}
              {hwPrinters.length === 0 && !showPrinterForm && (
                <div className="py-6 text-center text-gray-400">
                  <p className="text-sm">{t('settings.noPrintersConfigured')}</p>
                  <p className="text-xs mt-1">{t('settings.printerHint')}</p>
                </div>
              )}

              {hwPrinters.length > 0 && !showPrinterForm && (
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{t('settings.configuredPrinters')}</h3>
              )}
              <div className="space-y-3">
                {hwPrinters.map((p) => (
                  <div key={p.id} className={`flex items-center gap-3 rounded-xl border p-4 ${p.is_default ? 'border-brand bg-brand/5' : 'border-gray-200'}`}>
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-gray-100 shrink-0">
                      {p.connection_type === 'network' ? <Wifi size={18} className="text-gray-500" /> :
                       p.connection_type === 'webusb' ? <Usb size={18} className="text-blue-500" /> :
                       <Usb size={18} className="text-gray-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900 text-sm">{p.name}</span>
                        {p.is_default === 1 && (
                          <span className="text-[10px] bg-brand/10 text-brand px-2 py-0.5 rounded-full font-medium">{t('settings.defaultPrinter')}</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {p.connection_type === 'network' ? <Ltr>{p.ip_address}:{p.port}</Ltr> :
                         p.connection_type === 'usb' ? t('settings.connectionUsb') :
                         t('settings.browserWebusb')}
                        {' · '}{printWidthLabel(p.paper_width)}
                        {p.profile_name ? ` · ${p.profile_name}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => testPrinterHw(p)} disabled={testingPrinterId === p.id}
                        title={t('settings.testPrint')}
                        className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 disabled:opacity-40">
                        <TestTube2 size={15} />
                      </button>
                      {p.is_default !== 1 && (
                        <button onClick={() => setDefaultPrinter(p.id)} title={t('settings.setAsDefault')}
                          className="p-2 rounded-lg hover:bg-yellow-50 text-gray-400 hover:text-yellow-600">
                          <Star size={15} />
                        </button>
                      )}
                      <button onClick={() => openEditPrinter(p)} title={t('settings.edit')}
                        className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700">
                        <Settings size={15} />
                      </button>
                      <button onClick={() => deletePrinterHw(p.id)} title={t('settings.delete')}
                        className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add / Edit form */}
              {showPrinterForm && (
                <div className="mt-5 pt-5 border-t border-gray-100">
                  <h3 className="font-semibold text-gray-900 text-sm mb-4">
                    {editingPrinterId ? t('settings.editPrinter') : t('settings.addPrinter')}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('settings.printerName')}</label>
                      <input type="text" value={printerForm.name}
                        onChange={(e) => setPrinterForm((p) => ({ ...p, name: e.target.value }))}
                        placeholder={t('settings.printerNamePlaceholder')}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('settings.connectionType')}</label>
                      <select value={printerForm.connection_type}
                        onChange={(e) => setPrinterForm((p) => ({ ...p, connection_type: e.target.value as HwPrinter['connection_type'] }))}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand">
                        <option value="network">{t('settings.connectionNetwork')}</option>
                        <option value="usb">{t('settings.connectionUsb')}</option>
                        <option value="webusb">{t('settings.connectionWebusb')}</option>
                      </select>
                    </div>

                    {printerForm.connection_type === 'network' && (<>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">{t('settings.ipAddress')}</label>
                        <input type="text" value={printerForm.ip_address}
                          onChange={(e) => setPrinterForm((p) => ({ ...p, ip_address: e.target.value }))}
                          placeholder={t('settings.ipAddressPlaceholder')}
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand" dir="ltr" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">{t('settings.port')}</label>
                        <input type="number" value={printerForm.port}
                          onChange={(e) => setPrinterForm((p) => ({ ...p, port: e.target.value }))}
                          placeholder={t('settings.portPlaceholder')}
                          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                      </div>
                    </>)}

                    {printerForm.connection_type === 'webusb' && (
                      <div className="md:col-span-2 bg-blue-50 rounded-lg p-3 text-sm text-blue-700">
                        {t('settings.webusbHint')}
                      </div>
                    )}

                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('settings.paperWidth')}</label>
                      <select value={printerForm.paper_width}
                        onChange={(e) => setPrinterForm((p) => ({ ...p, paper_width: e.target.value }))}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand">
                        <option value="cols-32">{t('settings.printColumns32')}</option>
                        <option value="cols-36">{t('settings.printColumns36')}</option>
                        <option value="cols-40">{t('settings.printColumns40')}</option>
                        <option value="cols-42">{t('settings.printColumns42')}</option>
                        <option value="cols-44">{t('settings.printColumns44')}</option>
                        <option value="cols-48">{t('settings.printColumns48')}</option>
                      </select>
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <button onClick={savePrinterHw} disabled={savingPrinter}
                      className="px-5 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium">
                      {savingPrinter ? t('settings.saving') : editingPrinterId ? t('common.update') : t('settings.addPrinter')}
                    </button>
                    <button onClick={() => setShowPrinterForm(false)}
                      className="px-5 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 font-medium">
                      {t('settings.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              <strong>{t('settings.defaultPrinterTipTitle')}</strong> {t('settings.defaultPrinterTipBody')}
            </div>

            {/* Print Options — merged into the same Printers page rather than a separate tab */}
            <div className="pt-4 border-t border-gray-100">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">{t('settings.tabPrinting')}</h2>
            </div>

            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Printer size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.printing')}</h2>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t('settings.enablePrinter')}</p>
                    <p className="text-sm text-gray-500">{t('settings.enablePrinterHint')}</p>
                  </div>
                  <Toggle value={printingForm.printerEnabled} onChange={(v) => setPrintingForm((p) => ({ ...p, printerEnabled: v }))} />
                </div>
                <div>
                  <p className="font-medium text-gray-900 mb-2">{t('settings.paperSize')}</p>
                  <select value={printingForm.printerPaperSize}
                    onChange={(e) => setPrintingForm((p) => ({ ...p, printerPaperSize: e.target.value as PaperSize }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand">
                    {paperSizeOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <p className="font-medium text-gray-900 mb-2">{t('settings.printMethod')}</p>
                  <select value={printingForm.printMethod}
                    onChange={(e) => setPrintingForm((p) => ({ ...p, printMethod: e.target.value as 'escpos' | 'browser' }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand">
                    <option value="escpos">{t('settings.printMethodEscpos')}</option>
                    <option value="browser">{t('settings.printMethodBrowser')}</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    {printingForm.printMethod === 'escpos'
                      ? t('settings.printMethodEscposHint')
                      : t('settings.printMethodBrowserHint')}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-gray-100 pt-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t('settings.kotPrintingEnabledToggle', { defaultValue: 'KOT Ticket Printing' })}</p>
                    <p className="text-sm text-gray-500">{t('settings.kotPrintingEnabledToggleHint', { defaultValue: 'Allow KOT tickets to print at all, automatically or manually. Turn this off if this business doesn’t use a KOT printer.' })}</p>
                  </div>
                  <Toggle value={kotPrintingEnabledSetting} onChange={(v) => { if (!savingKotPrintingEnabled) saveKotPrintingEnabled(v); }} />
                </div>
                <div className={`flex items-center justify-between gap-4 ${!kotPrintingEnabledSetting ? 'opacity-50' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t('settings.autoPrintKot')}</p>
                    <p className="text-sm text-gray-500">
                      {kotPrintingEnabledSetting
                        ? t('settings.autoPrintKotHint')
                        : t('settings.autoPrintKotDisabledHint', { defaultValue: 'KOT printing is turned off above, so this has no effect.' })}
                    </p>
                  </div>
                  <Toggle
                    value={printingForm.autoPrintKot && kotPrintingEnabledSetting}
                    onChange={(v) => { if (kotPrintingEnabledSetting) setPrintingForm((p) => ({ ...p, autoPrintKot: v })); }}
                  />
                </div>
                {!kdsEnabledSetting && !kotPrintingEnabledSetting && (
                  <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800">
                      {t('settings.kitchenWorkflowBothOffNote', { defaultValue: 'Both the Kitchen Display and KOT printing are off. Kitchen items won’t display or print anywhere — orders will need to be marked served directly at the counter.' })}
                    </p>
                  </div>
                )}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t('settings.autoPrintBill')}</p>
                    <p className="text-sm text-gray-500">{t('settings.autoPrintBillHint')}</p>
                  </div>
                  <Toggle value={printingForm.autoPrintBill} onChange={(v) => setPrintingForm((p) => ({ ...p, autoPrintBill: v }))} />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t('settings.printerUnicode')}</p>
                    <p className="text-sm text-gray-500">
                      {t('settings.printerUnicodeHint')}
                    </p>
                  </div>
                  <Toggle value={printingForm.printerUseUnicode} onChange={(v) => setPrintingForm((p) => ({ ...p, printerUseUnicode: v }))} />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900">{t('settings.trimDecimals')}</p>
                    <p className="text-sm text-gray-500">{t('settings.trimDecimalsHint')}</p>
                  </div>
                  <Toggle value={printingForm.printerTrimDecimals} onChange={(v) => setPrintingForm((p) => ({ ...p, printerTrimDecimals: v }))} />
                </div>
                <div className="pt-4 border-t border-gray-100">
                  <p className="font-medium text-gray-900 mb-1">{t('settings.billContent')}</p>
                  <p className="text-sm text-gray-500 mb-3">{t('settings.billContentHint')}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                    {([
                      { label: t('settings.showRestaurantName'), key: 'billShowName' as const },
                      { label: t('settings.showRestaurantAddress'), key: 'billShowAddress' as const },
                      { label: t('settings.showRestaurantPhone'), key: 'billShowPhone' as const },
                      { label: t('settings.showTaxId'), key: 'billShowTaxId' as const },
                      { label: t('settings.showTaxBreakdown'), key: 'billShowTaxBreakdown' as const },
                      { label: t('settings.showCustomerName'), key: 'billShowCustomerName' as const },
                      { label: t('settings.showCustomerPhone'), key: 'billShowCustomerPhone' as const },
                      { label: t('settings.showTableNumber'), key: 'billShowTableNumber' as const },
                    ] as const).map((item) => (
                      <div key={item.key} className="flex min-h-11 items-center justify-between gap-3 py-1">
                        <span className="text-sm text-gray-700">{item.label}</span>
                        <Toggle
                          value={printingForm[item.key]}
                          onChange={(value) => setPrintingForm((previous) => ({ ...previous, [item.key]: value }))}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <label htmlFor="footer-message" className="block text-sm font-medium text-gray-700 mb-1">{t('settings.footerMessage')}</label>
                    <textarea id="footer-message" rows={2}
                      placeholder={t('settings.footerMessagePlaceholder')}
                      value={billForm.billFooterMessage}
                      onChange={(e) => setBillForm((p) => ({ ...p, billFooterMessage: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-brand resize-none" />
                    <p className="text-xs text-gray-400 mt-1">{t('settings.footerMessageHint')}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Share2 size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.whatsappSharing')}</h2>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-900">{t('settings.enableWhatsappShare')}</p>
                  <p className="text-sm text-gray-500">{t('settings.enableWhatsappShareHint')}</p>
                </div>
                <Toggle value={printingForm.whatsappShareEnabled} onChange={(v) => setPrintingForm((p) => ({ ...p, whatsappShareEnabled: v }))} />
              </div>
            </div>
          </div>

            <div className="space-y-6">
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <FileText size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.billTemplate')}</h2>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {billTemplateCards.map((card) => {
                  const isSelected = billForm.billTemplate === card.id;
                  return (
                    <button key={card.id} onClick={() => setBillForm((p) => ({ ...p, billTemplate: card.id }))}
                      className={`text-start rounded-xl border-2 p-4 transition-all ${
                        isSelected ? 'border-brand bg-brand/5' : 'border-gray-200 hover:border-gray-300 bg-white'
                      }`}>
                      <p className="font-semibold text-gray-900 mb-2">
                        {card.nameKey ? t(card.nameKey) : card.displayName}
                      </p>
                      <pre className="font-mono text-[9px] leading-tight text-gray-600 bg-gray-50 p-2 rounded overflow-hidden mb-3 whitespace-pre">
                        {card.preview}
                      </pre>
                      <p className="text-xs text-gray-500">
                        {card.source === 'plugin'
                          ? card.description
                          : card.id === 'classic'
                            ? t('settings.billTemplateClassicDesc')
                            : t('settings.billTemplateCompactDesc')}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

          </div>
          </div>
        </TabsContent>


        {/* Backup & Data tab — database tools only */}
        <TabsContent value="data">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="space-y-6">
            <h2 className="text-lg font-semibold text-gray-900">{t('settings.tabBackupData')}</h2>
            {/* Database Export */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <FileText size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.exportDatabase')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                {t('settings.exportDatabaseHint')}
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
                    toast.success(t('settings.databaseExported'));
                  } catch {
                    toast.error(t('settings.exportFailed'));
                  }
                }}
                className="px-5 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium"
              >
                {t('settings.exportToJson')}
              </button>
            </div>

            {/* Database Backup */}
            <div className="bg-white rounded-xl border border-blue-100 bg-blue-50/30 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Database size={20} className="text-blue-600" />
                <h2 className="font-semibold text-gray-900">{t('settings.createBackup')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                {t('settings.createBackupHint')}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleCreateBackup}
                  className="px-5 py-2 text-sm bg-gray-600 text-white rounded-lg hover:opacity-90 font-medium"
                >
                  {t('settings.createBackup')}
                </button>
                <button
                  onClick={handleChooseBackupLocation}
                  className="px-5 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium"
                >
                  {t('settings.chooseBackupLocation')}
                </button>
              </div>
            </div>

            {/* Backup History */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Database size={20} className="text-gray-500" />
                  <h2 className="font-semibold text-gray-900">{t('settings.backupHistory')}</h2>
                </div>
                <button
                  onClick={fetchBackups}
                  disabled={backupsLoading}
                  className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  title={t('settings.refresh')}
                >
                  <RefreshCw size={16} className={backupsLoading ? 'animate-spin' : ''} />
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                {t('settings.backupHistoryHint')}
              </p>
              {backups.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">
                  {backupsLoading ? t('common.loading') : t('settings.backupHistoryEmpty')}
                </p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {backups.map((backup) => (
                    <div key={backup.path} className="flex items-center justify-between py-3 gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">{formatDateTime(backup.createdAt)}</span>
                          {backup.kind === 'auto' && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100">
                              {t('settings.backupKindAuto')}
                            </span>
                          )}
                          {googleDriveStatus.last_backup_filename === backup.fileName && (
                            <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">
                              <HardDrive size={11} />
                              {t('settings.googleDriveUploadedBadge')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate">
                          {formatBackupSize(backup.sizeBytes)}
                          {backup.schemaVersion != null && ` · ${t('settings.backupSchemaVersion', { version: backup.schemaVersion })}`}
                        </p>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <button
                          onClick={() => handleRestoreFromHistory(backup)}
                          className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium"
                        >
                          {t('settings.restoreBackup')}
                        </button>
                        <button
                          onClick={() => handleDeleteBackup(backup)}
                          className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50"
                          title={t('settings.deleteBackup')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Google Drive — automated off-device backups (#129) */}
            <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
              <div className="flex items-center gap-2">
                <HardDrive size={20} className="text-gray-500" />
                <div>
                  <h2 className="font-semibold text-gray-900">{t('settings.googleDrive')}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{t('settings.googleDriveHint')}</p>
                </div>
              </div>

              {!googleDriveStatus.configured ? (
                <div className="bg-gray-50 rounded-xl p-6 flex flex-col items-center justify-center text-center space-y-2">
                  <div className="p-3 bg-white rounded-full shadow-sm">
                    <HardDrive className="w-6 h-6 text-gray-400" />
                  </div>
                  <p className="text-sm font-medium text-gray-900">{t('settings.googleDriveNotConfigured')}</p>
                  <p className="text-xs text-gray-500 max-w-sm">{t('settings.googleDriveNotConfiguredHint')}</p>
                </div>
              ) : !googleDriveStatus.secure_storage_available ? (
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3">
                  <AlertTriangle size={16} className="text-amber-600 shrink-0" />
                  <p className="text-sm text-amber-800">{t('settings.googleDriveSecureStorageUnavailable')}</p>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-gray-100 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      {googleDriveStatus.connected ? (
                        <CheckCircle2 size={16} className="text-green-600 shrink-0" />
                      ) : (
                        <CloudOff size={16} className="text-gray-400 shrink-0" />
                      )}
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {googleDriveStatus.connected ? t('settings.googleDriveConnected') : t('settings.googleDriveNotConnected')}
                        </p>
                        {googleDriveStatus.connected && googleDriveStatus.account_email && (
                          <p className="text-xs text-gray-500">{t('settings.googleDriveAccount')}: <Ltr>{googleDriveStatus.account_email}</Ltr></p>
                        )}
                      </div>
                    </div>
                    {(currentTenant?.role === 'owner') && (
                      googleDriveStatus.connected ? (
                        <button
                          onClick={disconnectGoogleDrive}
                          disabled={disconnectingGoogleDrive}
                          className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 font-medium shrink-0"
                        >
                          {disconnectingGoogleDrive ? t('settings.googleDriveDisconnecting') : t('settings.googleDriveDisconnect')}
                        </button>
                      ) : (
                        <button
                          onClick={connectGoogleDrive}
                          disabled={connectingGoogleDrive}
                          className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium shrink-0"
                        >
                          {connectingGoogleDrive ? t('settings.googleDriveConnecting') : t('settings.googleDriveConnect')}
                        </button>
                      )
                    )}
                  </div>

                  {googleDriveStatus.connected && (
                    <>
                      <div className="grid sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.googleDriveFrequency')}</label>
                          <select
                            value={googleDriveStatus.frequency}
                            disabled={savingGoogleDrivePrefs}
                            onChange={(e) => updateGoogleDrivePrefs({ frequency: e.target.value as 'daily' | 'weekly' })}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand outline-none disabled:opacity-50"
                          >
                            <option value="daily">{t('settings.googleDriveFrequencyDaily')}</option>
                            <option value="weekly">{t('settings.googleDriveFrequencyWeekly')}</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">{t('settings.googleDriveRetention')}</label>
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={googleDriveStatus.retention_count}
                            disabled={savingGoogleDrivePrefs}
                            onChange={(e) => setGoogleDriveStatus((prev) => ({ ...prev, retention_count: Number(e.target.value) || prev.retention_count }))}
                            onBlur={(e) => {
                              const n = Number(e.target.value);
                              if (Number.isInteger(n) && n >= 1 && n <= 100) updateGoogleDrivePrefs({ retention_count: n });
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-brand outline-none disabled:opacity-50"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-gray-500">{t('settings.googleDriveRetentionHint')}</p>

                      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
                        <div className="text-xs text-gray-500">
                          {googleDriveStatus.last_backup_at ? (
                            googleDriveStatus.last_backup_status === 'error' ? (
                              <span className="flex items-center gap-1 text-red-600">
                                <AlertTriangle size={13} />
                                {t('settings.googleDriveLastBackupErrorAt', { time: formatDateTime(googleDriveStatus.last_backup_at) })}
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-gray-500">
                                <CheckCircle2 size={13} className="text-green-600" />
                                {t('settings.googleDriveLastBackupSuccessAt', { time: formatDateTime(googleDriveStatus.last_backup_at) })}
                              </span>
                            )
                          ) : (
                            <span>{t('settings.googleDriveLastBackup')}: {t('settings.googleDriveLastBackupNever')}</span>
                          )}
                        </div>
                        {(currentTenant?.role === 'owner') && (
                          <button
                            onClick={backupToGoogleDriveNow}
                            disabled={backingUpGoogleDrive}
                            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium shrink-0"
                          >
                            <UploadCloud size={15} />
                            {backingUpGoogleDrive ? t('settings.googleDriveBackingUp') : t('settings.googleDriveBackupNow')}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Database Import */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <FileText size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.importDatabase')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                {t('settings.importDatabaseHint')}
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
                      const data = JSON.parse(event.target?.result as string);
                      if (!data.app || data.app !== 'FloDesktop') {
                        toast.error(t('settings.invalidExportFile'));
                        return;
                      }

                      const overwrite = await confirm(t('settings.importOverwriteConfirm'), { confirmLabel: t('settings.replaceAll') });

                      // A schema-mismatch import takes the same destructive
                      // delete-and-replace path as an overwrite, so it needs the
                      // same Master PIN confirmation (GHSA-xxv4-gm82-4639).
                      const rawImportVersion = String(data.schema_version ?? '');
                      const importVersion = /^(?:0|[1-9]\d*)$/.test(rawImportVersion) ? Number(rawImportVersion) : null;
                      const schemaMismatch = masterPinStatus.schemaVersion != null
                        && (importVersion === null || importVersion !== masterPinStatus.schemaVersion);
                      const destructive = overwrite || schemaMismatch;

                      if (destructive && masterPinStatus.available) {
                        if (!masterPinStatus.isSet) {
                          toast.error(t('settings.masterPinRequiredForReplace'));
                          return;
                        }
                        setPinGate({ mode: 'import', payload: { data, overwrite } });
                        return;
                      }

                      await runImport(data, overwrite);
                    } catch {
                      toast.error(t('settings.importFailed'));
                    }
                  };
                  reader.readAsText(file);
                  e.target.value = '';
                }}
              />
              <div className="flex gap-2">
                <label
                  htmlFor="import-file"
                  className="px-5 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 cursor-pointer font-medium"
                >
                  {t('settings.selectFileAndImport')}
                </label>
              </div>
            </div>

            {/* Database Info */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Database size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.databaseInformation')}</h2>
              </div>
              <button
                onClick={async () => {
                  try {
                    const response = await api.get('/db/tables');
                    const { tables } = response.data;
                    setTableInfo(tables);
                    setTableInfoOpen(true);
                  } catch {
                    toast.error(t('settings.tableInfoFailed'));
                  }
                }}
                className="px-5 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 font-medium"
              >
                {t('settings.viewTableInfo')}
              </button>
            </div>

            {/* Database Health Check */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Wrench size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.databaseHealthCheck')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                {t('settings.databaseHealthCheckDescription')}
              </p>
              <button
                onClick={runHealthCheck}
                className="px-5 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 font-medium"
              >
                {t('settings.databaseHealthCheck')}
              </button>
            </div>

            {/* Master PIN */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <KeyRound size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.masterPin')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                {t('settings.masterPinDataDescription')}
              </p>
              {!masterPinStatus.available ? (
                <p className="text-sm text-amber-600">{t('settings.notAvailableOnDevice')}</p>
              ) : (
                <div className="flex items-center gap-3">
                  <span className={`text-sm font-medium ${masterPinStatus.isSet ? 'text-green-600' : 'text-amber-600'}`}>
                    {masterPinStatus.isSet ? t('settings.masterPinStatusSet') : t('settings.masterPinStatusNotSet')}
                  </span>
                  <button
                    onClick={() => setPinGate({ mode: 'set' })}
                    className="px-5 py-2 text-sm border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 font-medium"
                  >
                    {masterPinStatus.isSet ? t('settings.masterPinChangeButton') : t('settings.masterPinSetButton')}
                  </button>
                </div>
              )}
            </div>

            {/* Danger Zone: Initialize Database */}
            <div className="bg-white rounded-xl border border-red-200 p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle size={20} className="text-red-600" />
                <h2 className="font-semibold text-red-600">{t('settings.initializeDatabase')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                {t('settings.initializeDatabaseDescription')}
              </p>
              <button
                onClick={() => setInitializeDbOpen(true)}
                className="px-5 py-2 text-sm bg-red-600 text-white rounded-lg hover:opacity-90 font-medium"
              >
                {t('settings.initializeDatabaseButton')}
              </button>
            </div>
          </div>
          </div>
        </TabsContent>

        {/* Integrations tab — cloud + OrderFlow + More Apps */}
        <TabsContent value="whatsapp">
          <div className="pb-6 max-w-3xl space-y-6">
            {!whatsappEnabled ? (
              <WhatsAppEnableCard />
            ) : (
              <div className="bg-white rounded-xl border border-gray-100 p-6 flex items-center justify-between gap-4">
                <div>
                  <p className="font-semibold text-gray-900">{t('whatsapp.settings.enabled')}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{t('whatsapp.settings.enabledHint')}</p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href="/whatsapp">{t('whatsapp.settings.openConnection')}</Link>
                </Button>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="mobile-access">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="space-y-6">
            <h2 className="text-lg font-semibold text-gray-900">{t('settings.tabMobileAccess')}</h2>

            {/* FloAdmin — reporting sync */}
            <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-5">
              <div className="flex items-center gap-2">
                <Cloud size={20} className="text-brand" />
                <div>
                  <h2 className="font-semibold text-gray-900">{t('settings.floadminSalesReporting')}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{t('settings.floadminSalesReportingHint')}</p>
                </div>
              </div>

              {cloudStatus.cloud_registration_status === 'unregistered' ? (
                <div className="bg-gray-50 rounded-xl p-6 flex flex-col items-center justify-center text-center space-y-4">
                  <div className="p-3 bg-white rounded-full shadow-sm">
                    <Cloud className="w-6 h-6 text-brand" />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900">Cloud Services Disabled</h3>
                    <p className="text-sm text-gray-500 mt-1 max-w-sm">Initialize cloud services to enable remote sales reporting, bill sync, and online dashboard access.</p>
                  </div>
                  <button
                    onClick={() => setShowInitializeCloudConfirm(true)}
                    className="px-4 py-2 bg-brand text-white text-sm font-medium rounded-lg hover:opacity-90"
                  >
                    Initialize Cloud Services
                  </button>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-gray-100 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                  {cloudStatus.cloud_registration_status === 'registered' && !cloudServicesStopped ? (
                    <CheckCircle2 size={16} className="text-green-600 shrink-0" />
                  ) : (
                    <CloudOff size={16} className="text-gray-400 shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {cloudStatus.cloud_registration_status === 'registered' && cloudServicesStopped && 'Cloud services stopped'}
                      {cloudStatus.cloud_registration_status === 'registered' && !cloudServicesStopped && (cloudStatus.cloud_connected ? t('settings.connectedToFloadmin') : t('settings.registeredReconnecting'))}
                      {cloudStatus.cloud_registration_status === 'rejected' && t('settings.registrationRejected')}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && (cloudStatus.cloud_last_error || cloudStatus.cloud_deletion_status === 'failed') && 'Cloud deletion request failed'}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && cloudStatus.cloud_deletion_status === 'processing' && 'Cloud deletion processing'}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && !cloudStatus.cloud_last_error && cloudStatus.cloud_deletion_status !== 'failed' && cloudStatus.cloud_deletion_status !== 'processing' && 'Cloud deletion request pending'}
                      {cloudStatus.cloud_registration_status === 'deleted' && 'Cloud data deleted'}
                      {(cloudStatus.cloud_registration_status === 'unregistered' || cloudStatus.cloud_registration_status === 'registration_failed') && t('settings.notRegistered')}
                    </p>
                    <p className="text-xs text-gray-500">
                      {cloudStatus.cloud_registration_status === 'registered' && cloudServicesStopped && 'Enable Cloud Services below and save changes to resume cloud services.'}
                      {cloudStatus.cloud_registration_status === 'registered' && !cloudServicesStopped && (cloudStatus.cloud_last_heartbeat ? t('settings.liveChannelHeartbeat', { mode: cloudStatus.cloud_relay_mode.replace('_', ' '), time: formatTime(cloudStatus.cloud_last_heartbeat) }) : t('settings.liveChannel', { mode: cloudStatus.cloud_relay_mode.replace('_', ' ') }))}
                      {cloudStatus.cloud_registration_status === 'rejected' && t('settings.registrationContactSupport')}
                      {cloudStatus.cloud_registration_status === 'registration_failed' && (cloudStatus.cloud_last_error ? t('settings.registrationLastError', { error: cloudStatus.cloud_last_error }) : t('settings.registrationLastFailed'))}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && (cloudStatus.cloud_last_error || cloudStatus.cloud_deletion_status === 'failed') && 'The deletion request failed. You can refresh its status or retry the request from the privacy controls below.'}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && cloudStatus.cloud_deletion_status === 'processing' && 'Cloud deletion is being processed. Refresh its status or cancel it if cancellation is available.'}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && !cloudStatus.cloud_last_error && cloudStatus.cloud_deletion_status !== 'failed' && cloudStatus.cloud_deletion_status !== 'processing' && 'Cloud services remain stopped until the deletion request is resolved.'}
                      {cloudStatus.cloud_registration_status === 'deleted' && 'Cloud data has been deleted from FloCafe servers. Cloud services cannot be re-enabled on this installation.'}
                      {cloudStatus.cloud_registration_status === 'unregistered' && t('settings.registrationRegisterHelp')}
                    </p>
                  </div>
                </div>
                {cloudStatus.cloud_registration_status !== 'registered' && cloudStatus.cloud_registration_status !== 'deletion_pending' && cloudStatus.cloud_registration_status !== 'deleted' && (
                  <button
                    onClick={() => registerCloud('')}
                    disabled={registeringCloud}
                    className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium shrink-0"
                  >
                    {registeringCloud ? t('settings.registering') : t('settings.registerWithFloadmin')}
                  </button>
                )}
              </div>

              {cloudStatus.cloud_registration_status !== 'deleted' && (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">{t('settings.cloudManagedAutomatically')}</p>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cloudSettings.cloud_sync_enabled}
                    onChange={(e) => setCloudSettings({ ...cloudSettings, cloud_sync_enabled: e.target.checked })}
                    className="mt-0.5 rounded border-gray-300 text-brand focus:ring-brand"
                  />
                  <div>
                    <span className="text-sm font-medium text-gray-900 block">{cloudServicesStopped ? 'Enable Cloud Services' : t('settings.enableBillSync')}</span>
                    <p className="text-xs text-gray-500 mt-1">{cloudServicesStopped ? 'Resume cloud services and bill sync on this device.' : t('settings.enableBillSyncHint')}</p>
                  </div>
                </label>

                    {cloudSettings.cloud_last_sync && (
                      <p className="text-xs text-gray-400">{t('settings.lastSync', { time: formatDateTime(cloudSettings.cloud_last_sync) })}</p>
                    )}
                  </div>
              )}
                </>
              )}
            </div>

            {/* RevFlo — consolidated: download/QR + app (pairing) code + paired devices */}
            <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-5">
              <div className="flex items-center gap-2">
                <Smartphone size={20} className="text-gray-500" />
                <div>
                  <h2 className="font-semibold text-gray-900">{revflo?.name || t('settings.revflo')}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{revflo?.tagline || t('settings.revfloHint')}</p>
                </div>
              </div>

              {revflo?.available && (
                <div className="flex flex-col sm:flex-row gap-5 items-start border border-gray-100 rounded-xl p-5">
                  <div className="shrink-0">
                    {revflo.qr_data_url ? (
                      <img src={revflo.qr_data_url} alt={t('settings.appQrAlt', { name: revflo.name })}
                        className="w-28 h-28 rounded-lg border border-gray-200" />
                    ) : (
                      <div className="w-28 h-28 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400">
                        <QrCode size={32} />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3 text-sm">
                    {revflo.ios_url && (
                      <a href={revflo.ios_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                        {t('settings.downloadForIos')}
                      </a>
                    )}
                    {revflo.android_url && (
                      <a href={revflo.android_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                        {t('settings.downloadForAndroid')}
                      </a>
                    )}
                  </div>
                </div>
              )}

              <div>
                <p className="text-sm font-medium text-gray-900 mb-1">{t('settings.mobileApp')}</p>
                <p className="text-xs text-gray-500 mb-4">{t('settings.mobileAppHint')}</p>
                {pairingUnavailable ? (
                  <p className="text-sm text-gray-500">{t('settings.mobilePairingNeedsCloud')}</p>
                ) : pairingCode ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-4">
                      {pairingQrDataUrl && (
                        <img src={pairingQrDataUrl} alt={t('settings.pairingQrAlt')} className="w-28 h-28 rounded-lg border border-gray-200" />
                      )}
                      <div className="flex items-center gap-3 flex-1">
                      <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-center">
                        <span className="font-mono text-2xl font-bold tracking-[0.3em] text-gray-900">
                          <Ltr>{pairingCode.toUpperCase()}</Ltr>
                        </span>
                      </div>
                      <button
                        onClick={copyPairingCode}
                        className="p-2.5 border border-gray-200 rounded-lg hover:bg-gray-50 text-gray-500"
                        title={t('settings.copyCode')}
                      >
                        {copiedCode ? <Check size={18} className="text-green-600" /> : <Copy size={18} />}
                      </button>
                      </div>
                    </div>
                    {pairingExpiresAt && (
                      <p className="text-xs text-gray-400">
                        {t('settings.codeExpires', { date: formatDate(pairingExpiresAt) })}
                      </p>
                    )}
                    <p className="text-xs text-gray-500">
                      {t('settings.pairingCodeSingleUse')}
                    </p>
                    <button
                      onClick={rotatePairingCode}
                      disabled={rotatingCode}
                      className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
                    >
                      <RefreshCw size={14} className={rotatingCode ? 'animate-spin' : ''} />
                      {rotatingCode ? t('settings.generating') : t('settings.generateNewCode')}
                    </button>
                    <p className="text-xs text-amber-600">
                      {t('settings.disconnectDevicesWarning')}
                    </p>
                  </div>
                ) : (
                  <button
                    onClick={rotatePairingCode}
                    disabled={rotatingCode}
                    className="px-5 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium"
                  >
                    {rotatingCode ? t('settings.generating') : t('settings.generatePairingCode')}
                  </button>
                )}
              </div>

              {!pairingUnavailable && (
                <div className="pt-5 border-t border-gray-100">
                  <p className="text-sm font-medium text-gray-900 mb-3">{t('settings.pairedDevices')}</p>
                  {devicesLoading ? (
                    <p className="text-sm text-gray-400">{t('settings.loading')}</p>
                  ) : pairedDevices.length === 0 ? (
                    <p className="text-sm text-gray-500">{t('settings.noPairedDevices')}</p>
                  ) : (
                    <div className="space-y-2">
                      {pairedDevices.map((d) => (
                        <div key={d.id} className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-sm">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-gray-900 capitalize">
                              {d.platform || t('settings.unknownPlatform')}
                              {d.country ? ` · ${d.country}` : ''}
                            </span>
                            <span className="text-xs text-gray-400">
                              {t('settings.lastActive', { date: formatDate(d.last_seen_at) })}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-1">
                            {t('settings.firstPaired', { date: formatDate(d.first_seen_at) })}
                            {d.app_version ? ` · v${d.app_version}` : ''}
                          </p>
                          {d.user_agent && (
                            <p className="text-xs text-gray-400 mt-1 truncate" title={d.user_agent}>{d.user_agent}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          </div>
        </TabsContent>

        <TabsContent value="orderflow">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="space-y-6">
            <h2 className="text-lg font-semibold text-gray-900">{t('settings.tabOrderflow')}</h2>

            {/* OrderFlow — online orders */}
            <div className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Zap size={20} className="text-amber-500" />
                <div>
                  <h2 className="font-semibold text-gray-900">{t('settings.orderflowOnlineOrders')}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{t('settings.orderflowOnlineOrdersHint')}</p>
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cloudSettings.cloud_orders_enabled}
                  onChange={(e) => setCloudSettings({ ...cloudSettings, cloud_orders_enabled: e.target.checked })}
                  className="rounded border-gray-300 text-brand focus:ring-brand"
                />
                <span className="text-sm text-gray-700">{t('settings.enableOnlineOrderPolling')}</span>
              </label>

            </div>
            </div>
          </div>
        </TabsContent>

        {/* About tab */}
        <TabsContent value="about">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <h2 className="font-semibold text-gray-900 mb-4">{t('settings.aboutFloCafe')}</h2>
              <p className="text-sm text-gray-600 mb-6">
                {t('settings.aboutDescription')}
              </p>
              <div className="space-y-3">
                <a href="https://github.com/FreeOpenSourcePOS/FloCafe" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-brand hover:underline">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
                  GitHub Repository
                </a>
                <a href="https://flopos.com/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-brand hover:underline">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                  App Website
                </a>
              </div>
            </div>

            {/* More Apps — moved here from the old Integrations tab */}
            <div className="bg-white rounded-xl border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Smartphone size={20} className="text-gray-500" />
                <h2 className="font-semibold text-gray-900">{t('settings.moreApps')}</h2>
              </div>
              <p className="text-sm text-gray-500 mb-5">
                {t('settings.moreAppsHint')}
              </p>

              {moreAppsLoading && (
                <div className="flex items-center justify-center py-10">
                  <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {!moreAppsLoading && (
                <div className="space-y-4">
                  {moreApps.map((app) => (
                    <div key={app.id} className="flex flex-col sm:flex-row gap-5 items-start border border-gray-100 rounded-xl p-5">
                      <div className="shrink-0">
                        {app.qr_data_url ? (
                          <img src={app.qr_data_url} alt={t('settings.appQrAlt', { name: app.name })}
                            className="w-32 h-32 rounded-lg border border-gray-200" />
                        ) : (
                          <div className="w-32 h-32 rounded-lg border border-gray-200 flex items-center justify-center text-gray-400">
                            <QrCode size={36} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-gray-900">{app.name}</h3>
                          {!app.available && (
                            <span className="text-xs font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{t('settings.comingSoon')}</span>
                          )}
                        </div>
                        <p className="text-sm text-gray-500 mb-3">{app.tagline}</p>
                        <div className="flex gap-3 text-sm">
                          {app.ios_url && (
                            <a href={app.ios_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                              {t('settings.downloadForIos')}
                            </a>
                          )}
                          {app.android_url && (
                            <a href={app.android_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                              {t('settings.downloadForAndroid')}
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {moreApps.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-10">{t('settings.noAppsToShow')}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Software Updates tab */}
        <TabsContent value="updates">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="bg-white rounded-xl border border-gray-100 p-6">
            <div className="flex items-center gap-2 mb-4">
              <RefreshCw size={20} className="text-gray-500" />
              <h2 className="font-semibold text-gray-900">{t('settings.updates')}</h2>
            </div>
            <p className="text-sm text-gray-500 mb-6">
              {updateStatus?.status === 'store'
                ? t('settings.softwareUpdatesHintStore')
                : updateStatus?.status === 'linux-managed'
                ? t('settings.softwareUpdatesHintLinuxManaged')
                : t('settings.softwareUpdatesHintDefault')}
            </p>

            {updateStatus && updateStatus.status !== 'store' && updateStatus.status !== 'linux-managed' && (
              <div className={`p-4 rounded-lg mb-4 ${
                updateStatus.status === 'available' || updateStatus.status === 'ready-to-install'
                  ? 'bg-green-50 border border-green-200'
                  : updateStatus.status === 'error'
                  ? 'bg-red-50 border border-red-200'
                  : updateStatus.status === 'dev-mode'
                  ? 'bg-yellow-50 border border-yellow-200'
                  : 'bg-gray-50 border border-gray-200'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  {updateStatus.status === 'checking' && <RefreshCw size={16} className="animate-spin text-brand" />}
                  {updateStatus.status === 'available' && <Check size={16} className="text-green-600" />}
                  {updateStatus.status === 'up-to-date' && <CheckCircle2 size={16} className="text-green-600" />}
                  {updateStatus.status === 'ready-to-install' && <CheckCircle2 size={16} className="text-green-600" />}
                  {updateStatus.status === 'downloading' && <RefreshCw size={16} className="animate-spin text-brand" />}
                  {updateStatus.status === 'error' && <span className="text-red-600">✕</span>}
                  {updateStatus.status === 'dev-mode' && <span className="text-yellow-600">⚠</span>}
                  <span className="font-medium capitalize">
                    {updateStatus.status === 'available' ? t('settings.updateStatusAvailable')
                     : updateStatus.status === 'up-to-date' ? t('settings.updateStatusUpToDate')
                     : updateStatus.status === 'ready-to-install' ? t('settings.updateStatusReadyToInstall')
                     : updateStatus.status.replace(/-/g, ' ')}
                  </span>
                </div>
                {appVersion && (
                  <p className="text-sm font-medium text-gray-900">{t('settings.version')}: <Ltr>{appVersion}</Ltr></p>
                )}
                {updateStatus.version && updateStatus.version !== appVersion && (
                  <p className="text-sm text-gray-600 mt-1">Latest Available: <Ltr>{updateStatus.version}</Ltr></p>
                )}
                {updateStatus.percent !== undefined && (
                  <div className="mt-2">
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-brand h-2 rounded-full transition-all"
                        style={{ width: `${updateStatus.percent}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{t('settings.percentDownloaded', { percent: updateStatus.percent.toFixed(1) })}</p>
                  </div>
                )}
                {updateStatus.error && (
                  <p className="text-sm text-red-600 mt-1">{updateStatus.error}</p>
                )}
                {updateStatus.status === 'up-to-date' && (
                  <p className="text-sm text-gray-600">{t('settings.upToDate')}</p>
                )}
                {updateStatus.status === 'dev-mode' && (
                  <p className="text-sm text-yellow-600">{t('settings.devModeDisabled')}</p>
                )}
              </div>
            )}

            {updateStatus?.status !== 'store' && updateStatus?.status !== 'linux-managed' && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCheckUpdates}
                  disabled={updateStatus?.status === 'checking' || updateStatus?.status === 'downloading'}
                  className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50 bg-brand text-white hover:opacity-90"
                >
                  <RefreshCw size={16} className={updateStatus?.status === 'checking' ? 'animate-spin' : ''} />
                  {updateStatus?.status === 'checking' ? t('settings.checking') : t('settings.checkForUpdates')}
                </button>
              </div>
            )}
          </div>
          </div>
        </TabsContent>

</div>
</Tabs>
      {ConfirmDialog}

      {/* Table Info Dialog */}
      <Dialog open={tableInfoOpen} onOpenChange={setTableInfoOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.databaseTables')}</DialogTitle>
            <DialogDescription>{t('settings.rowCountsForAll')}</DialogDescription>
          </DialogHeader>
          <div className="max-h-60 overflow-y-auto space-y-1.5">
            {tableInfo.map((row) => (
              <div key={row.name} className="flex justify-between text-sm">
                <span className="text-gray-700 font-mono">{row.name}</span>
                <span className="text-gray-500">{row.rows.toLocaleString()} {t('settings.rows')}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTableInfoOpen(false)}>{t('settings.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Initialize Cloud Disclaimer Dialog */}
      <Dialog open={showInitializeCloudConfirm} onOpenChange={setShowInitializeCloudConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Initialize Cloud Services</DialogTitle>
            <DialogDescription>
              Allow diagnostic and usage data collection to improve the product.
              <br /><br />
              This enables basic telemetry and provisions your local database to communicate with the FloAdmin cloud servers for remote reporting and sync.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInitializeCloudConfirm(false)}>{t('settings.cancel')}</Button>
            <Button
              disabled={registeringCloud}
              onClick={() => { setShowInitializeCloudConfirm(false); registerCloud(''); }}
            >
              {registeringCloud ? t('settings.registering') : 'Accept & Initialize'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MasterPinPrompt
        open={pinGate !== null}
        mode={pinGate?.mode === 'set' ? 'set' : 'verify'}
        title={
          pinGate?.mode === 'backup' || pinGate?.mode === 'backup-custom' ? t('settings.confirmBackupTitle')
          : pinGate?.mode === 'import' ? t('settings.confirmImportTitle')
          : pinGate?.mode === 'restore' ? t('settings.confirmRestoreTitle')
          : pinGate?.mode === 'delete-cloud' ? 'Confirm cloud deletion request'
          : pinGate?.mode === 'cancel-cloud-deletion' ? 'Cancel cloud deletion request'
          : undefined
        }
        onCancel={() => setPinGate(null)}
        onSubmit={handlePinGateSubmit}
      />

      <HealthCheckDialog
        open={healthCheckOpen}
        onOpenChange={setHealthCheckOpen}
        report={healthReport}
        applying={applyingFixes}
        onApplySafeFixes={applySafeFixes}
      />

      <InitializeDatabaseDialog
        open={initializeDbOpen}
        onOpenChange={setInitializeDbOpen}
        onConfirm={handleInitializeDatabase}
        onSuccess={() => {
          toast.success(t('settings.dbInitializedRedirecting'));
          setTimeout(() => window.location.replace('/setup'), 1200);
        }}
      />
      {isAdmin && isDirty && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none animate-in slide-in-from-bottom-5 duration-300">
          <div className={`bg-gray-900 text-white px-6 py-4 rounded-full shadow-2xl flex items-center gap-6 pointer-events-auto ${shakeSaveBar ? 'animate-shake' : ''}`}>
            <span className="text-sm font-medium">{t('settings.unsavedChanges', { defaultValue: 'You have unsaved changes' })}</span>
            <div className="flex items-center gap-2">
              <button onClick={resetAllSettings} disabled={savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering} className="px-4 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded-full transition-colors disabled:opacity-50 text-white">{t('settings.discard', { defaultValue: 'Discard' })}</button>
              <button onClick={saveAllSettings} disabled={savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering} className="px-4 py-1.5 text-sm bg-brand hover:opacity-90 rounded-full font-medium transition-colors disabled:opacity-50 text-white">{(savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering) ? t('settings.saving') : t('settings.saveChanges', { defaultValue: 'Save Changes' })}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
