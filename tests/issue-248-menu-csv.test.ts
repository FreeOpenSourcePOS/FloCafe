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
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { menuCsvRoutes } = require('../main/routes/menu-csv');
const { validateInventoryLedgerDatabase } = require('../main/db');

const PRODUCT_HEADER =
  'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active';
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

async function fetchText(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string>,
): Promise<string> {
  const response = await (globalThis as any).fetch(baseUrl + urlPath, { headers });
  return await response.text();
}

/** Finds the exported CSV record for a group/add-on pair and returns its cells. */
function exportedRecord(csv: string, groupName: string, addonName: string): string[] | null {
  const prefix = `${groupName},${addonName},`;
  const line = csv.split('\n').find((candidate: string) => candidate.startsWith(prefix));
  return line === undefined ? null : line.split(',');
}

async function main() {
  console.log('Integration Test: Issue #248 strict catalog CSV imports');
  console.log('='.repeat(58));

  const db = initTestDb();
  const { authHeader, userId } = seedOwnerUser(db);
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
          ',,"CRLF Product","CSV Category",12,"line1\r\nline2",1,,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqual(quoted.status, 200, 'valid quoted product CSV is accepted');
    assertEqual(quoted.data.created, 3, 'quoted products are created');
    assertEqual(quoted.data.failed, 0, 'valid quoted row is not failed');
    const quotedProduct = db
      .prepare('SELECT price, cost, description, tags FROM products WHERE name = ?')
      .get('Quoted, Coffee') as any;
    assertEqual(quotedProduct.price, 12.5, 'quoted product price is parsed completely');
    assertEqual(quotedProduct.cost, 3.25, 'quoted product cost is parsed completely');
    assertEqual(
      quotedProduct.description,
      'He said "hot",\nthen served',
      'quoted commas, quotes, and newlines are preserved',
    );
    assertEqual(
      quotedProduct.tags,
      JSON.stringify(['coffee', 'featured']),
      'quoted comma-separated tags are preserved',
    );
    const carriageReturnProduct = db
      .prepare('SELECT description FROM products WHERE name = ?')
      .get('CR Product') as any;
    assertEqual(
      carriageReturnProduct.description,
      'line1\rline2',
      'quoted carriage returns are preserved',
    );
    const carriageReturnLineFeedProduct = db
      .prepare('SELECT description FROM products WHERE name = ?')
      .get('CRLF Product') as any;
    assertEqual(
      carriageReturnLineFeedProduct.description,
      'line1\r\nline2',
      'quoted CRLF sequences are preserved exactly',
    );

    const malformedPostQuote = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(',,"Malformed" ,"CSV Category",10,Description,1,,,,,yes'),
      },
      headers: authHeader,
    });
    assertEqual(malformedPostQuote.status, 400, 'spaces after a closing CSV quote are rejected');
    assert(
      malformedPostQuote.data.error.includes('after closing quote'),
      'post-quote whitespace error identifies the malformed record',
    );
    assertEqual(
      db.prepare('SELECT id FROM products WHERE name = ?').get('Malformed'),
      undefined,
      'malformed post-quote row is not persisted',
    );

    console.log('\n─── Unterminated quoted row rolls back the import ───');
    const beforeMalformedCount = (db.prepare('SELECT COUNT(*) AS count FROM products').get() as any)
      .count;
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
    assert(
      malformed.data.error.includes('unterminated'),
      'unterminated CSV error explains the malformed quote',
    );
    const afterMalformedCount = (db.prepare('SELECT COUNT(*) AS count FROM products').get() as any)
      .count;
    assertEqual(
      afterMalformedCount,
      beforeMalformedCount,
      'malformed CSV does not partially import earlier rows',
    );
    const rolledBackProduct = db
      .prepare('SELECT id FROM products WHERE name = ?')
      .get('Should Roll Back');
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
    assertEqual(
      partialNumbers.status,
      200,
      'partial numeric rows return row-level validation results',
    );
    assertEqual(partialNumbers.data.created, 0, 'partial numeric rows are not created');
    assertEqual(partialNumbers.data.failed, 2, 'each partial numeric row is counted as failed');
    assert(
      partialNumbers.data.errors.some((error: string) => error.includes('invalid price "12abc"')),
      'partial price token is rejected',
    );
    assert(
      partialNumbers.data.errors.some((error: string) => error.includes('invalid cost "5xyz"')),
      'partial cost token is rejected',
    );

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
    assert(
      db.prepare('SELECT id FROM products WHERE name = ?').get('Valid Beside Failure'),
      'valid row persisted beside the failed row',
    );
    assertEqual(
      db.prepare('SELECT id FROM products WHERE name = ?').get('Rejected Beside Valid'),
      undefined,
      'rejected row did not persist',
    );

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
    assertEqual(
      invalidMoney.data.failed,
      5,
      'negative, non-finite, and empty money values are counted as failures',
    );
    assert(
      invalidMoney.data.errors.some((error: string) => error.includes('invalid price "-1"')),
      'negative product price is rejected',
    );
    assert(
      invalidMoney.data.errors.some((error: string) => error.includes('invalid price "NaN"')),
      'NaN product price is rejected',
    );
    assert(
      invalidMoney.data.errors.some((error: string) => error.includes('invalid price "Infinity"')),
      'Infinity product price is rejected',
    );
    assert(
      invalidMoney.data.errors.some((error: string) => error.includes('invalid price ""')),
      'empty product price is rejected',
    );
    assert(
      invalidMoney.data.errors.some((error: string) => error.includes('invalid cost "-1"')),
      'negative product cost is rejected',
    );

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
    assertEqual(
      invalidAddonMoney.data.addons_created,
      0,
      'invalid addon monetary rows are not created',
    );
    assertEqual(
      invalidAddonMoney.data.failed,
      4,
      'invalid addon monetary rows are counted as failures',
    );
    assert(
      invalidAddonMoney.data.errors.some((error: string) => error.includes('invalid price "-1"')),
      'negative addon price is rejected',
    );
    assert(
      invalidAddonMoney.data.errors.some((error: string) => error.includes('invalid price "NaN"')),
      'NaN addon price is rejected',
    );
    assert(
      invalidAddonMoney.data.errors.some((error: string) =>
        error.includes('invalid price "Infinity"'),
      ),
      'Infinity addon price is rejected',
    );
    assert(
      invalidAddonMoney.data.errors.some((error: string) => error.includes('invalid price ""')),
      'empty addon price is rejected',
    );

    console.log('\n─── Reactivation counters ───');
    db.prepare(
      `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, 0, 0, 1, 0, 0, ?, ?)`,
    ).run('group-csv-248-reactivate', 'CSV Reactivation Group', now(), now());
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    ).run(
      'addon-csv-248-reactivate',
      'group-csv-248-reactivate',
      'CSV Reactivation Addon',
      3,
      now(),
      now(),
    );

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
    assertEqual(
      reactivated.data.reactivated,
      2,
      'aggregate reactivation counter reports both entities',
    );
    assertEqual(reactivated.data.failed, 0, 'reactivation import has no failures');
    const activeGroup = db
      .prepare('SELECT is_active FROM addon_groups WHERE id = ?')
      .get('group-csv-248-reactivate') as any;
    const activeAddon = db
      .prepare('SELECT is_active, price FROM addons WHERE id = ?')
      .get('addon-csv-248-reactivate') as any;
    assertEqual(activeGroup.is_active, 1, 'reactivated group is active');
    assertEqual(activeAddon.is_active, 1, 'reactivated addon is active');
    assertEqual(activeAddon.price, 7.5, 'reactivated addon price is updated');

    const updatedGroup = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('CSV Reactivation Group,Updated Addon,8,yes,0,2') },
      headers: authHeader,
    });
    assertEqual(
      updatedGroup.data.groups_updated,
      1,
      'existing group settings are reported as updated',
    );
    const updatedGroupRow = db
      .prepare('SELECT is_required, max_selection FROM addon_groups WHERE id = ?')
      .get('group-csv-248-reactivate') as any;
    assertEqual(updatedGroupRow.is_required, 1, 'existing group required setting is updated');
    assertEqual(updatedGroupRow.max_selection, 2, 'existing group maximum selection is updated');

    db.prepare(
      `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, 0, 0, 3, 1, 0, ?, ?)`,
    ).run('group-csv-248-partial', 'CSV Partial Bounds Group', now(), now());
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      'addon-csv-248-partial-existing',
      'group-csv-248-partial',
      'Existing Partial Addon',
      2,
      now(),
      now(),
    );
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
    assertEqual(
      partialBounds.data.addons_created,
      1,
      'partial group settings allow the valid new addon',
    );
    assertEqual(
      partialBounds.data.failed,
      0,
      'partial group settings are not rejected by parser defaults',
    );
    const partialBoundsRow = db
      .prepare('SELECT min_selection, max_selection FROM addon_groups WHERE id = ?')
      .get('group-csv-248-partial') as any;
    assertEqual(partialBoundsRow.min_selection, 2, 'partial group minimum is updated');
    assertEqual(partialBoundsRow.max_selection, 3, 'omitted group maximum is preserved');

    db.prepare(
      `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, 0, 0, 1, 1, 0, ?, ?)`,
    ).run('group-csv-248-existing-invalid', 'CSV Existing Invalid Bounds', now(), now());
    db.prepare(
      `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(
      'addon-csv-248-existing-invalid',
      'group-csv-248-existing-invalid',
      'Only Existing Addon',
      2,
      now(),
      now(),
    );
    const existingInvalidBounds = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('CSV Existing Invalid Bounds,Only Existing Addon,5,no,2,2') },
      headers: authHeader,
    });
    assertEqual(
      existingInvalidBounds.data.failed,
      1,
      'existing groups reject impossible final selection bounds',
    );
    assert(
      existingInvalidBounds.data.errors[0].includes('final number of active add-ons'),
      'final-count bound error identifies the effective active count',
    );
    const unchangedInvalidGroup = db
      .prepare('SELECT min_selection, max_selection FROM addon_groups WHERE id = ?')
      .get('group-csv-248-existing-invalid') as any;
    assertEqual(
      unchangedInvalidGroup.min_selection,
      0,
      'existing invalid group settings are not mutated',
    );
    assertEqual(
      unchangedInvalidGroup.max_selection,
      1,
      'existing invalid group maximum is not mutated',
    );

    const invalidBounds = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('Invalid Bounds,Impossible,1,no,2,1') },
      headers: authHeader,
    });
    assertEqual(invalidBounds.data.failed, 1, 'invalid group selection bounds are rejected');
    assert(
      invalidBounds.data.errors[0].includes('must not exceed'),
      'selection-bound error identifies the invalid relationship',
    );
    assertEqual(
      db.prepare('SELECT COUNT(*) AS count FROM addon_groups WHERE name = ?').get('Invalid Bounds')
        .count,
      0,
      'invalid group bounds do not create a group',
    );

    const skippedActive = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('CSV Reactivation Group,CSV Reactivation Addon,8,no,0,1') },
      headers: authHeader,
    });
    assertEqual(
      skippedActive.data.groups_reactivated,
      0,
      'active group is not reported as reactivated',
    );
    assertEqual(
      skippedActive.data.addons_reactivated,
      0,
      'active addon is not reported as reactivated',
    );
    assertEqual(skippedActive.data.skipped, 1, 'active duplicate addon is skipped');

    console.log('\n─── Add-on inventory columns: legacy sheets stay importable ───');
    // A spreadsheet exported before add-on stock existed must still import, and
    // must land untracked: a file that never mentioned stock must not invent a
    // stock pool a merchant never counted.
    const legacyImport = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('Legacy Sheet Group,Legacy Sheet Addon,9,no,0,1') },
      headers: authHeader,
    });
    assertEqualOrThrow(legacyImport.status, 200, 'a pre-inventory add-on CSV still imports');
    assertEqualOrThrow(legacyImport.data.addons_created, 1, 'the legacy add-on row is created');
    assertEqualOrThrow(
      legacyImport.data.failed,
      0,
      'the legacy add-on row is not reported as failed',
    );
    const legacyRow = db
      .prepare('SELECT track_inventory, stock_quantity FROM addons WHERE name = ?')
      .get('Legacy Sheet Addon') as any;
    assertEqualOrThrow(
      legacyRow.track_inventory,
      0,
      'a CSV without the inventory columns defaults to untracked',
    );
    assertEqualOrThrow(
      legacyRow.stock_quantity,
      0,
      'a CSV without the inventory columns defaults to zero stock',
    );

    console.log('\n─── Add-on inventory columns: stock lands as a ledger movement ───');
    const trackedImport = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: {
        csv: addonCsvWithHeader(
          `${ADDON_HEADER},track_inventory,stock_quantity`,
          'Stock Group,Tracked Addon,12,no,0,1,yes,50',
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(trackedImport.status, 200, 'an add-on CSV carrying stock columns imports');
    assertEqualOrThrow(trackedImport.data.addons_created, 1, 'the tracked add-on row is created');
    assertEqualOrThrow(
      trackedImport.data.failed,
      0,
      'the tracked add-on row is not reported as failed',
    );
    const trackedRow = db
      .prepare('SELECT id, track_inventory, stock_quantity FROM addons WHERE name = ?')
      .get('Tracked Addon') as any;
    assertEqualOrThrow(trackedRow.track_inventory, 1, 'track_inventory imports as tracked');
    assertEqualOrThrow(trackedRow.stock_quantity, 50, 'stock_quantity imports onto the new add-on');

    // The decisive assertion for a catalog write: stock must not land as a bare
    // column update. It has to arrive as a movement the restore validator can
    // reconcile, attributed to the operator who ran the import.
    const openingMovement = db
      .prepare(
        `SELECT quantity_delta, movement_type, reference_type, actor_user_id, stock_after, product_id
       FROM inventory_movements WHERE addon_id = ?`,
      )
      .get(trackedRow.id) as any;
    assertEqualOrThrow(
      openingMovement.quantity_delta,
      50,
      'the imported stock is recorded as a movement delta',
    );
    assertEqualOrThrow(
      openingMovement.movement_type,
      'adjustment',
      'the imported stock is an adjustment movement',
    );
    assertEqualOrThrow(
      openingMovement.reference_type,
      'opening_balance',
      'a newly created add-on opens its balance',
    );
    assertEqualOrThrow(
      openingMovement.stock_after,
      50,
      'the movement records the imported stock level',
    );
    assertEqualOrThrow(
      openingMovement.actor_user_id,
      userId,
      'the movement is attributed to the importing operator',
    );
    assertEqualOrThrow(openingMovement.product_id, null, 'an add-on movement names no product');
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'imported add-on stock reconciles with its movement history',
    );

    const invalidStock = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: {
        csv: addonCsvWithHeader(
          `${ADDON_HEADER},track_inventory,stock_quantity`,
          'Stock Group,Negative Stock,5,no,0,1,yes,-3',
          'Stock Group,Text Stock,5,no,0,1,yes,lots',
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(
      invalidStock.data.failed,
      2,
      'negative and non-numeric stock are counted as failures',
    );
    assert(
      invalidStock.data.errors.some((error: string) =>
        error.includes('invalid stock_quantity "-3"'),
      ),
      'negative add-on stock is rejected',
    );
    assert(
      invalidStock.data.errors.some((error: string) =>
        error.includes('invalid stock_quantity "lots"'),
      ),
      'non-numeric add-on stock is rejected',
    );
    assertEqualOrThrow(
      db.prepare('SELECT id FROM addons WHERE name = ?').get('Negative Stock'),
      undefined,
      'a row rejected for stock is not persisted',
    );

    console.log('\n─── Add-on inventory columns: a legacy sheet never strips a stock pool ───');
    db.prepare('UPDATE addons SET is_active = 0 WHERE id = ?').run(trackedRow.id);
    const legacyReactivate = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: { csv: addonCsv('Stock Group,Tracked Addon,12,no,0,1') },
      headers: authHeader,
    });
    assertEqualOrThrow(
      legacyReactivate.data.addons_reactivated,
      1,
      'the deactivated tracked add-on reactivates',
    );
    const reactivatedRow = db
      .prepare('SELECT track_inventory, stock_quantity FROM addons WHERE id = ?')
      .get(trackedRow.id) as any;
    assertEqualOrThrow(
      reactivatedRow.track_inventory,
      1,
      'a legacy reactivation preserves existing tracking',
    );
    assertEqualOrThrow(
      reactivatedRow.stock_quantity,
      50,
      'a legacy reactivation preserves existing stock',
    );
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'a legacy reactivation leaves the add-on ledger reconcilable',
    );

    console.log('\n─── Add-on inventory columns: export and round trip ───');
    const exported = await fetchText(baseUrl, '/api/menu/csv/export/addons', authHeader);
    const exportHeader = exported.split('\n')[0];
    assertIncludesOrThrow(
      exportHeader,
      'track_inventory',
      'the add-on export carries a track_inventory column',
    );
    assertIncludesOrThrow(
      exportHeader,
      'stock_quantity',
      'the add-on export carries a stock_quantity column',
    );
    assertIncludesOrThrow(
      exportHeader,
      'low_stock_threshold',
      'the add-on export carries a low_stock_threshold column',
    );
    const exportedTracked = exportedRecord(exported, 'Stock Group', 'Tracked Addon');
    assertEqualOrThrow(
      exportedTracked === null ? null : exportedTracked[6],
      'yes',
      'the export marks a tracked add-on as tracked',
    );
    assertEqualOrThrow(
      exportedTracked === null ? null : exportedTracked[7],
      '50',
      'the export carries the add-on stock level',
    );
    assertEqualOrThrow(
      exportedTracked === null ? null : exportedTracked[8],
      '0',
      'the export carries the default low stock threshold',
    );
    const exportedLegacy = exportedRecord(exported, 'Legacy Sheet Group', 'Legacy Sheet Addon');
    assertEqualOrThrow(
      exportedLegacy === null ? null : exportedLegacy[6],
      'no',
      'the export marks an untracked add-on as untracked',
    );
    assertEqualOrThrow(
      exportedLegacy === null ? null : exportedLegacy[7],
      '0',
      'the export carries zero stock for an untracked add-on',
    );
    assertEqualOrThrow(
      exportedLegacy === null ? null : exportedLegacy[8],
      '0',
      'the export carries zero threshold for an untracked add-on',
    );

    // Round trip: the exported header is the new format, so re-importing it must
    // rebuild the same stock pool on a fresh add-on rather than losing it.
    const roundTrip = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: {
        csv: [exportHeader, 'Round Trip Group,Round Trip Addon,12,no,0,1,yes,50,5'].join('\n'),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(
      roundTrip.data.addons_created,
      1,
      'an exported-format row re-imports as a new add-on',
    );
    const roundTripRow = db
      .prepare(
        'SELECT id, track_inventory, stock_quantity, low_stock_threshold FROM addons WHERE name = ?',
      )
      .get('Round Trip Addon') as any;
    assertEqualOrThrow(roundTripRow.track_inventory, 1, 'the round trip preserves tracking');
    assertEqualOrThrow(roundTripRow.stock_quantity, 50, 'the round trip preserves stock');
    assertEqualOrThrow(
      roundTripRow.low_stock_threshold,
      5,
      'the round trip preserves low stock threshold',
    );
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'a round-tripped add-on reconciles with its movement history',
    );

    console.log('\n─── Unrecognized product ID fallback and round trip ───');
    const existingProdId = 'prod-exist-1';
    db.prepare(
      `INSERT INTO products (id, name, category_id, price, description, cost, tax_type, tax_rate,
       cb_percent, tags, is_active, sku, sort_order, created_at, updated_at)
       VALUES (?, 'Existing Coffee', 'cat-csv-248', 10, 'Existing desc', 4, 'none', 0, NULL, NULL, 1, 'SKU-EXIST', 0, ?, ?)`,
    ).run(existingProdId, now(), now());

    const importWithIds = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          `${existingProdId},SKU-EXIST,Existing Coffee,CSV Category,15,Updated desc,5,,,,,yes`,
          'unrecognized-external-id,SKU-NEW,New Fallback Product,CSV Category,20,Fallback desc,8,,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(
      importWithIds.status,
      200,
      'import with existing and unrecognized IDs succeeds',
    );
    assertEqualOrThrow(importWithIds.data.updated, 1, 'existing ID updates the product');
    assertEqualOrThrow(
      importWithIds.data.created,
      1,
      'unrecognized ID falls through to create the product',
    );
    assertEqualOrThrow(importWithIds.data.failed, 0, 'unrecognized ID is not failed');

    const updatedRow = db
      .prepare('SELECT price, description, cost FROM products WHERE id = ?')
      .get(existingProdId) as any;
    assertEqualOrThrow(updatedRow.price, 15, 'existing product price is updated');
    assertEqualOrThrow(
      updatedRow.description,
      'Updated desc',
      'existing product description is updated',
    );

    const createdRow = db
      .prepare('SELECT id, name, price, sku FROM products WHERE name = ?')
      .get('New Fallback Product') as any;
    assertEqualOrThrow(
      createdRow !== undefined,
      true,
      'fallback product is inserted into database',
    );
    assertEqualOrThrow(createdRow.sku, 'SKU-NEW', 'fallback product preserves sku');
    assertEqualOrThrow(
      createdRow.id !== 'unrecognized-external-id',
      true,
      'fallback product receives a generated short id',
    );

    const duplicateImport = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          'unrecognized-external-id,SKU-NEW,New Fallback Product,CSV Category,20,Fallback desc,8,,,,,yes',
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(duplicateImport.status, 200, 'duplicate re-import succeeds');
    assertEqualOrThrow(
      duplicateImport.data.skipped,
      1,
      'duplicate product by name and category is skipped',
    );
    assertEqualOrThrow(duplicateImport.data.created, 0, 'no duplicate product is created');

    console.log('\n─── CSV resource bounds ───');
    const tooManyCells = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: { csv: 'name,' + Array.from({ length: 64 }, () => 'extra').join(',') + '\nBounded' },
      headers: authHeader,
    });
    assertEqual(tooManyCells.status, 400, 'rows over the cell bound are rejected');
    assert(
      tooManyCells.data.error.includes('cell'),
      'cell-bound error identifies the resource limit',
    );

    const tooLongCell = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: { csv: 'name\n' + 'x'.repeat(10_001) },
      headers: authHeader,
    });
    assertEqual(tooLongCell.status, 400, 'cells over the value bound are rejected');
    assert(
      tooLongCell.data.error.includes('length'),
      'value-bound error identifies the resource limit',
    );

    console.log('\n─── Multi-cycle quote-v1 export/import round trips ───');
    const roundTripCategories = [
      { id: 'cat-rt-eq', name: '=Equals Category', desc: '-Minus description', color: 'blue', icon: '☕', sort: 10 },
      { id: 'cat-rt-plus', name: '+Plus, Category', desc: '@At description,\nwith newline', color: 'green', icon: '🍔', sort: 11 },
      { id: 'cat-rt-minus', name: '-Minus Category', desc: '=Formula desc', color: 'pink', icon: '🍰', sort: 12 },
      { id: 'cat-rt-at', name: '@At Category', desc: '+Plus desc', color: 'amber', icon: '🎁', sort: 13 },
      { id: 'cat-rt-ws', name: ' =Space Formula Category', desc: '\t+Tab Formula Desc', color: 'blue', icon: '☕', sort: 14 },
      { id: 'cat-rt-quote', name: "'Chef's Category", desc: "'Genuine quote, \"quoted\"\r\ndesc", color: 'green', icon: '🍔', sort: 15 },
      { id: 'cat-rt-qformula', name: "'+Quoted Formula Category", desc: "''Double Quoted Desc", color: 'pink', icon: '🍰', sort: 16 },
    ];
    for (const c of roundTripCategories) {
      db.prepare(
        `INSERT INTO categories (id, name, slug, description, color, icon, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(c.id, c.name, c.id, c.desc, c.color, c.icon, c.sort, now(), now());
    }

    const roundTripProducts = [
      { id: 'prod-rt-eq', catId: 'cat-rt-eq', sku: '=SKU-EQ', name: '=Combo Deal', price: 11, desc: '+Rich, "bold"\nflavor', cost: 4, tags: ['=tag-eq', 'featured'] },
      { id: 'prod-rt-plus', catId: 'cat-rt-plus', sku: '+SKU-PLUS', name: '+Special Curry, Large', price: 14.5, desc: '-Spiced\r\ncurry', cost: 5, tags: ['+tag-plus'] },
      { id: 'prod-rt-minus', catId: 'cat-rt-minus', sku: '-SKU-MINUS', name: '-Discount Tea', price: 6, desc: '@Tea note', cost: 2, tags: ['-tag-minus'] },
      { id: 'prod-rt-at', catId: 'cat-rt-at', sku: '@SKU-AT', name: '@House Special', price: 18, desc: '=House note', cost: 7, tags: ['@tag-at'] },
      { id: 'prod-rt-ws-space', catId: 'cat-rt-ws', sku: ' +SKU-SPACE', name: ' =Space Formula Roast', price: 9, desc: ' -Space desc', cost: 3, tags: ['veg'] },
      { id: 'prod-rt-ws-tab', catId: 'cat-rt-ws', sku: '\t@SKU-TAB', name: '\t+Tab Formula Espresso', price: 9.5, desc: '\n=Newline Formula Desc', cost: 3, tags: ['veg'] },
      { id: 'prod-rt-quote', catId: 'cat-rt-quote', sku: "'SKU-QUOTE", name: "'Chef's Signature, \"Hot\"\nBurger", price: 21, desc: "'Authentic recipe", cost: 8, tags: ["'chef-tag"] },
      { id: 'prod-rt-qformula', catId: 'cat-rt-qformula', sku: "'+SKU-QF", name: "'+Literal Escaped Plus", price: 16, desc: "''Double Apostrophe Note", cost: 6, tags: ["'+literal-tag"] },
      { id: 'prod-rt-qws', catId: 'cat-rt-qformula', sku: "' =SKU-QWS", name: "' =Literal Space Formula", price: 17, desc: "''@Double Quote At", cost: 6, tags: ['veg'] },
    ];
    for (const p of roundTripProducts) {
      db.prepare(
        `INSERT INTO products (id, name, category_id, price, description, cost, tax_type, tax_rate,
         cb_percent, tags, is_active, sku, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'none', 0, NULL, ?, 1, ?, 0, ?, ?)`,
      ).run(p.id, p.name, p.catId, p.price, p.desc, p.cost, JSON.stringify(p.tags), p.sku, now(), now());
    }

    const roundTripAddons = [
      { groupId: 'ag-rt-eq', groupName: '=Formula Group', addonId: 'ad-rt-plus', addonName: '+Extra Spice, Hot', price: 2 },
      { groupId: 'ag-rt-minus', groupName: '-Minus Group', addonId: 'ad-rt-at', addonName: '@House Drizzle', price: 3 },
      { groupId: 'ag-rt-ws', groupName: ' =Space Group', addonId: 'ad-rt-ws', addonName: '\t+Tab Addon', price: 1.5 },
      { groupId: 'ag-rt-quote', groupName: "'Chef's Addons", addonId: 'ad-rt-quote', addonName: "'Artisan Cheese", price: 4 },
      { groupId: 'ag-rt-qf', groupName: "'+Quoted Formula Group", addonId: 'ad-rt-qf', addonName: "''Double Apostrophe Addon", price: 2.5 },
    ];
    for (const a of roundTripAddons) {
      db.prepare(
        `INSERT INTO addon_groups (id, name, is_required, min_selection, max_selection, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, 0, 0, 1, 1, 0, ?, ?)`,
      ).run(a.groupId, a.groupName, now(), now());
      db.prepare(
        `INSERT INTO addons (id, addon_group_id, name, price, is_active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
      ).run(a.addonId, a.groupId, a.addonName, a.price, now(), now());
    }
    db.prepare(
      `INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?), (?, ?)`,
    ).run('prod-rt-plus', 'ag-rt-eq', 'prod-rt-quote', 'ag-rt-quote');

    const initialCatCount = (db.prepare('SELECT COUNT(*) AS count FROM categories WHERE deleted_at IS NULL').get() as any).count;
    const initialProdCount = (db.prepare('SELECT COUNT(*) AS count FROM products WHERE deleted_at IS NULL').get() as any).count;
    const initialGroupCount = (db.prepare('SELECT COUNT(*) AS count FROM addon_groups').get() as any).count;
    const initialAddonCount = (db.prepare('SELECT COUNT(*) AS count FROM addons').get() as any).count;

    for (let cycle = 1; cycle <= 3; cycle++) {
      const catExportCsv = await fetchText(baseUrl, '/api/menu/csv/export/categories', authHeader);
      const prodExportCsv = await fetchText(baseUrl, '/api/menu/csv/export/products', authHeader);
      const addonExportCsv = await fetchText(baseUrl, '/api/menu/csv/export/addons', authHeader);

      assertIncludesOrThrow(
        catExportCsv.split('\n')[0],
        'flo_csv_encoding',
        `cycle ${cycle}: categories export header includes flo_csv_encoding`,
      );
      assertIncludesOrThrow(
        prodExportCsv.split('\n')[0],
        'flo_csv_encoding',
        `cycle ${cycle}: products export header includes flo_csv_encoding`,
      );
      assertIncludesOrThrow(
        addonExportCsv.split('\n')[0],
        'flo_csv_encoding',
        `cycle ${cycle}: addons export header includes flo_csv_encoding`,
      );

      const catImportRes = await api(baseUrl, '/api/menu/csv/import/categories', {
        method: 'POST',
        body: { csv: catExportCsv },
        headers: authHeader,
      });
      assertEqualOrThrow(catImportRes.status, 200, `cycle ${cycle}: categories re-import succeeds`);
      assertEqualOrThrow(catImportRes.data.created, 0, `cycle ${cycle}: categories re-import creates no duplicates`);
      assertEqualOrThrow(catImportRes.data.failed, 0, `cycle ${cycle}: categories re-import has no failures`);

      const prodImportRes = await api(baseUrl, '/api/menu/csv/import/products', {
        method: 'POST',
        body: { csv: prodExportCsv },
        headers: authHeader,
      });
      assertEqualOrThrow(prodImportRes.status, 200, `cycle ${cycle}: products re-import succeeds`);
      assertEqualOrThrow(prodImportRes.data.created, 0, `cycle ${cycle}: products re-import creates no duplicates`);
      assertEqualOrThrow(prodImportRes.data.failed, 0, `cycle ${cycle}: products re-import has no failures`);

      const addonImportRes = await api(baseUrl, '/api/menu/csv/import/addons', {
        method: 'POST',
        body: { csv: addonExportCsv },
        headers: authHeader,
      });
      assertEqualOrThrow(addonImportRes.status, 200, `cycle ${cycle}: addons re-import succeeds`);
      assertEqualOrThrow(addonImportRes.data.groups_created, 0, `cycle ${cycle}: addons re-import creates no duplicate groups`);
      assertEqualOrThrow(addonImportRes.data.addons_created, 0, `cycle ${cycle}: addons re-import creates no duplicate addons`);
      assertEqualOrThrow(addonImportRes.data.failed, 0, `cycle ${cycle}: addons re-import has no failures`);
    }

    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM categories WHERE deleted_at IS NULL').get() as any).count,
      initialCatCount,
      'category count is unchanged after 3 export/import cycles',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM products WHERE deleted_at IS NULL').get() as any).count,
      initialProdCount,
      'product count is unchanged after 3 export/import cycles',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM addon_groups').get() as any).count,
      initialGroupCount,
      'addon_group count is unchanged after 3 export/import cycles',
    );
    assertEqualOrThrow(
      (db.prepare('SELECT COUNT(*) AS count FROM addons').get() as any).count,
      initialAddonCount,
      'addon count is unchanged after 3 export/import cycles',
    );

    for (const c of roundTripCategories) {
      const row = db.prepare('SELECT name, description FROM categories WHERE id = ?').get(c.id) as any;
      assertEqualOrThrow(row.name, c.name, `category ${c.id} name is preserved across round trips`);
      assertEqualOrThrow(row.description, c.desc, `category ${c.id} description is preserved across round trips`);
    }

    for (const p of roundTripProducts) {
      const row = db
        .prepare('SELECT name, sku, description, category_id, tags FROM products WHERE id = ?')
        .get(p.id) as any;
      assertEqualOrThrow(row.name, p.name, `product ${p.id} name is preserved across round trips`);
      assertEqualOrThrow(row.sku, p.sku, `product ${p.id} sku is preserved across round trips`);
      assertEqualOrThrow(row.description, p.desc, `product ${p.id} description is preserved across round trips`);
      assertEqualOrThrow(row.category_id, p.catId, `product ${p.id} category_id association is preserved`);
      assertEqualOrThrow(row.tags, JSON.stringify(p.tags), `product ${p.id} tags are preserved across round trips`);
    }

    for (const a of roundTripAddons) {
      const groupRow = db.prepare('SELECT name FROM addon_groups WHERE id = ?').get(a.groupId) as any;
      const addonRow = db.prepare('SELECT name, addon_group_id FROM addons WHERE id = ?').get(a.addonId) as any;
      assertEqualOrThrow(groupRow.name, a.groupName, `addon group ${a.groupId} name is preserved`);
      assertEqualOrThrow(addonRow.name, a.addonName, `addon ${a.addonId} name is preserved`);
      assertEqualOrThrow(addonRow.addon_group_id, a.groupId, `addon ${a.addonId} group association is preserved`);
    }

    const preservedLinks = db
      .prepare('SELECT COUNT(*) AS count FROM addon_group_product WHERE (product_id = ? AND addon_group_id = ?) OR (product_id = ? AND addon_group_id = ?)')
      .get('prod-rt-plus', 'ag-rt-eq', 'prod-rt-quote', 'ag-rt-quote') as any;
    assertEqualOrThrow(preservedLinks.count, 2, 'product-to-addon-group associations remain stable');

    console.log('\n─── Unmarked legacy imports: decode only when proven by stable ID ───');
    // 1. Existing product with formula-leading fields: unmarked legacy import with matching ID decodes proven fields.
    const legacyProvenProductImport = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          `prod-rt-plus,'+SKU-PLUS,"'+Special Curry, Large","'+Plus, Category",19,"'-Spiced\r\ncurry",5,,,,'+tag-plus,yes`,
          `prod-rt-ws-space,' +SKU-SPACE,' =Space Formula Roast,' =Space Formula Category,11,' -Space desc,3,,,,veg,yes`,
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(legacyProvenProductImport.status, 200, 'unmarked legacy product import with proven IDs succeeds');
    assertEqualOrThrow(legacyProvenProductImport.data.updated, 2, 'proven legacy product rows update existing records');
    assertEqualOrThrow(legacyProvenProductImport.data.failed, 0, 'proven legacy product rows do not fail');
    const provenPlusProd = db
      .prepare('SELECT name, sku, description, price, category_id, tags FROM products WHERE id = ?')
      .get('prod-rt-plus') as any;
    assertEqualOrThrow(provenPlusProd.name, '+Special Curry, Large', 'proven legacy product name is decoded');
    assertEqualOrThrow(provenPlusProd.sku, '+SKU-PLUS', 'proven legacy product sku is decoded');
    assertEqualOrThrow(provenPlusProd.description, '-Spiced\r\ncurry', 'proven legacy product description is decoded');
    assertEqualOrThrow(provenPlusProd.price, 19, 'proven legacy product price is updated');
    assertEqualOrThrow(provenPlusProd.category_id, 'cat-rt-plus', 'proven legacy product category association is preserved');
    assertEqualOrThrow(provenPlusProd.tags, JSON.stringify(['+tag-plus']), 'proven legacy product tags are decoded');

    const provenSpaceProd = db
      .prepare('SELECT name, sku, description FROM products WHERE id = ?')
      .get('prod-rt-ws-space') as any;
    assertEqualOrThrow(provenSpaceProd.name, ' =Space Formula Roast', 'proven legacy whitespace-formula product name is decoded');
    assertEqualOrThrow(provenSpaceProd.sku, ' +SKU-SPACE', 'proven legacy whitespace-formula product sku is decoded');
    assertEqualOrThrow(provenSpaceProd.description, ' -Space desc', 'proven legacy whitespace-formula product description is decoded');

    // 2. Existing product whose stored name already begins with an apostrophe (ambiguous record): must NOT be renamed!
    const legacyAmbiguousExistingProd = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          `prod-rt-qformula,'+SKU-QF,'+Literal Escaped Plus,'+Quoted Formula Category,22,''Double Apostrophe Note,6,,,,'+literal-tag,yes`,
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(legacyAmbiguousExistingProd.status, 200, 'unmarked import of existing ambiguous product succeeds');
    assertEqualOrThrow(legacyAmbiguousExistingProd.data.updated, 1, 'existing ambiguous product is updated');
    const ambiguousProdRow = db
      .prepare('SELECT name, sku, price FROM products WHERE id = ?')
      .get('prod-rt-qformula') as any;
    assertEqualOrThrow(
      ambiguousProdRow.name,
      "'+Literal Escaped Plus",
      'existing ambiguous product name is not stripped or renamed',
    );
    assertEqualOrThrow(
      ambiguousProdRow.sku,
      "'+SKU-QF",
      'existing ambiguous product sku is not stripped',
    );
    assertEqualOrThrow(ambiguousProdRow.price, 22, 'existing ambiguous product price updates normally');

    // 3. Unmarked product rows without ID or with unrecognized ID: preserve ambiguous leading apostrophes.
    const legacyUnprovenProd = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: productCsv(
          `,,'+Ambiguous Unmarked New,CSV Category,10,'-Ambiguous Desc,2,,,,,yes`,
          `unknown-legacy-id,,'+Ambiguous Unmarked Fallback,CSV Category,12,'=Ambiguous Desc 2,3,,,,,yes`,
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(legacyUnprovenProd.status, 200, 'unmarked unproven product rows import');
    assertEqualOrThrow(legacyUnprovenProd.data.created, 2, 'unmarked unproven products are created');
    assert(
      db.prepare('SELECT id FROM products WHERE name = ?').get("'+Ambiguous Unmarked New") !== undefined,
      'unmarked product without ID preserves its leading apostrophe',
    );
    assert(
      db.prepare('SELECT id FROM products WHERE name = ?').get("'+Ambiguous Unmarked Fallback") !== undefined,
      'unmarked product with unrecognized ID preserves its leading apostrophe',
    );

    // 4. Unmarked category import: category-only rows have no proof of identity, so ambiguous names are preserved.
    const legacyCatImport = await api(baseUrl, '/api/menu/csv/import/categories', {
      method: 'POST',
      body: {
        csv: [
          'name,description,color,icon,sort_order',
          "'=Equals Category,'-Minus description,blue,☕,20",
        ].join('\n'),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(legacyCatImport.status, 200, 'unmarked legacy category import succeeds');
    assertEqualOrThrow(
      legacyCatImport.data.created,
      1,
      'unmarked category row without proof of identity preserves its literal leading apostrophe',
    );
    assert(
      db.prepare('SELECT id FROM categories WHERE name = ? AND deleted_at IS NULL').get("'=Equals Category") !== undefined,
      'ambiguous unmarked category name is preserved as-is',
    );
    assert(
      db.prepare('SELECT id FROM categories WHERE id = ?').get('cat-rt-eq') !== undefined,
      'original category record remains intact',
    );

    // 5. Unmarked add-on import: proven when stable ID matches existing add-on, preserved when unproven or ambiguous.
    const legacyProvenAddonImport = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: {
        csv: addonCsvWithHeader(
          'id,group_name,addon_name,price,group_required,group_min_select,group_max_select',
          'ad-rt-at,\'-Minus Group,\'@House Drizzle,3,yes,0,1',
          ',\'+Unproven Legacy Group,\'@Unproven Legacy Addon,4,no,0,1',
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(legacyProvenAddonImport.status, 200, 'unmarked add-on import with mixed proven/unproven rows succeeds');
    assertEqualOrThrow(legacyProvenAddonImport.data.groups_updated, 1, 'ID-proven legacy add-on row updates its existing group');
    assertEqualOrThrow(legacyProvenAddonImport.data.skipped, 1, 'ID-proven legacy add-on row matches existing active add-on');
    assertEqualOrThrow(legacyProvenAddonImport.data.groups_created, 1, 'unproven legacy add-on row creates its literal group');
    assertEqualOrThrow(legacyProvenAddonImport.data.addons_created, 1, 'unproven legacy add-on row creates its literal add-on');
    assert(
      db.prepare('SELECT id FROM addon_groups WHERE name = ?').get("'+Unproven Legacy Group") !== undefined,
      'unproven legacy add-on group preserves its leading apostrophe',
    );
    assert(
      db.prepare('SELECT id FROM addons WHERE name = ?').get("'@Unproven Legacy Addon") !== undefined,
      'unproven legacy add-on preserves its leading apostrophe',
    );

    console.log('\n─── Unsupported non-empty flo_csv_encoding markers are rejected ───');
    const badCatEncoding = await api(baseUrl, '/api/menu/csv/import/categories', {
      method: 'POST',
      body: {
        csv: [
          'name,description,color,icon,sort_order,flo_csv_encoding',
          'Rejected Encoding Category,Desc,blue,☕,1,quote-v2',
          'Blank Marker Category,Desc,green,🍔,2,',
        ].join('\n'),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(badCatEncoding.status, 200, 'category import with unsupported encoding returns row validation results');
    assertEqualOrThrow(badCatEncoding.data.failed, 1, 'unsupported category encoding marker fails validation');
    assertEqualOrThrow(badCatEncoding.data.created, 1, 'row with empty flo_csv_encoding beside unsupported row still imports');
    assert(
      badCatEncoding.data.errors.some((e: string) => e.includes('unsupported flo_csv_encoding "quote-v2"')),
      'category validation error reports unsupported flo_csv_encoding',
    );
    assertEqualOrThrow(
      db.prepare('SELECT id FROM categories WHERE name = ?').get('Rejected Encoding Category'),
      undefined,
      'category row with unsupported encoding marker is not persisted',
    );

    const badProdEncoding = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: {
        csv: [
          `${PRODUCT_HEADER},flo_csv_encoding`,
          ',,Rejected Encoding Product,CSV Category,10,Desc,2,,,,,yes,unsupported-v9',
        ].join('\n'),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(badProdEncoding.status, 200, 'product import with unsupported encoding returns row validation results');
    assertEqualOrThrow(badProdEncoding.data.failed, 1, 'unsupported product encoding marker fails validation');
    assertEqualOrThrow(badProdEncoding.data.created, 0, 'unsupported product encoding marker creates no product');
    assert(
      badProdEncoding.data.errors.some((e: string) => e.includes('unsupported flo_csv_encoding "unsupported-v9"')),
      'product validation error reports unsupported flo_csv_encoding',
    );

    const badAddonEncoding = await api(baseUrl, '/api/menu/csv/import/addons', {
      method: 'POST',
      body: {
        csv: addonCsvWithHeader(
          `${ADDON_HEADER},flo_csv_encoding`,
          'Rejected Encoding Group,Rejected Encoding Addon,5,no,0,1,legacy-v0',
        ),
      },
      headers: authHeader,
    });
    assertEqualOrThrow(badAddonEncoding.status, 200, 'addon import with unsupported encoding returns row validation results');
    assertEqualOrThrow(badAddonEncoding.data.failed, 1, 'unsupported addon encoding marker fails validation');
    assertEqualOrThrow(badAddonEncoding.data.addons_created, 0, 'unsupported addon encoding marker creates no addon');
    assert(
      badAddonEncoding.data.errors.some((e: string) => e.includes('unsupported flo_csv_encoding "legacy-v0"')),
      'addon validation error reports unsupported flo_csv_encoding',
    );
  } finally {
    server.close();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
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
