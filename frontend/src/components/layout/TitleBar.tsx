'use client';

import { UserCircle } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Ltr } from './Ltr';
import UpdateBadge from './UpdateBadge';

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () => typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

export default function TitleBar() {
  const { currentTenant, user } = useAuthStore();
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const tStaff = useTranslations('staff');
  const isElectron = useSyncExternalStore(
    subscribeToElectronCapability,
    getElectronCapability,
    getServerElectronCapability,
  );

  useEffect(() => {
    if (isElectron) {
      document.documentElement.dataset.floDesktopTitlebar = 'true';
      if (window.electronAPI?.platform) {
        document.documentElement.dataset.floPlatform = window.electronAPI.platform;
      }
    } else {
      delete document.documentElement.dataset.floDesktopTitlebar;
      delete document.documentElement.dataset.floPlatform;
    }
  }, [isElectron]);

  useEffect(() => {
    const handleFocus = () => {
      document.documentElement.dataset.floWindowFocused = 'true';
    };
    const handleBlur = () => {
      document.documentElement.dataset.floWindowFocused = 'false';
    };
    document.documentElement.dataset.floWindowFocused = typeof document !== 'undefined' && document.hasFocus() ? 'true' : 'false';
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      delete document.documentElement.dataset.floWindowFocused;
    };
  }, []);

  if (!isElectron) return null;

  const businessName = currentTenant?.business_name || tCommon('brandName');
  const staffName = user?.name || user?.email || tNav('user');
  const staffIsEmail = !user?.name && Boolean(user?.email);

  const roleKey = currentTenant?.role;
  const roleLabel = roleKey
    ? (roleKey === 'owner'
      ? tStaff('roleOwner')
      : roleKey === 'manager'
      ? tStaff('roleManager')
      : roleKey === 'cashier'
      ? tStaff('roleCashier')
      : roleKey === 'server'
      ? tStaff('roleServer')
      : roleKey === 'chef'
      ? tStaff('roleChef')
      : roleKey.charAt(0).toUpperCase() + roleKey.slice(1))
    : null;

  return (
    <header
      data-testid="desktop-title-bar"
      className="flo-title-bar hidden shrink-0 md:flex"
      aria-label={businessName}
    >
      <div className="flo-title-bar__safe-area pointer-events-none flex w-full items-center justify-between">
        {/* Leading edge: Sidebar toggle button (placed after traffic lights on macOS, top-left on Windows/Linux) */}
        <div className="flo-title-bar__interactive pointer-events-auto flex items-center translate-y-[1.5px]">
          <SidebarTrigger
            aria-label={tNav('toggleSidebar')}
            className="size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
          />
        </div>

        {/* Trailing edge: Update badge */}
        <div className="flo-title-bar__interactive pointer-events-auto ms-auto flex items-center">
          <UpdateBadge />
        </div>
      </div>

      {/* Centered business name and user identity */}
      <div className="pointer-events-none absolute inset-0 m-auto flex h-fit w-fit flex-col items-center justify-center leading-tight text-center max-w-[min(60vw,32rem)] select-none">
        <span className="truncate text-xs font-semibold text-foreground max-w-full" title={businessName}>
          {businessName}
        </span>
        <span
          className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground max-w-full"
          title={`${staffName}${roleLabel ? ` (${roleLabel})` : ''}`}
        >
          <UserCircle aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">
            {staffIsEmail ? <Ltr>{staffName}</Ltr> : staffName}
            {roleLabel ? ` (${roleLabel})` : ''}
          </span>
        </span>
      </div>
    </header>
  );
}
