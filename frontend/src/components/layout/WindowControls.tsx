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
  const [resolved, setResolved] = useState<{
    mode: TitleBarMode;
    epoch: number;
    documentNonce: string | null;
  } | null>(null);

  useEffect(() => {
    if (!isElectron) return undefined;
    let cancelled = false;

    window.electronAPI
      ?.getStatus()
      .then((status) => {
        if (cancelled) return;
        // Resolve title-bar mode and bind readiness report to epoch;
        // fallback to native-overlay for unrecognized modes.
        setResolved({
          mode: status?.titleBarMode === 'html-fallback' ? 'html-fallback' : 'native-overlay',
          epoch: typeof status?.titleBarEpoch === 'number' ? status.titleBarEpoch : Number.NaN,
          documentNonce: typeof status?.titleBarDocumentNonce === 'string'
            ? status.titleBarDocumentNonce
            : null,
        });
      })
      .catch((error) => {
        // Skip readiness report on failure so main triggers bounded fail-safe.
        console.error('[WindowControls] Unable to resolve title-bar mode:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  // Report window readiness once title-bar controls are mounted and epoch is valid.
  useEffect(() => {
    if (!isElectron || !resolved) return;
    if (!Number.isInteger(resolved.epoch) || resolved.epoch < 1 || !resolved.documentNonce) return;
    window.electronAPI
      ?.windowReady({ epoch: resolved.epoch })
      ?.catch((error) => {
        console.error('[WindowControls] Unable to report renderer readiness:', error);
      });
  }, [isElectron, resolved]);

  const runWindowAction = useCallback((action: WindowControlAction) => {
    const windowAction = window.electronAPI?.windowAction;
    if (typeof windowAction !== 'function') return;
    windowAction(action).catch(() => {});
  }, []);

  if (!isElectron || resolved?.mode !== 'html-fallback' || window.electronAPI?.platform === 'darwin') return null;

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
