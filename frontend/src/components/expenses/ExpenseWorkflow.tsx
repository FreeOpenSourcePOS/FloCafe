'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import CurrencyAmountInput from '@/components/ui/CurrencyAmountInput';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useAmountFormat } from '@/hooks/useAmountFormat';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { displayAmountToCents } from '@/lib/money';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';
import {
  clearExpenseAttempt,
  isUnresolvedExpenseFailure,
  newExpenseAttempt,
  persistExpenseAttempt,
  readExpenseAttempt,
  withExpenseAttemptLock,
  type ExpenseAttemptKind,
  type ExpenseAttemptSnapshot,
} from '@/lib/expense-attempt';
import type {
  ExpenseCategory,
  ExpenseContext,
  ExpenseDetail,
  ExpensePaymentMethod,
  ExpensePaymentRecord,
  ExpenseRecord,
} from '@/lib/types';

const PAYMENT_METHODS: ExpensePaymentMethod[] = ['cash', 'card', 'bank_transfer', 'other'];
const PAYMENTS_PAGE_SIZE = 25;

export interface ExpenseAttemptState {
  attempt: ExpenseAttemptSnapshot | null;
  /** True when the slot could not be read, so nothing may be submitted blindly. */
  storageBlocked: boolean;
}

function readStoredAttemptState(
  user: { id: number } | null,
  tenant: { id: number } | null,
): ExpenseAttemptState {
  if (!user || !tenant) return { attempt: null, storageBlocked: false };
  try {
    return { attempt: readExpenseAttempt(user.id, tenant.id), storageBlocked: false };
  } catch {
    return { attempt: null, storageBlocked: true };
  }
}

interface ExpenseWorkflowProps {
  mode: 'create' | 'detail';
  expense: ExpenseRecord | null;
  categories: ExpenseCategory[];
  context: ExpenseContext;
  minorFactor: number;
  onClose: () => void;
  /** Re-read the filtered list and summary after a committed mutation. */
  onChanged: () => void;
  onCategoryCreated: (category: ExpenseCategory) => void;
  /** A created or replaced expense becomes the record the operator continues with. */
  onSaved: (expense: ExpenseRecord) => void;
}

interface FieldErrors {
  description?: string;
  category?: string;
  amount?: string;
  date?: string;
  reason?: string;
  form?: string;
}

