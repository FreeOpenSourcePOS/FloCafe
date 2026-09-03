'use client';

import { useState, useEffect, useMemo } from 'react';
import { X, Sparkles, ArrowLeftRight, CheckCircle2, Percent, Wallet, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { useAuthStore } from '@/store/auth';
import { useTaxPreview } from '@/hooks/use-tax-preview';
import { useTranslations, type AppConfig } from 'use-intl';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import toast from 'react-hot-toast';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCountryByCode, getCurrencyMinorUnitFactor } from '@/lib/countries';
import { getDiscountInputStep, normalizeFixedDiscountValue } from '@/lib/currency-input';
import { CurrencyTouchNumberPad } from '@/components/pos/TouchNumberPad';
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

type AmountTarget = { kind: 'payment'; index: number } | { kind: 'wallet' } | { kind: 'discount' } | null;

export default function PrepaidCheckoutModal({ currency, onClose, onConfirm }: Props) {
  const cart = useCartStore();
  const customer = cart.customer;
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();
  const unitAdapter = useCurrencyUnitAdapter();
  const { toDisplay: toDisplayUnit, toStored: toStoredUnit, label: inputCurrencyLabel, step: inputCurrencyStep, formatInput } = unitAdapter;
  const { currentTenant } = useAuthStore();
  const currencyCode =
    currentTenant?.currency ||
    (currentTenant?.country ? getCountryByCode(currentTenant.country)?.currency : undefined) ||
    'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currencyCode);
  const toMinorUnits = (amount: number) => Math.round(amount * minorFactor);

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
  const [amountTarget, setAmountTarget] = useState<AmountTarget>(null);

  const previewDiscount = useMemo(() => {
    const rawValue = Number.parseFloat(discountValue);
    if (!Number.isFinite(rawValue) || rawValue <= 0) return null;
    const normalizedValue = discountType === 'amount'
      ? normalizeFixedDiscountValue(rawValue, unitAdapter.maxDecimals)
      : Math.min(100, Math.max(0, rawValue));
    if (discountType === 'amount' && normalizedValue <= 0) return null;
    return {
      type: discountType,
      value: discountType === 'percentage' ? normalizedValue : toStoredUnit(normalizedValue),
    };
  }, [discountType, discountValue, toStoredUnit, unitAdapter.maxDecimals]);
  const rawDiscountValue = Number.parseFloat(discountValue);
  const normalizedFixedDiscountValue = discountType === 'amount'
    && Number.isFinite(rawDiscountValue)
    && rawDiscountValue > 0
    ? normalizeFixedDiscountValue(rawDiscountValue, unitAdapter.maxDecimals)
    : null;
  const hasInvalidFixedDiscount = normalizedFixedDiscountValue === 0;
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
  const totalPaymentMinor = payments.reduce((s, p) => s + toMinorUnits(toStoredUnit(parseFloat(p.amount) || 0)), 0) + toMinorUnits(walletAmt);
  const totalPayment = totalPaymentMinor / minorFactor;
  const remainingMinor = toMinorUnits(remaining);

  const updatePaymentAmount = (idx: number, value: string) => {
    setPaymentsTouched(true);
    setPayments((current) => current.map((payment, index) => index === idx ? { ...payment, amount: value } : payment));
  };

  const allocateRemainingTo = (idx: number) => {
    const allocatedElsewhere = payments.reduce((sum, payment, index) => index === idx ? sum : sum + toStoredUnit(parseFloat(payment.amount) || 0), walletAmt);
    const dueStored = Math.max(0, remaining - allocatedElsewhere);
    const dueDisplay = toDisplayUnit(dueStored);
    setPaymentsTouched(true);
    setPayments(payments.map((payment, index) => index === idx ? { ...payment, amount: dueDisplay > 0 ? String(dueDisplay) : '' } : payment));
  };

  const hasCash = payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);
  const change = hasCash && totalPaymentMinor > remainingMinor
    ? (totalPaymentMinor - remainingMinor) / minorFactor
    : 0;

  const activeAmountValue = amountTarget?.kind === 'payment'
    ? payments[amountTarget.index]?.amount || ''
    : amountTarget?.kind === 'wallet'
      ? walletAmount
      : amountTarget?.kind === 'discount'
        ? discountValue
        : '';

  const updateActiveAmount = (value: string) => {
    if (!amountTarget) return;
    if (amountTarget.kind === 'payment') {
      updatePaymentAmount(amountTarget.index, value);
      return;
    }
    if (amountTarget.kind === 'wallet') {
      const maxWalletCurrencyStored = Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE);
      const maxDisplay = toDisplayUnit(Math.min(maxWalletCurrencyStored, remaining));
      const clamped = parseFloat(value) > maxDisplay ? String(maxDisplay) : value;
      setWalletAmount(clamped);
      setPaymentsTouched(true);
      return;
    }
    setDiscountValue(value);
  };

  const activeAmountMax = amountTarget?.kind === 'discount'
    ? discountType === 'percentage' ? 100 : preview ? toDisplayUnit(preview.subtotal) : undefined
    : amountTarget?.kind === 'wallet'
      ? toDisplayUnit(Math.min(Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE), remaining))
      : undefined;

  const activeAmountQuickValues = (() => {
    if (amountTarget?.kind === 'payment') {
      const allocatedElsewhere = payments.reduce((sum, payment, index) => (
        index === amountTarget.index ? sum : sum + toStoredUnit(parseFloat(payment.amount) || 0)
      ), walletAmt);
      const dueDisplay = toDisplayUnit(Math.max(0, remaining - allocatedElsewhere));
      return dueDisplay > 0 ? [{ label: t('exactAmount'), value: String(dueDisplay) }] : [];
    }
    if (amountTarget?.kind === 'wallet') {
      const allocatedElsewhere = payments.reduce((sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0), 0);
      const maxWalletStored = Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE);
      const dueDisplay = toDisplayUnit(Math.min(maxWalletStored, Math.max(0, remaining - allocatedElsewhere)));
      return dueDisplay > 0 ? [{ label: t('exactAmount'), value: String(dueDisplay) }] : [];
    }
    return [];
  })();

  const handleConfirm = () => {
    if (hasInvalidFixedDiscount) {
      toast.error(unitAdapter.maxDecimals === 0 ? t('fixedDiscountMinimum') : t('discountInvalid'));
      return;
    }
    if (!preview) return;
    const decimalPart = unitAdapter.maxDecimals > 0 ? `(?:\\.\\d{1,${unitAdapter.maxDecimals}})?` : '';
    const amountPattern = new RegExp(`^\\d+${decimalPart}$`);
    const amountIsValid = (value: string) => value.trim() === '' || amountPattern.test(value.trim());
    if (payments.some((p) => (
      !PAYMENT_METHODS.some((allowed) => allowed.key === p.method)
      && !customMethods.some((method) => method.id === p.payment_method_id)
    ) || !amountIsValid(p.amount))) {
      toast.error(t('paymentFailed'));
      return;
    }
    if (walletAmount.trim() && !amountPattern.test(walletAmount.trim())) {
      toast.error(t('paymentFailed'));
      return;
    }
    const nonCashTotalMinor = payments
      .filter((p) => p.method !== 'cash')
      .reduce((sum, p) => sum + toMinorUnits(toStoredUnit(Number(p.amount) || 0)), 0) + toMinorUnits(walletAmt);
    if (nonCashTotalMinor > remainingMinor) {
      toast.error(t('paymentAboveBalance'));
      return;
    }
    if (totalPaymentMinor < remainingMinor) {
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
      <div className="bg-card flex max-h-[95vh] w-full flex-col overflow-hidden rounded-t-3xl shadow-2xl sm:max-w-md sm:rounded-2xl">

        {/* Compact header and bill summary share one block to preserve vertical space. */}
        <div className="shrink-0 border-b border-border px-5 pb-3 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-foreground">{t('checkout')}</h2>
              <p className="mt-0.5 truncate text-xs capitalize text-muted-foreground">
                {t(ORDER_TYPE_SUFFIX_KEYS[cart.orderType])}
                {customer ? ` · ${customer.name}` : ''}
              </p>
            </div>
            <button
              onClick={onClose}
              className="touch-target rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
              aria-label={t('close')}
            >
              <X size={16} />
            </button>
          </div>

          {taxLoading || !preview ? (
            <div className="mt-3 h-24 animate-pulse rounded-xl bg-muted" />
          ) : (
            <div className="mt-3 space-y-1 text-sm tabular-nums">
              <div className="flex justify-between text-foreground">
                <span>{t('itemCount', { count: cart.itemCount() })}</span>
                <span>{currencyFmt(preview.subtotal)}</span>
              </div>
              {preview.discountAmount > 0 && (
                <div className="flex justify-between font-medium text-emerald-600">
                  <span>{t('discount')}</span>
                  <span>− {currencyFmt(preview.discountAmount)}</span>
                </div>
              )}
              <div className="flex justify-between text-muted-foreground">
                <span>{t('subtotal')}</span>
                <span>{currencyFmt(preview.discountedSubtotal)}</span>
              </div>
              <TaxBreakdown taxAmount={preview.taxAmount} taxBreakdown={preview.taxBreakdown} theme="light" />
              {preview.packagingCharge > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('packaging')}</span>
                  <span>{currencyFmt(preview.packagingCharge)}</span>
                </div>
              )}
              {preview.roundOff !== 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('roundOff')}</span>
                  <span>{preview.roundOff > 0 ? '+' : ''}{currencyFmt(preview.roundOff)}</span>
                </div>
              )}
              <div className="mt-2 flex items-end justify-between border-t border-border pt-2 font-bold text-foreground">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('totalDue')}</span>
                <span className="text-xl leading-none">{currencyFmt(remaining)}</span>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setDiscountOpen((open) => !open)}
            className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted px-2 text-xs font-medium text-foreground transition-colors hover:border-brand hover:text-brand"
            aria-expanded={discountOpen}
          >
            {preview?.discountAmount ? `${t('discount')}: -${currencyFmt(preview.discountAmount)}` : t('discounts')}
            <ChevronDown size={12} className={`transition-transform ${discountOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        <div className="min-h-0 space-y-3 overflow-y-auto px-5 py-3">

          {/* Cart-level discount editor. */}
          {discountOpen && (
            <div className="overflow-hidden rounded-xl border border-purple-200 bg-purple-50 p-3 space-y-2">
                <div className="flex rounded-lg overflow-hidden border border-purple-200">
                  {isDiscountTypeAllowed(discountMode, 'percentage') && (
                    <button
                      onClick={() => setDiscountType('percentage')}
                      className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-purple-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
                    >
                      <Percent size={14} />
                      {t('percentage')}
                    </button>
                  )}
                  {isDiscountTypeAllowed(discountMode, 'amount') && (
                    <button
                      onClick={() => setDiscountType('amount')}
                      className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'amount' ? 'bg-purple-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
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
                    onFocus={() => setAmountTarget({ kind: 'discount' })}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountType === 'percentage' ? '0' : '0.00'}
                    min="0"
                    max={discountType === 'percentage' ? 100 : (preview ? toDisplayUnit(preview.subtotal) : undefined)}
                    step={getDiscountInputStep(unitAdapter.maxDecimals, discountType)}
                    inputMode={discountType === 'percentage' ? 'numeric' : 'decimal'}
                    className="w-full min-h-11 ps-8 pe-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
                  />
                </div>
                <input
                  type="text"
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  placeholder={t('discountReasonPlaceholder')}
                  className="w-full min-h-11 px-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
                />
                {discountRequiresApproval && parseFloat(discountValue) > 0 && (
                  <input
                    type="password"
                    value={discountPin}
                    onChange={(e) => setDiscountPin(e.target.value)}
                    placeholder={t('managerPin')}
                    maxLength={6}
                    className="w-full min-h-11 px-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
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

          {/* Every method has one compact amount row; clicking its label fills the unallocated balance. */}
          <div className="space-y-2">
            {payments.map((payment, idx) => {
              const builtIn = PAYMENT_METHODS.find((method) => method.key === payment.method && payment.payment_method_id === undefined);
              const custom = customMethods.find((method) => method.id === payment.payment_method_id);
              const label = builtIn ? t(BUILT_IN_PAYMENT_KEYS[builtIn.key]) : custom?.name || tCommon('unknown');
              const Icon = builtIn?.icon;
              const active = (parseFloat(payment.amount) || 0) > 0;
              return <div key={payment.payment_method_id === undefined ? payment.method : `custom:${payment.payment_method_id}`} className="flex min-h-12">
                <button type="button" title={label} onClick={() => { setAmountTarget({ kind: 'payment', index: idx }); allocateRemainingTo(idx); }} className={`touch-target w-36 shrink-0 justify-start rounded-s-xl border px-3 gap-2 text-sm font-semibold transition-colors ${active ? 'bg-brand text-white border-brand' : 'bg-muted text-foreground border-border hover:border-brand hover:text-brand'}`}>
                  {Icon && <Icon size={15} />}
                  <span className="truncate">{label}</span>
                </button>
                <div className="flex flex-1 items-center border border-s-0 border-border rounded-e-xl bg-card focus-within:ring-2 focus-within:ring-brand focus-within:border-transparent">
                  <span className="ps-3 text-gray-400 text-xs">{inputCurrencyLabel}</span>
                  <input
                    type="number"
                    value={payment.amount}
                    onFocus={() => setAmountTarget({ kind: 'payment', index: idx })}
                    onChange={(e) => updatePaymentAmount(idx, e.target.value)}
                    placeholder="0.00"
                    inputMode="decimal"
                    className="min-w-0 flex-1 px-2 py-2 text-end text-base font-semibold outline-none rounded-e-xl"
                    step={inputCurrencyStep}
                    min="0"
                  />
                </div>
              </div>;
            })}
          </div>

          {/* Loyalty Wallet Section */}
          {loyaltySettings?.loyalty_enabled && customer && walletBalance !== null && (
            <div className="space-y-1">
              <div className="flex min-h-12">
                <button type="button" disabled={walletBalance <= 0} onClick={() => {
                  const allocatedElsewhere = payments.reduce((sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0), 0);
                  const maxWalletStored = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
                  const dueStored = Math.min(maxWalletStored, Math.max(0, remaining - allocatedElsewhere));
                  const dueDisplay = toDisplayUnit(dueStored);
                  setWalletAmount(dueDisplay > 0 ? String(dueDisplay) : '');
                  setAmountTarget({ kind: 'wallet' });
                }} className={`touch-target w-36 shrink-0 justify-start rounded-s-xl border px-3 gap-2 text-sm font-semibold ${walletAmt > 0 ? 'bg-purple-600 text-white border-purple-600' : 'bg-purple-50 text-purple-800 border-purple-200 disabled:bg-muted disabled:text-gray-400 disabled:border-border'}`}>
                  <Wallet size={15} /><span className="truncate">{t('loyaltyWallet')}</span>
                </button>
                <div className="flex flex-1 items-center border border-s-0 border-purple-200 rounded-e-xl bg-card focus-within:ring-2 focus-within:ring-purple-400">
                  <span className="ps-3 text-gray-400 text-xs">{inputCurrencyLabel}</span>
                  <input
                    type="number"
                    value={walletAmount}
                    onFocus={() => setAmountTarget({ kind: 'wallet' })}
                    onChange={(e) => {
                      const v = e.target.value;
                      const maxWalletCurrencyStored = Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE));
                      const maxDisplay = toDisplayUnit(Math.min(maxWalletCurrencyStored, remaining));
                      const clamped = parseFloat(v) > maxDisplay ? String(maxDisplay) : v;
                      setWalletAmount(clamped);
                    }}
                    placeholder="0.00"
                    disabled={walletBalance <= 0}
                    inputMode="decimal"
                    className="min-w-0 flex-1 px-2 py-2 text-end text-base font-semibold outline-none rounded-e-xl disabled:bg-muted"
                    step={inputCurrencyStep}
                    min="0"
                    max={toDisplayUnit(Math.min(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE)), remaining))}
                  />
                </div>
              </div>
              <p className="px-1 text-[11px] text-gray-400 text-end">{walletBalance > 0 ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)) }) : t('noBalance')}</p>
            </div>
          )}

          {/* Loyalty Info Strip (staff reference) */}
          {loyaltySettings?.loyalty_enabled && customer && (
            <div className="flex items-center gap-2 px-3.5 py-2.5 bg-muted border border-border rounded-xl">
              <Sparkles size={13} className="text-gray-400 shrink-0" />
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span className="text-foreground font-medium">{t('loyalty')}</span>
                <span className="font-semibold text-foreground">
                  {walletBalance !== null
                    ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)) })
                    : '…'}
                </span>
              </div>
            </div>
          )}
          {amountTarget && (
            <CurrencyTouchNumberPad
              value={activeAmountValue}
              onChange={updateActiveAmount}
              ariaLabel={t('numericKeypad')}
              clearLabel={t('clearAmount')}
              backspaceLabel={t('backspaceAmount')}
              // Percentage discounts are dimensionless rates, so they retain decimal input for zero-decimal currencies.
              currencyMaxDecimals={unitAdapter.maxDecimals}
              amountTarget={amountTarget.kind}
              discountType={discountType}
              max={activeAmountMax}
              quickValues={activeAmountQuickValues}
            />
          )}

          {/* Change stays at the bottom of all payment controls. */}
          {hasCash && (
            <div className={`rounded-xl px-4 py-2.5 flex items-center justify-between border transition-all duration-200 ${
              change > 0
                ? 'bg-emerald-50 border-emerald-200'
                : 'bg-muted border-border'
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
              <span className={`text-lg font-bold tabular-nums ${
                change > 0 ? 'text-emerald-600' : 'text-gray-300'
              }`}>
                {currencyFmt(change)}
              </span>
            </div>
          )}
        </div>

        {/* Pay Button */}
        <div className="shrink-0 border-t border-border px-5 pb-6 pt-3">
          <Button
            onClick={handleConfirm}
            disabled={processing || taxLoading || (!preview && !hasInvalidFixedDiscount) || totalPaymentMinor < remainingMinor}
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
