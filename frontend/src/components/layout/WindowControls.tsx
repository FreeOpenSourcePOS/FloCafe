'use client';

import { Minus, Square, X } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';

type TitleBarMode = 'native-overlay' | 'html-fallback';
type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

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
  const [titleBarMode, setTitleBarMode] = useState<TitleBarMode | null>(null);

  useEffect(() => {
    if (!isElectron) return undefined;
    let cancelled = false;
    window.electronAPI
      ?.getStatus()
      .then((status) => {
        const mode = status?.titleBarMode;
        if (!cancelled && (mode === 'native-overlay' || mode === 'html-fallback')) {
          setTitleBarMode(mode);
        }
      })
      .catch((error) => {
        console.error('[WindowControls] Unable to resolve title-bar mode:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  useEffect(() => {
    if (!isElectron || !titleBarMode) return;
    const windowReady = window.electronAPI?.windowReady;
    if (typeof windowReady !== 'function') return;
    windowReady().catch((error) => {
      console.error('[WindowControls] Unable to show the main window:', error);
    });
  }, [isElectron, titleBarMode]);

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
