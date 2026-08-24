'use client';

import { Minus, Square, X } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';

type TitleBarMode = 'native-overlay' | 'html-fallback';
type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

/** Grace period before re-signal readiness if the first invoke hangs. */
const WINDOW_READY_FAILSAFE_MS = 3000;

const subscribeToElectronCapability = () => () => {};
const getElectronCapability = () => typeof window !== 'undefined' && Boolean(window.electronAPI?.getStatus);
const getServerElectronCapability = () => false;

export default function WindowControls() {
  const tCommon = useTranslations('common');
  const isElectron = useSyncExternalStore(
    subscribeToElectronCapability,
    getElectronCapability,
    getServerElectronCapability,
  );
  // Fail-safe default: assume visible HTML fallback controls until main
  // explicitly confirms the native overlay works, so mode-resolution failure
  // can never leave a hidden bar without controls.
  const [titleBarMode, setTitleBarMode] = useState<TitleBarMode>('html-fallback');

  useEffect(() => {
    if (!isElectron) return undefined;
    let cancelled = false;

    // Readiness must not depend on mode resolution succeeding: signal it
    // immediately and once more from a fail-safe timer so getStatus()
    // rejecting, hanging, or returning an unknown shape can never leave the
    // hidden BrowserWindow invisible indefinitely.
    const signalReady = () => {
      const windowReady = window.electronAPI?.windowReady;
      if (typeof windowReady !== 'function') return;
      windowReady().catch((error) => {
        console.error('[WindowControls] Unable to show the main window:', error);
      });
    };
    signalReady();
    const failSafeTimer = setTimeout(signalReady, WINDOW_READY_FAILSAFE_MS);

    window.electronAPI
      ?.getStatus()
      .then((status) => {
        // Only upgrade away from the visible fallback when main explicitly
        // confirms native overlay; missing/unrecognized values keep controls.
        if (!cancelled && status?.titleBarMode === 'native-overlay') {
          setTitleBarMode('native-overlay');
        }
      })
      .catch((error) => {
        console.error('[WindowControls] Unable to resolve title-bar mode:', error);
      });

    return () => {
      cancelled = true;
      clearTimeout(failSafeTimer);
    };
  }, [isElectron]);

  const runWindowAction = useCallback((action: WindowControlAction) => {
    const windowAction = window.electronAPI?.windowAction;
    if (typeof windowAction !== 'function') return;
    windowAction(action).catch(() => {});
  }, []);

  if (!isElectron || titleBarMode !== 'html-fallback') return null;

  return (
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
  );
}
