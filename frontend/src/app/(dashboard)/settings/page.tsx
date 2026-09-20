'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore, type BillTemplate } from '@/store/pos-settings';
import { useThemeMode, type ThemeMode } from '@/store/theme';
import type { KotLanguagePolicy, PrimaryLanguageSelection, ReceiptLanguagePolicy } from '@print/types';
import {
  parseStoredKotLanguagePolicy,
  parseStoredReceiptLanguagePolicy,
} from '@/lib/print-language-policies';
import { usePrinterStore } from '@/hooks/usePrinter';
import { Settings, Monitor, Users, Gift, Lock, Smartphone, RefreshCw, Copy, Check, Trash2, Plus, ChefHat, QrCode, CheckCircle2, Cloud, CloudOff, Zap, Percent, AlertTriangle, SunMoon } from 'lucide-react';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import axios from 'axios';
import toast from 'react-hot-toast';
import { normalizeOptionalPhone } from '@/lib/phone';
import { useConfirm } from '@/hooks/use-confirm';
import { MasterPinPrompt } from '@/components/settings/MasterPinPrompt';
import BetaChannelToggle from '@/components/settings/BetaChannelToggle';
import { HealthCheckDialog } from '@/components/settings/HealthCheckDialog';
import { InitializeDatabaseDialog } from '@/components/settings/InitializeDatabaseDialog';
import { WhatsAppEnableCard } from '@/components/settings/WhatsAppEnableCard';
import { TaxConfigurationPanel } from '@/components/settings/TaxConfigurationPanel';
import { PaymentMethodsSettings } from '@/components/settings/PaymentMethodsSettings';
import { GeneralSettingsTab, type BusinessForm, type InvoiceResetPeriod, type OrderNumberForm } from '@/components/settings/GeneralSettingsTab';
import {
  PrintersSettingsTab,
  type BillTemplateForm,
  type HwPrinter,
  type PrintingForm,
  type TemplateCard,
} from '@/components/settings/PrintersSettingsTab';
import {
  DatabaseSettingsTab,
  type BackupInfo,
  type GoogleDriveStatus,
  type ImportPayload,
  type MasterPinStatus,
  type PinGate,
} from '@/components/settings/DatabaseSettingsTab';
import { Toggle } from '@/components/settings/Toggle';
import { SettingsTabShell } from '@/components/settings/SettingsTabShell';
import type { HealthCheckReport } from '@/types/electron';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';


const CLOUD_ACCOUNT_STATUS_CHANGED_EVENT = 'flo:cloud-account-status-changed';

function isRequestCancelled(error: unknown): boolean {
  return axios.isCancel(error);
}

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


const TEMPLATE_CARDS: TemplateCard[] = [
  { id: 'classic', nameKey: 'billTemplateClassicName', preview: CLASSIC_PREVIEW, source: 'core', selectionSource: 'core' },
  { id: 'compact', nameKey: 'billTemplateCompactName', preview: COMPACT_PREVIEW, source: 'core', selectionSource: 'core' },
];

// Sanitize prefix on load to alphanumeric characters so legacy values pass save validation.
function sanitizeStoredNumberPrefix(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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
          : 'text-muted-foreground hover:bg-muted hover:text-foreground' + (indent ? ' border-transparent' : ''),
      ].join(' ')}
    >
      <span className="min-w-0 truncate">{label}</span>
      {attention && <span className="ms-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white" aria-label="Action required">1</span>}
    </button>
  );
}

