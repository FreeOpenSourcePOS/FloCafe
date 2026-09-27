'use client';

import { Menu as MenuIcon, MoreHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import type { ApplicationMenuEntry } from '@/types/electron';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () => typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

let measurementCanvas: HTMLCanvasElement | null = null;
function measureButtonText(label: string): number {
  if (typeof document === 'undefined') return label.length * 8 + 20;
  if (!measurementCanvas) {
    measurementCanvas = document.createElement('canvas');
  }
  const ctx = measurementCanvas.getContext('2d');
  if (!ctx) return label.length * 8 + 20;
  ctx.font = '500 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  return Math.ceil(ctx.measureText(label).width + 20);
}

const MORE_BUTTON_WIDTH = 32;
const TITLEBAR_COLLISION_SAFETY_MARGIN = 20;

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
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isElectron || window.electronAPI?.platform === 'darwin') return;
    let cancelled = false;
    void window.electronAPI
      ?.getApplicationMenu()
      .then((result) => {
        if (cancelled || 'error' in result) return;
        setEntries(result.entries);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  useIsomorphicLayoutEffect(() => {
    if (!isElectron) return;

    const updateAvailableWidth = () => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const identityEl = document.querySelector('.flo-title-bar__identity');
      const isRtl = document.documentElement.dir === 'rtl';

      let available: number;
      if (identityEl) {
        const idRect = identityEl.getBoundingClientRect();
        available = isRtl
          ? containerRect.right - idRect.right - TITLEBAR_COLLISION_SAFETY_MARGIN
          : idRect.left - containerRect.left - TITLEBAR_COLLISION_SAFETY_MARGIN;
      } else {
        const mid = window.innerWidth / 2;
        available = isRtl
          ? containerRect.right - mid - TITLEBAR_COLLISION_SAFETY_MARGIN
          : mid - containerRect.left - TITLEBAR_COLLISION_SAFETY_MARGIN;
      }
      setAvailableWidth(Math.max(0, Math.floor(available)));
    };

    updateAvailableWidth();

    const titleBar = document.querySelector('.flo-title-bar');
    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && titleBar) {
      resizeObserver = new ResizeObserver(() => {
        updateAvailableWidth();
      });
      resizeObserver.observe(titleBar);
      const identityEl = document.querySelector('.flo-title-bar__identity');
      if (identityEl) resizeObserver.observe(identityEl);
    }
    window.addEventListener('resize', updateAvailableWidth);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateAvailableWidth);
    };
  }, [isElectron, entries.length]);

  if (entries.length === 0) return null;

  // Determine layout mode based on available width against item widths
  let mode: 'full' | 'overflow' | 'compact' = 'full';
  let visibleCount = entries.length;

  if (availableWidth !== null) {
    const itemWidths = entries.map((entry) => measureButtonText(entry.label));
    const totalRequired = itemWidths.reduce((a, b) => a + b, 0);

    if (totalRequired > availableWidth) {
      let accumulated = MORE_BUTTON_WIDTH;
      let count = 0;
      for (let i = 0; i < entries.length; i++) {
        if (accumulated + itemWidths[i] <= availableWidth) {
          accumulated += itemWidths[i];
          count++;
        } else {
          break;
        }
      }

      if (count >= 2) {
        mode = 'overflow';
        visibleCount = count;
      } else {
        mode = 'compact';
        visibleCount = 0;
      }
    }
  }

  return (
    <div
      ref={containerRef}
      data-testid="desktop-application-menu"
      data-layout-mode={mode}
      role="menubar"
      aria-label={tCommon('appTitle')}
      className="flo-title-bar__menu flo-title-bar__interactive pointer-events-auto flex items-center"
    >
      {mode === 'compact' ? (
        <button
          type="button"
          role="menuitem"
          aria-label={tCommon('menu')}
          title={tCommon('menu')}
          data-testid="desktop-application-menu-hamburger"
          className="flo-title-bar__menu-button flex items-center justify-center px-1.5"
          onClick={(event) => {
            const { left, bottom } = event.currentTarget.getBoundingClientRect();
            void window.electronAPI
              ?.openApplicationMenu('hamburger', Math.round(left), Math.round(bottom))
              .catch(() => {});
          }}
        >
          <MenuIcon className="size-4" aria-hidden="true" />
        </button>
      ) : (
        <>
          {entries.slice(0, visibleCount).map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="menuitem"
              className="flo-title-bar__menu-button"
              onClick={(event) => {
                const { left, bottom } = event.currentTarget.getBoundingClientRect();
                void window.electronAPI
                  ?.openApplicationMenu(entry.key, Math.round(left), Math.round(bottom))
                  .catch(() => {});
              }}
            >
              {entry.label}
            </button>
          ))}
          {mode === 'overflow' && (
            <button
              type="button"
              role="menuitem"
              aria-label={tCommon('more')}
              title={tCommon('more')}
              data-testid="desktop-application-menu-overflow"
              className="flo-title-bar__menu-button flex items-center justify-center px-1.5"
              onClick={(event) => {
                const { left, bottom } = event.currentTarget.getBoundingClientRect();
                void window.electronAPI
                  ?.openApplicationMenu(`overflow:${visibleCount}`, Math.round(left), Math.round(bottom))
                  .catch(() => {});
              }}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          )}
        </>
      )}
    </div>
  );
}
