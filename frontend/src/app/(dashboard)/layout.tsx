'use client';

import { usePathname } from 'next/navigation';
import AppSidebar from '@/components/layout/Sidebar';
import AuthGuard from '@/components/layout/AuthGuard';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import StatusBar from '@/components/layout/StatusBar';
import GlobalNotifications from '@/components/layout/GlobalNotifications';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPos = pathname === '/pos' || pathname === '/kds';
  const isSettings = pathname === '/settings';

  return (
    <AuthGuard>
      <SidebarProvider defaultOpen>
        <AppSidebar />
        <SidebarInset className="h-screen overflow-hidden flex flex-col">
          {/* Mobile-only app bar: below md the sidebar renders as a Sheet with
              no opener, so expose the trigger here (Refs #241). */}
          <div className="md:hidden flex items-center px-2 py-1.5 border-b border-gray-200 bg-white shrink-0">
            <SidebarTrigger className="size-8" aria-label="Open navigation" />
          </div>
          {!isPos && <GlobalNotifications />}
          <div className={isPos
            ? 'flex-1 min-h-0 flex flex-col overflow-hidden p-4'
            : isSettings
            ? 'flex-1 min-h-0 p-4 overflow-auto md:overflow-hidden min-w-0'
            : 'flex-1 p-4 overflow-auto min-w-0'
          }>
            {children}
          </div>
          <StatusBar />
        </SidebarInset>
      </SidebarProvider>
    </AuthGuard>
  );
}
