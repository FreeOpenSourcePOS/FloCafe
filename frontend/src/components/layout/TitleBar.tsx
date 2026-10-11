'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { SidebarTrigger } from '@/components/ui/sidebar';
import ApplicationMenuRow from './ApplicationMenuRow';
import UpdateBadge from './UpdateBadge';

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () =>
  typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

export default function TitleBar() {
  const { currentTenant } = useAuthStore();
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
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
    document.documentElement.dataset.floWindowFocused =
      typeof document !== 'undefined' && document.hasFocus() ? 'true' : 'false';
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

  return (
    <header
      data-testid="desktop-title-bar"
      className="flo-title-bar flex shrink-0"
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

        {/* Windows/Linux: the frameless window has no native menu bar, so the
            top-level application menu is restored here (macOS keeps the native one). */}
        <ApplicationMenuRow />

        {/* Trailing edge: Update badge */}
        <div className="flo-title-bar__interactive pointer-events-auto ms-auto flex items-center">
          <UpdateBadge />
        </div>
      </div>

      {/* Centered business name */}
      <div className="flo-title-bar__identity pointer-events-none">
        <span
          className="truncate text-xs font-semibold leading-tight text-foreground max-w-full"
          title={businessName}
        >
          {businessName}
        </span>
      </div>
    </header>
  );
}
