/**
 * Integration Test: Issue #247 — catalog tree and nullable-field invariants.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-247-catalog-invariants.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-247-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-247';

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  seedCustomer,
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');

const { categoryRoutes } = require('../main/routes/categories');
const { productRoutes } = require('../main/routes/products');
const { addonGroupRoutes } = require('../main/routes/addon-groups');
const { getCustomerTopItems } = require('../main/routes/customers');

async function main() {
  console.log('Integration Test: Issue #247 catalog invariants');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({
    '/api/categories': categoryRoutes,
    '/api/products': productRoutes,
    '/api/addon-groups': addonGroupRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Category create/update validation ───');
    let res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: '   ' },
    });
    assertEqual(res.status, 400, 'blank category names are rejected');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Bad Parent', parent_id: 'missing-parent' },
    });
    assertEqual(res.status, 400, 'missing category parents are rejected');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: '  Parent Menu  ', description: 'Food', color: '#111111', icon: 'utensils' },
    });
    assertEqual(res.status, 201, 'trimmed root category is created');
    const parentId = res.data.category.id;
    assertEqual(res.data.category.name, 'Parent Menu', 'category name is stored trimmed');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Child Menu', parent_id: parentId },
    });
    assertEqual(res.status, 201, 'child category with active parent is created');
    const childId = res.data.category.id;

    res = await api(baseUrl, `/api/categories/${parentId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { parent_id: childId },
    });
    assertEqual(res.status, 400, 'ancestor cycles are rejected');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Grandchild Menu', parent_id: childId },
    });
    assertEqual(res.status, 400, 'grandchildren beyond two-level hierarchy are rejected on create');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Second Root' },
    });
    assertEqual(res.status, 201, 'second root category is created');
    const secondRootId = res.data.category.id;

    res = await api(baseUrl, `/api/categories/${parentId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { parent_id: secondRootId },
    });
    assertEqual(
      res.status,
      400,
      'moving a parent category with children under another parent is rejected',
    );

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: '  parent menu ' },
    });
    assertEqual(res.status, 400, 'duplicate root sibling names are rejected case-insensitively');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'child menu', parent_id: parentId },
    });
    assertEqual(
      res.status,
      400,
      'duplicate child sibling names under the same parent are rejected',
    );

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Child Menu', parent_id: secondRootId },
    });
    assertEqual(
      res.status,
      201,
      'identical child category name under a different parent is allowed',
    );
    const secondRootChildId = res.data.category.id;

    res = await api(baseUrl, `/api/categories/${secondRootChildId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { parent_id: parentId },
    });
    assertEqual(
      res.status,
      400,
      'moving a child into a parent that already has a child with the same name is rejected',
    );

    db.prepare('DELETE FROM categories WHERE id = ?').run(secondRootChildId);
    db.prepare('DELETE FROM categories WHERE id = ?').run(secondRootId);

    res = await api(baseUrl, `/api/categories/${childId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { parent_id: null },
    });
    assertEqual(res.status, 200, 'explicit null clears category parent');
    assertEqual(
      db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(childId).parent_id,
      null,
      'parent_id is null after clear',
    );

    res = await api(baseUrl, `/api/categories/${parentId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { description: null, color: null, icon: null },
    });
    assertEqual(res.status, 200, 'category nullable fields can be explicitly cleared');
    const clearedCategory = db
      .prepare('SELECT description, color, icon FROM categories WHERE id = ?')
      .get(parentId) as any;
    assertEqual(clearedCategory.description, null, 'category description cleared');
    assertEqual(clearedCategory.color, null, 'category color cleared');
    assertEqual(clearedCategory.icon, null, 'category icon cleared');

    console.log('\n─── Category deletion and deactivation child handling ───');
    seedCategory(db, 'cat-247-target', 'Target');
    seedCategory(db, 'cat-247-empty', 'Empty');
    res = await api(baseUrl, '/api/categories/cat-247-empty', {
      method: 'DELETE',
      headers: authHeader,
    });
    assertEqual(res.status, 200, 'empty categories can be deleted without dependency action');
    assert(
      Boolean(
        db.prepare('SELECT deleted_at FROM categories WHERE id = ?').get('cat-247-empty')
          .deleted_at,
      ),
      'empty category is soft-deleted',
    );

    db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run(parentId, childId);
    seedProduct(db, 'prod-247-reassign', parentId, 'Parent Product', 10);

    res = await api(baseUrl, `/api/categories/${parentId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { is_active: false },
    });
    assertEqual(res.status, 400, 'deactivating a parent category with children is refused');
    assert(
      String(res.data.error || '').includes('subcategories'),
      'deactivate refusal explains child dependency',
    );
    assertEqual(
      db.prepare('SELECT is_active FROM categories WHERE id = ?').get(parentId).is_active,
      1,
      'parent remains active after refused deactivation',
    );

    res = await api(baseUrl, `/api/categories/${parentId}`, {
      method: 'DELETE',
      headers: authHeader,
    });
    assertEqual(res.status, 400, 'deleting a parent category with children is refused');
    assertEqual(res.data.childCount, 1, 'delete response reports child count');

    res = await api(
      baseUrl,
      `/api/categories/${parentId}?action=reassign&reassign_to=cat-247-target`,
      {
        method: 'DELETE',
        headers: authHeader,
      },
    );
    assertEqual(
      res.status,
      400,
      'deleting a parent category with children is refused even when reassign action is supplied',
    );
    assertEqual(
      db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(childId).parent_id,
      parentId,
      'children are not silently reparented',
    );

    res = await api(baseUrl, `/api/categories/${parentId}?action=delete_all`, {
      method: 'DELETE',
      headers: authHeader,
    });
    assertEqual(
      res.status,
      400,
      'deleting a parent category with children is refused even when delete_all action is supplied',
    );
    assertEqual(
      db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(childId).parent_id,
      parentId,
      'children are not silently flattened',
    );

    res = await api(baseUrl, `/api/categories/${childId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { parent_id: null },
    });
    assertEqual(
      res.status,
      200,
      'child category can be promoted to root before deleting former parent',
    );

    res = await api(
      baseUrl,
      `/api/categories/${parentId}?action=reassign&reassign_to=${parentId}`,
      {
        method: 'DELETE',
        headers: authHeader,
      },
    );
    assertEqual(res.status, 400, 'category deletion rejects reassignment to itself');

    res = await api(
      baseUrl,
      `/api/categories/${parentId}?action=reassign&reassign_to=cat-247-target`,
      {
        method: 'DELETE',
        headers: authHeader,
      },
    );
    assertEqual(
      res.status,
      200,
      'category deletion can reassign products to a valid target once it has no children',
    );
    assertEqual(
      db.prepare('SELECT category_id FROM products WHERE id = ?').get('prod-247-reassign')
        .category_id,
      'cat-247-target',
      'products are reassigned',
    );

    console.log('\n─── Sibling sorting and legacy duplicate preservation ───');
    db.prepare(`
      INSERT INTO categories (id, name, parent_id, sort_order, is_active, created_at, updated_at)
      VALUES
        ('cat-sort-root-b', 'Root B', NULL, 20, 1, ?, ?),
        ('cat-sort-root-a', 'Root A', NULL, 10, 1, ?, ?),
        ('cat-sort-child-b', 'Sub B', 'cat-sort-root-a', 2, 1, ?, ?),
        ('cat-sort-child-a', 'Sub A', 'cat-sort-root-a', 1, 1, ?, ?),
        ('cat-legacy-dup-1', 'Legacy Dup', NULL, 30, 1, ?, ?),
        ('cat-legacy-dup-2', 'Legacy Dup', NULL, 31, 1, ?, ?)
    `).run(now(), now(), now(), now(), now(), now(), now(), now(), now(), now(), now(), now());

    res = await api(baseUrl, '/api/categories', { headers: authHeader });
    assertEqual(
      res.status,
      200,
      'GET /api/categories succeeds and preserves legacy duplicate siblings',
    );
    const orderedIds = res.data.categories.map((c: any) => c.id);
    const rootAIdx = orderedIds.indexOf('cat-sort-root-a');
    const subAIdx = orderedIds.indexOf('cat-sort-child-a');
    const subBIdx = orderedIds.indexOf('cat-sort-child-b');
    const rootBIdx = orderedIds.indexOf('cat-sort-root-b');
    assert(
      rootAIdx !== -1 && subAIdx === rootAIdx + 1 && subBIdx === rootAIdx + 2 && rootBIdx > subBIdx,
      'children are grouped immediately under their root parent in sibling sort_order',
    );
    assert(
      orderedIds.includes('cat-legacy-dup-1') && orderedIds.includes('cat-legacy-dup-2'),
      'legacy duplicate sibling records are preserved on read without silent merging',
    );

    console.log('\n─── Legacy inactive parent category consistency ───');
    db.prepare(`
      INSERT INTO categories (id, name, parent_id, sort_order, is_active, created_at, updated_at)
      VALUES
        ('cat-legacy-inactive-parent', 'Legacy Inactive Root', NULL, 40, 0, ?, ?),
        ('cat-legacy-active-child', 'Legacy Active Child', 'cat-legacy-inactive-parent', 1, 1, ?, ?),
        ('cat-sort-child-inactive', 'Sub Inactive', 'cat-sort-root-a', 3, 0, ?, ?)
    `).run(now(), now(), now(), now(), now(), now());
    seedProduct(db, 'prod-under-inactive-parent', 'cat-legacy-active-child', 'Hidden Child Tea', 9);
    seedProduct(db, 'prod-in-inactive-cat', 'cat-sort-child-inactive', 'Inactive Cat Product', 10);

    res = await api(baseUrl, '/api/categories?active=1', { headers: authHeader });
    assertEqual(res.status, 200, 'GET /api/categories?active=1 succeeds');
    const activeCatIds = res.data.categories.map((c: any) => c.id);
    assert(
      !activeCatIds.includes('cat-legacy-inactive-parent') &&
        !activeCatIds.includes('cat-legacy-active-child'),
      'GET /api/categories?active=1 excludes inactive parent and its active subcategory without flattening',
    );
    const activeRootA = res.data.categories.find((c: any) => c.id === 'cat-sort-root-a');
    assert(
      Boolean(activeRootA) &&
        !activeRootA.children.some((child: any) => child.id === 'cat-sort-child-inactive'),
      'GET /api/categories?active=1 excludes inactive subcategories from nested children',
    );

    res = await api(baseUrl, '/api/products?active=1', { headers: authHeader });
    assertEqual(res.status, 200, 'GET /api/products?active=1 succeeds');
    assert(
      !res.data.products.some((p: any) => p.id === 'prod-under-inactive-parent'),
      'GET /api/products?active=1 excludes products in subcategories under an inactive parent',
    );

    res = await api(baseUrl, '/api/categories/cat-legacy-active-child', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Legacy Active Child Edited',
        parent_id: 'cat-legacy-inactive-parent',
        is_active: true,
      },
    });
    assertEqual(
      res.status,
      200,
      'editing a subcategory while retaining its unchanged inactive parent succeeds',
    );

    res = await api(baseUrl, '/api/categories/cat-sort-root-b', {
      method: 'PUT',
      headers: authHeader,
      body: { parent_id: 'cat-legacy-inactive-parent' },
    });
    assertEqual(
      res.status,
      400,
      'moving a different category under an inactive parent is still rejected',
    );

    res = await api(baseUrl, '/api/categories/cat-legacy-inactive-parent', {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'Legacy Inactive Root Edited', is_active: false },
    });
    assertEqual(
      res.status,
      200,
      'editing an already-inactive parent category without activating it succeeds',
    );

    res = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Blocked Hidden Product', category_id: 'cat-legacy-active-child', price: 11 },
    });
    assertEqual(
      res.status,
      400,
      'creating a product in a subcategory under an inactive parent is rejected',
    );

    res = await api(baseUrl, '/api/products/prod-under-inactive-parent', {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'Hidden Child Tea Edited', category_id: 'cat-legacy-active-child', price: 11 },
    });
    assertEqual(
      res.status,
      200,
      'editing a product while retaining its subcategory under an inactive parent succeeds',
    );

    res = await api(baseUrl, '/api/products/prod-247-reassign', {
      method: 'PUT',
      headers: authHeader,
      body: { category_id: 'cat-legacy-active-child' },
    });
    assertEqual(
      res.status,
      400,
      'moving a product into a subcategory under an inactive parent is rejected',
    );

    res = await api(baseUrl, '/api/products/prod-in-inactive-cat', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Inactive Cat Product Edited',
        category_id: 'cat-sort-child-inactive',
        price: 12,
      },
    });
    assertEqual(
      res.status,
      200,
      'editing a product while retaining its unchanged inactive category succeeds',
    );

    res = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Blocked Inactive Cat Product',
        category_id: 'cat-sort-child-inactive',
        price: 12,
      },
    });
    assertEqual(res.status, 400, 'creating a product in an inactive category is rejected');

    res = await api(baseUrl, '/api/categories/cat-legacy-inactive-parent', {
      method: 'PUT',
      headers: authHeader,
      body: { is_active: true },
    });
    assertEqual(res.status, 200, 'reactivating a legacy inactive parent succeeds');

    res = await api(baseUrl, '/api/categories/cat-legacy-inactive-parent', {
      method: 'PUT',
      headers: authHeader,
      body: { is_active: false },
    });
    assertEqual(
      res.status,
      400,
      'deactivating the reactivated parent while it still has subcategories is refused',
    );

    console.log('\n─── Preserved deep categories and soft-deleted category guards ───');
    db.prepare(`
      INSERT INTO categories (id, name, parent_id, sort_order, is_active, deleted_at, created_at, updated_at)
      VALUES
        ('cat-deep-root', 'Deep Root', NULL, 50, 1, NULL, ?, ?),
        ('cat-deep-child', 'Deep Child', 'cat-deep-root', 1, 1, NULL, ?, ?),
        ('cat-deep-grand', 'Deep Grandchild', 'cat-deep-child', 1, 1, NULL, ?, ?),
        ('cat-soft-deleted', 'Soft Deleted Cat', NULL, 51, 1, ?, ?, ?)
    `).run(now(), now(), now(), now(), now(), now(), now(), now(), now());
    seedProduct(db, 'prod-soft-deleted-cat', 'cat-soft-deleted', 'Orphaned Cat Product', 7);

    res = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Deep Grandchild Tea', category_id: 'cat-deep-grand', price: 6 },
    });
    assertEqual(
      res.status,
      201,
      'creating a product in an active preserved depth-2 category succeeds',
    );
    const deepProdId = res.data.product.id;

    res = await api(baseUrl, '/api/categories/cat-deep-grand', {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'Deep Grandchild Edited', parent_id: 'cat-deep-child', is_active: true },
    });
    assertEqual(
      res.status,
      200,
      'editing a preserved depth-2 category while retaining its unchanged parent succeeds',
    );

    seedCustomer(db, 'cust-247-deep', 'Deep Catalog Customer');
    const deepOrderRes = db
      .prepare(`
      INSERT INTO orders (order_number, customer_id, type, status, created_at, updated_at)
      VALUES ('ORD-247-DEEP', 'cust-247-deep', 'takeaway', 'completed', ?, ?)
    `)
      .run(now(), now());
    const deepOrderId = Number(deepOrderRes.lastInsertRowid);
    db.prepare(`
      INSERT INTO bills (bill_number, order_id, customer_id, total, paid_amount, payment_status, created_at, updated_at)
      VALUES ('BILL-247-DEEP', ?, 'cust-247-deep', 13, 13, 'paid', ?, ?)
    `).run(deepOrderId, now(), now());
    db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
      VALUES
        (?, ?, 'Deep Grandchild Tea', 6, 1, 6, 6, 'completed', ?, ?),
        (?, 'prod-soft-deleted-cat', 'Orphaned Cat Product', 7, 1, 7, 7, 'completed', ?, ?)
    `).run(deepOrderId, deepProdId, now(), now(), deepOrderId, now(), now());

    res = await api(baseUrl, '/api/products?active=1', { headers: authHeader });
    assert(
      res.data.products.some((p: any) => p.id === deepProdId) &&
        !res.data.products.some((p: any) => p.id === 'prod-soft-deleted-cat'),
      'GET /api/products?active=1 includes active depth-2 product and excludes soft-deleted category product',
    );
    let topItems = getCustomerTopItems(db, 'cust-247-deep');
    assertEqual(
      topItems.find((item: any) => item.product_id === deepProdId)?.available,
      true,
      'getCustomerTopItems marks active preserved depth-2 product available',
    );
    assertEqual(
      topItems.find((item: any) => item.product_id === 'prod-soft-deleted-cat')?.available,
      false,
      'getCustomerTopItems marks product in soft-deleted category unavailable',
    );

    db.prepare('UPDATE categories SET is_active = 0 WHERE id = ?').run('cat-deep-root');

    res = await api(baseUrl, '/api/categories?active=1', { headers: authHeader });
    const activeIdsAfterDeepRootOff = res.data.categories.map((c: any) => c.id);
    assert(
      !activeIdsAfterDeepRootOff.includes('cat-deep-root') &&
        !activeIdsAfterDeepRootOff.includes('cat-deep-child') &&
        !activeIdsAfterDeepRootOff.includes('cat-deep-grand'),
      'GET /api/categories?active=1 excludes depth-2 category when its root ancestor is inactive',
    );

    res = await api(baseUrl, '/api/products?active=1', { headers: authHeader });
    assert(
      !res.data.products.some((p: any) => p.id === deepProdId),
      'GET /api/products?active=1 excludes depth-2 product when its root ancestor is inactive',
    );
    topItems = getCustomerTopItems(db, 'cust-247-deep');
    assertEqual(
      topItems.find((item: any) => item.product_id === deepProdId)?.available,
      false,
      'getCustomerTopItems marks depth-2 product unavailable when its root ancestor is inactive',
    );

    res = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Blocked Deep Product', category_id: 'cat-deep-grand', price: 8 },
    });
    assertEqual(
      res.status,
      400,
      'creating a product in a depth-2 category under an inactive root ancestor is rejected',
    );

    res = await api(baseUrl, `/api/products/${deepProdId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'Deep Grandchild Tea Retained', category_id: 'cat-deep-grand', price: 6.5 },
    });
    assertEqual(
      res.status,
      200,
      'editing a product while retaining its depth-2 category under an inactive root succeeds',
    );

    console.log('\n─── Product nullable field updates ───');
    seedCategory(db, 'cat-247-products', 'Products');
    seedProduct(db, 'prod-247-clear', 'cat-247-products', 'Clearable Product', 20);
    db.prepare(`
      UPDATE products SET sku = 'SKU-247', barcode = 'BAR-247', description = 'desc',
        cost = 5, image_url = 'data:image/png;base64,AAAA', cb_percent = 10,
        tags = '["a","b"]', tax_category_id = 'legacy-tax'
      WHERE id = 'prod-247-clear'
    `).run();

    res = await api(baseUrl, '/api/products/prod-247-clear', {
      method: 'PUT',
      headers: authHeader,
      body: {
        category_id: null,
        sku: null,
        barcode: null,
        description: null,
        cost_price: null,
        image_url: null,
        cb_percent: null,
        tax_category_id: null,
        tags: null,
      },
    });
    assertEqual(res.status, 200, 'product update accepts explicit null clears');
    const clearedProduct = db
      .prepare(`
      SELECT category_id, sku, barcode, description, cost, image_url, cb_percent, tax_category_id, tags
      FROM products WHERE id = 'prod-247-clear'
    `)
      .get() as any;
    assertEqual(clearedProduct.category_id, null, 'product category_id cleared');
    assertEqual(clearedProduct.sku, null, 'product sku cleared');
    assertEqual(clearedProduct.barcode, null, 'product barcode cleared');
    assertEqual(clearedProduct.description, null, 'product description cleared');
    assertEqual(clearedProduct.cost, null, 'product cost cleared');
    assertEqual(clearedProduct.image_url, null, 'product image_url cleared');
    assertEqual(clearedProduct.cb_percent, null, 'product cb_percent cleared');
    assertEqual(clearedProduct.tax_category_id, null, 'product tax_category_id cleared');
    assertEqual(clearedProduct.tags, '[]', 'product tags clear to an empty list');

    console.log('\n─── Add-on nullable field updates ───');
    db.prepare(`
      INSERT INTO addon_groups (id, name, description, min_selection, max_selection, is_active, created_at, updated_at)
      VALUES ('ag-247', 'Clearable Group', 'desc', 0, 1, 1, ?, ?)
    `).run(now(), now());
    db.prepare(`
      INSERT INTO addons (id, addon_group_id, name, price, tax_category_id, is_active, created_at, updated_at)
      VALUES ('addon-247', 'ag-247', 'Clearable Addon', 2, 'legacy-tax', 1, ?, ?)
    `).run(now(), now());

    res = await api(baseUrl, '/api/addon-groups/ag-247', {
      method: 'PUT',
      headers: authHeader,
      body: { description: null },
    });
    assertEqual(res.status, 200, 'add-on group description can be explicitly cleared');
    assertEqual(
      db.prepare('SELECT description FROM addon_groups WHERE id = ?').get('ag-247').description,
      null,
      'add-on group description cleared',
    );

    res = await api(baseUrl, '/api/addon-groups/ag-247/addons/addon-247', {
      method: 'PUT',
      headers: authHeader,
      body: { tax_category_id: null },
    });
    assertEqual(res.status, 200, 'add-on tax_category_id can be explicitly cleared');
    assertEqual(
      db.prepare('SELECT tax_category_id FROM addons WHERE id = ?').get('addon-247')
        .tax_category_id,
      null,
      'add-on tax_category_id cleared',
    );

    console.log('\n─── F2: Legacy duplicate category Management edits ───');
    db.prepare(`
      INSERT INTO categories (id, name, parent_id, sort_order, is_active, created_at, updated_at)
      VALUES
        ('cat-legacy-child-dup-1', 'Legacy Sub Dup', 'cat-sort-root-a', 10, 1, ?, ?),
        ('cat-legacy-child-dup-2', 'Legacy Sub Dup', 'cat-sort-root-a', 11, 1, ?, ?),
        ('cat-legacy-parent-dup-child', 'Sub Under Dup Root', 'cat-legacy-dup-2', 1, 1, ?, ?)
    `).run(now(), now(), now(), now(), now(), now());

    res = await api(baseUrl, '/api/categories/cat-legacy-dup-1', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Legacy Dup',
        parent_id: null,
        color: 'red',
        sort_order: 35,
        is_active: true,
        description: 'updated legacy root',
        addon_group_ids: [],
      },
    });
    assertEqual(
      res.status,
      200,
      'full Management payload edits unchanged legacy duplicate root category without collision error',
    );
    const updatedLegacyRoot = db
      .prepare('SELECT name, color, sort_order, is_active FROM categories WHERE id = ?')
      .get('cat-legacy-dup-1') as any;
    assertEqual(updatedLegacyRoot.color, 'red', 'legacy duplicate root color updated');
    assertEqual(updatedLegacyRoot.sort_order, 35, 'legacy duplicate root sort_order updated');

    res = await api(baseUrl, '/api/categories/cat-legacy-dup-1', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Legacy Dup',
        parent_id: null,
        color: 'red',
        sort_order: 35,
        is_active: false,
        description: 'updated legacy root',
        addon_group_ids: [],
      },
    });
    assertEqual(
      res.status,
      200,
      'full Management payload deactivates childless legacy duplicate root category',
    );
    assertEqual(
      db.prepare('SELECT is_active FROM categories WHERE id = ?').get('cat-legacy-dup-1').is_active,
      0,
      'legacy duplicate root deactivated',
    );

    res = await api(baseUrl, '/api/categories/cat-legacy-dup-2', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Legacy Dup',
        parent_id: null,
        color: null,
        sort_order: 31,
        is_active: false,
        description: null,
        addon_group_ids: [],
      },
    });
    assertEqual(
      res.status,
      400,
      'deactivating a legacy duplicate parent that has subcategories is still refused',
    );

    res = await api(baseUrl, '/api/categories/cat-legacy-child-dup-1', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Legacy Sub Dup',
        parent_id: 'cat-sort-root-a',
        color: 'blue',
        sort_order: 12,
        is_active: true,
        description: 'updated legacy child',
        addon_group_ids: [],
      },
    });
    assertEqual(
      res.status,
      200,
      'full Management payload edits unchanged legacy duplicate child category',
    );

    res = await api(baseUrl, '/api/categories/cat-legacy-child-dup-1', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Legacy Sub Dup',
        parent_id: 'cat-sort-root-a',
        color: 'blue',
        sort_order: 12,
        is_active: false,
        description: 'updated legacy child',
        addon_group_ids: [],
      },
    });
    assertEqual(
      res.status,
      200,
      'full Management payload deactivates legacy duplicate child category',
    );

    res = await api(baseUrl, '/api/categories/cat-sort-root-b', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Legacy Dup',
        parent_id: null,
        color: null,
        sort_order: 20,
        is_active: true,
        description: null,
        addon_group_ids: [],
      },
    });
    assertEqual(
      res.status,
      400,
      'renaming a distinct category into an existing sibling name fails',
    );

    res = await api(baseUrl, '/api/categories/cat-legacy-dup-1', {
      method: 'PUT',
      headers: authHeader,
      body: {
        name: 'Sub A',
        parent_id: 'cat-sort-root-a',
        color: 'red',
        sort_order: 35,
        is_active: true,
        description: null,
        addon_group_ids: [],
      },
    });
    assertEqual(res.status, 400, 'moving a category under a parent with a colliding child fails');

    console.log('\n─── F4: Unicode / non-ASCII sibling name uniqueness ───');
    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Кофе' },
    });
    assertEqual(res.status, 201, 'first Cyrillic root category Кофе is created');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Кофе' },
    });
    assertEqual(res.status, 400, 'exact duplicate Cyrillic root category Кофе is rejected');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'кофе' },
    });
    assertEqual(res.status, 400, 'case-variant Cyrillic root category кофе is rejected');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Érable' },
    });
    assertEqual(res.status, 201, 'first accented root category Érable is created');
    const erableRootId = res.data?.category?.id;

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Érable' },
    });
    assertEqual(res.status, 400, 'exact duplicate accented root category Érable is rejected');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'érable' },
    });
    assertEqual(res.status, 400, 'case-variant accented root category érable is rejected');

    res = await api(baseUrl, '/api/categories/cat-sort-root-b', {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'КОФЕ' },
    });
    assertEqual(res.status, 400, 'updating an existing category to colliding uppercase КОФЕ fails');

    if (erableRootId) {
      await api(baseUrl, `/api/categories/${erableRootId}`, {
        method: 'PUT',
        headers: authHeader,
        body: { is_active: false },
      });
      res = await api(baseUrl, '/api/categories', {
        method: 'POST',
        headers: authHeader,
        body: { name: 'ÉRABLE' },
      });
      assertEqual(
        res.status,
        400,
        'inactive non-deleted accented sibling still blocks duplicate creation',
      );
    }

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Кофе', parent_id: 'cat-sort-root-a' },
    });
    assertEqual(res.status, 201, 'Cyrillic subcategory Кофе under Root A is allowed');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Кофе', parent_id: 'cat-sort-root-b' },
    });
    assertEqual(res.status, 201, 'identical Cyrillic subcategory Кофе under Root B is allowed');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'КОФЕ', parent_id: 'cat-sort-root-a' },
    });
    assertEqual(res.status, 400, 'duplicate Cyrillic subcategory КОФЕ under same Root A fails');

    console.log('\n─── F3: Transactional sibling category reorder ───');
    seedCategory(db, 'cat-reorder-parent', 'Reorder Parent');
    const siblingIds: string[] = [];
    const insertReorderChild = db.prepare(`
      INSERT INTO categories (id, name, parent_id, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, 'cat-reorder-parent', 0, 1, ?, ?)
    `);
    for (let i = 0; i < 65; i++) {
      const id = `cat-s${String(i).padStart(2, '0')}`;
      siblingIds.push(id);
      insertReorderChild.run(id, `Sibling ${String(i).padStart(2, '0')}`, now(), now());
    }

    const intendedOrder = [siblingIds[1], siblingIds[0], ...siblingIds.slice(2)];
    res = await api(baseUrl, '/api/categories/reorder', {
      method: 'POST',
      headers: authHeader,
      body: { parent_id: 'cat-reorder-parent', category_ids: intendedOrder },
    });
    assertEqual(res.status, 200, '65-sibling reorder succeeds in a single transactional request');
    const persistedOrder = (
      db
        .prepare(
          'SELECT id FROM categories WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order, name',
        )
        .all('cat-reorder-parent') as { id: string }[]
    ).map((row) => row.id);
    assertEqual(
      JSON.stringify(persistedOrder),
      JSON.stringify(intendedOrder),
      'all 65 siblings persist in exact intended order without rate-limit scramble',
    );

    const snapshotBeforeInvalid = JSON.stringify(
      db
        .prepare(
          'SELECT id, sort_order FROM categories WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id',
        )
        .all('cat-reorder-parent'),
    );

    res = await api(baseUrl, '/api/categories/reorder', {
      method: 'POST',
      headers: authHeader,
      body: { parent_id: 'cat-reorder-parent', category_ids: intendedOrder.slice(0, 64) },
    });
    assertEqual(res.status, 400, 'incomplete sibling set is rejected');

    res = await api(baseUrl, '/api/categories/reorder', {
      method: 'POST',
      headers: authHeader,
      body: {
        parent_id: 'cat-reorder-parent',
        category_ids: [intendedOrder[0], intendedOrder[0], ...intendedOrder.slice(2)],
      },
    });
    assertEqual(res.status, 400, 'duplicate category IDs in reorder payload are rejected');

    res = await api(baseUrl, '/api/categories/reorder', {
      method: 'POST',
      headers: authHeader,
      body: {
        parent_id: 'cat-reorder-parent',
        category_ids: [...intendedOrder.slice(0, 64), 'cat-sort-root-a'],
      },
    });
    assertEqual(res.status, 400, 'non-sibling category ID in reorder payload is rejected');

    const snapshotAfterInvalid = JSON.stringify(
      db
        .prepare(
          'SELECT id, sort_order FROM categories WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id',
        )
        .all('cat-reorder-parent'),
    );
    assertEqual(
      snapshotAfterInvalid,
      snapshotBeforeInvalid,
      'rejected reorder payloads commit zero partial updates',
    );

    db.exec(`
      CREATE TEMPORARY TRIGGER fail_mid_category_reorder
      BEFORE UPDATE ON categories
      WHEN NEW.id = 'cat-s30'
      BEGIN
        SELECT RAISE(ABORT, 'forced mid-reorder failure');
      END;
    `);
    const reversedOrder = intendedOrder.slice().reverse();
    res = await api(baseUrl, '/api/categories/reorder', {
      method: 'POST',
      headers: authHeader,
      body: { parent_id: 'cat-reorder-parent', category_ids: reversedOrder },
    });
    db.exec('DROP TRIGGER fail_mid_category_reorder;');
    assertEqual(res.status, 500, 'mid-transaction failure returns 500');
    const snapshotAfterForcedFailure = JSON.stringify(
      db
        .prepare(
          'SELECT id, sort_order FROM categories WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id',
        )
        .all('cat-reorder-parent'),
    );
    assertEqual(
      snapshotAfterForcedFailure,
      snapshotBeforeInvalid,
      'forced mid-transaction failure rolls back all earlier sibling sort_order writes',
    );
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
