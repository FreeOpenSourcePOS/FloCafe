'use client';

import { classifyTransportFailure } from '@/lib/transport-failure';
import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useSidebar } from '@/components/ui/sidebar';
import toast from 'react-hot-toast';
import { ShoppingCart, X } from 'lucide-react';
import type {
  Addon,
  Category,
  Product,
  ProductVariant,
  Table,
  Bill,
  Order,
  CartItem,
} from '@/lib/types';
import { cartItemToOrderItem } from '@/lib/cart-order-item';
import { useConfirm } from '@/hooks/use-confirm';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';

import ProductGrid from '@/components/pos/ProductGrid';
import CartPanel from '@/components/pos/CartPanel';
import AddonModal from '@/components/pos/AddonModal';
import CustomerSearch from '@/components/pos/CustomerSearch';
import TablePickerModal from '@/components/pos/TablePickerModal';
import TableCheckoutModal from '@/components/pos/TableCheckoutModal';
import PaymentModal from '@/components/pos/PaymentModal';
import PrepaidCheckoutModal, {
  type PrepaidPayment,
  type PrepaidDiscount,
} from '@/components/pos/PrepaidCheckoutModal';
import PosTopbar from '@/components/pos/PosTopbar';
import ScheduledOrdersDrawer from '@/components/pos/ScheduledOrdersDrawer';
import { PaymentQueueDrawer } from '@/components/pos/PaymentQueueDrawer';
import { PaymentTicketConfirmationModal } from '@/components/pos/PaymentTicketConfirmationModal';
import type { Counter } from '@/lib/types';
import { canPayScheduledOrder, isPayableBill } from '@/lib/order-payment-state';
import RefundModal from '@/components/orders/RefundModal';
import { formatScheduledInstantForDisplay, parseScheduledForInput } from '@/lib/scheduled-time';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ShiftOpenModal } from '@/components/dashboard/ShiftOpenModal';
import { ShiftCloseModal } from '@/components/dashboard/ShiftCloseModal';
import { useCashSession } from '@/hooks/useCashSession';
import { usePosSortPreference } from '@/hooks/usePosSort';
import { tenantCan } from '@/lib/permissions';
import { CashDrawerMovementModal } from '@/components/dashboard/CashDrawerMovementModal';
import { useCashDrawerMovements } from '@/hooks/useCashDrawerMovements';
import { isPrintCancelledOnTenantChangeError, usePrinterStore } from '@/hooks/usePrinter';
import { printerService } from '@/lib/printer/PrinterService';
import { showPrintWarningsToast } from '@/lib/printer/warnings-toast';
import { formatKotErrorToast, formatReceiptErrorToast } from '@/lib/printer/warnings';
import { AI_HELP_PROVIDERS, copyPrinterDiagnostic } from '@/lib/printer/ai-help';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { usePosKeyboardShortcuts } from '@/hooks/usePosKeyboardShortcuts';
import KeyboardShortcutsModal from '@/components/pos/KeyboardShortcutsModal';
import { dispatchQuickSearchRequest } from '@/lib/quick-search';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useSupportTicketStatus } from '@/hooks/useSupportTicketStatus';
import {
  captureClientOperationFailure,
  createOperationReference,
  operationHeaders,
} from '@/lib/api';
import { getCurrencySymbol, getCountryByCode } from '@/lib/countries';
import { resolveScannedProduct } from '@/lib/scale-barcode';
import { productNeedsCustomizer, scannedVariantNeedsCustomizer } from '@/lib/product-variants';
import { fractionalQuantityStep, roundToQuantityPrecision } from '@/lib/utils';
import {
  buildAppendItemsFingerprint,
  clearAppendAttempt,
  createSafeAppendAttemptStorage,
  getAppendAttemptStorageKey,
  getOrCreateAppendAttempt,
  LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY,
  getPostpaidOrderAttemptStorageKey,
  migrateLegacyAppendAttempt,
  readAppendAttempt,
  type AppendAttempt,
  type AppendAttemptStorage,
} from '@/lib/append-attempt';
import {
  PREPAID_ATTEMPT_STORAGE_KEY,
  OrderAttemptStorageError,
  classifyOrderRequestFailure,
  clearOrderAttempt,
  doesAttemptMatchStore,
  fingerprintsMatchAcrossScheduleToggle,
  getPrepaidOrderAttemptStorageKey,
  getScheduleRejectionCode,
  isDefinitiveScheduleRejection,
  isSupportedFailureOperation,
  normalizeAttemptStoreId,
  parseStoredAttemptScheduledFor,
  persistOrderAttempt,
  readOrderAttempt,
  resolveCartScheduledForAfterSettingRead,
  resolveRetryScheduledFor,
  buildCartFingerprintFromState,
} from '@/lib/order-attempt';
import {
  buildPosSupportTicketRequestBody,
  buildPrinterOperationFailureSupportPayload,
  isOperationReference,
  isSupportErrorContextCurrent,
  readBoundedSupportLogTail,
  resolvePosFailureSupportMetadata,
  resolvePosValidationAction,
  type PosFailureSupportMetadata,
  type SupportErrorContextSnapshot,
} from '@/lib/operation-failure';

// Loaded on demand: the menu printer pulls the thermal print kernel in, which the
// POS has no use for until the merchant opens the dialog.
const PrintMenuModal = dynamic(() => import('@/components/products/PrintMenuModal'), {
  ssr: false,
});

const POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';

interface PostpaidAttempt {
  userId: string;
  storeId?: string;
  fingerprint: string;
  idempotencyKey: string;
  operationId?: string;
  order?: Order;
}

interface PrepaidAttempt {
  userId: string;
  storeId?: string;
  cartFingerprint: string;
  paymentFingerprint: string;
  discount: PrepaidDiscount | null;
  order?: Order;
  bill?: Bill;
  orderIdempotencyKey: string;
  paymentIdempotencyKey: string;
  operationId?: string;
}

interface PrepaidPaymentRequest {
  payments: Array<{
    method: string;
    payment_method_id?: number;
    amount: number;
    transaction_id?: string;
  }>;
  customer_id: string | number | null;
}

type SupportOperationFailure = {
  capture_point: string;
  operation_id: string;
  outcome: string;
  facts?: {
    display_code?: string;
    failure_class?: string;
    kind?: string;
    connection_type?: string;
    stock_scope?: string;
    stock_shortfall?: string;
  };
};

const STRUCTURED_HELP_CAPTURE_POINTS: Record<string, string> = {
  'order.create:validation:order.quantity_invalid': 'fc.backend.order.create.quantity_validation',
  'order.create:validation:order.stock_insufficient': 'fc.backend.order.create.stock_validation',
  'order.create:validation:order.addon_selection_required':
    'fc.backend.order.create.addon_group_validation',
  'order.create:validation:order.addon_unavailable':
    'fc.backend.order.create.addon_item_validation',
  'order.create:validation:validation.rejected': 'fc.backend.order.create.other_validation',
  'order.create:persistence:persistence.failed': 'fc.backend.order.create.persistence',
  'order.create:persistence:server.internal_error': 'fc.backend.order.create.server_error',
  'order.create:completion:operation.completion_failed': 'fc.backend.order.create.completion',
  'order.create:retry_state:order.retry_state_failed': 'fc.client.order.create.retry_state_update',
  'order.create:cleanup:order.held_state.cleanup_failed':
    'fc.frontend.pos.order.create.held_cleanup',
  'order.append:validation:validation.rejected': 'fc.backend.order.append.validation',
  'order.append:persistence:persistence.failed': 'fc.backend.order.append.persistence',
  'order.append:completion:operation.completion_failed': 'fc.backend.order.append.completion',
  'payment.create:retry_state:payment.retry_state_failed':
    'fc.client.payment.create.retry_state_update',
  'payment.create:cleanup:order.held_state.cleanup_failed':
    'fc.frontend.pos.payment.create.held_cleanup',
  'order.discount:validation:discount.rejected': 'fc.backend.order.discount.validation',
  'order.discount:persistence:persistence.failed': 'fc.backend.order.discount.persistence',
  'order.discount:completion:operation.completion_failed': 'fc.backend.order.discount.completion',
  'bill.discount:validation:discount.rejected': 'fc.backend.bill.discount.validation',
  'bill.discount:persistence:persistence.failed': 'fc.backend.bill.discount.persistence',
  'bill.discount:completion:operation.completion_failed': 'fc.backend.bill.discount.completion',
  'payment.create:validation:payment.invalid': 'fc.backend.payment.create.validation',
  'payment.create:persistence:persistence.failed': 'fc.backend.payment.create.persistence',
  'payment.create:completion:operation.completion_failed': 'fc.backend.payment.create.completion',
  'bill.generate:validation:bill.order_unavailable': 'fc.backend.bill.generate.validation',
  'bill.generate:persistence:persistence.failed': 'fc.backend.bill.generate.failure',
  'bill.generate:completion:operation.completion_failed': 'fc.backend.bill.generate.completion',
  'bill.generate:retry_state:bill.retry_state_failed': 'fc.client.bill.generate.retry_state_update',
  'bill.charge.update:validation:bill.charge_rejected': 'fc.backend.bill.charge.validation',
  'bill.charge.update:persistence:persistence.failed': 'fc.backend.bill.charge.persistence',
  'bill.charge.update:completion:operation.completion_failed': 'fc.backend.bill.charge.completion',
};

/** A stored attempt missing any of these is damaged, not absent: replacing it
 * with a fresh idempotency key could duplicate an order whose response was lost. */
const isUsablePostpaidAttempt = (attempt: PostpaidAttempt): boolean =>
  typeof attempt.fingerprint === 'string' && !!attempt.idempotencyKey;

const isUsablePrepaidAttempt = (attempt: PrepaidAttempt): boolean =>
  typeof attempt.cartFingerprint === 'string' &&
  typeof attempt.paymentFingerprint === 'string' &&
  !!attempt.orderIdempotencyKey &&
  !!attempt.paymentIdempotencyKey;

const parsePrepaidPaymentRequest = (serialized: string): PrepaidPaymentRequest | null => {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'customer_id,payments' ||
      !Array.isArray(record.payments) ||
      record.payments.length === 0 ||
      (record.customer_id !== null &&
        typeof record.customer_id !== 'string' &&
        typeof record.customer_id !== 'number')
    )
      return null;
    const payments: PrepaidPaymentRequest['payments'] = [];
    for (const line of record.payments) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
      const payment = line as Record<string, unknown>;
      const keys = Object.keys(payment).sort().join(',');
      if (
        ![
          'amount,method',
          'amount,method,payment_method_id',
          'amount,method,transaction_id',
          'amount,method,payment_method_id,transaction_id',
        ].includes(keys) ||
        typeof payment.method !== 'string' ||
        payment.method.length === 0 ||
        typeof payment.amount !== 'number' ||
        !Number.isFinite(payment.amount) ||
        payment.amount <= 0 ||
        (payment.payment_method_id !== undefined &&
          typeof payment.payment_method_id !== 'number') ||
        (payment.transaction_id !== undefined && typeof payment.transaction_id !== 'string')
      )
        return null;
      payments.push({
        method: payment.method,
        ...(payment.payment_method_id !== undefined
          ? { payment_method_id: payment.payment_method_id as number }
          : {}),
        amount: payment.amount,
        ...(payment.transaction_id !== undefined
          ? { transaction_id: payment.transaction_id as string }
          : {}),
      });
    }
    return { payments, customer_id: record.customer_id as string | number | null };
  } catch {
    return null;
  }
};

