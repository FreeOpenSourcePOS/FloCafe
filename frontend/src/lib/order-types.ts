import type { AppConfig } from 'use-intl';
import type { Order } from './types';

type OrdersKey = keyof AppConfig['Messages']['orders'];

/** Order-type domain union (mirrors `Order['type']`). */
export type OrderType = Order['type'];

/** Maps OrderType enum to typed use-intl orders leaf keys. */
export const ORDER_TYPE_LABEL_KEYS = {
  dine_in: 'dineIn',
  takeaway: 'takeaway',
  delivery: 'delivery',
  online: 'online',
} as const satisfies Record<OrderType, OrdersKey>;
