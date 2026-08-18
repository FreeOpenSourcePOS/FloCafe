'use client';

import { useEffect, useState, useRef } from 'react';
import { Server, HardDrive, Clock, AlertCircle, CheckCircle } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import UpdateBadge from './UpdateBadge';

interface StatusInfo {
  server: string;
  memory: { heapUsed: number; heapTotal: number; rss: number };
  uptime: number;
  port: number;
}

export default function StatusBar() {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    async function fetchStatus() {
      if (typeof window === 'undefined' || !window.electronAPI?.getStatus) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      try {
        const data = await window.electronAPI.getStatus();
        setStatus(data);
        setError(null);
      } catch {
        setError(t('nav.statusError'));
      } finally {
        inFlightRef.current = false;
      }
    }

    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, 10000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return t('common.timeHoursMinutes', { h: hours, m: minutes });
    return t('common.timeMinutes', { m: minutes });
  }

  if (typeof window === 'undefined' || !window.electronAPI?.getStatus) return null;

  const isRunning = status?.server === 'running';
  const isPending = !status && !error;

  const serverStatusDisplay = status?.server
    ? (status.server === 'running' ? t('nav.serverStatusRunning')
       : status.server === 'stopped' ? t('nav.serverStatusStopped')
       : status.server === 'starting' ? t('nav.serverStatusStarting')
       : status.server)
    : t('nav.serverUnknown');

  return (
    <footer
      role="status"
      aria-live="polite"
      className="flex h-8 shrink-0 items-center gap-3 border-t border-border/70 bg-background/95 px-3 text-[11px] text-muted-foreground shadow-[0_-1px_5px_rgba(15,23,42,0.035)] backdrop-blur supports-[backdrop-filter]:bg-background/85"
    >
      <div
        className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 font-medium ring-1 ring-inset ${
          isRunning
            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200/80 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800'
            : isPending
              ? 'bg-muted text-muted-foreground ring-border/70'
              : 'bg-red-50 text-red-700 ring-red-200/80 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-800'
        }`}
      >
        {isRunning ? (
          <CheckCircle size={13} />
        ) : (
          <AlertCircle size={13} />
        )}
        <span>{t('nav.serverLabel')}{serverStatusDisplay}</span>
      </div>

      {error && (
        <span className="hidden text-red-600 sm:inline">{error}</span>
      )}

      <div className="ms-auto flex h-full items-center divide-x divide-border/70">
        <div className="flex items-center gap-1.5 px-3" title={t('nav.portLabel')}>
          <Server size={13} className="text-muted-foreground/70" />
          <span className="hidden text-muted-foreground lg:inline">{t('nav.portLabel')}</span>
          <span className="font-medium tabular-nums text-foreground/70">{status?.port || '...'}</span>
        </div>

        <div className="hidden items-center gap-1.5 px-3 md:flex" title={t('nav.heapLabel').trim()}>
          <HardDrive size={13} className="text-muted-foreground/70" />
          <span className="hidden text-muted-foreground xl:inline">{t('nav.heapLabel')}</span>
          <span className="font-medium tabular-nums text-foreground/70">
            {status?.memory.heapUsed || 0} / {status?.memory.heapTotal || 0} MB
          </span>
        </div>

        <div className="hidden items-center gap-1.5 px-3 sm:flex" title={t('nav.uptimeLabel').trim()}>
          <Clock size={13} className="text-muted-foreground/70" />
          <span className="hidden text-muted-foreground xl:inline">{t('nav.uptimeLabel')}</span>
          <span className="font-medium tabular-nums text-foreground/70">
            {status ? formatUptime(status.uptime) : '...'}
          </span>
        </div>

        <UpdateBadge />
      </div>
    </footer>
  );
}
