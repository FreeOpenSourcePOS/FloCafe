'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Clock, ChefHat, X, ChevronRight, ChevronLeft, LogOut, Wifi, WifiOff } from 'lucide-react';
import type { Order, OrderItem } from '@/lib/types';
import { useI18n } from '@/hooks/useI18n';

const STATUS_CONFIG = {
  pending: { labelKey: 'kds.statusWaiting', color: 'bg-yellow-500', border: 'border-yellow-300', text: 'text-yellow-700', bg: 'bg-yellow-50', btnBg: 'bg-yellow-500 hover:bg-yellow-600' },
  preparing: { labelKey: 'kds.statusPreparing', color: 'bg-blue-500', border: 'border-blue-300', text: 'text-blue-700', bg: 'bg-blue-50', btnBg: 'bg-blue-500 hover:bg-blue-600' },
  ready: { labelKey: 'kds.statusReady', color: 'bg-green-500', border: 'border-green-300', text: 'text-green-700', bg: 'bg-green-50', btnBg: 'bg-green-500 hover:bg-green-600' },
  served: { labelKey: 'kds.statusDelivered', color: 'bg-purple-500', border: 'border-purple-300', text: 'text-purple-700', bg: 'bg-purple-50', btnBg: 'bg-purple-500 hover:bg-purple-600' },
} as const;

type KitchenStatus = keyof typeof STATUS_CONFIG;

const STATUS_ORDER: KitchenStatus[] = ['pending', 'preparing', 'ready', 'served'];

const NEXT_STATUS: Record<string, KitchenStatus | null> = {
  pending: 'preparing',
  preparing: 'ready',
  ready: 'served',
  served: null,
};

const PREV_STATUS: Record<string, KitchenStatus | null> = {
  pending: null,
  preparing: 'pending',
  ready: 'preparing',
  served: 'ready',
};

interface ModalItem {
  item: OrderItem;
  orderNumber: string;
}

interface KdsMessage {
  type: string;
  orders?: Order[];
  counts?: Record<string, number>;
  user?: {
    id: string;
    name: string;
    role: string;
    categoryIds: string[];
  };
  message?: string;
}

interface LoggedInUser {
  id: string;
  name: string;
  role: string;
  categoryIds: string[];
  token: string;
}

type ConnectionMode = 'websocket' | 'rest' | null;

const activeStatus = (s: string | undefined): KitchenStatus => (s || 'pending') as KitchenStatus;

