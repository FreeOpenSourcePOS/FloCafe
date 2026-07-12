'use client';

import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCurrency } from '@/lib/countries';
import type { Order, OrderItem, Bill } from '@/lib/types';

// --- Mock data ---------------------------------------------------------
// Shaped like the real `Order` / `Bill` types (src/lib/types.ts) so this
// swaps over to `GET /api/orders?status=completed,cancelled` with just a
// fetch + map, no shape changes.

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

interface HistoryOrder extends Order {
  bill?: Bill;
}

const MOCK_HISTORY: HistoryOrder[] = [
  {
    id: 981, order_number: 'A-0981', table_id: 'tbl-04', customer_id: null,
    type: 'dine_in', status: 'completed', subtotal: 890, tax_amount: 44.5,
    discount_amount: 0, delivery_charge: 0, total: 934.5, guest_count: 3,
    special_instructions: null, created_by: 1, created_at: hoursAgo(2),
    table: { id: 'tbl-04', name: '4', capacity: 4, status: 'occupied', kitchen_station_id: null, floor: null, section: null, is_active: true },
    items: [
      { id: 1, order_id: 981, product_id: 1, product_name: 'Margherita Pizza', product_sku: null, unit_price: 350, quantity: 2, subtotal: 700, tax_amount: 35, total: 735, addons: null, special_instructions: null, status: 'served' },
      { id: 2, order_id: 981, product_id: 2, product_name: 'Garlic Bread', product_sku: null, unit_price: 150, quantity: 1, subtotal: 150, tax_amount: 7.5, total: 157.5, addons: null, special_instructions: null, status: 'served' },
      { id: 3, order_id: 981, product_id: 3, product_name: 'Cold Coffee', product_sku: null, unit_price: 40, quantity: 1, subtotal: 40, tax_amount: 2, total: 42, addons: null, special_instructions: null, status: 'served' },
    ],
    bill: {
      id: 501, bill_number: 'B-0501', order_id: 981, subtotal: 890, tax_amount: 44.5,
      discount_amount: 0, service_charge: 0, delivery_charge: 0, total: 934.5,
      paid_amount: 934.5, balance: 0, payment_status: 'paid',
      payment_details: [{ method: 'card', amount: 934.5, timestamp: hoursAgo(2) }],
    },
  },
  {
    id: 976, order_number: 'A-0976', table_id: null, customer_id: null,
    type: 'takeaway', status: 'cancelled', subtotal: 480, tax_amount: 24,
    discount_amount: 0, delivery_charge: 0, total: 504, guest_count: null,
    special_instructions: null, created_by: 1, created_at: hoursAgo(5),
    items: [
      { id: 4, order_id: 976, product_id: 4, product_name: 'Chicken Biryani', product_sku: null, unit_price: 280, quantity: 1, subtotal: 280, tax_amount: 14, total: 294, addons: null, special_instructions: null, status: 'cancelled' },
      { id: 5, order_id: 976, product_id: 5, product_name: 'Raita', product_sku: null, unit_price: 60, quantity: 1, subtotal: 60, tax_amount: 3, total: 63, addons: null, special_instructions: null, status: 'cancelled' },
      { id: 6, order_id: 976, product_id: 6, product_name: 'Gulab Jamun', product_sku: null, unit_price: 90, quantity: 1, subtotal: 90, tax_amount: 4.5, total: 94.5, addons: null, special_instructions: null, status: 'cancelled' },
      { id: 7, order_id: 976, product_id: 7, product_name: 'Papad', product_sku: null, unit_price: 30, quantity: 1, subtotal: 30, tax_amount: 1.5, total: 31.5, addons: null, special_instructions: null, status: 'cancelled' },
    ],
    bill: {
      id: 496, bill_number: 'B-0496', order_id: 976, subtotal: 480, tax_amount: 24,
      discount_amount: 0, service_charge: 0, delivery_charge: 0, total: 504,
      paid_amount: 0, balance: 504, payment_status: 'unpaid', payment_details: null,
    },
  },
  {
    id: 970, order_number: 'A-0970', table_id: 'tbl-09', customer_id: null,
    type: 'dine_in', status: 'completed', subtotal: 1240, tax_amount: 62,
    discount_amount: 100, delivery_charge: 0, total: 1202, guest_count: 5,
    special_instructions: null, created_by: 1, created_at: hoursAgo(9),
    table: { id: 'tbl-09', name: '9', capacity: 6, status: 'occupied', kitchen_station_id: null, floor: null, section: null, is_active: true },
    items: [
      { id: 8, order_id: 970, product_id: 8, product_name: 'Paneer Tikka', product_sku: null, unit_price: 240, quantity: 2, subtotal: 480, tax_amount: 24, total: 504, addons: null, special_instructions: null, status: 'served' },
      { id: 9, order_id: 970, product_id: 9, product_name: 'Dal Makhani', product_sku: null, unit_price: 220, quantity: 2, subtotal: 440, tax_amount: 22, total: 462, addons: null, special_instructions: null, status: 'served' },
      { id: 10, order_id: 970, product_id: 10, product_name: 'Butter Naan', product_sku: null, unit_price: 45, quantity: 4, subtotal: 180, tax_amount: 9, total: 189, addons: null, special_instructions: null, status: 'served' },
      { id: 11, order_id: 970, product_id: 11, product_name: 'Jeera Rice', product_sku: null, unit_price: 140, quantity: 1, subtotal: 140, tax_amount: 7, total: 147, addons: null, special_instructions: null, status: 'served' },
    ],
    bill: {
      id: 490, bill_number: 'B-0490', order_id: 970, subtotal: 1240, tax_amount: 62,
      discount_amount: 100, discount_type: 'flat', discount_value: 100, discount_reason: 'Loyalty reward',
      service_charge: 0, delivery_charge: 0, total: 1202,
      paid_amount: 1202, balance: 0, payment_status: 'paid',
      payment_details: [{ method: 'upi', amount: 1202, timestamp: hoursAgo(9) }],
    },
  },
  {
    id: 964, order_number: 'A-0964', table_id: null, customer_id: null,
    type: 'delivery', status: 'completed', subtotal: 360, tax_amount: 18,
    discount_amount: 0, delivery_charge: 40, total: 418, guest_count: null,
    special_instructions: null, created_by: 1, created_at: hoursAgo(26),
    items: [
      { id: 12, order_id: 964, product_id: 12, product_name: 'Veg Hakka Noodles', product_sku: null, unit_price: 200, quantity: 1, subtotal: 200, tax_amount: 10, total: 210, addons: null, special_instructions: null, status: 'served' },
      { id: 13, order_id: 964, product_id: 13, product_name: 'Spring Rolls', product_sku: null, unit_price: 160, quantity: 1, subtotal: 160, tax_amount: 8, total: 168, addons: null, special_instructions: null, status: 'served' },
    ],
    bill: {
      id: 484, bill_number: 'B-0484', order_id: 964, subtotal: 360, tax_amount: 18,
      discount_amount: 0, service_charge: 0, delivery_charge: 40, total: 418,
      paid_amount: 418, balance: 0, payment_status: 'paid',
      payment_details: [{ method: 'cash', amount: 418, timestamp: hoursAgo(26) }],
    },
  },
];

