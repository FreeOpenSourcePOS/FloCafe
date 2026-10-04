'use client';

import { useEffect, useState } from 'react';
import { Percent, Plus, Trash2, Pencil } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useConfirm } from '@/hooks/use-confirm';
import { ORDER_TYPE_LABEL_KEYS, type OrderType } from '@/lib/order-types';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { VALID_CHARGE_ORDER_TYPES, type ChargeDefinition } from '@/lib/charges';
import { useChargesStore } from '@/store/charges';

interface ChargeForm {
  id: string;
  name: string;
  type: 'percentage' | 'fixed';
  value: string;
  calculation_basis: 'net' | 'gross';
  order_types: OrderType[];
  is_optional: boolean;
  is_default_active: boolean;
}

function emptyForm(): ChargeForm {
  return {
    id: '',
    name: '',
    type: 'percentage',
    value: '',
    calculation_basis: 'gross',
    order_types: ['dine_in'],
    is_optional: false,
    is_default_active: true,
  };
}

function toForm(charge: ChargeDefinition): ChargeForm {
  return {
    id: charge.id,
    name: charge.name,
    type: charge.type,
    value: String(charge.value),
    calculation_basis: charge.calculation_basis,
    order_types: [...charge.order_types] as OrderType[],
    is_optional: charge.is_optional,
    is_default_active: charge.is_default_active,
  };
}

function toDefinition(form: ChargeForm, existing?: ChargeDefinition): ChargeDefinition {
  // A blank id falls back to the name so the form never submits an empty id.
  const rawId = (form.id.trim() || form.name).trim();
  const normalizedId = rawId.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return {
    id: !form.id.trim() && !/[a-z0-9]/.test(normalizedId)
      ? `charge-${globalThis.crypto.randomUUID()}`
      : normalizedId,
    name: form.name.trim(),
    type: form.type,
    value: Number(form.value),
    calculation_basis: form.calculation_basis,
    order_types: form.order_types,
    is_optional: form.is_optional,
    is_default_active: form.is_default_active,
    tax_category_id: existing?.tax_category_id ?? null,
    is_active: existing?.is_active ?? true,
  };
}

