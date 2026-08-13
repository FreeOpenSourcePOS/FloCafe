/**
 * Integration Test: Issue #244 — product add-on link validation
 *
 * Usage: node tests/run-electron-node-test.cjs tests/issue-244-product-addon-links.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-issue-244-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-issue-244';

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { productRoutes } = require('../main/routes/products');

function seedAddonGroup(db: any, id: string, name: string, isActive = 1) {
  db.prepare(`
    INSERT INTO addon_groups (id, name, is_active, created_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, name, isActive);
}

function linkedGroupIds(db: any, productId: string) {
  return db.prepare(`
    SELECT addon_group_id FROM addon_group_product WHERE product_id = ? ORDER BY addon_group_id
  `).all(productId).map((row: any) => row.addon_group_id).join(',');
}

async function main() {
  console.log('Integration Test: Issue #244 — product add-on link validation');
  console.log('='.repeat(60));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-244', 'Coffee');
  seedProduct(db, 'prod-244', 'cat-244', 'Latte', 100);
  seedAddonGroup(db, 'ag-244-milk', 'Milk');
  seedAddonGroup(db, 'ag-244-syrup', 'Syrup');
  seedAddonGroup(db, 'ag-244-inactive', 'Inactive', 0);
  db.prepare('INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)').run('prod-244', 'ag-244-milk');

  const app = createApp({ '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Scenario A: create validates add-on link IDs before writing ───');
    let res = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: { category_id: 'cat-244', name: 'Bad Duplicate', price: 50, addon_group_ids: ['ag-244-milk', 'ag-244-milk'] },
    });
    assertEqual(res.status, 400, 'A1: duplicate add-on group IDs are rejected');
    assertEqual(db.prepare("SELECT COUNT(*) as count FROM products WHERE name = 'Bad Duplicate'").get().count, 0, 'A1: rejected create does not insert product');

    res = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: { category_id: 'cat-244', name: 'Bad Unknown', price: 50, addon_group_ids: ['ag-244-missing'] },
    });
    assertEqual(res.status, 400, 'A2: unknown add-on group ID is rejected');
    assertEqual(db.prepare("SELECT COUNT(*) as count FROM products WHERE name = 'Bad Unknown'").get().count, 0, 'A2: unknown ID create does not insert product');

    res = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: { category_id: 'cat-244', name: 'Bad Shape', price: 50, addon_group_ids: 'ag-244-milk' },
    });
    assertEqual(res.status, 400, 'A3: non-array add-on group IDs are rejected');

    console.log('\n─── Scenario B: create accepts valid active links ───');
    res = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: { category_id: 'cat-244', name: 'Valid Linked', price: 75, addon_group_ids: ['ag-244-syrup', 'ag-244-milk'] },
    });
    assertEqual(res.status, 201, 'B: valid linked product is created');
    assertEqual(linkedGroupIds(db, res.data.product.id), 'ag-244-milk,ag-244-syrup', 'B: valid add-on links are persisted');

    console.log('\n─── Scenario C: update validates links and preserves existing state on rejection ───');
    res = await api(baseUrl, '/api/products/prod-244', {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'Should Not Stick', price: 125, addon_group_ids: ['ag-244-inactive'] },
    });
    assertEqual(res.status, 400, 'C1: inactive add-on group ID is rejected');
    const unchanged = db.prepare('SELECT name, price FROM products WHERE id = ?').get('prod-244') as any;
    assertEqual(unchanged.name, 'Latte', 'C1: failed update preserves product name');
    assertEqual(unchanged.price, 100, 'C1: failed update preserves product price');
    assertEqual(linkedGroupIds(db, 'prod-244'), 'ag-244-milk', 'C1: failed update preserves existing links');

    res = await api(baseUrl, '/api/products/prod-244', {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'Linked Latte', addon_group_ids: ['ag-244-syrup'] },
    });
    assertEqual(res.status, 200, 'C2: valid update succeeds');
    assertEqual(db.prepare('SELECT name FROM products WHERE id = ?').get('prod-244').name, 'Linked Latte', 'C2: valid update changes product fields');
    assertEqual(linkedGroupIds(db, 'prod-244'), 'ag-244-syrup', 'C2: valid update replaces links');

    res = await api(baseUrl, '/api/products/prod-244', {
      method: 'PUT',
      headers: authHeader,
      body: { addon_group_ids: [] },
    });
    assertEqual(res.status, 200, 'C3: empty add-on group list clears links');
    assertEqual(linkedGroupIds(db, 'prod-244'), '', 'C3: links are cleared');
  } finally {
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
