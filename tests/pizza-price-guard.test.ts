/**
 * The price guard: the till sends the amount it showed for the lines it places
 * (`expected_subtotal`), and the order routes refuse the request with 409
 * `PRICES_CHANGED` when their own subtotal for those lines differs by a cent or
 * more. Carts are built by the POS's own store and helpers and posted to the
 * real routes of a store set up with the pizza profile and the sample menu.
 *
 * Sample prices: a large pizza 23.00, a topping 2.25, half a topping 1.13, a
 * ranch dip 1.25, the three-large deal 71.25.
 *
 * Run: npm run test:pizza-price-guard
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  runCases,
  createApp,
  startServer,
  api,
  seedCategory,
  seedProduct,
} = require('./helpers/pizza-print-harness');
const { initDatabase, getDatabase } = require('../main/db');
const { registerRoutes } = require('../main/routes/index');
const sample = require('./fixtures/pizza-sample-menu.json');

const frontend = loadFrontend();
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');
const { useCartStore } = require('../frontend/src/store/cart');
const {
  getPizzaCatalog,
  reloadPizzaCatalog,
  reloadPizzaMenuAndLists,
  setPizzaMenuCompanion,
} = require('../frontend/src/lib/pizza/catalog');
const { newSheet, sheetReducer, sheetLine } = require('../frontend/src/lib/pizza/sheet-state');
const { newDeal, dealReducer, dealLine } = require('../frontend/src/lib/pizza/deal-state');
const { chargedAddons } = require('../frontend/src/lib/pizza/toppings');
const {
  cartExpectedSubtotal,
  cartPricedOnline,
  giveBackAppend,
  isPricesChanged,
  isStaleSelectionRefusal,
  repricedCart,
  usePriceGuardStore,
} = require('../frontend/src/lib/pizza/price-guard');
const { productsShown } = require('../frontend/src/lib/pizza/price-refresh');
const {
  appendBody,
  quotedLines,
  retryFingerprint,
  sameRequestApartFromPrices,
} = require('../frontend/src/lib/pizza/quoted-retry');
const {
  buildAppendItemsFingerprint,
  createSafeAppendAttemptStorage,
  getOrCreateAppendAttempt,
  readAppendAttempt,
} = require('../frontend/src/lib/append-attempt');
const { buildCartFingerprintFromState } = require('../frontend/src/lib/order-attempt');
const { randomUUID } = require('node:crypto');

const MESSAGE = 'Prices have changed. Check the order and place it again.';
const json = (value: unknown) => JSON.stringify(value);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(json(actual), json(expected), message);
const cent = (amount: number, cents: number) => Math.round(amount * 100 + cents) / 100;

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
  frontend.api.defaults.baseURL = `${baseUrl}/api`;
  frontend.api.defaults.headers.common.Authorization = headers.Authorization;

  const post = (path: string, body: object) =>
    api(baseUrl, path, { method: 'POST', headers, body });
  const accepted = (response: any, status: number, label: string) =>
    assertEqualOrThrow(
      response.status,
      status,
      `${label} (the server said ${json(response.data)})`,
    );
  const loaded = await post('/api/pizza/menu/import', sample);
  accepted(loaded, 200, 'the sample menu loads');
  seedCategory(db, 'cat-other', 'Other');
  seedProduct(db, 'prod-tea', 'cat-other', 'Tea', 3.5, {
    track_inventory: true,
    stock_quantity: 50,
  });
  seedProduct(db, 'prod-cheese', 'cat-other', 'Cheese by weight', 1.13, {
    sale_unit: 'kg',
    allow_fractional_quantity: true,
  });
  seedProduct(db, 'prod-mint', 'cat-other', 'Mint', 10.7);
  db.prepare("UPDATE product_variants SET online_price = 26.4 WHERE id = 'pz-garden-large'").run();

  const cart = () => useCartStore.getState();
  let products: any[] = [];
  /** Reads the menu and the products the way the POS does. */
  const readPos = async () => {
    await reloadPizzaCatalog();
    products = (await frontend.api.get('/products?active=1')).data.products;
  };
  await readPos();
  const productOf = (id: string) => {
    const product = products.find((entry) => entry.id === id);
    assertOrThrow(Boolean(product), `the server lists the product ${id}`);
    return product;
  };
  const onSaleOf = (product: any) =>
    (product.addon_groups ?? []).flatMap((group: any) => group.addons ?? []);
  /** Add on the sheet, as `usePizzaPos` does it: dips and the topping add-ons of the recipe. */
  const addFromSheet = (first: object, ...actions: object[]) => {
    const state = actions.reduce((now, action) => sheetReducer(now, action), first) as any;
    const line = sheetLine(getPizzaCatalog(), state);
    assertOrThrow(line.canAdd, `the sheet allows Add (${line.message})`);
    const product = productOf(line.productId);
    const dips = line.dips.map((dip: any) => ({
      ...onSaleOf(product).find((entry: any) => entry.id === dip.addonId),
      quantity: dip.quantity,
    }));
    const addons = chargedAddons(dips, line.recipe, onSaleOf(product));
    assertOrThrow(addons !== null, 'the POS sells the topping add-ons');
    cart().addItem(
      product,
      state.quantity,
      addons,
      '',
      product.variants.find((entry: any) => entry.id === line.variantId),
      line.recipe,
    );
  };
  const bacon = { type: 'topping', half: 0, toppingId: 'bacon' };

  /** The request the POS sends for the cart, with what the cart showed unless told otherwise. */
  const createBody = (expected?: number | null | string) => ({
    type: cart().orderType === 'online' ? 'online' : 'takeaway',
    online_platform: cart().orderType === 'online' ? cart().onlinePlatform : undefined,
    items: cart().items.map(cartItemToOrderItem),
    ...(expected === null ? {} : { expected_subtotal: expected ?? cartExpectedSubtotal(cart()) }),
  });
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;
  /** Everything an order writes: its rows, stock, movements, print logs and the order sequence. */
  const written = () =>
    json([
      ...[
        'orders',
        'order_items',
        'order_item_addons',
        'inventory_movements',
        'print_logs',
        'order_audit_log',
        'order_idempotency',
      ].map(count),
      db.prepare("SELECT stock_quantity FROM products WHERE id = 'prod-tea'").get(),
      db.prepare('SELECT subtotal, total, updated_at FROM orders ORDER BY id').all(),
    ]);
  /** A request that must be refused for its price, leaving nothing behind. */
  const refused = async (label: string, send: () => Promise<any>) => {
    const before = written();
    const response = await send();
    accepted(response, 409, `${label}: refused with 409`);
    assertEqualOrThrow(response.data.code, 'PRICES_CHANGED', `${label}: a code a client can test`);
    assertEqualOrThrow(response.data.error, MESSAGE, `${label}: a message a cashier can act on`);
    assertEqualOrThrow(written(), before, `${label}: nothing is written`);
  };
  const teaCart = () => {
    cart().clearCart();
    cart().addItem(productOf('prod-tea'), 2);
  };
  const openOrder = async (body: object = {}) => {
    const response = await post('/api/orders', {
      type: 'takeaway',
      items: [{ product_id: 'prod-mint', quantity: 1 }],
      ...body,
    });
    accepted(response, 201, 'an order to add to is placed');
    return response.data.order;
  };
  const addBody = (expected?: number | null, online = false) => ({
    items: cart().items.map(cartItemToOrderItem),
    ...(expected === null
      ? {}
      : { expected_subtotal: expected ?? cartExpectedSubtotal(cart(), online) }),
  });

  /** One cart per shape of line the brief names; `online` is the platform of an online order. */
  const shapes: Array<{ name: string; subtotal: number; online?: string; build: () => void }> = [
    {
      name: 'a plain item',
      subtotal: 3.5,
      build: () => cart().addItem(productOf('prod-tea'), 1),
    },
    {
      name: 'a sized pizza',
      subtotal: 19,
      build: () => addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'medium' })),
    },
    {
      name: 'a half and half with dips and toppings',
      // 23.00 + one half topping 1.13 + two ranch dips 2.50
      subtotal: 26.63,
      build: () =>
        addFromSheet(
          newSheet({ split: true, sizeId: 'large' }),
          { type: 'pizza', half: 0, pizzaId: 'garden' },
          { type: 'pizza', half: 1, pizzaId: 'classic' },
          bacon,
          { type: 'dip', dipId: 'ranch', count: 2 },
        ),
    },
    {
      name: 'a deal with toppings',
      // 71.25 + two toppings on its first pizza
      subtotal: 75.75,
      build: () => {
        const deal = getPizzaCatalog().deals.find((entry: any) => entry.id === 'three-large-wings');
        let state = newDeal(deal);
        for (const [index, pizzaId] of ['garden', 'island', 'classic'].entries())
          state = dealReducer(state, {
            type: 'pizza',
            index,
            action: { type: 'pizza', half: 0, pizzaId },
          });
        for (const toppingId of ['bacon', 'feta'])
          state = dealReducer(state, {
            type: 'pizza',
            index: 0,
            action: { type: 'topping', half: 0, toppingId },
          });
        state = dealReducer(state, { type: 'wings', flavourId: 'hot' });
        const { recipe } = dealLine(getPizzaCatalog(), state);
        const product = productOf('dl-three-large-wings');
        cart().addItem(product, 1, chargedAddons([], recipe, onSaleOf(product)), '', null, recipe);
      },
    },
    {
      name: 'a weighed item at a half cent',
      // 1.5 kg at 1.13 is 1.695, which the server rounds up
      subtotal: 1.7,
      build: () => cart().addItem(productOf('prod-cheese'), 1.5),
    },
    {
      name: 'a line with a price override',
      subtotal: 39.98,
      build: () => {
        addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'large' }), {
          type: 'quantity',
          quantity: 2,
        });
        cart().setItemPriceOverride(cart().items[0].id, { price: 19.99, reason: 'Owner price' });
      },
    },
    {
      name: 'an online order with a platform price',
      subtotal: 26.4,
      online: 'Sample Eats',
      build: () => addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'large' })),
    },
    {
      name: 'quantities above one',
      // 3 x 10.70, and 2 x (23.00 + 2.25)
      subtotal: 82.6,
      build: () => {
        cart().addItem(productOf('prod-mint'), 3);
        addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'large' }), bacon, {
          type: 'quantity',
          quantity: 2,
        });
      },
    },
  ];
  const buildShape = (shape: (typeof shapes)[number]) => {
    cart().clearCart();
    if (shape.online) {
      cart().setOrderType('online');
      cart().setOnlinePlatform(shape.online);
    }
    shape.build();
  };

  const cases: Record<string, () => Promise<void>> = {
    'Case 1: an order whose expected subtotal is the server’s is placed': async () => {
      teaCart();
      assertEqualOrThrow(cartExpectedSubtotal(cart()), 7, 'the cart showed 2 x 3.50');
      const response = await post('/api/orders', createBody());
      accepted(response, 201, 'the order is accepted');
      assertEqualOrThrow(response.data.order.subtotal, 7, 'at the amount the cart showed');
    },

    'Case 2: a cent off either way is refused and nothing is written': async () => {
      teaCart();
      await refused('a cent under', () => post('/api/orders', createBody(6.99)));
      await refused('a cent over', () => post('/api/orders', createBody(7.01)));
      await refused('far off', () => post('/api/orders', createBody(0)));
      const next = await post('/api/orders', createBody());
      accepted(next, 201, 'the same cart at the right amount is placed');
      const numbers = db.prepare('SELECT order_number FROM orders ORDER BY id').all() as any[];
      assertEqualOrThrow(
        new Set(numbers.map((row) => row.order_number)).size,
        numbers.length,
        'and no order number was used twice',
      );
    },

    'Case 3: a request without the field is priced and placed as before': async () => {
      teaCart();
      const bare = await post('/api/orders', createBody(null));
      accepted(bare, 201, 'the order is accepted with no expected_subtotal');
      const guarded = await post('/api/orders', createBody());
      const money = (order: any) => [order.subtotal, order.tax_amount, order.total];
      same(money(bare.data.order), money(guarded.data.order), 'the same money either way');
      const explicitNull = await post('/api/orders', {
        ...createBody(null),
        expected_subtotal: null,
      });
      accepted(explicitNull, 201, 'null is read as absent');
    },

    'Case 4: an expected subtotal that is not a number is refused as a bad request': async () => {
      teaCart();
      const before = written();
      const response = await post('/api/orders', createBody('7.00'));
      accepted(response, 400, 'text is refused with 400');
      assertEqualOrThrow(written(), before, 'and nothing is written');
    },

    'Case 5: adding items is guarded the same way': async () => {
      const order = await openOrder();
      teaCart();
      const path = `/api/orders/${order.id}/items`;
      await refused('add items a cent under', () => post(path, addBody(6.99)));
      await refused('add items a cent over', () => post(path, addBody(7.01)));
      const equal = await post(path, addBody());
      accepted(equal, 200, 'the items are added at the amount the cart showed');
      assertEqualOrThrow(equal.data.order.subtotal, 17.7, '10.70 + 2 x 3.50');
      const bare = await post(path, addBody(null));
      accepted(bare, 200, 'and without the field as before');
      assertEqualOrThrow(bare.data.order.subtotal, 24.7, 'two more teas');
      const text = await post(path, { ...addBody(null), expected_subtotal: '7' });
      accepted(text, 400, 'text is refused with 400');
    },

    'Case 6: the cart shows the weighed half cent as the server rounds it, and sends the same':
      async () => {
        cart().clearCart();
        cart().addItem(productOf('prod-cheese'), 1.5);
        assertEqualOrThrow(cart().subtotal(), 1.7, 'the cart shows 1.695 rounded up: 1.70');
        assertEqualOrThrow(cartExpectedSubtotal(cart()), 1.7, 'and sends 1.70');
      },

    'Case 7: a line whose request carries an item discount is priced without it': async () => {
      teaCart();
      const body = createBody();
      (body.items[0] as any).discount_amount = 2;
      const response = await post('/api/orders', body);
      accepted(response, 201, 'the routes take no item discount, so the cart figure stands');
      assertEqualOrThrow(response.data.order.subtotal, 7, 'undiscounted');
    },
  };

  for (const shape of shapes) {
    cases[`Shape: ${shape.name}, created`] = async () => {
      buildShape(shape);
      assertEqualOrThrow(cartExpectedSubtotal(cart()), shape.subtotal, 'the cart figure');
      assertEqualOrThrow(cart().subtotal(), shape.subtotal, 'is the amount the cart shows');
      const response = await post('/api/orders', createBody());
      accepted(response, 201, 'the order is accepted');
      assertEqualOrThrow(response.data.order.subtotal, shape.subtotal, 'the server agrees');
      await refused('a cent off', () => post('/api/orders', createBody(cent(shape.subtotal, -1))));
    };
    cases[`Shape: ${shape.name}, added to an order`] = async () => {
      const order = await openOrder(
        shape.online ? { type: 'online', online_platform: shape.online } : {},
      );
      buildShape(shape);
      const path = `/api/orders/${order.id}/items`;
      const expected = cartExpectedSubtotal(cart(), Boolean(order.online_platform));
      assertEqualOrThrow(expected, shape.subtotal, 'the cart figure');
      assertEqualOrThrow(
        cart().subtotal(cartPricedOnline(cart(), order)),
        shape.subtotal,
        'is the amount the cart shows while adding to the order',
      );
      await refused('a cent off', () => post(path, addBody(cent(shape.subtotal, 1))));
      const response = await post(path, addBody(expected));
      accepted(response, 200, 'the items are added');
      assertEqualOrThrow(
        cent(response.data.order.subtotal - order.subtotal, 0),
        shape.subtotal,
        'the server adds the same amount',
      );
    };
  }

  Object.assign(cases, {
    'Case 8: a till that missed a price change is refused, re-priced with every line kept, and placed':
      async () => {
        cart().clearCart();
        addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'large' }), bacon);
        cart().addItem(productOf('prod-tea'), 2);
        assertEqualOrThrow(
          cartExpectedSubtotal(cart()),
          32.25,
          'the till shows 23.00 + 2.25 + 7.00',
        );

        const dearer = structuredClone(sample);
        dearer.sizes.pizza.find((size: any) => size.id === 'large').price = 24.5;
        dearer.toppings.price = 3;
        accepted(await post('/api/pizza/menu/import', dearer), 200, 'another device loads a menu');

        const before = written();
        let refusal: unknown;
        await frontend.api.post('/orders', createBody()).catch((error: unknown) => {
          refusal = error;
        });
        assertOrThrow(isPricesChanged(refusal), 'the POS reads the refusal as a price change');
        assertEqualOrThrow(written(), before, 'and no order exists');

        await readPos();
        const fresh = repricedCart(cart().items, products);
        same(fresh.offSale, [], 'every item is still on sale');
        useCartStore.setState({ items: fresh.items });
        same(
          cart().items.map((item: any) => [item.product.id, item.quantity]),
          [
            ['pz-garden', 1],
            ['prod-tea', 2],
          ],
          'every line is kept, in its place',
        );
        assertEqualOrThrow(
          cartExpectedSubtotal(cart()),
          34.5,
          'the cart shows 24.50 + 3.00 + 7.00',
        );
        const placed = await post('/api/orders', createBody());
        accepted(placed, 201, 'placing again succeeds');
        assertEqualOrThrow(placed.data.order.subtotal, 34.5, 'at the new price');

        accepted(await post('/api/pizza/menu/import', sample), 200, 'the sample loads again');
        await readPos();
      },

    'Case 9: re-pricing marks a line that is no longer on sale and keeps it': async () => {
      cart().clearCart();
      addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'large' }), bacon);
      cart().addItem(productOf('prod-tea'), 2);
      cart().addItem(productOf('prod-mint'), 1);
      cart().setItemPriceOverride(cart().items[2].id, { price: 9, reason: 'Owner price' });
      const [pizza, tea, mint] = cart().items;

      const dearer = structuredClone(products).filter((entry: any) => entry.id !== 'prod-tea');
      dearer.find((entry: any) => entry.id === 'prod-mint').price = 12;
      const fresh = repricedCart(cart().items, dearer);
      same(fresh.offSale, [tea.id], 'the tea is marked');
      same(
        fresh.items.map((item: any) => item.id),
        [pizza.id, tea.id, mint.id],
        'no line is dropped',
      );
      assertEqualOrThrow(fresh.items[1].product.price, 3.5, 'the line off sale is left as it was');
      assertEqualOrThrow(fresh.items[2].price_override.price, 9, 'an override is kept');
      assertEqualOrThrow(fresh.items[2].product.price, 12, 'over the new menu price');

      const noBacon = structuredClone(products);
      for (const product of noBacon)
        for (const group of product.addon_groups ?? [])
          group.addons = (group.addons ?? []).filter((addon: any) => addon.id !== 'ad-topping');
      same(
        repricedCart(cart().items, noBacon).offSale,
        [pizza.id],
        'a line whose add-on left the menu is marked',
      );
      const noLarge = structuredClone(products);
      const garden = noLarge.find((entry: any) => entry.id === 'pz-garden');
      garden.variants = garden.variants.filter((entry: any) => entry.id !== 'pz-garden-large');
      same(
        repricedCart(cart().items, noLarge).offSale,
        [pizza.id],
        'and so is one whose size left it',
      );
    },

    'Case 10: the refresh after a refusal loads the lists whether or not the menu changed':
      async () => {
        let applied = 0;
        let asked = 0;
        setPizzaMenuCompanion(async () => {
          asked += 1;
          return () => {
            applied += 1;
          };
        });
        const held = getPizzaCatalog();
        await reloadPizzaMenuAndLists();
        same([asked, applied], [1, 1], 'an unchanged menu still gets fresh lists');
        assertOrThrow(getPizzaCatalog() === held, 'and stays the menu held');

        const dearer = structuredClone(sample);
        dearer.sizes.pizza.find((size: any) => size.id === 'large').price = 24.5;
        accepted(await post('/api/pizza/menu/import', dearer), 200, 'the menu changes');
        const shown: Array<[number, number]> = [];
        let at = applied;
        setPizzaMenuCompanion(async () => () => {
          applied += 1;
          shown.push([
            applied,
            getPizzaCatalog().sizes.find((size: any) => size.id === 'large').priceCents,
          ]);
        });
        await reloadPizzaMenuAndLists();
        same(shown, [[at + 1, 2450]], 'a changed menu and its lists go on screen once, together');
        setPizzaMenuCompanion(null);
        accepted(await post('/api/pizza/menu/import', sample), 200, 'the sample loads again');
        at = applied;
        await reloadPizzaMenuAndLists();
        assertEqualOrThrow(applied, at, 'with no screen showing lists there is nothing to apply');
      },
  });

  const keyedPost = (path: string, body: object, key: string) =>
    api(baseUrl, path, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': key },
      body,
    });
  /** Another device loads the sample with dearer toppings; the till re-prices from the new lists. */
  const dearerToppings = async () => {
    const dearer = structuredClone(sample);
    dearer.toppings.price = 3;
    accepted(await post('/api/pizza/menu/import', dearer), 200, 'another device loads a menu');
    await readPos();
    useCartStore.setState({
      items: repricedCart(cart().items, products).items,
    });
  };
  const sampleAgain = async () => {
    accepted(await post('/api/pizza/menu/import', sample), 200, 'the sample loads again');
    await readPos();
  };
  const memoryStorage = () => {
    const map = new Map<string, string>();
    return createSafeAppendAttemptStorage({
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    });
  };
  const until = async (done: () => boolean, label: string) => {
    for (let waited = 0; !done(); waited += 20) {
      assertOrThrow(waited < 5000, `${label} within five seconds`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** A postpaid create request for the cart, as the POS fingerprints it: without the quote. */
  const postpaidPayload = () => ({
    table_id: null,
    customer_id: null,
    type: 'takeaway',
    items: cart().items.map(cartItemToOrderItem),
  });
  /** The postpaid request the POS sends under a stored attempt: its lines and quote at the end. */
  const replay = (fingerprint: string, quote: number | undefined) => ({
    ...postpaidPayload(),
    ...quotedLines(fingerprint, quote),
  });
  const pizzaAndTea = () => {
    cart().clearCart();
    addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'large' }), bacon);
    cart().addItem(productOf('prod-tea'), 2);
  };

  Object.assign(cases, {
    'G1: an append attempt keeps the quote and the cart lines it was sent with': async () => {
      pizzaAndTea();
      const storage = memoryStorage();
      const items = cart().items.map(cartItemToOrderItem);
      getOrCreateAppendAttempt(storage, {
        userId: 'cashier',
        orderId: 7,
        fingerprint: buildAppendItemsFingerprint(7, items),
        createKey: randomUUID,
        items,
        expectedSubtotal: cartExpectedSubtotal(cart()),
        lines: cart().items,
      });
      const stored = readAppendAttempt(storage, { userId: 'cashier' });
      assertEqualOrThrow(stored.expectedSubtotal, 32.25, 'the stored attempt holds the quote');
      same(stored.lines, cart().items, 'and the lines as the cart held them');
      same(
        appendBody(stored),
        { items, expected_subtotal: 32.25 },
        'a replay sends the stored lines with the stored quote',
      );
    },

    'G1: an append replayed after a reload is refused at new prices and its lines come back':
      async () => {
        const order = await openOrder();
        pizzaAndTea();
        const storage = memoryStorage();
        const items = cart().items.map(cartItemToOrderItem);
        getOrCreateAppendAttempt(storage, {
          userId: 'cashier',
          orderId: order.id,
          fingerprint: buildAppendItemsFingerprint(order.id, items),
          createKey: randomUUID,
          items,
          expectedSubtotal: cartExpectedSubtotal(cart()),
          lines: cart().items,
          orderNumber: order.order_number,
        });
        // The request never reached the server; the till reloads with an empty cart.
        const stored = readAppendAttempt(storage, { userId: 'cashier' });
        const lines = cart().items;
        cart().clearCart();
        try {
          await dearerToppings();
          await refused('the replayed append', () =>
            keyedPost(`/api/orders/${order.id}/items`, appendBody(stored), stored.idempotencyKey),
          );
          assertOrThrow(giveBackAppend(stored, order), 'the lines go back to the empty cart');
          same(cart().items, lines, 'every line, in its place');
          same(
            [cart().orderType, cart().tableId],
            [order.type, order.table_id],
            'set up for the order they were for',
          );
          assertOrThrow(!giveBackAppend(stored, order), 'never over lines already in the cart');
        } finally {
          await sampleAgain();
        }
      },

    'G2: what makes two requests different orders leaves out the quote and add-on prices':
      async () => {
        pizzaAndTea();
        const sentCart = buildCartFingerprintFromState(cart());
        const sentPostpaid = JSON.stringify(postpaidPayload());
        const legacyPostpaid = JSON.stringify({
          ...postpaidPayload(),
          expected_subtotal: 32.25,
        });
        const sentAppend = buildAppendItemsFingerprint(7, postpaidPayload().items);
        await dearerToppings();
        try {
          const nowCart = buildCartFingerprintFromState(cart());
          const nowPostpaid = JSON.stringify(postpaidPayload());
          assertOrThrow(
            nowPostpaid !== sentPostpaid,
            'the re-priced request sends another add-on price',
          );
          assertOrThrow(
            sameRequestApartFromPrices(sentPostpaid, nowPostpaid),
            'postpaid: same order',
          );
          assertOrThrow(
            sameRequestApartFromPrices(sentCart, nowCart),
            'prepaid and send to payment',
          );
          assertOrThrow(sameRequestApartFromPrices(legacyPostpaid, nowPostpaid), 'a stored quote');
          const nowAppend = buildAppendItemsFingerprint(7, postpaidPayload().items);
          assertEqualOrThrow(
            retryFingerprint(sentAppend, nowAppend),
            sentAppend,
            'append: the stored one',
          );
          cart().updateQuantity(cart().items[1].id, 3);
          const more = JSON.stringify(postpaidPayload());
          assertOrThrow(
            !sameRequestApartFromPrices(sentPostpaid, more),
            'another quantity is another order',
          );
          assertEqualOrThrow(
            retryFingerprint(sentAppend, buildAppendItemsFingerprint(7, postpaidPayload().items)),
            buildAppendItemsFingerprint(7, postpaidPayload().items),
            'and another append',
          );
          cart().setItemPriceOverride(cart().items[1].id, {
            price: 1,
            reason: 'Owner price',
          });
          const overridden = JSON.stringify(postpaidPayload());
          assertOrThrow(!sameRequestApartFromPrices(more, overridden), 'so is an owner price');
          assertOrThrow(
            !sameRequestApartFromPrices(undefined, more),
            'no stored attempt, no match',
          );
        } finally {
          await sampleAgain();
        }
      },

    'G2: the replayed body is the body first sent under the key': async () => {
      pizzaAndTea();
      const first = postpaidPayload();
      const sent = { ...first, expected_subtotal: 32.25 };
      await dearerToppings();
      try {
        same(replay(JSON.stringify(first), 32.25), sent, 'stored lines and quote');
        same(replay(JSON.stringify(sent), undefined), sent, 'a quote inside the fingerprint');
        same(replay(JSON.stringify(first), undefined), first, 'no quote then, none now');
        const cartFingerprint = buildCartFingerprintFromState(cart());
        same(
          quotedLines(cartFingerprint, 34.5),
          { items: JSON.parse(cartFingerprint).items, expected_subtotal: 34.5 },
          'the lines of a cart fingerprint',
        );
      } finally {
        await sampleAgain();
      }
    },

    'G2: a create whose answer was lost is answered with that order after a re-price': async () => {
      pizzaAndTea();
      const fingerprint = JSON.stringify(postpaidPayload());
      const quote = cartExpectedSubtotal(cart());
      const key = randomUUID();
      const first = await keyedPost('/api/orders', replay(fingerprint, quote), key);
      accepted(first, 201, 'the order is placed; its answer is lost');
      try {
        await dearerToppings();
        const now = JSON.stringify(postpaidPayload());
        assertOrThrow(sameRequestApartFromPrices(fingerprint, now), 'the till sees the same order');
        const orders = count('orders');
        const retried = await keyedPost('/api/orders', replay(fingerprint, quote), key);
        accepted(retried, 200, 'the retry is answered from the order placed');
        assertEqualOrThrow(retried.data.order.id, first.data.order.id, 'the same order');
        assertEqualOrThrow(count('orders'), orders, 'and no second one');
      } finally {
        await sampleAgain();
      }
    },

    'G2: a create that never arrived is refused for its quote, then placed at the new prices':
      async () => {
        pizzaAndTea();
        const fingerprint = JSON.stringify(postpaidPayload());
        const quote = cartExpectedSubtotal(cart());
        const key = randomUUID();
        try {
          await dearerToppings();
          await refused('the retry', () =>
            keyedPost('/api/orders', replay(fingerprint, quote), key),
          );
          const fresh = {
            ...postpaidPayload(),
            expected_subtotal: cartExpectedSubtotal(cart()),
          };
          const placed = await keyedPost('/api/orders', fresh, randomUUID());
          accepted(placed, 201, 'placed again under a new key');
          assertEqualOrThrow(placed.data.order.subtotal, 33, 'at the new price: 23 + 3 + 7');
        } finally {
          await sampleAgain();
        }
      },

    'G3: adding to an online order shows that order’s platform prices': async () => {
      const order = await openOrder({
        type: 'online',
        online_platform: 'Sample Eats',
      });
      cart().clearCart();
      addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'large' }));
      assertOrThrow(!cartPricedOnline(cart(), null), 'a counter cart shows standard prices');
      assertEqualOrThrow(cart().subtotal(), 23, 'the large Garden at 23.00');
      const online = cartPricedOnline(cart(), order);
      assertOrThrow(online, 'adding to the online order prices it for its platform');
      assertEqualOrThrow(cart().subtotal(online), 26.4, 'the cart shows 26.40');
      const response = await post(`/api/orders/${order.id}/items`, addBody(undefined, online));
      accepted(response, 200, 'and the server adds 26.40');
    },

    'G4: published lists re-price and mark the cart at once; a stale line is a refresh cue':
      async () => {
        pizzaAndTea();
        productsShown(products);
        const settled = cart().items;
        productsShown(structuredClone(products));
        assertOrThrow(cart().items === settled, 'lists that came with no menu change nothing');

        const stale = cart().items;
        const noToppings = structuredClone(sample);
        delete noToppings.toppings;
        setPizzaMenuCompanion(async () => {
          const list = (await frontend.api.get('/products?active=1')).data.products;
          return () => productsShown(list);
        });
        try {
          accepted(
            await post('/api/pizza/menu/import', noToppings),
            200,
            'a menu without toppings',
          );
          let refusal: any;
          await frontend.api.post('/orders', createBody()).catch((error: unknown) => {
            refusal = error;
          });
          assertOrThrow(
            isStaleSelectionRefusal(refusal),
            `the server refuses the stale topping (${json(refusal?.response?.data?.error)})`,
          );
          assertOrThrow(!isPricesChanged(refusal), 'before it compares the prices');
          assertOrThrow(
            isStaleSelectionRefusal({
              response: {
                status: 400,
                data: { error: 'Garden is not on the menu. Pick another item' },
              },
            }),
            'and so is a product taken off the menu',
          );
          await reloadPizzaCatalog();
          await until(() => usePriceGuardStore.getState().offSale.length > 0, 'the cart is marked');
          same(usePriceGuardStore.getState().offSale, [stale[0].id], 'the pizza with a topping');
          assertEqualOrThrow(cart().items.length, 2, 'every line is kept');
        } finally {
          setPizzaMenuCompanion(null);
          await sampleAgain();
        }
        const order = await openOrder();
        let other: any;
        await frontend.api
          .post(`/orders/${order.id}/items`, { items: [] })
          .catch((error: unknown) => (other = error));
        assertOrThrow(!isStaleSelectionRefusal(other), 'another refusal is not a stale line');
      },
  });

  await runCases('pizza-price-guard', cases);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
