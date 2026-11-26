/**
 * Recipe lines on kitchen display items: every server path that prepares an
 * item for the kitchen display puts the kitchen ticket's lines on a pizza or
 * deal line as `recipe_lines`, built at 48 columns, and leaves every other
 * item exactly as it was.
 *
 * Run: npm run test:pizza-kds-lines
 */
process.env.KDS_PORT = '0';

const {
  assertOrThrow,
  assertEqualOrThrow,
  runCases,
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
  now,
} = require('./helpers/pizza-print-harness');
const { seedPizzaMenu, writePizzaMenu } = require('./helpers/pizza-fixture');
const { createHash } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { projectKdsItem } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { kdsRoutes } = require('../main/routes/kds');
const { kitchenRoutes } = require('../main/routes/kitchen');
const { orderItemRoutes } = require('../main/routes/order-items');
const { startKdsServer, stopKdsServer, getKdsPort } = require('../main/kds-server');
const { buildActiveOrdersSnapshot } = require('../main/services/kds');
const { ticketLines } = require('../shared/pizza/ticket');
const { withRecipeDetailLines } = require('../main/pizza/order-recipe');

const COLUMNS = 48;
const NOT_PRINTED = ['RECIPE NOT PRINTED - CHECK ORDER'];
const STATION = 'kds-lines-station';

const whole = (pizzaId: string, removed: string[] = []) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  whole: { pizzaId, removed },
});
const half = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [
    { pizzaId: 'island', removed: ['Pineapple'] },
    { pizzaId: 'classic', removed: [] },
  ],
};
const threeLarge = {
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [
    whole('garden', ['Olives']),
    {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      halves: [
        { pizzaId: 'island', removed: [] },
        { pizzaId: 'plain', removed: [] },
      ],
    },
    whole('classic'),
  ],
  wingFlavour: 'sweet-chili',
};
// Every Garden ingredient removed: one line at 48 columns breaks where 42 columns could not reach.
const bare = whole('garden', [
  'Cheese',
  'Green peppers',
  'Mushrooms',
  'Olives',
  'Onions',
  'Tomato sauce',
]);

// The contract's ticket text.
const HALF_LINES = ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC PEPPERONI'];
const DEAL_LINES = [
  '1) LARGE GARDEN',
  '   NO OLIVES',
  '2) LARGE HALF & HALF',
  '   1ST: ISLAND',
  '   2ND: PLAIN CHEESE',
  '3) LARGE CLASSIC PEPPERONI',
  'WINGS: SWEET CHILI',
  'INCLUDES: ANY 3 LARGE PIZZAS & 12 WINGS',
];

const PLAIN_ITEMS = [
  { product_id: 'pz-garden', variant_id: 'pz-garden-large', quantity: 1 },
  { product_id: 'sd-green-salad', quantity: 2, special_instructions: 'Dressing on the side' },
];
const RECIPE_ITEMS = [
  {
    product_id: 'pz-half-and-half',
    variant_id: 'pz-half-and-half-large',
    quantity: 1,
    modifier_selection: half,
  },
  { product_id: 'dl-three-large-wings', quantity: 1, modifier_selection: threeLarge },
  ...PLAIN_ITEMS,
  {
    product_id: 'pz-garden',
    variant_id: 'pz-garden-large',
    quantity: 1,
    modifier_selection: bare,
  },
];

type Who = { headers: Record<string, string>; restricted: boolean };

/** Every object in a payload that is a line of the given order, in payload order. */
function itemsIn(payload: unknown, orderId: number): any[] {
  if (!payload || typeof payload !== 'object') return [];
  const node = payload as Record<string, unknown>;
  if ('product_id' in node && Number(node.order_id) === orderId) return [node];
  return Object.values(node).flatMap((value) => itemsIn(value, orderId));
}

/** A payload as text, with the clock taken out so that the same order hashes the same every run. */
const stable = (payload: unknown): string =>
  JSON.stringify(payload, (key, value) =>
    typeof value === 'string' && /(_at|_time)$/.test(key) ? '<time>' : value,
  );
const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Every payload for an order that holds no recipe, hashed from the code as it
 * was before kitchen display items carried recipe lines. A hash moves only when
 * upstream changes a kitchen display payload; print the current values with
 * `PIZZA_KDS_BASELINE=print npm run test:pizza-kds-lines`.
 */
