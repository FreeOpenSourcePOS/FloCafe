'use client';

import { ChevronRight, Clock } from 'lucide-react';
import { useState } from 'react';
import { ElapsedTime } from '@/components/kds/ElapsedTime';
import { KdsItemModal } from '@/components/kds/KdsItemModal';
import { Badge } from '@/components/ui/badge';
import {
  STATUS_CONFIG,
  normalizeKitchenStatus,
  ORDER_TYPE_BADGE_STYLES,
  type KitchenStatus,
  type KdsOrder,
  type KdsOrderItem,
} from '@/hooks/useKdsConnection';
import { ORDER_TYPE_LABEL_KEYS, type OrderType } from '@/lib/order-types';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { formatItemHeading } from '@/lib/printer/item-heading';

export interface KdsTabsViewProps {
  orders: KdsOrder[];
  updating: number | null;
  updateItemStatus: (
    itemId: number,
    status: KitchenStatus,
    opts?: { expectedStatus?: KitchenStatus },
  ) => Promise<boolean>;
}

interface ModalItem {
  item: KdsOrderItem;
  orderNumber: string;
}

export function KdsTabsView({ orders, updating, updateItemStatus }: KdsTabsViewProps) {
  const t = useTranslations('kds');
  const tOrders = useTranslations('orders');
  const [activeTab, setActiveTab] = useState<KitchenStatus>('pending');
  const [modalItem, setModalItem] = useState<ModalItem | null>(null);
  const resolvedModalItem = modalItem
    ? {
        ...modalItem,
        item:
          orders
            .flatMap((order) => order.items || [])
            .find((item) => item.id === modalItem.item.id) || modalItem.item,
      }
    : null;

  const statusLabel = (s: KitchenStatus) => t(STATUS_CONFIG[s].labelKey);

  const filteredOrders = orders
    .map((order) => ({
      ...order,
      items: (order.items || []).filter(
        (item) => normalizeKitchenStatus(item.status) === activeTab,
      ),
    }))
    .filter((order) => order.items.length > 0);

  const orderCounts = (status: KitchenStatus): number =>
    orders.reduce(
      (sum, order) =>
        sum +
        (order.items || []).filter((item) => normalizeKitchenStatus(item.status) === status).length,
      0,
    );

  return (
    <>
      <div className="shrink-0 bg-muted/50 p-1 rounded-xl inline-flex flex-wrap items-center gap-1.5 mb-4">
        {(Object.keys(STATUS_CONFIG) as KitchenStatus[]).map((status) => {
          const config = STATUS_CONFIG[status];
          const count = orderCounts(status);
          const isActive = activeTab === status;
          return (
            <button
              key={status}
              onClick={() => setActiveTab(status)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-all flex items-center gap-1.5 ${
                isActive
                  ? `bg-card shadow-xs ring-1 ring-border/60 ${config.text} font-semibold`
                  : 'text-slate-700 dark:text-slate-200 hover:text-foreground hover:bg-card/60 font-medium'
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${config.color}`} />
              {statusLabel(status)}
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full font-semibold tabular-nums shadow-2xs ${
                  isActive
                    ? `${config.bg} ${config.text}`
                    : 'bg-background/80 text-slate-700 dark:text-slate-200'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 items-start">
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              className={`rounded-xl bg-card shadow-sm ring-1 ring-border/50 border-t-4 ${STATUS_CONFIG[activeTab].border} p-3 flex flex-col`}
            >
              <div className="flex justify-between items-center mb-2 gap-2">
                <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                  <Ltr as="span" className="font-extrabold text-lg tracking-tight shrink-0">
                    #{order.order_number}
                  </Ltr>
                  <Badge
                    variant="outline"
                    className={`${ORDER_TYPE_BADGE_STYLES[order.type] || 'bg-muted text-foreground'} border-transparent dark:border-transparent`}
                  >
                    {ORDER_TYPE_LABEL_KEYS[order.type as OrderType]
                      ? tOrders(ORDER_TYPE_LABEL_KEYS[order.type as OrderType])
                      : order.type}
                  </Badge>
                  {order.table?.name && (
                    <Badge variant="secondary">{t('tableLabel', { name: order.table.name })}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 text-sm text-slate-700 dark:text-slate-300 font-mono shrink-0">
                  <Clock size={12} />
                  <Ltr>
                    <ElapsedTime dateStr={order.created_at} />
                  </Ltr>
                </div>
              </div>

              {order.special_instructions && (
                <p className="mb-2.5 px-2.5 py-1.5 border-s-4 border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/80 dark:text-amber-200 rounded-e-md text-sm font-medium break-words">
                  📝 {order.special_instructions}
                </p>
              )}

              <div className="divide-y divide-border/40 -mx-1 flex-1">
                {order.items?.map((item) => {
                  const itemStatus = normalizeKitchenStatus(item.status);
                  const config = STATUS_CONFIG[itemStatus];
                  const isVoided = itemStatus === 'voided';

                  return (
                    <button
                      key={item.id}
                      onClick={() => setModalItem({ item, orderNumber: order.order_number })}
                      className="w-full text-start px-2 py-2 first:pt-1.5 last:pb-1 hover:bg-muted/60 active:bg-muted/80 active:scale-[0.99] transition rounded-md"
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${config.color}`} />
                        <span className={`font-bold text-base w-6 shrink-0 ${config.text}`}>
                          {item.quantity}×
                        </span>
                        <span
                          className={`text-lg font-semibold flex-1 truncate ${isVoided ? 'text-slate-700 dark:text-slate-200 line-through' : 'text-foreground'}`}
                        >
                          {formatItemHeading(item.product_name, item.variant_selection)}
                        </span>
                        <ChevronRight
                          size={14}
                          className="text-slate-700 dark:text-slate-300 shrink-0 rtl-flip"
                        />
                      </div>
                      {item.addons && item.addons.length > 0 && (
                        <div className="ms-[26px] flex flex-wrap gap-1 mt-1.5">
                          {item.addons.map((addon, i) => (
                            <span
                              key={`${addon.id ?? addon.name}-${i}`}
                              className="text-xs font-medium bg-blue-100/90 text-blue-900 dark:bg-blue-950/90 dark:text-blue-200 px-2 py-0.5 rounded-md"
                            >
                              + {addon.name}
                              {(addon.quantity || 1) > 1 ? ` ×${addon.quantity}` : ''}
                            </span>
                          ))}
                        </div>
                      )}
                      {item.special_instructions && (
                        <p className="ms-[26px] mt-1.5 px-2 py-0.5 border-s-3 border-red-500 bg-red-50 text-red-900 dark:bg-red-950/90 dark:text-red-200 rounded-e text-xs font-semibold italic break-words">
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
          <div className="flex flex-col items-center justify-center py-16 text-slate-700 dark:text-slate-300">
            <p className="text-lg">
              {t('emptyItems', { status: statusLabel(activeTab).toLowerCase() })}
            </p>
            <p className="text-sm">{t('emptyHint')}</p>
          </div>
        )}
      </div>

      {resolvedModalItem && (
        <KdsItemModal
          item={resolvedModalItem.item}
          orderNumber={resolvedModalItem.orderNumber}
          updating={updating === resolvedModalItem.item.id}
          onClose={() => setModalItem(null)}
          onUpdateStatus={async (itemId, status) => {
            const updated = await updateItemStatus(itemId, status, {
              expectedStatus: normalizeKitchenStatus(resolvedModalItem.item.status),
            });
            if (updated) setModalItem(null);
          }}
        />
      )}
    </>
  );
}
