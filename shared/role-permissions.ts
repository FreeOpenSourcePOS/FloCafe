/**
 * Fixed FloCafe role definitions and authorization groups.
 *
 * Backend route gates import ROLE_ACCESS from this module. The renderer uses
 * PERMISSION_CAPABILITIES to render the read-only matrix, so the matrix stays
 * aligned with the same role groups that protect the runtime surfaces.
 */

export const ROLE_DEFINITIONS = [
  { id: 'owner', labelKey: 'roleOwner', descriptionKey: 'ownerDescription' },
  { id: 'manager', labelKey: 'roleManager', descriptionKey: 'managerDescription' },
  { id: 'cashier', labelKey: 'roleCashier', descriptionKey: 'cashierDescription' },
  { id: 'server', labelKey: 'roleServer', descriptionKey: 'serverDescription' },
  { id: 'chef', labelKey: 'roleChef', descriptionKey: 'chefDescription' },
] as const;

export type Role = typeof ROLE_DEFINITIONS[number]['id'];
export type RoleLabelKey = typeof ROLE_DEFINITIONS[number]['labelKey'];

export const ROLE_KEYS = ROLE_DEFINITIONS.map(({ id }) => id) as [Role, ...Role[]];
export const ROLE_LABEL_KEYS = Object.fromEntries(
  ROLE_DEFINITIONS.map(({ id, labelKey }) => [id, labelKey]),
) as Record<Role, RoleLabelKey>;

const OWNER = ['owner'] as const satisfies readonly Role[];
const OWNER_MANAGER = ['owner', 'manager'] as const satisfies readonly Role[];
const OWNER_MANAGER_CASHIER = ['owner', 'manager', 'cashier'] as const satisfies readonly Role[];
const SALES = ['owner', 'manager', 'cashier', 'server'] as const satisfies readonly Role[];
const CASHIER_SERVER = ['cashier', 'server'] as const satisfies readonly Role[];
const KITCHEN = ['owner', 'manager', 'chef'] as const satisfies readonly Role[];
const ORDER_STATUS = ['owner', 'manager', 'cashier', 'server', 'chef'] as const satisfies readonly Role[];
const ALL_STAFF = ['owner', 'manager', 'cashier', 'server', 'chef'] as const satisfies readonly Role[];
const SERVER_APP = ['server', 'manager', 'owner'] as const satisfies readonly Role[];
export const OPERATIONAL_ROLES = ['cashier', 'server', 'chef'] as const satisfies readonly Role[];

/** Named role groups used by backend middleware and frontend surface gates. */
export const ROLE_ACCESS = {
  owner: OWNER,
  ownerManager: OWNER_MANAGER,
  ownerManagerCashier: OWNER_MANAGER_CASHIER,
  sales: SALES,
  cashierServer: CASHIER_SERVER,
  kitchen: KITCHEN,
  orderStatus: ORDER_STATUS,
  allStaff: ALL_STAFF,
  serverApp: SERVER_APP,
  operational: OPERATIONAL_ROLES,
} as const;

export type RoleAccessKey = keyof typeof ROLE_ACCESS;

export type PermissionArea =
  | 'orders'
  | 'payments'
  | 'customers'
  | 'menu'
  | 'kitchen'
  | 'reports'
  | 'staff'
  | 'settings'
  | 'integrations'
  | 'system'
  | 'support';

export type PermissionCapability = {
  id: string;
  area: PermissionArea;
  labelKey: string;
  allowedRoles: readonly Role[];
};

/**
 * Capability rows are intentionally action-oriented. Each allowedRoles value
 * is one of ROLE_ACCESS, which is also used by the matching route middleware.
 */
