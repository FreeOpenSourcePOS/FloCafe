'use client';

import { useDroppable } from '@dnd-kit/react';
import { ReactNode } from 'react';
import { STATUS_CONFIG, type KitchenStatus } from '@/hooks/useKdsConnection';
import { useI18n } from '@/hooks/useI18n';

export interface KdsColumnProps {
  status: KitchenStatus;
  count: number;
  children: ReactNode;
}

export function KdsColumn({ status, count, children }: KdsColumnProps) {
  const { t } = useI18n();
  const config = STATUS_CONFIG[status];
  const statusLabel = t(config.labelKey);

  const { ref, isDropTarget } = useDroppable({
    id: `column-${status}`,
    data: { status },
  });

  return (
    <div className="flex-1 min-w-[260px] flex flex-col">
      <div className={`flex items-center gap-2 px-3 py-2 ${config.bg} rounded-t-lg border-2 ${config.border} border-b-0`}>
        <div className={`w-2 h-2 rounded-full ${config.color}`} />
        <span className={`text-sm font-semibold ${config.text}`}>{statusLabel}</span>
        <span className="ml-auto text-xs px-1.5 py-0.5 rounded-full bg-white/70 text-gray-700 font-medium tabular-nums">
          {count}
        </span>
      </div>
      <div
        ref={ref}
        className={`flex-1 border-2 ${config.border} border-t-0 rounded-b-lg p-2 space-y-2 overflow-y-auto bg-gray-50/40 transition-colors ${
          isDropTarget ? 'bg-blue-50 ring-2 ring-blue-300 ring-inset' : ''
        }`}
        style={{ minHeight: '60vh', maxHeight: 'calc(100vh - 220px)' }}
      >
        {children}
        {count === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-gray-400 text-xs">
            <span>{t('kds.emptyColumn')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
