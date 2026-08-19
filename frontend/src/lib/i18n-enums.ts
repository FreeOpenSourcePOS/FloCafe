/**
 * Maps backend enum/status strings to i18n translation keys.
 *
 * Backend values (roles, order statuses, item statuses, table statuses, etc.)
 * are English identifiers stored in the DB. The UI must never render them
 * raw — pass them through these maps and then through the appropriate
 * translator (`useTranslations()` leaf keys or legacy `t()` dotted keys) so
 * every language shows a localized label.
 *
 * Migrated status maps (`ORDER_STATUS_LABEL_KEYS`, `ITEM_STATUS_LABEL_KEYS`,
 * `TABLE_STATUS_LABEL_KEYS`) are exhaustively typed against use-intl leaf keys.
 * Unmigrated maps retain dotted keys for legacy `t()` callers until their
 * batches migrate.
 *
 * Unknown values fall back to the raw string, so a new backend status never
 * crashes the UI — it just shows in English until a translation key is added.
 */

import { ORDER_TYPE_LABEL_KEYS } from './order-types';
import type { Order, Table } from './types';
import type { AppConfig } from 'use-intl';

export { ORDER_TYPE_LABEL_KEYS };

type OrdersKey = keyof AppConfig['Messages']['orders'];
type TablesKey = keyof AppConfig['Messages']['tables'];
type StaffKey = keyof AppConfig['Messages']['staff'];
type CommonKey = keyof AppConfig['Messages']['common'];
type BusinessTypeKey = keyof AppConfig['Messages']['businessType'];

/** Staff/tenant role → label. Used in login tenant picker, staff table, etc. */
export const ROLE_LABEL_KEYS = {
  owner: 'roleOwner',
  manager: 'roleManager',
  cashier: 'roleCashier',
  chef: 'roleChef',
  server: 'roleServer',
} as const satisfies Record<'owner' | 'manager' | 'cashier' | 'chef' | 'server', StaffKey>;

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