export default function KdsPage() {
  const { t } = useI18n();
  const statusLabel = (s: KitchenStatus) => t(STATUS_CONFIG[s].labelKey);
  const [user, setUser] = useState<LoggedInUser | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<KitchenStatus>('pending');
  const [modalItem, setModalItem] = useState<ModalItem | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const restIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const stopRestPolling = useCallback(() => {
    if (restIntervalRef.current) {
      clearInterval(restIntervalRef.current);
      restIntervalRef.current = null;
    }
  }, []);

  const fetchOrdersRest = useCallback(async () => {
    try {
      const { data } = await api.get(`/kitchen/orders?status=pending,preparing,ready,served`);
      setOrders(data.orders || []);
      setCounts(data.counts || {});
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  const startRestPolling = useCallback(() => {
    stopRestPolling();
    setConnectionMode('rest');
    setConnected(true);
    fetchOrdersRest();
    restIntervalRef.current = setInterval(fetchOrdersRest, 5000);
  }, [fetchOrdersRest, stopRestPolling]);

  const updateItemStatus = useCallback(async (itemId: number, status: KitchenStatus) => {
    setUpdating(itemId);
    try {
      await api.patch(`/order-items/${itemId}/status`, { status });
      toast.success(t('kds.itemMarked', { status: statusLabel(status) }));
    } catch {
      toast.error(t('kds.failedToUpdateItem'));
    } finally {
      setUpdating(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getTimeSince = (dateStr: string) => {
    const minutes = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
    if (minutes < 1) return t('common.justNow');
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setLoading(true);

    try {
      const { data } = await api.post('/auth/login', {
        email: loginEmail,
        password: loginPassword,
      });

      const loggedInUser: LoggedInUser = {
        id: data.user.id,
        name: data.user.name,
        role: data.user.role,
        categoryIds: data.user.category_ids || [],
        token: data.access_token,
      };

      setUser(loggedInUser);
      localStorage.setItem('kds_user', JSON.stringify(loggedInUser));
      tryWebSocket(loggedInUser.token);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      setLoginError(error.response?.data?.error || t('auth.loginFailed'));
      setLoading(false);
    }
  };

  const handleLogout = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    stopRestPolling();
    setUser(null);
    setOrders([]);
    setConnected(false);
    setConnectionMode(null);
    localStorage.removeItem('kds_user');
  };

  const tryWebSocket = useCallback((token: string) => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/kds`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let connectionTimeout: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (connectionTimeout) clearTimeout(connectionTimeout);
    };

    ws.onopen = () => {
      cleanup();
      setConnectionMode('websocket');
      setConnected(true);
      ws.send(JSON.stringify({ type: 'auth', token }));
    };

    ws.onclose = () => {
      cleanup();
      setConnected(false);
      if (wsRef.current === ws) {
        reconnectTimeout = setTimeout(() => {
          if (wsRef.current === ws) {
            tryWebSocket(token);
          }
        }, 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg: KdsMessage = JSON.parse(event.data);
        if (msg.type === 'auth_success' && msg.user) {
          setUser(prev => prev ? { ...prev, ...msg.user, token: prev.token } : null);
          setOrders(msg.orders || []);
          setCounts(msg.counts || {});
          setConnected(true);
          setLoading(false);
        } else if (msg.type === 'auth_error') {
          setLoginError(msg.message || t('kds.authFailed'));
          ws.close();
          setLoading(false);
        } else if (msg.type === 'initial_data' && msg.orders) {
          setOrders(msg.orders);
          setCounts(msg.counts || {});
          setConnected(true);
          setLoading(false);
        } else if (msg.type === 'orders' && msg.orders) {
          setOrders(msg.orders);
          setCounts(msg.counts || {});
          setConnected(true);
        }
      } catch (e) {
        console.error('Failed to parse message', e);
      }
    };

    connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
        setConnectionMode('rest');
      }
    }, 5000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const savedUser = localStorage.getItem('kds_user');
    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser) as LoggedInUser;
        setUser(parsed);
        tryWebSocket(parsed.token);
      } catch {
        localStorage.removeItem('kds_user');
        setLoading(false);
      }
    } else {
      setLoading(false);
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      stopRestPolling();
    };
  }, [tryWebSocket, stopRestPolling]);

  useEffect(() => {
    if (connectionMode === 'rest' && user) {
      startRestPolling();
    }
    return () => stopRestPolling();
  }, [connectionMode, user, startRestPolling, stopRestPolling]);

  const filteredOrders = orders
    .map((order) => ({
      ...order,
      items: (order.items || []).filter((item) => (item.status || 'pending') === activeTab),
    }))
    .filter((order) => order.items.length > 0);

  const activeItem = modalItem?.item;
  const nextStatus = activeItem ? NEXT_STATUS[activeItem.status || 'pending'] : null;
  const prevStatus = activeItem ? PREV_STATUS[activeItem.status || 'pending'] : null;

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
          <div className="text-center mb-8">
            <ChefHat size={48} className="mx-auto text-brand mb-4" />
            <h1 className="text-2xl font-bold text-gray-900">{t('kds.title')}</h1>
            <p className="text-gray-500 mt-2">{t('kds.loginSubtitle')}</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            {loginError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {loginError}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.email')}</label>
              <input
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand"
                placeholder="chef@flo.local"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('auth.password')}</label>
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand"
                placeholder="••••••••"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full py-3 bg-brand text-white font-semibold rounded-lg hover:bg-brand/90 disabled:opacity-50"
            >
              {loginLoading ? t('auth.signingIn') : t('auth.signIn')}
            </button>
          </form>

          <p className="text-xs text-gray-400 text-center mt-6">
            {t('kds.loginHint')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 mb-4">
        <div className="flex items-center gap-3 mb-3">
          <ChefHat size={24} className="text-brand" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">{t('kds.title')}</h1>
            <p className="text-xs text-gray-500">{user.name} ({user.role})</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {connectionMode === 'websocket' ? (
              <span title={t('kds.wsConnected')}><Wifi size={16} className="text-green-500" /></span>
            ) : connectionMode === 'rest' ? (
              <span title={t('kds.restPolling')}><WifiOff size={16} className="text-amber-500" /></span>
            ) : null}
            <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-gray-400">
              {connected ? (connectionMode === 'websocket' ? t('kds.connectionLive') : t('kds.connectionPolling')) : t('kds.connectionConnecting')}
            </span>
            <button
              onClick={handleLogout}
              className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 ml-2"
              title={t('nav.logout')}
            >
              <LogOut size={20} />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(STATUS_CONFIG) as KitchenStatus[]).map((status) => {
            const config = STATUS_CONFIG[status];
            const count = counts[status] || 0;
            const isActive = activeTab === status;
            return (
              <button
                key={status}
                onClick={() => setActiveTab(status)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                  isActive
                    ? `${config.bg} ${config.text} ring-2 ring-current`
                    : `${config.bg} ${config.text} opacity-50 hover:opacity-80`
                }`}
              >
                <div className={`w-2 h-2 rounded-full ${config.color}`} />
                {statusLabel(status)}
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-white/60">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 items-start">
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              className={`bg-white rounded-xl border-2 ${STATUS_CONFIG[activeTab].border} p-4 flex flex-col`}
            >
              <div className="flex justify-between items-center mb-3">
                <div>
                  <span className="font-bold text-base">#{order.order_number}</span>
                  <span className="text-xs text-gray-500 ml-2">
                    {order.type.replace('_', ' ')}
                    {order.table && ` — ${order.table.name}`}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-xs text-gray-400">
                  <Clock size={12} />
                  {getTimeSince(order.created_at)}
                </div>
              </div>

              {order.special_instructions && (
                <div className="mb-2 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm text-amber-700 font-medium break-words">📝 {order.special_instructions}</p>
                </div>
              )}

              <div className="space-y-2 flex-1">
                {order.items?.map((item) => {
                  const itemStatus = (item.status || 'pending') as KitchenStatus;
                  const config = STATUS_CONFIG[itemStatus];

                  return (
                    <button
                      key={item.id}
                      onClick={() => setModalItem({ item, orderNumber: order.order_number })}
                      className={`w-full text-left rounded-xl border-2 ${config.border} ${config.bg} px-3 py-2.5 transition-all active:scale-95 hover:brightness-95`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${config.color}`} />
                        <span className={`font-bold text-sm w-6 shrink-0 ${config.text}`}>{item.quantity}×</span>
                        <span className="text-gray-900 text-sm font-semibold flex-1 truncate">{item.product_name}</span>
                        <ChevronRight size={14} className="text-gray-400 shrink-0" />
                      </div>
                      {item.addons && item.addons.length > 0 && (
                        <div className="ml-[26px] flex flex-wrap gap-1 mt-1">
                          {item.addons.map((addon, i) => (
                            <span key={i} className="text-[10px] bg-white/70 text-blue-600 px-1.5 py-0.5 rounded border border-blue-200">
                              + {addon.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {item.special_instructions && (
                        <p className="ml-[26px] text-xs text-red-600 italic mt-0.5 font-medium break-words">
                          {`"${item.special_instructions}"`}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {filteredOrders.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <ChefHat size={48} className="mb-3 opacity-30" />
            <p className="text-lg">{t('kds.emptyItems', { status: statusLabel(activeTab).toLowerCase() })}</p>
            <p className="text-sm">{t('kds.emptyHint')}</p>
          </div>
        )}
      </div>

      {modalItem && activeItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setModalItem(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 flex flex-col gap-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 font-medium mb-1">{t('kds.modalOrderNumber', { orderNumber: modalItem.orderNumber })}</p>
                <h2 className="text-2xl font-bold text-gray-900 leading-tight">{activeItem.product_name}</h2>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={`text-sm font-bold ${STATUS_CONFIG[activeStatus(activeItem.status)].text}`}>
                    {activeItem.quantity}×
                  </span>
                  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_CONFIG[activeStatus(activeItem.status)].bg} ${STATUS_CONFIG[activeStatus(activeItem.status)].text}`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[activeStatus(activeItem.status)].color}`} />
                    {statusLabel(activeStatus(activeItem.status))}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setModalItem(null)}
                className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 shrink-0"
              >
                <X size={18} />
              </button>
            </div>

            {activeItem.addons && activeItem.addons.length > 0 && (
              <div className="bg-blue-50 rounded-xl p-3">
                <p className="text-xs font-semibold text-blue-700 mb-1.5 uppercase tracking-wide">{t('kds.addonsLabel')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {activeItem.addons.map((addon, i) => (
                    <span key={i} className="text-sm bg-white text-blue-700 px-2.5 py-1 rounded-lg border border-blue-200 font-medium">
                      + {addon.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {activeItem.special_instructions && (
              <div className="bg-red-50 rounded-xl p-3">
                <p className="text-xs font-semibold text-red-700 mb-1 uppercase tracking-wide">{t('kds.specialInstructionsLabel')}</p>
                <p className="text-sm text-red-700 italic font-medium break-words">{activeItem.special_instructions}</p>
              </div>
            )}

            <div className="flex items-center justify-center gap-1.5">
              {STATUS_ORDER.map((s, i) => (
                <div key={s} className="flex items-center gap-1.5">
                  <div className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${
                    (activeItem.status || 'pending') === s
                      ? `${STATUS_CONFIG[s].bg} ${STATUS_CONFIG[s].text} ring-2 ring-current`
                      : STATUS_ORDER.indexOf((activeItem.status || 'pending') as KitchenStatus) > i
                        ? 'bg-gray-100 text-gray-400 line-through'
                        : 'bg-gray-100 text-gray-400'
                  }`}>
                    {statusLabel(s)}
                  </div>
                  {i < STATUS_ORDER.length - 1 && <ChevronRight size={12} className="text-gray-300 shrink-0" />}
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3">
              {nextStatus && (
                <button
                  onClick={() => updateItemStatus(activeItem.id, nextStatus)}
                  disabled={updating === activeItem.id}
                  className={`w-full py-5 rounded-2xl text-white text-xl font-bold transition-all active:scale-95 disabled:opacity-50 ${STATUS_CONFIG[nextStatus].btnBg}`}
                >
                  {updating === activeItem.id ? t('kds.updating') : t('kds.markAs', { status: statusLabel(nextStatus) })}
                </button>
              )}
              {prevStatus && (
                <button
                  onClick={() => updateItemStatus(activeItem.id, prevStatus)}
                  disabled={updating === activeItem.id}
                  className="w-full py-4 rounded-2xl text-gray-600 text-base font-semibold border-2 border-gray-200 bg-gray-50 hover:bg-gray-100 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <ChevronLeft size={18} />
                  {t('kds.backTo', { status: statusLabel(prevStatus) })}
                </button>
              )}
              {!nextStatus && (
                <div className="text-center py-4 text-gray-400 text-base font-medium">
                  {t('kds.deliveredDone')}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
