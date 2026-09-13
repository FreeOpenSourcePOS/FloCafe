'use client';

import axios, { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { Bell, CheckCircle2, ChefHat, Circle, Flame, LogOut, Minus, Plus, RefreshCw, Search, Send, ShoppingCart, Smartphone, SquarePen, Trash2, UserRound } from 'lucide-react';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { parsePhone } from '@/lib/phone';
import { useSyncServerLanguage } from '@/lib/i18n';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { toastApiError } from '@/lib/api-error';
import { formatCurrencyForTenant } from '@/lib/countries';
import { printerService } from '@/lib/printer/PrinterService';
import { generateCartItemId } from '@/lib/cart-identity';
import AddonModal from '@/components/pos/AddonModal';
import type { Order as FullOrder, Product, Addon, CartItem } from '@/lib/types';

type User = { id: string; name: string; email: string; role: string };
type Category = { id: string; name: string };
type Table = { id: string; name?: string; number?: string; status?: string; activeOrder?: Order | null; current_order?: Order | null };
type OrderItem = { id: number; product_name: string; quantity: number; status: string; special_instructions?: string | null };
type Order = { id: number; order_number: string; table_id?: string | null; status: string; items?: OrderItem[]; customer?: { id: string; name: string; phone?: string } | null };
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
      if (error.response?.status === 401) localStorage.removeItem(TOKEN_KEY);
      return Promise.reject(error);
    },
  );
  return api;
}

function itemStatusIcon(status: string, t: (key: ServerAppKey) => string) {
  if (status === 'preparing') return <Flame size={15} className="text-orange-500" aria-label={t('statusPreparing')} />;
  if (status === 'ready') return <Bell size={15} className="text-emerald-600" aria-label={t('statusReady')} />;
  if (status === 'served') return <CheckCircle2 size={15} className="text-blue-600" aria-label={t('statusServed')} />;
  return <Circle size={15} className="text-gray-400" aria-label={t('statusWaiting')} />;
}

function money(value: number | string, regional: ServerAppInfo | null) {
  return formatCurrencyForTenant(
    Number(value || 0),
    regional?.country,
    regional?.currency || 'INR',
  );
}

function sendAttemptSignature(scopeId: string, draft: DraftLine[], customerName: string, customerPhone: string): string {
  const items = draft.map((line) => `${line.id}:${line.quantity}`).join('|');
  return `${scopeId}|${items}|${customerName.trim()}|${customerPhone.trim()}`;
}

