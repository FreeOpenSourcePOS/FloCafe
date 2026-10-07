'use client';

import { useCallback, useMemo, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Bill, Order, OrderItem } from '@/lib/types';

type SplitMode = 'table' | 'guest';

const MIN_CHECKS = 2;
const MAX_CHECKS = 20;
const MAX_LABEL_LENGTH = 40;
const EXCLUDED_ITEM_STATUSES = ['cancelled', 'voided', 'void_adjustment', 'refunded'];

/** Only whole, positive quantities of live lines can be divided. */
function selectableItems(order: Order | null): OrderItem[] {
  return ((order?.items || []) as OrderItem[]).filter((item) => (
    !EXCLUDED_ITEM_STATUSES.includes(item.status ?? '')
    && Number.isSafeInteger(Number(item.quantity))
    && Number(item.quantity) > 0
  ));
}

function clampLabel(value: string, fallback: string): string {
  return value.trim().slice(0, MAX_LABEL_LENGTH) || fallback.slice(0, MAX_LABEL_LENGTH);
}

/**
 * Divides one unpaid check. The cashier either spreads the whole check across a
 * number of evenly shared checks, or picks the quantities the leaving guest is
 * paying for and leaves every other quantity on an unpaid check. The second mode
 * is what makes repeatable guest checkout possible: the remainder keeps this
 * bill's identity and can be divided again when the next guest leaves.
 */
