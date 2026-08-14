/**
 * Integration Test: Issue #250 — catalog read/render scaling guardrails
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-250-catalog-perf.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-250-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-250';

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedProduct, api, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { categoryRoutes } = require('../main/routes/categories');
const { productRoutes } = require('../main/routes/products');
const { addonGroupRoutes } = require('../main/routes/addon-groups');

function seedCategoryRow(db: any, id: string, name: string, sortOrder: number, parentId: string | null = null) {
  db.prepare(`
    INSERT INTO categories (id, name, slug, parent_id, sort_order, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, name, name.toLowerCase(), parentId, sortOrder);
}

async function main() {
  console.log('Integration Test: Issue #250 — catalog performance guardrails');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategoryRow(db, 'cat-250-a', 'A', 1);
  seedCategoryRow(db, 'cat-250-b', 'B', 2);
  seedCategoryRow(db, 'cat-250-c', 'C', 3);
  seedCategoryRow(db, 'cat-250-a-1', 'A One', 1, 'cat-250-a');
  seedCategoryRow(db, 'cat-250-b-1', 'B One', 1, 'cat-250-b');
  seedCategoryRow(db, 'cat-250-b-2', 'B Two', 2, 'cat-250-b');
  seedProduct(db, 'prod-250-a', 'cat-250-a', 'Product A', 100, { track_inventory: true, stock_quantity: 5 });
  db.prepare('UPDATE products SET image_url = ? WHERE id = ?')
    .run('data:image/png;base64,iVBORw0KGgo=', 'prod-250-a');
  db.prepare(`
    INSERT INTO addon_groups (id, name, is_required, allow_multiple_quantities, is_active, sort_order, created_at, updated_at)
    VALUES ('ag-250', 'Extras', 1, 1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run();
  db.prepare(`
    INSERT INTO addons (id, addon_group_id, name, price, inherit_parent_tax_category, is_active, sort_order, created_at, updated_at)
    VALUES ('addon-250', 'ag-250', 'Extra', 10, 1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run();
  db.prepare('INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)').run('prod-250-a', 'ag-250');

  const app = createApp({
    '/api/categories': categoryRoutes,
    '/api/products': productRoutes,
    '/api/addon-groups': addonGroupRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  const originalPrepare = db.prepare.bind(db);
  let childLoadQueries = 0;
  db.prepare = function (sql: string) {
    if (/FROM categories\s+WHERE parent_id IN/.test(sql)) {
      childLoadQueries++;
    }
    return originalPrepare(sql);
  };

  try {
    console.log('\n─── Scenario A: category listing batches child loading ───');
    const res = await api(baseUrl, '/api/categories?root=true', { headers: authHeader });
    assertEqual(res.status, 200, 'A: category list succeeds');
    assertEqual(res.data.categories.length, 3, 'A: root categories are returned');
    assertEqual(childLoadQueries, 1, 'A: children are loaded in one batched query');
    const byId = new Map(res.data.categories.map((category: any) => [category.id, category]));
    assertEqual(byId.get('cat-250-a').children.map((child: any) => child.id).join(','), 'cat-250-a-1', 'A: first parent has its child');
    assertEqual(byId.get('cat-250-b').children.map((child: any) => child.id).join(','), 'cat-250-b-1,cat-250-b-2', 'A: second parent children retain sort order');
    assertEqual(byId.get('cat-250-c').children.length, 0, 'A: parent without children returns empty child list');

    console.log('\n─── Scenario B: catalog API returns string IDs and boolean flags ───');
    const productsRes = await api(baseUrl, '/api/products?active=1', { headers: authHeader });
    assertEqual(productsRes.status, 200, 'B: product list succeeds');
    const product = productsRes.data.products.find((entry: any) => entry.id === 'prod-250-a');
    assertEqual(typeof product.id, 'string', 'B: product id is a string');
    assertEqual(typeof product.category_id, 'string', 'B: product category_id is a string');
    assertEqual(typeof product.is_active, 'boolean', 'B: product is_active is boolean');
    assertEqual(product.is_active, true, 'B: active product serializes is_active true');
    assertEqual(typeof product.track_inventory, 'boolean', 'B: product track_inventory is boolean');
    assertEqual(product.track_inventory, true, 'B: tracked product serializes track_inventory true');
    assertEqual(typeof product.has_image, 'boolean', 'B: product has_image is boolean');
    assertEqual(product.has_image, true, 'B: product with image serializes has_image true');
    assertEqual(typeof product.category.id, 'string', 'B: embedded category id is a string');
    assertEqual(typeof product.category.is_active, 'boolean', 'B: embedded category is_active is boolean');
    assertEqual(typeof product.addon_groups[0].id, 'string', 'B: embedded add-on group id is a string');
    assertEqual(typeof product.addon_groups[0].is_required, 'boolean', 'B: embedded add-on group is_required is boolean');
    assertEqual(typeof product.addon_groups[0].allow_multiple_quantities, 'boolean', 'B: embedded add-on group allow_multiple_quantities is boolean');
    assertEqual(typeof product.addon_groups[0].addons[0].id, 'string', 'B: embedded add-on id is a string');
    assertEqual(typeof product.addon_groups[0].addons[0].is_active, 'boolean', 'B: embedded add-on is_active is boolean');

    const categoryDetail = await api(baseUrl, '/api/categories/cat-250-a', { headers: authHeader });
    assertEqual(categoryDetail.status, 200, 'B: category detail succeeds');
    assertEqual(typeof categoryDetail.data.category.id, 'string', 'B: category detail id is a string');
    assertEqual(typeof categoryDetail.data.category.is_active, 'boolean', 'B: category detail is_active is boolean');
    assertEqual(typeof categoryDetail.data.category.products[0].id, 'string', 'B: category detail product id is a string');
    assertEqual(typeof categoryDetail.data.category.products[0].track_inventory, 'boolean', 'B: category detail product track_inventory is boolean');

    const addonGroupsRes = await api(baseUrl, '/api/addon-groups', { headers: authHeader });
    assertEqual(addonGroupsRes.status, 200, 'B: add-on group list succeeds');
    assertEqual(typeof addonGroupsRes.data.addon_groups[0].id, 'string', 'B: add-on group id is a string');
    assertEqual(typeof addonGroupsRes.data.addon_groups[0].is_required, 'boolean', 'B: add-on group is_required is boolean');
    assertEqual(typeof addonGroupsRes.data.addon_groups[0].allow_multiple_quantities, 'boolean', 'B: add-on group allow_multiple_quantities is boolean');
    assertEqual(typeof addonGroupsRes.data.addon_groups[0].addons[0].addon_group_id, 'string', 'B: add-on addon_group_id is a string');
    assertEqual(typeof addonGroupsRes.data.addon_groups[0].addons[0].is_active, 'boolean', 'B: add-on is_active is boolean');
  } finally {
    db.prepare = originalPrepare;
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
