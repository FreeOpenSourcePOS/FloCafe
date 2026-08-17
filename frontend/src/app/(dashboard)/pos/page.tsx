'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useSidebar } from '@/components/ui/sidebar';
import toast from 'react-hot-toast';
import { ShoppingCart, X } from 'lucide-react';
import type { Addon, Category, Product, Table, Bill, Order, CartItem } from '@/lib/types';
import { useConfirm } from '@/hooks/use-confirm';
import {
  Drawer, DrawerContent, DrawerTrigger,
} from '@/components/ui/drawer';

import ProductGrid from '@/components/pos/ProductGrid';
import CartPanel from '@/components/pos/CartPanel';
import AddonModal from '@/components/pos/AddonModal';
import CustomerSearch from '@/components/pos/CustomerSearch';
import TablePickerModal from '@/components/pos/TablePickerModal';
import TableCheckoutModal from '@/components/pos/TableCheckoutModal';
import PaymentModal from '@/components/pos/PaymentModal';
import PrepaidCheckoutModal, { type PrepaidPayment, type PrepaidDiscount } from '@/components/pos/PrepaidCheckoutModal';
import PosTopbar from '@/components/pos/PosTopbar';
import { usePrinterStore } from '@/hooks/usePrinter';
import { showPrintWarningsToast } from '@/lib/printer/warnings-toast';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { useI18n } from '@/hooks/useI18n';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useSupportTicketStatus } from '@/hooks/useSupportTicketStatus';
import { useSupportDiagnosticsPreview } from '@/hooks/useSupportDiagnosticsPreview';
import { getCurrencySymbol, getCountryByCode } from '@/lib/countries';
import {
  buildAppendItemsFingerprint,
  clearAppendAttempt,
  createSafeAppendAttemptStorage,
  getOrCreateAppendAttempt,
  LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY,
  getPostpaidOrderAttemptStorageKey,
  migrateLegacyAppendAttempt,
  readAppendAttempt,
  type AppendAttempt,
  type AppendAttemptStorage,
} from '@/lib/append-attempt';

const PREPAID_ATTEMPT_STORAGE_KEY = 'flo.prepaid.checkout.attempt';
const POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';

function normalizeBarcode(value: string | null | undefined) {
  return value?.trim() || '';
}

interface PostpaidAttempt {
  userId: string;
  fingerprint: string;
  idempotencyKey: string;
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
}

