'use client';

import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import {
  STATUS_CONFIG,
  STATUS_ORDER,
  type KitchenStatus,
  type KdsOrderItem,
} from '@/hooks/useKdsConnection';

export interface KdsItemModalProps {
  item: KdsOrderItem;
  orderNumber: string;
  updating: boolean;
  onClose: () => void;
  onUpdateStatus: (itemId: number, status: KitchenStatus) => void;
}

export function KdsItemModal({ item, orderNumber, updating, onClose, onUpdateStatus }: KdsItemModalProps) {
  const { t } = useI18n();
  const statusLabel = (s: KitchenStatus) => t(STATUS_CONFIG[s].labelKey);
  const currentStatus = (item.status || 'pending') as KitchenStatus;
  const currentIdx = STATUS_ORDER.indexOf(currentStatus);
  const next = STATUS_ORDER[currentIdx + 1] ?? null;
  const prev = STATUS_ORDER[currentIdx - 1] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-400 font-medium mb-1">
              {t('kds.modalOrderNumber', { orderNumber })}
            </p>
            <h2 className="text-2xl font-bold text-gray-900 leading-tight">{item.product_name}</h2>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`text-sm font-bold ${STATUS_CONFIG[currentStatus].text}`}>
                {item.quantity}×
              </span>
              <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_CONFIG[currentStatus].bg} ${STATUS_CONFIG[currentStatus].text}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[currentStatus].color}`} />
                {statusLabel(currentStatus)}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-gray-500 hover:bg-gray-200 shrink-0"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        {item.addons && item.addons.length > 0 && (
          <div className="bg-blue-50 rounded-xl p-3">
            <p className="text-xs font-semibold text-blue-700 mb-1.5 uppercase tracking-wide">
              {t('kds.addonsLabel')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {item.addons.map((addon, i) => (
                <span
                  key={`${addon.id ?? addon.name}-${i}`}
                  className="text-sm bg-white text-blue-700 px-2.5 py-1 rounded-lg border border-blue-200 font-medium"
                >
                  + {addon.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {item.special_instructions && (
          <div className="bg-red-50 rounded-xl p-3">
            <p className="text-xs font-semibold text-red-700 mb-1 uppercase tracking-wide">
              {t('kds.specialInstructionsLabel')}
            </p>
            <p className="text-sm text-red-700 italic font-medium break-words">{item.special_instructions}</p>
          </div>
        )}

        <div className="flex items-center justify-center gap-1.5">
          {STATUS_ORDER.map((s, i) => {
            const isCurrent = currentStatus === s;
            const isPast = currentIdx > i;
            return (
              <div key={s} className="flex items-center gap-1.5">
                <div
                  className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${
                    isCurrent
                      ? `${STATUS_CONFIG[s].bg} ${STATUS_CONFIG[s].text} ring-2 ring-current`
                      : isPast
                        ? 'bg-gray-100 text-gray-400 line-through'
                        : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {statusLabel(s)}
                </div>
                {i < STATUS_ORDER.length - 1 && <ChevronRight size={12} className="text-gray-300 shrink-0" />}
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-3">
          {next && (
            <button
              onClick={() => onUpdateStatus(item.id, next)}
              disabled={updating}
              className={`w-full py-5 rounded-2xl text-white text-xl font-bold transition-all active:scale-95 disabled:opacity-50 ${STATUS_CONFIG[next].color} hover:brightness-90`}
            >
              {updating ? t('kds.updating') : t('kds.markAs', { status: statusLabel(next) })}
            </button>
          )}
          {prev && (
            <button
              onClick={() => onUpdateStatus(item.id, prev)}
              disabled={updating}
              className="w-full py-4 rounded-2xl text-gray-600 text-base font-semibold border-2 border-gray-200 bg-gray-50 hover:bg-gray-100 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <ChevronLeft size={18} />
              {t('kds.backTo', { status: statusLabel(prev) })}
            </button>
          )}
          {!next && (
            <div className="text-center py-4 text-gray-400 text-base font-medium">
              {t('kds.deliveredDone')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
