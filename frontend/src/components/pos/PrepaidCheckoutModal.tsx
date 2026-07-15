'use client';

import { useState, useEffect, useMemo } from 'react';
import { X, Sparkles, ArrowLeftRight, CheckCircle2, User, Plus, Trash2, Percent, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { useTaxPreview } from '@/hooks/use-tax-preview';
import { useI18n } from '@/hooks/useI18n';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import toast from 'react-hot-toast';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

interface LoyaltySettings {
  loyalty_enabled: boolean;
}

export interface PrepaidPayment {
  method: string;
  amount: number;
}

export interface PrepaidDiscount {
  type: 'percentage' | 'amount';
  value: number;
  reason?: string;
  override_pin?: string;
}

interface Props {
  currency: string;
  onClose: () => void;
  onConfirm: (payments: PrepaidPayment[], walletAmount: number, discount: PrepaidDiscount | null) => void;
}

// Fixed conversion rate for redeeming loyalty wallet points as payment (points per 1 currency unit).
// Must match LOYALTY_REDEMPTION_RATE in main/routes/bills.ts.
const LOYALTY_REDEMPTION_RATE = 100;

interface Payment {
  method: string;
  amount: string;
}

export default function PrepaidCheckoutModal({ currency, onClose, onConfirm }: Props) {
  const cart = useCartStore();
  const { tax, loading: taxLoading } = useTaxPreview(cart.items, cart.customerId);
  const customer = cart.customer;
  const { t } = useI18n();
  const currencyFmt = useFormatCurrency();

  const [loyaltySettings, setLoyaltySettings] = useState<LoyaltySettings | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletAmount, setWalletAmount] = useState('');
  const [processing, setProcessing] = useState(false);

  // Discount state (applied to the order once checkout is confirmed)
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<'percentage' | 'amount'>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');

  const [payments, setPayments] = useState<Payment[]>([{ method: 'cash', amount: '0' }]);
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(false);

  useEffect(() => {
    api.get('/settings/loyalty')
      .then((res) => setLoyaltySettings(res.data))
      .catch(() => {});
    api.get('/settings/discount')
      .then((res) => setDiscountRequiresApproval(!!res.data.discount_requires_approval))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (customer?.id) {
      api.get(`/customers/${customer.id}/wallet`)
        .then((res) => {
          setWalletBalance(Number(res.data.balance) || 0);
        })
        .catch(() => {});
    } else {
      setWalletBalance(null);
    }
  }, [customer?.id]);

  // Net payable amount after discount — tax is recalculated on the discounted subtotal,
  // matching how the backend recomputes tax when a discount is applied to an order/bill.
  const preview = useMemo(() => {
    if (!tax) return null;
    const rawValue = parseFloat(discountValue) || 0;
    const discountAmount = showDiscount && rawValue > 0
      ? Math.round((discountType === 'percentage' ? (tax.subtotal * rawValue) / 100 : Math.min(rawValue, tax.subtotal)) * 100) / 100
      : 0;
    const discountedSubtotal = Math.max(0, tax.subtotal - discountAmount);
    const taxRatio = discountAmount > 0 && tax.subtotal > 0 ? discountedSubtotal / tax.subtotal : 1;
    const discountedTax = Math.round(tax.tax_amount * taxRatio * 100) / 100;
    const preRoundTotal = discountedSubtotal + discountedTax + tax.packaging_charge;
    const total = Math.round(preRoundTotal);
    const roundOff = Math.round((total - preRoundTotal) * 100) / 100;
    return {
      subtotal: tax.subtotal,
      discountAmount,
      discountedSubtotal,
      taxAmount: discountedTax,
      taxBreakdown: tax.tax_breakdown.map((line) => ({ ...line, amount: Math.round(line.amount * taxRatio * 100) / 100 })),
      packagingCharge: tax.packaging_charge,
      roundOff,
      total,
    };
  }, [tax, showDiscount, discountType, discountValue]);

  const remaining = preview?.total ?? 0;

  // Auto-fill payment splits to match the net payable amount, but only until the cashier
  // manually edits an amount — after that, discount/wallet edits must not silently rewrite
  // amounts they've already typed in.
  useEffect(() => {
    if (!preview || paymentsTouched) return;
    setPayments((prev) => {
      const walletUsed = parseFloat(walletAmount) || 0;
      const cashRemaining = Math.max(0, remaining - walletUsed);
      if (prev.length === 1) {
        return [{ ...prev[0], amount: cashRemaining.toFixed(2) }];
      }
      const totalAllocated = prev.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      if (totalAllocated > 0) {
        return prev.map((p) => {
          const ratio = (parseFloat(p.amount) || 0) / totalAllocated;
          return { ...p, amount: (cashRemaining * ratio).toFixed(2) };
        });
      }
      const perSplit = cashRemaining / prev.length;
      return prev.map((p) => ({ ...p, amount: perSplit.toFixed(2) }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only recompute splits when the net total changes
  }, [remaining, paymentsTouched]);

  const updatePayment = (idx: number, field: keyof Payment, value: string) => {
    if (field === 'amount') setPaymentsTouched(true);
    setPayments(payments.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  };

  const addSplit = () => {
    const newPayments = [...payments, { method: 'card' as const, amount: '0' }];
    const walletUsed = parseFloat(walletAmount) || 0;
    const cashRemaining = Math.max(0, remaining - walletUsed);
    const perSplit = cashRemaining / newPayments.length;
    setPayments(newPayments.map((p) => ({ ...p, amount: perSplit.toFixed(2) })));
  };

  const removeSplit = (idx: number) => {
    if (payments.length <= 1) return;
    setPayments(payments.filter((_, i) => i !== idx));
  };

  const walletAmt = parseFloat(walletAmount) || 0;
  const totalPayment = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) + walletAmt;

  const hasCash = payments.some((p) => p.method === 'cash');
  const change = hasCash && totalPayment > remaining + 0.009
    ? parseFloat((totalPayment - remaining).toFixed(2))
    : 0;

  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleConfirm = () => {
    if (!preview) return;
    if (totalPayment < remaining - 0.01) {
      toast.error(t('pos.paymentBelowBalance'));
      return;
    }
    if (walletAmt > 0 && walletBalance !== null) {
      const walletPointsRequired = walletAmt * LOYALTY_REDEMPTION_RATE;
      if (walletPointsRequired > walletBalance) {
        const maxCurrency = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
        toast.error(t('pos.walletMaxAmount', { max: currencyFmt(maxCurrency) }));
        return;
      }
    }
    if (showDiscount && preview.discountAmount > 0 && discountRequiresApproval && !discountPin) {
      toast.error(t('pos.managerPinRequired'));
      return;
    }

    const finalPayments: PrepaidPayment[] = payments
      .map((p) => ({ method: p.method, amount: parseFloat(p.amount) || 0 }))
      .filter((p) => p.amount > 0);

    const discount: PrepaidDiscount | null = showDiscount && preview.discountAmount > 0
      ? {
        type: discountType,
        value: parseFloat(discountValue) || 0,
        reason: discountReason || undefined,
        override_pin: discountRequiresApproval ? discountPin : undefined,
      }
      : null;

    setProcessing(true);
    onConfirm(finalPayments, walletAmt, discount);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{t('pos.checkout')}</h2>
            <p className="text-xs text-gray-400 mt-0.5 capitalize">
              {t(`pos.orderTypeSuffix_${cart.orderType}` as 'pos.orderTypeSuffix_dine_in' | 'pos.orderTypeSuffix_takeaway' | 'pos.orderTypeSuffix_delivery' | 'pos.orderTypeSuffix_online')}
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
                  {taxLoading ? t('pos.subtotal') : t('pos.totalDue')}
                </p>
                {taxLoading || !preview ? (
                  <div className="h-10 w-32 bg-white/10 rounded animate-pulse mt-1" />
                ) : (
                  <p className="text-4xl font-bold mt-1 tracking-tight">
                    {currency}{fmt(remaining)}
                  </p>
                )}
                <p className="text-xs text-slate-400 mt-1.5">
                  {t('pos.itemCount', { count: cart.itemCount() })}
                </p>
                {!taxLoading && preview && (
                  <div className="mt-2 space-y-1">
                    <div className="flex justify-between text-xs text-slate-300">
                      <span>{t('pos.subtotal')}</span>
                      <span>{currency}{fmt(preview.subtotal)}</span>
                    </div>
                    {preview.discountAmount > 0 && (
                      <div className="flex justify-between text-xs text-emerald-400 font-medium">
                        <span>{t('pos.discount')}</span>
                        <span>− {currency}{fmt(preview.discountAmount)}</span>
                      </div>
                    )}
                    <TaxBreakdown
                      taxAmount={preview.taxAmount}
                      taxBreakdown={preview.taxBreakdown}
                    />
                    {preview.packagingCharge > 0 && (
                      <div className="flex justify-between text-xs text-slate-300">
                        <span>{t('pos.packaging')}</span>
                        <span>{currency}{fmt(preview.packagingCharge)}</span>
                      </div>
                    )}
                    {preview.roundOff !== 0 && (
                      <div className="flex justify-between text-xs text-slate-300">
                        <span>{t('pos.roundOff')}</span>
                        <span>{preview.roundOff > 0 ? '+' : ''}{currency}{fmt(preview.roundOff)}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {customer && (
                <div className="text-right ml-4 shrink-0">
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center mb-1 ml-auto">
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
                <span className="text-gray-700 font-medium">{t('pos.loyalty')}</span>
                <span className="font-semibold text-gray-700">
                  {walletBalance !== null
                    ? t('pos.pointsApproxValue', { count: walletBalance, currency, value: fmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)) })
                    : '…'}
                </span>
              </div>
            </div>
          )}

          {/* Discount */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showDiscount}
                onChange={(e) => {
                  setShowDiscount(e.target.checked);
                  if (!e.target.checked) {
                    setDiscountValue('');
                    setDiscountReason('');
                    setDiscountPin('');
                  }
                }}
                className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
              />
              <span className="text-sm font-medium text-gray-700">{t('pos.applyDiscount')}</span>
            </label>

            {showDiscount && (
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 space-y-2 ml-6">
                <div className="flex rounded-lg overflow-hidden border border-purple-200">
                  <button
                    onClick={() => setDiscountType('percentage')}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    <Percent size={14} />
                    {t('pos.percentage')}
                  </button>
                  <button
                    onClick={() => setDiscountType('amount')}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${discountType === 'amount' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    {t('pos.flatAmount')}
                  </button>
                </div>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                    {discountType === 'percentage' ? '%' : currency}
                  </span>
                  <input
                    type="number"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountType === 'percentage' ? '0' : '0.00'}
                    min="0"
                    max={discountType === 'percentage' ? 100 : preview?.subtotal ?? undefined}
                    step={discountType === 'percentage' ? 1 : 0.01}
                    className="w-full pl-8 pr-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                  />
                </div>
                <input
                  type="text"
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  placeholder={t('pos.discountReasonPlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                />
                {discountRequiresApproval && parseFloat(discountValue) > 0 && (
                  <input
                    type="password"
                    value={discountPin}
                    onChange={(e) => setDiscountPin(e.target.value)}
                    placeholder={t('pos.managerPin')}
                    maxLength={6}
                    className="w-full px-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                  />
                )}
              </div>
            )}
          </div>

          {/* Payment Method Splits */}
          {payments.map((p, idx) => (
            <div key={idx} className="bg-gray-50 rounded-xl p-2.5 space-y-1.5">
              <div className="flex gap-1">
                {PAYMENT_METHODS.map((m) => {
                  const Icon = m.icon;
                  return (
                    <button
                      key={m.key}
                      onClick={() => updatePayment(idx, 'method', m.key)}
                      className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        p.method === m.key ? 'bg-brand text-white' : 'bg-white text-gray-600 border border-gray-200 hover:border-brand/40'
                      }`}
                    >
                      <Icon size={14} />
                      {t(m.labelKey)}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-gray-400 text-xs">{currency}</span>
                <input
                  type="number"
                  value={p.amount}
                  onChange={(e) => updatePayment(idx, 'amount', e.target.value)}
                  className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded-md outline-none focus:ring-2 focus:ring-brand"
                  step="0.01"
                  min="0"
                />
                {payments.length > 1 && (
                  <button onClick={() => removeSplit(idx)} className="text-red-400 hover:text-red-600 p-1">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}

          <button
            onClick={addSplit}
            className="w-full py-2 text-sm border border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-brand hover:text-brand transition-colors flex items-center justify-center gap-1"
          >
            <Plus size={14} /> {t('pos.splitPayment')}
          </button>

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
                  {t('pos.changeReturned')}
                </span>
              </div>
              <span className={`text-xl font-bold tabular-nums ${
                change > 0 ? 'text-emerald-600' : 'text-gray-300'
              }`}>
                {currency}{change > 0 ? fmt(change) : '0.00'}
              </span>
            </div>
          )}

          {/* Loyalty Wallet Redemption */}
          {customer && walletBalance !== null && (
            <div className={`border rounded-xl p-3 space-y-2 ${walletBalance > 0 ? 'bg-purple-50 border-purple-200' : 'bg-gray-50 border-gray-200'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet size={16} className={walletBalance > 0 ? 'text-purple-600' : 'text-gray-400'} />
                  <span className={`text-sm font-medium ${walletBalance > 0 ? 'text-purple-900' : 'text-gray-500'}`}>{t('pos.loyaltyWallet')}</span>
                </div>
                <span className={`text-sm font-semibold ${walletBalance > 0 ? 'text-purple-700' : 'text-gray-400'}`}>
                  {walletBalance > 0
                    ? t('pos.pointsApproxValue', { count: walletBalance.toLocaleString(), currency, value: fmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)) })
                    : t('pos.noBalance')}
                </span>
              </div>
              {walletBalance > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-gray-400 text-sm">{currency}</span>
                  <input
                    type="number"
                    value={walletAmount}
                    onChange={(e) => {
                      const v = e.target.value;
                      const maxWalletCurrency = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
                      const max = Math.min(maxWalletCurrency, remaining);
                      const clamped = parseFloat(v) > max ? max.toFixed(2) : v;
                      setWalletAmount(clamped);
                      const walletUsed = parseFloat(clamped) || 0;
                      setPayments((prev) => prev.map((p, i) =>
                        i === 0 ? { ...p, amount: Math.max(0, remaining - walletUsed).toFixed(2) } : p
                      ));
                    }}
                    placeholder={`0 – ${Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)}`}
                    className="flex-1 px-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                    step="0.01"
                    min="0"
                    max={Math.min(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE), remaining)}
                  />
                </div>
              )}
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
            {taxLoading ? t('pos.calculatingTax') : processing ? t('pos.processingPayment') : t('pos.confirmPaymentAmount', { currency, amount: fmt(remaining) })}
          </Button>
        </div>
      </div>
    </div>
  );
}
