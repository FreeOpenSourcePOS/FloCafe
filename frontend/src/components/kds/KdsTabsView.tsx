'use client';

import { ChevronRight, Clock } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { KdsItemModal } from '@/components/kds/KdsItemModal';
import { Badge } from '@/components/ui/badge';
import {
  STATUS_CONFIG,
  ORDER_TYPE_BADGE_STYLES,
  type KitchenStatus,
  type KdsOrder,
  type KdsOrderItem,
} from '@/hooks/useKdsConnection';
import { ORDER_TYPE_LABEL_KEYS } from '@/lib/order-types';
import { useI18n } from '@/hooks/useI18n';
import { parseDbTimestamp } from '@/lib/utils';

export interface KdsTabsViewProps {
  orders: KdsOrder[];
  updating: number | null;
  updateItemStatus: (itemId: number, status: KitchenStatus) => void;
}

interface ModalItem {
  item: KdsOrderItem;
  orderNumber: string;
}

export function KdsTabsView({ orders, updating, updateItemStatus }: KdsTabsViewProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<KitchenStatus>('pending');
  const [modalItem, setModalItem] = useState<ModalItem | null>(null);

  const statusLabel = (s: KitchenStatus) => t(STATUS_CONFIG[s].labelKey);

  // Ticks once a second so the elapsed-time display below stays live.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const timeSince = useCallback((dateStr: string) => {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - parseDbTimestamp(dateStr).getTime()) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  }, []);

  const filteredOrders = orders
    .map((order) => ({
      ...order,
      items: (order.items || []).filter((item) => (item.status || 'pending') === activeTab),
    }))
    .filter((order) => order.items.length > 0);

  const orderCounts = (status: KitchenStatus): number =>
    orders.reduce(
      (sum, order) => sum + (order.items || []).filter((item) => (item.status || 'pending') === status).length,
      0,
    );

  return (
    <>
      <div className="shrink-0 flex flex-wrap items-center gap-2 mb-4">
        {(Object.keys(STATUS_CONFIG) as KitchenStatus[]).map((status) => {
          const config = STATUS_CONFIG[status];
          const count = orderCounts(status);
          const isActive = activeTab === status;
          return (
            <button
              key={status}
              onClick={() => setActiveTab(status)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 ${
                isActive
                  ? `${config.bg} ${config.text} ring-2 ring-current`
                  : `${config.bg} ${config.text} opacity-50 hover:opacity-80`
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${config.color}`} />
              {statusLabel(status)}
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-white/60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 items-start">
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              className={`bg-white rounded-xl border-2 ${STATUS_CONFIG[activeTab].border} p-4 flex flex-col`}
            >
              <div className="flex justify-between items-center mb-3 gap-2">
                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                  <span className="font-bold text-base shrink-0">#{order.order_number}</span>
                  <Badge
                    variant="outline"
                    className={ORDER_TYPE_BADGE_STYLES[order.type] || 'bg-gray-50 text-gray-700 border-gray-200'}
                  >
                    {t(ORDER_TYPE_LABEL_KEYS[order.type] ?? order.type)}
                  </Badge>
                  {order.table?.name && (
                    <Badge variant="secondary">{t('kds.tableLabel', { name: order.table.name })}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 text-sm text-gray-400 font-mono shrink-0">
                  <Clock size={12} />
                  {timeSince(order.created_at)}
                </div>
              </div>

              {order.special_instructions && (
                <div className="mb-2 px-2 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <p className="text-sm text-amber-700 font-medium break-words">
                    📝 {order.special_instructions}
                  </p>
                </div>
              )}

              <div className="space-y-2 flex-1">
                {order.items?.map((item) => {
                  const itemStatus = (item.status || 'pending') as KitchenStatus;
                  const config = STATUS_CONFIG[itemStatus];
                  const isVoided = itemStatus === 'voided';

                  return (
                    <button
                      key={item.id}
                      onClick={() => setModalItem({ item, orderNumber: order.order_number })}
                      className={`w-full text-left rounded-xl border-2 ${config.border} ${config.bg} px-3 py-2.5 transition-all active:scale-95 hover:brightness-95`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${config.color}`} />
                        <span className={`font-bold text-base w-6 shrink-0 ${config.text}`}>{item.quantity}×</span>
                        <span className={`text-lg font-semibold flex-1 truncate ${isVoided ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                          {item.product_name}
                        </span>
                        <ChevronRight size={14} className="text-gray-400 shrink-0" />
                      </div>
                      {item.addons && item.addons.length > 0 && (
                        <div className="ml-[26px] flex flex-wrap gap-1 mt-1">
                          {item.addons.map((addon, i) => (
                            <span
                              key={`${addon.id ?? addon.name}-${i}`}
                              className="text-[10px] bg-white/70 text-blue-600 px-1.5 py-0.5 rounded border border-blue-200"
                            >
                              + {addon.name}{(addon.quantity || 1) > 1 ? ` ×${addon.quantity}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {item.special_instructions && (
                        <p className="ml-[26px] text-sm text-red-600 italic mt-0.5 font-medium break-words">
                          {`"${item.special_instructions}"`}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {filteredOrders.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <p className="text-lg">{t('kds.emptyItems', { status: statusLabel(activeTab).toLowerCase() })}</p>
            <p className="text-sm">{t('kds.emptyHint')}</p>
          </div>
        )}
      </div>

      {modalItem && (
        <KdsItemModal
          item={modalItem.item}
          orderNumber={modalItem.orderNumber}
          updating={updating === modalItem.item.id}
          onClose={() => setModalItem(null)}
          onUpdateStatus={(itemId, status) => {
            updateItemStatus(itemId, status);
            setModalItem(null);
          }}
        />
      )}
    </>
  );
}
