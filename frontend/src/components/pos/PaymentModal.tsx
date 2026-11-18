'use client';

import { classifyTransportFailure } from '@/lib/transport-failure';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Wallet,
  CheckCircle2,
  User,
  Percent,
  Send,
  ChevronDown,
  Users,
  Minus,
  Plus,
  Printer,
  ShieldAlert,
  Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import api, {
  captureClientOperationFailure,
  createOperationReference,
  operationHeaders,
} from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill, Order } from '@/lib/types';
import {
  SplitCheckModal,
  MIN_CHECKS as MIN_EQUAL_SHARE_PAYERS,
  MAX_CHECKS as MAX_EQUAL_SHARE_PAYERS,
} from '@/components/pos/SplitCheckModal';
import { resolveTaxComponents } from '@/lib/printer/tax-components';
import { useCartStore } from '@/store/cart';
import { useConfirm } from '@/hooks/use-confirm';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
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
  CHECKOUT_PRIMARY_CTA_CLASS,
  CheckoutHeaderChips,
  CheckoutQtyBadge,
  type CheckoutHeaderChipItem,
  applyPhysicalCheckoutKey,
  getCardReferenceSlotClasses,
  getTenderRowClasses,
} from '@/components/pos/checkout-ui';
import { useWhatsAppReady } from '@/hooks/useWhatsAppReady';
import { sendBillViaFlo, shareBillViaWhatsApp } from '@/lib/whatsapp-share';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { hasRole, ROLE_ACCESS } from '@shared/role-permissions';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
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
import {
  classifyOrderRequestFailure,
  clearPostpaidPaymentAttempt,
  getPostpaidPaymentAttemptStorageKey,
  loadPostpaidPaymentAttempt,
  savePostpaidPaymentAttempt,
  type OperationFailureMetadata,
} from '@/lib/order-attempt';
import { isScheduledOrderEditLocked } from '@/lib/order-payment-state';
import { ApproverSelect } from '@/components/ApproverSelect';
import { useManagerApprovers } from '@/hooks/useManagerApprovers';

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
  onRegisterDismissHandler?: (handler: (() => boolean) | undefined) => void;
  onPrintBill?: (bill: Bill, reservedWindow?: Window | null) => Promise<void> | void;
  reservePrintWindow?: () => Window | null | undefined;
}

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

// One equal share written into a tender row, and the balance and payer count it
// was sized from so a later change can withdraw it.
type AppliedEqualShare = {
  index: number;
  amountMinor: number;
  amountInput: string;
  balanceMinor: number;
  payers: number;
};

// One payment request frozen at submission. The backend hashes the bill, the
// payment lines and the customer, so a retry that changes any of them conflicts
// with the key already recorded for a committed attempt.
type PendingPaymentAttempt = {
  billId: string | number;
  key: string;
  operationId: string | null;
  zeroBalance: boolean;
  lines: {
    method: string;
    amount: number | null;
    payment_method_id?: number;
    transaction_id?: string;
  }[];
  customerId: string | number | null;
  balanceAtSubmit?: number;
};

function getSessionStorageSafe() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function readRestoredPostpaidAttempt(bill: Bill, storageKey: string): PendingPaymentAttempt | null {
  const stored = loadPostpaidPaymentAttempt(getSessionStorageSafe(), storageKey);
  if (
    !stored ||
    String(stored.billId) !== String(bill.id) ||
    Number(bill.balance) <= 0 ||
    bill.payment_status === 'paid'
  ) {
    return null;
  }
  const candidate = stored as unknown as Partial<PendingPaymentAttempt>;
  if (!candidate.key || !Array.isArray(candidate.lines)) return null;
  const savedBalance =
    typeof candidate.balanceAtSubmit === 'number' && Number.isFinite(candidate.balanceAtSubmit)
      ? candidate.balanceAtSubmit
      : Number(bill.balance);
  return {
    billId: bill.id,
    key: candidate.key,
    operationId: candidate.operationId ?? null,
    zeroBalance: Boolean(candidate.zeroBalance),
    lines: candidate.lines,
    customerId: candidate.customerId ?? null,
    ...(Number.isFinite(savedBalance) && savedBalance > 0 ? { balanceAtSubmit: savedBalance } : {}),
  };
}

// Must match the conflict thrown by main/routes/bills.ts for a reused key.
const IDEMPOTENCY_CONFLICT_ERROR =
  'Idempotency-Key was already used for a different payment request';

// Loyalty points are 1:1 with currency units. Must match LOYALTY_REDEMPTION_RATE in main/routes/bills.ts.
const LOYALTY_REDEMPTION_RATE = 1;

type PosKey = keyof AppConfig['Messages']['pos'];

// Built-in payment method label keys mapped to typed `pos` leaf keys.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const satisfies Record<'cash' | 'card', PosKey>;

const ORDER_TYPE_KEYS = {
  dine_in: 'orderTypeDineIn',
  takeaway: 'orderTypeTakeaway',
  delivery: 'orderTypeDelivery',
  online: 'orderTypeOnline',
} as const satisfies Record<Order['type'], PosKey>;

