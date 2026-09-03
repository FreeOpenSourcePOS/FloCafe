'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';


import toast from 'react-hot-toast';
import { Plus, Search, X, Edit, Wallet, History, TrendingUp, TrendingDown, AlertCircle } from 'lucide-react';
import { useSearchParams, useRouter } from 'next/navigation';

import type { Customer } from '@/lib/types';
import { countryName } from '@/lib/countries';
import { dialCodeFor, normalizeOptionalPhone } from '@/lib/phone';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useFormatNumber } from '@/hooks/useFormatNumber';

function SortIcon({ field, sortField, sortOrder }: { field: string; sortField: string; sortOrder: 'asc' | 'desc' }) {
  if (sortField !== field) return <span className="text-gray-300 w-3 inline-block ms-1 opacity-0 group-hover:opacity-100 transition-opacity">↕</span>;
  return sortOrder === 'asc' ? <TrendingUp size={12} className="inline ms-1 text-muted-foreground" /> : <TrendingDown size={12} className="inline ms-1 text-muted-foreground" />;
}

export default function CustomersPage() {
  const { currentTenant } = useAuthStore();
  const tCustomer = useTranslations('customer');
  const tCustomers = useTranslations('customers');
  const tPos = useTranslations('pos');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const { formatDate } = useFormatDate();
  const fmtNum = useFormatNumber();
  const defaultCountry = currentTenant?.country || 'IN';
  const dialCode = dialCodeFor(defaultCountry) || '+91';
  const searchParams = useSearchParams();
  const router = useRouter();
  const filter = searchParams.get('filter');
  
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('name');
  const [sortOrder, setSortOrder] = useState<'asc'|'desc'>('asc');
  const [showForm, setShowForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);

  const [form, setForm] = useState({ name: '', phone: '', email: '', country_code: dialCode });

  const [ledgerCustomer, setLedgerCustomer] = useState<Customer | null>(null);
  const [ledgerData, setLedgerData] = useState<{
    balance: number;
    transactions: { id: number; type: string; amount: number; description: string; created_at: string; expires_at?: string }[];
    bills: { id: number; bill_number: string; total: number; paid_at?: string; created_at: string; points_earned: number; points_redeemed: number }[];
    summary: { totalSpent: number; totalPointsEarned: number; totalPointsRedeemed: number };
  } | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const openLedger = async (c: Customer) => {
    setLedgerCustomer(c);
    setLedgerData(null);
    setLedgerLoading(true);
    try {
      const { data } = await api.get(`/customers/${c.id}/wallet`);
      setLedgerData(data);
    } catch {
      toast.error(tCustomer('ledgerLoadFailed'));
    } finally {
      setLedgerLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
    const params: Record<string, string> = {};
    if (search) params.search = search;
    if (filter) params.filter = filter;
    if (sortField) params.sort = sortField;
    if (sortOrder) params.order = sortOrder;
    api.get('/customers', { params, signal: controller.signal })
      .then(({ data }) => setCustomers(data.data || []))
      .catch((err: unknown) => {
        if (!(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) toast.error(tCustomer('loadFailed'));
      })
      .finally(() => { setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filter, sortField, sortOrder, refreshKey]);

  const openAdd = () => {
    setEditingCustomer(null);

    setForm({ name: '', phone: '', email: '', country_code: dialCode });
    setShowForm(true);
  };

  const openEdit = (c: Customer) => {
    setEditingCustomer(c);

    setForm({ name: c.name, phone: c.phone || '', email: c.email || '', country_code: c.country_code || dialCode });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const norm = normalizeOptionalPhone(form.phone, defaultCountry);
    if (!norm.valid) {
      toast.error(tPos('invalidPhone', { country: countryName(defaultCountry) }));
      return;
    }
    if (!editingCustomer && !norm.e164) {
      toast.error(tPos('invalidPhone', { country: countryName(defaultCountry) }));
      return;
    }
    const payload = { ...form, phone: norm.e164 ?? '', country_code: norm.countryCode ?? '' };
    try {
      if (editingCustomer) {
        await api.put(`/customers/${editingCustomer.id}`, payload);
        toast.success(tCustomer('updated'));
      } else {
        await api.post('/customers', payload);
        toast.success(tCustomer('added'));
      }
      setShowForm(false);
      setRefreshKey((k) => k + 1);
    } catch {
      toast.error(tCustomer('saveFailed'));
    }
  };

  const onSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder(field === 'name' ? 'asc' : 'desc');
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-foreground">{tNav('customers')}</h1>
          {filter === 'invalid_phones' && (
            <span className="bg-red-100 text-red-800 text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1.5">
              <AlertCircle size={14} /> {tCustomers('actionRequired')}
              <button onClick={() => router.push('/customers')} className="ms-1 text-red-500 hover:text-red-700">
                <X size={12} />
              </button>
            </span>
          )}
        </div>
        <Button onClick={openAdd}><Plus size={16} className="me-1" /> {tCustomer('add')}</Button>
      </div>

      <div className="relative mb-4">
        <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={tCustomer('search')}
          className="w-full ps-10 pe-4 py-2.5 bg-card border border-border rounded-lg focus:ring-2 focus:ring-brand outline-none"
        />
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted">
            <tr>
              <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors" onClick={() => onSort('name')}>
                {tCustomers('columnCustomer')} <SortIcon field="name" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-start p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors" onClick={() => onSort('phone')}>
                {tCustomer('phone')} <SortIcon field="phone" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors" onClick={() => onSort('last_visit')}>
                {tCustomers('columnLastVisit')} <SortIcon field="last_visit" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors" onClick={() => onSort('visits')}>
                {tCustomer('visits')} <SortIcon field="visits" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors" onClick={() => onSort('spent')}>
                {tCustomer('totalSpent')} <SortIcon field="spent" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-end p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors" onClick={() => onSort('loyalty')}>
                {tCustomer('loyalty')} <SortIcon field="loyalty" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{tCustomers('columnActions')}</th>
              <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">{tCustomers('columnLedger')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {customers.map((c) => (
              <tr key={c.id} className="hover:bg-muted">
                <td className="p-4">
                  <p className="font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.email || '—'}</p>
                </td>
                <td className="p-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span>
                      <Ltr>{c.phone ? (c.country_code && !c.phone.startsWith(c.country_code) ? `${c.country_code}${c.phone}` : c.phone) : '—'}</Ltr>
                    </span>
                    {c.phone && !c.phone.startsWith('+') && (
                      <div className="text-red-500 flex items-center" title="Invalid format">
                        <AlertCircle size={16} />
                      </div>
                    )}
                  </div>
                </td>
                <td className="p-4 text-center text-sm text-muted-foreground whitespace-nowrap">
                  {c.last_visit_at ? formatDate(c.last_visit_at) : '—'}
                </td>
                <td className="p-4 text-center text-sm">{c.visits_count}</td>
                <td className="p-4 text-end font-medium">{fmt(Number(c.total_spent))}</td>
                <td className="p-4 text-end">
                  {Number(c.wallet_balance) > 0 ? (
                    <span className="inline-flex items-center gap-1 text-purple-700 font-semibold text-sm">
                      <Wallet size={13} />
                      {fmtNum(Number(c.wallet_balance))} {tCustomer('ptsSuffix')}
                    </span>
                  ) : (
                    <span className="text-gray-400 text-sm">—</span>
                  )}
                </td>
                <td className="p-4 text-center">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                    <Edit size={14} />
                  </Button>
                </td>
                <td className="p-4 text-center">
                  <Button variant="ghost" size="sm" onClick={() => openLedger(c)} title={tCustomer('viewLedgerTitle')}>
                    <History size={14} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {customers.length === 0 && <p className="text-center text-muted-foreground py-12">{tCustomers('empty')}</p>}
        {customers.length >= 200 && <p className="text-center text-xs text-gray-400 py-3">{tCustomers('first200')}</p>}
      </div>

      {/* Loyalty Ledger Modal */}
      {ledgerCustomer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
              <div>
                <h2 className="text-lg font-bold text-foreground">{tCustomers('loyaltyLedger')}</h2>
                <p className="text-sm text-muted-foreground">{ledgerCustomer.name}</p>
              </div>
              <button onClick={() => setLedgerCustomer(null)} className="w-8 h-8 flex items-center justify-center rounded-full bg-muted hover:bg-muted">
                <X size={16} className="text-muted-foreground" />
              </button>
            </div>

            {ledgerLoading ? (
              <div className="flex-1 flex items-center justify-center py-12 text-gray-400">{tCustomer('loadingLedger')}</div>
            ) : ledgerData ? (
              <>
                {/* Summary row */}
                <div className="grid grid-cols-4 gap-4 px-6 py-4 bg-muted border-b border-border">
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{tCustomer('totalSpent')}</p>
                    <p className="text-lg font-bold text-foreground">{fmt(ledgerData.summary.totalSpent)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{tCustomers('totalPointsEarned')}</p>
                    <p className="text-lg font-bold text-green-600">+{ledgerData.summary.totalPointsEarned}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{tCustomers('totalPointsRedeemed')}</p>
                    <p className="text-lg font-bold text-red-500">-{ledgerData.summary.totalPointsRedeemed}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{tCustomers('totalBalance')}</p>
                    <p className="text-lg font-bold text-foreground">{ledgerData.balance} <span className="text-xs font-normal text-muted-foreground">{tCustomer('ptsSuffix')}</span></p>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {/* Billing history */}
                  <div className="px-6 pt-4">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{tCustomers('billingHistory')}</h3>
                  </div>
                  {ledgerData.bills.length === 0 ? (
                    <p className="text-center text-gray-400 py-6 text-sm">{tCustomers('noBills')}</p>
                  ) : (
                    <table className="w-full text-sm mb-2">
                      <thead className="bg-muted sticky top-0">
                        <tr>
                          <th className="text-start px-6 py-2.5 text-xs font-medium text-gray-500">{tCustomers('columnDate')}</th>
                          <th className="text-start px-4 py-2.5 text-xs font-medium text-gray-500">{tCustomers('columnBill')}</th>
                          <th className="text-end px-4 py-2.5 text-xs font-medium text-gray-500">{tCustomers('columnAmount')}</th>
                          <th className="text-end px-4 py-2.5 text-xs font-medium text-gray-500">{tCustomers('columnEarned')}</th>
                          <th className="text-end px-6 py-2.5 text-xs font-medium text-gray-500">{tCustomers('columnRedeemed')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {ledgerData.bills.map((b) => (
                          <tr key={b.id} className="hover:bg-muted">
                            <td className="px-6 py-3 text-muted-foreground whitespace-nowrap">{formatDate(b.paid_at || b.created_at)}</td>
                            <td className="px-4 py-3 text-foreground whitespace-nowrap">{b.bill_number}</td>
                            <td className="px-4 py-3 text-end text-foreground whitespace-nowrap">{fmt(b.total)}</td>
                            <td className="px-4 py-3 text-end whitespace-nowrap">
                              {b.points_earned > 0 ? <span className="text-green-600 font-semibold">+{b.points_earned}</span> : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-6 py-3 text-end whitespace-nowrap">
                              {b.points_redeemed > 0 ? <span className="text-red-500 font-semibold">-{b.points_redeemed}</span> : <span className="text-gray-300">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* Ledger table */}
                  <div className="px-6 pt-2">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">{tCustomers('pointsHistory')}</h3>
                  </div>
                  {ledgerData.transactions.length === 0 ? (
                    <p className="text-center text-gray-400 py-12">{tCustomers('noTransactions')}</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-muted sticky top-0">
                        <tr>
                          <th className="text-start px-6 py-2.5 text-xs font-medium text-muted-foreground">{tCustomers('columnDate')}</th>
                          <th className="text-start px-4 py-2.5 text-xs font-medium text-muted-foreground">{tCustomers('columnDescription')}</th>
                          <th className="text-end px-4 py-2.5 text-xs font-medium text-muted-foreground">{tCustomers('columnPoints')}</th>
                          <th className="text-end px-6 py-2.5 text-xs font-medium text-muted-foreground">{tCustomers('columnExpires')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {ledgerData.transactions.map((t: { id: number; type: string; amount: number; description: string; created_at: string; expires_at?: string }) => (
                          <tr key={t.id} className="hover:bg-muted">
                            <td className="px-6 py-3 text-muted-foreground whitespace-nowrap">{formatDate(t.created_at)}</td>
                            <td className="px-4 py-3 text-foreground">{t.description || '—'}</td>
                            <td className="px-4 py-3 text-end font-semibold whitespace-nowrap">
                              <span className={`inline-flex items-center gap-1 ${
                                t.type === 'credit' ? 'text-green-600' : 'text-red-500'
                              }`}>
                                {t.type === 'credit'
                                  ? <TrendingUp size={12} />
                                  : <TrendingDown size={12} />}
                                {t.type === 'credit' ? '+' : '-'}{t.amount}
                              </span>
                            </td>
                            <td className="px-6 py-3 text-end text-xs text-gray-400 whitespace-nowrap">
                              {t.expires_at ? formatDate(t.expires_at) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{editingCustomer ? tCustomer('edit') : tCustomer('add')}</h2>
              <button onClick={() => setShowForm(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <input type="text" placeholder={tCustomer('name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required />
              <div className="flex items-stretch gap-2">
                <input type="tel" placeholder={dialCode ? `${dialCode} ${tCustomer('phone')}` : tCustomer('phone')} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="flex-1 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required={!editingCustomer} />
              </div>
              <input type="email" placeholder={`${tCustomer('email')} (${tCommon('optional')})`} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" />
              <Button type="submit" className="w-full">{editingCustomer ? tCustomer('update') : tCustomer('add')}</Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
