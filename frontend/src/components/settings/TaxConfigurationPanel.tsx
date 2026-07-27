'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  ChevronDown,
  Clock3,
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

const ENTITY_LABELS: Record<OverrideEntityType, string> = {
  product: 'Product',
  addon: 'Add-on',
  packaging: 'Packaging charge',
  delivery: 'Delivery charge',
  service_charge: 'Service charge',
};
const CHARGE_TYPES: OverrideEntityType[] = ['packaging', 'delivery', 'service_charge'];

const ACTION_LABELS: Record<string, string> = {
  install_bundled_pack: 'Bundled pack installed',
  activate_pack: 'Pack activated',
  rollback_pack: 'Pack rolled back',
  create_override: 'Override added',
  update_override: 'Override edited',
  reset_override: 'Override removed',
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

function auditDescription(row: AuditRow): string {
  const details = row.details || {};
  if (row.action === 'install_bundled_pack') return `Version ${String(details.version || '')} from the application bundle`;
  if (row.action === 'create_override') {
    return `${String(details.entityType || 'target')} ${String(details.entityId || 'store-wide')} → ${String(details.categoryId || '')}`;
  }
  if (row.action === 'update_override') {
    const before = (details.before || {}) as Record<string, unknown>;
    const after = (details.after || {}) as Record<string, unknown>;
    return `${String(after.entityType || before.entityType || 'target')} ${String(after.entityId || before.entityId || 'store-wide')}: ${String(before.categoryId || '')} → ${String(after.categoryId || '')}`;
  }
  if (row.action === 'reset_override') {
    return `${String(details.entityType || 'target')} ${String(details.entityId || 'store-wide')} reset to official behavior`;
  }
  if (row.action === 'activate_pack') return `Previous version: ${String(details.previousVersionId || 'none')}`;
  if (row.action === 'rollback_pack') return `Rolled back from ${String(details.previousVersionId || 'unknown')}`;
  return '';
}

export function TaxConfigurationPanel({ isOwner }: { isOwner: boolean }) {
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
      toast.error(apiMessage(error, 'Could not load tax configuration'));
    } finally {
      setLoading(false);
    }
  }, [loadAudit, loadDetail, loadList, selectedPackId]);

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
        if (!cancelled) toast.error(apiMessage(error, 'Could not load tax configuration'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

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
        if (!cancelled) toast.error(apiMessage(error, 'Could not load tax pack details'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedPackId]);

  const selectedPack = packs.find((pack) => pack.id === selectedPackId);
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
      toast.error('Choose both a target and a tax category');
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
        toast.success('Tax override updated');
      } else {
        await api.post('/tax-packs/overrides', payload);
        toast.success('Tax override added');
      }
      resetOverrideForm();
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, 'Could not save tax override'));
    } finally {
      setSaving(false);
    }
  }

  async function removeOverride(override: TaxOverride) {
    if (!isOwner || !window.confirm(`Remove the override for ${override.entity_name || ENTITY_LABELS[override.entity_type]}?`)) return;
    setSaving(true);
    try {
      await api.delete(`/tax-packs/overrides/${override.id}`);
      toast.success('Tax override removed; official pack behavior restored');
      if (editingOverrideId === override.id) resetOverrideForm();
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, 'Could not remove tax override'));
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
        toast.success(`${ENTITY_LABELS[entityType]} restored to legacy behavior`);
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
        toast.success(`${ENTITY_LABELS[entityType]} tax category saved`);
      }
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, 'Could not save the charge tax category'));
    } finally {
      setSaving(false);
    }
  }

  async function activateVersion(versionId: string) {
    if (!isOwner || !selectedPackId) return;
    setSaving(true);
    try {
      await api.post(`/tax-packs/${selectedPackId}/versions/${versionId}/activate`);
      toast.success('Installed tax pack version activated');
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, 'Could not activate tax pack version'));
    } finally {
      setSaving(false);
    }
  }

  async function rollback() {
    if (!isOwner || !selectedPackId || !window.confirm('Roll back to the previous installed version?')) return;
    setSaving(true);
    try {
      await api.post(`/tax-packs/${selectedPackId}/rollback`);
      toast.success('Tax pack rolled back');
      await Promise.all([loadDetail(selectedPackId), loadList(), loadAudit()]);
    } catch (error) {
      toast.error(apiMessage(error, 'Could not roll back tax pack'));
    } finally {
      setSaving(false);
    }
  }

  async function calculate() {
    if (!selectedPack?.active_for_store) {
      toast.error('Select the active store-country pack to run a checkout calculation');
      return;
    }
    if (!testCategoryId || !testAmount) return;
    try {
      const response = await api.post('/tax-packs/test-calculation', {
        category_id: testCategoryId,
        amount: testAmount,
        tax_behavior: testBehavior,
      });
      setCalculation(response.data.calculation);
    } catch (error) {
      setCalculation(null);
      toast.error(apiMessage(error, 'Could not calculate tax'));
    }
  }

  if (loading && !detail) {
    return <div className="py-16 text-center text-sm text-gray-500">Loading tax configuration…</div>;
  }

  return (
    <div className="pb-6 max-w-5xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Tax configuration</h2>
          <p className="mt-1 text-sm text-gray-500">
            Review installed country packs, apply merchant overrides, and test calculations.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled title="Remote catalog support is not available yet">
            Check for updates · Not available yet
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setLoading(true);
              void refreshAll();
            }}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>
      </div>

      {!isOwner && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Lock size={16} className="mt-0.5 shrink-0" />
          Managers can review packs, overrides, audit history, and run test calculations. Only owners can make changes.
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} className="text-brand" />
            <h3 className="font-semibold text-gray-900">Installed country packs</h3>
          </div>
          {packs.length > 1 && (
            <select
              value={selectedPackId}
              onChange={(event) => setSelectedPackId(event.target.value)}
              className="rounded-md border border-gray-200 px-3 py-2 text-sm"
            >
              {packs.map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.country === '*' ? 'Generic' : pack.country} · {pack.publisher}
                  {pack.active_for_store ? ' (active)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {selectedPack && detail?.active_version ? (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Info label="Store country" value={storeCountry} />
              <Info label="Jurisdiction" value={selectedPack.jurisdiction} />
              <Info label="Active version" value={detail.active_version.version} />
              <Info label="Trust status" value={detail.pack.trust_status} />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <span>Effective {detail.active_version.effective_from}</span>
              <span>Published {detail.active_version.published_at}</span>
              <span>{detail.active_version.definition.currency}</span>
              <button
                type="button"
                onClick={() => setExpandedChecklist((value) => !value)}
                className="ml-auto flex items-center gap-1 font-medium text-brand"
              >
                {detail.active_version.validation.valid ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                {detail.active_version.validation.valid ? '24 activation checks passed' : 'Activation checks failed'}
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
            <div className="mt-5 border-t border-gray-100 pt-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-800">Installed versions</p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!isOwner || saving || detail.versions.length < 2}
                  onClick={() => void rollback()}
                  title={detail.versions.length < 2 ? 'No previous installed version is available' : undefined}
                >
                  <RotateCcw size={14} /> Roll back
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
                        <span className="text-xs font-medium text-emerald-700">Active</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!isOwner || saving}
                          onClick={() => void activateVersion(version.id)}
                        >
                          Activate installed version
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-gray-500">No active installed pack is available.</p>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <Calculator size={20} className="text-brand" />
          <h3 className="font-semibold text-gray-900">Test calculation</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">Uses the active pack and the same tax engine as checkout. It does not save a transaction.</p>
        {!selectedPack?.active_for_store && (
          <p className="mt-2 text-xs text-amber-700">This installed pack is not active for the current store. Select the active pack to test it.</p>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <select disabled={!selectedPack?.active_for_store} value={testCategoryId} onChange={(event) => setTestCategoryId(event.target.value)} className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100">
            {detail?.categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.label}</option>)}
          </select>
          <input
            value={testAmount}
            onChange={(event) => setTestAmount(event.target.value)}
            inputMode="decimal"
            placeholder="Amount"
            disabled={!selectedPack?.active_for_store}
            className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100"
          />
          <select disabled={!selectedPack?.active_for_store} value={testBehavior} onChange={(event) => setTestBehavior(event.target.value)} className="rounded-md border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-100">
            <option value="country_default">Country default</option>
            <option value="exclusive">Tax exclusive</option>
            <option value="inclusive">Tax inclusive</option>
            <option value="exempt">Exempt</option>
          </select>
          <Button disabled={!selectedPack?.active_for_store} onClick={() => void calculate()}>Calculate</Button>
        </div>
        {calculation && (
          <div className="mt-4 rounded-lg bg-gray-50 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Info label="Taxable base" value={calculation.taxableBase} />
              <Info label="Tax" value={calculation.taxAmount} />
              <Info label="Payable total" value={calculation.payableTotal} />
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
          <h3 className="font-semibold text-gray-900">Charge tax categories</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Choose the category used for each order-level charge. Unconfigured charges keep the legacy behavior and remain untaxed.
        </p>
        {!selectedPack?.active_for_store && (
          <p className="mt-2 text-xs text-amber-700">Select the active store-country pack to change charge categories.</p>
        )}
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {CHARGE_TYPES.map((chargeType) => {
            const configured = detail?.overrides.find(
              (override) => override.entity_type === chargeType && override.entity_id === null,
            );
            return (
              <label key={chargeType} className="block">
                <span className="text-sm font-medium text-gray-800">{ENTITY_LABELS[chargeType]}</span>
                <select
                  value={configured ? categoryIdOf(configured) : ''}
                  onChange={(event) => void setChargeCategory(chargeType, event.target.value)}
                  disabled={!isOwner || saving || !selectedPack?.active_for_store}
                  className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm disabled:bg-gray-100"
                >
                  <option value="">Not configured · legacy behavior</option>
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
          <h3 className="font-semibold text-gray-900">Merchant overrides</h3>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Overrides take priority over product and category assignments, but transaction exemptions still win.
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
                <option key={value} value={value}>{ENTITY_LABELS[value]}</option>
              ))}
            </select>
            {needsEntity ? (
              <select value={entityId} onChange={(event) => setEntityId(event.target.value)} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
                <option value="">Choose {ENTITY_LABELS[entityType].toLowerCase()}</option>
                {targetOptions.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
              </select>
            ) : (
              <div className="rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-500">Store-wide charge</div>
            )}
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
              {detail?.categories.map((category) => <option key={category.category_id} value={category.category_id}>{category.label}</option>)}
            </select>
            <div className="flex gap-2 sm:col-span-3 sm:justify-end">
              {editingOverrideId && <Button variant="outline" onClick={resetOverrideForm}>Cancel</Button>}
              <Button disabled={saving} onClick={() => void saveOverride()}>
                <Plus size={14} /> {editingOverrideId ? 'Save override' : 'Add override'}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pr-3">Target</th><th className="py-2 pr-3">Category</th><th className="py-2 pr-3">Updated</th><th className="py-2 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {detail?.overrides.map((override) => (
                <tr key={override.id} className="border-b border-gray-50">
                  <td className="py-3 pr-3"><span className="text-xs text-gray-400">{ENTITY_LABELS[override.entity_type]}</span><br />{override.entity_name || 'Store-wide'}</td>
                  <td className="py-3 pr-3">{categoriesById.get(categoryIdOf(override)) || categoryIdOf(override)}</td>
                  <td className="py-3 pr-3 text-xs text-gray-500">{dateTime(override.updated_at)}{override.created_by_name ? ` · ${override.created_by_name}` : ''}</td>
                  <td className="py-3 text-right">
                    {isOwner ? (
                      <div className="flex justify-end gap-2">
                        {!CHARGE_TYPES.includes(override.entity_type) && (
                          <button className="text-brand hover:underline" onClick={() => editOverride(override)}>Edit</button>
                        )}
                        <button className="text-red-600 hover:underline" onClick={() => void removeOverride(override)}>Remove</button>
                      </div>
                    ) : <span className="text-xs text-gray-400">Read only</span>}
                  </td>
                </tr>
              ))}
              {!detail?.overrides.length && <tr><td colSpan={4} className="py-8 text-center text-gray-400">No merchant overrides. Official pack behavior is in use.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="font-semibold text-gray-900">Pack reference</h3>
        <p className="mt-1 text-sm text-gray-500">Read-only categories and rules from the active installed JSON pack.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pr-3">Category</th><th className="py-2 pr-3">Default behavior</th><th className="py-2">Rules</th></tr>
            </thead>
            <tbody>
              {detail?.categories.map((category) => (
                <tr key={category.category_id} className="border-b border-gray-50">
                  <td className="py-3 pr-3"><span className="font-medium">{category.label}</span><br /><code className="text-xs text-gray-400">{category.category_id}</code></td>
                  <td className="py-3 pr-3">{category.default_behavior || 'Pack default'}</td>
                  <td className="py-3 text-xs text-gray-600">{category.definition.ruleIds?.join(', ') || 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-gray-100 text-xs uppercase text-gray-400">
              <tr><th className="py-2 pr-3">Rule</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Value</th><th className="py-2 pr-3">Scope</th><th className="py-2">Depends on</th></tr>
            </thead>
            <tbody>
              {detail?.rules.map((rule) => (
                <tr key={rule.rule_id} className="border-b border-gray-50">
                  <td className="py-3 pr-3"><span className="font-medium">{rule.label}</span><br /><code className="text-xs text-gray-400">{rule.rule_id}</code></td>
                  <td className="py-3 pr-3">{rule.calculation_type}</td>
                  <td className="py-3 pr-3">{rule.rate !== null ? `${rule.rate}%` : rule.amount}</td>
                  <td className="py-3 pr-3">{rule.applies_per}</td>
                  <td className="py-3 text-xs text-gray-600">{rule.base_rule_ids.join(', ') || 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-2">
          <History size={20} className="text-brand" />
          <h3 className="font-semibold text-gray-900">Audit history</h3>
        </div>
        <div className="mt-4 space-y-2">
          {audit.map((row) => (
            <div key={row.id} className="flex items-start gap-3 rounded-lg border border-gray-100 px-3 py-3">
              <Clock3 size={15} className="mt-0.5 shrink-0 text-gray-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-800">{ACTION_LABELS[row.action] || row.action}</p>
                {auditDescription(row) && <p className="truncate text-xs text-gray-600">{auditDescription(row)}</p>}
                <p className="text-xs text-gray-500">{row.actor_name || (row.actor_user_id ? 'Unknown user' : 'System')} · {dateTime(row.created_at)}</p>
              </div>
            </div>
          ))}
          {!audit.length && <p className="py-6 text-center text-sm text-gray-400">No tax configuration changes recorded.</p>}
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
