'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import api from '@/lib/api';
import { showPrintLanguageLoadErrorsToast } from '@/lib/printer/warnings-toast';
import { tenantCan } from '@/lib/permissions';
import type { Tenant } from '@/lib/types';

export function getLandingPage(tenant?: Tenant | null): string {
  const candidates = [
    ['pos.use', '/pos'],
    ['dashboard.view', '/dashboard'],
    ['orders.read', '/orders'],
    ['kitchen.use', '/kds'],
    ['catalog.manage', '/products'],
    ['inventory.view', '/inventory'],
    ['customers.view', '/customers'],
    ['staff.view', '/staff'],
    ['settings.view', '/settings'],
    ['support.use', '/support'],
  ] as const;
  return candidates.find(([permission]) => tenantCan(tenant, permission))?.[1] ?? '/auth/login';
}

const PUBLIC_PATHS = ['/kds', '/kds-standalone', '/server-standalone', '/auth/login', '/auth/register', '/auth/recover', '/setup'];

const PAGE_PERMISSIONS = [
  ['/pos', 'pos.use'],
  ['/dashboard', 'dashboard.view'],
  ['/orders', 'orders.read'],
  ['/products', 'catalog.manage'],
  ['/inventory', 'inventory.view'],
  ['/tables', 'tables.view'],
  ['/customers', 'customers.view'],
  ['/whatsapp', 'whatsapp.use'],
  ['/support', 'support.use'],
] as const;

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const t = useTranslations('common');
  const { user, currentTenant, loading, loadFromStorage, refreshAuthContext } = useAuthStore();
  const printLanguageLoadErrors = useAuthStore((s) => s.printLanguageLoadErrors);
  const router = useRouter();
  const pathname = usePathname();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null); // null = still checking

  const isPublicPath = PUBLIC_PATHS.some(p => pathname === p || pathname?.startsWith(p + '/'));
  const isSetupPath = pathname === '/setup' || pathname?.startsWith('/setup/');
  const isStandalonePath = pathname?.startsWith('/kds') || pathname?.startsWith('/server-standalone');

  useEffect(() => {
    // Standalone KDS and Server App pages manage their own auth sessions;
    // skip loading shared POS auth store to avoid clearing their tokens.
    if (isStandalonePath) return;
    loadFromStorage();
  }, [isStandalonePath, loadFromStorage]);

  useEffect(() => {
    if (isStandalonePath || !user || !currentTenant) return;
    const refresh = () => { void refreshAuthContext(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('flo:authorization-denied', refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('flo:authorization-denied', refresh);
      window.clearInterval(interval);
    };
  }, [currentTenant, isStandalonePath, refreshAuthContext, user]);

  useEffect(() => {
    showPrintLanguageLoadErrorsToast(printLanguageLoadErrors);
  }, [printLanguageLoadErrors]);

  // Single effect: determine where to redirect after auth state + setup status are known
  useEffect(() => {
    if (loading) return; // wait for auth state to load

    // If we don't know setup status yet, fetch it
    if (!isStandalonePath && needsSetup === null) {
      const controller = new AbortController();
      let active = true;
      api.get('/auth/setup/status', { signal: controller.signal })
        .then(({ data }) => {
          if (active) setNeedsSetup(data.needsSetup);
        })
        .catch((err) => {
          if (!active || (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))) return;
          console.error('[AuthGuard] Failed to check setup status:', err);
          // Fail closed: do not allow normal app routes when setup state is unknown.
          setNeedsSetup(true);
        });
      return () => {
        active = false;
        controller.abort();
      }; // wait for the result before redirecting
    }

    if (needsSetup && !isSetupPath) {
      router.push('/setup');
      return;
    }

    if (isPublicPath) return; // don't redirect from public paths unless setup is needed

    // Auth loaded + setup status known + not on public path
    if (!user) {
      router.push('/auth/login');
    } else if (!currentTenant) {
      router.push('/auth/login?select_tenant=true');
    } else {
      const pagePermission = PAGE_PERMISSIONS.find(([prefix]) => pathname === prefix || pathname?.startsWith(`${prefix}/`));
      const canOpenStaff = pathname === '/staff'
        && (tenantCan(currentTenant, 'staff.view') || tenantCan(currentTenant, 'authorization.manage'));
      const canOpenSettings = pathname === '/settings'
        && [
          'settings.view', 'settings.manage', 'tax-packs.view-test', 'tax-configuration.manage',
          'tax-packs.manage', 'printers.manage', 'print-templates.view', 'print-templates.manage',
          'payment-methods.manage', 'cloud.manage', 'cloud.account.manage', 'google-drive.manage',
          'database.manage', 'mobile-access.manage', 'kitchen.stations.manage', 'whatsapp.manage',
        ].some((permission) => tenantCan(currentTenant, permission as import('@shared/permissions').PermissionId));
      if ((pagePermission && !tenantCan(currentTenant, pagePermission[1]))
        || (pathname === '/staff' && !canOpenStaff)
        || (pathname === '/settings' && !canOpenSettings)) {
        router.replace(getLandingPage(currentTenant));
      }
    }
  }, [loading, user, currentTenant, isPublicPath, isSetupPath, isStandalonePath, needsSetup, pathname, router]);

  if (isStandalonePath || isSetupPath) {
    return <>{children}</>;
  }

  if (loading || needsSetup === null || needsSetup === true) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-muted-foreground text-sm">{t('loadingScreen')}</p>
        </div>
      </div>
    );
  }

  if (isPublicPath) {
    return <>{children}</>;
  }

  if (!user || !currentTenant) return null;

  return <>{children}</>;
}
