/**
 * Behavioral regression coverage for the held-order client store.
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/held-orders-store.test.ts
 */

const assert = require('node:assert/strict');
const Module = require('module');
const path = require('node:path');
const frontendRequire = Module.createRequire(path.join(process.cwd(), 'frontend/package.json'));
const originalLoad = Module._load;

type HeldOrder = {
  id: string;
  tableId: string;
  items: Array<Record<string, unknown>>;
  customerId: number | string | null;
  guestCount: number;
  orderNotes: string;
  heldAt: string;
};

const serverOrders = new Map<string, HeldOrder>();
let nextOrderId = 0;
let deleteError: Error | null = null;
let deferNextGet = false;
let releaseDeferredGet: (() => void) | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const serverApi = {
  get: async (url: string) => {
    assert.equal(url, '/held-orders');
    const response = { data: { orders: Array.from(serverOrders.values()).map(clone) } };
    if (deferNextGet) {
      deferNextGet = false;
      return new Promise((resolve) => {
        releaseDeferredGet = () => resolve(response);
      });
    }
    return response;
  },
  post: async (url: string, body: { tableId: string; items: HeldOrder['items']; customerId: HeldOrder['customerId']; guestCount: number; orderNotes: string }) => {
    assert.equal(url, '/held-orders');
    const id = `ho-${body.tableId}-${++nextOrderId}`;
    serverOrders.set(body.tableId, {
      id,
      tableId: body.tableId,
      items: clone(body.items),
      customerId: body.customerId,
      guestCount: body.guestCount,
      orderNotes: body.orderNotes,
      heldAt: '2026-08-01T00:00:00.000Z',
    });
    return { data: { success: true, id } };
  },
  delete: async (url: string) => {
    assert.match(url, /^\/held-orders\//);
    if (deleteError) {
      const error = deleteError;
      deleteError = null;
      throw error;
    }

    const parsed = new URL(url, 'http://localhost');
    const tableId = parsed.pathname.slice('/held-orders/'.length);
    const expectedHeldOrderId = parsed.searchParams.get('heldOrderId');
    const current = serverOrders.get(tableId);
    const deleted = !!current && (!expectedHeldOrderId || current.id === expectedHeldOrderId);
    if (deleted) serverOrders.delete(tableId);
    return { data: { success: true, deleted } };
  },
};

// The store uses the production alias import. Keep this test a direct store
// behavior test without requiring a browser or a Next.js runtime.
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === '@/lib/api') return serverApi;
  if (request === 'zustand') return originalLoad.call(this, frontendRequire.resolve('zustand'), parent, isMain);
  return originalLoad.apply(this, arguments as any);
};

const { createHeldOrdersStore } = require('../frontend/src/store/held-orders');

function makeHeldOrder(tableId: string): HeldOrder {
  return {
    id: `ho-${tableId}`,
    tableId,
    items: [{
      id: `item-${tableId}`,
      product: { id: `product-${tableId}`, name: 'Latte', price: 100 },
      quantity: 1,
      addons: [],
      special_instructions: '',
    }],
    customerId: null,
    guestCount: 1,
    orderNotes: '',
    heldAt: '2026-08-01T00:00:00.000Z',
  };
}

async function main() {
  console.log('Held-order client store regression tests (#256)');
  console.log('='.repeat(60));

  serverOrders.clear();
  nextOrderId = 0;
  serverOrders.set('table-a', makeHeldOrder('table-a'));
  serverOrders.set('table-b', makeHeldOrder('table-b'));

  const firstTerminal = createHeldOrdersStore(serverApi);
  const secondTerminal = createHeldOrdersStore(serverApi);

  await firstTerminal.getState().fetchHeldOrders();
  await secondTerminal.getState().fetchHeldOrders();
  assert.equal(firstTerminal.getState().hasHeldOrder('table-a'), true, 'first terminal caches the held order');
  assert.equal(secondTerminal.getState().hasHeldOrder('table-a'), true, 'second terminal retains the same held-order snapshot');

  const restored = await firstTerminal.getState().restoreOrder('table-a');
  assert.equal(restored?.tableId, 'table-a', 'first consumer receives the held order');
  assert.equal(firstTerminal.getState().hasHeldOrder('table-a'), false, 'first consumer clears its cache after consumption');
  assert.equal(serverOrders.has('table-a'), false, 'first consumer removes the server row');

  const staleRestore = await secondTerminal.getState().restoreOrder('table-a');
  assert.equal(staleRestore, null, 'second consumer does not restore an already-consumed snapshot');
  assert.equal(secondTerminal.getState().hasHeldOrder('table-a'), false, 'second consumer clears its stale cache');

  await secondTerminal.getState().fetchHeldOrders();
  assert.equal(secondTerminal.getState().hasHeldOrder('table-a'), false, 'reloading does not resurrect the consumed order');
  assert.equal(secondTerminal.getState().hasHeldOrder('table-b'), true, 'reloading preserves still-held orders');

  const replacement = makeHeldOrder('table-b');
  replacement.id = 'ho-table-b-replacement';
  replacement.items[0].product = { id: 'product-new', name: 'Cappuccino', price: 120 };
  serverOrders.set('table-b', replacement);
  const staleReplacementRestore = await secondTerminal.getState().restoreOrder('table-b');
  assert.equal(staleReplacementRestore, null, 'a stale snapshot cannot delete and restore a replacement row');
  assert.deepEqual(serverOrders.get('table-b'), replacement, 'replacement row remains after stale restore');
  assert.equal(secondTerminal.getState().hasHeldOrder('table-b'), false, 'replacement conflict clears the stale cache');

  await secondTerminal.getState().fetchHeldOrders();
  assert.equal(secondTerminal.getState().getHeldOrder('table-b')?.id, replacement.id, 'reload picks up the replacement row');

  deferNextGet = true;
  const staleReload = secondTerminal.getState().fetchHeldOrders();
  const currentReplacementRestore = await secondTerminal.getState().restoreOrder('table-b');
  assert.equal(currentReplacementRestore?.id, replacement.id, 'current replacement identity can still be consumed');
  assert.equal(typeof releaseDeferredGet, 'function', 'older reload remains pending while deletion completes');
  releaseDeferredGet?.();
  releaseDeferredGet = null;
  await staleReload;
  assert.equal(secondTerminal.getState().hasHeldOrder('table-b'), false, 'an older reload cannot resurrect a locally consumed order');

  await secondTerminal.getState().removeHeldOrder('table-a');
  assert.equal(secondTerminal.getState().hasHeldOrder('table-a'), false, 'repeated deletion remains safe after stale cleanup');

  serverOrders.set('table-c', makeHeldOrder('table-c'));
  await secondTerminal.getState().fetchHeldOrders();
  assert.equal(secondTerminal.getState().hasHeldOrder('table-c'), true, 'reload caches a new held order before retrying an error');
  deleteError = new Error('unauthorized');
  await assert.rejects(
    () => secondTerminal.getState().restoreOrder('table-c'),
    /unauthorized/,
    'delete errors are surfaced to the caller',
  );
  assert.equal(secondTerminal.getState().hasHeldOrder('table-c'), true, 'delete errors retain the cached order for retry');
  assert.equal(serverOrders.has('table-c'), true, 'delete errors do not consume the server row');

  console.log('\n✅ Held-order client store regression tests passed');
}

main()
  .catch((error: unknown) => {
    console.error('\n❌ Test failed:');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
