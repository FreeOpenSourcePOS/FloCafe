'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill, Order, OrderItem } from '@/lib/types';
import { useTranslations } from 'use-intl';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { getCountryByCode, getCurrencyMinorUnitFactor } from '@/lib/countries';
import { useAuthStore } from '@/store/auth';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';

// Kept in sync with REFUND_ITEM_ELIGIBLE_STATUSES in main/services/refund.ts.
const REFUND_ELIGIBLE_ITEM_STATUSES = ['preparing', 'ready', 'served', 'completed'];

// Mirrors BUILT_IN_PAYMENT_KEYS in PaymentModal.tsx.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const;

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
  const { currentTenant } = useAuthStore();
  const currencyCode =
    currentTenant?.currency ||
    (currentTenant?.country ? getCountryByCode(currentTenant.country)?.currency : undefined) ||
    'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currencyCode);
  const unitAdapter = useCurrencyUnitAdapter();
  const { toDisplay: toDisplayUnit, toStored: toStoredUnit, formatInput } = unitAdapter;
  const formatCurrency = useFormatCurrency();

  // Split checks mean an order can have several paid bills — only bills that were
  // actually paid have anything left to refund, and each has its own allocated items.
  const paidBills = bills.filter((b) => Number(b.paid_amount) > 0);
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
  const [refundedSoFarCents, setRefundedSoFarCents] = useState(0);
  const [submitting, setSubmitting] = useState(false);

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
  const eligibleItems: OrderItem[] = scopedItems.filter((item) => REFUND_ELIGIBLE_ITEM_STATUSES.includes(item.status));

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
    api.get('/payment-methods').then((res) => setCustomMethods(res.data.payment_methods || [])).catch(() => setCustomMethods([]));
    api.get('/settings/loyalty').then((res) => setLoyaltyEnabled(!!res.data?.loyalty_enabled)).catch(() => {});
    api.get('/refunds', { params: { bill_id: effectiveBill.id, limit: 500 } })
      .then((res) => {
        const refunds: { amount_cents?: number }[] = res.data?.refunds || [];
        const total = refunds.reduce((sum, r) => sum + Number(r.amount_cents || 0), 0);
        setRefundedSoFarCents(total);
      })
      .catch(() => {});
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
    overridePin.trim().length > 0 &&
    method &&
    amountValue > 0 &&
    refundableCents > 0 &&
    (scope === 'whole' || !!selectedItem);

  const submit = async () => {
    if (!canSubmit || !effectiveBill) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        bill_id: effectiveBill.id,
        method,
        reason: reason.trim() || undefined,
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
    } catch {
      toast.error(t('refundFailed'));
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

          <div>
            <label htmlFor="refundPin" className="block text-sm font-medium text-foreground mb-1">
              {t('refundPinLabel')}
            </label>
            <input
              id="refundPin"
              type="password"
              inputMode="numeric"
              value={overridePin}
              onChange={(e) => setOverridePin(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">{t('refundOwnerPinNotice')}</p>
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