/** Create form, detail view and the payment/reversal/void/replace actions. */
export default function ExpenseWorkflow({
  mode,
  expense,
  categories,
  context,
  minorFactor,
  onClose,
  onChanged,
  onCategoryCreated,
  onSaved,
}: ExpenseWorkflowProps) {
  const t = useTranslations('expenses');
  const tCommon = useTranslations('common');
  const tInventory = useTranslations('inventory');
  const tPos = useTranslations('pos');
  const { user, currentTenant } = useAuthStore();
  const fmt = useFormatCurrency();
  const { formatDate, formatDateTime } = useFormatDate();
  const amountFormat = useAmountFormat();
  const unitAdapter = useCurrencyUnitAdapter();

  const canManage = tenantCan(currentTenant, 'expenses.manage');
  const canPay = tenantCan(currentTenant, 'expenses.pay');
  const canReverse = tenantCan(currentTenant, 'expenses.reverse');
  const canMoveDrawer = tenantCan(currentTenant, 'cash.movements.manage');

  const [view, setView] = useState<'main' | 'payment' | 'reverse' | 'void' | 'replace'>('main');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [attemptState, setAttemptState] = useState<ExpenseAttemptState>(() => readStoredAttemptState(user, currentTenant));
  const [detail, setDetail] = useState<ExpenseDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(mode === 'detail');

  const descriptionRef = useRef<HTMLInputElement>(null);
  // CurrencyAmountInput owns its inner input, so focus the field through its container.
  const amountFieldRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const focusAmount = () => amountFieldRef.current?.querySelector('input')?.focus();

  // Shared form state for create/replace, which submit the same field set.
  const [categoryId, setCategoryId] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | ''>('');
  const [incurredOn, setIncurredOn] = useState(context.business_date);
  const [payee, setPayee] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');

  const [paymentMethod, setPaymentMethod] = useState<ExpensePaymentMethod>('cash');
  const [paymentAmount, setPaymentAmount] = useState<number | ''>('');
  const [paymentReference, setPaymentReference] = useState('');
  const [reversalTarget, setReversalTarget] = useState<ExpensePaymentRecord | null>(null);
  const [cashReturned, setCashReturned] = useState(false);

  const activeCategories = categories.filter((category) => category.is_active === 1);
  const attempt = attemptState.attempt;
  const setAttempt = (next: ExpenseAttemptSnapshot | null) => setAttemptState({ attempt: next, storageBlocked: false });
  // The freshly loaded record wins over the list row once it is that same record.
  const record = detail && detail.id === expense?.id ? detail : expense;
  const fmtMinor = (amountMinor: number) => fmt(amountMinor / getCurrencyMinorUnitFactor(record?.currency_code ?? context.currency_code));

  /** Replacing copies the source values into the fresh form. */
  const openReplace = () => {
    setErrors({});
    setReason('');
    if (expense) {
      setDescription(expense.description);
      setCategoryId(expense.category_id);
      setAmount(unitAdapter.toDisplay(expense.amount_minor / minorFactor));
      setIncurredOn(expense.incurred_on);
      setPayee(expense.payee ?? '');
      setNotes(expense.notes ?? '');
    }
    setView('replace');
  };

  const applyDetail = useCallback((expenseId: string, data: Record<string, unknown>, append: boolean) => {
    const payments = (data.payments ?? []) as ExpensePaymentRecord[];
    setDetail((previous) => ({
      ...(data.expense as ExpenseRecord),
      id: expenseId,
      payments: append && previous?.id === expenseId ? [...previous.payments, ...payments] : payments,
      paymentsNextCursor: (data.paymentsNextCursor as string | null) ?? null,
    }));
  }, []);

  // Reads for the open record only; paging is a separate event-driven call.
  const loadDetail = useCallback(() => {
    if (mode !== 'detail' || !expense) return;
    const expenseId = expense.id;
    api.get(`/expenses/${expenseId}`, { params: { payments_limit: PAYMENTS_PAGE_SIZE } })
      .then(({ data }) => applyDetail(expenseId, data, false))
      .catch(() => { toast.error(t('detailLoadFailed')); })
      .finally(() => setDetailLoading(false));
  }, [applyDetail, expense, mode, t]);

  const loadMorePayments = async () => {
    if (mode !== 'detail' || !expense || !paymentsCursor) return;
    const expenseId = expense.id;
    setDetailLoading(true);
    try {
      const { data } = await api.get(`/expenses/${expenseId}`, {
        params: { payments_limit: PAYMENTS_PAGE_SIZE, payments_cursor: paymentsCursor },
      });
      applyDetail(expenseId, data, true);
    } catch {
      toast.error(t('detailLoadFailed'));
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (mode !== 'detail' || !expense) return;
    loadDetail();
  }, [mode, expense, loadDetail]);

  const focusFirstError = (next: FieldErrors) => {
    if (next.description) descriptionRef.current?.focus();
    else if (next.amount) focusAmount();
    else if (next.reason) reasonRef.current?.focus();
  };

  /**
   * Persists the attempt before the request is sent, then sends it. A failure
   * with no server answer stays locked so the operator resolves the original
   * submission instead of silently getting a fresh idempotency key.
   */
  const sendMutation = async (
    kind: ExpenseAttemptKind,
    path: string,
    body: Record<string, unknown>,
    options: { paymentId?: string | null } = {},
  ): Promise<{ data: Record<string, unknown>; snapshot: ExpenseAttemptSnapshot } | null> => {
    if (!user || !currentTenant) return null;
    let persisted = false;
    setBusy(true);
    try {
      return await withExpenseAttemptLock(async () => {
        const snapshot = newExpenseAttempt({
          kind,
          path,
          expenseId: expense?.id ?? null,
          paymentId: options.paymentId ?? null,
          body,
          actorId: user.id,
          tenantId: currentTenant.id,
        });
        persistExpenseAttempt(snapshot);
        persisted = true;
        setAttempt(snapshot);
        try {
          const response = await api.post(path, body, {
            headers: { 'Idempotency-Key': snapshot.idempotencyKey },
          });
          if (clearExpenseAttempt(snapshot.actorId, snapshot.tenantId, snapshot.idempotencyKey)) setAttempt(null);
          return { data: response.data, snapshot };
        } catch (error) {
          if (isUnresolvedExpenseFailure(error)) {
            setErrors({ form: t('attemptNotice') });
            return null;
          }
          if (clearExpenseAttempt(snapshot.actorId, snapshot.tenantId, snapshot.idempotencyKey)) setAttempt(null);
          setErrors({ form: t('saveFailed') });
          return null;
        }
      });
    } catch {
      if (!persisted) {
        setAttemptState((current) => current.attempt ? current : { attempt: null, storageBlocked: true });
        setErrors({ form: t('attemptStorageBlocked') });
      } else {
        setErrors({ form: t('attemptNotice') });
      }
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** Replays the stored submission under its original key and payload. */
  const retryAttempt = async () => {
    if (!attempt) return;
    const snapshot = attempt;
    setBusy(true);
    try {
      const data = await withExpenseAttemptLock(async () => {
        const stored = readExpenseAttempt(snapshot.actorId, snapshot.tenantId);
        if (!stored || stored.idempotencyKey !== snapshot.idempotencyKey) throw new Error('Expense attempt changed');
        try {
          const response = await api.post(snapshot.path, snapshot.body, {
            headers: { 'Idempotency-Key': snapshot.idempotencyKey },
          });
          if (clearExpenseAttempt(snapshot.actorId, snapshot.tenantId, snapshot.idempotencyKey)) setAttempt(null);
          return response.data as Record<string, unknown>;
        } catch (error) {
          const status = (error as { response?: { status?: unknown } })?.response?.status;
          if (!isUnresolvedExpenseFailure(error) && status !== 401 && status !== 403) {
            if (clearExpenseAttempt(snapshot.actorId, snapshot.tenantId, snapshot.idempotencyKey)) setAttempt(null);
          }
          throw error;
        }
      });
      resolveCommitted(snapshot, data);
    } catch (error) {
      const status = (error as { response?: { status?: unknown } })?.response?.status;
      if (isUnresolvedExpenseFailure(error) || status === 401 || status === 403) {
        setErrors({ form: t('attemptNotice') });
      } else {
        setErrors({ form: t('saveFailed') });
      }
    } finally {
      setBusy(false);
    }
  };

  /** Applies a committed response: refresh from the server, keep the committed id. */
  const resolveCommitted = (snapshot: ExpenseAttemptSnapshot, data: Record<string, unknown>) => {
    setErrors({});
    onChanged();
    if (snapshot.kind === 'expense.create' || snapshot.kind === 'expense.replace') {
      const saved = data.expense as ExpenseRecord;
      toast.success(snapshot.kind === 'expense.create' ? t('createdNotice') : t('replacedNotice'));
      onSaved(saved);
      return;
    }
    if (snapshot.kind === 'expense.void') toast.success(t('voidedNotice'));
    if (snapshot.kind === 'expense.payment') toast.success(t('paymentRecorded'));
    if (snapshot.kind === 'expense.payment.reverse') toast.success(t('reversalRecorded'));
    setView('main');
    void loadDetail();
  };

  const validateObligationFields = (prefix: 'create' | 'replace'): FieldErrors => {
    const next: FieldErrors = {};
    if (!description.trim()) next.description = t('descriptionRequired');
    if (!categoryId) next.category = t('categoryRequired');
    if (!incurredOn) next.date = t('dateRequired');
    const cents = displayAmountToCents(String(amount ?? ''), unitAdapter, minorFactor);
    if (cents === null || cents <= 0) next.amount = t('amountRequired');
    if (prefix === 'replace' && !reason.trim()) next.reason = t('reasonRequired');
    return next;
  };

  const submitCreate = async () => {
    const next = validateObligationFields('create');
    setErrors(next);
    if (Object.keys(next).length > 0) {
      focusFirstError(next);
      return;
    }
    const cents = displayAmountToCents(String(amount ?? ''), unitAdapter, minorFactor);
    const result = await sendMutation('expense.create', '/expenses', {
      category_id: categoryId,
      description: description.trim(),
      amount_minor: cents,
      incurred_on: incurredOn,
      ...(payee.trim() ? { payee: payee.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
    if (result) resolveCommitted(result.snapshot, result.data);
  };

  const submitReplace = async () => {
    if (!expense) return;
    const next = validateObligationFields('replace');
    setErrors(next);
    if (Object.keys(next).length > 0) {
      focusFirstError(next);
      return;
    }
    const cents = displayAmountToCents(String(amount ?? ''), unitAdapter, minorFactor);
    const result = await sendMutation('expense.replace', `/expenses/${expense.id}/replace`, {
      category_id: categoryId,
      description: description.trim(),
      amount_minor: cents,
      incurred_on: incurredOn,
      reason: reason.trim(),
      ...(payee.trim() ? { payee: payee.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
    if (result) resolveCommitted(result.snapshot, result.data);
  };

  const openPayment = () => {
    setErrors({});
    const paymentMinorFactor = getCurrencyMinorUnitFactor(record?.currency_code ?? context.currency_code);
    setPaymentAmount(unitAdapter.toDisplay((record?.due_minor ?? 0) / paymentMinorFactor));
    setPaymentReference('');
    setCashReturned(false);
    setPaymentMethod(canMoveDrawer && context.cash_session_open ? 'cash' : 'card');
    setView('payment');
  };

  const submitPayment = async () => {
    if (!expense || !record) return;
    const paymentMinorFactor = getCurrencyMinorUnitFactor(record.currency_code);
    const cents = displayAmountToCents(String(paymentAmount ?? ''), unitAdapter, paymentMinorFactor);
    if (cents === null || cents <= 0) {
      setErrors({ amount: t('amountRequired') });
      focusAmount();
      return;
    }
    if (cents > record.due_minor) {
      setErrors({ amount: t('exceedsDue', { amount: fmtMinor(record.due_minor) }) });
      focusAmount();
      return;
    }
    setErrors({});
    const result = await sendMutation('expense.payment', `/expenses/${expense.id}/payments`, {
      amount_minor: cents,
      method: paymentMethod,
      currency_code: record.currency_code,
      ...(paymentReference.trim() ? { reference: paymentReference.trim() } : {}),
    });
    if (result) resolveCommitted(result.snapshot, result.data);
  };

  const openReversal = (payment: ExpensePaymentRecord) => {
    setErrors({});
    setReversalTarget(payment);
    setReason('');
    setCashReturned(false);
    setView('reverse');
  };

  const submitReversal = async () => {
    if (!expense || !reversalTarget) return;
    if (!reason.trim()) {
      setErrors({ reason: t('reasonRequired') });
      reasonRef.current?.focus();
      return;
    }
    if (reversalTarget.method === 'cash' && !cashReturned) {
      setErrors({ form: t('cashAckRequired') });
      return;
    }
    setErrors({});
    const result = await sendMutation(
      'expense.payment.reverse',
      `/expenses/${expense.id}/payments/${reversalTarget.id}/reverse`,
      { reason: reason.trim() },
      { paymentId: reversalTarget.id },
    );
    if (result) {
      setReversalTarget(null);
      resolveCommitted(result.snapshot, result.data);
    }
  };

  const submitVoid = async () => {
    if (!expense) return;
    if (!reason.trim()) {
      setErrors({ reason: t('reasonRequired') });
      reasonRef.current?.focus();
      return;
    }
    setErrors({});
    const result = await sendMutation('expense.void', `/expenses/${expense.id}/void`, { reason: reason.trim() });
    if (result) resolveCommitted(result.snapshot, result.data);
  };

  const createCategory = async () => {
    if (!newCategoryName.trim()) return;
    setBusy(true);
    try {
      const { data } = await api.post('/expenses/categories', { name: newCategoryName.trim() }, {
        headers: { 'Idempotency-Key': createPaymentIdempotencyKey() },
      });
      const created = data.category as ExpenseCategory;
      onCategoryCreated(created);
      setCategoryId(created.id);
      setNewCategoryName('');
      setShowNewCategory(false);
    } catch {
      setErrors({ form: t('addCategoryFailed') });
    } finally {
      setBusy(false);
    }
  };

  const open = mode === 'create' ? 'create' : view;
  const locked = attempt !== null || attemptState.storageBlocked;
  const payments = detail && detail.id === expense?.id ? detail.payments : [];
  const paymentsCursor = detail && detail.id === expense?.id ? detail.paymentsNextCursor : null;
  const hasUnreversedPayments = (record?.paid_minor ?? 0) !== 0;
  const cashBlocked = paymentMethod === 'cash' && (!canMoveDrawer || !context.cash_session_open);
  const cashReversalBlocked = reversalTarget?.method === 'cash' && (!canMoveDrawer || !context.cash_session_open);

  const fieldError = (key: keyof FieldErrors) => errors[key]
    ? <p className="mt-1 text-xs text-red-600" role="alert">{errors[key]}</p>
    : null;

  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label={tCommon('close')}
      className="w-8 h-8 flex items-center justify-center rounded-full bg-muted hover:bg-muted"
    >
      <X size={16} className="text-muted-foreground" />
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="expense-workflow">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-6 pb-4 pt-5">
          <div>
            <h2 className="text-lg font-bold text-foreground">
              {mode === 'create'
                ? t('addTitle')
                : view === 'payment'
                  ? t('paymentTitle')
                  : view === 'reverse'
                    ? t('reversalTitle')
                    : view === 'void'
                      ? t('voidTitle')
                      : view === 'replace'
                        ? t('replaceTitle')
                        : t('detailTitle')}
            </h2>
            {record && view !== 'replace' && mode === 'detail' && (
              <p className="text-sm text-muted-foreground">{record.description}</p>
            )}
          </div>
          {closeButton}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4" data-testid="expense-workflow-body">
          {(errors.form || attemptState.storageBlocked || locked) && (
            <div
              className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
              data-testid="expense-attempt-banner"
              role="status"
              aria-live="polite"
            >
              <p>{errors.form ?? (attemptState.storageBlocked ? t('attemptStorageBlocked') : t('attemptNotice'))}</p>
              {attempt && (
                <div className="mt-2 flex gap-2">
                  <Button type="button" size="sm" onClick={retryAttempt} disabled={busy} data-testid="expense-attempt-retry">
                    {t('attemptRetry')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {(open === 'create' || open === 'replace') && (
            <div className="space-y-3" data-testid="expense-form">
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="expense-category">{t('category')}</label>
                <div className="flex gap-2">
                  <select
                    id="expense-category"
                    data-testid="expense-form-category"
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="">{t('category')}</option>
                    {activeCategories.map((category) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </select>
                  <Button type="button" variant="outline" onClick={() => setShowNewCategory((value) => !value)} data-testid="expense-form-new-category">
                    {t('newCategory')}
                  </Button>
                </div>
                {fieldError('category')}
                {showNewCategory && (
                  <div className="mt-2 flex gap-2">
                    <label className="sr-only" htmlFor="expense-category-name">{t('categoryName')}</label>
                    <input
                      id="expense-category-name"
                      data-testid="expense-form-category-name"
                      value={newCategoryName}
                      onChange={(event) => setNewCategoryName(event.target.value)}
                      placeholder={t('categoryName')}
                      className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                    />
                    <Button type="button" onClick={createCategory} disabled={busy} data-testid="expense-form-category-save">
                      {tCommon('save')}
                    </Button>
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="expense-description">{t('description')}</label>
                <input
                  id="expense-description"
                  ref={descriptionRef}
                  data-testid="expense-form-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                />
                {fieldError('description')}
              </div>

              <div className="flex gap-3">
                <div className="flex-1" ref={amountFieldRef}>
                  <label className="mb-1 block text-sm font-medium" htmlFor="expense-amount">{tCommon('amount')}</label>
                  <CurrencyAmountInput
                    id="expense-amount"
                    data-testid="expense-form-amount"
                    value={amount}
                    onValueChange={setAmount}
                    format={amountFormat}
                    className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                  />
                  {fieldError('amount')}
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-sm font-medium" htmlFor="expense-incurred-on">{t('incurredOn')}</label>
                  <input
                    id="expense-incurred-on"
                    type="date"
                    data-testid="expense-form-incurred-on"
                    value={incurredOn}
                    max={context.business_date}
                    onChange={(event) => setIncurredOn(event.target.value)}
                    className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                  />
                  {fieldError('date')}
                </div>
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="mb-1 block text-sm font-medium" htmlFor="expense-payee">{t('payee')}</label>
                  <input
                    id="expense-payee"
                    data-testid="expense-form-payee"
                    value={payee}
                    onChange={(event) => setPayee(event.target.value)}
                    className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-sm font-medium" htmlFor="expense-notes">{t('notes')}</label>
                  <input
                    id="expense-notes"
                    data-testid="expense-form-notes"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder={tCommon('optional')}
                    className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                  />
                </div>
              </div>

              {open === 'replace' && (
                <div>
                  <p className="mb-1 text-sm text-muted-foreground">{t('replaceConsequence')}</p>
                  <label className="mb-1 block text-sm font-medium" htmlFor="expense-replace-reason">{tInventory('reason')}</label>
                  <textarea
                    id="expense-replace-reason"
                    ref={reasonRef}
                    data-testid="expense-form-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                  />
                  {fieldError('reason')}
                </div>
              )}
            </div>
          )}

          {mode === 'detail' && view === 'main' && record && (
            <div className="space-y-4" data-testid="expense-detail">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div className="col-span-2">
                  <dt className="text-muted-foreground">{t('description')}</dt>
                  <dd data-testid="expense-detail-description">{record.description}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{tCommon('amount')}</dt>
                  <dd className="font-semibold">{fmtMinor(record.amount_minor)} <span className="text-xs font-normal text-muted-foreground">{record.currency_code}</span></dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('incurredOn')}</dt>
                  <dd data-testid="expense-detail-incurred">{record.incurred_on}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('category')}</dt>
                  <dd data-testid="expense-detail-category">{record.category_name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('status')}</dt>
                  <dd data-testid="expense-detail-status">{record.status === 'active' ? tCommon('active') : record.status === 'voided' ? t('statusVoided') : t('statusReplaced')}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('netPaid')}</dt>
                  <dd data-testid="expense-detail-paid">{fmtMinor(record.paid_minor)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('due')}</dt>
                  <dd data-testid="expense-detail-due">{fmtMinor(record.due_minor)}</dd>
                </div>
                {record.payee && (
                  <div>
                    <dt className="text-muted-foreground">{t('payee')}</dt>
                    <dd data-testid="expense-detail-payee">{record.payee}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">{t('recordedBy')}</dt>
                  <dd>{record.created_by}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('recordedAt')}</dt>
                  <dd>{formatDateTime(record.created_at)}</dd>
                </div>
                {record.void_reason && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">{tInventory('reason')}</dt>
                    <dd data-testid="expense-detail-void-reason">{record.void_reason}</dd>
                  </div>
                )}
              </dl>

              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{t('payments')}</h3>
                {payments.length === 0 && !detailLoading && (
                  <p className="text-sm text-muted-foreground" data-testid="expense-payments-empty">{t('noPayments')}</p>
                )}
                <ul className="divide-y divide-border" data-testid="expense-payments">
                  {payments.map((payment) => (
                    <li key={payment.id} className="flex items-center justify-between gap-2 py-2" data-testid="expense-payment-row">
                      <div className="text-sm">
                        <p className={payment.reversal_of ? 'text-red-600' : 'text-foreground'}>
                          {payment.reversal_of ? '−' : '+'}{fmtMinor(payment.amount_minor)}{' '}
                          <span className="text-muted-foreground">
                            {payment.method === 'cash' ? tPos('methodCash') : payment.method === 'card' ? tPos('methodCard') : payment.method === 'bank_transfer' ? t('methodBankTransfer') : t('methodOther')}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(payment.business_date)}
                          {payment.reference ? ` · ${payment.reference}` : ''}
                          {payment.reason ? ` · ${payment.reason}` : ''}
                          {payment.cash_movement_id ? ` · #${payment.cash_movement_id}` : ''}
                        </p>
                      </div>
                      {canReverse && !payment.reversal_of && !payments.some((row) => row.reversal_of === payment.id) && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => openReversal(payment)}
                          data-testid="expense-reverse-payment"
                        >
                          {t('reversalTitle')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                {paymentsCursor && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={detailLoading}
                    onClick={() => void loadMorePayments()}
                    data-testid="expense-payments-more"
                  >
                    {tCommon('loadMore')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {open === 'payment' && record && (
            <div className="space-y-3" data-testid="expense-payment-form">
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="expense-payment-method">{t('method')}</label>
                <select
                  id="expense-payment-method"
                  data-testid="expense-payment-method"
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value as ExpensePaymentMethod)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                >
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method} disabled={method === 'cash' && !canMoveDrawer}>
                      {method === 'cash' ? tPos('methodCash') : method === 'card' ? tPos('methodCard') : method === 'bank_transfer' ? t('methodBankTransfer') : t('methodOther')}
                    </option>
                  ))}
                </select>
                {!canMoveDrawer && <p className="mt-1 text-xs text-muted-foreground">{t('cashUnavailable')}</p>}
              </div>
              <div ref={amountFieldRef}>
                <label className="mb-1 block text-sm font-medium" htmlFor="expense-payment-amount">{tCommon('amount')}</label>
                <CurrencyAmountInput
                  id="expense-payment-amount"
                  data-testid="expense-payment-amount"
                  value={paymentAmount}
                  onValueChange={setPaymentAmount}
                  format={amountFormat}
                  className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                />
                {fieldError('amount')}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="expense-payment-reference">{t('reference')}</label>
                <input
                  id="expense-payment-reference"
                  data-testid="expense-payment-reference"
                  value={paymentReference}
                  onChange={(event) => setPaymentReference(event.target.value)}
                  placeholder={tCommon('optional')}
                  className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
              <p className="rounded-lg bg-muted p-3 text-sm" data-testid="expense-payment-review">
                {t('reviewPayment', {
                  amount: fmtMinor(displayAmountToCents(String(paymentAmount ?? ''), unitAdapter, getCurrencyMinorUnitFactor(record.currency_code)) ?? 0),
                  method: paymentMethod === 'cash' ? tPos('methodCash') : paymentMethod === 'card' ? tPos('methodCard') : paymentMethod === 'bank_transfer' ? t('methodBankTransfer') : t('methodOther'),
                })}
              </p>
              {paymentMethod === 'cash' && (
                <p className="text-sm text-muted-foreground" data-testid="expense-payment-cash-notice">
                  {context.cash_session_open ? t('cashNotice') : t('cashSessionClosed')}
                </p>
              )}
            </div>
          )}

          {open === 'reverse' && reversalTarget && (
            <div className="space-y-3" data-testid="expense-reversal-form">
              <p className="text-sm" data-testid="expense-reversal-confirm">
                {t('reversalConfirm', {
                  amount: fmtMinor(reversalTarget.amount_minor),
                  method: reversalTarget.method === 'cash' ? tPos('methodCash') : reversalTarget.method === 'card' ? tPos('methodCard') : reversalTarget.method === 'bank_transfer' ? t('methodBankTransfer') : t('methodOther'),
                })}
              </p>
              {reversalTarget.method === 'cash' && (
                <>
                  <p className="text-sm text-muted-foreground">{t('cashReversalNotice')}</p>
                  {!canMoveDrawer && <p className="text-sm text-muted-foreground">{t('cashUnavailable')}</p>}
                  {!context.cash_session_open && <p className="text-sm text-muted-foreground">{t('cashSessionClosed')}</p>}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      data-testid="expense-reversal-cash-ack"
                      checked={cashReturned}
                      onChange={(event) => setCashReturned(event.target.checked)}
                    />
                    {t('cashAck')}
                  </label>
                </>
              )}
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="expense-reversal-reason">{tInventory('reason')}</label>
                <textarea
                  id="expense-reversal-reason"
                  ref={reasonRef}
                  data-testid="expense-reversal-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
                />
                {fieldError('reason')}
              </div>
            </div>
          )}

          {open === 'void' && (
            <div className="space-y-3" data-testid="expense-void-form">
              <p className="text-sm text-muted-foreground">{t('voidConsequence')}</p>
              <label className="mb-1 block text-sm font-medium" htmlFor="expense-void-reason">{tInventory('reason')}</label>
              <textarea
                id="expense-void-reason"
                ref={reasonRef}
                data-testid="expense-void-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                className="w-full rounded-lg border border-border px-3 py-2 outline-none focus:ring-2 focus:ring-brand"
              />
              {fieldError('reason')}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-4">
          <div className="flex gap-2">
            {open === 'main' && mode === 'detail' && record && (
              <>
                {canPay && (
                  <Button type="button" onClick={openPayment} disabled={busy || locked || record.status !== 'active' || record.due_minor === 0} data-testid="expense-record-payment">
                    {t('paymentTitle')}
                  </Button>
                )}
                {canManage && record.status === 'active' && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setErrors({});
                        setReason('');
                        setView('void');
                      }}
                      disabled={busy || locked || hasUnreversedPayments}
                      title={hasUnreversedPayments ? t('blockedByPayments') : undefined}
                      data-testid="expense-void"
                    >
                      {t('voidTitle')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={openReplace}
                      disabled={busy || locked || hasUnreversedPayments}
                      title={hasUnreversedPayments ? t('blockedByPayments') : undefined}
                      data-testid="expense-replace"
                    >
                      {t('replaceTitle')}
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>{tCommon('cancel')}</Button>
            {open === 'create' && (
              <Button type="button" onClick={submitCreate} disabled={busy || locked} data-testid="expense-form-submit">
                {tCommon('save')}
              </Button>
            )}
            {open === 'replace' && (
              <Button type="button" onClick={submitReplace} disabled={busy || locked} data-testid="expense-form-submit">
                {tCommon('save')}
              </Button>
            )}
            {open === 'payment' && (
              <Button type="button" onClick={submitPayment} disabled={busy || locked || cashBlocked} data-testid="expense-payment-submit">
                {t('paymentTitle')}
              </Button>
            )}
            {open === 'reverse' && (
              <Button type="button" onClick={submitReversal} disabled={busy || locked || cashReversalBlocked} data-testid="expense-reversal-submit">
                {t('reversalTitle')}
              </Button>
            )}
            {open === 'void' && (
              <Button type="button" onClick={submitVoid} disabled={busy || locked} data-testid="expense-void-submit">
                {t('voidTitle')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
