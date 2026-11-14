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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import api, {
  captureClientOperationFailure,
  createOperationReference,
  operationHeaders,
} from '@/lib/api';
import toast from 'react-hot-toast';
import type { Bill, Order } from '@/lib/types';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
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
  return {
    billId: bill.id,
    key: candidate.key,
    operationId: candidate.operationId ?? null,
    zeroBalance: Boolean(candidate.zeroBalance),
    lines: candidate.lines,
    customerId: candidate.customerId ?? null,
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
}: Props) {
  const remaining = Number(bill.balance);
  const cartCustomerId = useCartStore((s) => s.customerId);
  const selectedCustomer = useCartStore((s) => s.customer);
  const effectiveCustomerId = bill.customer_id || cartCustomerId || null;
  const { confirm, ConfirmDialog } = useConfirm();
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

  const [justPaid, setJustPaid] = useState(false);
  const [paidAmount, setPaidAmount] = useState<number | null>(null);
  const [sendingWa, setSendingWa] = useState(false);
  const [pointsEarned, setPointsEarned] = useState(0);
  const [payments, setPayments] = useState<Payment[]>(
    PAYMENT_METHODS.map((method) => ({ method: method.key, amount: '' })),
  );
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(false);
  const [autoFilledSingleIndex, setAutoFilledSingleIndex] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletAmount, setWalletAmount] = useState('');
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
  const showDiscount = activeCol1Panel === 'discount';
  const setShowDiscount = (next: boolean | ((prev: boolean) => boolean)) => {
    setActiveCol1Panel((prev) => {
      const resolved = typeof next === 'function' ? next(prev === 'discount') : next;
      return resolved ? 'discount' : 'items';
    });
  };
  const [discountType, setDiscountType] = useState<DiscountType>('percentage');
  const [discountValue, setDiscountValue] = useState('');
  const [discountReason, setDiscountReason] = useState('');

  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');
  const [discountApproverId, setDiscountApproverId] = useState<string | null>(null);
  const [applyingDiscount, setApplyingDiscount] = useState(false);
  const [loyaltySettings, setLoyaltySettings] = useState<{ loyalty_enabled: boolean } | null>(null);
  const [amountTarget, setAmountTarget] = useState<AmountTarget>({ kind: 'payment', index: 0 });
  const [showDetails, setShowDetails] = useState(false);
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
  const orderCustomer = detailOrder?.customer ?? bill.order?.customer;
  const cartCustomer = effectiveCustomerId
    ? String(orderCustomer?.id) === String(effectiveCustomerId)
      ? orderCustomer
      : String(selectedCustomer?.id) === String(effectiveCustomerId)
        ? selectedCustomer
        : null
    : (orderCustomer ?? selectedCustomer);

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
  // The backend rejects a waiver on a split check (its charges are already
  // allocated) and on a settled bill, so the toggle is not offered there.
  const canToggleCharges =
    !bill.split_group_id &&
    !scheduledOrderEditLocked &&
    bill.payment_status !== 'paid' &&
    Number(bill.paid_amount || 0) === 0 &&
    bill.payment_status !== 'refunded' &&
    bill.payment_status !== 'partially_refunded';
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
  type SplitEligibilityResult = { open: true } | { unknown: true } | { reason: SplitReasonKey };
  const splitEligibility: SplitEligibilityResult = (() => {
    // 1. Reading eligibility and generating an allocation are both configured
    //    permissions; both are explained the same way.
    if (!canReadBills || !canGenerateBill)
      return { reason: 'splitCheckPermissionRequired' } as const;
    // 2. An in-flight or unresolved payment operation must be resolved first.
    if (attemptLocked || paymentOutcomeUnknown || processing) {
      return { reason: 'splitCheckResolvePaymentFirst' } as const;
    }
    // 3. Only an untouched unpaid check is divisible.
    if (
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
      pendingAttemptRef.current = restored;
      inFlightRef.current = false;
      setPendingAttempt(restored);
      setSyncedRemaining(remaining);
      setPayments([
        ...PAYMENT_METHODS.map((method) => ({ method: method.key, amount: '' })),
        ...customMethods.map((method) => ({
          method: 'custom',
          payment_method_id: method.id,
          amount: '',
        })),
      ]);
      setPaymentsTouched(false);
      setAutoFilledSingleIndex(null);
      setWalletAmount('');
      setAmountTarget({ kind: 'payment', index: 0 });
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
      setPointsEarned(0);
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

  // Proportionally update payment inputs when remaining balance changes,
  // unless cashier has already edited inputs manually.
  if (!billIdChanged && !attemptLocked && remaining !== syncedRemaining) {
    setSyncedRemaining(remaining);
    const remainingTargetMinor = toMinorUnits(remaining);
    if (autoFilledSingleIndex !== null && payments[autoFilledSingleIndex]) {
      const nextDueMinor = Math.max(
        0,
        remainingTargetMinor - toMinorUnits(toStoredUnit(parseFloat(walletAmount) || 0)),
      );
      const nextDisplay = toDisplayUnit(nextDueMinor / minorFactor);
      setPayments(
        payments.map((p, idx) =>
          idx === autoFilledSingleIndex
            ? { ...p, amount: nextDueMinor > 0 ? formatInput(nextDisplay) : '' }
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
  }, [bill.customer_id, cartCustomerId]);

  const walletAmt = toStoredUnit(parseFloat(walletAmount) || 0);
  const totalPaymentMinor =
    payments.reduce((s, p) => s + toMinorUnits(toStoredUnit(parseFloat(p.amount) || 0)), 0) +
    toMinorUnits(walletAmt);
  const totalPayment = totalPaymentMinor / minorFactor;
  const remainingMinor = toMinorUnits(remaining);

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
    !(equalSharePayers.trim() !== '' && Number(equalSharePayers) <= MIN_EQUAL_SHARE_PAYERS);
  const canIncrementEqualShare =
    !processing &&
    !attemptLocked &&
    !(equalSharePayers.trim() !== '' && Number(equalSharePayers) >= MAX_EQUAL_SHARE_PAYERS);
  const stepEqualSharePayers = (delta: -1 | 1) => {
    if (processing || attemptLocked) return;
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
    if (processing || attemptLocked || shareMinor === undefined) return;
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

  const attemptTotalMinor = (attempt: PendingPaymentAttempt) =>
    attempt.lines.reduce((sum, line) => sum + toMinorUnits(Number(line.amount) || 0), 0);

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
    if (attemptLocked) return;
    setPaymentsTouched(true);
    setAutoFilledSingleIndex(null);
    setAppliedEqualShare((current) => (current?.index === idx ? null : current));
    setPayments((current) =>
      current.map((payment, index) => (index === idx ? { ...payment, amount: value } : payment)),
    );
  };

  const updatePaymentTransactionId = (idx: number, value: string) => {
    if (attemptLocked) return;
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
    if (attemptLocked) return;
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

  const activeAmountLabel =
    amountTarget?.kind === 'discount'
      ? t('discount')
      : amountTarget?.kind === 'wallet'
        ? t('loyaltyWallet')
        : amountTarget?.kind === 'payment' && payments[amountTarget.index]
          ? tenderLabel(payments[amountTarget.index])
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
    if (!amountTarget || attemptLocked) return;
    if (amountTarget.kind === 'payment') {
      updatePaymentAmount(amountTarget.index, value);
      return;
    }
    if (amountTarget.kind === 'wallet') {
      const maxWalletCurrencyStored = Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE);
      const maxDisplay = toDisplayUnit(Math.min(maxWalletCurrencyStored, remaining));
      const clamped = parseFloat(value) > maxDisplay ? String(maxDisplay) : value;
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

  const activeAmountQuickValues = (() => {
    if (amountTarget?.kind === 'payment') {
      const allocatedElsewhere = payments.reduce(
        (sum, payment, index) =>
          index === amountTarget.index ? sum : sum + toStoredUnit(parseFloat(payment.amount) || 0),
        walletAmt,
      );
      const dueDisplay = toDisplayUnit(Math.max(0, remaining - allocatedElsewhere));
      return dueDisplay > 0 ? [{ label: t('exactAmount'), value: String(dueDisplay) }] : [];
    }
    if (amountTarget?.kind === 'wallet') {
      const allocatedElsewhere = payments.reduce(
        (sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0),
        0,
      );
      const maxWalletStored = Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE);
      const dueDisplay = toDisplayUnit(
        Math.min(maxWalletStored, Math.max(0, remaining - allocatedElsewhere)),
      );
      return dueDisplay > 0 ? [{ label: t('exactAmount'), value: String(dueDisplay) }] : [];
    }
    return [];
  })();

  const hasCash = payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);

  const change =
    hasCash && totalPaymentMinor > remainingMinor
      ? (totalPaymentMinor - remainingMinor) / minorFactor
      : 0;

  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();

  const handleApplyDiscount = async (customVal?: number) => {
    if (
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
      toast.success(val === 0 ? t('discountRemoved') : t('discountUpdated'));
      setDiscountPin('');
      setDiscountApproverId(null);
      if (val === 0) {
        setShowDiscount(false);
        setDiscountValue('');
        setDiscountReason('');
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
      const maxSettleable =
        remaining > 0
          ? remaining
          : Math.max(0, Number(updatedBill.paid_amount ?? updatedBill.total ?? attemptAmount));
      setPaidAmount(attempt.zeroBalance ? 0 : Math.min(attemptAmount, maxSettleable));
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
        setActiveCol1Panel('kitchen-override');
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
        setActiveCol1Panel('kitchen-override');
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
    if (
      processing ||
      applyingDiscount ||
      updatingChargeId ||
      chargeStateUncertain ||
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
      const nonCashTotalMinor =
        payments
          .filter((p) => p.method !== 'cash')
          .reduce((sum, p) => sum + toMinorUnits(toStoredUnit(Number(p.amount) || 0)), 0) +
        toMinorUnits(walletAmt);
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

  const dismissHandlerRef = useRef<() => boolean>(() => true);
  useEffect(() => {
    dismissHandlerRef.current = () => {
      if (
        processing ||
        attemptLocked ||
        paymentOutcomeUnknown ||
        applyingDiscount ||
        updatingChargeId ||
        chargeStateUncertain ||
        splitCheckSaving ||
        inFlightRef.current
      ) {
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
    if (processing || attemptLocked || justPaid) return [];
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
      const allocatedPaymentsMinor = payments.reduce(
        (sum, payment) => sum + toMinorUnits(toStoredUnit(parseFloat(payment.amount) || 0)),
        0,
      );
      const maxWalletStored = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
      const dueMinor = Math.min(
        toMinorUnits(maxWalletStored),
        Math.max(0, remainingMinor - allocatedPaymentsMinor),
      );
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
    if (totalPaymentMinor < remainingMinor && remainingMinor > 0) {
      return {
        tone: 'idle-due',
        message: `${t('balanceDue')}: ${currencyFmt((remainingMinor - totalPaymentMinor) / minorFactor)}`,
      };
    }
    return {
      tone: 'idle-settled',
      message: t('paid'),
    };
  })();

  const readoutFormattedAmount =
    amountTarget?.kind === 'discount'
      ? discountType === 'percentage'
        ? `${discountValue || '0'}%`
        : currencyFmt(toStoredUnit(parseFloat(discountValue) || 0))
      : currencyFmt(toStoredUnit(parseFloat(activeAmountValue) || 0));

  const readoutStatusTone: 'settled' | 'due' | 'change' =
    change > 0 ? 'change' : totalPaymentMinor >= remainingMinor ? 'settled' : 'due';

  const taxComponents = resolveTaxComponents(bill);

  const payCtaDisabled =
    processing ||
    openingSplitCheck ||
    applyingDiscount ||
    Boolean(updatingChargeId) ||
    chargeStateUncertain ||
    (!pendingAttempt && totalPaymentMinor === 0 && remainingMinor > 0) ||
    Boolean(
      kitchenOverridePin &&
      (managerApprovers.loading ||
        managerApprovers.loadFailed ||
        managerApprovers.approvers.length === 0 ||
        !(kitchenApproverId ?? managerApprovers.selectedApproverId)),
    );

  const payCtaLabel = processing
    ? t('processingPayment')
    : paymentOutcomeUnknown
      ? t('checkPaymentStatus')
      : pendingAttempt
        ? t('retrySamePayment')
        : `${t('pay')} ${currencyFmt(totalPayment)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-3">
      <div className="flex h-[calc(100dvh-0px)] w-full flex-col overflow-hidden bg-card shadow-2xl sm:h-[min(94dvh,920px)] sm:max-w-[min(1440px,calc(100vw-24px))] sm:rounded-2xl">
        {/* Compact Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground sm:text-lg">{t('payment')}</h2>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {t('billNumber', { number: bill.bill_number })}
              {bill.split_label ? ` · ${bill.split_label}` : ''}
              {contextOrder?.order_number
                ? ` · ${t('orderNumber', { number: contextOrder.order_number })}`
                : ''}
              {contextOrder?.type ? ` · ${t(ORDER_TYPE_KEYS[contextOrder.type])}` : ''}
              {contextOrder?.table?.name ? ` · ${contextOrder.table.name}` : ''}
              {cartCustomer ? ` · ${cartCustomer.name}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowDetails((open) => !open)}
              aria-expanded={showDetails}
              className="touch-target rounded-lg border border-border px-3 text-sm font-medium lg:hidden"
            >
              {showDetails ? t('close') : t('items')}
            </button>
            <button
              onClick={justPaid ? onPaid : onClose}
              disabled={processing || attemptLocked}
              className="touch-target rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted active:bg-muted"
              aria-label={t('close')}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[minmax(280px,1fr)_minmax(310px,1.08fr)_minmax(320px,0.96fr)] lg:overflow-hidden">
          {/* Column 1: Contained Panel Swap (Items / Discount / Tax / Kitchen Override) + Pinned Totals Footer */}
          <div
            className={`${showDetails ? 'flex' : 'hidden lg:flex'} min-h-0 min-w-0 flex-col gap-2.5 border-b border-border p-3 sm:p-4 lg:overflow-hidden lg:border-b-0 lg:border-e`}
          >
            <div className="flex shrink-0 items-center justify-between gap-2">
              {activeCol1Panel === 'items' ? (
                <h3 className="text-sm font-semibold text-foreground">{t('items')}</h3>
              ) : (
                <button
                  type="button"
                  onClick={() => setActiveCol1Panel('items')}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-muted/60 px-2.5 text-xs font-semibold text-foreground hover:bg-muted"
                >
                  <span>&larr;</span>
                  <span>{tCommon('back')}</span>
                  <span className="text-muted-foreground">
                    ·{' '}
                    {activeCol1Panel === 'discount'
                      ? t('discount')
                      : activeCol1Panel === 'kitchen-override'
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
                      setActiveCol1Panel((panel) =>
                        panel === 'kitchen-override' ? 'items' : 'kitchen-override',
                      )
                    }
                    className={`inline-flex h-8 items-center rounded-lg border px-2 text-xs font-semibold transition-colors ${
                      activeCol1Panel === 'kitchen-override'
                        ? 'border-amber-500 bg-amber-500/15 text-amber-800 dark:text-amber-200'
                        : 'border-amber-400/60 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
                    }`}
                  >
                    {t('managerPin')}
                  </button>
                )}
                {!bill.split_group_id && !scheduledOrderEditLocked && discountMode !== 'none' && (
                  <button
                    type="button"
                    data-testid="col1-tab-discount"
                    onClick={() => setShowDiscount((open) => !open)}
                    aria-expanded={showDiscount}
                    className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                      showDiscount
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-border bg-muted text-foreground hover:border-brand hover:text-brand'
                    }`}
                  >
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

            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card p-3">
              {activeCol1Panel === 'kitchen-override' && kitchenOverrideRequired ? (
                <div
                  role="alert"
                  className="space-y-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-200"
                >
                  {kitchenUndeliveredCount > 0 && (
                    <p className="text-sm font-medium">
                      {t('kitchenItemsPendingWarning', { count: kitchenUndeliveredCount })}
                    </p>
                  )}
                  <p className="text-sm">{t('kitchenDeliveryOverridePrompt')}</p>
                  {kitchenUndeliveredItems.length > 0 && (
                    <p className="break-words text-xs">{kitchenUndeliveredItems.join(', ')}</p>
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
                      disabled={processing || attemptLocked}
                    />
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      value={kitchenOverridePin}
                      onChange={(event) => {
                        setKitchenOverridePin(event.target.value.replace(/\D/g, '').slice(0, 6));
                        setKitchenDeliveryError('');
                      }}
                      placeholder={t('managerPin')}
                      aria-label={t('managerPin')}
                      className="min-h-11 w-full rounded-lg border border-amber-300 bg-card px-3 py-2 text-center text-lg tracking-[0.5em] dark:border-amber-700"
                    />
                  </div>
                  {kitchenDeliveryError && (
                    <p className="text-xs text-red-700 dark:text-red-300">{kitchenDeliveryError}</p>
                  )}
                </div>
              ) : activeCol1Panel === 'discount' &&
                !bill.split_group_id &&
                !scheduledOrderEditLocked &&
                discountMode !== 'none' ? (
                <div className="space-y-2.5">
                  <div className="flex overflow-hidden rounded-lg border border-border">
                    {isDiscountTypeAllowed(discountMode, 'percentage') && (
                      <button
                        type="button"
                        disabled={processing || attemptLocked}
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
                        disabled={processing || attemptLocked}
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
                      disabled={processing || attemptLocked}
                      onFocus={() => setAmountTarget({ kind: 'discount' })}
                      onChange={(e) => setDiscountValue(e.target.value)}
                      placeholder={discountType === 'percentage' ? '0' : '0.00'}
                      min="0"
                      max={
                        discountType === 'percentage' ? 100 : toDisplayUnit(Number(bill.subtotal))
                      }
                      step={getDiscountInputStep(unitAdapter.maxDecimals, discountType)}
                      inputMode={discountType === 'percentage' ? 'numeric' : 'decimal'}
                      className="min-h-11 w-full rounded-lg border border-border bg-card pe-3 ps-8 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                    />
                  </div>
                  <input
                    type="text"
                    value={discountReason}
                    disabled={processing || attemptLocked}
                    onChange={(e) => setDiscountReason(e.target.value)}
                    placeholder={t('discountReasonPlaceholder')}
                    className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                  />
                  {discountRequiresApproval && parseFloat(discountValue) > 0 && (
                    <div className="space-y-2">
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
                        disabled={processing || attemptLocked || applyingDiscount}
                      />
                      <input
                        type="password"
                        value={discountPin}
                        disabled={processing || attemptLocked || applyingDiscount}
                        onChange={(e) => setDiscountPin(e.target.value)}
                        placeholder={t('managerPin')}
                        maxLength={6}
                        className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                      />
                    </div>
                  )}
                  <Button
                    onClick={() => handleApplyDiscount()}
                    disabled={
                      processing ||
                      applyingDiscount ||
                      attemptLocked ||
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
                    className="w-full bg-brand text-white hover:bg-brand/90"
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
                      className="w-full"
                      disabled={
                        processing ||
                        applyingDiscount ||
                        attemptLocked ||
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
              ) : activeCol1Panel === 'tax' ? (
                <div className="space-y-2">
                  <TaxBreakdown
                    taxAmount={Number(bill.tax_amount)}
                    taxBreakdown={taxComponents.map((component) => ({
                      title: component.title,
                      rate: component.rate ?? 0,
                      amount: component.amount,
                    }))}
                    theme="light"
                  />
                  {taxComponents.length > 0 && (
                    <div className="space-y-1.5 border-t border-border pt-2 text-xs">
                      {taxComponents.map((component, idx) => (
                        <div
                          key={`${component.title}-${idx}`}
                          className="flex justify-between gap-2"
                        >
                          <span className="text-muted-foreground">
                            {component.title} ({component.rate ?? 0}%)
                          </span>
                          <span className="font-medium tabular-nums">
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
                  {(detailOrder?.items || [])
                    .filter(
                      (item) => !['cancelled', 'voided', 'void_adjustment'].includes(item.status),
                    )
                    .map((item) => (
                      <div
                        key={item.id}
                        data-testid="payment-order-item"
                        className="border-b border-border pb-2 text-sm last:border-b-0 last:pb-0"
                      >
                        <div className="flex justify-between gap-3 font-medium">
                          <span>
                            {item.quantity} × {item.product_name}
                            {item.variant_selection ? ` (${item.variant_selection.name})` : ''}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {currencyFmt(Number(item.total))}
                          </span>
                        </div>
                        {Number(item.quantity) > 1 && (
                          <p className="text-xs text-muted-foreground">
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
                          <p className="text-xs text-muted-foreground">
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
                    ))}

                  {(appliedCharges.length > 0 || (canEditCharges && addableCharges.length > 0)) && (
                    <div
                      className="space-y-1.5 border-t border-border pt-2 text-xs"
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
                            <span className={charge.waived ? 'line-through' : undefined}>
                              {charge.name}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className={charge.waived ? 'line-through' : undefined}>
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
                                  className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {charge.waived ? t('applyCharge') : t('waiveCharge')}
                                </button>
                              )}
                              {canEditCharges && definition && !definition.is_default_active && (
                                <button
                                  type="button"
                                  disabled={Boolean(updatingChargeId)}
                                  onClick={() => void updateCharge(charge.id, { applied: false })}
                                  className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
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
                              className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
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
            <div className="shrink-0 space-y-1 rounded-xl border border-border bg-muted/20 p-2.5 text-xs tabular-nums">
              <div className="flex justify-between text-muted-foreground">
                <span>{t('subtotal')}</span>
                <span>{currencyFmt(Number(bill.subtotal))}</span>
              </div>
              {Number(bill.discount_amount) > 0 && (
                <div className="flex justify-between font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="truncate">
                    {t('discount')}
                    {bill.discount_reason ? ` · ${bill.discount_reason}` : ''}
                  </span>
                  <span className="shrink-0">− {currencyFmt(Number(bill.discount_amount))}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => setActiveCol1Panel((panel) => (panel === 'tax' ? 'items' : 'tax'))}
                aria-expanded={activeCol1Panel === 'tax'}
                className="flex w-full items-center justify-between text-muted-foreground hover:text-foreground"
              >
                <span className="inline-flex items-center gap-1">
                  <span>{t('tax')}</span>
                  {taxComponents.length > 0 && (
                    <ChevronDown
                      size={12}
                      className={`transition-transform ${activeCol1Panel === 'tax' ? 'rotate-180' : ''}`}
                    />
                  )}
                </span>
                <span>{currencyFmt(Number(bill.tax_amount))}</span>
              </button>
              {Number(bill.delivery_charge) > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('delivery')}</span>
                  <span>{currencyFmt(Number(bill.delivery_charge))}</span>
                </div>
              )}
              {Number(bill.packaging_charge) > 0 &&
                !appliedCharges.some((charge) => charge.id === 'packaging_charge') && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>{t('packaging')}</span>
                    <span>{currencyFmt(Number(bill.packaging_charge))}</span>
                  </div>
                )}
              {Number(bill.service_charge) > 0 &&
                !appliedCharges.some((charge) => charge.id === 'service_charge') && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>{tReceipt('serviceCharge')}</span>
                    <span>{currencyFmt(Number(bill.service_charge))}</span>
                  </div>
                )}
              {Number(bill.round_off) !== 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('roundOff')}</span>
                  <span>
                    {Number(bill.round_off) > 0 ? '+' : ''}
                    {currencyFmt(Number(bill.round_off))}
                  </span>
                </div>
              )}
              <div className="flex items-end justify-between border-t border-border pt-1.5 font-bold text-foreground">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('total')}
                </span>
                <span className="text-lg leading-none">{currencyFmt(Number(bill.total))}</span>
              </div>
              {Number(bill.paid_amount) > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('paid')}</span>
                  <span>{currencyFmt(Number(bill.paid_amount))}</span>
                </div>
              )}
            </div>
          </div>

          {/* Column 2: Hero Balance, Core Tenders + Fixed Card Ref, Custom Tenders, Loyalty Wallet, Contained Split Card */}
          <div
            className={`${showDetails ? 'hidden lg:flex' : 'flex'} min-h-0 min-w-0 flex-col gap-2.5 border-b border-border p-3 sm:p-4 lg:overflow-hidden lg:border-b-0 lg:border-e`}
          >
            {/* [2A] Hero Balance Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-3 py-2">
              <div className="min-w-0">
                <span className="text-xs font-medium text-muted-foreground">{t('totalDue')}</span>
                {cartCustomer && (
                  <p className="flex items-center gap-1 truncate text-xs font-medium text-foreground">
                    <User size={12} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{cartCustomer.name}</span>
                  </p>
                )}
              </div>
              <span className="text-xl font-bold tabular-nums text-foreground sm:text-2xl">
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
                const active = (parseFloat(payment.amount) || 0) > 0;
                const isAppliedShare = appliedEqualShare?.index === idx;
                return (
                  <div key={payment.method} className="space-y-0.5">
                    <div className="flex min-h-12">
                      <button
                        type="button"
                        title={label}
                        disabled={processing || attemptLocked}
                        onClick={() => {
                          if (attemptLocked) return;
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
                          disabled={processing || attemptLocked}
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
                    {isAppliedShare && (
                      <p className="px-1 text-[11px] font-medium text-brand">
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
                    disabled={processing || attemptLocked}
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

            {/* [2C] Contained Custom Tenders, Single Fixed-Height Loyalty Wallet & Equal/Item Split */}
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
              {customMethods.length > 0 && (
                <div className="max-h-[152px] shrink-0 space-y-2 overflow-y-auto pe-0.5">
                  {payments.map((payment, idx) => {
                    if (payment.payment_method_id === undefined) return null;
                    const label = tenderLabel(payment);
                    const active = (parseFloat(payment.amount) || 0) > 0;
                    const isAppliedShare = appliedEqualShare?.index === idx;
                    return (
                      <div key={`custom:${payment.payment_method_id}`} className="space-y-0.5">
                        <div className="flex min-h-12">
                          <button
                            type="button"
                            title={label}
                            disabled={processing || attemptLocked}
                            onClick={() => {
                              if (attemptLocked) return;
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
                              disabled={processing || attemptLocked}
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
                        {isAppliedShare && (
                          <p className="px-1 text-[11px] font-medium text-brand">
                            {t('equalShareBadge')}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {loyaltySettings?.loyalty_enabled && effectiveCustomerId && (
                <div className="flex h-[74px] shrink-0 flex-col justify-between">
                  <div className="flex min-h-12">
                    <button
                      type="button"
                      disabled={processing || attemptLocked || !walletBalance || walletBalance <= 0}
                      onClick={() => {
                        if (attemptLocked || !walletBalance) return;
                        const allocatedElsewhere = payments.reduce(
                          (sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0),
                          0,
                        );
                        const maxWalletStored = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
                        const dueStored = Math.min(
                          maxWalletStored,
                          Math.max(0, remaining - allocatedElsewhere),
                        );
                        const dueDisplay = toDisplayUnit(dueStored);
                        setWalletAmount(dueDisplay > 0 ? String(dueDisplay) : '');
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
                        disabled={
                          processing || attemptLocked || !walletBalance || walletBalance <= 0
                        }
                        onFocus={() => setAmountTarget({ kind: 'wallet' })}
                        onChange={(e) => {
                          if (attemptLocked) return;
                          const v = e.target.value;
                          const maxWalletCurrencyStored = Math.floor(
                            (walletBalance || 0) / LOYALTY_REDEMPTION_RATE,
                          );
                          const maxDisplay = toDisplayUnit(
                            Math.min(maxWalletCurrencyStored, remaining),
                          );
                          const clamped = parseFloat(v) > maxDisplay ? String(maxDisplay) : v;
                          setWalletAmount(clamped);
                          setAutoFilledSingleIndex(null);
                          setPaymentsTouched(true);
                        }}
                        placeholder="0.00"
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

              {/* Unified Split section (contained internally so even 20 Equal Share rows never grow Column 2) */}
              {!justPaid && (remainingMinor > 0 || hasSplitChecksPanel) && (
                <div
                  className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border"
                  data-testid="unified-split-card"
                >
                  {hasSplitChecksPanel ? (
                    <button
                      type="button"
                      onClick={() => setSplitSectionCollapsed((collapsed) => !collapsed)}
                      aria-expanded={!splitSectionCollapsed}
                      className="touch-target w-full shrink-0 justify-between gap-3 bg-muted px-3 text-start"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <Users size={15} className="text-muted-foreground" />
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
                      className="touch-target w-full shrink-0 justify-between gap-3 bg-muted px-3 text-start"
                    >
                      <span className="text-sm font-medium text-foreground">
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
                        <div className="grid grid-cols-2 gap-1 border-t border-border bg-muted/60 p-1">
                          <button
                            type="button"
                            aria-pressed={!showEqualShare}
                            data-testid="split-mode-items-tab"
                            onClick={() => setShowEqualShare(false)}
                            className={`min-h-11 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                              !showEqualShare
                                ? 'bg-card text-foreground shadow-sm'
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
                                ? 'bg-card text-foreground shadow-sm'
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
                          className="border-t border-border bg-muted px-3 py-2 text-[11px] text-muted-foreground"
                        >
                          {t(
                            equalShareNotice === 'lastPayer'
                              ? 'equalShareLastPayer'
                              : 'equalShareInvalidated',
                          )}
                        </p>
                      )}

                      {showEqualShare && remainingMinor > 0 ? (
                        <div className="space-y-2 border-t border-border bg-muted p-2.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <label
                              htmlFor="equal-share-payers"
                              className="text-xs font-medium text-foreground sm:text-sm"
                            >
                              {t('equalSharePayers')}
                            </label>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                aria-label={t('decreasePax')}
                                data-testid="equal-share-decrement"
                                disabled={!canDecrementEqualShare}
                                onClick={() => stepEqualSharePayers(-1)}
                                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-muted disabled:opacity-40"
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
                                disabled={processing || attemptLocked}
                                onChange={(event) => {
                                  if (attemptLocked) return;
                                  setEqualSharePayers(event.target.value);
                                }}
                                className="min-h-11 w-14 rounded-lg border border-border bg-card px-2 py-1 text-center text-sm font-semibold tabular-nums outline-none focus:ring-2 focus:ring-brand"
                              />
                              <button
                                type="button"
                                aria-label={t('increasePax')}
                                data-testid="equal-share-increment"
                                disabled={!canIncrementEqualShare}
                                onClick={() => stepEqualSharePayers(1)}
                                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-muted disabled:opacity-40"
                              >
                                <Plus size={15} />
                              </button>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {[2, 3, 4].map((preset) => {
                              const activePreset = equalShareCount === preset;
                              return (
                                <button
                                  key={preset}
                                  type="button"
                                  aria-pressed={activePreset}
                                  data-testid={`equal-share-preset-${preset}`}
                                  disabled={processing || attemptLocked}
                                  onClick={() => {
                                    if (attemptLocked) return;
                                    setEqualSharePayers(String(preset));
                                  }}
                                  className={`min-h-9 min-w-10 rounded-lg border px-2.5 py-1 text-xs font-semibold tabular-nums transition-colors disabled:opacity-40 ${
                                    activePreset
                                      ? 'border-brand bg-brand text-white'
                                      : 'border-border bg-card text-foreground hover:border-brand hover:text-brand'
                                  }`}
                                >
                                  {preset}
                                </button>
                              );
                            })}
                          </div>
                          {equalShareError ? (
                            <p role="alert" className="text-[11px] text-red-700 dark:text-red-300">
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
                                className="max-h-[104px] space-y-1 overflow-y-auto pe-0.5 text-sm"
                              >
                                {equalShareShares.map((shareMinor, index) => (
                                  <li
                                    key={index}
                                    className="flex items-center justify-between gap-2"
                                  >
                                    <span className="text-muted-foreground">
                                      {index + 1}
                                      {index === 0 && (
                                        <span className="ms-2 text-[11px] font-medium text-brand">
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
                                <li className="flex items-center justify-between gap-2 border-t border-border pt-1 font-semibold">
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
                                <p className="text-[11px] text-amber-700 dark:text-amber-300">
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
                                    variant="outline"
                                    size="sm"
                                    className="min-h-10"
                                    disabled={processing || attemptLocked}
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
                          <div className="border-t border-border bg-card p-3">
                            {splitSettingState === 'error' ? (
                              <div className="w-full space-y-2" data-testid="split-check-section">
                                <p className="text-xs text-amber-600 dark:text-amber-400">
                                  {splitSettingDenied
                                    ? t('splitCheckSettingDenied')
                                    : t('splitCheckAvailabilityFailed')}
                                </p>
                                <Button
                                  type="button"
                                  variant="outline"
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
                                    {t('splitCheck')}
                                  </Button>
                                ) : 'unknown' in splitEligibility ? (
                                  <Button
                                    variant="outline"
                                    onClick={handleOpenSplitCheck}
                                    disabled={
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
                                    <p className="text-xs text-amber-600 dark:text-amber-400">
                                      {t(splitEligibility.reason)}
                                    </p>
                                  </div>
                                )}
                                {splitOpenReason && (
                                  <p className="text-xs text-red-600 dark:text-red-400">
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
          <div className="flex min-h-0 min-w-0 flex-col bg-muted/30 p-3 sm:p-4 lg:overflow-hidden">
            {justPaid ? (
              <div className="flex h-full flex-col justify-center space-y-3">
                <div
                  role="status"
                  className="space-y-1 rounded-xl border border-border bg-card p-5 text-center"
                >
                  <CheckCircle2 className="mx-auto text-emerald-600" size={36} />
                  <p className="font-semibold text-foreground">{t('paymentRecorded')}</p>
                  <p className="text-2xl font-bold tabular-nums text-foreground">
                    {currencyFmt(paidAmount ?? Math.min(totalPayment, remaining))}
                  </p>
                  <p className="text-sm text-muted-foreground">{t('paid')}</p>
                </div>
                {cartCustomer?.phone &&
                  (isWhatsAppReady ? (
                    <Button
                      onClick={handleSendWhatsApp}
                      disabled={sendingWa}
                      className="min-h-11 w-full bg-emerald-600 hover:bg-emerald-700"
                      size="lg"
                    >
                      <Send size={16} className="me-2" />
                      {sendingWa ? t('processingPayment') : t('sendViaWhatsApp')}
                    </Button>
                  ) : (
                    <Button
                      onClick={handleShareWhatsApp}
                      variant="outline"
                      className="min-h-11 w-full"
                      size="lg"
                    >
                      <Send size={16} className="me-2" />
                      {tCommon('shareViaWhatsApp')}
                    </Button>
                  ))}
                <Button onClick={onPaid} variant="outline" className="min-h-11 w-full" size="lg">
                  {tCommon('done')}
                </Button>
              </div>
            ) : (
              <CheckoutPaymentStation
                readout={{
                  activeLabel: activeAmountLabel,
                  amountText: readoutFormattedAmount,
                  paidSummaryText: `${t('paid')}: ${currencyFmt(totalPayment)}`,
                  dueSummaryText: `${t('total')}: ${currencyFmt(remaining)}`,
                  statusPillText:
                    totalPaymentMinor >= remainingMinor && remainingMinor > 0
                      ? t('paid')
                      : undefined,
                  statusTone: readoutStatusTone,
                }}
                quickTenders={quickTenderOptions}
                keypad={
                  <fieldset disabled={processing || attemptLocked || justPaid} className="h-full">
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
                  className="h-11 w-full shrink-0 rounded-xl text-base font-semibold transition-colors sm:h-12"
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
              className="min-h-11 w-full rounded-lg border border-border bg-card px-3 py-2"
            />
            <div className="flex gap-2">
              <Button
                data-testid="charge-approval-cancel"
                variant="outline"
                className="min-h-11 flex-1"
                onClick={() => {
                  setChargeApprovalId(null);
                  setChargeApprovalPin('');
                }}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                data-testid="charge-approval-submit"
                className="min-h-11 flex-1"
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
