'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore, type PaperSize, type BillTemplate } from '@/store/pos-settings';
import { useThemeMode, type ThemeMode } from '@/store/theme';
import { LANGUAGES, type Language } from '@/lib/i18n';
import type { KotLanguagePolicy, PrimaryLanguageSelection, ReceiptLanguagePolicy } from '@print/types';
import {
  parseStoredKotLanguagePolicy,
  parseStoredReceiptLanguagePolicy,
} from '@/lib/print-language-policies';
import { usePrinterStore } from '@/hooks/usePrinter';
import { Settings, Building2, CreditCard, Monitor, Users, Gift, Printer, Share2, FileText, Lock, Smartphone, RefreshCw, Copy, Check, Wifi, Usb, Trash2, Plus, Star, TestTube2, ChefHat, QrCode, CheckCircle2, Database, Cloud, CloudOff, Zap, Percent, KeyRound, AlertTriangle, Wrench, HardDrive, UploadCloud, Hash, ChevronDown, SunMoon } from 'lucide-react';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import axios from 'axios';
import toast from 'react-hot-toast';
import { COUNTRIES, getCountryByCode, getLocalizedCountryName, sortCountriesByLocalizedName, type CurrencyDisplay, type DigitMode, type CalendarMode } from '@/lib/countries';
import { dialCodeFor, normalizeOptionalPhone } from '@/lib/phone';
import { useConfirm } from '@/hooks/use-confirm';
import { MasterPinPrompt } from '@/components/settings/MasterPinPrompt';
import BetaChannelToggle from '@/components/settings/BetaChannelToggle';
import { HealthCheckDialog } from '@/components/settings/HealthCheckDialog';
import { InitializeDatabaseDialog } from '@/components/settings/InitializeDatabaseDialog';
import { WhatsAppEnableCard } from '@/components/settings/WhatsAppEnableCard';
import { TaxConfigurationPanel } from '@/components/settings/TaxConfigurationPanel';
import { PaymentMethodsSettings } from '@/components/settings/PaymentMethodsSettings';
import { LocalePreferencesPanel } from '@/components/settings/LocalePreferencesPanel';
import { TimeZoneSelect } from '@/components/TimeZoneSelect';
import type { HealthCheckReport } from '@/types/electron';
import { useLocale, useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { TENANT_STATUS_LABEL_KEYS } from '@/lib/i18n-enums';
import { isTemplateCardSelected, type BillTemplateSelectionSource } from '@/lib/bill-template-picker';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';

// Registry-derived selectable UI languages (from LANGUAGES where selectable: true).
const SELECTABLE_LANGUAGES: Language[] = (Object.keys(LANGUAGES) as Language[]).filter(
  (lang) => LANGUAGES[lang].selectable,
);

function tenantStatusLabel(status: string | undefined, tCommon: (key: 'active' | 'inactive') => string): string {
  const key = (TENANT_STATUS_LABEL_KEYS as Record<string, 'active' | 'inactive' | undefined>)[status ?? ''];
  return key ? tCommon(key) : (status ?? '');
}

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

type SettingsKey = keyof AppConfig['Messages']['settings'];

interface TemplateCard {
  id: BillTemplate;
  nameKey?: SettingsKey;
  displayName?: string;
  preview: string;
  source: 'core' | 'plugin' | 'merchant';
  /** Selection-identity source persisted in bill_template (#447). */
  selectionSource: BillTemplateSelectionSource;
  description?: string;
  /** Provenance badge text for merchant cards (#447). */
  originBadgeKey?: 'billTemplateMerchantCreated' | 'billTemplateMerchantImported' | 'billTemplateMerchantCloned';
}

const TEMPLATE_CARDS: TemplateCard[] = [
  { id: 'classic', nameKey: 'billTemplateClassicName', preview: CLASSIC_PREVIEW, source: 'core', selectionSource: 'core' },
  { id: 'compact', nameKey: 'billTemplateCompactName', preview: COMPACT_PREVIEW, source: 'core', selectionSource: 'core' },
];

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${value ? 'bg-brand' : 'bg-gray-300'}`}
    >
      {/* start-0.5 + rtl:-translate-x-5 keeps the knob at the inline-start and slides it toward the inline-end in both directions. */}
      <span className={`absolute top-0.5 start-0.5 w-5 h-5 bg-card rounded-full shadow transition-transform ${value ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0'}`} />
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
  const { printMethod, setPrintMethod, refreshHardwarePrinter } = usePrinterStore();
  // Synced at the dashboard layout level now (issue #534).
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const sortedCountries = sortCountriesByLocalizedName(COUNTRIES, locale);
  const tRestore = useTranslations('restore');
  const tWhatsappSettings = useTranslations('whatsapp.settings');
  const language = posSettings.language;
  const setLanguage = posSettings.setLanguage;
  const { formatDate, formatTime, formatDateTime } = useFormatDate();
  const isAdmin = hasRole(currentTenant?.role, ROLE_ACCESS.ownerManager);
  const isOwner = hasRole(currentTenant?.role, ROLE_ACCESS.owner);
  const canViewTaxConfiguration = isAdmin;
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
  const requestedTab = searchParams?.get('tab') || 'store';
  // ── DB tools: master PIN, health check, initialize ──────────────────────
  // activeTab/healthCheckOpen/initializeDbOpen/pinGate read their initial value from the
  // ?tab=/?action= deep-link params directly. activeTab also stays synchronized below when
  // the sidebar changes the query string without remounting this page.
  const [activeTab, setActiveTab] = useState(requestedTab);
  const [masterPinStatus, setMasterPinStatus] = useState<{ available: boolean; isSet: boolean; schemaVersion: number | null }>({ available: false, isSet: false, schemaVersion: null });
  const [healthCheckOpen, setHealthCheckOpen] = useState(() => searchParams?.get('action') === 'health-check');
  const [healthReport, setHealthReport] = useState<HealthCheckReport | null>(null);
  const [applyingFixes, setApplyingFixes] = useState(false);
  const [initializeDbOpen, setInitializeDbOpen] = useState(() => searchParams?.get('action') === 'initialize-db');
  const [shakeSaveBar, setShakeSaveBar] = useState(false);

  const themeMode = useThemeMode((s) => s.mode);
  const setThemeMode = useThemeMode((s) => s.setMode);
  const markUserSelectedTheme = useThemeMode((s) => s.markUserSelected);

  // Last value known to be persisted — initialized from hydration, updated
  // on every successful save. Rollbacks land here, not on the captured
  // render-time value, which can be stale across rapid clicks.
  const lastCommitted = useRef<ThemeMode>('system');
  // Set the moment the user touches a control; hydration must not clobber a
  // later user choice with the stale DB row.
  const userTouched = useRef(false);
  // Hydration may race an in-flight save; seq snapshots order the winner.
  const saveSeq = useRef(0);
  // Armed when a save fails outright; the next hydration applies server truth.
  const needsServerTruth = useRef(false);
  const [savingTheme, setSavingTheme] = useState(false);

  // Absent row (404) → keep 'system'. Never an error toast on missing key.
  // setMode stays blocked by userTouched; lastCommitted moves only when no
  // save raced this fetch, so the rollback baseline stays trustworthy.
  useEffect(() => {
    let cancelled = false;
    const seqAtFetch = saveSeq.current;
    api.get('/settings/theme_mode').then((res) => {
      if (cancelled) return;
      const raw = res.data?.setting?.value;
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        if (!userTouched.current || needsServerTruth.current) {
          setThemeMode(raw);
        }
        // lastCommitted may be updated even when userTouched is true, but
        // only if no save started after this fetch began. If a save did
        // race in, its own lastCommitted update (success) or its
        // server-truth restore (failure, below) is authoritative — the
        // fetch response at that point reflects the pre-save DB row.
        if (saveSeq.current === seqAtFetch) {
          lastCommitted.current = raw;
        }
        // The needsServerTruth arm is consumed exactly once: a save that
        // failed (and whose recovery GET also failed) armed it, this
        // hydration response is the first authoritative signal since,
        // so we apply + clear. A subsequent user click re-arms as needed.
        if (needsServerTruth.current) {
          needsServerTruth.current = false;
        }
      }
    }).catch(() => {
      // 404 (no row yet), 401, network — keep 'system'.
    });
    return () => { cancelled = true; };
  }, [setThemeMode]);

  // Optimistic save: mirrors saveTelemetry (page's established pattern). The
  // store flip is instant — ThemeSync reacts and re-themes immediately. If
  // the PUT fails, rollback to the last persisted value + existing saveFailed
  // toast. savingTheme guards against overlapping PUTs; userTouched blocks a
  // late hydration fetch from clobbering a newer user choice.
  //
  // Optimistic; on failure restore server truth (lastCommitted is the baseline).
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

  // Sidebar links can change only the query string while this page stays mounted.
  // Keep the rendered Settings tab in sync with those deep-link changes (including
  // returning to the default Store tab when ?tab= is removed).
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
      toast.error(t('healthCheckFailed'));
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
    if (isOwner) {
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
          toast.error(t('healthCheckFailed'));
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

  // Lets the owner pick a custom save location (external drive, cloud-synced
  // folder, etc.) via the same native save dialog the File menu's "Export
  // Backup" action already uses. A backup saved this way does not appear in
  // the Backup History list below — same as it never has for the menu
  // action — since it's outside the managed backups/ directory. See #120.
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
  // The mount effect below always fetches this unconditionally, so this starts true rather
  // than being set synchronously inside that effect (fetchKdsInfo, used by the manual
  // "refresh" button, still sets it explicitly for that path).
  const [kdsInfoLoading, setKdsInfoLoading] = useState(true);

  const fetchKdsInfo = () => {
    setKdsInfoLoading(true);
    api.get('/kds-info').then((res) => {
      setKdsInfo(res.data);
    }).catch(() => {
      toast.error(t('kdsInfoFetchFailed'));
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
  const { updateStatus, appVersion, isElectron, checkForUpdates: handleCheckUpdates } = useUpdateStatus();

  // ── Printers ─────────────────────────────────────────────────────────────
  type HwPrinter = {
    id: string; name: string; connection_type: 'network' | 'usb' | 'webusb';
    ip_address?: string; port?: number;
    cash_drawer_pulse_enabled: number;
    paper_width: string; is_default: number; profile_id?: string; profile_name?: string;
  };

  type PrinterForm = {
    name: string; connection_type: 'network' | 'usb' | 'webusb';
    ip_address: string; port: string; paper_width: string;
    cash_drawer_pulse_enabled: boolean;
  };

  const emptyPrinterForm: PrinterForm = {
    name: '', connection_type: 'network', ip_address: '', port: '9100',
    paper_width: 'cols-42', cash_drawer_pulse_enabled: false,
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
    return t('printColumnsShort', { cols });
  };

  // Printer failures carry a specific, actionable reason from the backend
  // (wrong OS queue name, offline, out of paper, etc.) — showing only a
  // generic toast forces a support ticket for what the app already knows.
  const printerErrorMessage = (err: unknown, fallback: string): string => {
    if (axios.isAxiosError(err)) {
      const apiError = err.response?.data?.error;
      if (typeof apiError === 'string' && apiError.trim()) return `${fallback}: ${apiError}`;
    }
    return fallback;
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
      toast.success(t('printerQuickAdded', { name: p.name }));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch {
      toast.error(t('printerAddFailed'));
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
      cash_drawer_pulse_enabled: p.cash_drawer_pulse_enabled === 1,
    });
    setEditingPrinterId(p.id);
    setShowPrinterForm(true);
  };

  const savePrinterHw = async () => {
    if (!printerForm.name) { toast.error(t('printerNameRequired')); return; }
    setSavingPrinter(true);
    try {
      const payload = {
        name: printerForm.name,
        connection_type: printerForm.connection_type,
        ip_address: printerForm.connection_type === 'network' ? printerForm.ip_address : undefined,
        port: printerForm.connection_type === 'network' ? Number(printerForm.port) : undefined,
        paper_width: printerForm.paper_width,
        cash_drawer_pulse_enabled: printerForm.cash_drawer_pulse_enabled,
      };
      if (editingPrinterId) {
        await api.put(`/printers/${editingPrinterId}`, payload);
        toast.success(t('printerUpdated'));
      } else {
        await api.post('/printers', payload);
        toast.success(t('printerSaved'));
      }
      fetchPrinters();
      refreshHardwarePrinter();
      setShowPrinterForm(false);
    } catch (err) {
      toast.error(printerErrorMessage(err, t('printerSaveFailed')));
    } finally {
      setSavingPrinter(false);
    }
  };

  const deletePrinterHw = async (id: string) => {
    if (!await confirm(t('printerDeleteConfirm'), { destructive: true, confirmLabel: tCommon('delete') })) return;
    try {
      await api.delete(`/printers/${id}`);
      toast.success(t('printerDeleted'));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch { toast.error(t('printerDeleteFailed')); }
  };

  const setDefaultPrinter = async (id: string) => {
    try {
      await api.post(`/printers/${id}/set-default`);
      toast.success(t('defaultPrinterSet'));
      fetchPrinters();
      refreshHardwarePrinter();
    } catch { toast.error(t('actionFailed')); }
  };

  const testPrinterHw = async (printer: HwPrinter) => {
    if (printer.connection_type === 'webusb') {
      toast(t('webusbTestHint'));
      return;
    }
    setTestingPrinterId(printer.id);
    try {
      await api.post(`/printers/${printer.id}/test`);
      toast.success(t('testPrintSent'));
    } catch (err) {
      toast.error(printerErrorMessage(err, t('testPrintFailed')));
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
    printerArabicShaping: boolean;
    printerTrimDecimals: boolean;
    // Print language policies (#441): 'inherit'/'none' sentinels or registry codes.
    receiptPrimaryLanguage: string; // 'inherit' | selectable code
    receiptSecondLanguage: string; // 'none' | selectable code
    kotLanguage: string; // 'inherit' | selectable code
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
    printerArabicShaping: posSettings.printerArabicShaping,
    printerTrimDecimals: posSettings.printerTrimDecimals,
    receiptPrimaryLanguage: posSettings.billLanguagePolicy.primary.mode === 'fixed'
      ? posSettings.billLanguagePolicy.primary.language
      : 'inherit',
    receiptSecondLanguage: posSettings.billLanguagePolicy.additional[0] ?? 'none',
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
  const savePrinting = async (silent: boolean = false) => {
    // Build typed policies from the form and mirror them into the store for
    // renderer-side reads (renderers adopt them in #442+).
    const receiptPrimary: PrimaryLanguageSelection = printingForm.receiptPrimaryLanguage === 'inherit'
      ? { mode: 'inherit' }
      : { mode: 'fixed', language: printingForm.receiptPrimaryLanguage };
    const dedupedSecond = printingForm.receiptSecondLanguage !== 'none'
      && !(receiptPrimary.mode === 'fixed' && receiptPrimary.language === printingForm.receiptSecondLanguage)
      ? printingForm.receiptSecondLanguage
      : null;
    const billLanguagePolicy: ReceiptLanguagePolicy = dedupedSecond !== null
      ? { primary: receiptPrimary, additional: [dedupedSecond] as const }
      : { primary: receiptPrimary, additional: [] as const };
    const kotLanguagePolicy: KotLanguagePolicy = {
      primary: printingForm.kotLanguage === 'inherit' ? { mode: 'inherit' } : { mode: 'fixed', language: printingForm.kotLanguage },
      additional: [] as const,
    };
    posSettings.setPrinterEnabled(printingForm.printerEnabled);
    posSettings.setPrinterPaperSize(printingForm.printerPaperSize);
    setPrintMethod(printingForm.printMethod);
    posSettings.setAutoPrintKot(printingForm.autoPrintKot);
    posSettings.setAutoPrintBill(printingForm.autoPrintBill);
    posSettings.setWhatsappShareEnabled(printingForm.whatsappShareEnabled);
    posSettings.setPrinterUseUnicode(printingForm.printerUseUnicode);
    posSettings.setPrinterArabicShaping(printingForm.printerArabicShaping);
    posSettings.setPrinterTrimDecimals(printingForm.printerTrimDecimals);
    posSettings.setBillLanguagePolicy(billLanguagePolicy);
    posSettings.setKotLanguagePolicy(kotLanguagePolicy);
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
      api.put('/settings/bill_language_policy', { value: JSON.stringify(billLanguagePolicy) }),
      api.put('/settings/kot_language_policy', { value: JSON.stringify(kotLanguagePolicy) }),
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
    if (!silent) toast.success(t('printingSettingsSaved'));
  };
  const resetPrinting = () => setPrintingForm(savedPrinting);

  // Bill template local state. billTemplateSource carries the resolved
  // selection identity alongside the bare id so a pack template_id that
  // collides with a core name (classic/compact) keeps its {source: 'pack'}
  // qualifier through both display-selection and save round-trips (#447).
  type BillTemplateForm = {
    billTemplate: BillTemplate;
    billTemplateSource: BillTemplateSelectionSource;
    billFooterMessage: string;
  };
  const initBillTemplate = (): BillTemplateForm => ({
    billTemplate: posSettings.billTemplate,
    billTemplateSource: 'core',
    billFooterMessage: posSettings.billFooterMessage,
  });
  const [billForm, setBillForm] = useState<BillTemplateForm>(initBillTemplate);
  const [savedBillForm, setSavedBillForm] = useState<BillTemplateForm>(initBillTemplate);
  const [billTemplateCards, setBillTemplateCards] = useState<TemplateCard[]>(TEMPLATE_CARDS);
  const saveBillTemplate = async (silent: boolean = false) => {
    posSettings.setBillTemplate(billForm.billTemplate);
    posSettings.setBillFooterMessage(billForm.billFooterMessage);
    // Persist the resolved selection identity captured at selection time
    // (NOT re-derived by first-id match, which a colliding pack id would
    // fail): bare id for core templates, structured { source, id } for
    // pack and merchant.
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
  // Server-resolved: the active country tax pack's format if it declares
  // one, else the static countries.ts fallback, else null. The backend is
  // authoritative; this drives immediate warning feedback below the field.
  const [taxIdFormat, setTaxIdFormat] = useState<{ pattern: string; description: string } | null>(null);
  const [taxIdFormatCountryCode, setTaxIdFormatCountryCode] = useState('');
  // check 25 (main/routes/tax-packs.ts) rejects the textbook nested-
  // quantifier ReDoS shape at pack-activation time, but that's a known-shape
  // heuristic, not a formal safety proof. This runs on every keystroke, so
  // cap the input actually tested as a backstop too: the longest real
  // registration-number scheme is 15 chars (India GSTIN), so 24 leaves
  // generous headroom while bounding a worst-case pattern's backtracking to
  // low milliseconds instead of freezing the tab.
  const TAX_ID_WARNING_MAX_LENGTH = 24;
  const taxIdWarning = (() => {
    const value = form.taxRegistrationNumber.trim();
    // Do not show a format against a country other than the one for which the
    // server resolved it. This also keeps a rejected country-change response
    // visible for the submitted country without mislabeling it after a revert.
    if (!taxIdFormat || !value || form.countryCode !== taxIdFormatCountryCode) return null;
    if (value.length > TAX_ID_WARNING_MAX_LENGTH) return null;
    try {
      return new RegExp(taxIdFormat.pattern, 'i').test(value) ? null : taxIdFormat.description;
    } catch {
      return null;
    }
  })();

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
      const loaded: BusinessForm = {
        businessName: d.business_name || '',
        countryCode: d.country || '',
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

      toast.success(t('reloadedFromDb'));
    } catch {
      toast.error(t('reloadFailed'));
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
      .catch(() => toast.error(t('kdsInfoFetchFailed')))
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
    api.get('/settings/bill_language_policy').then((res) => {
      const policy = parseStoredReceiptLanguagePolicy(res.data?.setting?.value);
      if (!policy) return;
      posSettings.setBillLanguagePolicy(policy);
      const formPatch = {
        receiptPrimaryLanguage: policy.primary.mode === 'fixed' ? policy.primary.language : 'inherit',
        receiptSecondLanguage: policy.additional[0] ?? 'none',
      };
      setPrintingForm((p) => ({ ...p, ...formPatch }));
      setSavedPrinting((p) => ({ ...p, ...formPatch }));
    }).catch(() => {});
    api.get('/settings/kot_language_policy').then((res) => {
      const policy = parseStoredKotLanguagePolicy(res.data?.setting?.value);
      if (!policy) return;
      posSettings.setKotLanguagePolicy(policy);
      const formPatch = {
        kotLanguage: policy.primary.mode === 'fixed' ? policy.primary.language : 'inherit',
      };
      setPrintingForm((p) => ({ ...p, ...formPatch }));
      setSavedPrinting((p) => ({ ...p, ...formPatch }));
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
        selectionSource: 'pack' as const,
        description: `${template.country} tax template · ${template.paperColumns.join(', ')} columns`,
      }));
      // Merchant templates (#447): provenance is informational only — a
      // cloned origin references a compliance-pack template WITHOUT any
      // trust claim; the copy is an ordinary editable document.
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
      // The persisted value may be a legacy bare id or a structured
      // { source, id } JSON string (#447). Resolve it back to a picker card,
      // preferring the card whose selection source matches the stored source
      // so a pack template_id that collides with a core name keeps its
      // qualifier on the next save.
      let storedId: unknown = templateResponse?.data.setting?.value;
      let storedSource: string | null = null;
      if (typeof storedId === 'string' && storedId.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(storedId) as { source?: unknown; id?: unknown };
          if (
            parsed && typeof parsed === 'object'
            && typeof parsed.id === 'string'
            && (parsed.source === 'core' || parsed.source === 'pack' || parsed.source === 'merchant')
          ) {
            storedId = parsed.id;
            storedSource = parsed.source;
          }
        } catch { /* keep raw value */ }
      }
      const candidateCard = typeof storedId === 'string'
        ? cards.find((card) => card.id === storedId)
        : undefined;
      const matchedCard = candidateCard && storedSource !== null && candidateCard.selectionSource !== storedSource
        ? cards.find((card) => card.id === candidateCard.id && card.selectionSource === storedSource)
        : candidateCard;
      const billTemplate: BillTemplate = matchedCard ? matchedCard.id : 'classic';
      const billTemplateSource: 'core' | 'pack' | 'merchant' = matchedCard
        ? matchedCard.selectionSource
        : 'core';
      const billFooterMessage = footerResponse?.data.setting?.value ?? posSettings.billFooterMessage;
      const loadedBillForm = { billTemplate, billTemplateSource, billFooterMessage };
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
      const loaded: BusinessForm = {
        businessName: d.business_name || '',
        countryCode: d.country || '',
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
      setTaxIdFormat(d.tax_id_format || null);
      setTaxIdFormatCountryCode(loaded.countryCode);
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
        toast.success(t('cloudRegistrationSuccess'));
      }
    } catch {
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
    const norm = normalizeOptionalPhone(form.businessPhone, form.countryCode || 'IN');
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
      updateCurrentTenant({ currency: form.currency, timezone: form.timezone, country: form.countryCode, currency_display: form.currencyDisplay, number_digits: form.numberDigits, calendar: form.calendar });
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
    if (prefix && !/^[A-Za-z0-9_-]{0,12}$/.test(prefix)) {
      toast.error(t('orderNumberPrefixInvalid'));
      return;
    }
    const invoicePrefix = orderNumberForm.invoicePrefix.trim();
    if (invoicePrefix && !/^[A-Za-z0-9_-]{0,12}$/.test(invoicePrefix)) {
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
    try {
      await Promise.all([saveBusinessInfo(true), saveLoyalty(true), saveDiscount(true), saveCloud(true), saveOrderNumbering(true)]);
      await savePrinting(true);
      await saveBillTemplate(true);
      toast.success(t('allSaved'));
    } catch {
      toast.error(t('allSaveFailed'));
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
      toast.success(t('pairingCodeRotated'));
      loadPairedDevices();
    } catch {
      // Show a localized failure; the specific backend reason stays in logs.
      toast.error(t('pairingCodeFailed'));
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
    { value: 'thermal58', label: t('paperSize58') },
    { value: 'thermal80', label: t('paperSize80') },
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
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('navGroupGeneral')}</p>
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
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('navGroupOperations')}</p>
            </div>
            <SettingsNavItem label={t('posWorkflow')} value="pos" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabKds')} value="kds" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tablesideOrdering')} value="server-app" active={activeTab} onClick={handleSettingsTabChange} />
            {/* WhatsApp opt-in lives under Operations because the receive-bill
                workflow is what the cashier touches every time a customer pays. */}
            <SettingsNavItem label={t('tabWhatsapp')} value="whatsapp" active={activeTab} onClick={handleSettingsTabChange} />

            {/* Customers group */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-border">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('navGroupCustomers')}</p>
            </div>
            <SettingsNavItem label={t('loyalty')} value="loyalty" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('discounts')} value="discounts" active={activeTab} onClick={handleSettingsTabChange} />

            {/* Integrations group (formerly "Data") */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-border">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('navGroupData')}</p>
            </div>
            <SettingsNavItem label={t('tabMobileAccess')} value="mobile-access" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabBackupData')} value="data" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabOrderflow')} value="orderflow" active={activeTab} onClick={handleSettingsTabChange} />

            {/* Account group */}
            <div className="hidden md:block px-3 pt-4 pb-2 mt-3 mb-1 border-b border-border">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{t('navGroupAccount')}</p>
            </div>
            <SettingsNavItem label={t('account')} value="account" active={activeTab} onClick={handleSettingsTabChange} attention={cloudDeletionNeedsAction || (cloudAccountAvailable && Boolean(cloudAccount?.email && !cloudAccount?.verified))} />
            <SettingsNavItem label={t('privacy')} value="privacy" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabUpdates')} value="updates" active={activeTab} onClick={handleSettingsTabChange} />
            <SettingsNavItem label={t('tabAbout')} value="about" active={activeTab} onClick={handleSettingsTabChange} />

          </nav>
        </div>

        <div className="flex-1 min-w-0 md:h-full md:min-h-0 md:overflow-y-auto md:overscroll-contain pb-32">

        <TabsContent value="store">
          <div className="pb-6 max-w-3xl space-y-6">
            {/* Store Details — editable for admin, readonly otherwise */}
            <div className="lg:col-span-2 bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Building2 size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('storeDetails')}</h2>
                {!isAdmin && (
                  <span className="ms-auto flex items-center gap-1 text-xs text-gray-400">
                    <Lock size={12} /> {t('adminOnly')}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">{t('businessName')}</label>
                  {isAdmin ? (
                    <input type="text" value={form.businessName} onChange={(e) => setForm((p) => ({ ...p, businessName: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                  ) : (
                    <p className="font-medium text-foreground">{form.businessName || currentTenant?.business_name}</p>
                  )}
                </div>
                {/* Country, Timezone, Currency in single line with individual headings */}
                <div className="md:col-span-2 space-y-2">
                  {/* Headings */}
                  <div className="grid grid-cols-3 gap-2">
                    <label className="text-sm text-muted-foreground">{t('country')}</label>
                    <label className="text-sm text-muted-foreground">{t('timezone')}</label>
                    <label className="text-sm text-muted-foreground">{t('currency')}</label>
                  </div>
                  
                  {/* Input fields */}
                  {isAdmin ? (
                    <div className="grid grid-cols-3 gap-2">
                      <select
                        value={form.countryCode}
                        onChange={(e) => {
                           const country = COUNTRIES.find(c => c.code === e.target.value);
                           setForm((p) => {
                             const previousCountry = getCountryByCode(p.countryCode);
                             const timezoneWasDefault = !previousCountry || p.timezone === previousCountry.timezone;
                             const options = country?.localeOptions;
                             // Re-evaluate locale display preferences against the
                             // newly selected country (#390): keep supported values
                             // and reset unsupported ones to their neutral defaults.
                             const currencyDisplay = (options?.currencyDisplay?.includes(p.currencyDisplay) || p.currencyDisplay === 'rial')
                               ? p.currencyDisplay
                               : 'rial';
                             const numberDigits = (options?.digits?.includes(p.numberDigits) || p.numberDigits === 'locale')
                               ? p.numberDigits
                               : 'locale';
                             const calendar = (options?.calendar?.includes(p.calendar) || p.calendar === 'locale')
                               ? p.calendar
                               : 'locale';
                             return {
                               ...p,
                               countryCode: e.target.value,
                               currency: country?.currency || p.currency,
                               timezone: timezoneWasDefault
                                 ? (country?.timezone || p.timezone)
                                 : p.timezone,
                               currencyDisplay,
                               numberDigits,
                               calendar,
                             };
                           });
                        }}
                        aria-label={tCommon('search')}
                        className="px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                      >
                        <option value="">{t('selectCountry')}</option>
                        {sortedCountries.map((c) => (
                          <option key={c.code} value={c.code}>{getLocalizedCountryName(c.code, locale)}</option>
                        ))}
                      </select>
                      <TimeZoneSelect
                        value={form.timezone}
                        onChange={(timezone) => setForm((p) => ({ ...p, timezone }))}
                        placeholder={t('selectTimezone')}
                        className="px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                        ariaLabel={t('timezone')}
                      />
                      <input 
                        type="text" 
                        value={form.currency} 
                        onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
                        placeholder={t('currencyAutoFilled')}
                        className="px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-muted" 
                        readOnly
                        dir="ltr"
                      />
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      <p className="font-medium text-foreground">
                        {form.countryCode ? getLocalizedCountryName(form.countryCode, locale) : '—'}
                      </p>
                      <p className="font-medium text-foreground">
                        <Ltr>{form.timezone || '—'}</Ltr>
                      </p>
                      <p className="font-medium text-foreground">
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
                  <label className="block text-sm text-muted-foreground mb-1">{t('billingType')}</label>
                  {isAdmin ? (
                    <select value={form.billingType}
                      onChange={(e) => setForm((p) => ({ ...p, billingType: e.target.value as 'postpaid' | 'prepaid' }))}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card">
                      <option value="postpaid">{t('billingTypePostpaid')}</option>
                      <option value="prepaid">{t('billingTypePrepaid')}</option>
                    </select>
                  ) : (
                    <p className="font-medium text-foreground capitalize">{form.billingType}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">{t('tablesRequired')}</label>
                  {isAdmin ? (
                    <select
                      value={form.tablesRequired ? 'yes' : 'no'}
                      onChange={(e) => setForm((p) => ({ ...p, tablesRequired: e.target.value === 'yes' }))}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                    >
                      <option value="yes">{t('tablesRequiredYes')}</option>
                      <option value="no">{t('tablesRequiredNo')}</option>
                    </select>
                  ) : (
                    <p className="font-medium text-foreground">{form.tablesRequired ? t('yes') : t('no')}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">{t('taxRegistered')}</label>
                  {isAdmin ? (
                    <select
                      value={form.taxRegistered ? 'yes' : 'no'}
                      onChange={(e) => setForm((p) => ({ ...p, taxRegistered: e.target.value === 'yes' }))}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                    >
                      <option value="yes">{t('yes')}</option>
                      <option value="no">{t('no')}</option>
                    </select>
                  ) : (
                    <p className="font-medium text-foreground">{form.taxRegistered ? t('yes') : t('no')}</p>
                  )}
                </div>
                {form.taxRegistered ? (
                  <div>
                    <label className="block text-sm text-muted-foreground mb-1">{t('taxIdLabel')}</label>
                    {isAdmin ? (
                      <>
                        <input type="text" value={form.taxRegistrationNumber} onChange={(e) => setForm((p) => ({ ...p, taxRegistrationNumber: e.target.value }))}
                          placeholder={t('taxIdPlaceholder')}
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" dir="ltr" />
                        {taxIdWarning ? (
                          <p className="mt-1 text-xs text-amber-600">
                            {t('taxIdFormatWarning', { country: form.countryCode, format: taxIdWarning })}
                          </p>
                        ) : null}
                      </>

                    ) : (
                      <p className="font-medium text-foreground"><Ltr>{form.taxRegistrationNumber || '—'}</Ltr></p>
                    )}
                  </div>
                ) : <div className="hidden md:block" />}
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">{t('phone')}</label>
                  {isAdmin ? (
                    <input type="text" value={form.businessPhone} onChange={(e) => setForm((p) => ({ ...p, businessPhone: e.target.value }))}
                      placeholder={t('phonePlaceholder', { dialCode: dialCodeFor(form.countryCode) || '+1' })}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" dir="ltr" />
                  ) : (
                    <p className="font-medium text-foreground"><Ltr>{form.businessPhone || '—'}</Ltr></p>
                  )}
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm text-muted-foreground mb-1">{t('address')}</label>
                  {isAdmin ? (
                    <textarea value={form.businessAddress} onChange={(e) => setForm((p) => ({ ...p, businessAddress: e.target.value }))}
                      rows={2} placeholder={t('addressPlaceholder')}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand resize-none" />
                  ) : (
                    <p className="font-medium text-foreground">{form.businessAddress || '—'}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">{t('instagramHandle')}</label>
                  {isAdmin ? (
                    <input type="text" value={form.instagramHandle} onChange={(e) => setForm((p) => ({ ...p, instagramHandle: e.target.value }))}
                      placeholder={t('instagramPlaceholder')}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                  ) : (
                    <p className="font-medium text-foreground">{form.instagramHandle || '—'}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">{t('instagramHint')}</p>
                </div>
              </div>

              {isAdmin && (
                <div className="mt-4 flex gap-2">
                </div>
              )}
            </div>

            {/* Number Formats */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Hash size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('orderNumberFormat')}</h2>
                {!isAdmin && (
                  <span className="ms-auto flex items-center gap-1 text-xs text-gray-400">
                    <Lock size={12} /> {t('adminOnly')}
                  </span>
                )}
              </div>

              <h3 className="text-sm font-semibold text-foreground mb-3">{t('orderNumbers')}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">{t('orderNumberPrefix')}</label>
                  {isAdmin ? (
                    <input
                      type="text"
                      value={orderNumberForm.prefix}
                      onChange={(e) => setOrderNumberForm((p) => ({ ...p, prefix: e.target.value.toUpperCase() }))}
                      placeholder="ORD"
                      maxLength={12}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                    />
                  ) : (
                    <p className="font-medium text-foreground">{orderNumberForm.prefix || '—'}</p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1">{t('orderNumberPreview')}</label>
                  <p className="font-mono font-medium text-foreground px-3 py-2 bg-muted rounded-lg border border-border">
                    <Ltr>{[
                      orderNumberForm.prefix,
                      orderNumberForm.includeDate ? new Date().toISOString().slice(0, 10).replace(/-/g, '') : '',
                      '0001',
                    ].filter(Boolean).join('-')}</Ltr>
                  </p>
                </div>
              </div>

              <div className="mt-5 pt-5 border-t border-border space-y-3">
                <div className="flex items-center justify-between py-2">
                  <div>
                    <span className="text-sm text-foreground">{t('orderNumberIncludeDate')}</span>
                    <p className="text-xs text-muted-foreground">{t('orderNumberIncludeDateHint')}</p>
                  </div>
                  <Toggle
                    value={orderNumberForm.includeDate}
                    onChange={isAdmin ? (v) => setOrderNumberForm((p) => ({ ...p, includeDate: v })) : () => {}}
                  />
                </div>
                <div className="flex items-center justify-between py-2">
                  <div>
                    <span className="text-sm text-foreground">{t('orderNumberResetDaily')}</span>
                    <p className="text-xs text-muted-foreground">{t('orderNumberResetDailyHint')}</p>
                  </div>
                  <Toggle
                    value={orderNumberForm.resetDaily}
                    onChange={isAdmin ? (v) => setOrderNumberForm((p) => ({ ...p, resetDaily: v })) : () => {}}
                  />
                </div>
              </div>

              <div className="mt-6 pt-5 border-t border-border">
                <h3 className="text-sm font-semibold text-foreground mb-3">{t('invoiceNumbers')}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-muted-foreground mb-1">{t('invoiceNumberPrefix')}</label>
                    {isAdmin ? (
                      <input
                        type="text"
                        value={orderNumberForm.invoicePrefix}
                        onChange={(e) => setOrderNumberForm((p) => ({ ...p, invoicePrefix: e.target.value.toUpperCase() }))}
                        placeholder="INV"
                        maxLength={12}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                      />
                    ) : (
                      <p className="font-medium text-foreground">{orderNumberForm.invoicePrefix || '—'}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm text-muted-foreground mb-1">{t('invoiceNumberPreview')}</label>
                    <p className="font-mono font-medium text-foreground px-3 py-2 bg-muted rounded-lg border border-border">
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
                    <label className="block text-sm text-muted-foreground mb-1">{t('invoiceResetPeriod')}</label>
                    {isAdmin ? (
                      <select
                        value={orderNumberForm.invoiceResetPeriod}
                        onChange={(e) => setOrderNumberForm((p) => ({ ...p, invoiceResetPeriod: e.target.value as InvoiceResetPeriod }))}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
                      >
                        <option value="daily">{t('invoiceResetDaily')}</option>
                        <option value="monthly">{t('invoiceResetMonthly')}</option>
                        <option value="financial_year">{t('invoiceResetFinancialYear')}</option>
                        <option value="never">{t('invoiceResetNever')}</option>
                      </select>
                    ) : (
                      <p className="font-medium text-foreground">{orderNumberForm.invoiceResetPeriod.replace('_', ' ')}</p>
                    )}
                  </div>
                  {orderNumberForm.invoiceResetPeriod === 'financial_year' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm text-muted-foreground mb-1">{t('financialYearStartMonth')}</label>
                        <input
                          type="number"
                          min={1}
                          max={12}
                          value={orderNumberForm.invoiceFinancialYearStartMonth}
                          disabled={!isAdmin}
                          onChange={(e) => setOrderNumberForm((p) => ({ ...p, invoiceFinancialYearStartMonth: Number(e.target.value) }))}
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand disabled:bg-muted"
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-muted-foreground mb-1">{t('financialYearStartDay')}</label>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={orderNumberForm.invoiceFinancialYearStartDay}
                          disabled={!isAdmin}
                          onChange={(e) => setOrderNumberForm((p) => ({ ...p, invoiceFinancialYearStartDay: Number(e.target.value) }))}
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand disabled:bg-muted"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-5 pt-5 border-t border-border">
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <span className="text-sm text-foreground">{t('invoiceNumberIncludePeriod')}</span>
                      <p className="text-xs text-muted-foreground">{t('invoiceNumberIncludePeriodHint')}</p>
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
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <CreditCard size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('subscription')}</h2>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="text-sm text-muted-foreground">{t('plan')}</p>
                  <p className="font-medium text-foreground capitalize">{currentTenant?.plan}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('status')}</p>
                  <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                    currentTenant?.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {tenantStatusLabel(currentTenant?.status, tCommon)}
                  </span>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">{t('languages')}</p>
                  <select
                    value={language}
                    onChange={(e) => {
                      const lang = e.target.value as Language;
                      setLanguage(lang);
                      api.put('/settings/business', { language: lang }).catch(() => toast.error(t('saveFailed')));
                    }}
                    className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                  >
                    {SELECTABLE_LANGUAGES.map((lang) => (
                      <option key={lang} value={lang}>{LANGUAGES[lang].nativeName}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            
          </div>
        </TabsContent>

        <TabsContent value="payments">
          <PaymentMethodsSettings isAdmin={isAdmin} />
        </TabsContent>

        {isAdmin && (
        <TabsContent value="appearance">
          <div className="pb-6 max-w-3xl space-y-6">
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
          </div>
        </TabsContent>
        )}

        {canViewTaxConfiguration && (
          <TabsContent value="tax">
            <TaxConfigurationPanel isOwner={isOwner} />
          </TabsContent>
        )}

        <TabsContent value="pos">
          <div className="pb-6 max-w-3xl space-y-6">
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
                <Toggle value={posSettings.showProductImages} onChange={(v) => {
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
                  <Toggle value={posSettings.customerMandatory} onChange={(v) => {
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
                  <Toggle value={posSettings.enforcePhoneLength} onChange={(v) => {
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
                            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">{t('appleDevices')}</p>
                            <Ltr as="a" href={posInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 break-all hover:underline">
                              {posInfo.mdns_url}
                            </Ltr>
                            <p className="text-xs text-blue-600 mt-2">
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
                          <div className="w-48 h-48 rounded-xl border border-border flex items-center justify-center text-gray-400">
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
          </div>
        </TabsContent>

        {/* Kitchen Display — own tab under Operations */}
        <TabsContent value="kds">
          <div className="pb-6 max-w-3xl space-y-6">
            {/* KDS on/off (issue #133) — not every business runs a Kitchen Display. */}
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground">{t('kdsEnabledToggle')}</p>
                  <p className="text-sm text-muted-foreground">{t('kdsEnabledToggleHint')}</p>
                </div>
                <Toggle value={kdsEnabledSetting} onChange={(v) => { if (!savingKdsEnabled) saveKdsEnabled(v); }} />
              </div>
              {!kdsEnabledSetting && !kotPrintingEnabledSetting && (
                <div className="mt-4 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-800">
                    {t('kitchenWorkflowBothOffNote')}
                  </p>
                </div>
              )}
            </div>

            {!kdsEnabledSetting && (
              <p className="text-sm text-gray-400 italic">
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
                            <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">{t('appleDevices')}</p>
                            <Ltr as="a" href={kdsInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 break-all hover:underline">
                              {kdsInfo.mdns_url}
                            </Ltr>
                            <p className="text-xs text-blue-600 mt-2">
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
                          <div className="w-48 h-48 rounded-xl border border-border flex items-center justify-center text-gray-400">
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
                    <button onClick={fetchKdsInfo} disabled={kdsInfoLoading}
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
                  <button onClick={fetchKdsInfo}
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
                <p className="text-sm text-gray-400 py-4 text-center">{t('noStationsYet')}</p>
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
                          <p className="text-xs text-gray-400">{t('noCategoriesYet')}</p>
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
                          <p className="text-xs text-gray-400">{t('noStaffYet')}</p>
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

            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
              <strong>{t('howItWorks')}</strong> {t('howItWorksBody')}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="server-app">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground">{t('serverApp')}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('serverAppEnabledHint')}
                  </p>
                </div>
                <Toggle value={serverAppEnabledSetting} onChange={(v) => { if (!savingServerAppEnabled) saveServerAppEnabled(v); }} />
              </div>
            </div>

            {!serverAppEnabledSetting && (
              <p className="text-sm text-gray-400 italic">
                {t('serverAppPairingHiddenHint')}
              </p>
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
                          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">{t('appleDevices')}</p>
                          <Ltr as="a" href={serverAppInfo.mdns_url} target="_blank" rel="noopener noreferrer" className="block font-mono text-sm text-blue-600 break-all hover:underline">
                            {serverAppInfo.mdns_url}
                          </Ltr>
                          <p className="text-xs text-blue-600 mt-2">{t('appleDevicesHint')}</p>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col sm:flex-row gap-6 items-start">
                        <div className="shrink-0">
                          {serverAppInfo.qr_data_url ? (
                            <img src={serverAppInfo.qr_data_url} alt={t('serverAppQrAlt')} className="w-48 h-48 rounded-xl border border-border" />
                          ) : (
                            <div className="w-48 h-48 rounded-xl border border-border flex items-center justify-center text-gray-400">
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
          </div>
        </TabsContent>

        <TabsContent value="loyalty">
          <div className="pb-6 max-w-3xl space-y-6">
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
                    onClick={() => setLoyaltyEnabled(!loyaltyEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      loyaltyEnabled ? 'bg-brand' : 'bg-gray-200'
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
                        onChange={(e) => setGlobalCashbackPercent(e.target.value)}
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
          </div>
        </TabsContent>

        <TabsContent value="discounts">
          <div className="pb-6 max-w-3xl space-y-6">
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
                    onChange={(e) => setDiscountMode(e.target.value)}
                    className="w-48 px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand bg-card">
                    <option value="both">{t('discountBoth')}</option>
                    <option value="percentage">{t('discountPercentageOnly')}</option>
                    <option value="flat">{t('discountFlatOnly')}</option>
                  </select>
                </div>

                {(discountMode === 'percentage' || discountMode === 'both') && (
                  <div>
                    <p className="font-medium text-foreground">{t('maxDiscountPercentage')}</p>
                    <p className="text-sm text-muted-foreground mb-2">{t('maxDiscountPercentageHint')}</p>
                    <div className="flex items-center gap-3">
                      <input type="number" min={1} max={100} value={discountMaxPct}
                        onChange={(e) => setDiscountMaxPct(normalizeDiscountPercentage(e.target.value))}
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
                        onChange={(e) => setDiscountMaxAmount(normalizeDiscountAmount(e.target.value))}
                        className="w-24 px-3 py-1.5 text-sm border border-border rounded-lg outline-none focus:ring-1 focus:ring-brand" />
                      <span className="text-sm text-muted-foreground">{t('zeroNoLimit')}</span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-foreground">{t('requireApproval')}</p>
                    <p className="text-sm text-muted-foreground">{t('requireApprovalHint')}</p>
                  </div>
                  <button
                    onClick={() => setDiscountRequiresApproval(!discountRequiresApproval)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      discountRequiresApproval ? 'bg-brand' : 'bg-gray-200'
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${
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
              <div className={`rounded-xl border p-6 ${cloudAccountAvailable && cloudAccount?.email && !cloudAccount.verified ? 'border-red-200 bg-red-50/40' : 'border-border bg-card'}`}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-foreground">{t('contactEmailTitle')}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{cloudAccountLoadFailed ? t('cloudAccountLoadFailed') : cloudAccountAvailable ? <Ltr>{cloudAccount?.email || user?.email || t('noCloudContactEmail')}</Ltr> : t('cloudAccountUnavailable')}</p>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${!cloudAccountAvailable ? 'bg-muted text-muted-foreground' : cloudAccount?.verified ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
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
                    <label className="flex items-center justify-between gap-4 text-sm"><span>{t('cloudPrefProductUpdates')}</span><Toggle value={Boolean(cloudAccount?.product_updates)} onChange={async (value) => { setCloudAccountBusy(true); try { const { data } = await api.put('/settings/cloud/account/preferences', { product_updates: value }); setCloudAccount(data); } catch { toast.error(t('couldNotSavePreference')); } finally { setCloudAccountBusy(false); } }} /></label>
                    <label className="flex items-center justify-between gap-4 text-sm"><span>{t('cloudPrefMarketing')}</span><Toggle value={Boolean(cloudAccount?.marketing)} onChange={async (value) => { setCloudAccountBusy(true); try { const { data } = await api.put('/settings/cloud/account/preferences', { marketing: value }); setCloudAccount(data); } catch { toast.error(t('couldNotSavePreference')); } finally { setCloudAccountBusy(false); } }} /></label>
                    <p className="text-xs text-muted-foreground">{t('cloudPrefNote')}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Privacy — anonymous telemetry (from the old Integrations tab) + cloud privacy controls (from Account) */}
        <TabsContent value="privacy">
          <div className="pb-6 max-w-3xl space-y-6">
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
                  <div className={`mt-4 rounded-lg border p-3 text-sm ${cloudAccount.deletion_request.status === 'pending' || cloudAccount.deletion_request.status === 'processing' ? 'border-amber-200 bg-amber-50 text-amber-900' : cloudAccount.deletion_request.status === 'approved' || cloudAccount.deletion_request.status === 'completed' || cloudAccount.deletion_request.status === 'deleted' ? 'border-green-200 bg-green-50 text-green-800' : cloudAccount.deletion_request.status === 'failed' ? 'border-red-200 bg-red-50 text-red-800' : 'border-border bg-muted text-foreground'}`}>
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
          </div>
        </TabsContent>

        {/* Printers sub-page */}
        <TabsContent value="receipts-printers">
          <div className="pb-6 max-w-6xl space-y-6">
            <div className="space-y-6">
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Printer size={20} className="text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">{t('printers')}</h2>
                </div>
                {!showPrinterForm && (
                  <div className="flex items-center gap-2">
                    <button onClick={fetchDetectedPrinters} disabled={detectingPrinters}
                      title={t('refreshList')}
                      className="flex items-center gap-2 px-3 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium disabled:opacity-50">
                      <RefreshCw size={14} className={detectingPrinters ? 'animate-spin' : ''} /> {t('refresh')}
                    </button>
                    <button onClick={openAddPrinter}
                      className="flex items-center gap-2 px-4 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium">
                      <Plus size={14} /> {t('addPrinterManually')}
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
                    className="flex w-full items-center justify-between gap-3 border-y border-border py-3 text-start"
                    aria-expanded={installedPrintersOpen}
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('installedOnThisComputer')} ({detectedPrinters.length})
                    </span>
                    <ChevronDown size={16} className={`text-gray-400 transition-transform ${installedPrintersOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {installedPrintersOpen && (detectingPrinters && detectedPrinters.length === 0 ? (
                    <div className="py-6 text-center text-gray-400 text-sm">{t('scanningForPrinters')}</div>
                  ) : detectedPrinters.length === 0 ? (
                    <div className="mt-2 py-6 text-center text-gray-400 text-sm border border-dashed border-border rounded-lg">
                      {t('noInstalledPrinters')}
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {detectedPrinters.map((p) => {
                        const alreadyAdded = hwPrinters.some((h) => h.name.toLowerCase() === p.name.toLowerCase());
                        const isAdding = addingDetectedName === p.name;
                        const dotColor = p.status === 'idle' ? 'bg-green-500' : p.status === 'printing' ? 'bg-yellow-500' : 'bg-gray-300';
                        const statusLabel = p.status === 'idle' ? t('printerOnline') : p.status === 'printing' ? t('printerPrinting') : t('printerOffline');
                        return (
                          <div key={p.name} className="flex items-center gap-3 rounded-xl border border-border p-3">
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-muted shrink-0">
                              {p.connectionType === 'network' ? <Wifi size={18} className="text-muted-foreground" /> : <Usb size={18} className="text-muted-foreground" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-foreground text-sm truncate">{p.name}</span>
                                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                                  {statusLabel}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                {p.make !== 'Unknown' ? `${p.make} ${p.model}` : p.model}
                                {p.connectionType === 'network' && p.ipAddress ? <> · <Ltr>{p.ipAddress}{p.port ? ':' + p.port : ''}</Ltr></> : ''}
                                {p.paperWidth ? ` · ${printWidthLabel(p.paperWidth)}` : ''}
                                {p.profileId ? ` · ${t('printerSupportedProfile')}` : ''}
                              </p>
                            </div>
                            {alreadyAdded ? (
                              <span className="text-xs text-gray-400 px-3 py-1.5 flex items-center gap-1">
                                <CheckCircle2 size={14} className="text-green-500" /> {t('printerAdded')}
                              </span>
                            ) : (
                              <button onClick={() => quickAddDetected(p)} disabled={isAdding}
                                className="px-3 py-1.5 text-xs bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium flex items-center gap-1">
                                <Plus size={13} /> {isAdding ? t('printerAdding') : tCommon('add')}
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
                  <p className="text-sm">{t('noPrintersConfigured')}</p>
                  <p className="text-xs mt-1">{t('printerHint')}</p>
                </div>
              )}

              {hwPrinters.length > 0 && !showPrinterForm && (
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{t('configuredPrinters')}</h3>
              )}
              <div className="space-y-3">
                {hwPrinters.map((p) => (
                  <div key={p.id} className={`flex items-center gap-3 rounded-xl border p-4 ${p.is_default ? 'border-brand bg-brand/5' : 'border-border'}`}>
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-muted shrink-0">
                      {p.connection_type === 'network' ? <Wifi size={18} className="text-muted-foreground" /> :
                       p.connection_type === 'webusb' ? <Usb size={18} className="text-blue-500" /> :
                       <Usb size={18} className="text-muted-foreground" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground text-sm">{p.name}</span>
                        {p.is_default === 1 && (
                          <span className="text-[10px] bg-brand/10 text-brand px-2 py-0.5 rounded-full font-medium">{t('defaultPrinter')}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {p.connection_type === 'network' ? <Ltr>{p.ip_address}:{p.port}</Ltr> :
                         p.connection_type === 'usb' ? t('connectionUsb') :
                         t('browserWebusb')}
                        {' · '}{printWidthLabel(p.paper_width)}
                        {p.profile_name ? ` · ${p.profile_name}` : ''}
                        {p.cash_drawer_pulse_enabled === 1 ? ` · ${t('cashDrawerPulseEnabledShort')}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => testPrinterHw(p)} disabled={testingPrinterId === p.id}
                        title={t('testPrint')}
                        className="p-2 rounded-lg hover:bg-muted text-gray-400 hover:text-foreground disabled:opacity-40">
                        <TestTube2 size={15} />
                      </button>
                      {p.is_default !== 1 && (
                        <button onClick={() => setDefaultPrinter(p.id)} title={t('setAsDefault')}
                          className="p-2 rounded-lg hover:bg-yellow-50 text-gray-400 hover:text-yellow-600">
                          <Star size={15} />
                        </button>
                      )}
                      <button onClick={() => openEditPrinter(p)} title={t('edit')}
                        className="p-2 rounded-lg hover:bg-muted text-gray-400 hover:text-foreground">
                        <Settings size={15} />
                      </button>
                      <button onClick={() => deletePrinterHw(p.id)} title={t('delete')}
                        className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add / Edit form */}
              {showPrinterForm && (
                <div className="mt-5 pt-5 border-t border-border">
                  <h3 className="font-semibold text-foreground text-sm mb-4">
                    {editingPrinterId ? t('editPrinter') : t('addPrinter')}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">{t('printerName')}</label>
                      <input type="text" value={printerForm.name}
                        onChange={(e) => setPrinterForm((p) => ({ ...p, name: e.target.value }))}
                        placeholder={t('printerNamePlaceholder')}
                        list="detected-printer-names"
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                      <datalist id="detected-printer-names">
                        {detectedPrinters.map((dp) => <option key={dp.name} value={dp.name} />)}
                      </datalist>
                      {printerForm.connection_type !== 'webusb' && printerForm.name.trim() && detectedPrinters.length > 0
                        && !detectedPrinters.some((dp) => dp.name === printerForm.name) && (
                        <p className="mt-1 text-xs text-amber-600">{t('printerNameMismatchWarning')}</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">{t('connectionType')}</label>
                      <select value={printerForm.connection_type}
                        onChange={(e) => setPrinterForm((p) => ({ ...p, connection_type: e.target.value as HwPrinter['connection_type'] }))}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand">
                        <option value="network">{t('connectionNetwork')}</option>
                        <option value="usb">{t('connectionUsb')}</option>
                        <option value="webusb">{t('connectionWebusb')}</option>
                      </select>
                    </div>

                    {printerForm.connection_type === 'network' && (<>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">{t('ipAddress')}</label>
                        <input type="text" value={printerForm.ip_address}
                          onChange={(e) => setPrinterForm((p) => ({ ...p, ip_address: e.target.value }))}
                          placeholder={t('ipAddressPlaceholder')}
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" dir="ltr" />
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">{t('port')}</label>
                        <input type="number" value={printerForm.port}
                          onChange={(e) => setPrinterForm((p) => ({ ...p, port: e.target.value }))}
                          placeholder={t('portPlaceholder')}
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
                      </div>
                    </>)}

                    {printerForm.connection_type === 'webusb' && (
                      <div className="md:col-span-2 bg-blue-50 rounded-lg p-3 text-sm text-blue-700">
                        {t('webusbHint')}
                      </div>
                    )}

                    <div>
                      <label className="block text-xs text-muted-foreground mb-1">{t('paperWidth')}</label>
                      <select value={printerForm.paper_width}
                        onChange={(e) => setPrinterForm((p) => ({ ...p, paper_width: e.target.value }))}
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand">
                        <option value="cols-32">{t('printColumns32')}</option>
                        <option value="cols-36">{t('printColumns36')}</option>
                        <option value="cols-40">{t('printColumns40')}</option>
                        <option value="cols-42">{t('printColumns42')}</option>
                        <option value="cols-44">{t('printColumns44')}</option>
                        <option value="cols-48">{t('printColumns48')}</option>
                      </select>
                    </div>
                    <div className="md:col-span-2 flex items-center justify-between gap-4 rounded-lg border border-border p-3">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground text-sm">{t('cashDrawerPulse')}</p>
                        <p className="text-xs text-muted-foreground">{t('cashDrawerPulseHint')}</p>
                      </div>
                      <Toggle value={printerForm.cash_drawer_pulse_enabled} onChange={(v) => setPrinterForm((p) => ({ ...p, cash_drawer_pulse_enabled: v }))} />
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <button onClick={savePrinterHw} disabled={savingPrinter}
                      className="px-5 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium">
                      {savingPrinter ? t('saving') : editingPrinterId ? tCommon('update') : t('addPrinter')}
                    </button>
                    <button onClick={() => setShowPrinterForm(false)}
                      className="px-5 py-2 text-sm border border-border text-muted-foreground rounded-lg hover:bg-muted font-medium">
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              <strong>{t('defaultPrinterTipTitle')}</strong> {t('defaultPrinterTipBody')}
            </div>

            {/* Print Options — merged into the same Printers page rather than a separate tab */}
            <div className="pt-4 border-t border-border">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400">{t('tabPrinting')}</h2>
            </div>

            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Printer size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('printing')}</h2>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('enablePrinter')}</p>
                    <p className="text-sm text-muted-foreground">{t('enablePrinterHint')}</p>
                  </div>
                  <Toggle value={printingForm.printerEnabled} onChange={(v) => setPrintingForm((p) => ({ ...p, printerEnabled: v }))} />
                </div>
                <div>
                  <p className="font-medium text-foreground mb-2">{t('paperSize')}</p>
                  <select value={printingForm.printerPaperSize}
                    onChange={(e) => setPrintingForm((p) => ({ ...p, printerPaperSize: e.target.value as PaperSize }))}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand">
                    {paperSizeOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <p className="font-medium text-foreground mb-2">{t('printMethod')}</p>
                  <select value={printingForm.printMethod}
                    onChange={(e) => setPrintingForm((p) => ({ ...p, printMethod: e.target.value as 'escpos' | 'browser' }))}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand">
                    <option value="escpos">{t('printMethodEscpos')}</option>
                    <option value="browser">{t('printMethodBrowser')}</option>
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {printingForm.printMethod === 'escpos'
                      ? t('printMethodEscposHint')
                      : t('printMethodBrowserHint')}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('kotPrintingEnabledToggle')}</p>
                    <p className="text-sm text-muted-foreground">{t('kotPrintingEnabledToggleHint')}</p>
                  </div>
                  <Toggle value={kotPrintingEnabledSetting} onChange={(v) => { if (!savingKotPrintingEnabled) saveKotPrintingEnabled(v); }} />
                </div>
                <div className={`flex items-center justify-between gap-4 ${!kotPrintingEnabledSetting ? 'opacity-50' : ''}`}>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('autoPrintKot')}</p>
                    <p className="text-sm text-muted-foreground">
                      {kotPrintingEnabledSetting
                        ? t('autoPrintKotHint')
                        : t('autoPrintKotDisabledHint')}
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
                      {t('kitchenWorkflowBothOffNote')}
                    </p>
                  </div>
                )}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('autoPrintBill')}</p>
                    <p className="text-sm text-muted-foreground">{t('autoPrintBillHint')}</p>
                  </div>
                  <Toggle value={printingForm.autoPrintBill} onChange={(v) => setPrintingForm((p) => ({ ...p, autoPrintBill: v }))} />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('printerUnicode')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('printerUnicodeHint')}
                    </p>
                  </div>
                  <Toggle value={printingForm.printerUseUnicode} onChange={(v) => setPrintingForm((p) => ({ ...p, printerUseUnicode: v }))} />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('printerArabicShaping')}</p>
                    <p className="text-sm text-muted-foreground">{t('printerArabicShapingHint')}</p>
                  </div>
                  <Toggle value={printingForm.printerArabicShaping} onChange={(v) => setPrintingForm((p) => ({ ...p, printerArabicShaping: v }))} />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground">{t('trimDecimals')}</p>
                    <p className="text-sm text-muted-foreground">{t('trimDecimalsHint')}</p>
                  </div>
                  <Toggle value={printingForm.printerTrimDecimals} onChange={(v) => setPrintingForm((p) => ({ ...p, printerTrimDecimals: v }))} />
                </div>
                <div className="pt-4 border-t border-border">
                  <p className="font-medium text-foreground mb-1">{t('receiptLanguage')}</p>
                  <p className="text-sm text-muted-foreground mb-3">{t('receiptLanguageHint')}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                    <div>
                      <label htmlFor="receipt-primary-language" className="block text-sm font-medium text-foreground mb-1">{t('receiptLanguage')}</label>
                      <select
                        id="receipt-primary-language"
                        value={printingForm.receiptPrimaryLanguage}
                        onChange={(e) => setPrintingForm((p) => ({ ...p, receiptPrimaryLanguage: e.target.value }))}
                        className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                      >
                        <option value="inherit">{t('sameAsStore')}</option>
                        {SELECTABLE_LANGUAGES.map((lang) => (
                          <option key={lang} value={lang}>{LANGUAGES[lang].nativeName}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="receipt-second-language" className="block text-sm font-medium text-foreground mb-1">{t('secondReceiptLanguage')}</label>
                      <select
                        id="receipt-second-language"
                        value={printingForm.receiptSecondLanguage}
                        onChange={(e) => setPrintingForm((p) => ({ ...p, receiptSecondLanguage: e.target.value }))}
                        className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                      >
                        <option value="none">{t('secondLanguageNone')}</option>
                        {SELECTABLE_LANGUAGES.map((lang) => (
                          <option key={lang} value={lang}>{LANGUAGES[lang].nativeName}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="kot-language" className="block text-sm font-medium text-foreground mb-1">{t('kotPrintLanguage')}</label>
                      <select
                        id="kot-language"
                        value={printingForm.kotLanguage}
                        onChange={(e) => setPrintingForm((p) => ({ ...p, kotLanguage: e.target.value }))}
                        className="block w-full rounded-md border-border shadow-sm focus:border-brand focus:ring-brand sm:text-sm px-3 py-2 border"
                      >
                        <option value="inherit">{t('sameAsStore')}</option>
                        {SELECTABLE_LANGUAGES.map((lang) => (
                          <option key={lang} value={lang}>{LANGUAGES[lang].nativeName}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">{t('kotPrintLanguageHint')}</p>
                </div>
                <div className="pt-4 border-t border-border">
                  <p className="font-medium text-foreground mb-1">{t('billContent')}</p>
                  <p className="text-sm text-muted-foreground mb-3">{t('billContentHint')}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
                    {([
                      { label: t('showRestaurantName'), key: 'billShowName' as const },
                      { label: t('showRestaurantAddress'), key: 'billShowAddress' as const },
                      { label: t('showRestaurantPhone'), key: 'billShowPhone' as const },
                      { label: t('showTaxId'), key: 'billShowTaxId' as const },
                      { label: t('showTaxBreakdown'), key: 'billShowTaxBreakdown' as const },
                      { label: t('showCustomerName'), key: 'billShowCustomerName' as const },
                      { label: t('showCustomerPhone'), key: 'billShowCustomerPhone' as const },
                      { label: t('showTableNumber'), key: 'billShowTableNumber' as const },
                    ] as const).map((item) => (
                      <div key={item.key} className="flex min-h-11 items-center justify-between gap-3 py-1">
                        <span className="text-sm text-foreground">{item.label}</span>
                        <Toggle
                          value={printingForm[item.key]}
                          onChange={(value) => setPrintingForm((previous) => ({ ...previous, [item.key]: value }))}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 border-t border-border pt-4">
                    <label htmlFor="footer-message" className="block text-sm font-medium text-foreground mb-1">{t('footerMessage')}</label>
                    <textarea id="footer-message" rows={2}
                      placeholder={t('footerMessagePlaceholder')}
                      value={billForm.billFooterMessage}
                      onChange={(e) => setBillForm((p) => ({ ...p, billFooterMessage: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand resize-none" />
                    <p className="text-xs text-gray-400 mt-1">{t('footerMessageHint')}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <Share2 size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('whatsappSharing')}</h2>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-foreground">{t('enableWhatsappShare')}</p>
                  <p className="text-sm text-muted-foreground">{t('enableWhatsappShareHint')}</p>
                </div>
                <Toggle value={printingForm.whatsappShareEnabled} onChange={(v) => setPrintingForm((p) => ({ ...p, whatsappShareEnabled: v }))} />
              </div>
            </div>
          </div>

            <div className="space-y-6">
            <div className="bg-card rounded-xl border border-border p-6">
              <div className="flex items-center gap-2 mb-4">
                <FileText size={20} className="text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t('billTemplate')}</h2>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {billTemplateCards.map((card) => {
                  const isSelected = isTemplateCardSelected(billForm, card);
                  return (
                    <button key={card.id} onClick={() => setBillForm((p) => ({ ...p, billTemplate: card.id, billTemplateSource: card.selectionSource }))}
                      className={`text-start rounded-xl border-2 p-4 transition-all ${
                        isSelected ? 'border-brand bg-brand/5' : 'border-border hover:border-gray-300 dark:border-border bg-card'
                      }`}>
                      <p className="font-semibold text-foreground mb-2 flex items-center gap-2">
                        <span className="flex-1">{card.nameKey ? t(card.nameKey) : card.displayName}</span>
                        {card.source === 'merchant' && card.originBadgeKey && (
                          <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand">
                            {t(card.originBadgeKey)}
                          </span>
                        )}
                      </p>
                      <pre className="font-mono text-[9px] leading-tight text-muted-foreground bg-muted p-2 rounded overflow-hidden mb-3 whitespace-pre">
                        {card.preview}
                      </pre>
                      <p className="text-xs text-muted-foreground">
                        {card.source === 'plugin' || card.source === 'merchant'
                          ? card.description
                          : card.id === 'classic'
                            ? t('billTemplateClassicDesc')
                            : t('billTemplateCompactDesc')}
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
            <h2 className="text-lg font-semibold text-foreground">{t('tabBackupData')}</h2>
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
                  onClick={handleCreateBackup}
                  className="px-5 py-2 text-sm bg-gray-600 text-white rounded-lg hover:opacity-90 font-medium"
                >
                  {t('createBackup')}
                </button>
                <button
                  onClick={handleChooseBackupLocation}
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
                  onClick={fetchBackups}
                  disabled={backupsLoading}
                  className="p-1.5 text-gray-400 hover:text-muted-foreground rounded-lg hover:bg-muted disabled:opacity-50"
                  title={t('refresh')}
                >
                  <RefreshCw size={16} className={backupsLoading ? 'animate-spin' : ''} />
                </button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                {t('backupHistoryHint')}
              </p>
              {backups.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">
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
                          {googleDriveStatus.last_backup_filename === backup.fileName && (
                            <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">
                              <HardDrive size={11} />
                              {t('googleDriveUploadedBadge')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 truncate">
                          {formatBackupSize(backup.sizeBytes)}
                          {backup.schemaVersion != null && ` · ${t('backupSchemaVersion', { version: backup.schemaVersion })}`}
                        </p>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <button
                          onClick={() => handleRestoreFromHistory(backup)}
                          className="px-3 py-1.5 text-xs bg-muted text-foreground rounded-lg hover:bg-muted font-medium"
                        >
                          {t('restoreBackup')}
                        </button>
                        <button
                          onClick={() => handleDeleteBackup(backup)}
                          className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50"
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

            {/* Google Drive — automated off-device backups (#129) */}
            <div className="bg-card rounded-xl border border-border p-6 space-y-4">
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
                    <HardDrive className="w-6 h-6 text-gray-400" />
                  </div>
                  <p className="text-sm font-medium text-foreground">{t('googleDriveNotConfigured')}</p>
                  <p className="text-xs text-muted-foreground max-w-sm">{t('googleDriveNotConfiguredHint')}</p>
                </div>
              ) : !googleDriveStatus.secure_storage_available ? (
                <div className="flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-4 py-3">
                  <AlertTriangle size={16} className="text-amber-600 shrink-0" />
                  <p className="text-sm text-amber-800">{t('googleDriveSecureStorageUnavailable')}</p>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-border px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2">
                      {googleDriveStatus.connected ? (
                        <CheckCircle2 size={16} className="text-green-600 shrink-0" />
                      ) : (
                        <CloudOff size={16} className="text-gray-400 shrink-0" />
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
                      googleDriveStatus.connected ? (
                        <button
                          onClick={disconnectGoogleDrive}
                          disabled={disconnectingGoogleDrive}
                          className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 font-medium shrink-0"
                        >
                          {disconnectingGoogleDrive ? t('googleDriveDisconnecting') : t('googleDriveDisconnect')}
                        </button>
                      ) : (
                        <button
                          onClick={connectGoogleDrive}
                          disabled={connectingGoogleDrive}
                          className="px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium shrink-0"
                        >
                          {connectingGoogleDrive ? t('googleDriveConnecting') : t('googleDriveConnect')}
                        </button>
                      )
                    )}
                  </div>

                  {googleDriveStatus.connected && (
                    <>
                      <div className="grid sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-foreground mb-1">{t('googleDriveFrequency')}</label>
                          <select
                            value={googleDriveStatus.frequency}
                            disabled={savingGoogleDrivePrefs}
                            onChange={(e) => updateGoogleDrivePrefs({ frequency: e.target.value as 'daily' | 'weekly' })}
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
                              if (Number.isInteger(n) && n >= 1 && n <= 100) updateGoogleDrivePrefs({ retention_count: n });
                            }}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-border rounded-lg text-sm focus:ring-2 focus:ring-brand outline-none disabled:opacity-50"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">{t('googleDriveRetentionHint')}</p>

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
                            onClick={backupToGoogleDriveNow}
                            disabled={backingUpGoogleDrive}
                            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-600 text-white rounded-lg hover:opacity-90 disabled:opacity-50 font-medium shrink-0"
                          >
                            <UploadCloud size={15} />
                            {backingUpGoogleDrive ? t('googleDriveBackingUp') : t('googleDriveBackupNow')}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

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
                      const data = JSON.parse(event.target?.result as string);
                      if (!data.app || data.app !== 'FloDesktop') {
                        toast.error(t('invalidExportFile'));
                        return;
                      }

                      const overwrite = await confirm(t('importOverwriteConfirm'), { confirmLabel: t('replaceAll') });

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
                          toast.error(t('masterPinRequiredForReplace'));
                          return;
                        }
                        setPinGate({ mode: 'import', payload: { data, overwrite } });
                        return;
                      }

                      await runImport(data, overwrite);
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
                onClick={runHealthCheck}
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
                    onClick={() => setPinGate({ mode: 'set' })}
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
                onClick={() => setInitializeDbOpen(true)}
                className="px-5 py-2 text-sm bg-red-600 text-white rounded-lg hover:opacity-90 font-medium"
              >
                {t('initializeDatabaseButton')}
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
          </div>
        </TabsContent>

        <TabsContent value="mobile-access">
          <div className="pb-6 max-w-3xl space-y-6">
            <div className="space-y-6">
            <h2 className="text-lg font-semibold text-foreground">{t('tabMobileAccess')}</h2>

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
                    <CloudOff size={16} className="text-gray-400 shrink-0" />
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
                    onChange={(e) => setCloudSettings({ ...cloudSettings, cloud_sync_enabled: e.target.checked })}
                    className="mt-0.5 rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
                  />
                  <div>
                    <span className="text-sm font-medium text-foreground block">{cloudServicesStopped ? t('cloudEnableButton') : t('enableBillSync')}</span>
                    <p className="text-xs text-muted-foreground mt-1">{cloudServicesStopped ? t('cloudResumeHintStopped') : t('enableBillSyncHint')}</p>
                  </div>
                </label>

                    {cloudSettings.cloud_last_sync && (
                      <p className="text-xs text-gray-400">{t('lastSync', { time: formatDateTime(cloudSettings.cloud_last_sync) })}</p>
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
                      <div className="w-28 h-28 rounded-lg border border-border flex items-center justify-center text-gray-400">
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
                      <p className="text-xs text-gray-400">
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
                    <p className="text-sm text-gray-400">{t('loading')}</p>
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
                            <span className="text-xs text-gray-400">
                              {t('lastActive', { date: formatDate(d.last_seen_at) })}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('firstPaired', { date: formatDate(d.first_seen_at) })}
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
            <h2 className="text-lg font-semibold text-foreground">{t('tabOrderflow')}</h2>

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
                  onChange={(e) => setCloudSettings({ ...cloudSettings, cloud_orders_enabled: e.target.checked })}
                  className="rounded border-gray-300 dark:border-border text-brand focus:ring-brand"
                />
                <span className="text-sm text-foreground">{t('enableOnlineOrderPolling')}</span>
              </label>

            </div>
            </div>
          </div>
        </TabsContent>

        {/* About tab */}
        <TabsContent value="about">
          <div className="pb-6 max-w-3xl space-y-6">
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
                          <div className="w-32 h-32 rounded-lg border border-border flex items-center justify-center text-gray-400">
                            <QrCode size={36} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-foreground">{app.name}</h3>
                          {!app.available && (
                            <span className="text-xs font-medium text-gray-400 bg-muted px-2 py-0.5 rounded-full">{t('comingSoon')}</span>
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
                    <p className="text-sm text-gray-400 text-center py-10">{t('noAppsToShow')}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Software Updates tab */}
        <TabsContent value="updates">
          <div className="pb-6 max-w-3xl space-y-6">
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
                  ? 'bg-green-50 border border-green-200'
                  : updateStatus.status === 'up-to-date'
                  ? 'bg-green-50 border border-green-200'
                  : updateStatus.status === 'check-failed'
                  ? 'bg-red-50 border border-red-200'
                  : updateStatus.status === 'offline' || updateStatus.status === 'dev-mode'
                  ? 'bg-yellow-50 border border-yellow-200'
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
                    <div className="w-full bg-gray-200 rounded-full h-2">
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
                  <p className="text-sm text-yellow-700">{t('devModeDisabled')}</p>
                )}
                {(updateStatus.status === 'check-failed' || updateStatus.status === 'offline') && (
                  <p className="text-sm mt-1 text-red-600">
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
          </div>
        </TabsContent>

</div>
</Tabs>
      {ConfirmDialog}

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
              <button onClick={resetAllSettings} disabled={savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering} className="px-4 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded-full transition-colors disabled:opacity-50 text-white">{t('discard')}</button>
              <button onClick={saveAllSettings} disabled={savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering} className="px-4 py-1.5 text-sm bg-brand hover:opacity-90 rounded-full font-medium transition-colors disabled:opacity-50 text-white">{(savingBusiness || savingLoyalty || savingDiscount || savingCloud || savingOrderNumbering) ? t('saving') : t('saveChanges')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
