'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Order, OrderItem } from '@/lib/types';
import { useI18n } from '@/hooks/useI18n';
import { ORDER_TYPE_LABEL_KEYS } from '@/lib/order-types';

// --- Mock data -------------------------------------------------------------
// Shaped exactly like the real `Order`/`OrderItem` types from src/lib/types.ts
// so this drops in against the live API with zero changes beyond the fetch.

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

const MOCK_ORDERS: Order[] = [
  {
    id: 1042,
    order_number: 'A-1042',
    table_id: 'tbl-07',
    customer_id: null,
    type: 'dine_in',
    status: 'pending',
    subtotal: 0, tax_amount: 0, discount_amount: 0, delivery_charge: 0,
    total: 0, guest_count: 4, special_instructions: null,
    created_by: 1, created_at: minutesAgo(2),
    table: { id: 'tbl-07', name: '7', capacity: 4, status: 'occupied', kitchen_station_id: null, floor: null, section: null, is_active: true },
    items: [
      { id: 1, order_id: 1042, product_id: 1, product_name: 'Margherita Pizza', product_sku: null, unit_price: 350, quantity: 2, subtotal: 700, tax_amount: 0, total: 700, addons: null, special_instructions: null, status: 'pending' },
      { id: 2, order_id: 1042, product_id: 2, product_name: 'Garlic Bread', product_sku: null, unit_price: 150, quantity: 1, subtotal: 150, tax_amount: 0, total: 150, addons: null, special_instructions: 'No Onions', status: 'pending' },
    ],
  },
  {
    id: 1039,
    order_number: 'A-1039',
    table_id: null,
    customer_id: null,
    type: 'takeaway',
    status: 'preparing',
    subtotal: 0, tax_amount: 0, discount_amount: 0, delivery_charge: 0,
    total: 0, guest_count: null, special_instructions: null,
    created_by: 1, created_at: minutesAgo(6),
    items: [
      { id: 3, order_id: 1039, product_id: 3, product_name: 'Chicken Biryani', product_sku: null, unit_price: 280, quantity: 3, subtotal: 840, tax_amount: 0, total: 840, addons: null, special_instructions: 'Extra Spicy', status: 'preparing' },
      { id: 4, order_id: 1039, product_id: 4, product_name: 'Raita', product_sku: null, unit_price: 60, quantity: 3, subtotal: 180, tax_amount: 0, total: 180, addons: null, special_instructions: null, status: 'preparing' },
      { id: 5, order_id: 1039, product_id: 5, product_name: 'Gulab Jamun', product_sku: null, unit_price: 90, quantity: 2, subtotal: 180, tax_amount: 0, total: 180, addons: null, special_instructions: null, status: 'preparing' },
    ],
  },
  {
    id: 1035,
    order_number: 'A-1035',
    table_id: 'tbl-12',
    customer_id: null,
    type: 'dine_in',
    status: 'preparing',
    subtotal: 0, tax_amount: 0, discount_amount: 0, delivery_charge: 0,
    total: 0, guest_count: 2, special_instructions: null,
    created_by: 1, created_at: minutesAgo(11),
    table: { id: 'tbl-12', name: '12', capacity: 4, status: 'occupied', kitchen_station_id: null, floor: null, section: null, is_active: true },
    items: [
      { id: 6, order_id: 1035, product_id: 6, product_name: 'Paneer Tikka', product_sku: null, unit_price: 240, quantity: 1, subtotal: 240, tax_amount: 0, total: 240, addons: null, special_instructions: 'No Bell Peppers', status: 'ready' },
      { id: 7, order_id: 1035, product_id: 7, product_name: 'Butter Naan', product_sku: null, unit_price: 45, quantity: 4, subtotal: 180, tax_amount: 0, total: 180, addons: null, special_instructions: null, status: 'preparing' },
    ],
  },
  {
    id: 1044,
    order_number: 'A-1044',
    table_id: null,
    customer_id: null,
    type: 'delivery',
    status: 'pending',
    subtotal: 0, tax_amount: 0, discount_amount: 0, delivery_charge: 0,
    total: 0, guest_count: null, special_instructions: 'Ring the bell twice',
    created_by: 1, created_at: minutesAgo(1),
    items: [
      { id: 8, order_id: 1044, product_id: 8, product_name: 'Veg Hakka Noodles', product_sku: null, unit_price: 200, quantity: 1, subtotal: 200, tax_amount: 0, total: 200, addons: null, special_instructions: null, status: 'pending' },
    ],
  },
  {
    id: 1030,
    order_number: 'A-1030',
    table_id: 'tbl-03',
    customer_id: null,
    type: 'dine_in',
    status: 'preparing',
    subtotal: 0, tax_amount: 0, discount_amount: 0, delivery_charge: 0,
    total: 0, guest_count: 6, special_instructions: null,
    created_by: 1, created_at: minutesAgo(14),
    table: { id: 'tbl-03', name: '3', capacity: 6, status: 'occupied', kitchen_station_id: null, floor: null, section: null, is_active: true },
    items: [
      { id: 9, order_id: 1030, product_id: 9, product_name: 'Tandoori Roti', product_sku: null, unit_price: 30, quantity: 6, subtotal: 180, tax_amount: 0, total: 180, addons: null, special_instructions: null, status: 'preparing' },
      { id: 10, order_id: 1030, product_id: 10, product_name: 'Dal Makhani', product_sku: null, unit_price: 220, quantity: 2, subtotal: 440, tax_amount: 0, total: 440, addons: null, special_instructions: null, status: 'preparing' },
      { id: 11, order_id: 1030, product_id: 11, product_name: 'Chicken Curry', product_sku: null, unit_price: 260, quantity: 2, subtotal: 520, tax_amount: 0, total: 520, addons: null, special_instructions: 'Mild spice', status: 'preparing' },
      { id: 12, order_id: 1030, product_id: 12, product_name: 'Jeera Rice', product_sku: null, unit_price: 140, quantity: 2, subtotal: 280, tax_amount: 0, total: 280, addons: null, special_instructions: null, status: 'preparing' },
    ],
  },
  {
    id: 1046,
    order_number: 'A-1046',
    table_id: 'tbl-01',
    customer_id: null,
    type: 'dine_in',
    status: 'pending',
    subtotal: 0, tax_amount: 0, discount_amount: 0, delivery_charge: 0,
    total: 0, guest_count: 2, special_instructions: null,
    created_by: 1, created_at: minutesAgo(0),
    table: { id: 'tbl-01', name: '1', capacity: 2, status: 'occupied', kitchen_station_id: null, floor: null, section: null, is_active: true },
    items: [
      { id: 13, order_id: 1046, product_id: 13, product_name: 'Cold Coffee', product_sku: null, unit_price: 120, quantity: 2, subtotal: 240, tax_amount: 0, total: 240, addons: null, special_instructions: null, status: 'pending' },
    ],
  },
];

