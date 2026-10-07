'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Wallet, ArrowLeftRight, CheckCircle2, Sparkles, User, Percent, Send, ChevronDown, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill, Order } from '@/lib/types';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import { SplitCheckModal, MIN_CHECKS as MIN_EQUAL_SHARE_PAYERS, MAX_CHECKS as MAX_EQUAL_SHARE_PAYERS } from '@/components/pos/SplitCheckModal';
import { resolveTaxComponents } from '@/lib/printer/tax-components';
import { useCartStore } from '@/store/cart';
import { useConfirm } from '@/hooks/use-confirm';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCountryByCode, getCurrencyMinorUnitFactor } from '@/lib/countries';
import { getDiscountInputStep, normalizeFixedDiscountValue } from '@/lib/currency-input';
import { useWhatsAppReady } from '@/hooks/useWhatsAppReady';
import { sendBillViaFlo, shareBillViaWhatsApp } from '@/lib/whatsapp-share';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { CurrencyTouchNumberPad } from '@/components/pos/TouchNumberPad';
import {
  defaultDiscountTypeForMode,
  isDiscountTypeAllowed,
  normalizeDiscountMode,
  type DiscountMode,
  type DiscountType,
} from '@/lib/discount-settings';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';
import { allocateEqualShares } from '@/lib/money';
import { parseAppliedCharges, type AppliedCharge } from '@/lib/charges';
import { useChargesStore, chargesForOrderType } from '@/store/charges';

interface Props {
  bill: Bill;
  currency: string;
  initialOverridePin?: string;
  onClose: () => void;
  onPaid: () => void;
  onBillUpdate?: (bill: Bill) => void;
  /**
   * Runs after the check is split. When the cashier split off a leaving guest's
   * items, the new check is passed so the caller can open it for payment; an
   * all-items split still reports no bill of its own.
   */
  onSplit?: (departingBill?: Bill) => void;
}

interface Payment {
  method: string;
  payment_method_id?: number;
  amount: string;
}

type AmountTarget = { kind: 'payment'; index: number } | { kind: 'wallet' } | { kind: 'discount' } | null;

// One equal share written into a tender row, and the balance and payer count it
// was sized from so a later change can withdraw it.
type AppliedEqualShare = { index: number; amountMinor: number; amountInput: string; balanceMinor: number; payers: number };

// Loyalty points are 1:1 with currency units. Must match LOYALTY_REDEMPTION_RATE in main/routes/bills.ts.
const LOYALTY_REDEMPTION_RATE = 1;

type PosKey = keyof AppConfig['Messages']['pos'];

// Built-in payment method label keys mapped to typed `pos` leaf keys.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const satisfies Record<'cash' | 'card', PosKey>;

