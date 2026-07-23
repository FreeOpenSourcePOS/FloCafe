'use client';

import { useState, useEffect } from 'react';
import { X, Wallet, Plus, Trash2, ArrowLeftRight, CheckCircle2, Sparkles, User, Percent, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill } from '@/lib/types';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import { useCartStore } from '@/store/cart';
import { useConfirm } from '@/hooks/use-confirm';
import { useI18n } from '@/hooks/useI18n';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useWhatsAppReady } from '@/hooks/useWhatsAppReady';
import { sendBillViaFlo } from '@/lib/whatsapp-share';

interface Props {
  bill: Bill;
  currency: string;
  onClose: () => void;
  onPaid: () => void;
  onBillUpdate?: (bill: Bill) => void;
}

interface Payment {
  method: string;
  amount: string;
}

// Fixed conversion rate for redeeming loyalty wallet points as payment (points per 1 currency unit).
// Must match LOYALTY_REDEMPTION_RATE in main/routes/bills.ts.
const LOYALTY_REDEMPTION_RATE = 100;

export default function PaymentModal({ bill, currency, onClose, onPaid, onBillUpdate }: Props) {
  const remaining = Number(bill.balance);
  const cartCustomerId = useCartStore((s) => s.customerId);
  const cartCustomer = useCartStore((s) => s.customer);
  const effectiveCustomerId = bill.customer_id || cartCustomerId || null;
  const { confirm, ConfirmDialog } = useConfirm();
  const { t } = useI18n();
  const isWhatsAppReady = useWhatsAppReady();
  const [justPaid, setJustPaid] = useState(false);
  const [sendingWa, setSendingWa] = useState(false);
  const [payments, setPayments] = useState<Payment[]>([
    { method: 'cash', amount: remaining.toString() },
  ]);
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletAmount, setWalletAmount] = useState('');

  // Discount state
  const [showDiscount, setShowDiscount] = useState(false);
  const [discountType, setDiscountType] = useState<'percentage' | 'amount'>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');
  const [applyingDiscount, setApplyingDiscount] = useState(false);
  const [loyaltySettings, setLoyaltySettings] = useState<{ loyalty_enabled: boolean } | null>(null);

  // Sync state with active bill discount on load or update
  useEffect(() => {
    if (bill && Number(bill.discount_amount) > 0) {
      setDiscountType((bill.discount_type as 'percentage' | 'amount') || 'percentage');
      setDiscountValue(String(bill.discount_value || ''));
      setDiscountReason(bill.discount_reason || '');
      setShowDiscount(true);
    } else {
      setDiscountType('percentage');
      setDiscountValue('');
      setDiscountReason('');
      setShowDiscount(false);
    }
  }, [bill]);

  // Dynamically update payment inputs when remaining balance changes, but only until the
  // cashier manually edits an amount — after that, discount/wallet edits must not silently
  // rewrite amounts they've already typed in.
  useEffect(() => {
    if (paymentsTouched) return;
    if (payments.length === 1) {
      setPayments([{ ...payments[0], amount: remaining.toString() }]);
    } else {
      const totalAllocated = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      if (totalAllocated > 0) {
        setPayments(payments.map(p => {
          const ratio = (parseFloat(p.amount) || 0) / totalAllocated;
          return { ...p, amount: (remaining * ratio).toFixed(2) };
        }));
      } else {
        const perSplit = remaining / payments.length;
        setPayments(payments.map(p => ({ ...p, amount: perSplit.toFixed(2) })));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only recompute splits when the remaining balance changes
  }, [remaining, paymentsTouched]);

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
      .then((res) => setDiscountRequiresApproval(!!res.data.discount_requires_approval))
      .catch(() => {});
  }, [bill.customer_id, cartCustomerId]);

  const updatePayment = (idx: number, field: keyof Payment, value: string) => {
    if (field === 'amount') setPaymentsTouched(true);
    setPayments(payments.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const addSplit = () => {
    const newPayments = [...payments, { method: 'card' as const, amount: '0' }];
    // Split amount equally among all splits
    const perSplit = remaining / newPayments.length;
    setPayments(newPayments.map(p => ({ ...p, amount: perSplit.toFixed(2) })));
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

  const currencyFmt = useFormatCurrency();

  const handleApplyDiscount = async (customVal?: number) => {
    if (applyingDiscount) return;
    const val = customVal !== undefined ? customVal : parseFloat(discountValue);
    if (customVal === undefined && (isNaN(val) || val < 0)) {
      toast.error(t('pos.discountInvalid'));
      return;
    }
    // Check if PIN is required
    if (discountRequiresApproval && val > 0 && !discountPin) {
      toast.error(t('pos.managerPinRequired'));
      return;
    }
    setApplyingDiscount(true);
    try {
      await api.patch(`/orders/${bill.order_id}/discount`, {
        discount_type: discountType,
        discount_value: val,
        discount_reason: val > 0 ? discountReason || undefined : undefined,
        override_pin: discountRequiresApproval && val > 0 ? discountPin : undefined,
      });
      toast.success(val === 0 ? t('pos.discountRemoved') : t('pos.discountUpdated'));
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
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; message?: string } } };
      const msg = axiosErr.response?.data?.error || axiosErr.response?.data?.message || t('pos.failedToUpdateDiscount');
      toast.error(msg);
      // Clear the PIN on any failure (wrong PIN or rate-limited) so a stale/rejected
      // PIN doesn't sit in the field looking like it might still work on retry.
      setDiscountPin('');
    } finally {
      setApplyingDiscount(false);
    }
  };

  const handlePay = async () => {
    if (totalPayment < remaining - 0.01) {
      toast.error(t('pos.paymentBelowBalance'));
      return;
    }
    // Validate wallet amount against available balance (convert currency to points for comparison)
    if (walletAmt > 0 && walletBalance !== null) {
      const redemptionRate = LOYALTY_REDEMPTION_RATE;
      const walletPointsRequired = walletAmt * redemptionRate;
      if (walletPointsRequired > walletBalance) {
        const maxCurrency = Math.floor(walletBalance / redemptionRate);
        toast.error(t('pos.walletMaxAmount', { max: currencyFmt(maxCurrency) }));
        return;
      }
    }
    setProcessing(true);
    try {
      let pointsEarned = 0;
      for (const p of payments) {
        const amt = parseFloat(p.amount);
        if (!amt || amt <= 0 || isNaN(amt)) continue;
        const res = await api.post(`/bills/${bill.id}/payment`, { amount: amt, method: p.method, customer_id: effectiveCustomerId });
        if (res.data?.loyaltyPointsEarned > 0) pointsEarned = res.data.loyaltyPointsEarned;
      }
      if (walletAmt > 0) {
        const res = await api.post(`/bills/${bill.id}/payment`, { amount: walletAmt, method: 'wallet', customer_id: effectiveCustomerId });
        if (res.data?.loyaltyPointsEarned > 0) pointsEarned = res.data.loyaltyPointsEarned;
      }
      if (pointsEarned > 0) {
        toast.success(t('pos.paymentRecordedWithPoints', { points: pointsEarned }));
      } else {
        toast.success(t('pos.paymentRecorded'));
      }
      setJustPaid(true);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('pos.paymentFailed'));
    } finally {
      setProcessing(false);
    }
  };

  const handleSendWhatsApp = async () => {
    const phone = cartCustomer?.phone;
    if (!phone) {
      toast.error(t('whatsapp.send.customerPhoneRequired'));
      return;
    }
    setSendingWa(true);
    try {
      await sendBillViaFlo(bill, phone, currency, t);
    } finally {
      setSendingWa(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{t('pos.payment')}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{t('pos.billNumber', { number: bill.bill_number })}</p>
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
                <p className="text-xs font-medium text-slate-400 uppercase tracking-widest">{t('pos.totalDue')}</p>
                <p className="text-4xl font-bold mt-1 tracking-tight">{currencyFmt(remaining)}</p>
              </div>
              {cartCustomer && (
                <div className="text-right ml-4 shrink-0">
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center mb-1 ml-auto">
                    <User size={16} className="text-white/70" />
                  </div>
                  <p className="text-sm font-semibold text-white leading-tight">{cartCustomer.name}</p>
                </div>
              )}
            </div>

            {/* Bill breakdown — always shown so cashier has full context */}
            <div className="border-t border-white/10 pt-3 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-300">
                <span>{t('pos.subtotal')}</span>
                <span>{currencyFmt(Number(bill.subtotal))}</span>
              </div>
              {Number(bill.discount_amount) > 0 && (
                <div className="flex justify-between text-emerald-400 font-medium">
                  <span>{t('pos.discount')}</span>
                  <span>− {currencyFmt(Number(bill.discount_amount))}</span>
                </div>
              )}
              <TaxBreakdown
                taxAmount={Number(bill.tax_amount)}
                taxBreakdown={bill.tax_breakdown}
              />
              {Number(bill.delivery_charge) > 0 && (
                <div className="flex justify-between text-slate-300">
                  <span>{t('pos.delivery')}</span>
                  <span>{currencyFmt(Number(bill.delivery_charge))}</span>
                </div>
              )}
              {Number(bill.packaging_charge) > 0 && (
                <div className="flex justify-between text-slate-300">
                  <span>{t('pos.packaging')}</span>
                  <span>{currencyFmt(Number(bill.packaging_charge))}</span>
                </div>
              )}
              {Number(bill.round_off) !== 0 && (
                <div className="flex justify-between text-slate-300">
                  <span>{t('pos.roundOff')}</span>
                  <span>{Number(bill.round_off) > 0 ? '+' : ''}{currencyFmt(Number(bill.round_off))}</span>
                </div>
              )}
              <div className="flex justify-between text-white font-semibold border-t border-white/10 pt-1.5 mt-1">
                <span>{t('pos.total')}</span>
                <span>{currencyFmt(Number(bill.total))}</span>
              </div>
            </div>
          </div>

          {/* Loyalty Info Strip (staff reference) */}
          {loyaltySettings?.loyalty_enabled && effectiveCustomerId && (
            <div className="flex items-center gap-2 px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl">
              <Sparkles size={13} className="text-gray-400 shrink-0" />
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span className="text-gray-700 font-medium">{t('pos.loyalty')}</span>
                <span className="font-semibold text-gray-700">
                  {walletBalance !== null
                    ? t('pos.pointsApproxValue', { count: walletBalance, value: currencyFmt(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE))) })
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
                checked={showDiscount || Number(bill.discount_amount) > 0}
                onChange={async (e) => {
                  const checked = e.target.checked;
                  if (!checked && Number(bill.discount_amount) > 0) {
                    if (await confirm(t('pos.removeDiscountConfirm'), { destructive: true, confirmLabel: t('pos.remove') })) {
                      handleApplyDiscount(0);
                    }
                  } else {
                    setShowDiscount(checked);
                  }
                }}
                className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
              />
              <span className="text-sm font-medium text-gray-700">
                {Number(bill.discount_amount) > 0
                  ? `${t('pos.discount')}: -${currencyFmt(Number(bill.discount_amount))}`
                  : t('pos.applyDiscount')}
              </span>
            </label>

            {showDiscount && (
              <div className="bg-purple-50 border border-purple-200 rounded-xl p-3 space-y-2 ml-6">
                <div className="flex rounded-lg overflow-hidden border border-purple-200">
                  <button
                    onClick={() => { setDiscountType('percentage'); }}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    <Percent size={14} />
                    {t('pos.percentage')}
                  </button>
                  <button
                    onClick={() => { setDiscountType('amount'); }}
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
                    max={discountType === 'percentage' ? 100 : Number(bill.subtotal)}
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
                <Button
                  size="sm"
                  onClick={() => handleApplyDiscount()}
                  disabled={applyingDiscount || discountValue === '' || isNaN(parseFloat(discountValue))}
                  className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                >
                  {applyingDiscount
                    ? t('pos.applyingDiscount')
                    : Number(bill.discount_amount) > 0 ? t('pos.updateDiscount') : t('pos.applyDiscount')}
                </Button>
              </div>
            )}
          </div>

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
                {currencyFmt(change)}
              </span>
            </div>
          )}

          {bill.customer_id && walletBalance !== null && (
            <div className={`border rounded-xl p-3 space-y-2 ${walletBalance > 0 ? 'bg-purple-50 border-purple-200' : 'bg-gray-50 border-gray-200'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wallet size={16} className={walletBalance > 0 ? 'text-purple-600' : 'text-gray-400'} />
                  <span className={`text-sm font-medium ${walletBalance > 0 ? 'text-purple-900' : 'text-gray-500'}`}>{t('pos.loyaltyWallet')}</span>
                </div>
                <span className={`text-sm font-semibold ${walletBalance > 0 ? 'text-purple-700' : 'text-gray-400'}`}>
                  {walletBalance > 0
                    ? t('pos.pointsApproxValue', { count: walletBalance.toLocaleString(), value: currencyFmt(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE))) })
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
                      // Max is wallet points / redemption rate (converted to currency), capped at remaining
                      const maxWalletCurrency = Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE));
                      const max = Math.min(maxWalletCurrency, remaining);
                      const clamped = parseFloat(v) > max ? max.toFixed(2) : v;
                      setWalletAmount(clamped);
                      // Auto-reduce first payment so total stays at remaining
                      const walletUsed = parseFloat(clamped) || 0;
                      setPayments((prev) => prev.map((p, i) =>
                        i === 0 ? { ...p, amount: Math.max(0, remaining - walletUsed).toFixed(2) } : p
                      ));
                    }}
                    placeholder={`0 – ${Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE))}`}
                    className="flex-1 px-3 py-2 text-sm border border-purple-200 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-white"
                    step="0.01"
                    min="0"
                    max={Math.min(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE)), remaining)}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 pb-5 border-t border-gray-100 pt-3 space-y-2">
          {justPaid ? (
            <>
              {isWhatsAppReady && cartCustomer?.phone && (
                <Button
                  onClick={handleSendWhatsApp}
                  disabled={sendingWa}
                  className="w-full bg-emerald-600 hover:bg-emerald-700"
                  size="lg"
                >
                  <Send size={16} className="mr-2" />
                  {sendingWa ? t('pos.processingPayment') : t('pos.sendViaWhatsApp')}
                </Button>
              )}
              <Button onClick={onPaid} variant="outline" className="w-full" size="lg">
                {t('common.done')}
              </Button>
            </>
          ) : (
            <Button onClick={handlePay} disabled={processing || totalPayment < remaining - 0.01} className="w-full" size="lg">
              {processing ? t('pos.processingPayment') : `${t('pos.pay')} ${currencyFmt(totalPayment)}`}
            </Button>
          )}
        </div>
      </div>
      {ConfirmDialog}
    </div>
  );
}
