'use client';

import { useMemo, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { Bill, Order, OrderItem } from '@/lib/types';

export function SplitCheckModal({ bill, order, onClose, onSplit }: { bill: Bill; order: Order; onClose: () => void; onSplit: (bills: Bill[]) => void }) {
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const items = (order.items || []).filter((item) => !['cancelled', 'voided', 'void_adjustment'].includes(item.status));
  const initialCount = Math.min(8, Math.max(2, order.guest_count || 2));
  const [count, setCount] = useState(initialCount);
  const [labels, setLabels] = useState(() => Array.from({ length: initialCount }, (_, i) => `Guest ${i + 1}`));
  const [allocations, setAllocations] = useState<Record<number, number[]>>(() => Object.fromEntries(items.map((item) => {
    const slots = Array(initialCount).fill(0);
    for (let unit = 0; unit < item.quantity; unit++) slots[unit % initialCount]++;
    return [item.id, slots];
  })));
  const [saving, setSaving] = useState(false);

  const resize = (next: number) => {
    next = Math.min(20, Math.max(2, next));
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

  const submit = async () => {
    const invalid = items.some((item) => (allocations[item.id] || []).reduce((sum, value) => sum + value, 0) !== item.quantity)
      || Array.from({ length: count }, (_, check) => items.every((item) => !(allocations[item.id]?.[check] > 0))).some(Boolean);
    if (invalid) return toast.error(t('allocateAllItems', { defaultValue: 'Allocate every item and leave no guest check empty' }));
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
      onSplit(data.bills);
    } catch {
      toast.error(t('splitCheckFailed', { defaultValue: 'Unable to split check' }));
    } finally { setSaving(false); }
  };

  return <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4"><div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
    <div className="p-5 border-b flex items-center justify-between"><div><h2 className="text-lg font-bold">{t('splitCheck', { defaultValue: 'Split check' })}</h2><p className="text-sm text-gray-500">{t('splitCheckHint', { defaultValue: 'Assign whole item quantities to each guest check.' })}</p></div><button onClick={onClose}><X size={20} /></button></div>
    <div className="p-5 border-b flex items-center gap-3"><span className="text-sm text-gray-600">{t('numberOfChecks', { defaultValue: 'Number of checks' })}</span><button onClick={() => resize(count - 1)} className="size-7 rounded-full bg-gray-100 flex items-center justify-center"><Minus size={13} /></button><strong>{count}</strong><button onClick={() => resize(count + 1)} className="size-7 rounded-full bg-gray-100 flex items-center justify-center"><Plus size={13} /></button></div>
    <div className="overflow-auto p-5"><table className="w-full text-sm"><thead><tr><th className="text-start p-2 sticky start-0 bg-white">{t('items')}</th>{Array.from({ length: count }, (_, i) => <th key={i} className="p-2 min-w-28"><input value={labels[i]} onChange={(e) => setLabels((old) => old.map((label, n) => n === i ? e.target.value.slice(0, 40) : label))} className="w-full text-center border rounded px-2 py-1" /></th>)}</tr></thead><tbody>{items.map((item: OrderItem) => <tr key={item.id} className="border-t"><td className="p-2 sticky start-0 bg-white"><div className="font-medium">{item.product_name}</div><div className="text-xs text-gray-400">{item.quantity} × {fmt(Number(item.total) / item.quantity)}</div></td>{Array.from({ length: count }, (_, i) => <td key={i} className="p-2"><input type="number" min="0" max={item.quantity} value={allocations[item.id]?.[i] || 0} onChange={(e) => { const value = Math.min(item.quantity, Math.max(0, Number(e.target.value) || 0)); setAllocations((old) => ({ ...old, [item.id]: old[item.id].map((qty, n) => n === i ? value : qty) })); }} className="w-full text-center border rounded px-2 py-1" /></td>)}</tr>)}</tbody><tfoot><tr className="border-t font-semibold"><td className="p-2">{t('estimatedItemsTotal', { defaultValue: 'Items total' })}</td>{totals.map((total, i) => <td key={i} className="p-2 text-center">{fmt(total)}</td>)}</tr></tfoot></table></div>
    <div className="p-5 border-t flex justify-end gap-2"><Button variant="outline" onClick={onClose}>{tCommon('cancel')}</Button><Button onClick={submit} disabled={saving}>{saving ? tCommon('saving') : t('createChecks', { defaultValue: 'Create checks' })}</Button></div>
  </div></div>;
}
