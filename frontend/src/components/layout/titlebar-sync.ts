'use client';

import { useEffect } from 'react';

let activeInstances = 0;

export function useDesktopTitleBarSync(isElectron: boolean): void {
  useEffect(() => {
    if (!isElectron) {
      if (activeInstances === 0) {
        delete document.documentElement.dataset.floDesktopTitlebar;
        delete document.documentElement.dataset.floPlatform;
        delete document.documentElement.dataset.floWindowFullscreen;
      }
      return undefined;
    }

    activeInstances += 1;
    document.documentElement.dataset.floDesktopTitlebar = 'true';
    if (window.electronAPI?.platform) {
      document.documentElement.dataset.floPlatform = window.electronAPI.platform;
    }

    let cancelled = false;
    const api = window.electronAPI;

    api?.getWindowState?.()
      ?.then((state) => {
        if (!cancelled && state) {
          document.documentElement.dataset.floWindowFullscreen = state.isFullScreen
            ? 'true'
            : 'false';
        }
      })
      ?.catch(() => {});

    const unsubscribe = api?.onWindowStateChanged?.((state) => {
      if (!cancelled && state) {
        document.documentElement.dataset.floWindowFullscreen = state.isFullScreen
          ? 'true'
          : 'false';
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      activeInstances = Math.max(0, activeInstances - 1);
      if (activeInstances === 0) {
        delete document.documentElement.dataset.floDesktopTitlebar;
        delete document.documentElement.dataset.floPlatform;
        delete document.documentElement.dataset.floWindowFullscreen;
      }
    };
  }, [isElectron]);
}
