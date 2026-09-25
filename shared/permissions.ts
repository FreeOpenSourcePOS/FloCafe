import {
  ROLE_ACCESS,
  type Role,
} from './role-permissions';

export type PermissionArea =
  | 'orders'
  | 'tables'
  | 'payments'
  | 'cash'
  | 'customers'
  | 'menu'
  | 'inventory'
  | 'kitchen'
  | 'reports'
  | 'staff'
  | 'authorization'
  | 'settings'
  | 'tax'
  | 'printing'
  | 'integrations'
  | 'system'
  | 'apps'
  | 'support';

export type PermissionRisk = 'standard' | 'sensitive' | 'destructive';

type PermissionDefinitionShape = {
  id: string;
  area: PermissionArea;
  defaultRoles: readonly Role[];
  configurable: boolean;
  risk: PermissionRisk;
};

const OWNER = ROLE_ACCESS.owner;
const OWNER_MANAGER = ROLE_ACCESS.ownerManager;
const OWNER_MANAGER_CASHIER = ROLE_ACCESS.ownerManagerCashier;
const SALES = ROLE_ACCESS.sales;
const KITCHEN = ROLE_ACCESS.kitchen;
const ALL_STAFF = ROLE_ACCESS.allStaff;

/**
 * Stable authorization capabilities and their shipped role defaults.
 *
 * Runtime permission IDs are persistence keys. Never reuse an ID for a
 * different meaning. Store-local changes live in sparse override tables, so
 * changing a default here is a product migration and must be reviewed as one.
 */
