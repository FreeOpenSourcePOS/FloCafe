'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';

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

type CatalogEntry = {
  id: string;
  publisher: string;
  country: string;
  jurisdiction: string;
  version: string;
  publishedAt: string;
  minFloVersion: string;
  digest: string;
};

const ENTITY_LABEL_KEYS: Record<OverrideEntityType, string> = {
  product: 'settings.taxEntityProduct',
  addon: 'settings.taxEntityAddon',
  packaging: 'settings.taxEntityPackaging',
  delivery: 'settings.taxEntityDelivery',
  service_charge: 'settings.taxEntityServiceCharge',
};
const STORE_DEFAULT_KINDS: OverrideEntityType[] = [
  'product', 'addon', 'packaging', 'delivery', 'service_charge',
];

const ACTION_LABEL_KEYS: Record<string, string> = {
  install_bundled_pack: 'settings.taxAuditBundledInstalled',
  install_downloaded_pack: 'settings.taxAuditDownloadedInstalled',
  activate_pack: 'settings.taxAuditPackActivated',
  rollback_pack: 'settings.taxAuditPackRolledBack',
  create_override: 'settings.taxAuditOverrideAdded',
  update_override: 'settings.taxAuditOverrideEdited',
  reset_override: 'settings.taxAuditOverrideRemoved',
};

