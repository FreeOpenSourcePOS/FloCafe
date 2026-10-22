'use client';

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
import dynamic from 'next/dynamic';
import { ShiftOpenModal } from '@/components/dashboard/ShiftOpenModal';
import { ShiftCloseModal } from '@/components/dashboard/ShiftCloseModal';
import { useCashSession } from '@/hooks/useCashSession';
import { tenantCan } from '@/lib/permissions';
import { CashDrawerMovementModal } from '@/components/dashboard/CashDrawerMovementModal';
import { useCashDrawerMovements } from '@/hooks/useCashDrawerMovements';
import { usePrinterStore } from '@/hooks/usePrinter';
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
  getPrepaidOrderAttemptStorageKey,
  isSupportedFailureOperation,
  persistOrderAttempt,
  readOrderAttempt,
} from '@/lib/order-attempt';

// Loaded on demand: the menu printer pulls the thermal print kernel in, which the
// POS has no use for until the merchant opens the dialog.
const PrintMenuModal = dynamic(() => import('@/components/products/PrintMenuModal'), {
  ssr: false,
});

const POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';

interface PostpaidAttempt {
  userId: string;
  fingerprint: string;
  idempotencyKey: string;
  operationId?: string;
  order?: Order;
}

interface PrepaidAttempt {
  userId: string;
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
  facts?: { display_code?: string; failure_class?: string };
};

