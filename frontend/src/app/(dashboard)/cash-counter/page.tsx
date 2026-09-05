'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { X, Wallet, ClipboardCheck } from 'lucide-react';
import type { CashDailySummary, CashMonthlySummary } from '@/lib/types';
import { useTranslations } from 'use-intl';

// UTC calendar day — matches the backend's utcTodayDate() convention (see
// the /expenses page, which shares this same date discipline).
function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentUtcMonth(): string {
  return todayUtcDate().slice(0, 7);
}

export default function CashCounterPage() {
  const t = useTranslations('cashCounter');
  const tCommon = useTranslations('common');

  const [date, setDate] = useState(todayUtcDate());
  const [daily, setDaily] = useState<CashDailySummary | null>(null);
  const [loadingDaily, setLoadingDaily] = useState(true);

  const [month, setMonth] = useState(currentUtcMonth());
  const [monthly, setMonthly] = useState<CashMonthlySummary | null>(null);

  const [showFloatForm, setShowFloatForm] = useState(false);
  const [floatAmount, setFloatAmount] = useState('');
  const [floatNote, setFloatNote] = useState('');

  const [showCountForm, setShowCountForm] = useState(false);
  const [countAmount, setCountAmount] = useState('');
  const [countNote, setCountNote] = useState('');

  const loadDaily = () => api.get('/cash-counter/daily', { params: { date } })
    .then(({ data }) => setDaily(data))
    .catch(() => toast.error(t('failedToLoad')))
    .finally(() => setLoadingDaily(false));

  const loadMonthly = (m: string) => api.get('/cash-counter/monthly', { params: { month: m } })
    .then(({ data }) => setMonthly(data))
    .catch(() => toast.error(t('failedToLoadMonthly')));

  useEffect(() => {
    loadDaily();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  useEffect(() => {
    loadMonthly(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const openFloatForm = () => {
    setFloatAmount('');
    setFloatNote('');
    setShowFloatForm(true);
  };

  const handleAddFloat = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/cash-counter/opening-float', { date, amount: Number(floatAmount), note: floatNote || undefined });
      toast.success(t('openingFloatSet'));
      setShowFloatForm(false);
      loadDaily();
      loadMonthly(month);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } } };
      toast.error(err.response?.data?.error || tCommon('failedToSave'));
    }
  };

  const openCountForm = () => {
    setCountAmount('');
    setCountNote('');
    setShowCountForm(true);
  };

  const handleAddCount = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/cash-counter/count', { date, counted_amount: Number(countAmount), note: countNote || undefined });
      toast.success(t('countRecorded'));
      setShowCountForm(false);
      loadDaily();
      loadMonthly(month);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } } };
      toast.error(err.response?.data?.error || tCommon('failedToSave'));
    }
  };

  const varianceLabel = (variance: number | null) => {
    if (variance === null) return null;
    if (variance === 0) return t('varianceMatch');
    return variance > 0 ? t('varianceOverage', { amount: variance.toFixed(2) }) : t('varianceShortage', { amount: Math.abs(variance).toFixed(2) });
  };

  const varianceColor = (variance: number | null) => {
    if (variance === null) return 'text-gray-500';
    if (variance === 0) return 'text-emerald-600';
    return variance > 0 ? 'text-blue-600' : 'text-red-600';
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <input
          type="date" value={date} max={todayUtcDate()}
          onChange={(e) => setDate(e.target.value)}
          aria-label={t('selectDate')}
          className="px-3 py-1.5 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-brand"
        />
      </div>

      {loadingDaily || !daily ? (
        <p className="text-center text-gray-500 py-12">{tCommon('loading')}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-white rounded-xl p-4 border border-gray-100">
              <p className="text-xs text-gray-500">{t('openingFloat')}</p>
              <p className="text-lg font-semibold text-gray-900">{(daily.opening_float?.amount ?? 0).toFixed(2)}</p>
            </div>
            <div className="bg-white rounded-xl p-4 border border-gray-100">
              <p className="text-xs text-gray-500">{t('cashFromOrders')}</p>
              <p className="text-lg font-semibold text-emerald-600">+{daily.cash_from_orders.total.toFixed(2)}</p>
            </div>
            <div className="bg-white rounded-xl p-4 border border-gray-100">
              <p className="text-xs text-gray-500">{t('cashExpenses')}</p>
              <p className="text-lg font-semibold text-red-600">-{daily.cash_expenses.total.toFixed(2)}</p>
            </div>
            <div className="bg-brand/10 rounded-xl p-4 border border-brand/20">
              <p className="text-xs text-gray-500">{t('expectedCash')}</p>
              <p className="text-lg font-bold text-gray-900">{daily.expected_cash.toFixed(2)}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-6">
            <Button variant="outline" size="sm" disabled={Boolean(daily.opening_float)} title={daily.opening_float ? t('openingFloatAlreadySet') : ''} onClick={openFloatForm}>
              <Wallet size={14} className="me-1" /> {t('setOpeningFloat')}
            </Button>
            <Button variant="outline" size="sm" onClick={openCountForm}>
              <ClipboardCheck size={14} className="me-1" /> {t('recordCount')}
            </Button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h2 className="text-lg font-bold text-gray-900 mb-3">{t('countLog')}</h2>
              {daily.counts.length === 0 ? (
                <p className="text-center text-gray-500 py-8">{t('noCounts')}</p>
              ) : (
                <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
                  {daily.counts.map((count) => (
                    <div key={count.id} className="flex justify-between items-center px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{count.counted_amount.toFixed(2)}</p>
                        <p className="text-xs text-gray-500">
                          {count.created_by_name ? t('recordedBy', { name: count.created_by_name }) : ''}
                          {count.note ? ` · ${count.note}` : ''}
                        </p>
                      </div>
                      <p className={`text-sm font-semibold ${varianceColor(Math.round((count.counted_amount - daily.expected_cash) * 100) / 100)}`}>
                        {varianceLabel(Math.round((count.counted_amount - daily.expected_cash) * 100) / 100)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h2 className="text-lg font-bold text-gray-900 mb-3">{t('cashFromOrders')}</h2>
              {daily.cash_from_orders.payments.length === 0 ? (
                <p className="text-center text-gray-500 py-8">{t('noPayments')}</p>
              ) : (
                <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100 max-h-80 overflow-y-auto">
                  {daily.cash_from_orders.payments.map((payment) => (
                    <div key={`${payment.bill_id}-${payment.payment_time}`} className="flex justify-between items-center px-4 py-3">
                      <p className="text-sm text-gray-900">{payment.bill_number}</p>
                      <p className="text-sm font-semibold text-emerald-600">+{payment.amount.toFixed(2)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-2">
              <h2 className="text-lg font-bold text-gray-900 mb-3">{t('cashExpenses')}</h2>
              {daily.cash_expenses.payments.length === 0 ? (
                <p className="text-center text-gray-500 py-8">{t('noPayments')}</p>
              ) : (
                <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
                  {daily.cash_expenses.payments.map((payment) => (
                    <div key={payment.id} className="flex justify-between items-center px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-900">{payment.category_name}</p>
                        <p className="text-xs text-gray-500">
                          {payment.created_by_name ? t('recordedBy', { name: payment.created_by_name }) : ''}
                          {payment.note ? ` · ${payment.note}` : ''}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-red-600">-{payment.amount.toFixed(2)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div className="mt-10">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
          <h2 className="text-lg font-bold text-gray-900">{t('monthlyReport')}</h2>
          <input
            type="month" value={month} max={currentUtcMonth()}
            onChange={(e) => setMonth(e.target.value)}
            aria-label={t('selectMonth')}
            className="px-3 py-1.5 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        {monthly && (
          <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase text-gray-500">
                  <th className="px-4 py-2">{t('date')}</th>
                  <th className="px-4 py-2 text-end">{t('openingFloat')}</th>
                  <th className="px-4 py-2 text-end">{t('cashFromOrders')}</th>
                  <th className="px-4 py-2 text-end">{t('cashExpenses')}</th>
                  <th className="px-4 py-2 text-end">{t('expectedCash')}</th>
                  <th className="px-4 py-2 text-end">{t('counted')}</th>
                  <th className="px-4 py-2 text-end">{t('variance')}</th>
                </tr>
              </thead>
              <tbody>
                {monthly.days.map((day) => (
                  <tr key={day.date} className="border-b border-gray-50 last:border-b-0">
                    <td className="px-4 py-2 text-gray-900">{day.date}</td>
                    <td className="px-4 py-2 text-end text-gray-600">{day.opening_float.toFixed(2)}</td>
                    <td className="px-4 py-2 text-end text-emerald-600">{day.cash_from_orders.toFixed(2)}</td>
                    <td className="px-4 py-2 text-end text-red-600">{day.cash_expenses.toFixed(2)}</td>
                    <td className="px-4 py-2 text-end font-medium text-gray-900">{day.expected_cash.toFixed(2)}</td>
                    <td className="px-4 py-2 text-end text-gray-600">{day.latest_count !== null ? day.latest_count.toFixed(2) : '—'}</td>
                    <td className={`px-4 py-2 text-end font-medium ${varianceColor(day.variance)}`}>{day.variance !== null ? day.variance.toFixed(2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 font-semibold text-gray-900">
                  <td className="px-4 py-2">{t('overall')}</td>
                  <td className="px-4 py-2 text-end">{monthly.totals.total_opening_floats.toFixed(2)}</td>
                  <td className="px-4 py-2 text-end text-emerald-600">{monthly.totals.total_cash_from_orders.toFixed(2)}</td>
                  <td className="px-4 py-2 text-end text-red-600">{monthly.totals.total_cash_expenses.toFixed(2)}</td>
                  <td className="px-4 py-2 text-end" colSpan={3}>{t('netCash')}: {monthly.totals.net.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {showFloatForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('setOpeningFloat')}</h2>
              <button type="button" onClick={() => setShowFloatForm(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleAddFloat} className="space-y-4">
              <input
                type="number" step="0.01" min="0" placeholder={tCommon('amount')} value={floatAmount}
                onChange={(e) => setFloatAmount(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required
              />
              <input
                type="text" placeholder={`${tCommon('optional')}`} value={floatNote}
                onChange={(e) => setFloatNote(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              />
              <Button type="submit" className="w-full">{tCommon('confirm')}</Button>
            </form>
          </div>
        </div>
      )}

      {showCountForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('recordCount')}</h2>
              <button type="button" onClick={() => setShowCountForm(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleAddCount} className="space-y-4">
              <input
                type="number" step="0.01" min="0" placeholder={t('countedAmount')} value={countAmount}
                onChange={(e) => setCountAmount(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required
              />
              <input
                type="text" placeholder={`${tCommon('optional')}`} value={countNote}
                onChange={(e) => setCountNote(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              />
              <Button type="submit" className="w-full">{tCommon('confirm')}</Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
