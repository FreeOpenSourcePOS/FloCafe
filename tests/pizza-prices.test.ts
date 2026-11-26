/**
 * Prices the owner sets in the POS: kept apart from the menu file, applied on top of it by
 * every menu load, and changed through `/api/pizza/prices`.
 *
 * Sample prices: sizes 15.00, 19.00 and 23.00, a topping 2.25, a dip 1.25, a can 1.75,
 * the party deal 118.40. Half of a 2.75 topping is 1.375, rounded half-up to 1.38.
 *
 * Run: npm run test:pizza-prices
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  runCases,
  createApp,
  startServer,
  api,
} = require('./helpers/pizza-print-harness');
const jwt = require('jsonwebtoken');
const { initDatabase, getDatabase } = require('../main/db');
const { registerRoutes } = require('../main/routes/index');
const { getJWTSecret } = require('../main/routes/auth');
const sample = require('./fixtures/pizza-sample-menu.json');

const json = (value: unknown) => JSON.stringify(value);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(json(actual), json(expected), message);
/** The same rows whatever order they were written in. */
const byId = (prices: Record<string, number>) =>
  json(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)));
const copy = (): any => JSON.parse(json(sample));
const PIZZAS = ['classic', 'garden', 'half-and-half', 'island', 'plain', 'smokehouse'];

