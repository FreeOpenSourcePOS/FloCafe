/**
 * The dips and drinks popup and the folded cart rows, without a browser: the
 * rows and tiles worked out from the catalogue and the product list of a store
 * the real importer loaded, the cart line a tile adds, how many of a tile the
 * order holds, and which pizza lines fold their action row away.
 *
 * Run: npm run test:pizza-small-items
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
const { parseMenuFile } = require('../shared/pizza/menu');
const sample = require('./fixtures/pizza-sample-menu.json');

const frontend = loadFrontend();
const { useCartStore } = require('../frontend/src/store/cart');
const { reloadPizzaCatalog } = require('../frontend/src/lib/pizza/catalog');
const smallItems = () => require('../frontend/src/lib/pizza/small-items');

const json = (value: unknown) => JSON.stringify(value);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(
    isDeepStrictEqual(actual, expected),
    `${message} (got ${json(actual)}, expected ${json(expected)})`,
  );
const cart = () => useCartStore.getState();
const menu = parseMenuFile(sample);
const dollars = (cents: number) => cents / 100;

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
  frontend.api.defaults.baseURL = `${baseUrl}/api`;
  frontend.api.defaults.headers.common.Authorization = headers.Authorization;

  /** Loads a menu file through the import route, then reads what the POS page reads. */
  const load = async (file: unknown) => {
    const loaded = await api(baseUrl, '/api/pizza/menu/import', {
      method: 'POST',
      headers,
      body: file,
    });
    assertEqualOrThrow(loaded.status, 200, `the menu loads (${json(loaded.data)})`);
    return {
      catalog: await reloadPizzaCatalog(),
      products: (await frontend.api.get('/products?active=1')).data.products as any[],
    };
  };
  const { catalog, products } = await load(sample);
  const rows = () => smallItems().smallItemRows(catalog, products) as any[];
  const tileOf = (rowId: string, name: string) => {
    const tile = rows()
      .find((row) => row.id === rowId)
      ?.tiles.find((entry: any) => entry.name === name);
    assertOrThrow(Boolean(tile), `the ${rowId} row has a ${name} tile`);
    return tile;
  };
  /** The product, found by name, as the product grid shows it. */
  const onGrid = (name: string) => {
    const product = products.find((entry) => entry.name === name);
    assertOrThrow(Boolean(product), `the POS lists ${name}`);
    return product;
  };
  /** The line the product grid's dialog adds for one of `product` with this choice made in it. */
  const gridLine = (product: any, choice: { addon?: string; variant?: string }) => {
    const addon = (product.addon_groups ?? [])
      .flatMap((group: any) => group.addons ?? [])
      .find((entry: any) => entry.name === choice.addon);
    const variant = (product.variants ?? []).find((entry: any) => entry.name === choice.variant);
    assertOrThrow(Boolean(addon || variant), `${product.name} offers ${json(choice)}`);
    cart().clearCart();
    cart().addItem(product, 1, addon ? [{ ...addon, quantity: 1 }] : [], '', variant ?? null);
    return cart().items[0];
  };
  const tap = (tile: any) => cart().addItem(...smallItems().tileAdd(tile));
  const count = (tile: any) => smallItems().tileCount(cart().items, tile);

  await runCases('pizza-small-items', {
    'Case 1: the sample menu gives a dips row and one row per drink size': () => {
      const dipPrice = dollars(menu.sides.find((side: any) => side.id === 'dip').priceCents);
      same(
        rows().map((row) => ({
          kind: row.kind,
          id: row.id,
          label: row.label ?? null,
          price: row.price,
          categoryId: row.categoryId,
          tiles: row.tiles.map((tile: any) => [tile.name, tile.price]),
        })),
        [
          {
            kind: 'dips',
            id: 'dips',
            label: null,
            price: dipPrice,
            categoryId: 'cat-sides',
            tiles: menu.dips.map((dip: any) => [dip.label, dipPrice]),
          },
          ...menu.drinkVariants.map((variant: any) => ({
            kind: 'drinks',
            id: variant.id,
            label: variant.label,
            price: dollars(variant.priceCents),
            categoryId: 'cat-drinks',
            tiles: menu.drinks.map((drink: any) => [drink.label, dollars(variant.priceCents)]),
          })),
        ],
        'dips first, then cans, then two-litres, each tile at the price the POS charges',
      );
      const ranch = tileOf('dips', 'Ranch');
      same(
        [ranch.product.id, ranch.variant, ranch.addons.map((addon: any) => addon.id)],
        ['sd-dip', null, ['ad-dip-dip-type-ranch']],
        'a dip tile is the dip product with that dip chosen',
      );
      const bottle = tileOf('2l', 'Cola');
      same(
        [bottle.product.id, bottle.variant.id, bottle.addons],
        ['dr-cola', 'dr-cola-2l', []],
        'a drink tile is the drink in that size',
      );
    },

    'Case 2: a tile adds the line the product grid adds for the same item': () => {
      const items: Array<[any, any]> = [
        [tileOf('dips', 'Ranch'), gridLine(onGrid('Dip'), { addon: 'Ranch' })],
        [tileOf('dips', 'Garlic'), gridLine(onGrid('Dip'), { addon: 'Garlic' })],
        [tileOf('can', 'Cola'), gridLine(onGrid('Cola'), { variant: 'Can' })],
        [tileOf('2l', 'Cola'), gridLine(onGrid('Cola'), { variant: '2L Bottle' })],
        [tileOf('2l', 'Lemon Lime'), gridLine(onGrid('Lemon Lime'), { variant: '2L Bottle' })],
      ];
      same(new Set(items.map(([, line]) => line.id)).size, items.length, 'five different lines');
      for (const [tile, fromGrid] of items) {
        cart().clearCart();
        tap(tile);
        same(cart().items, [fromGrid], `${tile.name}: the tile adds the grid's line`);
        assertEqualOrThrow(tile.lineId, fromGrid.id, `${tile.name}: the tile knows that line's id`);
        tap(tile);
        same(
          cart().items.map((line: any) => [line.id, line.quantity]),
          [[fromGrid.id, 2]],
          `${tile.name}: a second tap makes it 2x, not a second line`,
        );
      }
    },

    'Case 3: a tile counts its own lines, not dips that are add-ons on a pizza': () => {
      const ranch = tileOf('dips', 'Ranch');
      const garlic = tileOf('dips', 'Garlic');
      const can = tileOf('can', 'Cola');
      const bottle = tileOf('2l', 'Cola');
      const garden = onGrid('Garden');
      const ranchOnPizza = garden.addon_groups
        .flatMap((group: any) => group.addons)
        .find((addon: any) => addon.id === 'ad-dips-ranch');
      assertOrThrow(Boolean(ranchOnPizza), 'a pizza offers Ranch as an add-on');

      cart().clearCart();
      cart().addItem(garden, 2, [{ ...ranchOnPizza, quantity: 2 }], '', garden.variants[0]);
      same([count(ranch), count(garlic)], [0, 0], 'dips on a pizza are not counted');

      tap(ranch);
      tap(ranch);
      tap(can);
      tap(bottle);
      tap(bottle);
      same(
        [
          count(ranch),
          count(garlic),
          count(can),
          count(bottle),
          count(tileOf('can', 'Ginger Ale')),
        ],
        [2, 0, 1, 2, 0],
        'each tile counts its own item, and a can apart from a two-litre',
      );

      // A dip line someone put a note on in the cart is still that dip.
      cart().addItem(ranch.product, 1, ranch.addons, 'on the side', null);
      assertEqualOrThrow(count(ranch), 3, 'a line with a note counts too');
      same(
        smallItems()
          .tileLines(cart().items, ranch)
          .map((line: any) => [line.special_instructions, line.quantity]),
        [
          ['on the side', 1],
          ['', 2],
        ],
        'and the line a tap adds to comes last, which is the one a minus takes from',
      );
    },

    'Case 4: a sold-out size and a dip with no stock left cannot be tapped': () => {
      const can = tileOf('can', 'Cola');
      const ranch = tileOf('dips', 'Ranch');
      const { tileSoldOut } = smallItems();
      same([tileSoldOut(can, 0), tileSoldOut(ranch, 5)], [false, false], 'untracked stock sells');
      const tracked = { track_inventory: true, stock_quantity: 0 };
      assertOrThrow(
        tileSoldOut({ ...can, variant: { ...can.variant, ...tracked } }, 0),
        'a size with none left is sold out',
      );
      const twoLeft = {
        ...ranch,
        addons: [{ ...ranch.addons[0], ...tracked, stock_quantity: 2 }],
      };
      same(
        [tileSoldOut(twoLeft, 1), tileSoldOut(twoLeft, 2)],
        [false, true],
        'a tracked dip sells until the order holds all of it',
      );
    },

    'Case 7: the drinks block opens the popup only when the popup holds every drink sold there':
      () => {
        const { smallItemRows, popupCategory } = smallItems();
        const opens = (list: any[]) => popupCategory(smallItemRows(catalog, list), list);
        assertEqualOrThrow(
          opens(products),
          'cat-drinks',
          'the sample menu: every drink is on a tile',
        );

        const cola = onGrid('Cola');
        const handAdded = { ...cola, id: 'own-soda', name: 'House Soda', variants: [] };
        assertEqualOrThrow(opens([...products, handAdded]), null, 'a drink the menu did not load');
        const extraSize = {
          ...cola,
          variants: [...cola.variants, { ...cola.variants[0], id: 'dr-cola-jug', name: 'Jug' }],
        };
        assertEqualOrThrow(
          opens(products.map((entry) => (entry === cola ? extraSize : entry))),
          null,
          'a size the menu does not list',
        );
        const elsewhere = { ...handAdded, category_id: 'cat-sides' };
        assertEqualOrThrow(
          opens([...products, elsewhere]),
          'cat-drinks',
          'another category is its own',
        );
        const off = { ...handAdded, is_active: false };
        assertEqualOrThrow(
          opens([...products, off]),
          'cat-drinks',
          'a product switched off is not sold',
        );
        assertEqualOrThrow(opens([]), null, 'and no rows open nothing');
      },

    'Case 8: for an online platform a drink tile shows the online price of its size': () => {
      const { smallItemRows } = smallItems();
      const priced = products.map((product) =>
        product.id !== 'dr-cola'
          ? product
          : {
              ...product,
              variants: product.variants.map((variant: any) =>
                variant.id === 'dr-cola-can' ? { ...variant, online_price: 2.5 } : variant,
              ),
            },
      );
      const cans = (online?: boolean) =>
        smallItemRows(catalog, priced, online).find((row: any) => row.id === 'can');
      const price = (row: any, name: string) =>
        row.tiles.find((tile: any) => tile.name === name).price;
      const can = dollars(menu.drinkVariants.find((size: any) => size.id === 'can').priceCents);

      assertEqualOrThrow(price(cans(true), 'Cola'), 2.5, 'online: the online price of the size');
      assertEqualOrThrow(price(cans(true), 'Ginger Ale'), can, 'a size with none keeps its price');
      assertEqualOrThrow(cans(true).price, null, 'so the row names no one price');
      assertEqualOrThrow(price(cans(false), 'Cola'), can, 'at the counter: the counter price');
      assertEqualOrThrow(cans().price, can, 'which is the default, and the row names it');
      same(
        smallItemRows(catalog, priced, true).find((row: any) => row.id === 'dips').tiles,
        smallItemRows(catalog, priced).find((row: any) => row.id === 'dips').tiles,
        'a dip has one price either way',
      );
      const tile = cans(true).tiles.find((entry: any) => entry.name === 'Cola');
      cart().clearCart();
      cart().setOrderType('online');
      cart().setOnlinePlatform('Example Eats');
      tap(tile);
      assertEqualOrThrow(cart().subtotal(), tile.price, 'the cart charges what the tile shows');
      cart().clearCart();
      cart().setOrderType('takeaway');
    },

    'Case 5: past three lines a pizza line folds unless it was the last one touched': () => {
      const { touchedLine, foldsActions } = smallItems();
      const line = (id: string, quantity = 1): any => ({ id, quantity });
      const three = [line('a'), line('b'), line('c')];
      const four = [...three, line('d')];
      same(
        three.map((item) => foldsActions(three, 'a', item.id)),
        [false, false, false],
        'with three lines nothing folds',
      );
      same(
        four.map((item) => foldsActions(four, 'b', item.id)),
        [true, false, true, true],
        'with four, every line but the touched one folds',
      );
      same(
        four.map((item) => foldsActions(four, null, item.id)),
        [true, true, true, true],
        'and all of them when none was touched',
      );

      assertEqualOrThrow(touchedLine(three, four), 'd', 'an added line is the touched one');
      const more = four.map((item) => (item.id === 'b' ? { ...item, quantity: 2 } : item));
      assertEqualOrThrow(touchedLine(four, more), 'b', 'so is a line whose quantity changed');
      assertEqualOrThrow(touchedLine(four, three), null, 'a removal touches none of what is left');
      const split = [four[0], line('b', 1), line('b:1'), four[2], four[3]];
      assertEqualOrThrow(touchedLine(more, split), 'b:1', 'of two changed lines, the later one');
    },

    'Case 6: a menu with no drinks has only the dips row, one with no dips only drinks':
      async () => {
        const { smallItemRows } = smallItems();
        const kinds = (held: unknown, list: any[]) =>
          smallItemRows(held, list).map((row: any) => row.id);
        same(kinds({ ...catalog, drinks: [], drinkVariants: [] }, products), ['dips'], 'no drinks');
        same(
          kinds({ ...catalog, dips: [], sides: [] }, products),
          menu.drinkVariants.map((variant: any) => variant.id),
          'no dips',
        );
        same(kinds(catalog, []), [], 'a menu whose items the POS does not list gives no rows');
        same(kinds(null, products), [], 'and no menu gives none');

        const withoutDrinks = JSON.parse(json(sample));
        withoutDrinks.categories = withoutDrinks.categories
          .filter((category: any) => category.id !== 'drinks')
          .map((category: any) =>
            category.id === 'deals'
              ? {
                  ...category,
                  items: category.items.filter((deal: any) =>
                    deal.picks.every((pick: any) => pick.type !== 'pop' && pick.type !== 'choice'),
                  ),
                }
              : category,
          );
        const reloaded = await load(withoutDrinks);
        same(
          smallItemRows(reloaded.catalog, reloaded.products).map((row: any) => [
            row.id,
            row.tiles.map((tile: any) => tile.name),
          ]),
          [['dips', menu.dips.map((dip: any) => dip.label)]],
          'the same file loaded without its drinks leaves the dips row alone',
        );
        // The drinks the first load created are switched off, so the POS no longer lists them.
        same(kinds(catalog, reloaded.products), ['dips'], 'even against the menu that had drinks');
      },
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