export const PERMISSION_CAPABILITIES = [
  { id: 'pos', area: 'orders', labelKey: 'pos', allowedRoles: ROLE_ACCESS.ownerManagerCashier },
  { id: 'dashboard', area: 'reports', labelKey: 'dashboard', allowedRoles: ROLE_ACCESS.owner },
  { id: 'ordersReadCreate', area: 'orders', labelKey: 'ordersReadCreate', allowedRoles: ROLE_ACCESS.sales },
  { id: 'ordersStatus', area: 'orders', labelKey: 'ordersStatus', allowedRoles: ROLE_ACCESS.orderStatus },
  { id: 'ordersCustomerDiscounts', area: 'orders', labelKey: 'ordersCustomerDiscounts', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'orderItemCancel', area: 'orders', labelKey: 'orderItemCancel', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'orderItemVoid', area: 'orders', labelKey: 'orderItemVoid', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'orderItemRestore', area: 'orders', labelKey: 'orderItemRestore', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'heldOrders', area: 'orders', labelKey: 'heldOrders', allowedRoles: ROLE_ACCESS.sales },
  { id: 'billsPayments', area: 'payments', labelKey: 'billsPayments', allowedRoles: ROLE_ACCESS.ownerManagerCashier },
  { id: 'billDiscounts', area: 'payments', labelKey: 'billDiscounts', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'paymentMethodsView', area: 'payments', labelKey: 'paymentMethodsView', allowedRoles: ROLE_ACCESS.allStaff },
  { id: 'paymentMethodsManage', area: 'payments', labelKey: 'paymentMethodsManage', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'printing', area: 'payments', labelKey: 'printing', allowedRoles: ROLE_ACCESS.ownerManagerCashier },
  { id: 'customersViewCreate', area: 'customers', labelKey: 'customersViewCreate', allowedRoles: ROLE_ACCESS.sales },
  { id: 'customersEdit', area: 'customers', labelKey: 'customersEdit', allowedRoles: ROLE_ACCESS.ownerManagerCashier },
  { id: 'customerMaintenance', area: 'customers', labelKey: 'customerMaintenance', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'customerCleanup', area: 'customers', labelKey: 'customerCleanup', allowedRoles: ROLE_ACCESS.owner },
  { id: 'catalogManagement', area: 'menu', labelKey: 'catalogManagement', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'menuImportExport', area: 'menu', labelKey: 'menuImportExport', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'tablesManage', area: 'orders', labelKey: 'tablesManage', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'tablesMoveOrders', area: 'orders', labelKey: 'tablesMoveOrders', allowedRoles: ROLE_ACCESS.sales },
  { id: 'kds', area: 'kitchen', labelKey: 'kds', allowedRoles: ROLE_ACCESS.kitchen },
  { id: 'kdsPairing', area: 'kitchen', labelKey: 'kdsPairing', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'kitchenStations', area: 'kitchen', labelKey: 'kitchenStations', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'reports', area: 'reports', labelKey: 'reports', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'staffViewManage', area: 'staff', labelKey: 'staffViewManage', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'staffOwnerManager', area: 'staff', labelKey: 'staffOwnerManager', allowedRoles: ROLE_ACCESS.owner },
  { id: 'operationalStaff', area: 'staff', labelKey: 'operationalStaff', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'settingsView', area: 'settings', labelKey: 'settingsView', allowedRoles: ROLE_ACCESS.allStaff },
  { id: 'settingsManage', area: 'settings', labelKey: 'settingsManage', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'taxPacksViewTest', area: 'settings', labelKey: 'taxPacksViewTest', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'taxPacksManage', area: 'settings', labelKey: 'taxPacksManage', allowedRoles: ROLE_ACCESS.owner },
  { id: 'taxConfiguration', area: 'settings', labelKey: 'taxConfiguration', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'printTemplatesView', area: 'settings', labelKey: 'printTemplatesView', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'printTemplatesManage', area: 'settings', labelKey: 'printTemplatesManage', allowedRoles: ROLE_ACCESS.owner },
  { id: 'printersManage', area: 'settings', labelKey: 'printersManage', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'whatsappUse', area: 'integrations', labelKey: 'whatsappUse', allowedRoles: ROLE_ACCESS.ownerManagerCashier },
  { id: 'whatsappManage', area: 'integrations', labelKey: 'whatsappManage', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'cloudDrive', area: 'integrations', labelKey: 'cloudDrive', allowedRoles: ROLE_ACCESS.ownerManager },
  { id: 'cloudAccountData', area: 'integrations', labelKey: 'cloudAccountData', allowedRoles: ROLE_ACCESS.owner },
  { id: 'databaseTools', area: 'system', labelKey: 'databaseTools', allowedRoles: ROLE_ACCESS.owner },
  { id: 'serverApp', area: 'orders', labelKey: 'serverApp', allowedRoles: ROLE_ACCESS.serverApp },
  { id: 'support', area: 'support', labelKey: 'support', allowedRoles: ROLE_ACCESS.allStaff },
] as const satisfies readonly PermissionCapability[];

export type PermissionCapabilityId = typeof PERMISSION_CAPABILITIES[number]['id'];

export function isRole(value: string | null | undefined): value is Role {
  return ROLE_KEYS.includes(value as Role);
}

export function hasRole(value: string | null | undefined, allowedRoles: readonly Role[]): boolean {
  return isRole(value) && allowedRoles.includes(value);
}

export function capabilityAllows(capability: PermissionCapability, role: string | null | undefined): boolean {
  return hasRole(role, capability.allowedRoles);
}
