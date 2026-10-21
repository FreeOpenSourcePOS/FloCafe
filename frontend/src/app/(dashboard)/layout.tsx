'use client';

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
import { useReceiptSettingsSync } from '@/hooks/useReceiptSettingsSync';
import { normalizePathname } from '@/lib/utils';

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