const OPERATION_REFERENCE_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRUCTURED_HELP_CAPTURE_POINTS: Record<string, string> = {
  'order.create:validation:order.quantity_invalid': 'fc.backend.order.create.quantity_validation',
  'order.create:validation:order.stock_insufficient': 'fc.backend.order.create.stock_validation',
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
  const { currentTenant, user } = useAuthStore();
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
  } = usePosSettingsStore();
  const { open: leftSidebarOpen } = useSidebar();
  const t = useTranslations('pos');
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
  const [showPrepaidCheckout, setShowPrepaidCheckout] = useState(false);
  const [prepaidModalAttempt, setPrepaidModalAttempt] = useState<PrepaidAttempt | null>(null);
  const [cardTransactionIdRequired, setCardTransactionIdRequired] = useState(false);
  const [showKeyboardShortcutsModal, setShowKeyboardShortcutsModal] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);
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
    correlationId?: string;
    operationFailure?: SupportOperationFailure;
    ticketCorrelationId: string;
    clientTicketId: string;
    payload: Record<string, unknown>;
  } | null>(null);
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const supportSubmittingRef = useRef(false);
  const [sentTicketId, setSentTicketId] = useState<string | null>(null);
  const delivery = useSupportTicketStatus(sentTicketId);
  const activeUserId = user?.id == null ? null : String(user.id);
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

  const readPostpaidAttempt = () => {
    if (typeof window === 'undefined') return null;
    const storage = getAppendAttemptStorage();
    let sharedLegacyAppendRetained = false;
    try {
      const migratedAppend = migrateLegacyAppendAttempt(storage, {
        userId: activeUserId || undefined,
      });
      sharedLegacyAppendRetained =
        migratedAppend !== null && storage.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY) !== null;
    } catch {
      throw new OrderAttemptStorageError();
    }
    if (postpaidAttemptRef.current?.userId === activeUserId) return postpaidAttemptRef.current;
    postpaidAttemptRef.current = null;
    postpaidAttemptKeyRef.current = null;
    postpaidAttemptWasLegacyRef.current = false;
    if (activeUserId) {
      const userStorageKey = getPostpaidOrderAttemptStorageKey(activeUserId);
      const scoped = readOrderAttempt<PostpaidAttempt>(storage, userStorageKey, activeUserId, {
        isValid: isUsablePostpaidAttempt,
      });
      if (scoped) {
        postpaidAttemptRef.current = scoped;
        postpaidAttemptKeyRef.current = userStorageKey;
        return scoped;
      }
    }
    const legacy = sharedLegacyAppendRetained
      ? null
      : readOrderAttempt<PostpaidAttempt>(
          storage,
          POSTPAID_ATTEMPT_STORAGE_KEY,
          activeUserId || '',
          {
            sharedKey: true,
            isValid: isUsablePostpaidAttempt,
          },
        );
    if (legacy) {
      postpaidAttemptRef.current = legacy;
      postpaidAttemptKeyRef.current = POSTPAID_ATTEMPT_STORAGE_KEY;
      postpaidAttemptWasLegacyRef.current = true;
    }
    return postpaidAttemptRef.current;
  };
  /** Only advance the in-memory attempt after a verified write: keys that never
   * reached a backend must not be executed from memory either. */
  const savePostpaidAttempt = (attempt: PostpaidAttempt): boolean => {
    const previous = postpaidAttemptRef.current;
    if (!activeUserId) return false;
    const storageKey = getPostpaidOrderAttemptStorageKey(activeUserId);
    try {
      persistOrderAttempt(getAppendAttemptStorage(), storageKey, attempt);
    } catch {
      postpaidAttemptRef.current = previous;
      return false;
    }
    postpaidAttemptRef.current = attempt;
    postpaidAttemptKeyRef.current = storageKey;
    return true;
  };
  const clearPostpaidAttempt = () => {
    const completedAttempt = postpaidAttemptRef.current;
    const storageKeys = [
      postpaidAttemptKeyRef.current,
      postpaidAttemptWasLegacyRef.current ? POSTPAID_ATTEMPT_STORAGE_KEY : null,
    ];
    if (!completedAttempt) {
      postpaidAttemptKeyRef.current = null;
      postpaidAttemptWasLegacyRef.current = false;
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
    if (cleared) {
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

  const readPrepaidAttempt = (): PrepaidAttempt | null => {
    if (prepaidAttemptRef.current?.userId === activeUserId) return prepaidAttemptRef.current;
    prepaidAttemptRef.current = null;
    prepaidAttemptKeyRef.current = null;
    if (typeof window === 'undefined' || !activeUserId) return null;
    const storage = getAppendAttemptStorage();
    const scopedKey = getPrepaidOrderAttemptStorageKey(activeUserId);
    const scoped = readOrderAttempt<PrepaidAttempt>(storage, scopedKey, activeUserId, {
      isValid: isUsablePrepaidAttempt,
    });
    if (scoped) {
      const safeAttempt = stripPrepaidDiscountPin(scoped);
      if (safeAttempt !== scoped) {
        if (!savePrepaidAttempt(safeAttempt)) throw new OrderAttemptStorageError();
      } else {
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
      activeUserId,
      {
        sharedKey: true,
        isValid: isUsablePrepaidAttempt,
      },
    );
    if (!legacy) return null;
    const migrated = stripPrepaidDiscountPin(legacy);
    if (!savePrepaidAttempt(migrated)) throw new OrderAttemptStorageError();
    clearOrderAttempt(storage, PREPAID_ATTEMPT_STORAGE_KEY, migrated);
    return migrated;
  };
  const savePrepaidAttempt = (attempt: PrepaidAttempt): boolean => {
    const previous = prepaidAttemptRef.current;
    if (!activeUserId) return false;
    const storageKey = getPrepaidOrderAttemptStorageKey(activeUserId);
    const safeAttempt = stripPrepaidDiscountPin(attempt);
    try {
      persistOrderAttempt(getAppendAttemptStorage(), storageKey, safeAttempt);
    } catch {
      prepaidAttemptRef.current = previous;
      return false;
    }
    prepaidAttemptRef.current = safeAttempt;
    prepaidAttemptKeyRef.current = storageKey;
    return true;
  };
  /** Intermediate prepaid states are persisted too: a request that runs under a
   * key the next run cannot replay can capture the same payment twice. */
  const requirePrepaidAttemptSaved = (attempt: PrepaidAttempt) => {
    if (!savePrepaidAttempt(attempt)) throw new OrderAttemptStorageError();
  };
  const clearPrepaidAttempt = () => {
    const completedAttempt = prepaidAttemptRef.current;
    const storageKey = prepaidAttemptKeyRef.current;
    if (!completedAttempt || !storageKey) {
      prepaidAttemptRef.current = null;
      prepaidAttemptKeyRef.current = null;
      return true;
    }
    // The payment is already captured: report a cleanup problem without turning
    // a completed sale into a failure.
    if (!clearOrderAttempt(getAppendAttemptStorage(), storageKey, completedAttempt)) {
      console.error('Failed to close the prepaid retry attempt after the payment was captured');
      return false;
    }
    prepaidAttemptRef.current = null;
    prepaidAttemptKeyRef.current = null;
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
    correlationId?: string | null;
    operationFailure?: SupportOperationFailure;
  }) => {
    const correlationId =
      entry.correlationId && OPERATION_REFERENCE_V4.test(entry.correlationId)
        ? entry.correlationId
        : undefined;
    const ticketCorrelationId = correlationId || createOperationReference() || '';
    const clientTicketId = createOperationReference() || '';
    setSupportError({
      title: entry.title,
      subject: 'FloCafe order problem',
      code: entry.code,
      message: entry.message,
      nextStep: entry.nextStep,
      operation: entry.operation,
      stage: entry.stage,
      outcome: entry.outcome,
      classification: entry.classification,
      reasonCode: entry.reasonCode || undefined,
      correlationId,
      operationFailure:
        entry.operationFailure?.operation_id === correlationId ? entry.operationFailure : undefined,
      ticketCorrelationId,
      clientTicketId,
      payload: {
        event_code: entry.code,
        message: entry.detail,
        category: 'bug',
        diagnostics: {
          operation: entry.operation,
          stage: entry.stage,
          outcome: entry.outcome,
          classification: entry.classification,
          reason_code: entry.reasonCode || entry.code,
          correlation_id: correlationId,
          http_status: entry.status,
        },
        ...(entry.operationFailure?.operation_id === correlationId
          ? { operation_failure: entry.operationFailure }
          : {}),
      },
    });
    toast.error(entry.message);
  };

  const reportOrderStorageFailure = (
    title: string,
    operation: 'order.create' | 'payment.create' | 'order.append' = 'order.create',
    correlationId: string | null = null,
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
    });
  };

  const reportOrderRequestFailure = (
    error: unknown,
    title: string,
    operation: string,
    stage: string,
    correlationId: string | null,
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
    const failureClass = (() => {
      const code = (error as { code?: unknown } | null)?.code;
      return code === 'ECONNABORTED' || code === 'ETIMEDOUT'
        ? 'timeout'
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? 'dns'
          : code === 'ECONNREFUSED'
            ? 'connection_refused'
            : typeof navigator !== 'undefined' && !navigator.onLine
              ? 'offline'
              : 'unreachable';
    })();
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
              ...(failure.displayCode ? { facts: { display_code: failure.displayCode } } : {}),
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
          ? failure.displayCode
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
      correlationId,
      operationFailure: helpOperationFailure,
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

  const printKotIfEnabled = async (order: Order) => {
    // Master kot_printing_enabled check gates both manual and automatic prints.
    if (!kotPrintingEnabled) return;
    if (!autoPrintKot) return;

    try {
      const printWarnings = await printKot(order, order.items ? { items: order.items } : undefined);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      console.error('[POS] KOT print failed:', err);
      const code = 'printer.queue_failed';
      reportOrderFailure({
        code,
        title: t('printingFailed'),
        message: t('saleCompletePrintFailed'),
        nextStep: t('saleCompleteReprintNextStep'),
        detail: 'Kitchen ticket printing failed after the order was created',
        status: null,
        operation: 'printer.print',
        stage: 'printing',
        outcome: 'unknown',
        reasonCode: code,
      });
      toast.error(formatKotErrorToast(t('kotPrintFailed'), t('saleCompletePrintFailed')));
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

  const printBillForTenant = async (bill: Bill, force = false, reservedWindow?: Window | null) => {
    if (!currentTenant || (!force && !autoPrintBill)) {
      if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
      return;
    }

    try {
      const printWarnings = await printBill(bill, currentTenant, undefined, reservedWindow);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      // Non-fatal: print failure should not block the checkout flow.
      const code = 'print.receipt.failed';
      console.error('[POS] Receipt print failed:', err);
      reportOrderFailure({
        code,
        title: t('printingFailed'),
        message: t('saleCompletePrintFailed'),
        nextStep: t('saleCompleteReprintNextStep'),
        detail: 'Receipt printing failed after payment was completed',
        status: null,
        operation: 'printer.print',
        stage: 'printing',
        outcome: 'unknown',
        reasonCode: code,
      });
      toast.error(formatReceiptErrorToast(t('receiptPrintFailed'), t('saleCompletePrintFailed')));
    }
  };

  const refreshTables = async () => {
    if (!isRestaurant || !tablesRequired) return;
    try {
      const { data } = await api.get('/tables?active=1');
      setTables(data.tables || []);
    } catch {
      /* ignore */
    }
  };

  // Replay persisted append attempt on reload to recover lost in-flight responses.
  useEffect(() => {
    if (!activeUserId || appendRecoveryStartedUsersRef.current.has(activeUserId)) return;

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
          () => reportOrderStorageFailure(t('addItemsFailed'), 'order.append', operationId),
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
        setBillingType(d.billing_type === 'prepaid' ? 'prepaid' : 'postpaid');
        const isTablesRequired = typeof d.tables_required === 'boolean' ? d.tables_required : true;
        setTablesRequired(isTablesRequired);

        api
          .get('/settings/kot_printing_enabled')
          .then((res) => setKotPrintingEnabled(res.data.setting?.value !== 'false'))
          .catch(() => {});

        // 2. Fetch other menu data
        const requests: Promise<{ data: Record<string, unknown> }>[] = [
          api.get('/categories?active=1'),
          api.get('/products?active=1'),
        ];

        if (isRestaurant && isTablesRequired) {
          requests.push(api.get('/tables?active=1'));
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
  }, [isRestaurant, setBillingType, setTablesRequired, setKotPrintingEnabled]);

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
    showPrepaidCheckout ||
    cashDrawer.open ||
    shift.openModalOpen ||
    shift.closeModalOpen ||
    showPrintMenuModal ||
    showKeyboardShortcutsModal ||
    isConfirmOpen;
  const anyModalOpen = showTablePicker || anyOtherModalOpen;

  useBarcodeScanner((code) => {
    const scan = resolveScannedProduct(code, products);
    if (scan) {
      if (scan.scaleBarcode) cart.addItem(scan.product, scan.quantity);
      else if (scan.variant) handleScannedVariant(scan.product, scan.variant);
      else handleProductClick(scan.product);
    } else {
      toast.error(t('barcodeNotFound', { code }));
    }
  }, !anyModalOpen);

  const validateOrderPreflight = () => {
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return false;
    }
    if (customerMandatory && !cart.customerId) {
      setShowCustomerPrompt(true);
      return false;
    }
    if (isRestaurant && cart.orderType === 'dine_in' && tablesRequired && !cart.tableId) {
      setShowTablePicker(true);
      return false;
    }
    return true;
  };

  const buildCurrentCartFingerprint = (orderItems = cart.items.map(cartItemToOrderItem)) =>
    JSON.stringify({
      table_id: cart.tableId,
      customer_id: cart.customerId,
      type: cart.orderType,
      guest_count: cart.guestCount,
      special_instructions: cart.orderNotes,
      online_platform: cart.orderType === 'online' ? cart.onlinePlatform : undefined,
      external_order_id: cart.orderType === 'online' ? cart.externalOrderId : undefined,
      delivery_address:
        cart.orderType === 'delivery' ? cart.deliveryAddress || undefined : undefined,
      expected_payment_method:
        cart.orderType === 'delivery' ? cart.expectedPaymentMethod || undefined : undefined,
      expected_payment_method_id:
        cart.orderType === 'delivery' ? (cart.expectedPaymentMethodId ?? undefined) : undefined,
      delivery_note: cart.orderType === 'delivery' ? cart.deliveryNote || undefined : undefined,
      items: orderItems,
      waived_charge_ids: Array.from(cart.waivedChargeIds),
      opted_in_charge_ids: Array.from(cart.optedInChargeIds),
    });

  const handlePlaceOrder = async () => {
    if (!validateOrderPreflight()) return;

    // Prepaid stores collect payment before finishing the order.
    if (shouldTakePaymentNow) {
      let matchingAttempt: PrepaidAttempt | null = null;
      try {
        const storedAttempt = readPrepaidAttempt();
        const cartFingerprint = buildCurrentCartFingerprint();
        if (
          storedAttempt &&
          storedAttempt.userId === activeUserId &&
          storedAttempt.cartFingerprint === cartFingerprint &&
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
    let failureOperation = pendingOrder ? 'order.append' : 'order.create';
    let failureStage = 'submission';
    let failureCorrelationId: string | null = null;
    try {
      let orderForKot: Order;

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
          userId: activeUserId || '',
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
        addItemsAttemptRef.current = itemAttempt;
        failureStage = 'append_items';
        const { data } = await api.post(
          `/orders/${pendingOrder.id}/items`,
          { items: newItems, special_instructions: specialInstructions },
          {
            headers: {
              'Idempotency-Key': itemAttempt.idempotencyKey,
              ...operationHeaders(itemAttempt.operationId),
            },
          },
        );
        toast.success(t('itemsAddedToOrder', { number: pendingOrder.order_number }));
        const updatedOrder = data.order as Order;
        const existingItemIds = new Set((pendingOrder.items || []).map((item) => Number(item.id)));
        const appendedItems = (updatedOrder.items || []).filter(
          (item) => !existingItemIds.has(Number(item.id)),
        );
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
          });
        }
        addItemsAttemptRef.current = null;
        setPendingOrder(null);
      } else {
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
          waived_charge_ids: Array.from(cart.waivedChargeIds),
          opted_in_charge_ids: Array.from(cart.optedInChargeIds),
          items: cart.items.map(cartItemToOrderItem),
        };
        const orderFingerprint = JSON.stringify(orderPayload);
        const priorOrderAttempt = readPostpaidAttempt();
        if (
          priorOrderAttempt?.userId === activeUserId &&
          priorOrderAttempt.fingerprint === orderFingerprint &&
          priorOrderAttempt.order
        ) {
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
          });
          return;
        }
        failureOperation = 'order.create';
        failureStage = 'order_submission';
        const orderAttempt: PostpaidAttempt =
          priorOrderAttempt?.userId === activeUserId &&
          priorOrderAttempt.fingerprint === orderFingerprint
            ? priorOrderAttempt
            : {
                userId: activeUserId || '',
                fingerprint: orderFingerprint,
                idempotencyKey: newIdempotencyKey(),
                operationId: createOperationReference() || undefined,
              };
        const operationId = orderAttempt.operationId || createOperationReference();
        failureCorrelationId = operationId;
        const attemptWithOperationId = operationId
          ? { ...orderAttempt, operationId }
          : orderAttempt;
        if (!savePostpaidAttempt(attemptWithOperationId)) {
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
                'Idempotency-Key': attemptWithOperationId.idempotencyKey,
                ...operationHeaders(operationId),
              },
            });
        const confirmedAttempt = { ...attemptWithOperationId, order: data.order as Order };
        if (!attemptWithOperationId.order && !savePostpaidAttempt(confirmedAttempt)) {
          console.error('The confirmed order could not be copied into retry storage');
          postpaidAttemptRef.current = confirmedAttempt;
          if (operationId)
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'retry_state_update',
              correlationId: operationId,
            });
        }
        toast.success(t('orderPlaced', { number: data.order.order_number }));
        orderForKot = data.order as Order;
        if (!clearPostpaidAttempt()) {
          if (operationId)
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'retry_cleanup',
              correlationId: operationId,
            });
          reportOrderFailure({
            code: 'order.retry_state.cleanup_failed',
            title: t('orderPlaced', { number: data.order.order_number }),
            message: t('saleCompleteCleanupFailed'),
            nextStep: t('saleCompleteCheckOrders'),
            detail: 'The order was created but local retry state could not be cleared',
            status: null,
            operation: 'order.create',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.retry_state.cleanup_failed',
            correlationId: operationId,
          });
        }
      }

      if (cart.tableId) {
        try {
          const deleted = await heldOrders.removeHeldOrder(
            cart.tableId,
            cart.heldOrderId || undefined,
          );
          if (!deleted) await heldOrders.fetchHeldOrders();
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
          });
        }
      }
      cart.clearCart();
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(orderForKot);
    } catch (error) {
      if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(
          t('placeOrderFailed'),
          failureOperation === 'order.append' ? 'order.append' : 'order.create',
          failureCorrelationId,
        );
      else
        reportOrderRequestFailure(
          error,
          t('placeOrderFailed'),
          failureOperation,
          failureStage,
          failureCorrelationId,
        );
    } finally {
      setSubmitting(false);
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
      storedAttempt = readPrepaidAttempt();
    } catch (error) {
      // An unreadable attempt cannot be safely replaced with a fresh key.
      if (!(error instanceof OrderAttemptStorageError)) throw error;
      reportOrderStorageFailure(t('processOrderFailed'));
      setSubmitting(false);
      return;
    }
    const existingAttempt =
      storedAttempt &&
      storedAttempt.userId === activeUserId &&
      storedAttempt.cartFingerprint === cartFingerprint &&
      storedAttempt.orderIdempotencyKey &&
      storedAttempt.paymentIdempotencyKey
        ? storedAttempt
        : null;
    const savedPaymentRequest =
      existingAttempt?.bill && existingAttempt.paymentFingerprint
        ? parsePrepaidPaymentRequest(existingAttempt.paymentFingerprint)
        : null;
    if (existingAttempt?.bill && existingAttempt.paymentFingerprint && !savedPaymentRequest) {
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
      });
      setSubmitting(false);
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
          headers: operationHeaders(recoveryOperationId),
        });
        if (!data?.bill || !['paid', 'partial', 'unpaid'].includes(data.bill.payment_status)) {
          throw new Error('Bill status unavailable');
        }
      } catch (recoveryError) {
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
        });
        setSubmitting(false);
        return;
      }
    }
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
          userId: activeUserId || '',
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
    if (!savePrepaidAttempt(attempt)) {
      reportOrderStorageFailure(t('processOrderFailed'), 'order.create', operationId || null);
      setSubmitting(false);
      return;
    }
    let orderData: { order: Order } | null = null;
    let billData: { bill: Bill } | null = null;
    let failureOperation = 'order.create';
    let failureStage = 'submission';
    let failureCorrelationId: string | null = null;
    let committedOrder: Order | null = attempt.order || null;
    try {
      failureCorrelationId = operationId;
      if (operationId && attempt.operationId !== operationId) {
        attempt = { ...attempt, operationId };
        requirePrepaidAttemptSaved(attempt);
      }
      if (attempt.order) {
        orderData = { order: attempt.order };
      } else {
        failureOperation = 'order.create';
        failureStage = 'submission';
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
            waived_charge_ids: Array.from(cart.waivedChargeIds),
            opted_in_charge_ids: Array.from(cart.optedInChargeIds),
            items: orderItems,
          },
          {
            headers: {
              'Idempotency-Key': attempt.orderIdempotencyKey,
              ...operationHeaders(operationId),
            },
          },
        );
        orderData = data;
        committedOrder = data.order as Order;
        requirePrepaidAttemptSaved({ ...attempt, order: data.order });
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
            headers: operationHeaders(operationId),
          });
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
          { headers: operationHeaders(operationId) },
        );
      }

      if (attempt.bill) {
        billData = { bill: attempt.bill };
      } else {
        failureOperation = 'bill.generate';
        failureStage = 'bill_generation';
        const { data: generatedBill } = await api.post(
          '/bills/generate',
          { order_id: orderId },
          { headers: operationHeaders(operationId) },
        );
        billData = generatedBill;
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
        requirePrepaidAttemptSaved(attempt);
      }

      // Record every split in one atomic request. The persisted bill/key pair
      // makes a lost response safe to retry without creating a second order.
      failureOperation = 'payment.create';
      failureStage = 'payment_submission';
      const paymentResponse = await api.post(`/bills/${bill.id}/payments`, paymentRequest, {
        headers: {
          'Idempotency-Key': attempt.paymentIdempotencyKey,
          ...operationHeaders(operationId),
        },
      });
      const paidBill: Bill = paymentResponse.data?.bill || bill;
      const pointsEarned =
        paymentResponse.data?.loyaltyPointsEarned > 0
          ? paymentResponse.data.loyaltyPointsEarned
          : 0;

      if (paidBill.payment_status !== 'paid') {
        const incompleteMessage = t('paymentIncomplete', {
          amount: currencyFmt(Number(paidBill.balance) || 0),
        });
        savePrepaidAttempt({
          ...attempt,
          bill: paidBill,
          paymentFingerprint: '',
          paymentIdempotencyKey: newIdempotencyKey(),
        });
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
        });
        return;
      }

      const completedAttempt = { ...attempt, order, bill: paidBill };
      if (!savePrepaidAttempt(completedAttempt)) {
        // Payment is confirmed. Keep that fact in memory and never turn a
        // local retry-state write failure into advice to charge again.
        prepaidAttemptRef.current = stripPrepaidDiscountPin(completedAttempt);
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
          if (!deleted) await heldOrders.fetchHeldOrders();
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
          });
        }
      }
      cart.clearCart();
      if (!clearPrepaidAttempt()) {
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
        });
      }
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(order);

      await printBillForTenant(paidBill, isPrepaidCheckout);
    } catch (error) {
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
        });
      } else if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(
          t('processOrderFailed'),
          failureOperation === 'payment.create' ? 'payment.create' : 'order.create',
          failureCorrelationId,
        );
      else {
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
            savePrepaidAttempt({
              ...attempt,
              paymentFingerprint: '',
              paymentIdempotencyKey: newIdempotencyKey(),
            });
          }
        }
        reportOrderRequestFailure(
          error,
          t('processOrderFailed'),
          failureOperation,
          failureStage,
          failureCorrelationId,
        );
      }
    } finally {
      setSubmitting(false);
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
    const operationId = createOperationReference();
    try {
      const items = cart.items.map(cartItemToOrderItem);
      const specialInstructions = order.special_instructions || undefined;
      const fingerprint = buildAppendItemsFingerprint(order.id, items, specialInstructions);
      const storage = getAppendAttemptStorage();
      const itemAttempt = getOrCreateAppendAttempt(storage, {
        userId: activeUserId || '',
        orderId: order.id,
        fingerprint,
        createKey: newIdempotencyKey,
        items,
        specialInstructions,
        orderNumber: order.order_number,
        operationId: operationId || undefined,
      });
      addItemsAttemptRef.current = itemAttempt;
      const { data } = await api.post(
        `/orders/${order.id}/items`,
        {
          items,
          special_instructions: specialInstructions,
        },
        {
          headers: {
            'Idempotency-Key': itemAttempt.idempotencyKey,
            ...operationHeaders(itemAttempt.operationId),
          },
        },
      );
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
        });
      }
      addItemsAttemptRef.current = null;
      toast.success(t('itemsAddedToOrder', { number: order.order_number }));
      const updatedOrder = data.order as Order;
      const existingItemIds = new Set((order.items || []).map((item) => Number(item.id)));
      const appendedItems = (updatedOrder.items || []).filter(
        (item) => !existingItemIds.has(Number(item.id)),
      );
      await printKotIfEnabled(
        appendedItems.length > 0 ? { ...updatedOrder, items: appendedItems } : updatedOrder,
      );
      cart.clearCart();
      setCheckoutTable(null);
      refreshTables();
    } catch (error) {
      if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(t('addItemsFailed'), 'order.append', operationId);
      else
        reportOrderRequestFailure(
          error,
          t('addItemsFailed'),
          'order.append',
          'append_items',
          operationId,
        );
    } finally {
      setSubmitting(false);
    }
  };

  const handlePaymentComplete = async () => {
    const bill = paymentBill; // capture before clearing state
    setPaymentBill(null);
    setCheckoutOverridePin(undefined);
    setCheckoutTable(null);
    refreshTables();

    if (bill) {
      try {
        await printBillForTenant(await fetchLatestBill(bill.id));
      } catch {
        toast.error(t('receiptPrintFailed'));
      }
    }
  };

  const cartPanelProps = {
    tables,
    currency,
    submitting,
    onPlaceOrder: handlePlaceOrder,
    onShowTablePicker: () => setShowTablePicker(true),
    onEditItem: setEditingCartItem,
    existingOrder: pendingOrder,
  };

  const itemCount = cart.itemCount();

  usePosKeyboardShortcuts(
    {
      onFocusSearch: () => {
        dispatchQuickSearchRequest();
      },
      onTender: () => {
        if (!submitting && cart.items.length > 0) {
          void handlePlaceOrder();
        }
      },
      onToggleTables: () => {
        if (isRestaurant && cart.orderType === 'dine_in' && tablesRequired) {
          setShowTablePicker((prev) => !prev);
        }
      },
      onOpenCheckout: () => {
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
        if (customerModalOpen) {
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
        <div className="fixed bottom-4 start-4 z-50 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-red-200 bg-card p-4 shadow-xl">
          {sentTicketId ? (
            <>
              <p className="font-semibold text-red-800">{tSupport('requestQueued')}</p>
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
                  onClick={() => {
                    setSupportError(null);
                    setSentTicketId(null);
                  }}
                >
                  {tSupport('dismiss')}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="font-semibold text-red-800">{supportError.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{supportError.message}</p>
              <p className="mt-1 text-sm text-muted-foreground">{supportError.nextStep}</p>
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{tSupport('showPayload')}</summary>
                <Ltr as="pre" className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2">
                  {JSON.stringify(
                    {
                      ...supportError.payload,
                      subject: supportError.subject,
                      correlation_id: supportError.ticketCorrelationId,
                      client_ticket_id: supportError.clientTicketId,
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
                    if (supportSubmittingRef.current) return;
                    supportSubmittingRef.current = true;
                    setSupportSubmitting(true);
                    try {
                      await api.post('/support-ticket', {
                        ...supportError.payload,
                        subject: supportError.subject,
                        correlation_id: supportError.ticketCorrelationId,
                        client_ticket_id: supportError.clientTicketId,
                      });
                      toast.success(tSupport('queued'));
                      setSentTicketId(supportError.clientTicketId);
                    } catch {
                      toast.error(t('supportRequestQueueFailed'));
                    } finally {
                      supportSubmittingRef.current = false;
                      setSupportSubmitting(false);
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
                  onClick={() => setSupportError(null)}
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
        shiftHasOpenSession={!!shift.session}
        shiftLoading={shift.loading}
        shiftError={shift.error}
        canUseShift={canUseShift}
        onShowPrintMenu={() => setShowPrintMenuModal(true)}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onCustomerModalOpenChange={setTopbarCustomerModalOpen}
      />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden p-4 gap-4">
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
            await printBillForTenant(bill, true, reservedWindow);
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
            setCheckoutTable(null);
            setPaymentBill(bill);
            setCheckoutOverridePin(overridePin);
          }}
          onAddCartToOrder={handleAddCartToOrder}
          onOrderMoved={({ sourceTable, targetTable }) => {
            if (cart.tableId === sourceTable.id) {
              cart.setTableId(targetTable.id);
            }
          }}
        />
      )}

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
              void api
                .get(`/bills/${departingBill.id}`)
                .then(({ data }) => setPaymentBill((data?.bill as Bill) ?? departingBill))
                .catch(() => setPaymentBill(departingBill));
            } else {
              setPaymentBill(null);
              setCheckoutOverridePin(undefined);
            }
            refreshTables();
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