export const PERMISSION_DEFINITIONS = [
  { id: 'pos.use', area: 'orders', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'standard' },
  { id: 'orders.read', area: 'orders', defaultRoles: SALES, configurable: true, risk: 'standard' },
  { id: 'orders.create', area: 'orders', defaultRoles: SALES, configurable: true, risk: 'standard' },
  { id: 'orders.status.update', area: 'orders', defaultRoles: ALL_STAFF, configurable: true, risk: 'standard' },
  { id: 'orders.customer.update', area: 'orders', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'standard' },
  { id: 'orders.discount.apply', area: 'orders', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'orders.item.cancel', area: 'orders', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'orders.item.void', area: 'orders', defaultRoles: SALES, configurable: true, risk: 'sensitive' },
  { id: 'orders.item.restore', area: 'orders', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'held-orders.manage', area: 'orders', defaultRoles: SALES, configurable: true, risk: 'standard' },

  { id: 'tables.view', area: 'tables', defaultRoles: ALL_STAFF, configurable: true, risk: 'standard' },
  { id: 'tables.manage', area: 'tables', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'standard' },
  { id: 'tables.orders.move', area: 'tables', defaultRoles: SALES, configurable: true, risk: 'standard' },

  { id: 'bills.read', area: 'payments', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'bills.generate', area: 'payments', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'payments.take', area: 'payments', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'bills.discount.apply', area: 'payments', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'bills.print', area: 'payments', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'standard' },
  { id: 'refunds.view', area: 'payments', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'refunds.initiate', area: 'payments', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'payment-methods.view', area: 'payments', defaultRoles: ALL_STAFF, configurable: true, risk: 'standard' },
  { id: 'payment-methods.manage', area: 'payments', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },

  { id: 'cash.shifts.view', area: 'cash', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'cash.shifts.open', area: 'cash', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'cash.shifts.close', area: 'cash', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'cash.movements.manage', area: 'cash', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'cash.movements.void', area: 'cash', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'cash.day-close', area: 'cash', defaultRoles: OWNER, configurable: true, risk: 'sensitive' },

  { id: 'customers.view', area: 'customers', defaultRoles: SALES, configurable: true, risk: 'sensitive' },
  { id: 'customers.create', area: 'customers', defaultRoles: SALES, configurable: true, risk: 'sensitive' },
  { id: 'customers.edit', area: 'customers', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'customers.maintenance', area: 'customers', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'customers.cleanup', area: 'customers', defaultRoles: OWNER, configurable: true, risk: 'destructive' },

  { id: 'catalog.view', area: 'menu', defaultRoles: ALL_STAFF, configurable: true, risk: 'standard' },
  { id: 'catalog.manage', area: 'menu', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'catalog.import-export', area: 'menu', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'inventory.view', area: 'inventory', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'standard' },
  { id: 'inventory.manage', area: 'inventory', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'supplies.manage', area: 'inventory', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },

  { id: 'kitchen.use', area: 'kitchen', defaultRoles: KITCHEN, configurable: true, risk: 'standard' },
  { id: 'kitchen.status.update', area: 'kitchen', defaultRoles: KITCHEN, configurable: true, risk: 'standard' },
  { id: 'kitchen.pair', area: 'kitchen', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'kitchen.stations.manage', area: 'kitchen', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },

  { id: 'dashboard.view', area: 'reports', defaultRoles: OWNER, configurable: true, risk: 'sensitive' },
  { id: 'reports.view', area: 'reports', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'reports.financial.view', area: 'reports', defaultRoles: OWNER, configurable: true, risk: 'sensitive' },
  { id: 'reports.daily-sales.export', area: 'reports', defaultRoles: OWNER, configurable: true, risk: 'sensitive' },

  { id: 'staff.view', area: 'staff', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'staff.operational.manage', area: 'staff', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'staff.privileged.manage', area: 'staff', defaultRoles: OWNER, configurable: false, risk: 'sensitive' },
  { id: 'authorization.manage', area: 'authorization', defaultRoles: OWNER, configurable: false, risk: 'sensitive' },

  { id: 'settings.view', area: 'settings', defaultRoles: ALL_STAFF, configurable: true, risk: 'standard' },
  { id: 'settings.manage', area: 'settings', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'tax-packs.view-test', area: 'tax', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'standard' },
  { id: 'tax-configuration.manage', area: 'tax', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'tax-packs.manage', area: 'tax', defaultRoles: OWNER, configurable: true, risk: 'sensitive' },

  { id: 'printing.execute', area: 'printing', defaultRoles: SALES, configurable: true, risk: 'standard' },
  { id: 'printers.manage', area: 'printing', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'print-templates.view', area: 'printing', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'standard' },
  { id: 'print-templates.manage', area: 'printing', defaultRoles: OWNER, configurable: true, risk: 'sensitive' },

  { id: 'whatsapp.use', area: 'integrations', defaultRoles: OWNER_MANAGER_CASHIER, configurable: true, risk: 'sensitive' },
  { id: 'whatsapp.manage', area: 'integrations', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'cloud.manage', area: 'integrations', defaultRoles: OWNER_MANAGER, configurable: true, risk: 'sensitive' },
  { id: 'cloud.account.manage', area: 'integrations', defaultRoles: OWNER, configurable: true, risk: 'destructive' },
  { id: 'google-drive.manage', area: 'integrations', defaultRoles: OWNER, configurable: true, risk: 'destructive' },

  { id: 'database.manage', area: 'system', defaultRoles: OWNER, configurable: true, risk: 'destructive' },
  { id: 'mobile-access.manage', area: 'system', defaultRoles: OWNER, configurable: true, risk: 'sensitive' },
  { id: 'server-app.use', area: 'apps', defaultRoles: ROLE_ACCESS.serverApp, configurable: true, risk: 'standard' },
  { id: 'support.use', area: 'support', defaultRoles: ALL_STAFF, configurable: true, risk: 'standard' },
] as const satisfies readonly PermissionDefinitionShape[];

export type PermissionDefinition = typeof PERMISSION_DEFINITIONS[number];
export type PermissionId = PermissionDefinition['id'];
export type PermissionEffect = 'allow' | 'deny';

export const PERMISSION_IDS = PERMISSION_DEFINITIONS.map(({ id }) => id) as PermissionId[];

export const PERMISSION_BY_ID = new Map<PermissionId, PermissionDefinition>(
  PERMISSION_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export const PROTECTED_PERMISSION_IDS = PERMISSION_DEFINITIONS
  .filter(({ configurable }) => !configurable)
  .map(({ id }) => id) as PermissionId[];

export function isPermissionId(value: unknown): value is PermissionId {
  return typeof value === 'string' && PERMISSION_BY_ID.has(value as PermissionId);
}

export function defaultPermissionIdsForRole(role: Role): PermissionId[] {
  return PERMISSION_DEFINITIONS
    .filter(({ defaultRoles }) => (defaultRoles as readonly Role[]).includes(role))
    .map(({ id }) => id);
}

export function permissionDefaultAllows(permissionId: PermissionId, role: Role): boolean {
  const definition = PERMISSION_BY_ID.get(permissionId);
  return definition ? (definition.defaultRoles as readonly Role[]).includes(role) : false;
}
