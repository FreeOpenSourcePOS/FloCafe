const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-category-addon-groups-'));

Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-category-addon-groups';

const assert = require('node:assert/strict');
const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { MIGRATIONS, getCurrentSchemaVersion } = require('../main/db');
const { addonGroupRoutes } = require('../main/routes/addon-groups');
const { categoryRoutes } = require('../main/routes/categories');
const { productRoutes } = require('../main/routes/products');
const { orderRoutes } = require('../main/routes/orders');

function seedAddonGroup(db: any, id: string, name: string, sortOrder: number, isActive = 1) {
  db.prepare(`
    INSERT INTO addon_groups (id, name, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, isActive, sortOrder, now(), now());
}

function seedAddon(db: any, id: string, groupId: string, name: string) {
  db.prepare(`
    INSERT INTO addons (id, addon_group_id, name, price, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 25, 1, ?, ?)
  `).run(id, groupId, name, now(), now());
}

async function main() {
  console.log('Integration Test: category-level add-on group assignment');
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedAddonGroup(db, 'ag-category-a', 'Category A', 0);
  seedAddonGroup(db, 'ag-category-z', 'Category Z', 5);
  seedAddonGroup(db, 'ag-product', 'Product', 0);
  seedAddonGroup(db, 'ag-shared', 'Shared', 0);
  seedAddonGroup(db, 'ag-other', 'Other', 0);
  seedAddonGroup(db, 'ag-inactive', 'Inactive', 0, 0);
  seedAddonGroup(db, 'ag-retired', 'Retired', 0);
  seedAddon(db, 'addon-category-a', 'ag-category-a', 'Extra cheese');

  const app = createApp({
    '/api/addon-groups': addonGroupRoutes,
    '/api/categories': categoryRoutes,
    '/api/products': productRoutes,
    '/api/orders': orderRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // This suite pins the category add-on group migration it covers, not the
    // registry tail: the tail moves with every new feature, so pinning it here
    // would fail an unrelated suite on someone else's migration.
    assert.ok(MIGRATIONS[MIGRATIONS.length - 1].version >= 98, 'the category add-on group migration is registered');
    assert.ok(getCurrentSchemaVersion() >= 98, 'fresh database applies the category add-on group migration');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'category_addon_groups'").get());
    db.exec('DROP TABLE category_addon_groups');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'category_addon_groups'").get(), undefined);
    MIGRATIONS.find((migration: any) => migration.version === 98).up();
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'category_addon_groups'").get(), 'migration 98 creates the join table for upgraded databases');
    assert.deepEqual(db.pragma('foreign_key_check'), [], 'category add-on group schema has no foreign-key violations');

    let res = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Invalid Shape', addon_group_ids: 'ag-category-a' },
    });
    assert.equal(res.status, 400, 'category creation rejects a non-array add-on group list');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Unknown Group', addon_group_ids: ['missing-group'] },
    });
    assert.equal(res.status, 400, 'category creation rejects unknown add-on group IDs');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM categories WHERE name = 'Unknown Group'").get().count, 0);

    res = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Inactive Group', addon_group_ids: ['ag-inactive'] },
    });
    assert.equal(res.status, 400, 'category creation rejects inactive add-on group IDs');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Duplicate Group', addon_group_ids: ['ag-category-a', 'ag-category-a'] },
    });
    assert.equal(res.status, 400, 'category creation rejects duplicate add-on group IDs');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Pizza', addon_group_ids: ['ag-category-a', 'ag-category-z', 'ag-shared'] },
    });
    assert.equal(res.status, 201, 'valid category add-on groups are accepted');
    const categoryId = res.data.category.id;
    assert.deepEqual(new Set(res.data.category.addon_group_ids), new Set(['ag-category-a', 'ag-category-z', 'ag-shared']));

    const retainedGroupCategory = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Retired Group Assignment', addon_group_ids: ['ag-category-a', 'ag-retired'] },
    });
    assert.equal(retainedGroupCategory.status, 201);
    const retainedGroupCategoryId = retainedGroupCategory.data.category.id;
    seedAddon(db, 'addon-retired', 'ag-retired', 'Retired add-on');
    seedProduct(db, 'prod-retired-group', retainedGroupCategoryId, 'Retired Group Product', 100);
    seedProduct(db, 'prod-direct-retired-group', categoryId, 'Direct Retired Group Product', 100);
    db.prepare('INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)').run('prod-direct-retired-group', 'ag-retired');
    const historicalOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-retired-group', quantity: 1, addons: [{ id: 'addon-retired' }] }] },
    });
    assert.equal(historicalOrder.status, 201, 'active add-ons from active category groups are accepted before deactivation');
    const historicalItemId = historicalOrder.data.order.items[0].id;
    res = await api(baseUrl, '/api/addon-groups/ag-retired', { method: 'DELETE', headers: authHeader });
    assert.equal(res.status, 200, 'assigned add-on groups can be deactivated');
    const activeGroupsAfterDeactivation = await api(baseUrl, '/api/addon-groups', { headers: authHeader });
    assert(!activeGroupsAfterDeactivation.data.addon_groups.some((group: any) => group.id === 'ag-retired'), 'default add-on group listing still hides inactive groups');
    const retainedInactiveProductUpdate = await api(baseUrl, '/api/products/prod-direct-retired-group', {
      method: 'PUT', headers: authHeader,
      body: { name: 'Direct Retired Group Product Renamed', addon_group_ids: ['ag-retired'] },
    });
    assert.equal(retainedInactiveProductUpdate.status, 200, 'product edits can retain an already-assigned inactive add-on group');
    assert.equal(retainedInactiveProductUpdate.data.product.name, 'Direct Retired Group Product Renamed');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM addon_group_product WHERE product_id = ? AND addon_group_id = ?').get('prod-direct-retired-group', 'ag-retired').count, 1);
    const removeInactiveProductGroup = await api(baseUrl, '/api/products/prod-direct-retired-group', {
      method: 'PUT', headers: authHeader,
      body: { addon_group_ids: [] },
    });
    assert.equal(removeInactiveProductGroup.status, 200, 'product edits can remove an existing inactive add-on group');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM addon_group_product WHERE product_id = ? AND addon_group_id = ?').get('prod-direct-retired-group', 'ag-retired').count, 0);
    const reattachInactiveProductGroup = await api(baseUrl, '/api/products/prod-direct-retired-group', {
      method: 'PUT', headers: authHeader,
      body: { addon_group_ids: ['ag-retired'] },
    });
    assert.equal(reattachInactiveProductGroup.status, 400, 'removed inactive add-on groups cannot be newly attached to products');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM addon_group_product WHERE product_id = ? AND addon_group_id = ?').get('prod-direct-retired-group', 'ag-retired').count, 0);
    const historicalOrderAfterDeactivation = await api(baseUrl, `/api/orders/${historicalOrder.data.order.id}`, { headers: authHeader });
    assert.equal(historicalOrderAfterDeactivation.data.order.items[0].addons[0].name, 'Retired add-on', 'group deactivation preserves saved order add-on snapshots');
    assert.equal(historicalOrderAfterDeactivation.data.order.items[0].addons[0].price, 25, 'group deactivation preserves the saved add-on price');
    const categoryLinkedInactiveGroupOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-retired-group', quantity: 1, addons: [{ id: 'addon-retired' }] }] },
    });
    assert.equal(categoryLinkedInactiveGroupOrder.status, 400, 'an active add-on under an inactive category-linked group is rejected');
    const productLinkedInactiveGroupOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-direct-retired-group', quantity: 1, addons: [{ id: 'addon-retired' }] }] },
    });
    assert.equal(productLinkedInactiveGroupOrder.status, 400, 'an active add-on under an inactive product-linked group is rejected');
    const allGroupsAfterDeactivation = await api(baseUrl, '/api/addon-groups?include_inactive=true', { headers: authHeader });
    const retiredGroup = allGroupsAfterDeactivation.data.addon_groups.find((group: any) => group.id === 'ag-retired');
    assert.equal(retiredGroup?.name, 'Retired', 'category editor can load the inactive group name');
    assert.equal(retiredGroup?.is_active, false, 'category editor receives inactive status');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM order_item_addons WHERE order_item_id = ?').get(historicalItemId).count, 1, 'historical order add-on snapshot remains stored');
    const afterGroupDeactivation = await api(baseUrl, `/api/categories/${retainedGroupCategoryId}`, { headers: authHeader });
    assert.deepEqual(new Set(afterGroupDeactivation.data.category.addon_group_ids), new Set(['ag-category-a', 'ag-retired']), 'category retains its assigned group after the group is deactivated');
    res = await api(baseUrl, `/api/categories/${retainedGroupCategoryId}`, {
      method: 'PUT', headers: authHeader,
      body: { name: 'Retired Group Assignment Renamed', addon_group_ids: ['ag-category-a', 'ag-retired'] },
    });
    assert.equal(res.status, 200, 'category edits can retain an already-assigned inactive add-on group');
    assert.deepEqual(new Set(res.data.category.addon_group_ids), new Set(['ag-category-a', 'ag-retired']));
    assert.equal(res.data.category.name, 'Retired Group Assignment Renamed');
    res = await api(baseUrl, `/api/categories/${retainedGroupCategoryId}`, {
      method: 'PUT', headers: authHeader,
      body: { addon_group_ids: ['ag-category-a'] },
    });
    assert.equal(res.status, 200, 'category edits can remove an existing inactive add-on group');
    assert.deepEqual(res.data.category.addon_group_ids, ['ag-category-a']);
    res = await api(baseUrl, `/api/categories/${retainedGroupCategoryId}`, {
      method: 'PUT', headers: authHeader,
      body: { addon_group_ids: ['ag-category-a', 'ag-retired'] },
    });
    assert.equal(res.status, 400, 'removed inactive add-on groups cannot be newly attached');
    const afterInactiveReattach = await api(baseUrl, `/api/categories/${retainedGroupCategoryId}`, { headers: authHeader });
    assert.deepEqual(afterInactiveReattach.data.category.addon_group_ids, ['ag-category-a'], 'rejected inactive attachment preserves active links');

    res = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Pizza Extras', parent_id: categoryId, addon_group_ids: ['ag-product'] },
    });
    assert.equal(res.status, 201, 'child category add-on groups are accepted');
    const childCategoryId = res.data.category.id;

    const categoryList = await api(baseUrl, '/api/categories', { headers: authHeader });
    const listedCategory = categoryList.data.categories.find((category: any) => category.id === categoryId);
    assert.deepEqual(new Set(listedCategory.addon_group_ids), new Set(['ag-category-a', 'ag-category-z', 'ag-shared']));
    assert.deepEqual(listedCategory.children.find((category: any) => category.id === childCategoryId).addon_group_ids, ['ag-product']);
    const categoryDetail = await api(baseUrl, `/api/categories/${categoryId}`, { headers: authHeader });
    assert.deepEqual(new Set(categoryDetail.data.category.addon_group_ids), new Set(['ag-category-a', 'ag-category-z', 'ag-shared']));
    assert.deepEqual(categoryDetail.data.category.children[0].addon_group_ids, ['ag-product']);

    seedProduct(db, 'prod-category-addon', categoryId, 'Pizza', 100);
    db.prepare('INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)').run('prod-category-addon', 'ag-product');
    db.prepare('INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)').run('prod-category-addon', 'ag-shared');

    const productDetail = await api(baseUrl, '/api/products/prod-category-addon', { headers: authHeader });
    assert.deepEqual(
      productDetail.data.product.addon_groups.map((group: any) => group.id),
      ['ag-category-a', 'ag-product', 'ag-shared', 'ag-category-z'],
      'product API returns the deduplicated category/product union sorted by sort_order then name',
    );
    assert.deepEqual(new Set(productDetail.data.product.addon_group_ids), new Set(['ag-product', 'ag-shared']), 'product API retains direct links separately for catalog edits');

    const order = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-category-addon', quantity: 1, addons: [{ id: 'addon-category-a' }] }] },
    });
    assert.equal(order.status, 201, 'order accepts an add-on from an inherited category group');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM order_item_addons WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?) AND addon_id = ?').get(order.data.order.id, 'addon-category-a').count, 1);
    db.prepare('UPDATE addon_groups SET is_required = 1, min_selection = 1 WHERE id = ?').run('ag-category-a');
    const omittedInheritedRequiredGroupOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-category-addon', quantity: 1 }] },
    });
    assert.equal(omittedInheritedRequiredGroupOrder.status, 400, 'orders cannot omit a required inherited category add-on group');
    const selectedInheritedRequiredGroupOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-category-addon', quantity: 1, addons: [{ id: 'addon-category-a' }] }] },
    });
    assert.equal(selectedInheritedRequiredGroupOrder.status, 201, 'orders accept the selected required inherited category add-on');

    res = await api(baseUrl, `/api/categories/${categoryId}`, {
      method: 'PUT', headers: authHeader,
      body: { addon_group_ids: ['ag-category-a'] },
    });
    assert.equal(res.status, 200, 'category add-on groups can be replaced');
    assert.deepEqual(res.data.category.addon_group_ids, ['ag-category-a']);

    res = await api(baseUrl, `/api/categories/${categoryId}`, {
      method: 'PUT', headers: authHeader,
      body: { name: 'Should Not Commit', addon_group_ids: ['ag-inactive'] },
    });
    assert.equal(res.status, 400, 'category update rejects inactive add-on group IDs');
    const afterRejectedUpdate = await api(baseUrl, `/api/categories/${categoryId}`, { headers: authHeader });
    assert.deepEqual(afterRejectedUpdate.data.category.addon_group_ids, ['ag-category-a'], 'rejected update preserves category links');
    assert.equal(afterRejectedUpdate.data.category.name, 'Pizza', 'rejected update preserves category fields');

    const replacedProduct = await api(baseUrl, '/api/products/prod-category-addon', { headers: authHeader });
    assert.deepEqual(replacedProduct.data.product.addon_groups.map((group: any) => group.id), ['ag-category-a', 'ag-product', 'ag-shared']);

    res = await api(baseUrl, `/api/categories/${categoryId}`, {
      method: 'PUT', headers: authHeader,
      body: { name: 'Pizza Menu' },
    });
    assert.equal(res.status, 200, 'category updates can omit add-on group links');
    assert.deepEqual(res.data.category.addon_group_ids, ['ag-category-a'], 'omitting add-on group links preserves them');

    res = await api(baseUrl, `/api/categories/${categoryId}`, {
      method: 'PUT', headers: authHeader,
      body: { addon_group_ids: [] },
    });
    assert.equal(res.status, 200, 'category add-on groups can be cleared');
    assert.deepEqual(res.data.category.addon_group_ids, []);
    const clearedProduct = await api(baseUrl, '/api/products/prod-category-addon', { headers: authHeader });
    assert.deepEqual(clearedProduct.data.product.addon_groups.map((group: any) => group.id), ['ag-product', 'ag-shared']);

    seedCategory(db, 'cat-category-addon-other', 'Other');
    db.prepare('INSERT INTO category_addon_groups (category_id, addon_group_id) VALUES (?, ?)').run('cat-category-addon-other', 'ag-other');
    db.prepare('UPDATE products SET category_id = ? WHERE id = ?').run('cat-category-addon-other', 'prod-category-addon');
    const movedProduct = await api(baseUrl, '/api/products/prod-category-addon', { headers: authHeader });
    assert.deepEqual(
      movedProduct.data.product.addon_groups.map((group: any) => group.id),
      ['ag-other', 'ag-product', 'ag-shared'],
      'moving a product changes inherited groups while retaining direct product groups',
    );

    res = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Cascade Category', addon_group_ids: ['ag-category-z'] },
    });
    assert.equal(res.status, 201);
    db.prepare('DELETE FROM categories WHERE id = ?').run(res.data.category.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM category_addon_groups WHERE category_id = ?').get(res.data.category.id).count, 0, 'category deletion cascades category links');

    seedAddonGroup(db, 'ag-cascade-delete', 'Cascade Group', 0);
    res = await api(baseUrl, '/api/categories', {
      method: 'POST', headers: authHeader,
      body: { name: 'Cascade Group Category', addon_group_ids: ['ag-cascade-delete'] },
    });
    assert.equal(res.status, 201);
    db.prepare('DELETE FROM addon_groups WHERE id = ?').run('ag-cascade-delete');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM category_addon_groups WHERE addon_group_id = ?').get('ag-cascade-delete').count, 0, 'add-on group deletion cascades category links');
    console.log('Category-level add-on group checks passed');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: any) => error ? reject(error) : resolve()));
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: any) => {
  console.error(error);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exitCode = 1;
});
