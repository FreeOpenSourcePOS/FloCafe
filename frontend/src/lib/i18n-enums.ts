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

export { ORDER_TYPE_LABEL_KEYS };

/** Staff/tenant role → label. Used in login tenant picker, staff table, etc. */
export const ROLE_LABEL_KEYS: Record<string, string> = {
  owner: 'staff.roleOwner',
  manager: 'staff.roleManager',
  cashier: 'staff.roleCashier',
  chef: 'staff.roleChef',
  server: 'staff.roleServer',
};

/** Order-level status → label. */
export const ORDER_STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'orders.pending',
  preparing: 'orders.preparing',
  ready: 'orders.ready',
  served: 'orders.served',
  completed: 'orders.completed',
  cancelled: 'orders.cancelled',
};

/** Individual order-item status → label. Note `pending` ≠ `waiting`: the
 *  backend emits `pending` for fresh items; `waiting` is the KDS term. */
export const ITEM_STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'orders.itemStatusPending',
  waiting: 'orders.itemStatusWaiting',
  preparing: 'orders.itemStatusPreparing',
  ready: 'orders.itemStatusReady',
  served: 'orders.itemStatusServed',
  cancelled: 'orders.itemStatusCancelled',
  voided: 'orders.itemStatusVoided',
};

/** Table status → label. */
export const TABLE_STATUS_LABEL_KEYS: Record<string, string> = {
  available: 'tables.statusAvailable',
  occupied: 'tables.statusOccupied',
  reserved: 'tables.statusReserved',
  held: 'tables.statusHeld',
  cleaning: 'tables.statusCleaning',
};

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
