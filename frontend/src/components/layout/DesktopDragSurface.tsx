'use client';

import { useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { normalizePathname } from '@/lib/utils';
import ApplicationMenuRow from './ApplicationMenuRow';
import WindowControls from './WindowControls';
import { useDesktopTitleBarSync } from './titlebar-sync';

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () =>
  typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

export function isStandaloneMenuRoute(pathname: string | null | undefined): boolean {
  const normalized = normalizePathname(pathname);
  return (
    normalized === '/setup' ||
    normalized.startsWith('/setup/') ||
    normalized === '/auth' ||
    normalized.startsWith('/auth/')
  );
}

export default function DesktopDragSurface() {
  const pathname = usePathname();
  const isElectron = useSyncExternalStore(
    subscribeToElectronCapability,
    getElectronCapability,
    getServerElectronCapability,
  );

  useDesktopTitleBarSync(isElectron);

  if (!isElectron) return null;

  const showStandaloneMenu = isStandaloneMenuRoute(pathname);

  return (
    <>
      <div
        aria-hidden={showStandaloneMenu ? undefined : 'true'}
        data-testid="desktop-drag-surface"
        className="flo-title-bar flo-title-bar--root-drag flex shrink-0"
      >
        {showStandaloneMenu && (
          <div className="flo-title-bar__safe-area pointer-events-none flex w-full items-center justify-between">
            <ApplicationMenuRow />
          </div>
        )}
      </div>
      <WindowControls />
    </>
  );
}
