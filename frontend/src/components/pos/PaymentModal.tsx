'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Wallet, ArrowLeftRight, CheckCircle2, Sparkles, User, Percent, Send, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill } from '@/lib/types';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import { resolveTaxComponents } from '@/lib/printer/tax-components';
import { useCartStore } from '@/store/cart';
import { useConfirm } from '@/hooks/use-confirm';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { useWhatsAppReady } from '@/hooks/useWhatsAppReady';
import { sendBillViaFlo, shareBillViaWhatsApp } from '@/lib/whatsapp-share';
import { useAuthStore } from '@/store/auth';
import {
  defaultDiscountTypeForMode,
  isDiscountTypeAllowed,
  normalizeDiscountMode,
  type DiscountMode,
  type DiscountType,
} from '@/lib/discount-settings';

interface Props {
  bill: Bill;
  currency: string;
  onClose: () => void;
  onPaid: () => void;
  onBillUpdate?: (bill: Bill) => void;
}

interface Payment {
  method: string;
  payment_method_id?: number;
  amount: string;
}

// Fixed conversion rate for redeeming loyalty wallet points as payment (points per 1 currency unit).
// Must match LOYALTY_REDEMPTION_RATE in main/routes/bills.ts.
const LOYALTY_REDEMPTION_RATE = 100;

type PosKey = keyof AppConfig['Messages']['pos'];

// Built-in payment method label keys mapped to typed `pos` leaf keys.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const satisfies Record<'cash' | 'card', PosKey>;

