'use client';

import axios from 'axios';
import { KdsLoginForm } from '@/components/kds/KdsLoginForm';
import { KdsWorkspace } from '@/components/kds/KdsWorkspace';
import { useKdsConnection } from '@/hooks/useKdsConnection';
import { useServerKdsInfo } from '@/hooks/useServerKdsInfo';
import { useSyncServerLanguage } from '@/lib/i18n';
import { useTranslations } from 'use-intl';
import { useEffect, useMemo, useState } from 'react';

// The standalone server hides this endpoint with 404 while KDS is disabled.
function useKdsEnabledCheck(baseUrl: string): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    fetch(`${baseUrl}/api/kds/info`, { cache: 'no-store' })
      .then((res) => {
        if (cancelled) return;
        setEnabled(res.status === 404 ? false : res.ok ? true : null);
      })
      .catch(() => { if (!cancelled) setEnabled(null); });
    return () => { cancelled = true; };
  }, [baseUrl]);
  return enabled;
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
  const t = useTranslations('kds');
  // Lazy-init the axios instance — must not run during SSR prerender.
  const api = useMemo(() => (typeof window !== 'undefined' ? createStandaloneApi() : null), []);
  // Standalone KDS server endpoint routes overriding dashboard defaults.
  const standaloneEndpoints = {
    login: '/api/auth/login',
    me: '/api/auth/me',
    logout: '/api/auth/logout',
    orders: '/api/kds/orders',
    itemStatus: '/api/kds/items/:itemId/status',
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const { kdsDefaultView } = useServerKdsInfo(origin);
  const kdsEnabled = useKdsEnabledCheck(origin);
  const conn = useKdsConnection(api
    ? { api, endpoints: standaloneEndpoints, enabled: kdsEnabled === true }
    : { api: axios.create(), enabled: false });

  if (kdsEnabled === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (kdsEnabled === false) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3 text-center px-6 bg-background text-foreground">
        <h1 className="text-lg font-semibold">{t('disabledTitle')}</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          {t('disabledHint')}
        </p>
      </div>
    );
  }

  if (conn.loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!conn.user) return <KdsLoginForm conn={conn} />;
  return <KdsWorkspace conn={conn} serverDefault={kdsDefaultView} />;
}
