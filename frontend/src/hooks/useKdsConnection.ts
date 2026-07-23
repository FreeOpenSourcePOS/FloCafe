'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import type { AxiosInstance } from 'axios';
import { useI18n } from '@/hooks/useI18n';
import { useConfirm } from '@/hooks/use-confirm';

export type KitchenStatus = 'pending' | 'preparing' | 'ready' | 'served';
export type ConnectionMode = 'websocket' | 'rest' | null;

export const STATUS_CONFIG = {
  pending: {
    labelKey: 'kds.statusWaiting',
    color: 'bg-yellow-500',
    border: 'border-yellow-300',
    text: 'text-yellow-700',
    bg: 'bg-yellow-50',
  },
  preparing: {
    labelKey: 'kds.statusPreparing',
    color: 'bg-blue-500',
    border: 'border-blue-300',
    text: 'text-blue-700',
    bg: 'bg-blue-50',
  },
  ready: {
    labelKey: 'kds.statusReady',
    color: 'bg-green-500',
    border: 'border-green-300',
    text: 'text-green-700',
    bg: 'bg-green-50',
  },
  served: {
    labelKey: 'kds.statusDelivered',
    color: 'bg-purple-500',
    border: 'border-purple-300',
    text: 'text-purple-700',
    bg: 'bg-purple-50',
  },
} as const;

export const STATUS_ORDER: KitchenStatus[] = ['pending', 'preparing', 'ready', 'served'];

export interface KdsOrderItemAddon {
  id?: string | number;
  name: string;
  price?: number;
  quantity?: number;
}

export interface KdsOrderItem {
  id: number;
  order_id: number;
  product_id: string | number;
  product_name: string;
  quantity: number;
  status?: string;
  addons?: KdsOrderItemAddon[] | null;
  special_instructions?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface KdsOrder {
  id: number;
  order_number: string;
  type: string;
  table_id?: string | number | null;
  customer_id?: string | null;
  status?: string;
  subtotal?: number;
  tax_amount?: number;
  total?: number;
  guest_count?: number | null;
  special_instructions?: string | null;
  created_at: string;
  updated_at?: string;
  items?: KdsOrderItem[];
  table?: { name: string } | null;
}

export interface KdsUser {
  id: string;
  name: string;
  role: string;
  token: string;
}

interface WsMessage {
  type: string;
  orders?: KdsOrder[];
  counts?: Record<string, number>;
  user?: { id: string; name: string; role: string };
  message?: string;
}

export interface UseKdsConnectionEndpoints {
  login?: string;
  me?: string;
  orders?: string;
  /** Path template containing a literal `:itemId` placeholder, e.g. '/kds/items/:itemId/status'. */
  itemStatus?: string;
}

export interface UseKdsConnectionOptions {
  api: AxiosInstance;
  /**
   * Overrides the default (main-server) endpoint paths. The standalone KDS
   * device page talks to kds-server.ts, which exposes a different, smaller
   * route set than the main server the dashboard-embedded KDS talks to.
   */
  endpoints?: UseKdsConnectionEndpoints;
}

export interface UseKdsConnectionResult {
  user: KdsUser | null;
  orders: KdsOrder[];
  counts: Record<string, number>;
  loading: boolean;
  connected: boolean;
  connectionMode: ConnectionMode;
  updating: number | null;
  loginEmail: string;
  loginPassword: string;
  loginError: string;
  loginLoading: boolean;
  rememberMe: boolean;
  setLoginEmail: (v: string) => void;
  setLoginPassword: (v: string) => void;
  setRememberMe: (v: boolean) => void;
  handleLogin: (e: React.FormEvent) => Promise<void>;
  handleLogout: () => Promise<void>;
  updateItemStatus: (itemId: number, status: KitchenStatus, opts?: { silent?: boolean }) => Promise<void>;
  ConfirmDialog: ReactNode;
}

const LOGIN_ENDPOINT = '/auth/login';
const ME_ENDPOINT = '/auth/me';
const ORDERS_ENDPOINT = '/kitchen/orders';
const ITEM_STATUS_ENDPOINT = '/order-items/:itemId/status';

export function useKdsConnection(options: UseKdsConnectionOptions): UseKdsConnectionResult {
  const { api, endpoints } = options;
  const loginPath = endpoints?.login ?? LOGIN_ENDPOINT;
  const mePath = endpoints?.me ?? ME_ENDPOINT;
  const ordersPath = endpoints?.orders ?? ORDERS_ENDPOINT;
  const itemStatusPath = endpoints?.itemStatus ?? ITEM_STATUS_ENDPOINT;
  const { t } = useI18n();
  const { confirm, ConfirmDialog } = useConfirm();

  const statusLabel = (s: KitchenStatus) => t(STATUS_CONFIG[s].labelKey);

  const [user, setUser] = useState<KdsUser | null>(null);
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(null);
  const [updating, setUpdating] = useState<number | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

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
      const { data } = await api.get(`${ordersPath}?status=pending,preparing,ready,served`);
      setOrders(data.orders || []);
      setCounts(data.counts || {});
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, [api, ordersPath]);