// --- Elapsed-time chronometer -----------------------------------------------

function useElapsedSeconds(createdAt: string): number {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));

  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return elapsed;
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

type UrgencyLevel = 'fresh' | 'warning' | 'critical';

function urgencyFromMinutes(mins: number): UrgencyLevel {
  if (mins >= 10) return 'critical';
  if (mins >= 5) return 'warning';
  return 'fresh';
}

const URGENCY_STYLES: Record<UrgencyLevel, { badge: string; ring: string; dot: string }> = {
  fresh: { badge: 'bg-green-100 text-green-700 border-green-200', ring: 'border-l-4 border-l-green-500', dot: 'bg-green-500' },
  warning: { badge: 'bg-amber-100 text-amber-700 border-amber-200', ring: 'border-l-4 border-l-amber-500', dot: 'bg-amber-500' },
  critical: { badge: 'bg-red-100 text-red-700 border-red-200', ring: 'border-l-4 border-l-red-500', dot: 'bg-red-500' },
};

const ORDER_TYPE_LABEL = ORDER_TYPE_LABEL_KEYS;

// --- Card --------------------------------------------------------------

function KdsOrderCard({ order, onBump }: { order: Order; onBump: (orderId: number) => void }) {
  const { t } = useI18n();
  const elapsed = useElapsedSeconds(order.created_at);
  const urgency = urgencyFromMinutes(elapsed / 60);
  const styles = URGENCY_STYLES[urgency];
  const items: OrderItem[] = order.items ?? [];

  return (
    <Card className={cn('mb-4 break-inside-avoid-column py-0 gap-0 overflow-hidden', styles.ring)}>
      <CardHeader className="px-4 pt-4 pb-3 border-b gap-1">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-xl font-bold tabular-nums">#{order.order_number}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t(ORDER_TYPE_LABEL[order.type])}
              {order.table && ` · ${t('kds.tableLabel', { name: order.table.name })}`}
              {order.guest_count ? t('kds.guestCount', { count: order.guest_count }) : ''}
            </p>
          </div>
          <Badge className={cn('shrink-0 font-mono text-sm px-2 py-1 gap-1.5', styles.badge)}>
            <span className={cn('size-1.5 rounded-full animate-pulse', styles.dot)} />
            {formatElapsed(elapsed)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="px-4 py-3">
        <ul className="space-y-2.5">
          {items.map((item) => (
            <li key={item.id}>
              <div className="flex items-baseline gap-2">
                <span className="text-base font-bold tabular-nums shrink-0">{item.quantity}×</span>
                <span className="text-base font-medium leading-tight">{item.product_name}</span>
              </div>
              {item.special_instructions && (
                <div className="ml-6 mt-1 rounded-md bg-amber-50 border border-amber-200 px-2 py-1">
                  <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide">
                    ⚠ {item.special_instructions}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>

        {order.special_instructions && (
          <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-2 py-1.5">
            <p className="text-xs font-semibold text-red-700">📝 {order.special_instructions}</p>
          </div>
        )}
      </CardContent>

      <CardFooter className="px-4 pb-4 pt-3 border-t">
        <Button
          className="w-full font-semibold"
          size="lg"
          onClick={() => onBump(order.id)}
        >
          {t('kds.bump')}
        </Button>
      </CardFooter>
    </Card>
  );
}

// --- Board -----------------------------------------------------------------

export default function KdsMasonryBoard() {
  const { t } = useI18n();
  const [orders, setOrders] = useState<Order[]>(MOCK_ORDERS);

  function handleBump(orderId: number) {
    // Placeholder click logic — wire to PATCH /api/orders/:id/status (or
    // per-item status) once integrated with the real KDS feed.
    setOrders((prev) => prev.filter((o) => o.id !== orderId));
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">{t('kds.title')}</h1>
        <Badge variant="outline">{t('kds.ordersActive', { count: orders.length })}</Badge>
      </div>

      {orders.length === 0 ? (
        <p className="text-muted-foreground text-center py-16">{t('kds.emptyAll')}</p>
      ) : (
        <div className="columns-1 md:columns-3 lg:columns-4 xl:columns-5 gap-4">
          {orders.map((order) => (
            <KdsOrderCard key={order.id} order={order} onBump={handleBump} />
          ))}
        </div>
      )}
    </div>
  );
}