const STATUS_BADGE: Record<string, string> = {
  completed: 'bg-green-100 text-green-700 border-green-200',
  cancelled: 'bg-red-100 text-red-700 border-red-200',
};

const STATUS_LABEL: Record<string, string> = {
  completed: 'Settled',
  cancelled: 'Voided',
};

const ORDER_TYPE_LABEL: Record<Order['type'], string> = {
  dine_in: 'Dine-In',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
  online: 'Online',
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function HistoryOrderCard({ order, currency }: { order: HistoryOrder; currency: string }) {
  const items: OrderItem[] = order.items ?? [];
  const bill = order.bill;
  const fmt = (n: number) => formatCurrency(n, currency);

  return (
    <Card className="gap-0 py-0 overflow-hidden">
      <CardHeader className="px-4 pt-4 pb-3 border-b gap-1">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base font-bold">#{order.order_number}</CardTitle>
            <CardDescription>{formatTimestamp(order.created_at)}</CardDescription>
          </div>
          <Badge className={STATUS_BADGE[order.status] ?? ''} variant="outline">
            {STATUS_LABEL[order.status] ?? order.status}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {ORDER_TYPE_LABEL[order.type]}
          {order.table && ` · Table ${order.table.name}`}
          {order.guest_count ? ` · ${order.guest_count} guests` : ''}
        </p>
      </CardHeader>

      <CardContent className="px-4 py-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-0">Item</TableHead>
              <TableHead className="px-0 text-center w-10">Qty</TableHead>
              <TableHead className="px-0 text-right">Rate</TableHead>
              <TableHead className="px-0 text-right">Amt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} className="hover:bg-transparent">
                <TableCell className="px-0 py-1.5 text-sm">{item.product_name}</TableCell>
                <TableCell className="px-0 py-1.5 text-sm text-center tabular-nums">{item.quantity}</TableCell>
                <TableCell className="px-0 py-1.5 text-sm text-right tabular-nums">{fmt(item.unit_price)}</TableCell>
                <TableCell className="px-0 py-1.5 text-sm text-right tabular-nums">{fmt(item.subtotal)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Separator className="my-3" />

        <div className="space-y-1 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span className="tabular-nums">{fmt(order.subtotal)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Tax</span>
            <span className="tabular-nums">{fmt(order.tax_amount)}</span>
          </div>
          {order.discount_amount > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Discount{bill?.discount_reason ? ` (${bill.discount_reason})` : ''}</span>
              <span className="tabular-nums">−{fmt(order.discount_amount)}</span>
            </div>
          )}
          {order.delivery_charge > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Delivery</span>
              <span className="tabular-nums">{fmt(order.delivery_charge)}</span>
            </div>
          )}
          <Separator className="my-1.5" />
          <div className="flex justify-between font-bold text-base">
            <span>Grand Total</span>
            <span className="tabular-nums">{fmt(order.total)}</span>
          </div>
        </div>
      </CardContent>

      <CardFooter className="px-4 pb-4 pt-3 border-t flex flex-wrap gap-2">
        <Button variant="outline" size="sm">Print Receipt</Button>
        {order.status === 'completed' && (
          <Button variant="outline" size="sm">Reopen Order</Button>
        )}
        <Button variant="ghost" size="sm">View Logs</Button>
      </CardFooter>
    </Card>
  );
}

export default function OrderHistoryGrid() {
  const [orders] = useState<HistoryOrder[]>(MOCK_HISTORY);
  const currency = 'INR'; // sourced from tenant.currency in the real page

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Order History</h1>
        <Badge variant="outline">{orders.length} orders</Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 auto-rows-max content-start items-start">
        {orders.map((order) => (
          <HistoryOrderCard key={order.id} order={order} currency={currency} />
        ))}
      </div>
    </div>
  );
}
