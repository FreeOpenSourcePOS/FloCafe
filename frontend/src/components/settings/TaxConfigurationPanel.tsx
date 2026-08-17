'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ltr } from '@/components/layout/Ltr';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  History,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useI18n } from '@/hooks/useI18n';
import { apiErrorText } from '@/lib/api-error';

type PackSummary = {
  id: string;
  publisher: string;
  country: string;
  jurisdiction: string;
  active_version_id: string | null;
  status: string;
  active_for_store: boolean;
  trust_status: string;
  override_count: number;
  versions: PackVersion[];
};

type PackVersion = {
  id: string;
  version: string;
  schema_version: number;
  effective_from: string;
  effective_to: string | null;
  published_at: string;
  status: string;
};

type TaxCategory = {
  category_id: string;
  label: string;
  default_behavior: string;
  definition: { description?: string; ruleIds?: string[] };
};

type TaxRule = {
  rule_id: string;
  label: string;
  calculation_type: string;
  rate: string | null;
  amount: string | null;
  applies_per: string;
  base_rule_ids: string[];
  definition: { categoryIds?: string[] };
};

type TaxOverride = {
  id: string;
  entity_type: OverrideEntityType;
  entity_id: string | null;
  entity_name: string | null;
  value: { categoryId: string };
  created_by_name: string | null;
  updated_at: string;
};

type OverrideEntityType = 'product' | 'addon' | 'packaging' | 'delivery' | 'service_charge';

type OverrideTarget = {
  id: string;
  name: string;
  tax_category_id: string | null;
};

type PackDetail = {
  pack: PackSummary;
  versions: PackVersion[];
  active_version: (PackVersion & {
    definition: {
      currency: string;
      taxRounding: { method: string; scope: string; decimalPlaces: number };
      payableRounding: { method: string; increment: string };
    };
    validation: {
      valid: boolean;
      checks: Array<{ id: number; passed: boolean; message: string }>;
    };
  }) | null;
  categories: TaxCategory[];
  rules: TaxRule[];
  overrides: TaxOverride[];
  targets: { products: OverrideTarget[]; addons: OverrideTarget[] };
};

type TaxPackUpdate = {
  // The catalog's current id — pass this to catalog/install.
  packId: string;
  // The id actually installed for this store (may predate a catalog rename).
  installedPackId: string;
  country: string;
  publisher: string;
  currentVersion: string;
  latestVersion: string;
  entry: { version: string; publishedAt: string; minFloVersion: string };
};

