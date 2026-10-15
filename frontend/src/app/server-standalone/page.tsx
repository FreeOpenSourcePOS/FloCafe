'use client';

import axios, { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import {
  Bell,
  CheckCircle2,
  ChefHat,
  Circle,
  Flame,
  LayoutGrid,
  LogOut,
  Minus,
  Plus,
  RefreshCw,
  Send,
  ShoppingCart,
  Smartphone,
  SquarePen,
  Trash2,
  UserRound,
} from 'lucide-react';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { parsePhone } from '@/lib/phone';
import { getLanguageDirection, getLanguageLocale, useSyncServerLanguage } from '@/lib/i18n';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { toastApiError } from '@/lib/api-error';
import { formatCurrencyForTenant } from '@/lib/countries';
import { createPaymentIdempotencyKey } from '@/lib/payment-idempotency';
import { formatItemHeading } from '@/lib/printer/item-heading';
import { usePosSettingsStore } from '@/store/pos-settings';
import { printerService } from '@/lib/printer/PrinterService';
import { generateCartItemId } from '@/lib/cart-identity';
import { productNeedsCustomizer, scannedVariantNeedsCustomizer } from '@/lib/product-variants';
import AddonModal from '@/components/pos/AddonModal';
import ProductGrid from '@/components/pos/ProductGrid';
import type {
  Order as FullOrder,
  Product,
  Addon,
  CartItem,
  Category,
  ProductVariant,
} from '@/lib/types';
import { cartItemToOrderItem } from '@/lib/cart-order-item';

type User = { id: string; name: string; email: string; role: string };
type Table = {
  id: string;
  name?: string;
  number?: string;
  status?: string;
  activeOrder?: Order | null;
  current_order?: Order | null;
};
type OrderItem = {
  id: number;
  product_name: string;
  quantity: number;
  status: string;
  special_instructions?: string | null;
  variant_selection?: unknown;
};
type Order = {
  id: number;
  order_number: string;
  table_id?: string | null;
  status: string;
  items?: OrderItem[];
  customer?: { id: string; name: string; phone?: string } | null;
};
type DraftLine = CartItem;
type ServerAppInfo = {
  country: string;
  currency: string;
  currency_symbol: string;
  currency_position: 'prefix' | 'suffix';
  currency_fraction_digits: number;
};

type ServerAppKey = keyof AppConfig['Messages']['serverApp'];

const TOKEN_KEY = 'flocafe:server-app-token';

function createApi(): AxiosInstance {
  const api = axios.create({ baseURL: window.location.origin, timeout: 10000 });
  api.interceptors.request.use((config) => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
  api.interceptors.response.use(
    (response) => response,
    (error) => {
      const sentAuth = error.config?.headers?.Authorization;
      const currentToken = localStorage.getItem(TOKEN_KEY);
      if (error.response?.status === 401 && currentToken && sentAuth === `Bearer ${currentToken}`) {
        localStorage.removeItem(TOKEN_KEY);
      }
      return Promise.reject(error);
    },
  );
  return api;
}

function itemStatusIcon(status: string, t: (key: ServerAppKey) => string) {
  if (status === 'preparing')
    return (
      <Flame
        size={15}
        className="text-orange-500 dark:text-orange-400"
        aria-label={t('statusPreparing')}
      />
    );
  if (status === 'ready')
    return (
      <Bell
        size={15}
        className="text-emerald-600 dark:text-emerald-400"
        aria-label={t('statusReady')}
      />
    );
  if (status === 'served')
    return (
      <CheckCircle2
        size={15}
        className="text-blue-600 dark:text-blue-400"
        aria-label={t('statusServed')}
      />
    );
  return (
    <Circle
      size={15}
      className="text-gray-400 dark:text-gray-500"
      aria-label={t('statusWaiting')}
    />
  );
}

function money(value: number | string, regional: ServerAppInfo | null) {
  return formatCurrencyForTenant(
    Number(value || 0),
    regional?.country || '',
    regional?.currency || '',
  );
}

type SendSnapshot = {
  tableId: string;
  tableName: string | undefined;
  orderId: number | null;
  orderCustomer: Order['customer'] | null;
  existingItemIds: Set<number>;
  draftLines: DraftLine[];
  customerName: string;
  customerPhone: string;
  orderNotes: string;
};

function sendAttemptSignature(
  tableId: string,
  draft: DraftLine[],
  customerName: string,
  customerPhone: string,
  orderNotes: string,
): string {
  const items = draft.map((line) => `${line.id}:${line.quantity}`).join('|');
  return `${tableId}|${items}|${customerName.trim()}|${customerPhone.trim()}|${orderNotes.trim()}`;
}

export default function ServerStandalonePage() {
  // Syncs tenant language preference from /api/server-app/info.
  useSyncServerLanguage('/api/server-app/info');
  const language = usePosSettingsStore((state) => state.language);
  const t = useTranslations('serverApp');
  const tAuth = useTranslations('auth');
  const tTables = useTranslations('tables');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const tPos = useTranslations('pos');
  const tSettings = useTranslations('settings');

  // Fall back to caller-supplied localized message for server-app errors without dotted error codes.
  const apiErrorT = (key: string): string => key;
  const api = useMemo(() => (typeof window !== 'undefined' ? createApi() : null), []);
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [regional, setRegional] = useState<ServerAppInfo | null>(null);

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [orderLoadedTableId, setOrderLoadedTableId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [orderNotes, setOrderNotes] = useState('');
  const [addonModalProduct, setAddonModalProduct] = useState<Product | null>(null);
  const [addonModalQuantity, setAddonModalQuantity] = useState(1);
  const [addonModalVariant, setAddonModalVariant] = useState<ProductVariant | null>(null);
  const [editingDraftLine, setEditingDraftLine] = useState<DraftLine | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState<Order | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerMatch, setCustomerMatch] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [customerSearched, setCustomerSearched] = useState(false);
  const phoneDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const phoneAbortRef = useRef<AbortController | null>(null);
  const [sending, setSending] = useState(false);
  // Synchronous re-entry guard: `sending` state updates too late to stop a second click fired before the first render.
  const sendInFlightRef = useRef(false);
  // Nonce and frozen target snapshot for the pending send attempt, paired with a signature of what defines it.
  // Reused while retrying that exact same attempt so a lost create response cannot switch to append on retry.
  const sendAttemptRef = useRef<{
    signature: string;
    nonce: string;
    snapshot: SendSnapshot;
  } | null>(null);
  const sendSeqRef = useRef(0);
  const addonModalSendSeqRef = useRef(0);
  const editingDraftSendSeqRef = useRef(0);
  const selectedTableIdRef = useRef('');
  const orderLoadedTableIdRef = useRef('');
  const orderLookupFailedRef = useRef(false);
  const orderLoadSeqRef = useRef(0);

  async function loadAll(options?: { allowWhileSending?: boolean }) {
    if (!api) return;
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    const [categoriesRes, productsRes, tablesRes] = await Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
    ]);
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    setCategories(categoriesRes.data.categories || []);
    setProducts(productsRes.data.products || []);
    const loadedTables = tablesRes.data.tables || [];
    setTables(loadedTables);
    setTablesLoaded(true);
    if (!selectedTableIdRef.current && loadedTables[0]) {
      selectedTableIdRef.current = loadedTables[0].id;
      setSelectedTableId(loadedTables[0].id);
    }
  }

  function cancelPendingCustomerLookup() {
    clearTimeout(phoneDebounceRef.current);
    phoneAbortRef.current?.abort();
  }

  async function loadOrder(tableId: string, options?: { allowWhileSending?: boolean }) {
    if (!api || !tableId) return;
    if (sendInFlightRef.current && !options?.allowWhileSending) return;
    const loadSeq = ++orderLoadSeqRef.current;
    orderLookupFailedRef.current = false;
    if (!options?.allowWhileSending) {
      orderLoadedTableIdRef.current = '';
      setOrderLoadedTableId('');
    }
    cancelPendingCustomerLookup();
    try {
      const res = await api.get('/api/orders', {
        params: {
          table_id: tableId,
          type: 'dine_in',
          status: 'pending,preparing,ready',
          per_page: 1,
        },
      });
      if (
        (sendInFlightRef.current && !options?.allowWhileSending) ||
        loadSeq !== orderLoadSeqRef.current ||
        selectedTableIdRef.current !== tableId
      ) {
        return;
      }
      const order = res.data.orders?.[0] || null;
      setCurrentOrder(order);
      const pendingAttempt =
        sendAttemptRef.current?.snapshot.tableId === tableId
          ? sendAttemptRef.current.snapshot
          : null;
      if (pendingAttempt) {
        setCustomerName(pendingAttempt.customerName);
        setCustomerPhone(pendingAttempt.customerPhone);
      } else if (order?.customer) {
        setCustomerName(order.customer.name || '');
        setCustomerPhone(order.customer.phone || '');
      } else {
        setCustomerName('');
        setCustomerPhone('');
      }
      setCustomerMatch(null);
      setCustomerSearched(false);
      orderLoadedTableIdRef.current = tableId;
      setOrderLoadedTableId(tableId);
    } catch (error) {
      if (
        !options?.allowWhileSending &&
        !sendInFlightRef.current &&
        loadSeq === orderLoadSeqRef.current &&
        selectedTableIdRef.current === tableId
      ) {
        setCurrentOrder(null);
        orderLoadedTableIdRef.current = '';
        setOrderLoadedTableId('');
        orderLookupFailedRef.current = true;
      }
      throw error;
    }
  }

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<ServerAppInfo>('/api/server-app/info')
      .then((infoResponse) => {
        if (!cancelled) setRegional(infoResponse.data);
        return api.get('/api/auth/me');
      })
      .then((res) => {
        if (!cancelled) setUser(res.data.user);
      })
      .catch((error) => {
        if (error.response?.status === 404) setDisabled(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!user || !api) return;
    let cancelled = false;
    Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
    ])
      .then(([categoriesRes, productsRes, tablesRes]) => {
        if (cancelled || sendInFlightRef.current) return;
        setCategories(categoriesRes.data.categories || []);
        setProducts(productsRes.data.products || []);
        const loadedTables = tablesRes.data.tables || [];
        setTables(loadedTables);
        setTablesLoaded(true);
        if (!selectedTableIdRef.current && loadedTables[0]) {
          selectedTableIdRef.current = loadedTables[0].id;
          setSelectedTableId(loadedTables[0].id);
        }
      })
      .catch(() => toast.error(t('couldNotLoadData')));
    return () => {
      cancelled = true;
    };
  }, [api, selectedTableId, user, t]);

  useEffect(() => {
    if (!selectedTableId || !user || !api) return;
    let cancelled = false;
    const loadSeq = ++orderLoadSeqRef.current;
    const targetTableId = selectedTableId;
    orderLookupFailedRef.current = false;
    orderLoadedTableIdRef.current = '';
    cancelPendingCustomerLookup();
    api
      .get('/api/orders', {
        params: {
          table_id: targetTableId,
          type: 'dine_in',
          status: 'pending,preparing,ready',
          per_page: 1,
        },
      })
      .then((res) => {
        if (
          cancelled ||
          sendInFlightRef.current ||
          loadSeq !== orderLoadSeqRef.current ||
          selectedTableIdRef.current !== targetTableId
        ) {
          return;
        }
        const order = res.data.orders?.[0] || null;
        setCurrentOrder(order);
        const pendingAttempt =
          sendAttemptRef.current?.snapshot.tableId === targetTableId
            ? sendAttemptRef.current.snapshot
            : null;
        if (pendingAttempt) {
          setCustomerName(pendingAttempt.customerName);
          setCustomerPhone(pendingAttempt.customerPhone);
        } else if (order?.customer) {
          setCustomerName(order.customer.name || '');
          setCustomerPhone(order.customer.phone || '');
        } else {
          setCustomerName('');
          setCustomerPhone('');
        }
        setCustomerMatch(null);
        setCustomerSearched(false);
        orderLoadedTableIdRef.current = targetTableId;
        setOrderLoadedTableId(targetTableId);
      })
      .catch(() => {
        if (
          !cancelled &&
          !sendInFlightRef.current &&
          loadSeq === orderLoadSeqRef.current &&
          selectedTableIdRef.current === targetTableId
        ) {
          setCurrentOrder(null);
          orderLoadedTableIdRef.current = '';
          setOrderLoadedTableId('');
          orderLookupFailedRef.current = true;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, selectedTableId, user]);

  useEffect(() => {
    return () => {
      clearTimeout(phoneDebounceRef.current);
      phoneAbortRef.current?.abort();
    };
  }, []);

  function searchCustomerByPhone(rawPhone: string) {
    if (sendInFlightRef.current) return;
    clearTimeout(phoneDebounceRef.current);
    phoneAbortRef.current?.abort();
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length < 3) {
      setCustomerMatch(null);
      setCustomerSearched(false);
      return;
    }
    phoneDebounceRef.current = setTimeout(async () => {
      if (!api || sendInFlightRef.current) return;
      const controller = new AbortController();
      phoneAbortRef.current = controller;
      try {
        const parsed = regional?.country ? parsePhone(rawPhone, regional.country) : null;
        const lookupPhone = parsed ? parsed.e164 : rawPhone;
        const { data } = await api.get('/api/crm/lookup', {
          params: { phone: lookupPhone },
          signal: controller.signal,
        });
        if (controller.signal.aborted || sendInFlightRef.current) return;
        if (data.found && data.customer) {
          setCustomerMatch({ id: data.customer.id, name: data.customer.name });
          setCustomerName(data.customer.name || '');
        } else {
          setCustomerMatch(null);
        }
        setCustomerSearched(true);
      } catch {
        if (controller.signal.aborted || sendInFlightRef.current) return;
        setCustomerMatch(null);
        setCustomerSearched(true);
      }
    }, 300);
  }

  function handleCustomerPhoneChange(value: string) {
    if (sendInFlightRef.current) return;
    sendAttemptRef.current = null;
    setCustomerPhone(value);
    setCustomerMatch(null);
    setCustomerSearched(false);
    setCustomerName('');
    searchCustomerByPhone(value);
  }

  function handleCustomerNameChange(value: string) {
    if (sendInFlightRef.current || customerMatch) return;
    sendAttemptRef.current = null;
    setCustomerName(value);
  }

  function handleOrderNotesChange(value: string) {
    if (sendInFlightRef.current) return;
    sendAttemptRef.current = null;
    setOrderNotes(value.slice(0, 200));
  }

  function selectTable(tableId: string) {
    if (sendInFlightRef.current) return;
    if (tableId === selectedTableIdRef.current) {
      if (orderLookupFailedRef.current) {
        loadOrder(tableId).catch(() => toast.error(t('couldNotLoadData')));
      }
      return;
    }
    selectedTableIdRef.current = tableId;
    orderLookupFailedRef.current = false;
    orderLoadedTableIdRef.current = '';
    setOrderLoadedTableId('');
    orderLoadSeqRef.current += 1;
    cancelPendingCustomerLookup();
    setCurrentOrder(null);
    const pendingAttempt =
      sendAttemptRef.current?.snapshot.tableId === tableId ? sendAttemptRef.current.snapshot : null;
    setCustomerName(pendingAttempt?.customerName ?? '');
    setCustomerPhone(pendingAttempt?.customerPhone ?? '');
    setCustomerMatch(null);
    setCustomerSearched(false);
    setSelectedTableId(tableId);
  }

  function handleRefresh() {
    if (sendInFlightRef.current) return;
    const tableId = selectedTableIdRef.current;
    Promise.all([loadAll(), tableId ? loadOrder(tableId) : Promise.resolve()]).catch(() =>
      toast.error(t('refreshFailed')),
    );
  }

  function openAddonModal(
    product: Product,
    quantity: number,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    addonModalSendSeqRef.current = sendSeqRef.current;
    setAddonModalQuantity(quantity);
    setAddonModalVariant(variant);
    setAddonModalProduct(product);
  }

  function openEditDraftModal(line: DraftLine) {
    if (sendInFlightRef.current) return;
    editingDraftSendSeqRef.current = sendSeqRef.current;
    setEditingDraftLine(line);
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (!api) return;
    setLoginLoading(true);
    try {
      const res = await api.post('/api/auth/login', {
        email,
        password,
        remember_me: rememberMe,
      });
      localStorage.setItem(TOKEN_KEY, res.data.access_token);
      setUser(res.data.user);
    } catch (error: unknown) {
      toastApiError(error, t('signInFailed'), apiErrorT);
    } finally {
      setLoginLoading(false);
    }
  }

  async function logout() {
    try {
      await api?.post('/api/auth/logout');
    } catch {}
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }

  function addDraftLine(
    product: Product,
    quantity: number,
    addons: Addon[],
    specialInstructions: string,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    sendAttemptRef.current = null;
    setDraft((lines) => {
      const lineId = generateCartItemId(
        product.id,
        variant?.id ?? null,
        addons,
        specialInstructions,
      );
      const existing = lines.find((line) => line.id === lineId);
      if (existing) {
        return lines.map((line) =>
          line.id === lineId ? { ...line, quantity: line.quantity + quantity } : line,
        );
      }
      return [
        ...lines,
        {
          id: lineId,
          product,
          quantity,
          addons,
          special_instructions: specialInstructions,
          variant,
        },
      ];
    });
  }

  function updateDraftLine(
    lineId: string,
    quantity: number,
    addons: Addon[],
    specialInstructions: string,
    variant: ProductVariant | null = null,
  ) {
    if (sendInFlightRef.current) return;
    sendAttemptRef.current = null;
    setDraft((lines) => {
      const target = lines.find((line) => line.id === lineId);
      if (!target) return lines;

      const newId = generateCartItemId(
        target.product.id,
        (variant ?? target.variant)?.id ?? null,
        addons,
        specialInstructions,
      );
      if (newId === lineId) {
        return lines.map((line) =>
          line.id === lineId
            ? {
                ...line,
                quantity,
                addons,
                special_instructions: specialInstructions,
                variant: variant ?? target.variant ?? null,
              }
            : line,
        );
      }

      // The edit produced a config that matches another existing line — merge into it.
      const collision = lines.find((line) => line.id === newId && line.id !== lineId);
      if (collision) {
        return lines
          .filter((line) => line.id !== lineId)
          .map((line) =>
            line.id === newId ? { ...line, quantity: line.quantity + quantity } : line,
          );
      }
      return lines.map((line) =>
        line.id === lineId
          ? {
              ...line,
              id: newId,
              quantity,
              addons,
              special_instructions: specialInstructions,
              variant: variant ?? target.variant ?? null,
            }
          : line,
      );
    });
  }

  function removeDraftLine(lineId: string) {
    if (sendInFlightRef.current) return;
    sendAttemptRef.current = null;
    setDraft((lines) => lines.filter((line) => line.id !== lineId));
  }

  function changeQty(lineId: string, delta: number) {
    if (sendInFlightRef.current) return;
    sendAttemptRef.current = null;
    setDraft((lines) =>
      lines
        .map((line) => (line.id === lineId ? { ...line, quantity: line.quantity + delta } : line))
        .filter((line) => line.quantity > 0),
    );
  }

  async function ensureCustomer(
    submittedName: string,
    submittedPhone: string,
  ): Promise<string | null> {
    if (!api) return null;
    const name = submittedName.trim();
    const rawPhone = submittedPhone.trim();
    if (!name && !rawPhone) return null;
    let normalizedPhone: string | undefined = undefined;
    if (rawPhone) {
      const parsed = regional?.country ? parsePhone(rawPhone, regional.country) : null;
      normalizedPhone = parsed ? parsed.e164 : rawPhone;
      try {
        const lookup = await api.get('/api/crm/lookup', {
          params: { phone: normalizedPhone },
        });
        if (lookup.data.found && lookup.data.customer?.id) return lookup.data.customer.id;
      } catch {}
    }
    const fallbackName = name || t('guestFallbackName', { last4: rawPhone.slice(-4) });
    const res = await api.post('/api/customers', {
      name: fallbackName,
      phone: normalizedPhone || undefined,
    });
    return res.data.customer?.id || null;
  }

  // Falls back to this device's browser print dialog when no hardware printer is configured (400).
  async function printKotForOrder(orderId: number, orderForPrint: Record<string, unknown>) {
    if (!api) return;
    try {
      await api.post('/api/printers/print-kot', {
        orderId,
        items: orderForPrint.items,
      });
      return;
    } catch (printError: unknown) {
      const status = axios.isAxiosError(printError) ? printError.response?.status : undefined;
      if (status !== 400) {
        toastApiError(printError, t('kotPrintFailed'), apiErrorT);
        return;
      }
    }
    try {
      const { generateKotHtml, resolveKotTicketLanguage } =
        await import('@/lib/printer/kot-web-print');
      const html = generateKotHtml(orderForPrint as unknown as FullOrder, {
        paperWidth: 80,
        language: resolveKotTicketLanguage(),
        stationName: t('kitchen'),
      });
      await printerService.printViaBrowser(html, 80);
    } catch (fallbackError: unknown) {
      toastApiError(fallbackError, t('kotPrintFailed'), apiErrorT);
    }
  }

  // Same browser-print fallback as KOT above on 400; stays quiet on 403 (owner hasn't enabled server bill printing).
  async function printOrderSlip(orderId: number, orderForPrint: Record<string, unknown>) {
    if (!api) return;
    try {
      await api.post('/api/printers/print-bill', { orderId });
      return;
    } catch (printError: unknown) {
      const status = axios.isAxiosError(printError) ? printError.response?.status : undefined;
      if (status === 403) return;
      if (status !== 400) {
        toastApiError(printError, t('billPrintFailed'), apiErrorT);
        return;
      }
    }
    try {
      const { generateOrderSlipHtml } = await import('@/lib/printer/order-slip-web-print');
      const html = generateOrderSlipHtml(
        orderForPrint as unknown as FullOrder,
        {
          title: t('orderSlipTitle'),
          subtotal: t('orderSlipSubtotal'),
          discount: t('orderSlipDiscount'),
          serviceCharge: t('orderSlipServiceCharge'),
          deliveryCharge: t('orderSlipDeliveryCharge'),
          packagingCharge: t('orderSlipPackagingCharge'),
          tax: t('orderSlipTax'),
          total: t('orderSlipTotal'),
        },
        {
          paperWidth: 80,
          country: regional?.country,
          currency: regional?.currency,
          locale: getLanguageLocale(language),
          direction: getLanguageDirection(language),
        },
      );
      await printerService.printViaBrowser(html, 80);
    } catch (fallbackError: unknown) {
      toastApiError(fallbackError, t('billPrintFailed'), apiErrorT);
    }
  }

  async function sendDraft() {
    if (
      !api ||
      !selectedTableId ||
      orderLoadedTableIdRef.current !== selectedTableId ||
      draft.length === 0 ||
      sendInFlightRef.current
    ) {
      return;
    }
    const snapshotTable = tables.find((table) => table.id === selectedTableId) || null;
    const candidateSnapshot: SendSnapshot = {
      tableId: selectedTableId,
      tableName: snapshotTable ? snapshotTable.name || snapshotTable.number : undefined,
      orderId: currentOrder?.id ?? null,
      orderCustomer: currentOrder?.customer ?? null,
      existingItemIds: new Set((currentOrder?.items || []).map((item) => item.id)),
      draftLines: draft.map((line) => ({
        ...line,
        addons: line.addons.map((addon) => ({ ...addon })),
      })),
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      orderNotes,
    };
    // Nonce first via the LAN-safe helper: anything thrown after the
    // sending flag is set sticks the UI on Sending... forever.
    const signature = sendAttemptSignature(
      candidateSnapshot.tableId,
      candidateSnapshot.draftLines,
      candidateSnapshot.customerName,
      candidateSnapshot.customerPhone,
      candidateSnapshot.orderNotes,
    );
    if (sendAttemptRef.current?.signature !== signature) {
      sendAttemptRef.current = {
        signature,
        nonce: createPaymentIdempotencyKey(),
        snapshot: candidateSnapshot,
      };
    }
    const { nonce, snapshot } = sendAttemptRef.current;
    const idempotencyKey = `server-app-${snapshot.tableId}-${nonce}`;
    sendSeqRef.current += 1;
    orderLoadSeqRef.current += 1;
    cancelPendingCustomerLookup();
    sendInFlightRef.current = true;
    setSending(true);
    try {
      const customerId = await ensureCustomer(snapshot.customerName, snapshot.customerPhone);
      const items = snapshot.draftLines.map((line) => cartItemToOrderItem(line));
      const specialInstructions = snapshot.orderNotes.trim() || undefined;
      let orderId: number;
      let rawOrder: Record<string, unknown>;
      let newItems: OrderItem[];
      if (snapshot.orderId) {
        const { data } = await api.post(
          `/api/orders/${snapshot.orderId}/items`,
          { items, special_instructions: specialInstructions },
          {
            headers: { 'Idempotency-Key': idempotencyKey },
          },
        );
        orderId = data.order.id;
        rawOrder = data.order;
        // Print only what this call added — omitting items reprints every pending item on the order.
        newItems = (data.order.items || []).filter(
          (item: OrderItem) => !snapshot.existingItemIds.has(item.id),
        );
      } else {
        const { data } = await api.post(
          '/api/orders',
          {
            table_id: snapshot.tableId,
            customer_id: customerId,
            type: 'dine_in',
            special_instructions: specialInstructions,
            items,
          },
          { headers: { 'Idempotency-Key': idempotencyKey } },
        );
        orderId = data.order.id;
        rawOrder = data.order;
        newItems = data.order.items || [];
      }
      if (sendAttemptRef.current?.signature === signature) {
        sendAttemptRef.current = null;
      }
      const submittedQtyById = new Map(snapshot.draftLines.map((line) => [line.id, line.quantity]));
      setDraft((currentLines) =>
        currentLines.flatMap((line) => {
          const ackedQty = submittedQtyById.get(line.id);
          if (ackedQty === undefined) return [line];
          const remainingQuantity = line.quantity - ackedQty;
          return remainingQuantity > 0 ? [{ ...line, quantity: remainingQuantity }] : [];
        }),
      );
      setOrderNotes((currentNotes) => (currentNotes === snapshot.orderNotes ? '' : currentNotes));
      if (selectedTableIdRef.current === snapshot.tableId) {
        setCurrentOrder(rawOrder as unknown as Order);
        orderLoadedTableIdRef.current = snapshot.tableId;
        setOrderLoadedTableId(snapshot.tableId);
      }
      setMobileCartOpen(false);
      await Promise.all([
        loadAll({ allowWhileSending: true }),
        loadOrder(snapshot.tableId, { allowWhileSending: true }),
      ]).catch(() => {});
      toast.success(t('orderSent'));
      // rawOrder only has table_id/customer_id; the KOT/slip renderers need the nested table/customer for display.
      const enrichedOrder = {
        ...rawOrder,
        table: snapshot.tableName ? { name: snapshot.tableName } : undefined,
        customer:
          snapshot.orderCustomer ||
          (snapshot.customerName ? { name: snapshot.customerName } : undefined),
      };
      // Backgrounded so an unreachable printer can't block Send; sequenced (not concurrent)
      // since KOT and bill can share a default printer and race its socket connection.
      void (async () => {
        await printKotForOrder(orderId, { ...enrichedOrder, items: newItems });
        await printOrderSlip(orderId, enrichedOrder);
      })();
    } catch (error: unknown) {
      toastApiError(error, t('couldNotSendOrder'), apiErrorT);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  }

  const activeTable = tables.find((table) => table.id === selectedTableId) || null;
  const draftTotal = draft.reduce((sum, line) => {
    const addonTotal = line.addons.reduce(
      (addonSum, addon) => addonSum + Number(addon.price || 0) * (addon.quantity || 1),
      0,
    );
    return (
      sum + ((Number(line.variant?.price ?? line.product.price) || 0) + addonTotal) * line.quantity
    );
  }, 0);
  const draftQuantities = useMemo(() => {
    const quantities = new Map<string, number>();
    for (const line of draft) {
      quantities.set(line.product.id, (quantities.get(line.product.id) || 0) + line.quantity);
    }
    return quantities;
  }, [draft]);
  const draftItemCount = draft.reduce((sum, line) => sum + line.quantity, 0);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  if (disabled) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <Smartphone size={44} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t('disabledTitle')}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{t('disabledHint')}</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm"
        >
          <div className="mb-6 text-center">
            <UserRound size={42} className="mx-auto mb-3 text-brand" />
            <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('loginSubtitle')}</p>
          </div>
          <div className="space-y-3">
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              dir="ltr"
              placeholder={t('emailPlaceholder')}
              required
              className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              placeholder={tAuth('password')}
              required
              className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
                className="rounded border-border text-brand focus:ring-brand"
              />
              {tAuth('rememberMe')}
            </label>
            <button
              disabled={loginLoading}
              className="h-11 w-full rounded-lg bg-brand font-semibold text-white disabled:opacity-60"
            >
              {loginLoading ? tAuth('signingIn') : tAuth('signIn')}
            </button>
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground">{t('loginHint')}</p>
        </form>
      </div>
    );
  }

  const ticketPanelBody = (
    <>
      <h2 className="text-sm font-semibold">{t('currentTicket')}</h2>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <input
          value={customerPhone}
          disabled={sending}
          onChange={(event) => handleCustomerPhoneChange(event.target.value)}
          dir="ltr"
          placeholder={t('phonePlaceholder')}
          className="h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none disabled:opacity-50"
        />
        <input
          value={customerName}
          disabled={sending}
          onChange={
            customerMatch ? undefined : (event) => handleCustomerNameChange(event.target.value)
          }
          readOnly={!!customerMatch}
          placeholder={
            customerSearched
              ? customerMatch
                ? ''
                : t('customerNamePlaceholder')
              : t('customerNamePlaceholder')
          }
          className={`h-10 rounded-lg border px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none disabled:opacity-50 ${customerMatch ? 'border-border bg-muted' : 'border-border bg-background'}`}
        />
      </div>
      {customerSearched && (
        <p
          className={`mt-1 text-xs font-medium ${customerMatch ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}
        >
          {customerMatch ? tPos('customerFound') : tPos('newCustomerEnterName')}
        </p>
      )}

      {currentOrder?.items && currentOrder.items.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            {t('kitchen')}
          </p>
          <div className="space-y-2">
            {currentOrder.items.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-sm">
                {itemStatusIcon(item.status, t)}
                <span className="min-w-0 flex-1 truncate">
                  <Ltr>{item.quantity}</Ltr> x{' '}
                  {formatItemHeading(item.product_name, item.variant_selection)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          {t('newItems')}
        </p>
        {draft.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('emptyDraft')}</p>
        ) : (
          <div className="space-y-3">
            {draft.map((line) => (
              <div key={line.id} className="rounded-lg border border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {line.variant
                        ? `${line.product.name} (${line.variant.name})`
                        : line.product.name}
                    </span>
                    {line.addons.length > 0 && (
                      <div className="mt-0.5 space-y-0.5">
                        {line.addons.map((addon) => (
                          <p key={addon.id} className="truncate text-xs text-muted-foreground">
                            + {addon.name}
                            {(addon.quantity || 1) > 1 ? ` x${addon.quantity}` : ''}
                          </p>
                        ))}
                      </div>
                    )}
                    {line.special_instructions && (
                      <p className="mt-0.5 truncate text-xs italic text-muted-foreground">
                        {line.special_instructions}
                      </p>
                    )}
                  </div>
                  <button
                    disabled={sending}
                    onClick={() => removeDraftLine(line.id)}
                    aria-label={tCommon('removeItem')}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-red-500 disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      disabled={sending}
                      onClick={() => changeQty(line.id, -1)}
                      className="rounded-md border border-border bg-card p-1 disabled:opacity-50"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-6 text-center text-sm font-semibold">
                      <Ltr>{line.quantity}</Ltr>
                    </span>
                    <button
                      disabled={sending}
                      onClick={() => changeQty(line.id, 1)}
                      className="rounded-md border border-border bg-card p-1 disabled:opacity-50"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <button
                    disabled={sending}
                    onClick={() => openEditDraftModal(line)}
                    className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 disabled:opacity-50 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
                  >
                    <SquarePen size={12} />
                    {tCommon('edit')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {draft.length > 0 && (
        <div className="mt-3">
          <textarea
            value={orderNotes}
            disabled={sending}
            onChange={(event) => handleOrderNotesChange(event.target.value)}
            placeholder={tPos('orderNotesPlaceholder')}
            rows={2}
            maxLength={200}
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none disabled:opacity-50"
          />
          <p className="mt-0.5 text-end text-xs text-muted-foreground">
            <Ltr>{orderNotes.length}/200</Ltr>
          </p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm text-muted-foreground">{t('draftTotal')}</span>
        <span className="text-lg font-bold">
          <Ltr>{money(draftTotal, regional)}</Ltr>
        </span>
      </div>
      <button
        onClick={sendDraft}
        disabled={
          !selectedTableId ||
          orderLoadedTableId !== selectedTableId ||
          draft.length === 0 ||
          sending
        }
        className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand font-semibold text-white disabled:opacity-50"
      >
        <Send size={17} />
        {sending ? t('sending') : currentOrder ? t('addToOrder') : t('sendToKitchen')}
      </button>
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 px-3 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white">
            <ChefHat size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{t('title')}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {activeTable
                ? t('tableLabel', {
                    name: activeTable.name ?? String(activeTable.number),
                  })
                : t('selectTable')}
            </p>
          </div>
          <button
            disabled={sending}
            onClick={handleRefresh}
            aria-label={tSettings('refresh')}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border p-2 text-muted-foreground disabled:opacity-50"
          >
            <RefreshCw size={17} />
          </button>
          <button
            onClick={logout}
            aria-label={tNav('logout')}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border p-2 text-muted-foreground"
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>

      {tablesLoaded && tables.length === 0 ? (
        <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-6 text-center">
          <LayoutGrid size={44} className="text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('noTablesTitle')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t('noTablesHint')}</p>
        </div>
      ) : (
        <main className="mx-auto grid max-w-6xl min-w-0 gap-3 p-3 lg:grid-cols-[220px_1fr_340px]">
          <section className="min-w-0 rounded-lg border border-border bg-card p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              {t('tables')}
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-1">
              {tables.map((table) => {
                const selected = table.id === selectedTableId;
                const order = table.activeOrder || table.current_order;
                return (
                  <button
                    key={table.id}
                    disabled={sending}
                    onClick={() => selectTable(table.id)}
                    className={`min-h-14 rounded-lg border px-2 py-2 text-start disabled:opacity-50 ${selected ? 'border-brand bg-brand/10' : 'border-border bg-card'}`}
                  >
                    <span className="block truncate text-sm font-semibold">
                      {table.name || table.number}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {order ? t('openOrder') : tTables('statusAvailable')}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex h-[calc(100dvh-5rem)] min-h-96 min-w-0 flex-col rounded-lg border border-border bg-card p-3">
            <ProductGrid
              categories={categories}
              products={products}
              selectedCategory={selectedCategoryId}
              setSelectedCategory={setSelectedCategoryId}
              search={query}
              setSearch={setQuery}
              currency={regional?.currency || ''}
              disabled={sending}
              onProductClick={(product, quantity) => {
                if (sendInFlightRef.current) return;
                if (productNeedsCustomizer(product)) {
                  openAddonModal(product, quantity, null);
                } else addDraftLine(product, quantity, [], '');
              }}
              onScannedVariant={(product, variant, quantity) => {
                if (sendInFlightRef.current) return;
                if (scannedVariantNeedsCustomizer(product, variant)) {
                  openAddonModal(product, quantity, variant);
                } else addDraftLine(product, quantity, [], '', variant);
              }}
              onScaledProduct={(product, quantity) => {
                if (sendInFlightRef.current) return;
                addDraftLine(product, quantity, [], '');
              }}
              cartQuantities={draftQuantities}
              formatPrice={(amount) => money(amount, regional)}
              showImages={true}
              gridClassName="grid-cols-2 sm:grid-cols-3 xl:grid-cols-4"
              searchPlaceholder={t('searchMenu')}
            />
          </section>

          <section className="hidden min-w-0 rounded-lg border border-border bg-card p-3 md:block md:sticky md:top-16 md:self-start">
            {ticketPanelBody}
          </section>
        </main>
      )}

      <Drawer open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <DrawerTrigger asChild>
          <button
            className="fixed bottom-5 end-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lg hover:bg-brand-hover active:bg-brand-hover md:hidden"
            aria-label={t('currentTicket')}
          >
            <ShoppingCart size={22} />
            {draftItemCount > 0 && (
              <span className="absolute -top-0.5 -end-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
                <Ltr>{draftItemCount}</Ltr>
              </span>
            )}
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[85vh] text-foreground">
          <div className="max-h-[80vh] overflow-y-auto px-3 pb-3">{ticketPanelBody}</div>
        </DrawerContent>
      </Drawer>

      {addonModalProduct && (
        <AddonModal
          product={addonModalProduct}
          currency={regional?.currency || ''}
          country={regional?.country}
          initialQuantity={addonModalQuantity}
          initialVariant={addonModalVariant}
          onAdd={(addedProduct, quantity, addons, instructions, variant) => {
            if (sendInFlightRef.current || addonModalSendSeqRef.current !== sendSeqRef.current) {
              return;
            }
            addDraftLine(addedProduct, quantity, addons, instructions, variant);
          }}
          onClose={() => {
            setAddonModalProduct(null);
            setAddonModalQuantity(1);
            setAddonModalVariant(null);
          }}
        />
      )}

      {editingDraftLine && (
        <AddonModal
          product={editingDraftLine.product}
          currency={regional?.currency || ''}
          country={regional?.country}
          mode="edit"
          initialQuantity={editingDraftLine.quantity}
          initialAddons={editingDraftLine.addons}
          initialInstructions={editingDraftLine.special_instructions}
          initialVariant={editingDraftLine.variant}
          onAdd={(_editedProduct, quantity, addons, instructions, variant) => {
            if (sendInFlightRef.current || editingDraftSendSeqRef.current !== sendSeqRef.current) {
              return;
            }
            updateDraftLine(editingDraftLine.id, quantity, addons, instructions, variant);
          }}
          onClose={() => setEditingDraftLine(null)}
        />
      )}
    </div>
  );
}
