import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLoadedOrderPages, matchesOrderSearch } from '../frontend/src/lib/orders-search';

const order = (overrides = {}) => ({
  order_number: 'A-1024',
  customer: { name: 'Anita Sharma', phone: '+919876543210' },
  ...overrides,
});

test('matches order number (existing behavior)', () => {
  assert.equal(matchesOrderSearch(order(), 'a-102'), true);
});

test('matches customer name case-insensitively', () => {
  assert.equal(matchesOrderSearch(order(), 'anita'), true);
  assert.equal(matchesOrderSearch(order(), 'SHARMA'), true);
});

test('matches phone digits ignoring formatting', () => {
  assert.equal(matchesOrderSearch(order(), '+91 98765'), true);
  assert.equal(matchesOrderSearch(order(), '987-654-3210'), true);
});

test('no match returns false', () => {
  assert.equal(matchesOrderSearch(order(), 'zzz'), false);
});

test('order without customer does not crash', () => {
  assert.equal(matchesOrderSearch(order({ customer: null }), 'anita'), false);
  assert.equal(matchesOrderSearch(order({ customer: null }), 'a-102'), true);
});

test('mixed name+digit query does not fall back to phone matching', () => {
  assert.equal(matchesOrderSearch(order(), 'Alice 2'), false);
});

test('empty query matches everything', () => {
  assert.equal(matchesOrderSearch(order(), ''), true);
  assert.equal(matchesOrderSearch(order(), '   '), true);
});

test('refreshes the loaded search pages from current results', async () => {
  const cursors: Array<number | undefined> = [];
  const refreshed = await fetchLoadedOrderPages(async (cursor) => {
    cursors.push(cursor);
    if (cursor === undefined) {
      return { orders: [{ id: 52, status: 'new' }], nextCursor: 50 };
    }
    return { orders: [{ id: 49, status: 'updated' }], nextCursor: null };
  }, 2);

  assert.deepEqual(cursors, [undefined, 50]);
  assert.deepEqual(refreshed.orders, [
    { id: 52, status: 'new' },
    { id: 49, status: 'updated' },
  ]);
  assert.equal(refreshed.nextCursor, null);
});

test('stops refreshing when the current results have no next page', async () => {
  let calls = 0;
  const refreshed = await fetchLoadedOrderPages(async () => {
    calls++;
    return { orders: [{ id: 52, status: 'new' }], nextCursor: null };
  }, 3);

  assert.equal(calls, 1);
  assert.deepEqual(refreshed.orders, [{ id: 52, status: 'new' }]);
});
