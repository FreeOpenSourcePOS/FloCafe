'use client';

import { useEffect, useState } from 'react';
import { CreditCard, Plus, Save, Trash2, Merge } from 'lucide-react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'use-intl';
import { useFormatDate } from '@/hooks/useFormatDate';
import type { CustomPaymentMethod } from '@/lib/payment-methods';

interface MergeRecord {
  id: number;
  source_name: string;
  target_name: string;
  affected_payments: number;
  merged_at: string;
}

export function PaymentMethodsSettings({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const { formatDate } = useFormatDate();

  const builtInMethods = [
    { key: 'cash', labelKey: 'methodCash' },
    { key: 'card', labelKey: 'methodCard' },
    { key: 'wallet', labelKey: 'loyaltyWallet' },
  ] as const;
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
    void load().catch(() => toast.error(t('loadFailed')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    if (!newName.trim()) return;
    try {
      await api.post('/payment-methods', { name: newName });
      setNewName('');
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const update = async (method: CustomPaymentMethod, changes: Record<string, unknown>) => {
    try {
      await api.put(`/payment-methods/${method.id}`, changes);
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const remove = async (method: CustomPaymentMethod) => {
    if (!window.confirm(t('deletePaymentMethodConfirm'))) return;
    try {
      await api.delete(`/payment-methods/${method.id}`);
      await load();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const merge = async (method: CustomPaymentMethod) => {
    const target = mergeTargets[method.id];
    if (!target) return;
    if (!window.confirm(t('mergePaymentMethodConfirm'))) return;
    try {
      await api.post(`/payment-methods/${method.id}/merge`, target === 'card'
        ? { target_type: 'card' }
        : { target_type: 'custom', target_id: Number(target) });
      await load();
      toast.success(t('paymentMethodMerged'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  return (
    <div className="pb-6 max-w-3xl space-y-6">
      <div className="bg-white rounded-xl border border-gray-100 p-6">
        <div className="flex items-center gap-2 mb-2"><CreditCard size={20} className="text-gray-500" /><h2 className="font-semibold text-gray-900">{t('paymentMethods')}</h2></div>
        <p className="text-sm text-gray-500 mb-5">{t('paymentMethodsHint')}</p>
        <div className="rounded-lg border border-gray-100 divide-y">
          {builtInMethods.map((method) => <div key={method.key} className="px-3 py-2 flex justify-between text-sm"><span>{tPos(method.labelKey)}</span><span className="text-xs text-gray-400">{t('builtIn')}</span></div>)}
        </div>
        <div className="mt-5 space-y-3">
          {methods.map((method) => (
            <div key={method.id} className="rounded-lg border border-gray-200 p-3 space-y-2">
              <div className="flex gap-2 items-center">
                <input disabled={!isAdmin} value={names[method.id] ?? method.name} onChange={(e) => setNames((old) => ({ ...old, [method.id]: e.target.value }))} className="flex-1 px-3 py-2 text-sm border rounded-lg" />
                <Button variant="outline" size="sm" disabled={!isAdmin || names[method.id] === method.name} onClick={() => update(method, { name: names[method.id] })}><Save size={14} /></Button>
                <label className="flex items-center gap-1.5 text-xs text-gray-500"><input type="checkbox" disabled={!isAdmin} checked={method.is_active} onChange={(e) => update(method, { is_active: e.target.checked })} /> {t('active')}</label>
                <Button variant="outline" size="sm" disabled={!isAdmin || Boolean(method.usage_count)} onClick={() => remove(method)}><Trash2 size={14} /></Button>
              </div>
              {Boolean(method.usage_count) && isAdmin && <div className="flex gap-2 items-center">
                <select value={mergeTargets[method.id] || ''} onChange={(e) => setMergeTargets((old) => ({ ...old, [method.id]: e.target.value }))} className="flex-1 px-2 py-1.5 text-xs border rounded-md bg-white">
                  <option value="">{t('mergeInto')}…</option><option value="card">{tPos('methodCard')}</option>
                  {methods.filter((target) => target.id !== method.id).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                </select>
                <Button variant="outline" size="sm" disabled={!mergeTargets[method.id]} onClick={() => merge(method)}><Merge size={14} className="me-1" />{t('merge')}</Button>
              </div>}
            </div>
          ))}
          {isAdmin && <div className="flex gap-2"><input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder={t('paymentMethodName')} className="flex-1 px-3 py-2 text-sm border rounded-lg" /><Button onClick={add} disabled={!newName.trim()}><Plus size={14} className="me-1" />{tCommon('add')}</Button></div>}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-6 flex items-center justify-between gap-4">
        <div><h2 className="font-semibold text-gray-900">{t('splitChecks')}</h2><p className="text-sm text-gray-500 mt-1">{t('splitChecksHint')}</p></div>
        <input type="checkbox" className="size-5" disabled={!isAdmin} checked={splitChecksEnabled} onChange={async (e) => { const value = e.target.checked; setSplitChecksEnabled(value); try { await api.put('/settings/split_checks_enabled', { value: String(value) }); } catch { setSplitChecksEnabled(!value); toast.error(t('saveFailed')); } }} />
      </div>

      {merges.length > 0 && <div className="bg-white rounded-xl border border-gray-100 p-6"><h2 className="font-semibold text-gray-900 mb-3">{t('mergeHistory')}</h2><div className="space-y-2 text-sm text-gray-600">{merges.map((entry) => <p key={entry.id}>{entry.source_name} → {entry.target_name} · {entry.affected_payments} · {formatDate(entry.merged_at)}</p>)}</div></div>}
    </div>
  );
}
