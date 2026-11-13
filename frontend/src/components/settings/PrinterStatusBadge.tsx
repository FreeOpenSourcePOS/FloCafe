'use client';

/** Live status badge for one saved printer, from GET /printers/:id/status. */

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { printFailureHint } from '@/lib/printer/print-failure-help';

type PrinterStatus = {
  connection_type: 'network' | 'usb' | 'webusb';
  answered?: boolean;
  reachable?: boolean;
  online?: boolean;
  paperNearEnd?: boolean;
  queue_status?: 'idle' | 'printing' | 'offline' | 'missing';
  cause?: string | null;
};

export function PrinterStatusBadge({
  printerId,
  connectionType,
  refreshKey = 0,
}: {
  printerId: string;
  connectionType: 'network' | 'usb' | 'webusb';
  /** Bumped after a reload or a test print, so the badge reads the printer again. */
  refreshKey?: number;
}) {
  const t = useTranslations('settings');
  const tAll = useTranslations();
  const [status, setStatus] = useState<PrinterStatus | null>(null);

  useEffect(() => {
    if (connectionType === 'webusb') return;
    const controller = new AbortController();
    api
      .get(`/printers/${printerId}/status`, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setStatus(res.data);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus({ connection_type: connectionType, answered: false });
      });
    return () => controller.abort();
  }, [printerId, connectionType, refreshKey]);

  if (!status) return null;

  const hint = printFailureHint(
    { cause: status.cause, platform: window.electronAPI?.platform },
    tAll,
  );
  const queueBroken = status.queue_status === 'offline' || status.queue_status === 'missing';
  const silent = status.answered === false || status.reachable === false;

  let label = t('printerStatusUnknown');
  let tone = 'bg-muted text-muted-foreground';
  let dot = 'bg-gray-400';
  if (hint) {
    label = hint;
    tone = 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300';
    dot = 'bg-amber-500';
  } else if (!silent && !queueBroken && status.online !== false) {
    label = status.paperNearEnd ? t('printerStatusPaperLow') : t('printerStatusReady');
    tone = 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300';
    dot = 'bg-green-500';
  }

  return (
    <span
      className={`inline-flex max-w-[18rem] items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}
      title={label}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{label}</span>
    </span>
  );
}
