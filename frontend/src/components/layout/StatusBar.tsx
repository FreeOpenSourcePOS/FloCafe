'use client';

import { useEffect, useState, useRef } from 'react';
import { Server, HardDrive, Clock, AlertCircle, CheckCircle } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';

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

  useEffect(() => {
    async function fetchStatus() {
      if (typeof window === 'undefined' || !window.electronAPI?.getStatus) return;

      try {
        const data = await window.electronAPI.getStatus();
        setStatus(data);
        setError(null);
      } catch {
        setError(t('nav.statusError'));
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
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  if (typeof window === 'undefined' || !window.electronAPI?.getStatus) return null;

  return (
    <div className="flex items-center gap-4 px-3 py-1 bg-gray-100 border-t border-gray-200 text-xs text-gray-600">
      <div className="flex items-center gap-1">
        {status?.server === 'running' ? (
          <CheckCircle size={12} className="text-green-500" />
        ) : (
          <AlertCircle size={12} className="text-red-500" />
        )}
        <span className={status?.server === 'running' ? 'text-green-600' : 'text-red-600'}>
          {t('nav.serverLabel')}{status?.server || t('nav.serverUnknown')}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <Server size={12} className="text-gray-400" />
        <span>:{status?.port || '...'}</span>
      </div>

      <div className="flex items-center gap-1">
        <HardDrive size={12} className="text-gray-400" />
        <span>
          {t('nav.heapLabel')}{status?.memory.heapUsed || 0} / {status?.memory.heapTotal || 0} MB
        </span>
      </div>

      <div className="flex items-center gap-1">
        <Clock size={12} className="text-gray-400" />
        <span>{t('nav.uptimeLabel')}{status ? formatUptime(status.uptime) : '...'}</span>
      </div>

      {error && (
        <div className="flex items-center gap-1 text-red-500">
          <AlertCircle size={12} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
