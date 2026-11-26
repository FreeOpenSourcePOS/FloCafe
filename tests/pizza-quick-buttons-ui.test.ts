/**
 * Quick buttons on the POS: the module the screen stands on, against the real
 * quick-button routes of a store set up with the pizza profile and the sample
 * menu loaded by the real importer. A cart line becomes the request the route
 * accepts, and the saved button becomes the same cart line again.
 *
 * Run: npm run test:pizza-quick-buttons-ui
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  runCases,
  createApp,
  startServer,
  api,
} = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');
const { initDatabase } = require('../main/db');
const { registerRoutes } = require('../main/routes/index');
const sample = require('./fixtures/pizza-sample-menu.json');

const frontend = loadFrontend();
const { useCartStore } = require('../frontend/src/store/cart');
const { getPizzaCatalog, reloadPizzaCatalog } = require('../frontend/src/lib/pizza/catalog');
const { newSheet, sheetReducer, sheetLine } = require('../frontend/src/lib/pizza/sheet-state');
const quick = () => require('../frontend/src/lib/pizza/quick-buttons');

const json = (value: unknown) => JSON.stringify(value);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${json(actual)})`);
const cart = () => useCartStore.getState();

const islandClassic = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [
    { pizzaId: 'island', removed: ['Pineapple'] },
    { pizzaId: 'classic', removed: [] },
  ],
};

async function main() {
  const app = createApp({});
  registerRoutes(app);
  const { baseUrl } = await startServer(app);
  initDatabase();

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

  /** Loads the sample menu, changed first by `change`, through the import route. */
  const loadMenu = async (change: (menu: any) => void = () => {}) => {
    const menu = JSON.parse(json(sample));
    change(menu);
    const loaded = await api(baseUrl, '/api/pizza/menu/import', {
      method: 'POST',
      headers,
      body: menu,
    });
    assertEqualOrThrow(loaded.status, 200, `the menu loads (the server said ${json(loaded.data)})`);
    await reloadPizzaCatalog();
    products = (await frontend.api.get('/products')).data.products;
  };
  /** The catalogue's products as the POS reads them, with variants and add-on groups. */
  let products: any[] = [];
  await loadMenu();

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
  const cents = (list: string, id: string) =>
    getPizzaCatalog()[list].find((entry: any) => entry.id === id).priceCents;

  /** Each kind of line a cashier can save, put in the cart the way its screen does. */
  const LINES: Record<string, () => void> = {
    'a plain pizza': () => {
      const garden = productOf('pz-garden');
      cart().addItem(garden, 1, [], '', variantOf(garden, 'pz-garden-large'));
    },
    'a half and half with a removal and a dip': () => {
      const half = productOf('pz-half-and-half');
      cart().addItem(
        half,
        1,
        [addonOf(half, 'ad-dips-garlic', 2)],
        'Ring the bell',
        variantOf(half, 'pz-half-and-half-large'),
        islandClassic,
      );
    },
    'a side with an add-on': () => {
      const wings = productOf('sd-wings');
      cart().addItem(wings, 1, [addonOf(wings, 'ad-wings-flavour-hot')]);
    },
    'a drink size': () => {
      const cola = productOf('dr-cola');
      cart().addItem(cola, 1, [], '', variantOf(cola, 'dr-cola-can'));
    },
  };
  /** The one line of the cart after `add` ran on an empty cart. */
  const lineOf = (add: () => void) => {
    cart().clearCart();
    add();
    assertEqualOrThrow(cart().items.length, 1, 'the cart holds one line');
    return cart().items[0];
  };
  /** Saves the line as a button through the module, as the save dialog does. */
  const saveLine = (line: any, label: string, customerId?: string) =>
    quick().saveQuickButton({
      label,
      color: 'green',
      ...quick().buttonContents(line),
      ...(customerId ? { customer_id: customerId } : {}),
    });
  const saved: Record<string, any> = {};

  await runCases('pizza-quick-buttons-ui', {
    'Case 1: a cart line of each kind is saved by the route and comes back as the same line':
      async () => {
        for (const [kind, add] of Object.entries(LINES)) {
          const line = lineOf(add);
          const button = await saveLine(line, kind.slice(0, 24));
          saved[kind] = button;
          assertEqualOrThrow(button.usable, true, `${kind}: the saved button can be added`);
          assertEqualOrThrow(button.customer_id, null, `${kind}: it is a shop-wide button`);

          const back = quick().buttonLine(button, products);
          assertOrThrow(back !== null, `${kind}: the button resolves against the POS's products`);
          cart().clearCart();
          cart().addItem(
            back.product,
            1,
            back.addons,
            back.special_instructions,
            back.variant,
            back.recipe,
          );
          assertEqualOrThrow(cart().items[0].id, line.id, `${kind}: the tap gives the same line`);
          cart().addItem(
            back.product,
            1,
            back.addons,
            back.special_instructions,
            back.variant,
            back.recipe,
          );
          same(
            cart().items.map((item: any) => item.quantity),
            [2],
            `${kind}: a second tap raises the quantity of that line`,
          );
        }
        same(
          (await quick().fetchQuickButtons()).map((button: any) => button.id),
          Object.values(saved).map((button) => button.id),
          'the list has the four buttons in the order they were saved',
        );
      },

    'Case 2: what a line sends is exactly what the route stores': async () => {
      const line = lineOf(LINES['a half and half with a removal and a dip']);
      same(
        quick().buttonContents(line),
        {
          product_id: 'pz-half-and-half',
          variant_id: 'pz-half-and-half-large',
          recipe: islandClassic,
          addons: [{ id: 'ad-dips-garlic', quantity: 2 }],
          note: 'Ring the bell',
        },
        'product, size, recipe, add-ons and note; no quantity and no price',
      );
      const stored = saved['a half and half with a removal and a dip'];
      same(
        [stored.product_id, stored.variant_id, stored.recipe, stored.addons, stored.note],
        [
          'pz-half-and-half',
          'pz-half-and-half-large',
          islandClassic,
          [{ id: 'ad-dips-garlic', quantity: 2 }],
          'Ring the bell',
        ],
        'the route stored the same',
      );
      same(
        quick().buttonContents(lineOf(LINES['a plain pizza'])),
        {
          product_id: 'pz-garden',
          variant_id: 'pz-garden-large',
          recipe: null,
          addons: [],
          note: '',
        },
        'a plain pizza sends no recipe',
      );
    },

    'Case 3: the price of a button is worked out from the product, size and add-ons': async () => {
      const price = (kind: string) =>
        Math.round(quick().buttonPrice(quick().buttonLine(saved[kind], products)) * 100);
      same(
        Object.keys(LINES).map(price),
        [
          cents('sizes', 'large'),
          cents('sizes', 'large') + 2 * cents('dips', 'garlic'),
          cents('sides', 'wings'),
          cents('drinkVariants', 'can'),
        ],
        'the size price, the size price and two dips, the side price, the can price',
      );
      assertOrThrow(
        !('price' in saved['a plain pizza']),
        'the route returns no price for the screen to show instead',
      );
    },

    'Case 4: what a button holds, in words': async () => {
      const summary = (kind: string) =>
        quick().buttonSummary(quick().buttonLine(saved[kind], products));
      same(
        Object.keys(LINES).map(summary),
        [
          'Garden (Large)',
          'Half & Half (Large) · 1ST: ISLAND · NO PINEAPPLE · 2ND: CLASSIC PEPPERONI · + Garlic ×2 · Ring the bell',
          'Wings (8 pcs.) · + Hot',
          'Cola (Can)',
        ],
        'the name as the cart shows it, the kitchen lines, the add-ons and the note',
      );
    },

    'Case 5: a pizza button opens in the sheet and the sheet gives the same pizza back':
      async () => {
        const button = saved['a half and half with a removal and a dip'];
        assertOrThrow(quick().isPizzaButton(button), 'a half and half is a pizza button');
        assertOrThrow(quick().isPizzaButton(saved['a plain pizza']), 'so is a plain pizza');
        assertOrThrow(!quick().isPizzaButton(saved['a side with an add-on']), 'a side is not');
        assertOrThrow(!quick().isPizzaButton(saved['a drink size']), 'a drink is not');

        const source = quick().buttonSheetLine(button);
        assertEqualOrThrow(
          quick().sheetButtonId(source.id),
          button.id,
          'the line the sheet opens on names its button',
        );
        assertEqualOrThrow(
          quick().sheetButtonId(lineOf(LINES['a plain pizza']).id),
          null,
          'a cart line names none',
        );
        const state = sheetReducer(newSheet(), { type: 'load', line: source });
        const line = sheetLine(getPizzaCatalog(), state);
        same(
          [line.productId, line.variantId, line.recipe, line.dips.map((dip: any) => dip.addonId)],
          ['pz-half-and-half', 'pz-half-and-half-large', islandClassic, ['ad-dips-garlic']],
          'the sheet holds the pizza the button holds',
        );
        assertEqualOrThrow(state.note, 'Ring the bell', 'and its note');
        assertEqualOrThrow(state.dips.garlic, 2, 'and two garlic dips');
      },

    'Case 6: a customer has their own buttons, and a button can be changed and deleted':
      async () => {
        const created = await api(baseUrl, '/api/customers', {
          method: 'POST',
          headers,
          body: { name: 'Sample Customer', phone: '+16045550101' },
        });
        assertEqualOrThrow(created.status, 201, `a customer is created (${json(created.data)})`);
        const customerId = created.data.customer.id;
        const usual = await saveLine(lineOf(LINES['a drink size']), 'The usual', customerId);
        assertEqualOrThrow(usual.customer_id, customerId, 'the button belongs to the customer');

        const shop = Object.values(saved).map((button) => button.id);
        same(
          (await quick().fetchQuickButtons(customerId)).map((button: any) => button.id),
          [...shop, usual.id],
          'with the customer on the order: the shop buttons, then theirs',
        );
        same(
          (await quick().fetchQuickButtons()).map((button: any) => button.id),
          shop,
          'with no customer: the shop buttons only',
        );

        const renamed = await quick().updateQuickButton(usual.id, {
          label: 'Cola for one',
          color: 'sky',
        });
        same(
          [renamed.label, renamed.color, renamed.variant_id],
          ['Cola for one', 'sky', 'dr-cola-can'],
          'a change names only the label and colour, and the item stays',
        );
        await quick().deleteQuickButton(usual.id);
        same(
          (await quick().fetchQuickButtons(customerId)).map((button: any) => button.id),
          shop,
          'a deleted button is gone from the list',
        );
      },

    'Case 9: the price is the online price while the order is for an online platform': async () => {
      const half = productOf('pz-half-and-half');
      const large = { ...variantOf(half, 'pz-half-and-half-large'), online_price: 30 };
      const line = {
        product: half,
        variant: large,
        addons: [addonOf(half, 'ad-dips-garlic', 2)],
        special_instructions: '',
      };
      const dips = (2 * cents('dips', 'garlic')) / 100;
      assertEqualOrThrow(
        quick().buttonPrice(line, true),
        30 + dips,
        'with a platform chosen: the size online price and the dips, as the cart charges',
      );
      assertEqualOrThrow(
        quick().buttonPrice(line, false),
        cents('sizes', 'large') / 100 + dips,
        'at the counter: the size price and the dips',
      );
    },

    'Case 10: a button whose size is sold out is not addable, and says so': async () => {
      const button = saved['a half and half with a removal and a dip'];
      const soldOut = products.map((product) =>
        product.id !== 'pz-half-and-half'
          ? product
          : {
              ...product,
              variants: product.variants.map((variant: any) =>
                variant.id === 'pz-half-and-half-large'
                  ? { ...variant, track_inventory: true, stock_quantity: 0 }
                  : variant,
              ),
            },
      );
      assertEqualOrThrow(quick().buttonSoldOut(button, soldOut), true, 'the size is sold out');
      assertEqualOrThrow(quick().buttonLine(button, soldOut), null, 'so a tap adds nothing');
      assertEqualOrThrow(quick().buttonSoldOut(button, products), false, 'in stock: not sold out');
      assertOrThrow(quick().buttonLine(button, products) !== null, 'and it adds');
      assertEqualOrThrow(
        quick().buttonSoldOut(saved['a side with an add-on'], soldOut),
        false,
        'a button with no size is never sold out',
      );
    },

    'Case 11: the list follows the customer the screen names, not the id the cart holds':
      async () => {
        const {
          useQuickButtonStore,
        } = require('../frontend/src/components/pos/pizza/useQuickButtons');
        const make = async (name: string, phone: string) => {
          const created = await api(baseUrl, '/api/customers', {
            method: 'POST',
            headers,
            body: { name, phone },
          });
          assertEqualOrThrow(created.status, 201, `${name} is created (${json(created.data)})`);
          return created.data.customer;
        };
        const first = await make('First Example', '+16045550111');
        const second = await make('Second Example', '+16045550112');
        const theirs = await saveLine(lineOf(LINES['a drink size']), 'First cola', first.id);
        const own = () =>
          useQuickButtonStore
            .getState()
            .buttons.filter((button: any) => button.customer_id !== null)
            .map((button: any) => button.id);

        // A resumed held order sets the id and leaves the customer the cart panel shows.
        cart().setCustomer(second);
        useCartStore.setState({ customerId: first.id });
        await useQuickButtonStore.getState().load(second.id);
        same(own(), [], 'the customer shown has no buttons, whatever id the cart holds');

        cart().setCustomer(first);
        useCartStore.setState({ customerId: second.id });
        await useQuickButtonStore.getState().load(first.id);
        same(own(), [theirs.id], 'the customer shown has theirs');
        await useQuickButtonStore.getState().load();
        same(own(), [theirs.id], 'a reload after a change lists for the same customer');

        await useQuickButtonStore.getState().load(null);
        same(own(), [], 'with no customer: the shop buttons only');
        await quick().deleteQuickButton(theirs.id);
        cart().setCustomer(null);
      },

    'Case 7: a refusal carries the message the server gave': async () => {
      const line = lineOf(LINES['a plain pizza']);
      let message = '';
      try {
        await saveLine(line, 'A name far longer than twenty-four characters');
      } catch (error) {
        message = quick().refusalMessage(error, 'fallback');
      }
      assertEqualOrThrow(
        message,
        'A button name can have at most 24 characters',
        'the route refuses a long name in words for the cashier',
      );
      assertEqualOrThrow(
        quick().refusalMessage(new Error('socket hang up'), 'Not saved'),
        'Not saved',
        'an error with no answer from the server gets the screen own words',
      );
    },

    'Case 8: a button the menu changed under is not addable': async () => {
      await loadMenu((menu) => {
        const pizzas = menu.categories.find((entry: any) => entry.id === 'pizzas');
        pizzas.items = pizzas.items.filter((pizza: any) => pizza.id !== 'garden');
      });
      const buttons = await quick().fetchQuickButtons();
      const stale = buttons.find((button: any) => button.id === saved['a plain pizza'].id);
      assertEqualOrThrow(stale.usable, false, 'the Garden button is no longer usable');
      assertEqualOrThrow(
        stale.reason,
        'Garden is not on the menu. Pick another item',
        'and says why',
      );
      assertEqualOrThrow(quick().buttonLine(stale, products), null, 'it gives no line to add');

      const half = buttons.find(
        (button: any) => button.id === saved['a half and half with a removal and a dip'].id,
      );
      assertOrThrow(quick().buttonLine(half, products) !== null, 'the other buttons still add');
      assertEqualOrThrow(
        quick().buttonLine(half, []),
        null,
        'a usable button the POS has no product for gives no line either',
      );
      assertEqualOrThrow(
        quick().buttonLine({ ...half, addons: [{ id: 'ad-dips-gone', quantity: 1 }] }, products),
        null,
        'nor does one with an add-on the POS does not have',
      );

      // A stale pizza button still opens in the sheet, where another pizza can be picked.
      const state = sheetReducer(newSheet(), {
        type: 'load',
        line: quick().buttonSheetLine(stale),
      });
      same(
        [state.sizeId, state.halves[0].pizzaId],
        ['large', 'garden'],
        'the sheet opens on what the button held',
      );
      assertEqualOrThrow(
        sheetLine(getPizzaCatalog(), state).canAdd,
        false,
        'and refuses it until a pizza on the menu is picked',
      );
    },
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
