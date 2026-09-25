import type { Tenant } from '@/lib/types';
import {
  permissionDefaultAllows,
  type PermissionId,
} from '@shared/permissions';
import { isRole } from '@shared/role-permissions';

/** Client-side UX gate only; the backend always re-checks live authorization. */
export function tenantCan(tenant: Tenant | null | undefined, permissionId: PermissionId): boolean {
  if (!tenant) return false;
  if (Array.isArray(tenant.permission_ids)) return tenant.permission_ids.includes(permissionId);
  return isRole(tenant.role) && permissionDefaultAllows(permissionId, tenant.role);
}
