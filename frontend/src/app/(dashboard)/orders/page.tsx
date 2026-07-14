'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { CreditCard, Trash2, RotateCcw, Clock, MessageCircle, Printer, XCircle, Lock, Percent, DollarSign, Search, Plus, ChevronDown, ChevronRight, UserPlus, User, ShoppingBag } from 'lucide-react';
import toast from 'react-hot-toast';
import PaymentModal from '@/components/pos/PaymentModal';
import { shareBillViaWhatsApp } from '@/lib/whatsapp-share';
import { useConfirm } from '@/hooks/use-confirm';
import type { OrderItem, Table, Product, Customer } from '@/lib/types';
import type { Order, Bill } from '@/lib/types';
import { getCurrencySymbol } from '@/lib/countries';
import { usePrinterStore } from '@/hooks/usePrinter';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useRouter } from 'next/navigation';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useI18n } from '@/hooks/useI18n';

const itemStatusConfig: Record<string, { dot: string; color: string; labelKey: string }> = {
  pending: { dot: 'bg-yellow-400', color: 'text-yellow-700', labelKey: 'orders.itemStatusWaiting' },
  preparing: { dot: 'bg-blue-500', color: 'text-blue-700', labelKey: 'orders.itemStatusPreparing' },
  ready: { dot: 'bg-green-500', color: 'text-green-700', labelKey: 'orders.itemStatusReady' },
  served: { dot: 'bg-purple-500', color: 'text-purple-700', labelKey: 'orders.itemStatusServed' },
  cancelled: { dot: 'bg-red-400', color: 'text-red-500', labelKey: 'orders.itemStatusCancelled' },
};

const orderStatusBadge: Record<string, { bg: string; text: string; labelKey: string }> = {
  pending: { bg: 'bg-yellow-100', text: 'text-yellow-700', labelKey: 'orders.pending' },
  preparing: { bg: 'bg-blue-100', text: 'text-blue-700', labelKey: 'orders.preparing' },
  ready: { bg: 'bg-green-100', text: 'text-green-700', labelKey: 'orders.ready' },
  served: { bg: 'bg-purple-100', text: 'text-purple-700', labelKey: 'orders.served' },
  completed: { bg: 'bg-gray-100', text: 'text-gray-600', labelKey: 'orders.completed' },
  cancelled: { bg: 'bg-red-100', text: 'text-red-700', labelKey: 'orders.cancelled' },
};

const paymentStatusBadge: Record<string, { bg: string; text: string; labelKey: string }> = {
  paid: { bg: 'bg-green-100', text: 'text-green-700', labelKey: 'orders.paid' },
  partial: { bg: 'bg-amber-100', text: 'text-amber-700', labelKey: 'orders.partiallyPaid' },
  unpaid: { bg: 'bg-red-100', text: 'text-red-700', labelKey: 'orders.unpaidBadge' },
};

const orderTypeLabel: Record<string, string> = {
  dine_in: 'orders.dineIn',
  takeaway: 'orders.takeaway',
  delivery: 'orders.delivery',
};

type FilterType = 'all' | 'active' | 'unpaid' | 'held';

