'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill, Order, OrderItem, Staff } from '@/lib/types';
import { useTranslations } from 'use-intl';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCountryByCode, getCurrencyMinorUnitFactor } from '@/lib/countries';
import { useAuthStore } from '@/store/auth';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';
import { parseDbTimestamp } from '@/lib/utils';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';

// Kept in sync with REFUND_ITEM_ELIGIBLE_STATUSES in main/services/refund.ts.
const REFUND_ELIGIBLE_ITEM_STATUSES = ['preparing', 'ready', 'served', 'completed'];
// Approximation of REFUND_WINDOW_MS in main/services/refund.ts, for the PIN hint only —
// the backend's business-day check is authoritative.
const REFUND_IN_PROGRESS_WINDOW_MS = 60 * 60 * 1000;

// Mirrors BUILT_IN_PAYMENT_KEYS in PaymentModal.tsx.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const;

// Refunds fail for many distinct reasons — surface the backend's own message instead
// of one generic toast that hides which one applies.
function extractRefundErrorMessage(error: unknown): string | null {
  const data = (error as { response?: { data?: { error?: unknown } } } | undefined)?.response?.data;
  return typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : null;
}

function getCurrentTime(): number {
  return Date.now();
}

function getConfiguredApprovers(staff: Staff[]): Staff[] {
  return staff.filter((member) => (
    member.is_active !== 0
    && Boolean(member.has_pin)
    && hasRole(member.role, ROLE_ACCESS.ownerManager)
  ));
}

interface Props {
  order: Order;
  bills: Bill[];
  onClose: () => void;
  onRefunded: () => void;
}

