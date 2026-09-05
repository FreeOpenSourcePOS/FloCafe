'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { Plus, X, Trash2, Wallet, Receipt } from 'lucide-react';
import type { ExpenseCategory, ExpenseLedgerEntry, ExpenseMonthSummary, ExpensePaymentMethod } from '@/lib/types';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { useConfirm } from '@/hooks/use-confirm';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';

type LedgerRow = ExpenseLedgerEntry & { kind: 'expense' | 'payment' };

const PAYMENT_METHODS: ExpensePaymentMethod[] = ['cash', 'card', 'upi'];

// UTC calendar day — matches the backend's utcTodayDate() convention, so a
// date picked here is never rejected as "in the future" by a client whose
// local clock has already rolled past midnight UTC.
function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentUtcMonth(): string {
  return todayUtcDate().slice(0, 7);
}

type PaymentMethodLabelKey = 'paymentMethodCash' | 'paymentMethodCard' | 'paymentMethodUpi';

function paymentMethodLabelKey(method: ExpensePaymentMethod): PaymentMethodLabelKey {
  return `paymentMethod${method.charAt(0).toUpperCase()}${method.slice(1)}` as PaymentMethodLabelKey;
}

export default function ExpensesPage() {
  const t = useTranslations('expenses');
  const tCommon = useTranslations('common');
  const { currentTenant } = useAuthStore();
  const { confirm, ConfirmDialog } = useConfirm();
  const isAdmin = hasRole(currentTenant?.role, ROLE_ACCESS.ownerManager);

  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [recent, setRecent] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterDate, setFilterDate] = useState('');

  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [categoryName, setCategoryName] = useState('');

  const [activeCategory, setActiveCategory] = useState<ExpenseCategory | null>(null);
  const [modalMode, setModalMode] = useState<'expense' | 'payment' | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayUtcDate());
  const [method, setMethod] = useState<ExpensePaymentMethod>('cash');

  const [summaryMonth, setSummaryMonth] = useState(currentUtcMonth());
  const [summary, setSummary] = useState<ExpenseMonthSummary | null>(null);

  const load = () => {
    const ledgerParams = { limit: 20, ...(filterDate ? { date: filterDate } : {}) };
    return Promise.all([
      api.get('/expenses/categories'),
      api.get('/expenses/entries', { params: ledgerParams }),
      api.get('/expenses/payments', { params: ledgerParams }),
    ])
      .then(([categoriesRes, entriesRes, paymentsRes]) => {
        setCategories(categoriesRes.data.categories || []);
        const merged: LedgerRow[] = [
          ...(entriesRes.data.entries || []).map((row: ExpenseLedgerEntry) => ({ ...row, kind: 'expense' as const })),
          ...(paymentsRes.data.payments || []).map((row: ExpenseLedgerEntry) => ({ ...row, kind: 'payment' as const })),
        ].sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? 1 : -1) : (a.date < b.date ? 1 : -1)));
        setRecent(merged.slice(0, 20));
      })
      .catch(() => toast.error(t('failedToLoad')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDate]);

  const loadSummary = (month: string) => api.get('/expenses/summary', { params: { month } })
    .then(({ data }) => setSummary(data))
    .catch(() => toast.error(t('failedToLoadSummary')));

  useEffect(() => {
    loadSummary(summaryMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryMonth]);

  const openCategoryForm = () => {
    setCategoryName('');
    setShowCategoryForm(true);
  };

  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/expenses/categories', { name: categoryName });
      toast.success(t('categoryCreated'));
      setShowCategoryForm(false);
      load();
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } } };
      toast.error(err.response?.data?.error || tCommon('failedToSave'));
    }
  };

  const handleDeleteCategory = async (category: ExpenseCategory) => {
    if (category.due !== 0) return;
    if (!await confirm(t('confirmDeleteCategory', { name: category.name }), { destructive: true })) return;
    try {
      await api.delete(`/expenses/categories/${category.id}`);
      toast.success(t('categoryDeleted'));
      load();
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } } };
      toast.error(err.response?.data?.error || tCommon('failedToDelete'));
    }
  };

  const openModal = (category: ExpenseCategory, mode: 'expense' | 'payment') => {
    setActiveCategory(category);
    setModalMode(mode);
    setAmount('');
    setNote('');
    setDate(todayUtcDate());
    setMethod('cash');
  };

  const closeModal = () => {
    setActiveCategory(null);
    setModalMode(null);
  };

  const handleSubmitLedger = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCategory || !modalMode) return;
    try {
      const path = modalMode === 'expense' ? '/expenses/entries' : '/expenses/payments';
      const body: Record<string, unknown> = { category_id: activeCategory.id, amount: Number(amount), note: note || undefined, date };
      if (modalMode === 'payment') body.method = method;
      await api.post(path, body);
      toast.success(modalMode === 'expense' ? t('entryAdded') : t('paymentRecorded'));
      closeModal();
      load();
      loadSummary(summaryMonth);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } } };
      toast.error(err.response?.data?.error || tCommon('failedToSave'));
    }
  };

  if (loading) return <p className="text-center text-gray-500 py-12">{tCommon('loading')}</p>;

  return (
    <div>
      {ConfirmDialog}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        {isAdmin && (
          <Button onClick={openCategoryForm}><Plus size={16} className="me-1" /> {t('addCategory')}</Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {categories.map((category) => (
          <div key={category.id} className="bg-white rounded-xl p-5 border border-gray-100">
            <div className="flex justify-between items-start mb-3">
              <p className="font-bold text-gray-900">{category.name}</p>
              {isAdmin && (
                <button
                  type="button"
                  title={category.due !== 0 ? t('deleteCategoryBlocked') : t('deleteCategory')}
                  disabled={category.due !== 0}
                  onClick={() => handleDeleteCategory(category)}
                  className={category.due !== 0 ? 'text-gray-300 cursor-not-allowed' : 'text-red-500 hover:text-red-700'}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <p className={`text-sm ${category.due > 0 ? 'text-red-600' : category.due < 0 ? 'text-emerald-600' : 'text-gray-500'}`}>
              {t('due')}: {category.due.toFixed(2)}
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button variant="outline" size="sm" onClick={() => openModal(category, 'expense')}>
                <Receipt size={14} className="me-1" /> {t('addExpense')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => openModal(category, 'payment')}>
                <Wallet size={14} className="me-1" /> {t('recordPayment')}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {categories.length === 0 && <p className="text-center text-gray-500 py-12">{t('noCategories')}</p>}

      <div className="mt-8">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
          <h2 className="text-lg font-bold text-gray-900">{t('monthlyReport')}</h2>
          <input
            type="month" value={summaryMonth} max={currentUtcMonth()}
            onChange={(e) => setSummaryMonth(e.target.value)}
            aria-label={t('selectMonth')}
            className="px-3 py-1.5 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        {summary && (
          <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase text-gray-500">
                  <th className="px-4 py-2">{t('category')}</th>
                  <th className="px-4 py-2 text-end">{t('totalExpenses')}</th>
                  <th className="px-4 py-2 text-end">{t('totalPaid')}</th>
                  <th className="px-4 py-2 text-end">{t('paymentMethodCash')}</th>
                  <th className="px-4 py-2 text-end">{t('paymentMethodCard')}</th>
                  <th className="px-4 py-2 text-end">{t('paymentMethodUpi')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.categories.map((row) => (
                  <tr key={row.category_id} className="border-b border-gray-50 last:border-b-0">
                    <td className="px-4 py-2 font-medium text-gray-900">{row.category_name}</td>
                    <td className="px-4 py-2 text-end text-red-600">{row.total_expenses.toFixed(2)}</td>
                    <td className="px-4 py-2 text-end text-emerald-600">{row.total_payments.toFixed(2)}</td>
                    <td className="px-4 py-2 text-end text-gray-600">{row.payments_by_method.cash.toFixed(2)}</td>
                    <td className="px-4 py-2 text-end text-gray-600">{row.payments_by_method.card.toFixed(2)}</td>
                    <td className="px-4 py-2 text-end text-gray-600">{row.payments_by_method.upi.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 font-semibold text-gray-900">
                  <td className="px-4 py-2">{t('overall')}</td>
                  <td className="px-4 py-2 text-end text-red-600">{summary.overall.total_expenses.toFixed(2)}</td>
                  <td className="px-4 py-2 text-end text-emerald-600">{summary.overall.total_payments.toFixed(2)}</td>
                  <td className="px-4 py-2 text-end">{summary.overall.payments_by_method.cash.toFixed(2)}</td>
                  <td className="px-4 py-2 text-end">{summary.overall.payments_by_method.card.toFixed(2)}</td>
                  <td className="px-4 py-2 text-end">{summary.overall.payments_by_method.upi.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
            {summary.categories.length === 0 && <p className="text-center text-gray-500 py-8">{t('noCategories')}</p>}
          </div>
        )}
      </div>

      <div className="mt-8">
        <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
          <h2 className="text-lg font-bold text-gray-900">{t('history')}</h2>
          <div className="flex items-center gap-2">
            <input
              type="date" value={filterDate} max={todayUtcDate()}
              onChange={(e) => setFilterDate(e.target.value)}
              aria-label={t('filterByDate')}
              className="px-3 py-1.5 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-brand"
            />
            {filterDate && (
              <button type="button" onClick={() => setFilterDate('')} className="text-xs text-gray-500 hover:text-gray-700 underline">
                {t('clearDateFilter')}
              </button>
            )}
          </div>
        </div>
        {recent.length === 0 ? (
          <p className="text-center text-gray-500 py-8">{t('noEntries')}</p>
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
            {recent.map((row) => (
              <div key={`${row.kind}-${row.id}`} className="flex justify-between items-center px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900">{row.category_name}</p>
                  <p className="text-xs text-gray-500">
                    {row.date}
                    {' · '}
                    {row.kind === 'expense' ? t('entryTypeExpense') : t('entryTypePayment')}
                    {row.kind === 'payment' && row.method ? ` · ${t(paymentMethodLabelKey(row.method))}` : ''}
                    {row.created_by_name ? ` · ${t('recordedBy', { name: row.created_by_name })}` : ''}
                    {row.note ? ` · ${row.note}` : ''}
                  </p>
                </div>
                <p className={`text-sm font-semibold ${row.kind === 'expense' ? 'text-red-600' : 'text-emerald-600'}`}>
                  {row.kind === 'expense' ? '+' : '-'}{Number(row.amount).toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCategoryForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{t('addCategory')}</h2>
              <button type="button" onClick={() => setShowCategoryForm(false)}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleAddCategory} className="space-y-4">
              <input
                type="text" placeholder={t('categoryName')} value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required
              />
              <Button type="submit" className="w-full">{tCommon('create')}</Button>
            </form>
          </div>
        </div>
      )}

      {activeCategory && modalMode && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">{modalMode === 'expense' ? t('addExpense') : t('recordPayment')} — {activeCategory.name}</h2>
              <button type="button" onClick={closeModal}><X size={20} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleSubmitLedger} className="space-y-4">
              <input
                type="number" step="0.01" min="0.01" placeholder={tCommon('amount')} value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required
              />
              <div>
                <label htmlFor="expense-entry-date" className="mb-1 block text-xs font-medium text-gray-500">{t('date')}</label>
                <input
                  id="expense-entry-date"
                  type="date" value={date} max={todayUtcDate()}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand" required
                />
              </div>
              {modalMode === 'payment' && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-500">{t('paymentMethod')}</label>
                  <div className="flex gap-2">
                    {PAYMENT_METHODS.map((m) => (
                      <button
                        key={m} type="button" onClick={() => setMethod(m)}
                        className={`flex-1 px-3 py-2 border rounded-lg text-sm ${method === m ? 'border-brand bg-brand/10 font-medium text-brand' : 'border-gray-200 text-gray-600'}`}
                      >
                        {t(paymentMethodLabelKey(m))}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <input
                type="text" placeholder={`${t('note')} (${tCommon('optional')})`} value={note}
                onChange={(e) => setNote(e.target.value)}
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
