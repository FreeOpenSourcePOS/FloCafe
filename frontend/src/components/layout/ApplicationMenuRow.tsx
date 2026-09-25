'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import type { ApplicationMenuEntry } from '@/types/electron';

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () => typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

/**
 * Restores the top-level application menu on the frameless Windows and Linux
 * title bars. Electron refuses to draw a menu bar for a frameless window, so
 * this renders the labels the main process built and asks it to pop the
 * matching submenu; the entries, roles, accelerators, and click handlers are
 * still the ones the native application menu uses. macOS keeps its
 * authoritative native menu bar and renders nothing.
 */
export default function ApplicationMenuRow() {
  const tCommon = useTranslations('common');
  const isElectron = useSyncExternalStore(
    subscribeToElectronCapability,
    getElectronCapability,
    getServerElectronCapability,
  );
  const [entries, setEntries] = useState<ApplicationMenuEntry[]>([]);

  useEffect(() => {
    if (!isElectron || window.electronAPI?.platform === 'darwin') return;
    let cancelled = false;
    void window.electronAPI?.getApplicationMenu().then((result) => {
      if (cancelled || 'error' in result) return;
      setEntries(result.entries);
    });
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  if (entries.length === 0) return null;

  return (
    <div
      data-testid="desktop-application-menu"
      role="menubar"
      aria-label={tCommon('appTitle')}
      className="flo-title-bar__menu flo-title-bar__interactive pointer-events-auto flex items-center"
    >
      {entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          role="menuitem"
          className="flo-title-bar__menu-button"
          onClick={(event) => {
            // Electron positions the popup against the window content
            // bounds, so the button's viewport rect is already correct.
            const { left, top } = event.currentTarget.getBoundingClientRect();
            void window.electronAPI?.openApplicationMenu(entry.key, left, top);
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
