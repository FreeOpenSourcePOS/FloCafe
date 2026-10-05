/** Behavioral coverage for the add-on inventory catalog API (#358): stock metadata on
 *  both add-on serializers, and a stock change recorded as a ledger movement. */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-addon-inventory-api-'));

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
  api,
  assertEqualOrThrow,
  assertOrThrow,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { validateInventoryLedgerDatabase } = require('../main/db');
const { addonGroupRoutes } = require('../main/routes/addon-groups');
const { productRoutes } = require('../main/routes/products');

function movementsFor(db: any, addonId: string): any[] {
  return db.prepare(
    'SELECT * FROM inventory_movements WHERE addon_id = ? ORDER BY id'
  ).all(addonId);
}

async function main() {
  console.log('Integration Test: add-on inventory catalog API (#358)');
  console.log('='.repeat(62));

  const db = initTestDb();
  const { userId, authHeader } = seedOwnerUser(db);
  const app = createApp({
    '/api/addon-groups': addonGroupRoutes,
    '/api/products': productRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n--- Nested create persists stock through the ledger ---');
    let res = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Milk Options',
        min_selection: 0,
        max_selection: 2,
        addons: [
          { name: 'Oat Milk', price: 1, track_inventory: true, stock_quantity: 12, low_stock_threshold: 4 },
          { name: 'Whole Milk', price: 0 },
        ],
      },
    });
    assertEqualOrThrow(res.status, 201, 'group with stock fields is created');
    const groupId = res.data.addon_group.id;
    const oat = res.data.addon_group.addons.find((a: any) => a.name === 'Oat Milk');
    const whole = res.data.addon_group.addons.find((a: any) => a.name === 'Whole Milk');
    assertEqualOrThrow(oat.track_inventory, true, 'track_inventory is serialized as a boolean');
    assertEqualOrThrow(oat.stock_quantity, 12, 'stock_quantity is serialized as a number');
    assertEqualOrThrow(oat.low_stock_threshold, 4, 'low_stock_threshold is serialized as a number');
    assertEqualOrThrow(whole.track_inventory, false, 'an untracked add-on defaults track_inventory to false');
    assertEqualOrThrow(whole.stock_quantity, 0, 'an untracked add-on starts at zero stock');

    const opening = movementsFor(db, oat.id);
    assertEqualOrThrow(opening.length, 1, 'opening stock appends exactly one ledger movement');
    assertEqualOrThrow(opening[0].quantity_delta, 12, 'the opening movement carries the full quantity');
    assertEqualOrThrow(opening[0].stock_after, 12, 'the opening movement records the resulting stock');
    assertEqualOrThrow(opening[0].movement_type, 'adjustment', 'opening stock is an adjustment movement');
    assertEqualOrThrow(opening[0].reference_type, 'opening_balance', 'opening stock is attributed to an opening balance');
    assertEqualOrThrow(opening[0].actor_user_id, userId, 'the movement is attributed to the authenticated operator');
    assertEqualOrThrow(opening[0].product_id, null, 'an add-on pool movement names no product');
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'a newly created add-on pool reconciles against its own ledger',
    );

    console.log('\n--- A stock change is a ledger event, not a silent overwrite ---');
    res = await api(baseUrl, `/api/addon-groups/${groupId}`, {
      method: 'PUT',
      headers: authHeader,
      body: {
        addons: [
          { id: oat.id, name: 'Oat Milk', price: 1, track_inventory: true, stock_quantity: 7, low_stock_threshold: 4 },
          { id: whole.id, name: 'Whole Milk', price: 0 },
        ],
      },
    });
    assertEqualOrThrow(res.status, 200, 'bulk group edit with new stock succeeds');
    const afterEdit = db.prepare('SELECT * FROM addons WHERE id = ?').get(oat.id);
    assertEqualOrThrow(afterEdit.stock_quantity, 7, 'the requested stock is persisted');
    const edits = movementsFor(db, oat.id);
    assertEqualOrThrow(edits.length, 2, 'the stock change appends a second movement');
    assertEqualOrThrow(edits[1].quantity_delta, -5, 'the movement records the difference, not the absolute value');
    assertEqualOrThrow(edits[1].stock_after, 7, 'the movement records the resulting stock');
    assertEqualOrThrow(edits[1].reference_type, 'manual_adjustment', 'an edit is attributed to a manual adjustment');
    assertEqualOrThrow(edits[1].actor_user_id, userId, 'the adjustment is attributed to the authenticated operator');
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'the ledger still reconciles after an edit',
    );

    console.log('\n--- Omitted stock leaves the tracked quantity alone ---');
    res = await api(baseUrl, `/api/addon-groups/${groupId}/addons/${oat.id}`, {
      method: 'PUT',
      headers: authHeader,
      body: { name: 'Oat Milk (large)', price: 1.5 },
    });
    assertEqualOrThrow(res.status, 200, 'a partial add-on edit succeeds');
    const afterPatch = db.prepare('SELECT * FROM addons WHERE id = ?').get(oat.id);
    assertEqualOrThrow(afterPatch.stock_quantity, 7, 'an omitted stock_quantity does not reset stock to zero');
    assertEqualOrThrow(afterPatch.low_stock_threshold, 4, 'an omitted low_stock_threshold keeps its stored value');
    assertEqualOrThrow(movementsFor(db, oat.id).length, 2, 'an omitted stock_quantity appends no movement');
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'a partial edit that omits stock leaves the ledger reconciled',
    );

    console.log('\n--- Single add-on create and update ---');
    res = await api(baseUrl, `/api/addon-groups/${groupId}/addons`, {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Extra Cheese', price: 2, track_inventory: true, stock_quantity: 5, low_stock_threshold: 2 },
    });
    assertEqualOrThrow(res.status, 201, 'a single add-on with stock is created');
    assertEqualOrThrow(res.data.addon.track_inventory, true, 'track_inventory is a boolean on the single-addon serializer');
    assertEqualOrThrow(res.data.addon.stock_quantity, 5, 'stock_quantity is a number on the single-addon serializer');
    assertEqualOrThrow(res.data.addon.low_stock_threshold, 2, 'low_stock_threshold is a number on the single-addon serializer');
    const cheeseId = res.data.addon.id;
    const cheeseOpening = movementsFor(db, cheeseId);
    assertEqualOrThrow(cheeseOpening.length, 1, 'single-addon opening stock appends one movement');
    assertEqualOrThrow(cheeseOpening[0].reference_type, 'opening_balance', 'single-addon opening stock is an opening balance');

    res = await api(baseUrl, `/api/addon-groups/${groupId}/addons/${cheeseId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { stock_quantity: 1 },
    });
    assertEqualOrThrow(res.status, 200, 'a single add-on stock edit succeeds');
    assertEqualOrThrow(res.data.addon.stock_quantity, 1, 'the single add-on edit persists stock');
    assertEqualOrThrow(movementsFor(db, cheeseId).length, 2, 'the single add-on edit appends a second movement');
    assertEqualOrThrow(movementsFor(db, cheeseId)[1].quantity_delta, -4, 'the single add-on edit records the difference');
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'single-addon edits leave the ledger reconciled',
    );

    console.log('\n--- Stock of zero still reconciles ---');
    res = await api(baseUrl, `/api/addon-groups/${groupId}/addons/${cheeseId}`, {
      method: 'PUT',
      headers: authHeader,
      body: { stock_quantity: 0 },
    });
    assertEqualOrThrow(res.status, 200, 'draining an add-on pool to zero succeeds');
    assertEqualOrThrow(res.data.addon.stock_quantity, 0, 'the drained pool reads back as zero');
    assertEqualOrThrow(movementsFor(db, cheeseId).length, 3, 'draining appends a third movement');
    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'a drained pool reconciles against its closing movement',
    );

    console.log('\n--- Validation uses the existing numeric rules ---');
    res = await api(baseUrl, `/api/addon-groups/${groupId}/addons`, {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Bad Stock', price: 1, stock_quantity: -3 },
    });
    assertEqualOrThrow(res.status, 400, 'a negative stock_quantity is rejected');
    assertOrThrow(res.data.errors.stock_quantity, 'a negative stock_quantity reports a stock_quantity field error');

    res = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      headers: authHeader,
      body: {
        name: 'Bad Nested Stock',
        min_selection: 0,
        max_selection: 1,
        addons: [{ name: 'Bad', price: 1, stock_quantity: 'lots' }],
      },
    });
    assertEqualOrThrow(res.status, 400, 'a non-numeric nested stock_quantity is rejected');
    assertOrThrow(res.data.errors['addons.0.stock_quantity'], 'the nested stock error names the indexed field');

    console.log('\n--- The POS product serializer carries the same fields ---');
    const productRes = await api(baseUrl, '/api/products', {
      method: 'POST',
      headers: authHeader,
      body: { name: 'Flat White', price: 3, addon_group_ids: [groupId] },
    });
    assertEqualOrThrow(productRes.status, 201, 'a product is created against the group');
    const readBack = await api(baseUrl, `/api/products/${productRes.data.product.id}`, { headers: authHeader });
    const posAddon = readBack.data.product.addon_groups[0].addons.find((a: any) => a.name === 'Oat Milk (large)');
    assertOrThrow(posAddon, 'the POS product payload carries the add-on');
    assertEqualOrThrow(posAddon.track_inventory, true, 'the POS serializer emits track_inventory as a boolean');
    assertEqualOrThrow(posAddon.stock_quantity, 7, 'the POS serializer emits stock_quantity as a number');
    assertEqualOrThrow(posAddon.low_stock_threshold, 4, 'the POS serializer emits low_stock_threshold as a number');

    assertEqualOrThrow(
      validateInventoryLedgerDatabase(db),
      null,
      'the whole store reconciles after every write path',
    );
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(62));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});