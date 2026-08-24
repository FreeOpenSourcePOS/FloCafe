'use client';

import { Minus, Square, Store, UserCircle, X } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
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
 * absent unless the preload capability is present. When main reports the
 * native titleBarOverlay is unavailable ('html-fallback'), minimal HTML
 * caption buttons are mounted and wired through the narrow windowAction IPC;
 * otherwise Electron supplies the native caption buttons and this component
 * only owns the useful store/staff context and the existing update indicator.
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
  // Defaults to native-overlay so an older main without the capability field
  // keeps Phase 1 behavior; only a confirmed 'html-fallback' mounts controls.
  const [titleBarMode, setTitleBarMode] = useState<'native-overlay' | 'html-fallback'>('native-overlay');

  useEffect(() => {
    if (!isElectron) return undefined;
    let cancelled = false;
    window.electronAPI
      ?.getStatus()
      .then((status) => {
        if (!cancelled && status?.titleBarMode === 'html-fallback') setTitleBarMode('html-fallback');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  const runWindowAction = useCallback((action: 'minimize' | 'toggle-maximize' | 'close') => {
    window.electronAPI?.windowAction(action)?.catch(() => {});
  }, []);

  // Expose the desktop capability to CSS so fixed app chrome (the sidebar)
  // can offset below the title bar. Browsers/LAN never receive the flag and
  // keep today's viewport-top geometry.
  useEffect(() => {
    if (isElectron) {
      document.documentElement.dataset.floDesktopTitlebar = 'true';
    } else {
      delete document.documentElement.dataset.floDesktopTitlebar;
    }
  }, [isElectron]);

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

      {titleBarMode === 'html-fallback' ? (
        <div className="flo-title-bar__fallback-controls" role="group" aria-label={tCommon('windowControls')}>
          <button
            type="button"
            className="flo-title-bar__fallback-button"
            aria-label={tCommon('minimize')}
            onClick={() => runWindowAction('minimize')}
          >
            <Minus aria-hidden="true" className="size-3.5" />
          </button>
          <button
            type="button"
            className="flo-title-bar__fallback-button"
            aria-label={tCommon('maximize')}
            onClick={() => runWindowAction('toggle-maximize')}
          >
            <Square aria-hidden="true" className="size-3" />
          </button>
          <button
            type="button"
            className="flo-title-bar__fallback-button flo-title-bar__fallback-button--close"
            aria-label={tCommon('close')}
            onClick={() => runWindowAction('close')}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : null}
    </header>
  );
}