export default function POSPage() {
  const { currentTenant, user } = useAuthStore();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { customerMandatory, autoPrintKot, autoPrintBill, billingType, tablesRequired, kotPrintingEnabled, setBillingType, setTablesRequired, setKotPrintingEnabled } = usePosSettingsStore();
  const { open: leftSidebarOpen } = useSidebar();
  const { t } = useI18n();
  const currencyFmt = useFormatCurrency();
  const { confirm, ConfirmDialog } = useConfirm();

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);

  // Modal state
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [addonProduct, setAddonProduct] = useState<Product | null>(null);
  const [editingCartItem, setEditingCartItem] = useState<CartItem | null>(null);
  const [checkoutTable, setCheckoutTable] = useState<Table | null>(null);
  const [paymentBill, setPaymentBill] = useState<Bill | null>(null);
  const [showCustomerPrompt, setShowCustomerPrompt] = useState(false);
  const [showPrepaidCheckout, setShowPrepaidCheckout] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);
  const [supportError, setSupportError] = useState<{ code: string; message: string; payload: Record<string, unknown> } | null>(null);
  const [sentTicketId, setSentTicketId] = useState<string | null>(null);
  const delivery = useSupportTicketStatus(sentTicketId);
  const diagnosticsPreview = useSupportDiagnosticsPreview(
    supportError ? String(supportError.payload.category || 'general') : null,
  );
  const activeUserId = user?.id == null ? null : String(user.id);
  const prepaidAttemptRef = useRef<PrepaidAttempt | null>(null);
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
    let sharedLegacyAppendRetained = false;
    try {
      const migratedAppend = migrateLegacyAppendAttempt(getAppendAttemptStorage(), { userId: activeUserId || undefined });
      sharedLegacyAppendRetained = migratedAppend !== null
        && getAppendAttemptStorage().getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY) !== null;
    } catch {
      throw new Error('Unable to recover append retry state');
    }
    if (postpaidAttemptRef.current?.userId === activeUserId) return postpaidAttemptRef.current;
    postpaidAttemptRef.current = null;
    postpaidAttemptKeyRef.current = null;
    postpaidAttemptWasLegacyRef.current = false;
    try {
      const userStorageKey = activeUserId ? getPostpaidOrderAttemptStorageKey(activeUserId) : null;
      const stored = userStorageKey ? window.localStorage.getItem(userStorageKey) : null;
      const parsed = stored ? JSON.parse(stored) as PostpaidAttempt : null;
      if (parsed && parsed.userId === activeUserId) {
        postpaidAttemptRef.current = parsed;
        postpaidAttemptKeyRef.current = userStorageKey;
        return parsed;
      }
      if (userStorageKey && stored !== null) window.localStorage.removeItem(userStorageKey);
      const legacyStored = sharedLegacyAppendRetained ? null : window.localStorage.getItem(POSTPAID_ATTEMPT_STORAGE_KEY);
      const legacyParsed = legacyStored ? JSON.parse(legacyStored) as PostpaidAttempt : null;
      if (legacyParsed && legacyParsed.userId === activeUserId) {
        postpaidAttemptRef.current = legacyParsed;
        postpaidAttemptKeyRef.current = POSTPAID_ATTEMPT_STORAGE_KEY;
        postpaidAttemptWasLegacyRef.current = true;
      } else if (legacyStored !== null) {
        window.localStorage.removeItem(POSTPAID_ATTEMPT_STORAGE_KEY);
      }
    } catch {
      if (activeUserId) window.localStorage.removeItem(getPostpaidOrderAttemptStorageKey(activeUserId));
      if (!sharedLegacyAppendRetained) window.localStorage.removeItem(POSTPAID_ATTEMPT_STORAGE_KEY);
      return null;
    }
    return postpaidAttemptRef.current;
  };
  const savePostpaidAttempt = (attempt: PostpaidAttempt): boolean => {
    postpaidAttemptRef.current = attempt;
    try {
      if (!activeUserId) return false;
      const storageKey = getPostpaidOrderAttemptStorageKey(activeUserId);
      window.localStorage.setItem(storageKey, JSON.stringify(attempt));
      postpaidAttemptKeyRef.current = storageKey;
      return true;
    } catch {
      return false;
    }
  };
  const clearPostpaidAttempt = () => {
    postpaidAttemptRef.current = null;
    try {
      if (postpaidAttemptKeyRef.current) window.localStorage.removeItem(postpaidAttemptKeyRef.current);
      if (postpaidAttemptWasLegacyRef.current) window.localStorage.removeItem(POSTPAID_ATTEMPT_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
    postpaidAttemptKeyRef.current = null;
    postpaidAttemptWasLegacyRef.current = false;
  };

  const readPrepaidAttempt = () => {
    if (prepaidAttemptRef.current?.userId === activeUserId) return prepaidAttemptRef.current;
    prepaidAttemptRef.current = null;
    if (typeof window === 'undefined') return null;
    try {
      const stored = window.localStorage.getItem(PREPAID_ATTEMPT_STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) as PrepaidAttempt : null;
      if (parsed && parsed.userId === activeUserId) {
        if (parsed.discount && 'override_pin' in parsed.discount) {
          const safeDiscount = { ...parsed.discount };
          delete safeDiscount.override_pin;
          parsed.discount = safeDiscount;
          window.localStorage.setItem(PREPAID_ATTEMPT_STORAGE_KEY, JSON.stringify(parsed));
        }
        prepaidAttemptRef.current = parsed;
      } else window.localStorage.removeItem(PREPAID_ATTEMPT_STORAGE_KEY);
    } catch {
      window.localStorage.removeItem(PREPAID_ATTEMPT_STORAGE_KEY);
    }
    return prepaidAttemptRef.current;
  };
  const savePrepaidAttempt = (attempt: PrepaidAttempt): boolean => {
    try {
      const safeAttempt = { ...attempt };
      if (safeAttempt.discount) {
        const safeDiscount = { ...safeAttempt.discount };
        delete safeDiscount.override_pin;
        safeAttempt.discount = safeDiscount;
      }
      prepaidAttemptRef.current = safeAttempt;
      window.localStorage.setItem(PREPAID_ATTEMPT_STORAGE_KEY, JSON.stringify(safeAttempt));
      return true;
    } catch {
      return false;
    }
  };
  const clearPrepaidAttempt = () => {
    prepaidAttemptRef.current = null;
    try {
      window.localStorage.removeItem(PREPAID_ATTEMPT_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
  };
  const newIdempotencyKey = () => typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const currency = getCurrencySymbol(currentTenant?.currency || 'INR', getCountryByCode(currentTenant?.country ?? 'IN')?.locale);
  const { printBill, printKot } = usePrinterStore();
  const billingIsPrepaid = billingType === 'prepaid';
  const shouldTakePaymentNow = billingIsPrepaid;

  const printKotIfEnabled = async (order: Order) => {
    // kot_printing_enabled is coarser than auto_print_kot: when it's off, no
    // KOT print command should go out at all, regardless of the auto-print
    // preference (issue #133).
    if (!kotPrintingEnabled) return;
    if (!autoPrintKot) return;

    try {
      const printWarnings = await printKot(order);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      console.error('[POS] KOT print failed:', err);
      const msg = err instanceof Error ? err.message : 'print failed';
      const code = `print.kot.${msg.toLowerCase().includes('spool') ? 'spooler_timeout' : 'failed'}`;
      setSupportError({
        code,
        message: t('pos.kotPrintFailed'),
        payload: { event_code: code, message: msg, category: 'printer', diagnostics: { order_id: order.id, stage: 'kot_print' } },
      });
      toast.error(t('pos.kotPrintFailed'));
    }
  };

  const fetchLatestBill = async (billId: number): Promise<Bill> => {
    const { data } = await api.get(`/bills/${billId}`);
    return data.bill as Bill;
  };

  const printBillForTenant = async (bill: Bill, force = false) => {
    if (!currentTenant) return;
    if (!force && !autoPrintBill) return;

    try {
      const printWarnings = await printBill(bill, currentTenant);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      // Non-fatal: print failure should not block the checkout flow.
      const msg = err instanceof Error ? err.message : 'print failed';
      const code = 'print.receipt.failed';
      setSupportError({
        code,
        message: t('pos.receiptPrintFailed'),
        payload: { event_code: code, message: msg, category: 'printer', diagnostics: { bill_id: bill.id, stage: 'receipt_print' } },
      });
      toast.error(t('pos.receiptPrintFailed'));
    }
  };

  const refreshTables = async () => {
    if (!isRestaurant || !tablesRequired) return;
    try {
      const { data } = await api.get('/tables?active=1');
      setTables(data.tables || []);
    } catch { /* ignore */ }
  };

  // A full renderer reload resets the Zustand cart. Recovering the persisted
  // request here lets a committed-but-response-lost append replay itself even
  // before the cashier reconstructs the cart or selects the table again.
  useEffect(() => {
    if (!activeUserId || appendRecoveryStartedUsersRef.current.has(activeUserId)) return;

    let pendingAttempt: AppendAttempt | null = null;
    try {
      pendingAttempt = readAppendAttempt(getAppendAttemptStorage(), { userId: activeUserId });
    } catch {
      return;
    }
    if (!pendingAttempt) return;

    appendRecoveryStartedUsersRef.current.add(activeUserId);
    addItemsAttemptRef.current = pendingAttempt;
    api.post(
      `/orders/${pendingAttempt.orderId}/items`,
      {
        items: pendingAttempt.items,
        special_instructions: pendingAttempt.specialInstructions,
      },
      { headers: { 'Idempotency-Key': pendingAttempt.idempotencyKey } },
    ).then(() => {
      const storage = getAppendAttemptStorage();
      if (!clearAppendAttempt(storage, pendingAttempt!)) throw new Error('Unable to clear append retry state');
      if (addItemsAttemptRef.current?.idempotencyKey !== pendingAttempt!.idempotencyKey) return;
      addItemsAttemptRef.current = null;
      // Do not clear cart or checkout state that may have been started while
      // recovery was in flight. A reload starts empty; any current UI is newer.
      toast.success(t('pos.itemsAddedToOrder', { number: pendingAttempt!.orderNumber || pendingAttempt!.orderId }));
      refreshTables();
    }).catch(() => {
      toast.error(t('pos.addItemsFailed'));
    });
  // The recovery runs once per authenticated renderer and intentionally uses
  // the persisted attempt rather than the transient cart state.
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

        api.get('/settings/kot_printing_enabled')
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
        toast.error(t('pos.menuLoadFailed'));
      }
    };
    fetchData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestaurant, setBillingType, setTablesRequired, setKotPrintingEnabled]);

  const handleProductClick = (product: Product) => {
    // Always open modal so user can add notes and adjust quantity
    setAddonProduct(product);
  };

  const handleAddonAdd = (product: Product, quantity: number, addons: Addon[], instructions: string) => {
    cart.addItem(product, quantity, addons, instructions);
  };

  const handleEditItemSave = (_product: Product, quantity: number, addons: Addon[], instructions: string) => {
    if (!editingCartItem) return;
    cart.updateItemDetails(editingCartItem.id, quantity, addons, instructions);
  };

  // A modal already open means the scan (if one lands) isn't meant for the
  // product grid — e.g. it could be a barcode field inside that modal.
  const anyModalOpen = showTablePicker || !!addonProduct || !!editingCartItem || !!checkoutTable
    || !!paymentBill || showCustomerPrompt || showPrepaidCheckout;

  useBarcodeScanner((code) => {
    const normalizedCode = normalizeBarcode(code);
    const product = products.find((p) => normalizeBarcode(p.barcode) === normalizedCode);
    if (product) {
      handleProductClick(product);
    } else {
      toast.error(t('pos.barcodeNotFound', { code }));
    }
  }, !anyModalOpen);

  const handlePlaceOrder = async () => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    if (customerMandatory && !cart.customerId) {
      setShowCustomerPrompt(true);
      return;
    }
    if (isRestaurant && cart.orderType === 'dine_in' && tablesRequired && !cart.tableId) {
      setShowTablePicker(true);
      return;
    }

    // Prepaid stores collect payment before finishing the order.
    if (shouldTakePaymentNow) {
      setShowPrepaidCheckout(true);
      return;
    }

    // Postpaid store / unpaid order → place order, kitchen gets the ticket, payment collected later
    setSubmitting(true);
    try {
      let orderForKot: Order;

      if (pendingOrder) {
        // Add new items to an existing order with a durable retry key.
        const newItems = cart.items.map((item) => ({
          product_id: item.product.id,
          quantity: item.quantity,
          addons: item.addons.length > 0
            ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
            : null,
          special_instructions: item.special_instructions || null,
        }));
        const specialInstructions = cart.orderNotes || undefined;
        const itemFingerprint = buildAppendItemsFingerprint(pendingOrder.id, newItems, specialInstructions);
        const storage = getAppendAttemptStorage();
        const itemAttempt = getOrCreateAppendAttempt(storage, {
          userId: activeUserId || '',
          orderId: pendingOrder.id,
          fingerprint: itemFingerprint,
          createKey: newIdempotencyKey,
          items: newItems,
          specialInstructions,
          orderNumber: pendingOrder.order_number,
        });
        addItemsAttemptRef.current = itemAttempt;
        const { data } = await api.post(
          `/orders/${pendingOrder.id}/items`,
          { items: newItems, special_instructions: specialInstructions },
          { headers: { 'Idempotency-Key': itemAttempt.idempotencyKey } },
        );
        toast.success(t('pos.itemsAddedToOrder', { number: pendingOrder.order_number }));
        orderForKot = data.order as Order;
        if (!clearAppendAttempt(storage, itemAttempt)) throw new Error('Unable to clear append retry state');
        addItemsAttemptRef.current = null;
        setPendingOrder(null);
      } else {
        const orderPayload = {
          table_id: cart.tableId,
          customer_id: cart.customerId,
          type: cart.orderType,
          guest_count: cart.guestCount,
          special_instructions: cart.orderNotes || undefined,
          items: cart.items.map((item) => ({
            product_id: item.product.id,
            quantity: item.quantity,
            addons: item.addons.length > 0
              ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
              : null,
            special_instructions: item.special_instructions || null,
          })),
        };
        const orderFingerprint = JSON.stringify(orderPayload);
        const priorOrderAttempt = readPostpaidAttempt();
        const orderAttempt: PostpaidAttempt = priorOrderAttempt?.userId === activeUserId && priorOrderAttempt.fingerprint === orderFingerprint
          ? priorOrderAttempt
          : { userId: activeUserId || '', fingerprint: orderFingerprint, idempotencyKey: newIdempotencyKey() };
        if (!savePostpaidAttempt(orderAttempt)) throw new Error(t('pos.placeOrderFailed'));
        const { data } = orderAttempt.order
          ? { data: { order: orderAttempt.order } }
          : await api.post('/orders', orderPayload, { headers: { 'Idempotency-Key': orderAttempt.idempotencyKey } });
        if (!orderAttempt.order) savePostpaidAttempt({ ...orderAttempt, order: data.order as Order });
        toast.success(t('pos.orderPlaced', { number: data.order.order_number }));
        orderForKot = data.order as Order;
        clearPostpaidAttempt();
      }

      if (cart.tableId) {
        try {
          const deleted = await heldOrders.removeHeldOrder(cart.tableId, cart.heldOrderId || undefined);
          if (!deleted) await heldOrders.fetchHeldOrders();
        } catch (heldOrderError) {
          // The order has already been placed. Do not turn a cleanup failure
          // into a failed sale or leave an unhandled promise in the console.
          console.error('Failed to clear held order after placing order', heldOrderError);
        }
      }
      cart.clearCart();
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(orderForKot);
    } catch {
      toast.error(t('pos.placeOrderFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  // Handle prepaid checkout - place order and pay in one step
  const handlePrepaidCheckout = async (payments: PrepaidPayment[], walletAmount: number, discount: PrepaidDiscount | null) => {
    const isPrepaidCheckout = shouldTakePaymentNow;
    setShowPrepaidCheckout(false);
    setSubmitting(true);
    const orderItems = cart.items.map((item) => ({
      product_id: item.product.id,
      quantity: item.quantity,
      addons: item.addons.length > 0
        ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
        : null,
      special_instructions: item.special_instructions || null,
    }));
    const paymentLines = payments
      .filter((p) => p.amount > 0)
      .map((p) => ({
        method: p.method,
        ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
        amount: p.amount,
      }));
    if (walletAmount > 0) paymentLines.push({ method: 'wallet', amount: walletAmount });
    const paymentFingerprint = JSON.stringify({ payments: paymentLines, customer_id: cart.customerId });
    const cartFingerprint = JSON.stringify({
      table_id: cart.tableId,
      customer_id: cart.customerId,
      type: cart.orderType,
      guest_count: cart.guestCount,
      special_instructions: cart.orderNotes,
      items: orderItems,
    });
    const storedAttempt = readPrepaidAttempt();
    const existingAttempt = storedAttempt && storedAttempt.userId === activeUserId && storedAttempt.cartFingerprint === cartFingerprint
      && storedAttempt.orderIdempotencyKey && storedAttempt.paymentIdempotencyKey
      ? storedAttempt
      : null;
    const currentDiscount = discount && discount.value > 0 ? discount : null;
    const discountFingerprint = (value: PrepaidDiscount | null | undefined) => JSON.stringify(
      value ? { type: value.type, value: value.value, reason: value.reason } : null,
    );
    const discountChanged = !!existingAttempt
      && discountFingerprint(existingAttempt.discount) !== discountFingerprint(currentDiscount);
    const retryDiscount = currentDiscount;
    let attempt: PrepaidAttempt = existingAttempt
      ? {
        ...existingAttempt,
        discount: retryDiscount,
        bill: discountChanged ? undefined : existingAttempt.bill,
        paymentFingerprint,
        paymentIdempotencyKey: existingAttempt.paymentFingerprint === paymentFingerprint && !discountChanged
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
      };
    // Persist the key before the first order mutation. The server replays the
    // order response if this renderer loses the response or restarts.
    if (!savePrepaidAttempt(attempt)) {
      clearPrepaidAttempt();
      toast.error(t('pos.processOrderFailed'));
      setSubmitting(false);
      return;
    }
    let orderData: { order: Order };
    let billData: { bill: Bill };
    try {
      if (existingAttempt?.bill && discountChanged) {
        try {
          const { data: currentBillData } = await api.get(`/bills/${existingAttempt.bill.id}`);
          if (currentBillData.bill?.payment_status === 'paid') {
            // A lost payment response wins over a later UI edit; replay the
            // original request instead of mutating an already-settled bill.
            attempt = {
              ...attempt,
              discount: existingAttempt.discount,
              bill: existingAttempt.bill,
              paymentFingerprint: existingAttempt.paymentFingerprint,
              paymentIdempotencyKey: existingAttempt.paymentIdempotencyKey,
            };
            savePrepaidAttempt(attempt);
          }
        } catch {
          // An unknown bill state must replay the original request. Applying a
          // new discount/key could turn a committed payment into a stuck retry.
          attempt = {
            ...attempt,
            discount: existingAttempt.discount,
            bill: existingAttempt.bill,
            paymentFingerprint: existingAttempt.paymentFingerprint,
            paymentIdempotencyKey: existingAttempt.paymentIdempotencyKey,
          };
          savePrepaidAttempt(attempt);
        }
      }
      if (attempt.order) {
        orderData = { order: attempt.order };
      } else {
        const { data } = await api.post('/orders', {
          table_id: cart.tableId,
          customer_id: cart.customerId,
          type: cart.orderType,
          guest_count: cart.guestCount,
          special_instructions: cart.orderNotes || undefined,
          items: orderItems,
        }, { headers: { 'Idempotency-Key': attempt.orderIdempotencyKey } });
        orderData = data;
        savePrepaidAttempt({ ...attempt, order: data.order });
      }
      const orderId = orderData.order.id;

      // Apply discount before bill generation so the bill uses the discounted
      // totals (tax recalculated on the net payable amount). Repeating this SET
      // operation is safe if its response was lost.
      const effectiveDiscount = attempt.discount;
      const discountForRequest = effectiveDiscount && currentDiscount
        && discountFingerprint(effectiveDiscount) === discountFingerprint(currentDiscount)
        ? { ...effectiveDiscount, override_pin: currentDiscount.override_pin }
        : effectiveDiscount;
      let discountAlreadyApplied = false;
      if (!attempt.bill && (discountChanged || (effectiveDiscount && effectiveDiscount.value > 0)) && attempt.order) {
        try {
          const { data: currentOrderData } = await api.get(`/orders/${orderId}`);
          const serverDiscount = currentOrderData.order?.discount_type && Number(currentOrderData.order.discount_value) > 0
            ? {
              type: currentOrderData.order.discount_type,
              value: Number(currentOrderData.order.discount_value),
              reason: currentOrderData.order.discount_reason || undefined,
            }
            : null;
          discountAlreadyApplied = discountFingerprint(serverDiscount) === discountFingerprint(effectiveDiscount);
        } catch {
          // If the order cannot be read, retain the safe retry behavior below;
          // an approval PIN may be required to reapply an uncertain discount.
        }
      }
      if (!attempt.bill && !discountAlreadyApplied && (discountChanged || (effectiveDiscount && effectiveDiscount.value > 0))) {
        await api.patch(`/orders/${orderId}/discount`, {
          discount_type: discountForRequest?.type || 'percentage',
          discount_value: discountForRequest?.value || 0,
          discount_reason: discountForRequest?.reason,
          override_pin: discountForRequest?.override_pin,
        });
      }

      if (attempt.bill) {
        billData = { bill: attempt.bill };
      } else {
        const { data: generatedBill } = await api.post('/bills/generate', { order_id: orderId });
        billData = generatedBill;
        savePrepaidAttempt({ ...attempt, order: orderData.order, bill: generatedBill.bill });
      }

      // Record every split in one atomic request. The persisted bill/key pair
      // makes a lost response safe to retry without creating a second order.
      const paymentResponse = await api.post(
        `/bills/${billData.bill.id}/payments`,
        { payments: paymentLines, customer_id: cart.customerId },
        { headers: { 'Idempotency-Key': attempt.paymentIdempotencyKey } },
      );
      const paidBill: Bill = paymentResponse.data?.bill || billData.bill;
      const pointsEarned = paymentResponse.data?.loyaltyPointsEarned > 0
        ? paymentResponse.data.loyaltyPointsEarned
        : 0;

      if (paidBill.payment_status !== 'paid') {
        toast.error(t('pos.paymentIncomplete', {
          amount: currencyFmt(Number(paidBill.balance) || 0),
        }));
        return;
      }

      const successMsg = pointsEarned > 0
        ? t('pos.orderPaidWithPoints', { number: orderData.order.order_number, points: pointsEarned })
        : t('pos.orderPaid', { number: orderData.order.order_number });
      toast.success(successMsg);
      if (cart.tableId) {
        try {
          const deleted = await heldOrders.removeHeldOrder(cart.tableId, cart.heldOrderId || undefined);
          if (!deleted) await heldOrders.fetchHeldOrders();
        } catch (heldOrderError) {
          // The payment is complete; clearing the held-order record is cleanup.
          console.error('Failed to clear held order after payment', heldOrderError);
        }
      }
      cart.clearCart();
      clearPrepaidAttempt();
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(orderData.order);

      await printBillForTenant(paidBill, isPrepaidCheckout);
    } catch {
      toast.error(t('pos.processOrderFailed'));
    } finally {
      setSubmitting(false);
    }
  };


  const handleSelectAvailableTable = (tableId: string, customer?: { id: number; name: string; phone: string } | null) => {
    cart.setTableId(tableId);
    if (customer) {
      cart.setCustomer({ ...customer, email: null, visits_count: 0, total_spent: 0, last_visit_at: null, country_code: '' });
    }
    setShowTablePicker(false);
  };

  const handleSelectOccupiedTable = async (table: Table) => {
    const activeOrder = table.current_order || table.activeOrder || null;
    const activeCustomerId = activeOrder?.customer_id;
    const activeCustomerName = activeOrder?.customer?.name || t('pos.anotherCustomer');

    if (
      cart.customerId != null &&
      activeCustomerId != null &&
      String(cart.customerId) !== String(activeCustomerId)
    ) {
      const shouldProceed = await confirm(
        t('pos.customerMismatchWarning', { customer: activeCustomerName }),
        {
          title: t('pos.customerMismatchTitle'),
          confirmLabel: t('pos.proceedAnyway'),
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
        cart.loadItems(held.items, tableId, held.customerId, held.guestCount, held.orderNotes, held.id);
        cart.setOrderType('dine_in');
      } else {
        await heldOrders.fetchHeldOrders();
        toast.error(t('pos.loadOrderFailed'));
      }
    } catch {
      toast.error(t('pos.loadOrderFailed'));
    } finally {
      setShowTablePicker(false);
      await refreshTables();
    }
  };

  const handleHoldTable = async (tableId: string) => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === tableId)?.name || tableId;
    try {
      await heldOrders.holdOrder(tableId, cart.items, cart.customerId, cart.guestCount, cart.orderNotes);
      cart.clearCart();
      setShowTablePicker(false);
      toast.success(t('pos.orderHeld', { tableName }));
      await refreshTables();
    } catch {
      toast.error(t('pos.holdOrderFailed'));
    }
  };

  const handleAddItemsToOrder = (table: Table, order: Order) => {
    setCheckoutTable(null);
    cart.setTableId(table.id);
    cart.setOrderType('dine_in');
    cart.setGuestCount(order.guest_count || 1);
    cart.setOrderNotes(order.special_instructions || '');
    setPendingOrder(order);
    toast(`${t('pos.addingItemsToOrder', { number: order.order_number })} ${t('pos.placeOrderReady')}`, { icon: 'ℹ️' });
  };

  // Add cart items directly to existing order
  const handleAddCartToOrder = async (table: Table, order: Order) => {
    if (cart.items.length === 0) {
      toast.error(t('pos.cartEmpty'));
      return;
    }
    setSubmitting(true);
    try {
      const items = cart.items.map((item) => ({
        product_id: item.product.id,
        quantity: item.quantity,
        addons: item.addons.length > 0
          ? item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price, quantity: a.quantity || 1 }))
          : null,
        special_instructions: item.special_instructions || null,
      }));
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
      });
      addItemsAttemptRef.current = itemAttempt;
      await api.post(`/orders/${order.id}/items`, {
        items,
        special_instructions: specialInstructions,
      }, { headers: { 'Idempotency-Key': itemAttempt.idempotencyKey } });
      // A resolved response is the confirmation boundary. Keep the durable
      // attempt through all network errors so a lost response can replay it.
      if (!clearAppendAttempt(storage, itemAttempt)) throw new Error('Unable to clear append retry state');
      addItemsAttemptRef.current = null;
      toast.success(t('pos.itemsAddedToOrder', { number: order.order_number }));
      cart.clearCart();
      setCheckoutTable(null);
      refreshTables();
    } catch {
      toast.error(t('pos.addItemsFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePaymentComplete = async () => {
    const bill = paymentBill; // capture before clearing state
    setPaymentBill(null);
    setCheckoutTable(null);
    refreshTables();

    if (bill) {
      try {
        await printBillForTenant(await fetchLatestBill(bill.id));
      } catch {
        toast.error(t('pos.receiptPrintFailed'));
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

  return (
    <>
      {supportError && (
        <div className="fixed bottom-4 start-4 z-50 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-red-200 bg-white p-4 shadow-xl">
          {sentTicketId ? (
            <>
              <p className="font-semibold text-red-800">{t('support.requestQueued')}</p>
              {delivery.status === 'delivered' && delivery.supportCode ? (
                <>
                  <p className="mt-1 text-sm font-semibold text-gray-800">{t('support.supportCode')}: <Ltr as="span" className="font-mono">{delivery.supportCode}</Ltr></p>
                  <p className="mt-0.5 text-xs text-gray-500">{t('support.supportCodeHint')}</p>
                </>
              ) : (
                <p className="mt-1 text-xs text-gray-500">
                  {delivery.status === 'failed' ? t('support.stillQueuedLocally') : t('support.confirmingDelivery')}
                </p>
              )}
              <div className="mt-3">
                <button className="rounded border px-3 py-2 text-sm" onClick={() => { setSupportError(null); setSentTicketId(null); }}>{t('support.dismiss')}</button>
              </div>
            </>
          ) : (
            <>
              <p className="font-semibold text-red-800">{t('pos.printingFailed')}</p>
              <p className="mt-1 text-sm text-gray-600">{supportError.message}</p>
              <details className="mt-2 text-xs text-gray-500">
                <summary className="cursor-pointer">{t('support.showPayload')}</summary>
                <Ltr as="pre" className="mt-2 max-h-32 overflow-auto rounded bg-gray-50 p-2">{JSON.stringify(
                  diagnosticsPreview
                    ? { ...supportError.payload, diagnostics: { ...(supportError.payload.diagnostics as Record<string, unknown> | undefined), ...diagnosticsPreview } }
                    : supportError.payload,
                  null, 2,
                )}</Ltr>
              </details>
              <div className="mt-3 flex gap-2">
                <button
                  className="rounded bg-brand px-3 py-2 text-sm font-medium text-white"
                  onClick={async () => {
                    const clientTicketId = crypto.randomUUID();
                    try {
                      await api.post('/support-ticket', {
                        ...supportError.payload,
                        subject: 'FloCafe printing problem',
                        correlation_id: crypto.randomUUID(),
                        client_ticket_id: clientTicketId,
                      });
                      toast.success(t('support.queued'));
                      setSentTicketId(clientTicketId);
                    } catch {
                      toast.error(t('pos.supportRequestQueueFailed'));
                    }
                  }}
                >{t('support.getHelp')}</button>
                <button className="rounded border px-3 py-2 text-sm" onClick={() => setSupportError(null)}>{t('support.dismiss')}</button>
              </div>
            </>
          )}
        </div>
      )}
      <PosTopbar tables={tables} onShowTablePicker={() => setShowTablePicker(true)} />

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
            sidebarOpen={leftSidebarOpen}
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
          <button className="fixed bottom-5 end-5 z-40 w-14 h-14 bg-brand text-white rounded-full shadow-lg flex items-center justify-center hover:bg-brand-hover transition-colors md:hidden">
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
          onAdd={handleAddonAdd}
          onClose={() => setAddonProduct(null)}
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
          onAdd={handleEditItemSave}
          onClose={() => setEditingCartItem(null)}
        />
      )}

      {checkoutTable && (
        <TableCheckoutModal
          table={checkoutTable}
          currency={currency}
          cartItemCount={cart.itemCount()}
          onClose={() => setCheckoutTable(null)}
          onAddItems={handleAddItemsToOrder}
          onPayment={(bill) => { setCheckoutTable(null); setPaymentBill(bill); }}
          onAddCartToOrder={handleAddCartToOrder}
        />
      )}

      {paymentBill && (
        <PaymentModal
          bill={paymentBill}
          currency={currency}
          onClose={() => setPaymentBill(null)}
          onPaid={handlePaymentComplete}
          onBillUpdate={(updated) => setPaymentBill(updated)}
        />
      )}

      {showCustomerPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-5 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">{t('pos.selectCustomer')}</h3>
              <button onClick={() => setShowCustomerPrompt(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">{t('pos.customerRequiredBeforeOrder')}</p>
            <CustomerSearch onSelected={() => setShowCustomerPrompt(false)} />
          </div>
        </div>
      )}

      {ConfirmDialog}

      {/* Prepaid Checkout Modal - Payment BEFORE order is placed */}
      {showPrepaidCheckout && (
        <PrepaidCheckoutModal
          currency={currency}
          onClose={() => setShowPrepaidCheckout(false)}
          onConfirm={handlePrepaidCheckout}
        />
      )}

    </>
  );
}
