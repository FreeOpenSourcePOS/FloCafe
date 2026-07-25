'use client';

import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, useDraggable, type DragEndEvent } from '@dnd-kit/react';
import { Clock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { KdsColumn } from '@/components/kds/KdsColumn';
import { KdsItemModal } from '@/components/kds/KdsItemModal';
import { Badge } from '@/components/ui/badge';
import {
  STATUS_CONFIG,
  STATUS_ORDER,
  ORDER_TYPE_BADGE_STYLES,
  type KitchenStatus,
  type KdsOrder,
  type KdsOrderItem,
} from '@/hooks/useKdsConnection';
import { ORDER_TYPE_LABEL_KEYS } from '@/lib/order-types';
import { useI18n } from '@/hooks/useI18n';

export interface KdsKanbanBoardProps {
  orders: KdsOrder[];
  updating: number | null;
  updateItemStatus: (itemId: number, status: KitchenStatus, opts?: { silent?: boolean }) => Promise<void>;
}

interface DropData {
  status: KitchenStatus;
}

interface DragData {
  itemIds: number[];
  fromStatus: KitchenStatus;
}

function statusOf(item: KdsOrderItem): KitchenStatus {
  return (item.status || 'pending') as KitchenStatus;
}

export function KdsKanbanBoard({ orders, updating, updateItemStatus }: KdsKanbanBoardProps) {
  const [modalItem, setModalItem] = useState<{ item: KdsOrderItem; orderNumber: string } | null>(null);

  // Group by status, then by order. Default rendering matches the tabs view:
  // one card per order, with the order header and a list of items in that status.
  const groupsByStatus = useMemo(() => {
    const map: Record<KitchenStatus, Array<{ order: KdsOrder; items: KdsOrderItem[] }>> = {
      pending: [],
      preparing: [],
      ready: [],
      served: [],
    };
    for (const order of orders) {
      const buckets: Record<KitchenStatus, KdsOrderItem[]> = {
        pending: [],
        preparing: [],
        ready: [],
        served: [],
      };
      for (const item of order.items || []) buckets[statusOf(item)].push(item);
      for (const status of STATUS_ORDER) {
        if (buckets[status].length > 0) map[status].push({ order, items: buckets[status] });
      }
    }
    return map;
  }, [orders]);

  async function handleDragEnd(event: DragEndEvent) {
    if (event.canceled) return;
    const sourceData = event.operation.source?.data as DragData | undefined;
    const targetData = event.operation.target?.data as DropData | undefined;
    if (!event.operation.target || !sourceData || !targetData) return;
    if (sourceData.fromStatus === targetData.status) return;

    for (const id of sourceData.itemIds) {
      await updateItemStatus(id, targetData.status, { silent: true });
    }
  }

  // Ticks once a second so the elapsed-time display below stays live.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setClockTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const timeSince = (dateStr: string) => {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <DragDropProvider
        sensors={(defaults) => [
          ...defaults.filter((sensor) => sensor !== PointerSensor),
          PointerSensor.configure({
            activationConstraints: [new PointerActivationConstraints.Distance({ value: 6 })],
            preventActivation: () => false,
          }),
        ]}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-3 px-1 overflow-x-auto flex-1 min-h-0">
          {STATUS_ORDER.map((status) => {
            const groups = groupsByStatus[status];
            return (
              <KdsColumn key={status} status={status} count={groups.length}>
                {groups.map(({ order, items }) => (
                  <KanbanOrderCard
                    key={`${order.id}-${status}`}
                    order={order}
                    status={status}
                    items={items}
                    updating={updating}
                    timeSince={timeSince}
                    onItemOpen={(item) => setModalItem({ item, orderNumber: order.order_number })}
                  />
                ))}
              </KdsColumn>
            );
          })}
        </div>
      </DragDropProvider>

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
    </div>
  );
}

function KanbanOrderCard({
  order,
  status,
  items,
  updating,
  timeSince,
  onItemOpen,
}: {
  order: KdsOrder;
  status: KitchenStatus;
  items: KdsOrderItem[];
  updating: number | null;
  timeSince: (dateStr: string) => string;
  onItemOpen: (item: KdsOrderItem) => void;
}) {
  const { t } = useI18n();
  const config = STATUS_CONFIG[status];
  const itemIds = items.map((i) => i.id);
  const busy = items.some((i) => updating === i.id);
  const { ref, isDragging } = useDraggable({
    id: `order-${order.id}-${status}`,
    data: { itemIds, fromStatus: status },
  });

  return (
    <div
      ref={ref}
      className={`select-none cursor-grab active:cursor-grabbing transition ${
        isDragging ? 'opacity-40' : ''
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
    >
      <div className={`rounded-xl border-2 ${config.border} bg-white p-3 flex flex-col shadow-sm`}>
        <div className="flex justify-between items-center mb-2 gap-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span className="font-bold text-xs shrink-0">#{order.order_number}</span>
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
          <div className="flex items-center gap-1 text-xs text-gray-400 font-mono shrink-0">
            <Clock size={12} />
            {timeSince(order.created_at)}
          </div>
        </div>

        {order.special_instructions && (
          <p className="mb-2 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700 font-medium break-words">
            📝 {order.special_instructions}
          </p>
        )}

        <div className="space-y-1">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onItemOpen(item);
              }}
              className={`w-full text-left rounded-lg border ${config.border} ${config.bg} px-2 py-1.5 hover:brightness-95 active:scale-[0.98] transition`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-xs font-bold w-6 shrink-0 ${config.text}`}>{item.quantity}×</span>
                <span className="text-sm text-gray-900 font-medium flex-1 truncate">{item.product_name}</span>
                {item.addons && item.addons.length > 0 && (
                  <span className="text-[10px] text-blue-600">+{item.addons.length}</span>
                )}
              </div>
              {item.special_instructions && (
                <p className="ml-[26px] text-xs text-red-600 italic mt-0.5 font-medium break-words">
                  {`"${item.special_instructions}"`}
                </p>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
