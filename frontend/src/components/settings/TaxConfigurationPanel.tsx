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
import { useTranslations, type AppConfig } from 'use-intl';
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
      sourceType?: 'official' | 'community';
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

// Manual tax builder: category groups rate components that apply together.
// See buildManualPack in main/routes/tax-packs.ts for server mirror.
type ManualComponent = { key: string; label: string; type: 'percent' | 'fixed'; value: string };
type ManualCategory = { tempId: string; label: string; components: ManualComponent[] };
// Add-ons are taxed with parent item subtotal, never as standalone lines.
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

type TaxKey = keyof AppConfig['Messages']['tax'];
type Translate = (key: TaxKey, params?: Record<string, string | number>) => string;

const ENTITY_LABELS = {
  product: 'entityProduct',
  addon: 'entityAddon',
  packaging: 'entityPackaging',
  delivery: 'entityDelivery',
  service_charge: 'entityServiceCharge',
} as const satisfies Record<OverrideEntityType, TaxKey>;

const pluginRequestSettingKey = (country: string) => `tax_plugin_request:${country}`;

async function loadPluginRequestId(country: string): Promise<string | null> {
  try {
    // Bulk /settings doesn't 404 on unwritten keys, avoiding console noise
    // for stores that haven't filed plugin requests.
    const response = await api.get('/settings');
    return response.data?.settings?.[pluginRequestSettingKey(country)] || null;
  } catch {
    return null;
  }
}
const CHARGE_TYPES: OverrideEntityType[] = ['packaging', 'delivery', 'service_charge'];

const ACTION_LABELS = {
  install_bundled_pack: 'actionInstallBundled',
  install_downloaded_pack: 'actionInstallDownloaded',
  activate_pack: 'actionActivate',
  rollback_pack: 'actionRollback',
  create_override: 'actionCreateOverride',
  update_override: 'actionUpdateOverride',
  reset_override: 'actionResetOverride',
} as const satisfies Record<string, TaxKey>;

function actionLabel(t: Translate, action: string): string {
  const key = (ACTION_LABELS as Record<string, TaxKey | undefined>)[action];
  return key ? t(key) : action;
}

// The `tax` namespace has no `apiError` sub-namespace, so the shared legacy
// helper always falls back to the localized fallback message.
const apiErrorT = (key: string): string => key;

function apiMessage(error: unknown, fallback: string): string {
  return apiErrorText(error, fallback, apiErrorT);
}

function taxModeSegmentClass(active: boolean): string {
  return `px-3 py-1.5 text-sm font-medium rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
    active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
  }`;
}

function categoryIdOf(override: TaxOverride): string {
  return override.value?.categoryId || '';
}

function entityTypeLabel(t: Translate, entityType: unknown): string {
  if (typeof entityType === 'string' && entityType in ENTITY_LABELS) {
    return t(ENTITY_LABELS[entityType as OverrideEntityType]);
  }
  return t('target');
}

function auditDescription(row: AuditRow, t: Translate): string {
  const details = row.details || {};
  if (row.action === 'install_bundled_pack') return t('auditInstallBundled', { version: String(details.version || '') });
  if (row.action === 'install_downloaded_pack') return t('auditInstallDownloaded', { version: String(details.version || '') });
  if (row.action === 'create_override') {
    return t('auditCreateOverride', {
      entityType: entityTypeLabel(t, details.entityType),
      entityId: String(details.entityId || t('storeWide')),
      categoryId: String(details.categoryId || ''),
    });
  }
  if (row.action === 'update_override') {
    const before = (details.before || {}) as Record<string, unknown>;
    const after = (details.after || {}) as Record<string, unknown>;
    return t('auditUpdateOverride', {
      entityType: entityTypeLabel(t, after.entityType || before.entityType),
      entityId: String(after.entityId || before.entityId || t('storeWide')),
      before: String(before.categoryId || ''),
      after: String(after.categoryId || ''),
    });
  }
  if (row.action === 'reset_override') {
    return t('auditResetOverride', {
      entityType: entityTypeLabel(t, details.entityType),
      entityId: String(details.entityId || t('storeWide')),
    });
  }
  if (row.action === 'activate_pack') return t('auditActivatePack', { previousVersionId: String(details.previousVersionId || 'none') });
  if (row.action === 'rollback_pack') return t('auditRollbackPack', { previousVersionId: String(details.previousVersionId || 'unknown') });
  return '';
}

