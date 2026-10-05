'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Trash2, Printer, Percent, Banknote, Search, Plus, Loader2, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import PaymentModal from '@/components/pos/PaymentModal';
import CreateCustomerModal from '@/components/pos/CreateCustomerModal';
import AddonModal from '@/components/pos/AddonModal';
import RefundModal from '@/components/orders/RefundModal';
import { sendBillViaFlo } from '@/lib/whatsapp-share';
import { useConfirm } from '@/hooks/use-confirm';
import type { Table, Product, ProductVariant, Customer, Addon } from '@/lib/types';
import { cartItemToOrderItem } from '@/lib/cart-order-item';
import type { Order, Bill } from '@/lib/types';
import { getCurrencySymbol, getCountryByCode } from '@/lib/countries';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getDiscountInputStep, normalizeFixedDiscountValue } from '@/lib/currency-input';
import { usePrinterStore } from '@/hooks/usePrinter';
import { showPrintWarningsToast } from '@/lib/printer/warnings-toast';
import { formatReceiptErrorToast, extractPrinterErrorMessage } from '@/lib/printer/warnings';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useRouter } from 'next/navigation';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useTranslations, useLocale, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useWhatsAppReady } from '@/hooks/useWhatsAppReady';
import {
  defaultDiscountTypeForMode,
  isDiscountTypeAllowed,
  normalizeDiscountMode,
  type DiscountMode,
  type DiscountType,
} from '@/lib/discount-settings';
import {
  buildAppendItemsFingerprint,
  clearAppendAttempt,
  createSafeAppendAttemptStorage,
  getOrCreateAppendAttempt,
  readAppendAttempt,
  type AppendAttempt,
  type AppendAttemptStorage,
} from '@/lib/append-attempt';
import { preferChildScopedBill } from '@/lib/printer/tax-components';
import { tenantCan } from '@/lib/permissions';
import { cn } from '@/lib/utils';

import { OrderCard } from '@/components/orders/OrderCard';
import { OrdersMasterList } from '@/components/orders/OrdersMasterList';
import { OrderDetailPanel } from '@/components/orders/OrderDetailPanel';
import { useOrdersLayoutPreference } from '@/hooks/useOrdersLayout';

type OrdersKey = keyof AppConfig['Messages']['orders'];

type FilterType = 'all' | 'active' | 'unpaid' | 'held';

const tabLabelKey: Record<FilterType, OrdersKey> = {
  all: 'all',
  active: 'active',
  unpaid: 'unpaidBadge',
  held: 'held',
};

// Consolidated state types
interface Filters {
  search: string;
  table: string;
  type: string;
  status: string;
}

interface CancelModal {
  order: Order;
  reason: string;
  freeTable: boolean;
  overridePin: string;
}

interface VoidItemModal {
  orderId: number;
  itemId: number;
  productName: string;
  overridePin: string;
}

interface DiscountModal {
  order: Order;
  type: DiscountType;
  value: number;
  reason: string;
}

