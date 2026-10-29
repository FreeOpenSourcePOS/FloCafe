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
