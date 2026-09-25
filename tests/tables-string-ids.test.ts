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
const strictAssert = require('node:assert/strict');
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
const { heldOrderRoutes } = require('../main/routes/held-orders');

async function main() {
  console.log('Integration Test: Tables String IDs');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);

  const app = createApp({
    '/api/tables': tableRoutes,
    '/api/orders': orderRoutes,
    '/api/held-orders': heldOrderRoutes,
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
    // Scenario B2: Reservation customer persists, hydrates, and clears
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario B2: Reservation customer lifecycle ───');

    seedTable(db, 'tbl-reservation', 90, 4);
    seedCustomer(db, 'cust-reservation-1', 'Reserved Guest', '+1 555 123 4567');
    seedCustomer(db, 'cust-reservation-2', 'Replacement Guest', '+1 555 765 4321');
    db.prepare(`INSERT INTO customers (id, name, phone, is_active, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`)
      .run('cust-reservation-inactive', 'Inactive Guest', '+1 555 000 0000', now(), now());
    seedCategory(db, 'cat-reservation', 'Reservation Menu');
    seedProduct(db, 'prod-reservation', 'cat-reservation', 'Tea', 5);

    const noAuthReservation = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', body: { status: 'reserved', reservation_customer_id: 'cust-reservation-1' },
    });
    assertEqual(noAuthReservation.status, 401, 'reservation customer cannot be linked without authentication');
    const { getJWTSecret: getReservationJwtSecret } = require('../main/routes/auth');
    const reservationCashierToken = require('jsonwebtoken').sign(
      { userId: 'reservation-cashier', email: 'reservation-cashier@test.local', role: 'cashier' },
      getReservationJwtSecret(),
      { expiresIn: '1h' },
    );
    const cashierReservation = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: { Authorization: `Bearer ${reservationCashierToken}` },
      body: { status: 'reserved', reservation_customer_id: 'cust-reservation-1' },
    });
    assertEqual(cashierReservation.status, 403, 'cashier cannot link a customer to a reservation');

    const missingCustomer = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 'missing-customer' },
    });
    assertEqual(missingCustomer.status, 400, 'nonexistent reservation customer is rejected');

    const inactiveCustomer = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 'cust-reservation-inactive' },
    });
    assertEqual(inactiveCustomer.status, 400, 'inactive reservation customer is rejected');

    const malformedCustomer = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 1 },
    });
    assertEqual(malformedCustomer.status, 400, 'non-string reservation customer ID is rejected');

    const linkOnAvailable = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'available', reservation_customer_id: 'cust-reservation-1' },
    });
    assertEqual(linkOnAvailable.status, 400, 'reservation customer cannot be linked to a non-reserved table');

    const reserveRes = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 'cust-reservation-1' },
    });
    assertEqual(reserveRes.status, 200, 'valid reservation with a customer succeeds');
    assertEqual(reserveRes.data.table.reservation_customer_id, 'cust-reservation-1', 'reservation customer ID persists');
    assertEqual(reserveRes.data.table.reservation_customer_name, 'Reserved Guest', 'reservation response hydrates customer name');
    assertEqual(reserveRes.data.table.reservation_customer_phone, '+1 555 123 4567', 'reservation response hydrates customer phone');

    const reloadRes = await api(baseUrl, '/api/tables/tbl-reservation', { headers: authHeader });
    assertEqual(reloadRes.data.table.reservation_customer_name, 'Reserved Guest', 'GET after reload returns reservation customer name');
    assertEqual(reloadRes.data.table.reservation_customer_phone, '+1 555 123 4567', 'GET after reload returns reservation customer phone');
    // requirePermission() resolves effective permissions from a real users row
    // keyed by the JWT's userId — the token alone is not authoritative.
    db.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES ('reservation-chef', 'Reservation Chef', 'reservation-chef@test.local', 'unused', 'chef', 1, ?, ?)`
    ).run(now(), now());
    const reservationChefToken = require('jsonwebtoken').sign(
      { userId: 'reservation-chef', email: 'reservation-chef@test.local', role: 'chef' },
      getReservationJwtSecret(),
      { expiresIn: '1h' },
    );
    const unauthenticatedTables = await api(baseUrl, '/api/tables');
    assertEqual(unauthenticatedTables.status, 401, 'table reads still require authentication');
    const chefTables = await api(baseUrl, '/api/tables', {
      headers: { Authorization: `Bearer ${reservationChefToken}` },
    });
    assertEqual(chefTables.status, 200, 'chef can read tables');
    const chefReservationTable = chefTables.data.tables.find((table: any) => table.id === 'tbl-reservation');
    assertEqual(chefReservationTable.status, 'reserved', 'chef can read the table status');
    assertEqual(chefReservationTable.reservation_customer_id, null, 'table list redacts the reservation customer ID for chefs');
    assertEqual(chefReservationTable.reservation_customer_name, null, 'table list redacts the reservation customer name for chefs');
    assertEqual(chefReservationTable.reservation_customer_phone, null, 'table list redacts the reservation customer phone for chefs');
    const chefTable = await api(baseUrl, '/api/tables/tbl-reservation', {
      headers: { Authorization: `Bearer ${reservationChefToken}` },
    });
    assertEqual(chefTable.status, 200, 'chef can read one table');
    assertEqual(chefTable.data.table.status, 'reserved', 'single-table read includes state for chefs');
    assertEqual(chefTable.data.table.reservation_customer_id, null, 'single-table read redacts the reservation customer ID for chefs');
    assertEqual(chefTable.data.table.reservation_customer_name, null, 'single-table read redacts the reservation customer name for chefs');
    assertEqual(chefTable.data.table.reservation_customer_phone, null, 'single-table read redacts the reservation customer phone for chefs');

    const replaceRes = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 'cust-reservation-2' },
    });
    assertEqual(replaceRes.data.table.reservation_customer_id, 'cust-reservation-2', 'a new reservation replaces the previous customer');
    assertEqual(replaceRes.data.table.reservation_customer_name, 'Replacement Guest', 'replacement customer is hydrated');

    const releaseRes = await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader, body: { status: 'available' },
    });
    assertEqual(releaseRes.data.table.reservation_customer_id, null, 'leaving reserved for available clears the reservation customer');
    assertEqual(releaseRes.data.table.reservation_customer_name, null, 'released table has no hydrated customer name');
    db.prepare("UPDATE tables SET status = 'available', reservation_customer_id = ? WHERE id = ?")
      .run('cust-reservation-1', 'tbl-reservation');
    assertEqual(db.prepare('SELECT reservation_customer_id FROM tables WHERE id = ?').get('tbl-reservation').reservation_customer_id,
      null, 'table status trigger clears a customer included in a non-reserved update');

    await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 'cust-reservation-2' },
    });
    const holdRes = await api(baseUrl, '/api/held-orders', {
      method: 'POST', headers: authHeader,
      body: {
        tableId: 'tbl-reservation', customerId: 'cust-reservation-2', guestCount: 1,
        items: [{ id: 'held-reservation-item', product: { id: 'prod-reservation' }, quantity: 1, addons: [] }],
      },
    });
    assertEqual(holdRes.status, 200, 'holding a reserved table succeeds');
    const heldReservation = await api(baseUrl, '/api/tables/tbl-reservation', { headers: authHeader });
    assertEqual(heldReservation.data.table.status, 'held', 'held order marks table held');
    assertEqual(heldReservation.data.table.reservation_customer_id, null, 'leaving reserved for held clears the reservation customer');
    const unholdRes = await api(baseUrl, `/api/held-orders/tbl-reservation?heldOrderId=${encodeURIComponent(holdRes.data.id)}`, {
      method: 'DELETE', headers: authHeader,
    });
    assertEqual(unholdRes.status, 200, 'held reservation can be released before creating a regular order');

    await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 'cust-reservation-2' },
    });
    const reservationOrderWithMismatch = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: {
        type: 'dine_in', table_id: 'tbl-reservation', customer_id: 'cust-reservation-1',
        items: [{ product_id: 'prod-reservation', quantity: 1 }],
      },
    });
    assertEqual(reservationOrderWithMismatch.status, 201, 'dine-in order with a mismatched customer can use a reserved table');
    assertEqual(reservationOrderWithMismatch.data.order.customer_id, 'cust-reservation-1', 'explicit order customer takes precedence over the reserved customer');
    db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(reservationOrderWithMismatch.data.order.id);

    await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 'cust-reservation-2' },
    });
    const reservationOrderWithoutCustomer = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: {
        type: 'dine_in', table_id: 'tbl-reservation',
        items: [{ product_id: 'prod-reservation', quantity: 1 }],
      },
    });
    assertEqual(reservationOrderWithoutCustomer.status, 201, 'dine-in order without a customer can use a reserved table');
    assertEqual(reservationOrderWithoutCustomer.data.order.customer_id, 'cust-reservation-2', 'reserved customer fills an omitted order customer');
    db.prepare("UPDATE orders SET status = 'completed' WHERE id = ?").run(reservationOrderWithoutCustomer.data.order.id);

    await api(baseUrl, '/api/tables/tbl-reservation/status', {
      method: 'PATCH', headers: authHeader,
      body: { status: 'reserved', reservation_customer_id: 'cust-reservation-2' },
    });
    const reservationOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: authHeader,
      body: {
        type: 'dine_in', table_id: 'tbl-reservation', customer_id: 'cust-reservation-2',
        items: [{ product_id: 'prod-reservation', quantity: 1 }],
      },
    });
    assertEqual(reservationOrder.status, 201, 'dine-in order can be created for a reserved table');
    assertEqual(reservationOrder.data.order.customer_id, 'cust-reservation-2', 'reserved customer is attached to the order');
    const reservationOrderList = await api(baseUrl, '/api/orders?table_id=tbl-reservation', { headers: authHeader });
    assertEqual(reservationOrderList.data.orders[0].customer.name, 'Replacement Guest', 'Orders API hydrates the linked reservation customer');
    const occupiedReservation = await api(baseUrl, '/api/tables/tbl-reservation', { headers: authHeader });
    assertEqual(occupiedReservation.data.table.status, 'occupied', 'order creation marks reserved table occupied');
    assertEqual(occupiedReservation.data.table.reservation_customer_id, null, 'order creation clears the consumed reservation');
    strictAssert.equal(occupiedReservation.data.table.activeOrder.customer_id, 'cust-reservation-2', 'sales table reads retain the linked active-order customer ID');
    strictAssert.equal(occupiedReservation.data.table.activeOrder.customer.name, 'Replacement Guest', 'sales table reads retain the linked active-order customer');
    strictAssert.equal(occupiedReservation.data.table.activeOrder.customer.phone, '+1 555 765 4321', 'sales table reads retain the linked active-order customer phone');
    const chefOccupiedTables = await api(baseUrl, '/api/tables', {
      headers: { Authorization: `Bearer ${reservationChefToken}` },
    });
    const chefOccupiedTable = chefOccupiedTables.data.tables.find((table: any) => table.id === 'tbl-reservation');
    strictAssert.equal(chefOccupiedTable.status, 'occupied', 'chef can still read occupied table state');
    strictAssert.equal(chefOccupiedTable.activeOrder.customer_id, null, 'chef table list redacts the active-order customer ID');
    strictAssert.equal(chefOccupiedTable.activeOrder.customer, null, 'chef table list redacts the active-order customer details');
    strictAssert.equal(chefOccupiedTable.current_order.customer_id, null, 'chef table list redacts the current-order customer ID alias');
    strictAssert.equal(chefOccupiedTable.current_order.customer, null, 'chef table list redacts the current-order customer details alias');
    const chefOccupiedTableDetail = await api(baseUrl, '/api/tables/tbl-reservation', {
      headers: { Authorization: `Bearer ${reservationChefToken}` },
    });
    strictAssert.equal(chefOccupiedTableDetail.data.table.status, 'occupied', 'chef can still read occupied table detail');
    strictAssert.equal(chefOccupiedTableDetail.data.table.activeOrder.customer_id, null, 'chef table detail redacts the active-order customer ID');
    strictAssert.equal(chefOccupiedTableDetail.data.table.activeOrder.customer, null, 'chef table detail redacts the active-order customer details');
    console.log('   ✓ Reservation customer survives reload, flows to orders, and clears on table transitions');

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

    // ═══════════════════════════════════════════════════════════════════
    // Scenario F: Floorplan editor positions persist (issue #356)
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario F: Floorplan position persistence ───');

    seedTable(db, 'tbl-floor-1', 93, 4);
    seedTable(db, 'tbl-floor-2', 94, 2);

    const floorPutRes = await api(baseUrl, '/api/tables/tbl-floor-1', {
      method: 'PUT',
      headers: authHeader,
      body: { position_x: 25.5, position_y: 40 },
    });
    assertEqual(floorPutRes.status, 200, 'PUT accepts floorplan position');
    assertEqual(floorPutRes.data.table.position_x, 25.5, 'position_x persisted');
    assertEqual(floorPutRes.data.table.position_y, 40, 'position_y persisted');

    // Partial update: only position_y keeps position_x (COALESCE contract)
    const floorPutRes2 = await api(baseUrl, '/api/tables/tbl-floor-1', {
      method: 'PUT',
      headers: authHeader,
      body: { position_y: 61.25 },
    });
    assertEqual(floorPutRes2.status, 200, 'partial PUT accepted');
    assertEqual(floorPutRes2.data.table.position_x, 25.5, 'position_x preserved on partial update');
    assertEqual(floorPutRes2.data.table.position_y, 61.25, 'position_y updated');

    const floorListRes = await api(baseUrl, '/api/tables', { headers: authHeader });
    const floorTable = floorListRes.data.tables.find((t: any) => t.id === 'tbl-floor-1');
    assertEqual(floorTable.position_x, 25.5, 'GET /tables returns position_x');
    assertEqual(floorTable.position_y, 61.25, 'GET /tables returns position_y');
    assertEqual(floorTable.capacity, 4, 'other fields untouched by position save');
    assertEqual(floorTable.status, 'available', 'status untouched by position save');
    const untouched = floorListRes.data.tables.find((t: any) => t.id === 'tbl-floor-2');
    assert(untouched.position_x === null && untouched.position_y === null, 'unpositioned table stays off-map');
    console.log('   ✓ Floorplan positions persist via PUT/GET');

    // ── Batch layout endpoint: PATCH /api/tables/positions ──
    const batchRes = await api(baseUrl, '/api/tables/positions', {
      method: 'PATCH',
      headers: authHeader,
      body: {
        positions: [
          { id: 'tbl-floor-1', position_x: 10, position_y: 20 },
          { id: 'tbl-floor-2', position_x: 75, position_y: 80 },
        ],
      },
    });
    assertEqual(batchRes.status, 200, 'PATCH /tables/positions returns 200');
    assertEqual(batchRes.data.success, true, 'batch positions returns success');
    assertEqual(batchRes.data.count, 2, 'batch positions returns count');

    const batchCheck = await api(baseUrl, '/api/tables', { headers: authHeader });
    const b1 = batchCheck.data.tables.find((t: any) => t.id === 'tbl-floor-1');
    const b2 = batchCheck.data.tables.find((t: any) => t.id === 'tbl-floor-2');
    assertEqual(b1.position_x, 10, 'tbl-floor-1 batch position_x updated');
    assertEqual(b1.position_y, 20, 'tbl-floor-1 batch position_y updated');
    assertEqual(b2.position_x, 75, 'tbl-floor-2 batch position_x updated');
    assertEqual(b2.position_y, 80, 'tbl-floor-2 batch position_y updated');
    console.log('   ✓ Batch position updates persist via PATCH /tables/positions');

    // ── Batch unplacing: set positions to null ──
    const unplaceBatchRes = await api(baseUrl, '/api/tables/positions', {
      method: 'PATCH',
      headers: authHeader,
      body: {
        positions: [
          { id: 'tbl-floor-1', position_x: null, position_y: null },
        ],
      },
    });
    assertEqual(unplaceBatchRes.status, 200, 'unplace via batch returns 200');
    const unplaceCheck = await api(baseUrl, '/api/tables', { headers: authHeader });
    const u1 = unplaceCheck.data.tables.find((t: any) => t.id === 'tbl-floor-1');
    assert(u1.position_x === null && u1.position_y === null, 'tbl-floor-1 unplaced via batch');
    console.log('   ✓ Unplace tables via batch PATCH /tables/positions');

    // ── Unplace via PUT /tables/:id (COALESCE null trap fix) ──
    const putUnplaceRes = await api(baseUrl, '/api/tables/tbl-floor-2', {
      method: 'PUT',
      headers: authHeader,
      body: { position_x: null, position_y: null },
    });
    assertEqual(putUnplaceRes.status, 200, 'unplace via PUT returns 200');
    assertEqual(putUnplaceRes.data.table.position_x, null, 'tbl-floor-2 position_x cleared via PUT');
    assertEqual(putUnplaceRes.data.table.position_y, null, 'tbl-floor-2 position_y cleared via PUT');
    console.log('   ✓ Unplace tables via PUT /tables/:id');

    // ── POST accepts a 0 coordinate (no falsy-to-null coercion) ──
    const postZeroRes = await api(baseUrl, '/api/tables', {
      method: 'POST',
      headers: authHeader,
      body: { number: 'TT-ZERO', capacity: 2, floor: 'Ground', position_x: 0, position_y: 0 },
    });
    assertEqual(postZeroRes.status, 201, 'POST with 0 coordinates returns 201');
    assertEqual(postZeroRes.data.table.position_x, 0, 'position_x 0 persists instead of coercing to null');
    console.log('   ✓ POST persists a 0 coordinate');

    // ── POST rejects out-of-range coordinates ──
    const postRangeRes = await api(baseUrl, '/api/tables', {
      method: 'POST',
      headers: authHeader,
      body: { number: 'TT-RANGE', capacity: 2, position_x: 150, position_y: 10 },
    });
    assertEqual(postRangeRes.status, 400, 'POST with out-of-range coordinates returns 400');
    console.log('   ✓ POST rejects coordinates outside 0–100');

    // ── Role restriction on PATCH /tables/positions ──
    const { getJWTSecret } = require('../main/routes/auth');
    const jwt = require('jsonwebtoken');
    const cashierToken = jwt.sign(
      { userId: 'cashier-test-001', email: 'cashier@test.local', role: 'cashier' },
      getJWTSecret(),
      { expiresIn: '1h' }
    );
    const cashierHeader = { Authorization: `Bearer ${cashierToken}` };

    const cashierPatchRes = await api(baseUrl, '/api/tables/positions', {
      method: 'PATCH',
      headers: cashierHeader,
      body: { positions: [{ id: 'tbl-floor-1', position_x: 50, position_y: 50 }] },
    });
    assertEqual(cashierPatchRes.status, 403, 'cashier role is denied on PATCH /tables/positions');
    console.log('   ✓ RBAC enforced on layout positions endpoint');

    // ── Coordinate range validation (0–100 canvas percent) ──
    const rangeRes = await api(baseUrl, '/api/tables/positions', {
      method: 'PATCH',
      headers: authHeader,
      body: { positions: [{ id: 'tbl-floor-1', position_x: 101, position_y: -1 }] },
    });
    assertEqual(rangeRes.status, 400, 'out-of-range coordinates are rejected with 400');
    console.log('   ✓ Batch rejects coordinates outside 0–100');

    // ── Unknown table IDs are rejected, not silently skipped ──
    const unknownRes = await api(baseUrl, '/api/tables/positions', {
      method: 'PATCH',
      headers: authHeader,
      body: { positions: [{ id: 'tbl-does-not-exist', position_x: 10, position_y: 10 }] },
    });
    assertEqual(unknownRes.status, 404, 'unknown table ID returns 404');
    console.log('   ✓ Batch rejects unknown table IDs');

    // ── PUT mirrors the contract: invalid coordinates are rejected ──
    const putBadRes = await api(baseUrl, '/api/tables/tbl-floor-1', {
      method: 'PUT',
      headers: authHeader,
      body: { position_x: 'not-a-number' },
    });
    assertEqual(putBadRes.status, 400, 'PUT with non-numeric position returns 400');
    console.log('   ✓ PUT rejects invalid coordinates with 400');

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
