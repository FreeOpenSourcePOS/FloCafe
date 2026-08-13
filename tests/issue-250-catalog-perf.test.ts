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
  seedOwnerUser, api, assertEqual, getResults, closeDatabase,
} = require('./helpers/test-setup');

const { categoryRoutes } = require('../main/routes/categories');

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

  const app = createApp({ '/api/categories': categoryRoutes });
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