export function TaxConfigurationPanel({ isOwner }: { isOwner: boolean }) {
  const { formatDateTime } = useFormatDate();
  const t = useTranslations('tax');
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
  const [reportingIssue, setReportingIssue] = useState(false);

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
    // Only fetch if a manual-<country> pack exists to avoid 404 console noise.
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
      toast.error(apiMessage(error, t('loadFailed')));
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
        if (!cancelled) toast.error(apiMessage(error, t('loadFailed')));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadManualDetail, t]);

  // Best-effort check to disable "Official Tax Pack" when no plugin exists;
  // offline/failed catalog checks preserve neutral state.
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
        if (!cancelled) toast.error(apiMessage(error, t('loadPackDetailsFailed')));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedPackId, t]);

  const selectedPack = packs.find((pack) => pack.id === selectedPackId);
  const activePackPublisher = packs.find((pack) => pack.active_for_store)?.publisher;
  // Real backend tax state; only changes once configuration is activated.
  const taxMode: 'off' | 'official' | 'manual' = !taxesEnabled ? 'off' : activePackPublisher === 'local' ? 'manual' : 'official';
  const manualBuilderVisible = manualBuilderOpen || taxMode === 'manual';
  // Check updates only when official (non-local) tax pack is active.
  const pluginUpdateApplicable = taxMode === 'official' && detail?.pack.publisher !== 'local';
  const activePluginUpdate = pluginUpdateApplicable ? packUpdate : null;
  // Opening manual builder displays 'manual' segment before backend saves.
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
      if (announce) toast.error(t('noPluginToCheck'));
      return;
    }
    setCheckingUpdate(true);
    try {
      const response = await api.get('/tax-packs/updates');
      const updates = (response.data?.updates || []) as TaxPackUpdate[];
      const match = updates.find((update) => update.installedPackId === packId) || null;
      setPackUpdate(match);
      if (announce) toast.success(match ? t('updateAvailable', { version: match.latestVersion }) : t('upToDate'));
    } catch (error) {
      if (announce) toast.error(apiMessage(error, t('checkUpdatesFailed')));
    } finally {
      setCheckingUpdate(false);
    }
  }

  // Silent, best-effort check for official pack updates on mount/change.
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
      const activateUrl = `/tax-packs/${encodeURIComponent(installed.packId)}/versions/${encodeURIComponent(installed.versionId)}/activate`;
      let activateResponse = await api.post(activateUrl);
      if (activateResponse.data?.requires_disclaimer) {
        const accepted = window.confirm(t('communityPackDisclaimer', {
          country: update.country,
          version: activateResponse.data.version,
        }));
        if (!accepted) return;
        activateResponse = await api.post(activateUrl, { acknowledge_community_disclaimer: true });
        if (activateResponse.data?.requires_disclaimer) return;
      }
      toast.success(t('updatedTo', { version: update.latestVersion }));
      setPackUpdate(null);
      // Switch selection explicitly to installed pack ID in case catalog renamed it.
      setSelectedPackId(installed.packId);
      await Promise.all([loadList(), loadAudit(), loadDetail(installed.packId)]);
    } catch (error) {
      toast.error(apiMessage(error, t('installUpdateFailed')));
    } finally {
      setInstallingUpdate(false);
    }
  }

  // Re-downloads active plugin in place to restore categories and bill templates
  // without changing the version number.
  async function reinstallPlugin() {
    const packId = detail?.pack.id;
    const versionId = detail?.active_version?.id;
    if (!isOwner || !pluginUpdateApplicable || !packId || !versionId) return;
    if (!window.confirm(t('reinstallConfirm'))) {
      return;
    }
    setReinstallingPlugin(true);
    try {
      await api.post(
        `/tax-packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(versionId)}/reinstall`,
      );
      toast.success(t('reinstalled'));
      await Promise.all([loadList(), loadAudit(), loadDetail(packId)]);
    } catch (error) {
      toast.error(apiMessage(error, t('reinstallFailed')));
    } finally {
      setReinstallingPlugin(false);
    }
  }

  // File support ticket for community tax pack issues.
  async function reportCommunityPackIssue() {
    const pack = detail?.pack;
    const version = detail?.active_version;
    if (!pack || !version) return;
    setReportingIssue(true);
    try {
      await api.post('/support-ticket', {
        client_ticket_id: crypto.randomUUID(),
        subject: `Issue with community tax pack ${pack.id}`,
        event_code: 'tax.community_pack_issue',
        message: `The merchant reported an issue with the community-sourced tax pack ${pack.id} (v${version.version}, ${pack.country}).`,
        diagnostics: { pack_id: pack.id, version: version.version, country: pack.country },
      });
      toast.success(t('reportIssueSent'));
    } catch (error) {
      toast.error(apiMessage(error, t('reportIssueFailed')));
    } finally {
      setReportingIssue(false);
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
      toast.error(t('chooseTargetAndCategory'));
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
        toast.success(t('overrideUpdated'));
      } else {
        await api.post('/tax-packs/overrides', payload);
        toast.success(t('overrideAdded'));
      }
      resetOverrideForm();
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('overrideSaveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function removeOverride(override: TaxOverride) {
    if (!isOwner || !window.confirm(t('removeOverrideConfirm', { target: override.entity_name || t(ENTITY_LABELS[override.entity_type]) }))) return;
    setSaving(true);
    try {
      await api.delete(`/tax-packs/overrides/${override.id}`);
      toast.success(t('overrideRemoved'));
      if (editingOverrideId === override.id) resetOverrideForm();
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('overrideRemoveFailed')));
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
        toast.success(t('chargeRestored', { entity: t(ENTITY_LABELS[entityType]) }));
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
        toast.success(t('chargeSaved', { entity: t(ENTITY_LABELS[entityType]) }));
      }
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('chargeSaveFailed')));
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
      toast.success(t('turnedOff'));
    } catch (error) {
      toast.error(apiMessage(error, t('turnOffFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function enableCountryTaxes() {
    if (!isOwner || !storeCountry) return;
    setEnablingTaxes(true);
    setCountryPackUnavailable(false);
    try {
      let response = await api.post('/tax-packs/ensure-country', { country: storeCountry });
      if (response.data?.requires_disclaimer) {
        const accepted = window.confirm(t('communityPackDisclaimer', {
          country: storeCountry,
          version: response.data.version,
        }));
        if (!accepted) return;
        response = await api.post('/tax-packs/ensure-country', {
          country: storeCountry,
          acknowledge_community_disclaimer: true,
        });
        if (response.data?.requires_disclaimer) return;
      }
      setTaxesEnabled(true);
      setCountryPackUnavailable(false);
      setPluginRequested(false);
      setManualBuilderOpen(false);
      await Promise.all([loadList(), loadAudit()]);
      toast.success(t('enabledFor', { country: storeCountry }));
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
      toast.error(apiMessage(error, t('enableFailed')));
    } finally {
      setEnablingTaxes(false);
    }
  }

  async function calculate() {
    if (!selectedPack?.active_for_store) {
      toast.error(t('selectActivePack'));
      return;
    }
    const amountNum = Number(testAmount);
    if (!testCategoryId || !testAmount || isNaN(amountNum) || amountNum <= 0) {
      toast.error(t('invalidTestAmount'));
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
      toast.error(apiMessage(error, t('calculateFailed')));
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
        toast.error(t('categoryNameRequired'));
        return;
      }
      if (category.components.length === 0) {
        toast.error(t('categoryNeedsComponent', { label: category.label }));
        return;
      }
      for (const component of category.components) {
        const value = Number(component.value);
        if (!Number.isFinite(value) || value < 0 || (component.type === 'percent' && value > 100)) {
          toast.error(t('componentNeedsValidRate', { label: component.label || category.label }));
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
        toast(t('reassignedSummary', { summary }), { icon: '⚠️' });
      }
      toast.success(t('manualSaved'));
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
      toast.error(failedChecks?.length ? failedChecks.join('; ') : apiMessage(error, t('manualSaveFailed')));
    } finally {
      setManualSaving(false);
    }
  }

  if (loading && !detail) {
    return <div className="py-16 text-center text-sm text-muted-foreground">{t('loading')}</div>;
  }

  return (
    <div className="pb-6 max-w-5xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
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
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> {t('refresh')}
          </Button>
        </div>
      </div>

      {!isOwner && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Lock size={16} className="mt-0.5 shrink-0" />
          {t('managerNotice')}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-semibold text-foreground">{t('mode')}</h3>
        <div className="mt-3 inline-flex flex-wrap rounded-lg border border-border bg-muted p-1">
          <button
            type="button"
            disabled={!isOwner || saving}
            onClick={() => {
              setManualBuilderOpen(false);
              if (taxesEnabled) void turnTaxesOff();
            }}
            className={taxModeSegmentClass(activeSegment === 'off')}
          >
            {t('modeOff')}
          </button>
          <button
            type="button"
            disabled={!isOwner || enablingTaxes || officialPackAvailableResolved === false}
            title={officialPackAvailableResolved === false ? t('noOfficialPack', { country: storeCountry }) : undefined}
            onClick={() => {
              setManualBuilderOpen(false);
              if (taxMode !== 'official') void enableCountryTaxes();
            }}
            className={taxModeSegmentClass(activeSegment === 'official')}
          >
            {enablingTaxes ? t('enabling') : t('modeOfficial')}
          </button>
          <button
            type="button"
            disabled={!isOwner}
            onClick={() => setManualBuilderOpen(true)}
            className={taxModeSegmentClass(activeSegment === 'manual')}
          >
            {t('modeManual')}
          </button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {taxMode === 'off' && t('modeOffHint')}
          {taxMode === 'official' && t('modeOfficialHint', { country: storeCountry })}
          {taxMode === 'manual' && t('modeManualHint', { country: storeCountry })}
          {manualBuilderOpen && taxMode !== 'manual' && t('modeManualUnsavedHint')}
        </p>
        {countryPackUnavailable && (
          <p role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t('supportUnavailable', { country: storeCountry })}
            {pluginRequested && t('requestQueued')}
          </p>
        )}
        {taxMode === 'official' && detail?.active_version && detail.pack.publisher !== 'local' && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
            <span>
              {t('pluginVersion')} <span className="font-mono font-medium">v{detail.active_version.version}</span>
              <span className="ms-1 text-gray-400">({detail.pack.trust_status})</span>
            </span>
            <span className="ms-auto flex items-center gap-3">
              {detail.active_version.definition.sourceType === 'community' && (
                <button
                  type="button"
                  onClick={() => void reportCommunityPackIssue()}
                  disabled={reportingIssue}
                  className="flex items-center gap-1 font-medium text-amber-700 hover:text-amber-900 disabled:opacity-50"
                >
                  <AlertTriangle size={13} />
                  {t('reportIssue')}
                </button>
              )}
              {isOwner && (
                <button
                  type="button"
                  onClick={() => void reinstallPlugin()}
                  disabled={reinstallingPlugin}
                  title={t('reinstallHint')}
                  className="flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <Wrench size={13} className={reinstallingPlugin ? 'animate-spin' : ''} />
                  {reinstallingPlugin ? t('reinstalling') : t('reinstallPlugin')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void checkForPluginUpdates(true)}
                disabled={checkingUpdate}
                className="flex items-center gap-1 font-medium text-brand disabled:opacity-50"
              >
                <RefreshCw size={13} className={checkingUpdate ? 'animate-spin' : ''} />
                {checkingUpdate ? t('checking') : t('checkUpdates')}
              </button>
            </span>
          </div>
        )}
        {activePluginUpdate && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
            <span className="flex items-center gap-1.5">
              <Download size={14} className="text-brand" />
              {t('updateAvailableLabel')} <span className="font-mono font-medium">v{activePluginUpdate.latestVersion}</span>
              <span className="text-muted-foreground">{t('currentVersion', { current: activePluginUpdate.currentVersion })}</span>
            </span>
            {isOwner ? (
              <Button size="sm" disabled={installingUpdate} onClick={() => void installPluginUpdate()}>
                {installingUpdate ? t('installing') : t('installAndActivate')}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">{t('askOwnerToInstall')}</span>
            )}
          </div>
        )}
      </section>

      {manualBuilderVisible && (
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wrench size={20} className="text-brand" />
            <h3 className="font-semibold text-foreground">{t('manualBuilder')}</h3>
          </div>
          {!taxesEnabled && (
            <button type="button" onClick={() => setManualBuilderOpen(false)} className="text-sm text-gray-400 hover:text-muted-foreground">{t('hide')}</button>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('manualBuilderHint', { country: storeCountry || t('yourStore') })}
        </p>

        <div className="mt-4 space-y-3">
          {manualCategories.map((category) => (
            <div key={category.tempId} className="rounded-lg border border-border bg-muted p-3">
              <div className="flex items-center gap-2">
                <input
                  value={category.label}
                  onChange={(event) => updateManualCategoryLabel(category.tempId, event.target.value)}
                  disabled={!isOwner}
                  placeholder={t('categoryNamePlaceholder')}
                  className="flex-1 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium disabled:bg-muted"
                />
                {isOwner && manualCategories.length > 1 && (
                  <button type="button" onClick={() => removeManualCategory(category.tempId)} className="p-2 text-gray-400 hover:text-red-600" title={t('removeCategory')}>
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
                      placeholder={t('componentPlaceholder')}
                      className="flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm disabled:bg-muted"
                    />
                    <select
                      value={component.type}
                      onChange={(event) => updateManualComponent(category.tempId, component.key, { type: event.target.value as 'percent' | 'fixed' })}
                      disabled={!isOwner}
                      className="rounded-md border border-border bg-card px-2 py-1.5 text-sm disabled:bg-muted"
                    >
                      <option value="percent">%</option>
                      <option value="fixed">{t('fixed')}</option>
                    </select>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={component.value}
                      onChange={(event) => updateManualComponent(category.tempId, component.key, { value: event.target.value })}
                      disabled={!isOwner}
                      className="w-24 rounded-md border border-border bg-card px-2 py-1.5 text-sm text-end disabled:bg-muted"
                    />
                    {isOwner && category.components.length > 1 && (
                      <button type="button" onClick={() => removeManualComponent(category.tempId, component.key)} className="p-1.5 text-gray-400 hover:text-red-600" title={t('removeComponent')}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
                {isOwner && (
                  <button type="button" onClick={() => addManualComponent(category.tempId)} className="ms-4 flex items-center gap-1 text-xs font-medium text-brand">
                    <Plus size={12} /> {t('addComponent')}
                  </button>
                )}
              </div>
            </div>
          ))}
          {isOwner && (
            <button type="button" onClick={addManualCategory} className="flex items-center gap-1 text-sm font-medium text-brand">
              <Plus size={14} /> {t('addCategory')}
            </button>
          )}
        </div>

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-sm font-medium text-foreground">{t('menuPrices')}</p>
          <div className="mt-2 flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={!manualInclusive} onChange={() => setManualInclusive(false)} disabled={!isOwner} />
              {t('exclusiveLabel')}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={manualInclusive} onChange={() => setManualInclusive(true)} disabled={!isOwner} />
              {t('inclusiveLabel')}
            </label>
          </div>
        </div>

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-sm font-medium text-foreground">{t('defaultCategory')}</p>
          <p className="text-xs text-muted-foreground mb-2">{t('defaultCategoryHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {([
              ['product', t('defaultNewProducts')],
              ['packaging', t('defaultPackaging')],
              ['delivery', t('defaultDelivery')],
              ['service_charge', t('defaultServiceCharge')],
            ] as Array<[keyof ManualDefaults, string]>).map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-xs text-muted-foreground">{label}</span>
                <select
                  value={manualDefaults[key]}
                  onChange={(event) => setManualDefaults((current) => ({ ...current, [key]: event.target.value }))}
                  disabled={!isOwner}
                  className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm disabled:bg-muted"
                >
                  {manualCategories.map((category) => (
                    <option key={category.tempId} value={category.tempId}>{category.label || t('untitledCategory')}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>

        {manualOverrideConfirm && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span>{t('manualOverrideConfirm', { country: storeCountry })}</span>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" onClick={() => setManualOverrideConfirm(null)}>{t('cancel')}</Button>
              <Button disabled={manualSaving} onClick={() => void saveManualConfig(true)}>{t('replace')}</Button>
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <Button disabled={!isOwner || manualSaving} onClick={() => void saveManualConfig(false)}>
            {manualSaving ? t('saving') : manualLoaded ? t('saveManual') : t('createManual')}
          </Button>
        </div>
      </section>
      )}

      <button
        type="button"
        onClick={() => setShowAdvancedTools((value) => !value)}
        className="flex w-full items-center justify-between rounded-xl border border-border bg-card p-5 text-start"
      >
        <div>
          <h3 className="font-semibold text-foreground">{t('advancedTools')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('advancedToolsHint')}</p>
        </div>
        <ChevronDown size={18} className={`shrink-0 text-muted-foreground ${showAdvancedTools ? 'rotate-180' : ''}`} />
      </button>

      {showAdvancedTools && (
        <>
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} className="text-brand" />
            <h3 className="font-semibold text-foreground">{t('installedPacks')}</h3>
          </div>
          <span className="text-xs text-muted-foreground">{t('installedPacksHint', { country: storeCountry })}</span>
        </div>

        {selectedPack && detail ? (
          <>
            {detail.active_version ? (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Info label={t('storeCountry')} value={storeCountry} />
                  <Info label={t('jurisdiction')} value={selectedPack.jurisdiction} />
                  <Info label={t('activeVersion')} value={detail.active_version.version} />
                  <Info label={t('trustStatus')} value={detail.pack.trust_status} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
                  <span>{t('effectiveFrom', { date: detail.active_version.effective_from })}</span>
                  <span>{t('publishedAt', { date: detail.active_version.published_at })}</span>
                  <span><Ltr>{detail.active_version.definition.currency}</Ltr></span>
                  <button
                    type="button"
                    onClick={() => setExpandedChecklist((value) => !value)}
                    className="ms-auto flex items-center gap-1 font-medium text-brand"
                  >
                    {detail.active_version.validation.valid ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                    {detail.active_version.validation.valid
                      ? t('checksPassed', { passed: detail.active_version.validation.checks.filter((c) => c.passed).length, total: detail.active_version.validation.checks.length })
                      : t('checksFailed')}
                    <ChevronDown size={14} className={expandedChecklist ? 'rotate-180' : ''} />
                  </button>
                </div>
                {expandedChecklist && (
                  <ol className="mt-3 grid gap-1 rounded-lg border border-border p-3 text-xs sm:grid-cols-2">
                    {detail.active_version.validation.checks.map((check) => (
                      <li key={check.id} className={check.passed ? 'text-muted-foreground' : 'text-red-700'}>
                        {check.passed ? '✓' : '✕'} {check.id}. {check.message}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                {t('noActiveVersion')}
              </p>
            )}
            <div className="mt-5 border-t border-border pt-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">{t('installedVersions')}</p>
              </div>
              <div className="space-y-2">
                {detail.versions.map((version) => {
                  const active = version.id === detail.pack.active_version_id;
                  return (
                    <div key={version.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                      <span>
                        v{version.version}
                        <span className="ms-2 text-xs text-gray-400">{version.status}</span>
                      </span>
                      {active && <span className="text-xs font-medium text-emerald-700">{t('active')}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">{t('noActivePack')}</p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <Calculator size={20} className="text-brand" />
          <h3 className="font-semibold text-foreground">{t('testCalculation')}</h3>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t('testCalculationHint')}</p>
        {!selectedPack?.active_for_store && (
          <p className="mt-2 text-xs text-amber-700">{t('packNotActive')}</p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <select disabled={!selectedPack?.active_for_store} value={testCategoryId} onChange={(event) => setTestCategoryId(event.target.value)} className="rounded-md border border-border px-3 py-2 text-sm disabled:bg-muted">
            {detail?.categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.label}</option>)}
          </select>
          <input
            value={testAmount}
            onChange={(event) => setTestAmount(event.target.value)}
            inputMode="decimal"
            placeholder={t('amount')}
            disabled={!selectedPack?.active_for_store}
            className="rounded-md border border-border px-3 py-2 text-sm disabled:bg-muted"
          />
          <select disabled={!selectedPack?.active_for_store} value={testBehavior} onChange={(event) => setTestBehavior(event.target.value)} className="rounded-md border border-border px-3 py-2 text-sm disabled:bg-muted">
            <option value="country_default">{t('behaviorCountryDefault')}</option>
            <option value="exclusive">{t('behaviorExclusive')}</option>
            <option value="inclusive">{t('behaviorInclusive')}</option>
            <option value="exempt">{t('behaviorExempt')}</option>
          </select>
          <Button disabled={!selectedPack?.active_for_store} onClick={() => void calculate()}>{t('calculate')}</Button>
        </div>
        {calculation && (
          <div className="mt-4 rounded-lg bg-muted p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Info label={t('taxableBase')} value={calculation.taxableBase} />
              <Info label={t('tax')} value={calculation.taxAmount} />
              <Info label={t('payableTotal')} value={calculation.payableTotal} />
            </div>
            {calculation.lines[0]?.components.length > 0 && (
              <div className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
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

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={20} className="text-brand" />
          <h3 className="font-semibold text-foreground">{t('chargeCategories')}</h3>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('chargeCategoriesHint')}
        </p>
        {!selectedPack?.active_for_store && (
          <p className="mt-2 text-xs text-amber-700">{t('chargeCategoriesNotActive')}</p>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {CHARGE_TYPES.map((chargeType) => {
            const configured = detail?.overrides.find(
              (override) => override.entity_type === chargeType && override.entity_id === null,
            );
            return (
              <label key={chargeType} className="block">
                <span className="text-sm font-medium text-foreground">{t(ENTITY_LABELS[chargeType])}</span>
                <select
                  value={configured ? categoryIdOf(configured) : ''}
                  onChange={(event) => void setChargeCategory(chargeType, event.target.value)}
                  disabled={!isOwner || saving || !selectedPack?.active_for_store}
                  className="mt-2 w-full rounded-md border border-border bg-card px-3 py-2 text-sm disabled:bg-muted"
                >
                  <option value="">{t('chargeNotConfigured')}</option>
                  {detail?.categories.map((category) => (
                    <option key={category.category_id} value={category.category_id}>{category.label}</option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={20} className="text-brand" />
          <h3 className="font-semibold text-foreground">{t('merchantOverrides')}</h3>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('merchantOverridesHint')}
        </p>

        {isOwner && (
          <div className="mt-4 grid gap-3 rounded-lg border border-border bg-muted p-4 sm:grid-cols-3">
            <select
              value={entityType}
              onChange={(event) => {
                setEntityType(event.target.value as OverrideEntityType);
                setEntityId('');
              }}
              className="rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              {(['product', 'addon'] as OverrideEntityType[]).map((value) => (
                <option key={value} value={value}>{t(ENTITY_LABELS[value])}</option>
              ))}
            </select>
            {needsEntity ? (
              <select value={entityId} onChange={(event) => setEntityId(event.target.value)} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                <option value="">{t('chooseEntity', { entity: t(ENTITY_LABELS[entityType]) })}</option>
                {targetOptions.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
              </select>
            ) : (
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{t('storeWideCharge')}</div>
            )}
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
              {detail?.categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.label}</option>)}
            </select>
            <div className="flex gap-2 sm:col-span-3 sm:justify-end">
              {editingOverrideId && <Button variant="outline" onClick={resetOverrideForm}>{t('cancel')}</Button>}
              <Button disabled={saving} onClick={() => void saveOverride()}>
                <Plus size={14} /> {editingOverrideId ? t('saveOverride') : t('addOverride')}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[620px] text-start text-sm">
            <thead className="border-b border-border text-xs uppercase text-gray-400">
              <tr><th className="py-2 pe-3">{t('target')}</th><th className="py-2 pe-3">{t('category')}</th><th className="py-2 pe-3">{t('updated')}</th><th className="py-2 text-end">{t('actions')}</th></tr>
            </thead>
            <tbody>
              {detail?.overrides.map((override) => (
                <tr key={override.id} className="border-b border-gray-50">
                  <td className="py-3 pe-3"><span className="text-xs text-gray-400">{t(ENTITY_LABELS[override.entity_type])}</span><br />{override.entity_name || t('storeWide')}</td>
                  <td className="py-3 pe-3">{categoriesById.get(categoryIdOf(override)) || categoryIdOf(override)}</td>
                  <td className="py-3 pe-3 text-xs text-muted-foreground">{formatDateTime(override.updated_at)}{override.created_by_name ? ` · ${override.created_by_name}` : ''}</td>
                  <td className="py-3 text-end">
                    {isOwner ? (
                      <div className="flex justify-end gap-2">
                        {!CHARGE_TYPES.includes(override.entity_type) && (
                          <button className="text-brand hover:underline" onClick={() => editOverride(override)}>{t('edit')}</button>
                        )}
                        <button className="text-red-600 hover:underline" onClick={() => void removeOverride(override)}>{t('remove')}</button>
                      </div>
                    ) : <span className="text-xs text-gray-400">{t('readOnly')}</span>}
                  </td>
                </tr>
              ))}
              {!detail?.overrides.length && <tr><td colSpan={4} className="py-8 text-center text-gray-400">{t('noOverrides')}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-semibold text-foreground">{t('packReference')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('packReferenceHint')}</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[680px] text-start text-sm">
            <thead className="border-b border-border text-xs uppercase text-gray-400">
              <tr><th className="py-2 pe-3">{t('category')}</th><th className="py-2 pe-3">{t('defaultBehavior')}</th><th className="py-2">{t('rules')}</th></tr>
            </thead>
            <tbody>
              {detail?.categories.map((category) => (
                <tr key={category.category_id} className="border-b border-gray-50">
                  <td className="py-3 pe-3"><span className="font-medium">{category.label}</span><br /><Ltr as="code" className="text-xs text-gray-400">{category.category_id}</Ltr></td>
                  <td className="py-3 pe-3">{category.default_behavior || t('packDefault')}</td>
                  <td className="py-3 text-xs text-muted-foreground">{category.definition.ruleIds?.join(', ') || t('none')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-start text-sm">
            <thead className="border-b border-border text-xs uppercase text-gray-400">
              <tr><th className="py-2 pe-3">{t('rule')}</th><th className="py-2 pe-3">{t('type')}</th><th className="py-2 pe-3">{t('value')}</th><th className="py-2 pe-3">{t('scope')}</th><th className="py-2">{t('dependsOn')}</th></tr>
            </thead>
            <tbody>
              {detail?.rules.map((rule) => (
                <tr key={rule.rule_id} className="border-b border-gray-50">
                  <td className="py-3 pe-3"><span className="font-medium">{rule.label}</span><br /><Ltr as="code" className="text-xs text-gray-400">{rule.rule_id}</Ltr></td>
                  <td className="py-3 pe-3">{rule.calculation_type}</td>
                  <td className="py-3 pe-3">{rule.rate !== null ? `${rule.rate}%` : rule.amount}</td>
                  <td className="py-3 pe-3">{rule.applies_per}</td>
                  <td className="py-3 text-xs text-muted-foreground">{rule.base_rule_ids.join(', ') || t('none')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <History size={20} className="text-brand" />
          <h3 className="font-semibold text-foreground">{t('auditHistory')}</h3>
        </div>
        <div className="mt-4 space-y-2">
          {audit.map((row) => (
            <div key={row.id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-3">
              <Clock3 size={15} className="mt-0.5 shrink-0 text-gray-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{actionLabel(t, row.action)}</p>
                {auditDescription(row, t) && <p className="truncate text-xs text-muted-foreground">{auditDescription(row, t)}</p>}
                <p className="text-xs text-muted-foreground">{row.actor_name || (row.actor_user_id ? t('auditUnknownUser') : t('auditSystem'))} · {formatDateTime(row.created_at)}</p>
              </div>
            </div>
          ))}
          {!audit.length && <p className="py-6 text-center text-sm text-gray-400">{t('noAudit')}</p>}
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
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}
