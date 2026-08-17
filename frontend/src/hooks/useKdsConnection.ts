'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import type { AxiosInstance } from 'axios';
import { useI18n } from '@/hooks/useI18n';
import { useConfirm } from '@/hooks/use-confirm';

// Bounded exponential backoff for KDS WebSocket reconnects: 1s, 2s, 4s, ...
// capping at 30s so a prolonged outage doesn't hammer the server while a brief
// blip still reconnects promptly.
const KDS_RECONNECT_BASE_MS = 1000;
const KDS_RECONNECT_MAX_MS = 30000;
function kdsReconnectDelay(attempt: number): number {
  return Math.min(KDS_RECONNECT_MAX_MS, KDS_RECONNECT_BASE_MS * (2 ** attempt));
}

// 'voided' is a terminal, locked status a manager sets via the Orders page
// PIN flow (issue #150) — it is never a target of the normal advance/revert
// flow below, so it's deliberately excluded from STATUS_ORDER.
export type KitchenStatus = 'pending' | 'preparing' | 'ready' | 'served' | 'voided';
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
  voided: {
    labelKey: 'kds.statusVoided',
    color: 'bg-red-500',
    border: 'border-red-300',
    text: 'text-red-700',
    bg: 'bg-red-50',
  },
} as const;

export const STATUS_ORDER: Exclude<KitchenStatus, 'voided'>[] = ['pending', 'preparing', 'ready', 'served'];

export function normalizeKitchenStatus(status: unknown): KitchenStatus {
  return typeof status === 'string' && status in STATUS_CONFIG
    ? status as KitchenStatus
    : 'pending';
}

export const ORDER_TYPE_BADGE_STYLES: Record<string, string> = {
  dine_in: 'bg-blue-50 text-blue-700 border-blue-200',
  takeaway: 'bg-orange-50 text-orange-700 border-orange-200',
  delivery: 'bg-purple-50 text-purple-700 border-purple-200',
  online: 'bg-teal-50 text-teal-700 border-teal-200',
};

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
  logout?: string;
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
  updateItemStatus: (itemId: number, status: KitchenStatus, opts?: { silent?: boolean; expectedStatus?: KitchenStatus }) => Promise<boolean>;
  ConfirmDialog: ReactNode;
}

const LOGIN_ENDPOINT = '/auth/login';
const ME_ENDPOINT = '/auth/me';
const ORDERS_ENDPOINT = '/kitchen/orders';
const ITEM_STATUS_ENDPOINT = '/order-items/:itemId/status';
const KDS_AUTH_BLOCKED_KEY = 'flocafe:kds-auth-blocked';

function isKdsAuthBlocked(): boolean {
  try { return window.sessionStorage.getItem(KDS_AUTH_BLOCKED_KEY) === '1'; } catch { return false; }
}

function clearKdsAuthBlocked(): void {
  try { window.sessionStorage.removeItem(KDS_AUTH_BLOCKED_KEY); } catch { }
}

function markKdsAuthBlocked(): void {
  try { window.sessionStorage.setItem(KDS_AUTH_BLOCKED_KEY, '1'); } catch { }
}

