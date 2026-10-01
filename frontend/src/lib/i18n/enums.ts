/** Maps backend domain enum and status strings to typed
 * use-intl translation keys. */

import { ORDER_TYPE_LABEL_KEYS } from '../order-types';
import type { Order, Table, OrderItem } from '../types';
import type { AppConfig } from 'use-intl';
import { ROLE_LABEL_KEYS as SHARED_ROLE_LABEL_KEYS } from '../../../../shared/role-permissions';
import type { PermissionArea, PermissionId } from '../../../../shared/permissions';

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

type PermissionMatrixCapabilityKey = keyof AppConfig['Messages']['permissionMatrix']['capabilities'];
type PermissionMatrixAreaKey = keyof AppConfig['Messages']['permissionMatrix']['areas'];

/**
 * Namespace-relative keys for the permission maps below, matching what a
 * `useTranslations('permissionMatrix')` translator accepts. Exported so the dynamic
 * `t()` call sites can pin the key to this closed union, which is what
 * `npm run i18n:check` requires of a template-literal key.
 */
export type PermissionCapabilityKey = `capabilities.${PermissionMatrixCapabilityKey}`;
export type PermissionAreaKey = `areas.${PermissionMatrixAreaKey}`;

/**
 * Permission id → capability label. Exhaustively typed against `PermissionId`, so
 * a new permission fails `npm run i18n:check` until it is named here. Without this
 * the matrix de-slugified the raw id and printed English on every locale.
 *
 * Several ids deliberately share a key where the existing label already covers
 * them (`bills.read` and `bills.generate` are both "view bills, take payments and
 * print receipts"). New keys exist only where no existing label is honest about a
 * capability — `refunds`, `cashDayClose` and friends have no honest home among the
 * 48 labels, and `tablesView` / `inventoryView` exist because the manage label
 * would overstate a view-only capability.
 */
export const PERMISSION_LABEL_KEYS = {
  'pos.use': 'pos',
  'orders.read': 'ordersReadCreate',
  'orders.create': 'ordersReadCreate',
  'orders.status.update': 'ordersStatus',
  'orders.customer.update': 'ordersCustomerDiscounts',
  'orders.discount.apply': 'ordersCustomerDiscounts',
  'orders.item.cancel': 'orderItemCancel',
  'orders.item.void': 'orderItemVoid',
  'orders.item.restore': 'orderItemRestore',
  'held-orders.manage': 'heldOrders',

  'tables.view': 'tablesView',
  'tables.manage': 'tablesManage',
  'tables.orders.move': 'tablesMoveOrders',

  'bills.read': 'billsPayments',
  'bills.generate': 'billsPayments',
  'payments.take': 'billsPayments',
  'bills.print': 'billsPayments',
  'bills.discount.apply': 'billDiscounts',
  'refunds.view': 'refunds',
  'refunds.initiate': 'refunds',
  'payment-methods.view': 'paymentMethodsView',
  'payment-methods.manage': 'paymentMethodsManage',

  'cash.shifts.view': 'cashShiftsView',
  'cash.shifts.open': 'shiftOpen',
  'cash.shifts.close': 'shiftClose',
  'cash.movements.manage': 'cashMovements',
  'cash.movements.void': 'cashMovements',
  'cash.day-close': 'cashDayClose',

  'customers.view': 'customersViewCreate',
  'customers.create': 'customersViewCreate',
  'customers.edit': 'customersEdit',
  'customers.maintenance': 'customerMaintenance',
  'customers.cleanup': 'customerCleanup',

  'catalog.view': 'catalogManagement',
  'catalog.manage': 'catalogManagement',
  'catalog.import-export': 'menuImportExport',

  'inventory.view': 'inventoryView',
  'inventory.manage': 'inventoryManage',
  'supplies.manage': 'inventoryManage',

  'kitchen.use': 'kds',
  'kitchen.status.update': 'kitchenStatusUpdate',
  'kitchen.pair': 'kdsPairing',
  'kitchen.stations.manage': 'kitchenStations',

  'dashboard.view': 'dashboard',
  'reports.view': 'reports',
  'reports.financial.view': 'reports',
  'reports.daily-sales.export': 'reportsDailySalesExport',

  'staff.view': 'staffViewManage',
  'staff.operational.manage': 'operationalStaff',
  'staff.privileged.manage': 'staffOwnerManager',

  'authorization.manage': 'authorizationManage',

  'settings.view': 'settingsView',
  'settings.manage': 'settingsManage',

  'tax-packs.view-test': 'taxPacksViewTest',
  'tax-configuration.manage': 'taxConfiguration',
  'tax-packs.manage': 'taxPacksManage',

  'printing.execute': 'printing',
  'printers.manage': 'printersManage',
  'print-templates.view': 'printTemplatesView',
  'print-templates.manage': 'printTemplatesManage',

  'whatsapp.use': 'whatsappUse',
  'whatsapp.manage': 'whatsappManage',
  'cloud.manage': 'cloudDrive',
  'cloud.account.manage': 'cloudAccountData',
  'google-drive.manage': 'googleDrive',

  'database.manage': 'databaseTools',
  'mobile-access.manage': 'mobileAccessManage',

  'server-app.use': 'serverApp',
  'support.use': 'support',
} as const satisfies Record<PermissionId, PermissionMatrixCapabilityKey>;

/** Permission area → area heading (exhaustively typed against `PermissionArea`). */
export const PERMISSION_AREA_KEYS = {
  orders: 'orders',
  tables: 'tables',
  payments: 'payments',
  cash: 'cash',
  customers: 'customers',
  menu: 'menu',
  inventory: 'inventory',
  kitchen: 'kitchen',
  reports: 'reports',
  staff: 'staff',
  authorization: 'authorization',
  settings: 'settings',
  tax: 'tax',
  printing: 'printing',
  integrations: 'integrations',
  system: 'system',
  apps: 'apps',
  support: 'support',
} as const satisfies Record<PermissionArea, PermissionMatrixAreaKey>;

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
