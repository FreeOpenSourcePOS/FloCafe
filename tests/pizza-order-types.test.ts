/**
 * The order types the POS switch offers: the store's `pos_order_types` setting
 * narrows them, the first one offered is the default for a new order, and an
 * order that already has a hidden type keeps it.
 *
 * Run: npm run test:pizza-order-types
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  runCases,
} = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');

// What the browser would keep between visits, so the test can read it.
const kept = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
  removeItem: (key: string) => void kept.delete(key),
};
// The store picks its storage when it is made; nothing else here may think it is in a browser.
(globalThis as any).window = { localStorage };
const { usePosSettingsStore } = require('../frontend/src/store/pos-settings');
delete (globalThis as any).window;
loadFrontend();
const { offeredOrderTypes, orderTypeToStartOn } = require('../frontend/src/lib/pizza/order-types');

const ALL = ['dine_in', 'takeaway', 'delivery', 'online'];
const COUNTER = ['takeaway', 'delivery'];
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${JSON.stringify(actual)})`);
const store = () => usePosSettingsStore.getState();

runCases('pizza-order-types', {
  'Case 1: with no setting every type is offered, as upstream does': () => {
    same(offeredOrderTypes(ALL, []), ALL, 'an empty setting hides nothing');
    same(offeredOrderTypes(ALL, ['curbside']), ALL, 'a setting that names no known type too');
  },

  'Case 2: a counter store offers takeaway and delivery, takeaway first': () => {
    same(offeredOrderTypes(ALL, COUNTER), COUNTER, 'dine-in and online are hidden');
    same(offeredOrderTypes(ALL, ['delivery', 'takeaway']), COUNTER, 'in the switch order');
    same(
      offeredOrderTypes(['takeaway', 'delivery', 'online'], ['dine_in', 'online']),
      ['online'],
      'a type the store never had is not brought back',
    );
  },

  'Case 3: an order that already has a hidden type keeps it on the switch': () => {
    same(offeredOrderTypes(ALL, COUNTER, 'dine_in'), ['dine_in', ...COUNTER], 'dine-in order');
    same(offeredOrderTypes(ALL, COUNTER, 'delivery'), COUNTER, 'an offered type adds nothing');
    same(offeredOrderTypes(ALL, COUNTER, null), COUNTER, 'a new order adds nothing');
  },

  'Case 3b: a new order moves off a hidden type only when the setting narrowed the switch': () => {
    const RETAIL = ['takeaway', 'delivery', 'online'];
    assertEqualOrThrow(
      orderTypeToStartOn(RETAIL, [], 'dine_in'),
      null,
      'no setting: a store whose business type hides dine-in keeps the cart as upstream has it',
    );
    assertEqualOrThrow(orderTypeToStartOn(RETAIL, ['curbside'], 'dine_in'), null, 'nor a bad one');
    assertEqualOrThrow(orderTypeToStartOn(ALL, [], 'dine_in'), null, 'nor a restaurant');
    assertEqualOrThrow(orderTypeToStartOn(ALL, COUNTER, 'dine_in'), 'takeaway', 'a counter does');
    assertEqualOrThrow(orderTypeToStartOn(ALL, COUNTER, 'online'), 'takeaway', 'from online too');
    assertEqualOrThrow(orderTypeToStartOn(ALL, COUNTER, 'delivery'), null, 'an offered type stays');
    assertEqualOrThrow(
      orderTypeToStartOn(ALL, COUNTER, 'dine_in', 'dine_in'),
      null,
      'an order being added to keeps its type',
    );
  },

  'Case 4: the browser store takes the setting from the business settings': () => {
    same(store().posOrderTypes, [], 'it starts with every type offered');
    store().hydrateReceiptSettings({ pos_order_types: COUNTER });
    same(store().posOrderTypes, COUNTER, 'the list is stored');
    store().hydrateReceiptSettings({ bill_show_name: true });
    same(store().posOrderTypes, COUNTER, 'a response without the key leaves it');
    store().hydrateReceiptSettings({ pos_order_types: [] });
    assertEqualOrThrow(store().posOrderTypes.length, 0, 'an empty list offers every type again');
  },

  'Case 5: the setting is never kept in the browser, so a new cart waits for the store': () => {
    store().hydrateReceiptSettings({ pos_order_types: COUNTER });
    const saved = JSON.parse(kept.get('pos-settings') ?? '{}').state ?? {};
    assertOrThrow(!('posOrderTypes' in saved), 'the list is left out of what the browser keeps');
    assertOrThrow('tablesRequired' in saved, 'while other settings are still kept');
    store().hydrateReceiptSettings({ pos_order_types: [] });
  },

  'Case 6: signing out or changing store empties the list, so the next store starts unrestricted':
    () => {
      require('../frontend/src/hooks/useReceiptSettingsSync');
      const { useAuthStore } = require('../frontend/src/store/auth');
      const tenant = (id: number) => ({ id, role: 'owner', country: 'CA', timezone: 'UTC' });
      useAuthStore.setState({ currentTenant: tenant(1) });
      store().hydrateReceiptSettings({ pos_order_types: COUNTER });
      useAuthStore.setState({ currentTenant: { ...tenant(1) } });
      same(store().posOrderTypes, COUNTER, 'the same store keeps its list');
      useAuthStore.setState({ currentTenant: tenant(2) });
      same(store().posOrderTypes, [], 'another store does not inherit it');
      store().hydrateReceiptSettings({ pos_order_types: COUNTER });
      useAuthStore.setState({ currentTenant: null });
      same(store().posOrderTypes, [], 'signing out empties it');
    },
});
