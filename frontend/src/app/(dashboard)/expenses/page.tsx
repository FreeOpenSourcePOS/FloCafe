'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '@/lib/api';
import { useTranslations } from 'use-intl';
import { Plus, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ExpenseWorkflow from '@/components/expenses/ExpenseWorkflow';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type {
  ExpenseCategory,
  ExpenseContext,
  ExpenseRecord,
  ExpenseStatusFilter,
  ExpenseSummary,
} from '@/lib/types';

const LIST_PAGE_SIZE = 50;

interface Filters {
  from: string;
  to: string;
  categoryId: string;
  status: ExpenseStatusFilter;
  currency: string;
}

/** Business month up to the store's own business date, never the host clock. */
function defaultRange(businessDate: string): { from: string; to: string } {
  return { from: `${businessDate.slice(0, 7)}-01`, to: businessDate };
}

export default function ExpensesPage() {
  const t = useTranslations('expenses');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const tOrders = useTranslations('orders');
  const { currentTenant, refreshAuthContext } = useAuthStore();
  const fmt = useFormatCurrency();
  const fmtMinor = (amountMinor: number, currencyCode: string) => fmt(amountMinor / getCurrencyMinorUnitFactor(currencyCode));

  const minorFactor = getCurrencyMinorUnitFactor(currentTenant?.currency || '');

  const [context, setContext] = useState<ExpenseContext | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [filters, setFilters] = useState<Filters | null>(null);
  // Rows carry the filter identity they were fetched for, so a filter change
  // renders as loading instead of showing rows that no longer match.
  const [page, setPage] = useState<{ key: string; rows: ExpenseRecord[]; cursor: string | null }>(
    { key: '', rows: [], cursor: null },
  );
  const [summary, setSummary] = useState<{ key: string; data: ExpenseSummary } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [workflow, setWorkflow] = useState<{ mode: 'create' | 'detail'; expense: ExpenseRecord | null } | null>(null);

  // Every filter change starts a new request identity, so a slower earlier
  // response can never replace the rows the operator is looking at now.
  const requestSeq = useRef(0);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  const filterKey = filters ? JSON.stringify(filters) : '';
  const requestKey = filters ? JSON.stringify([filters, refreshKey]) : '';
  const currentSummary = summary?.key === filterKey ? summary.data : null;
  const stale = !filters || page.key !== requestKey;
  const expenses = stale ? [] : page.rows;
  const nextCursor = stale ? null : page.cursor;

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get('/expenses/context'),
      api.get('/expenses/categories', { params: { include_inactive: true } }),
    ])
      .then(([contextResponse, categoriesResponse]) => {
        if (!active) return;
        const nextContext = contextResponse.data as ExpenseContext;
        setContext(nextContext);
        setCategories(categoriesResponse.data.categories ?? []);
        const range = defaultRange(nextContext.business_date);
        setFilters((current) => current ?? { ...range, categoryId: '', status: 'active', currency: '' });
      })
      .catch((error) => {
        if (!active) return;
        if ((error as { response?: { status?: number } })?.response?.status === 403) {
          setDenied(true);
          void refreshAuthContext();
        }
        setLoadError(t('loadFailed'));
        setFilters((current) => current ?? { from: '', to: '', categoryId: '', status: 'active', currency: '' });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshAuthContext, t]);

  useEffect(() => {
    if (!filters) return;
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    const key = JSON.stringify(filters);
    const pageKey = JSON.stringify([filters, refreshKey]);

    const params = {
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      ...(filters.categoryId ? { category_id: filters.categoryId } : {}),
      ...(filters.currency ? { currency: filters.currency } : {}),
      ...(filters.status !== 'all' ? { status: filters.status } : {}),
    };

    const summaryParams = {
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      ...(filters.categoryId ? { category_id: filters.categoryId } : {}),
      ...(filters.currency ? { currency: filters.currency } : {}),
    };

    api.get('/expenses', { params: { ...params, limit: LIST_PAGE_SIZE }, signal: controller.signal })
      .then(({ data }) => {
        if (seq !== requestSeq.current) return;
        setPage({ key: pageKey, rows: data.expenses ?? [], cursor: data.nextCursor ?? null });
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (seq !== requestSeq.current) return;
        if (error instanceof Error && (error.name === 'CanceledError' || error.name === 'AbortError')) return;
        if ((error as { response?: { status?: number } })?.response?.status === 403) {
          setDenied(true);
          void refreshAuthContext();
        }
        setLoadError(t('loadFailed'));
      });

    api.get('/expenses/summary', { params: summaryParams, signal: controller.signal })
      .then(({ data }) => {
        if (seq !== requestSeq.current) return;
        setSummary({ key, data: data as ExpenseSummary });
      })
      .catch(() => { /* the list surfaces the failure; the summary is supplementary */ });

    return () => controller.abort();
  }, [filters, refreshAuthContext, refreshKey, t]);

  const loadMore = async () => {
    if (!filters || !nextCursor) return;
    setLoadingMore(true);
    const seq = requestSeq.current;
    const key = JSON.stringify([filters, refreshKey]);
    try {
      const { data } = await api.get('/expenses', {
        params: {
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.to ? { to: filters.to } : {}),
          ...(filters.categoryId ? { category_id: filters.categoryId } : {}),
          ...(filters.currency ? { currency: filters.currency } : {}),
          ...(filters.status !== 'all' ? { status: filters.status } : {}),
          limit: LIST_PAGE_SIZE,
          cursor: nextCursor,
        },
      });
      if (seq !== requestSeq.current) return;
      setPage((previous) => ({
        key,
        rows: [...(previous.key === key ? previous.rows : []), ...(data.expenses ?? [])],
        cursor: data.nextCursor ?? null,
      }));
    } catch {
      setLoadError(t('loadFailed'));
    } finally {
      setLoadingMore(false);
    }
  };

  const currencyOptions = useMemo(() => {
    const codes = new Set<string>();
    if (context?.currency_code) codes.add(context.currency_code);
    currentSummary?.totals.forEach((total) => codes.add(total.currency_code));
    return Array.from(codes);
  }, [context, currentSummary]);

  const updateFilter = (patch: Partial<Filters>) => {
    setFilters((current) => (current ? { ...current, ...patch } : current));
  };

  if (denied) {
    return (
      <div className="dashboard-scroll-shell flex h-full min-h-0 flex-col items-center justify-center gap-2" data-testid="expenses-page">
        <p className="text-lg font-semibold" data-testid="expenses-denied">{t('permissionDenied')}</p>
      </div>
    );
  }

  return (
    <div className="dashboard-scroll-shell flex h-full min-h-0 flex-col" data-testid="expenses-page">
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{tNav('expenses')}</h1>
        {tenantCan(currentTenant, 'expenses.manage') && (
          <Button
            onClick={() => setWorkflow({ mode: 'create', expense: null })}
            disabled={!context}
            data-testid="expense-add"
          >
            <Plus size={16} className="me-1" /> {t('addTitle')}
          </Button>
        )}
      </div>

      <div className="mb-3 flex shrink-0 flex-wrap items-end gap-3" data-testid="expense-filters">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="expense-filter-from">{t('from')}</label>
          <input
            id="expense-filter-from"
            type="date"
            data-testid="expense-filter-from"
            value={filters?.from ?? ''}
            onChange={(event) => updateFilter({ from: event.target.value })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="expense-filter-to">{t('to')}</label>
          <input
            id="expense-filter-to"
            type="date"
            data-testid="expense-filter-to"
            value={filters?.to ?? ''}
            onChange={(event) => updateFilter({ to: event.target.value })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="expense-filter-category">{t('category')}</label>
          <select
            id="expense-filter-category"
            data-testid="expense-filter-category"
            value={filters?.categoryId ?? ''}
            onChange={(event) => updateFilter({ categoryId: event.target.value })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
          >
            <option value="">{t('category')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="expense-filter-status">{t('status')}</label>
          <select
            id="expense-filter-status"
            data-testid="expense-filter-status"
            value={filters?.status ?? 'active'}
            onChange={(event) => updateFilter({ status: event.target.value as ExpenseStatusFilter })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
          >
            <option value="active">{tCommon('active')}</option>
            <option value="voided">{t('statusVoided')}</option>
            <option value="replaced">{t('statusReplaced')}</option>
            <option value="all">{tOrders('allStatuses')}</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="expense-filter-currency">{t('currency')}</label>
          <select
            id="expense-filter-currency"
            data-testid="expense-filter-currency"
            value={filters?.currency ?? ''}
            onChange={(event) => updateFilter({ currency: event.target.value })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
          >
            <option value="">{t('allCurrencies')}</option>
            {currencyOptions.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-3 shrink-0 space-y-2" data-testid="expense-summary">
        {(currentSummary?.totals ?? []).map((total) => (
          <div key={total.currency_code} className="flex flex-wrap gap-3">
            <div className="min-w-40 flex-1 rounded-xl border border-border bg-card p-3" data-testid="expense-summary-incurred">
              <p className="text-xs text-muted-foreground">{t('incurred')} · {total.currency_code}</p>
              <p className="text-lg font-bold">{fmtMinor(total.incurred_minor, total.currency_code)}</p>
            </div>
            <div className="min-w-40 flex-1 rounded-xl border border-border bg-card p-3" data-testid="expense-summary-paid">
              <p className="text-xs text-muted-foreground">{t('paidToDate')}</p>
              <p className="text-lg font-bold">{fmtMinor(total.net_paid_minor, total.currency_code)}</p>
            </div>
            <div className="min-w-40 flex-1 rounded-xl border border-border bg-card p-3" data-testid="expense-summary-due">
              <p className="text-xs text-muted-foreground">{t('due')}</p>
              <p className="text-lg font-bold">{fmtMinor(total.due_minor, total.currency_code)}</p>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground" data-testid="expense-summary-basis">{t('summaryBasis')}</p>
        {(currentSummary?.groups ?? []).length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="expense-summary-groups">
            {currentSummary?.groups.map((group) => (
              <li key={`${group.currency_code}-${group.category_id}`}>
                {group.category_name} · {fmtMinor(group.due_minor, group.currency_code)} {group.currency_code}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-card" data-testid="expenses-list-scroll">
        <table className="w-full">
          <thead className="sticky top-0 bg-muted">
            <tr>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('incurred')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('description')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('payee')}</th>
              <th className="p-3 text-end text-xs font-medium uppercase text-muted-foreground">{tCommon('amount')}</th>
              <th className="p-3 text-end text-xs font-medium uppercase text-muted-foreground">{t('netPaid')}</th>
              <th className="p-3 text-end text-xs font-medium uppercase text-muted-foreground">{t('due')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('status')}</th>
              <th className="p-3 text-center text-xs font-medium uppercase text-muted-foreground">{t('openDetail')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {expenses.map((expense) => (
              <tr key={expense.id} className="hover:bg-muted" data-testid="expense-row" data-expense-id={expense.id}>
                <td className="whitespace-nowrap p-3 text-sm">{expense.incurred_on}</td>
                <td className="p-3 text-sm">
                  <p className="font-medium text-foreground">{expense.description}</p>
                  <p className="text-xs text-muted-foreground">{expense.category_name}</p>
                </td>
                <td className="p-3 text-sm text-muted-foreground">{expense.payee || '—'}</td>
                <td className="whitespace-nowrap p-3 text-end text-sm">{fmtMinor(expense.amount_minor, expense.currency_code)}</td>
                <td className="whitespace-nowrap p-3 text-end text-sm">{fmtMinor(expense.paid_minor, expense.currency_code)}</td>
                <td className="whitespace-nowrap p-3 text-end text-sm font-medium">{fmtMinor(expense.due_minor, expense.currency_code)}</td>
                <td className="p-3 text-sm">
                  {expense.status === 'active' ? tCommon('active') : expense.status === 'voided' ? t('statusVoided') : t('statusReplaced')}
                </td>
                <td className="p-3 text-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setWorkflow({ mode: 'detail', expense })}
                    data-testid="expense-open-detail"
                  >
                    {t('openDetail')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {(loading || stale) && <p className="py-10 text-center text-sm text-muted-foreground">{tCommon('loading')}</p>}
        {!loading && !stale && expenses.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground" data-testid="expenses-empty">
            <SearchX size={20} />
            <p className="text-sm">{t('empty')}</p>
          </div>
        )}
        {loadError && <p className="py-3 text-center text-sm text-red-600" role="alert">{loadError}</p>}
        {nextCursor && (
          <div className="p-3 text-center">
            <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore} data-testid="expenses-load-more">
              {tCommon('loadMore')}
            </Button>
          </div>
        )}
      </div>

      {workflow && context && (
        <ExpenseWorkflow
          mode={workflow.mode}
          expense={workflow.expense}
          categories={categories}
          context={context}
          minorFactor={minorFactor}
          onClose={() => setWorkflow(null)}
          onChanged={refresh}
          onCategoryCreated={(category) => setCategories((previous) => [...previous, category])}
          onSaved={(saved) => {
            refresh();
            setWorkflow({ mode: 'detail', expense: saved });
          }}
        />
      )}
    </div>
  );
}
