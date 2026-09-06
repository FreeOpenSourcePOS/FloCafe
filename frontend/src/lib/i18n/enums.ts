/** Maps backend domain enum and status strings to typed
 * use-intl translation keys. */

import { ORDER_TYPE_LABEL_KEYS } from '../order-types';
import type { Order, Table, OrderItem } from '../types';
import type { AppConfig } from 'use-intl';
import { ROLE_LABEL_KEYS as SHARED_ROLE_LABEL_KEYS } from '../../../../shared/role-permissions';

export { ORDER_TYPE_LABEL_KEYS };

type OrdersKey = keyof AppConfig['Messages']['orders'];
type TablesKey = keyof AppConfig['Messages']['tables'];
type StaffKey = keyof AppConfig['Messages']['staff'];
type CommonKey = keyof AppConfig['Messages']['common'];
type BusinessTypeKey = keyof AppConfig['Messages']['businessType'];

/** Staff/tenant role → label. Used in login tenant picker, staff table, etc. */
export const ROLE_LABEL_KEYS = SHARED_ROLE_LABEL_KEYS as Record<string, StaffKey>;

/** Order-level status → label (exhaustively typed against `Order['status']`). */
export const ORDER_STATUS_LABEL_KEYS = {
  pending: 'pending',
  preparing: 'preparing',
  ready: 'ready',
  served: 'served',
  completed: 'completed',
  cancelled: 'cancelled',
} as const satisfies Record<Order['status'], OrdersKey>;

/** Individual order-item status → label. Note `pending` ≠ `waiting`: the
 *  backend emits `pending` for fresh items; `waiting` is the KDS term. */
export const ITEM_STATUS_LABEL_KEYS = {
  pending: 'itemStatusPending',
  waiting: 'itemStatusWaiting',
  preparing: 'itemStatusPreparing',
  ready: 'itemStatusReady',
  served: 'itemStatusServed',
  cancelled: 'itemStatusCancelled',
  voided: 'itemStatusVoided',
  void_adjustment: 'itemStatusVoidAdjustment',
} as const satisfies Record<OrderItem['status'] | 'waiting', OrdersKey>;

/** Table status → label (exhaustively typed against `Table['status']`). */
export const TABLE_STATUS_LABEL_KEYS = {
  available: 'statusAvailable',
  occupied: 'statusOccupied',
  reserved: 'statusReserved',
  held: 'statusHeld',
  cleaning: 'statusCleaning',
} as const satisfies Record<Table['status'], TablesKey>;

/** Tenant/business status → label. */
export const TENANT_STATUS_LABEL_KEYS = {
  active: 'active',
  inactive: 'inactive',
  suspended: 'inactive',
} as const satisfies Record<'active' | 'inactive' | 'suspended', CommonKey>;

/** Business type → label. Currently only 'restaurant' is valid. */
export const BUSINESS_TYPE_LABEL_KEYS = {
  restaurant: 'restaurant',
} as const satisfies Record<'restaurant', BusinessTypeKey>;

/** Payment status → label. */
export const PAYMENT_STATUS_LABEL_KEYS = {
  paid: 'paid',
  partial: 'partiallyPaid',
  unpaid: 'unpaidBadge',
} as const satisfies Record<'paid' | 'partial' | 'unpaid', OrdersKey>;
