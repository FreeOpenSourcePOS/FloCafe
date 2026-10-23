'use client';

import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Toggle } from '@/components/settings/Toggle';
import { useFormatDate } from '@/hooks/useFormatDate';
import api from '@/lib/api';

type LocalBackupStatus = {
  enabled: boolean;
  directory: string;
  retention: number;
  lastBackupAt: string | null;
};

export function LocalBackupCard() {
  const t = useTranslations('settings');
  const { formatDateTime } = useFormatDate();
  const [status, setStatus] = useState<LocalBackupStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/db-tools/local-backup')
      .then(({ data }) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  const handleChange = async (enabled: boolean) => {
    setBusy(true);
    try {
      const { data } = await api.put('/db-tools/local-backup', { enabled });
      setStatus(data);
    } catch {
      toast.error(t('localBackupUpdateFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6" data-testid="local-backup-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <HardDrive size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('localBackupTitle')}</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('localBackupHint', {
              folder: status.directory,
              count: status.retention,
            })}
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            {status.lastBackupAt
              ? t('localBackupLast', { time: formatDateTime(status.lastBackupAt) })
              : t('localBackupNone')}
          </p>
        </div>
        <Toggle
          value={status.enabled}
          onChange={(value) => void handleChange(value)}
          label={t('localBackupTitle')}
          disabled={busy}
        />
      </div>
    </div>
  );
}
