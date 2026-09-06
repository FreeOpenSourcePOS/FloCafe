'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChefHat } from 'lucide-react';
import api from '@/lib/api';
import { KdsLoginForm } from '@/components/kds/KdsLoginForm';
import { KdsWorkspace } from '@/components/kds/KdsWorkspace';
import { useKdsConnection } from '@/hooks/useKdsConnection';
import { useSyncServerLanguage } from '@/lib/i18n';
import { useTranslations } from 'use-intl';
import type { KdsViewMode } from '@/hooks/useKdsView';

// Checks live kds_enabled setting directly from API; defaults to enabled on fetch errors.
function useKdsEnabledCheck(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.get('/settings/kds_enabled')
      .then((res) => { if (!cancelled) setEnabled(res.data?.setting?.value !== 'false'); })
      .catch(() => { if (!cancelled) setEnabled(true); });
    return () => { cancelled = true; };
  }, []);
  return enabled;
}

// Fetches KDS default view from main API (port 3001) instead of standalone server.
function useDashboardKdsDefault(): KdsViewMode | null {
  const [view, setView] = useState<KdsViewMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get('/settings/kds')
      .then(({ data }) => {
        if (cancelled) return;
        setView(data?.kds_default_view === 'kanban' ? 'kanban' : 'tabs');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return view;
}

export default function KdsPage() {
  useSyncServerLanguage();
  const t = useTranslations('kds');
  const conn = useKdsConnection({ api });
  const kdsDefaultView = useDashboardKdsDefault();
  const kdsEnabled = useKdsEnabledCheck();

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
        <ChefHat size={40} className="text-gray-300" />
        <h1 className="text-lg font-semibold text-gray-900">{t('disabledTitle')}</h1>
        <p className="text-sm text-gray-500 max-w-sm">
          {t('disabledHintDashboard')}
        </p>
        <Link href="/settings?tab=kds" className="text-sm text-brand hover:underline mt-1">
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