export default function RefundModal({ order, bills, onClose, onRefunded }: Props) {
  const t = useTranslations('orders');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const { user, currentTenant } = useAuthStore();
  const currencyCode =
    currentTenant?.currency ||
    (currentTenant?.country ? getCountryByCode(currentTenant.country)?.currency : undefined) ||
    'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currencyCode);
  const unitAdapter = useCurrencyUnitAdapter();
  const { toDisplay: toDisplayUnit, toStored: toStoredUnit, formatInput } = unitAdapter;
  const formatCurrency = useFormatCurrency();
  // Ticks while the modal is open so the hint doesn't go stale if it's left open across
  // the 1-hour mark; the backend re-checks the real time at submission regardless.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);
  const isLikelyLate = now - parseDbTimestamp(order.created_at).getTime() > REFUND_IN_PROGRESS_WINDOW_MS;

  // Split checks mean an order can have several paid bills, each with its own allocated
  // items; a fully refunded bill has nothing left, so exclude it from selection.
  const paidBills = bills.filter((b) => Number(b.paid_amount) > 0 && b.payment_status !== 'refunded');
  const [selectedBillId, setSelectedBillId] = useState<number | ''>(paidBills[0]?.id ?? '');
  const selectedBill = paidBills.find((b) => b.id === selectedBillId) || paidBills[0] || null;

  const [scope, setScope] = useState<'whole' | 'item'>('whole');
  const [itemId, setItemId] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [method, setMethod] = useState('cash');
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [reason, setReason] = useState('');
  const [overridePin, setOverridePin] = useState('');
  const [approvers, setApprovers] = useState<Staff[]>([]);
  const [approverId, setApproverId] = useState('');
  const [approversLoading, setApproversLoading] = useState(true);
  const [approversLoadFailed, setApproversLoadFailed] = useState(false);
  const [refundedSoFarCents, setRefundedSoFarCents] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/staff', { params: { active: true } })
      .then((res) => {
        if (cancelled) return;
        const staff: Staff[] = res.data?.staff || [];
        const eligibleStaff = getConfiguredApprovers(staff);
        const currentUserApprover = eligibleStaff.find((member) => String(member.id) === String(user?.id));
        const preferredId = currentUserApprover?.id || (eligibleStaff.length === 1 ? eligibleStaff[0].id : '');
        setApprovers(eligibleStaff);
        setApproverId(preferredId ? String(preferredId) : '');
        setApproversLoadFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setApprovers([]);
        setApproversLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setApproversLoading(false);
      });
    return () => { cancelled = true; };
  }, [user?.id]);

  const eligibleApprovers = approvers.filter((member) => hasRole(
    member.role,
    isLikelyLate ? ROLE_ACCESS.owner : ROLE_ACCESS.ownerManager,
  ));
  const approverIdForRefund = eligibleApprovers.some((member) => String(member.id) === approverId)
    ? approverId
    : eligibleApprovers.length === 1 ? String(eligibleApprovers[0].id) : '';
  const selectedApprover = eligibleApprovers.find((member) => String(member.id) === approverIdForRefund);

  // Bill-scoped view: order.items is order-wide and includes other split bills' items,
  // which the backend would reject for this bill.
  const [scopedBill, setScopedBill] = useState<Bill | null>(null);
  const [scopedItems, setScopedItems] = useState<OrderItem[]>([]);
  useEffect(() => {
    if (!selectedBill) return;
    let cancelled = false;
    api.get(`/bills/${selectedBill.id}`).then((res) => {
      if (cancelled) return;
      setScopedBill(res.data.bill);
      setScopedItems(res.data.bill.order?.items || []);
    }).catch(() => {
      if (cancelled) return;
      setScopedBill(selectedBill);
      setScopedItems([]);
    });
    return () => { cancelled = true; };
  }, [selectedBill]);

  const effectiveBill = scopedBill && scopedBill.id === selectedBill?.id ? scopedBill : selectedBill;
  // A split item only allocated in part to this bill has a smaller quantity here than in
  // the order-wide list; the backend refuses to refund those as a whole item.
  const originalItemById = new Map((order.items || []).map((item) => [item.id, item]));
  const eligibleItems: OrderItem[] = scopedItems.filter((item) => {
    if (!REFUND_ELIGIBLE_ITEM_STATUSES.includes(item.status)) return false;
    const original = originalItemById.get(item.id);
    return !!original && Number(item.quantity) === Number(original.quantity);
  });

  // Reset item/amount selection when the cashier switches bills (during render, so it
  // settles before paint instead of flashing the previous bill's values).
  const [syncedBillId, setSyncedBillId] = useState(selectedBillId);
  if (selectedBillId !== syncedBillId) {
    setSyncedBillId(selectedBillId);
    setItemId('');
    setAmountTouched(false);
    setScope('whole');
  }

  useEffect(() => {
    if (!effectiveBill) return;
    let cancelled = false;
    api.get('/payment-methods').then((res) => setCustomMethods(res.data.payment_methods || [])).catch(() => setCustomMethods([]));
    api.get('/settings/loyalty').then((res) => setLoyaltyEnabled(!!res.data?.loyalty_enabled)).catch(() => {});
    api.get('/refunds', { params: { bill_id: effectiveBill.id, limit: 500 } })
      .then((res) => {
        if (cancelled) return;
        const refunds: { amount_cents?: number }[] = res.data?.refunds || [];
        const total = refunds.reduce((sum, r) => sum + Number(r.amount_cents || 0), 0);
        setRefundedSoFarCents(total);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [effectiveBill]);

  const paidCents = Math.round(Number(effectiveBill?.paid_amount || 0) * minorFactor);
  const refundableCents = Math.max(0, paidCents - refundedSoFarCents);
  const refundableDisplay = toDisplayUnit(refundableCents / minorFactor);

  // Default the whole-bill amount to the refundable balance until edited; null sentinel
  // ensures this fires on first render even when there are no prior refunds to react to.
  const [syncedRefundable, setSyncedRefundable] = useState<number | null>(null);
  if (!amountTouched && refundableDisplay !== syncedRefundable) {
    setSyncedRefundable(refundableDisplay);
    setAmount(formatInput(refundableDisplay));
  }

  const selectedItem = eligibleItems.find((i) => i.id === itemId) || null;
  const amountValue = scope === 'item' && selectedItem ? toDisplayUnit(Number(selectedItem.total)) : parseFloat(amount) || 0;

  const canSubmit =
    !submitting &&
    !!effectiveBill &&
    approverIdForRefund.trim().length > 0 &&
    overridePin.trim().length > 0 &&
    method &&
    amountValue > 0 &&
    refundableCents > 0 &&
    (scope === 'whole' || !!selectedItem);

  const submit = async () => {
    if (!canSubmit || !effectiveBill) return;
    setSubmitting(true);
    try {
      const submissionNow = getCurrentTime();
      const submissionIsLate = submissionNow - parseDbTimestamp(order.created_at).getTime() > REFUND_IN_PROGRESS_WINDOW_MS;
      const staffResponse = await api.get('/staff', { params: { active: true } });
      const configuredApprovers = getConfiguredApprovers(staffResponse.data?.staff || []);
      const eligibleApproversAtSubmission = configuredApprovers.filter((member) => hasRole(
        member.role,
        submissionIsLate ? ROLE_ACCESS.owner : ROLE_ACCESS.ownerManager,
      ));
      const approverIdAtSubmission = eligibleApproversAtSubmission.some((member) => String(member.id) === approverId)
        ? approverId
        : eligibleApproversAtSubmission.length === 1 ? String(eligibleApproversAtSubmission[0].id) : '';
      setNow(submissionNow);
      setApprovers(configuredApprovers);
      setApproverId(approverIdAtSubmission);
      if (approverIdAtSubmission !== approverId) {
        setOverridePin('');
        return;
      }
      const body: Record<string, unknown> = {
        bill_id: effectiveBill.id,
        method,
        reason: reason.trim() || undefined,
        approver_id: approverIdAtSubmission,
        override_pin: overridePin,
      };
      if (scope === 'item' && selectedItem) {
        body.order_item_id = selectedItem.id;
      } else {
        body.amount = toStoredUnit(amountValue);
      }
      await api.post('/refunds', body, { headers: { 'Idempotency-Key': createPaymentIdempotencyKey() } });
      toast.success(t('refundIssued'));
      onRefunded();
      onClose();
    } catch (error) {
      toast.error(extractRefundErrorMessage(error) || t('refundFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-sm mx-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold text-foreground mb-4">
          {t('refundButton')} #{order.order_number}
        </h2>

        <div className="space-y-4">
          {paidBills.length > 1 && (
            <div>
              <label htmlFor="refundBill" className="block text-sm font-medium text-foreground mb-1">
                {t('refundBillLabel')}
              </label>
              <select
                id="refundBill"
                value={selectedBillId}
                onChange={(e) => setSelectedBillId(e.target.value ? Number(e.target.value) : '')}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                {paidBills.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.split_label || `#${b.bill_number}`} — {formatCurrency(Number(b.paid_amount))}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setScope('whole')}
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${scope === 'whole' ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted-foreground'}`}
            >
              {t('refundScopeWholeBill')}
            </button>
            <button
              type="button"
              onClick={() => setScope('item')}
              disabled={eligibleItems.length === 0}
              className={`rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${scope === 'item' ? 'border-brand bg-brand/10 text-brand' : 'border-border text-muted-foreground'}`}
            >
              {t('refundScopeItem')}
            </button>
          </div>

          {scope === 'item' && (
            eligibleItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('refundNoEligibleItems')}</p>
            ) : (
              <select
                value={itemId}
                onChange={(e) => setItemId(e.target.value ? Number(e.target.value) : '')}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">{t('refundSelectItemPlaceholder')}</option>
                {eligibleItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.product_name} — {formatCurrency(Number(item.total))}
                  </option>
                ))}
              </select>
            )
          )}

          {scope === 'whole' && (
            <div>
              <label htmlFor="refundAmount" className="block text-sm font-medium text-foreground mb-1">
                {t('refundAmountLabel')}
              </label>
              <input
                id="refundAmount"
                type="number"
                min={0}
                step="any"
                value={amount}
                onChange={(e) => { setAmountTouched(true); setAmount(e.target.value); }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t('refundBalanceLabel', { amount: formatCurrency(refundableCents / minorFactor) })}
          </p>

          <div>
            <label htmlFor="refundMethod" className="block text-sm font-medium text-foreground mb-1">
              {t('refundMethodLabel')}
            </label>
            <select
              id="refundMethod"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m.key} value={m.key}>{tPos(BUILT_IN_PAYMENT_KEYS[m.key])}</option>
              ))}
              {customMethods.filter((m) => m.is_active).map((m) => (
                <option key={m.id} value={m.name}>{m.name}</option>
              ))}
              {loyaltyEnabled && effectiveBill?.customer_id && (
                <option value="wallet">{t('refundMethodStoreCredit')}</option>
              )}
            </select>
          </div>

          <div>
            <label htmlFor="refundReason" className="block text-sm font-medium text-foreground mb-1">
              {tCommon('reasonOptional')}
            </label>
            <input
              id="refundReason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
          </div>

          {approversLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              {t('refundApproverLabel')}
            </div>
          )}

          {approversLoadFailed && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {t('refundApproverLoadFailed')}
            </p>
          )}

          {!approversLoading && !approversLoadFailed && eligibleApprovers.length === 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <p>
                {hasRole(currentTenant?.role, ROLE_ACCESS.owner)
                  ? t('refundApprovalSetupOwner')
                  : t('refundApprovalSetupStaff')}
              </p>
              {hasRole(currentTenant?.role, ROLE_ACCESS.owner) && (
                <Link href="/staff" className="mt-1 inline-block font-medium underline">
                  {t('refundOpenStaff')}
                </Link>
              )}
            </div>
          )}

          {!approversLoading && eligibleApprovers.length > 1 && (
            <div>
              <label htmlFor="refundApprover" className="block text-sm font-medium text-foreground mb-1">
                {t('refundApproverLabel')}
              </label>
              <select
                id="refundApprover"
                value={approverIdForRefund}
                onChange={(e) => setApproverId(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">{t('refundApproverPlaceholder')}</option>
                {eligibleApprovers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name} ({member.role})
                  </option>
                ))}
              </select>
            </div>
          )}

          {!approversLoading && eligibleApprovers.length === 1 && selectedApprover && (
            <p className="text-sm text-muted-foreground">
              {t('refundApproverLabel')}: <span className="font-medium text-foreground">{selectedApprover.name}</span>
            </p>
          )}

          <div>
            <label htmlFor="refundPin" className="block text-sm font-medium text-foreground mb-1">
              {t('refundApprovalPinLabel')}
            </label>
            <input
              id="refundPin"
              type="password"
              inputMode="numeric"
              value={overridePin}
              maxLength={6}
              onChange={(e) => setOverridePin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">{t('refundApprovalPinHint')}</p>
            {isLikelyLate && <p className="text-xs text-muted-foreground mt-1">{t('refundOwnerPinNotice')}</p>}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit}>
            {submitting ? <Loader2 size={14} className="animate-spin me-1.5" /> : null}
            {t('refundSubmit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
