'use client';

/** Beta update channel toggle with IPC feature detection; reflects state
 * managed by main process. */

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { readBetaChannelState, writeBetaChannelState } from '@/lib/updates/beta-channel';

export default function BetaChannelToggle() {
  const t = useTranslations('update');
  // Tri-state: null until the initial get resolves (or proves unsupported).
  const [supported, setSupported] = useState<boolean | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    readBetaChannelState(typeof window !== 'undefined' ? window.electronAPI : undefined)
      .then((state) => {
        if (cancelled) return;
        setSupported(state.supported);
        if (state.enabled !== null) setEnabled(state.enabled);
      });
    return () => { cancelled = true; };
  }, []);

  const handleChange = async (next: boolean) => {
    if (!supported || busy) return;
    setBusy(true);
    const result = await writeBetaChannelState(window.electronAPI, next);
    if (result.ok && result.enabled !== null) {
      setEnabled(result.enabled);
    } else if (!result.ok) {
      toast.error(t('betaToggleFailed'));
    }
    setBusy(false);
  };

  // Not inside Electron at all: updates are desktop-only, hide entirely
  // (same policy as the #467 update controls).
  if (typeof window === 'undefined') return null;

  return (
    <div className="bg-card rounded-xl border border-border p-6" data-testid="beta-channel-toggle">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-foreground">{t('betaTitle')}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t('betaDescription')}</p>
          <p className="text-xs text-muted-foreground mt-2">{t('betaGraduationNote')}</p>
          {supported === false && (
            <p className="text-xs text-amber-600 mt-2">{t('betaUnavailable')}</p>
          )}
        </div>
        <label className="inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={supported !== true || busy}
            onChange={(e) => void handleChange(e.target.checked)}
            data-testid="beta-channel-checkbox"
            aria-label={t('betaTitle')}
            className="sr-only peer"
          />
          <span className={`relative w-9 h-5 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-brand ${
            enabled ? 'bg-brand' : 'bg-gray-300'
          } ${supported === true ? '' : 'opacity-40 cursor-not-allowed'}`}>
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-card rounded-full shadow transition-transform ${
              enabled ? 'translate-x-4' : ''
            }`} />
          </span>
          <span className="ml-2 text-sm font-medium text-foreground">
            {enabled ? t('betaOn') : t('betaOff')}
          </span>
        </label>
      </div>
    </div>
  );
}
