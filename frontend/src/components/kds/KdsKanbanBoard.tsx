'use client';

import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, useDraggable, type DragEndEvent } from '@dnd-kit/react';
import { Clock } from 'lucide-react';
import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ElapsedTime } from '@/components/kds/ElapsedTime';
import { KdsColumn } from '@/components/kds/KdsColumn';
import { KdsItemModal } from '@/components/kds/KdsItemModal';
import { Badge } from '@/components/ui/badge';
import {
  STATUS_CONFIG,
  STATUS_ORDER,
  normalizeKitchenStatus,
  ORDER_TYPE_BADGE_STYLES,
  type KitchenStatus,
  type KdsOrder,
  type KdsOrderItem,
} from '@/hooks/useKdsConnection';
import { ORDER_TYPE_LABEL_KEYS } from '@/lib/order-types';
import { useI18n } from '@/hooks/useI18n';
import { useConfirm } from '@/hooks/use-confirm';
import { Ltr } from '@/components/layout/Ltr';

export interface KdsKanbanBoardProps {
  orders: KdsOrder[];
  updating: number | null;
  updateItemStatus: (itemId: number, status: KitchenStatus, opts?: { silent?: boolean; expectedStatus?: KitchenStatus }) => Promise<boolean>;
}

interface DropData {
  status: KitchenStatus;
}

interface DragData {
  itemIds: number[];
  fromStatus: KitchenStatus;
}

function statusOf(item: KdsOrderItem): KitchenStatus {
  return normalizeKitchenStatus(item.status);
}

// The 4 draggable stages, as opposed to the locked 'voided' status (issue
// #150) which gets its own read-only, non-draggable section below — never a
// dnd-kit column, so a card can never be dragged into "voided" as a bypass
// for the manager-PIN void flow.
type BoardStatus = Exclude<KitchenStatus, 'voided'>;

