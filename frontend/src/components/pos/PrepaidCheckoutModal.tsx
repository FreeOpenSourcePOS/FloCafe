'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { X, CheckCircle2, Percent, Wallet, ChevronDown, Send, Tag, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { cartLineUnitPrice, cartVariantUnitPrice } from '@/lib/cart-price';
import { chargesForOrderType, useChargesStore } from '@/store/charges';
import { useAuthStore } from '@/store/auth';
import { useTaxPreview } from '@/hooks/use-tax-preview';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import type { Bill } from '@/lib/types';
import toast from 'react-hot-toast';
import { PAYMENT_METHODS, type CustomPaymentMethod } from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCountryByCode, getCurrencyMinorUnitFactor } from '@/lib/countries';
import {
  allowCurrencyDecimalKey,
  getDiscountInputStep,
  normalizeFixedDiscountValue,
} from '@/lib/currency-input';
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
import {
  applyPhysicalCheckoutKey,
  CHECKOUT_PRIMARY_CTA_CLASS,
  CheckoutHeaderChips,
  CheckoutQtyBadge,
  type CheckoutHeaderChipItem,
  getCardReferenceSlotClasses,
  getTenderRowClasses,
} from '@/components/pos/checkout-ui';
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
  orderCommitted?: boolean;
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
    terminal?: boolean;
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
  onRegisterDismissHandler?: (handler?: () => boolean) => void;
  onPrintBill?: (bill: Bill, reservedWindow?: Window | null) => Promise<void> | void;
  reservePrintWindow?: () => Window | null | undefined;
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

