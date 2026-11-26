/**
 * The seam between the POS and the server: lines built by the pizza sheet and
 * the cart store, turned into a request by `cartItemToOrderItem`, are posted
 * unchanged to the real order routes of a store set up with the pizza profile
 * and the sample menu loaded by the real importer.
 *
 * Run: npm run test:pizza-pos-order-seam
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
const { isDeepStrictEqual } = require('node:util');
const { initDatabase, getDatabase } = require('../main/db');
const { registerRoutes } = require('../main/routes/index');
const { parseMenuFile } = require('../shared/pizza/menu');
const sample = require('./fixtures/pizza-sample-menu.json');

const frontend = loadFrontend();
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');
const { useCartStore } = require('../frontend/src/store/cart');
const { getPizzaCatalog, reloadPizzaCatalog } = require('../frontend/src/lib/pizza/catalog');
const {
  newSheet,
  sheetReducer,
  sheetLine,
  sheetQuote,
} = require('../frontend/src/lib/pizza/sheet-state');
const { customizeOne, replaceCartLine } = require('../frontend/src/lib/pizza/cart-lines');

const json = (value: unknown) => JSON.stringify(value);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${json(actual)})`);
const cart = () => useCartStore.getState();
/** Applies actions in order, as taps on the sheet would. */
const tapped = (state: object, ...actions: object[]) =>
  actions.reduce((current, action) => sheetReducer(current, action), state);

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

  let products: any[] = [];
  /** Reads the catalogue's products the way the POS does, with variants and add-on groups. */
  const readProducts = async () => {
    products = (await frontend.api.get('/products')).data.products;
  };
  const productOf = (id: string) => {
    const product = products.find((entry) => entry.id === id);
    assertOrThrow(Boolean(product), `the server lists the product ${id}`);
    return product;
  };
  const variantOf = (product: any, id: string) => {
    const variant = (product.variants ?? []).find((entry: any) => entry.id === id);
    assertOrThrow(Boolean(variant), `${product.id} has the variant ${id}`);
    return variant;
  };
  const addonOf = (product: any, id: string, quantity = 1) => {
    const addon = (product.addon_groups ?? [])
      .flatMap((group: any) => group.addons ?? [])
      .find((entry: any) => entry.id === id);
    assertOrThrow(Boolean(addon), `${product.id} offers the add-on ${id}`);
    return { ...addon, quantity };
  };

  const catalog = () => getPizzaCatalog();
  const sizePrice = (sizeId: string) =>
    catalog().sizes.find((size: any) => size.id === sizeId).priceCents / 100;
  /** What the sheet describes, as the objects the cart holds. */
  const cartPartsOf = (state: any) => {
    const line = sheetLine(catalog(), state);
    assertOrThrow(line.canAdd, `the sheet allows Add (${line.message})`);
    const product = productOf(line.productId);
    return {
      // What the sheet shows for one of the pizza: the cart's own prices for the POS product.
      line: { ...line, unit: sheetQuote(catalog(), state, products, false).unit },
      product,
      variant: variantOf(product, line.variantId),
      addons: line.dips.map((dip: any) => addonOf(product, dip.addonId, dip.quantity)),
      quantity: state.quantity,
      special_instructions: state.note,
      recipe: line.recipe,
    };
  };
  /** Add on the sheet: the line goes into the cart store. */
  const addFromSheet = (state: any) => {
    const parts = cartPartsOf(state);
    cart().addItem(
      parts.product,
      parts.quantity,
      parts.addons,
      parts.special_instructions,
      parts.variant,
      parts.recipe,
    );
    return parts.line;
  };
  /** Save on the sheet: the edited line goes back where it stood. */
  const saveFromSheet = (lineId: string, state: any) => {
    const { line, ...parts } = cartPartsOf(state);
    const old = cart().items.find((item: any) => item.id === lineId);
    useCartStore.setState({ items: replaceCartLine(cart().items, lineId, { ...old, ...parts }) });
    return line;
  };

  const cartPayload = () => cart().items.map(cartItemToOrderItem);
  /** Posts the cart as it is; the request holds exactly what `cartItemToOrderItem` gives. */
  const placeCart = async () => {
    const items = cartPayload();
    const response = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers,
      body: { type: 'takeaway', items },
    });
    return { items, response, order: response.data?.order };
  };
  /** The order's lines that are still part of the sale, oldest first. */
  const liveRows = (orderId: number) =>
    db
      .prepare(
        "SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded') ORDER BY id",
      )
      .all(orderId) as any[];
  const storedRecipes = (orderId: number) =>
    liveRows(orderId).map((row) => JSON.parse(row.modifier_selection));
  /** Reads a placed order the way a screen does, and puts its one line into an empty cart. */
  const openStoredLine = async (orderId: number) => {
    const read = await api(baseUrl, `/api/orders/${orderId}`, { headers });
    assertEqualOrThrow(read.status, 200, 'the placed order can be read');
    const items = (read.data.order ?? read.data).items.filter(
      (item: any) => !['cancelled', 'voided', 'void_adjustment'].includes(item.status),
    );
    assertEqualOrThrow(items.length, 1, 'the order has one live line');
    const [stored] = items;
    const product = productOf(stored.product_id);
    cart().clearCart();
    cart().addItem(
      product,
      stored.quantity,
      [],
      stored.special_instructions ?? '',
      variantOf(product, stored.variant_id),
      stored.modifier_selection,
    );
    return { stored, line: cart().items[0] };
  };
  let editKey = 0;
  /** A replacement edit whose replacement is exactly the cart line's request payload. */
  const replaceStoredLine = (orderId: number, stored: any) =>
    api(baseUrl, `/api/orders/${orderId}/items/${stored.id}/edit`, {
      method: 'PATCH',
      headers: { ...headers, 'Idempotency-Key': `pizza-seam-${++editKey}` },
      body: {
        expected_edit_version: stored.edit_version,
        replacement: cartItemToOrderItem(cart().items[0]),
      },
    });
  const accepted = (response: any, status: number, label: string) =>
    assertEqualOrThrow(
      response.status,
      status,
      `${label} (the server said ${json(response.data)})`,
    );

  const noOlives = () =>
    tapped(newSheet({ pizzaId: 'garden', sizeId: 'large' }), {
      type: 'ingredient',
      half: 0,
      name: 'Olives',
    });

  await runCases('pizza-pos-order-seam', {
    'Case 8: with no menu loaded, an ordinary product orders exactly as upstream': async () => {
      const raw = await api(baseUrl, '/api/pizza/catalog', { headers });
      assertEqualOrThrow(
        raw.status,
        404,
        'the catalogue route answers 404 before a menu is loaded',
      );
      assertEqualOrThrow(
        await reloadPizzaCatalog(),
        null,
        'the client reads that as no pizza menu',
      );
      assertEqualOrThrow(getPizzaCatalog(), null, 'and holds no catalogue');

      seedCategory(db, 'cat-other', 'Other');
      seedProduct(db, 'prod-tea', 'cat-other', 'Tea', 3.5);
      await readProducts();
      cart().clearCart();
      cart().addItem(productOf('prod-tea'), 2);
      const { items, response, order } = await placeCart();
      same(
        items,
        [
          {
            product_id: 'prod-tea',
            variant_id: null,
            quantity: 2,
            addons: null,
            special_instructions: null,
          },
        ],
        'the request is the upstream one, with no modifier_selection',
      );
      accepted(response, 201, 'the order is accepted');
      assertEqualOrThrow(order.items[0].unit_price, 3.5, 'at the product price');
      assertEqualOrThrow(order.subtotal, 7, 'two of them');
      same(storedRecipes(order.id), [null], 'and nothing is stored as a recipe');
    },

    'Case 0: the catalogue route answers the menu the importer loaded': async () => {
      const loaded = await api(baseUrl, '/api/pizza/menu/import', {
        method: 'POST',
        headers,
        body: sample,
      });
      accepted(loaded, 200, 'the sample menu loads through the import route');
      assertEqualOrThrow(loaded.data.untaxed, false, 'with tax categories from the pizza profile');
      const fetched = await reloadPizzaCatalog();
      same(
        fetched,
        JSON.parse(json(parseMenuFile(sample))),
        'loadPizzaCatalog gets the catalogue parseMenuFile gives for the same file',
      );
      assertOrThrow(getPizzaCatalog() === fetched, 'and holds it for the sheet and the cart');
      await readProducts();
    },

    'Case 1: a plain large pizza': async () => {
      cart().clearCart();
      const line = addFromSheet(newSheet({ pizzaId: 'garden', sizeId: 'large' }));
      assertEqualOrThrow(line.recipe, null, 'the sheet gives a plain pizza no recipe');
      const { items, response, order } = await placeCart();
      same(
        items,
        [
          {
            product_id: 'pz-garden',
            variant_id: 'pz-garden-large',
            quantity: 1,
            addons: null,
            special_instructions: null,
            modifier_selection: null,
          },
        ],
        'the request says the pizza has no recipe',
      );
      accepted(response, 201, 'the order is accepted');
      same(storedRecipes(order.id), [null], 'stored with no recipe');
      assertEqualOrThrow(order.items[0].unit_price, sizePrice('large'), 'at the large price');
      assertEqualOrThrow(order.subtotal, line.unit, 'which is what the sheet showed');
    },

    'Case 2: a large pizza with two removals, well done': async () => {
      cart().clearCart();
      const line = addFromSheet(
        tapped(
          newSheet({ pizzaId: 'garden', sizeId: 'large' }),
          { type: 'ingredient', half: 0, name: 'Onions' },
          { type: 'ingredient', half: 0, name: 'Olives' },
          { type: 'cook', cook: 'well-done' },
        ),
      );
      const { items, response, order } = await placeCart();
      same(items[0].modifier_selection, line.recipe, 'the request carries the sheet recipe');
      accepted(response, 201, 'the order is accepted');
      same(
        storedRecipes(order.id),
        [
          {
            kind: 'pizza',
            v: 1,
            sizeId: 'large',
            whole: { pizzaId: 'garden', removed: ['Olives', 'Onions'] },
            cook: 'well-done',
          },
        ],
        'stored normalised',
      );
      same(storedRecipes(order.id), [line.recipe], 'and equal to what the sheet produced');
      assertEqualOrThrow(order.items[0].unit_price, sizePrice('large'), 'at the large price');
      assertEqualOrThrow(order.subtotal, line.unit, 'which is what the sheet showed');
    },

    'Case 3: a half and half with a removal on one half, and two of one dip': async () => {
      cart().clearCart();
      const line = addFromSheet(
        tapped(
          newSheet({ split: true, sizeId: 'large' }),
          { type: 'pizza', half: 0, pizzaId: 'garden' },
          { type: 'ingredient', half: 0, name: 'Olives' },
          { type: 'pizza', half: 1, pizzaId: 'classic' },
          { type: 'dip', dipId: 'ranch', count: 2 },
        ),
      );
      const { items, response, order } = await placeCart();
      accepted(response, 201, 'the order is accepted');
      assertEqualOrThrow(items[0].product_id, 'pz-half-and-half', 'the request names the product');
      assertEqualOrThrow(order.items[0].product_id, 'pz-half-and-half', 'and so does the order');
      same(
        storedRecipes(order.id),
        [
          {
            kind: 'pizza',
            v: 1,
            sizeId: 'large',
            halves: [
              { pizzaId: 'garden', removed: ['Olives'] },
              { pizzaId: 'classic', removed: [] },
            ],
          },
        ],
        'the stored recipe has both halves, first half first',
      );
      same(storedRecipes(order.id), [line.recipe], 'and equals what the sheet produced');
      assertEqualOrThrow(
        order.items[0].unit_price,
        sizePrice('large'),
        'the pizza is the size price',
      );
      same(
        order.items[0].addons.map((addon: any) => [addon.id, addon.quantity, addon.price]),
        [['ad-dips-ranch', 2, 1.25]],
        'with two ranch dips at the dip price',
      );
      assertEqualOrThrow(order.subtotal, 25.5, 'the size price plus the dips');
      assertEqualOrThrow(order.subtotal, line.unit, 'which is what the sheet showed');
    },

    'Case 4: "Customize 1" on a 2x line, then one removal on the split line': async () => {
      cart().clearCart();
      addFromSheet(
        tapped(newSheet({ pizzaId: 'garden', sizeId: 'large' }), { type: 'quantity', quantity: 2 }),
      );
      assertEqualOrThrow(cart().items[0].quantity, 2, 'the cart holds one 2x line');
      const split = customizeOne(cart().items, cart().items[0].id);
      useCartStore.setState({ items: split.items });
      const line = saveFromSheet(
        split.line.id,
        tapped(
          newSheet(),
          { type: 'load', line: split.line },
          { type: 'ingredient', half: 0, name: 'Olives' },
        ),
      );
      const { items, response, order } = await placeCart();
      same(
        items.map((item: any) => [item.quantity, item.modifier_selection]),
        [
          [1, null],
          [1, line.recipe],
        ],
        'the request has two lines, one plain and one with the removal',
      );
      accepted(response, 201, 'the order is accepted');
      same(
        liveRows(order.id).map((row) => [row.quantity, JSON.parse(row.modifier_selection)]),
        [
          [1, null],
          [
            1,
            {
              kind: 'pizza',
              v: 1,
              sizeId: 'large',
              whole: { pizzaId: 'garden', removed: ['Olives'] },
            },
          ],
        ],
        'two order lines: one without a recipe, one with',
      );
      same(
        order.items.map((item: any) => item.unit_price),
        [sizePrice('large'), sizePrice('large')],
        'both at the large price',
      );
    },

    'Case 5: a stored "no olives" pizza edited back to plain': async () => {
      cart().clearCart();
      addFromSheet(noOlives());
      const placed = await placeCart();
      accepted(placed.response, 201, 'the "no olives" pizza is placed');
      same(
        storedRecipes(placed.order.id)[0].whole.removed,
        ['Olives'],
        'and stored with the removal',
      );

      const { stored, line } = await openStoredLine(placed.order.id);
      const plain = saveFromSheet(
        line.id,
        // Off, then extra, then back to normal.
        tapped(
          newSheet(),
          { type: 'load', line },
          { type: 'ingredient', half: 0, name: 'Olives' },
          { type: 'ingredient', half: 0, name: 'Olives' },
        ),
      );
      assertEqualOrThrow(
        plain.recipe,
        null,
        'the sheet gives the pizza no recipe once olives are back',
      );
      const replacement = cartItemToOrderItem(cart().items[0]);
      assertOrThrow(
        'modifier_selection' in replacement && replacement.modifier_selection === null,
        'the cart sends modifier_selection: null',
      );
      const edited = await replaceStoredLine(placed.order.id, stored);
      accepted(edited, 200, 'the replacement edit is accepted');
      same(storedRecipes(placed.order.id), [null], 'the stored recipe is cleared');
      assertEqualOrThrow(
        liveRows(placed.order.id)[0].unit_price,
        sizePrice('large'),
        'and the line is still the large price',
      );
    },

    'Case 6: a stored pizza with a removal moved to another size': async () => {
      cart().clearCart();
      addFromSheet(noOlives());
      const placed = await placeCart();
      accepted(placed.response, 201, 'the "no olives" pizza is placed');

      const { stored, line } = await openStoredLine(placed.order.id);
      const medium = variantOf(line.product, 'pz-garden-medium');
      cart().updateItemDetails(
        line.id,
        line.quantity,
        line.addons,
        line.special_instructions,
        medium,
      );
      const replacement = cartItemToOrderItem(cart().items[0]);
      assertEqualOrThrow(replacement.variant_id, 'pz-garden-medium', 'the cart sends the new size');
      const edited = await replaceStoredLine(placed.order.id, stored);
      accepted(edited, 200, 'the replacement edit is accepted');
      same(
        storedRecipes(placed.order.id),
        [
          {
            kind: 'pizza',
            v: 1,
            sizeId: 'medium',
            whole: { pizzaId: 'garden', removed: ['Olives'] },
          },
        ],
        'the recipe keeps its removal at the new size',
      );
      const [row] = liveRows(placed.order.id);
      assertEqualOrThrow(row.variant_id, 'pz-garden-medium', 'the line is the medium variant');
      assertEqualOrThrow(row.unit_price, sizePrice('medium'), 'at the medium price');
    },

    'Case 7: a side with its required choice, and a drink in a can': async () => {
      cart().clearCart();
      const wings = productOf('sd-wings');
      const cola = productOf('dr-cola');
      cart().addItem(wings, 1, [addonOf(wings, 'ad-wings-flavour-hot')]);
      cart().addItem(cola, 1, [], '', variantOf(cola, 'dr-cola-can'));
      const { items, response, order } = await placeCart();
      assertOrThrow(
        items.every((item: object) => !('modifier_selection' in item)),
        'neither request line has a modifier_selection key',
      );
      same(
        items.map((item: any) => [item.product_id, item.variant_id]),
        [
          ['sd-wings', null],
          ['dr-cola', 'dr-cola-can'],
        ],
        'the request names the side and the can',
      );
      accepted(response, 201, 'the order is accepted');
      const side = catalog().sides.find((entry: any) => entry.id === 'wings');
      const can = catalog().drinkVariants.find((entry: any) => entry.id === 'can');
      same(
        order.items.map((item: any) => item.unit_price),
        [side.priceCents / 100, can.priceCents / 100],
        'at the side price and the can price',
      );
      same(storedRecipes(order.id), [null, null], 'and neither line stores a recipe');
    },
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
