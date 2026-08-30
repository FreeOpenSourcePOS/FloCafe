/**
 * Integration Test: Held Orders API
 *
 * Tests that:
 * A) POST /held-orders creates a held order for a table
 * B) GET /held-orders returns a list of held orders
 * C) DELETE /held-orders/:tableId consumes matching rows and safely handles stale rows
 *
 * Usage: node tests/run-electron-node-test.cjs tests/held-orders.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-held-orders-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct, seedTable,
  api, assert, assertEqual,
  closeDatabase, getDatabase, now,
} = require('./helpers/test-setup');

const { heldOrderRoutes } = require('../main/routes/held-orders');

async function main() {
  console.log('Integration Test: Held Orders API');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-held-365', 'Weighted products');
  seedProduct(db, 'product-mango', 'cat-held-365', 'Mango', 120, {
    sale_unit: 'kg', allow_fractional_quantity: true, weight_precision: 3,
  });
  seedProduct(db, 'product-each', 'cat-held-365', 'Each item', 10);

  const app = createApp({
    '/api/held-orders': heldOrderRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    const tableId = 'tbl-test-123';
    seedTable(db, tableId, 1);
    const mockItems = [{
      id: 'latte-line',
      product: { id: 'product-latte', name: 'Latte', price: 100 },
      quantity: 2,
      addons: [],
      special_instructions: '',
    }];
    
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario A: POST /held-orders creates a held order ───');
    
    const postRes = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: {
        tableId,
        items: mockItems,
        customerId: 1,
        guestCount: 2,
        orderNotes: 'Test Note'
      },
      headers: authHeader
    });
    
    assertEqual(postRes.status, 200, 'POST /held-orders returns 200');
    assertEqual(postRes.data.success, true, 'Returns success: true');
    assert(typeof postRes.data.id === 'string' && postRes.data.id.length > 0, 'POST returns the current held-order identity');
    console.log('  ✓ POST /held-orders creates successfully');

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario B: GET /held-orders returns held orders ───');
    
    const getRes = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    assertEqual(getRes.status, 200, 'GET /held-orders returns 200');
    assert(Array.isArray(getRes.data.orders), 'Returns an array of orders');
    assertEqual(getRes.data.orders.length, 1, 'Array contains one order');
    
    const held = getRes.data.orders[0];
    assertEqual(held.tableId, tableId, 'Table ID matches');
    assertEqual(held.guestCount, 2, 'Guest count matches');
    assertEqual(held.orderNotes, 'Test Note', 'Notes match');
    assert(Array.isArray(held.items), 'Items is an array');
    assertEqual(held.items[0].product.name, 'Latte', 'Items parsed correctly');
    console.log('  ✓ GET /held-orders retrieves held order');

    console.log('\n─── Scenario B2: fractional quantities can be held ───');
    const weightedTableId = 'tbl-weighted-365';
    seedTable(db, weightedTableId, 3);
    const weightedItems = [{
      id: 'mango-line',
      product: { id: 'product-mango', name: 'Mango', price: 120, sale_unit: 'kg', allow_fractional_quantity: true },
      quantity: 1.25,
      addons: [],
      special_instructions: '',
    }];
    const weightedPost = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: { tableId: weightedTableId, items: weightedItems },
      headers: authHeader,
    });
    assertEqual(weightedPost.status, 200, 'POST /held-orders accepts fractional weighted quantity');
    const weightedList = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    const weightedHeld = weightedList.data.orders.find((order: any) => order.tableId === weightedTableId);
    assertEqual(weightedHeld?.items[0].quantity, 1.25, 'Fractional quantity survives storage and parsing');
    await api(
      baseUrl,
      `/api/held-orders/${weightedTableId}?heldOrderId=${encodeURIComponent(weightedPost.data.id)}`,
      { method: 'DELETE', headers: authHeader },
    );
    console.log('  ✓ Fractional held-order quantities round-trip');

    const disallowedFraction = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: {
        tableId: weightedTableId,
        items: [{ ...weightedItems[0], product: { id: 'product-each', name: 'Each item', price: 10 }, quantity: 1.25 }],
      },
      headers: authHeader,
    });
    assertEqual(disallowedFraction.status, 400, 'POST /held-orders rejects fractional quantity for a whole-unit product');

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario C: POST /held-orders validates request data ───');
    const invalidRequests = [
      { tableId: 123, items: mockItems },
      { tableId, items: mockItems, guestCount: -1 },
      { tableId, items: mockItems, customerId: {} },
      { tableId, items: [{ ...mockItems[0], quantity: 0 }] },
      { tableId, items: mockItems, orderNotes: 'a'.repeat(201) },
    ];
    for (const body of invalidRequests) {
      const invalidRes = await api(baseUrl, '/api/held-orders', {
        method: 'POST', body, headers: authHeader,
      });
      assertEqual(invalidRes.status, 400, 'Invalid held-order input returns 400');
    }
    console.log('  ✓ POST /held-orders rejects malformed input');

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n─── Scenario D: DELETE /held-orders/:tableId removes order ───');

    const noIdDeleteRes = await api(baseUrl, `/api/held-orders/${tableId}`, { method: 'DELETE', headers: authHeader });
    assertEqual(noIdDeleteRes.status, 200, 'ID-less DELETE returns 200');
    assertEqual(noIdDeleteRes.data.success, true, 'ID-less DELETE returns success');
    assertEqual(noIdDeleteRes.data.deleted, false, 'ID-less DELETE is a non-consuming no-op');
    assertEqual((db.prepare('SELECT status FROM tables WHERE id = ?').get(tableId) as any).status, 'held', 'ID-less DELETE preserves the held table');
    assertEqual((await api(baseUrl, '/api/held-orders', { headers: authHeader })).data.orders.length, 1, 'ID-less DELETE preserves the held order');
    
    const delRes = await api(baseUrl, `/api/held-orders/${tableId}?heldOrderId=${encodeURIComponent(postRes.data.id)}`, { method: 'DELETE', headers: authHeader });
    assertEqual(delRes.status, 200, 'DELETE /held-orders returns 200');
    assertEqual(delRes.data.success, true, 'First DELETE returns success');
    assertEqual(delRes.data.deleted, true, 'First DELETE reports that the row was consumed');
    assertEqual((db.prepare('SELECT status FROM tables WHERE id = ?').get(tableId) as any).status, 'available', 'First DELETE releases the table');
    
    const verifyRes = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    assertEqual(verifyRes.data.orders.length, 0, 'Held orders list is empty after deletion');
    console.log('  ✓ DELETE /held-orders consumes the held order and releases the table');

    // A second terminal can retain the same held-order snapshot and race the
    // first terminal. It must get an explicit no-op result, not a second
    // consumption signal.
    const staleDeleteRes = await api(baseUrl, `/api/held-orders/${tableId}`, { method: 'DELETE', headers: authHeader });
    assertEqual(staleDeleteRes.status, 200, 'Stale DELETE is a successful no-op');
    assertEqual(staleDeleteRes.data.success, true, 'Stale DELETE returns success');
    assertEqual(staleDeleteRes.data.deleted, false, 'Stale DELETE reports that no row was consumed');
    assertEqual((db.prepare('SELECT status FROM tables WHERE id = ?').get(tableId) as any).status, 'available', 'Stale DELETE preserves the released table');
    console.log('  ✓ Stale DELETE cannot consume the same held order twice');

    // Missing credentials must still be rejected before the idempotent
    // deletion path is reached.
    const unauthorizedDeleteRes = await api(baseUrl, `/api/held-orders/${tableId}`, { method: 'DELETE' });
    assertEqual(unauthorizedDeleteRes.status, 401, 'DELETE /held-orders requires authentication');
    console.log('  ✓ DELETE /held-orders keeps its authorization boundary');

    // Replacing a held order for the same table creates a new identity. A
    // terminal retaining the old identity must not delete the replacement.
    console.log('\n─── Scenario E: replacement rows remain single-consumer ───');
    const replacementTableId = 'tbl-replacement-256';
    seedTable(db, replacementTableId, 2);
    const firstReplacement = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: { tableId: replacementTableId, items: mockItems },
      headers: authHeader,
    });
    const firstReplacementId = firstReplacement.data.id;
    const replacementItems = [{ ...mockItems[0], product: { ...mockItems[0].product, name: 'Cappuccino' } }];
    const secondReplacement = await api(baseUrl, '/api/held-orders', {
      method: 'POST',
      body: { tableId: replacementTableId, items: replacementItems },
      headers: authHeader,
    });
    const secondReplacementId = secondReplacement.data.id;
    assert(firstReplacementId !== secondReplacementId, 'Replacing a held order changes its identity');

    const staleReplacementDelete = await api(
      baseUrl,
      `/api/held-orders/${replacementTableId}?heldOrderId=${encodeURIComponent(firstReplacementId)}`,
      { method: 'DELETE', headers: authHeader },
    );
    assertEqual(staleReplacementDelete.data.deleted, false, 'Stale identity cannot delete a replacement row');
    const replacementList = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    const replacement = replacementList.data.orders.find((order: any) => order.tableId === replacementTableId);
    assertEqual(replacement?.id, secondReplacementId, 'Replacement row remains listed after stale deletion');
    assertEqual(replacement?.items[0].product.name, 'Cappuccino', 'Replacement contents remain intact');

    const currentReplacementDelete = await api(
      baseUrl,
      `/api/held-orders/${replacementTableId}?heldOrderId=${encodeURIComponent(secondReplacementId)}`,
      { method: 'DELETE', headers: authHeader },
    );
    assertEqual(currentReplacementDelete.data.deleted, true, 'Current identity can consume the replacement row');

    // ─── Scenario F: malformed legacy rows do not hide valid rows ───
    console.log('\n─── Scenario F: malformed legacy rows are isolated ───');
    db.prepare(`
      INSERT INTO held_orders (id, table_id, items, customer_id, guest_count, order_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ho-valid-legacy', 'tbl-valid-legacy', JSON.stringify(mockItems), null, 1, '', now(), now());
    db.prepare(`
      INSERT INTO held_orders (id, table_id, items, customer_id, guest_count, order_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('ho-malformed', 'tbl-malformed', '{invalid-json', null, 1, '', now(), now());
    const malformedRes = await api(baseUrl, '/api/held-orders', { headers: authHeader });
    assertEqual(malformedRes.status, 200, 'GET /held-orders succeeds with malformed stored data');
    assertEqual(malformedRes.data.orders.length, 1, 'Valid stored rows remain visible');
    assertEqual(malformedRes.data.orders[0].tableId, 'tbl-valid-legacy', 'Valid legacy row is returned');
    assertEqual(malformedRes.data.skippedCount, 1, 'Malformed row count is reported');
    assert(!JSON.stringify(malformedRes.data).includes('JSON'), 'Parser details are not exposed');
    console.log('  ✓ Malformed held orders are isolated');

    console.log('\n✅ All held orders tests passed');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('\n❌ Test failed:');
  console.error(err);
  process.exit(1);
});
