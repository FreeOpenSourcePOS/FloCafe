/**
 * Integration Test: Tables String IDs
 *
 * Tests that:
 * A) POST /tables generates string IDs in tbl-{uuid} format
 * B) GET /tables returns tables with string IDs
 * C) Table properties can be edited and explicitly cleared
 * D) Migration converts NULL/integer IDs to strings
 *
 * Regression test for Issue #27: ID type mismatch
 *
 * Usage: node tests/run-electron-node-test.cjs tests/tables-string-ids.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tables-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct, seedTable,
  seedCustomer,
  api, assert, assertEqual, assertIncludes,
  closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { tableRoutes } = require('../main/routes/tables');
const { orderRoutes } = require('../main/routes/orders');

async function main() {
  console.log('Integration Test: Tables String IDs');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);

  const app = createApp({
    '/api/tables': tableRoutes,
    '/api/orders': orderRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    // ═══════════════════════════════════════════════════════════════════
    // Scenario A: POST /tables generates string IDs
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario A: POST /tables generates string IDs ───');

    const createRes = await api(baseUrl, '/api/tables', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({
        number: 'T-NEW-1',
        capacity: 4,
      }),
    });

    assertEqual(createRes.status, 201, 'POST /tables returns 201');
    assert(createRes.data.table, 'Response includes table object');
    assertEqual(createRes.data.table.number, 'T-NEW-1', 'Table number matches');

    // Key assertion: ID must be a string in tbl-{uuid} format
    const tableId = createRes.data.table.id;
    assertEqual(typeof tableId, 'string', 'Table ID is a string');
    assert(/^tbl-[a-f0-9]{8}$/.test(tableId), `Table ID matches tbl-{8-hex-chars} format: ${tableId}`);
    console.log(`   ✓ Created table with ID: ${tableId}`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario B: GET /tables returns tables with string IDs
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario B: GET /tables returns string IDs ───');

    const listRes = await api(baseUrl, '/api/tables', {
      headers: authHeader,
    });

    assertEqual(listRes.status, 200, 'GET /tables returns 200');
    assert(Array.isArray(listRes.data.tables), 'Response includes tables array');

    const createdTable = listRes.data.tables.find((t: any) => t.number === 'T-NEW-1');
    assert(createdTable, 'Created table found in list');
    assertEqual(typeof createdTable.id, 'string', 'Listed table ID is a string');
    assert(/^tbl-[a-f0-9]{8}$/.test(createdTable.id), `Listed table ID matches format: ${createdTable.id}`);
    console.log(`   ✓ Listed table with ID: ${createdTable.id}`);

    // ═══════════════════════════════════════════════════════════════════
    // Scenario C: ID type consistency across queries
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario C: ID type consistency ───');

    // Verify all tables have string IDs (no integers or NULLs)
    const allTables = listRes.data.tables;
    for (const table of allTables) {
      assertEqual(typeof table.id, 'string', `Table ${table.number} has string ID`);
      assert(table.id.length > 0, `Table ${table.number} has non-empty ID`);
    }
    console.log(`   ✓ All ${allTables.length} tables have string IDs`);

    // ════════════════════════════════════════════════════════════════════
    // Scenario C2: PUT edits table properties and supports explicit clears
    // ══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario C2: Edit table properties ───');

    const editRes = await api(baseUrl, `/api/tables/${tableId}`, {
      method: 'PUT',
      headers: authHeader,
      body: JSON.stringify({ name: 'T-EDITED-1', capacity: 6, floor: 'First', section: 'Patio' }),
    });
    assertEqual(editRes.status, 200, 'PUT /tables/:id returns 200');
    assertEqual(editRes.data.table.number, 'T-EDITED-1', 'table number is updated');
    assertEqual(editRes.data.table.name, 'T-EDITED-1', 'normalized name alias is returned');
    assertEqual(editRes.data.table.capacity, 6, 'capacity is updated');
    assertEqual(editRes.data.table.floor, 'First', 'floor is updated');
    assertEqual(editRes.data.table.section, 'Patio', 'section is updated');
    assertEqual(editRes.data.table.activeOrder, null, 'normalized activeOrder field is returned');

    const clearRes = await api(baseUrl, `/api/tables/${tableId}`, {
      method: 'PUT',
      headers: authHeader,
      body: JSON.stringify({ floor: null, section: '' }),
    });
    assertEqual(clearRes.status, 200, 'optional location fields can be cleared');
    assertEqual(clearRes.data.table.floor, null, 'floor is explicitly cleared');
    assertEqual(clearRes.data.table.section, null, 'blank section is normalized to null');
    assertEqual(clearRes.data.table.name, 'T-EDITED-1', 'omitted name remains unchanged');

    const duplicateCreate = await api(baseUrl, '/api/tables', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({ number: 'T-DUPLICATE', capacity: 2 }),
    });
    const duplicateRename = await api(baseUrl, `/api/tables/${tableId}`, {
      method: 'PUT',
      headers: authHeader,
      body: JSON.stringify({ name: duplicateCreate.data.table.number }),
    });
    assertEqual(duplicateRename.status, 400, 'duplicate table rename is rejected');
    assertIncludes(duplicateRename.data.error, 'already exists', 'duplicate rename returns a clear validation message');
    assertEqual(duplicateRename.data.code, 'TABLE_NAME_DUPLICATE', 'duplicate rename returns a stable UI error code');

    const invalidName = await api(baseUrl, `/api/tables/${tableId}`, {
      method: 'PUT',
      headers: authHeader,
      body: JSON.stringify({ name: { unexpected: true } }),
    });
    assertEqual(invalidName.status, 400, 'object table names are rejected');
    assertEqual(invalidName.data.code, 'TABLE_NAME_REQUIRED', 'malformed names return a stable UI error code');

    const nullName = await api(baseUrl, `/api/tables/${tableId}`, {
      method: 'PUT',
      headers: authHeader,
      body: JSON.stringify({ name: null }),
    });
    assertEqual(nullName.status, 400, 'null table names are rejected');
    assertEqual(nullName.data.code, 'TABLE_NAME_REQUIRED', 'null names return a stable UI error code');

    const invalidCapacity = await api(baseUrl, `/api/tables/${tableId}`, {
      method: 'PUT',
      headers: authHeader,
      body: JSON.stringify({ capacity: 0 }),
    });
    assertEqual(invalidCapacity.status, 400, 'non-positive capacity is rejected');
    assertEqual(invalidCapacity.data.code, 'TABLE_CAPACITY_INVALID', 'invalid capacity returns a stable UI error code');

    const invalidLocation = await api(baseUrl, `/api/tables/${tableId}`, {
      method: 'PUT',
      headers: authHeader,
      body: JSON.stringify({ floor: { label: 'First' } }),
    });
    assertEqual(invalidLocation.status, 400, 'non-text floor is rejected');
    assertEqual(invalidLocation.data.code, 'TABLE_LOCATION_INVALID', 'invalid location returns a stable UI error code');

    const invalidCreate = await api(baseUrl, '/api/tables', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({ name: ['not-a-name'], capacity: 2 }),
    });
    assertEqual(invalidCreate.status, 400, 'malformed names are rejected during table creation');
    assertEqual(invalidCreate.data.code, 'TABLE_NAME_REQUIRED', 'create validation uses the same stable UI error code');

    for (const [label, malformedCapacity] of [['boolean', true], ['array', [2]]] as const) {
      const invalidCreateCapacity = await api(baseUrl, '/api/tables', {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({ name: `T-BAD-CREATE-${label}`, capacity: malformedCapacity }),
      });
      assertEqual(invalidCreateCapacity.status, 400, `${label} capacity is rejected during table creation`);
      assertEqual(invalidCreateCapacity.data.code, 'TABLE_CAPACITY_INVALID', `${label} create rejection has a stable UI error code`);

      const invalidUpdateCapacity = await api(baseUrl, `/api/tables/${tableId}`, {
        method: 'PUT',
        headers: authHeader,
        body: JSON.stringify({ capacity: malformedCapacity }),
      });
      assertEqual(invalidUpdateCapacity.status, 400, `${label} capacity is rejected during table editing`);
      assertEqual(invalidUpdateCapacity.data.code, 'TABLE_CAPACITY_INVALID', `${label} edit rejection has a stable UI error code`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Scenario D: Tables expose active orders and move order between tables
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario D: Move active order between tables ───');

    seedCategory(db, 'cat-table-move', 'Table Move Menu');
    seedProduct(db, 'prod-table-move', 'cat-table-move', 'Dosa', 120);
    seedCustomer(db, 'cust-table-move', 'Table Guest', '9876543210');
    seedTable(db, 'tbl-move-source', 91, 4);
    seedTable(db, 'tbl-move-target', 92, 4);

    const orderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-move-source',
        customer_id: 'cust-table-move',
        items: [{ product_id: 'prod-table-move', quantity: 1 }],
      },
    });
    assertEqual(orderRes.status, 201, 'dine-in order created on source table');
    const orderId = orderRes.data.order.id;

    const liveTables = await api(baseUrl, '/api/tables', { headers: authHeader });
    const liveSource = liveTables.data.tables.find((t: any) => t.id === 'tbl-move-source');
    assertEqual(liveSource.activeOrder.id, orderId, 'GET /tables includes active order for occupied table');
    assertEqual(liveSource.current_order.id, orderId, 'GET /tables includes current_order alias for frontend compatibility');
    assertEqual(liveSource.current_order.customer.name, 'Table Guest', 'current_order includes customer for mismatch warning');
    assertEqual(liveSource.seated_at, orderRes.data.order.created_at, 'GET /tables exposes seated_at from the active order (#595)');

    const moveRes = await api(baseUrl, '/api/tables/tbl-move-source/move-order', {
      method: 'POST',
      headers: authHeader,
      body: { target_table_id: 'tbl-move-target' },
    });
    assertEqual(moveRes.status, 200, 'move order returns 200');
    assertEqual(moveRes.data.order.id, orderId, 'same order is returned');
    assertEqual(moveRes.data.order.table_id, 'tbl-move-target', 'order table_id moves to target');
    assertEqual(Number(moveRes.data.order.table.name), 92, 'response includes new table for KOT/KDS consumers');
    assertEqual(moveRes.data.sourceTable.status, 'available', 'source table is freed');
    assertEqual(moveRes.data.targetTable.status, 'occupied', 'target table is occupied');
    assertEqual(moveRes.data.targetTable.activeOrder.id, orderId, 'target table now exposes active order');
    assertEqual(moveRes.data.targetTable.current_order.id, orderId, 'target table also exposes current_order alias');
    assertEqual(moveRes.data.targetTable.seated_at, orderRes.data.order.created_at, 'target table seated_at reflects the moved order (#595)');
    assertEqual(moveRes.data.sourceTable.seated_at, null, 'freed source table has no seated_at (#595)');

    const movedOrder = await api(baseUrl, `/api/orders/${orderId}`, { headers: authHeader });
    assertEqual(Number(movedOrder.data.order.table.name), 92, 'order detail resolves the new table immediately');

    const occupiedMove = await api(baseUrl, '/api/tables/tbl-move-target/move-order', {
      method: 'POST',
      headers: authHeader,
      body: { target_table_id: tableId },
    });
    assertEqual(occupiedMove.status, 200, 'order can be moved again to a free table');

    // ═══════════════════════════════════════════════════════════════════
    // Scenario E: Migration handles NULL IDs
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario E: Migration handles NULL IDs ───');

    // Simulate old table with NULL ID (from pre-fix INSERT)
    db.prepare(`INSERT INTO tables (number, capacity, status) VALUES (?, ?, ?)`).run('T-NULL-TEST', 4, 'available');

    // Verify NULL ID exists before migration
    const nullTable = db.prepare(`SELECT id, typeof(id) FROM tables WHERE number = ?`).get('T-NULL-TEST') as any;
    assert(nullTable.id === null, 'Table has NULL ID before migration');

    // Run migration logic
    db.exec(`UPDATE tables SET id = 'tbl-' || rowid WHERE id IS NULL`);

    // Verify ID is now a string
    const migratedTable = db.prepare(`SELECT id, typeof(id) FROM tables WHERE number = ?`).get('T-NULL-TEST') as any;
    assertEqual(typeof migratedTable.id, 'string', 'Migrated table has string ID');
    assert(/^tbl-\d+$/.test(migratedTable.id), `Migrated ID matches tbl-{rowid} format: ${migratedTable.id}`);
    console.log(`   ✓ Migrated NULL ID to: ${migratedTable.id}`);

    console.log('\n✅ All tables string ID tests passed');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  })
  .catch((error) => {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
  });