export default function PaymentModal({ bill, initialOverridePin, onClose, onPaid, onBillUpdate, onSplit }: Props) {
  const remaining = Number(bill.balance);
  const cartCustomerId = useCartStore((s) => s.customerId);
  const cartCustomer = useCartStore((s) => s.customer);
  const effectiveCustomerId = bill.customer_id || cartCustomerId || null;
  const { confirm, ConfirmDialog } = useConfirm();
  const t = useTranslations('pos');
  const locale = useLocale();
  const tCommon = useTranslations('common');
  const tOrders = useTranslations('orders');
  const tReceipt = useTranslations('receipt');
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
  const currencyCode =
    currentTenant?.currency ||
    (currentTenant?.country ? getCountryByCode(currentTenant.country)?.currency : undefined) ||
    'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currencyCode);
  const toMinorUnits = (amount: number) => Math.round(amount * minorFactor);

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
  const [kitchenOverrideRequired, setKitchenOverrideRequired] = useState(Boolean(initialOverridePin));
  const [kitchenOverridePin, setKitchenOverridePin] = useState(initialOverridePin || '');
  const [kitchenUndeliveredCount, setKitchenUndeliveredCount] = useState(0);
  const [kitchenUndeliveredItems, setKitchenUndeliveredItems] = useState<string[]>([]);
  const [kitchenDeliveryError, setKitchenDeliveryError] = useState('');

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
  const [amountTarget, setAmountTarget] = useState<AmountTarget>(null);

  const charges = useChargesStore((s) => s.charges);
  const loadCharges = useChargesStore((s) => s.load);
  const [updatingChargeId, setUpdatingChargeId] = useState<string | null>(null);
  const [splitChecksEnabled, setSplitChecksEnabled] = useState(false);
  const [splitCheckOrder, setSplitCheckOrder] = useState<Order | null>(null);
  const [openingSplitCheck, setOpeningSplitCheck] = useState(false);
  const [chargeStateUncertain, setChargeStateUncertain] = useState(false);
  const [showEqualShare, setShowEqualShare] = useState(false);
  // Session-only remaining payer count: reopening the dialog asks again rather
  // than remembering who has paid.
  const [equalSharePayers, setEqualSharePayers] = useState(() => String(
    Math.min(MAX_EQUAL_SHARE_PAYERS, Math.max(MIN_EQUAL_SHARE_PAYERS, Number(bill.order?.guest_count) || MIN_EQUAL_SHARE_PAYERS)),
  ));
  const [equalShareNotice, setEqualShareNotice] = useState<'lastPayer' | 'invalidated' | null>(null);
  const [appliedEqualShare, setAppliedEqualShare] = useState<AppliedEqualShare | null>(null);
  useEffect(() => {
    void loadCharges();
  }, [loadCharges]);

  const appliedCharges: AppliedCharge[] = parseAppliedCharges(bill.charges_breakdown);
  const applicableCharges = chargesForOrderType(charges, bill.order?.type || '');
  // The backend rejects a waiver on a split check (its charges are already
  // allocated) and on a settled bill, so the toggle is not offered there.
  const canToggleCharges = !bill.split_group_id
    && bill.payment_status !== 'paid'
    && Number(bill.paid_amount || 0) === 0
    && bill.payment_status !== 'refunded'
    && bill.payment_status !== 'partially_refunded';
  const splitCheckItems = (bill.order?.items || []).filter(
    (item) => !['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(item.status),
  );
  const hasDivisibleSplitCheckItems = splitCheckItems.length > 0
    && splitCheckItems.every((item) => Number.isSafeInteger(Number(item.quantity)) && Number(item.quantity) > 0)
    && splitCheckItems.reduce((total, item) => total + Number(item.quantity), 0) >= 2;
  // Split checks divide an untouched dine-in bill into separately payable
  // checks; the backend refuses anything else (POST /bills/:id/split-check).
  // An untouched unpaid check is divisible, including the remainder of an
  // earlier split: the bill projection limits the offer to its own items.
  const canSplitCheck = splitChecksEnabled
    && bill.payment_status === 'unpaid'
    && Number(bill.paid_amount || 0) === 0
    && !bill.payment_details
    && tenantCan(currentTenant, 'bills.read')
    && (bill.split_group_id
      ? (!bill.order || (bill.order.type === 'dine_in' && hasDivisibleSplitCheckItems))
      : hasDivisibleSplitCheckItems && bill.order?.type === 'dine_in');
  const canEditCharges = tenantCan(currentTenant, 'bills.discount.apply') && canToggleCharges && !processing && !chargeStateUncertain;
  const addableCharges = applicableCharges.filter(
    (charge) => !charge.is_default_active && !appliedCharges.some((applied) => applied.id === charge.id),
  );

  const updateCharge = async (chargeId: string, change: { waived?: boolean; applied?: boolean }) => {
    if (!canEditCharges || processing || updatingChargeId) return;
    setUpdatingChargeId(chargeId);
    setChargeStateUncertain(true);
    try {
      const { data } = await api.patch(`/bills/${bill.id}/charges`, { charge_id: chargeId, ...change });
      if (!data.bill) throw new Error('Bill charge update returned no bill');
      if (onBillUpdate) onBillUpdate({ ...bill, ...data.bill, order: bill.order });
      setChargeStateUncertain(false);
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } } | null)?.response?.status;
      if (status !== undefined && status >= 400 && status < 500) setChargeStateUncertain(false);
      toast.error(t('chargeUpdateFailed'));
    } finally {
      setUpdatingChargeId(null);
    }
  };

  // Sync state with active bill discount during render before paint
  // to prevent flashing stale values.
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

  // Reconcile the draft discount with the configured mode. Mode `none` forbids
  // every type, so its cleanup has to be a one-shot transition on entry: the
  // incompatible-type normalization below can never be satisfied there and would
  // reschedule a render-phase update until React aborts the tree.
  const [reconciledDiscountMode, setReconciledDiscountMode] = useState(discountMode);
  if (discountMode !== reconciledDiscountMode) {
    setReconciledDiscountMode(discountMode);
    if (discountMode === 'none') {
      setDiscountType(defaultDiscountTypeForMode(discountMode));
      setDiscountValue('');
      setDiscountReason('');
      setDiscountPin('');
      setAmountTarget((target) => target?.kind === 'discount' ? null : target);
    }
  }

  if (discountMode !== 'none' && !isDiscountTypeAllowed(discountMode, discountType)) {
    setDiscountType(defaultDiscountTypeForMode(discountMode));
    setDiscountValue('');
    setDiscountReason('');
    setDiscountPin('');
    setAmountTarget((target) => target?.kind === 'discount' ? null : target);
  }

  // Proportionally update payment inputs when remaining balance changes,
  // unless cashier has already edited inputs manually.
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
    api.get('/settings/split_checks_enabled')
      .then((res) => setSplitChecksEnabled(res.data?.setting?.value === 'true'))
      .catch(() => setSplitChecksEnabled(false));
  }, []);

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
  const totalPaymentMinor = payments.reduce((s, p) => s + toMinorUnits(toStoredUnit(parseFloat(p.amount) || 0)), 0) + toMinorUnits(walletAmt);
  const totalPayment = totalPaymentMinor / minorFactor;
  const remainingMinor = toMinorUnits(remaining);

  // Equal shares divide the remaining authoritative balance in the tenant's
  // smallest unit, so no share is created or lost to rounding.
  const equalShareCount = /^\d+$/.test(equalSharePayers.trim()) ? Number(equalSharePayers.trim()) : 0;
  const equalShareCountInRange = equalShareCount >= MIN_EQUAL_SHARE_PAYERS && equalShareCount <= MAX_EQUAL_SHARE_PAYERS;
  const equalShareShares = equalShareCountInRange && equalShareCount <= remainingMinor
    ? allocateEqualShares(remainingMinor, equalShareCount)
    : [];
  const equalShareError = equalShareCountInRange
    ? (equalShareCount > remainingMinor ? 'tooManyPayers' : null)
    : 'invalidCount';
  const equalShareSharesDiffer = equalShareShares.length > 1
    && equalShareShares[0] !== equalShareShares[equalShareShares.length - 1];
  const minorToStored = (minor: number) => minor / minorFactor;
  // A share may only be applied over an empty entry board: the other tenders and
  // the wallet are never overwritten.
  const tenderHasConflict = (index: number) => walletAmt > 0
    || payments.some((row, rowIndex) => rowIndex !== index && (parseFloat(row.amount) || 0) > 0);
  const equalShareConflict = walletAmt > 0
    || payments.filter((row) => (parseFloat(row.amount) || 0) > 0).length > 1;

  const tenderLabel = (payment: Payment) => {
    const builtIn = PAYMENT_METHODS.find((method) => method.key === payment.method && payment.payment_method_id === undefined);
    const custom = customMethods.find((method) => method.id === payment.payment_method_id);
    return builtIn ? t(BUILT_IN_PAYMENT_KEYS[builtIn.key]) : custom?.name || tCommon('unknown');
  };

  const applyEqualShare = (index: number) => {
    const shareMinor = equalShareShares[0];
    if (processing || shareMinor === undefined || tenderHasConflict(index)) return;
    const amountInput = String(toDisplayUnit(minorToStored(shareMinor)));
    setPaymentsTouched(true);
    setPayments((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: amountInput } : row));
    setAppliedEqualShare({
      index,
      amountMinor: shareMinor,
      amountInput,
      balanceMinor: remainingMinor,
      payers: equalShareCount,
    });
    setEqualShareNotice(null);
  };

  // The payer who just paid is done, so the count drops by one. The last payer
  // collects the balance the ordinary way instead of through the shortcut.
  const advanceEqualShare = (applied: AppliedEqualShare) => {
    const payersRemaining = applied.payers - 1;
    setAppliedEqualShare(null);
    setPayments((rows) => rows.map((row, index) => (
      index === applied.index && row.amount === applied.amountInput ? { ...row, amount: '' } : row
    )));
    if (payersRemaining >= MIN_EQUAL_SHARE_PAYERS) {
      setEqualSharePayers(String(payersRemaining));
      setEqualShareNotice(null);
    } else {
      setShowEqualShare(false);
      setEqualShareNotice('lastPayer');
    }
  };

  // A share sized for a balance or payer count that has since moved on is
  // withdrawn so the cashier reviews the new preview; an amount the cashier
  // typed themselves is left alone. Reconciled during render, like the balance
  // rescale above, so the stale share never reaches a paint.
  if (appliedEqualShare && (
    appliedEqualShare.balanceMinor !== remainingMinor || appliedEqualShare.payers !== equalShareCount
  )) {
    setAppliedEqualShare(null);
    setEqualShareNotice('invalidated');
    setPayments((rows) => rows.map((row, index) => (
      index === appliedEqualShare.index && row.amount === appliedEqualShare.amountInput ? { ...row, amount: '' } : row
    )));
  }

  const updatePaymentAmount = (idx: number, value: string) => {
    setPaymentsTouched(true);
    setAppliedEqualShare((current) => (current?.index === idx ? null : current));
    setPayments((current) => current.map((payment, index) => index === idx ? { ...payment, amount: value } : payment));
  };

  const allocateRemainingTo = (idx: number) => {
    const allocatedElsewhere = payments.reduce((sum, payment, index) => index === idx ? sum : sum + toStoredUnit(parseFloat(payment.amount) || 0), walletAmt);
    const dueStored = Math.max(0, remaining - allocatedElsewhere);
    const dueDisplay = toDisplayUnit(dueStored);
    setPaymentsTouched(true);
    setAppliedEqualShare(null);
    setPayments(payments.map((payment, index) => index === idx ? { ...payment, amount: dueDisplay > 0 ? String(dueDisplay) : '' } : payment));
  };

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
    ? discountType === 'percentage' ? 100 : toDisplayUnit(Number(bill.subtotal))
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

  const hasCash = payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);

  const change = hasCash && totalPaymentMinor > remainingMinor
    ? (totalPaymentMinor - remainingMinor) / minorFactor
    : 0;

  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();

  const handleApplyDiscount = async (customVal?: number) => {
    if (applyingDiscount) return;
    const rawVal = customVal !== undefined ? customVal : parseFloat(discountValue);
    if (customVal === undefined && (isNaN(rawVal) || rawVal < 0)) {
      toast.error(t('discountInvalid'));
      return;
    }
    const val = discountType === 'amount'
      ? normalizeFixedDiscountValue(rawVal, unitAdapter.maxDecimals)
      : rawVal;
    if (discountType === 'amount' && rawVal > 0 && val <= 0) {
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

  const handleOpenSplitCheck = async () => {
    if (openingSplitCheck) return;
    setOpeningSplitCheck(true);
    try {
      // The bill endpoint answers with this check's own projection, so a
      // re-split never offers a paid sibling's quantities.
      const { data } = await api.get(`/bills/${bill.id}`);
      let splitOrder = (data?.bill?.order ?? null) as Order | null;
      if (!splitOrder?.items?.length && !bill.split_group_id) {
        const fallback = await api.get(`/orders/${bill.order_id}`);
        splitOrder = (fallback.data?.order ?? null) as Order | null;
      }
      const items = (splitOrder?.items || []).filter(
        (item) => !['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(item.status),
      );
      const hasDivisibleItems = items.length > 0
        && items.every((item) => Number.isSafeInteger(Number(item.quantity)) && Number(item.quantity) > 0)
        && items.reduce((total, item) => total + Number(item.quantity), 0) >= 2;
      if (splitOrder?.type !== 'dine_in' || !hasDivisibleItems) {
        toast.error(t('splitCheckFailed'));
        return;
      }
      setSplitCheckOrder(splitOrder);
    } catch {
      toast.error(t('splitCheckFailed'));
    } finally {
      setOpeningSplitCheck(false);
    }
  };

  const handleSplitComplete = (bills: Bill[], departingBill: Bill | null) => {
    setSplitCheckOrder(null);
    if (onSplit) onSplit(departingBill ?? undefined);
    else onClose();
  };

  const handlePay = async () => {
    if (processing || updatingChargeId || chargeStateUncertain) return;
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
    // A short tender is a deliberate choice: the backend records what was
    // collected and leaves the rest as the bill's outstanding balance.
    if (totalPaymentMinor < remainingMinor) {
      const collected = totalPaymentMinor / minorFactor;
      const stillDue = (remainingMinor - totalPaymentMinor) / minorFactor;
      const proceed = await confirm(
        t('partialPaymentConfirm', { amount: currencyFmt(collected), remaining: currencyFmt(stillDue) }),
        { confirmLabel: t('pay') },
      );
      if (!proceed) return;
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
      const zeroBalanceSettlement = remainingMinor === 0 && splitLines.length === 0;

      // Atomic call ensures all split payment lines succeed together
      // or fail together without leaving partial payments.
      const idempotencyKey = idempotencyKeyRef.current || createPaymentIdempotencyKey();
      idempotencyKeyRef.current = idempotencyKey;
      const res = await api.post(
        zeroBalanceSettlement ? `/bills/${bill.id}/payment` : `/bills/${bill.id}/payments`,
        zeroBalanceSettlement
          ? { method: 'cash', amount: null, customer_id: effectiveCustomerId, override_pin: kitchenOverridePin || undefined }
          : { payments: splitLines, customer_id: effectiveCustomerId, override_pin: kitchenOverridePin || undefined },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );
      const updatedBill = res.data?.bill as Bill | undefined;
      setKitchenOverrideRequired(false);
      if (!updatedBill || updatedBill.payment_status !== 'paid') {
        // This request committed a partial payment, so the next attempt is a
        // new request and must not reuse the completed request's hash.
        if (updatedBill) idempotencyKeyRef.current = null;
        if (updatedBill && onBillUpdate) onBillUpdate({ ...bill, ...updatedBill, order: bill.order });
        // Only a committed equal share retires its payer; an uncertain or
        // different outcome keeps the applied share and its idempotency key.
        if (updatedBill?.payment_status === 'partial'
          && appliedEqualShare
          && totalPaymentMinor === appliedEqualShare.amountMinor) {
          advanceEqualShare(appliedEqualShare);
        }
        if (updatedBill?.payment_status === 'partial') {
          toast.success(t('paymentRecorded'));
        } else {
          toast.error(t('paymentIncomplete', {
            amount: currencyFmt(Number(updatedBill?.balance) || 0),
          }));
        }
        return;
      }
      const earned = res.data?.loyaltyPointsEarned > 0 ? res.data.loyaltyPointsEarned : 0;
      setPointsEarned(earned);
      if (res.data?.kitchenDeliveryOverridden) {
        toast.success(t('kitchenDeliveryOverrideSuccess'));
      } else if (earned > 0) {
        toast.success(t('paymentRecordedWithPoints', { points: earned }));
      } else {
        toast.success(t('paymentRecorded'));
      }
      setJustPaid(true);
    } catch (error: unknown) {
      const response = (error as { response?: { data?: { code?: string; error?: string; undeliveredCount?: number; undeliveredItems?: unknown } } } | null)?.response?.data;
      if (response?.code === 'KITCHEN_ITEMS_UNDELIVERED') {
        setKitchenOverrideRequired(true);
        setKitchenOverridePin('');
        setKitchenUndeliveredCount(Number(response.undeliveredCount) || 0);
        setKitchenUndeliveredItems(Array.isArray(response.undeliveredItems) ? response.undeliveredItems : []);
        setKitchenDeliveryError('');
      } else if (response?.error === 'Invalid manager PIN') {
        setKitchenOverrideRequired(true);
        setKitchenOverridePin('');
        setKitchenDeliveryError(t('kitchenDeliveryOverrideInvalid'));
      } else {
        toast.error(t('paymentFailed'));
      }
    } finally {
      setProcessing(false);
    }
  };

  const tenantForShare = {
    business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
    currency: currentTenant?.currency || '',
    country: currentTenant?.country || '',
  };

  const handleSendWhatsApp = async () => {
    const phone = cartCustomer?.phone;
    if (!phone) {
      toast.error(tWhatsappSend('customerPhoneRequired'));
      return;
    }
    setSendingWa(true);
    try {
      await sendBillViaFlo(bill, phone, tenantForShare, whatsappSendT, { pointsEarned }, locale);
    } finally {
      setSendingWa(false);
    }
  };

  const handleShareWhatsApp = async () => {
    if (!cartCustomer?.phone) {
      toast.error(tWhatsappSend('customerPhoneRequired'));
      return;
    }
    try {
      const opened = await shareBillViaWhatsApp(
        bill,
        { phone: cartCustomer.phone, country_code: cartCustomer.country_code },
        tenantForShare,
        { pointsEarned },
        locale,
      );
      if (!opened) toast.error(tOrders('whatsappFailed'));
    } catch {
      toast.error(tOrders('whatsappFailed'));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-card w-full sm:max-w-4xl sm:max-h-[95vh] sm:flex sm:flex-col rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border">
          <div>
            <h2 className="text-lg font-bold text-foreground">{t('payment')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{t('billNumber', { number: bill.bill_number })}</p>
          </div>
          <button
            onClick={onClose}
            className="touch-target rounded-full bg-muted hover:bg-muted active:bg-muted text-muted-foreground transition-colors"
            aria-label={t('close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[75vh] overflow-y-auto sm:min-h-0 lg:grid lg:grid-cols-2 lg:gap-5">

          {kitchenOverrideRequired && (
            <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-200 lg:col-span-2">
              {kitchenUndeliveredCount > 0 && <p className="text-sm font-medium">{t('kitchenItemsPendingWarning', { count: kitchenUndeliveredCount })}</p>}
              <p className="text-sm">{t('kitchenDeliveryOverridePrompt')}</p>
              {kitchenUndeliveredItems.length > 0 && <p className="mt-1 break-words text-xs">{kitchenUndeliveredItems.join(', ')}</p>}
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={kitchenOverridePin}
                onChange={(event) => { setKitchenOverridePin(event.target.value.replace(/\D/g, '').slice(0, 6)); setKitchenDeliveryError(''); }}
                placeholder={t('managerPin')}
                aria-label={t('managerPin')}
                className="mt-3 min-h-11 w-full rounded-lg border border-amber-300 bg-card px-3 py-2 text-center text-lg tracking-[0.5em] dark:border-amber-700"
              />
              {kitchenDeliveryError && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{kitchenDeliveryError}</p>}
            </div>
          )}

          <div className="space-y-4">

          {/* Amount + Customer Card */}
          <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-2xl px-5 py-4 text-white">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-xs font-medium text-slate-400 uppercase tracking-widest">{t('totalDue')}</p>
                <p className="text-4xl font-bold mt-1 tracking-tight">{currencyFmt(remaining)}</p>
              </div>
              {cartCustomer && (
                <div className="text-end ms-4 shrink-0">
                  <div className="w-8 h-8 rounded-full bg-card/10 flex items-center justify-center mb-1 ms-auto">
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
              {Number(bill.packaging_charge) > 0 && !appliedCharges.some((charge) => charge.id === 'packaging_charge') && (
                <div className="flex justify-between text-slate-300">
                  <span>{t('packaging')}</span>
                  <span>{currencyFmt(Number(bill.packaging_charge))}</span>
                </div>
              )}
              {Number(bill.service_charge) > 0 && !appliedCharges.some((charge) => charge.id === 'service_charge') && (
                <div className="flex justify-between text-slate-300">
                  <span>{tReceipt('serviceCharge')}</span>
                  <span>{currencyFmt(Number(bill.service_charge))}</span>
                </div>
              )}
              {(appliedCharges.length > 0 || (canEditCharges && addableCharges.length > 0)) && (
                <div className="space-y-1 pt-1" data-testid="payment-charges">
                  {appliedCharges.map((charge) => {
                    const definition = applicableCharges.find((c) => c.id === charge.id);
                    return (
                      <div key={charge.id} data-testid={`payment-charge-${charge.id}`} className="flex justify-between items-center gap-2 text-slate-300">
                        <span className={charge.waived ? 'line-through' : undefined}>{charge.name}</span>
                        <span className="flex items-center gap-2">
                          <span className={charge.waived ? 'line-through' : undefined}>{currencyFmt(charge.amount)}</span>
                          {canEditCharges && definition?.is_optional && (
                            <button
                              type="button"
                              disabled={Boolean(updatingChargeId)}
                              onClick={() => void updateCharge(charge.id, { waived: !charge.waived })}
                              aria-pressed={charge.waived}
                              className="text-[11px] px-2 py-0.5 rounded border border-white/20 text-slate-300 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {charge.waived ? t('applyCharge') : t('waiveCharge')}
                            </button>
                          )}
                          {canEditCharges && definition && !definition.is_default_active && (
                            <button
                              type="button"
                              disabled={Boolean(updatingChargeId)}
                              onClick={() => void updateCharge(charge.id, { applied: false })}
                              className="text-[11px] px-2 py-0.5 rounded border border-white/20 text-slate-300 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {t('removeCharge')}
                            </button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                  {canEditCharges && addableCharges.map((charge) => (
                    <div key={charge.id} data-testid={`payment-charge-${charge.id}`} className="flex justify-between items-center gap-2 text-slate-300">
                      <span>{charge.name}</span>
                      <button
                        type="button"
                        disabled={Boolean(updatingChargeId)}
                        onClick={() => void updateCharge(charge.id, { applied: true })}
                        className="text-[11px] px-2 py-0.5 rounded border border-white/20 text-slate-300 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t('addCharge')}
                      </button>
                    </div>
                  ))}
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
            <div className="flex items-center gap-2 px-3.5 py-2.5 bg-muted border border-border rounded-xl">
              <Sparkles size={13} className="text-muted-foreground shrink-0" />
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span className="text-foreground font-medium">{t('loyalty')}</span>
                <span className="font-semibold text-foreground">
                  {walletBalance !== null
                    ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE))) })
                    : '…'}
                </span>
              </div>
            </div>
          )}

          {/* Discount */}
          {!bill.split_group_id && discountMode !== 'none' && <div className="rounded-xl border border-border overflow-hidden">
            <button type="button" onClick={() => setShowDiscount((open) => !open)} className="touch-target w-full justify-between gap-3 px-3 bg-muted text-start">
              <span className="text-sm font-medium text-foreground">
                {Number(bill.discount_amount) > 0
                  ? `${t('discount')}: -${currencyFmt(Number(bill.discount_amount))}`
                  : t('applyDiscount')}
              </span>
              <ChevronDown size={16} className={`text-muted-foreground transition-transform ${showDiscount ? 'rotate-180' : ''}`} />
            </button>

            {showDiscount && (
              <div className="bg-purple-50 dark:bg-purple-950/40 border-t border-purple-200 dark:border-purple-800/40 p-3 space-y-2">
                <div className="flex rounded-lg overflow-hidden border border-purple-200 dark:border-purple-800/40">
                  {isDiscountTypeAllowed(discountMode, 'percentage') && (
                    <button
                      onClick={() => { setDiscountType('percentage'); }}
                      className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-purple-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
                    >
                      <Percent size={14} />
                      {t('percentage')}
                    </button>
                  )}
                  {isDiscountTypeAllowed(discountMode, 'amount') && (
                    <button
                      onClick={() => { setDiscountType('amount'); }}
                      className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'amount' ? 'bg-purple-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
                    >
                      {t('flatAmount')}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <span className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    {discountType === 'percentage' ? '%' : inputCurrencyLabel}
                  </span>
                  <input
                    type="number"
                    value={discountValue}
                    onFocus={() => setAmountTarget({ kind: 'discount' })}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountType === 'percentage' ? '0' : '0.00'}
                    min="0"
                    max={discountType === 'percentage' ? 100 : toDisplayUnit(Number(bill.subtotal))}
                    step={getDiscountInputStep(unitAdapter.maxDecimals, discountType)}
                    inputMode={discountType === 'percentage' ? 'numeric' : 'decimal'}
                    className="w-full min-h-11 ps-8 pe-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
                  />
                </div>
                <input
                  type="text"
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  placeholder={t('discountReasonPlaceholder')}
                  className="w-full min-h-11 px-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
                />
                {discountRequiresApproval && parseFloat(discountValue) > 0 && (
                  <input
                    type="password"
                    value={discountPin}
                    onChange={(e) => setDiscountPin(e.target.value)}
                    placeholder={t('managerPin')}
                    maxLength={6}
                    className="w-full min-h-11 px-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
                  />
                )}
                <Button
                  onClick={() => handleApplyDiscount()}
                  disabled={applyingDiscount || discountValue === '' || isNaN(parseFloat(discountValue))}
                  className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                >
                  {applyingDiscount
                    ? t('applyingDiscount')
                    : Number(bill.discount_amount) > 0 ? t('updateDiscount') : t('applyDiscount')}
                </Button>
                {Number(bill.discount_amount) > 0 && (
                  <Button variant="outline" className="w-full" onClick={async () => {
                    if (await confirm(t('removeDiscountConfirm'), { destructive: true, confirmLabel: t('remove') })) void handleApplyDiscount(0);
                  }}>
                    {t('remove')}
                  </Button>
                )}
              </div>
            )}
          </div>}

          </div>

          <div className="space-y-4">

          {/* Equal-share shortcut: divides the remaining balance by payer count */}
          {remainingMinor > 0 && !justPaid && (
            <div className="rounded-xl border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => { setShowEqualShare((open) => !open); setEqualShareNotice(null); }}
                aria-expanded={showEqualShare}
                className="touch-target w-full justify-between gap-3 px-3 bg-muted text-start"
              >
                <span className="text-sm font-medium text-foreground">{t('splitPaymentEqually')}</span>
                <ChevronDown size={16} className={`text-muted-foreground transition-transform ${showEqualShare ? 'rotate-180' : ''}`} />
              </button>
              {equalShareNotice && (
                <p role="status" className="border-t border-border bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                  {t(equalShareNotice === 'lastPayer' ? 'equalShareLastPayer' : 'equalShareInvalidated')}
                </p>
              )}
              {showEqualShare && (
                <div className="space-y-2 border-t border-border bg-sky-50 p-3 dark:bg-sky-950/40">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="equal-share-payers" className="text-sm font-medium text-foreground">{t('equalSharePayers')}</label>
                    <input
                      id="equal-share-payers"
                      type="number"
                      min={MIN_EQUAL_SHARE_PAYERS}
                      max={MAX_EQUAL_SHARE_PAYERS}
                      step={1}
                      inputMode="numeric"
                      value={equalSharePayers}
                      disabled={processing}
                      onChange={(event) => setEqualSharePayers(event.target.value)}
                      className="min-h-9 w-20 rounded-lg border border-border bg-card px-2 py-1 text-end text-sm font-semibold outline-none focus:ring-2 focus:ring-brand"
                    />
                  </div>
                  {equalShareError ? (
                    <p role="alert" className="text-[11px] text-red-700 dark:text-red-300">
                      {t(equalShareError === 'tooManyPayers' ? 'equalShareTooManyPayers' : 'equalShareInvalidCount')}
                    </p>
                  ) : (
                    <>
                      <ul className="space-y-1 text-sm">
                        {equalShareShares.map((shareMinor, index) => (
                          <li key={index} className="flex items-center justify-between gap-2">
                            <span className="text-muted-foreground">
                              {index + 1}
                              {index === 0 && <span className="ms-2 text-[11px] font-medium text-brand">{t('equalShareNextShare')}</span>}
                            </span>
                            <span data-testid={`equal-share-share-${index}`} className="font-semibold tabular-nums text-foreground">
                              {currencyFmt(minorToStored(shareMinor))}
                            </span>
                          </li>
                        ))}
                        <li className="flex items-center justify-between gap-2 border-t border-border pt-1 font-semibold">
                          <span>{t('total')}</span>
                          <span data-testid="equal-share-total" className="tabular-nums">{currencyFmt(remaining)}</span>
                        </li>
                      </ul>
                      {equalShareSharesDiffer && (
                        <p className="text-[11px] text-muted-foreground">{t('equalShareRoundingNote')}</p>
                      )}
                      {equalShareConflict && (
                        <p className="text-[11px] text-amber-700 dark:text-amber-300">{t('equalShareConflicts')}</p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {payments.map((payment, idx) => (
                          <Button
                            key={payment.payment_method_id === undefined ? payment.method : `custom:${payment.payment_method_id}`}
                            variant="outline"
                            size="sm"
                            disabled={processing || tenderHasConflict(idx)}
                            onClick={() => applyEqualShare(idx)}
                          >
                            {t('equalShareApplyTo', { method: tenderLabel(payment) })}
                          </Button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            {payments.map((payment, idx) => {
              const builtIn = PAYMENT_METHODS.find((method) => method.key === payment.method && payment.payment_method_id === undefined);
              const label = tenderLabel(payment);
              const Icon = builtIn?.icon;
              const active = (parseFloat(payment.amount) || 0) > 0;
              const isAppliedShare = appliedEqualShare?.index === idx;
              return <div key={payment.payment_method_id === undefined ? payment.method : `custom:${payment.payment_method_id}`} className="space-y-1">
                <div className="flex min-h-12">
                  <button type="button" title={label} disabled={processing} onClick={() => { setAmountTarget({ kind: 'payment', index: idx }); allocateRemainingTo(idx); }} className={`touch-target w-36 shrink-0 justify-start rounded-s-xl border px-3 gap-2 text-sm font-semibold transition-colors ${active ? 'bg-brand text-white border-brand' : 'bg-muted text-foreground border-border hover:border-brand hover:text-brand'}`}>
                    {Icon && <Icon size={15} />}
                    <span className="truncate">{label}</span>
                  </button>
                  <div className="flex flex-1 items-center border border-s-0 border-border rounded-e-xl bg-card focus-within:ring-2 focus-within:ring-brand focus-within:border-transparent">
                    <span className="ps-3 text-muted-foreground text-xs">{inputCurrencyLabel}</span>
                    <input
                      type="number"
                      value={payment.amount}
                      disabled={processing}
                      onFocus={() => setAmountTarget({ kind: 'payment', index: idx })}
                      onChange={(e) => updatePaymentAmount(idx, e.target.value)}
                      placeholder="0.00"
                      inputMode="decimal"
                      className="min-w-0 flex-1 px-2 py-2 text-end text-base font-semibold outline-none rounded-e-xl"
                      step={inputCurrencyStep}
                      min="0"
                    />
                  </div>
                </div>
                {isAppliedShare && (
                  <p className="px-1 text-[11px] font-medium text-brand">{t('equalShareBadge')}</p>
                )}
              </div>;
            })}
          </div>

          {/* Change Returned */}
          {hasCash && (
            <div className={`rounded-xl px-4 py-3 flex items-center justify-between border-2 transition-all duration-200 ${
              change > 0
                ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/40'
                : 'bg-muted border-border'
            }`}>
              <div className="flex items-center gap-2.5">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center ${
                  change > 0 ? 'bg-emerald-100 dark:bg-emerald-950/60' : 'bg-gray-200 dark:bg-muted'
                }`}>
                  {change > 0
                    ? <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400" />
                    : <ArrowLeftRight size={13} className="text-muted-foreground" />
                  }
                </div>
                <span className={`text-sm font-semibold ${
                  change > 0 ? 'text-emerald-800 dark:text-emerald-300' : 'text-muted-foreground'
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
              <div className="flex min-h-12">
                <button type="button" disabled={processing || walletBalance <= 0} onClick={() => {
                  const allocatedElsewhere = payments.reduce((sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0), 0);
                  const maxWalletStored = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
                  const dueStored = Math.min(maxWalletStored, Math.max(0, remaining - allocatedElsewhere));
                  const dueDisplay = toDisplayUnit(dueStored);
                  setWalletAmount(dueDisplay > 0 ? String(dueDisplay) : '');
                  setAmountTarget({ kind: 'wallet' });
                }} className={`touch-target w-36 shrink-0 justify-start rounded-s-xl border px-3 gap-2 text-sm font-semibold ${walletAmt > 0 ? 'bg-purple-600 text-white border-purple-600' : 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800/40 disabled:bg-muted disabled:text-muted-foreground disabled:border-border'}`}>
                  <Wallet size={15} /><span className="truncate">{t('loyaltyWallet')}</span>
                </button>
                <div className="flex flex-1 items-center border border-s-0 border-purple-200 dark:border-purple-800/40 rounded-e-xl bg-card focus-within:ring-2 focus-within:ring-purple-400">
                  <span className="ps-3 text-muted-foreground text-xs">{inputCurrencyLabel}</span>
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
                    disabled={processing || walletBalance <= 0}
                    inputMode="decimal"
                    className="min-w-0 flex-1 px-2 py-2 text-end text-base font-semibold outline-none rounded-e-xl disabled:bg-muted"
                    step={inputCurrencyStep}
                    min="0"
                    max={toDisplayUnit(Math.min(Math.floor(walletBalance / (LOYALTY_REDEMPTION_RATE)), remaining))}
                  />
                </div>
              </div>
              <p className="px-1 text-[11px] text-muted-foreground text-end">{walletBalance > 0 ? t('pointsApproxValue', { count: fmtNum(walletBalance), value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)) }) : t('noBalance')}</p>
            </div>
          )}
          {amountTarget && !processing && (
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
          </div>
        </div>

        <div className="px-5 pb-5 border-t border-border pt-3 space-y-2">
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
            <>
              {canSplitCheck && (
                <Button
                  variant="outline"
                  onClick={handleOpenSplitCheck}
                  disabled={openingSplitCheck || processing}
                  className="w-full"
                  size="lg"
                >
                  <Users size={16} className="me-2" />
                  {t('splitCheck')}
                </Button>
              )}
              <Button onClick={handlePay} disabled={processing || Boolean(updatingChargeId) || chargeStateUncertain || (totalPaymentMinor === 0 && remainingMinor > 0)} className="w-full" size="lg">
                {processing ? t('processingPayment') : `${t('pay')} ${currencyFmt(totalPayment)}`}
              </Button>
            </>
          )}
        </div>
      </div>
      {splitCheckOrder && (
        <SplitCheckModal
          bill={bill}
          order={splitCheckOrder}
          onClose={() => setSplitCheckOrder(null)}
          onSplit={handleSplitComplete}
        />
      )}
      {ConfirmDialog}
    </div>
  );
}