function apiMessage(error: unknown, fallback: string): string {
  const candidate = error as { response?: { data?: { error?: string } } };
  return candidate.response?.data?.error || fallback;
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function categoryIdOf(override: TaxOverride): string {
  return override.value?.categoryId || '';
}

export function TaxConfigurationPanel({ isOwner }: { isOwner: boolean }) {
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
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogChecked, setCatalogChecked] = useState(false);
  const [catalogEntries, setCatalogEntries] = useState<CatalogEntry[]>([]);
  const [applyAllSelect, setApplyAllSelect] = useState('');
  const [customRate, setCustomRate] = useState('');
  const [customRateError, setCustomRateError] = useState<string | null>(null);
  const [enablingTaxes, setEnablingTaxes] = useState(false);
  const [countryPackUnavailable, setCountryPackUnavailable] = useState(false);

  const entityLabel = useCallback(
    (type: OverrideEntityType) => t(ENTITY_LABEL_KEYS[type]),
    [t],
  );

  const auditDescription = useCallback(
    (row: AuditRow): string => {
      const details = row.details || {};
      if (row.action === 'install_bundled_pack') {
        return t('settings.taxAuditDescBundledInstalled', { version: String(details.version || '') });
      }
      if (row.action === 'install_downloaded_pack') {
        return t('settings.taxAuditDescDownloadedInstalled', { version: String(details.version || '') });
      }
      if (row.action === 'create_override') {
        return t('settings.taxAuditDescOverrideAdded', {
          entityType: String(details.entityType || 'target'),
          entityId: String(details.entityId || 'store-wide'),
          categoryId: String(details.categoryId || ''),
        });
      }
      if (row.action === 'update_override') {
        const before = (details.before || {}) as Record<string, unknown>;
        const after = (details.after || {}) as Record<string, unknown>;
        return t('settings.taxAuditDescOverrideEdited', {
          entityType: String(after.entityType || before.entityType || 'target'),
          entityId: String(after.entityId || before.entityId || 'store-wide'),
          before: String(before.categoryId || ''),
          after: String(after.categoryId || ''),
        });
      }
      if (row.action === 'reset_override') {
        return t('settings.taxAuditDescOverrideRemoved', {
          entityType: String(details.entityType || 'target'),
          entityId: String(details.entityId || 'store-wide'),
        });
      }
      if (row.action === 'activate_pack') {
        return t('settings.taxAuditDescActivated', {
          previousVersionId: String(details.previousVersionId || 'none'),
        });
      }
      if (row.action === 'rollback_pack') {
        return t('settings.taxAuditDescRolledBack', {
          previousVersionId: String(details.previousVersionId || 'unknown'),
        });
      }
      return '';
    },
    [t],
  );

  const loadList = useCallback(async () => {
    const response = await api.get('/tax-packs');
    const nextPacks = response.data.packs as PackSummary[];
    setPacks(nextPacks);
    setStoreCountry(response.data.store_country);
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
      toast.error(apiMessage(error, t('settings.taxLoadFailed')));
    } finally {
      setLoading(false);
    }
  }, [loadAudit, loadDetail, loadList, selectedPackId, t]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.get('/tax-packs'), api.get('/tax-packs/audit?limit=100')])
      .then(([packResponse, auditResponse]) => {
        if (cancelled) return;
        const nextPacks = packResponse.data.packs as PackSummary[];
        setPacks(nextPacks);
        setStoreCountry(packResponse.data.store_country);
        setSelectedPackId(
          nextPacks.find((pack) => pack.active_for_store)?.id || nextPacks[0]?.id || '',
        );
        setAudit(auditResponse.data.audit);
      })
      .catch((error) => {
        if (!cancelled) toast.error(apiMessage(error, t('settings.taxLoadFailed')));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [t]);

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
        if (!cancelled) toast.error(apiMessage(error, t('settings.taxLoadDetailFailed')));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedPackId, t]);

  const selectedPack = packs.find((pack) => pack.id === selectedPackId);
  const activeCountryPack = packs.find(
    (pack) => pack.country === storeCountry && pack.active_for_store,
  );
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

  // Map category → display label that includes its rate (e.g. "Standard · 21%").
  // Map category → its rate string. Built once per render so the dispatcher
  // doesn't re-scan `detail.rules` for every category it considers.
  const categoryRateById: Map<string, string> = (() => {
    const map = new Map<string, string>();
    if (!detail?.categories || !detail?.rules) return map;
    for (const category of detail.categories) {
      const categoryEntry = detail.categories.find((entry) => entry.category_id === category.category_id);
      const ruleIds = Array.isArray(categoryEntry?.definition?.ruleIds) ? categoryEntry!.definition!.ruleIds : [];
      const rule = detail.rules.find((candidate) => (
        ruleIds.includes(candidate.rule_id)
        || (Array.isArray(candidate.definition?.categoryIds) && candidate.definition!.categoryIds!.includes(category.category_id))
      ));
      const rate = rule?.rate;
      map.set(category.category_id, rate !== null && rate !== undefined ? rate : '');
    }
    return map;
  })();

  // Map category → display label that includes its rate (e.g. "Standard · 21%").
  const categoryRateLabel: Map<string, string> = (() => {
    const map = new Map<string, string>();
    if (!detail?.categories) return map;
    for (const category of detail.categories) {
      const rate = categoryRateById.get(category.category_id);
      map.set(category.category_id, rate ? `${category.label} · ${rate}%` : category.label);
    }
    return map;
  })();

  // Pack default category for products (Argentina = "standard"). Used to
  // pre-select the "Default for all" dropdown so the user sees what value
  // will be applied without having to pick.
  const packDefaultCategoryId = (
    (detail?.active_version?.definition as unknown as { defaultCategories?: Record<string, string> })?.defaultCategories
  )?.product
    ?? '';

  // Look up the rate (as a string, e.g. "21" or "10.5") for a given pack
  // category. Used by the typed-rate input and the dispatcher.
  function getCategoryRate(categoryId: string): string {
    return categoryRateById.get(categoryId) ?? '';
  }

  // Update the input to mirror the selected category's rate when the dropdown
  // changes, so the user sees what value the picked category actually has.
  function handleApplyAllSelectChange(nextCategoryId: string) {
    setApplyAllSelect(nextCategoryId);
    const rate = getCategoryRate(nextCategoryId);
    setCustomRate(rate);
    setCustomRateError(null);
  }

  // The input shows user input when present; otherwise it reflects the rate
  // of the currently selected category (or the pack default). Computed so the
  // user always sees the value that will be applied.
  const displayedRate = customRate
    || getCategoryRate(applyAllSelect || packDefaultCategoryId);

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
      toast.error(t('settings.taxChooseTargetAndCategory'));
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
        toast.success(t('settings.taxOverrideUpdated'));
      } else {
        await api.post('/tax-packs/overrides', payload);
        toast.success(t('settings.taxOverrideAdded'));
      }
      resetOverrideForm();
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('settings.taxOverrideSaveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function removeOverride(override: TaxOverride) {
    if (!isOwner) return;
    const label = override.entity_name || entityLabel(override.entity_type);
    if (!window.confirm(t('settings.taxRemoveOverrideConfirm', { entity: label }))) return;
    setSaving(true);
    try {
      await api.delete(`/tax-packs/overrides/${override.id}`);
      toast.success(t('settings.taxOverrideRemoved'));
      if (editingOverrideId === override.id) resetOverrideForm();
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('settings.taxOverrideRemoveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function setChargeCategory(entityType: OverrideEntityType, nextCategoryId: string) {
    if (!isOwner || !selectedPack?.active_for_store || !STORE_DEFAULT_KINDS.includes(entityType)) return;
    const current = detail?.overrides.find(
      (override) => override.entity_type === entityType && override.entity_id === null,
    );
    const label = entityLabel(entityType);
    setSaving(true);
    try {
      if (!nextCategoryId) {
        if (current) await api.delete(`/tax-packs/overrides/${current.id}`);
        toast.success(t('settings.taxStoreWideDefaultRestored', { entity: label }));
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
        toast.success(t('settings.taxStoreWideDefaultSaved', { entity: label }));
      }
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('settings.taxStoreWideDefaultSaveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function applyToAll() {
    if (!isOwner || !selectedPack?.active_for_store || !applyAllSelect) return;
    const categoryLabel = detail?.categories.find((category) => category.category_id === applyAllSelect)?.label;
    setSaving(true);
    try {
      for (const kind of STORE_DEFAULT_KINDS) {
        const current = detail?.overrides.find(
          (override) => override.entity_type === kind && override.entity_id === null,
        );
        const payload = { entity_type: kind, entity_id: null, category_id: applyAllSelect };
        if (current) {
          await api.put(`/tax-packs/overrides/${current.id}`, payload);
        } else {
          await api.post('/tax-packs/overrides', payload);
        }
      }
      setApplyAllSelect('');
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
      toast.success(t('settings.taxApplyToAllSuccess', { category: categoryLabel || applyAllSelect }));
    } catch (error) {
      toast.error(apiMessage(error, t('settings.taxStoreWideDefaultSaveFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function applyCustomRate() {
    const rateNumber = Number(customRate);
    if (!customRate || !Number.isFinite(rateNumber) || rateNumber <= 0 || rateNumber > 100) {
      setCustomRateError(t('settings.taxCustomRateInvalid'));
      return;
    }
    setSaving(true);
    try {
      const response = await api.post('/tax-packs/merchant-rate', { rate: customRate });
      setCustomRate('');
      setCustomRateError(null);
      setApplyAllSelect(response.data?.categoryId || '');
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
      toast.success(t('settings.taxApplyToAllSuccess', { category: `Custom ${response.data?.rate}%` }));
    } catch (error: unknown) {
      const errorMessage = (error as { response?: { data?: { error?: string } } })?.response?.data?.error
        || t('settings.taxStoreWideDefaultSaveFailed');
      setCustomRateError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setSaving(false);
    }
  }

  function applySelectOrCustom() {
    const value = (customRate || displayedRate).trim();
    const selectedCategoryId = applyAllSelect || packDefaultCategoryId;
    const selectedRate = getCategoryRate(selectedCategoryId);

    // Input matches the selected category's rate → use the selected category.
    if (value && value === selectedRate) {
      return applyToAll();
    }

    // Input matches a different existing category's rate → switch to that
    // category and apply. Avoids creating a duplicate merchant category when
    // the typed value already exists in the pack.
    if (value && detail?.categories) {
      const match = detail.categories.find((category) => getCategoryRate(category.category_id) === value);
      if (match) {
        setApplyAllSelect(match.category_id);
        return applyToAll();
      }
    }

    // Input is a new rate → create a merchant category from the typed value.
    if (value) {
      return applyCustomRate();
    }

    // No input → apply the selected category (or pack default).
    return applyToAll();
  }

  async function activateVersion(versionId: string) {
    if (!isOwner || !selectedPackId) return;
    setSaving(true);
    try {
      await api.post(`/tax-packs/${selectedPackId}/versions/${versionId}/activate`);
      toast.success(t('settings.taxVersionActivated'));
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('settings.taxVersionActivateFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function rollback() {
    if (!isOwner || !selectedPackId) return;
    if (!window.confirm(t('settings.taxRollbackConfirm'))) return;
    setSaving(true);
    try {
      await api.post(`/tax-packs/${selectedPackId}/rollback`);
      toast.success(t('settings.taxRolledBack'));
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, t('settings.taxRollbackFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function checkForUpdates() {
    setCatalogLoading(true);
    try {
      const response = await api.get('/tax-packs/catalog');
      const available = response.data.available as CatalogEntry[];
      setCatalogEntries(available);
      setCatalogChecked(true);
      if (available.length === 0) toast.success(t('settings.taxUpToDate'));
    } catch (error) {
      setCatalogEntries([]);
      setCatalogChecked(true);
      toast.error(apiMessage(error, t('settings.taxCheckUpdatesFailed')));
    } finally {
      setCatalogLoading(false);
    }
  }

  async function installCatalogPack(entry: CatalogEntry) {
    if (!isOwner) return;
    setSaving(true);
    try {
      await api.post('/tax-packs/catalog/install', {
        pack_id: entry.id,
        version: entry.version,
      });
      toast.success(t('settings.taxPackInstalled', { id: entry.id, version: entry.version }));
      setCatalogEntries((current) => current.filter(
        (candidate) => candidate.id !== entry.id || candidate.version !== entry.version,
      ));
      setSelectedPackId(entry.id);
      await Promise.all([loadList(), loadAudit(), loadDetail(entry.id)]);
    } catch (error) {
      toast.error(apiMessage(error, t('settings.taxPackInstallFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function enableCountryTaxes() {
    if (!isOwner || !storeCountry) return;
    setEnablingTaxes(true);
    setCountryPackUnavailable(false);
    try {
      const installedPack = packs.find((pack) => pack.country === storeCountry);
      const installedVersion = installedPack?.versions
        .slice()
        .sort((left, right) => right.published_at.localeCompare(left.published_at))[0];

      let packId = installedPack?.id;
      let versionId = installedVersion?.id;
      let version = installedVersion?.version;

      if (!packId || !versionId) {
        const response = await api.get('/tax-packs/catalog');
        const available = response.data.available as CatalogEntry[];
        setCatalogEntries(available);
        setCatalogChecked(true);
        const entry = available
          .filter((candidate) => candidate.country === storeCountry)
          .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))[0];
        if (!entry) {
          setCountryPackUnavailable(true);
          return;
        }
        const installResponse = await api.post('/tax-packs/catalog/install', {
          pack_id: entry.id,
          version: entry.version,
        });
        packId = installResponse.data.installed.packId;
        versionId = installResponse.data.installed.versionId;
        version = installResponse.data.installed.version;
        setCatalogEntries((current) => current.filter(
          (candidate) => candidate.id !== entry.id || candidate.version !== entry.version,
        ));
      }

      if (!packId || !versionId || !version) {
        throw new Error(t('settings.taxPackNoInstallable'));
      }
      await api.post(
        `/tax-packs/${encodeURIComponent(packId)}/versions/${encodeURIComponent(versionId)}/activate`,
      );
      setSelectedPackId(packId);
      await Promise.all([loadList(), loadAudit(), loadDetail(packId)]);
      toast.success(t('settings.taxEnabledWith', { id: packId, version }));
    } catch (error) {
      toast.error(apiMessage(error, t('settings.taxEnableTaxesFailed')));
    } finally {
      setEnablingTaxes(false);
    }
  }

  async function calculate() {
    if (!selectedPack?.active_for_store) {
      toast.error(t('settings.taxNeedActivePack'));
      return;
    }
    const amountNum = Number(testAmount);
    if (!testCategoryId || !testAmount || isNaN(amountNum) || amountNum <= 0) {
      toast.error(t('settings.taxInvalidAmount'));
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
      toast.error(apiMessage(error, t('settings.taxCalculateFailed')));
    }
  }

  if (loading && !detail) {
    return <div className="py-16 text-center text-sm text-gray-500">{t('settings.taxLoading')}</div>;
  }

  return (
    <div className="pb-6 max-w-5xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{t('settings.taxConfiguration')}</h2>
          <p className="mt-1 text-sm text-gray-500">{t('settings.taxConfigSubtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => void checkForUpdates()}
            disabled={catalogLoading}
          >
            <RefreshCw size={15} className={catalogLoading ? 'animate-spin' : ''} />
            {catalogLoading ? t('settings.taxChecking') : t('settings.taxCheckForUpdates')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setLoading(true);
              void refreshAll();
            }}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> {t('settings.taxRefresh')}
          </Button>
        </div>
      </div>

      {!isOwner && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Lock size={16} className="mt-0.5 shrink-0" />
          {t('settings.taxManagerNotice')}
        </div>
      )}

      {!activeCountryPack && (
        <section className="rounded-xl border border-blue-200 bg-blue-50 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">{t('settings.taxNotEnabledTitle')}</h3>
              <p className="mt-1 text-sm text-gray-600">
                {t('settings.taxNotEnabledBody', { country: storeCountry })}
              </p>
            </div>
            <Button
              onClick={() => void enableCountryTaxes()}
              disabled={!isOwner || enablingTaxes}
              title={!isOwner ? t('settings.taxOwnerOnlyEnable') : undefined}
              className="shrink-0"
            >
              <Download size={15} />
              {enablingTaxes ? t('settings.taxEnabling') : t('settings.taxEnableTaxes')}
            </Button>
          </div>
          {countryPackUnavailable && (
            <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {t('settings.taxCountryPackUnavailable', { country: storeCountry })}
            </p>
          )}
        </section>
      )}

      {catalogChecked && (
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Download size={20} className="text-brand" />
              <div>
                <h3 className="font-semibold text-gray-900">{t('settings.taxAvailablePacks')}</h3>
                <p className="text-sm text-gray-500">{t('settings.taxAvailablePacksHint')}</p>
              </div>
            </div>
          </div>
          {catalogEntries.length > 0 ? (
            <div className="mt-4 space-y-2">
              {catalogEntries.map((entry) => (
                <div
                  key={`${entry.id}@${entry.version}`}
                  className="flex flex-col gap-3 rounded-lg border border-gray-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {entry.id} · v{entry.version}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {entry.country === '*' ? t('settings.taxGeneric') : entry.country}
                      {' · '}{entry.publisher}
                      {' · '}{t('settings.taxPublished', { date: entry.publishedAt })}
                      {' · '}{t('settings.taxRequiresFlo', { version: entry.minFloVersion })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!isOwner || saving}
                    onClick={() => void installCatalogPack(entry)}
                    title={!isOwner ? t('settings.taxOwnerOnlyInstall') : undefined}
                  >
                    <Download size={14} /> {t('settings.taxVerifyAndInstall')}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-gray-500">{t('settings.taxNoUpdates')}</p>
          )}
        </section>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} className="text-brand" />
            <h3 className="font-semibold text-gray-900">{t('settings.taxInstalledCountryPacks')}</h3>
          </div>
          {packs.length > 1 && (
            <select
              value={selectedPackId}
              onChange={(event) => setSelectedPackId(event.target.value)}
              className="rounded-md border border-gray-200 px-3 py-2 text-sm"
            >
              {packs.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.country === '*' ? t('settings.taxGeneric') : pack.country} · {pack.publisher}
                  {pack.active_for_store ? ` (${t('common.active')})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {selectedPack && detail ? (
          <>
            {detail.active_version ? (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Info label={t('settings.taxStoreCountry')} value={storeCountry} />
                  <Info label={t('settings.taxJurisdiction')} value={selectedPack.jurisdiction} />
                  <Info label={t('settings.taxActiveVersion')} value={detail.active_version.version} />
                  <Info label={t('settings.taxTrustStatus')} value={detail.pack.trust_status} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                  <span>{t('settings.taxEffective', { date: detail.active_version.effective_from })}</span>
                  <span>{t('settings.taxPublished', { date: detail.active_version.published_at })}</span>
                  <span>{detail.active_version.definition.currency}</span>
                  <button
                    type="button"
                    onClick={() => setExpandedChecklist((value) => !value)}
                    className="ml-auto flex items-center gap-1 font-medium text-brand"
                  >
                    {detail.active_version.validation.valid ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                    {detail.active_version.validation.valid
                      ? t('settings.taxActivationChecksPassed', {
                          passed: detail.active_version.validation.checks.filter((c) => c.passed).length,
                          total: detail.active_version.validation.checks.length,
                        })
                      : t('settings.taxActivationChecksFailed')}
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
              <p className="mt-4 text-sm text-gray-500">{t('settings.taxNoActiveVersion')}</p>
            )}
            <div className="mt-5 border-t border-gray-100 pt-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-800">{t('settings.taxInstalledVersions')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isOwner || saving || detail.versions.length < 2}
                  onClick={() => void rollback()}
                  title={detail.versions.length < 2 ? t('settings.taxNoPreviousVersion') : undefined}
                >
                  <RotateCcw size={14} /> {t('settings.taxRollback')}
                </Button>
              </div>
              <div className="space-y-2">
                {detail.versions.map((version) => {
                  const active = version.id === detail.pack.active_version_id;
                  return (
                    <div key={version.id} className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 text-sm">
                      <span>
                        v{version.version}
                        <span className="ml-2 text-xs text-gray-400">{version.status}</span>
                      </span>
                      {active ? (
                        <span className="text-xs font-medium text-emerald-700">{t('common.active')}</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!isOwner || saving}
                          onClick={() => void activateVersion(version.id)}
                        >
                          {t('settings.taxActivateVersion')}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-gray-500">{t('settings.taxNoActivePack')}</p>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <Calculator size={20} className="text-brand" />
          <h3 className="font-semibold text-gray-900">{t('settings.taxTestCalculation')}</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">{t('settings.taxTestCalculationHint')}</p>
        {!selectedPack?.active_for_store && (
          <p className="mt-2 text-xs text-amber-700">{t('settings.taxNotActivePackTest')}</p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <select disabled={!selectedPack?.active_for_store} value={testCategoryId} onChange={(event) => setTestCategoryId(event.target.value)} className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100">
            {detail?.categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.label}</option>)}
          </select>
          <input
            value={testAmount}
            onChange={(event) => setTestAmount(event.target.value)}
            inputMode="decimal"
            placeholder={t('settings.taxTaxableBase')}
            disabled={!selectedPack?.active_for_store}
            className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100"
          />
          <select disabled={!selectedPack?.active_for_store} value={testBehavior} onChange={(event) => setTestBehavior(event.target.value)} className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100">
            <option value="country_default">{t('settings.taxCountryDefault')}</option>
            <option value="exclusive">{t('settings.taxExclusive')}</option>
            <option value="inclusive">{t('settings.taxInclusive')}</option>
            <option value="exempt">{t('settings.taxExempt')}</option>
          </select>
          <Button disabled={!selectedPack?.active_for_store} onClick={() => void calculate()}>{t('settings.taxCalculate')}</Button>
        </div>
        {calculation && (
          <div className="mt-4 rounded-lg bg-gray-50 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Info label={t('settings.taxTaxableBase')} value={calculation.taxableBase} />
              <Info label={t('common.tax')} value={calculation.taxAmount} />
              <Info label={t('settings.taxPayableTotal')} value={calculation.payableTotal} />
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
          <h3 className="font-semibold text-gray-900">{t('settings.taxStoreWideDefaults')}</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">{t('settings.taxStoreWideDefaultsHint')}</p>
        {!selectedPack?.active_for_store && (
          <p className="mt-2 text-xs text-amber-700">{t('settings.taxNeedActivePackDefaults')}</p>
        )}

        <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50 p-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-800">{t('settings.taxApplyToAll')}</span>
            <p className="mt-0.5 text-xs text-gray-500">{t('settings.taxApplyToAllHint')}</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <select
                value={applyAllSelect || packDefaultCategoryId || ''}
                onChange={(event) => handleApplyAllSelectChange(event.target.value)}
                disabled={!isOwner || saving || !selectedPack?.active_for_store}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm disabled:bg-gray-100 sm:flex-1"
              >
                <option value="">—</option>
                {detail?.categories
                  .filter((category) => Boolean(getCategoryRate(category.category_id)))
                  .map((category) => (
                    <option key={category.category_id} value={category.category_id}>
                      {categoryRateLabel.get(category.category_id) || category.label}
                    </option>
                  ))}
              </select>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  max="100"
                  step="0.01"
                  value={customRate || displayedRate}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCustomRate(value);
                    setCustomRateError(null);
                    // If the typed value matches an existing category's rate,
                    // switch the dropdown to that category so the user sees
                    // the canonical pick.
                    if (value && detail?.categories) {
                      const match = detail.categories.find((category) => getCategoryRate(category.category_id) === value);
                      if (match) setApplyAllSelect(match.category_id);
                    }
                  }}
                  placeholder="—"
                  disabled={!isOwner || saving || !selectedPack?.active_for_store}
                  aria-label={t('settings.taxCustomRate')}
                  className="w-24 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm disabled:bg-gray-100"
                />
                <span className="text-sm font-medium text-gray-600">%</span>
              </div>
              <Button
                disabled={!isOwner || saving || !selectedPack?.active_for_store || !(customRate || applyAllSelect || packDefaultCategoryId)}
                onClick={() => void applySelectOrCustom()}
                className="shrink-0"
              >
                {t('settings.taxApplyToAllButton')}
              </Button>
            </div>
            {customRateError && (
              <p className="mt-2 text-xs text-red-700">{customRateError}</p>
            )}
          </label>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STORE_DEFAULT_KINDS.map((kind) => {
            const configured = detail?.overrides.find(
              (override) => override.entity_type === kind && override.entity_id === null,
            );
            return (
              <label key={kind} className="block">
                <span className="text-sm font-medium text-gray-800">{entityLabel(kind)}</span>
                <select
                  value={configured ? categoryIdOf(configured) : ''}
                  onChange={(event) => void setChargeCategory(kind, event.target.value)}
                  disabled={!isOwner || saving || !selectedPack?.active_for_store}
                  className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm disabled:bg-gray-100"
                >
                  <option value="">{t('settings.taxNotConfigured')}</option>
                  {detail?.categories.map((category) => (
                    <option key={category.category_id} value={category.category_id}>
                      {categoryRateLabel.get(category.category_id) || category.label}
                    </option>
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
          <h3 className="font-semibold text-gray-900">{t('settings.taxMerchantOverrides')}</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">{t('settings.taxMerchantOverridesHint')}</p>

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
                <option key={value} value={value}>{entityLabel(value)}</option>
              ))}
            </select>
            {needsEntity ? (
              <select value={entityId} onChange={(event) => setEntityId(event.target.value)} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
                <option value="">{t('settings.taxChooseTarget', { entity: entityLabel(entityType).toLowerCase() })}</option>
                {targetOptions.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
              </select>
            ) : (
              <div className="rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-500">{t('settings.taxStoreWideCharge')}</div>
            )}
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
              {detail?.categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.label}</option>)}
            </select>
            <div className="flex gap-2 sm:col-span-3 sm:justify-end">
              {editingOverrideId && <Button variant="outline" onClick={resetOverrideForm}>{t('common.cancel')}</Button>}
              <Button disabled={saving} onClick={() => void saveOverride()}>
                <Plus size={14} /> {editingOverrideId ? t('settings.taxSaveOverride') : t('settings.taxAddOverride')}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pr-3">{t('settings.taxTarget')}</th><th className="py-2 pr-3">{t('settings.taxCategory')}</th><th className="py-2 pr-3">{t('settings.taxUpdated')}</th><th className="py-2 text-right">{t('settings.taxActions')}</th></tr>
            </thead>
            <tbody>
              {detail?.overrides.map((override) => (
                <tr key={override.id} className="border-b border-gray-50">
                  <td className="py-3 pr-3"><span className="text-xs text-gray-400">{entityLabel(override.entity_type)}</span><br />{override.entity_name || t('settings.taxStoreWide')}</td>
                  <td className="py-3 pr-3">{categoriesById.get(categoryIdOf(override)) || categoryIdOf(override)}</td>
                  <td className="py-3 pr-3 text-xs text-gray-500">{dateTime(override.updated_at)}{override.created_by_name ? ` · ${override.created_by_name}` : ''}</td>
                  <td className="py-3 text-right">
                    {isOwner ? (
                      <div className="flex justify-end gap-2">
                        {override.entity_id !== null && (
                          <button className="text-brand hover:underline" onClick={() => editOverride(override)}>{t('common.edit')}</button>
                        )}
                        <button className="text-red-600 hover:underline" onClick={() => void removeOverride(override)}>{t('common.remove')}</button>
                      </div>
                    ) : <span className="text-xs text-gray-400">{t('settings.taxReadOnly')}</span>}
                  </td>
                </tr>
              ))}
              {!detail?.overrides.length && <tr><td colSpan={4} className="py-8 text-center text-gray-400">{t('settings.taxNoOverrides')}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">{t('settings.taxPackReference')}</h3>
        <p className="mt-1 text-sm text-gray-500">{t('settings.taxPackReferenceHint')}</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pr-3">{t('settings.taxCategory')}</th><th className="py-2 pr-3">{t('settings.taxDefaultBehavior')}</th><th className="py-2">{t('settings.taxRules')}</th></tr>
            </thead>
            <tbody>
              {detail?.categories.map((category) => (
                <tr key={category.category_id} className="border-b border-gray-50">
                  <td className="py-3 pr-3"><span className="font-medium">{category.label}</span><br /><code className="text-xs text-gray-400">{category.category_id}</code></td>
                  <td className="py-3 pr-3">{category.default_behavior || t('settings.taxPackDefault')}</td>
                  <td className="py-3 text-xs text-gray-600">{category.definition.ruleIds?.join(', ') || t('settings.taxNone')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pr-3">{t('settings.taxRule')}</th><th className="py-2 pr-3">{t('settings.taxType')}</th><th className="py-2 pr-3">{t('settings.taxValue')}</th><th className="py-2 pr-3">{t('settings.taxScope')}</th><th className="py-2">{t('settings.taxDependsOn')}</th></tr>
            </thead>
            <tbody>
              {detail?.rules.map((rule) => (
                <tr key={rule.rule_id} className="border-b border-gray-50">
                  <td className="py-3 pr-3"><span className="font-medium">{rule.label}</span><br /><code className="text-xs text-gray-400">{rule.rule_id}</code></td>
                  <td className="py-3 pr-3">{rule.calculation_type}</td>
                  <td className="py-3 pr-3">{rule.rate !== null ? `${rule.rate}%` : rule.amount}</td>
                  <td className="py-3 pr-3">{rule.applies_per}</td>
                  <td className="py-3 text-xs text-gray-600">{rule.base_rule_ids.join(', ') || t('settings.taxNone')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <History size={20} className="text-brand" />
          <h3 className="font-semibold text-gray-900">{t('settings.taxAuditHistory')}</h3>
        </div>
        <div className="mt-4 space-y-2">
          {audit.map((row) => (
            <div key={row.id} className="flex items-start gap-3 rounded-lg border border-gray-100 px-3 py-3">
              <Clock3 size={15} className="mt-0.5 shrink-0 text-gray-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800">{t(ACTION_LABEL_KEYS[row.action] || row.action)}</p>
                {auditDescription(row) && <p className="truncate text-xs text-gray-600">{auditDescription(row)}</p>}
                <p className="text-xs text-gray-500">{row.actor_name || (row.actor_user_id ? t('settings.taxUnknownUser') : t('settings.taxSystem'))} · {dateTime(row.created_at)}</p>
              </div>
            </div>
          ))}
          {!audit.length && <p className="py-6 text-center text-sm text-gray-400">{t('settings.taxNoAudit')}</p>}
        </div>
      </section>
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
