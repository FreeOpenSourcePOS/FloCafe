'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChefHat } from 'lucide-react';
import api from '@/lib/api';
import { KdsLoginForm } from '@/components/kds/KdsLoginForm';
import { KdsWorkspace } from '@/components/kds/KdsWorkspace';
import { useKdsConnection } from '@/hooks/useKdsConnection';
import { useSyncServerLanguage } from '@/lib/i18n';
import { useAuthStore } from '@/store/auth';
import { useTranslations } from 'use-intl';
import type { KdsViewMode } from '@/hooks/useKdsView';

// Keeps KDS idle until its setting is confirmed enabled.
function useKdsEnabledCheck(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get('/settings/kds_enabled')
      .then((res) => {
        if (cancelled) return;
        const value = res.data?.setting?.value;
        setEnabled(value === 'true' ? true : value === 'false' ? false : null);
      })
      .catch(() => {
        if (!cancelled) setEnabled(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}

// Fetches KDS default view from main API (port 3001) instead of standalone server.
function useDashboardKdsDefault(userId?: string | null): KdsViewMode | null {
  const [view, setView] = useState<KdsViewMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get('/settings/kds')
      .then(({ data }) => {
        if (cancelled) return;
        setView(data?.kds_default_view === 'tabs' ? 'tabs' : 'kanban');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);
  return view;
}

export default function KdsPage() {
  useSyncServerLanguage();
  const t = useTranslations('kds');
  const kdsEnabled = useKdsEnabledCheck();
  // Stay idle until the feature is confirmed on: a disabled KDS refuses the
  // /kds upgrade with 404, which only logs handshake failures.
  const conn = useKdsConnection({
    api,
    enabled: kdsEnabled === true,
    onSessionCleared: (clearedToken) => {
      useAuthStore.getState().clearLocalSession(clearedToken);
    },
    onSessionTokenReplaced: (nextToken, hasPin) => {
      useAuthStore
        .getState()
        .replaceSessionToken(nextToken, hasPin !== undefined ? { has_pin: hasPin } : undefined);
    },
    onSessionAuthenticated: ({ token, user, tenant, tenants }) => {
      useAuthStore.getState().syncAuthenticatedSession({
        token,
        user,
        currentTenant: tenant,
        tenants,
      });
    },
  });
  const kdsDefaultView = useDashboardKdsDefault(conn.user?.id);

  useEffect(() => {
    if (
      conn.user &&
      String(useAuthStore.getState().user?.id) !== String(conn.user.id) &&
      typeof window !== 'undefined' &&
      Boolean(window.localStorage.getItem('token')) &&
      Boolean(window.localStorage.getItem('tenant'))
    ) {
      useAuthStore.getState().loadFromStorage();
    }
  }, [conn.user]);

  if (kdsEnabled === null) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (kdsEnabled === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-3 text-center px-6">
        <ChefHat size={40} className="text-slate-500 dark:text-slate-400" />
        <h1 className="text-lg font-semibold text-foreground">{t('disabledTitle')}</h1>
        <p className="text-sm text-slate-700 dark:text-slate-300 max-w-sm">
          {t('disabledHintDashboard')}
        </p>
        <Link
          href="/settings?tab=kds"
          className="text-sm text-brand dark:text-indigo-300 hover:underline mt-1"
        >
          {t('goToSettings')}
        </Link>
      </div>
    );
  }

  if (conn.loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[60vh]">
        <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!conn.user) return <KdsLoginForm conn={conn} />;
  return <KdsWorkspace conn={conn} serverDefault={kdsDefaultView} />;
}
