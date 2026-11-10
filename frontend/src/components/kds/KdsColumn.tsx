'use client';

import { useDroppable } from '@dnd-kit/react';
import { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { STATUS_CONFIG, type KitchenStatus } from '@/hooks/useKdsConnection';

export interface KdsColumnProps {
  status: KitchenStatus;
  count: number;
  children: ReactNode;
}

export function KdsColumn({ status, count, children }: KdsColumnProps) {
  const t = useTranslations('kds');
  const config = STATUS_CONFIG[status];
  const statusLabel = t(config.labelKey);

  const { ref, isDropTarget } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  return (
    <div className="rounded-2xl bg-muted/40 dark:bg-muted/25 flex-1 min-w-[260px] flex flex-col overflow-hidden">
      <div className={`flex items-center gap-2 px-3.5 py-2.5 ${config.bg}`}>
        <div className={`w-2.5 h-2.5 rounded-full ${config.color}`} />
        <span className={`text-base font-semibold ${config.text}`}>{statusLabel}</span>
        <span className="ms-auto text-xs px-2 py-0.5 rounded-full bg-card/80 text-foreground font-semibold tabular-nums shadow-2xs">
          {count}
        </span>
      </div>
      <div
        ref={ref}
        className={`flex-1 p-2.5 space-y-2.5 overflow-y-auto transition-colors ${
          isDropTarget
            ? 'bg-blue-50/70 ring-2 ring-blue-400 dark:bg-blue-950/40 dark:ring-blue-600 ring-inset'
            : ''
        }`}
        style={{ minHeight: '60vh', maxHeight: 'calc(100vh - 220px)' }}
      >
        {children}
        {count === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-slate-700 dark:text-slate-300 text-xs">
            <span>{t('emptyColumn')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
