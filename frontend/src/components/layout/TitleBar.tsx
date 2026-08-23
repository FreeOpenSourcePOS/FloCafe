'use client';

import { Store, UserCircle } from 'lucide-react';
import { useSyncExternalStore } from 'react';
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
 * absent unless the preload capability is present. Native caption buttons are
 * supplied by Electron's titleBarOverlay; this component only owns the useful
 * store/staff context and the existing update indicator.
 */
export default function TitleBar() {
  const { currentTenant, user } = useAuthStore();
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const isElectron = useSyncExternalStore(
    subscribeToElectronCapability,
    getElectronCapability,
    getServerElectronCapability,
  );

  if (!isElectron) return null;

  const businessName = currentTenant?.business_name || tCommon('brandName');
  const staffName = user?.name || user?.email || tNav('user');
  const staffIsEmail = !user?.name && Boolean(user?.email);

  return (
    <header
      data-testid="desktop-title-bar"
      className="flo-title-bar hidden shrink-0 md:flex"
      aria-label={businessName}
    >
      <div className="flo-title-bar__safe-area">
        <div className="flex min-w-0 items-center gap-2 text-start">
          <div
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground"
          >
            <Store className="size-4" />
          </div>
          <div className="flex min-w-0 flex-col justify-center gap-0.5 leading-none">
            <span className="max-w-[min(32vw,20rem)] truncate text-xs font-semibold text-foreground" title={businessName}>
              {businessName}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title={staffName}>
              <UserCircle aria-hidden="true" className="size-3 shrink-0" />
              {staffIsEmail ? <Ltr className="truncate">{staffName}</Ltr> : <span className="truncate">{staffName}</span>}
            </span>
          </div>
        </div>

        <div className="flo-title-bar__interactive ms-auto flex items-center">
          <UpdateBadge />
        </div>
      </div>
    </header>
  );
}
