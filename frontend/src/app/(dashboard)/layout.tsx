'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import AppSidebar from '@/components/layout/Sidebar';
import AuthGuard from '@/components/layout/AuthGuard';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import StatusBar from '@/components/layout/StatusBar';
import GlobalNotifications from '@/components/layout/GlobalNotifications';
import TitleBar from '@/components/layout/TitleBar';
import UpdateAvailableDialog from '@/components/updates/UpdateAvailableDialog';
import ProductAnalyticsDialog from '@/components/analytics/ProductAnalyticsDialog';
import { usePrinterStatusSync } from '@/hooks/usePrinter';
import { canSyncReceiptSettings, useReceiptSettingsSync } from '@/hooks/useReceiptSettingsSync';
import { normalizePathname } from '@/lib/utils';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import api from '@/lib/api';

function useIdleAutoLock(): void {
  const token = useAuthStore((s) => s.token);
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const autoLockMinutes = usePosSettingsStore((s) => s.autoLockMinutes);
  const setAutoLockMinutes = usePosSettingsStore((s) => s.setAutoLockMinutes);

  useEffect(() => {
    if (!token || !currentTenant || canSyncReceiptSettings(currentTenant)) return;
    let active = true;
    api
      .get('/settings/auto_lock_minutes')
      .then((res) => {
        if (active && res.data?.setting?.value !== undefined) {
          setAutoLockMinutes(res.data.setting.value);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [token, currentTenant, setAutoLockMinutes]);

  useEffect(() => {
    if (typeof window === 'undefined' || !token || autoLockMinutes <= 0) return;
    const timeoutMs = autoLockMinutes * 60 * 1000;
    let timerId: number | null = null;

    const resetTimer = () => {
      if (timerId !== null) window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        if (useAuthStore.getState().token) {
          void useAuthStore.getState().lock();
        }
      }, timeoutMs);
    };

    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'mousemove'] as const;
    for (const ev of events) {
      window.addEventListener(ev, resetTimer, { passive: true });
    }
    resetTimer();

    return () => {
      if (timerId !== null) window.clearTimeout(timerId);
      for (const ev of events) {
        window.removeEventListener(ev, resetTimer);
      }
    };
  }, [token, autoLockMinutes]);
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Normalized: the desktop build's trailingSlash:true makes usePathname()
  // return "/pos/" there but "/pos" in dev — see normalizePathname's doc
  // comment. Without this, isPos/isSettings silently miss in the built app
  // and POS falls back to page-level scroll instead of its own scroll panel.
  const pathname = normalizePathname(usePathname());
  const isPos = pathname === '/pos' || pathname === '/kds';
  const isSettings = pathname === '/settings';
  // Sync printer status early so hardware and WebUSB reconnect before first print.
  usePrinterStatusSync();
  // Hydrate receipt display settings from backend so browser print has current store details.
  useReceiptSettingsSync();
  // Auto-lock terminal after configured idle timeout.
  useIdleAutoLock();

  return (
    <AuthGuard>
      <SidebarProvider
        defaultOpen
        className="flex h-screen min-h-0 flex-col w-full"
        style={{ minHeight: 0 }}
      >
        <TitleBar />
        <div className="flex min-h-0 flex-1 w-full overflow-hidden">
          <AppSidebar />
          <SidebarInset className="h-full min-h-0 overflow-hidden flex flex-col">
            {/* Mobile-only app bar: below md the sidebar renders as a Sheet with
                no opener, so expose the trigger here (Refs #241). */}
            <div className="md:hidden flex items-center px-2 py-1.5 border-b border-border bg-card shrink-0">
              <SidebarTrigger className="size-8" aria-label="Open navigation" />
            </div>
            {!isPos && <GlobalNotifications />}
            <div
              className={
                isPos
                  ? 'flex-1 min-h-0 flex flex-col overflow-hidden p-4'
                  : isSettings
                    ? 'flex-1 min-h-0 p-4 overflow-auto md:overflow-hidden min-w-0'
                    : 'flex-1 p-4 overflow-auto min-w-0'
              }
            >
              {children}
            </div>
            <StatusBar showUpdateBadge={false} />
          </SidebarInset>
        </div>
        <UpdateAvailableDialog />
        {!isPos && <ProductAnalyticsDialog />}
      </SidebarProvider>
    </AuthGuard>
  );
}
