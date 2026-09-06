'use client';

import axios, { AxiosInstance } from 'axios';
import toast from 'react-hot-toast';
import { Bell, CheckCircle2, ChefHat, Circle, Flame, LogOut, Minus, Plus, RefreshCw, Search, Send, Smartphone, UserRound } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { parsePhone } from '@/lib/phone';
import { useSyncServerLanguage } from '@/lib/i18n';
import { useTranslations, type AppConfig } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { toastApiError } from '@/lib/api-error';

type User = { id: string; name: string; email: string; role: string };
type Category = { id: string; name: string };
type Product = { id: string; category_id: string | null; name: string; price: number | string; is_active: number };
type Table = { id: string; name?: string; number?: string; status?: string; activeOrder?: Order | null; current_order?: Order | null };
type OrderItem = { id: number; product_name: string; quantity: number; status: string; special_instructions?: string | null };
type Order = { id: number; order_number: string; table_id?: string | null; status: string; items?: OrderItem[]; customer?: { id: string; name: string; phone?: string } | null };
type DraftLine = { product: Product; quantity: number; note: string };

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

function money(value: number | string) {
  return Number(value || 0).toFixed(2);
}

export default function ServerStandalonePage() {
  // Syncs tenant language preference from /api/server-app/info.
  useSyncServerLanguage('/api/server-app/info');
  const t = useTranslations('serverApp');
  const tAuth = useTranslations('auth');
  const tOrders = useTranslations('orders');
  const tTables = useTranslations('tables');

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

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [currentOrder, setCurrentOrder] = useState<Order | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [sending, setSending] = useState(false);

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

  async function loadOrder(tableId: string) {
    if (!api || !tableId) return;
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
  }

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.get('/api/server-app/info')
      .then(() => api.get('/api/auth/me'))
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
    }).catch(() => {
      if (!cancelled) setCurrentOrder(null);
    });
    return () => { cancelled = true; };
  }, [api, selectedTableId, user]);

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

  function addProduct(product: Product) {
    setDraft((lines) => {
      const existing = lines.find((line) => line.product.id === product.id && line.note === '');
      if (existing) {
        return lines.map((line) => line === existing ? { ...line, quantity: line.quantity + 1 } : line);
      }
      return [...lines, { product, quantity: 1, note: '' }];
    });
  }

  function changeQty(productId: string, delta: number) {
    setDraft((lines) => lines
      .map((line) => line.product.id === productId ? { ...line, quantity: line.quantity + delta } : line)
      .filter((line) => line.quantity > 0));
  }

  async function ensureCustomer(): Promise<string | null> {
    if (!api) return null;
    const name = customerName.trim();
    const rawPhone = customerPhone.trim();
    if (!name && !rawPhone) return null;
    let normalizedPhone: string | undefined = undefined;
    if (rawPhone) {
      const parsed = parsePhone(rawPhone, 'IN');
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

  async function sendDraft() {
    if (!api || !selectedTableId || draft.length === 0) return;
    setSending(true);
    try {
      const customerId = await ensureCustomer();
      const items = draft.map((line) => ({
        product_id: line.product.id,
        quantity: line.quantity,
        special_instructions: line.note.trim() || undefined,
      }));
      if (currentOrder?.id) {
        await api.post(`/api/orders/${currentOrder.id}/items`, { items });
      } else {
        await api.post('/api/orders', {
          table_id: selectedTableId,
          customer_id: customerId,
          type: 'dine_in',
          items,
        }, { headers: { 'Idempotency-Key': `server-app-${Date.now()}-${selectedTableId}` } });
      }
      setDraft([]);
      await Promise.all([loadAll(), loadOrder(selectedTableId)]);
      toast.success(t('orderSent'));
    } catch (error: unknown) {
      toastApiError(error, t('couldNotSendOrder'), apiErrorT);
    } finally {
      setSending(false);
    }
  }

  const activeTable = tables.find((table) => table.id === selectedTableId) || null;
  const filteredProducts = products.filter((product) => {
    const matchesCategory = selectedCategoryId === 'all' || product.category_id === selectedCategoryId;
    const matchesQuery = !query || product.name.toLowerCase().includes(query.toLowerCase());
    return matchesCategory && matchesQuery;
  });
  const draftTotal = draft.reduce((sum, line) => sum + Number(line.product.price || 0) * line.quantity, 0);

  if (loading) {
    return <div className="flex h-screen items-center justify-center"><div className="h-10 w-10 rounded-full border-4 border-brand border-t-transparent animate-spin" /></div>;
  }

  if (disabled) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <Smartphone size={44} className="text-gray-400" />
        <h1 className="text-lg font-semibold text-gray-900">{t('disabledTitle')}</h1>
        <p className="max-w-sm text-sm text-gray-500">{t('disabledHint')}</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-6 text-center">
            <UserRound size={42} className="mx-auto mb-3 text-brand" />
            <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            <p className="mt-1 text-sm text-gray-500">{t('loginSubtitle')}</p>
          </div>
          <div className="space-y-3">
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" dir="ltr" placeholder={t('emailPlaceholder')} required className="h-11 w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20" />
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder={tAuth('password')} required className="h-11 w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20" />
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

  return (
    <div className="min-h-screen bg-slate-50 text-gray-900">
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
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('searchMenu')} className="h-10 w-full rounded-lg border border-gray-200 ps-9 pe-3 text-sm focus:border-brand focus:outline-none" />
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
            {filteredProducts.map((product) => (
              <button key={product.id} onClick={() => addProduct(product)}
                className="min-h-24 rounded-lg border border-gray-200 bg-white p-3 text-start hover:border-brand">
                <span className="line-clamp-2 text-sm font-semibold">{product.name}</span>
                <span className="mt-2 block text-sm text-gray-500"><Ltr>{money(product.price)}</Ltr></span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-3 lg:sticky lg:top-16 lg:self-start">
          <h2 className="text-sm font-semibold">{t('currentTicket')}</h2>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder={t('customerNamePlaceholder')} className="h-10 rounded-lg border border-gray-200 px-3 text-sm focus:border-brand focus:outline-none" />
            <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} dir="ltr" placeholder={t('phonePlaceholder')} className="h-10 rounded-lg border border-gray-200 px-3 text-sm focus:border-brand focus:outline-none" />
          </div>

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
                  <div key={line.product.id} className="rounded-lg border border-gray-100 p-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{line.product.name}</span>
                      <button onClick={() => changeQty(line.product.id, -1)} className="rounded-md border border-gray-200 p-1"><Minus size={14} /></button>
                      <span className="w-6 text-center text-sm font-semibold"><Ltr>{line.quantity}</Ltr></span>
                      <button onClick={() => changeQty(line.product.id, 1)} className="rounded-md border border-gray-200 p-1"><Plus size={14} /></button>
                    </div>
                    <input value={line.note} onChange={(event) => setDraft((lines) => lines.map((draftLine) => draftLine.product.id === line.product.id ? { ...draftLine, note: event.target.value } : draftLine))}
                      placeholder={t('itemNotePlaceholder')} className="mt-2 h-9 w-full rounded-md border border-gray-200 px-2 text-sm focus:border-brand focus:outline-none" />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3">
            <span className="text-sm text-gray-500">{t('draftTotal')}</span>
            <span className="text-lg font-bold"><Ltr>{money(draftTotal)}</Ltr></span>
          </div>
          <button onClick={sendDraft} disabled={!selectedTableId || draft.length === 0 || sending}
            className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-brand font-semibold text-white disabled:opacity-50">
            <Send size={17} />
            {sending ? t('sending') : currentOrder ? t('addToOrder') : t('sendToKitchen')}
          </button>
        </section>
      </main>
    </div>
  );
}
