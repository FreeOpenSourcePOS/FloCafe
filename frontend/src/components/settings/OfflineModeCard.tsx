'use client';

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Toggle } from '@/components/settings/Toggle';

export function OfflineModeCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('settings');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/settings/offline-mode', { signal: controller.signal })
      .then((res) => setEnabled(res.data?.offline_mode === true))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const change = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await api.put('/settings/offline-mode', { offline_mode: next });
      setEnabled(res.data?.offline_mode === true);
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
          </div>
        </div>
        <Toggle
          value={enabled}
          onChange={(next) => void change(next)}
          label={t('offlineModeTitle')}
          disabled={!canManage || busy}
        />
      </div>
    </div>
  );
}