export default function POSPage() {
  const { currentTenant, user, token } = useAuthStore();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const {
    customerMandatory,
    autoPrintKot,
    autoPrintBill,
    billingType,
    tablesRequired,
    kotPrintingEnabled,
    setBillingType,
    setTablesRequired,
    setKotPrintingEnabled,
    setAutoPrintKot,
    setPrinterUseUnicode,
    setPrinterArabicShaping,
  } = usePosSettingsStore();
  const { open: leftSidebarOpen } = useSidebar();
  const t = useTranslations('pos');
  const tSettings = useTranslations('settings');
  const tExpenses = useTranslations('expenses');
  const tCommon = useTranslations('common');
  const tSupport = useTranslations('support');
  const currencyFmt = useFormatCurrency();
  const { confirm, ConfirmDialog, isConfirmOpen } = useConfirm();
  const cashDrawer = useCashDrawerMovements();
  const shift = useCashSession();
  // Shift actions follow the same owner/manager/cashier group as the
  // backend route gates (backend still enforces; this only hides the entry).
  const canUseShift = tenantCan(currentTenant, 'cash.shifts.view');

  const { categorySort, itemSort } = usePosSortPreference();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPrintMenuModal, setShowPrintMenuModal] = useState(false);

  // Modal state
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [addonProduct, setAddonProduct] = useState<Product | null>(null);
  const [addonInitialQuantity, setAddonInitialQuantity] = useState(1);
  // The variant a scanned barcode named, preselected in the customizer.
  const [addonInitialVariant, setAddonInitialVariant] = useState<ProductVariant | null>(null);
  const [editingCartItem, setEditingCartItem] = useState<CartItem | null>(null);
  const [checkoutTable, setCheckoutTable] = useState<Table | null>(null);
  const [paymentBill, setPaymentBill] = useState<Bill | null>(null);
  const [checkoutOverridePin, setCheckoutOverridePin] = useState<string | undefined>();
  const [showCustomerPrompt, setShowCustomerPrompt] = useState(false);
  const [topbarCustomerModalOpen, setTopbarCustomerModalOpen] = useState(false);
  const [promptCustomerModalOpen, setPromptCustomerModalOpen] = useState(false);
  const customerModalOpen = topbarCustomerModalOpen || promptCustomerModalOpen;
  const [cartPanelModalOpen, setCartPanelModalOpen] = useState(false);
  const [showPrepaidCheckout, setShowPrepaidCheckout] = useState(false);
  const [prepaidModalAttempt, setPrepaidModalAttempt] = useState<PrepaidAttempt | null>(null);
  const [cardTransactionIdRequired, setCardTransactionIdRequired] = useState(false);
  const [showKeyboardShortcutsModal, setShowKeyboardShortcutsModal] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);
  const [storeTimezone, setStoreTimezone] = useState<string>(currentTenant?.timezone || 'UTC');
  const [scheduledOrders, setScheduledOrders] = useState<Order[]>([]);
  const [nextScheduledCursor, setNextScheduledCursor] = useState<string | null>(null);
  const [scheduledCount, setScheduledCount] = useState<number>(0);
  const [blockedScheduledCount, setBlockedScheduledCount] = useState<number>(0);
  const [loadingMoreScheduled, setLoadingMoreScheduled] = useState(false);
  const [showScheduledOrders, setShowScheduledOrders] = useState(false);
  const [scheduledOrdersEnabled, setScheduledOrdersEnabled] = useState(false);
  const [refundModalTarget, setRefundModalTarget] = useState<{
    order: Order;
    bills: Bill[];
  } | null>(null);

  // Multi-counter ordering states
  const [multiCounterEnabled, setMultiCounterEnabled] = useState(false);
  const [counters, setCounters] = useState<Counter[]>([]);
  const [activeCounter, setActiveCounter] = useState<Counter | null>(null);
  const [showPaymentQueue, setShowPaymentQueue] = useState(false);
  const [paymentQueueCount, setPaymentQueueCount] = useState(0);
  const [paymentQueueBlockedCount, setPaymentQueueBlockedCount] = useState(0);
  const [paymentQueueRefreshKey, setPaymentQueueRefreshKey] = useState(0);
  const [showTicketModal, setShowTicketModal] = useState(false);
  const [ticketModalOrder, setTicketModalOrder] = useState<Order | null>(null);
  const [ticketModalQrDataUrl, setTicketModalQrDataUrl] = useState<string | null>(null);
  const [ticketModalQrPayload, setTicketModalQrPayload] = useState<string | null>(null);
  const isSendingToPaymentRef = useRef(false);
  useEffect(() => {
    if (currentTenant?.timezone) {
      setStoreTimezone(currentTenant.timezone);
    }
  }, [currentTenant?.timezone]);
  const [supportError, setSupportError] = useState<{
    title: string;
    subject: string;
    code: string;
    message: string;
    nextStep: string;
    operation: string;
    stage: string;
    outcome: string;
    classification?: string;
    reasonCode?: string;
    displayCode?: string;
    correlationId?: string;
    operationFailure?: SupportOperationFailure;
    ticketCorrelationId: string;
    clientTicketId: string;
    context: SupportErrorContextSnapshot;
    presentation: PosFailureSupportMetadata;
    payload: Record<string, unknown>;
  } | null>(null);
  const [attachLog, setAttachLog] = useState(true);
  const supportLogSnapshotRef = useRef<{
    clientTicketId: string;
    logTail: string | undefined;
  } | null>(null);
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const supportSubmitTokenRef = useRef<symbol | null>(null);
  const [sentTicketId, setSentTicketId] = useState<string | null>(null);
  const delivery = useSupportTicketStatus(sentTicketId);
  const activeUserId = user?.id == null ? null : String(user.id);
  const activeToken = token ?? null;
  const currentStoreId = currentTenant?.id || 'default';
  const currentStoreIdRef = useRef(currentStoreId);
  currentStoreIdRef.current = currentStoreId;
  const initialStoreIdRef = useRef<string | number>(currentStoreId);
  if (initialStoreIdRef.current === 'default' && currentTenant?.id != null) {
    initialStoreIdRef.current = currentTenant.id;
  }
  const sessionEpochRef = useRef(0);
  const lastActiveSessionRef = useRef<{ userId: string | null; token: string | null }>({
    userId: activeUserId,
    token: activeToken,
  });
  const activeSubmissionTokenRef = useRef<symbol | null>(null);

  const readStoredAuthToken = (): string | null => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
    } catch {
      return null;
    }
  };
  const readLiveSupportContext = () => {
    const authState =
      typeof useAuthStore.getState === 'function'
        ? useAuthStore.getState()
        : { currentTenant, user, token };
    const liveTenantId = authState.currentTenant?.id ?? currentTenant?.id;
    if (initialStoreIdRef.current === 'default' && liveTenantId != null) {
      initialStoreIdRef.current = liveTenantId;
    }
    const liveUserId = authState.user?.id == null ? null : String(authState.user.id);
    const liveToken = authState.token ?? readStoredAuthToken();
    return {
      storeId: String(liveTenantId || currentStoreId),
      initialStoreId: initialStoreIdRef.current,
      userId: liveUserId,
      token: liveToken,
      sessionEpoch: sessionEpochRef.current,
    };
  };
  const clearSupportErrorState = () => {
    supportSubmitTokenRef.current = null;
    setSupportSubmitting(false);
    setSupportError(null);
    setSentTicketId(null);
    supportLogSnapshotRef.current = null;
  };

  useEffect(() => {
    if (
      lastActiveSessionRef.current.userId === activeUserId &&
      lastActiveSessionRef.current.token === activeToken
    ) {
      return;
    }
    lastActiveSessionRef.current = { userId: activeUserId, token: activeToken };
    sessionEpochRef.current += 1;
    activeSubmissionTokenRef.current = null;
    isSendingToPaymentRef.current = false;
    setSubmitting(false);
    supportSubmitTokenRef.current = null;
    setSupportSubmitting(false);
    setSupportError(null);
    setSentTicketId(null);
    supportLogSnapshotRef.current = null;

    setCheckoutOverridePin(undefined);
    setPaymentBill(null);
    setCheckoutTable(null);
    setPendingOrder(null);
    setShowPrepaidCheckout(false);
    setPrepaidModalAttempt(null);
    setShowScheduledOrders(false);
    setRefundModalTarget(null);
    cashDrawer.setOpen(false);
    shift.setOpenModalOpen(false);
    shift.setCloseModalOpen(false);
  }, [activeUserId, activeToken, cashDrawer, shift]);

  useEffect(() => {
    if (!supportError) return;
    if (!isSupportErrorContextCurrent(supportError.context, readLiveSupportContext())) {
      clearSupportErrorState();
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [supportError, currentStoreId, activeUserId, activeToken]);

  const pinnedAuthHeaders = (authToken: string | null): Record<string, string> =>
    authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const checkSessionCurrent = (originContext: SupportErrorContextSnapshot): boolean => {
    return isSupportErrorContextCurrent(originContext, readLiveSupportContext());
  };
  const prepaidAttemptRef = useRef<PrepaidAttempt | null>(null);
  const prepaidAttemptKeyRef = useRef<string | null>(null);
  const postpaidAttemptRef = useRef<PostpaidAttempt | null>(null);
  const postpaidAttemptKeyRef = useRef<string | null>(null);
  const postpaidAttemptWasLegacyRef = useRef(false);
  const addItemsAttemptRef = useRef<AppendAttempt | null>(null);
  const appendRecoveryStartedUsersRef = useRef<Set<string>>(new Set());
  const appendAttemptStorageRef = useRef<AppendAttemptStorage | null>(null);

  const getAppendAttemptStorage = (): AppendAttemptStorage => {
    if (appendAttemptStorageRef.current) return appendAttemptStorageRef.current;
    let browserStorage: AppendAttemptStorage | null = null;
    let sessionStorage: AppendAttemptStorage | null = null;
    try {
      if (typeof window !== 'undefined') browserStorage = window.localStorage;
    } catch {
      // Private/restricted renderers may throw while reading localStorage.
    }
    try {
      if (typeof window !== 'undefined') sessionStorage = window.sessionStorage;
    } catch {
      // Session storage may also be restricted.
    }
    appendAttemptStorageRef.current = createSafeAppendAttemptStorage(
      browserStorage,
      sessionStorage,
    );
    return appendAttemptStorageRef.current;
  };

  const createFreshAppendAttemptStorage = (): AppendAttemptStorage => {
    let browserStorage: AppendAttemptStorage | null = null;
    let sessionStorage: AppendAttemptStorage | null = null;
    try {
      if (typeof window !== 'undefined') browserStorage = window.localStorage;
    } catch {
      // Private/restricted renderers may throw while reading localStorage.
    }
    try {
      if (typeof window !== 'undefined') sessionStorage = window.sessionStorage;
    } catch {
      // Session storage may also be restricted.
    }
    return createSafeAppendAttemptStorage(browserStorage, sessionStorage);
  };

  const readPostpaidAttempt = (targetUserId?: string | null) => {
    if (typeof window === 'undefined') return null;
    const effectiveUserId = targetUserId || activeUserId;
    const storage = getAppendAttemptStorage();
    let sharedLegacyAppendRetained = false;
    try {
      const migratedAppend = migrateLegacyAppendAttempt(storage, {
        userId: effectiveUserId || undefined,
      });
      sharedLegacyAppendRetained =
        migratedAppend !== null && storage.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY) !== null;
    } catch {
      throw new OrderAttemptStorageError();
    }
    if (effectiveUserId === activeUserId && postpaidAttemptRef.current?.userId === activeUserId)
      return postpaidAttemptRef.current;
    if (effectiveUserId === activeUserId) {
      postpaidAttemptRef.current = null;
      postpaidAttemptKeyRef.current = null;
      postpaidAttemptWasLegacyRef.current = false;
    }
    if (effectiveUserId) {
      const userStorageKey = getPostpaidOrderAttemptStorageKey(effectiveUserId);
      const scoped = readOrderAttempt<PostpaidAttempt>(storage, userStorageKey, effectiveUserId, {
        isValid: isUsablePostpaidAttempt,
      });
      if (scoped) {
        if (effectiveUserId === activeUserId) {
          postpaidAttemptRef.current = scoped;
          postpaidAttemptKeyRef.current = userStorageKey;
        }
        return scoped;
      }
    }
    const legacy = sharedLegacyAppendRetained
      ? null
      : readOrderAttempt<PostpaidAttempt>(
          storage,
          POSTPAID_ATTEMPT_STORAGE_KEY,
          effectiveUserId || '',
          {
            sharedKey: true,
            isValid: isUsablePostpaidAttempt,
          },
        );
    if (legacy) {
      if (effectiveUserId === activeUserId) {
        postpaidAttemptRef.current = legacy;
        postpaidAttemptKeyRef.current = POSTPAID_ATTEMPT_STORAGE_KEY;
        postpaidAttemptWasLegacyRef.current = true;
      }
      return legacy;
    }
    return null;
  };
  /** Only advance the in-memory attempt after a verified write: keys that never
   * reached a backend must not be executed from memory either. */
  const savePostpaidAttempt = (attempt: PostpaidAttempt, targetUserId?: string | null): boolean => {
    const previous = postpaidAttemptRef.current;
    const effectiveUserId = targetUserId || attempt.userId || activeUserId;
    if (!effectiveUserId) return false;
    const storageKey = getPostpaidOrderAttemptStorageKey(effectiveUserId);
    const attemptWithStore: PostpaidAttempt = {
      ...attempt,
      storeId: normalizeAttemptStoreId(attempt.storeId) || String(currentStoreIdRef.current),
    };
    try {
      persistOrderAttempt(getAppendAttemptStorage(), storageKey, attemptWithStore);
    } catch {
      if (effectiveUserId === activeUserId) {
        postpaidAttemptRef.current = previous;
      }
      return false;
    }
    if (effectiveUserId === activeUserId) {
      postpaidAttemptRef.current = attemptWithStore;
      postpaidAttemptKeyRef.current = storageKey;
    }
    return true;
  };
  const clearPostpaidAttempt = (targetUserId?: string | null) => {
    const effectiveUserId = targetUserId || activeUserId;
    const completedAttempt =
      (effectiveUserId === activeUserId ? postpaidAttemptRef.current : null) ||
      readPostpaidAttempt(effectiveUserId);
    const storageKeys = [
      effectiveUserId ? getPostpaidOrderAttemptStorageKey(effectiveUserId) : null,
      (effectiveUserId === activeUserId && postpaidAttemptWasLegacyRef.current) || !effectiveUserId
        ? POSTPAID_ATTEMPT_STORAGE_KEY
        : null,
    ];
    if (!completedAttempt) {
      if (effectiveUserId === activeUserId) {
        postpaidAttemptKeyRef.current = null;
        postpaidAttemptWasLegacyRef.current = false;
      }
      return true;
    }
    const storage = getAppendAttemptStorage();
    let cleared = true;
    for (const storageKey of storageKeys) {
      // The order is already placed: report a cleanup problem without turning a
      // completed sale into a failure.
      if (storageKey && !clearOrderAttempt(storage, storageKey, completedAttempt)) {
        console.error('Failed to close the postpaid retry attempt after the order was placed');
        cleared = false;
      }
    }
    if (cleared && effectiveUserId === activeUserId) {
      postpaidAttemptRef.current = null;
      postpaidAttemptKeyRef.current = null;
      postpaidAttemptWasLegacyRef.current = false;
    }
    return cleared;
  };

  const stripPrepaidDiscountPin = (attempt: PrepaidAttempt): PrepaidAttempt => {
    if (!attempt.discount) return attempt;
    if (!('override_pin' in attempt.discount) && !('approver_id' in attempt.discount))
      return attempt;
    const safeDiscount = { ...attempt.discount };
    delete safeDiscount.override_pin;
    delete safeDiscount.approver_id;
    return { ...attempt, discount: safeDiscount };
  };

  const readPrepaidAttempt = (targetUserId?: string | null): PrepaidAttempt | null => {
    const effectiveUserId = targetUserId || activeUserId;
    if (effectiveUserId === activeUserId && prepaidAttemptRef.current?.userId === activeUserId)
      return prepaidAttemptRef.current;
    if (effectiveUserId === activeUserId) {
      prepaidAttemptRef.current = null;
      prepaidAttemptKeyRef.current = null;
    }
    if (typeof window === 'undefined' || !effectiveUserId) return null;
    const storage = getAppendAttemptStorage();
    const scopedKey = getPrepaidOrderAttemptStorageKey(effectiveUserId);
    const scoped = readOrderAttempt<PrepaidAttempt>(storage, scopedKey, effectiveUserId, {
      isValid: isUsablePrepaidAttempt,
    });
    if (scoped) {
      const safeAttempt = stripPrepaidDiscountPin(scoped);
      if (safeAttempt !== scoped) {
        if (!savePrepaidAttempt(safeAttempt, effectiveUserId)) throw new OrderAttemptStorageError();
      } else if (effectiveUserId === activeUserId) {
        prepaidAttemptRef.current = safeAttempt;
        prepaidAttemptKeyRef.current = scopedKey;
      }
      return safeAttempt;
    }
    // Builds before user-scoped attempts shared one global prepaid record.
    // Adopt it only for its owner and leave a foreign record untouched: clearing
    // another cashier's pending retry is what forced fresh keys onto a request
    // that may already have committed.
    const legacy = readOrderAttempt<PrepaidAttempt>(
      storage,
      PREPAID_ATTEMPT_STORAGE_KEY,
      effectiveUserId,
      {
        sharedKey: true,
        isValid: isUsablePrepaidAttempt,
      },
    );
    if (!legacy) return null;
    const migrated = stripPrepaidDiscountPin(legacy);
    if (!savePrepaidAttempt(migrated, effectiveUserId)) throw new OrderAttemptStorageError();
    clearOrderAttempt(storage, PREPAID_ATTEMPT_STORAGE_KEY, migrated);
    return migrated;
  };
  const savePrepaidAttempt = (attempt: PrepaidAttempt, targetUserId?: string | null): boolean => {
    const previous = prepaidAttemptRef.current;
    const effectiveUserId = targetUserId || attempt.userId || activeUserId;
    if (!effectiveUserId) return false;
    const storageKey = getPrepaidOrderAttemptStorageKey(effectiveUserId);
    const safeAttempt: PrepaidAttempt = {
      ...stripPrepaidDiscountPin(attempt),
      storeId: normalizeAttemptStoreId(attempt.storeId) || String(currentStoreIdRef.current),
    };
    try {
      persistOrderAttempt(getAppendAttemptStorage(), storageKey, safeAttempt);
    } catch {
      if (effectiveUserId === activeUserId) {
        prepaidAttemptRef.current = previous;
      }
      return false;
    }
    if (effectiveUserId === activeUserId) {
      prepaidAttemptRef.current = safeAttempt;
      prepaidAttemptKeyRef.current = storageKey;
    }
    return true;
  };
  /** Intermediate prepaid states are persisted too: a request that runs under a
   * key the next run cannot replay can capture the same payment twice. */
  const requirePrepaidAttemptSaved = (attempt: PrepaidAttempt, targetUserId?: string | null) => {
    if (!savePrepaidAttempt(attempt, targetUserId)) throw new OrderAttemptStorageError();
  };
  const clearPrepaidAttempt = (targetUserId?: string | null) => {
    const effectiveUserId = targetUserId || activeUserId;
    const completedAttempt =
      (effectiveUserId === activeUserId ? prepaidAttemptRef.current : null) ||
      (effectiveUserId ? readPrepaidAttempt(effectiveUserId) : null);
    const storageKey = effectiveUserId
      ? getPrepaidOrderAttemptStorageKey(effectiveUserId)
      : prepaidAttemptKeyRef.current;
    if (!completedAttempt || !storageKey) {
      if (effectiveUserId === activeUserId) {
        prepaidAttemptRef.current = null;
        prepaidAttemptKeyRef.current = null;
      }
      return true;
    }
    // The payment is already captured: report a cleanup problem without turning
    // a completed sale into a failure.
    if (!clearOrderAttempt(getAppendAttemptStorage(), storageKey, completedAttempt)) {
      console.error('Failed to close the prepaid retry attempt after the payment was captured');
      return false;
    }
    if (effectiveUserId === activeUserId) {
      prepaidAttemptRef.current = null;
      prepaidAttemptKeyRef.current = null;
    }
    return true;
  };

  /** Keeps bounded operation facts for the deliberate help flow only. */
  const reportOrderFailure = (entry: {
    code: string;
    title: string;
    message: string;
    nextStep: string;
    detail: string;
    status: number | null;
    operation: string;
    stage: string;
    outcome: string;
    classification?: string;
    reasonCode?: string | null;
    displayCode?: string | null;
    correlationId?: string | null;
    operationFailure?: SupportOperationFailure;
    category?: string;
    subject?: string;
    extraDiagnostics?: Record<string, unknown>;
    suppressToast?: boolean;
    originContext?: SupportErrorContextSnapshot;
  }) => {
    const liveContext = readLiveSupportContext();
    const originContext = entry.originContext || liveContext;
    if (!isSupportErrorContextCurrent(originContext, liveContext)) {
      return;
    }
    const correlationId = isOperationReference(entry.correlationId)
      ? entry.correlationId
      : undefined;
    const ticketCorrelationId = correlationId || createOperationReference() || '';
    const clientTicketId = createOperationReference() || '';
    const presentation = resolvePosFailureSupportMetadata({
      operation: entry.operation,
      classification: entry.classification,
      outcome: entry.outcome,
      reasonCode: entry.reasonCode,
      displayCode: entry.displayCode,
      code: entry.code,
      message: entry.message,
      detail: entry.detail,
    });
    const subject = entry.subject || presentation.subject;
    const category = entry.category || presentation.category;
    const matchedOperationFailure =
      correlationId && entry.operationFailure?.operation_id === correlationId
        ? entry.operationFailure
        : undefined;
    supportSubmitTokenRef.current = null;
    setSupportSubmitting(false);
    setSentTicketId(null);
    setAttachLog(true);
    supportLogSnapshotRef.current = null;
    setSupportError({
      title: entry.title,
      subject,
      code: entry.code,
      message: entry.message,
      nextStep: entry.nextStep,
      operation: entry.operation,
      stage: entry.stage,
      outcome: entry.outcome,
      classification: entry.classification,
      reasonCode: entry.reasonCode || undefined,
      displayCode: entry.displayCode || undefined,
      correlationId,
      operationFailure: matchedOperationFailure,
      ticketCorrelationId,
      clientTicketId,
      context: {
        storeId: originContext.storeId,
        userId: originContext.userId,
        token: originContext.token,
        sessionEpoch: originContext.sessionEpoch,
      },
      presentation,
      payload: {
        event_code: entry.code,
        message: entry.detail,
        category,
        diagnostics: {
          operation: entry.operation,
          stage: entry.stage,
          outcome: entry.outcome,
          classification: entry.classification,
          reason_code: entry.reasonCode || entry.code,
          correlation_id: correlationId,
          http_status: entry.status,
          ...(entry.extraDiagnostics || {}),
        },
        ...(matchedOperationFailure ? { operation_failure: matchedOperationFailure } : {}),
      },
    });
    if (!entry.suppressToast) {
      toast.error(entry.message);
    }
  };

  const reportOrderStorageFailure = (
    title: string,
    operation: 'order.create' | 'payment.create' | 'order.append' = 'order.create',
    correlationId: string | null = null,
    originContext?: SupportErrorContextSnapshot,
  ) => {
    if (correlationId)
      void captureClientOperationFailure({ operation, phase: 'retry_storage', correlationId });
    const message = t('orderStorageUnavailable');
    reportOrderFailure({
      code:
        operation === 'payment.create'
          ? 'payment.retry_state.storage_unavailable'
          : operation === 'order.append'
            ? 'order.append.retry_state.storage_unavailable'
            : 'order.retry_state.storage_unavailable',
      title,
      message,
      nextStep: t('orderStorageNextStep'),
      detail: 'Retry state could not be persisted before the request was sent',
      status: null,
      operation,
      stage: 'local_storage',
      outcome: 'not_applied',
      correlationId,
      operationFailure: correlationId
        ? {
            capture_point:
              operation === 'payment.create'
                ? 'fc.frontend.pos.payment.create.retry_storage'
                : operation === 'order.append'
                  ? 'fc.frontend.pos.order.append.retry_storage'
                  : 'fc.frontend.pos.order.create.retry_storage',
            operation_id: correlationId,
            outcome: 'not_applied',
          }
        : undefined,
      originContext,
    });
  };

  const reportOrderRequestFailure = (
    error: unknown,
    title: string,
    operation: string,
    stage: string,
    correlationId: string | null,
    originContext?: SupportErrorContextSnapshot,
  ) => {
    const registeredOperation = isSupportedFailureOperation(operation) ? operation : 'order.create';
    const expectedReference = operation === registeredOperation ? correlationId || '' : '';
    const failure = classifyOrderRequestFailure(error, {
      operation: registeredOperation,
      correlationId: expectedReference,
    });
    const helpCapturePoint = failure.trusted
      ? STRUCTURED_HELP_CAPTURE_POINTS[
          `${failure.operation}:${failure.stage}:${failure.reasonCode}`
        ]
      : undefined;
    const hasResponse = !!(error as { response?: unknown } | null)?.response;
    const frontendTransportOperation =
      operation === 'order.create' ||
      operation === 'payment.create' ||
      operation === 'order.append';
    const failureClass = classifyTransportFailure(error);
    const clientFailurePhase =
      operation === 'order.append' && stage === 'recovery' ? 'recovery' : 'transport';
    const clientCapturePoint = `fc.frontend.pos.${operation}.${clientFailurePhase}`;
    if (!hasResponse && correlationId && frontendTransportOperation) {
      void captureClientOperationFailure({
        operation: operation as 'order.create' | 'payment.create' | 'order.append',
        phase: clientFailurePhase,
        correlationId,
        failureClass,
      });
    }
    const helpOperationFailure =
      !hasResponse && correlationId && frontendTransportOperation
        ? {
            capture_point: clientCapturePoint,
            operation_id: correlationId,
            outcome: 'unknown',
            ...(clientFailurePhase === 'transport'
              ? { facts: { failure_class: failureClass } }
              : {}),
          }
        : helpCapturePoint && failure.correlationId
          ? {
              capture_point: helpCapturePoint,
              operation_id: failure.correlationId,
              outcome: failure.outcome || 'unknown',
              ...(failure.displayCode
                ? { facts: { display_code: failure.displayCode } }
                : failure.failureClass
                  ? { facts: { failure_class: failure.failureClass } }
                  : failure.stockRefusal
                    ? { facts: failure.stockRefusal }
                    : {}),
            }
          : undefined;
    const reasonMessages: Record<string, string> = {
      'order.quantity_invalid': t('orderQuantityInvalid'),
      'order.stock_insufficient': t('orderStockInsufficient'),
      'validation.rejected': t('orderValidationRejected'),
      'bill.order_unavailable': t('operationNotSaved'),
      'payment.invalid': t('paymentValidationRejected'),
      'discount.rejected': t('operationCorrectAndRetry'),
    };
    const discountMessages: Record<string, string> = {
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
    const paymentMessages: Record<string, string> = {
      transaction_reference_used: t('paymentTransactionReferenceUsed'),
      transaction_reference_reused: t('paymentTransactionReferenceReused'),
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
      card_transaction_id_required: t('cardTransactionIdMissing'),
    };
    const confirmedNotApplied = failure.trusted && failure.outcome === 'not_applied';
    if (confirmedNotApplied && failure.displayCode === 'card_transaction_id_required') {
      setCardTransactionIdRequired(true);
    }
    const expectedRejection =
      confirmedNotApplied && failure.classification === 'expected_rejection';
    const confirmedNotSaved =
      confirmedNotApplied && failure.classification === 'unexpected_failure';
    const paymentRejection = expectedRejection && failure.reasonCode === 'payment.invalid';
    const appliedPayment =
      failure.trusted && failure.operation === 'payment.create' && failure.outcome === 'applied';
    const paymentNeedsStatusCheck =
      paymentRejection &&
      ['bill_refunded', 'bill_already_paid', 'idempotency_conflict'].includes(
        failure.displayCode || '',
      );
    const unknownMessage =
      operation === 'order.discount'
        ? t('discountOutcomeUnknown')
        : operation === 'bill.discount'
          ? t('discountOutcomeUnknown')
          : operation === 'bill.generate'
            ? t('billOutcomeUnknown')
            : operation === 'order.append'
              ? t('appendOutcomeUnknown')
              : t('operationOutcomeUnknown');
    const isAddonOrGeneralValidation =
      failure.reasonCode === 'order.addon_selection_required' ||
      failure.reasonCode === 'order.addon_unavailable' ||
      failure.reasonCode === 'order.stock_insufficient' ||
      failure.reasonCode === 'validation.rejected';
    const rejectionMessage =
      isAddonOrGeneralValidation && failure.serverError
        ? failure.serverError
        : failure.reasonCode
          ? reasonMessages[failure.reasonCode] ||
            failure.serverError ||
            t('operationOutcomeUnknown')
          : t('operationOutcomeUnknown');
    reportOrderFailure({
      code: failure.code,
      title,
      message: paymentRejection
        ? failure.displayCode
          ? paymentMessages[failure.displayCode] || t('paymentValidationRejected')
          : t('paymentValidationRejected')
        : expectedRejection && failure.reasonCode
          ? failure.reasonCode === 'discount.rejected' && failure.displayCode
            ? discountMessages[failure.displayCode] || t('operationOutcomeUnknown')
            : rejectionMessage
          : confirmedNotSaved
            ? t('operationNotSaved')
            : appliedPayment
              ? t('paymentCompletionApplied')
              : failure.outcome === 'unknown'
                ? unknownMessage
                : t('operationMayHaveCompleted'),
      nextStep: paymentNeedsStatusCheck
        ? t('operationCheckBeforeRetry')
        : paymentRejection
          ? t('paymentCorrectAndRetry')
          : expectedRejection
            ? t('operationCorrectAndRetry')
            : confirmedNotSaved
              ? t('operationNotSavedNextStep')
              : t('operationCheckBeforeRetry'),
      detail: failure.detail,
      status: failure.status,
      operation: registeredOperation,
      stage: failure.trusted
        ? failure.stage || stage
        : hasResponse && (stage === 'submission' || stage === 'order_submission')
          ? 'response_unconfirmed'
          : stage,
      outcome: failure.outcome || 'unknown',
      classification: failure.classification || undefined,
      reasonCode: failure.reasonCode,
      displayCode: failure.displayCode,
      correlationId,
      operationFailure: helpOperationFailure,
      originContext,
    });
  };
  const newIdempotencyKey = () =>
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const currency = getCurrencySymbol(
    currentTenant?.currency || '',
    getCountryByCode(currentTenant?.country ?? '')?.locale,
  );
  const { printBill, printKot } = usePrinterStore();
  const billingIsPrepaid = billingType === 'prepaid';
  const shouldTakePaymentNow = billingIsPrepaid;

  const printKotIfEnabled = async (order: Order, originContext?: SupportErrorContextSnapshot) => {
    const origin = originContext || readLiveSupportContext();
    if (order.release_status && order.release_status !== 'released') return;
    if (!isSupportErrorContextCurrent(origin, readLiveSupportContext())) {
      return;
    }
    // Master kot_printing_enabled check gates both manual and automatic prints.
    if (!kotPrintingEnabled) return;
    if (!autoPrintKot) return;

    try {
      const printWarnings = await printKot(order, order.items ? { items: order.items } : undefined);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      if (isPrintCancelledOnTenantChangeError(err)) return;
      if (!isSupportErrorContextCurrent(origin, readLiveSupportContext())) return;
      console.error('[POS] KOT print failed:', err);
      const printFailure = buildPrinterOperationFailureSupportPayload(err, {
        kind: 'kot',
        fallbackDetail: 'Kitchen ticket printing failed after the order was created',
      });
      const fallbackKotLabel = t('kotPrintFailed');
      const userMessage = printFailure.hasSpecificDetail
        ? formatKotErrorToast(printFailure.detail, t('saleCompletePrintFailed'))
        : t('saleCompletePrintFailed');
      reportOrderFailure({
        code: printFailure.code,
        title: t('printingFailed'),
        message: userMessage,
        nextStep: t('saleCompleteReprintNextStep'),
        detail: printFailure.detail,
        status: printFailure.status,
        operation: 'printer.print',
        stage: printFailure.stage,
        outcome: printFailure.outcome,
        classification: 'unexpected_failure',
        reasonCode: printFailure.reasonCode,
        correlationId: printFailure.correlation_id,
        operationFailure: printFailure.operation_failure,
        category: 'printer',
        extraDiagnostics: {
          failure_class: printFailure.failure_class,
          connection_type: printFailure.connection_type,
        },
        suppressToast: true,
        originContext: origin,
      });
      toast.error(
        formatKotErrorToast(
          printFailure.hasSpecificDetail ? printFailure.detail : fallbackKotLabel,
          t('saleCompletePrintFailed'),
        ),
      );
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.electronAPI?.getWindowState) {
      window.electronAPI
        .getWindowState()
        .then((state) => {
          if (state && typeof state === 'object' && 'isMaximized' in state) {
            setFullscreen(Boolean(state.isMaximized || state.isFullScreen));
          }
        })
        .catch(() => {});

      if (window.electronAPI.onWindowStateChanged) {
        return window.electronAPI.onWindowStateChanged((state) => {
          setFullscreen(Boolean(state?.isMaximized || state?.isFullScreen));
        });
      }
      return;
    }

    const syncFullscreen = () => setFullscreen(document.fullscreenElement != null);
    syncFullscreen();
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (typeof window === 'undefined') return;

    if (window.electronAPI?.windowAction) {
      try {
        await window.electronAPI.windowAction('toggle-maximize');
      } catch {
        toast.error(t('fullscreenUnavailable'));
      }
      return;
    }

    if (typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      toast.error(t('fullscreenUnavailable'));
    }
  }, [t]);

  const fetchLatestBill = async (billId: number): Promise<Bill> => {
    const { data } = await api.get(`/bills/${billId}`);
    return data.bill as Bill;
  };

  const printBillForTenant = async (
    bill: Bill,
    force = false,
    reservedWindow?: Window | null,
    originContext?: SupportErrorContextSnapshot,
  ) => {
    const origin = originContext || readLiveSupportContext();
    if (
      !currentTenant ||
      !isSupportErrorContextCurrent(origin, readLiveSupportContext()) ||
      (!force && !autoPrintBill)
    ) {
      if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
      return;
    }

    try {
      const printWarnings = await printBill(bill, currentTenant, undefined, reservedWindow);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      if (isPrintCancelledOnTenantChangeError(err)) return;
      if (!isSupportErrorContextCurrent(origin, readLiveSupportContext())) return;
      // Non-fatal: print failure should not block the checkout flow.
      console.error('[POS] Receipt print failed:', err);
      const printFailure = buildPrinterOperationFailureSupportPayload(err, {
        kind: 'receipt',
        fallbackDetail: 'Receipt printing failed after payment was completed',
      });
      const fallbackReceiptLabel = t('receiptPrintFailed');
      const userMessage = printFailure.hasSpecificDetail
        ? formatReceiptErrorToast(printFailure.detail, t('saleCompletePrintFailed'))
        : t('saleCompletePrintFailed');
      reportOrderFailure({
        code: printFailure.code,
        title: t('printingFailed'),
        message: userMessage,
        nextStep: t('saleCompleteReprintNextStep'),
        detail: printFailure.detail,
        status: printFailure.status,
        operation: 'printer.print',
        stage: printFailure.stage,
        outcome: printFailure.outcome,
        classification: 'unexpected_failure',
        reasonCode: printFailure.reasonCode,
        correlationId: printFailure.correlation_id,
        operationFailure: printFailure.operation_failure,
        category: 'printer',
        extraDiagnostics: {
          failure_class: printFailure.failure_class,
          connection_type: printFailure.connection_type,
        },
        suppressToast: true,
        originContext: origin,
      });
      toast.error(
        formatReceiptErrorToast(
          printFailure.hasSpecificDetail ? printFailure.detail : fallbackReceiptLabel,
          t('saleCompletePrintFailed'),
        ),
      );
    }
  };

  const refreshTables = async () => {
    if (!isRestaurant || !tablesRequired) return;
    try {
      const { data } = await api.get('/tables?active=1&include_items=1');
      setTables(data.tables || []);
    } catch {
      /* ignore */
    }
  };

  const canReadOrders = tenantCan(currentTenant, 'orders.read');
  const refreshScheduledOrders = useCallback(async () => {
    const originStoreId = currentStoreIdRef.current;
    if (!canReadOrders) {
      setScheduledOrders([]);
      setNextScheduledCursor(null);
      setScheduledCount(0);
      setBlockedScheduledCount(0);
      return;
    }
    try {
      const { data } = await api.get('/orders/scheduled');
      if (currentStoreIdRef.current !== originStoreId) return;
      const loadedOrders = (data.orders as Order[]) || [];
      setScheduledOrders(loadedOrders);
      setNextScheduledCursor(data.next_cursor || null);
      if (typeof data.scheduled_count === 'number') {
        setScheduledCount(data.scheduled_count);
      } else {
        setScheduledCount(loadedOrders.filter((o) => o.release_status === 'scheduled').length);
      }
      if (typeof data.blocked_count === 'number') {
        setBlockedScheduledCount(data.blocked_count);
      } else {
        setBlockedScheduledCount(loadedOrders.filter((o) => o.release_status === 'blocked').length);
      }
    } catch {
      /* ignore background poll failures */
    }
  }, [canReadOrders]);

  const handleLoadMoreScheduledOrders = async () => {
    if (!nextScheduledCursor || loadingMoreScheduled) return;
    const originStoreId = currentStoreIdRef.current;
    setLoadingMoreScheduled(true);
    try {
      const { data } = await api.get('/orders/scheduled', {
        params: { cursor: nextScheduledCursor },
      });
      if (currentStoreIdRef.current !== originStoreId) return;
      const moreOrders = (data.orders as Order[]) || [];
      setScheduledOrders((prev) => {
        const seen = new Set(prev.map((o) => o.id));
        return [...prev, ...moreOrders.filter((o) => !seen.has(o.id))];
      });
      setNextScheduledCursor(data.next_cursor || null);
      if (typeof data.scheduled_count === 'number') {
        setScheduledCount(data.scheduled_count);
      }
      if (typeof data.blocked_count === 'number') {
        setBlockedScheduledCount(data.blocked_count);
      }
    } catch {
      /* ignore load more failures */
    } finally {
      if (currentStoreIdRef.current === originStoreId) {
        setLoadingMoreScheduled(false);
      }
    }
  };

  useEffect(() => {
    void refreshScheduledOrders();
    const interval = setInterval(() => {
      void refreshScheduledOrders();
    }, 10000);
    const onFocus = () => {
      void refreshScheduledOrders();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [currentStoreId, refreshScheduledOrders]);

  // Replay persisted append attempt on reload to recover lost in-flight responses.
  useEffect(() => {
    if (!activeUserId || appendRecoveryStartedUsersRef.current.has(activeUserId)) return;
    const originContext = readLiveSupportContext();

    let pendingAttempt: AppendAttempt | null = null;
    try {
      pendingAttempt = readAppendAttempt(getAppendAttemptStorage(), { userId: activeUserId });
    } catch {
      window.setTimeout(
        () =>
          reportOrderStorageFailure(
            t('addItemsFailed'),
            'order.append',
            createOperationReference(),
            originContext,
          ),
        0,
      );
      return;
    }
    if (!pendingAttempt) return;

    const operationId = pendingAttempt.operationId || createOperationReference();
    if (operationId && pendingAttempt.operationId !== operationId) {
      pendingAttempt = { ...pendingAttempt, operationId };
      try {
        getAppendAttemptStorage().setItem(
          getAppendAttemptStorageKey(activeUserId),
          JSON.stringify(pendingAttempt),
        );
      } catch {
        window.setTimeout(
          () =>
            reportOrderStorageFailure(
              t('addItemsFailed'),
              'order.append',
              operationId,
              originContext,
            ),
          0,
        );
        return;
      }
    }
    appendRecoveryStartedUsersRef.current.add(activeUserId);
    addItemsAttemptRef.current = pendingAttempt;
    api
      .post(
        `/orders/${pendingAttempt.orderId}/items`,
        {
          items: pendingAttempt.items,
          special_instructions: pendingAttempt.specialInstructions,
        },
        {
          headers: {
            'Idempotency-Key': pendingAttempt.idempotencyKey,
            ...operationHeaders(operationId),
          },
        },
      )
      .then(() => {
        const storage = getAppendAttemptStorage();
        const cleared = clearAppendAttempt(storage, pendingAttempt!);
        if (addItemsAttemptRef.current?.idempotencyKey !== pendingAttempt!.idempotencyKey) return;
        addItemsAttemptRef.current = null;
        // Do not clear cart or checkout state that may have been started while
        // recovery was in flight. A reload starts empty; any current UI is newer.
        toast.success(
          t('itemsAddedToOrder', {
            number: pendingAttempt!.orderNumber || pendingAttempt!.orderId,
          }),
        );
        if (!cleared) {
          reportOrderFailure({
            code: 'order.append.retry_state.cleanup_failed',
            title: t('itemsAddedToOrder', {
              number: pendingAttempt!.orderNumber || pendingAttempt!.orderId,
            }),
            message: t('appendCompleteCleanupFailed'),
            nextStep: t('appendCompleteCheckOrders'),
            detail: 'Items were added to the order but local retry state could not be cleared',
            status: null,
            operation: 'order.append',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.append.retry_state.cleanup_failed',
            correlationId: pendingAttempt!.operationId,
            originContext,
          });
        }
        refreshTables();
      })
      .catch((error) => {
        reportOrderRequestFailure(
          error,
          t('addItemsFailed'),
          'order.append',
          'recovery',
          pendingAttempt!.operationId || null,
          originContext,
        );
      });
    // Runs once per user session to recover persisted append state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUserId]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        // 1. Fetch business settings first
        const settingsRes = await api.get('/settings/business');
        const d = settingsRes.data;
        if (typeof d.timezone === 'string' && d.timezone.trim()) {
          setStoreTimezone(d.timezone.trim());
        }
        setBillingType(d.billing_type === 'prepaid' ? 'prepaid' : 'postpaid');
        const isTablesRequired = typeof d.tables_required === 'boolean' ? d.tables_required : true;
        setTablesRequired(isTablesRequired);

        api
          .get('/settings/kot_printing_enabled')
          .then((res) => setKotPrintingEnabled(res.data.setting?.value !== 'false'))
          .catch(() => {});
        api
          .get('/settings/auto_print_kot')
          .then((res) => {
            const setting = res.data.setting;
            if (
              setting?.updated_at != null &&
              (setting.value === 'true' || setting.value === 'false')
            ) {
              setAutoPrintKot(setting.value === 'true');
            }
          })
          .catch(() => {});
        api
          .get('/settings/printer_use_unicode')
          .then((res) => {
            const setting = res.data.setting;
            if (
              setting?.updated_at != null &&
              (setting.value === 'true' || setting.value === 'false')
            ) {
              setPrinterUseUnicode(setting.value === 'true');
            }
          })
          .catch(() => {});
        api
          .get('/settings/printer_arabic_shaping')
          .then((res) => {
            const setting = res.data.setting;
            if (
              setting?.updated_at != null &&
              (setting.value === 'true' || setting.value === 'false')
            ) {
              setPrinterArabicShaping(setting.value === 'true');
            }
          })
          .catch(() => {});

        // 2. Fetch other menu data
        const requests: Promise<{ data: Record<string, unknown> }>[] = [
          api.get('/categories?active=1'),
          api.get('/products?active=1'),
        ];

        if (isRestaurant && isTablesRequired) {
          requests.push(api.get('/tables?active=1&include_items=1'));
        }

        const [catRes, prodRes, tableRes] = await Promise.all(requests);
        setCategories((catRes.data.categories as Category[]) || []);
        setProducts((prodRes.data.products as Product[]) || []);

        if (tableRes) {
          setTables((tableRes.data.tables as Table[]) || []);
        } else {
          setTables([]);
        }

        // 3. Fetch held orders conditionally
        if (isTablesRequired) {
          await heldOrders.fetchHeldOrders();
        }
      } catch {
        toast.error(t('menuLoadFailed'));
      }
    };
    fetchData();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isRestaurant,
    setBillingType,
    setTablesRequired,
    setKotPrintingEnabled,
    setAutoPrintKot,
    setPrinterUseUnicode,
    setPrinterArabicShaping,
  ]);

  const getPreservedAttemptScheduledFor = (
    cartState: Parameters<typeof buildCartFingerprintFromState>[0] = useCartStore.getState(),
    targetStoreId: string | number = useAuthStore.getState().currentTenant?.id ?? currentStoreId,
  ): string | undefined => {
    const currentAuthUser = useAuthStore.getState().user;
    const effectiveUserId =
      activeUserId || (currentAuthUser?.id == null ? null : String(currentAuthUser.id));
    if (!effectiveUserId) return undefined;

    const orderItems = cartState.items.map(cartItemToOrderItem);
    const unscheduledCartFingerprint = buildCartFingerprintFromState(
      { ...cartState, scheduledFor: '' },
      orderItems,
    );
    const unscheduledPostpaidOrderFingerprint = JSON.stringify({
      table_id: cartState.tableId,
      customer_id: cartState.customerId,
      type: cartState.orderType,
      guest_count: cartState.guestCount,
      special_instructions: cartState.orderNotes || undefined,
      online_platform:
        cartState.orderType === 'online' ? cartState.onlinePlatform || undefined : undefined,
      external_order_id:
        cartState.orderType === 'online' ? cartState.externalOrderId || undefined : undefined,
      delivery_address:
        cartState.orderType === 'delivery' ? cartState.deliveryAddress || undefined : undefined,
      expected_payment_method:
        cartState.orderType === 'delivery'
          ? cartState.expectedPaymentMethod || undefined
          : undefined,
      expected_payment_method_id:
        cartState.orderType === 'delivery'
          ? (cartState.expectedPaymentMethodId ?? undefined)
          : undefined,
      delivery_note:
        cartState.orderType === 'delivery' ? cartState.deliveryNote || undefined : undefined,
      scheduled_for: undefined,
      waived_charge_ids: Array.from(cartState.waivedChargeIds),
      opted_in_charge_ids: Array.from(cartState.optedInChargeIds),
      items: orderItems,
    });

    const matchesStoredSchedule = (storedFingerprint: string | undefined): string | undefined => {
      const storedScheduledFor = parseStoredAttemptScheduledFor(storedFingerprint);
      if (!storedScheduledFor) return undefined;
      const currentScheduledFor = cartState.scheduledFor?.trim() || '';
      if (currentScheduledFor && currentScheduledFor !== storedScheduledFor) return undefined;
      if (
        fingerprintsMatchAcrossScheduleToggle(storedFingerprint, unscheduledCartFingerprint) ||
        fingerprintsMatchAcrossScheduleToggle(
          storedFingerprint,
          unscheduledPostpaidOrderFingerprint,
        )
      ) {
        return storedScheduledFor;
      }
      return undefined;
    };

    try {
      const postpaidAttempt = readPostpaidAttempt(effectiveUserId);
      const postpaidScheduledFor =
        postpaidAttempt?.userId === effectiveUserId &&
        doesAttemptMatchStore(postpaidAttempt, targetStoreId, initialStoreIdRef.current)
          ? matchesStoredSchedule(postpaidAttempt.fingerprint)
          : undefined;
      if (postpaidScheduledFor) return postpaidScheduledFor;
    } catch {
      return cartState.scheduledFor?.trim() || undefined;
    }

    try {
      const prepaidAttempt = readPrepaidAttempt(effectiveUserId);
      const prepaidScheduledFor =
        prepaidAttempt?.userId === effectiveUserId &&
        doesAttemptMatchStore(prepaidAttempt, targetStoreId, initialStoreIdRef.current)
          ? matchesStoredSchedule(prepaidAttempt.cartFingerprint)
          : undefined;
      if (prepaidScheduledFor) return prepaidScheduledFor;
    } catch {
      return cartState.scheduledFor?.trim() || undefined;
    }

    return undefined;
  };

  useEffect(() => {
    let cancelled = false;
    setActiveCounter(null);
    setShowPaymentQueue(false);
    setCounters([]);
    setScheduledOrdersEnabled(false);
    setShowScheduledOrders(false);
    setScheduledOrders([]);
    setNextScheduledCursor(null);
    setScheduledCount(0);
    setBlockedScheduledCount(0);

    api
      .get('/settings/multi_counter_enabled')
      .then((res) => {
        if (cancelled) return;
        const isEnabled = res.data.setting?.value === 'true';
        setMultiCounterEnabled(isEnabled);
        if (isEnabled) {
          api
            .get('/counters?is_active=true')
            .then((cRes) => {
              if (cancelled) return;
              const activeList: Counter[] = cRes.data.counters || [];
              setCounters(activeList);
              const savedId =
                typeof window !== 'undefined'
                  ? localStorage.getItem(`flocafe_active_counter_${currentStoreId}`)
                  : null;
              if (savedId) {
                const matched = activeList.find((c) => c.id === savedId);
                if (matched) {
                  setActiveCounter(matched);
                  if (matched.role === 'payment') {
                    setShowPaymentQueue(true);
                  }
                } else {
                  setActiveCounter(null);
                  setShowPaymentQueue(false);
                }
              } else {
                setActiveCounter(null);
                setShowPaymentQueue(false);
              }
            })
            .catch(() => {});
        } else {
          setActiveCounter(null);
          setShowPaymentQueue(false);
          setCounters([]);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setMultiCounterEnabled(false);
        setActiveCounter(null);
        setShowPaymentQueue(false);
        setCounters([]);
      });

    const syncCartScheduledForWithSetting = (
      settingReadSucceeded: boolean,
      isScheduledEnabled: boolean,
    ) => {
      const currentCart = useCartStore.getState();
      const nextScheduledFor = resolveCartScheduledForAfterSettingRead({
        settingReadSucceeded,
        scheduledOrdersEnabled: isScheduledEnabled,
        cartScheduledFor: currentCart.scheduledFor,
        preservedScheduledFor: getPreservedAttemptScheduledFor(currentCart, currentStoreId),
      });
      if (currentCart.scheduledFor !== nextScheduledFor) {
        currentCart.setScheduledFor(nextScheduledFor);
      }
    };

    api
      .get('/settings/scheduled_orders_enabled')
      .then((res) => {
        if (cancelled) return;
        const isScheduledEnabled = res.data.setting?.value === 'true';
        setScheduledOrdersEnabled(isScheduledEnabled);
        syncCartScheduledForWithSetting(true, isScheduledEnabled);
      })
      .catch(() => {
        if (cancelled) return;
        setScheduledOrdersEnabled(false);
        syncCartScheduledForWithSetting(false, false);
      });

    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStoreId]);

  const handleSelectCounter = (counter: Counter | null) => {
    setActiveCounter(counter);
    if (multiCounterEnabled && counter?.role === 'payment') {
      setShowPaymentQueue(true);
    }
    if (typeof window !== 'undefined') {
      if (counter) {
        localStorage.setItem(`flocafe_active_counter_${currentStoreId}`, counter.id);
      } else {
        localStorage.removeItem(`flocafe_active_counter_${currentStoreId}`);
      }
    }
  };

  const refreshPaymentQueueCounts = useCallback(async () => {
    try {
      const { data } = await api.get('/orders/awaiting-payment', { params: { limit: '1' } });
      const awaiting = Number(data.awaiting_count) || 0;
      const blocked = Number(data.blocked_count) || 0;
      setPaymentQueueCount(awaiting + blocked);
      setPaymentQueueBlockedCount(blocked);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!multiCounterEnabled) return;
    void refreshPaymentQueueCounts();
    const interval = setInterval(() => {
      void refreshPaymentQueueCounts();
    }, 15000);
    return () => clearInterval(interval);
  }, [multiCounterEnabled, refreshPaymentQueueCounts]);

  const handleLookupAndPayTicket = useCallback(
    async (ticket: string) => {
      try {
        const { data } = await api.get(`/orders/by-ticket/${encodeURIComponent(ticket)}`);
        if (data?.bill) {
          setPaymentBill(data.bill as Bill);
          toast.success(t('ticketLoaded', { number: data.order?.order_number || ticket }));
        } else if (data?.order) {
          await handlePayScheduledOrder(data.order as Order);
        }
      } catch (err: unknown) {
        const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
        toast.error(errData?.error || t('ticketNotFound'));
      }
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  const handleProductClick = (product: Product, quantity = 1) => {
    if (!productNeedsCustomizer(product)) {
      cart.addItem(product, quantity);
      return;
    }
    setAddonInitialQuantity(quantity);
    setAddonInitialVariant(null);
    setAddonProduct(product);
  };

  const handleScannedVariant = (product: Product, variant: ProductVariant, quantity = 1) => {
    if (scannedVariantNeedsCustomizer(product, variant)) {
      setAddonInitialQuantity(quantity);
      setAddonInitialVariant(variant);
      setAddonProduct(product);
      return;
    }
    cart.addItem(product, quantity, [], '', variant);
  };

  const handleAddonAdd = (
    product: Product,
    quantity: number,
    addons: Addon[],
    instructions: string,
    variant: ProductVariant | null,
  ) => {
    cart.addItem(product, quantity, addons, instructions, variant);
  };

  const handleEditItemSave = (
    _product: Product,
    quantity: number,
    addons: Addon[],
    instructions: string,
    variant: ProductVariant | null,
  ) => {
    if (!editingCartItem) return;
    cart.updateItemDetails(editingCartItem.id, quantity, addons, instructions, variant);
  };

  // A modal already open means the scan (if one lands) isn't meant for the
  // product grid — e.g. it could be a barcode field inside that modal.
  const anyOtherModalOpen =
    !!addonProduct ||
    !!editingCartItem ||
    !!checkoutTable ||
    !!paymentBill ||
    showCustomerPrompt ||
    customerModalOpen ||
    cartPanelModalOpen ||
    showPrepaidCheckout ||
    cashDrawer.open ||
    shift.openModalOpen ||
    shift.closeModalOpen ||
    showPrintMenuModal ||
    showKeyboardShortcutsModal ||
    showScheduledOrders ||
    showPaymentQueue ||
    showTicketModal ||
    !!refundModalTarget ||
    actionsMenuOpen ||
    isConfirmOpen;
  const anyModalOpen = showTablePicker || anyOtherModalOpen;

  useBarcodeScanner((code) => {
    if (code.startsWith('FLOCAFE-TICKET:')) {
      void handleLookupAndPayTicket(code);
      return;
    }
    const scan = resolveScannedProduct(code, products);
    if (scan) {
      if (scan.scaleBarcode) cart.addItem(scan.product, scan.quantity);
      else if (scan.variant) handleScannedVariant(scan.product, scan.variant);
      else handleProductClick(scan.product);
    } else {
      toast.error(t('barcodeNotFound', { code }));
    }
  }, !anyModalOpen);

  const tablesLoaded = tables.length > 0;
  useEffect(() => {
    if (cart.orderType !== 'dine_in') {
      if (cart.tableId && !pendingOrder) cart.setTableId(null);
      return;
    }
    if (!isRestaurant || !tablesRequired || !tablesLoaded) return;
    const selected = tables.find((tbl) => tbl.id === cart.tableId);
    const staleSelection =
      !!selected &&
      selected.status === 'occupied' &&
      cart.items.length === 0 &&
      !pendingOrder &&
      !checkoutTable;
    if (cart.tableId && !staleSelection) return;
    const next = tables.find(
      (tbl) => tbl.status === 'available' && !heldOrders.hasHeldOrder(tbl.id),
    );
    if (next) cart.setTableId(next.id);
    else if (staleSelection) cart.setTableId(null);
  }, [
    isRestaurant,
    tablesRequired,
    tablesLoaded,
    tables,
    cart,
    heldOrders,
    pendingOrder,
    checkoutTable,
  ]);

  const validateOrderPreflight = () => {
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return false;
    }
    if (!pendingOrder && customerMandatory && !cart.customerId) {
      setShowCustomerPrompt(true);
      return false;
    }
    if (
      !pendingOrder &&
      isRestaurant &&
      cart.orderType === 'dine_in' &&
      tablesRequired &&
      !cart.tableId
    ) {
      setShowTablePicker(true);
      return false;
    }
    if (
      scheduledOrdersEnabled &&
      !pendingOrder &&
      (cart.orderType === 'takeaway' || cart.orderType === 'delivery') &&
      cart.scheduledFor.trim().length > 0 &&
      getPreservedAttemptScheduledFor(cart) !== cart.scheduledFor.trim()
    ) {
      const check = parseScheduledForInput({
        input: cart.scheduledFor,
        timezone: storeTimezone || currentTenant?.timezone || 'UTC',
        nowMs: Date.now(),
      });
      if (!check.ok) {
        const tz = storeTimezone || currentTenant?.timezone || 'UTC';
        const msg =
          check.code === 'PAST_SCHEDULED_TIME'
            ? t('scheduledPastTimeError', { timezone: tz })
            : check.code === 'DST_NONEXISTENT_TIME'
              ? t('scheduledDstSkippedError', { timezone: tz })
              : check.code === 'DST_AMBIGUOUS_TIME'
                ? t('scheduledDstAmbiguousError', { timezone: tz })
                : t('scheduledInvalidTimeError', { timezone: tz });
        toast.error(msg);
        return false;
      }
    }
    return true;
  };

  const buildCartFingerprint = (
    cartState: Parameters<typeof buildCartFingerprintFromState>[0],
    orderItems?: Parameters<typeof buildCartFingerprintFromState>[1],
  ) =>
    buildCartFingerprintFromState(
      {
        ...cartState,
        scheduledFor: scheduledOrdersEnabled ? cartState.scheduledFor : '',
      },
      orderItems,
    );

  const buildCurrentCartFingerprint = (orderItems = cart.items.map(cartItemToOrderItem)) =>
    buildCartFingerprint(cart, orderItems);

  const handlePlaceOrder = async () => {
    if (!validateOrderPreflight()) return;

    const cartFingerprint = buildCurrentCartFingerprint();
    // Prepaid stores collect payment before finishing the order.
    if (shouldTakePaymentNow && !pendingOrder) {
      let matchingAttempt: PrepaidAttempt | null = null;
      try {
        const storedAttempt = readPrepaidAttempt();
        if (
          storedAttempt &&
          storedAttempt.userId === activeUserId &&
          doesAttemptMatchStore(storedAttempt, currentStoreId, initialStoreIdRef.current) &&
          fingerprintsMatchAcrossScheduleToggle(storedAttempt.cartFingerprint, cartFingerprint) &&
          storedAttempt.orderIdempotencyKey &&
          storedAttempt.paymentIdempotencyKey
        ) {
          matchingAttempt = storedAttempt;
        }
      } catch {
        // Storage failures are reported when checkout is confirmed.
      }
      setPrepaidModalAttempt(matchingAttempt);
      setShowPrepaidCheckout(true);
      return;
    }

    // Postpaid store / unpaid order → place order, kitchen gets the ticket, payment collected later
    setSubmitting(true);
    const originContext = readLiveSupportContext();
    const originUserId = originContext.userId;
    const originStoreId = originContext.storeId;
    const originToken = originContext.token;
    const submissionToken = Symbol('pos-place-order');
    activeSubmissionTokenRef.current = submissionToken;

    const isSessionCurrent = () => checkSessionCurrent(originContext);

    let failureOperation = pendingOrder ? 'order.append' : 'order.create';
    let failureStage = 'submission';
    let failureCorrelationId: string | null = null;
    let attemptedScheduledFor: string | undefined;
    try {
      let orderForKot: Order;
      let postpaidOperationId: string | null = null;

      if (pendingOrder) {
        // Add new items to an existing order with a durable retry key.
        const newItems = cart.items.map(cartItemToOrderItem);
        const specialInstructions = cart.orderNotes || undefined;
        const itemFingerprint = buildAppendItemsFingerprint(
          pendingOrder.id,
          newItems,
          specialInstructions,
        );
        const storage = getAppendAttemptStorage();
        const candidateOperationId = createOperationReference() || undefined;
        failureCorrelationId = candidateOperationId || null;
        let itemAttempt = getOrCreateAppendAttempt(storage, {
          userId: originUserId || '',
          orderId: pendingOrder.id,
          fingerprint: itemFingerprint,
          createKey: newIdempotencyKey,
          items: newItems,
          specialInstructions,
          orderNumber: pendingOrder.order_number,
          operationId: candidateOperationId,
        });
        if (!itemAttempt.operationId) {
          const operationId = createOperationReference();
          if (operationId) {
            itemAttempt = { ...itemAttempt, operationId };
            try {
              storage.setItem(
                getAppendAttemptStorageKey(itemAttempt.userId),
                JSON.stringify(itemAttempt),
              );
            } catch {
              throw new OrderAttemptStorageError();
            }
          }
        }
        failureCorrelationId = itemAttempt.operationId || null;
        if (originUserId === activeUserId) {
          addItemsAttemptRef.current = itemAttempt;
        }
        failureStage = 'append_items';
        const { data } = await api.post(
          `/orders/${pendingOrder.id}/items`,
          { items: newItems, special_instructions: specialInstructions },
          {
            headers: {
              ...pinnedAuthHeaders(originToken),
              'Idempotency-Key': itemAttempt.idempotencyKey,
              ...operationHeaders(itemAttempt.operationId),
            },
          },
        );
        if (!isSessionCurrent()) {
          // Item append succeeded on server while session changed. Stop before mutating state.
          if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
            useCartStore.getState().clearCart();
          }
          return;
        }
        toast.success(t('itemsAddedToOrder', { number: pendingOrder.order_number }));
        const updatedOrder = data.order as Order;
        const existingItemIds = new Set((pendingOrder.items || []).map((item) => Number(item.id)));
        const appendedItems =
          Array.isArray(data.added_items) && data.added_items.length > 0
            ? data.added_items
            : (updatedOrder.items || []).filter((item) => !existingItemIds.has(Number(item.id)));
        orderForKot =
          appendedItems.length > 0 ? { ...updatedOrder, items: appendedItems } : updatedOrder;
        if (!clearAppendAttempt(storage, itemAttempt)) {
          if (itemAttempt.operationId)
            void captureClientOperationFailure({
              operation: 'order.append',
              phase: 'retry_cleanup',
              correlationId: itemAttempt.operationId,
            });
          reportOrderFailure({
            code: 'order.append.retry_state.cleanup_failed',
            title: t('itemsAddedToOrder', { number: pendingOrder.order_number }),
            message: t('appendCompleteCleanupFailed'),
            nextStep: t('appendCompleteCheckOrders'),
            detail: 'Items were added to the order but local retry state could not be cleared',
            status: null,
            operation: 'order.append',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.append.retry_state.cleanup_failed',
            correlationId: itemAttempt.operationId,
            originContext,
          });
        }
        addItemsAttemptRef.current = null;
        setPendingOrder(null);
      } else {
        const priorOrderAttempt = readPostpaidAttempt(originUserId);
        const priorPostpaidMatchesStore =
          priorOrderAttempt?.userId === originUserId &&
          doesAttemptMatchStore(priorOrderAttempt, originStoreId, initialStoreIdRef.current);
        const preservedPostpaidScheduledFor = priorPostpaidMatchesStore
          ? parseStoredAttemptScheduledFor(priorOrderAttempt.fingerprint)
          : undefined;
        const orderPayload = {
          table_id: cart.tableId,
          customer_id: cart.customerId,
          type: cart.orderType,
          guest_count: cart.guestCount,
          special_instructions: cart.orderNotes || undefined,
          online_platform:
            cart.orderType === 'online' ? cart.onlinePlatform || undefined : undefined,
          external_order_id:
            cart.orderType === 'online' ? cart.externalOrderId || undefined : undefined,
          delivery_address:
            cart.orderType === 'delivery' ? cart.deliveryAddress || undefined : undefined,
          expected_payment_method:
            cart.orderType === 'delivery' ? cart.expectedPaymentMethod || undefined : undefined,
          expected_payment_method_id:
            cart.orderType === 'delivery' ? (cart.expectedPaymentMethodId ?? undefined) : undefined,
          delivery_note: cart.orderType === 'delivery' ? cart.deliveryNote || undefined : undefined,
          scheduled_for: resolveRetryScheduledFor({
            orderType: cart.orderType,
            scheduledOrdersEnabled,
            cartScheduledFor: cart.scheduledFor,
          }),
          waived_charge_ids: Array.from(cart.waivedChargeIds),
          opted_in_charge_ids: Array.from(cart.optedInChargeIds),
          items: cart.items.map(cartItemToOrderItem),
        };
        const baseOrderFingerprint = JSON.stringify(orderPayload);
        const matchesPriorPostpaidOrderAttempt =
          priorPostpaidMatchesStore &&
          fingerprintsMatchAcrossScheduleToggle(
            priorOrderAttempt.fingerprint,
            baseOrderFingerprint,
          );
        if (matchesPriorPostpaidOrderAttempt) {
          orderPayload.scheduled_for = resolveRetryScheduledFor({
            orderType: cart.orderType,
            scheduledOrdersEnabled,
            cartScheduledFor: cart.scheduledFor,
            preservedScheduledFor: preservedPostpaidScheduledFor,
          });
        }
        attemptedScheduledFor = orderPayload.scheduled_for;
        const orderFingerprint = matchesPriorPostpaidOrderAttempt
          ? priorOrderAttempt.fingerprint
          : baseOrderFingerprint;
        if (
          priorPostpaidMatchesStore &&
          fingerprintsMatchAcrossScheduleToggle(priorOrderAttempt.fingerprint, cartFingerprint)
        ) {
          const completedOrder = priorOrderAttempt.order;
          reportOrderFailure({
            code: completedOrder ? 'order.retry_state.cleanup_failed' : 'order.retry_state.pending',
            title: completedOrder
              ? t('orderPlaced', { number: completedOrder.order_number })
              : t('placeOrderFailed'),
            message: completedOrder ? t('saleCompleteCleanupFailed') : t('operationOutcomeUnknown'),
            nextStep: completedOrder
              ? t('saleCompleteCheckOrders')
              : t('operationCheckBeforeRetry'),
            detail: completedOrder
              ? 'This matching order attempt already has a confirmed order and cannot be reused for a new sale'
              : 'A send-to-payment attempt for this cart is unresolved and cannot be replaced with a different checkout request',
            status: null,
            operation: 'order.create',
            stage: completedOrder ? 'cleanup' : 'retry_state',
            outcome: completedOrder ? 'applied' : 'unknown',
            reasonCode: completedOrder
              ? 'order.retry_state.cleanup_failed'
              : 'order.retry_state.pending',
            correlationId: priorOrderAttempt.operationId,
            originContext,
          });
          return;
        }
        if (matchesPriorPostpaidOrderAttempt && priorOrderAttempt.order) {
          reportOrderFailure({
            code: 'order.retry_state.cleanup_failed',
            title: t('orderPlaced', { number: priorOrderAttempt.order.order_number }),
            message: t('saleCompleteCleanupFailed'),
            nextStep: t('saleCompleteCheckOrders'),
            detail:
              'This matching order attempt already has a confirmed order and cannot be reused for a new sale',
            status: null,
            operation: 'order.create',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.retry_state.cleanup_failed',
            correlationId: priorOrderAttempt.operationId,
            originContext,
          });
          return;
        }
        failureOperation = 'order.create';
        failureStage = 'order_submission';
        const orderAttempt: PostpaidAttempt = matchesPriorPostpaidOrderAttempt
          ? priorOrderAttempt
          : {
              userId: originUserId || '',
              fingerprint: orderFingerprint,
              idempotencyKey: newIdempotencyKey(),
              operationId: createOperationReference() || undefined,
            };
        const operationId = orderAttempt.operationId || createOperationReference();
        postpaidOperationId = operationId || null;
        failureCorrelationId = operationId;
        const attemptWithOperationId = operationId
          ? { ...orderAttempt, operationId }
          : orderAttempt;
        if (!savePostpaidAttempt(attemptWithOperationId, originUserId)) {
          if (operationId)
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'retry_storage',
              correlationId: operationId,
            });
          throw new OrderAttemptStorageError();
        }
        const { data } = attemptWithOperationId.order
          ? { data: { order: attemptWithOperationId.order } }
          : await api.post('/orders', orderPayload, {
              headers: {
                ...pinnedAuthHeaders(originToken),
                'Idempotency-Key': attemptWithOperationId.idempotencyKey,
                ...operationHeaders(operationId),
              },
            });
        const confirmedAttempt = { ...attemptWithOperationId, order: data.order as Order };
        if (!attemptWithOperationId.order && !savePostpaidAttempt(confirmedAttempt, originUserId)) {
          console.error('The confirmed order could not be copied into retry storage');
          if (originUserId === activeUserId) {
            postpaidAttemptRef.current = confirmedAttempt;
          }
          if (operationId)
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'retry_state_update',
              correlationId: operationId,
            });
        }
        if (!isSessionCurrent()) {
          // Critical recovery invariant: order succeeded on server while session changed.
          // Originating user's recovery attempt is saved under getPostpaidOrderAttemptStorageKey(originUserId).
          // If the shared cart still matches the submitted cart, clear it so the new session doesn't double-order.
          if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
            useCartStore.getState().clearCart();
          }
          return;
        }
        if (data.order.release_status === 'scheduled' && data.order.scheduled_for) {
          toast.success(
            t('scheduledOrderPlaced', {
              number: data.order.order_number,
              time: formatScheduledInstantForDisplay(
                data.order.scheduled_for,
                storeTimezone || currentTenant?.timezone || 'UTC',
              ),
            }),
          );
        } else {
          toast.success(t('orderPlaced', { number: data.order.order_number }));
        }
        orderForKot = data.order as Order;
      }

      if (cart.tableId) {
        try {
          const deleted = await heldOrders.removeHeldOrder(
            cart.tableId,
            cart.heldOrderId || undefined,
          );
          if (!deleted && isSessionCurrent()) await heldOrders.fetchHeldOrders();
        } catch (heldOrderError) {
          // The order has already been placed. Do not turn a cleanup failure
          // into a failed sale or leave an unhandled promise in the console.
          console.error('Failed to clear held order after placing order', heldOrderError);
          if (
            !(heldOrderError as { response?: unknown } | null)?.response &&
            failureCorrelationId
          ) {
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'held_cleanup',
              correlationId: failureCorrelationId,
            });
          }
          reportOrderFailure({
            code: 'order.held_state.cleanup_failed',
            title: t('orderPlaced', { number: orderForKot.order_number }),
            message: t('saleCompleteCleanupFailed'),
            nextStep: t('saleCompleteCheckOrders'),
            detail: 'The order was created but its held-order record could not be refreshed',
            status: null,
            operation: 'order.create',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.held_state.cleanup_failed',
            correlationId: failureCorrelationId,
            operationFailure:
              !(heldOrderError as { response?: unknown } | null)?.response && !!failureCorrelationId
                ? {
                    capture_point: 'fc.frontend.pos.order.create.held_cleanup',
                    operation_id: failureCorrelationId,
                    outcome: 'applied',
                  }
                : undefined,
            originContext,
          });
        }
      }
      if (!isSessionCurrent()) {
        if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
          useCartStore.getState().clearCart();
        }
        return;
      }
      cart.clearCart();
      if (!pendingOrder && !clearPostpaidAttempt(originUserId)) {
        if (postpaidOperationId)
          void captureClientOperationFailure({
            operation: 'order.create',
            phase: 'retry_cleanup',
            correlationId: postpaidOperationId,
          });
        reportOrderFailure({
          code: 'order.retry_state.cleanup_failed',
          title: t('orderPlaced', { number: orderForKot.order_number }),
          message: t('saleCompleteCleanupFailed'),
          nextStep: t('saleCompleteCheckOrders'),
          detail: 'The order was created but local retry state could not be cleared',
          status: null,
          operation: 'order.create',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'order.retry_state.cleanup_failed',
          correlationId: postpaidOperationId,
          originContext,
        });
      }
      setMobileCartOpen(false);
      await refreshTables();
      void refreshScheduledOrders();

      if (!isSessionCurrent()) return;
      await printKotIfEnabled(orderForKot, originContext);
    } catch (error) {
      if (!isSessionCurrent()) return;
      if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(
          t('placeOrderFailed'),
          failureOperation === 'order.append' ? 'order.append' : 'order.create',
          failureCorrelationId,
          originContext,
        );
      else {
        if (
          !pendingOrder &&
          failureOperation === 'order.create' &&
          attemptedScheduledFor &&
          isDefinitiveScheduleRejection(error, failureCorrelationId)
        ) {
          clearPostpaidAttempt(originUserId);
          if (
            !scheduledOrdersEnabled ||
            getScheduleRejectionCode(error) === 'SCHEDULED_ORDERS_DISABLED'
          ) {
            setScheduledOrdersEnabled(false);
            if (useCartStore.getState().scheduledFor.trim()) {
              useCartStore.getState().setScheduledFor('');
            }
          }
        }
        reportOrderRequestFailure(
          error,
          t('placeOrderFailed'),
          failureOperation,
          failureStage,
          failureCorrelationId,
          originContext,
        );
      }
    } finally {
      if (isSessionCurrent() && activeSubmissionTokenRef.current === submissionToken) {
        setSubmitting(false);
        activeSubmissionTokenRef.current = null;
      }
    }
  };

  const handleSendToPayment = async () => {
    if (pendingOrder) {
      void handlePlaceOrder();
      return;
    }
    if (isSendingToPaymentRef.current) return;
    if (cart.orderType !== 'takeaway' && cart.orderType !== 'dine_in') {
      toast.error(
        cart.orderType === 'delivery' ? t('sendToPaymentDeliveryError') : t('placeOrderFailed'),
      );
      return;
    }
    if (!validateOrderPreflight()) return;

    isSendingToPaymentRef.current = true;
    setSubmitting(true);
    const originContext = readLiveSupportContext();
    const originUserId = originContext.userId;
    const originToken = originContext.token;
    const submissionToken = Symbol('pos-send-to-payment');
    activeSubmissionTokenRef.current = submissionToken;
    const isOriginSessionCurrent = () => checkSessionCurrent(originContext);

    let sendToPaymentOperationId: string | null = null;
    let attemptedScheduledFor: string | undefined;
    try {
      if (!originUserId) throw new OrderAttemptStorageError();

      const orderItems = cart.items.map(cartItemToOrderItem);
      const cartFingerprint = buildCurrentCartFingerprint(orderItems);
      const storage = getAppendAttemptStorage();
      const storedAttempt = readPostpaidAttempt(originUserId);
      const storedAttemptMatchesCart =
        storedAttempt?.userId === originUserId &&
        doesAttemptMatchStore(storedAttempt, originContext.storeId, initialStoreIdRef.current) &&
        fingerprintsMatchAcrossScheduleToggle(storedAttempt.fingerprint, cartFingerprint);
      if (storedAttemptMatchesCart && storedAttempt.order) {
        reportOrderFailure({
          code: 'order.retry_state.cleanup_failed',
          title: t('orderSentToPaymentSuccess', { number: storedAttempt.order.order_number }),
          message: t('saleCompleteCleanupFailed'),
          nextStep: t('saleCompleteCheckOrders'),
          detail: 'This matching order attempt already has a confirmed ticket and cannot be reused',
          status: null,
          operation: 'order.create',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'order.retry_state.cleanup_failed',
          correlationId: storedAttempt.operationId,
          originContext,
        });
        return;
      }
      const attemptOperationId =
        (storedAttemptMatchesCart ? storedAttempt.operationId : undefined) ||
        createOperationReference() ||
        undefined;
      sendToPaymentOperationId = attemptOperationId || null;
      const attempt: PostpaidAttempt = storedAttemptMatchesCart
        ? {
            ...storedAttempt,
            ...(attemptOperationId ? { operationId: attemptOperationId } : {}),
          }
        : {
            userId: originUserId,
            fingerprint: cartFingerprint,
            idempotencyKey: newIdempotencyKey(),
            operationId: attemptOperationId,
          };
      const preservedScheduledFor = storedAttemptMatchesCart
        ? parseStoredAttemptScheduledFor(storedAttempt.fingerprint)
        : undefined;
      const storageKey = getPostpaidOrderAttemptStorageKey(originUserId);
      if (!savePostpaidAttempt(attempt, originUserId)) throw new OrderAttemptStorageError();

      const orderPayload = {
        type: cart.orderType,
        table_id: cart.orderType === 'dine_in' ? cart.tableId : undefined,
        customer_id: cart.customerId || undefined,
        guest_count: cart.orderType === 'dine_in' ? cart.guestCount : undefined,
        special_instructions: cart.orderNotes || undefined,
        scheduled_for:
          cart.orderType === 'takeaway'
            ? resolveRetryScheduledFor({
                orderType: cart.orderType,
                scheduledOrdersEnabled,
                cartScheduledFor: cart.scheduledFor,
                preservedScheduledFor,
              })
            : undefined,
        dispatch_policy: 'on_payment',
        waived_charge_ids: Array.from(cart.waivedChargeIds),
        opted_in_charge_ids: Array.from(cart.optedInChargeIds),
        items: orderItems,
      };
      attemptedScheduledFor = orderPayload.scheduled_for;

      const { data } = await api.post('/orders', orderPayload, {
        headers: {
          ...pinnedAuthHeaders(originToken),
          'Idempotency-Key': attempt.idempotencyKey,
          ...operationHeaders(attempt.operationId),
        },
      });
      const createdOrder = data.order as Order;

      let isLatestAttempt = false;
      let cleanupFailed = false;
      try {
        const currentAttempt = readOrderAttempt<PostpaidAttempt>(
          createFreshAppendAttemptStorage(),
          storageKey,
          originUserId,
          { isValid: isUsablePostpaidAttempt },
        );
        isLatestAttempt =
          currentAttempt?.fingerprint === attempt.fingerprint &&
          currentAttempt.idempotencyKey === attempt.idempotencyKey &&
          currentAttempt.operationId === attempt.operationId;
      } catch {
        if (!isOriginSessionCurrent()) return;
        setShowPaymentQueue(true);
        reportOrderFailure({
          code: 'order.retry_state.read_failed',
          title: t('orderSentToPaymentSuccess', { number: createdOrder.order_number }),
          message: t('saleCompleteCleanupFailed'),
          nextStep: t('saleCompleteCheckOrders'),
          detail:
            'The order was created but local retry state could not be read; confirm it in the payment queue before retrying',
          status: null,
          operation: 'order.create',
          stage: 'recovery',
          outcome: 'applied',
          reasonCode: 'order.retry_state.read_failed',
          correlationId: attempt.operationId || null,
          originContext,
        });
        return;
      }
      if (!isLatestAttempt) return;

      const confirmedAttempt = { ...attempt, order: createdOrder };
      if (!savePostpaidAttempt(confirmedAttempt, originUserId)) {
        if (originUserId === activeUserId) {
          postpaidAttemptRef.current = confirmedAttempt;
          postpaidAttemptKeyRef.current = storageKey;
        }
        if (attempt.operationId)
          void captureClientOperationFailure({
            operation: 'order.create',
            phase: 'retry_state_update',
            correlationId: attempt.operationId,
          });
      }
      if (!isOriginSessionCurrent()) {
        if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
          useCartStore.getState().clearCart();
        }
        return;
      }

      if (!clearOrderAttempt(storage, storageKey, confirmedAttempt)) {
        cleanupFailed = true;
      } else if (postpaidAttemptRef.current?.idempotencyKey === attempt.idempotencyKey) {
        postpaidAttemptRef.current = null;
        postpaidAttemptKeyRef.current = null;
        postpaidAttemptWasLegacyRef.current = false;
      }
      if (!isLatestAttempt || !isOriginSessionCurrent()) return;

      if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
        useCartStore.getState().clearCart();
      }
      setTicketModalOrder(createdOrder);
      setTicketModalQrDataUrl(data.qr_data_url || null);
      setTicketModalQrPayload(data.qr_payload || null);
      setShowTicketModal(true);
      void refreshTables();
      void refreshPaymentQueueCounts();
      if (cleanupFailed) {
        reportOrderFailure({
          code: 'order.retry_state.cleanup_failed',
          title: t('orderSentToPaymentSuccess', { number: createdOrder.order_number }),
          message: t('saleCompleteCleanupFailed'),
          nextStep: t('saleCompleteCheckOrders'),
          detail: 'The order was created but local retry state could not be cleared',
          status: null,
          operation: 'order.create',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'order.retry_state.cleanup_failed',
          correlationId: attempt.operationId || null,
          originContext,
        });
      } else {
        toast.success(t('orderSentToPaymentSuccess', { number: createdOrder.order_number }));
      }
    } catch (err: unknown) {
      if (!isOriginSessionCurrent()) return;
      if (err instanceof OrderAttemptStorageError) {
        reportOrderStorageFailure(t('placeOrderFailed'), 'order.create', null, originContext);
      } else {
        if (attemptedScheduledFor && isDefinitiveScheduleRejection(err, sendToPaymentOperationId)) {
          clearPostpaidAttempt(originUserId);
          if (
            !scheduledOrdersEnabled ||
            getScheduleRejectionCode(err) === 'SCHEDULED_ORDERS_DISABLED'
          ) {
            setScheduledOrdersEnabled(false);
            if (useCartStore.getState().scheduledFor.trim()) {
              useCartStore.getState().setScheduledFor('');
            }
          }
        }
        const errData = (err as { response?: { data?: { error?: string; code?: string } } })
          ?.response?.data;
        toast.error(
          errData?.code === 'MULTI_COUNTER_DISABLED'
            ? tSettings('multiCounterDisabled')
            : errData?.error || t('placeOrderFailed'),
        );
      }
    } finally {
      if (isOriginSessionCurrent() && activeSubmissionTokenRef.current === submissionToken) {
        isSendingToPaymentRef.current = false;
        setSubmitting(false);
        activeSubmissionTokenRef.current = null;
      }
    }
  };

  // Handle prepaid checkout - place order and pay in one step
  const handlePrepaidCheckout = async (
    payments: PrepaidPayment[],
    walletAmount: number,
    discount: PrepaidDiscount | null,
  ) => {
    const isPrepaidCheckout = shouldTakePaymentNow;
    setShowPrepaidCheckout(false);
    setSubmitting(true);
    const originContext = readLiveSupportContext();
    const originUserId = originContext.userId;
    const originToken = originContext.token;
    const submissionToken = Symbol('pos-prepaid-checkout');
    activeSubmissionTokenRef.current = submissionToken;

    const isSessionCurrent = () => checkSessionCurrent(originContext);

    const orderItems = cart.items.map(cartItemToOrderItem);
    let paymentLines = payments
      .filter((p) => p.amount > 0)
      .map((p) => ({
        method: p.method,
        ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
        amount: p.amount,
        ...(p.transaction_id !== undefined ? { transaction_id: p.transaction_id } : {}),
      }));
    if (walletAmount > 0) paymentLines.push({ method: 'wallet', amount: walletAmount });
    const paymentCustomerId: string | number | null = cart.customerId ?? null;
    let paymentFingerprint = JSON.stringify({
      payments: paymentLines,
      customer_id: paymentCustomerId,
    });
    const cartFingerprint = buildCurrentCartFingerprint(orderItems);
    let storedAttempt: PrepaidAttempt | null;
    try {
      storedAttempt = readPrepaidAttempt(originUserId);
    } catch (error) {
      // An unreadable attempt cannot be safely replaced with a fresh key.
      if (!(error instanceof OrderAttemptStorageError)) throw error;
      if (isSessionCurrent()) {
        reportOrderStorageFailure(t('processOrderFailed'), 'order.create', null, originContext);
        setSubmitting(false);
      }
      return;
    }
    const existingAttempt =
      storedAttempt &&
      storedAttempt.userId === originUserId &&
      doesAttemptMatchStore(storedAttempt, currentStoreId, initialStoreIdRef.current) &&
      fingerprintsMatchAcrossScheduleToggle(storedAttempt.cartFingerprint, cartFingerprint) &&
      storedAttempt.orderIdempotencyKey &&
      storedAttempt.paymentIdempotencyKey
        ? storedAttempt
        : null;
    const preservedPrepaidScheduledFor = existingAttempt
      ? parseStoredAttemptScheduledFor(existingAttempt.cartFingerprint)
      : undefined;
    const savedPaymentRequest =
      existingAttempt?.bill && existingAttempt.paymentFingerprint
        ? parsePrepaidPaymentRequest(existingAttempt.paymentFingerprint)
        : null;
    if (existingAttempt?.bill && existingAttempt.paymentFingerprint && !savedPaymentRequest) {
      if (isSessionCurrent()) {
        reportOrderFailure({
          code: 'request.outcome_unknown',
          title: t('processOrderFailed'),
          message: t('operationOutcomeUnknown'),
          nextStep: t('operationCheckBeforeRetry'),
          detail:
            'The saved payment request could not be validated, so no replacement payment was submitted',
          status: null,
          operation: 'payment.create',
          stage: 'recovery',
          outcome: 'unknown',
          reasonCode: 'request.outcome_unknown',
          correlationId: existingAttempt.operationId,
          originContext,
        });
        setSubmitting(false);
      }
      return;
    }
    if (savedPaymentRequest && existingAttempt) {
      paymentLines = savedPaymentRequest.payments;
      paymentFingerprint = existingAttempt.paymentFingerprint;
    }
    if (existingAttempt?.bill) {
      const recoveryOperationId = existingAttempt.operationId || createOperationReference();
      try {
        const { data } = await api.get(`/bills/${existingAttempt.bill.id}`, {
          headers: {
            ...pinnedAuthHeaders(originToken),
            ...operationHeaders(recoveryOperationId),
          },
        });
        if (!isSessionCurrent()) return;
        if (!data?.bill || !['paid', 'partial', 'unpaid'].includes(data.bill.payment_status)) {
          throw new Error('Bill status unavailable');
        }
      } catch (recoveryError) {
        if (!isSessionCurrent()) return;
        if (!(recoveryError as { response?: unknown } | null)?.response && recoveryOperationId) {
          void captureClientOperationFailure({
            operation: 'payment.create',
            phase: 'recovery',
            correlationId: recoveryOperationId,
          });
        }
        reportOrderFailure({
          code: 'request.outcome_unknown',
          title: t('processOrderFailed'),
          message: t('operationOutcomeUnknown'),
          nextStep: t('operationCheckBeforeRetry'),
          detail: 'The bill status could not be confirmed before retrying payment',
          status: null,
          operation: 'payment.create',
          stage: 'recovery',
          outcome: 'unknown',
          reasonCode: 'request.outcome_unknown',
          correlationId: recoveryOperationId,
          originContext,
        });
        setSubmitting(false);
        return;
      }
    }
    if (!isSessionCurrent()) return;
    const currentDiscount = savedPaymentRequest
      ? existingAttempt?.discount || null
      : discount && discount.value > 0
        ? discount
        : null;
    const discountFingerprint = (value: PrepaidDiscount | null | undefined) =>
      JSON.stringify(value ? { type: value.type, value: value.value, reason: value.reason } : null);
    const discountChanged =
      !!existingAttempt &&
      !savedPaymentRequest &&
      discountFingerprint(existingAttempt.discount) !== discountFingerprint(currentDiscount);
    const retryDiscount = currentDiscount;
    let attempt: PrepaidAttempt = existingAttempt
      ? {
          ...existingAttempt,
          discount: retryDiscount,
          bill: discountChanged ? undefined : existingAttempt.bill,
          paymentFingerprint,
          paymentIdempotencyKey:
            savedPaymentRequest ||
            (existingAttempt.paymentFingerprint === paymentFingerprint && !discountChanged)
              ? existingAttempt.paymentIdempotencyKey
              : newIdempotencyKey(),
        }
      : {
          userId: originUserId || '',
          cartFingerprint,
          paymentFingerprint,
          discount: discount && discount.value > 0 ? discount : null,
          orderIdempotencyKey: newIdempotencyKey(),
          paymentIdempotencyKey: newIdempotencyKey(),
          operationId: createOperationReference() || undefined,
        };
    const operationId = attempt.operationId || createOperationReference();
    if (operationId && attempt.operationId !== operationId) attempt = { ...attempt, operationId };
    // Persist the keys before the first order mutation. The server replays the
    // order response if this renderer loses the response or restarts.
    if (!savePrepaidAttempt(attempt, originUserId)) {
      if (!isSessionCurrent()) return;
      reportOrderStorageFailure(
        t('processOrderFailed'),
        'order.create',
        operationId || null,
        originContext,
      );
      setSubmitting(false);
      return;
    }
    let orderData: { order: Order } | null = null;
    let billData: { bill: Bill } | null = null;
    let failureOperation = 'order.create';
    let failureStage = 'submission';
    let failureCorrelationId: string | null = null;
    let committedOrder: Order | null = attempt.order || null;
    let attemptedScheduledFor: string | undefined;
    try {
      failureCorrelationId = operationId;
      if (operationId && attempt.operationId !== operationId) {
        attempt = { ...attempt, operationId };
        requirePrepaidAttemptSaved(attempt, originUserId);
      }
      if (attempt.order) {
        orderData = { order: attempt.order };
      } else {
        failureOperation = 'order.create';
        failureStage = 'submission';
        const resolvedPrepaidScheduledFor = resolveRetryScheduledFor({
          orderType: cart.orderType,
          scheduledOrdersEnabled,
          cartScheduledFor: cart.scheduledFor,
          preservedScheduledFor: preservedPrepaidScheduledFor,
        });
        attemptedScheduledFor = resolvedPrepaidScheduledFor;
        const { data } = await api.post(
          '/orders',
          {
            table_id: cart.tableId,
            customer_id: cart.customerId,
            type: cart.orderType,
            guest_count: cart.guestCount,
            special_instructions: cart.orderNotes || undefined,
            online_platform:
              cart.orderType === 'online' ? cart.onlinePlatform || undefined : undefined,
            external_order_id:
              cart.orderType === 'online' ? cart.externalOrderId || undefined : undefined,
            delivery_address:
              cart.orderType === 'delivery' ? cart.deliveryAddress || undefined : undefined,
            expected_payment_method:
              cart.orderType === 'delivery' ? cart.expectedPaymentMethod || undefined : undefined,
            expected_payment_method_id:
              cart.orderType === 'delivery'
                ? (cart.expectedPaymentMethodId ?? undefined)
                : undefined,
            delivery_note:
              cart.orderType === 'delivery' ? cart.deliveryNote || undefined : undefined,
            scheduled_for: resolvedPrepaidScheduledFor,
            waived_charge_ids: Array.from(cart.waivedChargeIds),
            opted_in_charge_ids: Array.from(cart.optedInChargeIds),
            items: orderItems,
          },
          {
            headers: {
              ...pinnedAuthHeaders(originToken),
              'Idempotency-Key': attempt.orderIdempotencyKey,
              ...operationHeaders(operationId),
            },
          },
        );
        orderData = data;
        committedOrder = data.order as Order;
        requirePrepaidAttemptSaved({ ...attempt, order: data.order }, originUserId);
        if (!isSessionCurrent()) {
          // Order succeeded on the server while session changed.
          // Recovery record is preserved under originUserId. Stop before generating/paying bill under new user.
          if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
            useCartStore.getState().clearCart();
          }
          return;
        }
      }
      if (!orderData) throw new Error('Order result unavailable');
      const order = orderData.order;
      const orderId = order.id;

      // Apply discount before bill generation so bill totals reflect discounted net amounts.
      const effectiveDiscount = attempt.discount;
      const discountForRequest =
        effectiveDiscount &&
        currentDiscount &&
        discountFingerprint(effectiveDiscount) === discountFingerprint(currentDiscount)
          ? {
              ...effectiveDiscount,
              override_pin: currentDiscount.override_pin,
              approver_id: currentDiscount.approver_id,
            }
          : effectiveDiscount;
      let discountAlreadyApplied = false;
      if (
        !attempt.bill &&
        (discountChanged || (effectiveDiscount && effectiveDiscount.value > 0)) &&
        attempt.order
      ) {
        try {
          const { data: currentOrderData } = await api.get(`/orders/${orderId}`, {
            headers: {
              ...pinnedAuthHeaders(originToken),
              ...operationHeaders(operationId),
            },
          });
          if (!isSessionCurrent()) return;
          const serverDiscount =
            currentOrderData.order?.discount_type &&
            Number(currentOrderData.order.discount_value) > 0
              ? {
                  type: currentOrderData.order.discount_type,
                  value: Number(currentOrderData.order.discount_value),
                  reason: currentOrderData.order.discount_reason || undefined,
                }
              : null;
          discountAlreadyApplied =
            discountFingerprint(serverDiscount) === discountFingerprint(effectiveDiscount);
        } catch {
          // If the order cannot be read, retain the safe retry behavior below;
          // an approval PIN may be required to reapply an uncertain discount.
        }
      }
      if (!isSessionCurrent()) return;
      if (
        !attempt.bill &&
        !discountAlreadyApplied &&
        (discountChanged || (effectiveDiscount && effectiveDiscount.value > 0))
      ) {
        failureOperation = 'order.discount';
        failureStage = 'discount';
        await api.patch(
          `/orders/${orderId}/discount`,
          {
            discount_type: discountForRequest?.type || 'percentage',
            discount_value: discountForRequest?.value || 0,
            discount_reason: discountForRequest?.reason,
            override_pin: discountForRequest?.override_pin,
            approver_id: discountForRequest?.approver_id,
          },
          {
            headers: {
              ...pinnedAuthHeaders(originToken),
              ...operationHeaders(operationId),
            },
          },
        );
        if (!isSessionCurrent()) return;
      }

      if (attempt.bill) {
        billData = { bill: attempt.bill };
      } else {
        failureOperation = 'bill.generate';
        failureStage = 'bill_generation';
        const { data: generatedBill } = await api.post(
          '/bills/generate',
          { order_id: orderId },
          {
            headers: {
              ...pinnedAuthHeaders(originToken),
              ...operationHeaders(operationId),
            },
          },
        );
        billData = generatedBill;
        if (!isSessionCurrent()) {
          // Bill was generated on server while session changed. Stop here.
          if (generatedBill?.bill) {
            savePrepaidAttempt({ ...attempt, order, bill: generatedBill.bill }, originUserId);
          }
          if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
            useCartStore.getState().clearCart();
          }
          return;
        }
      }
      if (!billData) throw new Error('Bill result unavailable');
      const bill = billData.bill;
      const paymentRequest = savedPaymentRequest || {
        payments: paymentLines,
        customer_id: bill.customer_id ?? order.customer_id ?? null,
      };
      const exactPaymentFingerprint = savedPaymentRequest
        ? attempt.paymentFingerprint
        : JSON.stringify(paymentRequest);
      if (attempt.paymentFingerprint !== exactPaymentFingerprint || !attempt.bill) {
        failureOperation = attempt.bill ? 'payment.create' : 'bill.generate';
        failureStage = 'retry_state';
        attempt = { ...attempt, order, bill, paymentFingerprint: exactPaymentFingerprint };
        requirePrepaidAttemptSaved(attempt, originUserId);
      }
      if (!isSessionCurrent()) return;

      // Record every split in one atomic request. The persisted bill/key pair
      // makes a lost response safe to retry without creating a second order.
      failureOperation = 'payment.create';
      failureStage = 'payment_submission';
      const paymentResponse = await api.post(`/bills/${bill.id}/payments`, paymentRequest, {
        headers: {
          ...pinnedAuthHeaders(originToken),
          'Idempotency-Key': attempt.paymentIdempotencyKey,
          ...operationHeaders(operationId),
        },
      });
      const paidBill: Bill = paymentResponse.data?.bill || bill;
      const pointsEarned =
        paymentResponse.data?.loyaltyPointsEarned > 0
          ? paymentResponse.data.loyaltyPointsEarned
          : 0;

      if (!isSessionCurrent()) {
        savePrepaidAttempt({ ...attempt, order, bill: paidBill }, originUserId);
        if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
          useCartStore.getState().clearCart();
        }
        return;
      }

      if (paidBill.payment_status !== 'paid') {
        const incompleteMessage = t('paymentIncomplete', {
          amount: currencyFmt(Number(paidBill.balance) || 0),
        });
        savePrepaidAttempt(
          {
            ...attempt,
            bill: paidBill,
            paymentFingerprint: '',
            paymentIdempotencyKey: newIdempotencyKey(),
          },
          originUserId,
        );
        reportOrderFailure({
          code: 'payment.incomplete',
          title: incompleteMessage,
          message: incompleteMessage,
          nextStep: t('openOrdersToPay'),
          detail: 'The bill remains partially unpaid after the recorded payment',
          status: null,
          operation: 'payment.create',
          stage: 'completion',
          outcome: 'partial',
          reasonCode: 'payment.incomplete',
          correlationId: operationId,
          originContext,
        });
        return;
      }

      const completedAttempt = { ...attempt, order, bill: paidBill };
      if (!savePrepaidAttempt(completedAttempt, originUserId)) {
        // Payment is confirmed. Keep that fact in memory and never turn a
        // local retry-state write failure into advice to charge again.
        if (originUserId === activeUserId) {
          prepaidAttemptRef.current = stripPrepaidDiscountPin(completedAttempt);
        }
        if (operationId)
          void captureClientOperationFailure({
            operation: 'payment.create',
            phase: 'retry_state_update',
            correlationId: operationId,
          });
        reportOrderFailure({
          code: 'payment.retry_state.persist_failed',
          title: t('orderPaid', { number: order.order_number }),
          message: t('saleCompleteCleanupFailed'),
          nextStep: t('saleCompleteCheckOrders'),
          detail:
            'Payment completed but local retry state could not be updated with the confirmed bill',
          status: null,
          operation: 'payment.create',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'payment.retry_state.persist_failed',
          correlationId: operationId,
          operationFailure: operationId
            ? {
                capture_point: 'fc.client.payment.create.retry_state_update',
                operation_id: operationId,
                outcome: 'applied',
              }
            : undefined,
          originContext,
        });
      }

      const successMsg =
        pointsEarned > 0
          ? t('orderPaidWithPoints', { number: order.order_number, points: pointsEarned })
          : t('orderPaid', { number: order.order_number });
      toast.success(successMsg);
      if (cart.tableId) {
        try {
          const deleted = await heldOrders.removeHeldOrder(
            cart.tableId,
            cart.heldOrderId || undefined,
          );
          if (!deleted && isSessionCurrent()) await heldOrders.fetchHeldOrders();
        } catch (heldOrderError) {
          // The payment is complete; clearing the held-order record is cleanup.
          console.error('Failed to clear held order after payment', heldOrderError);
          if (!(heldOrderError as { response?: unknown } | null)?.response && operationId) {
            void captureClientOperationFailure({
              operation: 'payment.create',
              phase: 'held_cleanup',
              correlationId: operationId,
            });
          }
          if (isSessionCurrent()) {
            reportOrderFailure({
              code: 'order.held_state.cleanup_failed',
              title: t('orderPaid', { number: order.order_number }),
              message: t('saleCompleteCleanupFailed'),
              nextStep: t('saleCompleteCheckOrders'),
              detail: 'Payment completed but its held-order record could not be refreshed',
              status: null,
              operation: 'payment.create',
              stage: 'cleanup',
              outcome: 'applied',
              reasonCode: 'order.held_state.cleanup_failed',
              correlationId: operationId,
              operationFailure:
                !(heldOrderError as { response?: unknown } | null)?.response && !!operationId
                  ? {
                      capture_point: 'fc.frontend.pos.payment.create.held_cleanup',
                      operation_id: operationId,
                      outcome: 'applied',
                    }
                  : undefined,
              originContext,
            });
          }
        }
      }
      if (!isSessionCurrent()) {
        if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
          useCartStore.getState().clearCart();
        }
        return;
      }
      cart.clearCart();
      if (!clearPrepaidAttempt(originUserId)) {
        if (operationId)
          void captureClientOperationFailure({
            operation: 'payment.create',
            phase: 'retry_cleanup',
            correlationId: operationId,
          });
        reportOrderFailure({
          code: 'payment.retry_state.cleanup_failed',
          title: t('orderPaid', { number: order.order_number }),
          message: t('saleCompleteCleanupFailed'),
          nextStep: t('saleCompleteCheckOrders'),
          detail: 'Payment completed but local retry state could not be cleared',
          status: null,
          operation: 'payment.create',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'payment.retry_state.cleanup_failed',
          correlationId: operationId,
          originContext,
        });
      }
      setMobileCartOpen(false);
      await refreshTables();
      void refreshScheduledOrders();
      if (!isSessionCurrent()) return;

      await printKotIfEnabled(order, originContext);
      if (!isSessionCurrent()) return;

      await printBillForTenant(
        { ...paidBill, order: paidBill.order ?? bill.order ?? order },
        isPrepaidCheckout,
        undefined,
        originContext,
      );
    } catch (error) {
      if (!isSessionCurrent()) return;
      if (error instanceof OrderAttemptStorageError && committedOrder) {
        if (
          failureOperation === 'payment.create' &&
          failureStage === 'retry_state' &&
          failureCorrelationId
        ) {
          void captureClientOperationFailure({
            operation: 'payment.create',
            phase: 'retry_storage',
            correlationId: failureCorrelationId,
          });
        }
        if (
          failureOperation === 'bill.generate' &&
          failureStage === 'retry_state' &&
          failureCorrelationId
        ) {
          void captureClientOperationFailure({
            operation: 'bill.generate',
            phase: 'retry_state_update',
            correlationId: failureCorrelationId,
          });
        }
        if (failureOperation === 'order.create' && failureCorrelationId) {
          void captureClientOperationFailure({
            operation: 'order.create',
            phase: 'retry_state_update',
            correlationId: failureCorrelationId,
          });
        }
        cart.clearCart();
        setMobileCartOpen(false);
        // Keep the durable pre-order key: replaying it after reload returns the
        // already-created order without creating another one.
        reportOrderFailure({
          code: 'order.retry_state.persist_failed',
          title: t('orderPlaced', { number: committedOrder.order_number }),
          message: t('orderCreatedPaymentNotStarted'),
          nextStep: t('openOrdersToPay'),
          detail:
            failureOperation === 'bill.generate'
              ? 'The bill was generated, but local payment retry state could not be saved before payment'
              : 'Order was created, but local checkout recovery state could not be saved before payment',
          status: null,
          operation: failureOperation === 'bill.generate' ? 'bill.generate' : 'order.create',
          stage: failureOperation === 'bill.generate' ? 'retry_state' : failureStage,
          outcome: 'applied',
          reasonCode:
            failureOperation === 'bill.generate'
              ? 'bill.retry_state.persist_failed'
              : 'order.retry_state.persist_failed',
          correlationId: failureCorrelationId,
          operationFailure:
            failureOperation === 'bill.generate' && failureCorrelationId
              ? {
                  capture_point: 'fc.client.bill.generate.retry_state_update',
                  operation_id: failureCorrelationId,
                  outcome: 'applied',
                }
              : undefined,
          originContext,
        });
      } else if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(
          t('processOrderFailed'),
          failureOperation === 'payment.create' ? 'payment.create' : 'order.create',
          failureCorrelationId,
          originContext,
        );
      else {
        if (
          failureOperation === 'order.create' &&
          !committedOrder &&
          attemptedScheduledFor &&
          isDefinitiveScheduleRejection(error, failureCorrelationId)
        ) {
          clearPrepaidAttempt(originUserId);
          setPrepaidModalAttempt(null);
          if (
            !scheduledOrdersEnabled ||
            getScheduleRejectionCode(error) === 'SCHEDULED_ORDERS_DISABLED'
          ) {
            setScheduledOrdersEnabled(false);
            if (useCartStore.getState().scheduledFor.trim()) {
              useCartStore.getState().setScheduledFor('');
            }
          }
        }
        if (failureOperation === 'payment.create' && attempt.bill) {
          const failure = classifyOrderRequestFailure(error, {
            operation: 'payment.create',
            correlationId: failureCorrelationId || '',
          });
          if (
            failure.trusted &&
            failure.outcome === 'not_applied' &&
            failure.displayCode !== 'idempotency_conflict'
          ) {
            savePrepaidAttempt(
              {
                ...attempt,
                paymentFingerprint: '',
                paymentIdempotencyKey: newIdempotencyKey(),
              },
              originUserId,
            );
          }
        }
        reportOrderRequestFailure(
          error,
          t('processOrderFailed'),
          failureOperation,
          failureStage,
          failureCorrelationId,
          originContext,
        );
      }
    } finally {
      if (isSessionCurrent() && activeSubmissionTokenRef.current === submissionToken) {
        setSubmitting(false);
        activeSubmissionTokenRef.current = null;
      }
    }
  };

  const handleSelectAvailableTable = (
    tableId: string,
    customer?: { id: string; name: string; phone: string } | null,
  ) => {
    const cartCustomerWasInherited = cart.customerSource === 'reservation';

    cart.setTableId(tableId);
    if (customer && (!cart.customerId || cartCustomerWasInherited)) {
      cart.setReservationCustomer({
        ...customer,
        email: null,
        visits_count: 0,
        total_spent: 0,
        last_visit_at: null,
        country_code: '',
      });
    } else if (!customer && cartCustomerWasInherited) {
      cart.setCustomer(null);
    }
    setShowTablePicker(false);
  };

  const handleSelectOccupiedTable = async (table: Table) => {
    const activeOrder = table.current_order || table.activeOrder || null;
    const activeCustomerId = activeOrder?.customer_id;
    const activeCustomerName = activeOrder?.customer?.name || t('anotherCustomer');

    if (
      cart.customerId != null &&
      activeCustomerId != null &&
      String(cart.customerId) !== String(activeCustomerId)
    ) {
      const shouldProceed = await confirm(
        t('customerMismatchWarning', { customer: activeCustomerName }),
        {
          title: t('customerMismatchTitle'),
          confirmLabel: t('proceedAnyway'),
        },
      );

      if (!shouldProceed) return;
    }

    setShowTablePicker(false);
    setCheckoutTable(table);
  };

  const handleSelectHeldTable = async (tableId: string) => {
    try {
      const held = await heldOrders.restoreOrder(tableId);
      if (held) {
        // Settle the target type first so the type change cannot clear the saved
        // charge selections that loadItems installs afterwards.
        cart.setOrderType('dine_in');
        cart.loadItems(
          held.items,
          tableId,
          held.customerId,
          held.guestCount,
          held.orderNotes,
          held.id,
          held.waivedChargeIds,
          held.optedInChargeIds,
        );
      } else {
        await heldOrders.fetchHeldOrders();
        toast.error(t('loadOrderFailed'));
      }
    } catch {
      toast.error(t('loadOrderFailed'));
    } finally {
      setShowTablePicker(false);
      await refreshTables();
    }
  };

  const handleHoldTable = async (tableId: string) => {
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === tableId)?.name || tableId;
    try {
      await heldOrders.holdOrder(
        tableId,
        cart.items,
        cart.customerId,
        cart.guestCount,
        cart.orderNotes,
        [...cart.waivedChargeIds],
        [...cart.optedInChargeIds],
      );
      cart.clearCart();
      setShowTablePicker(false);
      toast.success(t('orderHeld', { tableName }));
      await refreshTables();
    } catch {
      toast.error(t('holdOrderFailed'));
    }
  };

  const handleAddItemsToOrder = (table: Table, order: Order) => {
    setCheckoutTable(null);
    cart.setTableId(table.id);
    cart.setOrderType('dine_in');
    cart.setGuestCount(order.guest_count || 1);
    cart.setOrderNotes(order.special_instructions || '');
    setPendingOrder(order);
    toast(`${t('addingItemsToOrder', { number: order.order_number })} ${t('placeOrderReady')}`, {
      icon: 'ℹ️',
    });
  };

  // Add cart items directly to existing order
  const handleAddCartToOrder = async (table: Table, order: Order) => {
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return;
    }
    setSubmitting(true);
    const originContext = readLiveSupportContext();
    const originUserId = originContext.userId;
    const originToken = originContext.token;
    const submissionToken = Symbol('pos-add-cart-to-order');
    activeSubmissionTokenRef.current = submissionToken;

    const isSessionCurrent = () => checkSessionCurrent(originContext);

    const operationId = createOperationReference();
    try {
      const cartFingerprint = buildCurrentCartFingerprint();
      const items = cart.items.map(cartItemToOrderItem);
      const specialInstructions = order.special_instructions || undefined;
      const fingerprint = buildAppendItemsFingerprint(order.id, items, specialInstructions);
      const storage = getAppendAttemptStorage();
      const itemAttempt = getOrCreateAppendAttempt(storage, {
        userId: originUserId || '',
        orderId: order.id,
        fingerprint,
        createKey: newIdempotencyKey,
        items,
        specialInstructions,
        orderNumber: order.order_number,
        operationId: operationId || undefined,
      });
      if (originUserId === activeUserId) {
        addItemsAttemptRef.current = itemAttempt;
      }
      const { data } = await api.post(
        `/orders/${order.id}/items`,
        {
          items,
          special_instructions: specialInstructions,
        },
        {
          headers: {
            ...pinnedAuthHeaders(originToken),
            'Idempotency-Key': itemAttempt.idempotencyKey,
            ...operationHeaders(itemAttempt.operationId),
          },
        },
      );
      if (!isSessionCurrent()) {
        // Items append succeeded on server while session changed. Stop before mutating state.
        if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
          useCartStore.getState().clearCart();
        }
        return;
      }
      // A resolved response is the confirmation boundary. Keep the durable
      // attempt through all network errors so a lost response can replay it.
      const cleared = clearAppendAttempt(storage, itemAttempt);
      if (!cleared && itemAttempt.operationId) {
        void captureClientOperationFailure({
          operation: 'order.append',
          phase: 'retry_cleanup',
          correlationId: itemAttempt.operationId,
        });
        reportOrderFailure({
          code: 'order.append.retry_state.cleanup_failed',
          title: t('itemsAddedToOrder', { number: order.order_number }),
          message: t('appendCompleteCleanupFailed'),
          nextStep: t('appendCompleteCheckOrders'),
          detail: 'Items were added to the order but local retry state could not be cleared',
          status: null,
          operation: 'order.append',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'order.append.retry_state.cleanup_failed',
          correlationId: itemAttempt.operationId,
          originContext,
        });
      }
      addItemsAttemptRef.current = null;
      toast.success(t('itemsAddedToOrder', { number: order.order_number }));
      const updatedOrder = data.order as Order;
      const existingItemIds = new Set((order.items || []).map((item) => Number(item.id)));
      const appendedItems =
        Array.isArray(data.added_items) && data.added_items.length > 0
          ? data.added_items
          : (updatedOrder.items || []).filter((item) => !existingItemIds.has(Number(item.id)));
      await printKotIfEnabled(
        appendedItems.length > 0 ? { ...updatedOrder, items: appendedItems } : updatedOrder,
        originContext,
      );
      if (!isSessionCurrent()) {
        if (buildCartFingerprint(useCartStore.getState()) === cartFingerprint) {
          useCartStore.getState().clearCart();
        }
        return;
      }
      cart.clearCart();
      setCheckoutTable(null);
      refreshTables();
    } catch (error) {
      if (!isSessionCurrent()) return;
      if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(t('addItemsFailed'), 'order.append', operationId, originContext);
      else
        reportOrderRequestFailure(
          error,
          t('addItemsFailed'),
          'order.append',
          'append_items',
          operationId,
          originContext,
        );
    } finally {
      if (isSessionCurrent() && activeSubmissionTokenRef.current === submissionToken) {
        setSubmitting(false);
        activeSubmissionTokenRef.current = null;
      }
    }
  };

  const handlePaymentComplete = async () => {
    const originContext = readLiveSupportContext();
    const isSessionCurrent = () => checkSessionCurrent(originContext);

    const bill = paymentBill; // capture before clearing state
    setPaymentBill(null);
    setCheckoutOverridePin(undefined);
    setCheckoutTable(null);
    refreshTables();
    void refreshScheduledOrders();
    void refreshPaymentQueueCounts();
    setPaymentQueueRefreshKey((k) => k + 1);

    if (bill) {
      try {
        const latestBill = await fetchLatestBill(bill.id);
        if (!isSessionCurrent()) return;
        await printBillForTenant(
          { ...latestBill, order: latestBill.order ?? bill.order },
          false,
          undefined,
          originContext,
        );
      } catch {
        if (isSessionCurrent()) {
          toast.error(t('receiptPrintFailed'));
        }
      }
    }
  };

  const handleAddItemsToScheduledOrder = (order: Order) => {
    setShowScheduledOrders(false);
    setCheckoutTable(null);
    cart.setTableId(null);
    cart.setOrderType(order.type);
    cart.setScheduledFor('');
    cart.setDeliveryAddress('');
    cart.setExpectedPaymentMethod('', null);
    cart.setDeliveryNote('');
    cart.setOrderNotes(order.special_instructions || '');
    setPendingOrder(order);
    toast(`${t('addingItemsToOrder', { number: order.order_number })} ${t('placeOrderReady')}`, {
      icon: 'ℹ️',
    });
  };

  const handlePayScheduledOrder = async (order: Order) => {
    if (!canPayScheduledOrder(order)) return;
    try {
      const existingBills =
        order.bills && order.bills.length > 0 ? order.bills : order.bill ? [order.bill] : [];
      const payableBill = existingBills.find(isPayableBill);
      let billToPay: Bill;
      if (payableBill) {
        billToPay = await fetchLatestBill(payableBill.id);
      } else {
        const { data } = await api.post('/bills/generate', { order_id: order.id });
        billToPay = data.bill as Bill;
      }
      if (!isPayableBill(billToPay)) {
        await refreshScheduledOrders();
        return;
      }
      setCheckoutOverridePin(undefined);
      setPaymentBill(billToPay);
      void refreshScheduledOrders();
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string } } })?.response?.data;
      toast.error(errData?.error || t('billOutcomeUnknown'));
    }
  };

  const handleScheduledOrderReleased = async (releasedOrder: Order, kotAutoPrinted: boolean) => {
    await refreshScheduledOrders();
    if (!kotAutoPrinted) {
      const originContext = readLiveSupportContext();
      await printKotIfEnabled({ ...releasedOrder, release_status: 'released' }, originContext);
    }
  };

  const totalActiveScheduled = Math.max(
    scheduledCount + blockedScheduledCount,
    scheduledOrders.filter(
      (o) =>
        o.status !== 'cancelled' &&
        o.status !== 'completed' &&
        (o.release_status === 'scheduled' || o.release_status === 'blocked'),
    ).length,
  );
  const totalBlockedScheduled = Math.max(
    blockedScheduledCount,
    scheduledOrders.filter(
      (o) => o.status !== 'cancelled' && o.status !== 'completed' && o.release_status === 'blocked',
    ).length,
  );

  const cartPanelProps = {
    tables,
    currency,
    submitting,
    onPlaceOrder: handlePlaceOrder,
    onSendToPayment: handleSendToPayment,
    onOpenPaymentQueue: () => setShowPaymentQueue(true),
    counterRole: activeCounter?.role || null,
    multiCounterEnabled,
    scheduledOrdersEnabled,
    onEditItem: setEditingCartItem,
    onModalOpenChange: setCartPanelModalOpen,
    existingOrder: pendingOrder,
    storeTimezone,
    onCancelExistingOrderMode: () => {
      setPendingOrder(null);
      cart.clearCart();
    },
  };

  const itemCount = cart.itemCount();

  usePosKeyboardShortcuts(
    {
      onFocusSearch: () => {
        dispatchQuickSearchRequest();
      },
      onTender: () => {
        if (!submitting && cart.items.length > 0) {
          if (pendingOrder) {
            void handlePlaceOrder();
          } else if (
            multiCounterEnabled &&
            activeCounter?.role === 'ordering' &&
            (cart.orderType === 'takeaway' || cart.orderType === 'dine_in')
          ) {
            void handleSendToPayment();
          } else {
            void handlePlaceOrder();
          }
        }
      },
      onToggleTables: () => {
        if (isRestaurant && cart.orderType === 'dine_in' && tablesRequired) {
          setShowTablePicker((prev) => !prev);
        }
      },
      onOpenCheckout: () => {
        if (pendingOrder) {
          if (!submitting && cart.items.length > 0) void handlePlaceOrder();
          return;
        }
        if (
          multiCounterEnabled &&
          activeCounter?.role === 'ordering' &&
          (cart.orderType === 'takeaway' || cart.orderType === 'dine_in')
        ) {
          if (!submitting && cart.items.length > 0) {
            void handleSendToPayment();
          }
          return;
        }
        if (
          shouldTakePaymentNow ||
          !isRestaurant ||
          cart.orderType !== 'dine_in' ||
          !tablesRequired
        ) {
          void handlePlaceOrder();
          return;
        }
        if (!validateOrderPreflight()) return;
        if (cart.tableId) {
          const tbl = tables.find((t) => t.id === cart.tableId);
          if (tbl) setCheckoutTable(tbl);
          else setShowTablePicker(true);
        } else {
          setShowTablePicker(true);
        }
      },
      onOpenCashMovement: () => {
        cashDrawer.openModal();
      },
      onFocusCustomer: () => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="pos-customer-search-input"]',
        );
        if (input) {
          input.focus();
          input.select();
          return;
        }
        document
          .querySelector<HTMLButtonElement>('[data-testid="pos-customer-select-btn"]')
          ?.click();
      },
      onHoldOrder: () => {
        if (
          isRestaurant &&
          cart.orderType === 'dine_in' &&
          cart.tableId &&
          cart.items.length > 0 &&
          billingType === 'postpaid'
        ) {
          const tableName = tables.find((t) => t.id === cart.tableId)?.name || cart.tableId;
          heldOrders
            .holdOrder(
              cart.tableId,
              cart.items,
              cart.customerId,
              cart.guestCount,
              cart.orderNotes,
              [...cart.waivedChargeIds],
              [...cart.optedInChargeIds],
            )
            .then(() => {
              cart.clearCart();
              toast.success(t('orderHeldFor', { table: tableName }));
            })
            .catch(() => {
              toast.error(t('holdOrderFailed'));
            });
        }
      },
      onToggleFullscreen: () => {
        toggleFullscreen();
      },
      onDismissModalOrBlur: () => {
        if (showKeyboardShortcutsModal) {
          setShowKeyboardShortcutsModal(false);
          return true;
        }
        if (customerModalOpen || cartPanelModalOpen) {
          return false;
        }
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
          activeEl.blur();
          return true;
        }
        if (showTablePicker) {
          setShowTablePicker(false);
          return true;
        }
        if (addonProduct) {
          setAddonProduct(null);
          setAddonInitialVariant(null);
          return true;
        }
        if (editingCartItem) {
          setEditingCartItem(null);
          return true;
        }
        if (showCustomerPrompt) {
          setShowCustomerPrompt(false);
          return true;
        }
        if (showPrepaidCheckout) {
          setShowPrepaidCheckout(false);
          return true;
        }
        if (checkoutTable) {
          setCheckoutTable(null);
          return true;
        }
        if (paymentBill) {
          setPaymentBill(null);
          return true;
        }
        if (refundModalTarget) {
          setRefundModalTarget(null);
          return true;
        }
        if (showScheduledOrders) {
          setShowScheduledOrders(false);
          return true;
        }
        if (showPaymentQueue) {
          setShowPaymentQueue(false);
          setTimeout(() => {
            document.querySelector<HTMLElement>('[data-testid="pos-payment-queue-btn"]')?.focus();
          }, 0);
          return true;
        }
        if (cashDrawer.open) {
          cashDrawer.setOpen(false);
          return true;
        }
        if (showPrintMenuModal) {
          setShowPrintMenuModal(false);
          return true;
        }
        if (mobileCartOpen) {
          setMobileCartOpen(false);
          return true;
        }
        return false;
      },
      onIncrementLastItem: () => {
        const items = useCartStore.getState().items;
        if (items.length === 0) return;
        const last = items[items.length - 1];
        const step = fractionalQuantityStep(last.product);
        useCartStore
          .getState()
          .updateQuantity(
            last.id,
            step == null ? last.quantity + 1 : roundToQuantityPrecision(last.quantity + step, step),
          );
      },
      onDecrementLastItem: () => {
        const items = useCartStore.getState().items;
        if (items.length === 0) return;
        const last = items[items.length - 1];
        const step = fractionalQuantityStep(last.product);
        useCartStore
          .getState()
          .updateQuantity(
            last.id,
            step == null ? last.quantity - 1 : roundToQuantityPrecision(last.quantity - step, step),
          );
      },
      onClearCart: async () => {
        if (cart.items.length === 0) return;
        const confirmed = await confirm(t('clearAmount') + '?', {
          title: t('cart'),
          confirmLabel: tCommon('clear'),
          destructive: true,
        });
        if (confirmed) cart.clearCart();
      },
      onShowHelp: () => {
        setShowKeyboardShortcutsModal((prev) => !prev);
      },
    },
    {
      enabled: true,
      anyModalOpen,
      tablePickerOpen: showTablePicker && !anyOtherModalOpen,
      cartItemCount: cart.items.length,
    },
  );

  return (
    <>
      {supportError && (
        <div
          data-testid="pos-support-error-panel"
          data-classification={supportError.classification || 'unexpected_failure'}
          data-variant={supportError.presentation.variant}
          className={`fixed bottom-4 start-4 z-50 w-[min(28rem,calc(100vw-2rem))] rounded-xl border bg-card p-4 shadow-xl ${
            supportError.presentation.variant === 'validation'
              ? 'border-amber-300 dark:border-amber-700'
              : 'border-red-200'
          }`}
        >
          {sentTicketId ? (
            <>
              <p
                className={`font-semibold ${
                  supportError.presentation.variant === 'validation'
                    ? 'text-amber-900 dark:text-amber-200'
                    : 'text-red-800'
                }`}
              >
                {tSupport('requestQueued')}
              </p>
              {delivery.status === 'delivered' && delivery.supportCode ? (
                <>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {tSupport('supportCode')}:{' '}
                    <Ltr as="span" className="font-mono">
                      {delivery.supportCode}
                    </Ltr>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {tSupport('supportCodeHint')}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  {delivery.status === 'failed'
                    ? tSupport('stillQueuedLocally')
                    : tSupport('confirmingDelivery')}
                </p>
              )}
              <div className="mt-3">
                <button
                  className="rounded border px-3 py-2 text-sm"
                  onClick={clearSupportErrorState}
                >
                  {tSupport('dismiss')}
                </button>
              </div>
            </>
          ) : (
            <>
              <p
                className={`font-semibold ${
                  supportError.presentation.variant === 'validation'
                    ? 'text-amber-900 dark:text-amber-200'
                    : 'text-red-800'
                }`}
              >
                {supportError.title}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{supportError.message}</p>
              <p className="mt-1 text-sm text-muted-foreground">{supportError.nextStep}</p>
              {(() => {
                const rejectionKind = supportError.presentation.rejectionKind;
                const correctiveGuidance =
                  rejectionKind === 'stock_insufficient'
                    ? supportError.presentation.affectedItem
                      ? t('validationStockGuidanceItem', {
                          item: supportError.presentation.affectedItem,
                        })
                      : t('validationStockGuidance')
                    : rejectionKind === 'shift_required'
                      ? t('validationShiftRequiredGuidance')
                      : rejectionKind === 'closed_books'
                        ? t('validationClosedBooksGuidance')
                        : null;
                const correctiveAction = resolvePosValidationAction(rejectionKind, {
                  canManageCatalog: tenantCan(currentTenant, 'catalog.manage'),
                  canUseShift,
                });
                const evidenceHint =
                  rejectionKind === 'stock_insufficient'
                    ? t('validationStockEvidenceHint')
                    : rejectionKind === 'shift_required'
                      ? t('validationShiftEvidenceHint')
                      : rejectionKind === 'closed_books'
                        ? t('validationClosedBooksEvidenceHint')
                        : supportError.presentation.isExpectedRejection
                          ? t('validationGenericEvidenceHint')
                          : null;
                return (
                  <>
                    {correctiveGuidance && (
                      <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/70 p-2 text-xs text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
                        <p>{correctiveGuidance}</p>
                        {correctiveAction?.kind === 'link' && (
                          <Link
                            href={correctiveAction.href}
                            className="mt-1 inline-block font-medium text-brand underline"
                          >
                            {correctiveAction.href === '/products'
                              ? t('validationOpenProducts')
                              : t('validationOpenInventory')}
                          </Link>
                        )}
                        {correctiveAction?.kind === 'open_shift' && (
                          <button
                            type="button"
                            onClick={() => shift.setOpenModalOpen(true)}
                            className="mt-1 inline-block text-start font-medium text-brand underline"
                          >
                            {t('validationOpenShiftAction')}
                          </button>
                        )}
                      </div>
                    )}
                    {evidenceHint && (
                      <p className="mt-1.5 text-xs text-muted-foreground">{evidenceHint}</p>
                    )}
                  </>
                );
              })()}
              <div className="mt-2.5 flex items-start gap-2">
                <input
                  id="pos-support-attach-log"
                  type="checkbox"
                  checked={attachLog}
                  onChange={(e) => setAttachLog(e.target.checked)}
                  className="mt-0.5 rounded border-border"
                />
                <div>
                  <label
                    htmlFor="pos-support-attach-log"
                    className="cursor-pointer text-xs font-medium text-foreground"
                  >
                    {tSupport('attachLog')}
                  </label>
                  <p className="text-[11px] text-muted-foreground">{tSupport('attachLogHint')}</p>
                </div>
              </div>
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{tSupport('showPayload')}</summary>
                <Ltr as="pre" className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2">
                  {JSON.stringify(
                    {
                      ...supportError.payload,
                      subject: supportError.subject,
                      correlation_id: supportError.ticketCorrelationId,
                      client_ticket_id: supportError.clientTicketId,
                      ...(attachLog ? { log_tail: `[${tSupport('attachLogHint')}]` } : {}),
                    },
                    null,
                    2,
                  )}
                </Ltr>
              </details>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded bg-brand px-3 py-2 text-sm font-medium text-white"
                  disabled={
                    supportSubmitting ||
                    !supportError.clientTicketId ||
                    !supportError.ticketCorrelationId
                  }
                  onClick={async () => {
                    if (supportSubmitTokenRef.current !== null) return;
                    const targetError = supportError;
                    if (
                      !isSupportErrorContextCurrent(targetError.context, readLiveSupportContext())
                    ) {
                      clearSupportErrorState();
                      return;
                    }
                    const submitToken = Symbol('pos-support-submit');
                    supportSubmitTokenRef.current = submitToken;
                    setSupportSubmitting(true);
                    try {
                      let logTail: string | undefined;
                      if (attachLog) {
                        if (
                          supportLogSnapshotRef.current?.clientTicketId ===
                            targetError.clientTicketId &&
                          supportLogSnapshotRef.current.logTail !== undefined
                        ) {
                          logTail = supportLogSnapshotRef.current.logTail;
                        } else {
                          const fetchedLogTail = await readBoundedSupportLogTail(
                            true,
                            typeof window !== 'undefined'
                              ? window.electronAPI?.getLogTail
                              : undefined,
                          );
                          const liveAfterLog = readLiveSupportContext();
                          if (!isSupportErrorContextCurrent(targetError.context, liveAfterLog)) {
                            clearSupportErrorState();
                            return;
                          }
                          if (supportSubmitTokenRef.current !== submitToken) {
                            return;
                          }
                          logTail = fetchedLogTail;
                          supportLogSnapshotRef.current = {
                            clientTicketId: targetError.clientTicketId,
                            logTail: fetchedLogTail,
                          };
                        }
                        if (
                          !isSupportErrorContextCurrent(
                            targetError.context,
                            readLiveSupportContext(),
                          )
                        ) {
                          clearSupportErrorState();
                          return;
                        }
                      }
                      const requestBody = buildPosSupportTicketRequestBody({
                        payload: targetError.payload,
                        subject: targetError.subject,
                        ticketCorrelationId: targetError.ticketCorrelationId,
                        clientTicketId: targetError.clientTicketId,
                        attachLog,
                        logTail,
                      });
                      await api.post('/support-ticket', requestBody, {
                        headers: pinnedAuthHeaders(targetError.context.token),
                      });
                      if (
                        !isSupportErrorContextCurrent(targetError.context, readLiveSupportContext())
                      ) {
                        clearSupportErrorState();
                        return;
                      }
                      if (supportSubmitTokenRef.current !== submitToken) {
                        return;
                      }
                      toast.success(tSupport('queued'));
                      setSentTicketId(targetError.clientTicketId);
                    } catch {
                      if (
                        !isSupportErrorContextCurrent(targetError.context, readLiveSupportContext())
                      ) {
                        clearSupportErrorState();
                        return;
                      }
                      if (supportSubmitTokenRef.current === submitToken) {
                        toast.error(t('supportRequestQueueFailed'));
                      }
                    } finally {
                      if (supportSubmitTokenRef.current === submitToken) {
                        supportSubmitTokenRef.current = null;
                        setSupportSubmitting(false);
                      }
                    }
                  }}
                >
                  {supportSubmitting ? tSupport('submitting') : tSupport('getHelp')}
                </button>
                {AI_HELP_PROVIDERS.map((provider) => (
                  <button
                    key={provider.id}
                    className="rounded border px-3 py-2 text-sm"
                    onClick={() => {
                      window.open(provider.url, '_blank', 'noopener,noreferrer');
                      void (async () => {
                        const diagnosticsMessage =
                          typeof supportError.payload.message === 'string'
                            ? supportError.payload.message
                            : undefined;
                        const copied = await copyPrinterDiagnostic(
                          supportError.message,
                          diagnosticsMessage,
                        );
                        toast(
                          copied
                            ? tSupport('askAiCopied', { provider: provider.label })
                            : tSupport('askAiCopyFailed', { provider: provider.label }),
                          { icon: copied ? '📋' : 'ℹ️' },
                        );
                      })();
                    }}
                  >
                    {tSupport('askAi')} · {provider.label}
                  </button>
                ))}
                <button
                  className="rounded border px-3 py-2 text-sm"
                  onClick={clearSupportErrorState}
                >
                  {tSupport('dismiss')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <PosTopbar
        products={products}
        onTopItemSelect={handleProductClick}
        showTableButton={isRestaurant && cart.orderType === 'dine_in' && tablesRequired}
        tableName={tables.find((tbl) => tbl.id === cart.tableId)?.name ?? null}
        onShowTablePicker={() => setShowTablePicker(true)}
        onActionsMenuOpenChange={setActionsMenuOpen}
        onShowCashMovement={cashDrawer.openModal}
        // Re-fetch on entry: the mount snapshot can be hours stale on a
        // multi-terminal POS (backend still guards stale operations). On a
        // load failure offer nothing — unknown state is not "no shift".
        onShowShift={async () => {
          const result = await shift.refresh();
          if (result.status !== 'ok') return;
          if (result.error) {
            toast.error(result.error || shift.shiftLoadFailedMessage);
            return;
          }
          if (result.session) shift.setCloseModalOpen(true);
          else shift.setOpenModalOpen(true);
        }}
        onShowCloseStaffShift={
          !shift.session && shift.openSessions.length > 0
            ? async () => {
                const result = await shift.refresh();
                if (result.status !== 'ok') return;
                if (result.error) {
                  toast.error(result.error || shift.shiftLoadFailedMessage);
                  return;
                }
                if (result.openSessions.length > 0) shift.setCloseModalOpen(true);
              }
            : undefined
        }
        shiftHasOpenSession={!!shift.session}
        shiftLoading={shift.loading}
        shiftError={shift.error}
        canUseShift={canUseShift}
        onShowPrintMenu={() => setShowPrintMenuModal(true)}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onCustomerModalOpenChange={setTopbarCustomerModalOpen}
        scheduledOrderCount={totalActiveScheduled}
        blockedScheduledCount={totalBlockedScheduled}
        scheduledOrdersEnabled={scheduledOrdersEnabled}
        multiCounterEnabled={multiCounterEnabled}
        counters={counters}
        activeCounter={activeCounter}
        onSelectCounter={handleSelectCounter}
        paymentQueueCount={paymentQueueCount}
        paymentQueueBlockedCount={paymentQueueBlockedCount}
        onShowPaymentQueue={() => setShowPaymentQueue(true)}
        onShowScheduledOrders={() => {
          void refreshScheduledOrders();
          api
            .get('/settings/business')
            .then((res) => {
              if (typeof res.data?.timezone === 'string' && res.data.timezone.trim()) {
                setStoreTimezone(res.data.timezone.trim());
              }
            })
            .catch(() => {});
          setShowScheduledOrders(true);
        }}
      />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden px-3 py-2 sm:px-4 sm:py-2.5 gap-3 sm:gap-4">
        {/* Product Grid — full width on mobile, flex-1 on desktop */}
        <div className="flex-1 min-w-0 h-full flex flex-col">
          <ProductGrid
            categories={categories}
            products={products}
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            search={search}
            setSearch={setSearch}
            currency={currency}
            onProductClick={handleProductClick}
            onScannedVariant={handleScannedVariant}
            onScaledProduct={(product, quantity) => cart.addItem(product, quantity)}
            sidebarOpen={leftSidebarOpen}
            categorySort={categorySort}
            itemSort={itemSort}
            collapseCategories
          />
        </div>

        {/* Desktop Cart — always open, hidden on mobile */}
        <div className="hidden md:flex md:w-80 md:shrink-0 h-full">
          <CartPanel {...cartPanelProps} />
        </div>
      </div>

      {/* Mobile: Floating Cart Button + Bottom Sheet — outside flex container */}
      <Drawer open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <DrawerTrigger asChild>
          <button
            className="touch-target fixed bottom-5 end-5 z-40 w-14 h-14 bg-brand text-white rounded-full shadow-lg hover:bg-brand-hover active:bg-brand-hover transition-colors md:hidden"
            aria-label={t('cart')}
          >
            <ShoppingCart size={22} />
            {itemCount > 0 && (
              <span className="absolute -top-0.5 -end-0.5 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                {itemCount}
              </span>
            )}
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[85vh]">
          <div className="overflow-y-auto max-h-[80vh] px-2 pb-2">
            <CartPanel {...cartPanelProps} variant="drawer" />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Modals */}
      <CashDrawerMovementModal model={cashDrawer} />
      <ShiftOpenModal model={shift} />
      <ShiftCloseModal model={shift} />
      {isRestaurant && showTablePicker && (
        <TablePickerModal
          tables={tables}
          selectedTableId={cart.tableId}
          onSelectAvailable={handleSelectAvailableTable}
          onSelectOccupied={handleSelectOccupiedTable}
          onSelectHeld={handleSelectHeldTable}
          onPlaceOrder={handlePlaceOrder}
          onHoldTable={handleHoldTable}
          onClose={() => setShowTablePicker(false)}
        />
      )}

      {addonProduct && (
        <AddonModal
          product={addonProduct}
          currency={currency}
          initialQuantity={addonInitialQuantity}
          initialVariant={addonInitialVariant}
          onlinePlatformSelected={
            cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0
          }
          onAdd={handleAddonAdd}
          onClose={() => {
            setAddonProduct(null);
            setAddonInitialQuantity(1);
            setAddonInitialVariant(null);
          }}
        />
      )}

      {editingCartItem && (
        <AddonModal
          product={editingCartItem.product}
          currency={currency}
          mode="edit"
          initialQuantity={editingCartItem.quantity}
          initialAddons={editingCartItem.addons}
          initialInstructions={editingCartItem.special_instructions}
          initialVariant={editingCartItem.variant}
          onlinePlatformSelected={
            cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0
          }
          onAdd={handleEditItemSave}
          onClose={() => setEditingCartItem(null)}
        />
      )}

      {checkoutTable && (
        <TableCheckoutModal
          table={checkoutTable}
          tables={tables}
          currency={currency}
          cartItemCount={cart.itemCount()}
          onClose={() => {
            setCheckoutTable(null);
            refreshTables();
          }}
          onAddItems={handleAddItemsToOrder}
          onPrintBill={async (bill, reservedWindow) => {
            const originContext = readLiveSupportContext();
            await printBillForTenant(bill, true, reservedWindow, originContext);
          }}
          reservePrintWindow={() => {
            const printer = usePrinterStore.getState();
            const expectedBrowserPrint =
              printer.printMethod === 'browser' ||
              (printer.printMethod === 'escpos' &&
                !printer.hardwarePrinter &&
                !printerService.isConnected &&
                printer.status !== 'connecting');
            return expectedBrowserPrint ? printerService.reserveBrowserPrintWindow() : undefined;
          }}
          canGenerateBill={tenantCan(currentTenant, 'bills.generate')}
          canReadBills={tenantCan(currentTenant, 'bills.read')}
          onPayment={(bill, overridePin) => {
            if (!checkoutTable) return;
            setCheckoutTable(null);
            setPaymentBill(bill);
            setCheckoutOverridePin(overridePin);
          }}
          onAddCartToOrder={(table, order) => {
            if (!checkoutTable) return;
            handleAddCartToOrder(table, order);
          }}
          onOrderMoved={({ sourceTable, targetTable }) => {
            if (cart.tableId === sourceTable.id) {
              cart.setTableId(targetTable.id);
            }
          }}
        />
      )}

      <ScheduledOrdersDrawer
        open={showScheduledOrders}
        orders={scheduledOrders}
        storeTimezone={storeTimezone}
        onClose={() => setShowScheduledOrders(false)}
        onRefresh={refreshScheduledOrders}
        onOrderReleased={handleScheduledOrderReleased}
        onAddItemsToOrder={handleAddItemsToScheduledOrder}
        onPayOrder={handlePayScheduledOrder}
        onRefundOrder={(order, bills) => setRefundModalTarget({ order, bills })}
        hasMore={Boolean(nextScheduledCursor)}
        loadingMore={loadingMoreScheduled}
        onLoadMore={handleLoadMoreScheduledOrders}
        totalScheduledCount={totalActiveScheduled}
      />

      <PaymentQueueDrawer
        open={showPaymentQueue}
        onClose={() => setShowPaymentQueue(false)}
        onPayOrder={handlePayScheduledOrder}
        refreshKey={paymentQueueRefreshKey}
        onRefundOrder={(order, bills) => {
          setShowPaymentQueue(false);
          setRefundModalTarget({ order, bills });
        }}
        onCountsChanged={(awaiting, blocked) => {
          setPaymentQueueCount(awaiting + blocked);
          setPaymentQueueBlockedCount(blocked);
        }}
        onQueueChanged={() => {
          void refreshPaymentQueueCounts();
          void refreshScheduledOrders();
        }}
      />

      <PaymentTicketConfirmationModal
        open={showTicketModal}
        order={ticketModalOrder}
        qrDataUrl={ticketModalQrDataUrl}
        qrPayload={ticketModalQrPayload}
        onClose={() => {
          setShowTicketModal(false);
          setTicketModalOrder(null);
          setTicketModalQrDataUrl(null);
          setTicketModalQrPayload(null);
        }}
      />

      {paymentBill && (
        <PaymentModal
          key={paymentBill.id}
          bill={paymentBill}
          currency={currency}
          initialOverridePin={checkoutOverridePin}
          onClose={() => {
            setPaymentBill(null);
            setCheckoutOverridePin(undefined);
          }}
          onPaid={handlePaymentComplete}
          onBillUpdate={(updated) => setPaymentBill(updated)}
          onSplit={(departingBill) => {
            if (departingBill) {
              // Clear current paymentBill synchronously so the cashier cannot
              // pay against the remainder source bill during the fetch window.
              setPaymentBill(null);
              setCheckoutOverridePin(undefined);
              const originEpoch = sessionEpochRef.current;
              void api
                .get(`/bills/${departingBill.id}`)
                .then(({ data }) => {
                  if (sessionEpochRef.current === originEpoch) {
                    setPaymentBill((data?.bill as Bill) ?? departingBill);
                  }
                })
                .catch(() => {
                  if (sessionEpochRef.current === originEpoch) {
                    setPaymentBill(departingBill);
                  }
                });
            } else {
              setPaymentBill(null);
              setCheckoutOverridePin(undefined);
            }
            refreshTables();
          }}
        />
      )}

      {refundModalTarget && (
        <RefundModal
          order={refundModalTarget.order}
          bills={refundModalTarget.bills}
          onClose={() => setRefundModalTarget(null)}
          onRefunded={() => {
            setRefundModalTarget(null);
            void refreshScheduledOrders();
            void refreshPaymentQueueCounts();
            setPaymentQueueRefreshKey((k) => k + 1);
          }}
        />
      )}

      {showCustomerPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-5 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">{t('selectCustomer')}</h3>
              <button
                onClick={() => setShowCustomerPrompt(false)}
                className="touch-target rounded-full text-gray-400 hover:text-muted-foreground active:bg-muted"
                aria-label={t('close')}
              >
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{t('customerRequiredBeforeOrder')}</p>
            <CustomerSearch
              onSelected={() => setShowCustomerPrompt(false)}
              onModalOpenChange={setPromptCustomerModalOpen}
            />
          </div>
        </div>
      )}

      {ConfirmDialog}

      <PrintMenuModal open={showPrintMenuModal} onOpenChange={setShowPrintMenuModal} />

      {/* Prepaid Checkout Modal - Payment BEFORE order is placed */}
      {showPrepaidCheckout && (
        <PrepaidCheckoutModal
          currency={currency}
          initialCardTransactionIdRequired={cardTransactionIdRequired}
          initialDiscount={prepaidModalAttempt?.discount ?? null}
          discountCommitted={Boolean(prepaidModalAttempt?.bill)}
          onClose={() => setShowPrepaidCheckout(false)}
          onConfirm={handlePrepaidCheckout}
        />
      )}

      <KeyboardShortcutsModal
        open={showKeyboardShortcutsModal}
        onClose={() => setShowKeyboardShortcutsModal(false)}
      />
    </>
  );
}
