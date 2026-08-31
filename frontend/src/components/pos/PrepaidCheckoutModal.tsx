'use client';

import { useState, useEffect, useMemo } from 'react';
import { X, Sparkles, ArrowLeftRight, CheckCircle2, User, Percent, Wallet, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { useTaxPreview } from '@/hooks/use-tax-preview';
import { useTranslations, type AppConfig } from 'use-intl';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import toast from 'react-hot-toast';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import {
  defaultDiscountTypeForMode,
  isDiscountTypeAllowed,
  normalizeDiscountMode,
  type DiscountMode,
  type DiscountType,
} from '@/lib/discount-settings';

interface LoyaltySettings {
  loyalty_enabled: boolean;
}

export interface PrepaidPayment {
  method: string;
  payment_method_id?: number;
  amount: number;
}

export interface PrepaidDiscount {
  type: DiscountType;
  value: number;
  reason?: string;
  override_pin?: string;
}

interface Props {
  currency: string;
  onClose: () => void;
  onConfirm: (payments: PrepaidPayment[], walletAmount: number, discount: PrepaidDiscount | null) => void;
}

// Loyalty points are 1:1 with currency units. Must match LOYALTY_REDEMPTION_RATE in main/routes/bills.ts.
const LOYALTY_REDEMPTION_RATE = 1;

type PosKey = keyof AppConfig['Messages']['pos'];

type OrderType = 'dine_in' | 'takeaway' | 'delivery' | 'online';

// Exhaustively typed lookup for the order-type suffix (no template-literal keys).
const ORDER_TYPE_SUFFIX_KEYS = {
  dine_in: 'orderTypeSuffix_dine_in',
  takeaway: 'orderTypeSuffix_takeaway',
  delivery: 'orderTypeSuffix_delivery',
  online: 'orderTypeSuffix_online',
} as const satisfies Record<OrderType, PosKey>;

// Built-in payment method label keys mapped to typed `pos` leaf keys.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const satisfies Record<'cash' | 'card', PosKey>;

interface Payment {
  method: string;
  payment_method_id?: number;
  amount: string;
}

export default function PrepaidCheckoutModal({ onClose, onConfirm }: Props) {
  const cart = useCartStore();
  const customer = cart.customer;
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();
  const unitAdapter = useCurrencyUnitAdapter();
  const { toDisplay: toDisplayUnit, toStored: toStoredUnit, label: inputCurrencyLabel, step: inputCurrencyStep, formatInput } = unitAdapter;

  const [loyaltySettings, setLoyaltySettings] = useState<LoyaltySettings | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletAmount, setWalletAmount] = useState('');
  const [processing, setProcessing] = useState(false);
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);

  // Discount state (applied to the order once checkout is confirmed)
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountType, setDiscountType] = useState<DiscountType>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');

  const previewDiscount = useMemo(() => {
    const rawValue = Number.parseFloat(discountValue);
    if (!Number.isFinite(rawValue) || rawValue <= 0) return null;
    return {
      type: discountType,
      value: discountType === 'percentage'
        ? Math.min(100, Math.max(0, rawValue))
        : toStoredUnit(Math.max(0, rawValue)),
    };
  }, [discountType, discountValue, toStoredUnit]);
  const { tax, loading: taxLoading } = useTaxPreview(
    cart.items,
    cart.customerId,
    undefined,
    previewDiscount,
  );

  const [payments, setPayments] = useState<Payment[]>(
    PAYMENT_METHODS.map((method) => ({ method: method.key, amount: '' })),
  );
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(false);

  if (!isDiscountTypeAllowed(discountMode, discountType)) {
    setDiscountType(defaultDiscountTypeForMode(discountMode));
    setDiscountValue('');
    setDiscountReason('');
    setDiscountPin('');
    setPaymentsTouched(false);
  }

  useEffect(() => {
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
  }, []);

  // Reset the stale balance the moment the customer changes, read directly during render
  // (React's recommended pattern for "adjusting state when a prop changes") so there's no
  // flash of the previous customer's balance; the actual fetch stays in the effect below.
  const [syncedCustomerId, setSyncedCustomerId] = useState(customer?.id ?? null);
  if ((customer?.id ?? null) !== syncedCustomerId) {
    setSyncedCustomerId(customer?.id ?? null);
    if (!customer?.id) {
      setWalletBalance(null);
    }
  }

  useEffect(() => {
    if (customer?.id) {
      api.get(`/customers/${customer.id}/wallet`)
        .then((res) => {
          setWalletBalance(Number(res.data.balance) || 0);
        })
        .catch(() => {});
    }
  }, [customer?.id]);

  // The backend preview is the settlement source of truth: it applies the same
  // discount/tax rules and active-pack payable rounding used by bill generation.
  const preview = useMemo(() => {
    if (!tax) return null;
    return {
      subtotal: tax.subtotal,
      discountAmount: tax.discount_amount,
      discountedSubtotal: tax.discounted_subtotal,
      taxAmount: tax.tax_amount,
      taxBreakdown: tax.tax_breakdown,
      packagingCharge: tax.packaging_charge,
      roundOff: tax.round_off,
      total: tax.total,
    };
  }, [tax]);

  const remaining = preview?.total ?? 0;

  // Auto-fill payment splits to match the net payable amount, but only until the cashier
  // manually edits an amount — after that, discount/wallet edits must not silently rewrite
  // amounts they've already typed in. Read directly during render (same pattern as above)
  // so we only react when the net total itself changes, not on every render.
  const [syncedRemaining, setSyncedRemaining] = useState(remaining);
  if (preview && !paymentsTouched && remaining !== syncedRemaining) {
    setSyncedRemaining(remaining);
    const walletUsed = toStoredUnit(parseFloat(walletAmount) || 0);
    const cashRemaining = Math.max(0, remaining - walletUsed);
    const totalAllocated = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    if (totalAllocated > 0) {
      const displayRemaining = toDisplayUnit(cashRemaining);
      setPayments(payments.map(p => {
        const ratio = (parseFloat(p.amount) || 0) / totalAllocated;
        return { ...p, amount: formatInput(displayRemaining * ratio) };
      }));
    }
  }

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

  const handleConfirm = () => {
    if (!preview) return;
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
    if (walletAmt > 0 && walletBalance !== null) {
      const walletPointsRequired = walletAmt * LOYALTY_REDEMPTION_RATE;
      if (walletPointsRequired > walletBalance) {
        const maxCurrency = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
        toast.error(t('walletMaxAmount', { max: currencyFmt(maxCurrency) }));
        return;
      }
    }
    if (preview.discountAmount > 0 && discountRequiresApproval && !discountPin) {
      toast.error(t('managerPinRequired'));
      return;
    }
    if (preview.discountAmount > 0 && !isDiscountTypeAllowed(discountMode, discountType)) {
      toast.error(t('discountInvalid'));
      return;
    }

    setProcessing(true);
    const splitLines: PrepaidPayment[] = payments
      .map((p) => ({
        method: p.payment_method_id === undefined ? p.method : 'custom',
        ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
        amount: toStoredUnit(parseFloat(p.amount) || 0),
      }))
      .filter((p) => p.amount > 0 && !isNaN(p.amount));

    const finalDiscount: PrepaidDiscount | null = preview.discountAmount > 0
      ? {
        type: discountType,
        value: previewDiscount?.value ?? 0,
        reason: discountReason || undefined,
        override_pin: discountRequiresApproval && discountPin ? discountPin : undefined,
      }
      : null;

    onConfirm(splitLines, walletAmt, finalDiscount);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{t('checkout')}</h2>
            <p className="text-xs text-gray-400 mt-0.5 capitalize">
              {t(ORDER_TYPE_SUFFIX_KEYS[cart.orderType])}
            </p>
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
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <p className="text-xs font-medium text-slate-400 uppercase tracking-widest">
                  {taxLoading ? t('subtotal') : t('totalDue')}
                </p>
                {taxLoading || !preview ? (
                  <div className="h-10 w-32 bg-white/10 rounded animate-pulse mt-1" />
                ) : (
                  <p className="text-4xl font-bold mt-1 tracking-tight">
                    {currencyFmt(remaining)}
                  </p>
                )}
                <p className="text-xs text-slate-400 mt-1.5">
                  {t('itemCount', { count: cart.itemCount() })}
                </p>
                {!taxLoading && preview && (
                  <div className="mt-2 space-y-1">
                    <div className="flex justify-between text-xs text-slate-300">
                      <span>{t('subtotal')}</span>
                      <span>{currencyFmt(preview.subtotal)}</span>
                    </div>
                    {preview.discountAmount > 0 && (
                      <div className="flex justify-between text-xs text-emerald-400 font-medium">
                        <span>{t('discount')}</span>
                        <span>− {currencyFmt(preview.discountAmount)}</span>
                      </div>
                    )}
                    <TaxBreakdown taxAmount={preview.taxAmount} taxBreakdown={preview.taxBreakdown} />
                    {preview.packagingCharge > 0 && (
                      <div className="flex justify-between text-xs text-slate-300">
                        <span>{t('packaging')}</span>
                        <span>{currencyFmt(preview.packagingCharge)}</span>
                      </div>
                    )}
                    {preview.roundOff !== 0 && (
                      <div className="flex justify-between text-xs text-slate-300">
                        <span>{t('roundOff')}</span>
                        <span>{preview.roundOff > 0 ? '+' : ''}{currencyFmt(preview.roundOff)}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {customer && (
                <div className="text-end ms-4 shrink-0">
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center mb-1 ms-auto">
                    <User size={16} className="text-white/70" />
                  </div>
                  <p className="text-sm font-semibold text-white leading-tight">{customer.name}</p>
                </div>
              )}
            </div>
          </div>

          {/* Loyalty Info Strip (staff reference) */}
          {loyaltySettings?.loyalty_enabled && customer && (
            <div className="flex items-center gap-2 px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl">
              <Sparkles size={13} className="text-gray-400 shrink-0" />
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span className="text-gray-700 font-medium">{t('loyalty')}</span>
                <span className="font-semibold text-gray-700">
                  {walletBalance !== null
                    ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)) })
                    : '…'}
                </span>
              </div>
            </div>
          )}

          {/* Discount */}
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <button type="button" onClick={() => setDiscountOpen((open) => !open)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 bg-gray-50 text-start">
              <span className="text-sm font-medium text-gray-700">
                {preview?.discountAmount ? `${t('discount')}: -${currencyFmt(preview.discountAmount)}` : t('applyDiscount')}
              </span>
              <ChevronDown size={16} className={`text-gray-400 transition-transform ${discountOpen ? 'rotate-180' : ''}`} />
            </button>

            {discountOpen && (
              <div className="bg-purple-50 border-t border-purple-200 p-3 space-y-2">
                <div className="flex rounded-lg overflow-hidden border border-purple-200">
                  {isDiscountTypeAllowed(discountMode, 'percentage') && (
                    <button
                      onClick={() => setDiscountType('percentage')}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      <Percent size={14} />
                      {t('percentage')}
                    </button>
                  )}
                  {isDiscountTypeAllowed(discountMode, 'amount') && (
                    <button
                      onClick={() => setDiscountType('amount')}
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
                    max={discountType === 'percentage' ? 100 : (preview ? toDisplayUnit(preview.subtotal) : undefined)}
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
                {discountValue && (
                  <Button variant="outline" size="sm" className="w-full" onClick={() => {
                    setDiscountValue('');
                    setDiscountReason('');
                    setDiscountPin('');
                    setPaymentsTouched(false);
                  }}>
                    {t('remove')}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Every method has one compact amount row; clicking its label fills the unallocated balance. */}
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
          {loyaltySettings?.loyalty_enabled && customer && walletBalance !== null && (
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

        {/* Pay Button */}
        <div className="px-5 pb-6 pt-3 border-t border-gray-100">
          <Button
            onClick={handleConfirm}
            disabled={processing || taxLoading || !preview || totalPayment < remaining - 0.01}
            className="w-full h-12 text-base font-semibold rounded-xl"
            size="lg"
          >
            {taxLoading ? t('calculatingTax') : processing ? t('processingPayment') : t('confirmPaymentAmount', { amount: currencyFmt(remaining) })}
          </Button>
        </div>
      </div>
    </div>
  );
}
