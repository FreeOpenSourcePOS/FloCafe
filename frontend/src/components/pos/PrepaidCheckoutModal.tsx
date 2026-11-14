'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { X, CheckCircle2, Percent, Wallet, ChevronDown, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { cartLineUnitPrice, cartVariantUnitPrice } from '@/lib/cart-price';
import { chargesForOrderType, useChargesStore } from '@/store/charges';
import { useAuthStore } from '@/store/auth';
import { useTaxPreview } from '@/hooks/use-tax-preview';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import type { Bill } from '@/lib/types';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import toast from 'react-hot-toast';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCountryByCode, getCurrencyMinorUnitFactor } from '@/lib/countries';
import { getDiscountInputStep, normalizeFixedDiscountValue } from '@/lib/currency-input';
import {
  allocateRemainingMinor,
  computeQuickCashDisplayAmounts,
  rescalePaymentAmountsMinor,
} from '@/lib/checkout-quick-tender';
import {
  CheckoutPaymentStation,
  type CheckoutQuickTenderOption,
  type CheckoutStatusBanner,
} from '@/components/pos/CheckoutPaymentStation';
import { CurrencyTouchNumberPad } from '@/components/pos/TouchNumberPad';
import {
  defaultDiscountTypeForMode,
  isDiscountTypeAllowed,
  normalizeDiscountMode,
  type DiscountMode,
  type DiscountType,
} from '@/lib/discount-settings';
import { ApproverSelect } from '@/components/ApproverSelect';
import { useManagerApprovers } from '@/hooks/useManagerApprovers';

interface LoyaltySettings {
  loyalty_enabled: boolean;
}

export interface PrepaidPayment {
  method: string;
  payment_method_id?: number;
  amount: number;
  transaction_id?: string;
}

export interface PrepaidDiscount {
  type: DiscountType;
  value: number;
  reason?: string;
  override_pin?: string;
  approver_id?: string;
}

interface PrepaidSuccess {
  bill: Bill;
  customer: { phone: string | null; country_code: string | null } | null;
  pointsEarned: number;
}

interface Props {
  currency: string;
  initialCardTransactionIdRequired?: boolean;
  initialDiscount?: PrepaidDiscount | null;
  discountCommitted?: boolean;
  recovery?: {
    message: string;
    statusChecked: boolean;
    details: {
      operation: string;
      stage: string;
      outcome: string;
      reasonCode?: string | null;
      correlationId?: string | null;
      httpStatus: number | null;
    };
  } | null;
  failure?: {
    message: string;
    nextStep?: string;
    details: {
      operation: string;
      stage: string;
      outcome: string;
      reasonCode?: string | null;
      correlationId?: string | null;
      httpStatus: number | null;
    };
  } | null;
  onCheckRecovery?: () => Promise<void>;
  onClose: () => void;
  onConfirm: (
    payments: PrepaidPayment[],
    walletAmount: number,
    discount: PrepaidDiscount | null,
  ) => Promise<PrepaidSuccess | void> | void;
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
  transaction_id?: string;
}

type AmountTarget =
  | { kind: 'payment'; index: number }
  | { kind: 'wallet' }
  | { kind: 'discount' }
  | null;