export function useKdsConnection(options: UseKdsConnectionOptions): UseKdsConnectionResult {
  const { api, endpoints } = options;
  const loginPath = endpoints?.login ?? LOGIN_ENDPOINT;
  const mePath = endpoints?.me ?? ME_ENDPOINT;
  const logoutPath = endpoints?.logout ?? '/auth/logout';
  const ordersPath = endpoints?.orders ?? ORDERS_ENDPOINT;
  const itemStatusPath = endpoints?.itemStatus ?? ITEM_STATUS_ENDPOINT;
  const { t } = useI18n();
  const { confirm, ConfirmDialog } = useConfirm();

  const statusLabel = (s: KitchenStatus) => t(STATUS_CONFIG[normalizeKitchenStatus(s)].labelKey);

  const [user, setUser] = useState<KdsUser | null>(null);
  const [orders, setOrders] = useState<KdsOrder[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  // Starts true only if there's a saved token to check (we're about to fetch /auth/me);
  // otherwise there's nothing to load. Lazy-initialized once on mount instead of being set
  // synchronously inside the mount effect below.
  const [loading, setLoading] = useState(() => typeof window !== 'undefined' && !!window.localStorage.getItem('token') && !isKdsAuthBlocked());
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
  const restInitialFetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restRequestSequenceRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const updatingIdsRef = useRef(new Set<number>());
  // Holds the latest tryWebSocket so its own reconnect timer can call it recursively without
  // referencing the useCallback-bound identifier before it's declared (which the compiler
  // can't safely memoize). Kept in sync via the unconditional assignment right after the
  // useCallback definition below.
  const tryWebSocketRef = useRef<(token: string, retryDuringMaintenance?: boolean) => void>(() => {});

  const stopRestPolling = useCallback(() => {
    if (restIntervalRef.current) {
      clearInterval(restIntervalRef.current);
      restIntervalRef.current = null;
    }
    if (restInitialFetchRef.current) {
      clearTimeout(restInitialFetchRef.current);
      restInitialFetchRef.current = null;
    }
    restRequestSequenceRef.current += 1;
  }, []);

  const fetchOrdersRest = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    const requestSequence = ++restRequestSequenceRef.current;
    try {
      const { data } = await api.get(`${ordersPath}?status=pending,preparing,ready,served`);
      if (
        generation !== sessionGenerationRef.current ||
        requestSequence !== restRequestSequenceRef.current ||
        (typeof window !== 'undefined' && !window.localStorage.getItem('token'))
      ) return;
      setOrders(data.orders || []);
      setCounts(data.counts || {});
      setConnected(true);
    } catch (error: unknown) {
      if (generation !== sessionGenerationRef.current || requestSequence !== restRequestSequenceRef.current) return;
      const axiosError = error as { response?: { status?: number; data?: { error?: string } } };
      const status = axiosError?.response?.status;
      const tokenMissing = typeof window !== 'undefined' && !window.localStorage.getItem('token');
      if (status === 401 || tokenMissing) {
        sessionGenerationRef.current += 1;
        stopRestPolling();
        updatingIdsRef.current.clear();
        setUpdating(null);
        setUser(null);
        setOrders([]);
        setCounts({});
        setConnected(false);
        setConnectionMode(null);
        setLoading(false);
        if (typeof window !== 'undefined') window.localStorage.removeItem('token');
      } else if (status === 403) {
        const message = axiosError.response?.data?.error || t('kds.authFailed');
        const kdsDisabled = /kds is disabled/i.test(message);
        if (!kdsDisabled) {
          // A station/role denial is a KDS authorization failure. Never retain
          // data fetched earlier or retry it on the next mount.
          sessionGenerationRef.current += 1;
          markKdsAuthBlocked();
          stopRestPolling();
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setLoginError(t('kds.authFailed'));
          setConnectionMode(null);
        } else {
          // KDS can be re-enabled without changing the user's credentials;
          // keep polling rather than permanently blocking the session.
          setLoginError(t('kds.authFailed'));
          setConnectionMode('rest');
        }
        setOrders([]);
        setCounts({});
        setConnected(false);
        setLoading(false);
      } else {
        setConnected(false);
      }
    }
  }, [api, ordersPath, stopRestPolling, t]);
  // connectionMode is already 'rest' by the time this runs (it's only invoked from the
  // effect below, guarded on that condition), and `connected` is owned by fetchOrdersRest's
  // own success/failure handling — so this only needs to (re)start the polling loop. The
  // initial fetch is deferred a tick (setTimeout 0) rather than called synchronously, since
  // this is invoked directly from that effect and its state updates must not land in the
  // same commit.
  const startRestPolling = useCallback(() => {
    stopRestPolling();
    restInitialFetchRef.current = setTimeout(() => {
      restInitialFetchRef.current = null;
      fetchOrdersRest();
    }, 0);
    restIntervalRef.current = setInterval(fetchOrdersRest, 5000);
  }, [fetchOrdersRest, stopRestPolling]);

  const updateItemStatus = useCallback(
    async (itemId: number, status: KitchenStatus, opts: { silent?: boolean; expectedStatus?: KitchenStatus } = {}) => {
      const generation = sessionGenerationRef.current;
      updatingIdsRef.current.add(itemId);
      setUpdating(itemId);
      try {
        await api.patch(itemStatusPath.replace(':itemId', String(itemId)), {
          status,
          ...(opts.expectedStatus ? { expected_status: opts.expectedStatus } : {}),
        });
        if (generation === sessionGenerationRef.current && connectionMode === 'rest' && wsRef.current === null) {
          await fetchOrdersRest();
        }
        if (generation === sessionGenerationRef.current && !opts.silent) {
          toast.success(t('kds.itemMarked', { status: statusLabel(status) }));
        }
        return true;
      } catch (error: unknown) {
        if (generation !== sessionGenerationRef.current) return false;
        const axiosError = error as { response?: { status?: number; data?: { error?: string } } };
        const statusCode = axiosError.response?.status;
        const errorMessage = axiosError.response?.data?.error || t('kds.failedToUpdateItem');
        const kdsDisabled = /kds is disabled/i.test(errorMessage);
        if (statusCode === 409) {
          await fetchOrdersRest();
          if (!opts.silent) toast.error(t('kds.failedToUpdateItem'));
          return false;
        }
        const authorizationFailure = /invalid|expired|revoked|authentication required|no active kitchen station|only chef|only kitchen staff|user account is not active|not authorized to update (this item|this station)/i.test(errorMessage);
        if (statusCode === 401 || (statusCode === 403 && !kdsDisabled && authorizationFailure)) {
          sessionGenerationRef.current += 1;
          if (statusCode === 401) window.localStorage.removeItem('token');
          else markKdsAuthBlocked();
          stopRestPolling();
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setConnectionMode(null);
          setLoading(false);
          setLoginError(t('kds.authFailed'));
          return false;
        }
        if (kdsDisabled) {
          sessionGenerationRef.current += 1;
          restRequestSequenceRef.current += 1;
          updatingIdsRef.current.clear();
          setUpdating(null);
          const disabledGeneration = sessionGenerationRef.current;
          const activeWs = wsRef.current;
          wsRef.current = null;
          if (activeWs) activeWs.close();
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(() => {
            const token = window.localStorage.getItem('token');
            if (token && disabledGeneration === sessionGenerationRef.current) {
              tryWebSocketRef.current(token, true);
            }
          }, 1500);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setConnectionMode('rest');
          setLoading(false);
          setLoginError(errorMessage);
          return false;
        }
        if (!opts.silent) {
          toast.error(t('kds.failedToUpdateItem'));
        }
        return false;
      } finally {
        updatingIdsRef.current.delete(itemId);
        if (generation === sessionGenerationRef.current) {
          setUpdating(updatingIdsRef.current.values().next().value ?? null);
        }
      }
    },
    // statusLabel is derived from `t` (already in deps), so omit it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, connectionMode, fetchOrdersRest, itemStatusPath, stopRestPolling, t],
  );

  const tryWebSocket = useCallback(
    (token: string, retryDuringMaintenance = false) => {
      const generation = sessionGenerationRef.current;
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
      let connectionTimeout: ReturnType<typeof setTimeout> | null = null;
      let authTimeout: ReturnType<typeof setTimeout> | null = null;
      let authenticated = false;

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
        if (authTimeout) clearTimeout(authTimeout);
      };

      ws.onopen = () => {
        if (wsRef.current !== ws || generation !== sessionGenerationRef.current) {
          ws.close();
          return;
        }
        cleanup();
        if (wsRef.current === ws && reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        setConnectionMode('websocket');
        setConnected(false);
        ws.send(JSON.stringify({ type: 'auth', token }));
        authTimeout = setTimeout(() => {
          if (wsRef.current !== ws || generation !== sessionGenerationRef.current) return;
          wsRef.current = null;
          ws.close();
          setConnected(false);
          setConnectionMode('rest');
          setLoading(false);
        }, 5000);
      };

      ws.onclose = () => {
        cleanup();
        if (wsRef.current !== ws || generation !== sessionGenerationRef.current) return;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        setConnected(false);
        setConnectionMode('rest');
        setLoading(false);
        if (!authenticated) {
          if (retryDuringMaintenance) {
            const delay = kdsReconnectDelay(reconnectAttemptRef.current++);
            reconnectTimerRef.current = setTimeout(() => {
              if (generation === sessionGenerationRef.current && window.localStorage.getItem('token') === token) {
                tryWebSocketRef.current(token, true);
              }
            }, delay);
          }
          return;
        }
        const delay = kdsReconnectDelay(reconnectAttemptRef.current++);
        reconnectTimerRef.current = setTimeout(() => {
          if (wsRef.current === ws && generation === sessionGenerationRef.current) {
            tryWebSocketRef.current(token);
          }
        }, delay);
      };

      ws.onerror = () => {
        if (wsRef.current === ws && generation === sessionGenerationRef.current) ws.close();
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws || generation !== sessionGenerationRef.current) return;
        try {
          const msg: WsMessage = JSON.parse(event.data);
          if (msg.type === 'auth_success' && msg.user) {
            authenticated = true;
            reconnectAttemptRef.current = 0;
            // A REST fallback request may still be in flight when the socket
            // authenticates. Invalidate it before accepting the snapshot so a
            // late REST response cannot overwrite newer WebSocket state.
            stopRestPolling();
            if (authTimeout) { clearTimeout(authTimeout); authTimeout = null; }
            setUser((prev) => (prev ? { ...prev, ...msg.user, token: prev.token } : null));
            setOrders(msg.orders || []);
            setCounts(msg.counts || {});
            setConnected(true);
            setLoading(false);
          } else if (msg.type === 'auth_error') {
            if (wsRef.current !== ws) return;
            if (authTimeout) { clearTimeout(authTimeout); authTimeout = null; }
            const maintenanceInProgress = /database maintenance/i.test(msg.message || '');
            const kdsDisabled = /kds is disabled/i.test(msg.message || '');
            const temporaryUnavailable = maintenanceInProgress || kdsDisabled;
            const authorizationFailure = /user not found|only kitchen staff|no active kitchen station|could not load station permissions/i.test(msg.message || '');
            const invalidSession = /invalid|expired|revoked|authentication required/i.test(msg.message || '');
            sessionGenerationRef.current += 1;
            setLoginError(maintenanceInProgress ? '' : (msg.message || t('kds.authFailed')));
            if (wsRef.current === ws) wsRef.current = null;
            if (reconnectTimerRef.current) {
              clearTimeout(reconnectTimerRef.current);
              reconnectTimerRef.current = null;
            }
            stopRestPolling();
            updatingIdsRef.current.clear();
            setUpdating(null);
            if (!temporaryUnavailable) setUser(null);
            setOrders([]);
            setCounts({});
            setConnected(false);
            setConnectionMode(null);
            if (authorizationFailure) markKdsAuthBlocked();
            if (invalidSession) window.localStorage.removeItem('token');
            if (temporaryUnavailable) {
              setLoading(true);
              const delay = kdsReconnectDelay(reconnectAttemptRef.current++);
              reconnectTimerRef.current = setTimeout(() => {
                if (generation + 1 === sessionGenerationRef.current && window.localStorage.getItem('token') === token) {
                  tryWebSocketRef.current(token, true);
                }
              }, delay);
            }
            ws.close();
            setLoading(temporaryUnavailable);
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
        if (
          ws.readyState === WebSocket.CONNECTING &&
          wsRef.current === ws &&
          generation === sessionGenerationRef.current
        ) {
          if (wsRef.current === ws) wsRef.current = null;
          ws.close();
          setConnectionMode('rest');
          setLoading(false);
        }
      }, 5000);
    },
    [t, api, stopRestPolling],
  );
  useEffect(() => {
    tryWebSocketRef.current = tryWebSocket;
  }, [tryWebSocket]);

  const handleLogin = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      clearKdsAuthBlocked();
      setLoginError('');
      sessionGenerationRef.current += 1;
      const generation = sessionGenerationRef.current;
      setLoginLoading(true);
      setLoading(true);

      try {
        const { data } = await api.post(loginPath, {
          email: loginEmail,
          password: loginPassword,
          rememberMe,
        });

        if (generation !== sessionGenerationRef.current) return;
        const token = data.access_token ?? data.token;
        const loggedInUser: KdsUser = {
          id: data.user.id,
          name: data.user.name,
          role: data.user.role,
          token,
        };

        setUser(loggedInUser);
        window.localStorage.setItem('token', token);
        tryWebSocket(token);
      } catch {
        if (generation !== sessionGenerationRef.current) return;
        setLoginError(t('kds.loginFailed'));
      } finally {
        if (generation === sessionGenerationRef.current) {
          setLoginLoading(false);
          setLoading(false);
        }
      }
    },
    [loginEmail, loginPassword, rememberMe, loginPath, api, t, tryWebSocket],
  );

  const handleLogout = useCallback(async () => {
    if (!await confirm(t('nav.confirmLogout', { defaultValue: 'Are you sure you want to log out?' }))) return;
    sessionGenerationRef.current += 1;
    const logoutGeneration = sessionGenerationRef.current;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const activeWs = wsRef.current;
    wsRef.current = null;
    if (activeWs) activeWs.close();
    const token = user?.token || window.localStorage.getItem('token');
    if (token) {
      try {
        await api.post(logoutPath, undefined, { headers: { Authorization: `Bearer ${token}` } });
      } catch {
        // Local logout must still complete if the server is offline.
      }
    }
    if (logoutGeneration !== sessionGenerationRef.current) return;
    stopRestPolling();
    updatingIdsRef.current.clear();
    setUpdating(null);
    setUser(null);
    setOrders([]);
    setCounts({});
    setConnected(false);
    setConnectionMode(null);
    window.localStorage.removeItem('token');
  }, [api, confirm, logoutPath, stopRestPolling, t, user]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedToken = window.localStorage.getItem('token');
    if (!savedToken) {
      return;
    }
    if (isKdsAuthBlocked()) return;
    const generation = sessionGenerationRef.current;
    api.get(mePath)
      .then(({ data }) => {
        if (
          generation !== sessionGenerationRef.current ||
          window.localStorage.getItem('token') !== savedToken
        ) return;
        setUser({
          id: data.user.id,
          name: data.user.name,
          role: data.user.role,
          token: savedToken,
        });
        tryWebSocket(savedToken);
      })
      .catch((error: unknown) => {
        if (
          generation !== sessionGenerationRef.current ||
          window.localStorage.getItem('token') !== savedToken
        ) return;
        const axiosError = error as { response?: { status?: number; data?: { error?: string } } };
        const status = axiosError?.response?.status;
        if (status === 401) {
          sessionGenerationRef.current += 1;
          stopRestPolling();
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setConnectionMode(null);
          window.localStorage.removeItem('token');
        } else if (status === 403) {
          sessionGenerationRef.current += 1;
          markKdsAuthBlocked();
          stopRestPolling();
          updatingIdsRef.current.clear();
          setUpdating(null);
          setUser(null);
          setOrders([]);
          setCounts({});
          setConnected(false);
          setConnectionMode(null);
          setLoginError(t('kds.authFailed'));
        }
        setLoading(false);
      });

    return () => {
      sessionGenerationRef.current += 1;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      stopRestPolling();
    };
  }, [api, mePath, tryWebSocket, stopRestPolling, t]);

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
