'use client';

import { useEffect, useState } from 'react';
import { CreditCard, Plus, Save, Trash2, Merge } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';
import type { CustomPaymentMethod } from '@/lib/payment-methods';

interface MergeRecord {
  id: number;
  source_name: string;
  target_name: string;
  affected_payments: number;
  merged_at: string;
}

export function PaymentMethodsSettings({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useI18n();
  const [methods, setMethods] = useState<CustomPaymentMethod[]>([]);
  const [names, setNames] = useState<Record<number, string>>({});
  const [newName, setNewName] = useState('');
  const [mergeTargets, setMergeTargets] = useState<Record<number, string>>({});
  const [merges, setMerges] = useState<MergeRecord[]>([]);
  const [splitChecksEnabled, setSplitChecksEnabled] = useState(false);

  const load = async () => {
    const [methodsRes, historyRes, splitRes] = await Promise.all([
      api.get('/payment-methods?include_inactive=true'),
      api.get('/payment-methods/merge-history'),
      api.get('/settings/split_checks_enabled').catch(() => ({ data: { setting: { value: 'false' } } })),
    ]);
    const rows = methodsRes.data.payment_methods || [];
    setMethods(rows);
    setNames(Object.fromEntries(rows.map((row: CustomPaymentMethod) => [row.id, row.name])));
    setMerges(historyRes.data.merges || []);
    setSplitChecksEnabled(splitRes.data?.setting?.value === 'true');
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(() => toast.error(t('settings.loadFailed')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!newName.trim()) return;
    try {
      await api.post('/payment-methods', { name: newName });
      setNewName('');
      await load();
    } catch (error: unknown) {
      toast.error((error as { response?: { data?: { error?: string } } }).response?.data?.error || t('settings.saveFailed'));
    }
  };

  const update = async (method: CustomPaymentMethod, changes: Record<string, unknown>) => {
    try {
      await api.put(`/payment-methods/${method.id}`, changes);
      await load();
    } catch (error: unknown) {
      toast.error((error as { response?: { data?: { error?: string } } }).response?.data?.error || t('settings.saveFailed'));
    }
  };

  const remove = async (method: CustomPaymentMethod) => {
    if (!window.confirm(t('settings.deletePaymentMethodConfirm', { defaultValue: `Delete ${method.name}?` }))) return;
    try {
      await api.delete(`/payment-methods/${method.id}`);
      await load();
    } catch (error: unknown) {
      toast.error((error as { response?: { data?: { error?: string } } }).response?.data?.error || t('settings.saveFailed'));
    }
  };

  const merge = async (method: CustomPaymentMethod) => {
    const target = mergeTargets[method.id];
    if (!target) return;
    if (!window.confirm(t('settings.mergePaymentMethodConfirm', { defaultValue: `Replace all ${method.name} payments with the selected method?` }))) return;
    try {
      await api.post(`/payment-methods/${method.id}/merge`, target === 'card'
        ? { target_type: 'card' }
        : { target_type: 'custom', target_id: Number(target) });
      await load();
      toast.success(t('settings.paymentMethodMerged', { defaultValue: 'Payment methods merged' }));
    } catch (error: unknown) {
      toast.error((error as { response?: { data?: { error?: string } } }).response?.data?.error || t('settings.saveFailed'));
    }
  };

  return (
    <div className="pb-6 max-w-3xl space-y-6">
      <div className="bg-white rounded-xl border border-gray-100 p-6">
        <div className="flex items-center gap-2 mb-2"><CreditCard size={20} className="text-gray-500" /><h2 className="font-semibold text-gray-900">{t('settings.paymentMethods', { defaultValue: 'Payment methods' })}</h2></div>
        <p className="text-sm text-gray-500 mb-5">{t('settings.paymentMethodsHint', { defaultValue: 'Cash, Card, and Loyalty Wallet are built in. Add any other manual methods used by your store.' })}</p>
        <div className="rounded-lg border border-gray-100 divide-y">
          {['Cash', 'Card', 'Loyalty Wallet'].map((name) => <div key={name} className="px-3 py-2 flex justify-between text-sm"><span>{name}</span><span className="text-xs text-gray-400">{t('settings.builtIn', { defaultValue: 'Built in' })}</span></div>)}
        </div>
        <div className="mt-5 space-y-3">
          {methods.map((method) => (
            <div key={method.id} className="rounded-lg border border-gray-200 p-3 space-y-2">
              <div className="flex gap-2 items-center">
                <input disabled={!isAdmin} value={names[method.id] ?? method.name} onChange={(e) => setNames((old) => ({ ...old, [method.id]: e.target.value }))} className="flex-1 px-3 py-2 text-sm border rounded-lg" />
                <Button variant="outline" size="sm" disabled={!isAdmin || names[method.id] === method.name} onClick={() => update(method, { name: names[method.id] })}><Save size={14} /></Button>
                <label className="flex items-center gap-1.5 text-xs text-gray-500"><input type="checkbox" disabled={!isAdmin} checked={method.is_active} onChange={(e) => update(method, { is_active: e.target.checked })} /> {t('settings.active', { defaultValue: 'Active' })}</label>
                <Button variant="outline" size="sm" disabled={!isAdmin || Boolean(method.usage_count)} onClick={() => remove(method)}><Trash2 size={14} /></Button>
              </div>
              {Boolean(method.usage_count) && isAdmin && <div className="flex gap-2 items-center">
                <select value={mergeTargets[method.id] || ''} onChange={(e) => setMergeTargets((old) => ({ ...old, [method.id]: e.target.value }))} className="flex-1 px-2 py-1.5 text-xs border rounded-md bg-white">
                  <option value="">{t('settings.mergeInto', { defaultValue: 'Merge into…' })}</option><option value="card">Card</option>
                  {methods.filter((target) => target.id !== method.id).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                </select>
                <Button variant="outline" size="sm" disabled={!mergeTargets[method.id]} onClick={() => merge(method)}><Merge size={14} className="mr-1" />{t('settings.merge', { defaultValue: 'Merge' })}</Button>
              </div>}
            </div>
          ))}
          {isAdmin && <div className="flex gap-2"><input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder={t('settings.paymentMethodName', { defaultValue: 'e.g. Paytm, cheque, bank transfer' })} className="flex-1 px-3 py-2 text-sm border rounded-lg" /><Button onClick={add} disabled={!newName.trim()}><Plus size={14} className="mr-1" />{t('common.add')}</Button></div>}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-6 flex items-center justify-between gap-4">
        <div><h2 className="font-semibold text-gray-900">{t('settings.splitChecks', { defaultValue: 'Split checks' })}</h2><p className="text-sm text-gray-500 mt-1">{t('settings.splitChecksHint', { defaultValue: 'Allow dine-in orders to be divided into separate guest checks by item quantity. Disabled by default.' })}</p></div>
        <input type="checkbox" className="size-5" disabled={!isAdmin} checked={splitChecksEnabled} onChange={async (e) => { const value = e.target.checked; setSplitChecksEnabled(value); try { await api.put('/settings/split_checks_enabled', { value: String(value) }); } catch { setSplitChecksEnabled(!value); toast.error(t('settings.saveFailed')); } }} />
      </div>

      {merges.length > 0 && <div className="bg-white rounded-xl border border-gray-100 p-6"><h2 className="font-semibold text-gray-900 mb-3">{t('settings.mergeHistory', { defaultValue: 'Recent merges' })}</h2><div className="space-y-2 text-sm text-gray-600">{merges.map((entry) => <p key={entry.id}>{entry.source_name} → {entry.target_name} · {entry.affected_payments} · {new Date(`${entry.merged_at.replace(' ', 'T')}Z`).toLocaleDateString()}</p>)}</div></div>}
    </div>
  );
}
