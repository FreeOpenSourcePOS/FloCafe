/** Behavioral coverage for issue #248: strict catalog CSV imports. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-menu-csv-248-'));

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
  api,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { menuCsvRoutes } = require('../main/routes/menu-csv');

const PRODUCT_HEADER = 'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active';
const ADDON_HEADER = 'group_name,addon_name,price,group_required,group_min_select,group_max_select';

function productCsv(...rows: string[]): string {
  return [PRODUCT_HEADER, ...rows].join('\n');
}

function addonCsv(...rows: string[]): string {
  return [ADDON_HEADER, ...rows].join('\n');
}

function addonCsvWithHeader(header: string, ...rows: string[]): string {
  return [header, ...rows].join('\n');
}

async function main() {
  console.log('Integration Test: Issue #248 strict catalog CSV imports');
  console.log('='.repeat(58));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-csv-248', 'CSV Category');

  const app = createApp({ '/api/menu/csv': menuCsvRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Valid quoted CSV ───');
    const quoted = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          ',,"Quoted, Coffee","CSV Category",12.50,"He said ""hot"",\nthen served",3.25,,,2.5,"coffee,featured",yes',
          ',,"CR Product","CSV Category",12,"line1\rline2",1,,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqual(quoted.status, 200, 'valid quoted product CSV is accepted');
    assertEqual(quoted.data.created, 2, 'quoted products are created');
    assertEqual(quoted.data.failed, 0, 'valid quoted row is not failed');
    const quotedProduct = db.prepare('SELECT price, cost, description, tags FROM products WHERE name = ?').get('Quoted, Coffee') as any;
    assertEqual(quotedProduct.price, 12.5, 'quoted product price is parsed completely');
    assertEqual(quotedProduct.cost, 3.25, 'quoted product cost is parsed completely');
    assertEqual(quotedProduct.description, 'He said "hot",\nthen served', 'quoted commas, quotes, and newlines are preserved');
    assertEqual(quotedProduct.tags, JSON.stringify(['coffee', 'featured']), 'quoted comma-separated tags are preserved');
    const carriageReturnProduct = db.prepare('SELECT description FROM products WHERE name = ?').get('CR Product') as any;
    assertEqual(carriageReturnProduct.description, 'line1\rline2', 'quoted carriage returns are preserved');

    const malformedPostQuote = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          ',,"Malformed" ,"CSV Category",10,Description,1,,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqual(malformedPostQuote.status, 400, 'spaces after a closing CSV quote are rejected');
    assert(malformedPostQuote.data.error.includes('after closing quote'), 'post-quote whitespace error identifies the malformed record');
    assertEqual(db.prepare('SELECT id FROM products WHERE name = ?').get('Malformed'), undefined, 'malformed post-quote row is not persisted');

    console.log('\n─── Unterminated quoted row rolls back the import ───');
    const beforeMalformedCount = (db.prepare('SELECT COUNT(*) AS count FROM products').get() as any).count;
    const malformed = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          ',,Should Roll Back,CSV Category,10,Description,1,,,,,yes',
          ',,Unterminated,CSV Category,11,"description never closes,1,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqual(malformed.status, 400, 'unterminated quoted CSV is rejected');
    assert(malformed.data.error.includes('unterminated'), 'unterminated CSV error explains the malformed quote');
    const afterMalformedCount = (db.prepare('SELECT COUNT(*) AS count FROM products').get() as any).count;
    assertEqual(afterMalformedCount, beforeMalformedCount, 'malformed CSV does not partially import earlier rows');
    const rolledBackProduct = db.prepare('SELECT id FROM products WHERE name = ?').get('Should Roll Back');
    assertEqual(rolledBackProduct, undefined, 'malformed CSV leaves no inserted product behind');

    console.log('\n─── Partial numeric tokens and rejected rows ───');
    const partialNumbers = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          ',,Partial Price,CSV Category,12abc,Description,1,,,,,yes',
          ',,Partial Cost,CSV Category,12,Description,5xyz,,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqual(partialNumbers.status, 200, 'partial numeric rows return row-level validation results');
    assertEqual(partialNumbers.data.created, 0, 'partial numeric rows are not created');
    assertEqual(partialNumbers.data.failed, 2, 'each partial numeric row is counted as failed');
    assert(partialNumbers.data.errors.some((error: string) => error.includes('invalid price "12abc"')), 'partial price token is rejected');
    assert(partialNumbers.data.errors.some((error: string) => error.includes('invalid cost "5xyz"')), 'partial cost token is rejected');

    const mixedRows = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          ',,Valid Beside Failure,CSV Category,13,Description,2,,,,,yes',
          ',,Rejected Beside Valid,CSV Category,14abc,Description,2,,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqual(mixedRows.data.created, 1, 'a valid row still imports beside a rejected row');
    assertEqual(mixedRows.data.failed, 1, 'the rejected row is counted separately');
    assert(db.prepare('SELECT id FROM products WHERE name = ?').get('Valid Beside Failure'), 'valid row persisted beside the failed row');
    assertEqual(db.prepare('SELECT id FROM products WHERE name = ?').get('Rejected Beside Valid'), undefined, 'rejected row did not persist');

    console.log('\n─── Invalid monetary values ───');
    const invalidMoney = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          ',,Negative Price,CSV Category,-1,Description,1,,,,,yes',
          ',,NaN Price,CSV Category,NaN,Description,1,,,,,yes',
          ',,Infinity Price,CSV Category,Infinity,Description,1,,,,,yes',
          ',,Empty Price,CSV Category,,Description,1,,,,,yes',
          ',,Negative Cost,CSV Category,15,Description,-1,,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqual(invalidMoney.data.created, 0, 'invalid monetary rows are not created');
    assertEqual(invalidMoney.data.failed, 5, 'negative, non-finite, and empty money values are counted as failures');
    assert(invalidMoney.data.errors.some((error: string) => error.includes('invalid price "-1"')), 'negative product price is rejected');
    assert(invalidMoney.data.errors.some((error: string) => error.includes('invalid price "NaN"')), 'NaN product price is rejected');
    assert(invalidMoney.data.errors.some((error: string) => error.includes('invalid price "Infinity"')), 'Infinity product price is rejected');
    assert(invalidMoney.data.errors.some((error: string) => error.includes('invalid price ""')), 'empty product price is rejected');
    assert(invalidMoney.data.errors.some((error: string) => error.includes('invalid cost "-1"')), 'negative product cost is rejected');

    const invalidAddonMoney = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: {
        csv: addonCsv(
          'Invalid Money,Negative,-1,no,0,1',
          'Invalid Money,NaN,NaN,no,0,1',
          'Invalid Money,Infinity,Infinity,no,0,1',
          'Invalid Money,Empty,,no,0,1',
        ),
      },
      headers: authHeader,
    });
    assertEqual(invalidAddonMoney.data.addons_created, 0, 'invalid addon monetary rows are not created');
    assertEqual(invalidAddonMoney.data.failed, 4, 'invalid addon monetary rows are counted as failures');
    assert(invalidAddonMoney.data.errors.some((error: string) => error.includes('invalid price "-1"')), 'negative addon price is rejected');
    assert(invalidAddonMoney.data.errors.some((error: string) => error.includes('invalid price "NaN"')), 'NaN addon price is rejected');
    assert(invalidAddonMoney.data.errors.some((error: string) => error.includes('invalid price "Infinity"')), 'Infinity addon price is rejected');
    assert(invalidAddonMoney.data.errors.some((error: string) => error.includes('invalid price ""')), 'empty addon price is rejected');

    console.log('\n─── Reactivation counters ───');
    db.prepare(
      `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, 0, 0, 1, 0, 0, ?, ?)`,
    ).run('group-csv-248-reactivate', 'CSV Reactivation Group', now(), now());
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run('addon-csv-248-reactivate', 'group-csv-248-reactivate', 'CSV Reactivation Addon', 3, now(), now());

    const reactivated = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('CSV Reactivation Group,CSV Reactivation Addon,7.5,no,0,1') },
      headers: authHeader,
    });
    assertEqual(reactivated.status, 200, 'inactive addon records can be reactivated');
    assertEqual(reactivated.data.groups_created, 0, 'reactivated group is not counted as created');
    assertEqual(reactivated.data.addons_created, 0, 'reactivated addon is not counted as created');
    assertEqual(reactivated.data.groups_reactivated, 1, 'reactivated group has its own counter');
    assertEqual(reactivated.data.addons_reactivated, 1, 'reactivated addon has its own counter');
    assertEqual(reactivated.data.reactivated, 2, 'aggregate reactivation counter reports both entities');
    assertEqual(reactivated.data.failed, 0, 'reactivation import has no failures');
    const activeGroup = db.prepare('SELECT is_active FROM addon_groups WHERE id = ?').get('group-csv-248-reactivate') as any;
    const activeAddon = db.prepare('SELECT is_active, price FROM addons WHERE id = ?').get('addon-csv-248-reactivate') as any;
    assertEqual(activeGroup.is_active, 1, 'reactivated group is active');
    assertEqual(activeAddon.is_active, 1, 'reactivated addon is active');
    assertEqual(activeAddon.price, 7.5, 'reactivated addon price is updated');

    const updatedGroup = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('CSV Reactivation Group,Updated Addon,8,yes,0,2') },
      headers: authHeader,
    });
    assertEqual(updatedGroup.data.groups_updated, 1, 'existing group settings are reported as updated');
    const updatedGroupRow = db.prepare('SELECT is_required, max_selection FROM addon_groups WHERE id = ?').get('group-csv-248-reactivate') as any;
    assertEqual(updatedGroupRow.is_required, 1, 'existing group required setting is updated');
    assertEqual(updatedGroupRow.max_selection, 2, 'existing group maximum selection is updated');

    db.prepare(
      `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, 0, 0, 3, 1, 0, ?, ?)`,
    ).run('group-csv-248-partial', 'CSV Partial Bounds Group', now(), now());
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run('addon-csv-248-partial-existing', 'group-csv-248-partial', 'Existing Partial Addon', 2, now(), now());
    const partialBounds = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: {
        csv: addonCsvWithHeader(
          'group_name,addon_name,price,group_min_select',
          'CSV Partial Bounds Group,New Partial Addon,4,2',
        ),
      },
      headers: authHeader,
    });
    assertEqual(partialBounds.status, 200, 'partial group settings use the existing maximum');
    assertEqual(partialBounds.data.addons_created, 1, 'partial group settings allow the valid new addon');
    assertEqual(partialBounds.data.failed, 0, 'partial group settings are not rejected by parser defaults');
    const partialBoundsRow = db.prepare('SELECT min_selection, max_selection FROM addon_groups WHERE id = ?').get('group-csv-248-partial') as any;
    assertEqual(partialBoundsRow.min_selection, 2, 'partial group minimum is updated');
    assertEqual(partialBoundsRow.max_selection, 3, 'omitted group maximum is preserved');

    db.prepare(
      `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, 0, 0, 1, 1, 0, ?, ?)`,
    ).run('group-csv-248-existing-invalid', 'CSV Existing Invalid Bounds', now(), now());
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run('addon-csv-248-existing-invalid', 'group-csv-248-existing-invalid', 'Only Existing Addon', 2, now(), now());
    const existingInvalidBounds = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('CSV Existing Invalid Bounds,Only Existing Addon,5,no,2,2') },
      headers: authHeader,
    });
    assertEqual(existingInvalidBounds.data.failed, 1, 'existing groups reject impossible final selection bounds');
    assert(existingInvalidBounds.data.errors[0].includes('final number of active add-ons'), 'final-count bound error identifies the effective active count');
    const unchangedInvalidGroup = db.prepare('SELECT min_selection, max_selection FROM addon_groups WHERE id = ?').get('group-csv-248-existing-invalid') as any;
    assertEqual(unchangedInvalidGroup.min_selection, 0, 'existing invalid group settings are not mutated');
    assertEqual(unchangedInvalidGroup.max_selection, 1, 'existing invalid group maximum is not mutated');

    const invalidBounds = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('Invalid Bounds,Impossible,1,no,2,1') },
      headers: authHeader,
    });
    assertEqual(invalidBounds.data.failed, 1, 'invalid group selection bounds are rejected');
    assert(invalidBounds.data.errors[0].includes('must not exceed'), 'selection-bound error identifies the invalid relationship');
    assertEqual(db.prepare('SELECT COUNT(*) AS count FROM addon_groups WHERE name = ?').get('Invalid Bounds').count, 0, 'invalid group bounds do not create a group');

    const skippedActive = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('CSV Reactivation Group,CSV Reactivation Addon,8,no,0,1') },
      headers: authHeader,
    });
    assertEqual(skippedActive.data.groups_reactivated, 0, 'active group is not reported as reactivated');
    assertEqual(skippedActive.data.addons_reactivated, 0, 'active addon is not reported as reactivated');
    assertEqual(skippedActive.data.skipped, 1, 'active duplicate addon is skipped');

    console.log('\n─── CSV resource bounds ───');
    const tooManyCells = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: { csv: 'name,' + Array.from({ length: 64 }, () => 'extra').join(',') + '\nBounded' },
      headers: authHeader,
    });
    assertEqual(tooManyCells.status, 400, 'rows over the cell bound are rejected');
    assert(tooManyCells.data.error.includes('cell'), 'cell-bound error identifies the resource limit');

    const tooLongCell = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: { csv: 'name\n' + 'x'.repeat(10_001) },
      headers: authHeader,
    });
    assertEqual(tooLongCell.status, 400, 'cells over the value bound are rejected');
    assert(tooLongCell.data.error.includes('length'), 'value-bound error identifies the resource limit');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(58));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