export default function ServerStandalonePage() {
  // Syncs tenant language preference from /api/server-app/info.
  useSyncServerLanguage('/api/server-app/info');
  const t = useTranslations('serverApp');
  const tAuth = useTranslations('auth');
  const tOrders = useTranslations('orders');
  const tTables = useTranslations('tables');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');

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
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [addonModalProduct, setAddonModalProduct] = useState<Product | null>(null);
  const [editingDraftLine, setEditingDraftLine] = useState<DraftLine | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [currentOrder, setCurrentOrder] = useState<Order | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerMatch, setCustomerMatch] = useState<{ id: string; name: string } | null>(null);
  const [customerSearched, setCustomerSearched] = useState(false);
  const phoneDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const phoneAbortRef = useRef<AbortController | null>(null);
  const [sending, setSending] = useState(false);
  // Synchronous re-entry guard: `sending` state updates too late to stop a second click fired before the first render.
  const sendInFlightRef = useRef(false);
  // Nonce for the in-flight send attempt, paired with a signature of what defines it (draft/customer/order).
  // Reused only while retrying that exact same attempt; a content change or a success both rotate it.
  const sendAttemptRef = useRef<{ signature: string; nonce: string } | null>(null);

  async function loadAll() {
    if (!api) return;
    const [categoriesRes, productsRes, tablesRes] = await Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
    ]);
    setCategories(categoriesRes.data.categories || []);
    setProducts(productsRes.data.products || []);
    const loadedTables = tablesRes.data.tables || [];
    setTables(loadedTables);
    if (!selectedTableId && loadedTables[0]) setSelectedTableId(loadedTables[0].id);
  }

  function cancelPendingCustomerLookup() {
    clearTimeout(phoneDebounceRef.current);
    phoneAbortRef.current?.abort();
  }

  async function loadOrder(tableId: string) {
    if (!api || !tableId) return;
    cancelPendingCustomerLookup();
    const res = await api.get('/api/orders', {
      params: { table_id: tableId, type: 'dine_in', status: 'pending,preparing,ready', per_page: 1 },
    });
    const order = res.data.orders?.[0] || null;
    setCurrentOrder(order);
    if (order?.customer) {
      setCustomerName(order.customer.name || '');
      setCustomerPhone(order.customer.phone || '');
    } else {
      setCustomerName('');
      setCustomerPhone('');
    }
    setCustomerMatch(null);
    setCustomerSearched(false);
  }

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.get<ServerAppInfo>('/api/server-app/info')
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
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!user || !api) return;
    let cancelled = false;
    Promise.all([
      api.get('/api/categories', { params: { active: 'true' } }),
      api.get('/api/products', { params: { active: 'true' } }),
      api.get('/api/tables', { params: { active: 'true' } }),
    ]).then(([categoriesRes, productsRes, tablesRes]) => {
      if (cancelled) return;
      setCategories(categoriesRes.data.categories || []);
      setProducts(productsRes.data.products || []);
      const loadedTables = tablesRes.data.tables || [];
      setTables(loadedTables);
      if (!selectedTableId && loadedTables[0]) setSelectedTableId(loadedTables[0].id);
    }).catch(() => toast.error(t('couldNotLoadData')));
    return () => { cancelled = true; };
  }, [api, selectedTableId, user, t]);

  useEffect(() => {
    if (!selectedTableId || !user || !api) return;
    let cancelled = false;
    cancelPendingCustomerLookup();
    api.get('/api/orders', {
      params: { table_id: selectedTableId, type: 'dine_in', status: 'pending,preparing,ready', per_page: 1 },
    }).then((res) => {
      if (cancelled) return;
      const order = res.data.orders?.[0] || null;
      setCurrentOrder(order);
      if (order?.customer) {
        setCustomerName(order.customer.name || '');
        setCustomerPhone(order.customer.phone || '');
      } else {
        setCustomerName('');
        setCustomerPhone('');
      }
      setCustomerMatch(null);
      setCustomerSearched(false);
    }).catch(() => {
      if (!cancelled) setCurrentOrder(null);
    });
    return () => { cancelled = true; };
  }, [api, selectedTableId, user]);

  useEffect(() => {
    return () => {
      clearTimeout(phoneDebounceRef.current);
      phoneAbortRef.current?.abort();
    };
  }, []);

  function searchCustomerByPhone(rawPhone: string) {
    clearTimeout(phoneDebounceRef.current);
    phoneAbortRef.current?.abort();
    const digits = rawPhone.replace(/\D/g, '');
    if (digits.length < 3) {
      setCustomerMatch(null);
      setCustomerSearched(false);
      return;
    }
    phoneDebounceRef.current = setTimeout(async () => {
      if (!api) return;
      const controller = new AbortController();
      phoneAbortRef.current = controller;
      try {
        const parsed = regional?.country ? parsePhone(rawPhone, regional.country) : null;
        const lookupPhone = parsed ? parsed.e164 : rawPhone;
        const { data } = await api.get('/api/crm/lookup', { params: { phone: lookupPhone }, signal: controller.signal });
        if (data.found && data.customer) {
          setCustomerMatch({ id: data.customer.id, name: data.customer.name });
          setCustomerName(data.customer.name || '');
        } else {
          setCustomerMatch(null);
        }
        setCustomerSearched(true);
      } catch {
        if (controller.signal.aborted) return;
        setCustomerMatch(null);
        setCustomerSearched(true);
      }
    }, 300);
  }

  function handleCustomerPhoneChange(value: string) {
    setCustomerPhone(value);
    setCustomerMatch(null);
    setCustomerSearched(false);
    setCustomerName('');
    searchCustomerByPhone(value);
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (!api) return;
    setLoginLoading(true);
    try {
      const res = await api.post('/api/auth/login', { email, password, remember_me: rememberMe });
      localStorage.setItem(TOKEN_KEY, res.data.access_token);
      setUser(res.data.user);
    } catch (error: unknown) {
      toastApiError(error, t('signInFailed'), apiErrorT);
    } finally {
      setLoginLoading(false);
    }
  }

  async function logout() {
    try { await api?.post('/api/auth/logout'); } catch {}
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  }

  function addDraftLine(product: Product, quantity: number, addons: Addon[], specialInstructions: string) {
    setDraft((lines) => {
      const lineId = generateCartItemId(product.id, addons, specialInstructions);
      const existing = lines.find((line) => line.id === lineId);
      if (existing) {
        return lines.map((line) => line.id === lineId ? { ...line, quantity: line.quantity + quantity } : line);
      }
      return [...lines, { id: lineId, product, quantity, addons, special_instructions: specialInstructions }];
    });
  }

  function updateDraftLine(lineId: string, quantity: number, addons: Addon[], specialInstructions: string) {
    setDraft((lines) => {
      const target = lines.find((line) => line.id === lineId);
      if (!target) return lines;

      const newId = generateCartItemId(target.product.id, addons, specialInstructions);
      if (newId === lineId) {
        return lines.map((line) => line.id === lineId ? { ...line, quantity, addons, special_instructions: specialInstructions } : line);
      }

      // The edit produced a config that matches another existing line — merge into it.
      const collision = lines.find((line) => line.id === newId && line.id !== lineId);
      if (collision) {
        return lines
          .filter((line) => line.id !== lineId)
          .map((line) => line.id === newId ? { ...line, quantity: line.quantity + quantity } : line);
      }
      return lines.map((line) => line.id === lineId ? { ...line, id: newId, quantity, addons, special_instructions: specialInstructions } : line);
    });
  }

  function removeDraftLine(lineId: string) {
    setDraft((lines) => lines.filter((line) => line.id !== lineId));
  }

  function changeQty(lineId: string, delta: number) {
    setDraft((lines) => lines
      .map((line) => line.id === lineId ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0));
  }

  async function ensureCustomer(): Promise<string | null> {
    if (!api) return null;
    const name = customerName.trim();
    const rawPhone = customerPhone.trim();
    if (!name && !rawPhone) return null;
    let normalizedPhone: string | undefined = undefined;
    if (rawPhone) {
      const parsed = regional?.country ? parsePhone(rawPhone, regional.country) : null;
      normalizedPhone = parsed ? parsed.e164 : rawPhone;
      try {
        const lookup = await api.get('/api/crm/lookup', { params: { phone: normalizedPhone } });
        if (lookup.data.found && lookup.data.customer?.id) return lookup.data.customer.id;
      } catch {}
    }
    const fallbackName = name || t('guestFallbackName', { last4: rawPhone.slice(-4) });
    const res = await api.post('/api/customers', { name: fallbackName, phone: normalizedPhone || undefined });
    return res.data.customer?.id || null;
  }

  // Falls back to this device's browser print dialog when no hardware printer is configured (400).
  async function printKotForOrder(orderId: number, orderForPrint: Record<string, unknown>) {
    if (!api) return;
    try {
      await api.post('/api/printers/print-kot', { orderId, items: orderForPrint.items });
      return;
    } catch (printError: unknown) {
      const status = axios.isAxiosError(printError) ? printError.response?.status : undefined;
      if (status !== 400) {
        toastApiError(printError, t('kotPrintFailed'), apiErrorT);
        return;
      }
    }
    try {
      const { generateKotHtml, resolveKotTicketLanguage } = await import('@/lib/printer/kot-web-print');
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
      const html = generateOrderSlipHtml(orderForPrint as unknown as FullOrder, {
        title: t('orderSlipTitle'),
        subtotal: t('orderSlipSubtotal'),
        discount: t('orderSlipDiscount'),
        serviceCharge: t('orderSlipServiceCharge'),
        deliveryCharge: t('orderSlipDeliveryCharge'),
        packagingCharge: t('orderSlipPackagingCharge'),
        tax: t('orderSlipTax'),
        total: t('orderSlipTotal'),
      }, { paperWidth: 80, country: regional?.country, currency: regional?.currency });
      await printerService.printViaBrowser(html, 80);
    } catch (fallbackError: unknown) {
      toastApiError(fallbackError, t('billPrintFailed'), apiErrorT);
    }
  }

  async function sendDraft() {
    if (!api || !selectedTableId || draft.length === 0 || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    const signature = sendAttemptSignature(selectedTableId, draft, customerName, customerPhone);
    if (sendAttemptRef.current?.signature !== signature) {
      sendAttemptRef.current = { signature, nonce: crypto.randomUUID() };
    }
    const idempotencyKey = `server-app-${selectedTableId}-${sendAttemptRef.current.nonce}`;
    try {
      const customerId = await ensureCustomer();
      const items = draft.map((line) => ({
        product_id: line.product.id,
        quantity: line.quantity,
        addons: line.addons.length > 0
          ? line.addons.map((addon) => ({ id: addon.id, name: addon.name, price: addon.price, quantity: addon.quantity || 1 }))
          : null,
        special_instructions: line.special_instructions.trim() || undefined,
      }));
      let orderId: number;
      let rawOrder: Record<string, unknown>;
      let newItems: OrderItem[];
      if (currentOrder?.id) {
        const { data } = await api.post(`/api/orders/${currentOrder.id}/items`, { items }, {
          headers: { 'Idempotency-Key': idempotencyKey },
        });
        orderId = data.order.id;
        rawOrder = data.order;
        // Print only what this call added — omitting items reprints every pending item on the order.
        const existingIds = new Set((currentOrder.items || []).map((item) => item.id));
        newItems = (data.order.items || []).filter((item: OrderItem) => !existingIds.has(item.id));
      } else {
        const { data } = await api.post('/api/orders', {
          table_id: selectedTableId,
          customer_id: customerId,
          type: 'dine_in',
          items,
        }, { headers: { 'Idempotency-Key': idempotencyKey } });
        orderId = data.order.id;
        rawOrder = data.order;
        newItems = data.order.items || [];
      }
      sendAttemptRef.current = null;
      setDraft([]);
      setMobileCartOpen(false);
      await Promise.all([loadAll(), loadOrder(selectedTableId)]);
      toast.success(t('orderSent'));
      // rawOrder only has table_id/customer_id; the KOT/slip renderers need the nested table/customer for display.
      const trimmedCustomerName = customerName.trim();
      const enrichedOrder = {
        ...rawOrder,
        table: activeTable ? { name: activeTable.name || activeTable.number } : undefined,
        customer: currentOrder?.customer || (trimmedCustomerName ? { name: trimmedCustomerName } : undefined),
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
  const filteredProducts = products.filter((product) => {
    const matchesCategory = selectedCategoryId === 'all' || product.category_id === selectedCategoryId;
    const matchesQuery = !query || product.name.toLowerCase().includes(query.toLowerCase());
    return matchesCategory && matchesQuery;
  });
  const draftTotal = draft.reduce((sum, line) => {
    const addonTotal = line.addons.reduce((addonSum, addon) => addonSum + Number(addon.price || 0) * (addon.quantity || 1), 0);
    return sum + (Number(line.product.price || 0) + addonTotal) * line.quantity;
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
    return <div className="server-app-light flex h-screen items-center justify-center"><div className="h-10 w-10 rounded-full border-4 border-brand border-t-transparent animate-spin" /></div>;
  }

  if (disabled) {
    return (
      <div className="server-app-light flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <Smartphone size={44} className="text-gray-400" />
        <h1 className="text-lg font-semibold text-gray-900">{t('disabledTitle')}</h1>
        <p className="max-w-sm text-sm text-gray-500">{t('disabledHint')}</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="server-app-light flex min-h-screen items-center justify-center p-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-6 text-center">
            <UserRound size={42} className="mx-auto mb-3 text-brand" />
            <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            <p className="mt-1 text-sm text-gray-500">{t('loginSubtitle')}</p>
          </div>
          <div className="space-y-3">
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" dir="ltr" placeholder={t('emailPlaceholder')} required className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20" />
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder={tAuth('password')} required className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20" />
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} className="rounded border-gray-300 text-brand focus:ring-brand" />
              {tAuth('rememberMe')}
            </label>
            <button disabled={loginLoading} className="h-11 w-full rounded-lg bg-brand font-semibold text-white disabled:opacity-60">
              {loginLoading ? tAuth('signingIn') : tAuth('signIn')}
            </button>
          </div>
          <p className="mt-4 text-center text-xs text-gray-500">{t('loginHint')}</p>
        </form>
      </div>
    );
  }

  const ticketPanelBody = (
    <>
      <h2 className="text-sm font-semibold">{t('currentTicket')}</h2>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <input value={customerPhone} onChange={(event) => handleCustomerPhoneChange(event.target.value)} dir="ltr" placeholder={t('phonePlaceholder')} className="h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand focus:outline-none" />
        <input
          value={customerName}
          onChange={customerMatch ? undefined : (event) => setCustomerName(event.target.value)}
          readOnly={!!customerMatch}
          placeholder={customerSearched ? (customerMatch ? '' : t('customerNamePlaceholder')) : t('customerNamePlaceholder')}
          className={`h-10 rounded-lg border px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand focus:outline-none ${customerMatch ? 'border-gray-200 bg-gray-50' : 'border-gray-200 bg-white'}`}
        />
      </div>
      {customerSearched && (
        <p className={`mt-1 text-xs font-medium ${customerMatch ? 'text-green-600' : 'text-red-500'}`}>
          {customerMatch ? tPos('customerFound') : tPos('newCustomerEnterName')}
        </p>
      )}

      {currentOrder?.items && currentOrder.items.length > 0 && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <p className="mb-2 text-xs font-semibold uppercase text-gray-500">{t('kitchen')}</p>
          <div className="space-y-2">
            {currentOrder.items.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-sm">
                {itemStatusIcon(item.status, t)}
                <span className="min-w-0 flex-1 truncate"><Ltr>{item.quantity}</Ltr> x {item.product_name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-gray-100 pt-3">
        <p className="mb-2 text-xs font-semibold uppercase text-gray-500">{t('newItems')}</p>
        {draft.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">{t('emptyDraft')}</p>
        ) : (
          <div className="space-y-3">
            {draft.map((line) => (
              <div key={line.id} className="rounded-lg border border-gray-100 p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{line.product.name}</span>
                    {line.addons.length > 0 && (
                      <div className="mt-0.5 space-y-0.5">
                        {line.addons.map((addon) => (
                          <p key={addon.id} className="truncate text-xs text-gray-500">
                            + {addon.name}{(addon.quantity || 1) > 1 ? ` x${addon.quantity}` : ''}
                          </p>
                        ))}
                      </div>
                    )}
                    {line.special_instructions && (
                      <p className="mt-0.5 truncate text-xs italic text-gray-500">{line.special_instructions}</p>
                    )}
                  </div>
                  <button onClick={() => removeDraftLine(line.id)} aria-label={tCommon('removeItem')}
                    className="shrink-0 rounded-md p-1 text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => changeQty(line.id, -1)} className="rounded-md border border-gray-200 p-1"><Minus size={14} /></button>
                    <span className="w-6 text-center text-sm font-semibold"><Ltr>{line.quantity}</Ltr></span>
                    <button onClick={() => changeQty(line.id, 1)} className="rounded-md border border-gray-200 p-1"><Plus size={14} /></button>
                  </div>
                  <button onClick={() => setEditingDraftLine(line)}
                    className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200">
                    <SquarePen size={12} />
                    {tCommon('edit')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
        <span className="text-sm text-gray-500">{t('draftTotal')}</span>
        <span className="text-lg font-bold"><Ltr>{money(draftTotal, regional)}</Ltr></span>
      </div>
      <button onClick={sendDraft} disabled={!selectedTableId || draft.length === 0 || sending}
        className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand font-semibold text-white disabled:opacity-50">
        <Send size={17} />
        {sending ? t('sending') : currentOrder ? t('addToOrder') : t('sendToKitchen')}
      </button>
    </>
  );

  return (
    <div className="server-app-light min-h-screen bg-slate-50 text-gray-900">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-white"><ChefHat size={18} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{t('title')}</h1>
            <p className="truncate text-xs text-gray-500">{activeTable ? t('tableLabel', { name: activeTable.name ?? String(activeTable.number) }) : t('selectTable')}</p>
          </div>
          <button onClick={() => loadAll().catch(() => toast.error(t('refreshFailed')))} className="rounded-lg border border-gray-200 p-2 text-gray-600"><RefreshCw size={17} /></button>
          <button onClick={logout} className="rounded-lg border border-gray-200 p-2 text-gray-600"><LogOut size={17} /></button>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-3 p-3 lg:grid-cols-[220px_1fr_340px]">
        <section className="rounded-lg border border-gray-200 bg-white p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase text-gray-500">{t('tables')}</h2>
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
            {tables.map((table) => {
              const selected = table.id === selectedTableId;
              const order = table.activeOrder || table.current_order;
              return (
                <button key={table.id} onClick={() => setSelectedTableId(table.id)}
                  className={`min-h-14 rounded-lg border px-2 py-2 text-start ${selected ? 'border-brand bg-brand/5' : 'border-gray-200 bg-white'}`}>
                  <span className="block truncate text-sm font-semibold">{table.name || table.number}</span>
                  <span className="text-xs text-gray-500">{order ? t('openOrder') : tTables('statusAvailable')}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-3">
          <div className="mb-3 flex gap-2">
            <div className="relative flex-1">
              <Search size={16} className="absolute start-3 top-3 text-gray-400" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchMenu')} className="h-10 w-full rounded-lg border border-gray-200 bg-white ps-9 pe-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand focus:outline-none" />
            </div>
          </div>
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            <button onClick={() => setSelectedCategoryId('all')} className={`h-9 shrink-0 rounded-lg px-3 text-sm ${selectedCategoryId === 'all' ? 'bg-brand text-white' : 'bg-gray-100 text-gray-700'}`}>{tOrders('all')}</button>
            {categories.map((category) => (
              <button key={category.id} onClick={() => setSelectedCategoryId(category.id)}
                className={`h-9 shrink-0 rounded-lg px-3 text-sm ${selectedCategoryId === category.id ? 'bg-brand text-white' : 'bg-gray-100 text-gray-700'}`}>
                {category.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {filteredProducts.map((product) => {
              const inCartQty = draftQuantities.get(product.id) || 0;
              return (
                <button key={product.id} onClick={() => setAddonModalProduct(product)}
                  className="relative min-h-24 rounded-lg border border-gray-200 bg-white p-3 text-start hover:border-brand">
                  {inCartQty > 0 && (
                    <span className="absolute top-0 end-0 z-10 flex h-6 w-6 items-center justify-center rounded-es-lg bg-brand text-xs font-bold text-white">
                      <Ltr>{inCartQty}</Ltr>
                    </span>
                  )}
                  <span className="line-clamp-2 text-sm font-semibold">{product.name}</span>
                  <span className="mt-2 block text-sm text-gray-500"><Ltr>{money(product.price, regional)}</Ltr></span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="hidden rounded-lg border border-gray-200 bg-white p-3 md:block md:sticky md:top-16 md:self-start">
          {ticketPanelBody}
        </section>
      </main>

      <Drawer open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <DrawerTrigger asChild>
          <button className="fixed bottom-5 end-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-lg hover:bg-brand-hover active:bg-brand-hover md:hidden" aria-label={t('currentTicket')}>
            <ShoppingCart size={22} />
            {draftItemCount > 0 && (
              <span className="absolute -top-0.5 -end-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
                <Ltr>{draftItemCount}</Ltr>
              </span>
            )}
          </button>
        </DrawerTrigger>
        <DrawerContent className="server-app-light max-h-[85vh]">
          <div className="max-h-[80vh] overflow-y-auto px-3 pb-3">
            {ticketPanelBody}
          </div>
        </DrawerContent>
      </Drawer>

      {addonModalProduct && (
        <AddonModal
          product={addonModalProduct}
          currency={regional?.currency || 'INR'}
          country={regional?.country}
          onAdd={(addedProduct, quantity, addons, instructions) => addDraftLine(addedProduct, quantity, addons, instructions)}
          onClose={() => setAddonModalProduct(null)}
        />
      )}

      {editingDraftLine && (
        <AddonModal
          product={editingDraftLine.product}
          currency={regional?.currency || 'INR'}
          country={regional?.country}
          mode="edit"
          initialQuantity={editingDraftLine.quantity}
          initialAddons={editingDraftLine.addons}
          initialInstructions={editingDraftLine.special_instructions}
          onAdd={(_editedProduct, quantity, addons, instructions) => updateDraftLine(editingDraftLine.id, quantity, addons, instructions)}
          onClose={() => setEditingDraftLine(null)}
        />
      )}
    </div>
  );
}
