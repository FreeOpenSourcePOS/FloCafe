'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChefHat } from 'lucide-react';
import api from '@/lib/api';
import { KdsLoginForm } from '@/components/kds/KdsLoginForm';
import { KdsWorkspace } from '@/components/kds/KdsWorkspace';
import { useKdsConnection } from '@/hooks/useKdsConnection';
import { useSyncServerLanguage } from '@/lib/i18n';
import type { KdsViewMode } from '@/hooks/useKdsView';

// Reads the kds_enabled setting directly (not the cached posSettings copy) so
// this route reflects the current state even if the sidebar hasn't refreshed
// its own copy yet. `null` = still loading. Never throws — a fetch failure
// falls back to "enabled" so a network hiccup doesn't lock owners out.
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

// Dashboard `/kds` runs on the main API origin (port 3001), which has
// `/api/settings/kds` but not `/api/kds/info` (that one lives on the
// standalone KDS server). Fetch the default view from the main API instead
// of `useServerKdsInfo` so chef toggles reflect admin-set defaults here.
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
  const conn = useKdsConnection({ api });
  const kdsDefaultView = useDashboardKdsDefault();
  const kdsEnabled = useKdsEnabledCheck();

  if (kdsEnabled === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[60vh] gap-3 text-center px-6">
        <ChefHat size={40} className="text-gray-300" />
        <h1 className="text-lg font-semibold text-gray-900">Kitchen Display is disabled</h1>
        <p className="text-sm text-gray-500 max-w-sm">
          This business has turned off the Kitchen Display System. An owner or manager can turn it back on from Settings.
        </p>
        <Link href="/settings?tab=kds" className="text-sm text-brand hover:underline mt-1">
          Go to Settings
        </Link>
      </div>
    );
  }

  if (conn.loading || !conn.user) return <KdsLoginForm conn={conn} />;
  return <KdsWorkspace conn={conn} serverDefault={kdsDefaultView} />;
}