export default function PaymentModal({
  bill,
  initialOverridePin,
  onClose,
  onPaid,
  onBillUpdate,
  onSplit,
  onRegisterDismissHandler,
  onPrintBill,
  reservePrintWindow,
}: Props) {
  const remaining = Number(bill.balance);
  const cartCustomerId = useCartStore((s) => s.customerId);
  const selectedCustomer = useCartStore((s) => s.customer);
  const effectiveCustomerId = bill.customer_id || cartCustomerId || null;
  const { confirm, ConfirmDialog, isConfirmOpen } = useConfirm();
  const t = useTranslations('pos');
  const tExpenses = useTranslations('expenses');
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
  const { currentTenant, user } = useAuthStore();
  const isWhatsAppReady = useWhatsAppReady();
  const unitAdapter = useCurrencyUnitAdapter();
  const {
    toDisplay: toDisplayUnit,
    toStored: toStoredUnit,
    label: inputCurrencyLabel,
    step: inputCurrencyStep,
    formatInput,
  } = unitAdapter;
  const currencyCode =
    currentTenant?.currency ||
    (currentTenant?.country ? getCountryByCode(currentTenant.country)?.currency : undefined) ||
    'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currencyCode);
  const toMinorUnits = (amount: number) => Math.round(amount * minorFactor);
  const remainingMinor = toMinorUnits(remaining);

  const buildAttemptPaymentRows = (
    attempt: PendingPaymentAttempt | null,
    methods: CustomPaymentMethod[],
  ): Payment[] => [
    ...PAYMENT_METHODS.map((method) => {
      const matched = attempt?.lines.find(
        (line) => line.method === method.key && line.payment_method_id === undefined,
      );
      return {
        method: method.key,
        amount:
          matched && Number(matched.amount) > 0
            ? formatInput(toDisplayUnit(Number(matched.amount)))
            : '',
        ...(matched?.transaction_id ? { transaction_id: matched.transaction_id } : {}),
      };
    }),
    ...methods.map((method) => {
      const matched = attempt?.lines.find(
        (line) => line.method === 'custom' && line.payment_method_id === method.id,
      );
      return {
        method: 'custom' as const,
        payment_method_id: method.id,
        amount:
          matched && Number(matched.amount) > 0
            ? formatInput(toDisplayUnit(Number(matched.amount)))
            : '',
      };
    }),
  ];
  const walletInputFromAttempt = (attempt: PendingPaymentAttempt | null): string => {
    const walletLine = attempt?.lines.find((line) => line.method === 'wallet');
    return walletLine && Number(walletLine.amount) > 0
      ? formatInput(toDisplayUnit(Number(walletLine.amount)))
      : '';
  };
  const targetFromAttempt = (
    attempt: PendingPaymentAttempt | null,
    rows: Payment[],
  ): AmountTarget => {
    if (!attempt) return { kind: 'payment', index: 0 };
    const firstRowIndex = rows.findIndex((row) => (parseFloat(row.amount) || 0) > 0);
    if (firstRowIndex >= 0) return { kind: 'payment', index: firstRowIndex };
    if (attempt.lines.some((line) => line.method === 'wallet' && Number(line.amount) > 0)) {
      return { kind: 'wallet' };
    }
    return { kind: 'payment', index: 0 };
  };

  // An attempt whose outcome is unknown keeps its key and its exact request:
  // its retry must replay the same bill, lines and customer, so the draft that
  // produced it stays frozen until the outcome is known.
  const postpaidAttemptKey = getPostpaidPaymentAttemptStorageKey(
    String(user?.id ?? 'anonymous'),
    currentTenant?.id ?? 'default',
    String(bill.id),
  );
  const [pendingAttempt, setPendingAttempt] = useState<PendingPaymentAttempt | null>(() =>
    readRestoredPostpaidAttempt(bill, postpaidAttemptKey),
  );
  const pendingAttemptRef = useRef<PendingPaymentAttempt | null>(null);
  const [paymentOutcomeUnknown, setPaymentOutcomeUnknown] = useState(() =>
    Boolean(readRestoredPostpaidAttempt(bill, postpaidAttemptKey)),
  );

  const [justPaid, setJustPaid] = useState(false);
  const [paidAmount, setPaidAmount] = useState<number | null>(null);
  const [paidChangeAmount, setPaidChangeAmount] = useState(0);
  const [settledBill, setSettledBill] = useState<Bill | null>(null);
  const [printingReceipt, setPrintingReceipt] = useState(false);
  const [sendingWa, setSendingWa] = useState(false);
  const [pointsEarned, setPointsEarned] = useState(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const [payments, setPayments] = useState<Payment[]>(buildAttemptPaymentRows(pendingAttempt, []));
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(Boolean(pendingAttempt));
  const [autoFilledSingleIndex, setAutoFilledSingleIndex] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletAmount, setWalletAmount] = useState(walletInputFromAttempt(pendingAttempt));
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);
  const managerApprovers = useManagerApprovers();
  const [cardTransactionIdRequired, setCardTransactionIdRequired] = useState(false);
  const [kitchenOverrideRequired, setKitchenOverrideRequired] = useState(
    Boolean(initialOverridePin),
  );
  const [kitchenOverridePin, setKitchenOverridePin] = useState(initialOverridePin || '');
  const [kitchenApproverId, setKitchenApproverId] = useState<string | null>(null);
  const [kitchenUndeliveredCount, setKitchenUndeliveredCount] = useState(0);
  const [kitchenUndeliveredItems, setKitchenUndeliveredItems] = useState<string[]>([]);
  const [kitchenDeliveryError, setKitchenDeliveryError] = useState('');
  const [requestFailure, setRequestFailure] = useState<{
    message: string;
    nextStep: string;
    details: Pick<
      OperationFailureMetadata,
      'operation' | 'stage' | 'outcome' | 'reasonCode' | 'correlationId'
    >;
    status: number | null;
  } | null>(null);

  // Column 1 panel state (contained panel swap above pinned totals footer)
  const [activeCol1Panel, setActiveCol1Panel] = useState<
    'items' | 'discount' | 'tax' | 'kitchen-override'
  >(() => (initialOverridePin ? 'kitchen-override' : 'items'));
  const [discountType, setDiscountType] = useState<DiscountType>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');
  const [discountApproverId, setDiscountApproverId] = useState<string | null>(null);
  const [applyingDiscount, setApplyingDiscount] = useState(false);
  const [loyaltySettings, setLoyaltySettings] = useState<{ loyalty_enabled: boolean } | null>(null);
  const [amountTarget, setAmountTarget] = useState<AmountTarget>(
    targetFromAttempt(pendingAttempt, payments),
  );
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
    if (lastPaymentTarget.kind === 'wallet') {
      setAmountTarget({ kind: 'wallet' });
      return;
    }
    setAmountTarget({
      kind: 'payment',
      index: payments[lastPaymentTarget.index] ? lastPaymentTarget.index : 0,
    });
  };
  const [showDetails, setShowDetails] = useState(Boolean(initialOverridePin));
  const [billDetails, setBillDetails] = useState<{
    id: number;
    order: Order | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get(`/bills/${bill.id}`)
      .then(({ data }) => {
        if (!cancelled)
          setBillDetails({ id: bill.id, order: data?.bill?.order ?? null, failed: false });
      })
      .catch(() => {
        if (!cancelled) setBillDetails({ id: bill.id, order: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [bill.id]);
  const detailOrder = billDetails?.id === bill.id ? billDetails.order : null;
  const contextOrder = detailOrder ?? bill.order;
  const isOrderCancelled = contextOrder?.status === 'cancelled';
  const billTerminal =
    bill.payment_status === 'refunded' ||
    bill.payment_status === 'partially_refunded' ||
    isOrderCancelled;
  const isBillPaid = bill.payment_status === 'paid' && remainingMinor <= 0;
  const billReadOnly = billTerminal || isBillPaid;
  const orderCustomer = detailOrder?.customer ?? bill.order?.customer;
  const cartCustomer = effectiveCustomerId
    ? String(orderCustomer?.id) === String(effectiveCustomerId)
      ? orderCustomer
      : String(selectedCustomer?.id) === String(effectiveCustomerId)
        ? selectedCustomer
        : null
    : (orderCustomer ?? selectedCustomer);

  // An attempt only locks the bill it was made for; another check inherits
  // nothing from it.
  const attemptLocked = pendingAttempt !== null && pendingAttempt.billId === bill.id;
  const inFlightRef = useRef(false);
  const lockAttempt = (attempt: PendingPaymentAttempt | null) => {
    pendingAttemptRef.current = attempt;
    setPendingAttempt(attempt);
    const storage = getSessionStorageSafe();
    if (attempt) {
      savePostpaidPaymentAttempt(storage, postpaidAttemptKey, {
        ...(attempt as unknown as Record<string, unknown>),
        userId: String(user?.id ?? 'anonymous'),
        storeId: currentTenant?.id ?? 'default',
        billId: String(attempt.billId),
        idempotencyKey: attempt.key,
        paymentFingerprint: JSON.stringify(attempt.lines),
      });
    } else {
      clearPostpaidPaymentAttempt(storage, postpaidAttemptKey);
    }
  };
  useEffect(() => {
    pendingAttemptRef.current = pendingAttempt;
  }, [pendingAttempt]);
  useEffect(() => {
    inFlightRef.current = false;
  }, [bill.id]);

  const charges = useChargesStore((s) => s.charges);
  const loadCharges = useChargesStore((s) => s.load);
  const [updatingChargeId, setUpdatingChargeId] = useState<string | null>(null);
  const [chargeApprovalId, setChargeApprovalId] = useState<string | null>(null);
  const [chargeApprovalPin, setChargeApprovalPin] = useState('');
  const [chargeApproverId, setChargeApproverId] = useState<string | null>(null);
  const [splitChecksEnabled, setSplitChecksEnabled] = useState(false);
  const [splitCheckOrder, setSplitCheckOrder] = useState<Order | null>(null);
  const [openingSplitCheck, setOpeningSplitCheck] = useState(false);
  const [splitCheckSaving, setSplitCheckSaving] = useState(false);
  /** Explicit availability state for the feature setting lookup. */
  const [splitSettingState, setSplitSettingState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [splitSettingDenied, setSplitSettingDenied] = useState(false);
  /** Reason the fresh bill lookup refused to open the allocator. */
  const [splitOpenReason, setSplitOpenReason] = useState<SplitReasonKey | null>(null);
  const [splitCheckBill, setSplitCheckBill] = useState<Bill | null>(null);
  const [chargeStateUncertain, setChargeStateUncertain] = useState(false);
  const [splitSectionCollapsed, setSplitSectionCollapsed] = useState(false);
  const [showEqualShare, setShowEqualShare] = useState(false);
  // Session-only remaining payer count: reopening the dialog asks again rather
  // than remembering who has paid.
  const [equalSharePayers, setEqualSharePayers] = useState(() =>
    String(
      Math.min(
        MAX_EQUAL_SHARE_PAYERS,
        Math.max(MIN_EQUAL_SHARE_PAYERS, Number(bill.order?.guest_count) || MIN_EQUAL_SHARE_PAYERS),
      ),
    ),
  );
  const [equalShareNotice, setEqualShareNotice] = useState<'lastPayer' | 'invalidated' | null>(
    null,
  );
  const [appliedEqualShare, setAppliedEqualShare] = useState<AppliedEqualShare | null>(null);
  useEffect(() => {
    void loadCharges();
  }, [loadCharges]);

  const appliedCharges: AppliedCharge[] = parseAppliedCharges(bill.charges_breakdown);
  const applicableCharges = chargesForOrderType(charges, bill.order?.type || '');
  const scheduledOrderEditLocked = isScheduledOrderEditLocked(bill.order, [bill]);
  const canShowDiscountPanel =
    !bill.split_group_id && !scheduledOrderEditLocked && discountMode !== 'none';
  const effectiveCol1Panel: 'items' | 'discount' | 'tax' | 'kitchen-override' =
    activeCol1Panel === 'kitchen-override' && kitchenOverrideRequired
      ? 'kitchen-override'
      : activeCol1Panel === 'discount' && canShowDiscountPanel
        ? 'discount'
        : activeCol1Panel === 'tax'
          ? 'tax'
          : 'items';
  const showDiscount = effectiveCol1Panel === 'discount';
  const setCol1Panel = (
    next:
      | 'items'
      | 'discount'
      | 'tax'
      | 'kitchen-override'
      | ((
          prev: 'items' | 'discount' | 'tax' | 'kitchen-override',
        ) => 'items' | 'discount' | 'tax' | 'kitchen-override'),
  ) => {
    const resolved = typeof next === 'function' ? next(effectiveCol1Panel) : next;
    if (resolved !== activeCol1Panel) {
      setActiveCol1Panel(resolved);
    }
    if (
      resolved === 'discount' &&
      !attemptLocked &&
      !justPaid &&
      !billReadOnly &&
      canShowDiscountPanel
    ) {
      setAmountTarget({ kind: 'discount' });
    } else if (resolved !== 'discount' && amountTarget?.kind === 'discount') {
      restorePaymentTarget();
    }
  };
  const setShowDiscount = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(showDiscount) : next;
    setCol1Panel(resolved ? 'discount' : 'items');
  };
  // The backend rejects a waiver on a split check (its charges are already
  // allocated) and on a settled bill, so the toggle is not offered there.
  const canToggleCharges =
    !bill.split_group_id &&
    !scheduledOrderEditLocked &&
    !billReadOnly &&
    bill.payment_status !== 'paid' &&
    Number(bill.paid_amount || 0) === 0;
  const canReadBills = tenantCan(currentTenant, 'bills.read');
  const canGenerateBill = tenantCan(currentTenant, 'bills.generate');
  const splitCheckItems = (bill.order?.items || []).filter(
    (item) => !['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(item.status),
  );
  // Split checks divide an untouched dine-in bill into separately payable
  // checks; the backend refuses anything else (POST /bills/:id/split-check).
  // Reasons are deterministic and visible as text, so the section explains the
  // state instead of silently hiding a usable control.
  type SplitReasonKey =
    | 'splitCheckPermissionRequired'
    | 'splitCheckResolvePaymentFirst'
    | 'splitCheckBeforePaymentOnly'
    | 'splitCheckDineInOnly'
    | 'splitCheckWholeUnitsOnly'
    | 'splitCheckTwoUnitsRequired'
    | 'splitCheckFailed';
  type SplitEligibilityResult =
    | { open: true }
    | { unknown: true }
    | { cancelled: true }
    | { reason: SplitReasonKey };
  const splitEligibility: SplitEligibilityResult = (() => {
    // 1. Reading eligibility and generating an allocation are both configured
    //    permissions; both are explained the same way.
    if (!canReadBills || !canGenerateBill)
      return { reason: 'splitCheckPermissionRequired' } as const;
    // 2. An in-flight or unresolved payment operation must be resolved first.
    if (attemptLocked || paymentOutcomeUnknown || processing) {
      return { reason: 'splitCheckResolvePaymentFirst' } as const;
    }
    if (isOrderCancelled) {
      return { cancelled: true } as const;
    }
    // 3. Only an untouched unpaid check is divisible.
    if (
      billTerminal ||
      bill.payment_status !== 'unpaid' ||
      Number(bill.paid_amount || 0) > 0 ||
      Boolean(bill.payment_details)
    ) {
      return { reason: 'splitCheckBeforePaymentOnly' } as const;
    }
    // 4. The authoritative projection must be dine-in.
    if (bill.order?.type !== undefined && bill.order?.type !== 'dine_in') {
      return { reason: 'splitCheckDineInOnly' } as const;
    }
    // 5.-6. Eligible units are positive safe integers totalling at least two.
    if (splitCheckItems.length > 0) {
      if (
        !splitCheckItems.every(
          (item) => Number.isSafeInteger(Number(item.quantity)) && Number(item.quantity) > 0,
        )
      ) {
        return { reason: 'splitCheckWholeUnitsOnly' } as const;
      }
      const units = splitCheckItems.reduce((total, item) => total + Number(item.quantity), 0);
      if (units < 2) return { reason: 'splitCheckTwoUnitsRequired' } as const;
    }
    // 7. A projection without item lines is resolved by an explicit fresh
    //    check, not a definite verdict.
    if (splitCheckItems.length === 0) return { unknown: true } as const;
    return { open: true } as const;
  })();
  const canEditCharges =
    tenantCan(currentTenant, 'bills.discount.apply') &&
    canToggleCharges &&
    !justPaid &&
    !processing &&
    !applyingDiscount &&
    // A split lookup that would freeze the bill's totals excludes charge edits.
    !openingSplitCheck &&
    !chargeStateUncertain &&
    !attemptLocked;
  const addableCharges = applicableCharges.filter(
    (charge) =>
      !charge.is_default_active && !appliedCharges.some((applied) => applied.id === charge.id),
  );

  const updateCharge = async (
    chargeId: string,
    change: { waived?: boolean; applied?: boolean },
    approval?: { override_pin: string; approver_id: string },
  ) => {
    if (!canEditCharges || processing || applyingDiscount || updatingChargeId || openingSplitCheck)
      return;
    setUpdatingChargeId(chargeId);
    setChargeStateUncertain(true);
    const operationId = createOperationReference();
    try {
      const { data } = await api.patch(
        `/bills/${bill.id}/charges`,
        { charge_id: chargeId, ...change, ...approval },
        { headers: operationHeaders(operationId) },
      );
      if (!data.bill) throw new Error('Bill charge update returned no bill');
      if (onBillUpdate) onBillUpdate({ ...bill, ...data.bill, order: bill.order });
      setChargeStateUncertain(false);
    } catch (error: unknown) {
      const failure = classifyOrderRequestFailure(error, {
        operation: 'bill.charge.update',
        correlationId: operationId || '',
      });
      const chargeMessages: Record<string, string> = {
        charge_required: t('chargeRequired'),
        bill_not_found: t('chargeBillNotFound'),
        split_check: t('chargeSplitCheck'),
        bill_paid: t('chargeBillPaid'),
        bill_refunded: t('chargeBillRefunded'),
        order_not_found: t('chargeOrderNotFound'),
        order_cancelled: t('chargeOrderCancelled'),
        charge_unavailable: t('chargeUnavailable'),
        order_type_unsupported: t('chargeOrderTypeUnsupported'),
        change_required: t('chargeChangeRequired'),
        invalid_change_type: t('chargeInvalidChangeType'),
        charge_not_waivable: t('chargeNotWaivable'),
        charge_always_applied: t('chargeAlwaysApplied'),
      };
      if (failure.trusted && failure.outcome === 'not_applied') {
        setChargeStateUncertain(false);
        setRequestFailure({
          message: failure.displayCode
            ? chargeMessages[failure.displayCode] || t('operationNotSaved')
            : t('operationNotSaved'),
          nextStep: t('operationCorrectAndRetry'),
          details: {
            operation: 'bill.charge.update',
            stage: failure.stage || 'validation',
            outcome: 'not_applied',
            reasonCode: failure.reasonCode,
            correlationId: failure.correlationId,
          },
          status: failure.status,
        });
        return;
      }

      try {
        const { data } = await api.get(`/bills/${bill.id}`, {
          headers: operationHeaders(operationId),
        });
        if (!data?.bill) throw new Error('Bill status unavailable');
        onBillUpdate?.({ ...bill, ...data.bill, order: bill.order });
        setChargeStateUncertain(!failure.trusted || failure.outcome === 'unknown');
        setRequestFailure({
          message:
            failure.trusted && failure.outcome === 'applied'
              ? t('chargeCompletionApplied')
              : t('operationOutcomeUnknown'),
          nextStep: t('operationCheckBeforeRetry'),
          details: {
            operation: 'bill.charge.update',
            stage: failure.trusted ? failure.stage || 'recovery' : 'recovery',
            outcome: failure.trusted ? failure.outcome || 'unknown' : 'unknown',
            reasonCode: failure.reasonCode,
            correlationId: failure.correlationId || operationId,
          },
          status: failure.status,
        });
      } catch {
        toast.error(t('chargeUpdateFailed'));
        setRequestFailure({
          message:
            failure.trusted && failure.outcome === 'applied'
              ? t('chargeCompletionApplied')
              : t('operationOutcomeUnknown'),
          nextStep: t('operationCheckBeforeRetry'),
          details: {
            operation: 'bill.charge.update',
            stage: failure.trusted ? failure.stage || 'recovery' : 'recovery',
            outcome: failure.trusted ? failure.outcome || 'unknown' : 'unknown',
            reasonCode: failure.reasonCode,
            correlationId: failure.correlationId || operationId,
          },
          status: failure.status,
        });
      }
    } finally {
      setUpdatingChargeId(null);
    }
  };

  // Sync state with active bill discount during render before paint
  // to prevent flashing stale values.
  const [syncedBill, setSyncedBill] = useState(bill);
  const [syncedRemaining, setSyncedRemaining] = useState(remaining);
  const billIdChanged = bill !== syncedBill && bill.id !== syncedBill.id;
  if (bill !== syncedBill) {
    setSyncedBill(bill);
    if (billIdChanged) {
      const restored = readRestoredPostpaidAttempt(bill, postpaidAttemptKey);
      const restoredRows = buildAttemptPaymentRows(restored, customMethods);
      setPendingAttempt(restored);
      setSyncedRemaining(remaining);
      setPayments(restoredRows);
      setPaymentsTouched(Boolean(restored));
      setAutoFilledSingleIndex(null);
      setWalletAmount(walletInputFromAttempt(restored));
      setAmountTarget(targetFromAttempt(restored, restoredRows));
      setAppliedEqualShare(null);
      setShowEqualShare(false);
      setEqualShareNotice(null);
      setEqualSharePayers(
        String(
          Math.min(
            MAX_EQUAL_SHARE_PAYERS,
            Math.max(
              MIN_EQUAL_SHARE_PAYERS,
              Number(bill.order?.guest_count) || MIN_EQUAL_SHARE_PAYERS,
            ),
          ),
        ),
      );
      setSplitCheckOrder(null);
      setSplitCheckBill(null);
      setSplitOpenReason(null);
      setSplitSectionCollapsed(false);
      setKitchenOverrideRequired(false);
      setKitchenOverridePin('');
      setKitchenApproverId(null);
      setKitchenUndeliveredCount(0);
      setKitchenUndeliveredItems([]);
      setKitchenDeliveryError('');
      setRequestFailure(null);
      setPaymentOutcomeUnknown(Boolean(restored));
      setJustPaid(false);
      setPaidAmount(null);
      setPaidChangeAmount(0);
      setSettledBill(null);
      setPointsEarned(0);
      setLastPaymentTarget({ kind: 'payment', index: 0 });
      setDiscountPin('');
      setDiscountApproverId(null);
      setShowDetails(false);
      setChargeStateUncertain(false);
      setUpdatingChargeId(null);
      setChargeApprovalId(null);
      setChargeApprovalPin('');
      setChargeApproverId(null);
      setActiveCol1Panel('items');
    }
    if (bill && Number(bill.discount_amount) > 0) {
      const nextType =
        bill.discount_type === 'percentage' || bill.discount_type === 'amount'
          ? bill.discount_type
          : defaultDiscountTypeForMode(discountMode);
      setDiscountType(
        isDiscountTypeAllowed(discountMode, nextType)
          ? nextType
          : defaultDiscountTypeForMode(discountMode),
      );
      setDiscountValue(
        String(
          nextType === 'amount'
            ? toDisplayUnit(Number(bill.discount_value || 0))
            : bill.discount_value || '',
        ),
      );
      setDiscountReason(bill.discount_reason || '');
      if (bill.id !== syncedBill.id) {
        setShowDiscount(false);
      }
    } else if (billIdChanged || Number(syncedBill.discount_amount) > 0) {
      setDiscountType('percentage');
      setDiscountValue('');
      setDiscountReason('');
      if (!billIdChanged && activeCol1Panel === 'discount') {
        setShowDiscount(false);
      }
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
      setActiveCol1Panel((panel) => (panel === 'discount' ? 'items' : panel));
      setAmountTarget((target) =>
        target?.kind === 'discount' ? { kind: 'payment', index: 0 } : target,
      );
    }
  }

  if (discountMode !== 'none' && !isDiscountTypeAllowed(discountMode, discountType)) {
    setDiscountType(defaultDiscountTypeForMode(discountMode));
    setDiscountValue('');
    setDiscountReason('');
    setDiscountPin('');
    setAmountTarget((target) =>
      target?.kind === 'discount' ? { kind: 'payment', index: 0 } : target,
    );
  }

  if (
    (activeCol1Panel === 'discount' && !canShowDiscountPanel) ||
    (activeCol1Panel === 'kitchen-override' && !kitchenOverrideRequired)
  ) {
    setActiveCol1Panel('items');
    if (amountTarget?.kind === 'discount') {
      restorePaymentTarget();
    }
  }

  // Proportionally update payment inputs when remaining balance changes,
  // unless cashier has already edited inputs manually.
  if (!billIdChanged && !attemptLocked && remaining !== syncedRemaining) {
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

  const loadSplitCheckSetting = useCallback(() => {
    setSplitSettingState('loading');
    api
      .get('/settings/split_checks_enabled')
      .then((res) => {
        setSplitChecksEnabled(res.data?.setting?.value === 'true');
        setSplitSettingDenied(false);
        setSplitSettingState('ready');
      })
      .catch((error) => {
        // A failed lookup is not a disabled feature: it is a state the user can
        // retry, and a denied `settings.view` is explained, not hidden.
        const status = (error as { response?: { status?: unknown } })?.response?.status;
        setSplitSettingDenied(status === 403);
        setSplitChecksEnabled(false);
        setSplitSettingState('error');
      });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => loadSplitCheckSetting(), 0);
    return () => clearTimeout(timer);
  }, [loadSplitCheckSetting]);

  const paymentMethodsEffectRef = useRef({ billId: bill.id, formatInput, toDisplayUnit });
  useEffect(() => {
    paymentMethodsEffectRef.current = { billId: bill.id, formatInput, toDisplayUnit };
  }, [bill.id, formatInput, toDisplayUnit]);

  useEffect(() => {
    const custId = bill.customer_id || cartCustomerId;
    if (custId) {
      api
        .get(`/customers/${custId}/wallet`)
        .then((res) => {
          setWalletBalance(Number(res.data.balance) || 0);
        })
        .catch(() => setWalletBalance(0));
    }
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
      .catch(() => {});
    api
      .get('/settings/card_transaction_id_required')
      .then((res) => setCardTransactionIdRequired(res.data?.setting?.value === 'true'))
      .catch(() => {});
    api
      .get('/payment-methods')
      .then((res) => {
        const methods: CustomPaymentMethod[] = res.data.payment_methods || [];
        setCustomMethods(methods);
        const {
          billId: currentBillId,
          formatInput: formatCurrentInput,
          toDisplayUnit: toCurrentDisplayUnit,
        } = paymentMethodsEffectRef.current;
        const lockedAttempt =
          pendingAttemptRef.current && pendingAttemptRef.current.billId === currentBillId
            ? pendingAttemptRef.current
            : null;
        setPayments((current) => [
          ...PAYMENT_METHODS.map(
            (method) =>
              current.find(
                (row) => row.method === method.key && row.payment_method_id === undefined,
              ) || { method: method.key, amount: '' },
          ),
          ...methods.map((method) => {
            const existing = current.find((row) => row.payment_method_id === method.id);
            if (existing) return existing;
            const matched = lockedAttempt?.lines.find(
              (line) => line.method === 'custom' && line.payment_method_id === method.id,
            );
            return {
              method: 'custom',
              payment_method_id: method.id,
              amount:
                matched && Number(matched.amount) > 0
                  ? formatCurrentInput(toCurrentDisplayUnit(Number(matched.amount)))
                  : '',
            };
          }),
        ]);
        if (lockedAttempt) {
          const firstCustomLine = lockedAttempt.lines.find(
            (line) => line.method === 'custom' && Number(line.amount) > 0,
          );
          const matchedCustomIdx = firstCustomLine
            ? methods.findIndex((m) => m.id === firstCustomLine.payment_method_id)
            : -1;
          if (matchedCustomIdx >= 0) {
            setAmountTarget((prev) =>
              prev?.kind === 'payment' && prev.index === 0
                ? { kind: 'payment', index: PAYMENT_METHODS.length + matchedCustomIdx }
                : prev,
            );
          }
        }
      })
      .catch(() => setCustomMethods([]));
  }, [bill.customer_id, cartCustomerId]);

  const walletAmt = toStoredUnit(parseFloat(walletAmount) || 0);
  const attemptTotalMinor = (attempt: PendingPaymentAttempt) =>
    attempt.lines.reduce((sum, line) => sum + toMinorUnits(Number(line.amount) || 0), 0);
  const attemptNonCashMinor = (attempt: PendingPaymentAttempt) =>
    attempt.lines
      .filter((line) => line.method !== 'cash')
      .reduce((sum, line) => sum + toMinorUnits(Number(line.amount) || 0), 0);
  const lockedAttemptTotalMinor =
    attemptLocked && pendingAttempt ? attemptTotalMinor(pendingAttempt) : null;
  const lockedAttemptNonCashMinor =
    attemptLocked && pendingAttempt ? attemptNonCashMinor(pendingAttempt) : null;
  const totalPaymentMinor =
    lockedAttemptTotalMinor ??
    payments.reduce((s, p) => s + toMinorUnits(toStoredUnit(parseFloat(p.amount) || 0)), 0) +
      toMinorUnits(walletAmt);
  const nonCashTotalMinor =
    lockedAttemptNonCashMinor ??
    payments
      .filter((p) => p.method !== 'cash')
      .reduce((sum, p) => sum + toMinorUnits(toStoredUnit(Number(p.amount) || 0)), 0) +
      toMinorUnits(walletAmt);
  const totalPayment = totalPaymentMinor / minorFactor;
  const nonCashExceedsBalance = nonCashTotalMinor > remainingMinor;

  // Equal shares divide the remaining authoritative balance in the tenant's
  // smallest unit, so no share is created or lost to rounding.
  const equalShareCount = /^\d+$/.test(equalSharePayers.trim())
    ? Number(equalSharePayers.trim())
    : 0;
  const equalShareCountInRange =
    equalShareCount >= MIN_EQUAL_SHARE_PAYERS && equalShareCount <= MAX_EQUAL_SHARE_PAYERS;
  const equalShareShares =
    equalShareCountInRange && equalShareCount <= remainingMinor
      ? allocateEqualShares(remainingMinor, equalShareCount)
      : [];
  const equalShareError = equalShareCountInRange
    ? equalShareCount > remainingMinor
      ? 'tooManyPayers'
      : null
    : 'invalidCount';
  const equalShareSharesDiffer =
    equalShareShares.length > 1 &&
    equalShareShares[0] !== equalShareShares[equalShareShares.length - 1];
  const hasSplitChecksPanel =
    splitSettingState === 'error' || (splitSettingState === 'ready' && splitChecksEnabled);
  const canDecrementEqualShare =
    !processing &&
    !attemptLocked &&
    !justPaid &&
    !billReadOnly &&
    !(equalSharePayers.trim() !== '' && Number(equalSharePayers) <= MIN_EQUAL_SHARE_PAYERS);
  const canIncrementEqualShare =
    !processing &&
    !attemptLocked &&
    !justPaid &&
    !billReadOnly &&
    !(equalSharePayers.trim() !== '' && Number(equalSharePayers) >= MAX_EQUAL_SHARE_PAYERS);
  const stepEqualSharePayers = (delta: -1 | 1) => {
    if (processing || attemptLocked || justPaid || billReadOnly) return;
    const trimmed = equalSharePayers.trim();
    const parsed = Number(trimmed);
    if (!trimmed || !Number.isFinite(parsed)) {
      setEqualSharePayers(String(MIN_EQUAL_SHARE_PAYERS));
      return;
    }
    const next =
      delta < 0
        ? Math.max(MIN_EQUAL_SHARE_PAYERS, Math.min(MAX_EQUAL_SHARE_PAYERS, Math.ceil(parsed) - 1))
        : Math.min(
            MAX_EQUAL_SHARE_PAYERS,
            Math.max(MIN_EQUAL_SHARE_PAYERS, Math.floor(parsed) + 1),
          );
    setEqualSharePayers(String(next));
  };
  const minorToStored = (minor: number) => minor / minorFactor;
  const equalShareConflict =
    walletAmt > 0 || payments.filter((row) => (parseFloat(row.amount) || 0) > 0).length > 1;

  const tenderLabel = (payment: Payment) => {
    const builtIn = PAYMENT_METHODS.find(
      (method) => method.key === payment.method && payment.payment_method_id === undefined,
    );
    const custom = customMethods.find((method) => method.id === payment.payment_method_id);
    return builtIn ? t(BUILT_IN_PAYMENT_KEYS[builtIn.key]) : custom?.name || tCommon('unknown');
  };

  const equalShareStateRef = useRef({
    billId: bill.id,
    remainingMinor,
    equalShareCount,
    payments,
    walletAmount,
    processing,
    attemptLocked,
  });
  useEffect(() => {
    equalShareStateRef.current = {
      billId: bill.id,
      remainingMinor,
      equalShareCount,
      payments,
      walletAmount,
      processing,
      attemptLocked,
    };
  }, [bill.id, remainingMinor, equalShareCount, payments, walletAmount, processing, attemptLocked]);

  const applyEqualShare = async (index: number) => {
    const shareMinor = equalShareShares[0];
    if (processing || attemptLocked || justPaid || billReadOnly || shareMinor === undefined) return;
    const amountInput = String(toDisplayUnit(minorToStored(shareMinor)));
    const replacing = payments.filter(
      (row, rowIndex) =>
        (parseFloat(row.amount) || 0) > 0 &&
        (rowIndex !== index || (paymentsTouched && row.amount !== amountInput)),
    );
    const needsConfirmation = replacing.length > 0 || walletAmt > 0;
    if (needsConfirmation) {
      const entries = replacing.map(
        (row) => `${tenderLabel(row)}: ${currencyFmt(toStoredUnit(Number(row.amount)))}`,
      );
      if (walletAmt > 0) entries.push(`${t('loyaltyWallet')}: ${currencyFmt(walletAmt)}`);
      const snapshot = equalShareStateRef.current;
      const accepted = await confirm(`${t('equalShareConflicts')}\n${entries.join('\n')}`, {
        confirmLabel: tCommon('clear'),
      });
      const current = equalShareStateRef.current;
      if (
        !accepted ||
        current.billId !== snapshot.billId ||
        current.remainingMinor !== snapshot.remainingMinor ||
        current.equalShareCount !== snapshot.equalShareCount ||
        current.payments !== snapshot.payments ||
        current.walletAmount !== snapshot.walletAmount ||
        current.processing ||
        current.attemptLocked
      )
        return;
    }
    setAutoFilledSingleIndex(null);
    setPaymentsTouched(true);
    setPayments((rows) =>
      rows.map((row, rowIndex) => {
        if (rowIndex === index)
          return {
            ...row,
            amount: amountInput,
            ...(needsConfirmation ? { transaction_id: '' } : {}),
          };
        return needsConfirmation && (parseFloat(row.amount) || 0) > 0
          ? { ...row, amount: '', transaction_id: '' }
          : row;
      }),
    );
    if (needsConfirmation) setWalletAmount('');
    setAmountTarget({ kind: 'payment', index });
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
    setPayments((rows) =>
      rows.map((row, index) =>
        index === applied.index && row.amount === applied.amountInput
          ? { ...row, amount: '', transaction_id: '' }
          : row,
      ),
    );
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
  if (
    !billIdChanged &&
    appliedEqualShare &&
    (appliedEqualShare.balanceMinor !== remainingMinor ||
      appliedEqualShare.payers !== equalShareCount) &&
    !(
      attemptLocked &&
      pendingAttempt &&
      attemptTotalMinor(pendingAttempt) === appliedEqualShare.amountMinor
    )
  ) {
    setAppliedEqualShare(null);
    setEqualShareNotice('invalidated');
    setPayments((rows) =>
      rows.map((row, index) =>
        index === appliedEqualShare.index && row.amount === appliedEqualShare.amountInput
          ? { ...row, amount: '' }
          : row,
      ),
    );
  }

  const updatePaymentAmount = (idx: number, value: string) => {
    if (attemptLocked || justPaid || billReadOnly) return;
    setPaymentsTouched(true);
    setAutoFilledSingleIndex(null);
    setAppliedEqualShare((current) => (current?.index === idx ? null : current));
    setPayments((current) =>
      current.map((payment, index) => (index === idx ? { ...payment, amount: value } : payment)),
    );
  };

  const updatePaymentTransactionId = (idx: number, value: string) => {
    if (attemptLocked || justPaid || billReadOnly) return;
    setPayments((current) =>
      current.map((payment, index) =>
        index === idx ? { ...payment, transaction_id: value } : payment,
      ),
    );
  };

  const needsTransactionId = (payment: Payment) =>
    cardTransactionIdRequired &&
    payment.method === 'card' &&
    payment.payment_method_id === undefined;

  const allocateRemainingTo = (idx: number) => {
    if (attemptLocked || justPaid || billReadOnly) return;
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
    setAppliedEqualShare(null);
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
    if (attemptLocked || justPaid || billReadOnly) return;
    setAmountTarget({ kind: 'payment', index: idx });
    if (
      autoFilledSingleIndex !== null &&
      autoFilledSingleIndex !== idx &&
      !paymentsTouched &&
      walletAmt === 0
    ) {
      const dueMinor = Math.max(0, remainingMinor);
      const dueDisplay = toDisplayUnit(dueMinor / minorFactor);
      setAppliedEqualShare(null);
      setAutoFilledSingleIndex(dueMinor > 0 ? idx : null);
      setPaymentsTouched(false);
      setPayments((current) =>
        current.map((payment, index) =>
          index === idx
            ? { ...payment, amount: dueMinor > 0 ? formatInput(dueDisplay) : '' }
            : { ...payment, amount: '', transaction_id: '' },
        ),
      );
      return;
    }
    if (!payments[idx]?.amount) {
      allocateRemainingTo(idx);
    }
  };

  const activeAmountLabel =
    amountTarget?.kind === 'discount'
      ? t('discount')
      : amountTarget?.kind === 'wallet'
        ? t('loyaltyWallet')
        : amountTarget?.kind === 'payment' && payments[amountTarget.index]
          ? tenderLabel(payments[amountTarget.index])
          : t('payment');

  const rawActiveAmountValue =
    amountTarget?.kind === 'payment'
      ? payments[amountTarget.index]?.amount || ''
      : amountTarget?.kind === 'wallet'
        ? walletAmount
        : amountTarget?.kind === 'discount'
          ? discountValue
          : '';
  const activeAmountValue =
    attemptLocked && pendingAttempt && !(parseFloat(rawActiveAmountValue) > 0) && totalPayment > 0
      ? formatInput(toDisplayUnit(totalPayment))
      : rawActiveAmountValue;

  const updateActiveAmount = (value: string) => {
    if (!amountTarget || attemptLocked || justPaid || billReadOnly) return;
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
        : toDisplayUnit(Number(bill.subtotal))
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

  const hasCash =
    attemptLocked && pendingAttempt
      ? pendingAttempt.lines.some(
          (line) => line.method === 'cash' && (Number(line.amount) || 0) > 0,
        )
      : payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);

  const change =
    !nonCashExceedsBalance && hasCash && totalPaymentMinor > remainingMinor
      ? (totalPaymentMinor - remainingMinor) / minorFactor
      : 0;

  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();

  const handleApplyDiscount = async (customVal?: number) => {
    if (
      justPaid ||
      billReadOnly ||
      applyingDiscount ||
      processing ||
      updatingChargeId ||
      chargeStateUncertain ||
      attemptLocked ||
      openingSplitCheck
    )
      return;
    const rawVal = customVal !== undefined ? customVal : parseFloat(discountValue);
    if (customVal === undefined && (isNaN(rawVal) || rawVal < 0)) {
      toast.error(t('discountInvalid'));
      return;
    }
    const val =
      discountType === 'amount'
        ? normalizeFixedDiscountValue(rawVal, unitAdapter.maxDecimals)
        : rawVal;
    if (discountType === 'amount' && rawVal > 0 && val <= 0) {
      toast.error(t('discountInvalid'));
      return;
    }
    const effectiveDiscountApproverId = discountApproverId ?? managerApprovers.selectedApproverId;
    // Check if PIN is required
    if (discountRequiresApproval && val > 0) {
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
    if (val > 0 && !isDiscountTypeAllowed(discountMode, discountType)) {
      toast.error(t('discountInvalid'));
      return;
    }
    setApplyingDiscount(true);
    setRequestFailure(null);
    const operationId = createOperationReference();
    try {
      const storedDiscountValue =
        discountType === 'amount' && customVal === undefined ? toStoredUnit(val) : val;
      await api.patch(
        `/orders/${bill.order_id}/discount`,
        {
          discount_type: discountType,
          discount_value: storedDiscountValue,
          discount_reason: val > 0 ? discountReason || undefined : undefined,
          override_pin: discountRequiresApproval && val > 0 ? discountPin : undefined,
          approver_id:
            discountRequiresApproval && val > 0 && discountPin
              ? effectiveDiscountApproverId || undefined
              : undefined,
        },
        { headers: operationHeaders(operationId) },
      );
      setRequestFailure(null);
      toast.success(val === 0 ? t('discountRemoved') : t('discountUpdated'));
      setDiscountPin('');
      setDiscountApproverId(null);
      if (val === 0) {
        setShowDiscount(false);
        setDiscountValue('');
        setDiscountReason('');
      } else if (amountTarget?.kind === 'discount') {
        restorePaymentTarget();
      }
      // Refresh bill without closing modal
      const { data } = await api.get(`/bills/order/${bill.order_id}`, {
        headers: operationHeaders(operationId),
      });
      if (data.bill && onBillUpdate) {
        onBillUpdate(data.bill);
      }
    } catch (error) {
      const failure = classifyOrderRequestFailure(error, {
        operation: 'order.discount',
        correlationId: operationId || '',
      });
      const confirmedNoChange = failure.trusted && failure.outcome === 'not_applied';
      const displayMessages: Record<string, string> = {
        invalid_type: t('discountInvalidType'),
        invalid_value: t('discountInvalidValue'),
        disabled: t('discountDisabled'),
        type_disabled: t('discountTypeDisabled'),
        limit_exceeded: t('discountLimitExceeded'),
        order_not_discountable: t('orderNotDiscountable'),
        bill_not_discountable: t('billNotDiscountable'),
        split_check: t('splitCheckDiscountUnavailable'),
        refunded: t('refundedDiscountUnavailable'),
        paid: t('paidDiscountUnavailable'),
      };
      const message = confirmedNoChange
        ? failure.displayCode
          ? displayMessages[failure.displayCode] || t('operationNotSaved')
          : failure.serverError === 'Invalid manager PIN'
            ? t('kitchenDeliveryOverrideInvalid')
            : failure.serverError === 'Manager PIN required for discounts'
              ? t('managerPinRequired')
              : failure.status === 429 && failure.serverError
                ? failure.serverError
                : t('operationNotSaved')
        : t('discountOutcomeUnknown');
      setRequestFailure({
        message,
        nextStep: confirmedNoChange
          ? t('operationNotSavedNextStep')
          : t('operationCheckBeforeRetry'),
        details: {
          operation: 'order.discount',
          stage: failure.stage || 'unknown',
          outcome: confirmedNoChange ? 'not_applied' : 'unknown',
          reasonCode: failure.reasonCode,
          correlationId: failure.correlationId || operationId,
        },
        status: failure.status,
      });
      toast.error(message);
      // Clear the PIN on any failure (wrong PIN or rate-limited) so a stale/rejected
      // PIN doesn't sit in the field looking like it might still work on retry.
      setDiscountPin('');
    } finally {
      setApplyingDiscount(false);
    }
  };

  const splitLookupIdRef = useRef(0);
  // Any bill change (discount, charge, payment, parent refresh) invalidates an
  // in-flight split lookup: an older response answering a stale snapshot must
  // never open the allocator against frozen totals.
  const splitLookupBillRef = useRef(bill);
  useEffect(() => {
    if (splitLookupBillRef.current === bill) return;
    splitLookupBillRef.current = bill;
    splitLookupIdRef.current += 1;
    setOpeningSplitCheck(false);
    setSplitOpenReason(null);
  }, [bill]);
  const handleOpenSplitCheck = async () => {
    if (
      openingSplitCheck ||
      attemptLocked ||
      justPaid ||
      billReadOnly ||
      applyingDiscount ||
      updatingChargeId ||
      chargeStateUncertain
    )
      return;
    const lookupId = ++splitLookupIdRef.current;
    setOpeningSplitCheck(true);
    setSplitOpenReason(null);
    try {
      // The bill endpoint answers with this check's own projection, so a
      // re-split never offers a paid sibling's quantities.
      const { data } = await api.get(`/bills/${bill.id}`);
      if (lookupId !== splitLookupIdRef.current) return;
      const freshBill = (data?.bill ?? null) as Bill | null;
      if (!freshBill) {
        setSplitOpenReason('splitCheckFailed');
        return;
      }
      let splitOrder = (freshBill.order ?? null) as Order | null;
      if (!splitOrder?.items?.length && !freshBill.split_group_id) {
        const fallback = await api.get(`/orders/${bill.order_id}`);
        if (lookupId !== splitLookupIdRef.current) return;
        splitOrder = (fallback.data?.order ?? null) as Order | null;
      }
      if (lookupId !== splitLookupIdRef.current) return;

      // Re-evaluate eligibility from the authoritative fresh result before
      // opening anything; the button could only check a stale snapshot.
      const items = (splitOrder?.items || []).filter(
        (item) => !['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(item.status),
      );
      const untouchedUnpaid =
        freshBill.payment_status === 'unpaid' &&
        splitOrder?.status !== 'cancelled' &&
        Number(freshBill.paid_amount || 0) === 0 &&
        !freshBill.payment_details;
      const wholeUnits = items.every(
        (item) => Number.isSafeInteger(Number(item.quantity)) && Number(item.quantity) > 0,
      );
      const divisible =
        items.length > 0 &&
        wholeUnits &&
        items.reduce((total, item) => total + Number(item.quantity), 0) >= 2;
      if (
        !canReadBills ||
        !canGenerateBill ||
        !untouchedUnpaid ||
        splitOrder?.type !== 'dine_in' ||
        !divisible
      ) {
        setSplitOpenReason(
          !canReadBills || !canGenerateBill
            ? 'splitCheckPermissionRequired'
            : !untouchedUnpaid
              ? 'splitCheckBeforePaymentOnly'
              : splitOrder?.type !== 'dine_in'
                ? 'splitCheckDineInOnly'
                : !wholeUnits
                  ? 'splitCheckWholeUnitsOnly'
                  : items.length > 0
                    ? 'splitCheckTwoUnitsRequired'
                    : 'splitCheckFailed',
        );
        return;
      }

      // The refreshed bill and its matching projection travel together, so the
      // editor never mixes fresh items with an obsolete total or status.
      setSplitCheckBill({ ...freshBill, order: splitOrder ?? (bill as Bill).order });
      setSplitCheckOrder(splitOrder);
    } catch {
      if (splitLookupIdRef.current === lookupId) setSplitOpenReason('splitCheckFailed');
    } finally {
      if (splitLookupIdRef.current === lookupId) setOpeningSplitCheck(false);
    }
  };

  const handleSplitComplete = (bills: Bill[], departingBill: Bill | null) => {
    setSplitCheckOrder(null);
    setSplitCheckBill(null);
    setSplitOpenReason(null);
    if (onSplit) onSplit(departingBill ?? undefined);
    else onClose();
  };

  /** Snapshots the draft fields the backend hashes into the request fingerprint. */
  const buildPendingAttempt = (): PendingPaymentAttempt => {
    const splitLines = payments
      .map((p) => ({
        method: p.payment_method_id === undefined ? p.method : 'custom',
        ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
        amount: toStoredUnit(parseFloat(p.amount) || 0),
        ...(needsTransactionId(p) && p.transaction_id?.trim()
          ? { transaction_id: p.transaction_id.trim() }
          : {}),
      }))
      .filter((p) => p.amount > 0 && !isNaN(p.amount));
    if (walletAmt > 0) splitLines.push({ method: 'wallet', amount: walletAmt });
    const zeroBalance = remainingMinor === 0 && splitLines.length === 0;
    return {
      billId: bill.id,
      key: createPaymentIdempotencyKey(),
      operationId: createOperationReference(),
      zeroBalance,
      lines: zeroBalance ? [{ method: 'cash', amount: null }] : splitLines,
      customerId: effectiveCustomerId,
      ...(remaining > 0 ? { balanceAtSubmit: remaining } : {}),
    };
  };

  /**
   * Sends one frozen attempt. A known outcome releases it (and a committed
   * partial payment starts a fresh key next time); anything uncertain keeps the
   * attempt and its key, so Pay replays the identical request.
   */
  const submitPaymentAttempt = async (attempt: PendingPaymentAttempt, lockHeld = false) => {
    if (!lockHeld) {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
    }
    setProcessing(true);
    setRequestFailure(null);
    const effectiveKitchenApproverId = kitchenApproverId ?? managerApprovers.selectedApproverId;
    if (kitchenOverridePin) {
      if (
        managerApprovers.loading ||
        managerApprovers.loadFailed ||
        managerApprovers.approvers.length === 0 ||
        !effectiveKitchenApproverId
      ) {
        toast.error(t('managerPinRequired'));
        inFlightRef.current = false;
        setProcessing(false);
        return;
      }
    }
    try {
      const res = await api.post(
        attempt.zeroBalance ? `/bills/${bill.id}/payment` : `/bills/${bill.id}/payments`,
        attempt.zeroBalance
          ? {
              method: attempt.lines[0].method,
              amount: attempt.lines[0].amount,
              customer_id: attempt.customerId,
              override_pin: kitchenOverridePin || undefined,
              approver_id: kitchenOverridePin ? effectiveKitchenApproverId || undefined : undefined,
            }
          : {
              payments: attempt.lines,
              customer_id: attempt.customerId,
              override_pin: kitchenOverridePin || undefined,
              approver_id: kitchenOverridePin ? effectiveKitchenApproverId || undefined : undefined,
            },
        { headers: { 'Idempotency-Key': attempt.key, ...operationHeaders(attempt.operationId) } },
      );
      const updatedBill = res.data?.bill as Bill | undefined;
      if (!updatedBill) {
        // A 2xx without a bill is no evidence of an outcome: replay the attempt.
        lockAttempt(attempt);
        setPaymentOutcomeUnknown(true);
        setRequestFailure({
          message: t('operationOutcomeUnknown'),
          nextStep: t('operationCheckBeforeRetry'),
          details: {
            operation: 'payment.create',
            stage: 'response',
            outcome: 'unknown',
            reasonCode: null,
            correlationId: attempt.operationId,
          },
          status: res.status,
        });
        void captureClientOperationFailure({
          operation: 'payment.create',
          phase: 'transport',
          correlationId: attempt.operationId,
          failureClass: 'invalid_response',
        });
        return;
      }
      lockAttempt(null);
      setPaymentOutcomeUnknown(false);
      setRequestFailure(null);
      setKitchenOverrideRequired(false);
      setActiveCol1Panel((panel) => (panel === 'kitchen-override' ? 'items' : panel));
      if (updatedBill.payment_status !== 'paid') {
        setPayments((rows) =>
          rows.map((row) => (row.transaction_id ? { ...row, transaction_id: '' } : row)),
        );
        if (onBillUpdate) onBillUpdate({ ...bill, ...updatedBill, order: bill.order });
        // Only a committed equal share retires its payer, and only once.
        if (
          updatedBill.payment_status === 'partial' &&
          appliedEqualShare &&
          attemptTotalMinor(attempt) === appliedEqualShare.amountMinor
        ) {
          advanceEqualShare(appliedEqualShare);
        }
        if (updatedBill.payment_status === 'partial') {
          toast.success(t('paymentRecorded'));
        } else {
          toast.error(
            t('paymentIncomplete', {
              amount: currencyFmt(Number(updatedBill.balance) || 0),
            }),
          );
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
      const attemptAmount = attempt.zeroBalance ? 0 : attemptTotalMinor(attempt) / minorFactor;
      const recordedTail =
        !attempt.zeroBalance &&
        attempt.lines.length > 0 &&
        Array.isArray(updatedBill.payment_details) &&
        updatedBill.payment_details.length >= attempt.lines.length
          ? updatedBill.payment_details.slice(-attempt.lines.length)
          : null;
      const recordedTailMatches = Boolean(
        recordedTail &&
        recordedTail.every((detail, idx) => {
          const line = attempt.lines[idx];
          const requested =
            (detail as { requested_amount?: number }).requested_amount ??
            detail.tendered_amount ??
            detail.amount;
          return (
            detail?.method === line.method &&
            (detail?.payment_method_id ?? undefined) === (line.payment_method_id ?? undefined) &&
            toMinorUnits(Number(requested) || 0) === toMinorUnits(Number(line.amount) || 0)
          );
        }),
      );
      const priorRemaining =
        remaining > 0
          ? remaining
          : typeof attempt.balanceAtSubmit === 'number' && attempt.balanceAtSubmit > 0
            ? attempt.balanceAtSubmit
            : Math.max(0, Number(updatedBill.paid_amount ?? updatedBill.total ?? attemptAmount));
      const settledNow = attempt.zeroBalance
        ? 0
        : recordedTailMatches && recordedTail
          ? recordedTail.reduce((sum, d) => sum + toMinorUnits(Number(d.amount) || 0), 0) /
            minorFactor
          : Math.min(attemptAmount, priorRemaining);
      const attemptHasCash = attempt.lines.some(
        (line) => line.method === 'cash' && (Number(line.amount) || 0) > 0,
      );
      const settledChange = attempt.zeroBalance
        ? 0
        : recordedTailMatches && recordedTail
          ? recordedTail.reduce((sum, d) => sum + toMinorUnits(Number(d.change_amount) || 0), 0) /
            minorFactor
          : attemptHasCash && attemptTotalMinor(attempt) > toMinorUnits(settledNow)
            ? (attemptTotalMinor(attempt) - toMinorUnits(settledNow)) / minorFactor
            : 0;
      setSettledBill({
        ...bill,
        ...updatedBill,
        order: updatedBill.order ?? detailOrder ?? bill.order,
      });
      setPaidChangeAmount(settledChange);
      setPaidAmount(settledNow);
      setJustPaid(true);
    } catch (error: unknown) {
      const response = (
        error as {
          response?: {
            status?: number;
            data?: {
              code?: string;
              error?: string;
              undeliveredCount?: number;
              undeliveredItems?: unknown;
            };
          };
        } | null
      )?.response;
      const payload = response?.data;
      const failure = classifyOrderRequestFailure(error, {
        operation: 'payment.create',
        correlationId: attempt.operationId || '',
      });
      const knownNotApplied = failure.trusted && failure.outcome === 'not_applied';
      if (!response) {
        const failureClass = classifyTransportFailure(error);
        void captureClientOperationFailure({
          operation: 'payment.create',
          phase: 'transport',
          correlationId: attempt.operationId,
          failureClass,
        });
      }
      const paymentDisplayMessages: Record<string, string> = {
        transaction_reference_used: t('paymentTransactionReferenceUsed'),
        transaction_reference_reused: t('paymentTransactionReferenceReused'),
        card_transaction_id_required: t('cardTransactionIdMissing'),
        bill_refunded: t('paymentBillRefunded'),
        bill_already_paid: t('paymentBillAlreadyPaid'),
        customer_mismatch: t('paymentCustomerMismatch'),
        customer_unavailable: t('paymentCustomerUnavailable'),
        wallet_customer_required: t('paymentWalletCustomerRequired'),
        amount_required: t('paymentAmountRequired'),
        non_cash_exceeds_balance: t('paymentAboveBalance'),
        cash_reference_zero_applied: t('paymentCashReferenceZeroApplied'),
        wallet_insufficient: t('paymentWalletInsufficient'),
        kitchen_undelivered: t('kitchenDeliveryOverridePrompt'),
        idempotency_conflict: t('paymentIdempotencyConflict'),
        payment_method_unavailable: t('paymentMethodUnavailable'),
        payment_input_invalid: t('paymentInputInvalid'),
        cash_session_required: tExpenses('cashSessionClosed'),
      };
      // The setting may be unreadable for this role; the backend's refusal still reveals it.
      if (failure.displayCode === 'card_transaction_id_required') {
        setCardTransactionIdRequired(true);
      }
      const reasonMessage =
        failure.outcome === 'applied'
          ? t('paymentCompletionApplied')
          : failure.reasonCode === 'payment.invalid'
            ? failure.displayCode
              ? paymentDisplayMessages[failure.displayCode] || t('paymentValidationRejected')
              : t('paymentValidationRejected')
            : knownNotApplied
              ? t('operationNotSaved')
              : t('operationOutcomeUnknown');
      const setFailure = (outcome: 'not_applied' | 'applied' | 'unknown') => {
        setPaymentOutcomeUnknown(outcome !== 'not_applied');
        setRequestFailure({
          message: reasonMessage,
          nextStep:
            outcome === 'not_applied'
              ? t('operationNotSavedNextStep')
              : t('operationCheckBeforeRetry'),
          details: {
            operation: failure.operation,
            stage: failure.stage || 'unknown',
            outcome,
            reasonCode: failure.reasonCode,
            correlationId: failure.correlationId || attempt.operationId,
          },
          status: failure.status,
        });
      };
      if (payload?.code === 'KITCHEN_ITEMS_UNDELIVERED') {
        // The kitchen gate runs before any write: nothing committed, and the
        // cashier must be able to retry with a manager PIN.
        lockAttempt(null);
        setKitchenOverrideRequired(true);
        setCol1Panel('kitchen-override');
        setShowDetails(true);
        setKitchenOverridePin('');
        setKitchenUndeliveredCount(Number(payload.undeliveredCount) || 0);
        setKitchenUndeliveredItems(
          Array.isArray(payload.undeliveredItems) ? payload.undeliveredItems : [],
        );
        setKitchenDeliveryError('');
        setRequestFailure(null);
        setPaymentOutcomeUnknown(false);
      } else if (payload?.error === 'Invalid manager PIN') {
        // A definitive challenge rejection: no payment was recorded.
        lockAttempt(null);
        setKitchenOverrideRequired(true);
        setCol1Panel('kitchen-override');
        setShowDetails(true);
        setKitchenOverridePin('');
        setKitchenDeliveryError(t('kitchenDeliveryOverrideInvalid'));
        setRequestFailure(null);
        setPaymentOutcomeUnknown(false);
      } else if (knownNotApplied && payload?.error !== IDEMPOTENCY_CONFLICT_ERROR) {
        lockAttempt(null);
        setFailure('not_applied');
        toast.error(reasonMessage);
      } else if (failure.trusted && failure.outcome === 'applied') {
        lockAttempt(attempt);
        setFailure('applied');
        toast.error(reasonMessage);
      } else {
        // No response, a server fault, or a key already recorded for another
        // request: the outcome is unknown, so the attempt stays frozen and the
        // retry replays it rather than issuing a new charge.
        lockAttempt(attempt);
        setFailure('unknown');
        toast.error(t('operationOutcomeUnknown'));
      }
    } finally {
      inFlightRef.current = false;
      setProcessing(false);
    }
  };

  const checkPaymentStatus = async (lockHeld = false) => {
    const attempt = pendingAttemptRef.current;
    if (!attempt || attempt.billId !== bill.id || processing) return;
    if (!lockHeld) {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
    }
    setProcessing(true);
    setRequestFailure(null);
    try {
      const { data } = await api.get(`/bills/${bill.id}`, {
        headers: operationHeaders(attempt.operationId),
      });
      const currentBill = data?.bill as Bill | undefined;
      if (
        currentBill &&
        (currentBill.payment_status === 'refunded' ||
          currentBill.payment_status === 'partially_refunded' ||
          currentBill.order?.status === 'cancelled')
      ) {
        onBillUpdate?.({ ...bill, ...currentBill, order: currentBill.order ?? bill.order });
        lockAttempt(null);
        setPaymentOutcomeUnknown(false);
        const isCancelled = currentBill.order?.status === 'cancelled';
        setRequestFailure({
          message: isCancelled ? tOrders('noFurtherActions') : t('paymentBillRefunded'),
          nextStep: '',
          details: {
            operation: 'payment.create',
            stage: 'recovery',
            outcome: 'not_applied',
            reasonCode: isCancelled ? 'order_cancelled' : 'bill_refunded',
            correlationId: attempt.operationId,
          },
          status: null,
        });
        return;
      }
      if (!currentBill || !['paid', 'partial', 'unpaid'].includes(currentBill.payment_status))
        throw new Error('Bill status unavailable');
      onBillUpdate?.({ ...bill, ...currentBill, order: bill.order });
      // A bill read cannot attribute another payment's balance change to this
      // request. Keep the exact request and idempotency key until replay returns
      // an authoritative result for this attempt.
      setPaymentOutcomeUnknown(false);
      setRequestFailure({
        message: t('paymentStatusUnconfirmed'),
        nextStep: t('paymentRetrySameRequest'),
        details: {
          operation: 'payment.create',
          stage: 'recovery',
          outcome: 'unknown',
          reasonCode: null,
          correlationId: attempt.operationId,
        },
        status: null,
      });
    } catch (error) {
      if (!(error as { response?: unknown } | null)?.response) {
        void captureClientOperationFailure({
          operation: 'payment.create',
          phase: 'recovery',
          correlationId: attempt.operationId,
        });
      }
      setPaymentOutcomeUnknown(true);
      setRequestFailure({
        message: t('operationOutcomeUnknown'),
        nextStep: t('operationCheckBeforeRetry'),
        details: {
          operation: 'payment.create',
          stage: 'recovery',
          outcome: 'unknown',
          reasonCode: null,
          correlationId: attempt.operationId,
        },
        status: null,
      });
    } finally {
      inFlightRef.current = false;
      setProcessing(false);
    }
  };

  const handlePay = async () => {
    const hasLockedAttempt = Boolean(
      pendingAttemptRef.current && pendingAttemptRef.current.billId === bill.id,
    );
    if (
      processing ||
      applyingDiscount ||
      updatingChargeId ||
      chargeStateUncertain ||
      justPaid ||
      billTerminal ||
      (!hasLockedAttempt && isBillPaid) ||
      inFlightRef.current
    )
      return;
    // Acquire synchronous flight lock before any async confirmation prompt
    // so rapid double-taps cannot open duplicate confirms or requests.
    inFlightRef.current = true;
    try {
      // An unresolved attempt is replayed exactly: same bill, lines, customer and
      // key. Resubmitting the live draft here is the hazard this guards.
      const unresolved = pendingAttemptRef.current;
      if (unresolved && unresolved.billId === bill.id) {
        if (paymentOutcomeUnknown) {
          await checkPaymentStatus(true);
          return;
        }
        await submitPaymentAttempt(unresolved, true);
        return;
      }
      const decimalPart =
        unitAdapter.maxDecimals > 0 ? `(?:\\.\\d{1,${unitAdapter.maxDecimals}})?` : '';
      const amountPattern = new RegExp(`^\\d+${decimalPart}$`);
      const amountIsValid = (value: string) =>
        value.trim() === '' || amountPattern.test(value.trim());
      if (
        payments.some(
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
        payments.some(
          (p) =>
            needsTransactionId(p) && (parseFloat(p.amount) || 0) > 0 && !p.transaction_id?.trim(),
        )
      ) {
        toast.error(t('cardTransactionIdMissing'));
        return;
      }
      if (nonCashExceedsBalance) {
        toast.error(t('paymentAboveBalance'));
        return;
      }
      // A short tender is a deliberate choice: the backend records what was
      // collected and leaves the rest as the bill's outstanding balance.
      if (totalPaymentMinor < remainingMinor) {
        const collected = totalPaymentMinor / minorFactor;
        const stillDue = (remainingMinor - totalPaymentMinor) / minorFactor;
        const proceed = await confirm(
          t('partialPaymentConfirm', {
            amount: currencyFmt(collected),
            remaining: currencyFmt(stillDue),
          }),
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
      const attempt = buildPendingAttempt();
      lockAttempt(attempt);
      await submitPaymentAttempt(attempt, true);
    } finally {
      inFlightRef.current = false;
    }
  };

  const tenantForShare = {
    business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
    currency: currentTenant?.currency || '',
    country: currentTenant?.country || '',
  };

  const completionBill = (() => {
    const base = settledBill ?? bill;
    return base.order || !contextOrder ? base : { ...base, order: contextOrder };
  })();

  const handleSendWhatsApp = async () => {
    const phone = cartCustomer?.phone;
    if (!phone) {
      toast.error(tWhatsappSend('customerPhoneRequired'));
      return;
    }
    setSendingWa(true);
    try {
      await sendBillViaFlo(
        completionBill,
        phone,
        tenantForShare,
        whatsappSendT,
        { pointsEarned },
        locale,
      );
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
        completionBill,
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

  const handlePrintCompletionReceipt = async () => {
    if (printingReceipt) return;
    const targetBill = completionBill;
    const reservedWindow = reservePrintWindow?.();
    setPrintingReceipt(true);
    try {
      if (onPrintBill) {
        await onPrintBill(targetBill, reservedWindow);
        return;
      }
      if (!currentTenant) {
        if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
        return;
      }
      const { usePrinterStore } = await import('@/hooks/usePrinter');
      await usePrinterStore
        .getState()
        .printBill(targetBill, currentTenant, undefined, reservedWindow);
    } catch {
      toast.error(tOrders('printReceiptFailed'));
    } finally {
      setPrintingReceipt(false);
    }
  };

  const isDismissLocked = () =>
    processing ||
    attemptLocked ||
    paymentOutcomeUnknown ||
    applyingDiscount ||
    Boolean(updatingChargeId) ||
    chargeStateUncertain ||
    splitCheckSaving ||
    inFlightRef.current;

  const handleCloseButtonClick = () => {
    if (isDismissLocked() || isConfirmOpen) return;
    if (splitCheckOrder) {
      setSplitCheckOrder(null);
      return;
    }
    if (chargeApprovalId) {
      setChargeApprovalId(null);
      setChargeApprovalPin('');
      return;
    }
    if (justPaid) {
      onPaid();
    } else {
      onClose();
    }
  };

  const dismissHandlerRef = useRef<() => boolean>(() => true);
  useEffect(() => {
    dismissHandlerRef.current = () => {
      if (isDismissLocked() || isConfirmOpen) {
        return true;
      }
      if (splitCheckOrder) {
        setSplitCheckOrder(null);
        return true;
      }
      if (chargeApprovalId) {
        setChargeApprovalId(null);
        setChargeApprovalPin('');
        return true;
      }
      if (
        !justPaid &&
        (effectiveCol1Panel === 'discount' ||
          effectiveCol1Panel === 'tax' ||
          (effectiveCol1Panel === 'kitchen-override' && !initialOverridePin))
      ) {
        setCol1Panel('items');
        return true;
      }
      if (justPaid) {
        onPaid();
      } else {
        onClose();
      }
      return true;
    };
  });

  useEffect(() => {
    if (!onRegisterDismissHandler) return;
    onRegisterDismissHandler(() => dismissHandlerRef.current());
    return () => onRegisterDismissHandler(undefined);
  }, [onRegisterDismissHandler]);

  const cardTenderIndex = payments.findIndex(
    (p) => p.method === 'card' && p.payment_method_id === undefined,
  );
  const cardPayment = cardTenderIndex >= 0 ? payments[cardTenderIndex] : null;
  const cardTenderActive = Boolean(
    cardPayment &&
    ((parseFloat(cardPayment.amount) || 0) > 0 ||
      (amountTarget?.kind === 'payment' && amountTarget.index === cardTenderIndex)),
  );
  const showPaymentCardRefInput = Boolean(
    cardPayment && needsTransactionId(cardPayment) && cardTenderActive,
  );

  const quickTenderOptions: CheckoutQuickTenderOption[] = (() => {
    if (processing || attemptLocked || justPaid || billReadOnly) return [];
    if (amountTarget?.kind === 'discount' && discountType === 'percentage') {
      return [5, 10, 15, 20].map((pct) => ({
        label: `${pct}%`,
        active: Number(discountValue) === pct,
        onClick: () => setDiscountValue(String(pct)),
      }));
    }
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
    if (requestFailure) {
      return {
        tone: paymentOutcomeUnknown ? 'warning' : 'error',
        message: requestFailure.message,
        nextStep: requestFailure.nextStep,
        technicalDetails: JSON.stringify(
          { ...requestFailure.details, httpStatus: requestFailure.status },
          null,
          2,
        ),
        technicalDetailsLabel: t('operationTechnicalDetails'),
        closeLabel: t('close'),
      };
    }
    if (isBillPaid) {
      return {
        tone: 'idle-settled',
        message: t('paid'),
      };
    }
    if (billTerminal) {
      return {
        tone: 'warning',
        message: isOrderCancelled ? tOrders('noFurtherActions') : t('paymentBillRefunded'),
      };
    }
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
  })();

  const readoutFormattedAmount =
    amountTarget?.kind === 'discount'
      ? discountType === 'percentage'
        ? `${discountValue || '0'}%`
        : currencyFmt(toStoredUnit(parseFloat(discountValue) || 0))
      : currencyFmt(toStoredUnit(parseFloat(activeAmountValue) || 0));

  const readoutStatusTone: 'settled' | 'ready' | 'due' | 'partial' | 'change' = isBillPaid
    ? 'settled'
    : billTerminal || nonCashExceedsBalance
      ? 'due'
      : change > 0 && !nonCashExceedsBalance
        ? 'change'
        : !nonCashExceedsBalance && totalPaymentMinor === remainingMinor
          ? 'ready'
          : totalPaymentMinor > 0
            ? 'partial'
            : 'due';

  const readoutStatusPillText = isBillPaid
    ? t('paid')
    : billTerminal || nonCashExceedsBalance
      ? undefined
      : change > 0 && !nonCashExceedsBalance
        ? `${t('changeReturned')}: ${currencyFmt(change)}`
        : !nonCashExceedsBalance && totalPaymentMinor === remainingMinor
          ? t('exactAmount')
          : undefined;

  const rawOrderType =
    contextOrder?.type || (contextOrder as { order_type?: string } | undefined)?.order_type;
  const orderTypeKey =
    rawOrderType && rawOrderType in ORDER_TYPE_KEYS
      ? ORDER_TYPE_KEYS[rawOrderType as keyof typeof ORDER_TYPE_KEYS]
      : null;
  const headerTableName =
    contextOrder?.table?.name || (contextOrder as { table_name?: string } | undefined)?.table_name;
  const headerChips: CheckoutHeaderChipItem[] = [
    { key: 'bill', label: t('billNumber', { number: bill.bill_number }), variant: 'neutral' },
    ...(bill.split_label
      ? [{ key: 'split', label: bill.split_label, variant: 'brand' as const }]
      : []),
    ...(contextOrder?.order_number
      ? [
          {
            key: 'order',
            label: t('orderNumber', { number: contextOrder.order_number }),
            variant: 'neutral' as const,
          },
        ]
      : []),
    ...(orderTypeKey ? [{ key: 'type', label: t(orderTypeKey), variant: 'brand' as const }] : []),
    ...(headerTableName
      ? [
          {
            key: 'table',
            label: t('tableLabel', { name: headerTableName }),
            variant: 'neutral' as const,
          },
        ]
      : []),
    ...(cartCustomer?.name
      ? [{ key: 'customer', label: cartCustomer.name, variant: 'customer' as const }]
      : []),
  ];

  const visibleOrderItems = (detailOrder?.items || []).filter(
    (item) => !['cancelled', 'voided', 'void_adjustment'].includes(item.status),
  );

  const taxComponents = resolveTaxComponents(bill);

  const controlsDisabled = processing || attemptLocked || justPaid || billReadOnly;

  const payCtaDisabled =
    processing ||
    openingSplitCheck ||
    applyingDiscount ||
    Boolean(updatingChargeId) ||
    chargeStateUncertain ||
    billTerminal ||
    (!attemptLocked && isBillPaid) ||
    (!pendingAttempt && nonCashExceedsBalance) ||
    (!pendingAttempt && totalPaymentMinor === 0 && remainingMinor > 0) ||
    Boolean(
      kitchenOverridePin &&
      (managerApprovers.loading ||
        managerApprovers.loadFailed ||
        managerApprovers.approvers.length === 0 ||
        !(kitchenApproverId ?? managerApprovers.selectedApproverId)),
    );

  const terminalCtaLabel = isOrderCancelled
    ? tOrders('cancelled')
    : bill.payment_status === 'partially_refunded'
      ? tOrders('partiallyRefunded')
      : tOrders('refunded');

  const payCtaLabel = processing
    ? t('processingPayment')
    : billTerminal
      ? terminalCtaLabel
      : paymentOutcomeUnknown
        ? t('checkPaymentStatus')
        : pendingAttempt
          ? t('retrySamePayment')
          : isBillPaid
            ? t('paid')
            : `${t('pay')} ${currencyFmt(totalPayment)}`;

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
    if (justPaid) {
      doneButtonRef.current?.focus?.();
    }
  }, [justPaid]);

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

      if (splitCheckOrder || chargeApprovalId || isConfirmOpen) return;
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
          if (justPaid) {
            onPaid();
            return;
          }
          if (
            amountTarget?.kind !== 'discount' &&
            !payCtaDisabled &&
            !pendingAttempt &&
            totalPaymentMinor >= remainingMinor
          ) {
            void handlePay();
          }
        }
        return;
      }

      if (justPaid || billReadOnly || isDismissLocked() || openingSplitCheck || !amountTarget)
        return;
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
      !isConfirmOpen &&
      amountTarget?.kind !== 'discount' &&
      !payCtaDisabled &&
      !pendingAttempt &&
      totalPaymentMinor >= remainingMinor
    ) {
      e.preventDefault();
      void handlePay();
    }
  };

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-3"
    >
      <div className="flex h-[calc(100dvh-0px)] w-full flex-col overflow-hidden border-border bg-background shadow-2xl sm:h-[min(94dvh,920px)] sm:max-w-[min(1440px,calc(100vw-24px))] sm:rounded-2xl sm:border dark:border-white/12">
        {/* Compact Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-card/85 px-4 py-2.5 sm:px-5 [@media(max-height:660px)]:py-1.5 dark:bg-card/55">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="shrink-0 text-base font-bold tracking-tight text-foreground sm:text-lg">
              {t('payment')}
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
              aria-expanded={showDetails}
              className={`touch-target rounded-lg border px-3 text-sm font-medium transition-colors lg:hidden ${
                !showDetails && kitchenOverrideRequired
                  ? 'border-amber-500/60 bg-amber-500/12 text-amber-800 dark:text-amber-200'
                  : 'border-border bg-card hover:bg-muted dark:border-white/10'
              }`}
            >
              {showDetails ? t('close') : kitchenOverrideRequired ? t('managerPin') : t('items')}
            </button>
            <button
              onClick={handleCloseButtonClick}
              disabled={
                processing ||
                attemptLocked ||
                paymentOutcomeUnknown ||
                applyingDiscount ||
                Boolean(updatingChargeId) ||
                chargeStateUncertain ||
                splitCheckSaving
              }
              className="touch-target rounded-full border border-border/70 bg-muted/70 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground active:scale-[0.98] dark:border-white/10"
              aria-label={t('close')}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(280px,1fr)_minmax(310px,1.08fr)_minmax(320px,0.96fr)] lg:overflow-hidden">
          {/* Column 1: Contained Panel Swap (Items / Discount / Tax / Kitchen Override) + Pinned Totals Footer */}
          <div
            className={`${showDetails ? 'flex' : 'hidden lg:flex'} max-lg:min-h-[168px] min-w-0 flex-col gap-2.5 border-b border-border bg-card/35 p-3 max-lg:flex-1 max-lg:overflow-y-auto sm:p-4 lg:min-h-0 lg:overflow-hidden lg:border-b-0 lg:border-e dark:bg-card/20`}
          >
            <div className="flex shrink-0 items-center justify-between gap-2">
              {effectiveCol1Panel === 'items' ? (
                <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <span>{t('items')}</span>
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border/80 bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground dark:border-white/10">
                    {fmtNum(visibleOrderItems.length)}
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
                    {effectiveCol1Panel === 'discount'
                      ? t('discount')
                      : effectiveCol1Panel === 'kitchen-override'
                        ? t('managerPin')
                        : t('tax')}
                  </span>
                </button>
              )}
              <div className="flex shrink-0 items-center gap-1.5">
                {kitchenOverrideRequired && (
                  <button
                    type="button"
                    onClick={() =>
                      setCol1Panel((panel) =>
                        panel === 'kitchen-override' ? 'items' : 'kitchen-override',
                      )
                    }
                    className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-semibold transition-colors ${
                      effectiveCol1Panel === 'kitchen-override'
                        ? 'border-amber-500 bg-amber-500/20 text-amber-800 dark:text-amber-200'
                        : 'border-amber-500/45 bg-amber-500/10 text-amber-800 hover:bg-amber-500/18 dark:text-amber-200'
                    }`}
                  >
                    <ShieldAlert className="size-3.5 shrink-0" />
                    {t('managerPin')}
                  </button>
                )}
                {canShowDiscountPanel && (
                  <button
                    type="button"
                    data-testid="col1-tab-discount"
                    disabled={controlsDisabled}
                    onClick={() => setShowDiscount((open) => !open)}
                    aria-expanded={showDiscount}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      showDiscount
                        ? 'border-brand bg-brand-light text-brand shadow-2xs dark:border-indigo-400/50 dark:bg-[var(--color-brand-light)] dark:text-indigo-300'
                        : Number(bill.discount_amount) > 0
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:border-emerald-500/60 dark:text-emerald-300'
                          : 'border-border bg-card text-foreground shadow-2xs hover:border-brand/45 hover:text-brand dark:border-white/10 dark:hover:text-indigo-300'
                    }`}
                  >
                    <Tag className="size-3.5 shrink-0" />
                    <span>
                      {Number(bill.discount_amount) > 0
                        ? `${t('discount')}: -${currencyFmt(Number(bill.discount_amount))}`
                        : t('applyDiscount')}
                    </span>
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${showDiscount ? 'rotate-180' : ''}`}
                    />
                  </button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-3 shadow-2xs dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              {effectiveCol1Panel === 'kitchen-override' ? (
                <div
                  role="alert"
                  className="space-y-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-amber-900 dark:border-amber-400/35 dark:bg-amber-500/12 dark:text-amber-200"
                >
                  {kitchenUndeliveredCount > 0 && (
                    <p className="text-sm font-semibold">
                      {t('kitchenItemsPendingWarning', { count: kitchenUndeliveredCount })}
                    </p>
                  )}
                  <p className="text-sm">{t('kitchenDeliveryOverridePrompt')}</p>
                  {kitchenUndeliveredItems.length > 0 && (
                    <p className="break-words text-xs opacity-90">
                      {kitchenUndeliveredItems.join(', ')}
                    </p>
                  )}
                  <div className="space-y-2 text-start">
                    <ApproverSelect
                      id="kitchenApproverSelect"
                      approvers={managerApprovers.approvers}
                      selectedApproverId={kitchenApproverId ?? managerApprovers.selectedApproverId}
                      onSelectApprover={(id) => {
                        setKitchenApproverId(id);
                        setKitchenOverridePin('');
                        setKitchenDeliveryError('');
                      }}
                      loading={managerApprovers.loading}
                      loadFailed={managerApprovers.loadFailed}
                      disabled={controlsDisabled}
                    />
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      value={kitchenOverridePin}
                      disabled={controlsDisabled}
                      onChange={(event) => {
                        setKitchenOverridePin(event.target.value.replace(/\D/g, '').slice(0, 6));
                        setKitchenDeliveryError('');
                      }}
                      placeholder={t('managerPin')}
                      aria-label={t('managerPin')}
                      className="min-h-11 w-full rounded-lg border border-amber-500/45 bg-card px-3 py-2 text-center text-lg font-semibold tracking-[0.5em] text-foreground outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20"
                    />
                  </div>
                  {kitchenDeliveryError && (
                    <p className="text-xs font-medium text-destructive">{kitchenDeliveryError}</p>
                  )}
                </div>
              ) : effectiveCol1Panel === 'discount' ? (
                <div className="space-y-2.5">
                  <div className="flex gap-1 rounded-xl border border-border/80 bg-muted/60 p-1 dark:border-white/10 dark:bg-muted/35">
                    {isDiscountTypeAllowed(discountMode, 'percentage') && (
                      <button
                        type="button"
                        disabled={controlsDisabled}
                        onClick={() => setDiscountType('percentage')}
                        className={`touch-target flex-1 gap-1.5 rounded-lg text-xs font-semibold transition-colors sm:text-sm ${
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
                        disabled={controlsDisabled}
                        onClick={() => setDiscountType('amount')}
                        className={`touch-target flex-1 gap-1.5 rounded-lg text-xs font-semibold transition-colors sm:text-sm ${
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
                    className={`flex min-h-11 items-center rounded-xl border bg-card pe-3 transition-colors ${
                      controlsDisabled ? 'cursor-not-allowed opacity-60' : ''
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
                      disabled={controlsDisabled}
                      onFocus={() => setAmountTarget({ kind: 'discount' })}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      placeholder={discountType === 'percentage' ? '0' : '0.00'}
                      min="0"
                      max={
                        discountType === 'percentage' ? 100 : toDisplayUnit(Number(bill.subtotal))
                      }
                      step={getDiscountInputStep(unitAdapter.maxDecimals, discountType)}
                      inputMode={discountType === 'percentage' ? 'numeric' : 'decimal'}
                      className="min-w-0 flex-1 bg-transparent py-2 text-base font-bold tabular-nums text-foreground outline-none disabled:cursor-not-allowed"
                    />
                  </div>
                  <input
                    type="text"
                    value={discountReason}
                    disabled={controlsDisabled}
                    onChange={(e) => setDiscountReason(e.target.value)}
                    placeholder={t('discountReasonPlaceholder')}
                    className="min-h-11 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-white/10"
                  />
                  {discountRequiresApproval && parseFloat(discountValue) > 0 && (
                    <div className="space-y-2 rounded-xl border border-amber-500/35 bg-amber-500/8 p-2.5 dark:border-amber-400/30 dark:bg-amber-500/10">
                      <ApproverSelect
                        id="paymentDiscountApprover"
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
                        disabled={controlsDisabled || applyingDiscount}
                      />
                      <input
                        type="password"
                        value={discountPin}
                        disabled={controlsDisabled || applyingDiscount}
                        onChange={(e) => setDiscountPin(e.target.value)}
                        placeholder={t('managerPin')}
                        maxLength={6}
                        className="min-h-11 w-full rounded-lg border border-amber-500/40 bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                      />
                    </div>
                  )}
                  <Button
                    onClick={() => handleApplyDiscount()}
                    disabled={
                      controlsDisabled ||
                      applyingDiscount ||
                      openingSplitCheck ||
                      Boolean(updatingChargeId) ||
                      discountValue === '' ||
                      isNaN(parseFloat(discountValue)) ||
                      (discountRequiresApproval &&
                        parseFloat(discountValue) > 0 &&
                        (!discountPin ||
                          managerApprovers.loading ||
                          managerApprovers.loadFailed ||
                          managerApprovers.approvers.length === 0 ||
                          !(discountApproverId ?? managerApprovers.selectedApproverId)))
                    }
                    className={`min-h-11 w-full rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                  >
                    {applyingDiscount
                      ? t('applyingDiscount')
                      : Number(bill.discount_amount) > 0
                        ? t('updateDiscount')
                        : t('applyDiscount')}
                  </Button>
                  {Number(bill.discount_amount) > 0 && (
                    <Button
                      variant="outline"
                      className="min-h-10 w-full rounded-xl"
                      disabled={
                        controlsDisabled ||
                        applyingDiscount ||
                        openingSplitCheck ||
                        Boolean(updatingChargeId)
                      }
                      onClick={async () => {
                        if (
                          await confirm(t('removeDiscountConfirm'), {
                            destructive: true,
                            confirmLabel: t('remove'),
                          })
                        )
                          void handleApplyDiscount(0);
                      }}
                    >
                      {t('remove')}
                    </Button>
                  )}
                </div>
              ) : effectiveCol1Panel === 'tax' ? (
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
                    <span>{t('tax')}</span>
                    <span className="tabular-nums">{currencyFmt(Number(bill.tax_amount))}</span>
                  </div>
                  {taxComponents.length > 0 && (
                    <div className="space-y-1.5 border-t border-border pt-2 text-xs tabular-nums dark:border-white/10">
                      {taxComponents.map((component, idx) => (
                        <div
                          key={`${component.title}-${idx}`}
                          className="flex justify-between gap-2"
                        >
                          <span className="text-muted-foreground">
                            {component.title} ({component.rate ?? 0}%)
                          </span>
                          <span className="font-medium text-foreground">
                            {currencyFmt(component.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {billDetails?.id === bill.id && billDetails.failed && (
                    <p className="text-sm text-muted-foreground">{t('loadOrderFailed')}</p>
                  )}
                  {visibleOrderItems.map((item) => (
                    <div
                      key={item.id}
                      data-testid="payment-order-item"
                      className="border-b border-border/75 pb-2 text-sm last:border-b-0 last:pb-0 dark:border-white/8"
                    >
                      <div className="flex items-start justify-between gap-2.5">
                        <div className="flex min-w-0 items-start gap-2">
                          <CheckoutQtyBadge>{fmtNum(Number(item.quantity))}</CheckoutQtyBadge>
                          <span className="min-w-0 font-semibold leading-snug text-foreground">
                            {item.product_name}
                            {item.variant_selection ? ` (${item.variant_selection.name})` : ''}
                          </span>
                        </div>
                        <span className="shrink-0 font-semibold tabular-nums text-foreground">
                          {currencyFmt(Number(item.total))}
                        </span>
                      </div>
                      {(Number(item.quantity) > 1 ||
                        (item.addons || []).length > 0 ||
                        Boolean(item.special_instructions) ||
                        (Boolean(item.price_overridden) && item.original_unit_price != null)) && (
                        <div className="space-y-0.5 ps-7 pt-0.5">
                          {Number(item.quantity) > 1 && (
                            <p className="text-xs tabular-nums text-muted-foreground">
                              {item.quantity} × {currencyFmt(Number(item.unit_price))}
                            </p>
                          )}
                          {(item.addons || []).map((addon, index) => (
                            <p key={addon.id ?? index} className="text-xs text-muted-foreground">
                              + {addon.name}
                              {(addon.quantity || 1) > 1 ? ` ×${addon.quantity}` : ''}
                            </p>
                          ))}
                          {item.special_instructions && (
                            <p className="text-xs italic text-muted-foreground">
                              {item.special_instructions}
                            </p>
                          )}
                          {Boolean(item.price_overridden) && item.original_unit_price != null && (
                            <p className="text-xs text-muted-foreground">
                              {tOrders('priceOverriddenMenu', {
                                price: currencyFmt(Number(item.original_unit_price)),
                              })}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {(appliedCharges.length > 0 || (canEditCharges && addableCharges.length > 0)) && (
                    <div
                      className="space-y-1.5 border-t border-border pt-2 text-xs tabular-nums dark:border-white/10"
                      data-testid="payment-charges"
                    >
                      {appliedCharges.map((charge) => {
                        const definition = applicableCharges.find((c) => c.id === charge.id);
                        return (
                          <div
                            key={charge.id}
                            data-testid={`payment-charge-${charge.id}`}
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
                              {canEditCharges && definition?.is_optional && (
                                <button
                                  type="button"
                                  disabled={Boolean(updatingChargeId)}
                                  onClick={() => {
                                    if (
                                      !charge.waived &&
                                      !hasRole(currentTenant?.role, ROLE_ACCESS.ownerManager)
                                    ) {
                                      setChargeApprovalId(charge.id);
                                      setChargeApprovalPin('');
                                      setChargeApproverId(null);
                                    } else {
                                      void updateCharge(charge.id, { waived: !charge.waived });
                                    }
                                  }}
                                  aria-pressed={charge.waived}
                                  className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-semibold text-brand transition-colors hover:border-brand/40 hover:bg-brand-light/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-indigo-300"
                                >
                                  {charge.waived ? t('applyCharge') : t('waiveCharge')}
                                </button>
                              )}
                              {canEditCharges && definition && !definition.is_default_active && (
                                <button
                                  type="button"
                                  disabled={Boolean(updatingChargeId)}
                                  onClick={() => void updateCharge(charge.id, { applied: false })}
                                  className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10"
                                >
                                  {t('removeCharge')}
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                      {canEditCharges &&
                        addableCharges.map((charge) => (
                          <div
                            key={charge.id}
                            data-testid={`payment-charge-${charge.id}`}
                            className="flex items-center justify-between gap-2 text-muted-foreground"
                          >
                            <span>{charge.name}</span>
                            <button
                              type="button"
                              disabled={Boolean(updatingChargeId)}
                              onClick={() => void updateCharge(charge.id, { applied: true })}
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
            <div className="shrink-0 space-y-1 rounded-xl border border-border bg-muted/35 p-3 text-xs tabular-nums dark:border-white/10 dark:bg-muted/20">
              <div className="flex justify-between text-muted-foreground">
                <span>{t('subtotal')}</span>
                <span className="font-medium text-foreground">
                  {currencyFmt(Number(bill.subtotal))}
                </span>
              </div>
              {Number(bill.discount_amount) > 0 && (
                <div className="flex justify-between font-semibold text-emerald-600 dark:text-emerald-400">
                  <span className="truncate">
                    {t('discount')}
                    {bill.discount_reason ? ` - ${bill.discount_reason}` : ''}
                  </span>
                  <span className="shrink-0">− {currencyFmt(Number(bill.discount_amount))}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => setCol1Panel((panel) => (panel === 'tax' ? 'items' : 'tax'))}
                aria-expanded={effectiveCol1Panel === 'tax'}
                className="flex w-full items-center justify-between text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="inline-flex items-center gap-1">
                  <span>{t('tax')}</span>
                  {taxComponents.length > 0 && (
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${effectiveCol1Panel === 'tax' ? 'rotate-180' : ''}`}
                    />
                  )}
                </span>
                <span className="font-medium text-foreground">
                  {currencyFmt(Number(bill.tax_amount))}
                </span>
              </button>
              {Number(bill.delivery_charge) > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('delivery')}</span>
                  <span className="font-medium text-foreground">
                    {currencyFmt(Number(bill.delivery_charge))}
                  </span>
                </div>
              )}
              {Number(bill.packaging_charge) > 0 &&
                !appliedCharges.some((charge) => charge.id === 'packaging_charge') && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>{t('packaging')}</span>
                    <span className="font-medium text-foreground">
                      {currencyFmt(Number(bill.packaging_charge))}
                    </span>
                  </div>
                )}
              {Number(bill.service_charge) > 0 &&
                !appliedCharges.some((charge) => charge.id === 'service_charge') && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>{tReceipt('serviceCharge')}</span>
                    <span className="font-medium text-foreground">
                      {currencyFmt(Number(bill.service_charge))}
                    </span>
                  </div>
                )}
              {Number(bill.round_off) !== 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('roundOff')}</span>
                  <span className="font-medium text-foreground">
                    {Number(bill.round_off) > 0 ? '+' : ''}
                    {currencyFmt(Number(bill.round_off))}
                  </span>
                </div>
              )}
              <div className="flex items-baseline justify-between border-t border-border/80 pt-2 font-bold text-foreground dark:border-white/10">
                <span className="text-sm font-bold text-foreground">{t('total')}</span>
                <span className="text-lg font-bold leading-none tabular-nums">
                  {currencyFmt(Number(bill.total))}
                </span>
              </div>
              {Number(bill.paid_amount) > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('paid')}</span>
                  <span className="font-medium text-foreground">
                    {currencyFmt(Number(bill.paid_amount))}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Column 2: Hero Balance, Core Tenders + Fixed Card Ref, Custom Tenders, Loyalty Wallet, Contained Split Card */}
          <div
            className={`${showDetails ? 'hidden lg:flex' : 'flex'} max-lg:min-h-[168px] min-w-0 flex-col gap-2.5 border-b border-border bg-muted/20 p-3 max-lg:flex-1 max-lg:overflow-y-auto sm:p-4 [@media(max-height:660px)]:p-2 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-e dark:bg-background/45`}
          >
            {/* [2A] Hero Balance Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-2xs dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              <div className="min-w-0">
                <span className="text-xs font-semibold text-muted-foreground">{t('totalDue')}</span>
                {cartCustomer && (
                  <p className="mt-0.5 flex items-center gap-1 truncate text-xs font-medium text-foreground">
                    <User size={12} className="shrink-0 text-brand dark:text-indigo-300" />
                    <span className="truncate">{cartCustomer.name}</span>
                  </p>
                )}
              </div>
              <span className="text-xl font-bold tracking-tight tabular-nums text-foreground sm:text-2xl">
                {currencyFmt(remaining)}
              </span>
            </div>

            {/* [2B] Core Built-in Tenders (Cash & Card) + Constant Terminal Reference Slot */}
            <div className="shrink-0 space-y-2">
              {payments.map((payment, idx) => {
                if (payment.payment_method_id !== undefined) return null;
                const builtIn = PAYMENT_METHODS.find((method) => method.key === payment.method);
                const label = tenderLabel(payment);
                const Icon = builtIn?.icon;
                const isFocused = amountTarget?.kind === 'payment' && amountTarget.index === idx;
                const isAppliedShare = appliedEqualShare?.index === idx;
                const isAllocated = (parseFloat(payment.amount) || 0) > 0 || isAppliedShare;
                const rowDisabled = controlsDisabled;
                const rowClasses = getTenderRowClasses({
                  isFocused,
                  isAllocated,
                  disabled: rowDisabled,
                });
                return (
                  <div key={payment.method} className="space-y-0.5">
                    <div className="flex min-h-12">
                      <button
                        type="button"
                        title={label}
                        disabled={rowDisabled}
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
                          disabled={rowDisabled}
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
                    {isAppliedShare && (
                      <p className="px-1 text-[11px] font-semibold text-brand dark:text-indigo-300">
                        {t('equalShareBadge')}
                      </p>
                    )}
                  </div>
                );
              })}

              {/* Constant-height Terminal Reference Slot prevents vertical shift across Cash <-> Card */}
              <div className="flex h-11 shrink-0 items-center">
                {showPaymentCardRefInput && cardPayment && cardTenderIndex >= 0 ? (
                  <input
                    id="payment-card-transaction-id"
                    type="text"
                    value={cardPayment.transaction_id ?? ''}
                    disabled={controlsDisabled}
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

            {/* [2C] Contained Custom Tenders, Single Fixed-Height Loyalty Wallet & Equal/Item Split */}
            <div className="flex flex-col gap-2 max-lg:shrink-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {customMethods.length > 0 && (
                <div className="max-h-[152px] shrink-0 space-y-2 overflow-y-auto pe-0.5">
                  {payments.map((payment, idx) => {
                    if (payment.payment_method_id === undefined) return null;
                    const label = tenderLabel(payment);
                    const isFocused =
                      amountTarget?.kind === 'payment' && amountTarget.index === idx;
                    const isAppliedShare = appliedEqualShare?.index === idx;
                    const isAllocated = (parseFloat(payment.amount) || 0) > 0 || isAppliedShare;
                    const rowDisabled = controlsDisabled;
                    const rowClasses = getTenderRowClasses({
                      isFocused,
                      isAllocated,
                      disabled: rowDisabled,
                    });
                    return (
                      <div key={`custom:${payment.payment_method_id}`} className="space-y-0.5">
                        <div className="flex min-h-12">
                          <button
                            type="button"
                            title={label}
                            disabled={rowDisabled}
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
                              disabled={rowDisabled}
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
                        {isAppliedShare && (
                          <p className="px-1 text-[11px] font-semibold text-brand dark:text-indigo-300">
                            {t('equalShareBadge')}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {loyaltySettings?.loyalty_enabled &&
                effectiveCustomerId &&
                (() => {
                  const walletDisabled = controlsDisabled || !walletBalance || walletBalance <= 0;
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
                            if (attemptLocked || justPaid || billReadOnly || !walletBalance) return;
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
                            disabled={walletDisabled}
                            onFocus={() => setAmountTarget({ kind: 'wallet' })}
                            onChange={(e) => {
                              if (attemptLocked || justPaid || billReadOnly) return;
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

              {/* Unified Split section (contained internally so even 20 Equal Share rows never grow Column 2) */}
              {!justPaid && (remainingMinor > 0 || hasSplitChecksPanel) && (
                <div
                  className={`flex flex-col rounded-xl border border-border bg-card shadow-2xs max-lg:shrink-0 lg:flex-1 lg:overflow-hidden dark:border-white/10 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${
                    (
                      hasSplitChecksPanel
                        ? !splitSectionCollapsed
                        : showEqualShare || Boolean(equalShareNotice)
                    )
                      ? 'lg:min-h-[168px]'
                      : 'lg:min-h-[52px]'
                  }`}
                  data-testid="unified-split-card"
                >
                  {hasSplitChecksPanel ? (
                    <button
                      type="button"
                      onClick={() => setSplitSectionCollapsed((collapsed) => !collapsed)}
                      aria-expanded={!splitSectionCollapsed}
                      className="touch-target w-full shrink-0 justify-between gap-3 bg-muted/45 px-3 text-start transition-colors hover:bg-muted/70 dark:bg-muted/25"
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Users size={15} className="text-brand dark:text-indigo-300" />
                        {t('splitPayment')}
                      </span>
                      <ChevronDown
                        size={16}
                        className={`text-muted-foreground transition-transform ${!splitSectionCollapsed ? 'rotate-180' : ''}`}
                      />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setShowEqualShare((open) => !open);
                        setEqualShareNotice(null);
                      }}
                      aria-expanded={showEqualShare}
                      className="touch-target w-full shrink-0 justify-between gap-3 bg-muted/45 px-3 text-start transition-colors hover:bg-muted/70 dark:bg-muted/25"
                    >
                      <span className="text-sm font-semibold text-foreground">
                        {t('splitPaymentEqually')}
                      </span>
                      <ChevronDown
                        size={16}
                        className={`text-muted-foreground transition-transform ${showEqualShare ? 'rotate-180' : ''}`}
                      />
                    </button>
                  )}

                  {(!hasSplitChecksPanel || !splitSectionCollapsed) && (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      {hasSplitChecksPanel && remainingMinor > 0 && (
                        <div className="grid grid-cols-2 gap-1 border-t border-border bg-muted/55 p-1 dark:border-white/10 dark:bg-muted/30">
                          <button
                            type="button"
                            aria-pressed={!showEqualShare}
                            data-testid="split-mode-items-tab"
                            onClick={() => setShowEqualShare(false)}
                            className={`min-h-11 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                              !showEqualShare
                                ? 'bg-brand text-white shadow-xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('splitItemsIntoChecks')}
                          </button>
                          <button
                            type="button"
                            aria-pressed={showEqualShare}
                            data-testid="split-mode-equal-tab"
                            onClick={() => {
                              setShowEqualShare(true);
                              setEqualShareNotice(null);
                            }}
                            className={`min-h-11 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                              showEqualShare
                                ? 'bg-brand text-white shadow-xs'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {t('splitPaymentEqually')}
                          </button>
                        </div>
                      )}

                      {equalShareNotice && (
                        <p
                          role="status"
                          className="border-t border-border bg-amber-500/8 px-3 py-2 text-[11px] font-medium text-amber-800 dark:border-white/10 dark:text-amber-300"
                        >
                          {t(
                            equalShareNotice === 'lastPayer'
                              ? 'equalShareLastPayer'
                              : 'equalShareInvalidated',
                          )}
                        </p>
                      )}

                      {showEqualShare && remainingMinor > 0 ? (
                        <div className="space-y-2 border-t border-border bg-card p-2.5 dark:border-white/10">
                          <div className="space-y-1">
                            <label
                              htmlFor="equal-share-payers"
                              className="block text-xs font-semibold text-foreground"
                            >
                              {t('equalSharePayers')}
                            </label>
                            <div className="flex flex-wrap items-center justify-between gap-1.5">
                              <div className="flex items-center gap-1">
                                {[2, 3, 4].map((preset) => {
                                  const activePreset = equalShareCount === preset;
                                  return (
                                    <button
                                      key={preset}
                                      type="button"
                                      aria-pressed={activePreset}
                                      data-testid={`equal-share-preset-${preset}`}
                                      disabled={controlsDisabled}
                                      onClick={() => {
                                        if (attemptLocked || justPaid || billReadOnly) return;
                                        setEqualSharePayers(String(preset));
                                      }}
                                      className={`min-h-11 min-w-11 rounded-lg border px-2.5 py-1.5 text-xs font-semibold tabular-nums transition-colors disabled:opacity-40 ${
                                        activePreset
                                          ? 'border-brand bg-brand text-white shadow-xs'
                                          : 'border-border bg-card text-foreground shadow-2xs hover:border-brand/45 hover:text-brand dark:border-white/10 dark:hover:text-indigo-300'
                                      }`}
                                    >
                                      {preset}
                                    </button>
                                  );
                                })}
                              </div>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  aria-label={t('decreasePax')}
                                  data-testid="equal-share-decrement"
                                  disabled={!canDecrementEqualShare}
                                  onClick={() => stepEqualSharePayers(-1)}
                                  className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-2xs transition-[color,background-color,border-color,box-shadow,transform] hover:border-brand/40 hover:bg-brand-light/25 active:scale-[0.98] disabled:opacity-40 dark:border-white/10"
                                >
                                  <Minus size={15} />
                                </button>
                                <input
                                  id="equal-share-payers"
                                  type="number"
                                  min={MIN_EQUAL_SHARE_PAYERS}
                                  max={MAX_EQUAL_SHARE_PAYERS}
                                  step={1}
                                  inputMode="numeric"
                                  value={equalSharePayers}
                                  disabled={controlsDisabled}
                                  onChange={(event) => {
                                    if (attemptLocked || justPaid || billReadOnly) return;
                                    setEqualSharePayers(event.target.value);
                                  }}
                                  className="min-h-11 w-12 rounded-lg border border-border bg-card px-1.5 py-1.5 text-center text-sm font-bold tabular-nums text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 dark:border-white/10"
                                />
                                <button
                                  type="button"
                                  aria-label={t('increasePax')}
                                  data-testid="equal-share-increment"
                                  disabled={!canIncrementEqualShare}
                                  onClick={() => stepEqualSharePayers(1)}
                                  className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-2xs transition-[color,background-color,border-color,box-shadow,transform] hover:border-brand/40 hover:bg-brand-light/25 active:scale-[0.98] disabled:opacity-40 dark:border-white/10"
                                >
                                  <Plus size={15} />
                                </button>
                              </div>
                            </div>
                          </div>
                          {equalShareError ? (
                            <p role="alert" className="text-[11px] font-medium text-destructive">
                              {t(
                                equalShareError === 'tooManyPayers'
                                  ? 'equalShareTooManyPayers'
                                  : 'equalShareInvalidCount',
                              )}
                            </p>
                          ) : (
                            <>
                              <ul
                                data-testid="equal-share-shares"
                                className="max-h-[76px] space-y-0.5 overflow-y-auto rounded-lg border border-border/75 bg-muted/25 p-1.5 text-xs dark:border-white/10 dark:bg-muted/15"
                              >
                                {equalShareShares.map((shareMinor, index) => (
                                  <li
                                    key={index}
                                    className={`flex items-center justify-between gap-2 rounded-md px-1.5 py-0.5 ${
                                      index === 0
                                        ? 'bg-brand-light/55 font-medium text-brand dark:bg-[var(--color-brand-light)] dark:text-indigo-300'
                                        : ''
                                    }`}
                                  >
                                    <span
                                      className={
                                        index === 0
                                          ? 'text-brand dark:text-indigo-300'
                                          : 'text-muted-foreground'
                                      }
                                    >
                                      {index + 1}
                                      {index === 0 && (
                                        <span className="ms-2 rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                          {t('equalShareNextShare')}
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      data-testid={`equal-share-share-${index}`}
                                      className="font-semibold tabular-nums text-foreground"
                                    >
                                      {currencyFmt(minorToStored(shareMinor))}
                                    </span>
                                  </li>
                                ))}
                                <li className="flex items-center justify-between gap-2 border-t border-border/80 px-1.5 pt-1 font-semibold text-foreground dark:border-white/10">
                                  <span>{t('total')}</span>
                                  <span data-testid="equal-share-total" className="tabular-nums">
                                    {currencyFmt(remaining)}
                                  </span>
                                </li>
                              </ul>
                              {equalShareSharesDiffer && (
                                <p className="text-[11px] text-muted-foreground">
                                  {t('equalShareRoundingNote')}
                                </p>
                              )}
                              {equalShareConflict && (
                                <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                                  {t('equalShareConflicts')}
                                </p>
                              )}
                              <div className="flex flex-wrap gap-1.5">
                                {payments.map((payment, idx) => (
                                  <Button
                                    key={
                                      payment.payment_method_id === undefined
                                        ? payment.method
                                        : `custom:${payment.payment_method_id}`
                                    }
                                    data-testid={`equal-share-apply-${idx}`}
                                    variant="outline"
                                    size="sm"
                                    className="min-h-10 border-brand/35 bg-brand-light/40 font-semibold text-brand hover:border-brand hover:bg-brand-light/80 dark:border-indigo-400/40 dark:bg-[var(--color-brand-light)] dark:text-indigo-300 dark:hover:bg-indigo-500/25"
                                    disabled={controlsDisabled}
                                    onClick={() => void applyEqualShare(idx)}
                                  >
                                    {t('equalShareApplyTo', { method: tenderLabel(payment) })}
                                  </Button>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      ) : (
                        hasSplitChecksPanel && (
                          <div className="border-t border-border bg-card p-3 dark:border-white/10">
                            {splitSettingState === 'error' ? (
                              <div className="w-full space-y-2" data-testid="split-check-section">
                                <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                                  {splitSettingDenied
                                    ? t('splitCheckSettingDenied')
                                    : t('splitCheckAvailabilityFailed')}
                                </p>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={billReadOnly || justPaid}
                                  onClick={loadSplitCheckSetting}
                                  className="w-full"
                                  size="lg"
                                >
                                  {t('splitCheckCheckAvailability')}
                                </Button>
                              </div>
                            ) : (
                              <div className="w-full space-y-2" data-testid="split-check-section">
                                {remainingMinor <= 0 && (
                                  <p className="text-xs font-semibold text-foreground">
                                    {t('splitItemsIntoChecks')}
                                  </p>
                                )}
                                <p className="text-xs text-muted-foreground">
                                  {t('splitCheckHint')}
                                </p>
                                {'open' in splitEligibility ? (
                                  <Button
                                    variant="outline"
                                    onClick={handleOpenSplitCheck}
                                    disabled={
                                      billReadOnly ||
                                      justPaid ||
                                      openingSplitCheck ||
                                      processing ||
                                      attemptLocked ||
                                      applyingDiscount ||
                                      Boolean(updatingChargeId) ||
                                      chargeStateUncertain
                                    }
                                    className="w-full border-brand/35 bg-brand-light/40 font-semibold text-brand hover:border-brand hover:bg-brand-light/75 dark:border-indigo-400/40 dark:bg-[var(--color-brand-light)] dark:text-indigo-300 dark:hover:bg-indigo-500/25"
                                    size="lg"
                                  >
                                    <Users size={16} className="me-2" />
                                    {t('splitCheck')}
                                  </Button>
                                ) : 'unknown' in splitEligibility ? (
                                  <Button
                                    variant="outline"
                                    onClick={handleOpenSplitCheck}
                                    disabled={
                                      billReadOnly ||
                                      justPaid ||
                                      openingSplitCheck ||
                                      processing ||
                                      attemptLocked ||
                                      applyingDiscount ||
                                      Boolean(updatingChargeId) ||
                                      chargeStateUncertain
                                    }
                                    className="w-full"
                                    size="lg"
                                  >
                                    <Users size={16} className="me-2" />
                                    {t('splitCheckCheckAvailability')}
                                  </Button>
                                ) : (
                                  <div className="w-full space-y-1">
                                    <Button variant="outline" disabled className="w-full" size="lg">
                                      <Users size={16} className="me-2" />
                                      {t('splitCheck')}
                                    </Button>
                                    <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                                      {'cancelled' in splitEligibility
                                        ? tOrders('noFurtherActions')
                                        : t(splitEligibility.reason)}
                                    </p>
                                  </div>
                                )}
                                {splitOpenReason && (
                                  <p className="text-xs font-medium text-destructive">
                                    {t(splitOpenReason)}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Column 3: Full-Height 4-Zone Checkout Payment Station (or Receipt Share when settled) */}
          <div className="flex min-h-0 min-w-0 flex-col bg-muted/30 p-3 max-lg:shrink-0 sm:p-4 [@media(max-height:660px)]:p-2 lg:overflow-y-auto dark:bg-card/25">
            {justPaid ? (
              <div className="flex h-full flex-col justify-center space-y-2.5">
                <div
                  role="status"
                  className="space-y-2.5 rounded-2xl border border-emerald-500/35 bg-card p-5 text-center shadow-xs dark:border-emerald-400/30 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                >
                  <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/12 text-emerald-600 ring-4 ring-emerald-500/10 dark:text-emerald-400">
                    <CheckCircle2 size={30} />
                  </div>
                  <p className="text-base font-semibold text-foreground">{t('paymentRecorded')}</p>
                  <p className="text-3xl font-bold tracking-tight tabular-nums text-foreground">
                    {currencyFmt(paidAmount ?? Math.min(totalPayment, remaining))}
                  </p>
                  <div>
                    <span className="inline-flex items-center rounded-full border border-emerald-500/35 bg-emerald-500/12 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
                      {t('paid')}
                    </span>
                  </div>
                  {paidChangeAmount > 0 && (
                    <div
                      data-testid="settled-change-banner"
                      className="mt-1 flex items-center justify-between gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/12 px-3.5 py-2.5 text-start dark:border-emerald-400/35 dark:bg-emerald-500/15"
                    >
                      <span className="text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                        {t('changeReturned')}
                      </span>
                      <span className="text-xl font-bold tracking-tight tabular-nums text-emerald-700 sm:text-2xl dark:text-emerald-300">
                        {currencyFmt(paidChangeAmount)}
                      </span>
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  data-testid="completion-print-receipt-btn"
                  variant="outline"
                  disabled={printingReceipt}
                  onClick={() => void handlePrintCompletionReceipt()}
                  className="min-h-11 w-full rounded-xl bg-card font-semibold dark:border-white/10"
                  size="lg"
                >
                  <Printer size={16} className="me-2" />
                  {tOrders('printReceiptTitle')}
                </Button>
                {cartCustomer?.phone &&
                  (isWhatsAppReady ? (
                    <Button
                      onClick={handleSendWhatsApp}
                      disabled={sendingWa}
                      className="min-h-11 w-full rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
                      size="lg"
                    >
                      <Send size={16} className="me-2" />
                      {sendingWa ? t('processingPayment') : t('sendViaWhatsApp')}
                    </Button>
                  ) : (
                    <Button
                      onClick={handleShareWhatsApp}
                      variant="outline"
                      className="min-h-11 w-full rounded-xl border-emerald-500/35 bg-emerald-500/8 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
                      size="lg"
                    >
                      <Send size={16} className="me-2" />
                      {tCommon('shareViaWhatsApp')}
                    </Button>
                  ))}
                <Button
                  ref={doneButtonRef}
                  onClick={onPaid}
                  className={`min-h-11 w-full rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                  size="lg"
                >
                  {tCommon('done')}
                </Button>
              </div>
            ) : (
              <CheckoutPaymentStation
                readout={{
                  activeLabel: activeAmountLabel,
                  amountText: readoutFormattedAmount,
                  paidSummaryText: isBillPaid
                    ? `${t('paid')}: ${currencyFmt(Number(bill.paid_amount) || 0)}`
                    : `${t('payment')}: ${currencyFmt(totalPayment)}`,
                  dueSummaryText: `${t('total')}: ${currencyFmt(remaining)}`,
                  statusPillText: readoutStatusPillText,
                  statusTone: readoutStatusTone,
                  isDiscountTarget: amountTarget?.kind === 'discount',
                }}
                quickTenders={quickTenderOptions}
                keypad={
                  <fieldset disabled={controlsDisabled} className="h-full">
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
                        fillHeight
                      />
                    )}
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
                  onClick={handlePay}
                  disabled={payCtaDisabled}
                  className={`h-11 w-full shrink-0 rounded-xl text-base font-semibold transition-colors sm:h-12 [@media(max-height:660px)]:h-11 ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                  size="lg"
                >
                  {payCtaLabel}
                </Button>
              </CheckoutPaymentStation>
            )}
          </div>
        </div>
      </div>
      {chargeApprovalId && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setChargeApprovalId(null);
              setChargeApprovalPin('');
            }
          }}
        >
          <DialogContent showCloseButton={false} aria-describedby={undefined}>
            <DialogTitle>{t('managerPin')}</DialogTitle>
            <div className="space-y-2.5 rounded-xl border border-amber-500/35 bg-amber-500/8 p-3 dark:border-amber-400/30 dark:bg-amber-500/10">
              <ApproverSelect
                id="chargeApproverSelect"
                approvers={managerApprovers.approvers}
                selectedApproverId={chargeApproverId ?? managerApprovers.selectedApproverId}
                onSelectApprover={(id) => {
                  setChargeApproverId(id);
                  setChargeApprovalPin('');
                }}
                loading={managerApprovers.loading}
                loadFailed={managerApprovers.loadFailed}
                disabled={processing || attemptLocked}
              />
              <input
                type="password"
                inputMode="numeric"
                maxLength={6}
                value={chargeApprovalPin}
                onChange={(event) =>
                  setChargeApprovalPin(event.target.value.replace(/\D/g, '').slice(0, 6))
                }
                placeholder={t('managerPin')}
                aria-label={t('managerPin')}
                className="min-h-11 w-full rounded-lg border border-amber-500/40 bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
              />
            </div>
            <div className="flex gap-2">
              <Button
                data-testid="charge-approval-cancel"
                variant="outline"
                className="min-h-11 flex-1 rounded-xl"
                onClick={() => {
                  setChargeApprovalId(null);
                  setChargeApprovalPin('');
                }}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                data-testid="charge-approval-submit"
                className={`min-h-11 flex-1 rounded-xl font-semibold ${CHECKOUT_PRIMARY_CTA_CLASS}`}
                disabled={
                  processing ||
                  attemptLocked ||
                  !/^\d{4,6}$/.test(chargeApprovalPin) ||
                  managerApprovers.loading ||
                  managerApprovers.loadFailed ||
                  !(chargeApproverId ?? managerApprovers.selectedApproverId)
                }
                onClick={() => {
                  const approverId = chargeApproverId ?? managerApprovers.selectedApproverId;
                  void updateCharge(
                    chargeApprovalId,
                    { waived: true },
                    { override_pin: chargeApprovalPin, approver_id: approverId },
                  );
                  setChargeApprovalId(null);
                  setChargeApprovalPin('');
                }}
              >
                {t('waiveCharge')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {splitCheckOrder && (
        <SplitCheckModal
          bill={splitCheckBill ?? bill}
          order={splitCheckOrder}
          onClose={() => {
            if (!splitCheckSaving) setSplitCheckOrder(null);
          }}
          onSplit={handleSplitComplete}
          onSubmittingChange={setSplitCheckSaving}
        />
      )}
      {ConfirmDialog}
    </div>
  );
}
