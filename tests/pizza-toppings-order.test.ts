/**
 * Toppings as money: the two add-ons a menu load makes, the server's check
 * that a line's topping add-ons equal what its recipe says, and the charge on
 * an order of a store set up with the pizza profile and the sample menu.
 *
 * Sample prices: a large pizza 23.00, a topping 2.25, half a topping 1.13
 * (1.125 rounded half-up), GST 5% on the line.
 *
 * Run: npm run test:pizza-toppings-order
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  rows,
  runCases,
  createApp,
  startServer,
  api,
} = require('./helpers/pizza-print-harness');
const { initDatabase, getDatabase } = require('../main/db');
const { kdsRecipe, withKdsRecipeLines } = require('../main/pizza/order-recipe');
const { registerRoutes } = require('../main/routes/index');
const net = require('node:net');
const { printKOTDetailed, prepareReceipt } = require('../main/printers/thermal');
const { getEffectiveOrderItems } = require('../main/routes/printers');
const sample = require('./fixtures/pizza-sample-menu.json');

const frontend = loadFrontend();
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');
const { useCartStore } = require('../frontend/src/store/cart');
const { getPizzaCatalog, reloadPizzaCatalog } = require('../frontend/src/lib/pizza/catalog');
const { newSheet, sheetReducer, sheetLine } = require('../frontend/src/lib/pizza/sheet-state');
const { newDeal, dealReducer, dealLine } = require('../frontend/src/lib/pizza/deal-state');
const {
  customizeOne,
  replaceCartLine,
  sheetAddons,
} = require('../frontend/src/lib/pizza/cart-lines');
const { chargedAddons } = require('../frontend/src/lib/pizza/toppings');
const {
  buttonContents,
  buttonLine,
  fetchQuickButtons,
  saveQuickButton,
} = require('../frontend/src/lib/pizza/quick-buttons');
const {
  dealSentLine,
  sentLine,
  sentLineEdit,
  sheetSentLine,
  sheetSource,
} = require('../frontend/src/lib/pizza/sent-line');

const MISMATCH =
  'The toppings on this item do not match what it is charged. Remove it and add it again';
const json = (value: unknown) => JSON.stringify(value);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(json(actual), json(expected), message);

const part = (pizzaId: string, more: object = {}) => ({ pizzaId, removed: [], ...more });
const pizza = (parts: object) => ({ kind: 'pizza', v: 1, sizeId: 'large', ...parts });
const whole = (pizzaId: string, more: object = {}) => pizza({ whole: part(pizzaId, more) });
const halves = (first: object, second: object) => pizza({ halves: [first, second] });
const toppings = (quantity: number) => ({ id: 'ad-topping', quantity });
const halfToppings = (quantity: number) => ({ id: 'ad-topping-half', quantity });

const gardenLine = (more: object = {}) => ({
  product_id: 'pz-garden',
  variant_id: 'pz-garden-large',
  quantity: 1,
  ...more,
});
const halfLine = (more: object = {}) => ({
  product_id: 'pz-half-and-half',
  variant_id: 'pz-half-and-half-large',
  quantity: 1,
  ...more,
});

/** Extra cheese and bacon on a whole pizza: two toppings. */
const twoOnWhole = whole('garden', { extra: ['Cheese'], added: ['bacon'] });
/** One on each half: two half toppings. */
const oneOnEachHalf = halves(
  part('island', { added: ['bacon'] }),
  part('classic', { extra: ['Cheese'] }),
);
const threeLarge = (first: object) => ({
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [first, halves(part('island', { added: ['feta'] }), part('plain')), whole('classic')],
  wingFlavour: 'hot',
});

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
  const headers = { Authorization: `Bearer ${setup.data.access_token}` };

  // The POS's own API client, pointed at the test server and signed in.
  frontend.api.defaults.baseURL = `${baseUrl}/api`;
  frontend.api.defaults.headers.common.Authorization = headers.Authorization;
  const cart = () => useCartStore.getState();
  let products: any[] = [];
  /** Reads the menu and the products the way the POS does after a menu load. */
  const readPos = async () => {
    await reloadPizzaCatalog();
    products = (await frontend.api.get('/products')).data.products;
  };
  const productOf = (id: string) => products.find((entry) => entry.id === id);
  const onSaleOf = (product: any) =>
    (product.addon_groups ?? []).flatMap((group: any) => group.addons ?? []);
  const tap = (state: object, ...actions: object[]) =>
    actions.reduce((current, action) => sheetReducer(current, action), state) as any;
  /** What Add or Save on the sheet hands the cart, built as `usePizzaPos` builds it. */
  const sheetParts = (state: any) => {
    const line = sheetLine(getPizzaCatalog(), state);
    assertOrThrow(line.canAdd, `the sheet allows Add (${line.message})`);
    const product = productOf(line.productId);
    const addons = chargedAddons([], line.recipe, onSaleOf(product));
    assertOrThrow(addons !== null, 'the POS sells the topping add-ons');
    return {
      product,
      variant: product.variants.find((entry: any) => entry.id === line.variantId),
      addons,
      quantity: state.quantity,
      special_instructions: state.note,
      recipe: line.recipe,
    };
  };
  const addFromSheet = (state: any) => {
    const parts = sheetParts(state);
    cart().addItem(parts.product, parts.quantity, parts.addons, '', parts.variant, parts.recipe);
  };
  const placeCart = () => createOrder(cart().items.map(cartItemToOrderItem));
  /** What the cart charges before tax, as the POS shows it. */
  const cartSubtotal = () => Number(cart().subtotal().toFixed(2));
  const extraCheese = [
    { type: 'ingredient', half: 0, name: 'Cheese' },
    { type: 'ingredient', half: 0, name: 'Cheese' },
  ];
  const addBacon = { type: 'topping', half: 0, toppingId: 'bacon' };

  let key = 0;
  const post = (path: string, body: object) =>
    api(baseUrl, path, { method: 'POST', headers, body });
  const loadMenu = (menu: object) => post('/api/pizza/menu/import', menu);
  const createOrder = (items: object[]) => post('/api/orders', { type: 'takeaway', items });
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;
  const liveRows = (orderId: number) =>
    db
      .prepare(
        "SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded') ORDER BY id",
      )
      .all(orderId) as any[];
  const addonRows = (itemId: number) =>
    db
      .prepare(
        'SELECT addon_id, addon_name, price, quantity FROM order_item_addons WHERE order_item_id = ? ORDER BY addon_id',
      )
      .all(itemId);
  const editVersion = (orderId: number, itemId: number) =>
    (
      db
        .prepare(
          'SELECT COALESCE(MAX(id), 0) AS v FROM order_audit_log WHERE order_id = ? AND order_item_id = ?',
        )
        .get(orderId, itemId) as any
    ).v;
  const edit = (orderId: number, itemId: number, body: object) =>
    api(baseUrl, `/api/orders/${orderId}/items/${itemId}/edit`, {
      method: 'PATCH',
      headers: { ...headers, 'Idempotency-Key': `pizza-toppings-${++key}` },
      body: { expected_edit_version: editVersion(orderId, itemId), ...body },
    });
  const addon = (id: string) => db.prepare('SELECT * FROM addons WHERE id = ?').get(id) as any;
  const accepted = (response: any, status: number, label: string) =>
    assertEqualOrThrow(
      response.status,
      status,
      `${label} (the server said ${json(response.data)})`,
    );
  /** Posts an order that must be refused, and checks that it left nothing behind. */
  async function refused(label: string, item: object) {
    const before = [count('orders'), count('order_items')];
    const response = await createOrder([gardenLine(), item]);
    assertEqualOrThrow(response.status, 400, `${label}: refused with 400`);
    assertEqualOrThrow(response.data.error, MISMATCH, `${label}: the message says what to do`);
    same([count('orders'), count('order_items')], before, `${label}: nothing is written`);
  }

  await runCases('pizza-toppings-order', {
    'Case 1: a menu load makes the two topping add-ons, linked to pizzas and deals': async () => {
      accepted(await loadMenu(sample), 200, 'the sample menu loads');
      const group = db.prepare("SELECT * FROM addon_groups WHERE id = 'ag-toppings'").get() as any;
      same(
        [
          group.name,
          group.is_required,
          group.min_selection,
          group.max_selection,
          group.allow_multiple_quantities,
          group.is_active,
        ],
        ['Toppings', 0, 0, null, 1, 1],
        'an optional group that takes any number of each',
      );
      same(
        ['ad-topping', 'ad-topping-half'].map((id) => {
          const row = addon(id);
          return [row.addon_group_id, row.name, row.price, row.is_active];
        }),
        [
          ['ag-toppings', 'Topping', 2.25, 1],
          ['ag-toppings', 'Half topping', 1.13, 1],
        ],
        'a topping at the menu price and half a topping at half of it, 1.125 rounded half-up',
      );
      same(
        db
          .prepare(
            "SELECT category_id FROM category_addon_groups WHERE addon_group_id = 'ag-toppings' ORDER BY category_id",
          )
          .all()
          .map((row: any) => row.category_id),
        ['cat-deals', 'cat-pizzas'],
        'linked to the pizzas, with the half and half, and to the deals',
      );
      const again = await loadMenu(sample);
      same(
        [again.data.created, again.data.updated, again.data.deactivated],
        [0, 0, 0],
        'loading the same file again changes nothing',
      );
    },

    'Case 2: one price in the file sets both add-ons; a file without toppings switches them off':
      async () => {
        const priced = (price: number) => {
          const menu = structuredClone(sample);
          menu.toppings.price = price;
          return menu;
        };
        const prices = () => [addon('ad-topping').price, addon('ad-topping-half').price];
        accepted(await loadMenu(priced(3)), 200, 'a menu with another topping price loads');
        same(prices(), [3, 1.5], 'an even amount halves exactly');
        accepted(await loadMenu(priced(0.01)), 200, 'a one-cent topping loads');
        same(prices(), [0.01, 0.01], 'half a cent rounds up to a cent');
        accepted(await loadMenu(priced(2.05)), 200, 'an odd cent loads');
        same(prices(), [2.05, 1.03], '1.025 rounds half-up to 1.03');

        const without = structuredClone(sample);
        delete without.toppings;
        accepted(await loadMenu(without), 200, 'a menu without toppings loads');
        same(
          [
            addon('ad-topping').is_active,
            addon('ad-topping-half').is_active,
            (db.prepare("SELECT is_active FROM addon_groups WHERE id = 'ag-toppings'").get() as any)
              .is_active,
          ],
          [0, 0, 0],
          'the add-ons and their group are switched off',
        );
        const stale = await createOrder([
          gardenLine({ modifier_selection: twoOnWhole, addons: [toppings(2)] }),
        ]);
        assertEqualOrThrow(stale.status, 400, 'and a pizza with a topping is refused');

        accepted(await loadMenu(sample), 200, 'the sample loads again');
        same([...prices(), addon('ad-topping').is_active], [2.25, 1.13, 1], 'and they are back');

        // A pizza sent with toppings, then the menu drops them: it can shrink but not grow.
        const sent = await createOrder([
          gardenLine({ quantity: 2, modifier_selection: twoOnWhole, addons: [toppings(2)] }),
        ]);
        accepted(sent, 201, 'two pizzas with toppings are sent');
        const orderId = sent.data.order.id;
        accepted(await loadMenu(without), 200, 'the menu drops its toppings');
        const more = await edit(orderId, liveRows(orderId)[0].id, { quantity: 3 });
        assertEqualOrThrow(more.status, 400, 'one more is refused: there is no price for it');
        const fewer = await edit(orderId, liveRows(orderId)[0].id, { quantity: 1 });
        accepted(fewer, 200, 'one fewer is accepted');
        same(
          [liveRows(orderId)[0].quantity, liveRows(orderId)[0].subtotal],
          [1, 27.5],
          'at the prices it was sold for',
        );
        accepted(await loadMenu(sample), 200, 'the sample loads once more');
      },

    'Case 3: a whole pizza with one extra and one added topping costs two toppings more':
      async () => {
        const sent = whole('garden', { extra: ['Cheese', 'Cheese'], added: ['bacon'] });
        const response = await createOrder([
          gardenLine({ modifier_selection: sent, addons: [toppings(2)] }),
        ]);
        accepted(response, 201, 'the order is accepted');
        const [line] = liveRows(response.data.order.id);
        assertEqualOrThrow(line.modifier_selection, json(twoOnWhole), 'stored normalised');
        assertEqualOrThrow(line.unit_price, 23, 'the pizza is at its size price');
        same(
          addonRows(line.id),
          [{ addon_id: 'ad-topping', addon_name: 'Topping', price: 2.25, quantity: 2 }],
          'with two toppings at the add-on price',
        );
        assertEqualOrThrow(line.subtotal, 27.5, '23.00 + 2 x 2.25');
        assertEqualOrThrow(line.tax_amount, 1.38, 'GST on the whole 27.50: 1.375 rounds to 1.38');
        assertEqualOrThrow(response.data.order.total, 28.88, 'and the order comes to 28.88');
      },

    'Case 4: a half and half with one on each half costs two half toppings more': async () => {
      const response = await createOrder([
        halfLine({ modifier_selection: oneOnEachHalf, addons: [halfToppings(2)] }),
      ]);
      accepted(response, 201, 'the order is accepted');
      const [line] = liveRows(response.data.order.id);
      same(
        addonRows(line.id),
        [{ addon_id: 'ad-topping-half', addon_name: 'Half topping', price: 1.13, quantity: 2 }],
        'two half toppings',
      );
      assertEqualOrThrow(line.subtotal, 25.26, '23.00 + 2 x 1.13');
      assertEqualOrThrow(line.tax_amount, 1.26, 'GST 1.263 rounds to 1.26');

      const three = await createOrder([
        gardenLine({ quantity: 3, modifier_selection: twoOnWhole, addons: [toppings(2)] }),
      ]);
      accepted(three, 201, 'three of a pizza with two toppings');
      assertEqualOrThrow(liveRows(three.data.order.id)[0].subtotal, 82.5, 'are 3 x 27.50');
    },

    'Case 5: a line whose topping add-ons disagree with its recipe is refused': async () => {
      await refused('toppings with no add-on', gardenLine({ modifier_selection: twoOnWhole }));
      await refused(
        'one topping charged for two',
        gardenLine({ modifier_selection: twoOnWhole, addons: [toppings(1)] }),
      );
      await refused(
        'three charged for two',
        gardenLine({ modifier_selection: twoOnWhole, addons: [toppings(3)] }),
      );
      await refused(
        'whole toppings charged as halves',
        gardenLine({ modifier_selection: twoOnWhole, addons: [halfToppings(2)] }),
      );
      await refused(
        'half toppings charged as whole',
        halfLine({ modifier_selection: oneOnEachHalf, addons: [toppings(2)] }),
      );
      await refused('a topping on a plain pizza', gardenLine({ addons: [toppings(1)] }));
      await refused(
        'a topping on a pizza with only a removal',
        gardenLine({
          modifier_selection: whole('garden', { removed: ['Olives'] }),
          addons: [halfToppings(1)],
        }),
      );
      await refused('a deal charged for none of its toppings', {
        product_id: 'dl-three-large-wings',
        quantity: 1,
        modifier_selection: threeLarge(twoOnWhole),
      });
      await refused('a topping on a deal with no pizzas', {
        product_id: 'dl-pasta-night',
        quantity: 1,
        modifier_selection: {
          kind: 'deal',
          v: 1,
          dealId: 'pasta-night',
          pizzas: [],
          pops: { cola: 3 },
        },
        addons: [toppings(1)],
      });
      // The same add-on named twice counts once for each.
      const split = await createOrder([
        gardenLine({ modifier_selection: twoOnWhole, addons: [toppings(1), toppings(1)] }),
      ]);
      accepted(split, 201, 'two entries of one each are two toppings');
    },

    'Case 6: a product no menu load made cannot carry a topping': async () => {
      db.prepare(
        "INSERT INTO products (id, category_id, name, price, is_active) VALUES ('hand-calzone', 'cat-pizzas', 'Calzone', 12, 1)",
      ).run();
      const response = await createOrder([
        { product_id: 'hand-calzone', quantity: 1, addons: [toppings(1)] },
      ]);
      assertEqualOrThrow(response.status, 400, 'refused');
      assertEqualOrThrow(response.data.error, MISMATCH, 'with the same message');
      accepted(
        await createOrder([{ product_id: 'hand-calzone', quantity: 1 }]),
        201,
        'without one it sells as before',
      );
    },

    "Case 7: a deal's pizzas are charged on the deal line": async () => {
      const response = await createOrder([
        {
          product_id: 'dl-three-large-wings',
          quantity: 1,
          modifier_selection: threeLarge(twoOnWhole),
          addons: [toppings(2), halfToppings(1)],
        },
      ]);
      accepted(response, 201, 'the deal is accepted');
      const [line] = liveRows(response.data.order.id);
      assertEqualOrThrow(line.unit_price, 71.25, 'the deal is at its price');
      assertEqualOrThrow(line.subtotal, 76.88, '71.25 + 2 x 2.25 + 1.13');
      assertEqualOrThrow(line.tax_amount, 3.84, 'GST on 76.88: 3.844 rounds to 3.84');
    },

    'Case 8: adding to an order is checked the same way': async () => {
      const order = (await createOrder([gardenLine()])).data.order;
      const added = await post(`/api/orders/${order.id}/items`, {
        items: [halfLine({ modifier_selection: oneOnEachHalf, addons: [halfToppings(2)] })],
      });
      accepted(added, 200, 'a half and half with its half toppings is added');
      same(
        addonRows(added.data.added_item_ids[0]).map((row: any) => [row.addon_id, row.quantity]),
        [['ad-topping-half', 2]],
        'with the add-ons stored',
      );
      const before = count('order_items');
      const bad = await post(`/api/orders/${order.id}/items`, {
        items: [halfLine({ modifier_selection: oneOnEachHalf, addons: [halfToppings(1)] })],
      });
      assertEqualOrThrow(bad.status, 400, 'one half topping for two is refused');
      assertEqualOrThrow(bad.data.error, MISMATCH, 'with the message');
      assertEqualOrThrow(count('order_items'), before, 'and nothing is added');
    },

    'Case 9: an edit of a sold line keeps the add-ons equal to the recipe': async () => {
      const oneExtra = whole('garden', { extra: ['Cheese'] });
      const order = (
        await createOrder([gardenLine({ modifier_selection: oneExtra, addons: [toppings(1)] })])
      ).data.order;
      const live = () => liveRows(order.id);
      const untouched = () => [live()[0].id, count('order_items')];

      // A change of recipe that needs another charge, sent with the old add-ons.
      let standing = untouched();
      const forgot = await edit(order.id, live()[0].id, {
        replacement: gardenLine({ modifier_selection: twoOnWhole, addons: [toppings(1)] }),
      });
      assertEqualOrThrow(forgot.status, 400, 'a second topping without its charge is refused');
      assertEqualOrThrow(forgot.data.error, MISMATCH, 'with the message');
      same(untouched(), standing, 'and the line still stands');

      const second = await edit(order.id, live()[0].id, {
        replacement: gardenLine({ modifier_selection: twoOnWhole, addons: [toppings(2)] }),
      });
      accepted(second, 200, 'with its charge it is accepted');
      assertEqualOrThrow(live()[0].subtotal, 27.5, 'and the line is priced with two toppings');

      // Only the recipe changes: the toppings stay, so the sold add-ons are carried.
      const noOlives = whole('garden', {
        removed: ['Olives'],
        extra: ['Cheese'],
        added: ['bacon'],
      });
      const removal = await edit(order.id, live()[0].id, {
        replacement: gardenLine({ modifier_selection: noOlives, addons: [toppings(2)] }),
      });
      accepted(removal, 200, 'a removal beside the same toppings is accepted');
      same(
        [live()[0].modifier_selection, live()[0].subtotal, addonRows(live()[0].id).length],
        [json(noOlives), 27.5, 1],
        'the recipe changes and the charge stays',
      );

      // A replacement that names no recipe keeps the stored one, so it must keep its charge too.
      standing = untouched();
      const bare = await edit(order.id, live()[0].id, { replacement: gardenLine({ quantity: 2 }) });
      assertEqualOrThrow(bare.status, 400, 'a replacement that drops the add-ons is refused');
      assertEqualOrThrow(bare.data.error, MISMATCH, 'with the message');
      same(untouched(), standing, 'and the line still stands');

      const more = await edit(order.id, live()[0].id, { quantity: 2 });
      accepted(more, 200, 'a quantity increase is accepted');
      same(
        [live()[0].quantity, live()[0].subtotal],
        [2, 55],
        'two pizzas with two toppings each: 2 x 27.50',
      );
      const fewer = await edit(order.id, live()[0].id, { quantity: 1 });
      accepted(fewer, 200, 'and a reduction');
      assertEqualOrThrow(live()[0].subtotal, 27.5, 'back to one');

      standing = untouched();
      const plainWithCharge = await edit(order.id, live()[0].id, {
        replacement: gardenLine({ modifier_selection: null, addons: [toppings(2)] }),
      });
      assertEqualOrThrow(plainWithCharge.status, 400, 'a plain pizza still charged is refused');
      same(untouched(), standing, 'and the line still stands');
      const plain = await edit(order.id, live()[0].id, {
        replacement: gardenLine({ modifier_selection: null, addons: [] }),
      });
      accepted(plain, 200, 'made plain with no add-ons it is accepted');
      same([live()[0].subtotal, addonRows(live()[0].id)], [23, []], 'at the pizza price alone');
    },

    'Case 10: a quick button keeps its add-ons equal to its recipe, also after a price change':
      async () => {
        const button = (more: object) =>
          post('/api/pizza/quick-buttons', {
            label: 'Cheesy',
            color: 'red',
            product_id: 'pz-garden',
            variant_id: 'pz-garden-large',
            ...more,
          });
        const bad = await button({ recipe: twoOnWhole, addons: [toppings(1)] });
        assertEqualOrThrow(bad.status, 400, 'a button charged for one of two toppings is refused');
        assertEqualOrThrow(bad.data.error, MISMATCH, 'with the message');
        const saved = await button({ recipe: twoOnWhole, addons: [toppings(2)] });
        accepted(saved, 201, 'with both it is saved');
        const id = saved.data.button.id;
        const listed = async () =>
          (await api(baseUrl, '/api/pizza/quick-buttons', { headers })).data.buttons.find(
            (entry: any) => entry.id === id,
          );

        const dearer = structuredClone(sample);
        dearer.toppings.price = 3.01;
        accepted(await loadMenu(dearer), 200, 'a menu with a dearer topping loads');
        const after = await listed();
        same(
          [after.usable, after.addons, after.recipe],
          [true, [toppings(2)], twoOnWhole],
          'the button is as it was saved, and usable',
        );
        const tapped = await createOrder([
          gardenLine({ modifier_selection: after.recipe, addons: after.addons }),
        ]);
        accepted(tapped, 201, 'a tap is accepted');
        const [line] = liveRows(tapped.data.order.id);
        assertEqualOrThrow(line.subtotal, 29.02, 'at the new price: 23.00 + 2 x 3.01');
        const halfTap = await createOrder([
          halfLine({ modifier_selection: oneOnEachHalf, addons: [halfToppings(2)] }),
        ]);
        assertEqualOrThrow(
          liveRows(halfTap.data.order.id)[0].subtotal,
          26.02,
          'and half of 3.01 is 1.51, the odd cent rounded up: 23.00 + 2 x 1.51',
        );
        accepted(await loadMenu(sample), 200, 'the sample loads again');
      },

    'Case 11: a restricted kitchen station gets extras and toppings, and only as lists of text':
      () => {
        same(
          kdsRecipe({ modifier_selection: { ...twoOnWhole, secret: 1 } }),
          twoOnWhole,
          'the recipe fields, extras and toppings included',
        );
        for (const bad of [{ extra: 'Cheese' }, { added: [7] }, { extra: [{}] }])
          assertEqualOrThrow(
            kdsRecipe({ modifier_selection: whole('garden', bad) }),
            null,
            `${json(bad)} is not a recipe`,
          );
      },

    'Case 12: a pizza built on the sheet goes through the cart to the order with its charge':
      async () => {
        await readPos();
        cart().clearCart();
        addFromSheet(
          tap(newSheet({ pizzaId: 'garden', sizeId: 'large' }), ...extraCheese, addBacon),
        );
        assertEqualOrThrow(cartSubtotal(), 27.5, 'the cart shows 23.00 + 2 x 2.25');
        const sent = cart().items.map(cartItemToOrderItem);
        same(
          [
            sent[0].addons.map((addon: any) => [addon.id, addon.quantity]),
            sent[0].modifier_selection,
          ],
          [[['ad-topping', 2]], twoOnWhole],
          'the request carries the recipe and two toppings',
        );
        const placed = await placeCart();
        accepted(placed, 201, 'the order is accepted');
        assertEqualOrThrow(placed.data.order.subtotal, cartSubtotal(), 'at what the cart showed');

        cart().clearCart();
        addFromSheet(
          tap(
            newSheet({ split: true, sizeId: 'large' }),
            { type: 'pizza', half: 0, pizzaId: 'island' },
            { type: 'pizza', half: 1, pizzaId: 'classic' },
            addBacon,
            { type: 'ingredient', half: 1, name: 'Cheese' },
            { type: 'ingredient', half: 1, name: 'Cheese' },
          ),
        );
        const half = await placeCart();
        accepted(half, 201, 'a half and half with one on each half is accepted');
        same(
          [cartSubtotal(), half.data.order.subtotal],
          [25.26, 25.26],
          'the cart and the order agree on 23.00 + 2 x 1.13',
        );
      },

    'Case 13: "Customize 1" gives one pizza of several a topping and leaves the rest plain':
      async () => {
        cart().clearCart();
        const garden = productOf('pz-garden');
        const large = garden.variants.find((entry: any) => entry.id === 'pz-garden-large');
        cart().addItem(garden, 3, [], '', large);
        const split = customizeOne(cart().items, cart().items[0].id);
        const edited = sheetParts(tap(newSheet(), { type: 'load', line: split.line }, addBacon));
        useCartStore.setState({
          items: replaceCartLine(split.items, split.line.id, {
            ...split.line,
            ...edited,
            addons: sheetAddons(split.line.addons, edited.addons),
          }),
        });
        same(
          cart().items.map((item: any) => [
            item.quantity,
            item.addons.map((addon: any) => [addon.id, addon.quantity]),
          ]),
          [
            [2, []],
            [1, [['ad-topping', 1]]],
          ],
          'two plain and one with a topping',
        );
        const placed = await placeCart();
        accepted(placed, 201, 'the order is accepted');
        assertEqualOrThrow(placed.data.order.subtotal, 71.25, '3 x 23.00 + 2.25');
      },

    'Case 14: a deal built in the configurator is charged for the toppings of its pizzas':
      async () => {
        const deal = getPizzaCatalog().deals.find((entry: any) => entry.id === 'three-large-wings');
        let state = newDeal(deal);
        for (const [index, pizzaId] of ['garden', 'island', 'classic'].entries())
          state = dealReducer(state, {
            type: 'pizza',
            index,
            action: { type: 'pizza', half: 0, pizzaId },
          });
        for (const action of [...extraCheese, addBacon])
          state = dealReducer(state, { type: 'pizza', index: 0, action });
        state = dealReducer(state, { type: 'wings', flavourId: 'hot' });
        const { recipe } = dealLine(getPizzaCatalog(), state);
        const product = productOf('dl-three-large-wings');
        cart().clearCart();
        cart().addItem(product, 1, chargedAddons([], recipe, onSaleOf(product)), '', null, recipe);
        const placed = await placeCart();
        accepted(placed, 201, 'the deal is accepted');
        same(
          [cartSubtotal(), placed.data.order.subtotal],
          [75.75, 75.75],
          'the cart and the order agree on 71.25 + 2 x 2.25',
        );
      },

    'Case 15: a quick button saved from a line with toppings adds the same line, at the price of the day':
      async () => {
        const parts = sheetParts(
          tap(newSheet({ pizzaId: 'garden', sizeId: 'large' }), ...extraCheese, addBacon),
        );
        const saved = await saveQuickButton({
          label: 'Bacon',
          color: 'red',
          ...buttonContents(parts),
        });
        same(saved.addons, [toppings(2)], 'the button stores two toppings');

        const dearer = structuredClone(sample);
        dearer.toppings.price = 3.01;
        accepted(await loadMenu(dearer), 200, 'a menu with a dearer topping loads');
        await readPos();
        const button = (await fetchQuickButtons()).find((entry: any) => entry.id === saved.id);
        const line = buttonLine(button, products);
        assertOrThrow(line !== null, 'the button can still be added');
        cart().clearCart();
        cart().addItem(
          line.product,
          1,
          line.addons,
          line.special_instructions,
          line.variant,
          line.recipe,
        );
        const placed = await placeCart();
        accepted(placed, 201, 'a tap is accepted');
        same(
          [cartSubtotal(), placed.data.order.subtotal],
          [29.02, 29.02],
          'two toppings at 3.01 each, in the cart and on the order',
        );
        accepted(await loadMenu(sample), 200, 'the sample loads again');
        await readPos();
      },

    'Case 16: a cart line held across a menu load that changes the topping price still agrees':
      async () => {
        cart().clearCart();
        addFromSheet(tap(newSheet({ pizzaId: 'garden', sizeId: 'large' }), ...extraCheese));
        const dearer = structuredClone(sample);
        dearer.toppings.price = 4;
        accepted(await loadMenu(dearer), 200, 'the topping price changes under the cart');
        const placed = await placeCart();
        accepted(placed, 201, 'the line is accepted: its add-on count is the recipe');
        assertEqualOrThrow(
          placed.data.order.subtotal,
          27,
          'and the server charges the price of now',
        );
        accepted(await loadMenu(sample), 200, 'the sample loads again');
        await readPos();
      },

    'Case 17: a sent pizza and a sent deal changed on the screen keep their add-ons with the recipe':
      async () => {
        const order = (await createOrder([gardenLine()])).data.order;
        const read = async (orderId: number) =>
          (await api(baseUrl, `/api/orders/${orderId}`, { headers })).data.order.items.filter(
            (item: any) => item.status === 'pending',
          );
        const [sold] = await read(order.id);
        const was = sentLine(sold);
        const state = tap(
          newSheet(),
          { type: 'load', line: sheetSource(was) },
          ...extraCheese,
          addBacon,
        );
        const body = sentLineEdit(
          sold,
          sheetSentLine(was, sheetLine(getPizzaCatalog(), state), state),
        );
        const changed = await api(baseUrl, `/api/orders/${order.id}/items/${sold.id}/edit`, {
          method: 'PATCH',
          headers: { ...headers, 'Idempotency-Key': `pizza-toppings-${++key}` },
          body,
        });
        accepted(changed, 200, 'the changed pizza is accepted');
        const [now] = await read(order.id);
        same(
          [now.addons.map((addon: any) => [addon.id, addon.price, addon.quantity]), now.subtotal],
          [[['ad-topping', 2.25, 2]], 27.5],
          'and is charged two toppings',
        );

        const plainDeal = threeLarge(whole('garden'));
        const dealOrder = (
          await createOrder([
            {
              product_id: 'dl-three-large-wings',
              quantity: 1,
              modifier_selection: plainDeal,
              addons: [halfToppings(1)],
            },
          ])
        ).data.order;
        const [soldDeal] = await read(dealOrder.id);
        const dealBody = sentLineEdit(
          soldDeal,
          dealSentLine(sentLine(soldDeal), threeLarge(twoOnWhole)),
        );
        const dealChanged = await api(
          baseUrl,
          `/api/orders/${dealOrder.id}/items/${soldDeal.id}/edit`,
          {
            method: 'PATCH',
            headers: { ...headers, 'Idempotency-Key': `pizza-toppings-${++key}` },
            body: dealBody,
          },
        );
        accepted(dealChanged, 200, 'the changed deal is accepted');
        assertEqualOrThrow(
          (await read(dealOrder.id))[0].subtotal,
          76.88,
          'and is charged 71.25 + 2 x 2.25 + 1.13',
        );
      },

    'Case 18: the kitchen ticket and the receipt print the recipe lines and the add-on lines':
      async () => {
        // A loopback socket stands in for the kitchen printer and keeps what it is sent.
        const jobs: Buffer[] = [];
        const server = net.createServer((socket: any) => {
          const chunks: Buffer[] = [];
          socket.on('data', (chunk: Buffer) => chunks.push(chunk));
          socket.on('error', () => {});
          socket.on('close', () => jobs.push(Buffer.concat(chunks)));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const printer = {
          id: 'capture',
          name: 'Capture',
          connection_type: 'network',
          ip_address: '127.0.0.1',
          port: server.address().port,
          paper_width: 'cols-42',
          text_size: 'normal',
        };
        const created = await createOrder([
          gardenLine({
            modifier_selection: whole('garden', {
              removed: ['Olives'],
              extra: ['Cheese'],
              added: ['bacon'],
            }),
            addons: [toppings(2)],
          }),
          halfLine({ modifier_selection: oneOnEachHalf, addons: [halfToppings(2)] }),
        ]);
        accepted(created, 201, 'the order is accepted');
        const order = db
          .prepare('SELECT * FROM orders WHERE id = ?')
          .get(created.data.order.id) as any;
        order.items = getEffectiveOrderItems(db, String(order.id));
        const bill = (await post('/api/bills/generate', { order_id: order.id })).data.bill;

        const sent = await printKOTDetailed(order, order.items, 'Kitchen', false, printer);
        assertOrThrow(sent.ok, 'the kitchen ticket is sent');
        for (let waited = 0; jobs.length === 0 && waited < 5000; waited += 20)
          await new Promise((resolve) => setTimeout(resolve, 20));
        server.close();
        const ticket = rows(jobs.pop() ?? Buffer.alloc(0));
        const receipt = rows(
          prepareReceipt(
            order,
            bill,
            { name: 'Sample Pizza Co.', country: 'CA', currency: 'CAD', timezone: 'UTC' },
            'classic',
          ).data,
        );
        const itemRows = (printed: string[]) => {
          const from = printed.findIndex((row) => row.includes('Garden'));
          const to = printed.findIndex((row, index) => index > from && /ADD BACON/.test(row));
          return printed.slice(
            from,
            printed.indexOf('', to) > 0 ? printed.indexOf('', to) : to + 12,
          );
        };
        console.log(
          `  kitchen ticket, 42 columns:\n${itemRows(ticket)
            .map((row) => `    |${row}`)
            .join('\n')}`,
        );
        console.log(
          `  classic receipt, 42 columns:\n${itemRows(receipt)
            .map((row) => `    |${row}`)
            .join('\n')}`,
        );
        for (const [name, printed] of [
          ['kitchen ticket', ticket],
          ['classic receipt', receipt],
        ] as const) {
          for (const line of ['NO OLIVES', 'EXTRA CHEESE', 'ADD BACON', 'EXTRA CHEESE'])
            assertOrThrow(
              printed.some((row) => row.trim() === line || row.trim().endsWith(line)),
              `${name}: prints ${line}`,
            );
        }
        // The charge lines are for the customer. A cook would read "+ Topping x2" as two more to put on.
        assertOrThrow(
          !ticket.some((row) => /topping/i.test(row)),
          'kitchen ticket: prints no topping charge line',
        );
        assertOrThrow(
          receipt.some((row) => /\+ Topping x2/.test(row) && /4\.50/.test(row)),
          'classic receipt: prints the Topping add-on with its count and amount',
        );
        assertOrThrow(
          receipt.some((row) => /\+ Half topping x2/.test(row) && /2\.26/.test(row)),
          'classic receipt: prints the Half topping add-on',
        );

        const dips = { id: 'ad-dips-ranch', name: 'Ranch', price: 1.25, quantity: 1 };
        const shown = withKdsRecipeLines([
          { ...order.items[0], addons: [dips, ...order.items[0].addons] },
          { id: 999, product_id: 'sd-green-salad', addons: [dips], modifier_selection: null },
        ]);
        same(
          shown[0].addons.map((addon: any) => addon.id),
          ['ad-dips-ranch'],
          'kitchen display: the pizza keeps its dip and loses the topping charge',
        );
        assertOrThrow(
          shown[0].recipe_lines.includes('EXTRA CHEESE') &&
            shown[0].recipe_lines.includes('ADD BACON'),
          'kitchen display: the recipe lines still name the extra and the topping',
        );
        same(shown[1].addons, [dips], 'kitchen display: an item without a recipe is as it was');
      },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