const BASELINE: Record<string, string> = {
  'main API, GET /api/kitchen/orders, an owner': '7238afb42fcdff44',
  'main API, GET /api/kds/orders, an owner': '7ff5d6723f8732df',
  'main API, GET /api/kds/display, an owner': '688a365ca0245782',
  'kitchen display server, GET /api/kds/orders, an owner': '9ae502de5797d5f9',
  'live broadcast, buildActiveOrdersSnapshot, an owner': '4ac72193d15978f4',
  'main API, PATCH /api/kds/items/:id/status, an owner': '43912674f63dd272',
  'main API, PATCH /api/order-items/:id/status, an owner': '90a209c2009abf1b',
  'main API, GET /api/kitchen/orders, a restricted station': 'ad1f37f13f10dc5a',
  'main API, GET /api/kds/orders, a restricted station': 'dcd154d0340a404f',
  'main API, GET /api/kds/display, a restricted station': '04968522ab732ab0',
  'kitchen display server, GET /api/kds/orders, a restricted station': '9aceef24bb5fe434',
  'live broadcast, buildActiveOrdersSnapshot, a restricted station': 'e7b7cc802b21ecfe',
  'main API, PATCH /api/kds/items/:id/status, a restricted station': '2938b228e216078d',
  'main API, PATCH /api/order-items/:id/status, a restricted station': '2f5bac7aa248e3b4',
};

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('kds-lines-chef', 'Line Chef', 'kds-lines-chef@test.local', ?, 'chef', 1, ?, ?)`,
  ).run(bcrypt.hashSync('testpass123', 10), now(), now());
  db.prepare(
    `INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
     VALUES (?, 'Line Station', NULL, 1, ?, ?)`,
  ).run(STATION, now(), now());
  const chefToken = jwt.sign({ userId: 'kds-lines-chef', role: 'chef' }, getJWTSecret(), {
    expiresIn: '1h',
  });
  const everyone: Record<string, Who> = {
    'an owner': { headers: owner.authHeader, restricted: false },
    'a restricted station': {
      headers: { Authorization: `Bearer ${chefToken}` },
      restricted: true,
    },
  };

  const { baseUrl } = await startServer(
    createApp({
      '/api/orders': orderRoutes,
      '/api/kds': kdsRoutes,
      '/api/kitchen': kitchenRoutes,
      '/api/order-items': orderItemRoutes,
    }),
  );
  await startKdsServer();
  const kdsServerUrl = `http://127.0.0.1:${getKdsPort()}`;

  const call = async (base: string, path: string, who: Who, body?: object) => {
    const answer = await api(base, path, {
      headers: who.headers,
      ...(body ? { method: 'PATCH', body } : {}),
    });
    assertEqualOrThrow(answer.status, 200, `${body ? 'PATCH' : 'GET'} ${path} answers`);
    return answer.data;
  };
  const itemIds = (orderId: number): number[] =>
    db
      .prepare('SELECT id FROM order_items WHERE order_id = ? ORDER BY id')
      .all(orderId)
      .map((row: any) => row.id);

  /** Each server path that prepares kitchen display items, answering its whole payload. */
  const PATHS: Record<string, (who: Who, orderId: number) => Promise<unknown>> = {
    'main API, GET /api/kitchen/orders': (who) => call(baseUrl, '/api/kitchen/orders', who),
    'main API, GET /api/kds/orders': (who) => call(baseUrl, '/api/kds/orders', who),
    'main API, GET /api/kds/display': (who) =>
      call(baseUrl, `/api/kds/display?station_id=${STATION}`, who),
    'kitchen display server, GET /api/kds/orders': (who) =>
      call(kdsServerUrl, '/api/kds/orders', who),
    'live broadcast, buildActiveOrdersSnapshot': async (who) =>
      JSON.parse(buildActiveOrdersSnapshot([], [], who.restricted)),
    'main API, PATCH /api/kds/items/:id/status': async (who, orderId) => {
      const answers = [];
      for (const id of itemIds(orderId))
        answers.push(await call(baseUrl, `/api/kds/items/${id}/status`, who, { status: 'ready' }));
      return answers;
    },
    'main API, PATCH /api/order-items/:id/status': (who, orderId) =>
      call(baseUrl, `/api/order-items/${itemIds(orderId)[0]}/status`, who, {
        status: 'preparing',
      }),
  };

  const placeOrder = async (items: object[]): Promise<number> => {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items },
      headers: owner.authHeader,
    });
    assertEqualOrThrow(created.status, 201, 'the order is accepted');
    return created.data.order.id;
  };
  /** Runs `check` on the order's items as each path hands them to each kind of viewer. */
  const onEveryPath = async (
    orderId: number,
    viewers: Record<string, Who>,
    check: (items: any[], label: string) => void,
  ) => {
    for (const [viewer, who] of Object.entries(viewers)) {
      for (const [path, fetch] of Object.entries(PATHS)) {
        const items = itemsIn(await fetch(who, orderId), orderId);
        assertOrThrow(items.length > 0, `${path}, ${viewer}: the order's items are in the payload`);
        check(items, `${path}, ${viewer}`);
      }
    }
  };
  const lineOf = (items: any[], productId: string, withRecipe: boolean) =>
    items.find(
      (item) =>
        item.product_id === productId &&
        Boolean(item.modifier_selection && item.modifier_selection !== 'null') === withRecipe,
    );
  const linesOf = (item: any) => JSON.stringify(item?.recipe_lines);

  // The baseline is taken first, while the order without a recipe is the only one there is.
  const catalog = seedPizzaMenu(db);
  const plainOrderId = await placeOrder(PLAIN_ITEMS);
  // An order number holds the day it was made.
  db.prepare("UPDATE orders SET order_number = 'KDS-LINES-PLAIN' WHERE id = ?").run(plainOrderId);
  const baseline: Record<string, string> = {};
  for (const [viewer, who] of Object.entries(everyone)) {
    for (const [path, fetch] of Object.entries(PATHS)) {
      baseline[`${path}, ${viewer}`] = sha(stable(await fetch(who, plainOrderId)));
    }
  }
  if (process.env.PIZZA_KDS_BASELINE === 'print') {
    console.log(JSON.stringify(baseline, null, 2));
    await stopKdsServer();
    process.exit(0);
  }
  const recipeOrderId = await placeOrder(RECIPE_ITEMS);

  await runCases('pizza-kds-lines', {
    'Case 1: on every path the half and half and the deal carry the ticket lines, other items none':
      async () => {
        const wide = ticketLines(catalog, bare, COLUMNS).detailLines;
        assertOrThrow(
          JSON.stringify(wide) !== JSON.stringify(ticketLines(catalog, bare, 42).detailLines),
          'the long removal list wraps differently at 48 and at 42 columns',
        );
        await onEveryPath(recipeOrderId, { 'an owner': everyone['an owner'] }, (items, label) => {
          assertEqualOrThrow(items.length, RECIPE_ITEMS.length, `${label}: every item is there`);
          assertEqualOrThrow(
            linesOf(lineOf(items, 'pz-half-and-half', true)),
            JSON.stringify(HALF_LINES),
            `${label}: the half and half carries the contract's lines`,
          );
          assertEqualOrThrow(
            linesOf(lineOf(items, 'dl-three-large-wings', true)),
            JSON.stringify(DEAL_LINES),
            `${label}: the deal carries the contract's lines`,
          );
          assertEqualOrThrow(
            linesOf(lineOf(items, 'pz-garden', true)),
            JSON.stringify(wide),
            `${label}: the lines are built for 48 columns`,
          );
          for (const productId of ['pz-garden', 'sd-green-salad']) {
            const plain = lineOf(items, productId, false);
            assertOrThrow(plain, `${label}: ${productId} without a recipe is there`);
            assertOrThrow(!('recipe_lines' in plain), `${label}: ${productId} carries no lines`);
          }
        });
      },

    'Case 2: a restricted station gets the lines too': async () => {
      const restricted = { 'a restricted station': everyone['a restricted station'] };
      await onEveryPath(recipeOrderId, restricted, (items, label) => {
        assertEqualOrThrow(
          linesOf(lineOf(items, 'pz-half-and-half', true)),
          JSON.stringify(HALF_LINES),
          `${label}: the half and half carries the contract's lines`,
        );
        assertEqualOrThrow(
          linesOf(lineOf(items, 'dl-three-large-wings', true)),
          JSON.stringify(DEAL_LINES),
          `${label}: the deal carries the contract's lines`,
        );
        for (const item of items) {
          assertOrThrow(!('unit_price' in item), `${label}: and still no price`);
          if (!item.modifier_selection)
            assertOrThrow(!('recipe_lines' in item), `${label}: an item without a recipe has none`);
        }
      });
      const projected = projectKdsItem({ id: 1, unit_price: 5, recipe_lines: HALF_LINES }, true);
      assertEqualOrThrow(
        linesOf(projected),
        JSON.stringify(HALF_LINES),
        'the restricted projection keeps the lines',
      );
      assertOrThrow(
        !('recipe_lines' in projectKdsItem({ id: 1, unit_price: 5 }, true)),
        'the restricted projection adds none of its own',
      );
    },

    'Case 3: with the stored menu removed, a recipe item carries the warning line': async () => {
      const warned: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '));
      db.prepare('DELETE FROM pizza_menu').run();
      try {
        await onEveryPath(recipeOrderId, everyone, (items, label) => {
          for (const productId of ['pz-half-and-half', 'dl-three-large-wings', 'pz-garden']) {
            assertEqualOrThrow(
              linesOf(lineOf(items, productId, true)),
              JSON.stringify(NOT_PRINTED),
              `${label}: ${productId} carries the one warning line`,
            );
          }
          assertOrThrow(
            !('recipe_lines' in lineOf(items, 'sd-green-salad', false)),
            `${label}: an item without a recipe still carries none`,
          );
        });
        // A display refreshes all day; the log names each item once, not once a refresh.
        assertEqualOrThrow(warned.length, 3, 'each recipe item is logged once across every path');
        assertOrThrow(warned[0].includes('menu is not loaded'), 'the log says why');
        const logged = new Set<unknown>(Array.from({ length: 1001 }, (_, index) => `old-${index}`));
        withRecipeDetailLines(
          [{ id: 1, modifier_selection: half }],
          COLUMNS,
          'recipe_lines',
          logged,
        );
        assertEqualOrThrow(logged.size, 1, 'the set of logged items is emptied past 1000 entries');
      } finally {
        console.warn = originalWarn;
        writePizzaMenu(db, JSON.stringify(catalog));
      }
    },

    'Case 3b: after a menu reload the deal shows what it was sold with': async () => {
      const changed = JSON.parse(JSON.stringify(catalog));
      changed.deals.find((deal: any) => deal.id === 'three-large-wings').description =
        'Any 3 large pizzas & 6 wings';
      writePizzaMenu(db, JSON.stringify(changed));
      try {
        await onEveryPath(recipeOrderId, everyone, (items, label) => {
          assertEqualOrThrow(
            linesOf(lineOf(items, 'dl-three-large-wings', true)),
            JSON.stringify(DEAL_LINES),
            `${label}: the deal still says 12 wings`,
          );
        });
      } finally {
        writePizzaMenu(db, JSON.stringify(catalog));
      }
    },

    'Case 4: the route that returns the recipe as text carries the lines as a list': async () => {
      const payload = await PATHS['main API, GET /api/kds/orders'](
        everyone['an owner'],
        recipeOrderId,
      );
      const item = lineOf(itemsIn(payload, recipeOrderId), 'pz-half-and-half', true);
      assertEqualOrThrow(typeof item.modifier_selection, 'string', 'the recipe is stored text');
      assertOrThrow(Array.isArray(item.recipe_lines), 'the lines are a list');
      assertEqualOrThrow(linesOf(item), JSON.stringify(HALF_LINES), 'and they are the lines');
    },

    'Case 5: an order with no recipes has the same payload as before, on every path': () => {
      assertEqualOrThrow(
        Object.keys(baseline).length,
        Object.keys(BASELINE).length,
        'every path has a recorded baseline',
      );
      for (const [path, hash] of Object.entries(baseline)) {
        assertEqualOrThrow(hash, BASELINE[path], `${path}: unchanged`);
      }
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