const tabLabelKey: Record<FilterType, string> = {
  all: 'orders.all',
  active: 'orders.active',
  unpaid: 'orders.unpaidBadge',
  held: 'orders.held',
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

interface DiscountModal {
  order: Order;
  type: 'percentage' | 'amount';
  value: number;
  reason: string;
}

export default function OrdersPage() {
  const { currentTenant } = useAuthStore();
  const { printBill } = usePrinterStore();
  const heldOrdersStore = useHeldOrdersStore();
  const router = useRouter();
  const cartStore = useCartStore();
  const { setTablesRequired, autoPrintBill } = usePosSettingsStore();
  const { t } = useI18n();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [tabFilter, setTabFilter] = useState<FilterType>('active');
  const [paymentBill, setPaymentBill] = useState<Bill | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const { confirm, ConfirmDialog } = useConfirm();

  // Consolidated filter state
  const [filters, setFilters] = useState<Filters>({ search: '', table: '', type: '', status: '' });

  // Consolidated cancel modal state
  const [cancelModal, setCancelModal] = useState<CancelModal | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<number | null>(null);
  const [convertingOrderId, setConvertingOrderId] = useState<number | null>(null);

  // Consolidated discount modal state
  const [discountModal, setDiscountModal] = useState<DiscountModal | null>(null);
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');

  // Print states
  const [generatingBill, setGeneratingBill] = useState<number | null>(null);
  const [printingBillId, setPrintingBillId] = useState<number | null>(null);
  const [confirmPrintBillId, setConfirmPrintBillId] = useState<number | null>(null);

  // Other states
  const [addItemsOrder, setAddItemsOrder] = useState<Order | null>(null);
  const [printHistoryExpanded, setPrintHistoryExpanded] = useState<Record<number, boolean>>({});
  const [printHistory, setPrintHistory] = useState<Record<number, { id: number; print_type: string; user_name: string; printed_at: string }[]>>({});
  const fetchedBillIdsRef = useRef<Set<number>>(new Set());

  // Add Item modal states
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [selectedItems, setSelectedItems] = useState<{ product_id: number; product_name: string; quantity: number; special_instructions: string }[]>([]);
  const [addingItems, setAddingItems] = useState(false);

  // Link Customer states
  const [linkCustomerOrderId, setLinkCustomerOrderId] = useState<number | null>(null);
  const [linkCustomerSearch, setLinkCustomerSearch] = useState('');
  const [linkCustomerResults, setLinkCustomerResults] = useState<Customer[]>([]);
  const [linkingCustomer, setLinkingCustomer] = useState(false);
  const linkSearchRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const currency = getCurrencySymbol(currentTenant?.currency || 'INR');
  const isOwnerOrManager = currentTenant?.role === 'owner' || currentTenant?.role === 'manager';

  const fetchOrders = async () => {
    try {
      const { data } = await api.get('/orders', { params: { per_page: 50 } });
      const orders = data.orders || [];
      setOrders(orders);
      // Fetch print history only for bills we haven't fetched yet
      orders.forEach((order: Order) => {
        if (order.bill?.id && !fetchedBillIdsRef.current.has(order.bill.id)) {
          fetchedBillIdsRef.current.add(order.bill.id);
          fetchPrintHistory(order.bill.id);
        }
      });
    } catch {
      toast.error(t('orders.loadOrdersFailed'));
    } finally {
      setLoading(false);
    }
  };

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
        .then((res) => setDiscountRequiresApproval(!!res.data.discount_requires_approval))
        .catch(() => {});
    };

    initPage();

    // 10-second backup polling interval (WebSocket handles real-time updates)
    const interval = setInterval(fetchOrders, 10000);

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
              fetchOrders();
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
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
     
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTablesRequired]);

  const fetchPrintHistory = async (billId: number) => {
    try {
      const { data } = await api.get(`/bills/${billId}/print-history`);
      setPrintHistory(prev => ({ ...prev, [billId]: data.prints || [] }));
    } catch {
      // Ignore error
    }
  };

  const isOrderPaid = (order: Order) => order.bill?.payment_status === 'paid';

  const paymentStatusOf = (order: Order): 'paid' | 'partial' | 'unpaid' | null => {
    if (order.status === 'cancelled') return null;
    if (order.bill?.payment_status === 'paid') return 'paid';
    if (order.bill?.payment_status === 'partial') return 'partial';
    return 'unpaid';
  };

  const getTimeSince = (dateStr: string) => {
    const minutes = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
    if (minutes < 1) return t('common.justNow');
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
  };

  const handleCreateNewOrderForCustomer = async (order: Order) => {
    if (!order.customer) return;

    // Check for active POS cart items to avoid accidental loss of progress
    if (cartStore.items.length > 0) {
      const proceed = await confirm(
        t('orders.cartClearConfirm')
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
    toast.success(t('orders.newOrderStarted', { name: order.customer.name }));
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
      toast.success(t('orders.customerLinked'));
      setLinkCustomerOrderId(null);
      setLinkCustomerSearch('');
      setLinkCustomerResults([]);
      fetchOrders();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      toast.error(error.response?.data?.error || t('orders.linkCustomerFailed'));
    } finally {
      setLinkingCustomer(false);
    }
  };

  const filteredOrders = orders.filter((order) => {
    // Tab filter
    if (tabFilter === 'active' && ['completed', 'cancelled'].includes(order.status)) return false;
    if (tabFilter === 'unpaid' && !(order.bill && order.bill.payment_status !== 'paid')) return false;

    // Search by order number
    if (filters.search && !order.order_number.toLowerCase().includes(filters.search.toLowerCase())) {
      return false;
    }
    // Filter by table
    if (filters.table && String(order.table_id) !== filters.table) {
      return false;
    }
    // Filter by type
    if (filters.type && order.type !== filters.type) {
      return false;
    }
    // Filter by status
    if (filters.status === 'active' && ['completed', 'cancelled'].includes(order.status)) {
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

  const handleCheckout = async (orderId: number) => {
    setGeneratingBill(orderId);
    try {
      const { data } = await api.post('/bills/generate', { order_id: orderId });
      setPaymentBill(data.bill);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { message?: string } } };
      toast.error(error.response?.data?.message || t('orders.generateBillFailed'));
    } finally {
      setGeneratingBill(null);
    }
  };

  const handlePaymentComplete = async () => {
    const bill = paymentBill; // capture before clearing state
    setPaymentBill(null);
    fetchOrders();

    if (bill && autoPrintBill) {
      const order = orders.find((o) => o.bill?.id === bill.id);
      if (order) {
        try {
          const { data } = await api.get(`/bills/${bill.id}`);
          const latestBill = data.bill as Bill;
          await printBill(
            { ...latestBill, order },
            { business_name: currentTenant?.business_name || t('common.businessNameFallback'), currency: currentTenant?.currency || 'INR' },
            { isReprint: false }
          );
          await api.post(`/bills/${bill.id}/print`, { print_type: 'receipt' });
        } catch {
          toast.error(t('orders.receiptPrintFailedHint'));
        }
      }
    }
  };

  const handlePrint = async (billId: number) => {
    const order = orders.find((o) => o.bill?.id === billId);
    if (!order?.bill) {
      toast.error(t('orders.billNotFound'));
      return;
    }
    const isReprint = (printHistory[billId]?.length ?? 0) > 0;
    setPrintingBillId(billId);
    try {
      // Actually attempt the print first — only log/report success if the printer accepted the job,
      // otherwise a disconnected printer would silently report "success" (it was only logging before).
      await printBill(
        { ...order.bill, order },
        { business_name: currentTenant?.business_name || t('common.businessNameFallback'), currency: currentTenant?.currency || 'INR' },
        { isReprint }
      );
      await api.post(`/bills/${billId}/print`, { print_type: isReprint ? 'reprint' : 'receipt' });
      toast.success(isReprint ? t('orders.printReceiptReprint') : t('orders.printReceipt'));
      fetchPrintHistory(billId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'check printer connection';
      toast.error(`${t('orders.printReceiptFailed')}: ${msg}`);
    } finally {
      setPrintingBillId(null);
      setConfirmPrintBillId(null);
    }
  };

  const deleteItem = async (orderId: number, itemId: number) => {
    if (!isOwnerOrManager) {
      toast.error(t('orders.onlyOwnersRemove'));
      return;
    }
    if (!await confirm(t('orders.removeItemConfirm'), { destructive: true, confirmLabel: t('common.remove') })) return;
    try {
      await api.patch(`/orders/${orderId}/items/${itemId}/cancel`, { reason: t('orders.removedByManager') });
      toast.success(t('orders.itemRemoved'));
      fetchOrders();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('orders.removeItemFailed'));
    }
  };

  const restoreItem = async (orderId: number, itemId: number) => {
    if (!isOwnerOrManager) return;
    try {
      await api.patch(`/orders/${orderId}/items/${itemId}/restore`);
      toast.success(t('orders.itemRestored'));
      fetchOrders();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('orders.restoreItemFailed'));
    }
  };

  const handleWhatsAppShare = (order: Order) => {
    if (!order.bill) {
      toast.error(t('orders.billNotFound'));
      return;
    }
    if (!order.customer?.phone) {
      toast.error(t('orders.customerPhoneMissing'));
      return;
    }

    try {
      shareBillViaWhatsApp(
        order.bill,
        { phone: order.customer.phone, country_code: order.customer.country_code },
        { business_name: currentTenant?.business_name || t('common.businessNameFallback'), currency: currentTenant?.currency || 'INR' }
      );
    } catch {
      toast.error(t('orders.whatsappFailed'));
    }
  };

  const handleApplyDiscount = async () => {
    if (!discountModal) return;

    // Check if PIN is required
    if (discountRequiresApproval && discountModal.value > 0 && !discountPin) {
      toast.error(t('orders.managerPinRequired'));
      return;
    }

    try {
      await api.patch(`/orders/${discountModal.order.id}/discount`, {
        discount_type: discountModal.type,
        discount_value: discountModal.value,
        discount_reason: discountModal.reason || undefined,
        override_pin: discountRequiresApproval && discountModal.value > 0 ? discountPin : undefined,
      });
      toast.success(t('orders.discountApplied'));
      fetchOrders();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('orders.discountFailed'));
    } finally {
      setDiscountModal(null);
    }
  };

  const showCheckout = (order: Order) => {
    return !isOrderPaid(order) && !['completed', 'cancelled'].includes(order.status);
  };

  const handleConvertToTakeaway = async (order: Order) => {
    const tableNote = order.table ? t('orders.freeTableSuffix', { name: order.table.name }) : '';
    if (!await confirm(t('orders.convertToTakeawayConfirm', { number: order.order_number, tableNote }))) return;
    setConvertingOrderId(order.id);
    try {
      await api.patch(`/orders/${order.id}/convert-to-takeaway`);
      toast.success(t('orders.orderConvertedTakeaway'));
      fetchOrders();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('orders.convertOrderFailed'));
    } finally {
      setConvertingOrderId(null);
    }
  };

  // Add Item modal: fetch products when modal opens
  useEffect(() => {
    if (!addItemsOrder) return;
    const fetchProducts = async () => {
      try {
        const { data } = await api.get('/products', { params: { per_page: 200 } });
        setProducts(data.products || []);
      } catch {
        toast.error(t('orders.menuLoadFailed'));
      }
    };
    fetchProducts();
    setSelectedItems([]);
    setProductSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addItemsOrder]);

  const handleAddItemToSelection = (product: Product) => {
    setSelectedItems(prev => {
      const existing = prev.find(i => i.product_id === product.id);
      if (existing) {
        return prev.map(i => i.product_id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, { product_id: product.id, product_name: product.name, quantity: 1, special_instructions: '' }];
    });
  };

  const handleRemoveFromSelection = (productId: number) => {
    setSelectedItems(prev => prev.filter(i => i.product_id !== productId));
  };

  const handleUpdateSelectionQty = (productId: number, quantity: number) => {
    if (quantity < 1) return;
    setSelectedItems(prev => prev.map(i => i.product_id === productId ? { ...i, quantity } : i));
  };

  const handleUpdateSelectionNotes = (productId: number, notes: string) => {
    setSelectedItems(prev => prev.map(i => i.product_id === productId ? { ...i, special_instructions: notes } : i));
  };

  const handleSubmitAddItems = async () => {
    if (!addItemsOrder || selectedItems.length === 0) return;
    setAddingItems(true);
    try {
      await api.post(`/orders/${addItemsOrder.id}/items`, {
        items: selectedItems.map(i => ({
          product_id: i.product_id,
          quantity: i.quantity,
          special_instructions: i.special_instructions || undefined,
        })),
      });
      toast.success(t('orders.itemsAdded', { count: selectedItems.length }));
      setAddItemsOrder(null);
      fetchOrders();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('orders.addItemsFailed'));
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
      toast.success(t('orders.orderCancelled'));
      fetchOrders();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('orders.cancelOrderFailed'));
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
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('nav.orders')}</h1>
        <div className="flex gap-2">
          {(['all', 'active', 'unpaid', 'held'] as FilterType[]).map((f) => (
            <button
              key={f}
              onClick={() => setTabFilter(f)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium ${
                tabFilter === f
                  ? 'bg-brand text-white'
                  : 'bg-white text-gray-600 border border-gray-200 hover:border-gray-400'
              }`}
            >
              {t(tabLabelKey[f])}
            </button>
          ))}
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Search by order number */}
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder={t('orders.search')}
            value={filters.search}
            onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
            className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand bg-white"
          />
        </div>

        {/* Table filter */}
        <select
          value={filters.table}
          onChange={(e) => setFilters(prev => ({ ...prev, table: e.target.value }))}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
        >
          <option value="">{t('orders.allTables')}</option>
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
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
        >
          <option value="">{t('orders.allTypes')}</option>
          <option value="dine_in">{t('orders.dineIn')}</option>
          <option value="takeaway">{t('orders.takeaway')}</option>
          <option value="delivery">{t('orders.delivery')}</option>
          <option value="online">{t('orders.online')}</option>
        </select>

        {/* Status filter */}
        <select
          value={filters.status}
          onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
        >
          <option value="">{t('orders.allStatuses')}</option>
          <option value="active">{t('orders.active')}</option>
          <option value="completed">{t('orders.completed')}</option>
          <option value="cancelled">{t('orders.cancelled')}</option>
        </select>
      </div>

      {/* Orders List */}
      {tabFilter === 'held' ? (
        loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        ) : Object.keys(heldOrdersStore.orders).length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-gray-400">
            <p>{t('orders.heldEmpty')}</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 content-start items-start auto-rows-max">
            {Object.values(heldOrdersStore.orders).map((heldOrder) => (
              <div key={heldOrder.tableId} className="bg-white rounded-xl border border-blue-200 overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-shadow">
                 <div className="p-4 border-b border-gray-100 bg-blue-50/50 flex justify-between items-center">
                   <div>
                     <p className="font-bold text-gray-900">{tables.find(t => t.id === heldOrder.tableId)?.name || t('common.tableFallback')}</p>
                     <p className="text-xs text-gray-500">{new Date(heldOrder.heldAt).toLocaleTimeString()}</p>
                   </div>
                   <span className="bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full font-bold tracking-wide">{t('orders.held')}</span>
                 </div>
                 <div className="p-4 flex-1">
                   {heldOrder.items.map((item, idx) => (
                     <div key={idx} className="flex justify-between text-sm py-1 text-gray-700">
                       <span>{item.quantity}x {item.product.name}</span>
                     </div>
                   ))}
                   {heldOrder.orderNotes && (
                     <div className="mt-3 text-sm italic text-gray-500 bg-gray-50 p-2 rounded-lg">
                       &quot;{heldOrder.orderNotes}&quot;
                     </div>
                   )}
                 </div>
                 <div className="p-4 bg-gray-50 border-t border-gray-100 flex gap-2">
                    <Button onClick={async () => {
                      const held = await heldOrdersStore.restoreOrder(heldOrder.tableId);
                      if (held) {
                        cartStore.loadItems(held.items, heldOrder.tableId, held.customerId, held.guestCount, held.orderNotes);
                        cartStore.setOrderType('dine_in');
                        router.push('/pos');
                      } else {
                        toast.error(t('orders.resumeFailed'));
                      }
                    }} variant="default" className="flex-1 bg-brand hover:bg-brand/90 text-white">{t('orders.resumeInPos')}</Button>
                    <Button onClick={async () => {
                      if (await confirm(t('orders.deleteHeldConfirm'), { destructive: true })) {
                        try {
                          await heldOrdersStore.removeHeldOrder(heldOrder.tableId);
                          toast.success(t('orders.heldOrderRemoved'));
                        } catch {
                          toast.error(t('orders.removeHeldOrderFailed'));
                        }
                      }
                    }} variant="outline" className="flex-1 text-red-600 hover:text-red-700 hover:bg-red-50">{t('orders.delete')}</Button>
                 </div>
              </div>
            ))}
          </div>
        )
      ) : loading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-gray-400">
          <p>{t('orders.empty')}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 content-start items-start auto-rows-max">
          {filteredOrders.map((order) => {
            const activeItems = (order.items || []).filter((i: OrderItem) => i.status !== 'cancelled');
            const cancelledItems = (order.items || []).filter((i: OrderItem) => i.status === 'cancelled');
            const paid = isOrderPaid(order);
            const payStatus = paymentStatusOf(order);
            const payBadge = payStatus ? paymentStatusBadge[payStatus] : null;
            const bill = order.bill;
            const discount = bill ? Number(bill.discount_amount) : Number(order.discount_amount);
            const tax = bill ? Number(bill.tax_amount) : Number(order.tax_amount);
            const subtotal = bill ? Number(bill.subtotal) : Number(order.subtotal);
            const total = bill ? Number(bill.total) : Number(order.total);

            return (
              <div
                key={order.id}
                className={`bg-white rounded-xl border overflow-hidden flex flex-col ${
                  order.status === 'cancelled' ? 'border-red-200 opacity-75' : 'border-gray-100'
                }`}
              >
                {/* Top bar: order id/status on the left, payment badge + reprint on the right */}
                <div className="flex items-center justify-between gap-2 px-4 py-3 bg-gray-50 border-b border-gray-100">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="font-bold text-gray-900">#{order.order_number}</span>
                    {(() => { const badge = orderStatusBadge[order.status]; return badge ? (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.text}`}>{t(badge.labelKey)}</span>
                    ) : null; })()}
                    <span className="text-sm text-gray-500 capitalize">{t(orderTypeLabel[order.type] ?? order.type)}</span>
                    {order.table && (
                      <span className="text-sm text-orange-600 font-medium">{order.table.name}</span>
                    )}
                    <span className="flex items-center gap-1 text-xs text-gray-400">
                      <Clock size={12} />
                      {getTimeSince(order.created_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {payBadge && (
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${payBadge.bg} ${payBadge.text}`}>
                        {t(payBadge.labelKey)}
                      </span>
                    )}
                    {paid && order.customer?.phone && (
                      <button
                        onClick={() => handleWhatsAppShare(order)}
                        className="p-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white transition-colors"
                        title={t('common.shareViaWhatsApp')}
                      >
                        <MessageCircle size={14} />
                      </button>
                    )}
                    {order.bill && (
                      <button
                        onClick={() => setConfirmPrintBillId(order.bill!.id)}
                        disabled={printingBillId === order.bill.id}
                        className="p-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-100 disabled:opacity-50 transition-colors"
                        title={(printHistory[order.bill.id]?.length ?? 0) > 0 ? t('common.reprint') : t('common.print')}
                      >
                        <Printer size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Order notes */}
                {order.special_instructions && (
                  <div className="px-4 py-2 bg-amber-50 border-b border-amber-100">
                    <p className="text-sm text-amber-700 font-medium break-words">
                      📝 {order.special_instructions}
                    </p>
                  </div>
                )}

                {/* Customer info strip */}
                {order.customer ? (
                  <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <User size={14} className="text-blue-600 shrink-0" />
                      <span className="text-sm font-medium text-blue-800 truncate">{order.customer.name}</span>
                      {order.customer.phone && (
                        <span className="text-xs text-blue-600 shrink-0">{order.customer.phone}</span>
                      )}
                    </div>
                    <button
                      onClick={() => handleCreateNewOrderForCustomer(order)}
                      className="flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900 bg-blue-100 hover:bg-blue-200 px-2.5 py-1 rounded-lg transition-colors shrink-0"
                      title={t('orders.startNewOrderForCustomer')}
                    >
                      <Plus size={12} /> {t('orders.newOrder')}
                    </button>
                  </div>
                ) : isOwnerOrManager && !['completed', 'cancelled'].includes(order.status) ? (
                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-100">
                    {linkCustomerOrderId === order.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={linkCustomerSearch}
                          onChange={(e) => {
                            setLinkCustomerSearch(e.target.value);
                            searchCustomersForLink(e.target.value);
                          }}
                          placeholder={t('orders.searchCustomer')}
                          className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                          autoFocus
                        />
                        <button
                          onClick={() => {
                            setLinkCustomerOrderId(null);
                            setLinkCustomerSearch('');
                            setLinkCustomerResults([]);
                          }}
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <XCircle size={16} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setLinkCustomerOrderId(order.id)}
                        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 transition-colors"
                      >
                        <UserPlus size={14} />
                        {t('orders.linkCustomer')}
                      </button>
                    )}
                    {linkCustomerOrderId === order.id && linkCustomerResults.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {linkCustomerResults.map((customer) => (
                          <button
                            key={customer.id}
                            onClick={() => handleLinkCustomer(order.id, String(customer.id))}
                            disabled={linkingCustomer}
                            className="w-full flex items-center justify-between px-3 py-2 bg-white rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors text-left disabled:opacity-50"
                          >
                            <div>
                              <span className="text-sm font-medium text-gray-900">{customer.name}</span>
                              {customer.phone && (
                                <span className="text-xs text-gray-500 ml-2">{customer.phone}</span>
                              )}
                            </div>
                            {linkingCustomer && <span className="text-xs text-gray-400">{t('orders.linking')}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}

                {/* Items — presented like a bill */}
                <div className="px-4 py-3 flex-1">
                  <div className="divide-y divide-gray-50">
                    {activeItems.map((item: OrderItem) => {
                      const config = itemStatusConfig[item.status] || itemStatusConfig.pending;
                      return (
                        <div key={item.id} className="py-1.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span className={`w-2 h-2 rounded-full shrink-0 ${config.dot}`} title={t(config.labelKey)} />
                              <span className={`text-sm font-medium ${config.color}`}>
                                {item.quantity}x
                              </span>
                              <span className="text-sm text-gray-900 truncate">{item.product_name}</span>
                              {item.special_instructions && (
                                <span className="text-xs text-red-500 italic break-words">&quot;{item.special_instructions}&quot;</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-gray-600">{currency}{Number(item.total).toLocaleString()}</span>
                              {item.status === 'pending' && isOwnerOrManager && !paid && (
                                <button
                                  onClick={() => deleteItem(order.id, item.id)}
                                  className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors"
                                  title={t('common.removeItem')}
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </div>
                          </div>
                          {item.addons && item.addons.length > 0 && (
                            <div className="pl-4 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                              {item.addons.map((addon, idx) => (
                                <span key={addon.id ?? `${item.id}-${idx}`} className="text-xs text-gray-400">
                                  + {addon.name}{addon.price ? ` (${currency}${Number(addon.price).toLocaleString()})` : ''}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Bill summary */}
                  <div className="mt-3 pt-3 border-t border-dashed border-gray-200 space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">{t('common.subtotal')}</span>
                      <span className="text-gray-700">{currency}{subtotal.toLocaleString()}</span>
                    </div>
                    {discount > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-purple-600">{t('common.discount')}</span>
                        <span className="text-purple-600">-{currency}{discount.toLocaleString()}</span>
                      </div>
                    )}
                    {tax > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">{t('common.tax')}</span>
                        <span className="text-gray-700">{currency}{tax.toLocaleString()}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-base font-bold pt-1 border-t border-gray-100">
                      <span className="text-gray-900">{t('common.total')}</span>
                      <span className="text-gray-900">{currency}{total.toLocaleString()}</span>
                    </div>
                    {bill && payStatus === 'partial' && (
                      <div className="flex justify-between text-xs text-gray-500 pt-0.5">
                        <span>{t('orders.paid')} {currency}{Number(bill.paid_amount).toLocaleString()}</span>
                        <span>{t('orders.balance')} {currency}{Number(bill.balance).toLocaleString()}</span>
                      </div>
                    )}
                  </div>

                  {/* Cancelled items */}
                  {cancelledItems.length > 0 && isOwnerOrManager && (
                    <div className="mt-2 pt-2 border-t border-gray-50">
                      {cancelledItems.map((item: OrderItem) => (
                        <div key={item.id} className="flex items-center justify-between py-1 opacity-50">
                          <div className="flex items-center gap-2">
                            <span className="text-xs">❌</span>
                            <span className="text-xs text-gray-400 line-through">
                              {item.quantity}x {item.product_name}
                            </span>
                          </div>
                          {!paid && order.status !== 'completed' && order.status !== 'cancelled' && (
                            <button
                              onClick={() => restoreItem(order.id, item.id)}
                              className="p-1 rounded hover:bg-green-50 text-green-400 hover:text-green-600"
                              title={t('common.restore')}
                            >
                              <RotateCcw size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {t('orders.printHistory')}
                  {order.bill && printHistory[order.bill.id]?.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-100">
                      <button
                        onClick={() => {
                          setPrintHistoryExpanded(prev => ({ ...prev, [order.bill!.id]: !prev[order.bill!.id] }));
                        }}
                        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
                      >
                        {printHistoryExpanded[order.bill!.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {t('orders.printHistory')}
                      </button>

                      {printHistoryExpanded[order.bill!.id] && (
                        <div className="mt-2 pl-4 space-y-1">
                          {printHistory[order.bill!.id].map((print, index) => (
                            <div key={print.id} className="text-xs text-gray-500">
                              {index + 1}. {t('orders.printHistoryEntry', { printedType: print.print_type === 'reprint' ? t('orders.reprint') : t('orders.printed'), user: print.user_name, time: new Date(print.printed_at).toLocaleString() })}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Footer with actions */}
                <div className="px-4 py-3 border-t border-gray-100 flex flex-wrap gap-2">
                    {showCheckout(order) && (
                      <Button
                        onClick={() => handleCheckout(order.id)}
                        disabled={generatingBill === order.id}
                        size="sm"
                        className="flex-1 justify-center"
                      >
                        <CreditCard size={14} className="mr-1.5" />
                        {generatingBill === order.id ? t('orders.generating') : t('orders.checkout')}
                      </Button>
                    )}
                    {!['completed', 'cancelled'].includes(order.status) && (
                      <Button
                        variant="outline"
                        onClick={() => setAddItemsOrder(order)}
                        size="sm"
                        className="flex-1 justify-center border-green-300 text-green-600 hover:bg-green-50 hover:text-green-700"
                      >
                        <Plus size={14} className="mr-1.5" />
                        Add Item
                      </Button>
                    )}
                    {order.type === 'dine_in' && !['completed', 'cancelled'].includes(order.status) && (
                      <Button
                        variant="outline"
                        onClick={() => handleConvertToTakeaway(order)}
                        disabled={convertingOrderId === order.id}
                        size="sm"
                        className="flex-1 justify-center border-blue-300 text-blue-600 hover:bg-blue-50 hover:text-blue-700"
                      >
                        <ShoppingBag size={14} className="mr-1.5" />
                        {convertingOrderId === order.id ? t('orders.converting') : t('orders.convertToTakeaway')}
                      </Button>
                    )}
                    {!['completed', 'cancelled'].includes(order.status) && (
                      <Button
                        variant="outline"
                        onClick={() => setCancelModal({ order, reason: '', freeTable: true, overridePin: '' })}
                        disabled={cancellingOrderId === order.id}
                        size="sm"
                        className={`flex-1 justify-center ${
                          order.status === 'pending'
                            ? 'border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700'
                            : 'border-orange-300 text-orange-600 hover:bg-orange-50 hover:text-orange-700'
                        }`}
                      >
                        {order.status === 'pending' ? (
                          <XCircle size={14} className="mr-1.5" />
                        ) : (
                          <Lock size={14} className="mr-1.5" />
                        )}
                        {cancellingOrderId === order.id ? t('orders.cancelling') : t('common.cancel')}
                      </Button>
                    )}
                  </div>
              </div>
            );
          })}
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

      {/* Print Confirmation Modal */}
      {confirmPrintBillId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-bold text-gray-900 mb-2">
              {(printHistory[confirmPrintBillId]?.length ?? 0) > 0 ? t('orders.reprintReceiptTitle') : t('orders.printReceiptTitle')}
            </h2>
            <p className="text-sm text-gray-600 mb-6">
              {(printHistory[confirmPrintBillId]?.length ?? 0) > 0
                ? t('orders.reprintReceiptWarning')
                : t('orders.printReceiptConfirm')}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmPrintBillId(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => handlePrint(confirmPrintBillId)}
                disabled={printingBillId === confirmPrintBillId}
              >
                <Printer size={14} className="mr-1.5" />
                {printingBillId === confirmPrintBillId
                  ? t('orders.printing')
                  : (printHistory[confirmPrintBillId]?.length ?? 0) > 0
                    ? t('orders.confirmReprint')
                    : t('orders.confirmPrint')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Order Modal */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-bold text-gray-900 mb-4">{t('orders.cancel')} #{cancelModal.order.order_number}</h2>

            <div className="space-y-4">
              <div>
                <label htmlFor="cancelReason" className="block text-sm font-medium text-gray-700 mb-1">
                  {t('common.reasonOptional')}
                </label>
                <input
                  id="cancelReason"
                  type="text"
                  value={cancelModal.reason}
                  onChange={(e) => updateCancelModal({ reason: e.target.value })}
                  placeholder={t('orders.cancelReason')}
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
                  <label htmlFor="freeTable" className="text-sm text-gray-700">
                    {t('orders.freeTable', { name: cancelModal.order.table.name })}
                  </label>
                </div>
              )}

              {cancelModal.order.status !== 'pending' && (
                <div>
                  <label htmlFor="overridePin" className="block text-sm font-medium text-gray-700 mb-1">
                    {t('orders.overridePinLabel')}
                  </label>
                  <input
                    id="overridePin"
                    type="password"
                    value={cancelModal.overridePin}
                    onChange={(e) => updateCancelModal({ overridePin: e.target.value })}
placeholder={t('orders.managerPin')}
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
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleCancelOrder}
                disabled={cancellingOrderId === cancelModal.order.id}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {cancellingOrderId === cancelModal.order.id ? t('orders.cancelling') : t('orders.confirmCancel')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Discount Modal */}
      {discountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-bold text-gray-900 mb-4">{t('orders.applyDiscountTitle', { number: discountModal.order.order_number })}</h2>

            <div className="space-y-4">
              {/* Discount Type Toggle */}
              <div className="flex rounded-lg overflow-hidden border border-gray-200">
                <button
                  onClick={() => updateDiscountModal({ type: 'percentage', value: 0 })}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
                    discountModal.type === 'percentage'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <Percent size={14} />
                  {t('common.percentage')}
                </button>
                <button
                  onClick={() => updateDiscountModal({ type: 'amount', value: 0 })}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
                    discountModal.type === 'amount'
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <DollarSign size={14} />
                  {t('common.amount')}
                </button>
              </div>

              {/* Discount Value */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {discountModal.type === 'percentage' ? t('orders.discountPercentageLabel') : t('orders.discountAmountLabel')}
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                    {discountModal.type === 'percentage' ? '%' : currency}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={discountModal.type === 'percentage' ? 100 : Number(discountModal.order.total)}
                    step={discountModal.type === 'percentage' ? 1 : 0.01}
                    value={discountModal.value || ''}
                    onChange={(e) => updateDiscountModal({ value: Number(e.target.value) })}
                    placeholder={discountModal.type === 'percentage' ? '0' : '0.00'}
                    className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                </div>
              </div>

              {/* Discount Reason */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reason (optional)
                </label>
                <input
                  type="text"
                  value={discountModal.reason}
                  onChange={(e) => updateDiscountModal({ reason: e.target.value })}
                  placeholder={t('orders.discountReason')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>

              {/* Preview */}
              <div className="bg-gray-50 rounded-lg p-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('common.subtotal')}</span>
                  <span className="text-gray-900">{currency}{Number(discountModal.order.subtotal).toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t('common.tax')}</span>
                  <span className="text-gray-900">{currency}{Number(discountModal.order.tax_amount || 0).toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-purple-600">
                    {t('common.discount')}
                    {discountModal.type === 'percentage' && discountModal.value > 0 && (
                      <span className="text-gray-400 ml-1">{t('orders.percentOnSubtotal', { value: discountModal.value })}</span>
                    )}
                  </span>
                  <span className="text-purple-600">
                    -{currency}{
                      discountModal.type === 'percentage'
                        ? (Number(discountModal.order.subtotal) * discountModal.value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : Number(discountModal.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    }
                  </span>
                </div>
                <div className="border-t border-gray-200 pt-1.5 flex justify-between text-sm font-bold">
                  <span className="text-gray-900">{t('orders.newTotal')}</span>
                  <span className="text-gray-900">
                    {currency}{
                      discountModal.type === 'percentage'
                        ? (Number(discountModal.order.subtotal) * (1 - discountModal.value / 100) + Number(discountModal.order.tax_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : (Number(discountModal.order.subtotal) - Number(discountModal.value) + Number(discountModal.order.tax_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    }
                  </span>
                </div>
              </div>
            </div>

            {discountRequiresApproval && discountModal.value > 0 && (
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('orders.managerPinLabel')}</label>
                <input
                  type="password"
                  value={discountPin}
                  onChange={(e) => setDiscountPin(e.target.value)}
placeholder={t('orders.managerPin')}
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
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleApplyDiscount}
                disabled={discountModal.value <= 0}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                <Percent size={14} className="mr-1.5" />
                {t('orders.applyDiscount')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Item Modal */}
      {addItemsOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
            <h2 className="text-lg font-bold text-gray-900 mb-4">{t('orders.addItems')} #{addItemsOrder.order_number}</h2>

            {/* Search */}
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder={t('orders.searchMenu')}
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              />
            </div>

            {/* Product list */}
            <div className="flex-1 overflow-y-auto border border-gray-200 rounded-lg mb-3 max-h-48">
              {products
                .filter(p => !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase()))
                .map((product: Product) => (
                  <button
                    key={product.id}
                    onClick={() => handleAddItemToSelection(product)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-green-50 text-left border-b border-gray-50 last:border-0 transition-colors"
                  >
                    <div>
                      <span className="text-sm font-medium text-gray-900">{product.name}</span>
                      {product.price && (
                        <span className="text-xs text-gray-500 ml-2">{currency}{Number(product.price).toLocaleString()}</span>
                      )}
                    </div>
                    <Plus size={14} className="text-green-500" />
                  </button>
                ))
              }
              {products.filter(p => !productSearch || p.name.toLowerCase().includes(productSearch.toLowerCase())).length === 0 && (
                <div className="px-3 py-4 text-sm text-gray-400 text-center">{t('orders.noItemsFound')}</div>
              )}
            </div>

            {/* Selected items */}
            {selectedItems.length > 0 && (
              <div className="space-y-2 mb-3">
                <p className="text-xs font-medium text-gray-500 uppercase">{t('orders.selectedItems')}</p>
                {selectedItems.map(item => (
                  <div key={item.product_id} className="flex items-center gap-2 bg-gray-50 rounded-lg p-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-gray-900 truncate block">{item.product_name}</span>
                      <input
                        type="text"
                        placeholder={t('orders.notesOptional')}
                        value={item.special_instructions}
                        maxLength={100}
                        onChange={(e) => handleUpdateSelectionNotes(item.product_id, e.target.value.slice(0, 100))}
                        className="w-full text-xs text-gray-500 bg-transparent border-0 p-0 focus:outline-none placeholder:text-gray-300"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleUpdateSelectionQty(item.product_id, item.quantity - 1)}
                        className="w-6 h-6 rounded bg-gray-200 text-gray-600 text-xs hover:bg-gray-300"
                      >-</button>
                      <span className="w-6 text-center text-sm font-medium">{item.quantity}</span>
                      <button
                        onClick={() => handleUpdateSelectionQty(item.product_id, item.quantity + 1)}
                        className="w-6 h-6 rounded bg-gray-200 text-gray-600 text-xs hover:bg-gray-300"
                      >+</button>
                    </div>
                    <button
                      onClick={() => handleRemoveFromSelection(item.product_id)}
                      className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAddItemsOrder(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleSubmitAddItems}
                disabled={selectedItems.length === 0 || addingItems}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                <Plus size={14} className="mr-1.5" />
                {addingItems ? t('orders.adding') : t('orders.addItemsCount', { count: selectedItems.length })}
              </Button>
            </div>
          </div>
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
}