export default function PrepaidCheckoutModal({
  initialCardTransactionIdRequired,
  initialDiscount = null,
  discountCommitted = false,
  recovery = null,
  failure = null,
  onCheckRecovery,
  onClose,
  onConfirm,
}: Props) {
  const cart = useCartStore();
  const customer = cart.customer;
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tOrders = useTranslations('orders');
  const locale = useLocale();
  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();
  const unitAdapter = useCurrencyUnitAdapter();
  const {
    toDisplay: toDisplayUnit,
    toStored: toStoredUnit,
    label: inputCurrencyLabel,
    step: inputCurrencyStep,
    formatInput,
  } = unitAdapter;
  const { currentTenant } = useAuthStore();
  const charges = useChargesStore((s) => s.charges);
  const loadCharges = useChargesStore((s) => s.load);
  const currencyCode =
    currentTenant?.currency ||
    (currentTenant?.country ? getCountryByCode(currentTenant.country)?.currency : undefined) ||
    'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currencyCode);
  const toMinorUnits = (amount: number) => Math.round(amount * minorFactor);

  const [loyaltySettings, setLoyaltySettings] = useState<LoyaltySettings | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletLoadFailed, setWalletLoadFailed] = useState(false);
  const [walletAmount, setWalletAmount] = useState('');
  const [processing, setProcessing] = useState(false);
  const [success, setSuccess] = useState<PrepaidSuccess | null>(null);
  const inFlightRef = useRef(false);
  const lastSubmissionRef = useRef<[PrepaidPayment[], number, PrepaidDiscount | null] | null>(null);
  const locked = processing || Boolean(recovery);
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);
  const [cardTransactionIdRequired, setCardTransactionIdRequired] = useState(
    Boolean(initialCardTransactionIdRequired),
  );

  // Discount state (applied to the order once checkout is confirmed)
  const hasInitialDiscount = Boolean(initialDiscount && initialDiscount.value > 0);
  const [activeCol1Panel, setActiveCol1Panel] = useState<'items' | 'discount' | 'tax'>(
    hasInitialDiscount ? 'discount' : 'items',
  );
  const discountOpen = activeCol1Panel === 'discount';
  const [discountType, setDiscountType] = useState<DiscountType>(
    hasInitialDiscount && initialDiscount ? initialDiscount.type : 'percentage',
  );
  const [discountValue, setDiscountValue] = useState(() => {
    if (!hasInitialDiscount || !initialDiscount) return '';
    return initialDiscount.type === 'amount'
      ? formatInput(toDisplayUnit(initialDiscount.value))
      : String(initialDiscount.value);
  });
  const [discountReason, setDiscountReason] = useState(
    hasInitialDiscount && initialDiscount?.reason ? initialDiscount.reason : '',
  );
  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountModeLoaded, setDiscountModeLoaded] = useState(false);
  const managerApprovers = useManagerApprovers();
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');
  const [discountApproverId, setDiscountApproverId] = useState<string | null>(null);
  const [amountTarget, setAmountTarget] = useState<AmountTarget>({ kind: 'payment', index: 0 });
  const setCol1Panel = (
    next: 'items' | 'discount' | 'tax' | ((prev: 'items' | 'discount' | 'tax') => 'items' | 'discount' | 'tax'),
  ) => {
    const resolved = typeof next === 'function' ? next(activeCol1Panel) : next;
    if (resolved !== activeCol1Panel) {
      setActiveCol1Panel(resolved);
    }
    if (resolved !== 'discount' && amountTarget?.kind === 'discount') {
      setAmountTarget({ kind: 'payment', index: 0 });
    }
  };
  const setDiscountOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(activeCol1Panel === 'discount') : next;
    setCol1Panel(resolved ? 'discount' : 'items');
  };
  const [showDetails, setShowDetails] = useState(false);

  const previewDiscount = useMemo(() => {
    const rawValue = Number.parseFloat(discountValue);
    if (!Number.isFinite(rawValue) || rawValue <= 0) return null;
    const normalizedValue =
      discountType === 'amount'
        ? normalizeFixedDiscountValue(rawValue, unitAdapter.maxDecimals)
        : Math.min(100, Math.max(0, rawValue));
    if (discountType === 'amount' && normalizedValue <= 0) return null;
    return {
      type: discountType,
      value: discountType === 'percentage' ? normalizedValue : toStoredUnit(normalizedValue),
    };
  }, [discountType, discountValue, toStoredUnit, unitAdapter.maxDecimals]);
  const committedInitialDiscountUnchanged = Boolean(
    discountCommitted &&
    initialDiscount &&
    initialDiscount.value > 0 &&
    previewDiscount &&
    previewDiscount.type === initialDiscount.type &&
    previewDiscount.value === initialDiscount.value &&
    (discountReason || undefined) === (initialDiscount.reason || undefined),
  );
  const discountNeedsApprovalPin = discountRequiresApproval && !committedInitialDiscountUnchanged;
  const chargeContext = useMemo(
    () => ({
      orderType: cart.orderType,
      onlinePlatform: cart.onlinePlatform,
      waivedChargeIds: Array.from(cart.waivedChargeIds),
      optedInChargeIds: Array.from(cart.optedInChargeIds),
    }),
    [cart.orderType, cart.onlinePlatform, cart.waivedChargeIds, cart.optedInChargeIds],
  );
  const applicableCharges = chargesForOrderType(charges, cart.orderType);
  const addableCharges = applicableCharges.filter(
    (charge) => !charge.is_default_active && !cart.optedInChargeIds.has(charge.id),
  );
  const rawDiscountValue = Number.parseFloat(discountValue);
  const normalizedFixedDiscountValue =
    discountType === 'amount' && Number.isFinite(rawDiscountValue) && rawDiscountValue > 0
      ? normalizeFixedDiscountValue(rawDiscountValue, unitAdapter.maxDecimals)
      : null;
  const hasInvalidFixedDiscount = normalizedFixedDiscountValue === 0;
  const { tax, loading: taxLoading } = useTaxPreview(
    cart.items,
    cart.customerId,
    undefined,
    previewDiscount,
    chargeContext,
  );

  useEffect(() => {
    void loadCharges();
  }, [loadCharges]);

  const [payments, setPayments] = useState<Payment[]>(
    PAYMENT_METHODS.map((method) => ({ method: method.key, amount: '' })),
  );
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(false);
  // When a single tender row was auto-filled for the full remaining due (without manual typing),
  // subsequent discount edits keep that row synced with the updated balance.
  const [autoFilledSingleIndex, setAutoFilledSingleIndex] = useState<number | null>(null);

  // Same one-shot reconciliation as PaymentModal: `none` forbids every type, so
  // its cleanup runs once on entry instead of rescheduling every render.
  const [reconciledDiscountMode, setReconciledDiscountMode] = useState(discountMode);
  if (discountMode !== reconciledDiscountMode) {
    setReconciledDiscountMode(discountMode);
    if (discountMode === 'none' && !committedInitialDiscountUnchanged) {
      setDiscountType(defaultDiscountTypeForMode(discountMode));
      setDiscountValue('');
      setDiscountReason('');
      setDiscountPin('');
      setPaymentsTouched(false);
      setAmountTarget((target) =>
        target?.kind === 'discount' ? { kind: 'payment', index: 0 } : target,
      );
    }
  }

  if (
    discountModeLoaded &&
    !committedInitialDiscountUnchanged &&
    discountMode !== 'none' &&
    !isDiscountTypeAllowed(discountMode, discountType)
  ) {
    setDiscountType(defaultDiscountTypeForMode(discountMode));
    setDiscountValue('');
    setDiscountReason('');
    setDiscountPin('');
    setPaymentsTouched(false);
    setAmountTarget((target) =>
      target?.kind === 'discount' ? { kind: 'payment', index: 0 } : target,
    );
  }

  useEffect(() => {
    api
      .get('/settings/loyalty')
      .then((res) => setLoyaltySettings(res.data))
      .catch(() => {});
    api
      .get('/settings/discount')
      .then((res) => {
        setDiscountMode(normalizeDiscountMode(res.data.discount_mode));
        setDiscountRequiresApproval(!!res.data.discount_requires_approval);
      })
      .catch(() => {})
      .finally(() => setDiscountModeLoaded(true));
    api
      .get('/settings/card_transaction_id_required')
      .then((res) => setCardTransactionIdRequired(res.data?.setting?.value === 'true'))
      .catch(() => {});
    api
      .get('/payment-methods')
      .then((res) => {
        const methods: CustomPaymentMethod[] = res.data.payment_methods || [];
        setCustomMethods(methods);
        setPayments((current) => [
          ...PAYMENT_METHODS.map(
            (method) =>
              current.find(
                (row) => row.method === method.key && row.payment_method_id === undefined,
              ) || { method: method.key, amount: '' },
          ),
          ...methods.map(
            (method) =>
              current.find((row) => row.payment_method_id === method.id) || {
                method: 'custom',
                payment_method_id: method.id,
                amount: '',
              },
          ),
        ]);
      })
      .catch(() => setCustomMethods([]));
  }, []);

  // Reset stale wallet balance during render when customer changes
  // to avoid flashing previous customer balance.
  const [syncedCustomerId, setSyncedCustomerId] = useState(customer?.id ?? null);
  if ((customer?.id ?? null) !== syncedCustomerId) {
    setSyncedCustomerId(customer?.id ?? null);
    setWalletLoadFailed(false);
    setWalletBalance(null);
    setWalletAmount('');
    setAmountTarget({ kind: 'payment', index: 0 });
  }

  useEffect(() => {
    if (customer?.id) {
      api
        .get(`/customers/${customer.id}/wallet`)
        .then((res) => {
          setWalletBalance(Number(res.data.balance) || 0);
        })
        .catch(() => setWalletLoadFailed(true));
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
      charges: tax.charges_breakdown || [],
      roundOff: tax.round_off,
      total: tax.total,
    };
  }, [tax]);

  const remaining = preview?.total ?? 0;

  // Auto-fill splits to match net total during render when total changes,
  // unless cashier has already edited inputs manually.
  const [syncedRemaining, setSyncedRemaining] = useState(remaining);
  if (preview && remaining !== syncedRemaining) {
    setSyncedRemaining(remaining);
    const remainingTargetMinor = Math.max(
      0,
      toMinorUnits(remaining) - toMinorUnits(toStoredUnit(parseFloat(walletAmount) || 0)),
    );
    if (autoFilledSingleIndex !== null && payments[autoFilledSingleIndex]) {
      const nextDisplay = toDisplayUnit(remainingTargetMinor / minorFactor);
      setPayments(
        payments.map((p, idx) =>
          idx === autoFilledSingleIndex
            ? { ...p, amount: remainingTargetMinor > 0 ? formatInput(nextDisplay) : '' }
            : p,
        ),
      );
    } else if (!paymentsTouched) {
      const currentMinor = payments.map((p) =>
        toMinorUnits(toStoredUnit(parseFloat(p.amount) || 0)),
      );
      const totalMinor = currentMinor.reduce((s, v) => s + v, 0);
      if (totalMinor > 0) {
        const rescaledMinor = rescalePaymentAmountsMinor(currentMinor, remainingTargetMinor);
        setPayments(
          payments.map((p, idx) => ({
            ...p,
            amount:
              rescaledMinor[idx] > 0
                ? formatInput(toDisplayUnit(rescaledMinor[idx] / minorFactor))
                : '',
          })),
        );
      }
    }
  }

  const walletAmt = toStoredUnit(parseFloat(walletAmount) || 0);
  const totalPaymentMinor =
    payments.reduce((s, p) => s + toMinorUnits(toStoredUnit(parseFloat(p.amount) || 0)), 0) +
    toMinorUnits(walletAmt);
  const remainingMinor = toMinorUnits(remaining);

  const updatePaymentTransactionId = (idx: number, value: string) => {
    setPayments((current) =>
      current.map((payment, index) =>
        index === idx ? { ...payment, transaction_id: value } : payment,
      ),
    );
  };

  const needsTransactionId = (payment: Payment) =>
    (cardTransactionIdRequired || initialCardTransactionIdRequired) &&
    payment.method === 'card' &&
    payment.payment_method_id === undefined;

  const updatePaymentAmount = (idx: number, value: string) => {
    setPaymentsTouched(true);
    setAutoFilledSingleIndex(null);
    setPayments((current) =>
      current.map((payment, index) => (index === idx ? { ...payment, amount: value } : payment)),
    );
  };

  const allocateRemainingTo = (idx: number) => {
    const rowMinor = payments.map((payment) =>
      toMinorUnits(toStoredUnit(parseFloat(payment.amount) || 0)),
    );
    const dueMinor = allocateRemainingMinor(
      Math.max(0, remainingMinor - toMinorUnits(walletAmt)),
      rowMinor,
      idx,
    );
    const hasOtherActive = walletAmt > 0 || rowMinor.some((amt, index) => index !== idx && amt > 0);
    if (!hasOtherActive && dueMinor > 0) {
      setAutoFilledSingleIndex(idx);
      setPaymentsTouched(false);
    } else {
      setAutoFilledSingleIndex(null);
      setPaymentsTouched(true);
    }
    const dueDisplay = toDisplayUnit(dueMinor / minorFactor);
    setPayments(
      payments.map((payment, index) =>
        index === idx
          ? { ...payment, amount: dueMinor > 0 ? formatInput(dueDisplay) : '' }
          : payment,
      ),
    );
  };

  const hasCash = payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);
  const change =
    !taxLoading && preview && hasCash && totalPaymentMinor > remainingMinor
      ? (totalPaymentMinor - remainingMinor) / minorFactor
      : 0;

  const activeAmountLabel =
    amountTarget?.kind === 'discount'
      ? t('discount')
      : amountTarget?.kind === 'wallet'
        ? t('loyaltyWallet')
        : amountTarget?.kind === 'payment' && payments[amountTarget.index]
          ? (() => {
              const payment = payments[amountTarget.index];
              const builtIn = PAYMENT_METHODS.find(
                (method) =>
                  method.key === payment.method && payment.payment_method_id === undefined,
              );
              const custom = customMethods.find(
                (method) => method.id === payment.payment_method_id,
              );
              return builtIn
                ? t(BUILT_IN_PAYMENT_KEYS[builtIn.key])
                : custom?.name || tCommon('unknown');
            })()
          : t('payment');

  const activeAmountValue =
    amountTarget?.kind === 'payment'
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
      const clamped = parseFloat(value) > maxDisplay ? formatInput(maxDisplay) : value;
      setWalletAmount(clamped);
      setAutoFilledSingleIndex(null);
      setPaymentsTouched(true);
      return;
    }
    setDiscountValue(value);
  };

  const activeAmountMax =
    amountTarget?.kind === 'discount'
      ? discountType === 'percentage'
        ? 100
        : preview
          ? toDisplayUnit(preview.subtotal)
          : undefined
      : amountTarget?.kind === 'wallet'
        ? toDisplayUnit(
            Math.min(Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE), remaining),
          )
        : undefined;

  const remainingWalletMinor = () => {
    if (!walletBalance || walletBalance <= 0) return 0;
    const allocatedPaymentsMinor = payments.reduce(
      (sum, payment) => sum + toMinorUnits(toStoredUnit(parseFloat(payment.amount) || 0)),
      0,
    );
    const maxWalletStored = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
    return Math.min(
      toMinorUnits(maxWalletStored),
      Math.max(0, remainingMinor - allocatedPaymentsMinor),
    );
  };

  const activeAmountQuickValues = (() => {
    if (amountTarget?.kind === 'payment') {
      const rowMinor = payments.map((payment) =>
        toMinorUnits(toStoredUnit(parseFloat(payment.amount) || 0)),
      );
      const dueMinor = allocateRemainingMinor(
        Math.max(0, remainingMinor - toMinorUnits(walletAmt)),
        rowMinor,
        amountTarget.index,
      );
      return dueMinor > 0
        ? [{ label: t('exactAmount'), value: formatInput(toDisplayUnit(dueMinor / minorFactor)) }]
        : [];
    }
    if (amountTarget?.kind === 'wallet') {
      const dueMinor = remainingWalletMinor();
      return dueMinor > 0
        ? [{ label: t('exactAmount'), value: formatInput(toDisplayUnit(dueMinor / minorFactor)) }]
        : [];
    }
    return [];
  })();

  const handleConfirm = (paymentRows = payments) => {
    if (inFlightRef.current || locked) return;
    if (hasInvalidFixedDiscount) {
      toast.error(unitAdapter.maxDecimals === 0 ? t('fixedDiscountMinimum') : t('discountInvalid'));
      return;
    }
    if (!preview) return;
    const decimalPart =
      unitAdapter.maxDecimals > 0 ? `(?:\\.\\d{1,${unitAdapter.maxDecimals}})?` : '';
    const amountPattern = new RegExp(`^\\d+${decimalPart}$`);
    const amountIsValid = (value: string) =>
      value.trim() === '' || amountPattern.test(value.trim());
    if (
      paymentRows.some(
        (p) =>
          (!PAYMENT_METHODS.some((allowed) => allowed.key === p.method) &&
            !customMethods.some((method) => method.id === p.payment_method_id)) ||
          !amountIsValid(p.amount),
      )
    ) {
      toast.error(t('paymentFailed'));
      return;
    }
    if (walletAmount.trim() && !amountPattern.test(walletAmount.trim())) {
      toast.error(t('paymentFailed'));
      return;
    }
    if (
      paymentRows.some(
        (p) =>
          needsTransactionId(p) && (parseFloat(p.amount) || 0) > 0 && !p.transaction_id?.trim(),
      )
    ) {
      toast.error(t('cardTransactionIdMissing'));
      return;
    }
    const paymentTotalMinor =
      paymentRows.reduce(
        (sum, payment) => sum + toMinorUnits(toStoredUnit(Number(payment.amount) || 0)),
        0,
      ) + toMinorUnits(walletAmt);
    const nonCashTotalMinor =
      paymentRows
        .filter((p) => p.method !== 'cash')
        .reduce((sum, p) => sum + toMinorUnits(toStoredUnit(Number(p.amount) || 0)), 0) +
      toMinorUnits(walletAmt);
    if (nonCashTotalMinor > remainingMinor) {
      toast.error(t('paymentAboveBalance'));
      return;
    }
    if (paymentTotalMinor < remainingMinor) {
      toast.error(t('paymentBelowBalance'));
      return;
    }
    if (walletAmt > 0 && walletBalance === null) {
      toast.error(t('paymentFailed'));
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
    const effectiveDiscountApproverId = discountApproverId ?? managerApprovers.selectedApproverId;
    if (preview.discountAmount > 0 && discountNeedsApprovalPin) {
      if (
        !discountPin ||
        managerApprovers.loading ||
        managerApprovers.loadFailed ||
        managerApprovers.approvers.length === 0 ||
        !effectiveDiscountApproverId
      ) {
        toast.error(t('managerPinRequired'));
        return;
      }
    }
    if (
      preview.discountAmount > 0 &&
      !committedInitialDiscountUnchanged &&
      !isDiscountTypeAllowed(discountMode, discountType)
    ) {
      toast.error(t('discountInvalid'));
      return;
    }

    inFlightRef.current = true;
    setProcessing(true);
    const splitLines: PrepaidPayment[] = paymentRows
      .map((p) => ({
        method: p.payment_method_id === undefined ? p.method : 'custom',
        ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
        amount: toStoredUnit(parseFloat(p.amount) || 0),
        ...(needsTransactionId(p) && p.transaction_id?.trim()
          ? { transaction_id: p.transaction_id.trim() }
          : {}),
      }))
      .filter((p) => p.amount > 0 && !isNaN(p.amount));

    const finalDiscount: PrepaidDiscount | null =
      preview.discountAmount > 0
        ? {
            type: discountType,
            value: previewDiscount?.value ?? 0,
            reason: discountReason || undefined,
            override_pin: discountNeedsApprovalPin && discountPin ? discountPin : undefined,
            approver_id:
              discountNeedsApprovalPin && discountPin
                ? effectiveDiscountApproverId || undefined
                : undefined,
          }
        : null;

    const submission: [PrepaidPayment[], number, PrepaidDiscount | null] = [
      splitLines,
      walletAmt,
      finalDiscount,
    ];
    lastSubmissionRef.current = submission;
    Promise.resolve(onConfirm(...submission))
      .then((result) => {
        if (result) setSuccess(result);
      })
      .finally(() => {
        inFlightRef.current = false;
        setProcessing(false);
      });
  };

  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      typeof document !== 'undefined' &&
      modalRef.current &&
      document.activeElement &&
      !modalRef.current.contains(document.activeElement) &&
      typeof (document.activeElement as HTMLElement).blur === 'function'
    ) {
      (document.activeElement as HTMLElement).blur();
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isInput =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        Boolean(target?.isContentEditable);
      const isInsideModal =
        !modalRef.current ||
        !target ||
        (typeof Node !== 'undefined' && !(target instanceof Node)) ||
        modalRef.current.contains(target as Node);
      const isInteractive =
        isInput ||
        (isInsideModal &&
          (tag === 'BUTTON' ||
            tag === 'A' ||
            target?.getAttribute?.('role') === 'button' ||
            Boolean(target?.closest?.('button, a, [role="button"]'))));

      if (e.key === 'Escape') {
        e.preventDefault();
        if (!locked) onClose();
        return;
      }

      if (isInput) return;

      if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') {
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        if (isInteractive) return;
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, locked]);

  if (success) {
    const shareReceipt = async () => {
      if (!success.customer?.phone) return;
      try {
        const { shareBillViaWhatsApp } = await import('@/lib/whatsapp-share');
        const opened = await shareBillViaWhatsApp(
          success.bill,
          { phone: success.customer.phone, country_code: success.customer.country_code || '' },
          {
            business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
            currency: currentTenant?.currency || '',
            country: currentTenant?.country || '',
          },
          { pointsEarned: success.pointsEarned },
          locale,
        );
        if (!opened) toast.error(tOrders('whatsappFailed'));
      } catch {
        toast.error(tOrders('whatsappFailed'));
      }
    };
    return (
      <div
        ref={modalRef}
        data-testid="prepaid-checkout-modal"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      >
        <div
          role="status"
          className="w-full max-w-md space-y-4 rounded-2xl bg-card p-6 text-center shadow-2xl"
        >
          <CheckCircle2 className="mx-auto text-emerald-600" size={40} />
          <p className="text-lg font-semibold text-foreground">
            {success.pointsEarned > 0
              ? t('paymentRecordedWithPoints', { points: success.pointsEarned })
              : t('paymentRecorded')}
          </p>
          <p className="text-2xl font-bold tabular-nums text-foreground">
            {currencyFmt(Number(success.bill.total) || 0)}
          </p>
          <p className="text-sm text-muted-foreground">{t('paid')}</p>
          {success.customer?.phone && (
            <Button
              onClick={() => void shareReceipt()}
              variant="outline"
              className="min-h-11 w-full"
            >
              <Send size={16} className="me-2" />
              {tCommon('shareViaWhatsApp')}
            </Button>
          )}
          <Button onClick={onClose} className="min-h-11 w-full">
            {tCommon('done')}
          </Button>
        </div>
      </div>
    );
  }

  const quickTenderOptions: CheckoutQuickTenderOption[] = (() => {
    if (locked) return [];
    if (amountTarget?.kind === 'discount' && discountType === 'percentage') {
      return [5, 10, 15, 20].map((pct) => ({
        label: `${pct}%`,
        active: Number(discountValue) === pct,
        onClick: () => setDiscountValue(String(pct)),
      }));
    }
    if (taxLoading || !preview) return [];
    if (amountTarget?.kind === 'payment' && payments[amountTarget.index]) {
      const targetIndex = amountTarget.index;
      const allocatedElsewhereMinor =
        payments.reduce(
          (sum, payment, index) =>
            index === targetIndex
              ? sum
              : sum + toMinorUnits(toStoredUnit(parseFloat(payment.amount) || 0)),
          0,
        ) + toMinorUnits(walletAmt);
      const dueMinor = Math.max(0, remainingMinor - allocatedElsewhereMinor);
      const displayAmounts = computeQuickCashDisplayAmounts({
        remainingMinor: dueMinor,
        minorFactor,
        unitAdapter,
      });
      const currentVal = payments[targetIndex]?.amount || '';
      return displayAmounts.map((displayVal, pillIndex) => {
        const formattedInput = formatInput(displayVal);
        return {
          label: currencyFmt(toStoredUnit(displayVal)),
          subLabel: pillIndex === 0 ? t('exactAmount') : undefined,
          active: currentVal !== '' && formattedInput === currentVal,
          onClick: () => {
            if (pillIndex === 0) {
              allocateRemainingTo(targetIndex);
            } else {
              updatePaymentAmount(targetIndex, formattedInput);
            }
          },
        };
      });
    }
    if (amountTarget?.kind === 'wallet' && walletBalance && walletBalance > 0) {
      const dueMinor = remainingWalletMinor();
      if (dueMinor <= 0) return [];
      const exactDisplay = toDisplayUnit(dueMinor / minorFactor);
      const formattedInput = formatInput(exactDisplay);
      return [
        {
          label: currencyFmt(dueMinor / minorFactor),
          subLabel: t('exactAmount'),
          active: walletAmount !== '' && walletAmount === formattedInput,
          onClick: () => {
            setWalletAmount(formattedInput);
            setAutoFilledSingleIndex(null);
            setPaymentsTouched(true);
          },
        },
      ];
    }
    return [];
  })();

  const stationStatusBanner: CheckoutStatusBanner | null = (() => {
    if (recovery) {
      return {
        tone: 'warning',
        message: recovery.message,
        nextStep: recovery.statusChecked
          ? t('paymentRetrySameRequest')
          : t('operationCheckBeforeRetry'),
        technicalDetails: JSON.stringify(recovery.details, null, 2),
        technicalDetailsLabel: t('operationTechnicalDetails'),
        closeLabel: t('close'),
      };
    }
    if (failure) {
      return {
        tone: 'error',
        message: failure.message,
        nextStep: failure.nextStep || null,
        technicalDetails: JSON.stringify(failure.details, null, 2),
        technicalDetailsLabel: t('operationTechnicalDetails'),
        closeLabel: t('close'),
      };
    }
    if (!taxLoading && preview && totalPaymentMinor < remainingMinor) {
      return {
        tone: 'idle-due',
        message: `${t('balanceDue')}: ${currencyFmt((remainingMinor - totalPaymentMinor) / minorFactor)}`,
      };
    }
    if (!taxLoading && preview && totalPaymentMinor >= remainingMinor) {
      return {
        tone: 'idle-settled',
        message: t('paid'),
      };
    }
    return null;
  })();

  const cardTenderIndex = payments.findIndex(
    (p) => p.method === 'card' && p.payment_method_id === undefined,
  );
  const cardPayment = cardTenderIndex >= 0 ? payments[cardTenderIndex] : null;
  const cardTenderActive = Boolean(
    cardPayment &&
    ((parseFloat(cardPayment.amount) || 0) > 0 ||
      (amountTarget?.kind === 'payment' && amountTarget.index === cardTenderIndex)),
  );
  const showPrepaidCardRefInput = Boolean(
    cardPayment && needsTransactionId(cardPayment) && cardTenderActive,
  );

  const readoutFormattedAmount =
    amountTarget?.kind === 'discount'
      ? discountType === 'percentage'
        ? `${discountValue || '0'}%`
        : currencyFmt(toStoredUnit(parseFloat(discountValue) || 0))
      : currencyFmt(toStoredUnit(parseFloat(activeAmountValue) || 0));

  const readoutStatusTone: 'settled' | 'due' | 'change' =
    change > 0 ? 'change' : totalPaymentMinor >= remainingMinor && preview ? 'settled' : 'due';

  const confirmDisabled =
    processing ||
    (!recovery &&
      (taxLoading ||
        !preview ||
        hasInvalidFixedDiscount ||
        totalPaymentMinor < remainingMinor ||
        Boolean(
          preview.discountAmount > 0 &&
          discountNeedsApprovalPin &&
          (!discountPin ||
            managerApprovers.loading ||
            managerApprovers.loadFailed ||
            managerApprovers.approvers.length === 0 ||
            !(discountApproverId ?? managerApprovers.selectedApproverId)),
        )));

  const confirmLabel = processing
    ? t('processingPayment')
    : recovery
      ? t(recovery.statusChecked ? 'retrySamePayment' : 'checkPaymentStatus')
      : taxLoading
        ? t('calculatingTax')
        : t('confirmPaymentAmount', { amount: currencyFmt(remaining) });

  const handlePrimarySubmit = () => {
    if (inFlightRef.current) return;
    if (recovery && !recovery.statusChecked && onCheckRecovery) {
      inFlightRef.current = true;
      setProcessing(true);
      void onCheckRecovery().finally(() => {
        inFlightRef.current = false;
        setProcessing(false);
      });
    } else if (recovery && lastSubmissionRef.current) {
      inFlightRef.current = true;
      setProcessing(true);
      Promise.resolve(onConfirm(...lastSubmissionRef.current))
        .then((result) => {
          if (result) setSuccess(result);
        })
        .finally(() => {
          inFlightRef.current = false;
          setProcessing(false);
        });
    } else {
      handleConfirm();
    }
  };

  return (
    <div
      ref={modalRef}
      data-testid="prepaid-checkout-modal"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-3"
    >
      <div className="flex h-[calc(100dvh-0px)] w-full flex-col overflow-hidden bg-card shadow-2xl sm:h-[min(94dvh,920px)] sm:max-w-[min(1440px,calc(100vw-24px))] sm:rounded-2xl">
        {/* Compact modal header */}
        <div className="shrink-0 border-b border-border px-4 py-2.5 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold text-foreground sm:text-lg">{t('checkout')}</h2>
              <p className="truncate text-xs capitalize text-muted-foreground">
                {t(ORDER_TYPE_SUFFIX_KEYS[cart.orderType])}
                {customer ? ` · ${customer.name}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setShowDetails((open) => {
                    const next = !open;
                    if (!next && amountTarget?.kind === 'discount') {
                      setAmountTarget({ kind: 'payment', index: 0 });
                    }
                    return next;
                  })
                }
                disabled={locked}
                aria-expanded={showDetails}
                className="touch-target rounded-lg border border-border px-3 text-sm font-medium lg:hidden"
              >
                {showDetails ? t('close') : t('items')}
              </button>
              <button
                onClick={onClose}
                disabled={locked}
                className="touch-target rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
                aria-label={t('close')}
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(280px,1fr)_minmax(310px,1.08fr)_minmax(320px,0.96fr)]">
          {/* Column 1: Contained Panel Swap (Items / Discount / Tax Details) + Pinned Totals Footer */}
          <fieldset
            disabled={locked}
            className={`${showDetails ? 'flex' : 'hidden lg:flex'} min-h-0 min-w-0 flex-col gap-2.5 border-b border-border p-3 max-lg:flex-1 max-lg:overflow-y-auto sm:p-4 lg:overflow-hidden lg:border-b-0 lg:border-e`}
          >
            <div className="flex shrink-0 items-center justify-between gap-2">
              {activeCol1Panel === 'items' ? (
                <h3 className="text-sm font-semibold text-foreground">{t('items')}</h3>
              ) : (
                <button
                  type="button"
                  onClick={() => setCol1Panel('items')}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-muted/60 px-2.5 text-xs font-semibold text-foreground hover:bg-muted"
                >
                  <span>&larr;</span>
                  <span>{tCommon('back')}</span>
                  <span className="text-muted-foreground">
                    · {activeCol1Panel === 'discount' ? t('discount') : t('tax')}
                  </span>
                </button>
              )}
              {discountModeLoaded && discountMode !== 'none' && (
                <button
                  type="button"
                  onClick={() => setDiscountOpen((open) => !open)}
                  className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                    discountOpen
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border bg-muted text-foreground hover:border-brand hover:text-brand'
                  }`}
                  aria-expanded={discountOpen}
                >
                  {preview?.discountAmount
                    ? `${t('discount')}: -${currencyFmt(preview.discountAmount)}`
                    : t('discounts')}
                  <ChevronDown
                    size={12}
                    className={`transition-transform ${discountOpen ? 'rotate-180' : ''}`}
                  />
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-3">
              {activeCol1Panel === 'discount' && discountModeLoaded && discountMode !== 'none' ? (
                <div className="space-y-2.5">
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    {isDiscountTypeAllowed(discountMode, 'percentage') && (
                      <button
                        type="button"
                        onClick={() => setDiscountType('percentage')}
                        className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-brand text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
                      >
                        <Percent size={14} />
                        {t('percentage')}
                      </button>
                    )}
                    {isDiscountTypeAllowed(discountMode, 'amount') && (
                      <button
                        type="button"
                        onClick={() => setDiscountType('amount')}
                        className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'amount' ? 'bg-brand text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
                      >
                        {t('flatAmount')}
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <span className="absolute start-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {discountType === 'percentage' ? '%' : inputCurrencyLabel}
                    </span>
                    <input
                      type="number"
                      value={discountValue}
                      onFocus={() => setAmountTarget({ kind: 'discount' })}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      placeholder={discountType === 'percentage' ? '0' : '0.00'}
                      min="0"
                      max={
                        discountType === 'percentage'
                          ? 100
                          : preview
                            ? toDisplayUnit(preview.subtotal)
                            : undefined
                      }
                      step={getDiscountInputStep(unitAdapter.maxDecimals, discountType)}
                      inputMode={discountType === 'percentage' ? 'numeric' : 'decimal'}
                      className="min-h-11 w-full rounded-lg border border-border bg-card pe-3 ps-8 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                    />
                  </div>
                  <input
                    type="text"
                    value={discountReason}
                    onChange={(e) => setDiscountReason(e.target.value)}
                    placeholder={t('discountReasonPlaceholder')}
                    className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                  />
                  {discountNeedsApprovalPin && parseFloat(discountValue) > 0 && (
                    <div className="space-y-2">
                      <ApproverSelect
                        id="prepaidDiscountApprover"
                        approvers={managerApprovers.approvers}
                        selectedApproverId={
                          discountApproverId ?? managerApprovers.selectedApproverId
                        }
                        onSelectApprover={(id) => {
                          setDiscountApproverId(id);
                          setDiscountPin('');
                        }}
                        loading={managerApprovers.loading}
                        loadFailed={managerApprovers.loadFailed}
                        disabled={locked}
                      />
                      <input
                        type="password"
                        value={discountPin}
                        onChange={(e) => setDiscountPin(e.target.value)}
                        placeholder={t('managerPin')}
                        maxLength={6}
                        className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      className="flex-1"
                      onClick={() => setCol1Panel('items')}
                    >
                      {tCommon('done')}
                    </Button>
                    {discountValue ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setDiscountValue('');
                          setDiscountReason('');
                          setDiscountPin('');
                          setDiscountApproverId(null);
                          setPaymentsTouched(false);
                          if (autoFilledSingleIndex === null) {
                            setPayments((rows) => rows.map((r) => ({ ...r, amount: '' })));
                          }
                        }}
                      >
                        {t('remove')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : activeCol1Panel === 'tax' && preview ? (
                <div className="space-y-2">
                  <TaxBreakdown
                    taxAmount={preview.taxAmount}
                    taxBreakdown={preview.taxBreakdown}
                    theme="light"
                  />
                  {preview.taxBreakdown.length > 0 ? (
                    <div className="space-y-1.5 border-t border-border pt-2 text-xs">
                      {preview.taxBreakdown.map((item, idx) => (
                        <div key={`${item.title}-${idx}`} className="flex justify-between gap-2">
                          <span className="text-muted-foreground">
                            {item.title} ({item.rate}%)
                          </span>
                          <span className="font-medium tabular-nums">
                            {currencyFmt(item.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-2">
                  {cart.items.map((item) => {
                    const online =
                      cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0;
                    const unitPrice =
                      cartLineUnitPrice(item, online) +
                      item.addons.reduce(
                        (sum, addon) => sum + Number(addon.price) * (addon.quantity || 1),
                        0,
                      );
                    return (
                      <div
                        key={item.id}
                        className="border-b border-border pb-2 text-sm last:border-b-0 last:pb-0"
                      >
                        <div className="flex justify-between gap-3 font-medium">
                          <span>
                            {item.quantity} × {item.product.name}
                            {item.variant ? ` (${item.variant.name})` : ''}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {currencyFmt(unitPrice * item.quantity)}
                          </span>
                        </div>
                        {item.quantity > 1 && (
                          <p className="text-xs text-muted-foreground">
                            {item.quantity} × {currencyFmt(unitPrice)}
                          </p>
                        )}
                        {item.addons.map((addon) => (
                          <p key={addon.id} className="text-xs text-muted-foreground">
                            + {addon.name}
                            {(addon.quantity || 1) > 1 ? ` ×${addon.quantity}` : ''}
                          </p>
                        ))}
                        {item.special_instructions && (
                          <p className="text-xs text-muted-foreground">
                            {item.special_instructions}
                          </p>
                        )}
                        {item.price_override && (
                          <p className="text-xs text-muted-foreground">
                            {tOrders('priceOverriddenMenu', {
                              price: currencyFmt(cartVariantUnitPrice(item, online)),
                            })}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {preview && (preview.charges.length > 0 || addableCharges.length > 0) && (
                    <div className="space-y-1.5 border-t border-border pt-2 text-xs">
                      {preview.charges.map((charge) => {
                        const definition = applicableCharges.find(
                          (candidate) => candidate.id === charge.id,
                        );
                        const optedIn = cart.optedInChargeIds.has(charge.id);
                        return (
                          <div
                            key={charge.id}
                            data-testid={`prepaid-charge-${charge.id}`}
                            className="flex items-center justify-between gap-2 text-muted-foreground"
                          >
                            <span className={charge.waived ? 'line-through' : undefined}>
                              {charge.name}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className={charge.waived ? 'line-through' : undefined}>
                                {currencyFmt(charge.amount)}
                              </span>
                              {definition?.is_optional && (
                                <button
                                  type="button"
                                  onClick={() => cart.toggleWaiveCharge(charge.id)}
                                  aria-pressed={charge.waived}
                                  className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:text-foreground"
                                >
                                  {charge.waived ? t('applyCharge') : t('waiveCharge')}
                                </button>
                              )}
                              {definition && !definition.is_default_active && optedIn && (
                                <button
                                  type="button"
                                  onClick={() => cart.toggleOptedInCharge(charge.id)}
                                  aria-pressed={optedIn}
                                  className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:text-foreground"
                                >
                                  {t('removeCharge')}
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                      {addableCharges.map((charge) => (
                        <div
                          key={charge.id}
                          data-testid={`prepaid-charge-${charge.id}`}
                          className="flex items-center justify-between gap-2 text-muted-foreground"
                        >
                          <span>{charge.name}</span>
                          <button
                            type="button"
                            onClick={() => cart.toggleOptedInCharge(charge.id)}
                            className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:text-foreground"
                          >
                            {t('addCharge')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Pinned Totals Footer */}
            {taxLoading || !preview ? (
              <div className="h-24 shrink-0 animate-pulse rounded-xl bg-muted" />
            ) : (
              <div
                className="shrink-0 space-y-1 rounded-xl border border-border bg-muted/20 p-2.5 text-xs tabular-nums"
                data-testid="prepaid-checkout-summary"
              >
                <div className="flex justify-between text-foreground">
                  <span>{t('itemCount', { count: cart.itemCount() })}</span>
                  <span>{currencyFmt(preview.subtotal)}</span>
                </div>
                {preview.discountAmount > 0 && (
                  <div className="flex justify-between font-medium text-emerald-600">
                    <span className="truncate">
                      {t('discount')}
                      {discountReason ? ` · ${discountReason}` : ''}
                    </span>
                    <span className="shrink-0">− {currencyFmt(preview.discountAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('subtotal')}</span>
                  <span>{currencyFmt(preview.discountedSubtotal)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setCol1Panel((panel) => (panel === 'tax' ? 'items' : 'tax'))}
                  aria-expanded={activeCol1Panel === 'tax'}
                  className="flex w-full items-center justify-between text-muted-foreground hover:text-foreground"
                >
                  <span className="inline-flex items-center gap-1">
                    <span>{t('tax')}</span>
                    {preview.taxBreakdown.length > 0 && (
                      <ChevronDown
                        size={12}
                        className={`transition-transform ${activeCol1Panel === 'tax' ? 'rotate-180' : ''}`}
                      />
                    )}
                  </span>
                  <span>{currencyFmt(preview.taxAmount)}</span>
                </button>
                {preview.packagingCharge > 0 &&
                  !preview.charges.some((charge) => charge.id === 'packaging_charge') && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t('packaging')}</span>
                      <span>{currencyFmt(preview.packagingCharge)}</span>
                    </div>
                  )}
                {preview.roundOff !== 0 && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>{t('roundOff')}</span>
                    <span>
                      {preview.roundOff > 0 ? '+' : ''}
                      {currencyFmt(preview.roundOff)}
                    </span>
                  </div>
                )}
                <div className="flex items-end justify-between border-t border-border pt-1.5 font-bold text-foreground">
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">
                    {t('total')}
                  </span>
                  <span className="text-lg leading-none">{currencyFmt(remaining)}</span>
                </div>
              </div>
            )}
          </fieldset>

          {/* Column 2: Core Tenders, Constant Card Ref Slot, Custom Tenders & Loyalty Wallet */}
          <fieldset
            disabled={locked}
            className={`${showDetails ? 'hidden lg:flex' : 'flex'} min-h-0 min-w-0 flex-col gap-2.5 border-b border-border p-3 max-lg:flex-1 max-lg:overflow-y-auto sm:p-4 lg:overflow-hidden lg:border-b-0 lg:border-e`}
          >
            {/* [2A] Hero Balance Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">
                {taxLoading || !preview ? t('calculatingTax') : t('totalDue')}
              </span>
              <span className="text-xl font-bold tabular-nums text-foreground sm:text-2xl">
                {taxLoading || !preview ? '…' : currencyFmt(remaining)}
              </span>
            </div>

            {/* [2B] Core Built-in Tenders (Cash & Card) + Fixed-Height Terminal Ref Slot */}
            <div className="shrink-0 space-y-2">
              {payments.map((payment, idx) => {
                if (payment.payment_method_id !== undefined) return null;
                const builtIn = PAYMENT_METHODS.find((method) => method.key === payment.method);
                const label = builtIn ? t(BUILT_IN_PAYMENT_KEYS[builtIn.key]) : tCommon('unknown');
                const Icon = builtIn?.icon;
                const active = (parseFloat(payment.amount) || 0) > 0;
                return (
                  <div key={payment.method} className="flex min-h-12">
                    <button
                      type="button"
                      title={label}
                      onClick={() => {
                        setAmountTarget({ kind: 'payment', index: idx });
                        if (!payment.amount) allocateRemainingTo(idx);
                      }}
                      className={`touch-target w-32 shrink-0 justify-start gap-2 rounded-s-xl border px-3 text-sm font-semibold transition-colors sm:w-36 ${active ? 'border-brand bg-brand text-white' : 'border-border bg-muted text-foreground hover:border-brand hover:text-brand'}`}
                    >
                      {Icon && <Icon size={15} />}
                      <span className="truncate">{label}</span>
                    </button>
                    <div className="flex min-w-0 flex-1 items-center rounded-e-xl border border-s-0 border-border bg-card focus-within:border-transparent focus-within:ring-2 focus-within:ring-brand">
                      <span className="ps-3 text-xs text-muted-foreground">
                        {inputCurrencyLabel}
                      </span>
                      <input
                        type="number"
                        aria-label={`${label} amount`}
                        value={payment.amount}
                        onFocus={() => setAmountTarget({ kind: 'payment', index: idx })}
                        onChange={(e) => updatePaymentAmount(idx, e.target.value)}
                        placeholder="0.00"
                        inputMode="decimal"
                        className="min-w-0 flex-1 rounded-e-xl px-2 py-2 text-end text-base font-semibold outline-none"
                        step={inputCurrencyStep}
                        min="0"
                      />
                    </div>
                  </div>
                );
              })}

              {/* Constant-height Terminal Reference Slot prevents shifts on Cash <-> Card switch */}
              <div className="flex h-11 shrink-0 items-center">
                {showPrepaidCardRefInput && cardPayment && cardTenderIndex >= 0 ? (
                  <input
                    id="prepaid-card-transaction-id"
                    type="text"
                    value={cardPayment.transaction_id ?? ''}
                    onChange={(e) => updatePaymentTransactionId(cardTenderIndex, e.target.value)}
                    placeholder={t('cardTransactionIdLabel')}
                    aria-label={t('cardTransactionIdLabel')}
                    maxLength={256}
                    autoComplete="off"
                    className="h-11 w-full rounded-xl border border-border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-brand"
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className="flex h-11 w-full items-center rounded-xl border border-dashed border-border/50 bg-muted/10 px-3 text-xs text-muted-foreground"
                  >
                    <span className="truncate opacity-60">{t('cardTransactionIdLabel')}</span>
                  </div>
                )}
              </div>
            </div>

            {/* [2C] Contained Custom Tenders & Single Fixed-Height Loyalty Wallet Card */}
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              {customMethods.length > 0 && (
                <div className="max-h-[152px] shrink-0 space-y-2 overflow-y-auto pe-0.5">
                  {payments.map((payment, idx) => {
                    if (payment.payment_method_id === undefined) return null;
                    const custom = customMethods.find(
                      (method) => method.id === payment.payment_method_id,
                    );
                    const label = custom?.name || tCommon('unknown');
                    const active = (parseFloat(payment.amount) || 0) > 0;
                    return (
                      <div key={`custom:${payment.payment_method_id}`} className="flex min-h-12">
                        <button
                          type="button"
                          title={label}
                          onClick={() => {
                            setAmountTarget({ kind: 'payment', index: idx });
                            if (!payment.amount) allocateRemainingTo(idx);
                          }}
                          className={`touch-target w-32 shrink-0 justify-start gap-2 rounded-s-xl border px-3 text-sm font-semibold transition-colors sm:w-36 ${active ? 'border-brand bg-brand text-white' : 'border-border bg-muted text-foreground hover:border-brand hover:text-brand'}`}
                        >
                          <span className="truncate">{label}</span>
                        </button>
                        <div className="flex min-w-0 flex-1 items-center rounded-e-xl border border-s-0 border-border bg-card focus-within:border-transparent focus-within:ring-2 focus-within:ring-brand">
                          <span className="ps-3 text-xs text-muted-foreground">
                            {inputCurrencyLabel}
                          </span>
                          <input
                            type="number"
                            aria-label={`${label} amount`}
                            value={payment.amount}
                            onFocus={() => setAmountTarget({ kind: 'payment', index: idx })}
                            onChange={(e) => updatePaymentAmount(idx, e.target.value)}
                            placeholder="0.00"
                            inputMode="decimal"
                            className="min-w-0 flex-1 rounded-e-xl px-2 py-2 text-end text-base font-semibold outline-none"
                            step={inputCurrencyStep}
                            min="0"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {loyaltySettings?.loyalty_enabled && customer && !walletLoadFailed && (
                <div className="flex h-[74px] shrink-0 flex-col justify-between">
                  <div className="flex min-h-12">
                    <button
                      type="button"
                      disabled={!walletBalance || walletBalance <= 0}
                      onClick={() => {
                        if (!walletBalance) return;
                        const dueMinor = remainingWalletMinor();
                        const dueDisplay = toDisplayUnit(dueMinor / minorFactor);
                        setWalletAmount(dueMinor > 0 ? formatInput(dueDisplay) : '');
                        setAutoFilledSingleIndex(null);
                        setAmountTarget({ kind: 'wallet' });
                      }}
                      className={`touch-target w-32 shrink-0 justify-start gap-2 rounded-s-xl border px-3 text-sm font-semibold sm:w-36 ${walletAmt > 0 ? 'border-brand bg-brand text-white' : 'border-border bg-muted text-foreground disabled:border-border disabled:bg-muted disabled:text-muted-foreground'}`}
                    >
                      <Wallet size={15} />
                      <span className="truncate">{t('loyaltyWallet')}</span>
                    </button>
                    <div className="flex min-w-0 flex-1 items-center rounded-e-xl border border-s-0 border-border bg-card focus-within:ring-2 focus-within:ring-brand">
                      <span className="ps-3 text-xs text-muted-foreground">
                        {inputCurrencyLabel}
                      </span>
                      <input
                        type="number"
                        value={walletAmount}
                        onFocus={() => setAmountTarget({ kind: 'wallet' })}
                        onChange={(e) => {
                          const v = e.target.value;
                          const maxWalletCurrencyStored = Math.floor(
                            (walletBalance || 0) / LOYALTY_REDEMPTION_RATE,
                          );
                          const maxDisplay = toDisplayUnit(
                            Math.min(maxWalletCurrencyStored, remaining),
                          );
                          const clamped = parseFloat(v) > maxDisplay ? formatInput(maxDisplay) : v;
                          setWalletAmount(clamped);
                          setAutoFilledSingleIndex(null);
                          setPaymentsTouched(true);
                        }}
                        placeholder="0.00"
                        disabled={!walletBalance || walletBalance <= 0}
                        inputMode="decimal"
                        className="min-w-0 flex-1 rounded-e-xl px-2 py-2 text-end text-base font-semibold outline-none disabled:bg-muted"
                        step={inputCurrencyStep}
                        min="0"
                        max={toDisplayUnit(
                          Math.min(
                            Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE),
                            remaining,
                          ),
                        )}
                      />
                    </div>
                  </div>
                  <p className="min-h-4 truncate px-1 text-end text-[11px] text-muted-foreground">
                    {walletBalance === null
                      ? '…'
                      : walletBalance > 0
                        ? t('pointsApproxValue', {
                            count: fmtNum(walletBalance),
                            value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)),
                          })
                        : t('noBalance')}
                  </p>
                </div>
              )}
            </div>
          </fieldset>

          {/* Column 3: Full-Height 4-Zone Checkout Payment Station (outer container must NOT be disabled so recovery actions stay clickable) */}
          <div className="flex min-h-0 min-w-0 flex-col bg-muted/30 p-3 max-lg:shrink-0 sm:p-4 lg:overflow-hidden">
            <CheckoutPaymentStation
              readout={{
                activeLabel: activeAmountLabel,
                amountText: readoutFormattedAmount,
                paidSummaryText:
                  taxLoading || !preview
                    ? t('calculatingTax')
                    : `${t('paid')}: ${currencyFmt(totalPaymentMinor / minorFactor)}`,
                dueSummaryText:
                  taxLoading || !preview ? '…' : `${t('total')}: ${currencyFmt(remaining)}`,
                statusPillText:
                  totalPaymentMinor >= remainingMinor && preview ? t('paid') : undefined,
                statusTone: readoutStatusTone,
              }}
              quickTenders={quickTenderOptions}
              keypad={
                <fieldset disabled={locked} className="h-full">
                  {amountTarget ? (
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
                      fillHeight
                    />
                  ) : null}
                </fieldset>
              }
              changeDisplay={{
                label: t('changeReturned'),
                formattedAmount: currencyFmt(change),
                visible: change > 0,
              }}
              statusBanner={stationStatusBanner}
            >
              <Button
                onClick={handlePrimarySubmit}
                disabled={confirmDisabled}
                className="h-11 w-full shrink-0 rounded-xl text-base font-semibold transition-colors sm:h-12"
                size="lg"
              >
                {confirmLabel}
              </Button>
            </CheckoutPaymentStation>
          </div>
        </div>
      </div>
    </div>
  );
}
