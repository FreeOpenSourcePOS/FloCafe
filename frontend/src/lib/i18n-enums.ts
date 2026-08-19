/**
 * Maps backend enum/status strings to i18n translation keys.
 *
 * Backend values (roles, order statuses, item statuses, table statuses, etc.)
 * are English identifiers stored in the DB. The UI must never render them
 * raw — pass them through these maps and then through `t()` so every language
 * shows a localized label.
 *
 * Pattern mirrors `ORDER_TYPE_LABEL_KEYS` in order-types.ts.
 * Unknown values fall back to the raw string (then to the key itself in `t()`),
 * so a new backend status never crashes the UI — it just shows in English
 * until a translation key is added.
 */

import { ORDER_TYPE_LABEL_KEYS } from './order-types';
import type { Order, Table } from './types';
import type { AppConfig } from 'use-intl';

export { ORDER_TYPE_LABEL_KEYS };

type OrdersKey = keyof AppConfig['Messages']['orders'];
type TablesKey = keyof AppConfig['Messages']['tables'];

/** Staff/tenant role → label. Used in login tenant picker, staff table, etc. */
export const ROLE_LABEL_KEYS: Record<string, string> = {
  owner: 'staff.roleOwner',
  manager: 'staff.roleManager',
  cashier: 'staff.roleCashier',
  chef: 'staff.roleChef',
  server: 'staff.roleServer',
};

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
 *  backend emits `pending` for fresh items; `waiting` is the KDS term.
 *  `void_adjustment` has no label key and falls back to the raw string. */
export const ITEM_STATUS_LABEL_KEYS = {
  pending: 'itemStatusPending',
  waiting: 'itemStatusWaiting',
  preparing: 'itemStatusPreparing',
  ready: 'itemStatusReady',
  served: 'itemStatusServed',
  cancelled: 'itemStatusCancelled',
  voided: 'itemStatusVoided',
} as const satisfies Record<
  'pending' | 'waiting' | 'preparing' | 'ready' | 'served' | 'cancelled' | 'voided',
  OrdersKey
>;

/** Table status → label (exhaustively typed against `Table['status']`). */
export const TABLE_STATUS_LABEL_KEYS = {
  available: 'statusAvailable',
  occupied: 'statusOccupied',
  reserved: 'statusReserved',
  held: 'statusHeld',
  cleaning: 'statusCleaning',
} as const satisfies Record<Table['status'], TablesKey>;

/** Tenant/business status → label. */
export const TENANT_STATUS_LABEL_KEYS: Record<string, string> = {
  active: 'common.active',
  inactive: 'common.inactive',
  suspended: 'common.inactive',
};

/** Business type → label. Currently only 'restaurant' is valid. */
export const BUSINESS_TYPE_LABEL_KEYS: Record<string, string> = {
  restaurant: 'businessType.restaurant',
};

/** Payment status → label. */
export const PAYMENT_STATUS_LABEL_KEYS: Record<string, string> = {
  paid: 'orders.paid',
  partial: 'orders.partiallyPaid',
  unpaid: 'orders.unpaidBadge',
};