export default function OrdersPage() {
  const { currentTenant, user } = useAuthStore();
  const { printBill, printDeliverySlip } = usePrinterStore();
  const heldOrdersStore = useHeldOrdersStore();
  const router = useRouter();
  const cartStore = useCartStore();
  const { setTablesRequired, autoPrintBill, printerUseUnicode, printerArabicShaping } = usePosSettingsStore();
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const tWhatsappSend = useTranslations('whatsapp.send');

  // sendBillViaFlo (shared with PaymentModal) takes a translator callback;
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
  const { formatTime } = useFormatDate();
  const locale = useLocale();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewingBillId, setPreviewingBillId] = useState<number | null>(null);
  // Snapshot of "now" for the "Xm ago" timestamps below — Date.now() can't be called directly
  // during render (impure), so it's held in state and refreshed periodically instead.
  const [now, setNow] = useState(() => Date.now());
  const [tabFilter, setTabFilter] = useState<FilterType>('active');
  const [paymentBill, setPaymentBill] = useState<Bill | null>(null);
  const [refundModal, setRefundModal] = useState<{ order: Order; bills: Bill[] } | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [kdsEnabled, setKdsEnabled] = useState(true);
  const { confirm, ConfirmDialog } = useConfirm();
  const isWhatsAppReady = useWhatsAppReady();

  // Consolidated filter state
  const [filters, setFilters] = useState<Filters>({ search: '', table: '', type: '', status: '' });
  const searchRef = useRef(filters.search);
  const previousSearchRef = useRef(filters.search);
  const ordersFetchIdRef = useRef(0);
  const ordersRefreshInProgressRef = useRef(false);
  const ordersLoadMoreInProgressRef = useRef(false);
  const ordersRefreshPendingRef = useRef(false);
  const ordersRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedOrdersPageCountRef = useRef(1);
  const lastRateLimitedOrdersRefreshAtRef = useRef(0);
  const [nextOrdersCursor, setNextOrdersCursor] = useState<number | null>(null);
  const [loadingMoreOrders, setLoadingMoreOrders] = useState(false);

  // Consolidated cancel modal state
  const [cancelModal, setCancelModal] = useState<CancelModal | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<number | null>(null);
  const [convertingOrderId, setConvertingOrderId] = useState<number | null>(null);

  // Void (in-progress item) modal state
  const [voidItemModal, setVoidItemModal] = useState<VoidItemModal | null>(null);
  const [voidingItem, setVoidingItem] = useState(false);

  // Consolidated discount modal state
  const [discountModal, setDiscountModal] = useState<DiscountModal | null>(null);
  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');

  // Print states
  const [generatingBill, setGeneratingBill] = useState<number | null>(null);
  const [printingBillId, setPrintingBillId] = useState<number | null>(null);
  const [printingSlipOrderId, setPrintingSlipOrderId] = useState<number | null>(null);
  const [sendingWaOrderId, setSendingWaOrderId] = useState<number | null>(null);
  const [confirmPrintBillId, setConfirmPrintBillId] = useState<number | null>(null);

  // Other states
  const [addItemsOrder, setAddItemsOrder] = useState<Order | null>(null);
  const [printHistory, setPrintHistory] = useState<Record<number, { id: number; print_type: string; user_name: string; printed_at: string }[]>>({});
  const fetchedBillIdsRef = useRef<Set<number>>(new Set());

  // Add Item modal states
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [selectedItems, setSelectedItems] = useState<{ key: string; product: Product; variant: ProductVariant | null; quantity: number; special_instructions: string; addons: Addon[] }[]>([]);
  const [addingItems, setAddingItems] = useState(false);
  const [addonPickerProduct, setAddonPickerProduct] = useState<Product | null>(null);
  const addItemsAttemptRef = useRef<AppendAttempt | null>(null);
  const appendAttemptStorageRef = useRef<AppendAttemptStorage | null>(null);
  const appendRecoveryStartedUsersRef = useRef<Set<string>>(new Set());
  const activeUserId = user?.id == null ? null : String(user.id);

  const getAppendAttemptStorage = (): AppendAttemptStorage => {
    if (appendAttemptStorageRef.current) return appendAttemptStorageRef.current;
    let browserStorage: AppendAttemptStorage | null = null;
    let sessionStorage: AppendAttemptStorage | null = null;
    try {
      if (typeof window !== 'undefined') browserStorage = window.localStorage;
    } catch {
      browserStorage = null;
    }
    try {
      if (typeof window !== 'undefined') sessionStorage = window.sessionStorage;
    } catch {
      sessionStorage = null;
    }
    appendAttemptStorageRef.current = createSafeAppendAttemptStorage(
      browserStorage,
      sessionStorage,
    );
    return appendAttemptStorageRef.current;
  };

  // Link Customer states
  const [linkCustomerOrderId, setLinkCustomerOrderId] = useState<number | null>(null);
  const [linkCustomerSearch, setLinkCustomerSearch] = useState('');
  const [linkCustomerResults, setLinkCustomerResults] = useState<Customer[]>([]);
  const [linkingCustomer, setLinkingCustomer] = useState(false);
  const [createCustomerOrderId, setCreateCustomerOrderId] = useState<number | null>(null);
  const [createCustomerSearch, setCreateCustomerSearch] = useState('');
  const linkSearchRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const currency = getCurrencySymbol(currentTenant?.currency || '', getCountryByCode(currentTenant?.country ?? '')?.locale);
  const unitAdapter = useCurrencyUnitAdapter();
  const normalizedDiscountValue = discountModal?.type === 'amount'
    ? normalizeFixedDiscountValue(discountModal.value, unitAdapter.maxDecimals)
    : discountModal?.value ?? 0;
  const fmt = useFormatCurrency();
  const { layout: ordersLayout } = useOrdersLayoutPreference();
  // Selected order id survives refetches; it resolves against the filtered list
  // so a selection that disappears degrades to the placeholder instead of throwing.
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const canCancelItems = tenantCan(currentTenant, 'orders.item.cancel');
  const canRestoreItems = tenantCan(currentTenant, 'orders.item.restore');
  const canRefund = tenantCan(currentTenant, 'refunds.initiate');

  if (discountModal && !isDiscountTypeAllowed(discountMode, discountModal.type)) {
    setDiscountModal({
      ...discountModal,
      type: defaultDiscountTypeForMode(discountMode),
      value: 0,
    });
    setDiscountPin('');
  }

  const fetchPrintHistory = async (billId: number) => {
    try {
      const { data } = await api.get(`/bills/${billId}/print-history`);
      setPrintHistory(prev => ({ ...prev, [billId]: data.prints || [] }));
    } catch {
      // Ignore error
    }
  };

  const fetchOrders = async (cursor?: number, rateLimitedRefresh = false): Promise<boolean> => {
    if (cursor === undefined && (ordersLoadMoreInProgressRef.current || ordersRefreshInProgressRef.current)) {
      ordersRefreshPendingRef.current = true;
      return true;
    }
    if (cursor !== undefined && (ordersRefreshInProgressRef.current || ordersLoadMoreInProgressRef.current)) return true;
    if (cursor === undefined && rateLimitedRefresh) {
      const now = Date.now();
      const cooldown = 1000 - (now - lastRateLimitedOrdersRefreshAtRef.current);
      if (cooldown > 0) {
        ordersRefreshPendingRef.current = true;
        if (ordersRefreshTimerRef.current === null) {
          ordersRefreshTimerRef.current = setTimeout(() => {
            ordersRefreshTimerRef.current = null;
            if (!ordersRefreshPendingRef.current) return;
            ordersRefreshPendingRef.current = false;
            fetchOrders(undefined, true);
          }, cooldown);
        }
        return true;
      }
      lastRateLimitedOrdersRefreshAtRef.current = now;
    } else if (cursor === undefined) {
      if (ordersRefreshTimerRef.current !== null) {
        clearTimeout(ordersRefreshTimerRef.current);
        ordersRefreshTimerRef.current = null;
      }
      ordersRefreshPendingRef.current = false;
    }
    const fetchId = ++ordersFetchIdRef.current;
    setLoadingMoreOrders(true);
    if (cursor === undefined) {
      ordersRefreshInProgressRef.current = true;
    } else {
      ordersLoadMoreInProgressRef.current = true;
    }
    try {
      const search = searchRef.current.trim();
      const { data } = await api.get('/orders', {
        params: { per_page: 50, ...(search ? { search } : {}), ...(cursor !== undefined ? { before_id: cursor } : {}) },
      });
      if (fetchId !== ordersFetchIdRef.current) return true;
      const orders: Order[] = data.orders || [];
      const nextCursor: number | null = data.nextCursor ?? null;
      if (cursor === undefined) {
        if (loadedOrdersPageCountRef.current > 1) {
          const refreshedOrderIds = new Set(orders.map((order) => order.id));
          setOrders((prev) => [...orders, ...prev.filter((order) => !refreshedOrderIds.has(order.id))]);
        } else {
          setOrders(orders);
          setNextOrdersCursor(nextCursor);
        }
      } else {
        setOrders((prev) => [...prev, ...orders]);
        loadedOrdersPageCountRef.current++;
        setNextOrdersCursor(nextCursor);
      }
      // Fetch print history only for bills we haven't fetched yet
      orders.forEach((order: Order) => {
        if (order.bill?.id && !fetchedBillIdsRef.current.has(order.bill.id)) {
          fetchedBillIdsRef.current.add(order.bill.id);
          fetchPrintHistory(order.bill.id);
        }
      });
      return true;
    } catch {
      if (fetchId === ordersFetchIdRef.current) toast.error(tOrders('loadOrdersFailed'));
      return false;
    } finally {
      if (fetchId === ordersFetchIdRef.current) {
        if (cursor === undefined) {
          ordersRefreshInProgressRef.current = false;
          setLoading(false);
        } else {
          ordersLoadMoreInProgressRef.current = false;
        }
        setLoadingMoreOrders(false);
        if (ordersRefreshPendingRef.current && ordersRefreshTimerRef.current === null) {
          ordersRefreshPendingRef.current = false;
          fetchOrders(undefined, true);
        }
      }
    }
  };

  useEffect(() => {
    searchRef.current = filters.search;
    if (previousSearchRef.current === filters.search) return;
    previousSearchRef.current = filters.search;
    ordersFetchIdRef.current++;
    ordersRefreshInProgressRef.current = false;
    ordersLoadMoreInProgressRef.current = false;
    ordersRefreshPendingRef.current = false;
    if (ordersRefreshTimerRef.current !== null) {
      clearTimeout(ordersRefreshTimerRef.current);
      ordersRefreshTimerRef.current = null;
    }
    loadedOrdersPageCountRef.current = 1;
    setOrders([]);
    setNextOrdersCursor(null);
    setLoading(true);
    setLoadingMoreOrders(false);
    const timeout = setTimeout(() => fetchOrders(undefined, true), 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.search]);

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
    api.post(`/orders/${pendingAttempt.orderId}/items`, {
      items: pendingAttempt.items,
      special_instructions: pendingAttempt.specialInstructions,
    }, { headers: { 'Idempotency-Key': pendingAttempt.idempotencyKey } }).then(() => {
      if (!clearAppendAttempt(getAppendAttemptStorage(), pendingAttempt!)) throw new Error('Unable to clear append retry state');
      if (addItemsAttemptRef.current?.idempotencyKey !== pendingAttempt!.idempotencyKey) return;
      addItemsAttemptRef.current = null;
      toast.success(tOrders('itemsAdded', { count: pendingAttempt!.items.length }));
      fetchOrders();
    }).catch(() => {
      toast.error(tOrders('addItemsFailed'));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUserId]);

  useEffect(() => {
    api.get('/settings/kds_enabled')
      .then((res) => setKdsEnabled(res.data?.setting?.value !== 'false'))
      .catch(() => setKdsEnabled(true));
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const initPage = async () => {
      let isTablesRequired = true;
      try {
        const { data } = await api.get('/settings/business');
        isTablesRequired = typeof data.tables_required === 'boolean' ? data.tables_required : true;
        setTablesRequired(isTablesRequired);
      } catch {
        // Ignore and fallback to default (true)
      }

      fetchOrders();

      if (isTablesRequired) {
        heldOrdersStore.fetchHeldOrders();
        api.get('/tables')
          .then((res) => setTables(res.data.tables || []))
          .catch(() => {});
      }

      api.get('/settings/discount')
        .then((res) => {
          setDiscountMode(normalizeDiscountMode(res.data.discount_mode));
          setDiscountRequiresApproval(!!res.data.discount_requires_approval);
        })
        .catch(() => {});
    };

    initPage();

    // 10-second backup polling interval (WebSocket handles real-time updates)
    const interval = setInterval(() => fetchOrders(undefined, true), 10000);

    // Live WebSocket connection to trigger immediate updates
    let ws: globalThis.WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const connectWS = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/kds`;
      
      try {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          const token = localStorage.getItem('token');
          if (token) {
            ws?.send(JSON.stringify({ type: 'auth', token }));
          }
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'order_updated' || data.type === 'orders' || data.type === 'initial_data') {
              fetchOrders(undefined, true);
            }
          } catch {
            // Ignore parse errors
          }
        };

        ws.onclose = () => {
          reconnectTimeout = setTimeout(connectWS, 3000);
        };

        ws.onerror = () => {
          ws?.close();
        };
      } catch {
        // WS not supported
      }
    };

    connectWS();

    return () => {
      clearInterval(interval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ordersRefreshTimerRef.current !== null) clearTimeout(ordersRefreshTimerRef.current);
      ordersRefreshTimerRef.current = null;
      ordersRefreshPendingRef.current = false;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
     
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTablesRequired]);

  const paymentStatusOf = (order: Order): 'paid' | 'partial' | 'unpaid' | null => {
    if (order.status === 'cancelled') return null;
    if (order.bill?.payment_status === 'paid') return 'paid';
    if (order.bill?.payment_status === 'partial') return 'partial';
    return 'unpaid';
  };

  const handleCreateNewOrderForCustomer = async (order: Order) => {
    if (!order.customer) return;

    // Check for active POS cart items to avoid accidental loss of progress
    if (cartStore.items.length > 0) {
      const proceed = await confirm(
        tOrders('cartClearConfirm')
      );
      if (!proceed) return;
    }

    cartStore.clearCart();
    cartStore.setCustomer(order.customer);

    const posOrderType = (order.type === 'dine_in' || order.type === 'takeaway' || order.type === 'delivery')
      ? order.type
      : 'takeaway';
    cartStore.setOrderType(posOrderType);

    if (posOrderType === 'dine_in' && order.table_id) {
      cartStore.setTableId(order.table_id);
    }

    if (posOrderType === 'delivery' && order.customer.address) {
      cartStore.setDeliveryAddress(order.customer.address);
    }

    router.push('/pos');
    toast.success(tOrders('newOrderStarted', { name: order.customer.name }));
  };

  const searchCustomersForLink = (query: string) => {
    clearTimeout(linkSearchRef.current);
    if (query.length < 2) {
      setLinkCustomerResults([]);
      return;
    }
    linkSearchRef.current = setTimeout(async () => {
      try {
        const { data } = await api.get(`/customers-search?q=${encodeURIComponent(query)}`);
        setLinkCustomerResults(Array.isArray(data) ? data : (data.customers || []));
      } catch {
        setLinkCustomerResults([]);
      }
    }, 300);
  };

  const handleLinkCustomer = async (orderId: number, customerId: string) => {
    setLinkingCustomer(true);
    try {
      await api.patch(`/orders/${orderId}/customer`, { customer_id: customerId });
      toast.success(tOrders('customerLinked'));
      setLinkCustomerOrderId(null);
      setLinkCustomerSearch('');
      setLinkCustomerResults([]);
      fetchOrders();
    } catch {
      toast.error(tOrders('linkCustomerFailed'));
    } finally {
      setLinkingCustomer(false);
    }
  };

  // Completed prepaid orders remain active while unserved kitchen items exist (when KDS enabled).
  const isOrderActive = (order: Order) => {
    if (order.status === 'cancelled') return false;
    if (order.status === 'completed') {
      return kdsEnabled && (order.items || []).some((item) => !['served', 'cancelled'].includes(item.status));
    }
    return true;
  };

  const filteredOrders = orders.filter((order) => {
    // Tab filter
    if (tabFilter === 'active' && !isOrderActive(order)) return false;
    // Filter unpaid orders using resolved payment status since bills are generated at checkout.
    if (tabFilter === 'unpaid' && !['unpaid', 'partial'].includes(paymentStatusOf(order) || '')) return false;

    // Filter by table
    if (filters.table && String(order.table_id) !== filters.table) {
      return false;
    }
    // Filter by type
    if (filters.type && order.type !== filters.type) {
      return false;
    }
    // Filter by status
    if (filters.status === 'active' && !isOrderActive(order)) {
      return false;
    }
    if (filters.status === 'completed' && order.status !== 'completed') {
      return false;
    }
    if (filters.status === 'cancelled' && order.status !== 'cancelled') {
      return false;
    }
    return true;
  });

  const selectedOrder = selectedOrderId == null
    ? undefined
    : filteredOrders.find((order) => order.id === selectedOrderId);

  const handleCheckout = async (orderId: number) => {
    setGeneratingBill(orderId);
    try {
      const { data } = await api.post('/bills/generate', { order_id: orderId });
      setPaymentBill(data.bill);
    } catch {
      toast.error(tOrders('generateBillFailed'));
    } finally {
      setGeneratingBill(null);
    }
  };

  const handlePaymentComplete = async () => {
    const bill = paymentBill; // capture before clearing state
    setPaymentBill(null);
    fetchOrders();

    if (bill && autoPrintBill) {
      try {
        const fallbackOrder = orders.find((o) => o.bill?.id === bill.id);
        const { data } = await api.get(`/bills/${bill.id}`);
        const latestBill = preferChildScopedBill(data.bill as Bill, fallbackOrder);
        const printWarnings = await printBill(
          latestBill,
          {
            business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
            currency: currentTenant?.currency || '',
            country: currentTenant?.country || '',
            timezone: currentTenant?.timezone || 'UTC',
            currency_display: currentTenant?.currency_display,
            number_digits: currentTenant?.number_digits,
            calendar: currentTenant?.calendar,
          },
          { isReprint: false }
        );
        showPrintWarningsToast(printWarnings);
        try {
          await api.post(`/bills/${bill.id}/print`, { print_type: 'receipt' });
        } catch { /* best-effort history tracking */ }
      } catch (err) {
        const msg = extractPrinterErrorMessage(err);
        toast.error(formatReceiptErrorToast(msg, tOrders('receiptPrintFailedHint')));
      }
    }
  };

  const handlePrint = async (billId: number) => {
    const order = orders.find((o) => o.bill?.id === billId);
    if (!order?.bill) {
      toast.error(tOrders('billNotFound'));
      return;
    }
    const isReprint = (printHistory[billId]?.length ?? 0) > 0;
    setPrintingBillId(billId);
    try {
      const { data } = await api.get(`/bills/${billId}`);
      const latestBill = preferChildScopedBill(data.bill as Bill, order);
      // Actually attempt the print first — only log/report success if the printer accepted the job,
      // otherwise a disconnected printer would silently report "success" (it was only logging before).
      const printWarnings = await printBill(
        latestBill,
        {
          business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
          currency: currentTenant?.currency || '',
          country: currentTenant?.country || '',
          timezone: currentTenant?.timezone || 'UTC',
          currency_display: currentTenant?.currency_display,
          number_digits: currentTenant?.number_digits,
          calendar: currentTenant?.calendar,
        },
        { isReprint }
      );
      toast.success(isReprint ? tOrders('printReceiptReprint') : tOrders('printReceipt'));
      showPrintWarningsToast(printWarnings);
      try {
        await api.post(`/bills/${billId}/print`, { print_type: isReprint ? 'reprint' : 'receipt' });
        fetchPrintHistory(billId);
      } catch { /* best-effort history tracking */ }
    } catch (err) {
      const detail = extractPrinterErrorMessage(err);
      toast.error(formatReceiptErrorToast(detail, tOrders('printReceiptFailed')));
    } finally {
      setPrintingBillId(null);
      setConfirmPrintBillId(null);
    }
  };

  const handlePrintOrder = async (order: Order) => {
    if (order.bill?.id) {
      setConfirmPrintBillId(order.bill.id);
      return;
    }
    setGeneratingBill(order.id);
    try {
      const { data } = await api.post('/bills/generate', { order_id: order.id });
      const bill = data.bill as Bill;
      setOrders((prev) => prev.map((o) => (o.id === order.id ? { ...o, bill } : o)));
      await fetchOrders();
      setConfirmPrintBillId(bill.id);
    } catch {
      toast.error(tOrders('generateBillFailed'));
    } finally {
      setGeneratingBill(null);
    }
  };

  const handlePrintDeliverySlip = async (order: Order) => {
    const customer = order.customer;
    const phone = customer?.phone
      ? (customer.country_code && !customer.phone.startsWith(customer.country_code)
        ? `${customer.country_code} ${customer.phone}`
        : customer.phone)
      : '';
    setPrintingSlipOrderId(order.id);
    try {
      const warnings = await printDeliverySlip(
        order,
        {
          name: customer?.name || '',
          phone,
          // The order's own address wins; pre-column orders take the fallback,
          // so that is the common case rather than the rare one.
          address: order.delivery_address || customer?.address || '',
        },
      );
      showPrintWarningsToast(warnings);
      toast.success(tOrders('printDeliverySlip'));
      fetchOrders();
    } catch (err) {
      const detail = extractPrinterErrorMessage(err);
      toast.error(formatReceiptErrorToast(detail, tOrders('printReceiptFailed')));
    } finally {
      setPrintingSlipOrderId(null);
    }
  };

  const handleDownloadPrintPreview = async (billId: number) => {
    setPreviewingBillId(billId);
    try {
      const isReprint = (printHistory[billId]?.length ?? 0) > 0;
      const { data } = await api.post<{
        columns: number;
        printer: { name: string };
        text: string;
      }>('/printers/print-bill', {
        billId,
        useUnicode: printerUseUnicode,
        arabicShaping: printerArabicShaping,
        isReprint,
        preview: true,
      });
      const contents = `Printer: ${data.printer.name}\nColumns: ${data.columns}\n\n${data.text}\n`;
      const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `receipt-${billId}-${data.columns}cols.txt`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(tOrders('printPreviewDownloaded'));
    } catch {
      toast.error(tOrders('printPreviewFailed'));
    } finally {
      setPreviewingBillId(null);
    }
  };

  const deleteItem = async (orderId: number, itemId: number) => {
    if (!canCancelItems) {
      toast.error(tOrders('onlyOwnersRemove'));
      return;
    }
    if (!await confirm(tOrders('removeItemConfirm'), { destructive: true, confirmLabel: tCommon('remove') })) return;
    try {
      await api.patch(`/orders/${orderId}/items/${itemId}/cancel`, { reason: tOrders('removedByManager') });
      toast.success(tOrders('itemRemoved'));
      fetchOrders();
    } catch {
      toast.error(tOrders('removeItemFailed'));
    }
  };

  const handleVoidItem = async () => {
    if (!voidItemModal) return;
    setVoidingItem(true);
    try {
      await api.patch(`/orders/${voidItemModal.orderId}/items/${voidItemModal.itemId}/cancel`, {
        reason: tOrders('removedByManager'),
        override_pin: voidItemModal.overridePin || undefined,
      });
      toast.success(tOrders('itemVoided'));
      setVoidItemModal(null);
      fetchOrders();
    } catch {
      toast.error(tOrders('voidItemFailed'));
    } finally {
      setVoidingItem(false);
    }
  };

  const restoreItem = async (orderId: number, itemId: number) => {
    if (!canRestoreItems) return;
    try {
      await api.patch(`/orders/${orderId}/items/${itemId}/restore`);
      toast.success(tOrders('itemRestored'));
      fetchOrders();
    } catch {
      toast.error(tOrders('restoreItemFailed'));
    }
  };

  const handleSendViaFlo = async (order: Order) => {
    if (!order.bill) {
      toast.error(tOrders('billNotFound'));
      return;
    }
    if (!order.customer?.phone) {
      toast.error(tWhatsappSend('customerPhoneRequired'));
      return;
    }
    setSendingWaOrderId(order.id);
    try {
      await sendBillViaFlo(
        { ...order.bill, order },
        order.customer.phone,
        {
          business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
          currency: currentTenant?.currency || '',
          country: currentTenant?.country || '',
        },
        whatsappSendT,
        { pointsEarned: order.bill.points_earned ?? 0 },
        locale,
      );
      await fetchOrders();
    } finally {
      setSendingWaOrderId(null);
    }
  };

  const handleApplyDiscount = async () => {
    if (!discountModal) return;

    if (discountModal.type === 'amount' && discountModal.value > 0 && normalizedDiscountValue <= 0) {
      toast.error(tOrders('discountFailed'));
      return;
    }

    // Check if PIN is required
    if (discountRequiresApproval && normalizedDiscountValue > 0 && !discountPin) {
      toast.error(tOrders('managerPinRequired'));
      return;
    }
    if (normalizedDiscountValue > 0 && !isDiscountTypeAllowed(discountMode, discountModal.type)) {
      toast.error(tOrders('discountFailed'));
      return;
    }

    try {
      await api.patch(`/orders/${discountModal.order.id}/discount`, {
        discount_type: discountModal.type,
        discount_value: normalizedDiscountValue,
        discount_reason: discountModal.reason || undefined,
        override_pin: discountRequiresApproval && normalizedDiscountValue > 0 ? discountPin : undefined,
      });
      toast.success(tOrders('discountApplied'));
      fetchOrders();
    } catch {
      toast.error(tOrders('discountFailed'));
    } finally {
      setDiscountModal(null);
      setDiscountPin('');
    }
  };

  const handleConvertToTakeaway = async (order: Order) => {
    const tableNote = order.table ? tOrders('freeTableSuffix', { name: order.table.name }) : '';
    if (!await confirm(tOrders('convertToTakeawayConfirm', { number: order.order_number, tableNote }))) return;
    setConvertingOrderId(order.id);
    try {
      await api.patch(`/orders/${order.id}/convert-to-takeaway`);
      toast.success(tOrders('orderConvertedTakeaway'));
      fetchOrders();
    } catch {
      toast.error(tOrders('convertOrderFailed'));
    } finally {
      setConvertingOrderId(null);
    }
  };

  const openAddItemsModal = (order: Order | null) => {
    setSelectedItems([]);
    setProductSearch('');
    setAddItemsOrder(order);
  };

  useEffect(() => {
    if (!addItemsOrder) return;
    api.get('/products', { params: { per_page: 200 } })
      .then(({ data }) => setProducts(data.products || []))
      .catch(() => toast.error(tOrders('menuLoadFailed')));
  }, [addItemsOrder, tOrders]);

  const handleAddItemToSelection = (product: Product) => {
    if ((product.addon_groups || []).length > 0 || (product.variants || []).length > 0) {
      setAddonPickerProduct(product);
      return;
    }
    setSelectedItems(prev => {
      const existing = prev.find(i => i.product.id === product.id && !i.variant && i.addons.length === 0);
      if (existing) {
        return prev.map(i => i === existing ? { ...i, quantity: i.quantity + 1 } : i);
      }
      const key = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `item-${prev.length}-${Math.random().toString(36).slice(2)}`;
      return [...prev, { key, product, variant: null, quantity: 1, special_instructions: '', addons: [] }];
    });
  };

  const handleAddonPickerAdd = (product: Product, quantity: number, addons: Addon[], instructions: string, variant: ProductVariant | null) => {
    setSelectedItems(prev => {
      const key = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `item-${prev.length}-${Math.random().toString(36).slice(2)}`;
      return [...prev, {
        key,
        product,
        variant,
        quantity,
        special_instructions: instructions,
        addons,
      }];
    });
    setAddonPickerProduct(null);
  };

  const handleRemoveFromSelection = (key: string) => {
    setSelectedItems(prev => prev.filter(i => i.key !== key));
  };

  const handleUpdateSelectionQty = (key: string, quantity: number) => {
    if (quantity < 1) return;
    setSelectedItems(prev => prev.map(i => i.key === key ? { ...i, quantity } : i));
  };

  const handleUpdateSelectionNotes = (key: string, notes: string) => {
    setSelectedItems(prev => prev.map(i => i.key === key ? { ...i, special_instructions: notes } : i));
  };

  const handleSubmitAddItems = async () => {
    if (!addItemsOrder || selectedItems.length === 0) return;
    setAddingItems(true);
    try {
      const items = selectedItems.map((i) => cartItemToOrderItem(i));
      const fingerprint = buildAppendItemsFingerprint(addItemsOrder.id, items);
      const storage = getAppendAttemptStorage();
      const attempt = getOrCreateAppendAttempt(storage, {
        userId: activeUserId || '',
        orderId: addItemsOrder.id,
        fingerprint,
        createKey: () => typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `items-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        items,
        orderNumber: addItemsOrder.order_number,
      });
      addItemsAttemptRef.current = attempt;
      await api.post(`/orders/${addItemsOrder.id}/items`, {
        items,
      }, { headers: { 'Idempotency-Key': attempt.idempotencyKey } });
      if (!clearAppendAttempt(storage, attempt)) throw new Error('Unable to clear append retry state');
      addItemsAttemptRef.current = null;
      toast.success(tOrders('itemsAdded', { count: selectedItems.length }));
      openAddItemsModal(null);
      fetchOrders();
    } catch {
      toast.error(tOrders('addItemsFailed'));
    } finally {
      setAddingItems(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!cancelModal) return;

    setCancellingOrderId(cancelModal.order.id);
    try {
      await api.patch(`/orders/${cancelModal.order.id}/status`, {
        status: 'cancelled',
        reason: cancelModal.reason || undefined,
        free_table: cancelModal.freeTable,
        override_pin: cancelModal.overridePin || undefined,
      });
      toast.success(tOrders('orderCancelled'));
      fetchOrders();
    } catch {
      toast.error(tOrders('cancelOrderFailed'));
    } finally {
      setCancellingOrderId(null);
      setCancelModal(null);
    }
  };

  // Helper to update cancel modal state
  const updateCancelModal = (updates: Partial<Omit<CancelModal, 'order'>>) => {
    if (cancelModal) {
      setCancelModal({ ...cancelModal, ...updates });
    }
  };

  // Helper to update discount modal state
  const updateDiscountModal = (updates: Partial<Omit<DiscountModal, 'order'>>) => {
    if (discountModal) {
      setDiscountModal({ ...discountModal, ...updates });
    }
  };

  return (
    <div className={ordersLayout === 'split' ? 'h-full min-h-0 flex flex-col gap-4' : 'space-y-4'}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <h1 className="text-2xl font-bold text-foreground">{tNav('orders')}</h1>
        <div className="flex gap-2">
          {(['all', 'active', 'unpaid', 'held'] as FilterType[]).map((f) => (
            <button
              key={f}
              onClick={() => setTabFilter(f)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
                tabFilter === f
                  ? 'bg-brand text-white'
                  : 'bg-card text-muted-foreground border border-border hover:border-gray-400'
              }`}
            >
              {tOrders(tabLabelKey[f])}
            </button>
          ))}
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3 mb-4 shrink-0">
        {/* Search by order number, customer name, or phone */}
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder={tOrders('search')}
            value={filters.search}
            onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
            className="w-full ps-9 pe-3 py-2 border border-border bg-card rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
          />
        </div>

        {/* Table filter */}
        <select
          value={filters.table}
          onChange={(e) => setFilters(prev => ({ ...prev, table: e.target.value }))}
          className="px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
        >
          <option value="">{tOrders('allTables')}</option>
          {tables.map((table: Table) => (
            <option key={table.id} value={String(table.id)}>
              {table.name}
            </option>
          ))}
        </select>

        {/* Type filter */}
        <select
          value={filters.type}
          onChange={(e) => setFilters(prev => ({ ...prev, type: e.target.value }))}
          className="px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
        >
          <option value="">{tOrders('allTypes')}</option>
          <option value="dine_in">{tOrders('dineIn')}</option>
          <option value="takeaway">{tOrders('takeaway')}</option>
          <option value="delivery">{tOrders('delivery')}</option>
          <option value="online">{tOrders('online')}</option>
        </select>

        {/* Status filter */}
        <select
          value={filters.status}
          onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))}
          className="px-3 py-2 border border-border bg-card rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
        >
          <option value="">{tOrders('allStatuses')}</option>
          <option value="active">{tOrders('active')}</option>
          <option value="completed">{tOrders('completed')}</option>
          <option value="cancelled">{tOrders('cancelled')}</option>
        </select>
      </div>

      {/* Orders List */}
      {tabFilter === 'held' ? (
        loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        ) : Object.keys(heldOrdersStore.orders).length === 0 ? (
          <div className="flex items-center justify-center py-24 text-gray-400">
            <p>{tOrders('heldEmpty')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 content-start items-start auto-rows-max">
            {Object.values(heldOrdersStore.orders).map((heldOrder) => (
              <div key={heldOrder.tableId} className="bg-card rounded-xl border border-blue-200 overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-shadow">
                 <div className="p-4 border-b border-border bg-blue-50/50 flex justify-between items-center">
                   <div>
                     <p className="font-bold text-foreground">{tables.find(t => t.id === heldOrder.tableId)?.name || tCommon('tableFallback')}</p>
                     <p className="text-xs text-muted-foreground">{formatTime(heldOrder.heldAt)}</p>
                   </div>
                   <span className="bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full font-bold tracking-wide">{tOrders('held')}</span>
                 </div>
                 <div className="p-4 flex-1">
                   {heldOrder.items.map((item, idx) => (
                     <div key={idx} className="flex justify-between text-sm py-1 text-foreground">
                       <span>{item.quantity}x {item.product.name}</span>
                     </div>
                   ))}
                   {heldOrder.orderNotes && (
                     <div className="mt-3 text-sm italic text-muted-foreground bg-muted p-2 rounded-lg">
                       &quot;{heldOrder.orderNotes}&quot;
                     </div>
                   )}
                 </div>
                 <div className="p-4 bg-muted border-t border-border flex gap-2">
                    <Button onClick={async () => {
                      try {
                        const held = await heldOrdersStore.restoreOrder(heldOrder.tableId);
                        if (held) {
                          cartStore.loadItems(held.items, heldOrder.tableId, held.customerId, held.guestCount, held.orderNotes, held.id);
                          cartStore.setOrderType('dine_in');
                          router.push('/pos');
                        } else {
                          await heldOrdersStore.fetchHeldOrders();
                          toast.error(tOrders('resumeFailed'));
                        }
                      } catch {
                        toast.error(tOrders('resumeFailed'));
                      }
                    }} variant="default" className="flex-1 bg-brand hover:bg-brand/90 text-white">{tOrders('resumeInPos')}</Button>
                    <Button onClick={async () => {
                      if (await confirm(tOrders('deleteHeldConfirm'), { destructive: true })) {
                        try {
                          const deleted = await heldOrdersStore.removeHeldOrder(heldOrder.tableId, heldOrder.id);
                          if (deleted) {
                            toast.success(tOrders('heldOrderRemoved'));
                          } else {
                            await heldOrdersStore.fetchHeldOrders();
                            toast.error(tOrders('removeHeldOrderFailed'));
                          }
                        } catch {
                          toast.error(tOrders('removeHeldOrderFailed'));
                        }
                      }
                    }} variant="outline" className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50">{tOrders('delete')}</Button>
                 </div>
              </div>
            ))}
          </div>
        )
      ) : loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-gray-400">
          <p>{tOrders('empty')}</p>
        </div>
      ) : ordersLayout === 'split' ? (
        <div className="flex-1 min-h-0 flex gap-4">
          {/* Master pane — 40% on desktop, full width below md. */}
          <div className={cn(selectedOrder ? 'hidden md:flex' : 'flex', 'w-full md:w-[40%] min-w-0 flex-col rounded-xl border border-border bg-card overflow-hidden')}>
            <OrdersMasterList
              orders={filteredOrders}
              selectedOrderId={selectedOrderId}
              onSelect={setSelectedOrderId}
              now={now}
            />
          </div>

          {/* Detail pane — 60% on desktop, full width with back nav below md. */}
          <div className={cn(selectedOrder ? 'flex' : 'hidden md:flex', 'w-full md:w-[60%] min-w-0')}>
            <OrderDetailPanel
              order={selectedOrder ?? null}
              onBack={() => setSelectedOrderId(null)}
              now={now}
              canCancelItems={canCancelItems}
              canRestoreItems={canRestoreItems}
              canRefund={canRefund}
              isWhatsAppReady={isWhatsAppReady}
              printHistory={printHistory}
              generatingBillId={generatingBill}
              printingBillId={printingBillId}
              printingSlipOrderId={printingSlipOrderId}
              sendingWaOrderId={sendingWaOrderId}
              cancellingOrderId={cancellingOrderId}
              convertingOrderId={convertingOrderId}
              isLinkingCustomer={selectedOrderId !== null && linkCustomerOrderId === selectedOrderId}
              linkCustomerSearch={linkCustomerSearch}
              linkCustomerResults={linkCustomerResults}
              linkingCustomer={linkingCustomer}
              onCheckout={handleCheckout}
              onAddItems={openAddItemsModal}
              onRefund={(ord, bills) => setRefundModal({ order: ord, bills })}
              onConvertToTakeaway={handleConvertToTakeaway}
              onCancelOrder={(ord) => setCancelModal({ order: ord, reason: '', freeTable: true, overridePin: '' })}
              onPrint={(billId) => setConfirmPrintBillId(billId)}
              onPrintOrder={tenantCan(currentTenant, 'bills.generate') ? handlePrintOrder : undefined}
              onPrintDeliverySlip={handlePrintDeliverySlip}
              onSendWhatsApp={handleSendViaFlo}
              onLinkCustomer={(orderId) => {
                setLinkCustomerOrderId(orderId);
                setLinkCustomerSearch('');
                setLinkCustomerResults([]);
              }}
              onCancelLinkCustomer={() => {
                setLinkCustomerOrderId(null);
                setLinkCustomerSearch('');
                setLinkCustomerResults([]);
              }}
              onSearchCustomer={(query) => {
                setLinkCustomerSearch(query);
                searchCustomersForLink(query);
              }}
              onSelectCustomer={handleLinkCustomer}
              onCreateCustomer={(orderId, search) => {
                setCreateCustomerSearch(search);
                setCreateCustomerOrderId(orderId);
              }}
              onCreateNewOrderForCustomer={handleCreateNewOrderForCustomer}
              onDownloadPrintPreview={handleDownloadPrintPreview}
              onDeleteItem={deleteItem}
              onVoidItem={(orderId, itemId, productName) =>
                setVoidItemModal({ orderId, itemId, productName, overridePin: '' })
              }
              onRestoreItem={restoreItem}
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 content-start items-start auto-rows-max">
          {filteredOrders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              now={now}
              canCancelItems={canCancelItems}
              canRestoreItems={canRestoreItems}
              canRefund={canRefund}
              isWhatsAppReady={isWhatsAppReady}
              printHistory={printHistory}
              generatingBillId={generatingBill}
              printingBillId={printingBillId}
              onPrintDeliverySlip={handlePrintDeliverySlip}
              printingSlipOrderId={printingSlipOrderId}
              sendingWaOrderId={sendingWaOrderId}
              cancellingOrderId={cancellingOrderId}
              convertingOrderId={convertingOrderId}
              isLinkingCustomer={linkCustomerOrderId === order.id}
              linkCustomerSearch={linkCustomerSearch}
              linkCustomerResults={linkCustomerResults}
              linkingCustomer={linkingCustomer}
              onCheckout={handleCheckout}
              onAddItems={openAddItemsModal}
              onRefund={(ord, bills) => setRefundModal({ order: ord, bills })}
              onConvertToTakeaway={handleConvertToTakeaway}
              onCancelOrder={(ord) => setCancelModal({ order: ord, reason: '', freeTable: true, overridePin: '' })}
              onPrint={(billId) => setConfirmPrintBillId(billId)}
              onPrintOrder={tenantCan(currentTenant, 'bills.generate') ? handlePrintOrder : undefined}
              onSendWhatsApp={handleSendViaFlo}
              onLinkCustomer={(orderId) => {
                setLinkCustomerOrderId(orderId);
                setLinkCustomerSearch('');
                setLinkCustomerResults([]);
              }}
              onCancelLinkCustomer={() => {
                setLinkCustomerOrderId(null);
                setLinkCustomerSearch('');
                setLinkCustomerResults([]);
              }}
              onSearchCustomer={(query) => {
                setLinkCustomerSearch(query);
                searchCustomersForLink(query);
              }}
              onSelectCustomer={handleLinkCustomer}
              onCreateCustomer={(orderId, search) => {
                setCreateCustomerSearch(search);
                setCreateCustomerOrderId(orderId);
              }}
              onCreateNewOrderForCustomer={handleCreateNewOrderForCustomer}
              onDownloadPrintPreview={handleDownloadPrintPreview}
              onDeleteItem={deleteItem}
              onVoidItem={(orderId, itemId, productName) =>
                setVoidItemModal({ orderId, itemId, productName, overridePin: '' })
              }
              onRestoreItem={restoreItem}
            />
          ))}
        </div>
      )}
      {filters.search.trim() && tabFilter !== 'held' && !loading && nextOrdersCursor !== null && (
        <div className="text-center py-3 border-t border-border">
          <Button variant="outline" size="sm" onClick={() => fetchOrders(nextOrdersCursor)} disabled={loadingMoreOrders}>
            {loadingMoreOrders ? <Loader2 size={14} className="animate-spin" /> : tCommon('loadMore')}
          </Button>
        </div>
      )}

      {/* Payment Modal */}
      {paymentBill && (
        <PaymentModal
          bill={paymentBill}
          currency={currency}
          onClose={() => setPaymentBill(null)}
          onPaid={handlePaymentComplete}
          onBillUpdate={(updated) => setPaymentBill(updated)}
        />
      )}

      {/* Refund Modal */}
      {refundModal && (
        <RefundModal
          order={refundModal.order}
          bills={refundModal.bills}
          onClose={() => setRefundModal(null)}
          onRefunded={() => { setRefundModal(null); fetchOrders(); }}
        />
      )}

      {/* Print Confirmation Modal */}
      {confirmPrintBillId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-bold text-foreground mb-2">
              {(printHistory[confirmPrintBillId]?.length ?? 0) > 0 ? tOrders('reprintReceiptTitle') : tOrders('printReceiptTitle')}
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              {(printHistory[confirmPrintBillId]?.length ?? 0) > 0
                ? tOrders('reprintReceiptWarning')
                : tOrders('printReceiptConfirm')}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmPrintBillId(null)}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDownloadPrintPreview(confirmPrintBillId)}
                disabled={previewingBillId === confirmPrintBillId}
                title={tOrders('downloadPrintPreview')}
                aria-label={tOrders('downloadPrintPreview')}
                className="w-9 px-0"
              >
                {previewingBillId === confirmPrintBillId
                  ? <Loader2 size={14} className="animate-spin" />
                  : <Download size={14} />}
              </Button>
              <Button
                size="sm"
                onClick={() => handlePrint(confirmPrintBillId)}
                disabled={printingBillId === confirmPrintBillId}
              >
                <Printer size={14} className="me-1.5" />
                {printingBillId === confirmPrintBillId
                  ? tOrders('printing')
                  : (printHistory[confirmPrintBillId]?.length ?? 0) > 0
                    ? tOrders('confirmReprint')
                    : tOrders('confirmPrint')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Order Modal */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-bold text-foreground mb-4">{tOrders('cancel')} #<Ltr>{cancelModal.order.order_number}</Ltr></h2>
            <p className="text-sm text-muted-foreground -mt-2 mb-4">
              {tOrders('cancelOrderStatusHint')}
            </p>

            <div className="space-y-4">
              <div>
                <label htmlFor="cancelReason" className="block text-sm font-medium text-foreground mb-1">
                  {tCommon('reasonOptional')}
                </label>
                <input
                  id="cancelReason"
                  type="text"
                  value={cancelModal.reason}
                  onChange={(e) => updateCancelModal({ reason: e.target.value })}
                  placeholder={tOrders('cancelReason')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                />
              </div>

              {cancelModal.order.type === 'dine_in' && cancelModal.order.table && (
                <div className="flex items-center gap-2">
                  <input
                    id="freeTable"
                    type="checkbox"
                    checked={cancelModal.freeTable}
                    onChange={(e) => updateCancelModal({ freeTable: e.target.checked })}
                    className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                  />
                  <label htmlFor="freeTable" className="text-sm text-foreground">
                    {tOrders('freeTable', { name: cancelModal.order.table.name })}
                  </label>
                </div>
              )}

              {(cancelModal.order.status !== 'pending' || cancelModal.order.items?.some((i) => ['preparing', 'ready', 'served', 'completed'].includes(i.status))) && (
                <div>
                  <label htmlFor="overridePin" className="block text-sm font-medium text-foreground mb-1">
                    {tOrders('overridePinLabel')}
                  </label>
                  <input
                    id="overridePin"
                    type="password"
                    value={cancelModal.overridePin}
                    onChange={(e) => updateCancelModal({ overridePin: e.target.value })}
placeholder={tOrders('managerPin')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCancelModal(null)}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleCancelOrder}
                disabled={cancellingOrderId === cancelModal.order.id}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {cancellingOrderId === cancelModal.order.id ? tOrders('cancelling') : tOrders('confirmCancel')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Void In-Progress Item Modal */}
      {voidItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-bold text-foreground mb-1">{tOrders('voidItem')}</h2>
            <p className="text-sm text-muted-foreground mb-4">{tOrders('voidItemConfirm', { name: voidItemModal.productName })}</p>

            <div>
              <label htmlFor="voidOverridePin" className="block text-sm font-medium text-foreground mb-1">
                {tOrders('overridePinLabel')}
              </label>
              <input
                id="voidOverridePin"
                type="password"
                autoFocus
                value={voidItemModal.overridePin}
                onChange={(e) => setVoidItemModal({ ...voidItemModal, overridePin: e.target.value })}
                placeholder={tOrders('managerPin')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVoidItemModal(null)}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleVoidItem}
                disabled={voidingItem || !voidItemModal.overridePin}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {voidingItem ? tOrders('voidingItem') : tOrders('confirmVoidItem')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Discount Modal */}
      {discountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-bold text-foreground mb-4">{tOrders('applyDiscountTitle', { number: discountModal.order.order_number })}</h2>

            <div className="space-y-4">
              {/* Discount Type Toggle */}
              <div className="flex rounded-lg overflow-hidden border border-border">
                {isDiscountTypeAllowed(discountMode, 'percentage') && (
                  <button
                    onClick={() => updateDiscountModal({ type: 'percentage', value: 0 })}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
                      discountModal.type === 'percentage'
                        ? 'bg-purple-600 text-white'
                        : 'bg-muted text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <Percent size={14} />
                    {tCommon('percentage')}
                  </button>
                )}
                {isDiscountTypeAllowed(discountMode, 'amount') && (
                  <button
                    onClick={() => updateDiscountModal({ type: 'amount', value: 0 })}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
                      discountModal.type === 'amount'
                        ? 'bg-purple-600 text-white'
                        : 'bg-muted text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <Banknote size={14} />
                    {tCommon('amount')}
                  </button>
                )}
              </div>

              {/* Discount Value */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  {discountModal.type === 'percentage' ? tOrders('discountPercentageLabel') : tOrders('discountAmountLabel')}
                </label>
                <div className="relative">
                  <span className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                    {discountModal.type === 'percentage' ? '%' : currency}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={discountModal.type === 'percentage' ? 100 : Number(discountModal.order.total)}
                    step={getDiscountInputStep(unitAdapter.maxDecimals, discountModal.type)}
                    value={discountModal.value || ''}
                    onChange={(e) => updateDiscountModal({ value: Number(e.target.value) })}
                    placeholder={discountModal.type === 'percentage' ? '0' : unitAdapter.formatInput(0)}
                    className="w-full ps-8 pe-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                </div>
              </div>

              {/* Discount Reason */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  {tCommon('reasonOptional')}
                </label>
                <input
                  type="text"
                  value={discountModal.reason}
                  onChange={(e) => updateDiscountModal({ reason: e.target.value })}
                  placeholder={tOrders('discountReason')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>

              {/* Preview */}
              <div className="bg-muted rounded-lg p-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{tCommon('subtotal')}</span>
                  <span className="text-foreground">{fmt(Number(discountModal.order.subtotal))}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{tCommon('tax')}</span>
                  <span className="text-foreground">{fmt(Number(discountModal.order.tax_amount || 0))}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-purple-600">
                    {tCommon('discount')}
                    {discountModal.type === 'percentage' && discountModal.value > 0 && (
                      <span className="text-gray-400 ms-1">{tOrders('percentOnSubtotal', { value: discountModal.value })}</span>
                    )}
                  </span>
                  <span className="text-purple-600">
                    -{fmt(
                      discountModal.type === 'percentage'
                        ? Number(discountModal.order.subtotal) * discountModal.value / 100
                        : normalizedDiscountValue
                    )}
                  </span>
                </div>
                <div className="border-t border-border pt-1.5 flex justify-between text-sm font-bold">
                  <span className="text-foreground">{tOrders('newTotal')}</span>
                  <span className="text-foreground">
                    {fmt(
                      discountModal.type === 'percentage'
                        ? Number(discountModal.order.subtotal) * (1 - discountModal.value / 100) + Number(discountModal.order.tax_amount || 0)
                        : Number(discountModal.order.subtotal) - normalizedDiscountValue + Number(discountModal.order.tax_amount || 0)
                    )}
                  </span>
                </div>
              </div>
            </div>

            {discountRequiresApproval && discountModal.value > 0 && (
              <div className="mt-4">
                <label className="block text-sm font-medium text-foreground mb-1">{tOrders('managerPinLabel')}</label>
                <input
                  type="password"
                  value={discountPin}
                  onChange={(e) => setDiscountPin(e.target.value)}
placeholder={tOrders('managerPin')}
                maxLength={6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDiscountModal(null)}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleApplyDiscount}
                disabled={discountModal.value <= 0}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                <Percent size={14} className="me-1.5" />
                {tOrders('applyDiscount')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Item Modal */}
      {addItemsOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
            <h2 className="text-lg font-bold text-foreground mb-4">{tOrders('addItems')} #<Ltr>{addItemsOrder.order_number}</Ltr></h2>

            {/* Search */}
            <div className="relative mb-3">
              <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder={tOrders('searchMenu')}
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                className="w-full ps-9 pe-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>

            {/* Product list */}
            <div className="flex-1 overflow-y-auto border border-border rounded-lg mb-3 max-h-48">
              {products
                .filter(p => !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase()))
                .map((product: Product) => (
                  <button
                    key={product.id}
                    onClick={() => handleAddItemToSelection(product)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-green-50 dark:hover:bg-green-950/40 text-start border-b border-gray-50 last:border-0 transition-colors"
                  >
                    <div>
                      <span className="text-sm font-medium text-foreground">{product.name}</span>
                      {product.price && (
                        <span className="text-xs text-muted-foreground ms-2">{fmt(Number(product.price))}</span>
                      )}
                    </div>
                    <Plus size={14} className="text-green-500" />
                  </button>
                ))
              }
              {products.filter(p => !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase())).length === 0 && (
                <div className="px-3 py-4 text-sm text-gray-400 text-center">{tOrders('noItemsFound')}</div>
              )}
            </div>

            {/* Selected items */}
            {selectedItems.length > 0 && (
              <div className="space-y-2 mb-3">
                <p className="text-xs font-medium text-muted-foreground uppercase">{tOrders('selectedItems')}</p>
                {selectedItems.map(item => (
                  <div key={item.key} className="flex items-center gap-2 bg-muted rounded-lg p-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate block">
                        {item.variant ? `${item.product.name} (${item.variant.name})` : item.product.name}
                      </span>
                      {item.addons.length > 0 && (
                        <span className="text-xs text-muted-foreground truncate block">
                          {item.addons.map((a) => a.name).join(', ')}
                        </span>
                      )}
                      <input
                        type="text"
                        placeholder={tOrders('notesOptional')}
                        value={item.special_instructions}
                        maxLength={100}
                        onChange={(e) => handleUpdateSelectionNotes(item.key, e.target.value.slice(0, 100))}
                        className="w-full text-xs text-muted-foreground bg-transparent border-0 p-0 focus:outline-none placeholder:text-gray-300"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleUpdateSelectionQty(item.key, item.quantity - 1)}
                        className="w-6 h-6 rounded bg-gray-200 text-muted-foreground text-xs hover:bg-gray-300"
                      >-</button>
                      <span className="w-6 text-center text-sm font-medium">{item.quantity}</span>
                      <button
                        onClick={() => handleUpdateSelectionQty(item.key, item.quantity + 1)}
                        className="w-6 h-6 rounded bg-gray-200 text-muted-foreground text-xs hover:bg-gray-300"
                      >+</button>
                    </div>
                    <button
                      onClick={() => handleRemoveFromSelection(item.key)}
                      className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                onClick={() => openAddItemsModal(null)}
              >
                {tCommon('cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleSubmitAddItems}
                disabled={selectedItems.length === 0 || addingItems}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                <Plus size={14} className="me-1.5" />
                {addingItems ? tOrders('adding') : tOrders('addItemsCount', { count: selectedItems.length })}
              </Button>
            </div>
          </div>
        </div>
      )}
      {addonPickerProduct && (
        <AddonModal
          product={addonPickerProduct}
          currency={currency}
          onAdd={handleAddonPickerAdd}
          onClose={() => setAddonPickerProduct(null)}
        />
      )}
      {createCustomerOrderId !== null && (
        <CreateCustomerModal
          initialSearch={createCustomerSearch}
          onClose={() => {
            setCreateCustomerOrderId(null);
            setCreateCustomerSearch('');
          }}
          onCreated={async (newCustomer) => {
            const orderId = createCustomerOrderId;
            setCreateCustomerOrderId(null);
            setCreateCustomerSearch('');
            await handleLinkCustomer(orderId, String(newCustomer.id));
          }}
        />
      )}
      {ConfirmDialog}
    </div>
  );
}
