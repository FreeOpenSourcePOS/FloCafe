'use client';

import { Utensils, ShoppingBag, Truck, Globe, Clock } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { Order } from '@/lib/types';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { parseDbTimestamp, cn } from '@/lib/utils';
import { orderStatusBadge, ORDER_TYPE_KEYS } from './OrderCard';

function OrderTypeIcon({ type }: { type: Order['type'] }) {
  const cls = 'shrink-0 text-muted-foreground';
  switch (type) {
    case 'dine_in': return <Utensils size={13} className={cls} />;
    case 'delivery': return <Truck size={13} className={cls} />;
    case 'online': return <Globe size={13} className={cls} />;
    default: return <ShoppingBag size={13} className={cls} />;
  }
}

/** Left pane of the Orders master/detail layout: one compact row per order for
 * rapid triage. Full order details live in the detail pane. */
export function OrdersMasterList({
  orders,
  selectedOrderId,
  onSelect,
  now,
}: {
  orders: Order[];
  selectedOrderId: number | null;
  onSelect: (orderId: number) => void;
  now: number;
}) {
  const tOrders = useTranslations('orders');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();

  const getTimeSince = (createdAt: string) => {
    const minutes = Math.floor((now - parseDbTimestamp(createdAt).getTime()) / 60000);
    if (minutes < 1) return tCommon('justNow');
    if (minutes < 60) return tCommon('timeMinutesAgo', { m: minutes });
    return tCommon('timeHoursMinutesAgo', { h: Math.floor(minutes / 60), m: minutes % 60 });
  };

  return (
    <ul className="flex-1 min-h-0 overflow-y-auto divide-y divide-border">
      {orders.map((order) => {
        const badge = orderStatusBadge[order.status];
        const active = order.status !== 'cancelled';
        const itemCount = (order.items || []).filter(
          (i) => !['cancelled', 'voided', 'void_adjustment'].includes(i.status),
        ).length;
        return (
          <li key={order.id}>
            <button
              type="button"
              onClick={() => onSelect(order.id)}
              aria-current={selectedOrderId === order.id}
              className={cn(
                'w-full text-start px-3 py-2.5 flex flex-col gap-1 transition-colors touch-manipulation',
                selectedOrderId === order.id
                  ? 'bg-brand/10 ring-1 ring-inset ring-brand'
                  : 'bg-card hover:bg-muted/60',
                !active && 'opacity-80',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-sm text-foreground tracking-tight">
                  #<Ltr>{order.order_number}</Ltr>
                </span>
                {badge && (
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 ${badge.bg} ${badge.text}`}>
                    {tOrders(badge.labelKey)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
                <span className="inline-flex items-center gap-1 font-medium text-foreground shrink-0">
                  <OrderTypeIcon type={order.type} />
                  {tOrders(ORDER_TYPE_KEYS[order.type])}
                </span>
                {order.table && (
                  <span className="font-medium text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40 px-1.5 py-0.5 rounded-md truncate">
                    {order.table.name}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 ms-auto shrink-0">
                  <Clock size={12} />
                  {getTimeSince(order.created_at)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {tOrders('itemCount', { count: itemCount })}
                </span>
                <span className="text-sm font-bold text-foreground">
                  {fmt(Number(order.bill?.total ?? order.total))}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}