export default function PaymentModal({ bill, onClose, onPaid, onBillUpdate }: Props) {
  const remaining = Number(bill.balance);
  const cartCustomerId = useCartStore((s) => s.customerId);
  const cartCustomer = useCartStore((s) => s.customer);
  const effectiveCustomerId = bill.customer_id || cartCustomerId || null;
  const { confirm, ConfirmDialog } = useConfirm();
  const t = useTranslations('pos');
  const locale = useLocale();
  const tCommon = useTranslations('common');
  const tOrders = useTranslations('orders');
  const tWhatsappSend = useTranslations('whatsapp.send');

  // sendBillViaFlo (shared with OrdersPage) takes a translator callback;
  // bridge the typed `whatsapp.send` namespace to that contract.
  const whatsappSendT = (key: string): string =>
    tWhatsappSend(
      key.replace(/^whatsapp\.send\./, '') as
        | 'success'
        | 'failed'
        | 'error.notConnected'
        | 'error.notOnWhatsapp'
        | 'error.blocked'
        | 'error.rateLimited',
    );
  const { currentTenant } = useAuthStore();
  const isWhatsAppReady = useWhatsAppReady();
  const unitAdapter = useCurrencyUnitAdapter();
  const { toDisplay: toDisplayUnit, toStored: toStoredUnit, label: inputCurrencyLabel, step: inputCurrencyStep, formatInput } = unitAdapter;

  const idempotencyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [bill.id]);
  const [justPaid, setJustPaid] = useState(false);
  const [sendingWa, setSendingWa] = useState(false);
  const [pointsEarned, setPointsEarned] = useState(0);
  const [payments, setPayments] = useState<Payment[]>(
    PAYMENT_METHODS.map((method) => ({ method: method.key, amount: '' })),
  );
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletAmount, setWalletAmount] = useState('');
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);

  // Discount state
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<DiscountType>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');
  const [applyingDiscount, setApplyingDiscount] = useState(false);
  const [loyaltySettings, setLoyaltySettings] = useState<{ loyalty_enabled: boolean } | null>(null);

  // Sync state with active bill discount on load or update. Read directly during render
  // (React's recommended pattern for "adjusting state when a prop changes") instead of an
  // effect, since this must run before paint and would otherwise cause a flash of stale values.
  const [syncedBill, setSyncedBill] = useState(bill);
  if (bill !== syncedBill) {
    setSyncedBill(bill);
    if (bill && Number(bill.discount_amount) > 0) {
      const nextType = (bill.discount_type === 'percentage' || bill.discount_type === 'amount')
        ? bill.discount_type
        : defaultDiscountTypeForMode(discountMode);
      setDiscountType(isDiscountTypeAllowed(discountMode, nextType) ? nextType : defaultDiscountTypeForMode(discountMode));
      setDiscountValue(String(nextType === 'amount' ? toDisplayUnit(Number(bill.discount_value || 0)) : (bill.discount_value || '')));
      setDiscountReason(bill.discount_reason || '');
      setShowDiscount(true);
    } else {
      setDiscountType('percentage');
      setDiscountValue('');
      setDiscountReason('');
      setShowDiscount(false);
    }
  }

  if (!isDiscountTypeAllowed(discountMode, discountType)) {
    setDiscountType(defaultDiscountTypeForMode(discountMode));
    setDiscountValue('');
    setDiscountReason('');
    setDiscountPin('');
  }

  // Dynamically update payment inputs when remaining balance changes, but only until the
  // cashier manually edits an amount — after that, discount/wallet edits must not silently
  // rewrite amounts they've already typed in. Same during-render pattern as above.
  const [syncedRemaining, setSyncedRemaining] = useState(remaining);
  if (!paymentsTouched && remaining !== syncedRemaining) {
    setSyncedRemaining(remaining);
    const totalAllocated = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    if (totalAllocated > 0) {
      const displayRemaining = toDisplayUnit(remaining);
      setPayments(payments.map(p => {
        const ratio = (parseFloat(p.amount) || 0) / totalAllocated;
        return { ...p, amount: formatInput(displayRemaining * ratio) };
      }));
    }
  }

  useEffect(() => {
    const custId = bill.customer_id || cartCustomerId;
    if (custId) {
      api.get(`/customers/${custId}/wallet`)
        .then((res) => {
          setWalletBalance(Number(res.data.balance) || 0);
        })
        .catch(() => setWalletBalance(0));
    }
    api.get('/settings/loyalty')
      .then((res) => setLoyaltySettings(res.data))
      .catch(() => {});
    api.get('/settings/discount')
      .then((res) => {
        setDiscountMode(normalizeDiscountMode(res.data.discount_mode));
        setDiscountRequiresApproval(!!res.data.discount_requires_approval);
      })
      .catch(() => {});
    api.get('/payment-methods')
      .then((res) => {
        const methods: CustomPaymentMethod[] = res.data.payment_methods || [];
        setCustomMethods(methods);
        setPayments((current) => [
          ...PAYMENT_METHODS.map((method) => current.find((row) => row.method === method.key && row.payment_method_id === undefined) || { method: method.key, amount: '' }),
          ...methods.map((method) => current.find((row) => row.payment_method_id === method.id) || { method: 'custom', payment_method_id: method.id, amount: '' }),
        ]);
      })
      .catch(() => setCustomMethods([]));
  }, [bill.customer_id, cartCustomerId]);

  const walletAmt = toStoredUnit(parseFloat(walletAmount) || 0);
  const totalPayment = payments.reduce((s, p) => s + toStoredUnit(parseFloat(p.amount) || 0), 0) + walletAmt;

  const updatePaymentAmount = (idx: number, value: string) => {
    setPaymentsTouched(true);
    setPayments(payments.map((payment, index) => index === idx ? { ...payment, amount: value } : payment));
  };

  const allocateRemainingTo = (idx: number) => {
    const allocatedElsewhere = payments.reduce((sum, payment, index) => index === idx ? sum : sum + toStoredUnit(parseFloat(payment.amount) || 0), walletAmt);
    const dueStored = Math.max(0, remaining - allocatedElsewhere);
    const dueDisplay = toDisplayUnit(dueStored);
    setPaymentsTouched(true);
    setPayments(payments.map((payment, index) => index === idx ? { ...payment, amount: dueDisplay > 0 ? String(dueDisplay) : '' } : payment));
  };

  const hasCash = payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);

  const change = hasCash && totalPayment > remaining + 0.009
    ? parseFloat((totalPayment - remaining).toFixed(2))
    : 0;

  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();

  const handleApplyDiscount = async (customVal?: number) => {
    if (applyingDiscount) return;
    const val = customVal !== undefined ? customVal : parseFloat(discountValue);
    if (customVal === undefined && (isNaN(val) || val < 0)) {
      toast.error(t('discountInvalid'));
      return;
    }
    // Check if PIN is required
    if (discountRequiresApproval && val > 0 && !discountPin) {
      toast.error(t('managerPinRequired'));
      return;
    }
    if (val > 0 && !isDiscountTypeAllowed(discountMode, discountType)) {
      toast.error(t('discountInvalid'));
      return;
    }
    setApplyingDiscount(true);
    try {
      const storedDiscountValue = discountType === 'amount' && customVal === undefined ? toStoredUnit(val) : val;
      await api.patch(`/orders/${bill.order_id}/discount`, {
        discount_type: discountType,
        discount_value: storedDiscountValue,
        discount_reason: val > 0 ? discountReason || undefined : undefined,
        override_pin: discountRequiresApproval && val > 0 ? discountPin : undefined,
      });
      toast.success(val === 0 ? t('discountRemoved') : t('discountUpdated'));
      setDiscountPin('');
      if (val === 0) {
        setShowDiscount(false);
        setDiscountValue('');
        setDiscountReason('');
      }
      // Refresh bill without closing modal
      const { data } = await api.get(`/bills/order/${bill.order_id}`);
      if (data.bill && onBillUpdate) {
        onBillUpdate(data.bill);
      }
    } catch {
      toast.error(t('failedToUpdateDiscount'));
      // Clear the PIN on any failure (wrong PIN or rate-limited) so a stale/rejected
      // PIN doesn't sit in the field looking like it might still work on retry.
      setDiscountPin('');
    } finally {
      setApplyingDiscount(false);
    }
  };

  const handlePay = async () => {
    const amountIsValid = (value: string) => value.trim() === '' || /^\d+(?:\.\d{1,4})?$/.test(value.trim());
    if (payments.some((p) => (
      !PAYMENT_METHODS.some((allowed) => allowed.key === p.method)
      && !customMethods.some((method) => method.id === p.payment_method_id)
    ) || !amountIsValid(p.amount))) {
      toast.error(t('paymentFailed'));
      return;
    }
    if (walletAmount.trim() && !/^\d+(?:\.\d{1,4})?$/.test(walletAmount.trim())) {
      toast.error(t('paymentFailed'));
      return;
    }
    const nonCashTotal = payments
      .filter((p) => p.method !== 'cash')
      .reduce((sum, p) => sum + toStoredUnit(Number(p.amount) || 0), 0) + walletAmt;
    if (nonCashTotal > remaining + 0.000001) {
      toast.error(t('paymentAboveBalance'));
      return;
    }
    if (totalPayment < remaining - 0.01) {
      toast.error(t('paymentBelowBalance'));
      return;
    }
    // Validate wallet amount against available balance (convert currency to points for comparison)
    if (walletAmt > 0 && walletBalance !== null) {
      const redemptionRate = LOYALTY_REDEMPTION_RATE;
      const walletPointsRequired = walletAmt * redemptionRate;
      if (walletPointsRequired > walletBalance) {
        const maxCurrency = Math.floor(walletBalance / redemptionRate);
        toast.error(t('walletMaxAmount', { max: currencyFmt(maxCurrency) }));
        return;
      }
    }
    setProcessing(true);
    try {
      const splitLines = payments
        .map((p) => ({
          method: p.payment_method_id === undefined ? p.method : 'custom',
          ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
          amount: toStoredUnit(parseFloat(p.amount) || 0),
        }))
        .filter((p) => p.amount > 0 && !isNaN(p.amount));
      if (walletAmt > 0) splitLines.push({ method: 'wallet', amount: walletAmt });

      // Single atomic call (#177) — either every split line is applied, or none are.
      // Sequential per-line requests would leave the bill partially paid if a later
      // line failed (e.g. network drop) after an earlier one had already committed.
      const idempotencyKey = idempotencyKeyRef.current || (typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : 'payment-req');
      idempotencyKeyRef.current = idempotencyKey;
      const res = await api.post(
        `/bills/${bill.id}/payments`,
        { payments: splitLines, customer_id: effectiveCustomerId },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
      const updatedBill = res.data?.bill as Bill | undefined;
      if (!updatedBill || updatedBill.payment_status !== 'paid') {
        // This request committed a partial payment, so the next attempt is a
        // new request and must not reuse the completed request's hash.
        if (updatedBill) idempotencyKeyRef.current = null;
        if (updatedBill && onBillUpdate) onBillUpdate(updatedBill);
        toast.error(t('paymentIncomplete', {
          amount: currencyFmt(Number(updatedBill?.balance) || 0),
        }));
        return;
      }
      const earned = res.data?.loyaltyPointsEarned > 0 ? res.data.loyaltyPointsEarned : 0;
      setPointsEarned(earned);
      if (earned > 0) {
        toast.success(t('paymentRecordedWithPoints', { points: earned }));
      } else {
        toast.success(t('paymentRecorded'));
      }
      setJustPaid(true);
    } catch {
      toast.error(t('paymentFailed'));
    } finally {
      setProcessing(false);
    }
  };

  const tenantForShare = {
    business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
    currency: currentTenant?.currency || 'INR',
    country: currentTenant?.country || 'IN',
  };

  const handleSendWhatsApp = async () => {
    const phone = cartCustomer?.phone;
    if (!phone) {
      toast.error(tWhatsappSend('customerPhoneRequired'));
      return;
    }
    setSendingWa(true);
    try {
      await sendBillViaFlo(bill, phone, tenantForShare, whatsappSendT, { pointsEarned });
    } finally {
      setSendingWa(false);
    }
  };

  const handleShareWhatsApp = () => {
    if (!cartCustomer?.phone) {
      toast.error(tWhatsappSend('customerPhoneRequired'));
      return;
    }
    try {
      shareBillViaWhatsApp(
        bill,
        { phone: cartCustomer.phone, country_code: cartCustomer.country_code },
        tenantForShare,
        { pointsEarned },
        locale,
      );
    } catch {
      toast.error(tOrders('whatsappFailed'));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{t('payment')}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{t('billNumber', { number: bill.bill_number })}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200 text-gray-500 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 max-h-[75vh] overflow-y-auto">

          {/* Amount + Customer Card */}
          <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl px-5 py-4 text-white">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-xs font-medium text-slate-400 uppercase tracking-widest">{t('totalDue')}</p>
                <p className="text-4xl font-bold mt-1 tracking-tight">{currencyFmt(remaining)}</p>
              </div>
              {cartCustomer && (
                <div className="text-end ms-4 shrink-0">
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center mb-1 ms-auto">
                    <User size={16} className="text-white/70" />
                  </div>
                  <p className="text-sm font-semibold text-white leading-tight">{cartCustomer.name}</p>
                </div>
              )}
            </div>

            <div className="border-t border-white/10 pt-3 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-300">
                <span>{t('subtotal')}</span>
                <span>{currencyFmt(Number(bill.subtotal))}</span>
              </div>
              {Number(bill.discount_amount) > 0 && (
                <div className="flex justify-between text-emerald-400 font-medium">
                  <span>{t('discount')}</span>
                  <span>− {currencyFmt(Number(bill.discount_amount))}</span>
                </div>
              )}
              <TaxBreakdown taxAmount={Number(bill.tax_amount)} taxBreakdown={resolveTaxComponents(bill).map((component) => ({
                ...component,
                rate: component.rate ?? 0,
              }))} />
              {Number(bill.delivery_charge) > 0 && (
                <div className="flex justify-between text-slate-300">
                  <span>{t('delivery')}</span>
                  <span>{currencyFmt(Number(bill.delivery_charge))}</span>
                </div>
              )}
              {Number(bill.packaging_charge) > 0 && (
                <div className="flex justify-between text-slate-300">
                  <span>{t('packaging')}</span>
                  <span>{currencyFmt(Number(bill.packaging_charge))}</span>
                </div>
              )}
              {Number(bill.round_off) !== 0 && (
                <div className="flex justify-between text-slate-300">
                  <span>{t('roundOff')}</span>
                  <span>{Number(bill.round_off) > 0 ? '+' : ''}{currencyFmt(Number(bill.round_off))}</span>
                </div>
              )}
              <div className="flex justify-between text-white font-semibold border-t border-white/10 pt-1.5 mt-1">
                <span>{t('total')}</span>
                <span>{currencyFmt(Number(bill.total))}</span>
              </div>
            </div>
          </div>

          {/* Loyalty Info Strip (staff reference) */}
          {loyaltySettings?.loyalty_enabled && effectiveCustomerId && (
            <div className="flex items-center gap-2 px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl">
              <Sparkles size={13} className="text-gray-400 shrink-0" />
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span className="text-gray-700 font-medium">{t('loyalty')}</span>
                <span className="font-semibold text-gray-700">
                  {walletBalance !== null
                    ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE))) })
                    : '…'}
                </span>
              </div>
            </div>
          )}

          {/* Discount */}
          {!bill.split_group_id && <div className="rounded-xl border border-gray-200 overflow-hidden">
            <button type="button" onClick={() => setShowDiscount((open) => !open)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 bg-gray-50 text-start">
              <span className="text-sm font-medium text-gray-700">
                {Number(bill.discount_amount) > 0
                  ? `${t('discount')}: -${currencyFmt(Number(bill.discount_amount))}`
                  : t('applyDiscount')}
              </span>
              <ChevronDown size={16} className={`text-gray-400 transition-transform ${showDiscount ? 'rotate-180' : ''}`} />
            </button>

            {showDiscount && (
              <div className="bg-purple-50 border-t border-purple-200 p-3 space-y-2">
                <div className="flex rounded-lg overflow-hidden border border-purple-200">
                  {isDiscountTypeAllowed(discountMode, 'percentage') && (
                    <button
                      onClick={() => { setDiscountType('percentage'); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      <Percent size={14} />
                      {t('percentage')}
                    </button>
                  )}
                  {isDiscountTypeAllowed(discountMode, 'amount') && (
                    <button
                      onClick={() => { setDiscountType('amount'); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${discountType === 'amount' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      {t('flatAmount')}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <span className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                    {discountType === 'percentage' ? '%' : inputCurrencyLabel}
                  </span>
                  <input
                    type="number"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountType === 'percentage' ? '0' : '0.00'}
                    min="0"
                    max={discountType === 'percentage' ? 100 : toDisplayUnit(Number(bill.subtotal))}
                    step={discountType === 'percentage' ? 1 : inputCurrencyStep}
                    className="w-full ps-8 pe-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                  />
                </div>
                <input
                  type="text"
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  placeholder={t('discountReasonPlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                />
                {discountRequiresApproval && parseFloat(discountValue) > 0 && (
                  <input
                    type="password"
                    value={discountPin}
                    onChange={(e) => setDiscountPin(e.target.value)}
                    placeholder={t('managerPin')}
                    maxLength={6}
                    className="w-full px-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                  />
                )}
                <Button
                  size="sm"
                  onClick={() => handleApplyDiscount()}
                  disabled={applyingDiscount || discountValue === '' || isNaN(parseFloat(discountValue))}
                  className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                >
                  {applyingDiscount
                    ? t('applyingDiscount')
                    : Number(bill.discount_amount) > 0 ? t('updateDiscount') : t('applyDiscount')}
                </Button>
                {Number(bill.discount_amount) > 0 && (
                  <Button variant="outline" size="sm" className="w-full" onClick={async () => {
                    if (await confirm(t('removeDiscountConfirm'), { destructive: true, confirmLabel: t('remove') })) void handleApplyDiscount(0);
                  }}>
                    {t('remove')}
                  </Button>
                )}
              </div>
            )}
          </div>}

          <div className="space-y-2">
            {payments.map((payment, idx) => {
              const builtIn = PAYMENT_METHODS.find((method) => method.key === payment.method && payment.payment_method_id === undefined);
              const custom = customMethods.find((method) => method.id === payment.payment_method_id);
              const label = builtIn ? t(BUILT_IN_PAYMENT_KEYS[builtIn.key]) : custom?.name || tCommon('unknown');
              const Icon = builtIn?.icon;
              const active = (parseFloat(payment.amount) || 0) > 0;
              return <div key={payment.payment_method_id === undefined ? payment.method : `custom:${payment.payment_method_id}`} className="flex h-11">
                <button type="button" title={label} onClick={() => allocateRemainingTo(idx)} className={`w-36 shrink-0 rounded-s-xl border px-3 flex items-center gap-2 text-sm font-semibold transition-colors ${active ? 'bg-brand text-white border-brand' : 'bg-gray-50 text-gray-700 border-gray-200 hover:border-brand hover:text-brand'}`}>
                  {Icon && <Icon size={15} />}
                  <span className="truncate">{label}</span>
                </button>
                <div className="flex flex-1 items-center border border-s-0 border-gray-200 rounded-e-xl bg-white focus-within:ring-2 focus-within:ring-brand focus-within:border-transparent">
                  <span className="ps-3 text-gray-400 text-xs">{inputCurrencyLabel}</span>
                  <input
                    type="number"
                    value={payment.amount}
                    onChange={(e) => updatePaymentAmount(idx, e.target.value)}
                    placeholder="0.00"
                    className="min-w-0 flex-1 px-2 py-2 text-end text-sm font-semibold outline-none rounded-e-xl"
                    step={inputCurrencyStep}
                    min="0"
                  />
                </div>
              </div>;
            })}
          </div>

          {/* Change Returned */}
          {hasCash && (
            <div className={`rounded-xl px-4 py-3 flex items-center justify-between border-2 transition-all duration-200 ${
              change > 0
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-gray-50 border-gray-200'
            }`}>
              <div className="flex items-center gap-2.5">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center ${
                  change > 0 ? 'bg-emerald-100' : 'bg-gray-200'
                }`}>
                  {change > 0
                    ? <CheckCircle2 size={15} className="text-emerald-600" />
                    : <ArrowLeftRight size={13} className="text-gray-400" />
                  }
                </div>
                <span className={`text-sm font-semibold ${
                  change > 0 ? 'text-emerald-800' : 'text-gray-400'
                }`}>
                  {t('changeReturned')}
                </span>
              </div>
              <span className={`text-xl font-bold tabular-nums ${
                change > 0 ? 'text-emerald-600' : 'text-gray-300'
              }`}>
                {currencyFmt(change)}
              </span>
            </div>
          )}

          {/* Loyalty Wallet Section */}
          {loyaltySettings?.loyalty_enabled && effectiveCustomerId && walletBalance !== null && (
            <div className="space-y-1">
              <div className="flex h-11">
                <button type="button" disabled={walletBalance <= 0} onClick={() => {
                  const allocatedElsewhere = payments.reduce((sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0), 0);
                  const maxWalletStored = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
                  const dueStored = Math.min(maxWalletStored, Math.max(0, remaining - allocatedElsewhere));
                  const dueDisplay = toDisplayUnit(dueStored);
                  setWalletAmount(dueDisplay > 0 ? String(dueDisplay) : '');
                }} className={`w-36 shrink-0 rounded-s-xl border px-3 flex items-center gap-2 text-sm font-semibold ${walletAmt > 0 ? 'bg-purple-600 text-white border-purple-600' : 'bg-purple-50 text-purple-800 border-purple-200 disabled:bg-gray-50 disabled:text-gray-400 disabled:border-gray-200'}`}>
                  <Wallet size={15} /><span className="truncate">{t('loyaltyWallet')}</span>
                </button>
                <div className="flex flex-1 items-center border border-s-0 border-purple-200 rounded-e-xl bg-white focus-within:ring-2 focus-within:ring-purple-400">
                  <span className="ps-3 text-gray-400 text-xs">{inputCurrencyLabel}</span>
                  <input
                    type="number"
                    value={walletAmount}
                    onChange={(e) => {
                      const v = e.target.value;
                      const maxWalletCurrencyStored = Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE));
                      const maxDisplay = toDisplayUnit(Math.min(maxWalletCurrencyStored, remaining));
                      const clamped = parseFloat(v) > maxDisplay ? String(maxDisplay) : v;
                      setWalletAmount(clamped);
                    }}
                    placeholder="0.00"
                    disabled={walletBalance <= 0}
                    className="min-w-0 flex-1 px-2 py-2 text-end text-sm font-semibold outline-none rounded-e-xl disabled:bg-gray-50"
                    step={inputCurrencyStep}
                    min="0"
                    max={toDisplayUnit(Math.min(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE)), remaining))}
                  />
                </div>
              </div>
              <p className="px-1 text-[11px] text-gray-400 text-end">{walletBalance > 0 ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)) }) : t('noBalance')}</p>
            </div>
          )}
        </div>

        <div className="px-5 pb-5 border-t border-gray-100 pt-3 space-y-2">
          {justPaid ? (
            <>
              {cartCustomer?.phone && (
                isWhatsAppReady ? (
                  <Button
                    onClick={handleSendWhatsApp}
                    disabled={sendingWa}
                    className="w-full bg-emerald-600 hover:bg-emerald-700"
                    size="lg"
                  >
                    <Send size={16} className="me-2" />
                    {sendingWa ? t('processingPayment') : t('sendViaWhatsApp')}
                  </Button>
                ) : (
                  <Button
                    onClick={handleShareWhatsApp}
                    variant="outline"
                    className="w-full"
                    size="lg"
                  >
                    <Send size={16} className="me-2" />
                    {tCommon('shareViaWhatsApp')}
                  </Button>
                )
              )}
              <Button onClick={onPaid} variant="outline" className="w-full" size="lg">
                {tCommon('done')}
              </Button>
            </>
          ) : (
            <Button onClick={handlePay} disabled={processing || totalPayment < remaining - 0.01} className="w-full" size="lg">
              {processing ? t('processingPayment') : `${t('pay')} ${currencyFmt(totalPayment)}`}
            </Button>
          )}
        </div>
      </div>
      {ConfirmDialog}
    </div>
  );
}
