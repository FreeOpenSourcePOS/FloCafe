import type { PermissionArea, PermissionId } from '../../../../shared/permissions';
import {
  PERMISSION_AREA_KEYS,
  PERMISSION_LABEL_KEYS,
  type PermissionAreaKey,
  type PermissionCapabilityKey,
} from './enums';

/**
 * These live here rather than in a settings component so both the matrix, the
 * audit log, and `tests/permission-label-i18n.test.ts` can import them. A 'use
 * client' component module pulls in axios, the auth store and toast, and cannot be
 * loaded by a node test — which is why the coverage test used to grep the component
 * source, and in doing so passed while the defect it guards was live.
 */

/** The capability label, translated. */
export function permissionLabel(permissionId: PermissionId, t: (key: PermissionCapabilityKey) => string): string {
  const key = PERMISSION_LABEL_KEYS[permissionId];
  if (key) return t(`capabilities.${key}` as PermissionCapabilityKey);
  // The fallback, deliberately: an id the catalog gains without a map entry must
  // not crash a row.
  return permissionId.split('.').map((part) => part.replace(/-/g, ' ')).join(' · ');
}

/** The area heading, translated. */
export function permissionAreaLabel(area: PermissionArea, t: (key: PermissionAreaKey) => string): string {
  const key = PERMISSION_AREA_KEYS[area];
  if (key) return t(`areas.${key}` as PermissionAreaKey);
  return area.replace(/-/g, ' ');
}