const ORDER_TYPE_KEYS = {
  dine_in: 'orderTypeDineIn',
  takeaway: 'orderTypeTakeaway',
  delivery: 'orderTypeDelivery',
  online: 'orderTypeOnline',
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
  orderCommitted = false,
  recovery = null,
  failure = null,
  onCheckRecovery,
  onRegisterDismissHandler,
  onPrintBill,
  reservePrintWindow,
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
  const [settledChangeAmount, setSettledChangeAmount] = useState(0);
  const [printingReceipt, setPrintingReceipt] = useState(false);
  const doneButtonRef = useRef<HTMLButtonElement>(null);
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
  const [lastPaymentTarget, setLastPaymentTarget] = useState<
    Exclude<AmountTarget, { kind: 'discount' } | null>
  >({
    kind: 'payment',
    index: 0,
  });
  if (
    amountTarget &&
    amountTarget.kind !== 'discount' &&
    (amountTarget.kind !== lastPaymentTarget.kind ||
      (amountTarget.kind === 'payment' &&
        lastPaymentTarget.kind === 'payment' &&
        amountTarget.index !== lastPaymentTarget.index))
  ) {
    setLastPaymentTarget(amountTarget);
  }
  const restorePaymentTarget = () => {
    setAmountTarget(lastPaymentTarget);
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

  if (discountCommitted && amountTarget?.kind === 'discount') {
    setAmountTarget({ kind: 'payment', index: 0 });
  }

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
    if (discountMode === 'none') {
      setActiveCol1Panel((panel) => (panel === 'discount' ? 'items' : panel));
      if (!committedInitialDiscountUnchanged) {
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
  }
  if (discountModeLoaded && discountMode === 'none' && activeCol1Panel === 'discount') {
    setActiveCol1Panel('items');
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
    setLastPaymentTarget({ kind: 'payment', index: 0 });
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

  const canShowDiscountPanel = discountModeLoaded && discountMode !== 'none';
  const canShowTaxPanel = Boolean(preview);
  const effectiveCol1Panel: 'items' | 'discount' | 'tax' =
    activeCol1Panel === 'discount' && canShowDiscountPanel
      ? 'discount'
      : activeCol1Panel === 'tax' && canShowTaxPanel
        ? 'tax'
        : 'items';
  const discountOpen = effectiveCol1Panel === 'discount';
  const setCol1Panel = (
    next:
      | 'items'
      | 'discount'
      | 'tax'
      | ((prev: 'items' | 'discount' | 'tax') => 'items' | 'discount' | 'tax'),
  ) => {
    const resolved = typeof next === 'function' ? next(effectiveCol1Panel) : next;
    if (resolved !== activeCol1Panel) {
      setActiveCol1Panel(resolved);
    }
    if (resolved === 'discount' && !locked && !discountCommitted && canShowDiscountPanel) {
      setAmountTarget({ kind: 'discount' });
    } else if (resolved !== 'discount' && amountTarget?.kind === 'discount') {
      restorePaymentTarget();
    }
  };
  const setDiscountOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(discountOpen) : next;
    setCol1Panel(resolved ? 'discount' : 'items');
  };

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
  const nonCashTotalMinor =
    payments
      .filter((p) => p.method !== 'cash')
      .reduce((sum, p) => sum + toMinorUnits(toStoredUnit(Number(p.amount) || 0)), 0) +
    toMinorUnits(walletAmt);
  const remainingMinor = toMinorUnits(remaining);
  const nonCashExceedsBalance = Boolean(preview) && nonCashTotalMinor > remainingMinor;

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

  const handleTenderButtonClick = (idx: number) => {
    if (locked || success) return;
    setAmountTarget({ kind: 'payment', index: idx });
    if (
      autoFilledSingleIndex !== null &&
      autoFilledSingleIndex !== idx &&
      !paymentsTouched &&
      walletAmt === 0
    ) {
      const dueMinor = Math.max(0, remainingMinor);
      const dueDisplay = toDisplayUnit(dueMinor / minorFactor);
      setAutoFilledSingleIndex(dueMinor > 0 ? idx : null);
      setPayments((rows) =>
        rows.map((row, index) => {
          if (index === idx) {
            return { ...row, amount: dueMinor > 0 ? formatInput(dueDisplay) : '' };
          }
          if (index === autoFilledSingleIndex) {
            return { ...row, amount: '', transaction_id: '' };
          }
          return row;
        }),
      );
      return;
    }
    if (!payments[idx]?.amount) {
      allocateRemainingTo(idx);
    }
  };

  const hasCash = payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);
  const change =
    !taxLoading &&
    preview &&
    !nonCashExceedsBalance &&
    hasCash &&
    totalPaymentMinor > remainingMinor
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
    if (discountCommitted) return;
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
        if (result) recordSettledSuccess(result);
      })
      .finally(() => {
        inFlightRef.current = false;
        setProcessing(false);
      });
  };

  const recordSettledSuccess = (result: PrepaidSuccess) => {
    const serverDetails = Array.isArray(result.bill.payment_details)
      ? result.bill.payment_details
      : null;
    if (
      serverDetails &&
      serverDetails.some(
        (detail) =>
          typeof detail?.change_amount === 'number' || typeof detail?.tendered_amount === 'number',
      )
    ) {
      const serverChange =
        serverDetails.reduce(
          (sum, detail) => sum + toMinorUnits(Number(detail?.change_amount) || 0),
          0,
        ) / minorFactor;
      setSettledChangeAmount(serverChange > 0 ? serverChange : 0);
      setSuccess(result);
      return;
    }
    const submitted = lastSubmissionRef.current;
    if (submitted) {
      const [splitLines, submittedWallet] = submitted;
      const cashSubmittedMinor = splitLines
        .filter((line) => line.method === 'cash' && line.payment_method_id === undefined)
        .reduce((sum, line) => sum + toMinorUnits(Number(line.amount) || 0), 0);
      const totalSubmittedMinor =
        splitLines.reduce((sum, line) => sum + toMinorUnits(Number(line.amount) || 0), 0) +
        toMinorUnits(Number(submittedWallet) || 0);
      const billTotalMinor = toMinorUnits(Number(result.bill.total) || 0);
      const computedChange =
        cashSubmittedMinor > 0 && totalSubmittedMinor > billTotalMinor
          ? (totalSubmittedMinor - billTotalMinor) / minorFactor
          : 0;
      setSettledChangeAmount(computedChange);
    } else {
      setSettledChangeAmount(change > 0 ? change : 0);
    }
    setSuccess(result);
  };

  const handlePrintCompletionReceipt = async () => {
    if (!success?.bill || printingReceipt) return;
    const reservedWindow = reservePrintWindow?.();
    setPrintingReceipt(true);
    try {
      if (onPrintBill) {
        await onPrintBill(success.bill, reservedWindow);
        return;
      }
      if (!currentTenant) {
        if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
        return;
      }
      const { usePrinterStore } = await import('@/hooks/usePrinter');
      await usePrinterStore
        .getState()
        .printBill(success.bill, currentTenant, undefined, reservedWindow);
      toast.success(tOrders('printReceipt'));
    } catch {
      toast.error(tOrders('printReceiptFailed'));
    } finally {
      setPrintingReceipt(false);
    }
  };

  const confirmDisabled =
    processing ||
    Boolean(failure?.terminal) ||
    (!recovery &&
      (taxLoading ||
        !preview ||
        hasInvalidFixedDiscount ||
        nonCashExceedsBalance ||
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
    if (inFlightRef.current || failure?.terminal) return;
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
          if (result) recordSettledSuccess(result);
        })
        .finally(() => {
          inFlightRef.current = false;
          setProcessing(false);
        });
    } else {
      handleConfirm();
    }
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
    if (success) {
      doneButtonRef.current?.focus?.();
    }
  }, [success]);

  const dismissHandlerRef = useRef<() => boolean>(() => true);
  useEffect(() => {
    dismissHandlerRef.current = () => {
      if (locked) return true;
      if (!success && (effectiveCol1Panel === 'discount' || effectiveCol1Panel === 'tax')) {
        setCol1Panel('items');
        return true;
      }
      onClose();
      return true;
    };
  });

  useEffect(() => {
    if (!onRegisterDismissHandler) return;
    onRegisterDismissHandler(() => dismissHandlerRef.current());
    return () => onRegisterDismissHandler(undefined);
  }, [onRegisterDismissHandler]);

  const keyboardActionRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  useEffect(() => {
    keyboardActionRef.current = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
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

      if (e.key === 'Escape' && !onRegisterDismissHandler) {
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        dismissHandlerRef.current();
        return;
      }

      if (isInput) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;

      if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') {
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        if (isInteractive) return;
        e.preventDefault();
        if (e.key === 'Enter') {
          if (success) {
            onClose();
            return;
          }
          if (amountTarget?.kind !== 'discount' && !confirmDisabled) {
            handlePrimarySubmit();
          }
        }
        return;
      }

      if (
        success ||
        locked ||
        failure?.terminal ||
        !amountTarget ||
        (amountTarget.kind === 'discount' && discountCommitted)
      ) {
        return;
      }
      const allowDecimal = allowCurrencyDecimalKey(
        unitAdapter.maxDecimals,
        amountTarget.kind,
        discountType,
      );
      const nextVal = applyPhysicalCheckoutKey(
        activeAmountValue,
        e.key,
        allowDecimal,
        activeAmountMax,
      );
      if (nextVal !== null) {
        e.preventDefault();
        if (isInteractive && typeof target?.blur === 'function') {
          target.blur();
        }
        updateActiveAmount(nextVal);
      }
    };
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const listener = (e: KeyboardEvent) => keyboardActionRef.current?.(e);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const handleTenderInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (
      e.key === 'Enter' &&
      !e.repeat &&
      !e.nativeEvent?.isComposing &&
      e.keyCode !== 229 &&
      amountTarget?.kind !== 'discount' &&
      !confirmDisabled
    ) {
      e.preventDefault();
      handlePrimarySubmit();
    }
  };

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
          className="w-full max-w-md space-y-4 rounded-2xl border border-emerald-500/35 bg-card p-6 text-center shadow-2xl dark:border-emerald-400/30 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
        >
          <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/12 text-emerald-600 ring-4 ring-emerald-500/10 dark:text-emerald-400">
            <CheckCircle2 size={32} />
          </div>
          <p className="text-lg font-semibold text-foreground">
            {success.pointsEarned > 0
              ? t('paymentRecordedWithPoints', { points: success.pointsEarned })
              : t('paymentRecorded')}
          </p>
          <p className="text-3xl font-bold tracking-tight tabular-nums text-foreground">
            {currencyFmt(Number(success.bill.total) || 0)}
          </p>
          <div>
            <span className="inline-flex items-center rounded-full border border-emerald-500/35 bg-emerald-500/12 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              {t('paid')}
            </span>
          </div>
          {settledChangeAmount > 0 && (
            <div
              data-testid="settled-change-banner"
              className="flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/12 px-4 py-2.5 dark:border-emerald-400/35 dark:bg-emerald-500/15"
            >
              <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                {t('changeReturned')}
              </span>
              <span className="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
                {currencyFmt(settledChangeAmount)}
              </span>
            </div>
          )}
          <div className="space-y-2 pt-1">
            <Button
              type="button"
              data-testid="completion-print-receipt-btn"
              disabled={printingReceipt}
              onClick={() => void handlePrintCompletionReceipt()}
              variant="outline"
              className="min-h-11 w-full rounded-xl bg-card font-semibold dark:border-white/12"
            >
              <Printer size={16} className="me-2" />
              {tOrders('printReceiptTitle')}
            </Button>
            {success.customer?.phone && (
              <Button
                type="button"
                onClick={() => void shareReceipt()}
                variant="outline"
                className="min-h-11 w-full rounded-xl border-emerald-500/35 bg-emerald-500/8 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
              >
                <Send size={16} className="me-2" />
                {tCommon('shareViaWhatsApp')}
              </Button>
            )}
            <Button
              ref={doneButtonRef}
              type="button"
              onClick={onClose}
              className={`min-h-11 w-full rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
            >
              {tCommon('done')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const quickTenderOptions: CheckoutQuickTenderOption[] = (() => {
    if (locked) return [];
    if (amountTarget?.kind === 'discount' && discountType === 'percentage') {
      if (discountCommitted) return [];
      return [5, 10, 15, 20].map((pct) => ({
        label: `${pct}%`,
        active: Number(discountValue) === pct,
        onClick: () => {
          if (!discountCommitted) setDiscountValue(String(pct));
        },
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
      const currentVal = payments[targetIndex]?.amount || '';
      if (payments[targetIndex].method !== 'cash') {
        if (dueMinor <= 0) return [];
        const exactDisplay = toDisplayUnit(dueMinor / minorFactor);
        const formattedInput = formatInput(exactDisplay);
        return [
          {
            label: currencyFmt(dueMinor / minorFactor),
            subLabel: t('exactAmount'),
            active: currentVal !== '' && formattedInput === currentVal,
            onClick: () => allocateRemainingTo(targetIndex),
          },
        ];
      }
      const displayAmounts = computeQuickCashDisplayAmounts({
        remainingMinor: dueMinor,
        minorFactor,
        unitAdapter,
      });
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
    if (!taxLoading && preview) {
      if (nonCashExceedsBalance) {
        return {
          tone: 'warning',
          message: t('paymentAboveBalance'),
        };
      }
      if (totalPaymentMinor === 0 && remainingMinor > 0) {
        return {
          tone: 'idle-due',
          message: `${t('balanceDue')}: ${currencyFmt(remaining)}`,
        };
      }
      if (totalPaymentMinor < remainingMinor) {
        return {
          tone: 'idle-due',
          partial: true,
          message: `${t('balanceDue')}: ${currencyFmt((remainingMinor - totalPaymentMinor) / minorFactor)}`,
        };
      }
      if (change > 0 && !nonCashExceedsBalance) {
        return {
          tone: 'idle-ready',
          message: `${t('totalDue')}: ${currencyFmt(remaining)}`,
        };
      }
      if (!nonCashExceedsBalance && totalPaymentMinor === remainingMinor) {
        return {
          tone: 'idle-ready',
          message: `${t('totalDue')}: ${currencyFmt(remaining)} - ${t('exactAmount')}`,
        };
      }
      return {
        tone: 'idle-due',
        message: `${t('balanceDue')}: ${currencyFmt(remaining)}`,
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

  const readoutStatusTone: 'ready' | 'due' | 'partial' | 'change' = nonCashExceedsBalance
    ? 'due'
    : change > 0 && !nonCashExceedsBalance
      ? 'change'
      : !nonCashExceedsBalance && totalPaymentMinor === remainingMinor && Boolean(preview)
        ? 'ready'
        : totalPaymentMinor > 0
          ? 'partial'
          : 'due';

  const readoutStatusPillText =
    !preview || nonCashExceedsBalance
      ? undefined
      : change > 0 && !nonCashExceedsBalance
        ? `${t('changeReturned')}: ${currencyFmt(change)}`
        : !nonCashExceedsBalance && totalPaymentMinor === remainingMinor
          ? t('exactAmount')
          : undefined;

  const headerChips: CheckoutHeaderChipItem[] = [
    { key: 'type', label: t(ORDER_TYPE_KEYS[cart.orderType]), variant: 'brand' },
    ...(cart.orderType === 'online' && cart.onlinePlatform?.trim()
      ? [{ key: 'platform', label: cart.onlinePlatform.trim(), variant: 'neutral' as const }]
      : []),
    ...(customer?.name
      ? [{ key: 'customer', label: customer.name, variant: 'customer' as const }]
      : []),
  ];

  return (
    <div
      ref={modalRef}
      data-testid="prepaid-checkout-modal"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-3"
    >
      <div className="flex h-[calc(100dvh-0px)] w-full flex-col overflow-hidden border-border bg-background shadow-2xl sm:h-[min(94dvh,920px)] sm:max-w-[min(1440px,calc(100vw-24px))] sm:rounded-2xl sm:border dark:border-white/12">
        {/* Compact modal header */}
        <div className="shrink-0 border-b border-border bg-card/85 px-4 py-2.5 sm:px-5 [@media(max-height:660px)]:py-1.5 dark:bg-card/55">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="shrink-0 text-base font-bold tracking-tight text-foreground sm:text-lg">
                {t('checkout')}
              </h2>
              <CheckoutHeaderChips chips={headerChips} />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const next = !showDetails;
                  setShowDetails(next);
                  if (!next && amountTarget?.kind === 'discount') {
                    restorePaymentTarget();
                  }
                }}
                disabled={locked}
                aria-expanded={showDetails}
                className="touch-target rounded-lg border border-border bg-card px-3 text-sm font-medium transition-colors hover:bg-muted lg:hidden dark:border-white/10"
              >
                {showDetails ? t('close') : t('items')}
              </button>
              <button
                onClick={onClose}
                disabled={locked}
                className="touch-target rounded-full border border-border/70 bg-muted/70 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground active:scale-[0.98] dark:border-white/10"
                aria-label={t('close')}
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(280px,1fr)_minmax(310px,1.08fr)_minmax(320px,0.96fr)] lg:overflow-hidden">
          {/* Column 1: Contained Panel Swap (Items / Discount / Tax Details) + Pinned Totals Footer */}
          <fieldset
            disabled={locked}
            className={`${showDetails ? 'flex' : 'hidden lg:flex'} max-lg:min-h-[168px] min-w-0 flex-col gap-2.5 border-b border-border bg-card/35 p-3 max-lg:flex-1 max-lg:overflow-y-auto sm:p-4 lg:min-h-0 lg:overflow-hidden lg:border-b-0 lg:border-e dark:bg-card/20`}
          >
            <div className="flex shrink-0 items-center justify-between gap-2">
              {effectiveCol1Panel === 'items' ? (
                <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <span>{t('items')}</span>
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border/80 bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground dark:border-white/10">
                    {fmtNum(cart.items.length)}
                  </span>
                </h3>
              ) : (
                <button
                  type="button"
                  onClick={() => setCol1Panel('items')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs font-semibold text-foreground shadow-2xs transition-colors hover:border-brand/40 hover:bg-muted/60 dark:border-white/10"
                >
                  <span className="rtl-flip">&larr;</span>
                  <span>{tCommon('back')}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {effectiveCol1Panel === 'discount' ? t('discount') : t('tax')}
                  </span>
                </button>
              )}
              {canShowDiscountPanel && (
                <button
                  type="button"
                  onClick={() => setDiscountOpen((open) => !open)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors ${
                    discountOpen
                      ? 'border-brand bg-brand-light text-brand shadow-2xs dark:border-indigo-400/50 dark:bg-[var(--color-brand-light)] dark:text-indigo-300'
                      : preview?.discountAmount
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:border-emerald-500/60 dark:text-emerald-300'
                        : 'border-border bg-card text-foreground shadow-2xs hover:border-brand/45 hover:text-brand dark:border-white/10 dark:hover:text-indigo-300'
                  }`}
                  aria-expanded={discountOpen}
                >
                  <Tag className="size-3.5 shrink-0" />
                  <span>
                    {preview?.discountAmount
                      ? `${t('discount')}: -${currencyFmt(preview.discountAmount)}`
                      : t('discounts')}
                  </span>
                  <ChevronDown
                    size={12}
                    className={`transition-transform ${discountOpen ? 'rotate-180' : ''}`}
                  />
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-3 shadow-2xs dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              {effectiveCol1Panel === 'discount' ? (
                <div className="space-y-2.5">
                  <div className="flex gap-1 rounded-xl border border-border/80 bg-muted/60 p-1 dark:border-white/10 dark:bg-muted/35">
                    {isDiscountTypeAllowed(discountMode, 'percentage') && (
                      <button
                        type="button"
                        disabled={locked || discountCommitted}
                        onClick={() => {
                          if (!locked && !discountCommitted) setDiscountType('percentage');
                        }}
                        className={`touch-target flex-1 gap-1.5 rounded-lg text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm ${
                          discountType === 'percentage'
                            ? 'bg-brand text-white shadow-xs'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <Percent size={14} />
                        {t('percentage')}
                      </button>
                    )}
                    {isDiscountTypeAllowed(discountMode, 'amount') && (
                      <button
                        type="button"
                        disabled={locked || discountCommitted}
                        onClick={() => {
                          if (!locked && !discountCommitted) setDiscountType('amount');
                        }}
                        className={`touch-target flex-1 gap-1.5 rounded-lg text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm ${
                          discountType === 'amount'
                            ? 'bg-brand text-white shadow-xs'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {t('flatAmount')}
                      </button>
                    )}
                  </div>
                  <div
                    className={`flex min-h-11 items-center rounded-xl border pe-3 transition-colors ${
                      locked || discountCommitted ? 'cursor-not-allowed bg-muted' : 'bg-card'
                    } ${
                      amountTarget?.kind === 'discount'
                        ? 'border-brand ring-2 ring-brand/20'
                        : 'border-border focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20 dark:border-white/10'
                    }`}
                  >
                    <span className="shrink-0 ps-3 pe-2 text-sm font-semibold text-brand dark:text-indigo-300">
                      {discountType === 'percentage' ? '%' : inputCurrencyLabel}
                    </span>
                    <input
                      type="number"
                      value={discountValue}
                      disabled={locked || discountCommitted}
                      onFocus={() => {
                        if (!locked && !discountCommitted) setAmountTarget({ kind: 'discount' });
                      }}
                      onChange={(e) => {
                        if (!locked && !discountCommitted) setDiscountValue(e.target.value);
                      }}
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
                      className="min-w-0 flex-1 bg-transparent py-2 text-base font-bold tabular-nums text-foreground outline-none disabled:cursor-not-allowed"
                    />
                  </div>
                  <input
                    type="text"
                    value={discountReason}
                    disabled={locked || discountCommitted}
                    onChange={(e) => {
                      if (!locked && !discountCommitted) setDiscountReason(e.target.value);
                    }}
                    placeholder={t('discountReasonPlaceholder')}
                    className="min-h-11 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:bg-muted dark:border-white/10"
                  />
                  {discountNeedsApprovalPin && parseFloat(discountValue) > 0 && (
                    <div className="space-y-2 rounded-xl border border-amber-500/35 bg-amber-500/8 p-2.5 dark:border-amber-400/30 dark:bg-amber-500/10">
                      <ApproverSelect
                        id="prepaidDiscountApprover"
                        approvers={managerApprovers.approvers}
                        selectedApproverId={
                          discountApproverId ?? managerApprovers.selectedApproverId
                        }
                        onSelectApprover={(id) => {
                          if (!locked && !discountCommitted) {
                            setDiscountApproverId(id);
                            setDiscountPin('');
                          }
                        }}
                        loading={managerApprovers.loading}
                        loadFailed={managerApprovers.loadFailed}
                        disabled={locked || discountCommitted}
                      />
                      <input
                        type="password"
                        value={discountPin}
                        disabled={locked || discountCommitted}
                        onChange={(e) => {
                          if (!locked && !discountCommitted) setDiscountPin(e.target.value);
                        }}
                        placeholder={t('managerPin')}
                        maxLength={6}
                        className="min-h-11 w-full rounded-lg border border-amber-500/40 bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 disabled:cursor-not-allowed disabled:bg-muted"
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      className={`min-h-11 flex-1 rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                      onClick={() => setCol1Panel('items')}
                    >
                      {tCommon('done')}
                    </Button>
                    {discountValue ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 rounded-xl"
                        disabled={locked || discountCommitted}
                        onClick={() => {
                          if (locked || discountCommitted) return;
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
              ) : effectiveCol1Panel === 'tax' && preview ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
                    <span>{t('tax')}</span>
                    <span className="tabular-nums">{currencyFmt(preview.taxAmount)}</span>
                  </div>
                  {preview.taxBreakdown.length > 0 ? (
                    <div className="space-y-1.5 border-t border-border pt-2 text-xs tabular-nums dark:border-white/10">
                      {preview.taxBreakdown.map((item, idx) => (
                        <div key={`${item.title}-${idx}`} className="flex justify-between gap-2">
                          <span className="text-muted-foreground">
                            {item.title} ({item.rate}%)
                          </span>
                          <span className="font-medium text-foreground">
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
                        className="border-b border-border/75 pb-2 text-sm last:border-b-0 last:pb-0 dark:border-white/8"
                      >
                        <div className="flex items-start justify-between gap-2.5">
                          <div className="flex min-w-0 items-start gap-2">
                            <CheckoutQtyBadge>{fmtNum(item.quantity)}</CheckoutQtyBadge>
                            <span className="min-w-0 font-semibold leading-snug text-foreground">
                              {item.product.name}
                              {item.variant ? ` (${item.variant.name})` : ''}
                            </span>
                          </div>
                          <span className="shrink-0 font-semibold tabular-nums text-foreground">
                            {currencyFmt(unitPrice * item.quantity)}
                          </span>
                        </div>
                        {(item.quantity > 1 ||
                          item.addons.length > 0 ||
                          Boolean(item.special_instructions) ||
                          Boolean(item.price_override)) && (
                          <div className="space-y-0.5 ps-7 pt-0.5">
                            {item.quantity > 1 && (
                              <p className="text-xs tabular-nums text-muted-foreground">
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
                              <p className="text-xs italic text-muted-foreground">
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
                        )}
                      </div>
                    );
                  })}
                  {preview && (preview.charges.length > 0 || addableCharges.length > 0) && (
                    <div className="space-y-1.5 border-t border-border pt-2 text-xs tabular-nums dark:border-white/10">
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
                            <span className={charge.waived ? 'line-through opacity-70' : undefined}>
                              {charge.name}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span
                                className={`font-medium text-foreground ${charge.waived ? 'line-through opacity-60' : ''}`}
                              >
                                {currencyFmt(charge.amount)}
                              </span>
                              {definition?.is_optional && (
                                <button
                                  type="button"
                                  disabled={locked || orderCommitted}
                                  onClick={() => {
                                    if (!locked && !orderCommitted) {
                                      cart.toggleWaiveCharge(charge.id);
                                    }
                                  }}
                                  aria-pressed={charge.waived}
                                  className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-semibold text-brand transition-colors hover:border-brand/40 hover:bg-brand-light/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-indigo-300"
                                >
                                  {charge.waived ? t('applyCharge') : t('waiveCharge')}
                                </button>
                              )}
                              {definition && !definition.is_default_active && optedIn && (
                                <button
                                  type="button"
                                  disabled={locked || orderCommitted}
                                  onClick={() => {
                                    if (!locked && !orderCommitted) {
                                      cart.toggleOptedInCharge(charge.id);
                                    }
                                  }}
                                  aria-pressed={optedIn}
                                  className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10"
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
                            disabled={locked || orderCommitted}
                            onClick={() => {
                              if (!locked && !orderCommitted) {
                                cart.toggleOptedInCharge(charge.id);
                              }
                            }}
                            className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-semibold text-brand transition-colors hover:border-brand/40 hover:bg-brand-light/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-indigo-300"
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
                className="shrink-0 space-y-1 rounded-xl border border-border bg-muted/35 p-3 text-xs tabular-nums dark:border-white/10 dark:bg-muted/20"
                data-testid="prepaid-checkout-summary"
              >
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('itemCount', { count: cart.itemCount() })}</span>
                  <span className="font-medium text-foreground">
                    {currencyFmt(preview.subtotal)}
                  </span>
                </div>
                {preview.discountAmount > 0 && (
                  <div className="flex justify-between font-semibold text-emerald-600 dark:text-emerald-400">
                    <span className="truncate">
                      {t('discount')}
                      {discountReason ? ` - ${discountReason}` : ''}
                    </span>
                    <span className="shrink-0">− {currencyFmt(preview.discountAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('subtotal')}</span>
                  <span className="font-medium text-foreground">
                    {currencyFmt(preview.discountedSubtotal)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setCol1Panel((panel) => (panel === 'tax' ? 'items' : 'tax'))}
                  aria-expanded={effectiveCol1Panel === 'tax'}
                  className="flex w-full items-center justify-between text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span className="inline-flex items-center gap-1">
                    <span>{t('tax')}</span>
                    {preview.taxBreakdown.length > 0 && (
                      <ChevronDown
                        size={12}
                        className={`transition-transform ${effectiveCol1Panel === 'tax' ? 'rotate-180' : ''}`}
                      />
                    )}
                  </span>
                  <span className="font-medium text-foreground">
                    {currencyFmt(preview.taxAmount)}
                  </span>
                </button>
                {preview.packagingCharge > 0 &&
                  !preview.charges.some((charge) => charge.id === 'packaging_charge') && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t('packaging')}</span>
                      <span className="font-medium text-foreground">
                        {currencyFmt(preview.packagingCharge)}
                      </span>
                    </div>
                  )}
                {preview.roundOff !== 0 && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>{t('roundOff')}</span>
                    <span className="font-medium text-foreground">
                      {preview.roundOff > 0 ? '+' : ''}
                      {currencyFmt(preview.roundOff)}
                    </span>
                  </div>
                )}
                <div className="flex items-baseline justify-between border-t border-border/80 pt-2 font-bold text-foreground dark:border-white/10">
                  <span className="text-sm font-bold text-foreground">{t('total')}</span>
                  <span className="text-lg font-bold leading-none tabular-nums">
                    {currencyFmt(remaining)}
                  </span>
                </div>
              </div>
            )}
          </fieldset>

          {/* Column 2: Core Tenders, Constant Card Ref Slot, Custom Tenders & Loyalty Wallet */}
          <fieldset
            disabled={locked}
            className={`${showDetails ? 'hidden lg:flex' : 'flex'} max-lg:min-h-[168px] min-w-0 flex-col gap-2.5 border-b border-border bg-muted/20 p-3 max-lg:flex-1 max-lg:overflow-y-auto sm:p-4 [@media(max-height:660px)]:p-2 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-e dark:bg-background/45`}
          >
            {/* [2A] Hero Balance Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-2xs dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <span className="text-xs font-semibold text-muted-foreground">
                {taxLoading || !preview ? t('calculatingTax') : t('totalDue')}
              </span>
              <span className="text-xl font-bold tracking-tight tabular-nums text-foreground sm:text-2xl">
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
                const isFocused = amountTarget?.kind === 'payment' && amountTarget.index === idx;
                const isAllocated = (parseFloat(payment.amount) || 0) > 0;
                const rowClasses = getTenderRowClasses({
                  isFocused,
                  isAllocated,
                  disabled: locked,
                });
                return (
                  <div key={payment.method} className="flex min-h-12">
                    <button
                      type="button"
                      title={label}
                      onClick={() => handleTenderButtonClick(idx)}
                      className={`touch-target w-32 shrink-0 justify-start gap-2 rounded-s-xl border px-3 text-sm font-semibold transition-colors sm:w-36 ${rowClasses.buttonClass}`}
                    >
                      {Icon && <Icon size={15} />}
                      <span className="truncate">{label}</span>
                    </button>
                    <div
                      className={`flex min-w-0 flex-1 items-center rounded-e-xl border border-s-0 transition-colors ${rowClasses.inputBoxClass}`}
                    >
                      <span className={`ps-3 text-xs ${rowClasses.currencyClass}`}>
                        {inputCurrencyLabel}
                      </span>
                      <input
                        type="number"
                        aria-label={`${label} amount`}
                        value={payment.amount}
                        onFocus={() => setAmountTarget({ kind: 'payment', index: idx })}
                        onChange={(e) => updatePaymentAmount(idx, e.target.value)}
                        onKeyDown={handleTenderInputKeyDown}
                        placeholder="0.00"
                        inputMode="decimal"
                        className={`min-w-0 flex-1 rounded-e-xl bg-transparent px-2.5 py-2 text-end text-base tabular-nums outline-none ${rowClasses.inputClass}`}
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
                    onKeyDown={handleTenderInputKeyDown}
                    placeholder={t('cardTransactionIdLabel')}
                    aria-label={t('cardTransactionIdLabel')}
                    maxLength={256}
                    autoComplete="off"
                    className={`h-11 w-full rounded-xl border px-3 text-sm outline-none transition-colors ${getCardReferenceSlotClasses(
                      {
                        isActive: true,
                        isMissingRequired: Boolean(
                          (parseFloat(cardPayment.amount) || 0) > 0 &&
                          !cardPayment.transaction_id?.trim(),
                        ),
                      },
                    )}`}
                  />
                ) : (
                  <div
                    aria-hidden="true"
                    className={`flex h-11 w-full items-center rounded-xl border px-3 text-xs transition-colors ${getCardReferenceSlotClasses(
                      {
                        isActive: false,
                        isMissingRequired: false,
                      },
                    )}`}
                  >
                    <span className="truncate">{t('cardTransactionIdLabel')}</span>
                  </div>
                )}
              </div>
            </div>

            {/* [2C] Contained Custom Tenders & Single Fixed-Height Loyalty Wallet Card */}
            <div className="flex flex-col gap-2 max-lg:shrink-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {customMethods.length > 0 && (
                <div className="max-h-[152px] shrink-0 space-y-2 overflow-y-auto pe-0.5">
                  {payments.map((payment, idx) => {
                    if (payment.payment_method_id === undefined) return null;
                    const custom = customMethods.find(
                      (method) => method.id === payment.payment_method_id,
                    );
                    const label = custom?.name || tCommon('unknown');
                    const isFocused =
                      amountTarget?.kind === 'payment' && amountTarget.index === idx;
                    const isAllocated = (parseFloat(payment.amount) || 0) > 0;
                    const rowClasses = getTenderRowClasses({
                      isFocused,
                      isAllocated,
                      disabled: locked,
                    });
                    return (
                      <div key={`custom:${payment.payment_method_id}`} className="flex min-h-12">
                        <button
                          type="button"
                          title={label}
                          onClick={() => handleTenderButtonClick(idx)}
                          className={`touch-target w-32 shrink-0 justify-start gap-2 rounded-s-xl border px-3 text-sm font-semibold transition-colors sm:w-36 ${rowClasses.buttonClass}`}
                        >
                          <span className="truncate">{label}</span>
                        </button>
                        <div
                          className={`flex min-w-0 flex-1 items-center rounded-e-xl border border-s-0 transition-colors ${rowClasses.inputBoxClass}`}
                        >
                          <span className={`ps-3 text-xs ${rowClasses.currencyClass}`}>
                            {inputCurrencyLabel}
                          </span>
                          <input
                            type="number"
                            aria-label={`${label} amount`}
                            value={payment.amount}
                            onFocus={() => setAmountTarget({ kind: 'payment', index: idx })}
                            onChange={(e) => updatePaymentAmount(idx, e.target.value)}
                            onKeyDown={handleTenderInputKeyDown}
                            placeholder="0.00"
                            inputMode="decimal"
                            className={`min-w-0 flex-1 rounded-e-xl bg-transparent px-2.5 py-2 text-end text-base tabular-nums outline-none ${rowClasses.inputClass}`}
                            step={inputCurrencyStep}
                            min="0"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {loyaltySettings?.loyalty_enabled &&
                customer &&
                !walletLoadFailed &&
                (() => {
                  const walletDisabled = locked || !walletBalance || walletBalance <= 0;
                  const walletClasses = getTenderRowClasses({
                    isFocused: amountTarget?.kind === 'wallet',
                    isAllocated: walletAmt > 0,
                    disabled: walletDisabled,
                  });
                  return (
                    <div className="flex h-[74px] shrink-0 flex-col justify-between">
                      <div className="flex min-h-12">
                        <button
                          type="button"
                          disabled={walletDisabled}
                          onClick={() => {
                            if (!walletBalance) return;
                            const dueMinor = remainingWalletMinor();
                            const dueDisplay = toDisplayUnit(dueMinor / minorFactor);
                            setWalletAmount(dueMinor > 0 ? formatInput(dueDisplay) : '');
                            setAutoFilledSingleIndex(null);
                            setAmountTarget({ kind: 'wallet' });
                          }}
                          className={`touch-target w-32 shrink-0 justify-start gap-2 rounded-s-xl border px-3 text-sm font-semibold transition-colors sm:w-36 ${walletClasses.buttonClass}`}
                        >
                          <Wallet size={15} />
                          <span className="truncate">{t('loyaltyWallet')}</span>
                        </button>
                        <div
                          className={`flex min-w-0 flex-1 items-center rounded-e-xl border border-s-0 transition-colors ${walletClasses.inputBoxClass}`}
                        >
                          <span className={`ps-3 text-xs ${walletClasses.currencyClass}`}>
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
                              const clamped =
                                parseFloat(v) > maxDisplay ? formatInput(maxDisplay) : v;
                              setWalletAmount(clamped);
                              setAutoFilledSingleIndex(null);
                              setPaymentsTouched(true);
                            }}
                            placeholder="0.00"
                            disabled={walletDisabled}
                            inputMode="decimal"
                            className={`min-w-0 flex-1 rounded-e-xl bg-transparent px-2.5 py-2 text-end text-base tabular-nums outline-none ${walletClasses.inputClass}`}
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
                      <p className="min-h-4 truncate px-1 text-end text-[11px] font-medium text-muted-foreground">
                        {walletBalance === null
                          ? '…'
                          : walletBalance > 0
                            ? t('pointsApproxValue', {
                                count: fmtNum(walletBalance),
                                value: currencyFmt(
                                  Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE),
                                ),
                              })
                            : t('noBalance')}
                      </p>
                    </div>
                  );
                })()}
            </div>
          </fieldset>

          {/* Column 3: Full-Height 4-Zone Checkout Payment Station (outer container must NOT be disabled so recovery actions stay clickable) */}
          <div className="flex min-h-0 min-w-0 flex-col bg-muted/30 p-3 max-lg:shrink-0 sm:p-4 [@media(max-height:660px)]:p-2 lg:overflow-y-auto dark:bg-card/25">
            <CheckoutPaymentStation
              readout={{
                activeLabel: activeAmountLabel,
                amountText: readoutFormattedAmount,
                paidSummaryText:
                  taxLoading || !preview
                    ? t('calculatingTax')
                    : `${t('payment')}: ${currencyFmt(totalPaymentMinor / minorFactor)}`,
                dueSummaryText:
                  taxLoading || !preview ? '…' : `${t('total')}: ${currencyFmt(remaining)}`,
                statusPillText: readoutStatusPillText,
                statusTone: readoutStatusTone,
                isDiscountTarget: amountTarget?.kind === 'discount',
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
                className={`h-11 w-full shrink-0 rounded-xl text-base font-semibold transition-colors sm:h-12 [@media(max-height:660px)]:h-11 ${CHECKOUT_PRIMARY_CTA_CLASS}`}
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