type AuditRow = {
  id: number;
  action: string;
  actor_name: string | null;
  actor_user_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type Calculation = {
  taxableBase: string;
  taxAmount: string;
  payableTotal: string;
  lines: Array<{
    components: Array<{ ruleId: string; label: string; amount: string; rate?: string }>;
  }>;
};

// Manual tax builder — a category is just a bucket of named rate components
// (e.g. "Standard" -> Tax 1 2.5% + Tax 2 2.5%) that all apply together. See
// buildManualPack in main/routes/tax-packs.ts for the server-side mirror.
type ManualComponent = { key: string; label: string; type: 'percent' | 'fixed'; value: string };
type ManualCategory = { tempId: string; label: string; components: ManualComponent[] };
// No "addon" default: an add-on is always taxed as part of its parent item's
// subtotal (see calculateItemTax in main/services/tax.ts), never its own line.
type ManualDefaults = { product: string; packaging: string; delivery: string; service_charge: string };
type ManualPackDefinition = {
  inclusivePricingDefault: boolean;
  unclassifiedCategoryId: string;
  defaultCategories: ManualDefaults;
  categories: Array<{ id: string; label: string; ruleIds: string[] }>;
  rules: Array<{ id: string; label: string; type: 'percent' | 'fixed'; rate?: string; amount?: string }>;
};

let manualIdCounter = 0;
function manualId(prefix: string): string {
  manualIdCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${manualIdCounter}`;
}
function newManualComponent(): ManualComponent {
  return { key: manualId('component'), label: '', type: 'percent', value: '0' };
}
function newManualCategory(label: string): ManualCategory {
  return { tempId: manualId('category'), label, components: [newManualComponent()] };
}

const ENTITY_LABELS: Record<OverrideEntityType, string> = {
  product: 'tax.entityProduct',
  addon: 'tax.entityAddon',
  packaging: 'tax.entityPackaging',
  delivery: 'tax.entityDelivery',
  service_charge: 'tax.entityServiceCharge',
};

const pluginRequestSettingKey = (country: string) => `tax_plugin_request:${country}`;

async function loadPluginRequestId(country: string): Promise<string | null> {
  try {
    // The bulk settings list never 404s for a key that hasn't been written
    // yet (unlike GET /settings/:key), so a store that has never filed a
    // plugin request doesn't spam the console with an expected-but-noisy 404.
    const response = await api.get('/settings');
    return response.data?.settings?.[pluginRequestSettingKey(country)] || null;
  } catch {
    return null;
  }
}
const CHARGE_TYPES: OverrideEntityType[] = ['packaging', 'delivery', 'service_charge'];

const ACTION_LABELS: Record<string, string> = {
  install_bundled_pack: 'tax.actionInstallBundled',
  install_downloaded_pack: 'tax.actionInstallDownloaded',
  activate_pack: 'tax.actionActivate',
  rollback_pack: 'tax.actionRollback',
  create_override: 'tax.actionCreateOverride',
  update_override: 'tax.actionUpdateOverride',
  reset_override: 'tax.actionResetOverride',
};

function apiMessage(error: unknown, fallback: string, t: Translate): string {
  return apiErrorText(error, fallback, t);
}

function taxModeSegmentClass(active: boolean): string {
  return `px-3 py-1.5 text-sm font-medium rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
    active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
  }`;
}

function categoryIdOf(override: TaxOverride): string {
  return override.value?.categoryId || '';
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function entityTypeLabel(t: Translate, entityType: unknown): string {
  if (typeof entityType === 'string' && entityType in ENTITY_LABELS) {
    return t(ENTITY_LABELS[entityType as OverrideEntityType]);
  }
  return t('tax.target');
}

function auditDescription(row: AuditRow, t: Translate): string {
  const details = row.details || {};
  if (row.action === 'install_bundled_pack') return t('tax.auditInstallBundled', { version: String(details.version || '') });
  if (row.action === 'install_downloaded_pack') return t('tax.auditInstallDownloaded', { version: String(details.version || '') });
  if (row.action === 'create_override') {
    return t('tax.auditCreateOverride', {
      entityType: entityTypeLabel(t, details.entityType),
      entityId: String(details.entityId || t('tax.storeWide')),
      categoryId: String(details.categoryId || ''),
    });
  }
  if (row.action === 'update_override') {
    const before = (details.before || {}) as Record<string, unknown>;
    const after = (details.after || {}) as Record<string, unknown>;
    return t('tax.auditUpdateOverride', {
      entityType: entityTypeLabel(t, after.entityType || before.entityType),
      entityId: String(after.entityId || before.entityId || t('tax.storeWide')),
      before: String(before.categoryId || ''),
      after: String(after.categoryId || ''),
    });
  }
  if (row.action === 'reset_override') {
    return t('tax.auditResetOverride', {
      entityType: entityTypeLabel(t, details.entityType),
      entityId: String(details.entityId || t('tax.storeWide')),
    });
  }
  if (row.action === 'activate_pack') return t('tax.auditActivatePack', { previousVersionId: String(details.previousVersionId || 'none') });
  if (row.action === 'rollback_pack') return t('tax.auditRollbackPack', { previousVersionId: String(details.previousVersionId || 'unknown') });
  return '';
}

export function TaxConfigurationPanel({ isOwner }: { isOwner: boolean }) {
  const { formatDateTime } = useFormatDate();
  const { t } = useI18n();
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [storeCountry, setStoreCountry] = useState('');
  const [selectedPackId, setSelectedPackId] = useState('');
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedChecklist, setExpandedChecklist] = useState(false);
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null);
  const [entityType, setEntityType] = useState<OverrideEntityType>('product');
  const [entityId, setEntityId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [testCategoryId, setTestCategoryId] = useState('');
  const [testAmount, setTestAmount] = useState('100');
  const [testBehavior, setTestBehavior] = useState('country_default');
  const [calculation, setCalculation] = useState<Calculation | null>(null);
  const [enablingTaxes, setEnablingTaxes] = useState(false);
  const [countryPackUnavailable, setCountryPackUnavailable] = useState(false);
  const [taxesEnabled, setTaxesEnabled] = useState(false);
  const [pluginRequested, setPluginRequested] = useState(false);
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [packUpdate, setPackUpdate] = useState<TaxPackUpdate | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [reinstallingPlugin, setReinstallingPlugin] = useState(false);

  const [manualStarter] = useState(() => {
    const category = newManualCategory('Standard');
    const id = category.tempId;
    return { category, defaults: { product: id, packaging: id, delivery: id, service_charge: id } };
  });
  const [manualCategories, setManualCategories] = useState<ManualCategory[]>([manualStarter.category]);
  const [manualInclusive, setManualInclusive] = useState(false);
  const [manualDefaults, setManualDefaults] = useState<ManualDefaults>(manualStarter.defaults);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualLoaded, setManualLoaded] = useState(false);
  const [manualOverrideConfirm, setManualOverrideConfirm] = useState<string | null>(null);
  const [manualBuilderOpen, setManualBuilderOpen] = useState(false);
  // null = not yet checked (or offline) — stays clickable rather than
  // wrongly disabling the option when we simply don't know yet.
  const [officialPackAvailable, setOfficialPackAvailable] = useState<boolean | null>(null);

  const applyManualDefinition = useCallback(async (country: string) => {
    const response = await api.get(`/tax-packs/manual-${country.toLowerCase()}`);
    const definition = response.data?.active_version?.definition as ManualPackDefinition | undefined;
    if (!definition || !Array.isArray(definition.categories)) return;
    const nextCategories: ManualCategory[] = definition.categories
      .filter((category) => category.id !== definition.unclassifiedCategoryId)
      .map((category) => ({
        tempId: category.id,
        label: category.label,
        components: (category.ruleIds.length > 0 ? category.ruleIds : [null]).map((ruleId) => {
          const rule = ruleId ? definition.rules.find((candidate) => candidate.id === ruleId) : undefined;
          return {
            key: ruleId || manualId('component'),
            label: rule?.label || '',
            type: (rule?.type === 'fixed' ? 'fixed' : 'percent') as 'percent' | 'fixed',
            value: rule ? (rule.type === 'fixed' ? (rule.amount || '0') : (rule.rate || '0')) : '0',
          };
        }),
      }));
    if (nextCategories.length === 0) return;
    setManualCategories(nextCategories);
    setManualInclusive(Boolean(definition.inclusivePricingDefault));
    setManualDefaults({
      product: definition.defaultCategories.product,
      packaging: definition.defaultCategories.packaging,
      delivery: definition.defaultCategories.delivery,
      service_charge: definition.defaultCategories.service_charge,
    });
    setManualLoaded(true);
  }, []);

  const loadManualDetail = useCallback(async (country: string, knownPacks: PackSummary[]) => {
    if (!country) return;
    // Only fetch if a manual-<country> pack row actually exists — otherwise
    // this always 404s on a store that has never saved one (normal, but
    // noisy in the console for no reason).
    const packId = `manual-${country.toLowerCase()}`;
    if (!knownPacks.some((pack) => pack.id === packId)) return;
    try {
      await applyManualDefinition(country);
    } catch {
      // No manual pack saved yet for this country — the blank starter template stays.
    }
  }, [applyManualDefinition]);

  const loadList = useCallback(async () => {
    const [response, settingResponse] = await Promise.all([
      api.get('/tax-packs'),
      api.get('/settings/taxes_enabled'),
    ]);
    const nextPacks = response.data.packs as PackSummary[];
    setPacks(nextPacks);
    setStoreCountry(response.data.store_country);
    const requestId = await loadPluginRequestId(response.data.store_country);
    setPluginRequested(Boolean(requestId));
    setCountryPackUnavailable(Boolean(requestId));
    setTaxesEnabled(settingResponse.data.setting?.value === 'true');
    setSelectedPackId((current) => {
      if (current && nextPacks.some((pack) => pack.id === current)) return current;
      return nextPacks.find((pack) => pack.active_for_store)?.id || nextPacks[0]?.id || '';
    });
  }, []);

  const loadDetail = useCallback(async (packId: string) => {
    if (!packId) {
      setDetail(null);
      return;
    }
    const response = await api.get(`/tax-packs/${encodeURIComponent(packId)}`);
    const nextDetail = response.data as PackDetail;
    setDetail(nextDetail);
    setCategoryId((current) => current || nextDetail.categories[0]?.category_id || '');
    setTestCategoryId((current) => current || nextDetail.categories[0]?.category_id || '');
  }, []);

  const loadAudit = useCallback(async () => {
    const response = await api.get('/tax-packs/audit?limit=100');
    setAudit(response.data.audit);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([
        loadList(),
        loadAudit(),
        ...(selectedPackId ? [loadDetail(selectedPackId)] : []),
      ]);
    } catch (error) {
      toast.error(apiMessage(error, t('tax.loadFailed'), t));
    } finally {
      setLoading(false);
    }
  }, [loadAudit, loadDetail, loadList, selectedPackId, t]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.get('/tax-packs'), api.get('/tax-packs/audit?limit=100')])
      .then(async ([packResponse, auditResponse]) => {
        if (cancelled) return;
        const nextPacks = packResponse.data.packs as PackSummary[];
        setPacks(nextPacks);
        setStoreCountry(packResponse.data.store_country);
        const requestId = await loadPluginRequestId(packResponse.data.store_country);
        if (cancelled) return;
        setPluginRequested(Boolean(requestId));
        setCountryPackUnavailable(Boolean(requestId));
        void api.get('/settings/taxes_enabled').then((settingResponse) => {
          setTaxesEnabled(settingResponse.data.setting?.value === 'true');
        }).catch(() => {});
        setSelectedPackId(
          nextPacks.find((pack) => pack.active_for_store)?.id || nextPacks[0]?.id || '',
        );
        setAudit(auditResponse.data.audit);
        if (packResponse.data.store_country) void loadManualDetail(packResponse.data.store_country, nextPacks);
      })
      .catch((error) => {
        if (!cancelled) toast.error(apiMessage(error, t('tax.loadFailed'), t));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadManualDetail, t]);

  // Best-effort only: greys out "Official Tax Pack" when we're confident no
  // plugin exists for this country. An already-installed pack (even inactive)
  // answers this without a network call; otherwise we ask the catalog once.
  // A failed/offline catalog check leaves it `null` (unknown) rather than
  // wrongly disabled — FloCafe must keep working without internet access.
  const officialPackInstalled = useMemo(
    () => packs.some((pack) => pack.country === storeCountry && pack.publisher !== 'local'),
    [packs, storeCountry],
  );
  useEffect(() => {
    if (!storeCountry || officialPackInstalled) return;
    let cancelled = false;
    api.get('/tax-packs/catalog')
      .then((response) => {
        if (cancelled) return;
        const available = (response.data?.available || []) as Array<{ country: string }>;
        setOfficialPackAvailable(available.some((entry) => entry.country === storeCountry));
      })
      .catch(() => { if (!cancelled) setOfficialPackAvailable(null); });
    return () => { cancelled = true; };
  }, [storeCountry, officialPackInstalled]);
  const officialPackAvailableResolved = officialPackInstalled ? true : officialPackAvailable;

  useEffect(() => {
    if (!selectedPackId) return;
    let cancelled = false;
    void api.get(`/tax-packs/${encodeURIComponent(selectedPackId)}`)
      .then((response) => {
        if (cancelled) return;
        const nextDetail = response.data as PackDetail;
        setDetail(nextDetail);
        setCategoryId(nextDetail.categories[0]?.category_id || '');
        setTestCategoryId(nextDetail.categories[0]?.category_id || '');
        setCalculation(null);
      })
      .catch((error) => {
        if (!cancelled) toast.error(apiMessage(error, t('tax.loadPackDetailsFailed'), t));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedPackId, t]);

  const selectedPack = packs.find((pack) => pack.id === selectedPackId);
  const activePackPublisher = packs.find((pack) => pack.active_for_store)?.publisher;
  // Reflects the real, saved backend state — only changes once something is
  // actually activated (enableCountryTaxes / saveManualConfig / turnTaxesOff).
  const taxMode: 'off' | 'official' | 'manual' = !taxesEnabled ? 'off' : activePackPublisher === 'local' ? 'manual' : 'official';
  const manualBuilderVisible = manualBuilderOpen || taxMode === 'manual';
  // Only meaningful while an official (non-local) pack is active — gate at
  // render time rather than resetting packUpdate from an effect, so a stale
  // result from a previously active pack never leaks into a different mode.
  const pluginUpdateApplicable = taxMode === 'official' && detail?.pack.publisher !== 'local';
  const activePluginUpdate = pluginUpdateApplicable ? packUpdate : null;
  // The segment control's *displayed* selection: opening the manual editor
  // is its own state even before anything is saved, so it must outrank
  // taxMode here — otherwise "Turn Off Tax" (or "Official") stays lit at the
  // same time purely because the backend hasn't changed yet, which reads as
  // two segments active at once.
  const activeSegment: 'off' | 'official' | 'manual' = manualBuilderOpen ? 'manual' : taxMode;
  const targetOptions = entityType === 'product'
    ? detail?.targets.products || []
    : entityType === 'addon'
      ? detail?.targets.addons || []
      : [];
  const needsEntity = entityType === 'product' || entityType === 'addon';
  const categoriesById = useMemo(
    () => new Map((detail?.categories || []).map((category) => [category.category_id, category.label])),
    [detail?.categories],
  );

  async function checkForPluginUpdates(announce: boolean) {
    const packId = detail?.pack.id;
    if (!pluginUpdateApplicable || !packId) {
      if (announce) toast.error(t('tax.noPluginToCheck'));
      return;
    }
    setCheckingUpdate(true);
    try {
      const response = await api.get('/tax-packs/updates');
      const updates = (response.data?.updates || []) as TaxPackUpdate[];
      const match = updates.find((update) => update.installedPackId === packId) || null;
      setPackUpdate(match);
      if (announce) toast.success(match ? t('tax.updateAvailable', { version: match.latestVersion }) : t('tax.upToDate'));
    } catch (error) {
      if (announce) toast.error(apiMessage(error, t('tax.checkUpdatesFailed'), t));
    } finally {
      setCheckingUpdate(false);
    }
  }

  // Silent, best-effort check whenever the active official pack changes —
  // e.g. right after the settings page loads. Never surfaces an error toast;
  // a failed/offline check just leaves the update banner hidden.
  useEffect(() => {
    if (!pluginUpdateApplicable || !detail?.pack.id) return;
    let cancelled = false;
    const packId = detail.pack.id;
    api.get('/tax-packs/updates')
      .then((response) => {
        if (cancelled) return;
        const updates = (response.data?.updates || []) as TaxPackUpdate[];
        setPackUpdate(updates.find((update) => update.installedPackId === packId) || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pluginUpdateApplicable, detail?.pack.id]);

  async function installPluginUpdate() {
    const update = activePluginUpdate;
    if (!update || !isOwner) return;
    setInstallingUpdate(true);
    try {
      const installResponse = await api.post('/tax-packs/catalog/install', {
        pack_id: update.packId,
        version: update.latestVersion,
      });
      const installed = installResponse.data.installed as { packId: string; versionId: string };
      await api.post(
        `/tax-packs/${encodeURIComponent(installed.packId)}/versions/${encodeURIComponent(installed.versionId)}/activate`,
      );
      toast.success(t('tax.updatedTo', { version: update.latestVersion }));
      setPackUpdate(null);
      // installed.packId can differ from the pack that was active before
      // (e.g. a catalog rename, official-in -> official-india) — switch the
      // selection explicitly rather than relying on loadList's "keep current
      // selection if it still exists" default, which would keep showing the
      // now-inactive old pack.
      setSelectedPackId(installed.packId);
      await Promise.all([loadList(), loadAudit(), loadDetail(installed.packId)]);
    } catch (error) {
      toast.error(apiMessage(error, t('tax.installUpdateFailed'), t));
    } finally {
      setInstallingUpdate(false);
    }
  }

  // Re-downloads the currently-active plugin version in place and re-derives
  // its categories, rules, and bundled billing template. For the case where a
  // plugin shows as installed/active but its billing template never appeared
  // under Printers > Bill Template (e.g. after a database restore) — the
  // version number doesn't change, so the normal update flow has nothing to
  // offer here.
  async function reinstallPlugin() {
    const packId = detail?.pack.id;
    const versionId = detail?.active_version?.id;
    if (!isOwner || !pluginUpdateApplicable || !packId || !versionId) return;
    if (!window.confirm(t('tax.reinstallConfirm'))) {
      return;
    }
    setReinstallingPlugin(true);
    try {
      await api.post(
        `/tax-packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(versionId)}/reinstall`,
      );
      toast.success(t('tax.reinstalled'));
      await Promise.all([loadList(), loadAudit(), loadDetail(packId)]);
    } catch (error) {
      toast.error(apiMessage(error, t('tax.reinstallFailed'), t));
    } finally {
      setReinstallingPlugin(false);
    }
  }

  function resetOverrideForm() {
    setEditingOverrideId(null);
    setEntityType('product');
    setEntityId('');
    setCategoryId(detail?.categories[0]?.category_id || '');
  }

  function editOverride(override: TaxOverride) {
    setEditingOverrideId(override.id);
    setEntityType(override.entity_type);
    setEntityId(override.entity_id || '');
    setCategoryId(categoryIdOf(override));
  }

  async function saveOverride() {
    if (!isOwner) return;
    if (!categoryId || (needsEntity && !entityId)) {
      toast.error(t('tax.chooseTargetAndCategory'));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        entity_type: entityType,
        entity_id: needsEntity ? entityId : null,
        category_id: categoryId,
      };
      if (editingOverrideId) {
        await api.put(`/tax-packs/overrides/${editingOverrideId}`, payload);
        toast.success(t('tax.overrideUpdated'));
      } else {
        await api.post('/tax-packs/overrides', payload);
        toast.success(t('tax.overrideAdded'));
      }
      resetOverrideForm();
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('tax.overrideSaveFailed'), t));
    } finally {
      setSaving(false);
    }
  }

  async function removeOverride(override: TaxOverride) {
    if (!isOwner || !window.confirm(t('tax.removeOverrideConfirm', { target: override.entity_name || t(ENTITY_LABELS[override.entity_type]) }))) return;
    setSaving(true);
    try {
      await api.delete(`/tax-packs/overrides/${override.id}`);
      toast.success(t('tax.overrideRemoved'));
      if (editingOverrideId === override.id) resetOverrideForm();
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('tax.overrideRemoveFailed'), t));
    } finally {
      setSaving(false);
    }
  }

  async function setChargeCategory(entityType: OverrideEntityType, nextCategoryId: string) {
    if (!isOwner || !selectedPack?.active_for_store || !CHARGE_TYPES.includes(entityType)) return;
    const current = detail?.overrides.find(
      (override) => override.entity_type === entityType && override.entity_id === null,
    );
    setSaving(true);
    try {
      if (!nextCategoryId) {
        if (current) await api.delete(`/tax-packs/overrides/${current.id}`);
        toast.success(t('tax.chargeRestored', { entity: t(ENTITY_LABELS[entityType]) }));
      } else {
        const payload = {
          entity_type: entityType,
          entity_id: null,
          category_id: nextCategoryId,
        };
        if (current) {
          await api.put(`/tax-packs/overrides/${current.id}`, payload);
        } else {
          await api.post('/tax-packs/overrides', payload);
        }
        toast.success(t('tax.chargeSaved', { entity: t(ENTITY_LABELS[entityType]) }));
      }
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('tax.chargeSaveFailed'), t));
    } finally {
      setSaving(false);
    }
  }

  async function turnTaxesOff() {
    if (!isOwner) return;
    setSaving(true);
    try {
      await api.put('/settings/taxes_enabled', { value: 'false' });
      setTaxesEnabled(false);
      setManualBuilderOpen(false);
      toast.success(t('tax.turnedOff'));
    } catch (error) {
      toast.error(apiMessage(error, t('tax.turnOffFailed'), t));
    } finally {
      setSaving(false);
    }
  }

  async function enableCountryTaxes() {
    if (!isOwner || !storeCountry) return;
    setEnablingTaxes(true);
    setCountryPackUnavailable(false);
    try {
      await api.post('/tax-packs/ensure-country', { country: storeCountry });
      setTaxesEnabled(true);
      setCountryPackUnavailable(false);
      setPluginRequested(false);
      setManualBuilderOpen(false);
      await Promise.all([loadList(), loadAudit()]);
      toast.success(t('tax.enabledFor', { country: storeCountry }));
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        setCountryPackUnavailable(true);
        const key = pluginRequestSettingKey(storeCountry);
        const existing = await loadPluginRequestId(storeCountry);
        const clientTicketId = existing || crypto.randomUUID();
        if (!existing) await api.put(`/settings/${key}`, { value: clientTicketId });
        try {
          await api.post('/support-ticket', {
            client_ticket_id: clientTicketId,
            subject: `Request tax support for ${storeCountry}`,
            event_code: 'tax.country_plugin_unavailable',
            message: `The merchant selected ${storeCountry} and enabled taxes, but no verified country tax plugin is currently available. Please create and publish the plugin.`,
            diagnostics: { country: storeCountry },
          });
          setPluginRequested(true);
        } catch {
          // The visible unavailable state remains; the support outbox will retry
          // when the network is available on a later attempt.
        }
        return;
      }
      toast.error(apiMessage(error, t('tax.enableFailed'), t));
    } finally {
      setEnablingTaxes(false);
    }
  }

  async function calculate() {
    if (!selectedPack?.active_for_store) {
      toast.error(t('tax.selectActivePack'));
      return;
    }
    const amountNum = Number(testAmount);
    if (!testCategoryId || !testAmount || isNaN(amountNum) || amountNum <= 0) {
      toast.error(t('tax.invalidTestAmount'));
      return;
    }
    try {
      const response = await api.post('/tax-packs/test-calculation', {
        category_id: testCategoryId,
        amount: amountNum,
        tax_behavior: testBehavior,
      });
      setCalculation(response.data.calculation);
    } catch (error) {
      setCalculation(null);
      toast.error(apiMessage(error, t('tax.calculateFailed'), t));
    }
  }

  function addManualCategory() {
    setManualCategories((current) => [...current, newManualCategory('')]);
  }
  function removeManualCategory(tempId: string) {
    setManualCategories((current) => current.filter((category) => category.tempId !== tempId));
    setManualDefaults((current) => {
      const fallback = manualCategories.find((category) => category.tempId !== tempId)?.tempId || '';
      const next = { ...current };
      (Object.keys(next) as Array<keyof ManualDefaults>).forEach((key) => {
        if (next[key] === tempId) next[key] = fallback;
      });
      return next;
    });
  }
  function updateManualCategoryLabel(tempId: string, label: string) {
    setManualCategories((current) => current.map((category) => (category.tempId === tempId ? { ...category, label } : category)));
  }
  function addManualComponent(categoryTempId: string) {
    setManualCategories((current) => current.map((category) => (
      category.tempId === categoryTempId ? { ...category, components: [...category.components, newManualComponent()] } : category
    )));
  }
  function removeManualComponent(categoryTempId: string, key: string) {
    setManualCategories((current) => current.map((category) => (
      category.tempId === categoryTempId
        ? { ...category, components: category.components.filter((component) => component.key !== key) }
        : category
    )));
  }
  function updateManualComponent(categoryTempId: string, key: string, patch: Partial<ManualComponent>) {
    setManualCategories((current) => current.map((category) => (
      category.tempId === categoryTempId
        ? { ...category, components: category.components.map((component) => (component.key === key ? { ...component, ...patch } : component)) }
        : category
    )));
  }

  async function saveManualConfig(override = false) {
    if (!isOwner) return;
    for (const category of manualCategories) {
      if (!category.label.trim()) {
        toast.error(t('tax.categoryNameRequired'));
        return;
      }
      if (category.components.length === 0) {
        toast.error(t('tax.categoryNeedsComponent', { label: category.label }));
        return;
      }
      for (const component of category.components) {
        const value = Number(component.value);
        if (!Number.isFinite(value) || value < 0 || (component.type === 'percent' && value > 100)) {
          toast.error(t('tax.componentNeedsValidRate', { label: component.label || category.label }));
          return;
        }
      }
    }
    setManualSaving(true);
    try {
      const payload = {
        inclusive: manualInclusive,
        categories: manualCategories.map((category) => ({
          tempId: category.tempId,
          label: category.label.trim(),
          components: category.components.map((component) => ({
            label: component.label.trim(),
            type: component.type,
            value: component.value,
          })),
        })),
        defaultProductCategoryTempId: manualDefaults.product,
        packagingCategoryTempId: manualDefaults.packaging,
        deliveryCategoryTempId: manualDefaults.delivery,
        serviceChargeCategoryTempId: manualDefaults.service_charge,
        ...(override ? { override: true } : {}),
      };
      const response = await api.post('/tax-packs/manual-config', payload);
      const remapped = (response.data?.remapped || []) as Array<{ entity: string; count: number }>;
      if (remapped.length > 0) {
        const summary = remapped.map((row) => `${row.count} ${row.entity}${row.count === 1 ? '' : 's'}`).join(' and ');
        toast(t('tax.reassignedSummary', { summary }), { icon: '⚠️' });
      }
      toast.success(t('tax.manualSaved'));
      setManualOverrideConfirm(null);
      setTaxesEnabled(true);
      await Promise.all([loadList(), loadAudit(), applyManualDefinition(storeCountry)]);
      if (selectedPackId) await loadDetail(selectedPackId);
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: { can_override?: boolean; active_pack_id?: string; validation?: { checks: Array<{ passed: boolean; message: string }> } } } }).response;
      if (response?.status === 409 && response.data?.can_override) {
        setManualOverrideConfirm(response.data.active_pack_id || storeCountry);
        return;
      }
      const failedChecks = response?.data?.validation?.checks?.filter((check) => !check.passed).map((check) => check.message);
      toast.error(failedChecks?.length ? failedChecks.join('; ') : apiMessage(error, t('tax.manualSaveFailed'), t));
    } finally {
      setManualSaving(false);
    }
  }

  if (loading && !detail) {
    return <div className="py-16 text-center text-sm text-gray-500">{t('tax.loading')}</div>;
  }

  return (
    <div className="pb-6 max-w-5xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{t('tax.title')}</h2>
          <p className="mt-1 text-sm text-gray-500">{t('tax.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setLoading(true);
              void refreshAll();
            }}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> {t('tax.refresh')}
          </Button>
        </div>
      </div>

      {!isOwner && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Lock size={16} className="mt-0.5 shrink-0" />
          {t('tax.managerNotice')}
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">{t('tax.mode')}</h3>
        <div className="mt-3 inline-flex flex-wrap rounded-lg border border-gray-200 bg-gray-50 p-1">
          <button
            type="button"
            disabled={!isOwner || saving}
            onClick={() => {
              setManualBuilderOpen(false);
              if (taxesEnabled) void turnTaxesOff();
            }}
            className={taxModeSegmentClass(activeSegment === 'off')}
          >
            {t('tax.modeOff')}
          </button>
          <button
            type="button"
            disabled={!isOwner || enablingTaxes || officialPackAvailableResolved === false}
            title={officialPackAvailableResolved === false ? t('tax.noOfficialPack', { country: storeCountry }) : undefined}
            onClick={() => {
              setManualBuilderOpen(false);
              if (taxMode !== 'official') void enableCountryTaxes();
            }}
            className={taxModeSegmentClass(activeSegment === 'official')}
          >
            {enablingTaxes ? t('tax.enabling') : t('tax.modeOfficial')}
          </button>
          <button
            type="button"
            disabled={!isOwner}
            onClick={() => setManualBuilderOpen(true)}
            className={taxModeSegmentClass(activeSegment === 'manual')}
          >
            {t('tax.modeManual')}
          </button>
        </div>
        <p className="mt-3 text-sm text-gray-600">
          {taxMode === 'off' && t('tax.modeOffHint')}
          {taxMode === 'official' && t('tax.modeOfficialHint', { country: storeCountry })}
          {taxMode === 'manual' && t('tax.modeManualHint', { country: storeCountry })}
          {manualBuilderOpen && taxMode !== 'manual' && t('tax.modeManualUnsavedHint')}
        </p>
        {countryPackUnavailable && (
          <p role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t('tax.supportUnavailable', { country: storeCountry })}
            {pluginRequested && t('tax.requestQueued')}
          </p>
        )}
        {taxMode === 'official' && detail?.active_version && detail.pack.publisher !== 'local' && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
            <span>
              {t('tax.pluginVersion')} <span className="font-mono font-medium">v{detail.active_version.version}</span>
              <span className="ms-1 text-gray-400">({detail.pack.trust_status})</span>
            </span>
            <span className="ms-auto flex items-center gap-3">
              {isOwner && (
                <button
                  type="button"
                  onClick={() => void reinstallPlugin()}
                  disabled={reinstallingPlugin}
                  title={t('tax.reinstallHint')}
                  className="flex items-center gap-1 font-medium text-gray-600 hover:text-gray-800 disabled:opacity-50"
                >
                  <Wrench size={13} className={reinstallingPlugin ? 'animate-spin' : ''} />
                  {reinstallingPlugin ? t('tax.reinstalling') : t('tax.reinstallPlugin')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void checkForPluginUpdates(true)}
                disabled={checkingUpdate}
                className="flex items-center gap-1 font-medium text-brand disabled:opacity-50"
              >
                <RefreshCw size={13} className={checkingUpdate ? 'animate-spin' : ''} />
                {checkingUpdate ? t('tax.checking') : t('tax.checkUpdates')}
              </button>
            </span>
          </div>
        )}
        {activePluginUpdate && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
            <span className="flex items-center gap-1.5">
              <Download size={14} className="text-brand" />
              {t('tax.updateAvailableLabel')} <span className="font-mono font-medium">v{activePluginUpdate.latestVersion}</span>
              <span className="text-gray-500">{t('tax.currentVersion', { current: activePluginUpdate.currentVersion })}</span>
            </span>
            {isOwner ? (
              <Button size="sm" disabled={installingUpdate} onClick={() => void installPluginUpdate()}>
                {installingUpdate ? t('tax.installing') : t('tax.installAndActivate')}
              </Button>
            ) : (
              <span className="text-xs text-gray-500">{t('tax.askOwnerToInstall')}</span>
            )}
          </div>
        )}
      </section>

      {manualBuilderVisible && (
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wrench size={20} className="text-brand" />
            <h3 className="font-semibold text-gray-900">{t('tax.manualBuilder')}</h3>
          </div>
          {!taxesEnabled && (
            <button type="button" onClick={() => setManualBuilderOpen(false)} className="text-sm text-gray-400 hover:text-gray-600">{t('tax.hide')}</button>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500">
          {t('tax.manualBuilderHint', { country: storeCountry || t('tax.yourStore') })}
        </p>

        <div className="mt-4 space-y-3">
          {manualCategories.map((category) => (
            <div key={category.tempId} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <div className="flex items-center gap-2">
                <input
                  value={category.label}
                  onChange={(event) => updateManualCategoryLabel(category.tempId, event.target.value)}
                  disabled={!isOwner}
                  placeholder={t('tax.categoryNamePlaceholder')}
                  className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium disabled:bg-gray-100"
                />
                {isOwner && manualCategories.length > 1 && (
                  <button type="button" onClick={() => removeManualCategory(category.tempId)} className="p-2 text-gray-400 hover:text-red-600" title={t('tax.removeCategory')}>
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
              <div className="mt-2 space-y-2">
                {category.components.map((component) => (
                  <div key={component.key} className="flex items-center gap-2 ps-4">
                    <input
                      value={component.label}
                      onChange={(event) => updateManualComponent(category.tempId, component.key, { label: event.target.value })}
                      disabled={!isOwner}
                      placeholder={t('tax.componentPlaceholder')}
                      className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm disabled:bg-gray-100"
                    />
                    <select
                      value={component.type}
                      onChange={(event) => updateManualComponent(category.tempId, component.key, { type: event.target.value as 'percent' | 'fixed' })}
                      disabled={!isOwner}
                      className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm disabled:bg-gray-100"
                    >
                      <option value="percent">%</option>
                      <option value="fixed">{t('tax.fixed')}</option>
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={component.value}
                      onChange={(event) => updateManualComponent(category.tempId, component.key, { value: event.target.value })}
                      disabled={!isOwner}
                      className="w-24 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-end disabled:bg-gray-100"
                    />
                    {isOwner && category.components.length > 1 && (
                      <button type="button" onClick={() => removeManualComponent(category.tempId, component.key)} className="p-1.5 text-gray-400 hover:text-red-600" title={t('tax.removeComponent')}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
                {isOwner && (
                  <button type="button" onClick={() => addManualComponent(category.tempId)} className="ms-4 flex items-center gap-1 text-xs font-medium text-brand">
                    <Plus size={12} /> {t('tax.addComponent')}
                  </button>
                )}
              </div>
            </div>
          ))}
          {isOwner && (
            <button type="button" onClick={addManualCategory} className="flex items-center gap-1 text-sm font-medium text-brand">
              <Plus size={14} /> {t('tax.addCategory')}
            </button>
          )}
        </div>

        <div className="mt-5 border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-800">{t('tax.menuPrices')}</p>
          <div className="mt-2 flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={!manualInclusive} onChange={() => setManualInclusive(false)} disabled={!isOwner} />
              {t('tax.exclusiveLabel')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={manualInclusive} onChange={() => setManualInclusive(true)} disabled={!isOwner} />
              {t('tax.inclusiveLabel')}
            </label>
          </div>
        </div>

        <div className="mt-5 border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-800">{t('tax.defaultCategory')}</p>
          <p className="text-xs text-gray-500 mb-2">{t('tax.defaultCategoryHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {([
              ['product', t('tax.defaultNewProducts')],
              ['packaging', t('tax.defaultPackaging')],
              ['delivery', t('tax.defaultDelivery')],
              ['service_charge', t('tax.defaultServiceCharge')],
            ] as Array<[keyof ManualDefaults, string]>).map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-xs text-gray-500">{label}</span>
                <select
                  value={manualDefaults[key]}
                  onChange={(event) => setManualDefaults((current) => ({ ...current, [key]: event.target.value }))}
                  disabled={!isOwner}
                  className="mt-1 w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm disabled:bg-gray-100"
                >
                  {manualCategories.map((category) => (
                    <option key={category.tempId} value={category.tempId}>{category.label || t('tax.untitledCategory')}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>

        {manualOverrideConfirm && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span>{t('tax.manualOverrideConfirm', { country: storeCountry })}</span>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" onClick={() => setManualOverrideConfirm(null)}>{t('tax.cancel')}</Button>
              <Button disabled={manualSaving} onClick={() => void saveManualConfig(true)}>{t('tax.replace')}</Button>
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <Button disabled={!isOwner || manualSaving} onClick={() => void saveManualConfig(false)}>
            {manualSaving ? t('tax.saving') : manualLoaded ? t('tax.saveManual') : t('tax.createManual')}
          </Button>
        </div>
      </section>
      )}

      <button
        type="button"
        onClick={() => setShowAdvancedTools((value) => !value)}
        className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-white p-5 text-start"
      >
        <div>
          <h3 className="font-semibold text-gray-900">{t('tax.advancedTools')}</h3>
          <p className="mt-1 text-sm text-gray-500">{t('tax.advancedToolsHint')}</p>
        </div>
        <ChevronDown size={18} className={`shrink-0 text-gray-500 ${showAdvancedTools ? 'rotate-180' : ''}`} />
      </button>

      {showAdvancedTools && (
        <>
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} className="text-brand" />
            <h3 className="font-semibold text-gray-900">{t('tax.installedPacks')}</h3>
          </div>
          <span className="text-xs text-gray-500">{t('tax.installedPacksHint', { country: storeCountry })}</span>
        </div>

        {selectedPack && detail ? (
          <>
            {detail.active_version ? (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Info label={t('tax.storeCountry')} value={storeCountry} />
                  <Info label={t('tax.jurisdiction')} value={selectedPack.jurisdiction} />
                  <Info label={t('tax.activeVersion')} value={detail.active_version.version} />
                  <Info label={t('tax.trustStatus')} value={detail.pack.trust_status} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                  <span>{t('tax.effectiveFrom', { date: detail.active_version.effective_from })}</span>
                  <span>{t('tax.publishedAt', { date: detail.active_version.published_at })}</span>
                  <span><Ltr>{detail.active_version.definition.currency}</Ltr></span>
                  <button
                    type="button"
                    onClick={() => setExpandedChecklist((value) => !value)}
                    className="ms-auto flex items-center gap-1 font-medium text-brand"
                  >
                    {detail.active_version.validation.valid ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                    {detail.active_version.validation.valid
                      ? t('tax.checksPassed', { passed: detail.active_version.validation.checks.filter((c) => c.passed).length, total: detail.active_version.validation.checks.length })
                      : t('tax.checksFailed')}
                    <ChevronDown size={14} className={expandedChecklist ? 'rotate-180' : ''} />
                  </button>
                </div>
                {expandedChecklist && (
                  <ol className="mt-3 grid gap-1 rounded-lg border border-gray-100 p-3 text-xs sm:grid-cols-2">
                    {detail.active_version.validation.checks.map((check) => (
                      <li key={check.id} className={check.passed ? 'text-gray-600' : 'text-red-700'}>
                        {check.passed ? '✓' : '✕'} {check.id}. {check.message}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            ) : (
              <p className="mt-4 text-sm text-gray-500">
                {t('tax.noActiveVersion')}
              </p>
            )}
            <div className="mt-5 border-t border-gray-100 pt-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-800">{t('tax.installedVersions')}</p>
              </div>
              <div className="space-y-2">
                {detail.versions.map((version) => {
                  const active = version.id === detail.pack.active_version_id;
                  return (
                    <div key={version.id} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 text-sm">
                      <span>
                        v{version.version}
                        <span className="ms-2 text-xs text-gray-400">{version.status}</span>
                      </span>
                      {active && <span className="text-xs font-medium text-emerald-700">{t('tax.active')}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-gray-500">{t('tax.noActivePack')}</p>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <Calculator size={20} className="text-brand" />
          <h3 className="font-semibold text-gray-900">{t('tax.testCalculation')}</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">{t('tax.testCalculationHint')}</p>
        {!selectedPack?.active_for_store && (
          <p className="mt-2 text-xs text-amber-700">{t('tax.packNotActive')}</p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <select disabled={!selectedPack?.active_for_store} value={testCategoryId} onChange={(event) => setTestCategoryId(event.target.value)} className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100">
            {detail?.categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.label}</option>)}
          </select>
          <input
            value={testAmount}
            onChange={(event) => setTestAmount(event.target.value)}
            inputMode="decimal"
            placeholder={t('tax.amount')}
            disabled={!selectedPack?.active_for_store}
            className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100"
          />
          <select disabled={!selectedPack?.active_for_store} value={testBehavior} onChange={(event) => setTestBehavior(event.target.value)} className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100">
            <option value="country_default">{t('tax.behaviorCountryDefault')}</option>
            <option value="exclusive">{t('tax.behaviorExclusive')}</option>
            <option value="inclusive">{t('tax.behaviorInclusive')}</option>
            <option value="exempt">{t('tax.behaviorExempt')}</option>
          </select>
          <Button disabled={!selectedPack?.active_for_store} onClick={() => void calculate()}>{t('tax.calculate')}</Button>
        </div>
        {calculation && (
          <div className="mt-4 rounded-lg bg-gray-50 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Info label={t('tax.taxableBase')} value={calculation.taxableBase} />
              <Info label={t('tax.tax')} value={calculation.taxAmount} />
              <Info label={t('tax.payableTotal')} value={calculation.payableTotal} />
            </div>
            {calculation.lines[0]?.components.length > 0 && (
              <div className="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-600">
                {calculation.lines[0].components.map((component) => (
                  <div key={component.ruleId} className="flex justify-between py-0.5">
                    <span>{component.label}{component.rate ? ` · ${component.rate}%` : ''}</span>
                    <span>{component.amount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={20} className="text-brand" />
          <h3 className="font-semibold text-gray-900">{t('tax.chargeCategories')}</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          {t('tax.chargeCategoriesHint')}
        </p>
        {!selectedPack?.active_for_store && (
          <p className="mt-2 text-xs text-amber-700">{t('tax.chargeCategoriesNotActive')}</p>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {CHARGE_TYPES.map((chargeType) => {
            const configured = detail?.overrides.find(
              (override) => override.entity_type === chargeType && override.entity_id === null,
            );
            return (
              <label key={chargeType} className="block">
                <span className="text-sm font-medium text-gray-800">{t(ENTITY_LABELS[chargeType])}</span>
                <select
                  value={configured ? categoryIdOf(configured) : ''}
                  onChange={(event) => void setChargeCategory(chargeType, event.target.value)}
                  disabled={!isOwner || saving || !selectedPack?.active_for_store}
                  className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm disabled:bg-gray-100"
                >
                  <option value="">{t('tax.chargeNotConfigured')}</option>
                  {detail?.categories.map((category) => (
                    <option key={category.category_id} value={category.category_id}>{category.label}</option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={20} className="text-brand" />
          <h3 className="font-semibold text-gray-900">{t('tax.merchantOverrides')}</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          {t('tax.merchantOverridesHint')}
        </p>

        {isOwner && (
          <div className="mt-4 grid gap-3 rounded-lg border border-gray-100 bg-gray-50 p-4 sm:grid-cols-3">
            <select
              value={entityType}
              onChange={(event) => {
                setEntityType(event.target.value as OverrideEntityType);
                setEntityId('');
              }}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
            >
              {(['product', 'addon'] as OverrideEntityType[]).map((value) => (
                <option key={value} value={value}>{t(ENTITY_LABELS[value])}</option>
              ))}
            </select>
            {needsEntity ? (
              <select value={entityId} onChange={(event) => setEntityId(event.target.value)} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
                <option value="">{t('tax.chooseEntity', { entity: t(ENTITY_LABELS[entityType]) })}</option>
                {targetOptions.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
              </select>
            ) : (
              <div className="rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-500">{t('tax.storeWideCharge')}</div>
            )}
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
              {detail?.categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.label}</option>)}
            </select>
            <div className="flex gap-2 sm:col-span-3 sm:justify-end">
              {editingOverrideId && <Button variant="outline" onClick={resetOverrideForm}>{t('tax.cancel')}</Button>}
              <Button disabled={saving} onClick={() => void saveOverride()}>
                <Plus size={14} /> {editingOverrideId ? t('tax.saveOverride') : t('tax.addOverride')}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[620px] text-start text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pe-3">{t('tax.target')}</th><th className="py-2 pe-3">{t('tax.category')}</th><th className="py-2 pe-3">{t('tax.updated')}</th><th className="py-2 text-end">{t('tax.actions')}</th></tr>
            </thead>
            <tbody>
              {detail?.overrides.map((override) => (
                <tr key={override.id} className="border-b border-gray-50">
                  <td className="py-3 pe-3"><span className="text-xs text-gray-400">{t(ENTITY_LABELS[override.entity_type])}</span><br />{override.entity_name || t('tax.storeWide')}</td>
                  <td className="py-3 pe-3">{categoriesById.get(categoryIdOf(override)) || categoryIdOf(override)}</td>
                  <td className="py-3 pe-3 text-xs text-gray-500">{formatDateTime(override.updated_at)}{override.created_by_name ? ` · ${override.created_by_name}` : ''}</td>
                  <td className="py-3 text-end">
                    {isOwner ? (
                      <div className="flex justify-end gap-2">
                        {!CHARGE_TYPES.includes(override.entity_type) && (
                          <button className="text-brand hover:underline" onClick={() => editOverride(override)}>{t('tax.edit')}</button>
                        )}
                        <button className="text-red-600 hover:underline" onClick={() => void removeOverride(override)}>{t('tax.remove')}</button>
                      </div>
                    ) : <span className="text-xs text-gray-400">{t('tax.readOnly')}</span>}
                  </td>
                </tr>
              ))}
              {!detail?.overrides.length && <tr><td colSpan={4} className="py-8 text-center text-gray-400">{t('tax.noOverrides')}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">{t('tax.packReference')}</h3>
        <p className="mt-1 text-sm text-gray-500">{t('tax.packReferenceHint')}</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[680px] text-start text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pe-3">{t('tax.category')}</th><th className="py-2 pe-3">{t('tax.defaultBehavior')}</th><th className="py-2">{t('tax.rules')}</th></tr>
            </thead>
            <tbody>
              {detail?.categories.map((category) => (
                <tr key={category.category_id} className="border-b border-gray-50">
                  <td className="py-3 pe-3"><span className="font-medium">{category.label}</span><br /><Ltr as="code" className="text-xs text-gray-400">{category.category_id}</Ltr></td>
                  <td className="py-3 pe-3">{category.default_behavior || t('tax.packDefault')}</td>
                  <td className="py-3 text-xs text-gray-600">{category.definition.ruleIds?.join(', ') || t('tax.none')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-start text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pe-3">{t('tax.rule')}</th><th className="py-2 pe-3">{t('tax.type')}</th><th className="py-2 pe-3">{t('tax.value')}</th><th className="py-2 pe-3">{t('tax.scope')}</th><th className="py-2">{t('tax.dependsOn')}</th></tr>
            </thead>
            <tbody>
              {detail?.rules.map((rule) => (
                <tr key={rule.rule_id} className="border-b border-gray-50">
                  <td className="py-3 pe-3"><span className="font-medium">{rule.label}</span><br /><Ltr as="code" className="text-xs text-gray-400">{rule.rule_id}</Ltr></td>
                  <td className="py-3 pe-3">{rule.calculation_type}</td>
                  <td className="py-3 pe-3">{rule.rate !== null ? `${rule.rate}%` : rule.amount}</td>
                  <td className="py-3 pe-3">{rule.applies_per}</td>
                  <td className="py-3 text-xs text-gray-600">{rule.base_rule_ids.join(', ') || t('tax.none')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <History size={20} className="text-brand" />
          <h3 className="font-semibold text-gray-900">{t('tax.auditHistory')}</h3>
        </div>
        <div className="mt-4 space-y-2">
          {audit.map((row) => (
            <div key={row.id} className="flex items-start gap-3 rounded-lg border border-gray-100 px-3 py-3">
              <Clock3 size={15} className="mt-0.5 shrink-0 text-gray-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800">{t(ACTION_LABELS[row.action] || row.action)}</p>
                {auditDescription(row, t) && <p className="truncate text-xs text-gray-600">{auditDescription(row, t)}</p>}
                <p className="text-xs text-gray-500">{row.actor_name || (row.actor_user_id ? t('tax.auditUnknownUser') : t('tax.auditSystem'))} · {formatDateTime(row.created_at)}</p>
              </div>
            </div>
          ))}
          {!audit.length && <p className="py-6 text-center text-sm text-gray-400">{t('tax.noAudit')}</p>}
        </div>
      </section>
        </>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-medium text-gray-800">{value}</p>
    </div>
  );
}