function KdsDefaultViewCard() {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const [view, setView] = useState<'tabs' | 'kanban'>('tabs');
  const [savedView, setSavedView] = useState<'tabs' | 'kanban'>('tabs');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.get('/settings/kds', { signal: controller.signal }).then((res) => {
      if (controller.signal.aborted) return;
      const v = res.data?.kds_default_view === 'kanban' ? 'kanban' : 'tabs';
      setView(v);
      setSavedView(v);
    }).catch(() => {});
    return () => controller.abort();
  }, []);

  const dirty = view !== savedView;

  async function save() {
    setSaving(true);
    try {
      const { data } = await api.put('/settings/kds', { kds_default_view: view });
      const next = data?.kds_default_view === 'kanban' ? 'kanban' : 'tabs';
      setSavedView(next);
      setView(next);
      toast.success(t('kdsViewSaved'));
    } catch {
      toast.error(t('kdsViewSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center gap-2 mb-4">
        <Monitor size={20} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">{t('kdsDefaultView')}</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-5">{t('kdsDefaultViewHint')}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setView('tabs')}
          className={`text-start rounded-lg border-2 px-4 py-3 transition ${
            view === 'tabs'
              ? 'border-brand bg-brand/5'
              : 'border-border hover:border-gray-300 dark:border-border'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <input type="radio" readOnly checked={view === 'tabs'} className="text-brand" />
            <span className="font-medium text-foreground">{t('kdsDefaultViewTabs')}</span>
          </div>
          <p className="text-xs text-muted-foreground ms-6">{t('kdsDefaultViewTabsHint')}</p>
        </button>
        <button
          type="button"
          onClick={() => setView('kanban')}
          className={`text-start rounded-lg border-2 px-4 py-3 transition ${
            view === 'kanban'
              ? 'border-brand bg-brand/5'
              : 'border-border hover:border-gray-300 dark:border-border'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <input type="radio" readOnly checked={view === 'kanban'} className="text-brand" />
            <span className="font-medium text-foreground">{t('kdsDefaultViewKanban')}</span>
          </div>
          <p className="text-xs text-muted-foreground ms-6">{t('kdsDefaultViewKanbanHint')}</p>
        </button>
      </div>

      <div className="flex justify-end mt-5 pt-4 border-t border-border">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium text-sm"
        >
          {saving ? tCommon('saving') : tCommon('save')}
        </button>
      </div>
    </div>
  );
}


export default function SettingsPage() {
  const router = useRouter();
  const { currentTenant, user, updateCurrentTenant } = useAuthStore();
  const posSettings = usePosSettingsStore();
  const whatsappEnabled = posSettings.whatsappEnabled;
  const { printMethod, setPrintMethod } = usePrinterStore();
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const tRestore = useTranslations('restore');
  const tWhatsappSettings = useTranslations('whatsapp.settings');
  const { formatDate, formatTime, formatDateTime } = useFormatDate();
  const isAdmin = hasRole(currentTenant?.role, ROLE_ACCESS.ownerManager);
  const isOwner = hasRole(currentTenant?.role, ROLE_ACCESS.owner);
  const canViewTaxConfiguration = isAdmin;
  const { confirm, ConfirmDialog } = useConfirm();

  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [savedLoyaltyEnabled, setSavedLoyaltyEnabled] = useState(false);
  const [globalCashbackPercent, setGlobalCashbackPercent] = useState('0');
  const [savedGlobalCashbackPercent, setSavedGlobalCashbackPercent] = useState('0');
  const loyaltyFormRef = useRef({ loyaltyEnabled, globalCashbackPercent });
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
  const discountFormRef = useRef({ discountMaxPct, discountMaxAmount, discountMode, discountRequiresApproval });
  const [savingDiscount, setSavingDiscount] = useState(false);


  const searchParams = useSearchParams();
  const requestedTab = searchParams?.get('tab') || 'store';
  const requestedAction = searchParams?.get('action');
  // Deep-link query param state for active tab and database actions.
  const [activeTab, setActiveTab] = useState(requestedTab);
  const activeTabRef = useRef(activeTab);
  const hydrationTouchVersions = useRef(new Map<string, number>());
  const markHydrationTouched = (field: string) => {
    hydrationTouchVersions.current.set(field, (hydrationTouchVersions.current.get(field) || 0) + 1);
  };
  const loadedSettingsTabs = useRef(new Set<string>());
  const settingsTabLoadPromises = useRef(new Map<string, Promise<void>>());
  const settingsTabLoadControllers = useRef(new Map<string, AbortController>());
  const mobileAccessRequestGeneration = useRef(0);
  const mobileAccessRequestController = useRef<AbortController | null>(null);
  const businessHydrationPromise = useRef<Promise<void> | null>(null);
  const businessHydrationTenant = useRef<number | null>(null);
  const businessHydrated = useRef(false);
  const cloudHydrationPromise = useRef<Promise<void> | null>(null);
  const cloudHydrationTenant = useRef<number | null>(null);
  const cloudHydrationGeneration = useRef(0);
  const cloudHydrated = useRef(false);
  const cloudHydrationSucceeded = useRef(false);
  const cloudRegistrationStatus = useRef('unregistered');
  const healthCheckLoaded = useRef<string | null>(null);
  const [masterPinStatus, setMasterPinStatus] = useState<MasterPinStatus>({ available: false, isSet: false, schemaVersion: null });
  const [healthCheckOpen, setHealthCheckOpen] = useState(() => searchParams?.get('action') === 'health-check');
  const [healthReport, setHealthReport] = useState<HealthCheckReport | null>(null);
  const [applyingFixes, setApplyingFixes] = useState(false);
  const [initializeDbOpen, setInitializeDbOpen] = useState(() => searchParams?.get('action') === 'initialize-db');
  const [shakeSaveBar, setShakeSaveBar] = useState(false);
  const [savingAllSettings, setSavingAllSettings] = useState(false);
  const [saveAllHydrationRun, setSaveAllHydrationRun] = useState(0);
  const savingAllSettingsInFlight = useRef(false);

  const themeMode = useThemeMode((s) => s.mode);
  const setThemeMode = useThemeMode((s) => s.setMode);
  const markUserSelectedTheme = useThemeMode((s) => s.markUserSelected);

  // Last persisted theme value used as rollback target on failed saves.
  const lastCommitted = useRef<ThemeMode>('system');
  // Set the moment the user touches a control; hydration must not clobber a
  // later user choice with the stale DB row.
  const userTouched = useRef(false);
  // Hydration may race an in-flight save; seq snapshots order the winner.
  const saveSeq = useRef(0);
  // Armed when a save fails outright; the next hydration applies server truth.
  const needsServerTruth = useRef(false);
  const [savingTheme, setSavingTheme] = useState(false);

  // Optimistically updates theme store and rolls back on API failure.
  const saveThemeMode = async (next: ThemeMode) => {
    if (savingTheme) return;
    const previous = lastCommitted.current;
    const seq = ++saveSeq.current;
    userTouched.current = true;
    setSavingTheme(true);
    markUserSelectedTheme();
    setThemeMode(next);
    try {
      await api.put('/settings/theme_mode', { value: next });
      lastCommitted.current = next;
    } catch {
      setThemeMode(previous);
      toast.error(t('saveFailed'));
      if (saveSeq.current === seq) {
        try {
          const res = await api.get('/settings/theme_mode');
          const serverValue = res.data?.setting?.value;
          if (
            serverValue === 'light' ||
            serverValue === 'dark' ||
            serverValue === 'system'
          ) {
            setThemeMode(serverValue);
            lastCommitted.current = serverValue;
          }
        } catch {
          needsServerTruth.current = true;
        }
      }
    } finally {
      setSavingTheme(false);
    }
  };

  // Sync active settings tab when query string changes while mounted.
  useEffect(() => {
    // This is navigation state arriving from Next.js, not an async data effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab(requestedTab);
  }, [requestedTab]);

  const handleSettingsTabChange = (value: string) => {
    setActiveTab(value);
    const nextParams = new URLSearchParams(searchParams?.toString());
    if (value === 'store') {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', value);
    }
    const query = nextParams.toString();
    router.replace(query ? `/settings?${query}` : '/settings');
  };

  // Unified PIN gate: 'set' opens the set/change-PIN dialog; 'backup'/'backup-custom'/
  // 'import'/'restore' open a verify prompt and, on success, run the pending action.
  const [pinGate, setPinGate] = useState<PinGate>(() => searchParams?.get('action') === 'master-pin' ? { mode: 'set' } : null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  // Starts true until the Data tab performs its first load.
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

  const fetchCloudAccount = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const { data } = await api.get('/settings/cloud/account', signal ? { signal } : undefined);
      if (signal?.aborted) return false;
      setCloudAccount(data);
      setCloudAccountLoadFailed(false);
      return true;
    } catch (error) {
      if (isRequestCancelled(error)) return false;
      setCloudAccountLoadFailed(true);
      return false;
    }
  };

  const fetchMasterPinStatus = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const { data } = await api.get('/db-tools/master-pin/status', signal ? { signal } : undefined);
      if (signal?.aborted) return false;
      setMasterPinStatus(data);
      return true;
    } catch (error) {
      if (isRequestCancelled(error)) return false;
      // ignore — card just shows "Unknown" state until retried
      return false;
    }
  };

  const fetchBackups = async (signal?: AbortSignal): Promise<boolean> => {
    setBackupsLoading(true);
    try {
      const { data } = await api.get('/db-tools/backups', signal ? { signal } : undefined);
      if (signal?.aborted) return false;
      setBackups(data.backups ?? []);
      return true;
    } catch (error) {
      if (isRequestCancelled(error)) return false;
      // ignore — history card just shows empty state until retried
      return false;
    } finally {
      if (!signal?.aborted) setBackupsLoading(false);
    }
  };

  const runHealthCheck = async () => {
    setHealthCheckOpen(true);
    try {
      const { data } = await api.get('/db-tools/health-check');
      setHealthReport(data);
    } catch {
      toast.error(t('healthCheckFailed'));
      setHealthCheckOpen(false);
    }
  };

  const applySafeFixes = async () => {
    setApplyingFixes(true);
    try {
      const { data } = await api.post('/db-tools/apply-safe-fixes', {});
      if (data.errors?.length) {
        toast.error(t('fixesAppliedPartial', { applied: data.applied.length, failed: data.errors.length }));
      } else {
        toast.success(t('fixesApplied', { count: data.applied.length }));
      }
      await runHealthCheck();
    } catch {
      toast.error(t('applyingFixesFailed'));
    } finally {
      setApplyingFixes(false);
    }
  };

  const runImport = async (data: ImportPayload, overwrite: boolean, master_pin?: string) => {
    try {
      const response = await api.post('/db/import', { data, overwrite, master_pin });
      if (response.data.success) toast.success(t('importSuccess'));
      return { success: true };
    } catch {
      const message = t('importFailed');
      toast.error(message);
      return { success: false, error: message };
    }
  };

  const handlePinGateSubmit = async (pin: string): Promise<{ success: boolean; error?: string }> => {
    if (!pinGate) return { success: false, error: t('nothingPending') };

    if (pinGate.mode === 'set') {
      try {
        await api.post('/db-tools/master-pin/reset', { pin, confirm_pin: pin });
        await fetchMasterPinStatus();
        toast.success(t('masterPinSaved'));
        setPinGate(null);
        return { success: true };
      } catch {
        return { success: false, error: t('savePinFailed') };
      }
    }

    if (pinGate.mode === 'backup') {
      try {
        const response = await api.post('/db/backup', { master_pin: pin });
        toast.success(`${t('backupCreated')} ${response.data.path}`, { duration: 5000 });
        setPinGate(null);
        fetchBackups();
        return { success: true };
      } catch {
        return { success: false, error: t('backupFailedGeneric') };
      }
    }

    if (pinGate.mode === 'backup-custom') {
      if (!window.electronAPI?.backupDatabase) {
        return { success: false, error: tCommon('notAvailable') };
      }
      const result = await window.electronAPI.backupDatabase(pin);
      if (result.success) {
        toast.success(`${t('backupCreated')} ${result.path}`, { duration: 5000 });
        setPinGate(null);
        return { success: true };
      }
      if (result.error === 'Cancelled') {
        setPinGate(null);
        return { success: true };
      }
      return { success: false, error: result.error || t('backupFailedGeneric') };
    }

    if (pinGate.mode === 'restore') {
      if (!window.electronAPI?.restoreBackup) {
        return { success: false, error: tCommon('notAvailable') };
      }
      const result = await window.electronAPI.restoreBackup(pin, pinGate.payload.backupPath);
      if (result.success) {
        toast.success(tRestore('success'));
        setPinGate(null);
        setTimeout(() => window.location.reload(), 1500);
        return { success: true };
      }
      if (result.error === 'Cancelled') {
        setPinGate(null);
        return { success: true };
      }
      return { success: false, error: result.error || t('restoreFailedGeneric') };
    }

    if (pinGate.mode === 'delete-backup') {
      try {
        await api.post(`/db-tools/backups/${encodeURIComponent(pinGate.payload.fileName)}/delete`, { master_pin: pin });
        toast.success(t('backupDeleted'));
        setPinGate(null);
        fetchBackups();
        return { success: true };
      } catch {
        return { success: false, error: t('backupDeleteFailed') };
      }
    }

    if (pinGate.mode === 'delete-cloud') {
      try {
        await api.post('/settings/cloud/delete-data', { master_pin: pin, confirmation: 'DELETE CLOUD DATA' });
        toast.success(t('cloudDeletionSubmitted'));
        await Promise.all([fetchCloudAccount(), refreshCloudStatus()]);
        notifyCloudAccountStatusChanged();
        setPinGate(null);
        return { success: true };
      } catch {
        await Promise.all([fetchCloudAccount(), refreshCloudStatus()]);
        notifyCloudAccountStatusChanged();
        return { success: false, error: t('cloudDeletionFailed') };
      }
    }

    if (pinGate.mode === 'cancel-cloud-deletion') {
      try {
        await api.post('/settings/cloud/delete-data/cancel', { master_pin: pin });
        toast.success(t('cloudDeletionCancelled'));
        await Promise.all([fetchCloudAccount(), refreshCloudStatus()]);
        notifyCloudAccountStatusChanged();
        setPinGate(null);
        return { success: true };
      } catch {
        return { success: false, error: t('cloudDeletionCancelFailed') };
      }
    }

    // mode === 'import'
    const result = await runImport(pinGate.payload.data, pinGate.payload.overwrite, pin);
    if (result.success) setPinGate(null);
    return result;
  };

  const handleCreateBackup = async () => {
    if (masterPinStatus.available && !masterPinStatus.isSet) {
      toast.error(t('masterPinRequiredForBackup'));
      return;
    }
    if (!masterPinStatus.available) {
      try {
        const response = await api.post('/db/backup', {});
        toast.success(`${t('backupCreated')} ${response.data.path}`, { duration: 5000 });
      } catch {
        toast.error(t('backupFailed'));
      }
      return;
    }
    setPinGate({ mode: 'backup' });
  };

  // Prompt native file dialog to export a backup to a custom directory.
  const handleChooseBackupLocation = async () => {
    if (masterPinStatus.available && !masterPinStatus.isSet) {
      toast.error(t('masterPinRequiredForBackup'));
      return;
    }
    if (!masterPinStatus.available) {
      if (!window.electronAPI?.backupDatabase) {
        toast.error(tCommon('notAvailable'));
        return;
      }
      const result = await window.electronAPI.backupDatabase('');
      if (result.success) {
        toast.success(`${t('backupCreated')} ${result.path}`, { duration: 5000 });
      } else if (result.error !== 'Cancelled') {
        toast.error(result.error || t('backupFailedGeneric'));
      }
      return;
    }
    setPinGate({ mode: 'backup-custom' });
  };

  const handleRestoreFromHistory = async (backup: BackupInfo) => {
    const ok = await confirm(t('restoreConfirm', { fileName: backup.fileName }), {
      title: t('confirmRestoreTitle'),
      confirmLabel: t('restoreBackup'),
      destructive: true,
    });
    if (!ok) return;

    if (masterPinStatus.available && !masterPinStatus.isSet) {
      toast.error(t('setMasterPinFirst'));
      return;
    }
    if (!masterPinStatus.available) {
      if (!window.electronAPI?.restoreBackup) {
        toast.error(tCommon('notAvailable'));
        return;
      }
      const result = await window.electronAPI.restoreBackup('', backup.path);
      if (result.success) {
        toast.success(tRestore('success'));
        setTimeout(() => window.location.reload(), 1500);
      } else if (result.error !== 'Cancelled') {
        toast.error(result.error || t('restoreFailedGeneric'));
      }
      return;
    }
    setPinGate({ mode: 'restore', payload: { backupPath: backup.path } });
  };

  const handleDeleteBackup = async (backup: BackupInfo) => {
    const ok = await confirm(t('deleteBackupConfirm', { fileName: backup.fileName }), {
      title: t('confirmDeleteBackupTitle'),
      confirmLabel: t('deleteBackup'),
      destructive: true,
    });
    if (!ok) return;

    if (masterPinStatus.available && !masterPinStatus.isSet) {
      toast.error(t('setMasterPinFirst'));
      return;
    }
    if (!masterPinStatus.available) {
      try {
        await api.post(`/db-tools/backups/${encodeURIComponent(backup.fileName)}/delete`, {});
        toast.success(t('backupDeleted'));
        fetchBackups();
      } catch {
        toast.error(t('backupDeleteFailed'));
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
      return { success: false, error: t('initializeFailedGeneric') };
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
  // Starts true until the KDS tab performs its first load; fetchKdsInfo
  // sets it explicitly for manual refresh.
  const [kdsInfoLoading, setKdsInfoLoading] = useState(true);

  const fetchKdsInfo = async (signal?: AbortSignal): Promise<boolean> => {
    setKdsInfoLoading(true);
    try {
      const res = await api.get('/kds-info', signal ? { signal } : undefined);
      if (signal?.aborted) return false;
      setKdsInfo(res.data);
      return true;
    } catch (error) {
      if (isRequestCancelled(error)) return false;
      if (!signal?.aborted) toast.error(t('kdsInfoFetchFailed'));
      return false;
    } finally {
      if (!signal?.aborted) setKdsInfoLoading(false);
    }
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
      toast.error(t('serverAppInfoFetchFailed'));
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
      toast.error(t('posInfoFetchFailed'));
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
  // Starts true until the About tab performs its first load.
  const [moreAppsLoading, setMoreAppsLoading] = useState(true);
  const [revflo, setRevflo] = useState<MoreApp | null>(null);

  // ── Updates ─────────────────────────────────────────────────────────────────
  const { updateStatus, appVersion, isElectron, checkForUpdates: handleCheckUpdates } = useUpdateStatus();

  // ── Printers ─────────────────────────────────────────────────────────────
  const [hwPrinters, setHwPrinters] = useState<HwPrinter[]>([]);

  const fetchPrinters = async (signal?: AbortSignal) => {
    try {
      const res = await api.get('/printers', signal ? { signal } : undefined);
      if (!signal?.aborted) setHwPrinters(res.data.printers || []);
    } catch (error) {
      if (!isRequestCancelled(error)) return;
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

  const fetchStations = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const res = await api.get('/kitchen-stations', signal ? { signal } : undefined);
      if (signal?.aborted) return false;
      setStations(res.data.kitchenStations || []);
      return true;
    } catch { return false; }
  };
  const fetchStationCategories = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const res = await api.get('/categories', signal ? { signal } : undefined);
      if (signal?.aborted) return false;
      setStationCategories(res.data.categories || []);
      return true;
    } catch { return false; }
  };
  const fetchStationStaff = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      const res = await api.get('/staff', signal ? { signal } : undefined);
      if (signal?.aborted) return false;
      setStationStaff(res.data.staff || []);
      return true;
    } catch { return false; }
  };
  const fetchStationUsers = async (stationId: string, signal?: AbortSignal) => {
    try {
      const res = await api.get(`/kitchen-stations/${stationId}`, signal ? { signal } : undefined);
      if (!signal?.aborted) {
        setStationUsersByStation((prev) => ({ ...prev, [stationId]: res.data.kitchenStation.users || [] }));
      }
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
    if (!stationForm.name.trim()) { toast.error(t('stationNameRequired')); return; }
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
      toast.success(editingStationId ? t('stationUpdated') : t('stationSaved'));
      setShowStationForm(false);
      fetchStations();
    } catch {
      toast.error(t('stationSaveFailed'));
    } finally {
      setSavingStation(false);
    }
  };

  const deleteStation = async (id: string) => {
    if (!await confirm(t('stationDeleteConfirm'), { destructive: true, confirmLabel: tCommon('delete') })) return;
    try {
      await api.delete(`/kitchen-stations/${id}`);
      toast.success(t('stationDeleted'));
      fetchStations();
    } catch {
      toast.error(t('stationDeleteFailed'));
    }
  };

  useEffect(() => {
    if (activeTab !== 'kds') return;
    const controller = new AbortController();
    stations.forEach((s) => {
      if (!stationUsersByStation[s.id]) fetchStationUsers(s.id, controller.signal);
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, activeTab]);

  // Cash drawer pulse: active custom payment methods (beyond built-in cash/card)
  const [pulseCustomMethods, setPulseCustomMethods] = useState<string[]>([]);
  useEffect(() => {
    if (activeTab !== 'receipts-printers') return;
    const controller = new AbortController();
    api.get('/payment-methods', { signal: controller.signal }).then(({ data }) => {
      setPulseCustomMethods((data.payment_methods || []).map((m: { name: string }) => m.name));
    }).catch((error) => {
      if (isRequestCancelled(error)) return;
      toast.error(t('loadFailed'));
    });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Mobile App Pairing
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = useState<string | null>(null);
  // Defaults true so button cannot be clicked before registration status
  // is known from /settings/cloud.
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
  const initPrinting = (): PrintingForm => ({
    printerEnabled: posSettings.printerEnabled,
    printerPaperSize: posSettings.printerPaperSize,
    cashDrawerPulseEnabled: undefined,
    cashDrawerPulseMethods: ['cash', 'card'],
    printMethod: printMethod as 'escpos' | 'browser',
    autoPrintKot: posSettings.autoPrintKot,
    autoPrintBill: posSettings.autoPrintBill,
    whatsappShareEnabled: posSettings.whatsappShareEnabled,
    printerUseUnicode: posSettings.printerUseUnicode,
    printerArabicShaping: posSettings.printerArabicShaping,
    printerTrimDecimals: posSettings.printerTrimDecimals,
    receiptPrimaryLanguage: posSettings.billLanguagePolicy.primary.mode === 'fixed'
      ? posSettings.billLanguagePolicy.primary.language
      : 'inherit',
    receiptSecondLanguage: posSettings.billLanguagePolicy.additional[0] ?? 'none',
    zReportPrimaryLanguage: 'inherit',
    zReportSecondLanguage: 'none',
    kotLanguage: posSettings.kotLanguagePolicy.primary.mode === 'fixed'
      ? posSettings.kotLanguagePolicy.primary.language
      : 'inherit',
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
  const printingFormRef = useRef(printingForm);
  const mergeHydratedPrinting = (patch: Partial<PrintingForm>, initial: PrintingForm, touchedAtHydrationStart = new Map<string, number>()) => {
    setPrintingForm((previous) => {
      const applicablePatch = Object.fromEntries(
        Object.entries(patch).filter(([key]) => {
          const field = key as keyof PrintingForm;
          const touchedAfterStart = (hydrationTouchVersions.current.get(key) || 0) > (touchedAtHydrationStart.get(key) || 0);
          return !touchedAfterStart && Object.is(previous[field], initial[field]);
        }),
      ) as Partial<PrintingForm>;
      return { ...previous, ...applicablePatch };
    });
  };
  const [zReportLanguagePolicyLoaded, setZReportLanguagePolicyLoaded] = useState(false);
  const [savingPrinting, setSavingPrinting] = useState(false);
  const printingSaveInFlight = useRef(false);
  const savePrinting = async (silent: boolean = false) => {
    if (printingSaveInFlight.current) return;
    printingSaveInFlight.current = true;
    setSavingPrinting(true);
    const formSnapshot = printingForm;
    try {
      const receiptPrimary: PrimaryLanguageSelection = formSnapshot.receiptPrimaryLanguage === 'inherit'
        ? { mode: 'inherit' }
        : { mode: 'fixed', language: formSnapshot.receiptPrimaryLanguage };
      const dedupedSecond = formSnapshot.receiptSecondLanguage !== 'none'
        && !(receiptPrimary.mode === 'fixed' && receiptPrimary.language === formSnapshot.receiptSecondLanguage)
        ? formSnapshot.receiptSecondLanguage
        : null;
      const billLanguagePolicy: ReceiptLanguagePolicy = dedupedSecond !== null
        ? { primary: receiptPrimary, additional: [dedupedSecond] as const }
        : { primary: receiptPrimary, additional: [] as const };
      const kotLanguagePolicy: KotLanguagePolicy = {
        primary: formSnapshot.kotLanguage === 'inherit' ? { mode: 'inherit' } : { mode: 'fixed', language: formSnapshot.kotLanguage },
        additional: [] as const,
      };
      const zReportPrimary: PrimaryLanguageSelection = formSnapshot.zReportPrimaryLanguage === 'inherit'
        ? { mode: 'inherit' }
        : { mode: 'fixed', language: formSnapshot.zReportPrimaryLanguage };
      const zReportSecond = formSnapshot.zReportSecondLanguage !== 'none'
        && !(zReportPrimary.mode === 'fixed' && zReportPrimary.language === formSnapshot.zReportSecondLanguage)
        ? formSnapshot.zReportSecondLanguage
        : null;
      const zReportLanguagePolicy: ReceiptLanguagePolicy = zReportSecond !== null
        ? { primary: zReportPrimary, additional: [zReportSecond] as const }
        : { primary: zReportPrimary, additional: [] as const };
      const printingPayload = {
        printer_trim_decimals: formSnapshot.printerTrimDecimals,
        bill_language_policy: billLanguagePolicy,
        kot_language_policy: kotLanguagePolicy,
        ...(zReportLanguagePolicyLoaded ? { z_report_language_policy: zReportLanguagePolicy } : {}),
        bill_show_name: formSnapshot.billShowName,
        bill_show_address: formSnapshot.billShowAddress,
        bill_show_phone: formSnapshot.billShowPhone,
        bill_show_tax_id: formSnapshot.billShowTaxId,
        bill_show_tax_breakdown: formSnapshot.billShowTaxBreakdown,
        bill_show_customer_name: formSnapshot.billShowCustomerName,
        bill_show_customer_phone: formSnapshot.billShowCustomerPhone,
        bill_show_table_number: formSnapshot.billShowTableNumber,
        ...(formSnapshot.cashDrawerPulseEnabled !== undefined ? {
          cash_drawer_pulse_enabled: formSnapshot.cashDrawerPulseEnabled,
          cash_drawer_pulse_methods: formSnapshot.cashDrawerPulseMethods,
        } : {}),
      };
      await api.put('/settings/printing', printingPayload);
      posSettings.setPrinterEnabled(formSnapshot.printerEnabled);
      posSettings.setPrinterPaperSize(formSnapshot.printerPaperSize);
      setPrintMethod(formSnapshot.printMethod);
      posSettings.setAutoPrintKot(formSnapshot.autoPrintKot);
      posSettings.setAutoPrintBill(formSnapshot.autoPrintBill);
      posSettings.setWhatsappShareEnabled(formSnapshot.whatsappShareEnabled);
      posSettings.setPrinterUseUnicode(formSnapshot.printerUseUnicode);
      posSettings.setPrinterArabicShaping(formSnapshot.printerArabicShaping);
      posSettings.setPrinterTrimDecimals(formSnapshot.printerTrimDecimals);
      posSettings.setBillLanguagePolicy(billLanguagePolicy);
      posSettings.setKotLanguagePolicy(kotLanguagePolicy);
      posSettings.setBillShowName(formSnapshot.billShowName);
      posSettings.setBillShowAddress(formSnapshot.billShowAddress);
      posSettings.setBillShowPhone(formSnapshot.billShowPhone);
      posSettings.setBillShowTaxId(formSnapshot.billShowTaxId);
      posSettings.setBillShowTaxBreakdown(formSnapshot.billShowTaxBreakdown);
      posSettings.setBillShowCustomerName(formSnapshot.billShowCustomerName);
      posSettings.setBillShowCustomerPhone(formSnapshot.billShowCustomerPhone);
      posSettings.setBillShowTableNumber(formSnapshot.billShowTableNumber);
      setSavedPrinting(formSnapshot);
      if (!silent) toast.success(t('printingSettingsSaved'));
    } finally {
      printingSaveInFlight.current = false;
      setSavingPrinting(false);
    }
  };
  const resetPrinting = () => setPrintingForm(savedPrinting);

  // Bill template local state; billTemplateSource preserves pack
  // qualifier if ID collides with core template names.
  const initBillTemplate = (): BillTemplateForm => ({
    billTemplate: posSettings.billTemplate,
    billTemplateSource: 'core',
    billFooterMessage: posSettings.billFooterMessage,
  });
  const [billForm, setBillForm] = useState<BillTemplateForm>(initBillTemplate);
  const [savedBillForm, setSavedBillForm] = useState<BillTemplateForm>(initBillTemplate);
  const billFormRef = useRef(billForm);
  const [billTemplateCards, setBillTemplateCards] = useState<TemplateCard[]>(TEMPLATE_CARDS);
  const saveBillTemplate = async (silent: boolean = false) => {
    posSettings.setBillTemplate(billForm.billTemplate);
    posSettings.setBillTemplateSource(billForm.billTemplateSource);
    posSettings.setBillFooterMessage(billForm.billFooterMessage);
    // Persist bare ID for core templates, structured { source, id }
    // for pack and merchant templates.
    const templateValue = billForm.billTemplateSource === 'core'
      ? billForm.billTemplate
      : JSON.stringify({ source: billForm.billTemplateSource, id: billForm.billTemplate });
    await Promise.all([
      api.put('/settings/bill_template', { value: templateValue }),
      api.put('/settings/bill_footer_message', { value: billForm.billFooterMessage }),
    ]);
    setSavedBillForm(billForm);
    if (!silent) toast.success(t('billTemplateSaved'));
  };
  const resetBillTemplate = () => setBillForm(savedBillForm);

  // Store / business fields — local form state (saved only on explicit Save)
  const [savedBusiness, setSavedBusiness] = useState<BusinessForm>({
    businessName: '', countryCode: '', timezone: '', businessDayStartTime: '00:00', currency: '', billingType: 'postpaid',
    tablesRequired: true,
    taxRegistered: false,
    taxRegistrationNumber: '', businessAddress: '', businessPhone: '', instagramHandle: '',
    currencyDisplay: 'rial',
    numberDigits: 'locale',
    calendar: 'locale',
  });
  const [form, setForm] = useState<BusinessForm>(savedBusiness);
  const businessFormRef = useRef(form);
  const [savingBusiness, setSavingBusiness] = useState(false);
  // Server-resolved tax format from country tax pack or static fallback;
  // drives immediate warning feedback below the field.
  const [taxIdFormat, setTaxIdFormat] = useState<{ pattern: string; description: string } | null>(null);
  const [taxIdFormatCountryCode, setTaxIdFormatCountryCode] = useState('');

  const [cloudSettings, setCloudSettings] = useState({
    cloud_api_key: '',
    cloud_store_id: '',
    cloud_sync_enabled: false,
    cloud_orders_enabled: false,
    cloud_last_sync: null as string | null,
  });
  const [savedCloudSettings, setSavedCloudSettings] = useState(cloudSettings);
  const cloudSettingsRef = useRef(cloudSettings);
  const [cloudStatus, setCloudStatus] = useState({
    cloud_registration_status: 'unregistered',
    cloud_services_disabled_by_user: false,
    cloud_connected: false,
    cloud_relay_mode: 'disconnected',
    cloud_last_heartbeat: null as string | null,
    cloud_last_error: null as string | null,
    cloud_deletion_status: '',
  });
  const [cloudPrivacyHydrated, setCloudPrivacyHydrated] = useState(false);
   
  const [savingCloud, setSavingCloud] = useState(false);
  const [registeringCloud, setRegisteringCloud] = useState(false);
  const [showInitializeCloudConfirm, setShowInitializeCloudConfirm] = useState(false);

  const cloudServicesStopped = cloudStatus.cloud_services_disabled_by_user;
  const cloudDeletionFinal = !cloudPrivacyHydrated || cloudAccountLoadFailed || cloudStatus.cloud_registration_status === 'deleted' || ['approved', 'completed', 'deleted'].includes(cloudStatus.cloud_deletion_status);
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
      toast.success(t('cloudDeletionStatusRefreshed'));
    } catch {
      toast.error(t('cloudDeletionStatusRefreshFailed'));
    } finally {
      setRefreshingDeletionStatus(false);
    }
  };

  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [savingTelemetry, setSavingTelemetry] = useState(false);

  const [diagnosticsConsent, setDiagnosticsConsent] = useState(false);
  const [savingDiagnosticsConsent, setSavingDiagnosticsConsent] = useState(false);

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

  // Kitchen workflow toggle states (defaults to enabled).
  const [kdsEnabledSetting, setKdsEnabledSetting] = useState(true);
  const [savingKdsEnabled, setSavingKdsEnabled] = useState(false);
  const [serverAppEnabledSetting, setServerAppEnabledSetting] = useState(true);
  const [savingServerAppEnabled, setSavingServerAppEnabled] = useState(false);
  const [serverAppBillPrintingEnabledSetting, setServerAppBillPrintingEnabledSetting] = useState(false);
  const [savingServerAppBillPrintingEnabled, setSavingServerAppBillPrintingEnabled] = useState(false);
  const [kotPrintingEnabledSetting, setKotPrintingEnabledSetting] = useState(true);
  const [savingKotPrintingEnabled, setSavingKotPrintingEnabled] = useState(false);

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
  const orderNumberFormRef = useRef(orderNumberForm);
  const [savingOrderNumbering, setSavingOrderNumbering] = useState(false);

  useEffect(() => {
    loyaltyFormRef.current = { loyaltyEnabled, globalCashbackPercent };
    discountFormRef.current = { discountMaxPct, discountMaxAmount, discountMode, discountRequiresApproval };
    activeTabRef.current = activeTab;
    printingFormRef.current = printingForm;
    billFormRef.current = billForm;
    businessFormRef.current = form;
    cloudSettingsRef.current = cloudSettings;
    orderNumberFormRef.current = orderNumberForm;
  }, [
    loyaltyEnabled,
    globalCashbackPercent,
    discountMaxPct,
    discountMaxAmount,
    discountMode,
    discountRequiresApproval,
    activeTab,
    printingForm,
    billForm,
    form,
    cloudSettings,
    orderNumberForm,
  ]);

  const mergeHydratedValues = <T extends object>(previous: T, initial: T, loaded: T, touchedAtHydrationStart: Map<string, number>): T => {
    const previousValues = previous as Record<string, unknown>;
    const initialValues = initial as Record<string, unknown>;
    return Object.fromEntries(Object.entries(loaded).map(([key, value]) => [
      key,
      (hydrationTouchVersions.current.get(key) || 0) > (touchedAtHydrationStart.get(key) || 0)
        || !Object.is(previousValues[key], initialValues[key])
        ? previousValues[key]
        : value,
    ])) as T;
  };

  const resetBusiness = async () => {
    try {
      const [businessRes, loyaltyRes, discountRes, orderNumberingRes] = await Promise.all([
        api.get('/settings/business'),
        api.get('/settings/loyalty'),
        api.get('/settings/discount'),
        api.get('/settings/order-numbering'),
      ]);

      const d = businessRes.data;
      const loaded: BusinessForm = {
        businessName: d.business_name || '',
        countryCode: d.country || '',
        timezone: d.timezone || '',
        businessDayStartTime: d.business_day_start_time || '00:00',
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
      setTaxIdFormat(d.tax_id_format || null);
      setTaxIdFormatCountryCode(loaded.countryCode);
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
        prefix: orderNumberingRes.data.order_number_prefix == null ? 'ORD' : sanitizeStoredNumberPrefix(orderNumberingRes.data.order_number_prefix),
        includeDate: orderNumberingRes.data.order_number_include_date !== false,
        resetDaily: orderNumberingRes.data.order_number_reset_daily !== false,
        invoicePrefix: orderNumberingRes.data.invoice_number_prefix == null ? 'INV' : sanitizeStoredNumberPrefix(orderNumberingRes.data.invoice_number_prefix),
        invoiceIncludePeriod: orderNumberingRes.data.invoice_number_include_period !== false,
        invoiceResetPeriod: (orderNumberingRes.data.invoice_number_reset_period || 'daily') as InvoiceResetPeriod,
        invoiceFinancialYearStartMonth: Number(orderNumberingRes.data.invoice_financial_year_start_month) || 4,
        invoiceFinancialYearStartDay: Number(orderNumberingRes.data.invoice_financial_year_start_day) || 1,
      };
      setOrderNumberForm(loadedOrderNumbering);
      setSavedOrderNumberForm(loadedOrderNumbering);

      toast.success(t('reloadedFromDb'));
    } catch {
      toast.error(t('reloadFailed'));
    }
  };

  const fetchGoogleDriveStatus = async (signal?: AbortSignal) => {
    try {
      const res = await api.get('/settings/google-drive', signal ? { signal } : undefined);
      if (signal?.aborted) return;
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
    } catch (error) {
      if (isRequestCancelled(error)) return;
      // Leave defaults (not configured / not connected) — this section is
      // optional and must never block the rest of Settings from loading.
    }
  };

  const loadPairedDevices = async (signal?: AbortSignal) => {
    setDevicesLoading(true);
    try {
      const res = await api.get('/mobile/devices', signal ? { signal } : undefined);
      if (signal?.aborted) return;
      setPairedDevices(res.data.devices || []);
    } catch (error) {
      if (isRequestCancelled(error)) return;
      setPairedDevices([]);
    } finally {
      if (!signal?.aborted) setDevicesLoading(false);
    }
  };

  const loadSettingsTab = async (tab: string, signal: AbortSignal, includeStatusOnly = true): Promise<void> => {
    const get = (path: string) => api.get(path, { signal });
    const active = () => !signal.aborted;
    const hydrationTouchSnapshot = new Map(hydrationTouchVersions.current);
    const readOptional = async (path: string) => {
      try {
        return await get(path);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) return null;
        throw error;
      }
    };

    const loadBusiness = async () => {
      const tenantId = currentTenant?.id ?? null;
      if (businessHydrationTenant.current !== tenantId) {
        businessHydrationTenant.current = tenantId;
        businessHydrated.current = false;
        businessHydrationPromise.current = null;
      }
      if (businessHydrated.current) return;
      if (businessHydrationPromise.current) {
        try {
          await businessHydrationPromise.current;
        } catch (error) {
          if (!active() || !isRequestCancelled(error)) throw error;
        }
        if (businessHydrated.current || !active()) return;
      }

      const businessFormAtHydrationStart = { ...businessFormRef.current };
      const printingAtHydrationStart = { ...printingFormRef.current };
      const promise = (async () => {
        const { data: d } = await get('/settings/business');
        if (!active()) {
          businessHydrationPromise.current = null;
          return;
        }
        const loaded: BusinessForm = {
          businessName: d.business_name || '',
          countryCode: d.country || '',
          timezone: d.timezone || '',
          businessDayStartTime: d.business_day_start_time || '00:00',
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
        const mergedBusiness = mergeHydratedValues(
          businessFormRef.current,
          businessFormAtHydrationStart,
          loaded,
          hydrationTouchSnapshot,
        );
        setSavedBusiness(loaded);
        setForm(mergedBusiness);
        setTaxIdFormat(d.tax_id_format || null);
        setTaxIdFormatCountryCode(loaded.countryCode);
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
        mergeHydratedPrinting(billDisplay, printingAtHydrationStart, hydrationTouchSnapshot);
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
        businessHydrated.current = true;
      })();
      businessHydrationPromise.current = promise;
      try {
        await promise;
      } catch (error) {
        if (businessHydrationPromise.current === promise) businessHydrationPromise.current = null;
        throw error;
      }
    };

    const loadCloud = async (required = false) => {
      const cloudSettingsAtHydrationStart = { ...cloudSettingsRef.current };
      let registrationStatus = cloudRegistrationStatus.current;
      const tenantId = currentTenant?.id ?? null;
      if (cloudHydrationTenant.current !== tenantId) {
        cloudHydrationTenant.current = tenantId;
        cloudHydrationGeneration.current += 1;
        cloudHydrated.current = false;
        cloudHydrationSucceeded.current = false;
        cloudHydrationPromise.current = null;
        cloudRegistrationStatus.current = 'unregistered';
        setCloudPrivacyHydrated(false);
      }
      const loadGeneration = cloudHydrationGeneration.current;
      try {
        if (cloudHydrated.current) {
          if (required && !cloudHydrationSucceeded.current && active()) throw new Error('Cloud hydration failed');
          registrationStatus = cloudRegistrationStatus.current;
        } else {
          if (cloudHydrationPromise.current) {
            try {
              await cloudHydrationPromise.current;
            } catch (error) {
              if (cloudHydrationGeneration.current !== loadGeneration || !active()) return;
              if (!isRequestCancelled(error)) throw error;
            }
          }
          if (cloudHydrationGeneration.current !== loadGeneration || !active()) {
            return;
          }
          if (cloudHydrated.current) {
            if (required && !cloudHydrationSucceeded.current && active()) throw new Error('Cloud hydration failed');
            registrationStatus = cloudRegistrationStatus.current;
          } else {
            const requestGeneration = cloudHydrationGeneration.current;
            const promise = (async () => {
              const { data } = await get('/settings/cloud');
              if (!active()) {
                if (cloudHydrationGeneration.current === requestGeneration) {
                  cloudHydrationPromise.current = null;
                }
                return;
              }
              if (cloudHydrationGeneration.current !== requestGeneration) return;
              const settings = {
                cloud_api_key: data.cloud_api_key || '',
                cloud_store_id: data.cloud_store_id || '',
                cloud_sync_enabled: !!data.cloud_sync_enabled,
                cloud_orders_enabled: !!data.cloud_orders_enabled,
                cloud_last_sync: data.cloud_last_sync || null,
              };
              registrationStatus = data.cloud_registration_status || 'unregistered';
              cloudRegistrationStatus.current = registrationStatus;
              const mergedCloudSettings = mergeHydratedValues(cloudSettingsRef.current, cloudSettingsAtHydrationStart, settings, hydrationTouchSnapshot);
              setCloudSettings(mergedCloudSettings);
              setSavedCloudSettings(settings);
              setCloudStatus({
                cloud_registration_status: data.cloud_registration_status || 'unregistered',
                cloud_services_disabled_by_user: !!data.cloud_services_disabled_by_user,
                cloud_connected: !!data.cloud_connected,
                cloud_relay_mode: data.cloud_relay_mode || 'disconnected',
                cloud_last_heartbeat: data.cloud_last_heartbeat || null,
                cloud_last_error: data.cloud_last_error || null,
                cloud_deletion_status: data.cloud_deletion_status || '',
              });
              cloudHydrationSucceeded.current = true;
              cloudHydrated.current = true;
            })();
            cloudHydrationPromise.current = promise;
            try {
              await promise;
            } catch (error) {
              if (cloudHydrationPromise.current === promise && isRequestCancelled(error)) {
                cloudHydrationPromise.current = null;
              }
              throw error;
            }
          }
        }
      } catch (error) {
        if (!active() || isRequestCancelled(error) || required) throw error;
        cloudHydrationSucceeded.current = false;
        cloudHydrated.current = true;
        cloudRegistrationStatus.current = 'unregistered';
        registrationStatus = 'unregistered';
        setCloudStatus((previous) => ({
          ...previous,
          cloud_registration_status: 'unregistered',
          cloud_connected: false,
          cloud_relay_mode: 'disconnected',
        }));
      }

      if (tab !== 'mobile-access' || !includeStatusOnly || !active()) return;
      if (registrationStatus !== 'registered') {
        setPairingUnavailable(true);
        return;
      }
      try {
        const pairingResponse = await get('/mobile/pairing-code');
        if (active()) {
          setPairingCode(pairingResponse.data.pairing_code);
          setPairingExpiresAt(pairingResponse.data.expires_at);
          setPairingQrDataUrl(pairingResponse.data.qr_data_url || null);
          setPairingUnavailable(false);
        }
      } catch (error) {
        if (!isRequestCancelled(error) && active()) setPairingUnavailable(true);
      }
      await loadPairedDevices(signal);
    };

    const loadPrinting = async (printingAtHydrationStart: PrintingForm, billFormAtHydrationStart: BillTemplateForm) => {
      const [trimResponse, cashEnabledResponse, cashMethodsResponse, billLanguageResponse, kotLanguageResponse] = await Promise.all([
        readOptional('/settings/printer_trim_decimals'),
        readOptional('/settings/cash_drawer_pulse_enabled'),
        readOptional('/settings/cash_drawer_pulse_methods'),
        readOptional('/settings/bill_language_policy'),
        readOptional('/settings/kot_language_policy'),
      ]);
      if (!active()) return;

      if (trimResponse) {
        const enabled = trimResponse.data.setting?.value === 'true';
        posSettings.setPrinterTrimDecimals(enabled);
        mergeHydratedPrinting({ printerTrimDecimals: enabled }, printingAtHydrationStart, hydrationTouchSnapshot);
        setSavedPrinting((p) => ({ ...p, printerTrimDecimals: enabled }));
      }
      if (cashEnabledResponse) {
        const raw = cashEnabledResponse.data.setting?.value;
        if (raw === 'true' || raw === 'false') {
          const enabled = raw === 'true';
          setSavedPrinting((p) => ({ ...p, cashDrawerPulseEnabled: enabled }));
          // Missing rows intentionally remain undefined so thermal printing keeps
          // its legacy per-printer fallback.
          mergeHydratedPrinting({ cashDrawerPulseEnabled: enabled }, printingAtHydrationStart, hydrationTouchSnapshot);
        }
      }
      if (cashMethodsResponse) {
        try {
          const methods = JSON.parse(cashMethodsResponse.data.setting?.value || '[]');
          if (Array.isArray(methods)) {
            const valid = methods.filter((method: unknown): method is string => typeof method === 'string');
            const normalized = methods.length > 0 && valid.length === 0 ? ['cash', 'card'] : valid;
            mergeHydratedPrinting({ cashDrawerPulseMethods: normalized }, printingAtHydrationStart, hydrationTouchSnapshot);
            setSavedPrinting((p) => ({ ...p, cashDrawerPulseMethods: normalized }));
          }
        } catch { /* Use the safe defaults. */ }
      }
      if (billLanguageResponse) {
        const policy = parseStoredReceiptLanguagePolicy(billLanguageResponse.data?.setting?.value);
        if (policy) {
          posSettings.setBillLanguagePolicy(policy);
          const formPatch = {
            receiptPrimaryLanguage: policy.primary.mode === 'fixed' ? policy.primary.language : 'inherit',
            receiptSecondLanguage: policy.additional[0] ?? 'none',
          };
          mergeHydratedPrinting(formPatch, printingAtHydrationStart, hydrationTouchSnapshot);
          setSavedPrinting((p) => ({ ...p, ...formPatch }));
        }
      }
      if (kotLanguageResponse) {
        const policy = parseStoredKotLanguagePolicy(kotLanguageResponse.data?.setting?.value);
        if (policy) {
          posSettings.setKotLanguagePolicy(policy);
          const formPatch = { kotLanguage: policy.primary.mode === 'fixed' ? policy.primary.language : 'inherit' };
          mergeHydratedPrinting(formPatch, printingAtHydrationStart, hydrationTouchSnapshot);
          setSavedPrinting((p) => ({ ...p, ...formPatch }));
        }
      }
      const zReportResponse = await readOptional('/settings/z_report_language_policy');
      if (!active()) return;
      if (zReportResponse) {
        const policy = parseStoredReceiptLanguagePolicy(zReportResponse.data?.setting?.value);
        if (policy) {
          const formPatch = {
            zReportPrimaryLanguage: policy.primary.mode === 'fixed' ? policy.primary.language : 'inherit',
            zReportSecondLanguage: policy.additional[0] ?? 'none',
          };
          mergeHydratedPrinting(formPatch, printingAtHydrationStart, hydrationTouchSnapshot);
          setSavedPrinting((p) => ({ ...p, ...formPatch }));
          setZReportLanguagePolicyLoaded(true);
        }
      } else {
        setZReportLanguagePolicyLoaded(true);
      }

      const [templatesResponse, templateResponse, footerResponse] = await Promise.all([
        readOptional('/settings/bill-templates'),
        readOptional('/settings/bill_template'),
        readOptional('/settings/bill_footer_message'),
      ]);
      if (!active()) return;
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
        selectionSource: 'pack' as const,
        description: `${template.country} tax template · ${template.paperColumns.join(', ')} columns`,
      }));
      const merchantCards: TemplateCard[] = (templatesResponse?.data?.merchant || [])
        .filter((template: { status: string }) => template.status === 'active')
        .map((template: {
          id: string;
          displayName: string;
          origin: 'created' | 'imported' | 'cloned';
          documentType: string;
        }) => ({
          id: template.id,
          displayName: template.displayName,
          preview: `  ${template.displayName}\n-----------\nReceipt\n${template.documentType} · custom blocks\n-----------\nTOTAL`,
          source: 'merchant' as const,
          selectionSource: 'merchant' as const,
          description: t('billTemplateMerchantDesc'),
          originBadgeKey: template.origin === 'cloned'
            ? ('billTemplateMerchantCloned' as const)
            : template.origin === 'imported'
              ? ('billTemplateMerchantImported' as const)
              : ('billTemplateMerchantCreated' as const),
        }));
      const cards = [...TEMPLATE_CARDS, ...pluginCards, ...merchantCards];
      setBillTemplateCards(cards);
      let storedId: unknown = templateResponse?.data.setting?.value;
      let storedSource: string | null = null;
      if (typeof storedId === 'string' && storedId.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(storedId) as { source?: unknown; id?: unknown };
          if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string'
            && (parsed.source === 'core' || parsed.source === 'pack' || parsed.source === 'merchant')) {
            storedId = parsed.id;
            storedSource = parsed.source;
          }
        } catch { /* keep raw value */ }
      }
      const candidateCard = typeof storedId === 'string' ? cards.find((card) => card.id === storedId) : undefined;
      const matchedCard = candidateCard && storedSource !== null && candidateCard.selectionSource !== storedSource
        ? cards.find((card) => card.id === candidateCard.id && card.selectionSource === storedSource)
        : candidateCard;
      const billTemplate: BillTemplate = matchedCard ? matchedCard.id : 'classic';
      const billTemplateSource: 'core' | 'pack' | 'merchant' = matchedCard ? matchedCard.selectionSource : 'core';
      const billFooterMessage = footerResponse?.data.setting?.value ?? posSettings.billFooterMessage;
      const loadedBillForm = { billTemplate, billTemplateSource, billFooterMessage };
      posSettings.setBillTemplate(billTemplate);
      posSettings.setBillTemplateSource(billTemplateSource);
      posSettings.setBillFooterMessage(billFooterMessage);
      const mergedBillForm = mergeHydratedValues(billFormRef.current, billFormAtHydrationStart, loadedBillForm, hydrationTouchSnapshot);
      setBillForm(mergedBillForm);
      setSavedBillForm(loadedBillForm);
    };

    try {
      if (tab === 'appearance') {
        const seqAtFetch = saveSeq.current;
        const { data } = await get('/settings/theme_mode');
        if (!active()) return;
        const raw = data?.setting?.value;
        if (raw === 'light' || raw === 'dark' || raw === 'system') {
          if (!userTouched.current || needsServerTruth.current) setThemeMode(raw);
          if (saveSeq.current === seqAtFetch) lastCommitted.current = raw;
          if (needsServerTruth.current) needsServerTruth.current = false;
        }
        return;
      }
      if (tab === 'store') {
        const orderNumberAtHydrationStart = { ...orderNumberFormRef.current };
        await loadBusiness();
        const { data } = await get('/settings/order-numbering');
        if (!active()) return;
        const loaded: OrderNumberForm = {
          prefix: data.order_number_prefix == null ? 'ORD' : sanitizeStoredNumberPrefix(data.order_number_prefix),
          includeDate: data.order_number_include_date !== false,
          resetDaily: data.order_number_reset_daily !== false,
          invoicePrefix: data.invoice_number_prefix == null ? 'INV' : sanitizeStoredNumberPrefix(data.invoice_number_prefix),
          invoiceIncludePeriod: data.invoice_number_include_period !== false,
          invoiceResetPeriod: (data.invoice_number_reset_period || 'daily') as InvoiceResetPeriod,
          invoiceFinancialYearStartMonth: Number(data.invoice_financial_year_start_month) || 4,
          invoiceFinancialYearStartDay: Number(data.invoice_financial_year_start_day) || 1,
        };
        const mergedOrderNumbering = mergeHydratedValues(orderNumberFormRef.current, orderNumberAtHydrationStart, loaded, hydrationTouchSnapshot);
        setOrderNumberForm(mergedOrderNumbering);
        setSavedOrderNumberForm(loaded);
        return;
      }
      if (tab === 'receipts-printers') {
        const printingAtHydrationStart = { ...printingFormRef.current };
        const billFormAtHydrationStart = { ...billFormRef.current };
        await loadBusiness();
        await Promise.all([
          fetchPrinters(signal),
          loadPrinting(printingAtHydrationStart, billFormAtHydrationStart),
          readOptional('/settings/kot_printing_enabled').then((res) => {
            if (!active()) return;
            const enabled = res?.data.setting?.value !== 'false';
            setKotPrintingEnabledSetting(enabled);
            posSettings.setKotPrintingEnabled(enabled);
          }),
        ]);
        return;
      }
      if (tab === 'kds') {
        const [kdsInfoLoaded, stationsLoaded, categoriesLoaded, staffLoaded, settingLoaded] = await Promise.all([
          fetchKdsInfo(signal),
          fetchStations(signal),
          fetchStationCategories(signal),
          fetchStationStaff(signal),
          get('/settings/kds_enabled').then((res) => {
            if (!active()) return false;
            const enabled = res.data.setting?.value !== 'false';
            setKdsEnabledSetting(enabled);
            posSettings.setKdsEnabled(enabled);
            return true;
          }).catch((error) => {
            if (isRequestCancelled(error)) throw error;
            return false;
          }),
        ]);
        if (!kdsInfoLoaded || !stationsLoaded || !categoriesLoaded || !staffLoaded || !settingLoaded) {
          throw new Error('KDS hydration failed');
        }
        return;
      }
      if (tab === 'server-app') {
        const [{ data }, { data: billPrintData }] = await Promise.all([
          get('/settings/server_app_enabled'),
          get('/settings/server_app_bill_printing_enabled'),
        ]);
        if (active()) {
          setServerAppEnabledSetting(data.setting?.value !== 'false');
          setServerAppBillPrintingEnabledSetting(billPrintData.setting?.value === 'true');
        }
        return;
      }
      if (tab === 'loyalty') {
        const loyaltyAtHydrationStart = { ...loyaltyFormRef.current };
        const [loyaltyResponse, candidatesResponse] = await Promise.all([
          get('/settings/loyalty'),
          get('/products/loyalty/global-rate-candidates'),
        ]);
        if (!active()) return;
        const loadedLoyalty = {
          loyaltyEnabled: !!loyaltyResponse.data.loyalty_enabled,
          globalCashbackPercent: String(loyaltyResponse.data.global_cashback_percent ?? 0),
        };
        const mergedLoyalty = mergeHydratedValues(loyaltyFormRef.current, loyaltyAtHydrationStart, loadedLoyalty, hydrationTouchSnapshot);
        setLoyaltyEnabled(mergedLoyalty.loyaltyEnabled);
        setSavedLoyaltyEnabled(loadedLoyalty.loyaltyEnabled);
        setGlobalCashbackPercent(mergedLoyalty.globalCashbackPercent);
        setSavedGlobalCashbackPercent(loadedLoyalty.globalCashbackPercent);
        setGlobalRateCandidates(Number(candidatesResponse.data.count) || 0);
        return;
      }
      if (tab === 'discounts') {
        const discountAtHydrationStart = { ...discountFormRef.current };
        const { data } = await get('/settings/discount');
        if (!active()) return;
        const loadedDiscount = { ...discountAtHydrationStart };
        if (data.discount_max_percentage !== undefined) loadedDiscount.discountMaxPct = normalizeDiscountPercentage(data.discount_max_percentage);
        if (data.discount_max_amount !== undefined) loadedDiscount.discountMaxAmount = normalizeDiscountAmount(data.discount_max_amount);
        if (data.discount_mode) loadedDiscount.discountMode = data.discount_mode;
        if (data.discount_requires_approval !== undefined) loadedDiscount.discountRequiresApproval = !!data.discount_requires_approval;
        const mergedDiscount = mergeHydratedValues(discountFormRef.current, discountAtHydrationStart, loadedDiscount, hydrationTouchSnapshot);
        setDiscountMaxPct(mergedDiscount.discountMaxPct);
        setSavedDiscountMaxPct(loadedDiscount.discountMaxPct);
        setDiscountMaxAmount(mergedDiscount.discountMaxAmount);
        setSavedDiscountMaxAmount(loadedDiscount.discountMaxAmount);
        setDiscountMode(mergedDiscount.discountMode);
        setSavedDiscountMode(loadedDiscount.discountMode);
        setDiscountRequiresApproval(mergedDiscount.discountRequiresApproval);
        setSavedDiscountRequiresApproval(loadedDiscount.discountRequiresApproval);
        return;
      }
      if (tab === 'privacy') {
        setCloudPrivacyHydrated(false);
        const [telemetryResponse, diagnosticsResponse] = await Promise.all([
          get('/settings/telemetry_enabled').catch(() => null),
          get('/settings/diagnostics_consent').catch(() => null),
        ]);
        if (!active()) return;
        setTelemetryEnabled(telemetryResponse ? telemetryResponse.data.setting?.value === 'true' : false);
        setDiagnosticsConsent(diagnosticsResponse ? diagnosticsResponse.data.setting?.value !== 'false' : true);
        const [cloudLoaded, accountLoaded] = await Promise.all([
          loadCloud(true).then(() => true).catch((error) => {
            if (isRequestCancelled(error)) throw error;
            return false;
          }),
          isOwner ? fetchCloudAccount(signal) : Promise.resolve(true),
        ]);
        if (!cloudLoaded || !accountLoaded) throw new Error('Privacy hydration failed');
        if (active()) setCloudPrivacyHydrated(true);
        return;
      }
      if (tab === 'data') {
        void fetchGoogleDriveStatus(signal);
        const [masterPinLoaded, backupsLoaded] = await Promise.all([
          fetchMasterPinStatus(signal),
          fetchBackups(signal),
        ]);
        if (!masterPinLoaded || !backupsLoaded) throw new Error('Data hydration failed');
        return;
      }
      if (tab === 'account') {
        if (isOwner) await fetchCloudAccount(signal);
        return;
      }
      if (tab === 'about') {
        setMoreAppsLoading(true);
        try {
          const moreAppsResponse = await get('/more-apps');
          if (active()) {
            setMoreApps(moreAppsResponse.data.apps || []);
          }
        } catch (error) {
          if (isRequestCancelled(error)) throw error;
        } finally {
          if (active()) setMoreAppsLoading(false);
        }
        return;
      }
      if (tab === 'mobile-access' || tab === 'orderflow') {
        if (tab === 'mobile-access' && includeStatusOnly) {
          try {
            const revfloResponse = await get('/more-apps/revflo');
            if (active()) setRevflo(revfloResponse.data.app || null);
          } catch (error) {
            if (isRequestCancelled(error)) throw error;
          }
        }
        await loadCloud(!includeStatusOnly);
      }
    } catch (error) {
      if (!isRequestCancelled(error) && active()) {
        // Individual Settings sections are best-effort; the panel remains usable
        // and its existing manual refresh actions remain available.
      }
      throw error;
    }
  };

  const startSettingsTabLoad = (tab: string, controller: AbortController, includeStatusOnly = true): Promise<void> => {
    const tenantId = currentTenant?.id;
    if (!tenantId) return Promise.resolve();
    const { signal } = controller;
    const key = `${tenantId}:${tab}${tab === 'mobile-access' && !includeStatusOnly ? ':status' : ''}`;
    const requiresCloudHydration = tab === 'mobile-access' && !includeStatusOnly && !cloudHydrationSucceeded.current;
    if (loadedSettingsTabs.current.has(key) && !requiresCloudHydration) return Promise.resolve();
    const existing = settingsTabLoadPromises.current.get(key);
    if (existing) return existing;
    const promise = loadSettingsTab(tab, signal, includeStatusOnly).then(() => {
      if (!signal.aborted) loadedSettingsTabs.current.add(key);
    });
    settingsTabLoadPromises.current.set(key, promise);
    settingsTabLoadControllers.current.set(key, controller);
    void promise.then(() => {
      if (settingsTabLoadPromises.current.get(key) === promise) {
        settingsTabLoadPromises.current.delete(key);
        if (settingsTabLoadControllers.current.get(key) === controller) {
          settingsTabLoadControllers.current.delete(key);
        }
      }
    }, () => {
      if (settingsTabLoadPromises.current.get(key) === promise) {
        settingsTabLoadPromises.current.delete(key);
        if (settingsTabLoadControllers.current.get(key) === controller) {
          settingsTabLoadControllers.current.delete(key);
        }
      }
    });
    return promise;
  };

  useEffect(() => {
    if (!currentTenant?.id) return;
    const key = `${currentTenant.id}:${activeTab}`;
    if (loadedSettingsTabs.current.has(key)) return;
    const tabLoadPromises = settingsTabLoadPromises.current;
    const tabLoadControllers = settingsTabLoadControllers.current;
    const controller = new AbortController();
    void startSettingsTabLoad(activeTab, controller)
      .catch(() => {});
    return () => {
      controller.abort();
      if (tabLoadPromises.has(key)) {
        tabLoadPromises.delete(key);
      }
      if (tabLoadControllers.get(key) === controller) {
        tabLoadControllers.delete(key);
      }
    };
  // The tab and tenant identity are the intentional hydration boundaries.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, currentTenant?.id, isOwner]);

  useEffect(() => {
    mobileAccessRequestGeneration.current += 1;
    mobileAccessRequestController.current?.abort();
    mobileAccessRequestController.current = null;
    return () => {
      mobileAccessRequestGeneration.current += 1;
      mobileAccessRequestController.current?.abort();
      mobileAccessRequestController.current = null;
      setRotatingCode(false);
    };
  }, [activeTab, currentTenant?.id]);

  useEffect(() => {
    if (requestedAction !== 'health-check' || !currentTenant?.id) return;
    const key = `${currentTenant.id}:health-check`;
    if (healthCheckLoaded.current === key) return;
    const controller = new AbortController();
    api.get('/db-tools/health-check', { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return;
      healthCheckLoaded.current = key;
      setHealthReport(data);
    }).catch((error) => {
      if (!isRequestCancelled(error) && !controller.signal.aborted) {
        toast.error(t('healthCheckFailed'));
        setHealthCheckOpen(false);
      }
    });
    return () => controller.abort();
  }, [activeTab, currentTenant?.id, requestedAction, t]);

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
      if (!silent) toast.success(t('cloudSaved'));
    } catch (err) {
      if (!silent) toast.error(t('cloudSaveFailed'));
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
      const registrationStatus = res.data.cloud_registration_status || 'unregistered';
      cloudRegistrationStatus.current = registrationStatus;
      cloudHydrationGeneration.current += 1;
      cloudHydrated.current = false;
      cloudHydrationSucceeded.current = false;
      cloudHydrationPromise.current = null;
      setCloudStatus({
        cloud_registration_status: registrationStatus,
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
      if (registrationStatus === 'registered') {
        const mobileAccessKeys = currentTenant?.id
          ? [`${currentTenant.id}:mobile-access`, `${currentTenant.id}:mobile-access:status`]
          : [];
        mobileAccessKeys.forEach((key) => {
          settingsTabLoadControllers.current.get(key)?.abort();
          settingsTabLoadControllers.current.delete(key);
          settingsTabLoadPromises.current.delete(key);
          loadedSettingsTabs.current.delete(key);
        });
        if (activeTabRef.current === 'mobile-access') {
          const controller = new AbortController();
          mobileAccessRequestController.current = controller;
          try {
            await startSettingsTabLoad('mobile-access', controller);
          } finally {
            if (mobileAccessRequestController.current === controller) {
              mobileAccessRequestController.current = null;
            }
            controller.abort();
          }
        }
        toast.success(t('cloudRegistrationSuccess'));
      }
    } catch (error) {
      if (isRequestCancelled(error)) return;
      toast.error(t('cloudRegistrationFailed'));
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
      toast.error(t('saveFailed'));
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
      toast.error(t('saveFailed'));
    } finally {
      setSavingDiagnosticsConsent(false);
    }
  };

  const connectGoogleDrive = async () => {
    setConnectingGoogleDrive(true);
    try {
      const res = await api.post('/settings/google-drive/connect');
      setGoogleDriveStatus((prev) => ({ ...prev, ...res.data }));
      toast.success(t('googleDriveConnectedSuccess'));
      fetchBackups();
    } catch {
      toast.error(t('googleDriveConnectFailed'));
    } finally {
      setConnectingGoogleDrive(false);
    }
  };

  const disconnectGoogleDrive = async () => {
    const ok = await confirm(t('googleDriveDisconnectConfirm'), {
      confirmLabel: t('googleDriveDisconnect'),
      destructive: true,
    });
    if (!ok) return;
    setDisconnectingGoogleDrive(true);
    try {
      const res = await api.post('/settings/google-drive/disconnect');
      setGoogleDriveStatus((prev) => ({ ...prev, ...res.data }));
      toast.success(t('googleDriveDisconnectedSuccess'));
    } catch {
      toast.error(t('googleDriveDisconnectFailed'));
    } finally {
      setDisconnectingGoogleDrive(false);
    }
  };

  const backupToGoogleDriveNow = async () => {
    setBackingUpGoogleDrive(true);
    try {
      const res = await api.post('/settings/google-drive/backup-now');
      setGoogleDriveStatus((prev) => ({ ...prev, ...res.data }));
      toast.success(t('googleDriveBackupSuccess'));
      fetchBackups();
    } catch {
      toast.error(t('googleDriveBackupFailed'));
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
      toast.error(t('googleDriveSavePreferencesFailed'));
    } finally {
      setSavingGoogleDrivePrefs(false);
    }
  };

  // Saved immediately because turning KDS off invalidates pairing tokens server-side.
  const saveKdsEnabled = async (enabled: boolean) => {
    const previous = kdsEnabledSetting;
    setKdsEnabledSetting(enabled);
    posSettings.setKdsEnabled(enabled);
    setSavingKdsEnabled(true);
    try {
      await api.put('/settings/kds_enabled', { value: enabled ? 'true' : 'false' });
      toast.success(enabled ? t('kdsEnabledOn') : t('kdsEnabledOff'));
    } catch {
      setKdsEnabledSetting(previous);
      posSettings.setKdsEnabled(previous);
      toast.error(t('saveFailed'));
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
        ? t('serverAppEnabledOn')
        : t('serverAppEnabledOff'));
    } catch {
      setServerAppEnabledSetting(previous);
      toast.error(t('saveFailed'));
    } finally {
      setSavingServerAppEnabled(false);
    }
  };

  const saveServerAppBillPrintingEnabled = async (enabled: boolean) => {
    const previous = serverAppBillPrintingEnabledSetting;
    setServerAppBillPrintingEnabledSetting(enabled);
    setSavingServerAppBillPrintingEnabled(true);
    try {
      await api.put('/settings/server_app_bill_printing_enabled', { value: enabled ? 'true' : 'false' });
      toast.success(enabled
        ? t('serverAppBillPrintingEnabledOn')
        : t('serverAppBillPrintingEnabledOff'));
    } catch {
      setServerAppBillPrintingEnabledSetting(previous);
      toast.error(t('saveFailed'));
    } finally {
      setSavingServerAppBillPrintingEnabled(false);
    }
  };

  const saveKotPrintingEnabled = async (enabled: boolean) => {
    const previous = kotPrintingEnabledSetting;
    setKotPrintingEnabledSetting(enabled);
    posSettings.setKotPrintingEnabled(enabled);
    setSavingKotPrintingEnabled(true);
    try {
      await api.put('/settings/kot_printing_enabled', { value: enabled ? 'true' : 'false' });
      toast.success(enabled ? t('kotPrintingEnabledOn') : t('kotPrintingEnabledOff'));
    } catch {
      setKotPrintingEnabledSetting(previous);
      posSettings.setKotPrintingEnabled(previous);
      toast.error(t('saveFailed'));
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
      if (!silent) toast.success(t('loyaltySaved'));
    } catch (err) {
      if (!silent) toast.error(t('saveFailed'));
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
      toast.success(t('applyGlobalRateDone', { count: updated }));
    } catch {
      toast.error(t('saveFailed'));
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
      if (!silent) toast.success(t('discountSaved'));
    } catch (err) {
      if (!silent) toast.error(t('saveFailed'));
      throw err;
    } finally {
      setSavingDiscount(false);
    }
  };

  const saveBusinessInfo = async (silent = false) => {
    const norm = normalizeOptionalPhone(form.businessPhone, form.countryCode || '');
    if (!norm.valid) {
      toast.error(t('invalidPhoneFormat'));
      return;
    }
    const normalizedBusinessPhone = norm.e164 ?? '';

    setSavingBusiness(true);
    try {
      const putRes = await api.put('/settings/business', {
        business_name: form.businessName,
        timezone: form.timezone,
        business_day_start_time: form.businessDayStartTime,
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
      let resolvedTaxIdFormat = putRes.data?.tax_id_format || null;
      if (savedBusiness.countryCode !== form.countryCode) {
        const taxSetting = await api.get('/settings/taxes_enabled').catch(() => null);
        if (taxSetting?.data.setting?.value === 'true') {
          try {
            const ensureRes = await api.post('/tax-packs/ensure-country', { country: form.countryCode });
            resolvedTaxIdFormat = ensureRes.data?.tax_id_format || null;
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
              toast.error(t('taxSupportUnavailable', { country: form.countryCode }));
            } else {
              toast.error(t('countrySavedTaxPluginFailed'));
            }
          }
        }
      }
      const updatedForm = { ...form, businessPhone: normalizedBusinessPhone };
      setSavedBusiness(updatedForm);
      setForm(updatedForm);
      setTaxIdFormat(resolvedTaxIdFormat);
      setTaxIdFormatCountryCode(form.countryCode);
      posSettings.setBillTaxRegistrationNumber(form.taxRegistrationNumber);
      posSettings.setBillAddress(form.businessAddress);
      posSettings.setBillPhone(normalizedBusinessPhone);
      posSettings.setBillingType(form.billingType);
      posSettings.setTablesRequired(form.tablesRequired);
      updateCurrentTenant({ currency: form.currency, timezone: form.timezone, business_day_start_time: form.businessDayStartTime, country: form.countryCode, currency_display: form.currencyDisplay, number_digits: form.numberDigits, calendar: form.calendar });
      if (!silent) toast.success(t('storeSaved'));
    } catch (err: unknown) {
      const responseData = (err as { response?: { data?: unknown } }).response?.data;
      const serverError = responseData && typeof responseData === 'object'
        ? responseData as { error?: string; tax_id_format?: { pattern: string; description: string } }
        : null;
      if (!silent) {
        const message = serverError?.error || t('saveFailed');
        toast.error(message);
      }
      if (serverError?.tax_id_format) {
        setTaxIdFormat(serverError.tax_id_format);
        setTaxIdFormatCountryCode(form.countryCode);
      }
      throw err;
    } finally {
      setSavingBusiness(false);
    }
  };

  const saveOrderNumbering = async (silent = false) => {
    const prefix = orderNumberForm.prefix.trim();
    if (prefix && !/^[A-Za-z0-9]{0,12}$/.test(prefix)) {
      toast.error(t('orderNumberPrefixInvalid'));
      return;
    }
    const invoicePrefix = orderNumberForm.invoicePrefix.trim();
    if (invoicePrefix && !/^[A-Za-z0-9]{0,12}$/.test(invoicePrefix)) {
      toast.error(t('invoiceNumberPrefixInvalid'));
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
      if (!silent) toast.success(t('orderNumberingSaved'));
    } catch (err) {
      if (!silent) toast.error(t('saveFailed'));
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
    if (savingAllSettingsInFlight.current) return;
    savingAllSettingsInFlight.current = true;
    setSavingAllSettings(true);
    try {
      await Promise.all(['store', 'receipts-printers', 'loyalty', 'discounts', 'mobile-access'].map((tab) => {
        const key = `${currentTenant?.id}:${tab}${tab === 'mobile-access' ? ':status' : ''}`;
        if (loadedSettingsTabs.current.has(key)) return Promise.resolve();
        return startSettingsTabLoad(tab, new AbortController(), false);
      }));
      // Hydration updates state asynchronously. Let the next render run the
      // saves against the hydrated values instead of stale initial defaults.
      setSaveAllHydrationRun((run) => run + 1);
    } catch {
      toast.error(t('allSaveFailed'));
      savingAllSettingsInFlight.current = false;
      setSavingAllSettings(false);
    }
  };

  useEffect(() => {
    if (saveAllHydrationRun === 0 || !savingAllSettingsInFlight.current) return;
    void (async () => {
      try {
        await Promise.all([saveBusinessInfo(true), saveLoyalty(true), saveDiscount(true), saveCloud(true), saveOrderNumbering(true)]);
        await savePrinting(true);
        await saveBillTemplate(true);
        toast.success(t('allSaved'));
      } catch {
        toast.error(t('allSaveFailed'));
      } finally {
        savingAllSettingsInFlight.current = false;
        setSavingAllSettings(false);
      }
    })();
  // This effect intentionally runs once per hydration run, using the state
  // values produced by the loaders before it starts the writes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveAllHydrationRun]);

  const rotatePairingCode = async () => {
    setRotatingCode(true);
    const generation = mobileAccessRequestGeneration.current;
    const controller = new AbortController();
    mobileAccessRequestController.current = controller;
    try {
      const res = await api.post('/mobile/rotate-code', undefined, { signal: controller.signal });
      if (controller.signal.aborted || generation !== mobileAccessRequestGeneration.current || activeTabRef.current !== 'mobile-access') return;
      setPairingCode(res.data.pairing_code);
      setPairingExpiresAt(res.data.expires_at);
      setPairingQrDataUrl(res.data.qr_data_url || null);
      setPairingUnavailable(false);
      toast.success(t('pairingCodeRotated'));
      await loadPairedDevices(controller.signal);
    } catch (error) {
      if (isRequestCancelled(error)) return;
      // Show a localized failure; the specific backend reason stays in logs.
      toast.error(t('pairingCodeFailed'));
    } finally {
      if (mobileAccessRequestController.current === controller) {
        mobileAccessRequestController.current = null;
        setRotatingCode(false);
      }
    }
  };

  const copyPairingCode = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode.toUpperCase()).then(() => {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    });
  };

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
    <div className="md:h-full md:min-h-0">
      <Tabs orientation="vertical" value={activeTab} onValueChange={handleSettingsTabChange} className="flex flex-col md:flex-row gap-6 items-start md:h-full md:min-h-0">

        {/* Settings sidebar nav */}
        <div className="w-full md:w-40 md:min-w-[10rem] shrink-0 md:h-full md:min-h-0 md:flex md:flex-col">
          <div className="flex items-center gap-3 mb-6 shrink-0">
            <Settings size={28} className="text-brand" />
            <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          </div>

           <nav className="flex md:flex-col gap-0.5 overflow-x-auto md:flex-1 md:min-h-0 md:overflow-x-hidden md:overflow-y-auto md:overscroll-contain border-b md:border-b-0 md:border-e border-border pb-2 md:pb-0 md:pe-2">

            {/* General group */}
            <div className="hidden md:block px-3 pt-3 pb-2 mt-2 mb-1 border-b border-border">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('navGroupGeneral')}</p>
            </div>
            <SettingsNavItem label={t('storeDetails')} value="store" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabPrinters')} value="receipts-printers" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('paymentMethods')} value="payments" active={activeTab} onClick={handleSettingsTabChange} />
            {isAdmin && (
              <SettingsNavItem label={t('tabAppearance')} value="appearance" active={activeTab} onClick={handleSettingsTabChange} />
            )}
            {canViewTaxConfiguration && (
              <SettingsNavItem label={t('taxConfiguration')} value="tax" active={activeTab} onClick={handleSettingsTabChange} />
            )}

            {/* Operations group */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-border">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('navGroupOperations')}</p>
            </div>
            <SettingsNavItem label={t('posWorkflow')} value="pos" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabKds')} value="kds" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tablesideOrdering')} value="server-app" active={activeTab} onClick={handleSettingsTabChange} />
            {/* WhatsApp opt-in lives under Operations because the receive-bill
                workflow is what the cashier touches every time a customer pays. */}
            <SettingsNavItem label={t('tabWhatsapp')} value="whatsapp" active={activeTab} onClick={handleSettingsTabChange} />

            {/* Customers group */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-border">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('navGroupCustomers')}</p>
            </div>
            <SettingsNavItem label={t('loyalty')} value="loyalty" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('discounts')} value="discounts" active={activeTab} onClick={handleSettingsTabChange} />

            {/* Integrations group (formerly "Data") */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-border">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('navGroupData')}</p>
            </div>
            <SettingsNavItem label={t('tabMobileAccess')} value="mobile-access" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabBackupData')} value="data" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabOrderflow')} value="orderflow" active={activeTab} onClick={handleSettingsTabChange} />

            {/* Account group */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-border">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{t('navGroupAccount')}</p>
            </div>
            <SettingsNavItem label={t('account')} value="account" active={activeTab} onClick={handleSettingsTabChange} attention={cloudDeletionNeedsAction || (cloudAccountAvailable && Boolean(cloudAccount?.email && !cloudAccount?.verified))} />
            <SettingsNavItem label={t('privacy')} value="privacy" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabUpdates')} value="updates" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabAbout')} value="about" active={activeTab} onClick={handleSettingsTabChange} />

          </nav>
        </div>

        <div className={`flex-1 min-w-0 md:h-full md:min-h-0 md:overflow-y-auto md:overscroll-contain pb-8 md:pb-12 ${isDirty ? 'pb-32 md:pb-32' : ''}`}>

        <TabsContent value="store">
          <GeneralSettingsTab
            isAdmin={isAdmin}
            form={form}
            setForm={setForm}
            taxIdFormat={taxIdFormat}
            taxIdFormatCountryCode={taxIdFormatCountryCode}
            orderNumberForm={orderNumberForm}
            setOrderNumberForm={setOrderNumberForm}
            markHydrationTouched={markHydrationTouched}
          />
        </TabsContent>

        <TabsContent value="payments">
          <PaymentMethodsSettings isAdmin={isAdmin} />
        </TabsContent>

        {isAdmin && (
        <TabsContent value="appearance">
          <SettingsTabShell>
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <SunMoon size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('themeTitle')}</h2>
              </div>
              <div
                className="flex gap-3"
                role="radiogroup"
                aria-label={t('themeTitle')}
              >
                {(['light', 'dark', 'system'] as const).map((m) => {
                  const active = themeMode === m;
                  const label = m === 'light' ? t('themeLight') : m === 'dark' ? t('themeDark') : t('themeSystem');
                  return (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={savingTheme}
                      onClick={() => { if (!active) saveThemeMode(m); }}
                      className={`text-start rounded-lg border-2 px-4 py-3 transition flex-1 ${
                        active
                          ? 'border-brand bg-brand/5'
                          : 'border-border hover:border-gray-300 dark:border-border'
                      } ${savingTheme ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`inline-block w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                            active ? 'border-brand' : 'border-gray-300 dark:border-border'
                          }`}
                        >
                          {active && <span className="block w-2 h-2 rounded-full bg-brand" />}
                        </span>
                        <span className="font-medium text-foreground">{label}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </SettingsTabShell>
        </TabsContent>
        )}

        {canViewTaxConfiguration && (
          <TabsContent value="tax">
            <TaxConfigurationPanel isOwner={isOwner} />
          </TabsContent>
        )}

        <TabsContent value="pos">
          <SettingsTabShell>
            {/* POS Display */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Monitor size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('posDisplay')}</h2>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground">{t('showProductImages')}</p>
                  <p className="text-sm text-muted-foreground">{t('showProductImagesHint')}</p>
                </div>
                <Toggle value={posSettings.showProductImages} label={t('showProductImages')} onChange={(v) => {
                  posSettings.setShowProductImages(v);
                  toast.success(v ? t('productImagesEnabled') : t('productImagesDisabled'), { id: 'pos-local' });
                }} />
              </div>
            </div>

            {/* POS Workflow */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Users size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('posWorkflow')}</h2>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('customerMandatory')}</p>
                    <p className="text-sm text-muted-foreground">{t('customerMandatoryHint')}</p>
                  </div>
                  <Toggle value={posSettings.customerMandatory} label={t('customerMandatory')} onChange={(v) => {
                    posSettings.setCustomerMandatory(v);
                    toast.success(v ? t('customerMandatoryEnabled') : t('customerMandatoryDisabled'), { id: 'pos-local' });
                  }} />
                </div>
                <p className="text-sm text-muted-foreground">{t('phoneDigitsDerived')}</p>
                <div className="flex items-center justify-between gap-4 pt-2 border-t border-border">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('enforcePhoneLength')}</p>
                    <p className="text-sm text-muted-foreground">{t('enforcePhoneLengthHint')}</p>
                  </div>
                  <Toggle value={posSettings.enforcePhoneLength} label={t('enforcePhoneLength')} onChange={(v) => {
                    posSettings.setEnforcePhoneLength(v);
                    toast.success(v ? t('enforcePhoneLengthEnabled') : t('enforcePhoneLengthDisabled'), { id: 'pos-local' });
                  }} />
                </div>
              </div>
            </div>

            {/* Add a cashier — pair another device onto the same POS over the local network */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Smartphone size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('posPairing')}</h2>
              </div>
              <p className="text-sm text-muted-foreground mb-5">
                {t('posPairingHint')}
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
                          <div key={idx} className="flex flex-col items-center p-4 bg-muted border border-border rounded-lg">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                              {ipInfo.ip.startsWith('100.') ? t('vpnMeshNetwork') : t('localNetwork')}
                            </p>
                            {ipInfo.qr_data ? (
                              <img src={ipInfo.qr_data} alt={`QR Code for ${ipInfo.ip}`} className="w-40 h-40 rounded-lg mb-3 bg-card p-2 border border-border" />
                            ) : (
                              <div className="w-40 h-40 bg-muted rounded-lg flex items-center justify-center mb-3">
                                <QrCode size={40} className="text-muted-foreground" />
                              </div>
                            )}
                            <Ltr as="a" href={ipInfo.url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-brand hover:underline break-all text-center">
                              {ipInfo.url}
                            </Ltr>
                          </div>
                        ))}
                      </div>
                      <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 rounded-lg p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex-1">
                            <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wide mb-1">{t('appleDevices')}</p>
                            <Ltr as="a" href={posInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 dark:text-blue-400 break-all hover:underline">
                              {posInfo.mdns_url}
                            </Ltr>
                            <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">
                              {t('appleDevicesHint')}
                            </p>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-6 items-start">
                      <div className="shrink-0">
                        {posInfo.qr_data_url ? (
                          <img src={posInfo.qr_data_url} alt={t('posQrAlt')} className="w-48 h-48 rounded-xl border border-border" />
                        ) : (
                          <div className="w-48 h-48 rounded-xl border border-border flex items-center justify-center text-muted-foreground">
                            <QrCode size={48} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 space-y-4">
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{t('directIp')}</p>
                          <Ltr as="a" href={posInfo.ip_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-brand break-all hover:underline">
                            {posInfo.ip_url}
                          </Ltr>
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{t('mdnsAlwaysStable')}</p>
                          <Ltr as="a" href={posInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-foreground break-all hover:underline">
                            {posInfo.mdns_url}
                          </Ltr>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end border-t border-border pt-4">
                    <button onClick={fetchPosInfo} disabled={posInfoLoading}
                      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                      <RefreshCw size={14} className={posInfoLoading ? 'animate-spin' : ''} />
                      {t('refreshUrls')}
                    </button>
                  </div>
                </div>
              )}

              {!posInfo && !posInfoLoading && (
                <>
                  <p className="text-sm text-muted-foreground mb-3">
                    {t('posLoadHint')}
                  </p>
                  <button onClick={fetchPosInfo}
                    className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium">
                    {t('loadPosInfo')}
                  </button>
                </>
              )}
            </div>
          </SettingsTabShell>
        </TabsContent>

        {/* Kitchen Display — own tab under Operations */}
        <TabsContent value="kds">
          <SettingsTabShell>
            {/* Kitchen Display System enable toggle */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground">{t('kdsEnabledToggle')}</p>
                  <p className="text-sm text-muted-foreground">{t('kdsEnabledToggleHint')}</p>
                </div>
                <Toggle value={kdsEnabledSetting} label={t('kdsEnabledToggle')} onChange={(v) => { if (!savingKdsEnabled) saveKdsEnabled(v); }} />
              </div>
              {!kdsEnabledSetting && !kotPrintingEnabledSetting && (
                <div className="mt-4 flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 rounded-lg">
                  <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    {t('kitchenWorkflowBothOffNote')}
                  </p>
                </div>
              )}
            </div>

            {!kdsEnabledSetting && (
              <p className="text-sm text-muted-foreground italic">
                {t('kdsPairingHiddenHint')}
              </p>
            )}

            {kdsEnabledSetting && (
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <ChefHat size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('kds')}</h2>
              </div>
              <p className="text-sm text-muted-foreground mb-5">
                {t('kdsPairingHint')}
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
                          <div key={idx} className="flex flex-col items-center p-4 bg-muted border border-border rounded-lg">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                              {ipInfo.ip.startsWith('100.') ? t('vpnMeshNetwork') : t('localNetwork')}
                            </p>
                            {ipInfo.qr_data ? (
                              <img src={ipInfo.qr_data} alt={`QR Code for ${ipInfo.ip}`} className="w-40 h-40 rounded-lg mb-3 bg-card p-2 border border-border" />
                            ) : (
                              <div className="w-40 h-40 bg-muted rounded-lg flex items-center justify-center mb-3">
                                <QrCode size={40} className="text-muted-foreground" />
                              </div>
                            )}
                            <Ltr as="a" href={ipInfo.url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-brand hover:underline break-all text-center">
                              {ipInfo.url}
                            </Ltr>
                          </div>
                        ))}
                      </div>
                      <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 rounded-lg p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex-1">
                            <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wide mb-1">{t('appleDevices')}</p>
                            <Ltr as="a" href={kdsInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 dark:text-blue-400 break-all hover:underline">
                              {kdsInfo.mdns_url}
                            </Ltr>
                            <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">
                              {t('appleDevicesHint')}
                            </p>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-6 items-start">
                      <div className="shrink-0">
                        {kdsInfo.qr_data_url ? (
                          <img src={kdsInfo.qr_data_url} alt={t('kdsQrAlt')} className="w-48 h-48 rounded-xl border border-border" />
                        ) : (
                          <div className="w-48 h-48 rounded-xl border border-border flex items-center justify-center text-muted-foreground">
                            <QrCode size={48} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 space-y-4">
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{t('directIp')}</p>
                          <Ltr as="a" href={kdsInfo.ip_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-brand break-all hover:underline">
                            {kdsInfo.ip_url}
                          </Ltr>
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{t('mdnsAlwaysStable')}</p>
                          <Ltr as="a" href={kdsInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-foreground break-all hover:underline">
                            {kdsInfo.mdns_url}
                          </Ltr>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end border-t border-border pt-4">
                    <button onClick={() => { void fetchKdsInfo(); }} disabled={kdsInfoLoading}
                      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                      <RefreshCw size={14} className={kdsInfoLoading ? 'animate-spin' : ''} />
                      {t('refreshUrls')}
                    </button>
                  </div>
                </div>
              )}

              {!kdsInfo && !kdsInfoLoading && (
                <>
                  <p className="text-sm text-muted-foreground mb-3">
                    {t('kdsLoadHint')}
                  </p>
                  <button onClick={() => { void fetchKdsInfo(); }}
                    className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium">
                    {t('loadKdsInfo')}
                  </button>
                </>
              )}
            </div>
            )}

            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <ChefHat size={20} className="text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">{t('kitchenStations')}</h2>
                </div>
                <button onClick={openAddStation}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium">
                  <Plus size={14} />
                  {t('addStation')}
                </button>
              </div>
              <p className="text-sm text-muted-foreground mb-5">{t('kitchenStationsHint')}</p>

              {stations.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">{t('noStationsYet')}</p>
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
                      <div key={station.id} className="flex items-center justify-between p-3 border border-border rounded-lg">
                        <div className="min-w-0">
                          <p className="font-medium text-foreground">{station.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {categoryNames.length > 0 ? categoryNames.join(', ') : t('stationNoCategories')}
                            {' · '}
                            {printer ? printer.name : t('stationNoPrinter')}
                            {users.length > 0 && ` · ${users.map((u) => u.name).join(', ')}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => openEditStation(station)}
                            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded">
                            {tCommon('edit')}
                          </button>
                          <button onClick={() => deleteStation(station.id)}
                            className="p-1.5 text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded">
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
                      <DialogTitle>{editingStationId ? t('editStation') : t('addStation')}</DialogTitle>
                      <DialogDescription>{t('stationFormHint')}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1">{t('stationName')}</label>
                        <input type="text" value={stationForm.name}
                          onChange={(e) => setStationForm((f) => ({ ...f, name: e.target.value }))}
                          placeholder={t('stationNamePlaceholder')}
                          className="w-full px-3 py-2 border border-border rounded-lg text-sm" />
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1">{t('stationCategories')}</label>
                        {stationCategories.length === 0 ? (
                          <p className="text-xs text-muted-foreground">{t('noCategoriesYet')}</p>
                        ) : (
                          <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                            {stationCategories.map((cat) => (
                              <label key={cat.id} className="flex items-center gap-1.5 px-2.5 py-1 border border-border rounded-full text-xs cursor-pointer hover:bg-muted">
                                <input type="checkbox" checked={stationForm.category_ids.includes(cat.id)}
                                  onChange={() => toggleStationFormValue('category_ids', cat.id)}
                                  className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand" />
                                {cat.name}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1">{t('stationPrinter')}</label>
                        <select value={stationForm.printer_id}
                          onChange={(e) => setStationForm((f) => ({ ...f, printer_id: e.target.value }))}
                          className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-card">
                          <option value="">{t('stationUseDefaultPrinter')}</option>
                          {hwPrinters.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1">{t('stationStaff')}</label>
                        {stationStaff.length === 0 ? (
                          <p className="text-xs text-muted-foreground">{t('noStaffYet')}</p>
                        ) : (
                          <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                            {stationStaff.map((u) => (
                              <label key={u.id} className="flex items-center gap-1.5 px-2.5 py-1 border border-border rounded-full text-xs cursor-pointer hover:bg-muted">
                                <input type="checkbox" checked={stationForm.user_ids.includes(u.id)}
                                  onChange={() => toggleStationFormValue('user_ids', u.id)}
                                  className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand" />
                                {u.name}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setShowStationForm(false)}>{tCommon('cancel')}</Button>
                      <Button onClick={saveStation} disabled={savingStation}>
                        {savingStation ? tCommon('saving') : tCommon('save')}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>

            <KdsDefaultViewCard />

            <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 rounded-xl p-4 text-sm text-blue-800 dark:text-blue-300">
              <strong>{t('howItWorks')}</strong> {t('howItWorksBody')}
            </div>
          </SettingsTabShell>
        </TabsContent>

        <TabsContent value="server-app">
          <SettingsTabShell>
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground">{t('serverApp')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('serverAppEnabledHint')}
                  </p>
                </div>
                <Toggle value={serverAppEnabledSetting} label={t('serverApp')} onChange={(v) => { if (!savingServerAppEnabled) saveServerAppEnabled(v); }} />
              </div>
            </div>

            {!serverAppEnabledSetting && (
              <p className="text-sm text-muted-foreground italic">
                {t('serverAppPairingHiddenHint')}
              </p>
            )}

            {serverAppEnabledSetting && (
              <div className="bg-card rounded-xl border border-border p-6">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('serverAppBillPrinting')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('serverAppBillPrintingHint')}
                    </p>
                  </div>
                  <Toggle value={serverAppBillPrintingEnabledSetting} label={t('serverAppBillPrinting')} onChange={(v) => { if (!savingServerAppBillPrintingEnabled) saveServerAppBillPrintingEnabled(v); }} />
                </div>
              </div>
            )}

            {serverAppEnabledSetting && (
              <div className="bg-card rounded-xl border border-border p-6">
                <div className="flex items-center gap-2 mb-4">
                  <Smartphone size={20} className="text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">{t('tablesideOrdering')}</h2>
                </div>
                <p className="text-sm text-muted-foreground mb-5">
                  {t('serverAppPairingHint')}
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
                            <div key={idx} className="flex flex-col items-center p-4 bg-muted border border-border rounded-lg">
                              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                                {ipInfo.ip.startsWith('100.') ? t('vpnMeshNetwork') : t('localNetwork')}
                              </p>
                              {ipInfo.qr_data ? (
                                <img src={ipInfo.qr_data} alt={`QR Code for ${ipInfo.ip}`} className="w-40 h-40 rounded-lg mb-3 bg-card p-2 border border-border" />
                              ) : (
                                <div className="w-40 h-40 bg-muted rounded-lg flex items-center justify-center mb-3">
                                  <QrCode size={40} className="text-muted-foreground" />
                                </div>
                              )}
                              <Ltr as="a" href={ipInfo.url} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-brand hover:underline break-all text-center">
                                {ipInfo.url}
                              </Ltr>
                            </div>
                          ))}
                        </div>
                        <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800/40 rounded-lg p-4">
                          <p className="text-xs font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wide mb-1">{t('appleDevices')}</p>
                          <Ltr as="a" href={serverAppInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 dark:text-blue-400 break-all hover:underline">
                            {serverAppInfo.mdns_url}
                          </Ltr>
                          <p className="text-xs text-blue-600 dark:text-blue-400 mt-2">{t('appleDevicesHint')}</p>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col sm:flex-row gap-6 items-start">
                        <div className="shrink-0">
                          {serverAppInfo.qr_data_url ? (
                            <img src={serverAppInfo.qr_data_url} alt={t('serverAppQrAlt')} className="w-48 h-48 rounded-xl border border-border" />
                          ) : (
                            <div className="w-48 h-48 rounded-xl border border-border flex items-center justify-center text-muted-foreground">
                              <QrCode size={48} />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 space-y-4">
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{t('directIp')}</p>
                            <Ltr as="a" href={serverAppInfo.ip_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-brand break-all hover:underline">
                              {serverAppInfo.ip_url}
                            </Ltr>
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{t('mdnsAlwaysStable')}</p>
                            <Ltr as="a" href={serverAppInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-foreground break-all hover:underline">
                              {serverAppInfo.mdns_url}
                            </Ltr>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end border-t border-border pt-4">
                      <button onClick={fetchServerAppInfo} disabled={serverAppInfoLoading}
                        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                        <RefreshCw size={14} className={serverAppInfoLoading ? 'animate-spin' : ''} />
                        {t('refreshUrls')}
                      </button>
                    </div>
                  </div>
                )}

                {!serverAppInfo && !serverAppInfoLoading && (
                  <>
                    <p className="text-sm text-muted-foreground mb-3">
                      {t('serverAppLoadHint')}
                    </p>
                    <button onClick={fetchServerAppInfo}
                      className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium">
                      {t('loadServerAppInfo')}
                    </button>
                  </>
                )}
              </div>
            )}
          </SettingsTabShell>
        </TabsContent>

        <TabsContent value="loyalty">
          <SettingsTabShell>
            {/* Loyalty */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Gift size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('loyaltyProgram')}</h2>
              </div>
              <div className="space-y-5">
                {/* Enable toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-foreground">{t('enableLoyalty')}</p>
                    <p className="text-sm text-muted-foreground">{t('loyaltyHint')}</p>
                  </div>
                  <button
                    onClick={() => {
                      markHydrationTouched('loyaltyEnabled');
                      setLoyaltyEnabled(!loyaltyEnabled);
                    }}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      loyaltyEnabled ? 'bg-brand' : 'bg-gray-200 dark:bg-input'
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${
                      loyaltyEnabled ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'
                    }`} />
                  </button>
                </div>
                {/* Global Cashback Input */}
                {loyaltyEnabled && (
                  <div className="pt-4 border-t border-border flex items-center justify-between">
                    <div>
                      <p className="font-medium text-foreground">{t('globalLoyaltyRate')}</p>
                      <p className="text-sm text-muted-foreground">{t('globalLoyaltyRateHint')}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={globalCashbackPercent}
                        onChange={(e) => {
                          markHydrationTouched('globalCashbackPercent');
                          setGlobalCashbackPercent(e.target.value);
                        }}
                        placeholder="0"
                        className="w-20 px-3 py-2 border border-gray-300 dark:border-border rounded-lg focus:ring-2 focus:ring-brand focus:border-brand transition-shadow text-end"
                      />
                      <span className="text-muted-foreground font-medium">%</span>
                    </div>
                  </div>
                )}
                {/* Products upgraded from before the tri-state all sit at 0%
                    ("earns nothing"), so the global rate does nothing for them
                    until the owner explicitly opts them in. */}
                {loyaltyEnabled && globalRateCandidates > 0 && (
                  <div className="pt-4 border-t border-border">
                    <p className="font-medium text-foreground">{t('applyGlobalRateTitle')}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('applyGlobalRateHint', { count: globalRateCandidates })}
                    </p>
                    <button
                      type="button"
                      onClick={applyGlobalRateToProducts}
                      disabled={applyingGlobalRate}
                      className="mt-3 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-border hover:bg-muted disabled:opacity-50"
                    >
                      {applyingGlobalRate
                        ? t('applyGlobalRateWorking')
                        : t('applyGlobalRateAction', { count: globalRateCandidates })}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </SettingsTabShell>
        </TabsContent>

        <TabsContent value="discounts">
          <SettingsTabShell>
            {/* Discount Limits */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Percent size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('discountLimits')}</h2>
              </div>
              <div className="space-y-5">
                {/* Discount mode */}
                <div>
                  <p className="font-medium text-foreground">{t('discountMode')}</p>
                  <p className="text-sm text-muted-foreground mb-2">{t('discountModeHint')}</p>
                  <select value={discountMode}
                    onChange={(e) => {
                      markHydrationTouched('discountMode');
                      setDiscountMode(e.target.value);
                    }}
                    className="w-48 px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand bg-card">
                    <option value="both">{t('discountBoth')}</option>
                    <option value="percentage">{t('discountPercentageOnly')}</option>
                    <option value="flat">{t('discountFlatOnly')}</option>
                    <option value="none">{t('discountNone')}</option>
                  </select>
                </div>

                {(discountMode === 'percentage' || discountMode === 'both') && (
                  <div>
                    <p className="font-medium text-foreground">{t('maxDiscountPercentage')}</p>
                    <p className="text-sm text-muted-foreground mb-2">{t('maxDiscountPercentageHint')}</p>
                    <div className="flex items-center gap-3">
                      <input type="number" min={1} max={100} value={discountMaxPct}
                        onChange={(e) => {
                          markHydrationTouched('discountMaxPct');
                          setDiscountMaxPct(normalizeDiscountPercentage(e.target.value));
                        }}
                        className="w-24 px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      <span className="text-sm text-muted-foreground">{t('percentMaximum')}</span>
                    </div>
                  </div>
                )}

                {(discountMode === 'flat' || discountMode === 'both') && (
                  <div>
                    <p className="font-medium text-foreground">{t('maxDiscountAmount')}</p>
                    <p className="text-sm text-muted-foreground mb-2">{t('maxDiscountAmountHint')}</p>
                    <div className="flex items-center gap-3">
                      <input type="number" min={0} max={999999} value={discountMaxAmount}
                        onChange={(e) => {
                          markHydrationTouched('discountMaxAmount');
                          setDiscountMaxAmount(normalizeDiscountAmount(e.target.value));
                        }}
                        className="w-24 px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      <span className="text-sm text-muted-foreground">{t('zeroNoLimit')}</span>
                    </div>
                  </div>
                )}

                {discountMode !== 'none' && (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-foreground">{t('requireApproval')}</p>
                      <p className="text-sm text-muted-foreground">{t('requireApprovalHint')}</p>
                    </div>
                    <button
                      onClick={() => {
                        markHydrationTouched('discountRequiresApproval');
                        setDiscountRequiresApproval(!discountRequiresApproval);
                      }}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        discountRequiresApproval ? 'bg-brand' : 'bg-gray-200 dark:bg-input'
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${
                        discountRequiresApproval ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'
                      }`} />
                    </button>
                  </div>
                )}

              </div>
            </div>
          </SettingsTabShell>
        </TabsContent>

        <TabsContent value="account">
          <SettingsTabShell>
            {/* Account */}
            <div className="bg-card rounded-xl border border-border p-6">
              <h2 className="font-semibold text-foreground mb-4">{t('account')}</h2>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-muted-foreground">{t('name')}</p>
                  <p className="font-medium text-foreground">{user?.name}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('email')}</p>
                  <p className="font-medium text-foreground"><Ltr>{user?.email}</Ltr></p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('role')}</p>
                  <p className="font-medium text-foreground capitalize">{currentTenant?.role || '—'}</p>
                </div>
              </div>
            </div>
            {isOwner && (
              <div className={`rounded-xl border p-6 ${cloudAccountAvailable && cloudAccount?.email && !cloudAccount.verified ? 'border-red-200 dark:border-red-800/40 bg-red-50/40 dark:bg-red-950/20' : 'border-border bg-card'}`}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-foreground">{t('contactEmailTitle')}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{cloudAccountLoadFailed ? t('cloudAccountLoadFailed') : cloudAccountAvailable ? <Ltr>{cloudAccount?.email || user?.email || t('noCloudContactEmail')}</Ltr> : t('cloudAccountUnavailable')}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${!cloudAccountAvailable ? 'bg-muted text-muted-foreground' : cloudAccount?.verified ? 'bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-300' : 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300'}`}>
                    {cloudAccountLoadFailed ? t('cloudStatusUnavailable') : !cloudAccountAvailable ? t('cloudUnavailableBadge') : cloudAccount?.verified ? t('cloudVerified') : t('cloudPendingVerification')}
                  </span>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{cloudAccountLoadFailed ? t('cloudAccountLoadError') : cloudAccountAvailable ? t('cloudVerificationHint') : cloudDeletionPending ? t('cloudDeletionPendingHint') : cloudDeletionStatus === 'processing' ? t('cloudDeletionProcessingHint') : cloudDeletionStatus === 'failed' || cloudStatus.cloud_deletion_status === 'failed' ? t('cloudDeletionFailedHint') : t('cloudEnableHintAccount')}</p>
                {cloudAccountLoadFailed && (
                  <Button variant="outline" className="mt-4" onClick={() => void fetchCloudAccount()}>{t('retry')}</Button>
                )}
                {cloudAccountAvailable && !cloudAccount?.verified && (
                  <Button className="mt-4" disabled={cloudAccountBusy} onClick={async () => {
                    setCloudAccountBusy(true);
                    try { await api.post('/settings/cloud/account/verification'); toast.success(t('verificationEmailQueued')); await fetchCloudAccount(); }
                    catch {
                      toast.error(t('verificationEmailFailed'));
                    }
                    finally { setCloudAccountBusy(false); }
                  }}>{cloudAccountBusy ? t('cloudSendingVerification') : t('cloudSendVerificationEmail')}</Button>
                )}
                {cloudAccountAvailable && (
                  <div className="mt-5 space-y-3 border-t border-border pt-4">
                    <label className="flex items-center justify-between gap-4 text-sm"><span>{t('cloudPrefProductUpdates')}</span><Toggle value={Boolean(cloudAccount?.product_updates)} label={t('cloudPrefProductUpdates')} onChange={async (value) => { setCloudAccountBusy(true); try { const { data } = await api.put('/settings/cloud/account/preferences', { product_updates: value }); setCloudAccount(data); } catch { toast.error(t('couldNotSavePreference')); } finally { setCloudAccountBusy(false); } }} /></label>
                    <label className="flex items-center justify-between gap-4 text-sm"><span>{t('cloudPrefMarketing')}</span><Toggle value={Boolean(cloudAccount?.marketing)} label={t('cloudPrefMarketing')} onChange={async (value) => { setCloudAccountBusy(true); try { const { data } = await api.put('/settings/cloud/account/preferences', { marketing: value }); setCloudAccount(data); } catch { toast.error(t('couldNotSavePreference')); } finally { setCloudAccountBusy(false); } }} /></label>
                    <p className="text-xs text-muted-foreground">{t('cloudPrefNote')}</p>
                  </div>
                )}
              </div>
            )}
          </SettingsTabShell>
        </TabsContent>

        {/* Privacy — anonymous telemetry (from the old Integrations tab) + cloud privacy controls (from Account) */}
        <TabsContent value="privacy">
          <SettingsTabShell>
            <div className="bg-card rounded-xl border border-border p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Lock size={20} className="text-muted-foreground" />
                <div>
                  <h2 className="font-semibold text-foreground">{t('privacy')}</h2>
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={telemetryEnabled}
                  disabled={savingTelemetry}
                  onChange={(e) => saveTelemetry(e.target.checked)}
                  className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
                />
                <span className="text-sm text-foreground">{t('anonymousTelemetry')}</span>
              </label>
              <p className="text-xs text-muted-foreground">{t('anonymousTelemetryHint')}</p>

              <div className="border-t border-border pt-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={diagnosticsConsent}
                    disabled={savingDiagnosticsConsent}
                    onChange={(e) => saveDiagnosticsConsent(e.target.checked)}
                    className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
                  />
                  <span className="text-sm text-foreground">{t('storeDiagnostics')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1">{t('storeDiagnosticsHint')}</p>
              </div>
            </div>

            {isOwner && (
              <div className="rounded-xl border border-border bg-card p-6">
                <h2 className="font-semibold text-foreground">{t('cloudPrivacyControls')}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{t('cloudStopReversible')}</p>
                {cloudAccount?.deletion_request && (
                  <div className={`mt-4 rounded-lg border p-3 text-sm ${cloudAccount.deletion_request.status === 'pending' || cloudAccount.deletion_request.status === 'processing' ? 'border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300' : cloudAccount.deletion_request.status === 'approved' || cloudAccount.deletion_request.status === 'completed' || cloudAccount.deletion_request.status === 'deleted' ? 'border-green-200 dark:border-green-800/40 bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300' : cloudAccount.deletion_request.status === 'failed' ? 'border-red-200 dark:border-red-800/40 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300' : 'border-border bg-muted text-foreground'}`}>
                    <p className="font-semibold">{t('cloudDeletionRequest', { status: cloudAccount.deletion_request.status || '' })}</p>
                    {cloudAccount.deletion_request.id && <p className="mt-1 font-mono text-xs"><Ltr>{cloudAccount.deletion_request.id}</Ltr></p>}
                    {cloudAccount.deletion_request.decision_note && <p className="mt-2">{cloudAccount.deletion_request.decision_note}</p>}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button variant="outline" onClick={async () => {
                    if (!await confirm(t('cloudStopAllConfirm'))) return;
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
                      toast.success(t('cloudAllStopped'));
                    }
                    catch { toast.error(t('cloudStopFailed')); }
                  }}><CloudOff size={16} className="me-2" />{t('cloudStopAllButton')}</Button>
                  {!cloudDeletionFinal && <Button variant="destructive" disabled={cloudAccount?.deletion_request?.status === 'pending' || cloudAccount?.deletion_request?.status === 'processing' || cloudAccount?.deletion_request?.status === 'approved' || cloudStatus.cloud_deletion_status === 'processing'} onClick={() => {
                    const phrase = window.prompt(t('cloudDeletePrompt'));
                    if (phrase === 'DELETE CLOUD DATA') setPinGate({ mode: 'delete-cloud' });
                    else if (phrase !== null) toast.error(t('confirmationPhraseMismatch'));
                  }}><Trash2 size={16} className="me-2" />{t('cloudDeleteDataButton')}</Button>}
                  {cloudDeletionNeedsAction && (
                    <>
                      <Button variant="outline" onClick={() => void refreshDeletionStatus()} disabled={refreshingDeletionStatus}>
                        {refreshingDeletionStatus ? t('cloudRefreshingDeletion') : t('cloudRefreshDeletion')}
                      </Button>
                      {cloudDeletionCanCancel && <Button variant="outline" onClick={() => setPinGate({ mode: 'cancel-cloud-deletion' })}>{t('cloudCancelDeletion')}</Button>}
                    </>
                  )}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">{t('cloudTelemetryNote')}</p>
              </div>
            )}
          </SettingsTabShell>
        </TabsContent>

        <TabsContent value="receipts-printers" forceMount hidden={activeTab !== 'receipts-printers'}>
          <PrintersSettingsTab
            isActive={activeTab === 'receipts-printers'}
            hwPrinters={hwPrinters}
            setHwPrinters={setHwPrinters}
            printingForm={printingForm}
            setPrintingForm={setPrintingForm}
            billForm={billForm}
            setBillForm={setBillForm}
            billTemplateCards={billTemplateCards}
            kotPrintingEnabledSetting={kotPrintingEnabledSetting}
            saveKotPrintingEnabled={saveKotPrintingEnabled}
            savingKotPrintingEnabled={savingKotPrintingEnabled}
            kdsEnabledSetting={kdsEnabledSetting}
            pulseCustomMethods={pulseCustomMethods}
            markHydrationTouched={markHydrationTouched}
            confirm={confirm}
          />
        </TabsContent>


        {/* Backup & Data tab - database tools only */}
        <TabsContent value="data">
          <DatabaseSettingsTab
            isOwner={isOwner}
            masterPinStatus={masterPinStatus}
            backups={backups}
            backupsLoading={backupsLoading}
            googleDriveStatus={googleDriveStatus}
            setGoogleDriveStatus={setGoogleDriveStatus}
            connectingGoogleDrive={connectingGoogleDrive}
            disconnectingGoogleDrive={disconnectingGoogleDrive}
            savingGoogleDrivePrefs={savingGoogleDrivePrefs}
            backingUpGoogleDrive={backingUpGoogleDrive}
            onFetchBackups={fetchBackups}
            onCreateBackup={handleCreateBackup}
            onChooseBackupLocation={handleChooseBackupLocation}
            onRestoreFromHistory={handleRestoreFromHistory}
            onDeleteBackup={handleDeleteBackup}
            onConnectGoogleDrive={connectGoogleDrive}
            onDisconnectGoogleDrive={disconnectGoogleDrive}
            onUpdateGoogleDrivePrefs={updateGoogleDrivePrefs}
            onBackupToGoogleDriveNow={backupToGoogleDriveNow}
            onRunImport={runImport}
            onRequestPinGate={setPinGate}
            onRunHealthCheck={runHealthCheck}
            onRequestInitializeDb={() => setInitializeDbOpen(true)}
            confirm={confirm}
          />
        </TabsContent>

        {/* Integrations tab — cloud + OrderFlow + More Apps */}
        <TabsContent value="whatsapp">
          <SettingsTabShell>
            {!whatsappEnabled ? (
              <WhatsAppEnableCard />
            ) : (
              <div className="bg-card rounded-xl border border-border p-6 flex items-center justify-between gap-4">
                <div>
                  <p className="font-semibold text-foreground">{tWhatsappSettings('enabled')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{tWhatsappSettings('enabledHint')}</p>
                </div>
                <Button asChild variant="outline" size="sm">
                  <Link href="/whatsapp">{tWhatsappSettings('openConnection')}</Link>
                </Button>
              </div>
            )}
          </SettingsTabShell>
        </TabsContent>

        <TabsContent value="mobile-access">
          <SettingsTabShell title={t('tabMobileAccess')}>

            {/* FloAdmin — reporting sync */}
            <div className="bg-card rounded-xl border border-border p-6 space-y-5">
              <div className="flex items-center gap-2">
                <Cloud size={20} className="text-brand" />
                <div>
                  <h2 className="font-semibold text-foreground">{t('floadminSalesReporting')}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('floadminSalesReportingHint')}</p>
                </div>
              </div>

              {cloudStatus.cloud_registration_status === 'unregistered' ? (
                <div className="bg-muted rounded-xl p-6 flex flex-col items-center justify-center text-center space-y-4">
                  <div className="p-3 bg-card rounded-full shadow-sm">
                    <Cloud className="w-6 h-6 text-brand" />
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground">{t('cloudServicesDisabled')}</h3>
                    <p className="text-sm text-muted-foreground mt-1 max-w-sm">{t('cloudServicesDisabledHint')}</p>
                  </div>
                  <button
                    onClick={() => setShowInitializeCloudConfirm(true)}
                    className="px-4 py-2 bg-brand text-white text-sm font-medium rounded-lg hover:opacity-90"
                  >
                    {t('cloudInitializeButton')}
                  </button>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-border px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                  {cloudStatus.cloud_registration_status === 'registered' && !cloudServicesStopped ? (
                    <CheckCircle2 size={16} className="text-green-600 shrink-0" />
                  ) : (
                    <CloudOff size={16} className="text-muted-foreground shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {cloudStatus.cloud_registration_status === 'registered' && cloudServicesStopped && t('cloudServicesStopped')}
                      {cloudStatus.cloud_registration_status === 'registered' && !cloudServicesStopped && (cloudStatus.cloud_connected ? t('connectedToFloadmin') : t('registeredReconnecting'))}
                      {cloudStatus.cloud_registration_status === 'rejected' && t('registrationRejected')}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && (cloudStatus.cloud_last_error || cloudStatus.cloud_deletion_status === 'failed') && t('cloudDeletionFailed')}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && cloudStatus.cloud_deletion_status === 'processing' && t('cloudDeletionProcessing')}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && !cloudStatus.cloud_last_error && cloudStatus.cloud_deletion_status !== 'failed' && cloudStatus.cloud_deletion_status !== 'processing' && t('cloudDeletionPending')}
                      {cloudStatus.cloud_registration_status === 'deleted' && t('cloudDataDeleted')}
                      {(cloudStatus.cloud_registration_status === 'unregistered' || cloudStatus.cloud_registration_status === 'registration_failed') && t('notRegistered')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {cloudStatus.cloud_registration_status === 'registered' && cloudServicesStopped && t('cloudResumeHint')}
                      {cloudStatus.cloud_registration_status === 'registered' && !cloudServicesStopped && (cloudStatus.cloud_last_heartbeat ? t('liveChannelHeartbeat', { mode: cloudStatus.cloud_relay_mode.replace('_', ' '), time: formatTime(cloudStatus.cloud_last_heartbeat) }) : t('liveChannel', { mode: cloudStatus.cloud_relay_mode.replace('_', ' ') }))}
                      {cloudStatus.cloud_registration_status === 'rejected' && t('registrationContactSupport')}
                      {cloudStatus.cloud_registration_status === 'registration_failed' && (cloudStatus.cloud_last_error ? t('registrationLastError', { error: cloudStatus.cloud_last_error }) : t('registrationLastFailed'))}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && (cloudStatus.cloud_last_error || cloudStatus.cloud_deletion_status === 'failed') && t('cloudDeletionFailedHint2')}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && cloudStatus.cloud_deletion_status === 'processing' && t('cloudDeletionProcessingHint2')}
                      {cloudStatus.cloud_registration_status === 'deletion_pending' && !cloudStatus.cloud_last_error && cloudStatus.cloud_deletion_status !== 'failed' && cloudStatus.cloud_deletion_status !== 'processing' && t('cloudServicesStoppedHint')}
                      {cloudStatus.cloud_registration_status === 'deleted' && t('cloudDataDeletedHint')}
                      {cloudStatus.cloud_registration_status === 'unregistered' && t('registrationRegisterHelp')}
                    </p>
                  </div>
                </div>
                {cloudStatus.cloud_registration_status !== 'registered' && cloudStatus.cloud_registration_status !== 'deletion_pending' && cloudStatus.cloud_registration_status !== 'deleted' && (
                  <button
                    onClick={() => registerCloud('')}
                    disabled={registeringCloud}
                    className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium shrink-0"
                  >
                    {registeringCloud ? t('registering') : t('registerWithFloadmin')}
                  </button>
                )}
              </div>

              {cloudStatus.cloud_registration_status !== 'deleted' && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{t('cloudManagedAutomatically')}</p>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cloudSettings.cloud_sync_enabled}
                    onChange={(e) => {
                      markHydrationTouched('cloud_sync_enabled');
                      setCloudSettings({ ...cloudSettings, cloud_sync_enabled: e.target.checked });
                    }}
                    className="mt-0.5 rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
                  />
                  <div>
                    <span className="text-sm font-medium text-foreground block">{cloudServicesStopped ? t('cloudEnableButton') : t('enableBillSync')}</span>
                    <p className="text-xs text-muted-foreground mt-1">{cloudServicesStopped ? t('cloudResumeHintStopped') : t('enableBillSyncHint')}</p>
                  </div>
                </label>

                    {cloudSettings.cloud_last_sync && (
                      <p className="text-xs text-muted-foreground">{t('lastSync', { time: formatDateTime(cloudSettings.cloud_last_sync) })}</p>
                    )}
                  </div>
              )}
                </>
              )}
            </div>

            {/* RevFlo — consolidated: download/QR + app (pairing) code + paired devices */}
            <div className="bg-card rounded-xl border border-border p-6 space-y-5">
              <div className="flex items-center gap-2">
                <Smartphone size={20} className="text-muted-foreground" />
                <div>
                  <h2 className="font-semibold text-foreground">{revflo?.name || t('revflo')}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{revflo?.tagline || t('revfloHint')}</p>
                </div>
              </div>

              {revflo?.available && (
                <div className="flex flex-col sm:flex-row gap-5 items-start border border-border rounded-xl p-5">
                  <div className="shrink-0">
                    {revflo.qr_data_url ? (
                      <img src={revflo.qr_data_url} alt={t('appQrAlt', { name: revflo.name })}
                        className="w-28 h-28 rounded-lg border border-border" />
                    ) : (
                      <div className="w-28 h-28 rounded-lg border border-border flex items-center justify-center text-muted-foreground">
                        <QrCode size={32} />
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3 text-sm">
                    {revflo.ios_url && (
                      <a href={revflo.ios_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                        {t('downloadForIos')}
                      </a>
                    )}
                    {revflo.android_url && (
                      <a href={revflo.android_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                        {t('downloadForAndroid')}
                      </a>
                    )}
                  </div>
                </div>
              )}

              <div>
                <p className="text-sm font-medium text-foreground mb-1">{t('mobileApp')}</p>
                <p className="text-xs text-muted-foreground mb-4">{t('mobileAppHint')}</p>
                {pairingUnavailable ? (
                  <p className="text-sm text-muted-foreground">{t('mobilePairingNeedsCloud')}</p>
                ) : pairingCode ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-4">
                      {pairingQrDataUrl && (
                        <img src={pairingQrDataUrl} alt={t('pairingQrAlt')} className="w-28 h-28 rounded-lg border border-border" />
                      )}
                      <div className="flex items-center gap-3 flex-1">
                      <div className="flex-1 bg-muted border border-border rounded-lg px-4 py-3 text-center">
                        <span className="font-mono text-2xl font-bold tracking-[0.3em] text-foreground">
                          <Ltr>{pairingCode.toUpperCase()}</Ltr>
                        </span>
                      </div>
                      <button
                        onClick={copyPairingCode}
                        className="p-2.5 border border-border rounded-lg hover:bg-muted text-muted-foreground"
                        title={t('copyCode')}
                      >
                        {copiedCode ? <Check size={18} className="text-green-600" /> : <Copy size={18} />}
                      </button>
                      </div>
                    </div>
                    {pairingExpiresAt && (
                      <p className="text-xs text-muted-foreground">
                        {t('codeExpires', { date: formatDate(pairingExpiresAt) })}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t('pairingCodeSingleUse')}
                    </p>
                    <button
                      onClick={rotatePairingCode}
                      disabled={rotatingCode}
                      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <RefreshCw size={14} className={rotatingCode ? 'animate-spin' : ''} />
                      {rotatingCode ? t('generating') : t('generateNewCode')}
                    </button>
                    <p className="text-xs text-amber-600">
                      {t('disconnectDevicesWarning')}
                    </p>
                  </div>
                ) : (
                  <button
                    onClick={rotatePairingCode}
                    disabled={rotatingCode}
                    className="px-5 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium"
                  >
                    {rotatingCode ? t('generating') : t('generatePairingCode')}
                  </button>
                )}
              </div>

              {!pairingUnavailable && (
                <div className="pt-5 border-t border-border">
                  <p className="text-sm font-medium text-foreground mb-3">{t('pairedDevices')}</p>
                  {devicesLoading ? (
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  ) : pairedDevices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('noPairedDevices')}</p>
                  ) : (
                    <div className="space-y-2">
                      {pairedDevices.map((d) => (
                        <div key={d.id} className="bg-muted border border-border rounded-lg px-4 py-3 text-sm">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-foreground capitalize">
                              {d.platform || t('unknownPlatform')}
                              {d.country ? ` · ${d.country}` : ''}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {t('lastActive', { date: formatDate(d.last_seen_at) })}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('firstPaired', { date: formatDate(d.first_seen_at) })}
                            {d.app_version ? ` · v${d.app_version}` : ''}
                          </p>
                          {d.user_agent && (
                            <p className="text-xs text-muted-foreground mt-1 truncate" title={d.user_agent}>{d.user_agent}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </SettingsTabShell>
        </TabsContent>

        <TabsContent value="orderflow">
          <SettingsTabShell title={t('tabOrderflow')}>

            {/* OrderFlow — online orders */}
            <div className="bg-card rounded-xl border border-border p-6 space-y-4">
              <div className="flex items-center gap-2">
                <Zap size={20} className="text-amber-500" />
                <div>
                  <h2 className="font-semibold text-foreground">{t('orderflowOnlineOrders')}</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('orderflowOnlineOrdersHint')}</p>
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cloudSettings.cloud_orders_enabled}
                    onChange={(e) => {
                      markHydrationTouched('cloud_orders_enabled');
                      setCloudSettings({ ...cloudSettings, cloud_orders_enabled: e.target.checked });
                    }}
                  className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
                />
                <span className="text-sm text-foreground">{t('enableOnlineOrderPolling')}</span>
              </label>

            </div>
          </SettingsTabShell>
        </TabsContent>

        {/* About tab */}
        <TabsContent value="about">
          <SettingsTabShell>
            <div className="bg-card rounded-xl border border-border p-6">
              <h2 className="font-semibold text-foreground mb-4">{t('aboutFloCafe')}</h2>
              <p className="text-sm text-muted-foreground mb-6">
                {t('aboutDescription')}
              </p>
              <div className="space-y-3">
                <a href="https://github.com/FreeOpenSourcePOS/FloCafe" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-brand hover:underline">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
                  {t('aboutGithub')}
                </a>
                <a href="https://flopos.com/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-brand hover:underline">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                  {t('aboutWebsite')}
                </a>
              </div>
            </div>

            {/* More Apps — moved here from the old Integrations tab */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Smartphone size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('moreApps')}</h2>
              </div>
              <p className="text-sm text-muted-foreground mb-5">
                {t('moreAppsHint')}
              </p>

              {moreAppsLoading && (
                <div className="flex items-center justify-center py-10">
                  <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                </div>
              )}

              {!moreAppsLoading && (
                <div className="space-y-4">
                  {moreApps.map((app) => (
                    <div key={app.id} className="flex flex-col sm:flex-row gap-5 items-start border border-border rounded-xl p-5">
                      <div className="shrink-0">
                        {app.qr_data_url ? (
                          <img src={app.qr_data_url} alt={t('appQrAlt', { name: app.name })}
                            className="w-32 h-32 rounded-lg border border-border" />
                        ) : (
                          <div className="w-32 h-32 rounded-lg border border-border flex items-center justify-center text-muted-foreground">
                            <QrCode size={36} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-foreground">{app.name}</h3>
                          {!app.available && (
                            <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{t('comingSoon')}</span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mb-3">{app.tagline}</p>
                        <div className="flex gap-3 text-sm">
                          {app.ios_url && (
                            <a href={app.ios_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                              {t('downloadForIos')}
                            </a>
                          )}
                          {app.android_url && (
                            <a href={app.android_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                              {t('downloadForAndroid')}
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {moreApps.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-10">{t('noAppsToShow')}</p>
                  )}
                </div>
              )}
            </div>
          </SettingsTabShell>
        </TabsContent>

        {/* Software Updates tab */}
        <TabsContent value="updates">
          <SettingsTabShell>
            <div className="bg-card rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-4">
              <RefreshCw size={20} className="text-muted-foreground" />
              <h2 className="font-semibold text-foreground">{t('updates')}</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-6">
              {!isElectron
                ? t('softwareUpdatesHintBrowser')
                : updateStatus?.status === 'store-managed'
                ? t('softwareUpdatesHintStore')
                : updateStatus?.status === 'linux-managed'
                ? t('softwareUpdatesHintLinuxManaged')
                : t('softwareUpdatesHintDefault')}
            </p>

            {/* Update controls only exist in the desktop app; hide them for
                browser/LAN users instead of showing a dead button (#467). */}
            {isElectron && updateStatus && updateStatus.status !== 'store-managed' && updateStatus.status !== 'linux-managed' && (
              <div className={`p-4 rounded-lg mb-4 ${
                updateStatus.status === 'available' || updateStatus.status === 'ready-to-install'
                  ? 'bg-green-50 border border-green-200 dark:bg-green-950/50 dark:border-green-800'
                  : updateStatus.status === 'up-to-date'
                  ? 'bg-green-50 border border-green-200 dark:bg-green-950/50 dark:border-green-800'
                  : updateStatus.status === 'check-failed'
                  ? 'bg-red-50 border border-red-200 dark:bg-red-950/50 dark:border-red-800'
                  : updateStatus.status === 'offline' || updateStatus.status === 'dev-mode'
                  ? 'bg-yellow-50 border border-yellow-200 dark:bg-yellow-950/50 dark:border-yellow-800'
                  : 'bg-muted border border-border'
              }`}>
                <div className="flex items-center gap-2 mb-2">
                  {(updateStatus.status === 'checking' || updateStatus.status === 'downloading') && <RefreshCw size={16} className="animate-spin text-brand" />}
                  {updateStatus.status === 'available' && <Check size={16} className="text-green-600" />}
                  {updateStatus.status === 'up-to-date' && <CheckCircle2 size={16} className="text-green-600" />}
                  {updateStatus.status === 'ready-to-install' && <CheckCircle2 size={16} className="text-green-600" />}
                  {updateStatus.status === 'check-failed' && <span className="text-red-600">✕</span>}
                  {updateStatus.status === 'offline' && <span className="text-yellow-600">⚠</span>}
                  {updateStatus.status === 'dev-mode' && <span className="text-yellow-600">⚠</span>}
                  {updateStatus.status === 'not-checked-yet' && <span className="text-muted-foreground">—</span>}
                  <span className="font-medium">
                    {updateStatus.status === 'available' ? t('updateStatusAvailable')
                     : updateStatus.status === 'up-to-date' ? t('updateStatusUpToDate')
                     : updateStatus.status === 'ready-to-install' ? t('updateStatusReadyToInstall')
                     : updateStatus.status === 'not-checked-yet' ? t('updateStatusNotCheckedYet')
                     : updateStatus.status === 'check-failed' ? t('updateStatusCheckFailed')
                     : updateStatus.status === 'offline' ? t('updateStatusOffline')
                     : updateStatus.status === 'checking' ? t('checking')
                     : updateStatus.status === 'dev-mode' ? t('devModeTitle')
                     : t('updateStatusDownloading')}
                  </span>
                </div>
                {appVersion && (
                  <p className="text-sm font-medium text-foreground">{t('version')}: <Ltr>{appVersion}</Ltr></p>
                )}
                {updateStatus.version && updateStatus.version !== appVersion && (
                  <p className="text-sm text-muted-foreground mt-1">{t('updateLatestAvailable')} <Ltr>{updateStatus.version}</Ltr></p>
                )}
                {updateStatus.percent !== undefined && (
                  <div className="mt-2">
                    <div className="w-full bg-gray-200 dark:bg-muted rounded-full h-2">
                      <div
                        className="bg-brand h-2 rounded-full transition-all"
                        style={{ width: `${updateStatus.percent}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{t('percentDownloaded', { percent: updateStatus.percent.toFixed(1) })}</p>
                  </div>
                )}
                {updateStatus.status === 'up-to-date' && (
                  <p className="text-sm text-muted-foreground">{t('upToDate')}</p>
                )}
                {updateStatus.status === 'not-checked-yet' && (
                  <p className="text-sm text-muted-foreground">{t('notCheckedYetHint')}</p>
                )}
                {updateStatus.status === 'dev-mode' && (
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">{t('devModeDisabled')}</p>
                )}
                {(updateStatus.status === 'check-failed' || updateStatus.status === 'offline') && (
                  <p className="text-sm mt-1 text-red-600 dark:text-red-300">
                    {updateStatus.reason === 'manifest-missing'
                      ? t('updateErrorManifestMissing')
                      : updateStatus.reason === 'download-failed'
                      ? t('updateErrorDownloadFailed')
                      : updateStatus.status === 'offline'
                      ? t('updateStatusOfflineHint')
                      : t('updateErrorGeneric')}
                  </p>
                )}
                {(updateStatus.status === 'check-failed' || updateStatus.status === 'offline') && updateStatus.error && (
                  <details className="mt-1">
                    <summary className="text-xs text-muted-foreground cursor-pointer">{t('errorDetails')}</summary>
                    <p className="text-xs text-muted-foreground mt-0.5 break-all"><Ltr>{updateStatus.error}</Ltr></p>
                  </details>
                )}
              </div>
            )}

            {isElectron && updateStatus?.status !== 'store-managed' && updateStatus?.status !== 'linux-managed' && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCheckUpdates}
                  disabled={updateStatus?.status === 'checking' || updateStatus?.status === 'available' || updateStatus?.status === 'downloading' || updateStatus?.status === 'ready-to-install'}
                  className="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 disabled:opacity-50 bg-brand text-white hover:opacity-90"
                >
                  <RefreshCw size={16} className={updateStatus?.status === 'checking' ? 'animate-spin' : ''} />
                  {updateStatus?.status === 'checking' ? t('checking') : t('checkForUpdates')}
                </button>
              </div>
            )}
          </div>

          {/* #463: beta/pre-release channel opt-in; feature-detects the
              beta-release-channel IPC contract and degrades visibly when absent. */}
          {isElectron && (
            <BetaChannelToggle />
          )}
          </SettingsTabShell>
        </TabsContent>

</div>
</Tabs>
      {ConfirmDialog}


      {/* Initialize Cloud Disclaimer Dialog */}
      <Dialog open={showInitializeCloudConfirm} onOpenChange={setShowInitializeCloudConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('cloudInitializeDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('cloudInitializeDialogBody')}
              <br /><br />
              {t('cloudInitializeDialogBody2')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInitializeCloudConfirm(false)}>{t('cancel')}</Button>
            <Button
              disabled={registeringCloud}
              onClick={() => { setShowInitializeCloudConfirm(false); registerCloud(''); }}
            >
              {registeringCloud ? t('registering') : t('cloudInitializeAccept')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MasterPinPrompt
        open={pinGate !== null}
        mode={pinGate?.mode === 'set' ? 'set' : 'verify'}
        title={
          pinGate?.mode === 'backup' || pinGate?.mode === 'backup-custom' ? t('confirmBackupTitle')
          : pinGate?.mode === 'import' ? t('confirmImportTitle')
          : pinGate?.mode === 'restore' ? t('confirmRestoreTitle')
          : pinGate?.mode === 'delete-cloud' ? t('cloudConfirmDeletion')
          : pinGate?.mode === 'cancel-cloud-deletion' ? t('cloudCancelDeletionTitle')
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
          toast.success(t('dbInitializedRedirecting'));
          setTimeout(() => window.location.replace('/setup'), 1200);
        }}
      />
      {isAdmin && isDirty && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none animate-in slide-in-from-bottom-5 duration-300">
          <div className={`bg-gray-900 text-white px-6 py-4 rounded-full shadow-2xl flex items-center gap-6 pointer-events-auto ${shakeSaveBar ? 'animate-shake' : ''}`}>
            <span className="text-sm font-medium">{t('unsavedChanges')}</span>
            <div className="flex items-center gap-2">
              <button onClick={resetAllSettings} disabled={savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering || savingPrinting || savingAllSettings} className="px-4 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded-full transition-colors disabled:opacity-50 text-white">{t('discard')}</button>
              <button onClick={saveAllSettings} disabled={savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering || savingPrinting || savingAllSettings} className="px-4 py-1.5 text-sm bg-brand hover:opacity-90 rounded-full font-medium transition-colors disabled:opacity-50 text-white">{(savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering || savingPrinting || savingAllSettings) ? t('saving') : t('saveChanges')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
