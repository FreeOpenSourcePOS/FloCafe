'use client';

import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';

const DASHBOARD_PATHS = [
  '/addon-groups',
  '/customers',
  '/dashboard',
  '/kds',
  '/order-history-demo',
  '/orders',
  '/pos',
  '/print-test',
  '/products',
  '/settings',
  '/staff',
  '/support',
  '/tables',
  '/whatsapp',
];

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () => typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

function isDashboardPath(pathname: string | null): boolean {
  return pathname !== null && DASHBOARD_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export default function DesktopDragSurface() {
  const pathname = usePathname();
  const isElectron = useSyncExternalStore(
    subscribeToElectronCapability,
    getElectronCapability,
    getServerElectronCapability,
  );

  if (!isElectron) return null;

  return (
    <div
      aria-hidden="true"
      data-testid="desktop-drag-surface"
      className={`flo-title-bar flo-title-bar--root-drag flex shrink-0${isDashboardPath(pathname) ? ' flo-title-bar--root-overlay' : ''}`}
    />
  );
}
