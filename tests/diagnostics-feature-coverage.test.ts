const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-diagnostics-feature-coverage-'));

Module._load = function (request: string) {
  if (request === 'electron')
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-diagnostics-feature-coverage';

const assert = require('node:assert/strict');
const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  api,
  closeDatabase,
} = require('./helpers/test-setup');
const { cloudSync } = require('../main/services/cloud-sync');
const { staffRoutes } = require('../main/routes/staff');
const { customerRoutes } = require('../main/routes/customers');
const { productRoutes } = require('../main/routes/products');
const { categoryRoutes } = require('../main/routes/categories');
const { addonGroupRoutes } = require('../main/routes/addon-groups');
const { inventoryRoutes } = require('../main/routes/inventory');
const { supplyRoutes } = require('../main/routes/supplies');
const { recipeRoutes } = require('../main/routes/recipes');
const { authRoutes } = require('../main/routes/auth');
const { authorizationRoutes } = require('../main/routes/authorization');
const { reportRoutes } = require('../main/routes/reports');
const { menuCsvRoutes } = require('../main/routes/menu-csv');
const authorizationService = require('../main/services/authorization');
const { setMasterPin } = require('../main/services/master-pin');
const { createSupply } = require('../main/services/supplies');

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'diag-feature-category', 'Diagnostics test');
  seedProduct(db, 'diag-feature-target', 'diag-feature-category', 'Inventory target', 100);
  seedProduct(db, 'diag-feature-linked', 'diag-feature-category', 'Linked product', 100, {
    inventory_product_id: 'diag-feature-target',
  });

  const app = createApp({
    '/api/auth': authRoutes,
    '/api/permissions': authorizationRoutes,
    '/api/staff': staffRoutes,
    '/api/customers': customerRoutes,
    '/api/products': productRoutes,
    '/api/categories': categoryRoutes,
    '/api/addon-groups': addonGroupRoutes,
    '/api/inventory': inventoryRoutes,
    '/api/supplies': supplyRoutes,
    '/api/recipes': recipeRoutes,
    '/api/reports': reportRoutes,
    '/api/menu/csv': menuCsvRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  const captured: any[] = [];
  const originalCapture = cloudSync.captureOperationFailure;
  cloudSync.captureOperationFailure = (failure: any) => captured.push(failure);

  try {
    const unauthenticated = await api(baseUrl, '/api/staff');
    assert.equal(unauthenticated.status, 401, 'routine unauthenticated access remains rejected');
    assert.equal(
      captured.length,
      0,
      'routine authentication rejection is not automatically captured',
    );

    const invalidLogin = await api(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@test.local', password: 'wrong-password' },
    });
    assert.equal(invalidLogin.status, 401, 'an ordinary wrong-password login remains rejected');
    assert.equal(
      captured.length,
      0,
      'routine authentication failure is not automatically captured',
    );

    const demoteLastOwner = await api(baseUrl, `/api/staff/${owner.userId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { role: 'manager' },
    });
    assert.equal(demoteLastOwner.status, 400, 'the only active owner cannot be demoted');
    assert.equal(
      demoteLastOwner.data.code,
      'administration_unreachable',
      'the service guard keeps its existing error code',
    );

    const lastOwner = await api(baseUrl, `/api/staff/${owner.userId}/deactivate`, {
      method: 'POST',
      headers: owner.authHeader,
    });
    assert.equal(lastOwner.status, 400, 'the last active owner cannot be deactivated');
    assert.equal(
      lastOwner.data.code,
      'administration_unreachable',
      'the service guard keeps its existing error code',
    );
    assert.equal(
      db.prepare('SELECT role FROM users WHERE id = ?').get(owner.userId).role,
      'owner',
      'the protected role remains unchanged',
    );
    assert.equal(
      db.prepare('SELECT is_active FROM users WHERE id = ?').get(owner.userId).is_active,
      1,
      'the protected account remains active',
    );
    assert.deepEqual(
      captured.map(
        ({
          capture_point,
          reason_code,
          operation,
          stage,
          classification,
          outcome,
          facts,
        }: any) => ({
          capture_point,
          reason_code,
          operation,
          stage,
          classification,
          outcome,
          facts,
        }),
      ),
      [1, 2].map(() => ({
        capture_point: 'fc.backend.staff.administration_access_guard',
        reason_code: 'staff.administration_invariant',
        operation: 'staff.manage',
        stage: 'validation',
        classification: 'expected_rejection',
        outcome: 'not_applied',
        facts: {},
      })),
      'the protected last-owner rejection branches emit their exact safe expected tuple',
    );

    const captureBeforeFailureTest = cloudSync.captureOperationFailure;
    cloudSync.captureOperationFailure = () => {
      throw new Error('synthetic synchronous diagnostics dispatch failure');
    };
    try {
      const reportingFailure = await api(baseUrl, `/api/staff/${owner.userId}/deactivate`, {
        method: 'POST',
        headers: owner.authHeader,
      });
      assert.equal(
        reportingFailure.status,
        400,
        'a synchronous diagnostics dispatch failure does not replace the staff guard response',
      );
      assert.equal(
        reportingFailure.data.code,
        'administration_unreachable',
        'the original staff guard code survives diagnostics failure',
      );
      assert.equal(
        db.prepare('SELECT is_active FROM users WHERE id = ?').get(owner.userId).is_active,
        1,
        'the failed report dispatch leaves the owner active',
      );
    } finally {
      cloudSync.captureOperationFailure = captureBeforeFailureTest;
    }

    const duplicateStaff = await api(baseUrl, '/api/staff', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        name: 'Another owner',
        email: 'owner@test.local',
        password: 'TestPass123',
        role: 'cashier',
      },
    });
    assert.equal(duplicateStaff.status, 400, 'a duplicate staff email is rejected');

    setMasterPin('1234');
    const passwordBeforeRecovery = db
      .prepare('SELECT password FROM users WHERE id = ?')
      .get(owner.userId).password;
    let administratorChecks = 0;
    const originalHasActiveAdministrator = authorizationService.hasActiveAdministrator;
    authorizationService.hasActiveAdministrator = () => {
      const reachable = originalHasActiveAdministrator();
      administratorChecks++;
      if (administratorChecks === 2) {
        db.prepare("UPDATE users SET role = 'manager' WHERE id = ?").run(owner.userId);
      }
      return reachable;
    };
    try {
      const recoveryRace = await api(baseUrl, '/api/auth/recover-password', {
        method: 'POST',
        body: { email: 'owner@test.local', master_pin: '1234', new_password: 'TestPass1234' },
      });
      assert.equal(recoveryRace.status, 409, 'password recovery rejects an owner-state race');
      assert.equal(
        recoveryRace.data.error,
        'Owner access changed during recovery. Try again.',
        'password recovery keeps its existing conflict response',
      );
      assert.equal(
        db.prepare('SELECT role FROM users WHERE id = ?').get(owner.userId).role,
        'manager',
        'the simulated concurrent owner-state change is retained',
      );
      assert.equal(
        db.prepare('SELECT password FROM users WHERE id = ?').get(owner.userId).password,
        passwordBeforeRecovery,
        'a rejected recovery leaves its password unchanged',
      );
    } finally {
      authorizationService.hasActiveAdministrator = originalHasActiveAdministrator;
      db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.userId);
    }

    const ownerPermissionState = await api(baseUrl, `/api/permissions/users/${owner.userId}`, {
      headers: owner.authHeader,
    });
    const administrationGuard = await api(baseUrl, `/api/permissions/users/${owner.userId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        revision: ownerPermissionState.data.revision,
        overrides: [{ permission_id: 'staff.operational.manage', effect: 'deny' }],
      },
    });
    assert.equal(
      administrationGuard.status,
      400,
      'permission edits cannot strand the only administrative account',
    );
    assert.equal(
      administrationGuard.data.code,
      'administration_unreachable',
      'the permission guard keeps its existing error code',
    );
    assert.equal(
      db
        .prepare('SELECT COUNT(*) as count FROM user_permission_overrides WHERE user_id = ?')
        .get(owner.userId).count,
      0,
      'the refused permission edit writes no override',
    );

    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'owner', 1, datetime('now'), datetime('now'))
    `).run(
      'authorization-second-owner',
      'Second Owner',
      'second-owner@test.local',
      'synthetic-hash',
    );
    const selfPermissionState = await api(baseUrl, `/api/permissions/users/${owner.userId}`, {
      headers: owner.authHeader,
    });
    const selfLockout = await api(baseUrl, `/api/permissions/users/${owner.userId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        revision: selfPermissionState.data.revision,
        overrides: [{ permission_id: 'settings.manage', effect: 'deny' }],
      },
    });
    assert.equal(
      selfLockout.status,
      409,
      'the permission editor refuses self-lockout when no PIN factor exists',
    );
    assert.equal(
      selfLockout.data.code,
      'self_privilege_change_factor_unavailable',
      'the refusal keeps its existing error code',
    );
    assert.equal(
      db
        .prepare('SELECT COUNT(*) as count FROM user_permission_overrides WHERE user_id = ?')
        .get(owner.userId).count,
      0,
      'the self-lockout refusal writes no override',
    );

    const managerPermissions = await api(baseUrl, '/api/permissions/roles', {
      headers: owner.authHeader,
    });
    const managerRevision = managerPermissions.data.roles.find(
      (entry: any) => entry.role === 'manager',
    ).revision;
    db.prepare(`
      INSERT INTO role_permission_overrides (role, permission_id, effect, updated_by, created_at, updated_at)
      VALUES ('manager', 'reports.view', 'deny', ?, datetime('now'), datetime('now'))
    `).run(owner.userId);
    const stalePermissionEdit = await api(baseUrl, '/api/permissions/roles/manager', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { revision: managerRevision, overrides: [] },
    });
    assert.equal(stalePermissionEdit.status, 409, 'stale role permission edits are rejected');
    assert.equal(
      stalePermissionEdit.data.code,
      'revision_conflict',
      'the conflict keeps its existing error code',
    );
    assert.equal(
      db
        .prepare(
          "SELECT effect FROM role_permission_overrides WHERE role = 'manager' AND permission_id = 'reports.view'",
        )
        .get().effect,
      'deny',
      'the conflicting role override stays intact',
    );

    db.prepare(`
      INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'owner', 1, datetime('now'), datetime('now'))
    `).run(
      'owner-race-target',
      'Concurrent Owner',
      'concurrent-owner@test.local',
      'synthetic-hash',
    );
    const originalAdministrationGuard = authorizationService.assertAdministrationReachable;
    authorizationService.assertAdministrationReachable = (database: any, candidate: any) => {
      originalAdministrationGuard(database, candidate);
      if (candidate.kind === 'user_state' && candidate.userId === 'owner-race-target') {
        database
          .prepare(
            "UPDATE users SET is_active = 0 WHERE role = 'owner' AND is_active = 1 AND id != ?",
          )
          .run(candidate.userId);
      }
    };
    try {
      const racedDeactivation = await api(baseUrl, '/api/staff/owner-race-target/deactivate', {
        method: 'POST',
        headers: owner.authHeader,
      });
      assert.equal(
        racedDeactivation.status,
        400,
        'the conditional write rejects a last-owner race after preflight',
      );
      assert.equal(
        racedDeactivation.data.error,
        'Cannot deactivate the last owner account',
        'the race fallback keeps its existing response',
      );
      assert.equal(
        db.prepare('SELECT role FROM users WHERE id = ?').get('owner-race-target').role,
        'owner',
        'the race target retains owner role',
      );
      assert.equal(
        db.prepare('SELECT is_active FROM users WHERE id = ?').get('owner-race-target').is_active,
        1,
        'the race target remains active',
      );
      assert.equal(
        db
          .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'owner' AND is_active = 1")
          .get().count,
        1,
        'the conditional write leaves one active owner after the simulated competing update',
      );
    } finally {
      authorizationService.assertAdministrationReachable = originalAdministrationGuard;
      db.prepare('UPDATE users SET is_active = 1 WHERE id IN (?, ?)').run(
        owner.userId,
        'authorization-second-owner',
      );
    }

    const customer = await api(baseUrl, '/api/customers', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Synthetic customer', phone: '+919876543210' },
    });
    assert.equal(customer.status, 201, 'the first synthetic customer is created');
    const duplicateCustomer = await api(baseUrl, '/api/customers', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Another synthetic customer', phone: '+919876543210' },
    });
    assert.equal(duplicateCustomer.status, 409, 'duplicate customer phone is rejected');

    const linkedProduct = await api(baseUrl, '/api/products/diag-feature-target', {
      method: 'DELETE',
      headers: owner.authHeader,
    });
    assert.equal(
      linkedProduct.status,
      409,
      'a product still used as an inventory target cannot be deleted',
    );

    const invalidCategoryParent = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid parent category', parent_id: 'missing-category' },
    });
    assert.equal(invalidCategoryParent.status, 400, 'a missing category parent is rejected');
    const categoryCycle = await api(baseUrl, '/api/categories/diag-feature-category', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { parent_id: 'diag-feature-category' },
    });
    assert.equal(categoryCycle.status, 400, 'a category cannot be its own parent');
    assert.equal(
      db.prepare('SELECT parent_id FROM categories WHERE id = ?').get('diag-feature-category')
        .parent_id,
      null,
      'the rejected parent edits leave the category unchanged',
    );

    const invalidAddonBounds = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid bounds group', min_selection: 2, max_selection: 1, addons: [] },
    });
    assert.equal(invalidAddonBounds.status, 400, 'selection bounds that conflict are rejected');
    assert.equal(
      db
        .prepare('SELECT COUNT(*) as count FROM addon_groups WHERE name = ?')
        .get('Invalid bounds group').count,
      0,
      'the invalid add-on group is not inserted',
    );

    const invalidMovementType = await api(baseUrl, '/api/inventory/movements?movement_type=bad');
    assert.equal(
      invalidMovementType.status,
      401,
      'unauthenticated inventory access remains protected',
    );
    const ownerMovementType = await api(baseUrl, '/api/inventory/movements?movement_type=bad', {
      headers: owner.authHeader,
    });
    assert.equal(ownerMovementType.status, 400, 'an invalid movement filter is rejected');
    const invalidMovementCursor = await api(baseUrl, '/api/inventory/movements?before_id=0', {
      headers: owner.authHeader,
    });
    assert.equal(invalidMovementCursor.status, 400, 'an invalid movement cursor is rejected');
    const invalidMovementSearch = await api(baseUrl, '/api/inventory/movements?product_id=', {
      headers: owner.authHeader,
    });
    assert.equal(invalidMovementSearch.status, 400, 'an invalid movement query value is rejected');

    const supply = createSupply(db, {
      name: 'Private synthetic flour',
      baseUnit: 'g',
      actorUserId: owner.userId,
    });
    const invalidRecipe = await api(baseUrl, '/api/recipes/product/diag-feature-linked', {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        yield_quantity: 1,
        items: [
          { supply_id: supply.id, quantity: 1, unit: 'g' },
          { supply_id: supply.id, quantity: 2, unit: 'g' },
        ],
      },
    });
    assert.equal(invalidRecipe.status, 400, 'a recipe with a repeated supply is rejected');
    assert.equal(
      db
        .prepare('SELECT COUNT(*) as count FROM recipes WHERE product_id = ?')
        .get('diag-feature-linked').count,
      0,
      'the invalid recipe is not stored',
    );
    const validRecipe = await api(baseUrl, '/api/recipes/product/diag-feature-linked', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { yield_quantity: 1, items: [{ supply_id: supply.id, quantity: 1, unit: 'g' }] },
    });
    assert.equal(validRecipe.status, 200, 'a valid recipe can reference the synthetic supply');
    const linkedSupplyDelete = await api(baseUrl, `/api/supplies/${supply.id}`, {
      method: 'DELETE',
      headers: owner.authHeader,
    });
    assert.equal(linkedSupplyDelete.status, 409, 'a supply used by a recipe cannot be deleted');
    assert.equal(
      db.prepare('SELECT deleted_at FROM supplies WHERE id = ?').get(supply.id).deleted_at,
      null,
      'the linked supply remains undeleted',
    );

    const invalidFinancialRange = await api(
      baseUrl,
      '/api/reports/financial-summary?start_date=2026-10-10&end_date=2026-10-09',
      {
        headers: owner.authHeader,
      },
    );
    assert.equal(
      invalidFinancialRange.status,
      400,
      'a reversed financial report range is rejected',
    );
    assert.equal(
      invalidFinancialRange.data.error,
      'start_date must be on or before end_date',
      'the report keeps its existing range error',
    );
    const invalidMenuCsv = await api(baseUrl, '/api/menu/csv/import/categories', {
      method: 'POST',
      headers: owner.authHeader,
      body: { csv: 'name\n"private-csv-value' },
    });
    assert.equal(invalidMenuCsv.status, 400, 'malformed CSV input is rejected');
    const missingMenuCsv = await api(baseUrl, '/api/menu/csv/import/categories', {
      method: 'POST',
      headers: owner.authHeader,
      body: { csv: '' },
    });
    assert.equal(missingMenuCsv.status, 400, 'a missing CSV body is rejected');
    const partialMenuCsv = await api(baseUrl, '/api/menu/csv/import/categories', {
      method: 'POST',
      headers: owner.authHeader,
      body: { csv: 'name,sort_order\nPartial category,0\nRejected category,nope' },
    });
    assert.equal(
      partialMenuCsv.status,
      200,
      'CSV imports preserve their row-level response after a partial import',
    );
    assert.equal(partialMenuCsv.data.created, 1, 'the valid CSV row is committed');
    assert.equal(partialMenuCsv.data.failed, 1, 'the invalid CSV row is reported');
    assert.equal(
      db.prepare('SELECT COUNT(*) as count FROM categories WHERE name = ?').get('Partial category')
        .count,
      1,
      'the partial import has one actual database change',
    );
    const rejectedMenuCsv = await api(baseUrl, '/api/menu/csv/import/categories', {
      method: 'POST',
      headers: owner.authHeader,
      body: { csv: 'name,sort_order\nRejected only,nope' },
    });
    assert.equal(
      rejectedMenuCsv.status,
      200,
      'an all-rejected row import keeps its normal response',
    );
    assert.equal(rejectedMenuCsv.data.created, 0, 'the all-rejected import creates nothing');
    assert.equal(rejectedMenuCsv.data.failed, 1, 'the all-rejected import reports one row failure');
    assert.equal(
      db.prepare('SELECT COUNT(*) as count FROM categories WHERE name = ?').get('Rejected only')
        .count,
      0,
      'the all-rejected import has no database changes',
    );
    const existingAddonGroup = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        name: 'CSV skipped-addon group',
        min_selection: 0,
        max_selection: 1,
        addons: [{ name: 'CSV existing addon', price: 1 }],
      },
    });
    assert.equal(existingAddonGroup.status, 201, 'the precondition add-on group is created');
    const addonCsvWithSkippedRow = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        csv: 'group_name,addon_name,price,group_required\nCSV skipped-addon group,CSV existing addon,1,yes\n,Invalid addon,not-a-number,',
      },
    });
    assert.equal(
      addonCsvWithSkippedRow.status,
      200,
      'the add-on CSV import keeps its row-level response',
    );
    assert.equal(
      addonCsvWithSkippedRow.data.groups_updated,
      1,
      'the existing group setting is changed',
    );
    assert.equal(
      addonCsvWithSkippedRow.data.skipped,
      1,
      'the existing active add-on is still skipped',
    );
    assert.equal(addonCsvWithSkippedRow.data.failed, 1, 'the invalid add-on CSV row is counted');
    assert.equal(
      db
        .prepare('SELECT is_required FROM addon_groups WHERE id = ?')
        .get(existingAddonGroup.data.addon_group.id).is_required,
      1,
      'the changed group persists even when its add-on row is skipped',
    );

    cloudSync.captureOperationFailure = () => {
      throw new Error('synthetic synchronous diagnostics dispatch failure');
    };
    try {
      const duplicateStaffWithReporterFailure = await api(baseUrl, '/api/staff', {
        method: 'POST',
        headers: owner.authHeader,
        body: {
          name: 'Another owner',
          email: 'owner@test.local',
          password: 'TestPass123',
          role: 'cashier',
        },
      });
      assert.equal(
        duplicateStaffWithReporterFailure.status,
        400,
        'a synchronous diagnostics dispatch failure does not replace duplicate-staff validation',
      );
      const duplicateWithReporterFailure = await api(baseUrl, '/api/customers', {
        method: 'POST',
        headers: owner.authHeader,
        body: { name: 'Reporter failure customer', phone: '+919876543210' },
      });
      assert.equal(
        duplicateWithReporterFailure.status,
        409,
        'a synchronous diagnostics dispatch failure does not replace the customer response',
      );
      const selfPermissionStateWithReporterFailure = await api(
        baseUrl,
        `/api/permissions/users/${owner.userId}`,
        { headers: owner.authHeader },
      );
      const selfLockoutWithReporterFailure = await api(
        baseUrl,
        `/api/permissions/users/${owner.userId}`,
        {
          method: 'PUT',
          headers: owner.authHeader,
          body: {
            revision: selfPermissionStateWithReporterFailure.data.revision,
            overrides: [{ permission_id: 'settings.manage', effect: 'deny' }],
          },
        },
      );
      assert.equal(
        selfLockoutWithReporterFailure.status,
        409,
        'a synchronous diagnostics dispatch failure does not replace the authorization self-lockout response',
      );
      assert.equal(
        selfLockoutWithReporterFailure.data.code,
        'self_privilege_change_factor_unavailable',
        'the original self-lockout code survives diagnostics failure',
      );
      const linkedProductWithReporterFailure = await api(
        baseUrl,
        '/api/products/diag-feature-target',
        {
          method: 'DELETE',
          headers: owner.authHeader,
        },
      );
      assert.equal(
        linkedProductWithReporterFailure.status,
        409,
        'a synchronous diagnostics dispatch failure does not replace the product response',
      );
      const categoryWithReporterFailure = await api(baseUrl, '/api/categories', {
        method: 'POST',
        headers: owner.authHeader,
        body: { name: 'Throwing reporter category', parent_id: 'missing-category' },
      });
      assert.equal(
        categoryWithReporterFailure.status,
        400,
        'a synchronous diagnostics dispatch failure does not replace category validation',
      );
      const addonWithReporterFailure = await api(baseUrl, '/api/addon-groups', {
        method: 'POST',
        headers: owner.authHeader,
        body: { name: 'Throwing reporter group', min_selection: 2, max_selection: 1, addons: [] },
      });
      assert.equal(
        addonWithReporterFailure.status,
        400,
        'a synchronous diagnostics dispatch failure does not replace add-on validation',
      );
      const movementWithReporterFailure = await api(
        baseUrl,
        '/api/inventory/movements?movement_type=bad',
        { headers: owner.authHeader },
      );
      assert.equal(
        movementWithReporterFailure.status,
        400,
        'a synchronous diagnostics dispatch failure does not replace inventory query validation',
      );
      const recipeWithReporterFailure = await api(
        baseUrl,
        '/api/recipes/product/diag-feature-linked',
        {
          method: 'PUT',
          headers: owner.authHeader,
          body: {
            yield_quantity: 1,
            items: [
              { supply_id: supply.id, quantity: 1, unit: 'g' },
              { supply_id: supply.id, quantity: 2, unit: 'g' },
            ],
          },
        },
      );
      assert.equal(
        recipeWithReporterFailure.status,
        400,
        'a synchronous diagnostics dispatch failure does not replace recipe validation',
      );
      const supplyWithReporterFailure = await api(baseUrl, `/api/supplies/${supply.id}`, {
        method: 'DELETE',
        headers: owner.authHeader,
      });
      assert.equal(
        supplyWithReporterFailure.status,
        409,
        'a synchronous diagnostics dispatch failure does not replace supply protection',
      );
      const reportWithReporterFailure = await api(
        baseUrl,
        '/api/reports/financial-summary?start_date=2026-10-10&end_date=2026-10-09',
        { headers: owner.authHeader },
      );
      assert.equal(
        reportWithReporterFailure.status,
        400,
        'a synchronous diagnostics dispatch failure does not replace report validation',
      );
      const csvWithReporterFailure = await api(baseUrl, '/api/menu/csv/import/categories', {
        method: 'POST',
        headers: owner.authHeader,
        body: { csv: 'name\n"private-csv-value' },
      });
      assert.equal(
        csvWithReporterFailure.status,
        400,
        'a synchronous diagnostics dispatch failure does not replace CSV parser responses',
      );
      const partialCsvWithReporterFailure = await api(baseUrl, '/api/menu/csv/import/categories', {
        method: 'POST',
        headers: owner.authHeader,
        body: { csv: 'name,sort_order\nReporter failure imported,0\nRejected with reporter,nope' },
      });
      assert.equal(
        partialCsvWithReporterFailure.status,
        200,
        'a synchronous diagnostics dispatch failure does not replace partial CSV import responses',
      );
      assert.equal(
        partialCsvWithReporterFailure.data.created,
        1,
        'the valid CSV row still commits when the reporter throws',
      );
      assert.equal(
        partialCsvWithReporterFailure.data.failed,
        1,
        'the rejected CSV row remains reported when the reporter throws',
      );
      assert.equal(
        db
          .prepare('SELECT COUNT(*) as count FROM categories WHERE name = ?')
          .get('Reporter failure imported').count,
        1,
        'diagnostic dispatch does not roll back the valid CSV row',
      );
      let recoveryChecks = 0;
      const originalHasActiveAdministrator = authorizationService.hasActiveAdministrator;
      authorizationService.hasActiveAdministrator = () => {
        const reachable = originalHasActiveAdministrator();
        recoveryChecks++;
        if (recoveryChecks === 2)
          db.prepare("UPDATE users SET role = 'manager' WHERE id = ?").run(owner.userId);
        return reachable;
      };
      try {
        const recoveryWithReporterFailure = await api(baseUrl, '/api/auth/recover-password', {
          method: 'POST',
          body: { email: 'owner@test.local', master_pin: '1234', new_password: 'TestPass1234' },
        });
        assert.equal(
          recoveryWithReporterFailure.status,
          409,
          'a synchronous diagnostics dispatch failure does not replace the recovery race response',
        );
        assert.equal(
          recoveryWithReporterFailure.data.error,
          'Owner access changed during recovery. Try again.',
          'the recovery response is unchanged when diagnostics dispatch throws',
        );
      } finally {
        authorizationService.hasActiveAdministrator = originalHasActiveAdministrator;
        db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner.userId);
      }
    } finally {
      cloudSync.captureOperationFailure = captureBeforeFailureTest;
    }

    assert.deepEqual(
      captured.map(
        ({
          capture_point,
          reason_code,
          operation,
          stage,
          classification,
          outcome,
          facts,
        }: any) => ({
          capture_point,
          reason_code,
          operation,
          stage,
          classification,
          outcome,
          facts,
        }),
      ),
      [
        ...[1, 2].map(() => ({
          capture_point: 'fc.backend.staff.administration_access_guard',
          reason_code: 'staff.administration_invariant',
          operation: 'staff.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        })),
        {
          capture_point: 'fc.backend.staff.duplicate_email',
          reason_code: 'staff.email_conflict',
          operation: 'staff.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.auth.recovery.owner_state_changed',
          reason_code: 'auth.owner_state_changed',
          operation: 'auth.session',
          stage: 'recovery',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.authorization.administration_guard',
          reason_code: 'authorization.administration_invariant',
          operation: 'authorization.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.authorization.self_lockout_guard',
          reason_code: 'authorization.self_lockout_prevented',
          operation: 'authorization.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.authorization.revision_conflict',
          reason_code: 'authorization.revision_conflict',
          operation: 'authorization.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.staff.administration_access_guard',
          reason_code: 'staff.administration_invariant',
          operation: 'staff.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.customer.duplicate_phone',
          reason_code: 'customer.duplicate_phone',
          operation: 'customer.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.product.delete.inventory_target',
          reason_code: 'product.delete_blocked',
          operation: 'product.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.category.parent_reference_invalid',
          reason_code: 'category.parent_reference_invalid',
          operation: 'category.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.category.parent_cycle',
          reason_code: 'category.parent_cycle',
          operation: 'category.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.addon_group.selection_bounds',
          reason_code: 'addon_group.selection_bounds_invalid',
          operation: 'addon_group.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        ...[1, 2].map(() => ({
          capture_point: 'fc.backend.inventory.movement_query.invalid',
          reason_code: 'inventory.query_rejected',
          operation: 'inventory.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        })),
        {
          capture_point: 'fc.backend.inventory.movement_query.invalid',
          reason_code: 'inventory.query_rejected',
          operation: 'inventory.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.recipe.save.invalid_component',
          reason_code: 'recipe.component_invalid',
          operation: 'recipe.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: { validation_code: 'duplicate_supply' },
        },
        {
          capture_point: 'fc.backend.supply.delete.recipe_linked',
          reason_code: 'supply.delete_blocked',
          operation: 'supplies.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        {
          capture_point: 'fc.backend.reports.financial_summary.date_range',
          reason_code: 'reports.date_range_invalid',
          operation: 'report.generate',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        ...[1, 2].map(() => ({
          capture_point: 'fc.backend.menu_csv.import.invalid_input',
          reason_code: 'catalog_import.invalid_input',
          operation: 'catalog.import',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        })),
        {
          capture_point: 'fc.backend.menu_csv.import.row_rejections',
          reason_code: 'catalog_import.rows_rejected',
          operation: 'catalog.import',
          stage: 'import',
          classification: 'expected_rejection',
          outcome: 'partial',
          facts: { failed_count: 1, changed_count: 1 },
        },
        {
          capture_point: 'fc.backend.menu_csv.import.row_rejections',
          reason_code: 'catalog_import.rows_rejected',
          operation: 'catalog.import',
          stage: 'import',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: { failed_count: 1, changed_count: 0 },
        },
        {
          capture_point: 'fc.backend.menu_csv.import.row_rejections',
          reason_code: 'catalog_import.rows_rejected',
          operation: 'catalog.import',
          stage: 'import',
          classification: 'expected_rejection',
          outcome: 'partial',
          facts: { failed_count: 1, changed_count: 1 },
        },
      ],
      'each known C6 business invariant has its exact safe tuple and the request contains no identifiers or free text',
    );

    const detailedCaptureStart = captured.length;
    const invalidStaffEmail = await api(baseUrl, '/api/staff', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid email staff', email: 'bad', password: 'TestPass123', role: 'cashier' },
    });
    assert.equal(invalidStaffEmail.status, 400, 'invalid staff email validation remains a 400');
    const managerCreateOwner = await api(baseUrl, '/api/staff', {
      method: 'POST',
      headers: manager.authHeader,
      body: {
        name: 'Not allowed owner',
        email: 'not-allowed@test.local',
        password: 'TestPass123',
        role: 'owner',
      },
    });
    assert.equal(managerCreateOwner.status, 403, 'manager cannot create privileged staff');
    assert.equal(
      db
        .prepare('SELECT COUNT(*) as count FROM users WHERE email = ?')
        .get('not-allowed@test.local').count,
      0,
      'denied privileged staff creation writes no user',
    );

    const invalidCustomerName = await api(baseUrl, '/api/customers', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: ' ' },
    });
    assert.equal(invalidCustomerName.status, 400, 'empty customer name remains rejected');
    const invalidCustomerPhone = await api(baseUrl, '/api/customers', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid phone customer', phone: 'bad' },
    });
    assert.equal(invalidCustomerPhone.status, 400, 'invalid customer phone remains rejected');
    const invalidCustomerAddress = await api(baseUrl, '/api/customers', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid address customer', address: 'a'.repeat(301) },
    });
    assert.equal(invalidCustomerAddress.status, 400, 'overlong customer address remains rejected');
    const updateCustomer = await api(baseUrl, '/api/customers', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Customer for update validation' },
    });
    assert.equal(updateCustomer.status, 201, 'customer update-validation precondition is created');
    const customerId = updateCustomer.data.customer.id;
    const invalidCustomerUpdatePhone = await api(baseUrl, `/api/customers/${customerId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { phone: 'bad' },
    });
    assert.equal(
      invalidCustomerUpdatePhone.status,
      400,
      'invalid customer update phone remains rejected',
    );
    const invalidCustomerUpdateName = await api(baseUrl, `/api/customers/${customerId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { name: ' ' },
    });
    assert.equal(
      invalidCustomerUpdateName.status,
      400,
      'empty customer update name remains rejected',
    );
    const invalidCustomerUpdateAddress = await api(baseUrl, `/api/customers/${customerId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { address: 'a'.repeat(301) },
    });
    assert.equal(
      invalidCustomerUpdateAddress.status,
      400,
      'overlong customer update address remains rejected',
    );
    const duplicateCustomerUpdate = await api(baseUrl, `/api/customers/${customerId}`, {
      method: 'PUT',
      headers: owner.authHeader,
      body: { phone: '+919876543210' },
    });
    assert.equal(
      duplicateCustomerUpdate.status,
      409,
      'customer update cannot reuse an active phone',
    );
    const invalidCustomerPage = await api(baseUrl, '/api/customers?per_page=bad', {
      headers: owner.authHeader,
    });
    assert.equal(invalidCustomerPage.status, 400, 'invalid customer pagination remains rejected');

    const invalidCategoryName = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: ' ' },
    });
    assert.equal(invalidCategoryName.status, 400, 'empty category name remains rejected');
    const invalidCategoryAddonGroups = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid category links', addon_group_ids: 'bad' },
    });
    assert.equal(
      invalidCategoryAddonGroups.status,
      400,
      'invalid category add-on-group list remains rejected',
    );
    const categoryNeedsResolution = await api(baseUrl, '/api/categories/diag-feature-category', {
      method: 'DELETE',
      headers: owner.authHeader,
    });
    assert.equal(
      categoryNeedsResolution.status,
      400,
      'category with active products still requires a delete action',
    );
    const invalidCategoryDeleteAction = await api(
      baseUrl,
      '/api/categories/diag-feature-category?action=invalid',
      {
        method: 'DELETE',
        headers: owner.authHeader,
      },
    );
    assert.equal(
      invalidCategoryDeleteAction.status,
      400,
      'invalid category delete action remains rejected',
    );
    const selfCategoryReassignment = await api(
      baseUrl,
      '/api/categories/diag-feature-category?action=reassign&reassign_to=diag-feature-category',
      {
        method: 'DELETE',
        headers: owner.authHeader,
      },
    );
    assert.equal(selfCategoryReassignment.status, 400, 'category cannot be reassigned to itself');

    const invalidAddonGroupInput = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: ' ', addons: [] },
    });
    assert.equal(invalidAddonGroupInput.status, 400, 'invalid add-on group fields remain rejected');

    const invalidPermissionRole = await api(baseUrl, '/api/permissions/roles/not-a-role', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { revision: 'ignored', overrides: [] },
    });
    assert.equal(invalidPermissionRole.status, 400, 'invalid permission role remains rejected');
    const invalidPermissionOverrides = await api(baseUrl, '/api/permissions/roles/manager', {
      method: 'PUT',
      headers: owner.authHeader,
      body: {
        revision: 'ignored',
        overrides: [{ permission_id: 'bad.permission', effect: 'allow' }],
      },
    });
    assert.equal(
      invalidPermissionOverrides.status,
      400,
      'invalid permission overrides remain rejected',
    );
    const missingPermissionRevision = await api(baseUrl, '/api/permissions/roles/manager', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { overrides: [] },
    });
    assert.equal(
      missingPermissionRevision.status,
      400,
      'permission edits still require a revision',
    );

    const invalidProductName = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: ' ', price: 10 },
    });
    assert.equal(invalidProductName.status, 400, 'missing product name remains rejected');
    const invalidProductNumeric = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid numeric product', price: -1 },
    });
    assert.equal(
      invalidProductNumeric.status,
      400,
      'invalid product numeric values remain rejected',
    );
    const invalidProductVariants = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid variant product', price: 10, variants: 'bad' },
    });
    assert.equal(invalidProductVariants.status, 400, 'malformed product variants remain rejected');
    const invalidProductStock = await api(baseUrl, '/api/products/diag-feature-linked/stock', {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assert.equal(
      invalidProductStock.status,
      400,
      'missing stock action and quantity remain rejected',
    );

    const invalidSupplyUnit = await api(baseUrl, '/api/supplies', {
      method: 'POST',
      headers: owner.authHeader,
      body: { name: 'Invalid unit supply', base_unit: 'stone' },
    });
    assert.equal(invalidSupplyUnit.status, 400, 'invalid supply units remain rejected');
    const invalidSupplyMovementFilter = await api(
      baseUrl,
      '/api/supplies/movements?movement_type=bad',
      { headers: owner.authHeader },
    );
    assert.equal(
      invalidSupplyMovementFilter.status,
      400,
      'invalid supply movement filters remain rejected',
    );
    const invalidSupplyMovementType = await api(baseUrl, `/api/supplies/${supply.id}/movements`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { movement_type: 'bad', quantity: 1, unit: 'g' },
    });
    assert.equal(
      invalidSupplyMovementType.status,
      400,
      'invalid supply movement types remain rejected',
    );
    const invalidSupplyMovement = await api(baseUrl, `/api/supplies/${supply.id}/movements`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { movement_type: 'receive', quantity: -1, unit: 'g' },
    });
    assert.equal(invalidSupplyMovement.status, 400, 'negative supply movements remain rejected');
    assert.equal(
      db
        .prepare('SELECT COUNT(*) as count FROM supply_movements WHERE supply_id = ?')
        .get(supply.id).count,
      0,
      'rejected supply movement writes no ledger row',
    );

    const invalidRecentOrderDate = await api(baseUrl, '/api/reports/recentOrders?date=bad', {
      headers: owner.authHeader,
    });
    assert.equal(
      invalidRecentOrderDate.status,
      400,
      'invalid recent-order report dates remain rejected',
    );
    const conflictingRecentOrderRange = await api(
      baseUrl,
      '/api/reports/recentOrders?date=2026-10-09&start_date=2026-10-09',
      { headers: owner.authHeader },
    );
    assert.equal(
      conflictingRecentOrderRange.status,
      400,
      'conflicting recent-order date filters remain rejected',
    );
    const reversedSalesRange = await api(
      baseUrl,
      '/api/reports/sales?start_date=2026-10-10&end_date=2026-10-09',
      { headers: owner.authHeader },
    );
    assert.equal(reversedSalesRange.status, 400, 'reversed sales report dates remain rejected');

    const detailedCaptures = captured
      .slice(detailedCaptureStart)
      .map(
        ({
          capture_point,
          reason_code,
          operation,
          stage,
          classification,
          outcome,
          facts,
        }: any) => ({
          capture_point,
          reason_code,
          operation,
          stage,
          classification,
          outcome,
          facts,
        }),
      );
    assert.deepEqual(
      detailedCaptures,
      [
        {
          capture_point: 'fc.backend.staff.create.validation',
          reason_code: 'staff.input_rejected',
          operation: 'staff.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: { validation_code: 'email_invalid' },
        },
        {
          capture_point: 'fc.backend.staff.target_access_denied',
          reason_code: 'permission.denied',
          operation: 'staff.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: { action: 'create_target' },
        },
        ...[
          [
            'fc.backend.customer.create.validation',
            'customer.input_rejected',
            { validation_code: 'name_required' },
          ],
          [
            'fc.backend.customer.create.validation',
            'customer.input_rejected',
            { validation_code: 'phone_invalid' },
          ],
          [
            'fc.backend.customer.create.validation',
            'customer.input_rejected',
            { validation_code: 'address_invalid' },
          ],
          [
            'fc.backend.customer.update.validation',
            'customer.input_rejected',
            { validation_code: 'phone_invalid' },
          ],
          [
            'fc.backend.customer.update.validation',
            'customer.input_rejected',
            { validation_code: 'name_required' },
          ],
          [
            'fc.backend.customer.update.validation',
            'customer.input_rejected',
            { validation_code: 'address_invalid' },
          ],
          ['fc.backend.customer.duplicate_phone', 'customer.duplicate_phone', {}],
          ['fc.backend.customer.list.pagination_invalid', 'customer.query_rejected', {}],
        ].map(([capture_point, reason_code, facts]: any) => ({
          capture_point,
          reason_code,
          operation: 'customer.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts,
        })),
        ...[
          [
            'fc.backend.category.save.validation',
            'category.input_rejected',
            { validation_code: 'name_required' },
          ],
          [
            'fc.backend.category.save.validation',
            'category.input_rejected',
            { validation_code: 'addon_group_ids_invalid' },
          ],
          [
            'fc.backend.category.delete.action_rejected',
            'category.delete_rejected',
            { validation_code: 'requires_resolution' },
          ],
          [
            'fc.backend.category.delete.action_rejected',
            'category.delete_rejected',
            { validation_code: 'action_invalid' },
          ],
          [
            'fc.backend.category.delete.action_rejected',
            'category.delete_rejected',
            { validation_code: 'self_target' },
          ],
        ].map(([capture_point, reason_code, facts]: any) => ({
          capture_point,
          reason_code,
          operation: 'category.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts,
        })),
        {
          capture_point: 'fc.backend.addon_group.input_validation',
          reason_code: 'addon_group.input_rejected',
          operation: 'addon_group.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        ...[
          [
            'fc.backend.authorization.input_validation',
            'authorization.input_rejected',
            { validation_code: 'invalid_role' },
          ],
          [
            'fc.backend.authorization.input_validation',
            'authorization.input_rejected',
            { validation_code: 'invalid_overrides' },
          ],
          [
            'fc.backend.authorization.input_validation',
            'authorization.input_rejected',
            { validation_code: 'missing_revision' },
          ],
        ].map(([capture_point, reason_code, facts]: any) => ({
          capture_point,
          reason_code,
          operation: 'authorization.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts,
        })),
        ...[
          [
            'fc.backend.product.create.validation',
            'product.input_rejected',
            { validation_code: 'required_fields' },
          ],
          [
            'fc.backend.product.create.validation',
            'product.input_rejected',
            { validation_code: 'numeric_fields' },
          ],
          [
            'fc.backend.product.create.validation',
            'product.input_rejected',
            { validation_code: 'variants_invalid' },
          ],
        ].map(([capture_point, reason_code, facts]: any) => ({
          capture_point,
          reason_code,
          operation: 'product.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts,
        })),
        {
          capture_point: 'fc.backend.product.stock.validation',
          reason_code: 'product.stock_input_rejected',
          operation: 'product.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: { validation_code: 'action_required' },
        },
        {
          capture_point: 'fc.backend.supply.validation',
          reason_code: 'supply.input_rejected',
          operation: 'supplies.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: { validation_code: 'unit_invalid' },
        },
        {
          capture_point: 'fc.backend.supply.movement_query.invalid',
          reason_code: 'supply.query_rejected',
          operation: 'supplies.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: {},
        },
        ...[['movement_type_invalid'], ['movement_negative']].map(([validation_code]: any) => ({
          capture_point: 'fc.backend.supply.validation',
          reason_code: 'supply.input_rejected',
          operation: 'supplies.manage',
          stage: 'validation',
          classification: 'expected_rejection',
          outcome: 'not_applied',
          facts: { validation_code },
        })),
        ...[['invalid_format'], ['date_and_range_conflict'], ['reversed_range']].map(
          ([validation_code]: any) => ({
            capture_point: 'fc.backend.reports.date_range.invalid',
            reason_code: 'reports.date_range_invalid',
            operation: 'report.generate',
            stage: 'validation',
            classification: 'expected_rejection',
            outcome: 'not_applied',
            facts: { validation_code },
          }),
        ),
      ],
      'the added feature rejections use exact closed facts, preserve no-write outcomes, and contain no request data',
    );

    const reporterFailureHandler = cloudSync.captureOperationFailure;
    cloudSync.captureOperationFailure = () => {
      throw new Error('synthetic synchronous diagnostics dispatch failure');
    };
    try {
      const productWithReporterFailure = await api(baseUrl, '/api/products', {
        method: 'POST',
        headers: owner.authHeader,
        body: { name: ' ', price: 10 },
      });
      assert.equal(
        productWithReporterFailure.status,
        400,
        'product validation remains unchanged when diagnostics dispatch throws',
      );
      const customerWithReporterFailure = await api(baseUrl, '/api/customers', {
        method: 'POST',
        headers: owner.authHeader,
        body: { name: ' ' },
      });
      assert.equal(
        customerWithReporterFailure.status,
        400,
        'customer validation remains unchanged when diagnostics dispatch throws',
      );
      const supplyWithReporterFailure = await api(baseUrl, '/api/supplies', {
        method: 'POST',
        headers: owner.authHeader,
        body: { name: 'Throwing reporter supply', base_unit: 'stone' },
      });
      assert.equal(
        supplyWithReporterFailure.status,
        400,
        'supply validation remains unchanged when diagnostics dispatch throws',
      );
    } finally {
      cloudSync.captureOperationFailure = reporterFailureHandler;
    }

    assert.equal(
      db
        .prepare('SELECT COUNT(*) as count FROM customers WHERE phone_digits = ?')
        .get('919876543210').count,
      1,
      'the duplicate phone does not create another customer',
    );
    assert.equal(
      db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(customerId).name,
      'Customer for update validation',
      'rejected customer updates leave the row unchanged',
    );
    assert.equal(
      db.prepare('SELECT deleted_at FROM categories WHERE id = ?').get('diag-feature-category')
        .deleted_at,
      null,
      'rejected category deletes leave the category active',
    );
    assert.equal(
      db
        .prepare('SELECT COUNT(*) as count FROM products WHERE name IN (?, ?, ?)')
        .get('Invalid numeric product', 'Invalid variant product', ' ').count,
      0,
      'rejected product validation writes no products',
    );
    assert.equal(
      db.prepare('SELECT deleted_at FROM products WHERE id = ?').get('diag-feature-target')
        .deleted_at,
      null,
      'the inventory target remains undeleted',
    );
    const serialized = JSON.stringify(captured);
    for (const privateValue of [
      '+919876543210',
      'diag-feature-target',
      'owner-test-001',
      'owner-race-target',
      'Concurrent Owner',
      'Synthetic customer',
      supply.id,
      'Private synthetic flour',
      'private-csv-value',
      'Partial category',
      'Rejected category',
      'Rejected only',
      'Reporter failure imported',
    ]) {
      assert.equal(
        serialized.includes(privateValue),
        false,
        `automatic diagnostics omit ${privateValue}`,
      );
    }
  } finally {
    cloudSync.captureOperationFailure = originalCapture;
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => (error ? reject(error) : resolve())),
    );
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('Diagnostics C6 feature boundary tests passed');
}

main().catch((error: unknown) => {
  console.error(error);
  try {
    closeDatabase();
  } catch {
    /* test setup may have failed */
  }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
});
