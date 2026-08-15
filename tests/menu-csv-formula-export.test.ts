/** Regression coverage for GHSA-vrxh-633p-fhgm (CWE-1236): catalog CSV
 *  exports must neutralize spreadsheet formulas. A catalog value beginning
 *  with = + - or @ must be exported with a leading single quote so Excel /
 *  LibreOffice treats it as text instead of evaluating it as a formula. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-menu-csv-formula-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  assert,
  assertIncludes,
  getResults,
  closeDatabase,
  getDatabase,
} = require('./helpers/test-setup');
const { menuCsvRoutes } = require('../main/routes/menu-csv');

async function getText(baseUrl: string, urlPath: string, headers: Record<string, string>): Promise<string> {
  const response = await (globalThis as any).fetch(baseUrl + urlPath, { headers });
  return await response.text();
}

async function main() {
  console.log('Integration Test: Catalog CSV export neutralizes spreadsheet formulas');
  console.log('='.repeat(64));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);

  // Formula-leading catalog values across categories, products, and add-ons.
  seedCategory(db, 'cat-formula', '=HYPERLINK("https://attacker.example/","click")');
  seedProduct(db, 'prod-formula', 'cat-formula', '+SUM(1,2)', 12.5);
  db.prepare(`UPDATE products SET description = ? WHERE id = ?`).run('-1+2', 'prod-formula');
  db.prepare(`INSERT INTO addon_groups (id, name) VALUES ('ag-formula', 'Extras')`).run();
  db.prepare(`INSERT INTO addons (id, addon_group_id, name, price, is_active) VALUES ('addon-formula', 'ag-formula', '@SUM(A1:A2)', 5, 1)`).run();

  const app = createApp({ '/api/menu/csv': menuCsvRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Categories export neutralizes a leading "=" ───');
    {
      const csv = await getText(baseUrl, '/api/menu/csv/export/categories', authHeader);
      assertIncludes(csv, "'=HYPERLINK", 'leading "=" is prefixed with a single quote');
      assert(!/,"?=HYPERLINK/.test(csv) && !/^=HYPERLINK/.test(csv), 'no bare "=" formula cell remains in the categories export');
    }

    console.log('\n─── Products export neutralizes "+" and "-" ───');
    {
      const csv = await getText(baseUrl, '/api/menu/csv/export/products', authHeader);
      assertIncludes(csv, "'+SUM(1,2)", 'leading "+" is prefixed with a single quote');
      assertIncludes(csv, "'-1+2", 'leading "-" is prefixed with a single quote');
      assertIncludes(csv, '12.5', 'numeric fields (price) are preserved as numbers');
    }

    console.log('\n─── Add-ons export neutralizes a leading "@" ───');
    {
      const csv = await getText(baseUrl, '/api/menu/csv/export/addons', authHeader);
      assertIncludes(csv, "'@SUM(A1:A2)", 'leading "@" is prefixed with a single quote');
    }
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(64));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