export function ChargesSettingsCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('settings');
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const { confirm, ConfirmDialog } = useConfirm();

  const charges = useChargesStore((s) => s.charges);
  const loading = useChargesStore((s) => s.loading);
  const loadError = useChargesStore((s) => s.error);
  const load = useChargesStore((s) => s.load);
  const save = useChargesStore((s) => s.save);

  const [editing, setEditing] = useState<ChargeForm | null>(null);
  const [editingOriginalId, setEditingOriginalId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [duplicateId, setDuplicateId] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (next: ChargeDefinition[]) => {
    if (loading || loadError) return;
    setSaving(true);
    try {
      await save(next);
      toast.success(t('chargesSaved'));
    } catch {
      toast.error(t('chargesSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const removeCharge = async (charge: ChargeDefinition) => {
    if (loading || loadError) return;
    const ok = await confirm(t('deleteChargeConfirm', { name: charge.name }), {
      destructive: true,
      confirmLabel: tCommon('delete'),
    });
    if (!ok) return;
    await persist(charges.filter((candidate) => candidate.id !== charge.id));
  };

  const submitForm = async () => {
    if (!editing || loading || loadError) return;
    const existing = editingOriginalId ? charges.find((charge) => charge.id === editingOriginalId) : undefined;
    const definition = toDefinition(editing, existing);
    if (charges.some((charge) => charge.id === definition.id && charge.id !== editingOriginalId)) {
      setDuplicateId(true);
      return;
    }
    // Editing replaces the row it came from, so renaming the id renames that
    // charge instead of adding a second one beside it.
    const targetId = editingOriginalId && charges.some((charge) => charge.id === editingOriginalId)
      ? editingOriginalId
      : definition.id;
    const next = charges.some((charge) => charge.id === targetId)
      ? charges.map((charge) => (charge.id === targetId ? definition : charge))
      : [...charges, definition];
    setSaving(true);
    try {
      await save(next);
      setEditing(null);
      setEditingOriginalId(null);
      toast.success(t('chargesSaved'));
    } catch {
      toast.error(t('chargesSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const closeForm = () => {
    setEditing(null);
    setEditingOriginalId(null);
    setDuplicateId(false);
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          <Percent size={20} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">{t('chargesAndSurcharges')}</h2>
        </div>
        {canManage && (
          <Button size="sm" disabled={loading || !!loadError} onClick={() => { setEditing(emptyForm()); setEditingOriginalId(null); }}>
            <Plus size={14} className="me-1" /> {t('addCharge')}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-4">{t('chargesAndSurchargesHint')}</p>

      {loadError && (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <span>{t('reloadFailed')}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      )}

      {charges.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noChargesConfigured')}</p>
      ) : (
        <div className="space-y-2">
          {charges.map((charge) => (
            <div key={charge.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{charge.name}</p>
                <p className="text-xs text-muted-foreground">
                  {charge.type === 'percentage'
                    ? t('chargePercentValue', { value: charge.value })
                    : t('chargeFixedValue', { value: fmt(charge.value) })}
                  {' · '}
                  {charge.calculation_basis === 'net' ? t('chargeBasisNet') : t('chargeBasisGross')}
                  {' · '}
                  {charge.order_types.map((type) => tOrders(ORDER_TYPE_LABEL_KEYS[type])).join(', ')}
                  {charge.is_optional ? ` · ${t('chargeWaivable')}` : ''}
                  {!charge.is_default_active ? ` · ${t('chargeOptionalApply')}` : ''}
                </p>
              </div>
              {canManage && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="ghost" aria-label={tCommon('edit')} disabled={loading || !!loadError} onClick={() => { setEditing(toForm(charge)); setEditingOriginalId(charge.id); }}>
                    <Pencil size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={tCommon('delete')} disabled={loading || !!loadError} onClick={() => void removeCharge(charge)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) closeForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('addCharge')}</DialogTitle>
            <DialogDescription>{t('chargesAndSurchargesHint')}</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <label className="block">
                <span className="text-sm text-muted-foreground">{t('chargeName')}</span>
                <input
                  value={editing.name}
                  onChange={(e) => { setEditing({ ...editing, name: e.target.value }); setDuplicateId(false); }}
                  className="w-full mt-1 px-3 py-2 text-sm border border-border bg-background rounded-lg"
                />
              </label>
              <label className="block">
                <span className="text-sm text-muted-foreground">{t('chargeId')}</span>
                <input
                  value={editing.id}
                  onChange={(e) => { setEditing({ ...editing, id: e.target.value }); setDuplicateId(false); }}
                  placeholder="service_charge"
                  aria-invalid={duplicateId}
                  className="w-full mt-1 px-3 py-2 text-sm border border-border bg-background rounded-lg"
                />
                <span className="text-xs text-muted-foreground">{t('chargeIdHint')}</span>
                {duplicateId && <span role="alert" className="block text-xs text-destructive">{t('chargesSaveFailed')}</span>}
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-sm text-muted-foreground">{t('chargeType')}</span>
                  <select
                    value={editing.type}
                    onChange={(e) => setEditing({ ...editing, type: e.target.value as ChargeForm['type'] })}
                    className="w-full mt-1 px-3 py-2 text-sm border border-border bg-background rounded-lg"
                  >
                    <option value="percentage">{t('chargeTypePercentage')}</option>
                    <option value="fixed">{t('chargeTypeFixed')}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-sm text-muted-foreground">{t('chargeValue')}</span>
                  <input
                    type="number"
                    min={0}
                    max={editing.type === 'percentage' ? 100 : undefined}
                    value={editing.value}
                    onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                    className="w-full mt-1 px-3 py-2 text-sm border border-border bg-background rounded-lg"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-sm text-muted-foreground">{t('chargeBasis')}</span>
                <select
                  value={editing.calculation_basis}
                  onChange={(e) => setEditing({ ...editing, calculation_basis: e.target.value as ChargeForm['calculation_basis'] })}
                  className="w-full mt-1 px-3 py-2 text-sm border border-border bg-background rounded-lg"
                >
                  <option value="gross">{t('chargeBasisGross')}</option>
                  <option value="net">{t('chargeBasisNet')}</option>
                </select>
              </label>
              <fieldset>
                <legend className="text-sm text-muted-foreground">{t('chargeOrderTypes')}</legend>
                <div className="flex flex-wrap gap-3 mt-1">
                  {VALID_CHARGE_ORDER_TYPES.map((type) => (
                    <label key={type} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={editing.order_types.includes(type)}
                        onChange={(e) => setEditing({
                          ...editing,
                          order_types: e.target.checked
                            ? [...editing.order_types, type]
                            : editing.order_types.filter((candidate) => candidate !== type),
                        })}
                      />
                      {tOrders(ORDER_TYPE_LABEL_KEYS[type])}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.is_optional}
                  onChange={(e) => setEditing({ ...editing, is_optional: e.target.checked })}
                />
                {t('chargeWaivable')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.is_default_active}
                  onChange={(e) => setEditing({ ...editing, is_default_active: e.target.checked })}
                />
                {t('chargeAutoApply')}
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeForm}>{tCommon('cancel')}</Button>
            <Button onClick={() => void submitForm()} disabled={saving || loading || !!loadError || !editing?.name || editing.value === ''}>
              {tCommon('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {ConfirmDialog}
    </div>
  );
}