async function main() {
  const app = createApp({});
  registerRoutes(app);
  const { baseUrl } = await startServer(app);
  initDatabase();
  const db = getDatabase();

  const setup = await api(baseUrl, '/api/auth/setup/initialize', {
    method: 'POST',
    body: {
      name: 'Pizza Owner',
      email: 'owner@example.com',
      password: 'TestPass123',
      business_type: 'restaurant',
      business_name: 'Sample Pizza Shop',
      setup_profile: 'pizza',
      terms_accepted: true,
      owner_approval_pin: '5678',
      owner_approval_pin_confirmation: '5678',
      country: 'CA',
      currency: 'CAD',
      timezone: 'America/Vancouver',
    },
  });
  assertEqualOrThrow(setup.status, 200, 'first-time setup accepts the pizza profile');
  const owner = { Authorization: `Bearer ${setup.data.access_token}` };
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active)
     VALUES ('cashier-1', 'Test cashier', 'cashier-1@test.local', 'x', 'cashier', 1)`,
  ).run();
  const cashier = {
    Authorization: `Bearer ${jwt.sign({ userId: 'cashier-1', role: 'cashier' }, getJWTSecret())}`,
  };

  const loadMenu = async (menu: object = sample) => {
    const answer = await api(baseUrl, '/api/pizza/menu/import', {
      method: 'POST',
      headers: owner,
      body: menu,
    });
    assertEqualOrThrow(answer.status, 200, `the menu loads (${answer.data?.error})`);
    return answer.data;
  };
  const read = (headers: object = owner) => api(baseUrl, '/api/pizza/prices', { headers });
  const put = (prices: unknown, headers: object = owner) =>
    api(baseUrl, '/api/pizza/prices', {
      method: 'PUT',
      headers,
      body: { prices },
    });
  /** Saves prices that must be accepted and returns the list the API answered. */
  const save = async (prices: object) => {
    const answer = await put(prices);
    assertEqualOrThrow(answer.status, 200, `saved ${json(prices)} (${answer.data?.error})`);
    return answer.data;
  };
  const priceOf = (list: any, key: string) => list.prices.find((entry: any) => entry.key === key);
  /** Every price the catalogue holds, by `"<table>:<id>"`. */
  const sold = (): Record<string, number> =>
    Object.fromEntries(
      ['products', 'product_variants', 'addons'].flatMap((table) =>
        (db.prepare(`SELECT id, price FROM ${table} ORDER BY id`).all() as any[]).map((row) => [
          `${table}:${row.id}`,
          row.price,
        ]),
      ),
    );
  /** The rows whose price differs between two readings of `sold()`, with the new price. */
  const changed = (before: Record<string, number>, after = sold()) =>
    byId(Object.fromEntries(Object.entries(after).filter(([id, price]) => before[id] !== price)));
  const stored = () =>
    JSON.parse((db.prepare('SELECT catalog FROM pizza_menu WHERE id = 1').get() as any).catalog);
  const overrides = () =>
    db.prepare('SELECT key, price_cents FROM pizza_price_overrides ORDER BY key').all();
  /** Everything a price change could write. */
  const dump = () =>
    json([sold(), overrides(), db.prepare('SELECT catalog, owned_rows FROM pizza_menu').all()]);
  const order = (items: object[]) =>
    api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner,
      body: { type: 'takeaway', items },
    });
  const largeGarden = {
    product_id: 'pz-garden',
    variant_id: 'pz-garden-large',
    quantity: 1,
  };

  await runCases('pizza prices', {
    'Case 1: before a menu is loaded there are no prices to read or set': async () => {
      assertEqualOrThrow((await read()).status, 404, 'reading answers 404');
      const answer = await put({ 'size:large': 24 });
      assertEqualOrThrow(answer.status, 404, 'saving answers 404');
      same(overrides(), [], 'and nothing is stored');
    },

    'Case 2: the list has one row per price, each at the price of the file': async () => {
      await loadMenu();
      const list = (await read()).data;
      same(
        list.prices.map((entry: any) => `${entry.key}=${entry.price}`),
        [
          'size:small=15',
          'size:medium=19',
          'size:large=23',
          'topping=2.25',
          'dip=1.25',
          'side:wings=12.25',
          'side:green-salad=5.49',
          'side:garlic-toast=2.5',
          'side:pasta=11',
          'drink:can=1.75',
          'drink:2l=4.5',
          'deal:large-combo=35.5',
          'deal:three-large-wings=71.25',
          'deal:party=118.4',
          'deal:pasta-night=29.99',
        ],
        'sizes, the topping, the dip, sides, drink sizes and deals, in menu order',
      );
      same(
        priceOf(list, 'size:large'),
        {
          key: 'size:large',
          group: 'size',
          label: 'Large',
          count: 5,
          file: 23,
          price: 23,
          overridden: false,
        },
        'a row names its price, how many items it is on, and both amounts',
      );
      same(
        ['topping', 'dip', 'drink:can', 'deal:party'].map((key) => {
          const { group, label, count } = priceOf(list, key);
          return `${group}|${label}|${count}`;
        }),
        ['topping|Topping|1', 'dip|Dip|2', 'drink|Can|3', 'deal|Party Pack|1'],
        'the dip counts its two dips and a drink size its three drinks',
      );
      assertOrThrow(
        list.prices.every((entry: any) => entry.file === entry.price && !entry.overridden),
        'nothing is overridden yet',
      );
      same(list.unused, [], 'and no override is unused');
    },

    'Case 3: a size price changes that size of every pizza and nothing else': async () => {
      const before = sold();
      const list = await save({ 'size:large': 24 });
      same(
        changed(before),
        byId(Object.fromEntries(PIZZAS.map((id) => [`product_variants:pz-${id}-large`, 24]))),
        'the large variant of the five pizzas and of the half and half, and no other row',
      );
      same(
        priceOf(list, 'size:large'),
        {
          key: 'size:large',
          group: 'size',
          label: 'Large',
          count: 5,
          file: 23,
          price: 24,
          overridden: true,
        },
        'the list shows the price of the file beside the price in force',
      );
      assertEqualOrThrow(
        stored().sizes.find((size: any) => size.id === 'large').priceCents,
        2400,
        'the stored catalogue carries the price in force',
      );
      same(overrides(), [{ key: 'size:large', price_cents: 2400 }], 'one override is stored');
      const catalog = await api(baseUrl, '/api/pizza/catalog', {
        headers: owner,
      });
      assertEqualOrThrow(catalog.data.sizes[2].priceCents, 2400, 'and the browser reads it');
    },

    'Case 4: a reload keeps the override, whatever price the file now has': async () => {
      const menu = copy();
      menu.sizes.pizza[1].price = 20;
      menu.sizes.pizza[2].price = 22;
      const before = sold();
      await loadMenu(menu);
      same(
        changed(before),
        byId(Object.fromEntries(PIZZAS.map((id) => [`product_variants:pz-${id}-medium`, 20]))),
        'medium follows the file and large keeps the price set in the POS',
      );
      const list = (await read()).data;
      assertEqualOrThrow(priceOf(list, 'size:large').file, 22, 'the list shows the new file price');
      assertEqualOrThrow(priceOf(list, 'size:large').price, 24, 'beside the price in force');

      const again = dump();
      const summary = await loadMenu(menu);
      assertEqualOrThrow(dump(), again, 'loading the same file again changes nothing');
      assertEqualOrThrow(summary.updated + summary.created, 0, 'and the summary says so');
    },

    "Case 5: taking an override off returns the file's price": async () => {
      const list = await save({ 'size:large': null });
      same(overrides(), [], 'the override is gone');
      assertEqualOrThrow(
        sold()['product_variants:pz-garden-large'],
        22,
        'large costs what the file last loaded says',
      );
      assertEqualOrThrow(stored().sizes[2].priceCents, 2200, 'in the stored catalogue too');
      assertEqualOrThrow(priceOf(list, 'size:large').overridden, false, 'and the list says so');
      await loadMenu();
    },

    'Case 6: the topping price changes both topping add-ons': async () => {
      const before = sold();
      await save({ topping: 2.75 });
      same(
        changed(before),
        byId({ 'addons:ad-topping': 2.75, 'addons:ad-topping-half': 1.38 }),
        'the whole topping, and half of it rounded half-up, and no other row',
      );
      assertEqualOrThrow(stored().toppings.priceCents, 275, 'the stored catalogue carries it');
    },

    'Case 7: a dip, a side, a drink size and a deal each change their own rows': async () => {
      let before = sold();
      await save({ dip: 1.5 });
      same(
        changed(before),
        byId({
          'products:sd-dip': 1.5,
          'addons:ad-dips-ranch': 1.5,
          'addons:ad-dips-garlic': 1.5,
        }),
        'the dip sold alone and each dip on a pizza',
      );
      same(
        [stored().dips.map((dip: any) => dip.priceCents), stored().sides[3].priceCents],
        [[150, 150], 150],
        'the stored catalogue carries the dip price in both places',
      );

      before = sold();
      await save({ 'side:wings': 13, 'drink:can': 2, 'deal:party': 120 });
      same(
        changed(before),
        byId({
          'products:dl-party': 120,
          'products:dr-cola': 2,
          'products:dr-ginger-ale': 2,
          'products:dr-lemon-lime': 2,
          'products:sd-wings': 13,
          'product_variants:dr-cola-can': 2,
          'product_variants:dr-ginger-ale-can': 2,
          'product_variants:dr-lemon-lime-can': 2,
        }),
        "the side, the deal, and the can of every drink with the drink's own lowest price",
      );
      same(
        overrides(),
        [
          { key: 'deal:party', price_cents: 12000 },
          { key: 'dip', price_cents: 150 },
          { key: 'drink:can', price_cents: 200 },
          { key: 'side:wings', price_cents: 1300 },
          { key: 'topping', price_cents: 275 },
        ],
        'every price set in the POS is stored under its own key',
      );
    },

    'Case 8: an override for something the file no longer has is kept, unused': async () => {
      const menu = copy();
      const deals = menu.categories.find((category: any) => category.id === 'deals');
      deals.items = deals.items.filter((deal: any) => deal.id !== 'party');
      delete menu.toppings;
      await loadMenu(menu);
      const list = (await read()).data;
      same(
        list.unused,
        [
          { key: 'deal:party', price: 120 },
          { key: 'topping', price: 2.75 },
        ],
        'the list names the overrides the menu has no item for',
      );
      assertOrThrow(!priceOf(list, 'deal:party'), 'and has no row for them');
      assertEqualOrThrow(overrides().length, 5, 'none is deleted');
      const refused = await put({ 'deal:party': 121 });
      assertEqualOrThrow(refused.status, 400, 'a price for an item not on the menu is refused');

      await loadMenu();
      same(
        [sold()['products:dl-party'], sold()['addons:ad-topping']],
        [120, 2.75],
        'the file that has them again is loaded at the prices set in the POS',
      );
      same((await read()).data.unused, [], 'and nothing is unused any more');

      await loadMenu(menu);
      const dropped = await save({ topping: null });
      same(
        dropped.unused,
        [{ key: 'deal:party', price: 120 }],
        'an unused override can be taken off',
      );
      await loadMenu();
    },

    'Case 9: a bad amount is refused and nothing is written': async () => {
      const before = dump();
      const bad: Array<[label: string, prices: unknown]> = [
        ['a negative amount', { 'size:large': -1 }],
        ['a fraction of a cent', { 'size:large': 23.005 }],
        ['text', { 'size:large': '24' }],
        ['an amount too large to be a price', { 'size:large': 1000000 }],
        ['a key the menu does not have', { 'size:huge': 30 }],
        ['a bad amount beside a good one', { 'size:small': 16, 'size:large': -1 }],
        ['a list', [24]],
        ['nothing', undefined],
      ];
      for (const [label, prices] of bad) {
        const answer = await put(prices);
        assertEqualOrThrow(answer.status, 400, `${label} is refused`);
        assertOrThrow(typeof answer.data.error === 'string', `${label} has a message`);
        assertEqualOrThrow(dump(), before, `${label} writes nothing`);
      }
      assertEqualOrThrow(
        (await put({ 'size:large': 23.005 })).data.error,
        'Large: 23.005 is not an amount in CAD. Use a price from 0 to 99999.99 with at most 2 decimal places.',
        'the message names the price and the currency',
      );
    },

    'Case 10: an order already placed keeps its price, and the next one is charged the new price':
      async () => {
        const first = await order([largeGarden]);
        assertEqualOrThrow(first.status, 201, `the order is placed (${first.data?.error})`);
        const placed = () =>
          json([
            db
              .prepare('SELECT subtotal, tax_amount, total FROM orders WHERE id = ?')
              .get(first.data.order.id),
            db
              .prepare(
                'SELECT unit_price, subtotal, tax_amount, total FROM order_items WHERE order_id = ?',
              )
              .all(first.data.order.id),
          ]);
        const before = placed();
        assertEqualOrThrow(Number(first.data.order.subtotal), 23, 'it was charged 23.00');

        await save({ 'size:large': 25 });

        assertEqualOrThrow(placed(), before, 'the placed order and its line are unchanged');
        const second = await order([largeGarden]);
        assertEqualOrThrow(
          Number(second.data.order.subtotal),
          25,
          'the next order is charged 25.00',
        );
        await save({ 'size:large': null });
      },

    'Case 11: a cashier reads the prices and may not change them': async () => {
      const before = dump();
      assertEqualOrThrow((await read(cashier)).status, 200, 'a cashier reads the list');
      assertEqualOrThrow((await put({ 'size:large': 1 }, cashier)).status, 403, 'and may not save');
      assertEqualOrThrow((await read({})).status, 401, 'reading needs a session');
      assertEqualOrThrow((await put({ 'size:large': 1 }, {})).status, 401, 'and so does saving');
      assertEqualOrThrow(dump(), before, 'nothing was written');
    },

    'Case 12: a stored menu that cannot be read is said so, and no price is saved': async () => {
      db.prepare('UPDATE pizza_menu SET catalog = \'{"sizes":[\'').run();
      const before = dump();
      const answers = [await read(), await put({ 'size:large': 24 })];
      same(
        answers.map((answer) => [answer.status, answer.data.error]),
        Array(2).fill([503, 'The pizza menu is not loaded. Load the menu file again.']),
        'reading and saving both answer 503 with what to do',
      );
      assertEqualOrThrow(dump(), before, 'nothing was written');
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
