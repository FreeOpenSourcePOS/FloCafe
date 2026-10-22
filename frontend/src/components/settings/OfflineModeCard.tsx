'use client';

import { useCallback, useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Toggle } from '@/components/settings/Toggle';
import { PRIVACY_CHANGED_EVENT } from '@/lib/privacy-events';

type ReadState = 'loading' | 'ready' | 'failed';

export function OfflineModeCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('settings');
  const [enabled, setEnabled] = useState(false);
  const [readState, setReadState] = useState<ReadState>('loading');
  const [busy, setBusy] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    api
      .get('/settings/offline-mode', { signal })
      .then((res) => {
        setEnabled(res.data?.offline_mode === true);
        setReadState('ready');
      })
      .catch(() => {
        if (!signal?.aborted) setReadState('failed');
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const change = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await api.put('/settings/offline-mode', { offline_mode: next });
      setEnabled(res.data?.offline_mode === true);
      window.dispatchEvent(new Event(PRIVACY_CHANGED_EVENT));
    } catch {
      toast.error(t('offlineModeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6" data-testid="offline-mode-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <WifiOff size={20} className="mt-0.5 text-muted-foreground" />
          <div>
            <h3 className="font-semibold text-foreground">{t('offlineModeTitle')}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t('offlineModeDescription')}</p>
            {readState === 'failed' && (
              <p className="text-sm text-destructive mt-2">
                {t('offlineModeReadFailed')}{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setReadState('loading');
                    load();
                  }}
                >
                  {t('offlineModeRetry')}
                </button>
              </p>
            )}
          </div>
        </div>
        <Toggle
          value={enabled}
          onChange={(next) => void change(next)}
          label={t('offlineModeTitle')}
          disabled={!canManage || busy || readState !== 'ready'}
        />
      </div>
    </div>
  );
}
