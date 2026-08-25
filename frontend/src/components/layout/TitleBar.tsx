'use client';

import { UserCircle } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { Ltr } from './Ltr';
import UpdateBadge from './UpdateBadge';

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () => typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

/**
 * Native-controls title-bar content for the desktop POS window.
 *
 * The same frontend is served to LAN browsers, so this component must remain
 * absent unless the preload capability is present. Electron supplies native
 * caption buttons when available; the root desktop chrome owns the HTML
 * fallback buttons so they remain available on every renderer route.
 */
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
  // Expose the desktop capability to CSS so fixed app chrome (the sidebar)
  // can offset below the title bar. Browsers/LAN never receive the flag and
  // keep today's viewport-top geometry.
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
      {/* Centered business name and user identity */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center leading-tight text-center max-w-[min(60vw,32rem)] select-none">
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

      <div className="flo-title-bar__safe-area pointer-events-none flex w-full items-center justify-end">
        <div className="flo-title-bar__interactive pointer-events-auto ms-auto flex items-center">
          <UpdateBadge />
        </div>
      </div>
    </header>
  );
}
