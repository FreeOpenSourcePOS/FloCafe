'use client';

import axios from 'axios';
import { KdsLoginForm } from '@/components/kds/KdsLoginForm';
import { KdsWorkspace } from '@/components/kds/KdsWorkspace';
import { useKdsConnection } from '@/hooks/useKdsConnection';
import { useServerKdsInfo } from '@/hooks/useServerKdsInfo';
import { useSyncServerLanguage } from '@/lib/i18n';
import { useEffect, useMemo, useState } from 'react';

// `/api/kds/info` 404s when kds_enabled is off (issue #133) — that's the
// signal this route uses to make itself unreachable. Distinguishes a real
// 404 from a network error (offline/unreachable server), which should not
// lock the device out — that's a connectivity problem, not a disabled
// feature, and the login form below already surfaces connection failures.
function useKdsDisabledCheck(baseUrl: string): boolean {
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    fetch(`${baseUrl}/api/kds/info`, { cache: 'no-store' })
      .then((res) => { if (!cancelled && res.status === 404) setDisabled(true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [baseUrl]);
  return disabled;
}

// Standalone axios client — points at this KDS server's origin (e.g. :3002),
// separate from the dashboard's `lib/api` which targets the main backend.
function createStandaloneApi() {
  const api = axios.create({
    baseURL: window.location.origin,
    timeout: 10000,
  });
  api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
  api.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) {
        localStorage.removeItem('token');
        window.location.reload();
      }
      return Promise.reject(error);
    },
  );
  return api;
}

export default function KdsStandalonePage() {
  useSyncServerLanguage();
  // Lazy-init the axios instance — must not run during SSR prerender.
  const api = useMemo(() => (typeof window !== 'undefined' ? createStandaloneApi() : null), []);
  // kds-server.ts (this page's backend, a separate Express app from the main
  // server) exposes a smaller, differently-named route set than the
  // dashboard-embedded KDS talks to — override the hook's main-server defaults.
  const standaloneEndpoints = {
    login: '/api/auth/login',
    me: '/api/auth/me',
    orders: '/api/kds/orders',
    itemStatus: '/api/kds/items/:itemId/status',
  };
  const conn = useKdsConnection(api ? { api, endpoints: standaloneEndpoints } : { api: axios.create() });
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { kdsDefaultView } = useServerKdsInfo(origin);
  const kdsDisabled = useKdsDisabledCheck(origin);

  if (kdsDisabled) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3 text-center px-6 bg-gray-900 text-white">
        <h1 className="text-lg font-semibold">Kitchen Display is disabled</h1>
        <p className="text-sm text-gray-400 max-w-sm">
          This business has turned off the Kitchen Display System. Ask an owner or manager to re-enable it from Settings.
        </p>
      </div>
    );
  }

  if (conn.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="w-10 h-10 border-4 border-white/40 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!conn.user) return <KdsLoginForm conn={conn} />;
  return <KdsWorkspace conn={conn} serverDefault={kdsDefaultView} />;
}