  const startRestPolling = useCallback(() => {
    stopRestPolling();
    setConnectionMode('rest');
    setConnected(true);
    fetchOrdersRest();
    restIntervalRef.current = setInterval(fetchOrdersRest, 5000);
  }, [fetchOrdersRest, stopRestPolling]);

  const updateItemStatus = useCallback(
    async (itemId: number, status: KitchenStatus, opts: { silent?: boolean } = {}) => {
      setUpdating(itemId);
      try {
        await api.patch(itemStatusPath.replace(':itemId', String(itemId)), { status });
        if (!opts.silent) toast.success(t('kds.itemMarked', { status: statusLabel(status) }));
      } catch {
        if (!opts.silent) toast.error(t('kds.failedToUpdateItem'));
      } finally {
        setUpdating(null);
      }
    },
    // statusLabel is derived from `t` (already in deps), so omit it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, itemStatusPath, t],
  );

  const tryWebSocket = useCallback(
    (token: string) => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      const apiBase = api.defaults.baseURL || '';
      // Derive WS host from the axios baseURL so dashboard KDS in dev
      // (next dev on :3000, backend on :3001) reaches the right server.
      // Falls back to the page origin for absolute-path baseURLs.
      let wsHost = window.location.host;
      try {
        if (apiBase) {
          const u = new URL(apiBase, window.location.origin);
          if (u.host) wsHost = u.host;
        }
      } catch {
        // ignore — keep window.location.host fallback
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${wsHost}/kds`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
      let connectionTimeout: ReturnType<typeof setTimeout> | null = null;

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
          const msg: WsMessage = JSON.parse(event.data);
          if (msg.type === 'auth_success' && msg.user) {
            setUser((prev) => (prev ? { ...prev, ...msg.user, token: prev.token } : null));
            setOrders(msg.orders || []);
            setCounts(msg.counts || {});
            setConnected(true);
            setLoading(false);
          } else if (msg.type === 'auth_error') {
            setLoginError(msg.message || t('kds.authFailed'));
            ws.close();
            setLoading(false);
          } else if ((msg.type === 'initial_data' || msg.type === 'orders') && msg.orders) {
            setOrders(msg.orders);
            setCounts(msg.counts || {});
            setConnected(true);
            if (msg.type === 'initial_data') setLoading(false);
          }
        } catch (e) {
          console.error('Failed to parse message', e);
        }
      };

      connectionTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          setConnectionMode('rest');
          setLoading(false);
        }
      }, 5000);
    },
    [t, api],
  );

  const handleLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLoginError('');
      setLoginLoading(true);
      setLoading(true);

      try {
        const { data } = await api.post(loginPath, {
          email: loginEmail,
          password: loginPassword,
          rememberMe,
        });

        const loggedInUser: KdsUser = {
          id: data.user.id,
          name: data.user.name,
          role: data.user.role,
          token: data.access_token,
        };

        setUser(loggedInUser);
        window.localStorage.setItem('token', data.access_token);
        tryWebSocket(data.access_token);
      } catch (err: unknown) {
        const error = err as { response?: { data?: { error?: string } } };
        setLoginError(error.response?.data?.error || t('auth.loginFailed'));
        setLoading(false);
        setLoginLoading(false);
      }
    },
    [api, loginEmail, loginPassword, loginPath, rememberMe, t, tryWebSocket],
  );

  const handleLogout = useCallback(async () => {
    if (!await confirm(t('nav.confirmLogout', { defaultValue: 'Are you sure you want to log out?' }))) return;
    if (wsRef.current) {
      wsRef.current.close();
    }
    stopRestPolling();
    setUser(null);
    setOrders([]);
    setConnected(false);
    setConnectionMode(null);
    window.localStorage.removeItem('token');
  }, [confirm, stopRestPolling, t]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedToken = window.localStorage.getItem('token');
    if (!savedToken) {
      setLoading(false);
      return;
    }
    api.get(mePath)
      .then(({ data }) => {
        setUser({
          id: data.user.id,
          name: data.user.name,
          role: data.user.role,
          token: savedToken,
        });
        tryWebSocket(savedToken);
      })
      .catch(() => {
        window.localStorage.removeItem('token');
        setLoading(false);
      });

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      stopRestPolling();
    };
  }, [api, mePath, tryWebSocket, stopRestPolling]);

  useEffect(() => {
    if (connectionMode === 'rest' && user) {
      startRestPolling();
    }
    return () => stopRestPolling();
  }, [connectionMode, user, startRestPolling, stopRestPolling]);

  return {
    user,
    orders,
    counts,
    loading,
    connected,
    connectionMode,
    updating,
    loginEmail,
    loginPassword,
    loginError,
    loginLoading,
    rememberMe,
    setLoginEmail,
    setLoginPassword,
    setRememberMe,
    handleLogin,
    handleLogout,
    updateItemStatus,
    ConfirmDialog,
  };
}
