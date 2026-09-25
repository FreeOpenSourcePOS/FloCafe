/**
 * Configurable authorization registry, migration, and resolver coverage.
 * Run: npm run test:authorization-permissions
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-authorization-permissions-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, getCurrentSchemaVersion, now } = require('../main/db');
const {
  PERMISSION_DEFINITIONS,
  PERMISSION_IDS,
  defaultPermissionIdsForRole,
  isPermissionId,
} = require('../shared/permissions');
const { resolveEffectivePermissions, hasPermission } = require('../main/services/authorization');

function seedUser(db: any, id: string, role: string, active = 1): void {
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 'unused-test-hash', ?, ?, ?, ?)
  `).run(id, id, `${id}@test.local`, role, active, now(), now());
}

function insertRoleOverride(db: any, role: string, permissionId: string, effect: string): void {
  db.prepare(`
    INSERT INTO role_permission_overrides
      (role, permission_id, effect, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 'owner-permissions', ?, ?)
  `).run(role, permissionId, effect, now(), now());
}

function insertUserOverride(db: any, userId: string, permissionId: string, effect: string): void {
  db.prepare(`
    INSERT INTO user_permission_overrides
      (user_id, permission_id, effect, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 'owner-permissions', ?, ?)
  `).run(userId, permissionId, effect, now(), now());
}

function main(): void {
  initDatabase();
  const db = getDatabase();

  assert.equal(getCurrentSchemaVersion(), 93, 'permission schema is migration v93');
  for (const table of ['role_permission_overrides', 'user_permission_overrides', 'authorization_audit_log']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} exists`);
  }

  const ids = PERMISSION_DEFINITIONS.map((definition: any) => definition.id);
  assert.equal(new Set(ids).size, ids.length, 'permission IDs are unique');
  assert.deepEqual(ids, PERMISSION_IDS, 'permission ID list follows registry order');
  for (const definition of PERMISSION_DEFINITIONS) {
    assert.ok(definition.area, `${definition.id} has an area`);
    assert.ok(['standard', 'sensitive', 'destructive'].includes(definition.risk), `${definition.id} has a valid risk`);
    assert.ok(isPermissionId(definition.id), `${definition.id} is recognized`);
  }
  assert.equal(isPermissionId('unknown.permission'), false, 'unknown permission IDs are rejected');

  seedUser(db, 'owner-permissions', 'owner');
  seedUser(db, 'manager-permissions', 'manager');
  seedUser(db, 'cashier-permissions', 'cashier');
  seedUser(db, 'server-permissions', 'server');
  seedUser(db, 'chef-permissions', 'chef');
  seedUser(db, 'inactive-permissions', 'manager', 0);

  for (const role of ['owner', 'manager', 'cashier', 'server', 'chef']) {
    const effective = resolveEffectivePermissions(`${role}-permissions`);
    assert.ok(effective, `${role} resolves`);
    assert.deepEqual(
      [...effective.permissionIds].sort(),
      [...defaultPermissionIdsForRole(role)].sort(),
      `${role} starts with its shipped defaults`,
    );
  }

  assert.equal(hasPermission('manager-permissions', 'reports.view'), true, 'manager receives default report access');
  assert.equal(hasPermission('cashier-permissions', 'reports.view'), false, 'cashier lacks default report access');
  assert.equal(hasPermission('server-permissions', 'orders.read'), true, 'server receives open order access');
  assert.equal(hasPermission('chef-permissions', 'kitchen.use'), true, 'chef receives KDS access');
  assert.equal(hasPermission('inactive-permissions', 'reports.view'), false, 'inactive users have no usable permissions');
  assert.equal(resolveEffectivePermissions('missing-user'), null, 'missing users do not resolve');

  // The tax preview gate is requireAnyPermission('pos.use', 'orders.create', 'kitchen.use').
  // Their union has to stay every role, or the checkout modal 403s mid-cart.
  const basketPricingRoles = ['owner', 'manager', 'cashier', 'server', 'chef'] as const;
  for (const role of basketPricingRoles) {
    const permissions = defaultPermissionIdsForRole(role);
    assert.ok(
      ['pos.use', 'orders.create', 'kitchen.use'].some((permissionId) => (permissions as readonly string[]).includes(permissionId)),
      `${role} can price a basket under the shipped defaults`,
    );
  }

  // bills.print is a payments-area permission, not a second name for bills.discount.apply.
  assert.deepEqual(defaultPermissionIdsForRole('cashier').includes('bills.print'), false, 'cashier does not receive bills.print');
  assert.deepEqual(defaultPermissionIdsForRole('server').includes('bills.print'), false, 'server does not receive bills.print');
  assert.equal(defaultPermissionIdsForRole('manager').includes('bills.print'), true, 'manager receives bills.print');
  assert.equal(defaultPermissionIdsForRole('owner').includes('bills.print'), true, 'owner receives bills.print');

  insertRoleOverride(db, 'manager', 'reports.view', 'deny');
  assert.equal(hasPermission('manager-permissions', 'reports.view'), false, 'role deny overrides shipped allow');
  insertUserOverride(db, 'manager-permissions', 'reports.view', 'allow');
  assert.equal(hasPermission('manager-permissions', 'reports.view'), true, 'user allow overrides role deny');

  insertRoleOverride(db, 'cashier', 'dashboard.view', 'allow');
  assert.equal(hasPermission('cashier-permissions', 'dashboard.view'), true, 'role allow overrides shipped deny');
  insertUserOverride(db, 'cashier-permissions', 'dashboard.view', 'deny');
  assert.equal(hasPermission('cashier-permissions', 'dashboard.view'), false, 'user deny overrides role allow');

  insertRoleOverride(db, 'manager', 'authorization.manage', 'allow');
  insertUserOverride(db, 'manager-permissions', 'staff.privileged.manage', 'allow');
  assert.equal(hasPermission('manager-permissions', 'authorization.manage'), false, 'protected IAM permission cannot be granted to manager');
  assert.equal(hasPermission('manager-permissions', 'staff.privileged.manage'), false, 'protected privileged staff permission cannot be granted to manager');

  insertRoleOverride(db, 'owner', 'authorization.manage', 'deny');
  insertUserOverride(db, 'owner-permissions', 'staff.privileged.manage', 'deny');
  const ownerEffective = resolveEffectivePermissions('owner-permissions');
  assert.equal(hasPermission('owner-permissions', 'authorization.manage'), true, 'owner cannot lose protected IAM permission');
  assert.equal(hasPermission('owner-permissions', 'staff.privileged.manage'), true, 'owner cannot lose protected privileged staff permission');
  assert.equal(ownerEffective.decisions['authorization.manage'].source, 'protected_rule');

  insertRoleOverride(db, 'manager', 'removed.permission', 'allow');
  assert.equal(resolveEffectivePermissions('manager-permissions').permissionIds.has('removed.permission'), false, 'unknown stored permission fails closed');

  console.log('Configurable authorization permission tests passed');
}

try {
  main();
} finally {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
}