export function SplitCheckModal({ bill, order, onClose, onSplit }: {
  bill: Bill;
  order: Order;
  onClose: () => void;
  onSplit: (bills: Bill[], departingBill: Bill | null) => void;
}) {
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  // The caller passes the bill-scoped projection, so these quantities are this
  // check's own share and never a paid sibling's.
  const [sourceOrder, setSourceOrder] = useState<Order>(order);
  const items = useMemo(() => selectableItems(sourceOrder), [sourceOrder]);
  const availableUnits = items.reduce((sum, item) => sum + Number(item.quantity), 0);
  const canSplitTable = availableUnits >= MIN_CHECKS;
  const maxTableChecks = Math.min(MAX_CHECKS, availableUnits);
  const checkTotal = Number(bill.total || 0);

  // A split-group child is divided for a leaving guest by default; the first
  // split of an untouched check keeps the familiar all-items grid.
  const [mode, setMode] = useState<SplitMode>(bill.split_group_id || !canSplitTable ? 'guest' : 'table');
  const initialCount = canSplitTable
    ? Math.min(8, maxTableChecks, Math.max(MIN_CHECKS, order.guest_count || MIN_CHECKS))
    : MIN_CHECKS;
  const [count, setCount] = useState(initialCount);
  const [labels, setLabels] = useState(() => Array.from({ length: initialCount }, (_, i) => `Guest ${i + 1}`));
  const [allocations, setAllocations] = useState<Record<number, number[]>>(() => {
    let nextSlot = 0;
    return Object.fromEntries(items.map((item) => {
      const slots = Array(initialCount).fill(0);
      for (let unit = 0; unit < item.quantity; unit++) slots[nextSlot++ % initialCount]++;
      return [item.id, slots];
    }));
  });
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [guestLabel, setGuestLabel] = useState(() => t('leavingGuestLabel').slice(0, MAX_LABEL_LENGTH));
  const [remainderLabel, setRemainderLabel] = useState(() => (bill.split_label || t('remainingCheckLabel')).slice(0, MAX_LABEL_LENGTH));
  const [saving, setSaving] = useState(false);

  const resize = (next: number) => {
    if (!canSplitTable) return;
    next = Math.min(maxTableChecks, Math.max(MIN_CHECKS, next));
    setLabels((old) => Array.from({ length: next }, (_, i) => old[i] || `Guest ${i + 1}`));
    setAllocations((old) => Object.fromEntries(items.map((item) => {
      const slots = Array.from({ length: next }, (_, i) => old[item.id]?.[i] || 0);
      const assigned = slots.reduce((sum, value) => sum + value, 0);
      if (assigned < item.quantity) slots[0] += item.quantity - assigned;
      if (assigned > item.quantity) slots[0] = Math.max(0, slots[0] - (assigned - item.quantity));
      return [item.id, slots];
    })));
    setCount(next);
  };

  const totals = useMemo(() => Array.from({ length: count }, (_, checkIndex) => items.reduce((sum, item) => sum + Number(item.total) * (allocations[item.id]?.[checkIndex] || 0) / item.quantity, 0)), [allocations, count, items]);

  const selectedUnits = items.reduce((sum, item) => sum + (selected[item.id] || 0), 0);
  const remainingUnits = availableUnits - selectedUnits;
  const guestEstimate = items.reduce((sum, item) => sum + Number(item.total) * (selected[item.id] || 0) / Number(item.quantity), 0);
  const remainingEstimate = Math.max(0, checkTotal - guestEstimate);

  const setQuantity = (item: OrderItem, value: number) => setSelected((old) => ({
    ...old,
    [item.id]: Math.max(0, Math.min(Number(item.quantity), Number.isFinite(value) ? Math.trunc(value) : 0)),
  }));

  /**
   * A rejected or unanswered split means the source may have moved on. Re-read
   * the check and keep only the draft that still fits its quantities; the
   * mutation itself is never retried automatically.
   */
  const refreshSource = useCallback(async () => {
    try {
      const { data } = await api.get(`/bills/${bill.id}`);
      const refreshed = (data?.bill?.order ?? null) as Order | null;
      if (!refreshed) return;
      const nextItems = selectableItems(refreshed);
      setSourceOrder(refreshed);
      setSelected((old) => Object.fromEntries(nextItems.map((item) => [
        item.id,
        Math.max(0, Math.min(Number(item.quantity), old[item.id] || 0)),
      ])));
      setAllocations((old) => Object.fromEntries(nextItems.map((item) => [
        item.id,
        Array.from({ length: count }, (_, index) => (
          Math.max(0, Math.min(Number(item.quantity), old[item.id]?.[index] || 0))
        )),
      ])));
    } catch {
      // The draft stays untouched when the check cannot be re-read.
    }
  }, [bill.id, count]);

  const submitAllItems = async () => {
    const invalid = items.some((item) => (allocations[item.id] || []).reduce((sum, value) => sum + value, 0) !== item.quantity)
      || Array.from({ length: count }, (_, check) => items.every((item) => !(allocations[item.id]?.[check] > 0))).some(Boolean);
    if (invalid) return toast.error(t('allocateAllItems'));
    setSaving(true);
    try {
      const checks = Array.from({ length: count }, (_, checkIndex) => ({
        label: labels[checkIndex],
        items: items.flatMap((item) => {
          const quantity = allocations[item.id]?.[checkIndex] || 0;
          return quantity > 0 ? [{ order_item_id: item.id, quantity }] : [];
        }),
      }));
      const { data } = await api.post(`/bills/${bill.id}/split-check`, { checks });
      onSplit(data.bills, null);
    } catch {
      await refreshSource();
      toast.error(t('splitCheckFailed'));
    } finally { setSaving(false); }
  };

  const submitLeavingGuest = async () => {
    if (saving || selectedUnits === 0 || remainingUnits === 0) return;
    setSaving(true);
    try {
      // The remainder keeps this bill as checks[0]; the leaving guest is the new
      // check, so the table stays open for whoever leaves next.
      const checks = [
        {
          label: clampLabel(remainderLabel, t('remainingCheckLabel')),
          items: items.flatMap((item) => {
            const quantity = Number(item.quantity) - (selected[item.id] || 0);
            return quantity > 0 ? [{ order_item_id: item.id, quantity }] : [];
          }),
        },
        {
          label: clampLabel(guestLabel, t('leavingGuestLabel')),
          items: items.flatMap((item) => {
            const quantity = selected[item.id] || 0;
            return quantity > 0 ? [{ order_item_id: item.id, quantity }] : [];
          }),
        },
      ];
      const { data } = await api.post(`/bills/${bill.id}/split-check`, { checks });
      const departing = (data.bills as Bill[]).find((created) => Number(created.id) !== Number(bill.id)) ?? null;
      onSplit(data.bills, departing);
    } catch {
      await refreshSource();
      toast.error(t('splitCheckFailed'));
    } finally { setSaving(false); }
  };

  const allSelected = selectedUnits > 0 && remainingUnits === 0;

  return <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4"><div className="bg-card rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
    <div className="p-5 border-b flex items-center justify-between"><div><h2 className="text-lg font-bold">{t('splitCheck')}</h2><p className="text-sm text-muted-foreground">{mode === 'guest' ? t('selectItemsHint') : t('splitCheckHint')}</p></div><button onClick={onClose} disabled={saving} aria-label={tCommon('close')}><X size={20} /></button></div>
    <div className="p-5 border-b flex flex-wrap items-center gap-2">
      <Button variant={mode === 'guest' ? 'default' : 'outline'} size="sm" onClick={() => setMode('guest')} disabled={saving}>{t('splitModeSelected')}</Button>
      <Button variant={mode === 'table' ? 'default' : 'outline'} size="sm" onClick={() => setMode('table')} disabled={saving || !canSplitTable}>{t('splitModeAll')}</Button>
      {mode === 'table'
        ? <div className="flex items-center gap-3 ms-auto"><span className="text-sm text-muted-foreground">{t('numberOfChecks')}</span><button onClick={() => resize(count - 1)} disabled={saving || count <= MIN_CHECKS} className="size-7 rounded-full bg-muted flex items-center justify-center disabled:opacity-50"><Minus size={13} /></button><strong>{count}</strong><button onClick={() => resize(count + 1)} disabled={saving || count >= maxTableChecks} className="size-7 rounded-full bg-muted flex items-center justify-center disabled:opacity-50"><Plus size={13} /></button></div>
        : <div className="flex items-center gap-3 ms-auto text-sm"><span className="text-muted-foreground">{t('selectedQuantity')}</span><strong>{selectedUnits}</strong><span className="text-muted-foreground">{t('remainingQuantity')}</span><strong>{remainingUnits}</strong></div>}
    </div>
    {mode === 'table'
      ? <div className="overflow-auto p-5"><table className="w-full text-sm"><thead><tr><th className="text-start p-2 sticky start-0 bg-card">{t('items')}</th>{Array.from({ length: count }, (_, i) => <th key={i} className="p-2 min-w-28"><input value={labels[i]} onChange={(e) => setLabels((old) => old.map((label, n) => n === i ? e.target.value.slice(0, MAX_LABEL_LENGTH) : label))} className="w-full text-center border rounded px-2 py-1" /></th>)}</tr></thead><tbody>{items.map((item: OrderItem) => <tr key={item.id} className="border-t"><td className="p-2 sticky start-0 bg-card"><div className="font-medium">{item.product_name}</div><div className="text-xs text-muted-foreground">{item.quantity} × {fmt(Number(item.total) / item.quantity)}</div></td>{Array.from({ length: count }, (_, i) => <td key={i} className="p-2"><input type="number" min="0" max={item.quantity} value={allocations[item.id]?.[i] || 0} onChange={(e) => { const value = Math.min(item.quantity, Math.max(0, Number(e.target.value) || 0)); setAllocations((old) => ({ ...old, [item.id]: old[item.id].map((qty, n) => n === i ? value : qty) })); }} className="w-full text-center border rounded px-2 py-1" /></td>)}</tr>)}</tbody><tfoot><tr className="border-t font-semibold"><td className="p-2">{t('estimatedItemsTotal')}</td>{totals.map((total, i) => <td key={i} className="p-2 text-center">{fmt(total)}</td>)}</tr></tfoot></table></div>
      : <div className="overflow-auto p-5">
        {items.length === 0
          ? <p className="text-sm text-muted-foreground">{t('noSplitCheckItems')}</p>
          : <table className="w-full text-sm">
            <thead><tr><th className="text-start p-2 sticky start-0 bg-card">{t('items')}</th><th className="p-2 min-w-28">{t('sourceQuantity')}</th><th className="p-2 min-w-40">{t('selectedQuantity')}</th><th className="p-2 min-w-28">{t('remainingQuantity')}</th></tr></thead>
            <tbody>{items.map((item: OrderItem) => <tr key={item.id} className="border-t">
              <td className="p-2 sticky start-0 bg-card"><div className="font-medium">{item.product_name}</div><div className="text-xs text-muted-foreground">{item.quantity} × {fmt(Number(item.total) / item.quantity)}</div></td>
              <td className="p-2 text-center">{item.quantity}</td>
              <td className="p-2">
                <div className="flex items-center justify-center gap-1.5">
                  <button type="button" onClick={() => setQuantity(item, (selected[item.id] || 0) - 1)} className="size-7 rounded-full bg-muted flex items-center justify-center"><Minus size={13} /></button>
                  <input type="number" min="0" max={item.quantity} aria-label={t('selectedQuantity')} value={selected[item.id] || 0} onChange={(e) => setQuantity(item, Number(e.target.value))} className="w-16 text-center border rounded px-2 py-1" />
                  <button type="button" onClick={() => setQuantity(item, (selected[item.id] || 0) + 1)} className="size-7 rounded-full bg-muted flex items-center justify-center"><Plus size={13} /></button>
                </div>
              </td>
              <td className="p-2 text-center">{Number(item.quantity) - (selected[item.id] || 0)}</td>
            </tr>)}</tbody>
          </table>}
        {selectedUnits === 0 && items.length > 0 && <p className="mt-3 text-sm text-muted-foreground">{t('selectAtLeastOneItem')}</p>}
        {allSelected && <p className="mt-3 text-sm text-muted-foreground">{t('allItemsSelected')}</p>}
        {items.length > 0 && <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <label className="text-sm"><span className="block text-muted-foreground mb-1">{t('leavingGuestLabel')}</span><input value={guestLabel} maxLength={MAX_LABEL_LENGTH} onChange={(e) => setGuestLabel(e.target.value)} className="w-full border rounded px-2 py-1" /></label>
          <label className="text-sm"><span className="block text-muted-foreground mb-1">{t('remainingCheckLabel')}</span><input value={remainderLabel} maxLength={MAX_LABEL_LENGTH} onChange={(e) => setRemainderLabel(e.target.value)} className="w-full border rounded px-2 py-1" /></label>
        </div>}
        {items.length > 0 && <div className="mt-4 space-y-1 border-t pt-3 text-sm">
          <div className="flex justify-between"><span>{t('estimatedLeavingGuestTotal')}</span><strong>{fmt(guestEstimate)}</strong></div>
          <div className="flex justify-between text-muted-foreground"><span>{t('remainingCheckLabel')}</span><span>{fmt(remainingEstimate)}</span></div>
          <p className="text-xs text-muted-foreground">{t('estimateDisclaimer')}</p>
        </div>}
      </div>}
    <div className="p-5 border-t flex justify-end gap-2">
      <Button variant="outline" onClick={onClose} disabled={saving}>{tCommon('cancel')}</Button>
      {mode === 'table'
        ? <Button onClick={submitAllItems} disabled={saving || !canSplitTable || items.length === 0}>{saving ? tCommon('saving') : t('createChecks')}</Button>
        : allSelected
          ? <Button onClick={onClose} disabled={saving}>{t('payThisCheck')}</Button>
          : <Button onClick={submitLeavingGuest} disabled={saving || selectedUnits === 0 || items.length === 0}>{saving ? tCommon('saving') : t('createChecks')}</Button>}
    </div>
  </div></div>;
}