export function KdsKanbanBoard({ orders, updating, updateItemStatus }: KdsKanbanBoardProps) {
  const [modalItem, setModalItem] = useState<{ item: KdsOrderItem; orderNumber: string } | null>(null);
  const resolvedModalItem = modalItem
    ? { ...modalItem, item: orders.flatMap((order) => order.items || []).find((item) => item.id === modalItem.item.id) || modalItem.item }
    : null;
  const { t } = useI18n();
  const { confirm, ConfirmDialog } = useConfirm();

  // Group by status, then by order. Default rendering matches the tabs view:
  // one card per order, with the order header and a list of items in that status.
  const groupsByStatus = useMemo(() => {
    const map: Record<BoardStatus, Array<{ order: KdsOrder; items: KdsOrderItem[] }>> = {
      pending: [],
      preparing: [],
      ready: [],
      served: [],
    };
    for (const order of orders) {
      const buckets: Record<BoardStatus, KdsOrderItem[]> = {
        pending: [],
        preparing: [],
        ready: [],
        served: [],
      };
      for (const item of order.items || []) {
        const status = statusOf(item);
        if (status in buckets) buckets[status as BoardStatus].push(item);
      }
      for (const status of STATUS_ORDER) {
        if (buckets[status].length > 0) map[status].push({ order, items: buckets[status] });
      }
    }
    return map;
  }, [orders]);

  // Voided items, grouped per order — read-only, struck through, and never a
  // drag source or drop target (see BoardStatus above).
  const voidedGroups = useMemo(() => {
    const groups: Array<{ order: KdsOrder; items: KdsOrderItem[] }> = [];
    for (const order of orders) {
      const items = (order.items || []).filter((item) => statusOf(item) === 'voided');
      if (items.length > 0) groups.push({ order, items });
    }
    return groups;
  }, [orders]);

  async function handleDragEnd(event: DragEndEvent) {
    if (event.canceled) return;
    const sourceData = event.operation.source?.data as DragData | undefined;
    const targetData = event.operation.target?.data as DropData | undefined;
    if (!event.operation.target || !sourceData || !targetData) return;
    if (sourceData.fromStatus === targetData.status) return;

    const sourceIdx = STATUS_ORDER.indexOf(sourceData.fromStatus as BoardStatus);
    const targetIdx = STATUS_ORDER.indexOf(targetData.status as BoardStatus);
    // A forward drag that jumps over one or more stages (e.g. preparing →
    // served) can accidentally complete an order, so require an explicit
    // confirmation before committing (issue #301). Backward and single-step
    // moves stay one-touch.
    const skipsStage = sourceIdx >= 0 && targetIdx > sourceIdx + 1;
    if (skipsStage) {
      const targetLabel = t(STATUS_CONFIG[targetData.status].labelKey);
      const proceed = await confirm(
        t('kds.skipStageMessage', { status: targetLabel }),
        { title: t('kds.skipStageTitle'), confirmLabel: t('kds.markAs', { status: targetLabel }) },
      );
      if (!proceed) return;
    }

    const results = await Promise.all(sourceData.itemIds.map((id) =>
      updateItemStatus(id, targetData.status, { silent: !skipsStage, expectedStatus: sourceData.fromStatus }),
    ));
    const failed = results.filter((result) => !result).length;
    if (failed > 0) {
      toast.error(`${failed} item${failed === 1 ? '' : 's'} could not be updated. The board was refreshed.`);
    }
  }

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
                    onItemOpen={(item) => setModalItem({ item, orderNumber: order.order_number })}
                  />
                ))}
              </KdsColumn>
            );
          })}

          {voidedGroups.length > 0 && (
            <VoidedColumn
              groups={voidedGroups}
              onItemOpen={(item, orderNumber) => setModalItem({ item, orderNumber })}
            />
          )}
        </div>
      </DragDropProvider>

      {ConfirmDialog}

      {resolvedModalItem && (
        <KdsItemModal
          item={resolvedModalItem.item}
          orderNumber={resolvedModalItem.orderNumber}
          updating={updating === resolvedModalItem.item.id}
          onClose={() => setModalItem(null)}
          onUpdateStatus={async (itemId, status) => {
            const updated = await updateItemStatus(itemId, status, { expectedStatus: statusOf(resolvedModalItem.item) });
            if (updated) setModalItem(null);
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
  onItemOpen,
}: {
  order: KdsOrder;
  status: KitchenStatus;
  items: KdsOrderItem[];
  updating: number | null;
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
            <Ltr as="span" className="font-bold text-sm shrink-0">#{order.order_number}</Ltr>
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
            <Ltr><ElapsedTime dateStr={order.created_at} /></Ltr>
          </div>
        </div>

        {order.special_instructions && (
          <p className="mb-2 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-sm text-amber-700 font-medium break-words">
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
              className={`w-full text-start rounded-lg border ${config.border} ${config.bg} px-2 py-1.5 hover:brightness-95 active:scale-[0.98] transition`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-base font-bold w-6 shrink-0 ${config.text}`}>{item.quantity}×</span>
                <span className="text-lg text-gray-900 font-medium flex-1 truncate">{item.product_name}</span>
                {item.addons && item.addons.length > 0 && (
                  <span className="text-[10px] text-blue-600">+{item.addons.length}</span>
                )}
              </div>
              {item.special_instructions && (
                <p className="ms-[26px] text-sm text-red-600 italic mt-0.5 font-medium break-words">
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

// Read-only column for voided items (issue #150) — deliberately not a
// KdsColumn/useDroppable target and its cards aren't useDraggable, so an
// in-progress item can only ever land here through the manager-PIN void
// flow on the Orders page, never by a kitchen drag-and-drop shortcut.
function VoidedColumn({
  groups,
  onItemOpen,
}: {
  groups: Array<{ order: KdsOrder; items: KdsOrderItem[] }>;
  onItemOpen: (item: KdsOrderItem, orderNumber: string) => void;
}) {
  const { t } = useI18n();
  const config = STATUS_CONFIG.voided;
  const count = groups.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <div className="flex-1 min-w-[260px] flex flex-col">
      <div className={`flex items-center gap-2 px-3 py-2 ${config.bg} rounded-t-lg border-2 ${config.border} border-b-0`}>
        <div className={`w-2 h-2 rounded-full ${config.color}`} />
        <span className={`text-base font-semibold ${config.text}`}>{t(config.labelKey)}</span>
        <span className="ms-auto text-xs px-1.5 py-0.5 rounded-full bg-white/70 text-gray-700 font-medium tabular-nums">
          {count}
        </span>
      </div>
      <div
        className={`flex-1 border-2 ${config.border} border-t-0 rounded-b-lg p-2 space-y-2 overflow-y-auto bg-gray-50/40`}
        style={{ minHeight: '60vh', maxHeight: 'calc(100vh - 220px)' }}
      >
        {groups.map(({ order, items }) => (
          <div key={order.id} className={`rounded-xl border-2 ${config.border} bg-white p-3 flex flex-col shadow-sm opacity-80`}>
            <div className="flex items-center gap-1.5 min-w-0 flex-wrap mb-2">
              <Ltr as="span" className="font-bold text-sm shrink-0">#{order.order_number}</Ltr>
              {order.table?.name && (
                <Badge variant="secondary">{t('kds.tableLabel', { name: order.table.name })}</Badge>
              )}
            </div>
            <div className="space-y-1">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onItemOpen(item, order.order_number)}
                  className={`w-full text-start rounded-lg border ${config.border} ${config.bg} px-2 py-1.5 hover:brightness-95 active:scale-[0.98] transition`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-base font-bold w-6 shrink-0 ${config.text}`}>{item.quantity}×</span>
                    <span className="text-lg text-gray-400 line-through font-medium flex-1 truncate">{item.product_name}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
        {count === 0 && (
          <div className="flex flex-col items-center justify-center py-6 text-gray-400 text-xs">
            <span>{t('kds.emptyColumn')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
