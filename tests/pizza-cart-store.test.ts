/**
 * Pizzas in the cart: a recipe is part of a line's identity, "Customize 1"
 * splits one pizza off a line, a restored cart keeps different pizzas apart,
 * and the order request carries the recipe.
 *
 * Run: npm run test:pizza-cart-store
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  runCases,
} = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');
const { parseMenuFile } = require('../shared/pizza/menu');
const { RECIPE_NOT_PRINTED, ticketLines } = require('../shared/pizza/ticket');
const sample = require('./fixtures/pizza-sample-menu.json');

const frontend = loadFrontend();
const { generateCartItemId, normalizeCartItems } = require('../frontend/src/lib/cart-identity');
const { cartItemToOrderItem } = require('../frontend/src/lib/cart-order-item');
const { cartLineUnitPrice } = require('../frontend/src/lib/cart-price');
const { buildCartFingerprintFromState } = require('../frontend/src/lib/order-attempt');
const { useCartStore } = require('../frontend/src/store/cart');
const cartLines = () => require('../frontend/src/lib/pizza/cart-lines');
const detailLines = () => require('../frontend/src/lib/pizza/detail-lines');
const pizzaCatalog = () => require('../frontend/src/lib/pizza/catalog');
const sheet = () => require('../frontend/src/lib/pizza/sheet-state');

const catalog = parseMenuFile(sample);
const json = (value: unknown) => JSON.stringify(value);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${json(actual)})`);

const product = (id: string, name: string): any => ({ id, name, price: 0 });
const variant = (productId: string, sizeId: string, price: number): any => ({
  id: `${productId}-${sizeId}`,
  product_id: productId,
  name: sizeId,
  price,
  online_price: null,
});
const dip = (): any => ({
  id: 'ad-dips-garlic',
  addon_group_id: 'ag-dips',
  name: 'Garlic',
  price: 1.25,
  quantity: 1,
});
const part = (pizzaId: string, removed: string[] = []) => ({ pizzaId, removed });
const halves = (first: object, second: object, more: object = {}) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [first, second],
  ...more,
});

const HALF = product('pz-half-and-half', 'Half & Half');
const LARGE = variant('pz-half-and-half', 'large', 23);
const GARDEN = product('pz-garden', 'Garden');
const LARGE_GARDEN = variant('pz-garden', 'large', 23);

const ISLAND_CLASSIC = halves(part('island', ['Pineapple']), part('classic'));
const CLASSIC_ISLAND = halves(part('classic'), part('island', ['Pineapple']));
const GARDEN_TWICE = halves(part('garden', ['Olives', 'Onions']), part('garden'));
const GARDEN_TWICE_TAPPED_BACKWARDS = halves(part('garden', ['Onions', 'Olives']), part('garden'));
const NO_OLIVES = { kind: 'pizza', v: 1, sizeId: 'large', whole: part('garden', ['Olives']) };
const PLAIN_GARDEN = { kind: 'pizza', v: 1, sizeId: 'large', whole: part('garden') };
const PLAIN_GARDEN_ID = 'cart-v3:3deb140d3dd95c1e';
const MEDIUM = variant('pz-half-and-half', 'medium', 19);
const MEDIUM_GARDEN = variant('pz-garden', 'medium', 19);
const ranch = (quantity: number): any => ({
  ...dip(),
  id: 'ad-dips-ranch',
  name: 'Ranch',
  quantity,
});
const medium = (recipe: object) => ({ ...recipe, sizeId: 'medium' });

const cart = () => useCartStore.getState();
const lineOf = (recipe: object | undefined, more: object = {}): any => ({
  id: 'stale',
  product: HALF,
  variant: LARGE,
  quantity: 1,
  addons: [],
  special_instructions: '',
  ...(recipe ? { recipe } : {}),
  ...more,
});
/** What the cart holds, as [quantity, recipe] pairs. */
const held = () => cart().items.map((item: any) => [item.quantity, item.recipe]);
const idOf = (recipe?: object | null, note = '') =>
  generateCartItemId(HALF.id, LARGE.id, [], note, undefined, recipe);
const fingerprint = (items: unknown[]) =>
  buildCartFingerprintFromState({
    tableId: null,
    customerId: null,
    orderType: 'takeaway',
    guestCount: 1,
    items,
    waivedChargeIds: new Set(),
    optedInChargeIds: new Set(),
  });

function deferred() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function stubCatalogRoute(answer: () => Promise<unknown>) {
  const originalGet = frontend.api.get;
  const calls: string[] = [];
  frontend.api.get = (url: string) => {
    calls.push(url);
    return answer();
  };
  return { calls, restore: () => (frontend.api.get = originalGet) };
}

runCases('pizza-cart-store', {
  'Case 1: a line without a recipe keeps the identity it had before recipes': () => {
    assertEqualOrThrow(
      generateCartItemId('pz-garden', 'pz-garden-large', [], ''),
      'cart-v3:3deb140d3dd95c1e',
      'a plain pizza',
    );
    assertEqualOrThrow(
      generateCartItemId('pz-garden', 'pz-garden-large', [dip()], 'no box', {
        price: 20,
        reason: 'staff',
      }),
      'cart-v3:c9b6f6c3284f3972',
      'a plain pizza with a dip, a note and an owner price',
    );
    for (const none of [undefined, null]) {
      assertEqualOrThrow(
        generateCartItemId('pz-garden', 'pz-garden-large', [], '', undefined, none),
        'cart-v3:3deb140d3dd95c1e',
        `a recipe of ${none} is no recipe`,
      );
    }
  },

  'Case 2: the recipe is part of the identity, by its recipe key': () => {
    assertEqualOrThrow(idOf(ISLAND_CLASSIC), idOf(structuredClone(ISLAND_CLASSIC)), 'same recipe');
    assertEqualOrThrow(
      idOf(GARDEN_TWICE),
      idOf(GARDEN_TWICE_TAPPED_BACKWARDS),
      'the same removals tapped in another order',
    );
    assertOrThrow(idOf(ISLAND_CLASSIC) !== idOf(GARDEN_TWICE), 'different pizzas');
    assertOrThrow(idOf(ISLAND_CLASSIC) !== idOf(CLASSIC_ISLAND), 'the same halves, swapped');
    assertOrThrow(idOf(ISLAND_CLASSIC) !== idOf(), 'a recipe and no recipe');
    assertOrThrow(
      idOf(ISLAND_CLASSIC) !== idOf({ ...ISLAND_CLASSIC, cook: 'well-done' }),
      'the same pizza, well done',
    );
    const sixPizzas = {
      kind: 'deal',
      v: 1,
      dealId: 'party',
      pizzas: Array.from({ length: 6 }, () => GARDEN_TWICE),
      twoLitre: 'cola',
    };
    assertOrThrow(idOf(sixPizzas).length <= 64, 'a six-pizza deal still has a bounded id');
  },

  'Case 3: identical recipes merge into 2x and different ones stay apart': () => {
    cart().clearCart();
    cart().addItem(HALF, 1, [], '', LARGE, ISLAND_CLASSIC);
    cart().addItem(HALF, 1, [], '', LARGE, structuredClone(ISLAND_CLASSIC));
    same(held(), [[2, ISLAND_CLASSIC]], 'two identical pizzas are one 2x line');
    assertEqualOrThrow(cart().items[0].id, idOf(ISLAND_CLASSIC), 'under the recipe identity');

    cart().addItem(HALF, 1, [], '', LARGE, CLASSIC_ISLAND);
    cart().addItem(HALF, 3, [], '', LARGE, GARDEN_TWICE);
    cart().addItem(HALF, 1, [], '', LARGE, GARDEN_TWICE_TAPPED_BACKWARDS);
    same(
      held(),
      [
        [2, ISLAND_CLASSIC],
        [1, CLASSIC_ISLAND],
        [4, GARDEN_TWICE],
      ],
      'different pizzas of the same product and size stay on their own lines',
    );

    cart().clearCart();
    cart().addItem(GARDEN, 1, [], '', LARGE_GARDEN);
    cart().addItem(GARDEN, 1, [], '', LARGE_GARDEN, NO_OLIVES);
    cart().addItem(GARDEN, 1, [], '', LARGE_GARDEN);
    same(
      held(),
      [
        [2, undefined],
        [1, NO_OLIVES],
      ],
      'a plain pizza and the same pizza with a removal stay apart',
    );
    assertOrThrow(!('recipe' in cart().items[0]), 'a plain line has no recipe field at all');
  },

  'Case 4: no cart action merges two lines that differ only in their recipe': () => {
    const load = () => {
      cart().clearCart();
      cart().addItem(HALF, 1, [], '', LARGE, ISLAND_CLASSIC);
      cart().addItem(HALF, 2, [], '', LARGE, CLASSIC_ISLAND);
    };
    const apart = [
      [1, ISLAND_CLASSIC],
      [2, CLASSIC_ISLAND],
    ];

    load();
    for (const item of [...cart().items]) cart().updateItemDetails(item.id, item.quantity, [], 'x');
    same(held(), apart, 'giving both the same note');
    same(
      cart().items.map((item: any) => item.id),
      [idOf(ISLAND_CLASSIC, 'x'), idOf(CLASSIC_ISLAND, 'x')],
      'an edited line keeps its recipe in its identity',
    );

    load();
    for (const item of [...cart().items])
      cart().setItemPriceOverride(item.id, { price: 20, reason: 'staff' });
    same(held(), apart, 'giving both the same owner price');
    cart().clearPriceOverrides();
    same(held(), apart, 'clearing the owner prices');
    same(
      cart().items.map((item: any) => item.id),
      [idOf(ISLAND_CLASSIC), idOf(CLASSIC_ISLAND)],
      'the lines are back under their recipe identities',
    );
  },

  'Case 5: "Customize 1" splits one pizza off a line': () => {
    const { customizeOne, replaceCartLine } = cartLines();
    cart().clearCart();
    cart().addItem(GARDEN, 4, [], '', LARGE_GARDEN);
    cart().addItem(HALF, 2, [dip()], 'no box', LARGE, ISLAND_CLASSIC);
    const before = cart().items;
    const snapshot = json(before);
    const two = before[1];

    const split = customizeOne(before, two.id);
    assertEqualOrThrow(json(before), snapshot, 'the cart it was given is as it was');
    same(
      split.items.map((item: any) => [item.quantity, item.recipe]),
      [
        [4, undefined],
        [1, ISLAND_CLASSIC],
        [1, ISLAND_CLASSIC],
      ],
      '2x becomes 1x and 1x, in place',
    );
    same(split.items[1], { ...two, quantity: 1 }, 'the first is the line as it was, one fewer');
    same(
      split.line,
      { ...two, quantity: 1, id: split.line.id },
      'the second is the same pizza on a line of its own',
    );
    assertOrThrow(split.items[2] === split.line, 'and it is the line to open in the sheet');
    assertEqualOrThrow(
      new Set(split.items.map((item: any) => item.id)).size,
      3,
      'every line has its own id',
    );

    const three = customizeOne(customizeOne([{ ...two, quantity: 3 }], two.id).items, two.id).items;
    same(
      three.map((item: any) => item.quantity),
      [1, 1, 1],
      'twice on 3x gives three lines',
    );
    assertEqualOrThrow(new Set(three.map((item: any) => item.id)).size, 3, 'each with its own id');

    const single = customizeOne(split.items, split.line.id);
    assertOrThrow(single.line === split.line, 'on a 1x line it returns the line itself');
    assertOrThrow(single.items === split.items, 'and leaves the cart alone');
    assertEqualOrThrow(customizeOne(before, 'no-such-line'), null, 'an unknown line is nothing');

    const edited = { ...split.line, recipe: { ...ISLAND_CLASSIC, cook: 'well-done' } };
    useCartStore.setState({ items: replaceCartLine(split.items, split.line.id, edited) });
    same(
      held(),
      [
        [4, undefined],
        [1, ISLAND_CLASSIC],
        [1, edited.recipe],
      ],
      'saving the changed pizza leaves two 1x lines',
    );
    same(
      cart().items.map((item: any) => item.id),
      [
        before[0].id,
        two.id,
        generateCartItemId(HALF.id, LARGE.id, [dip()], 'no box', undefined, edited.recipe),
      ],
      'and the saved line takes the identity of what it now is',
    );

    same(
      replaceCartLine(split.items, split.line.id, split.line),
      before,
      'saving it unchanged puts the 2x line back',
    );
    same(normalizeCartItems(split.items), before, 'so does closing the sheet and tidying the cart');
  },

  'Case 6: an edited line is saved where it stood': () => {
    const { replaceCartLine } = cartLines();
    cart().clearCart();
    cart().addItem(GARDEN, 2, [], '', LARGE_GARDEN, NO_OLIVES);
    cart().addItem(HALF, 1, [], '', LARGE, ISLAND_CLASSIC);
    cart().addItem(GARDEN, 1, [], '', LARGE_GARDEN);
    const [first, second, third] = cart().items;
    const snapshot = json(cart().items);

    const asHalves = replaceCartLine(cart().items, first.id, {
      ...first,
      product: HALF,
      variant: LARGE,
      recipe: CLASSIC_ISLAND,
    });
    assertEqualOrThrow(json(cart().items), snapshot, 'the cart it was given is as it was');
    same(
      asHalves,
      [
        {
          ...first,
          id: idOf(CLASSIC_ISLAND),
          product: HALF,
          variant: LARGE,
          recipe: CLASSIC_ISLAND,
        },
        second,
        third,
      ],
      'a whole pizza changed to a half and half stays first, as the new product',
    );

    same(
      replaceCartLine(cart().items, first.id, { ...first, recipe: undefined }),
      [second, { ...third, quantity: 3 }],
      'a pizza changed into one the cart already holds joins that line',
    );
    same(
      replaceCartLine(cart().items, 'no-such-line', { ...first, recipe: undefined }),
      cart().items,
      'an unknown line changes nothing',
    );
  },

  'Case 6b: a line the sheet saves keeps its add-ons that are not dips': () => {
    const { sheetAddons } = cartLines();
    const extra: any = {
      id: 'ad-extras-cheese',
      addon_group_id: 'ag-extras',
      name: 'Extra cheese',
      price: 2,
      quantity: 2,
    };
    same(
      sheetAddons([dip(), extra, ranch(1)], [ranch(3)]),
      [extra, ranch(3)],
      "another group's add-on stays as it was, and the dips are the sheet's",
    );
    same(sheetAddons([extra], []), [extra], 'taking every dip off keeps the rest');
    same(sheetAddons([], [dip()]), [dip()], "a new pizza has only the sheet's dips");
  },

  'Case 7: restoring a saved cart keeps two different pizzas apart': () => {
    const saved = JSON.parse(
      json([
        lineOf(ISLAND_CLASSIC, { id: 'stale-1', quantity: 1 }),
        lineOf(CLASSIC_ISLAND, { id: 'stale-2', quantity: 2 }),
        lineOf(ISLAND_CLASSIC, { id: 'stale-3', quantity: 4 }),
        lineOf(undefined, { id: 'stale-4', quantity: 1 }),
      ]),
    );
    same(
      normalizeCartItems(saved).map((item: any) => [item.quantity, item.recipe]),
      [
        [5, ISLAND_CLASSIC],
        [2, CLASSIC_ISLAND],
        [1, undefined],
      ],
      'normalizeCartItems merges by recipe and drops none',
    );

    cart().clearCart();
    cart().loadItems(saved, null, null, 1);
    same(
      held(),
      [
        [5, ISLAND_CLASSIC],
        [2, CLASSIC_ISLAND],
        [1, undefined],
      ],
      'a held order restored into the cart',
    );
    same(
      cart().items.map((item: any) => item.id),
      [idOf(ISLAND_CLASSIC), idOf(CLASSIC_ISLAND), idOf()],
      'restored lines get the ids the cart would give them',
    );
  },

  'Case 8: the cart sends the recipe, and the retry fingerprint sees it': () => {
    const line = lineOf(ISLAND_CLASSIC, { quantity: 2, addons: [dip()] });
    same(
      cartItemToOrderItem(line),
      {
        product_id: 'pz-half-and-half',
        variant_id: 'pz-half-and-half-large',
        quantity: 2,
        addons: [{ id: 'ad-dips-garlic', name: 'Garlic', price: 1.25, quantity: 1 }],
        special_instructions: null,
        modifier_selection: ISLAND_CLASSIC,
      },
      'a pizza line goes out with its recipe as modifier_selection',
    );
    same(
      cartItemToOrderItem(
        lineOf(undefined, { product: product('prod-1', 'Americano'), variant: null, quantity: 2 }),
      ),
      {
        product_id: 'prod-1',
        variant_id: null,
        quantity: 2,
        addons: null,
        special_instructions: null,
      },
      'a line that is not a pizza goes out as before, with no modifier_selection',
    );

    assertEqualOrThrow(
      fingerprint([lineOf(ISLAND_CLASSIC)]),
      fingerprint([lineOf(structuredClone(ISLAND_CLASSIC))]),
      'the same cart has the same fingerprint',
    );
    assertOrThrow(
      fingerprint([lineOf(ISLAND_CLASSIC)]) !== fingerprint([lineOf(CLASSIC_ISLAND)]),
      'two carts that differ only in a recipe have different fingerprints',
    );
    assertOrThrow(
      fingerprint([lineOf(ISLAND_CLASSIC)]) !== fingerprint([lineOf(undefined)]),
      'and so do a cart with a recipe and one without',
    );
  },

  'Case 9: the displayed unit price is the variant and the add-ons, recipe or not': () => {
    const { newSheet, sheetReducer, sheetQuote } = sheet();
    const line = lineOf(ISLAND_CLASSIC, { quantity: 2, addons: [dip()] });
    assertEqualOrThrow(cartLineUnitPrice(line, false), 23, 'a pizza with a recipe');
    assertEqualOrThrow(cartLineUnitPrice(lineOf(undefined), false), 23, 'the same line without');

    cart().clearCart();
    cart().addItem(HALF, 2, [dip()], '', LARGE, ISLAND_CLASSIC);
    assertEqualOrThrow(cart().subtotal(), 48.5, 'two large pizzas, each with a dip');
    const loaded = sheetReducer(newSheet(), { type: 'load', line });
    const priced = sheetQuote(catalog, loaded, undefined, false);
    assertEqualOrThrow(priced.unit, 24.25, 'the sheet prices one of them');
    assertEqualOrThrow(priced.unit * 2, cart().subtotal(), 'the same total');
  },

  'Case 10: the catalogue is fetched once, read at once, and reloaded on request': async () => {
    const { getPizzaCatalog, loadPizzaCatalog, reloadPizzaCatalog } = pizzaCatalog();
    assertEqualOrThrow(getPizzaCatalog(), null, 'nothing is loaded at first');

    const smaller = { ...catalog, deals: [] };
    let answer: () => Promise<unknown> = async () => ({ data: catalog });
    const route = stubCatalogRoute(() => answer());
    try {
      const [first, second] = await Promise.all([loadPizzaCatalog(), loadPizzaCatalog()]);
      same(route.calls, ['/pizza/catalog'], 'two screens loading at once make one request');
      assertOrThrow(first === catalog && second === catalog, 'both get the catalogue');
      assertOrThrow(getPizzaCatalog() === catalog, 'and it can be read without waiting');
      assertOrThrow((await loadPizzaCatalog()) === catalog, 'a later load answers from memory');
      assertEqualOrThrow(route.calls.length, 1, 'with no second request');

      answer = async () => ({ data: smaller });
      assertOrThrow((await reloadPizzaCatalog()) === smaller, 'a reload fetches again');
      assertOrThrow(getPizzaCatalog() === smaller, 'and replaces what is held');
      assertEqualOrThrow(route.calls.length, 2, 'with one more request');

      answer = () => Promise.reject({ response: { status: 500 } });
      let failed = false;
      await reloadPizzaCatalog().catch(() => (failed = true));
      assertOrThrow(failed, 'a failed reload is reported');
      assertOrThrow(getPizzaCatalog() === smaller, 'and the catalogue held is kept');
      answer = async () => ({ data: catalog });
      assertOrThrow((await loadPizzaCatalog()) === catalog, 'the next load tries again');

      answer = () => Promise.reject({ response: { status: 404 } });
      assertEqualOrThrow(await reloadPizzaCatalog(), null, 'a 404 means no pizza menu');
      assertEqualOrThrow(getPizzaCatalog(), null, 'so nothing is held');
      const calls = route.calls.length;
      assertEqualOrThrow(await loadPizzaCatalog(), null, 'and a later load still says so');
      assertEqualOrThrow(route.calls.length, calls, 'without asking again');
    } finally {
      route.restore();
    }
  },

  'Case 10b: a reload after a 404 gives the catalogue, and only the latest answer is kept':
    async () => {
      const { getPizzaCatalog, loadPizzaCatalog, reloadPizzaCatalog } = pizzaCatalog();
      const smaller = { ...catalog, deals: [] };
      let answer: () => Promise<unknown> = () => Promise.reject({ response: { status: 404 } });
      const route = stubCatalogRoute(() => answer());
      try {
        assertEqualOrThrow(await reloadPizzaCatalog(), null, 'no pizza menu yet');
        answer = async () => ({ data: catalog });
        assertEqualOrThrow(await loadPizzaCatalog(), null, 'a load still answers "no menu"');
        assertOrThrow((await reloadPizzaCatalog()) === catalog, 'a reload after a 404 fetches');
        assertOrThrow(getPizzaCatalog() === catalog, 'and the catalogue is held');

        const older = deferred();
        const newer = deferred();
        const answers = [older.promise, newer.promise];
        answer = () => answers.shift() as Promise<unknown>;
        const first = reloadPizzaCatalog();
        const second = reloadPizzaCatalog();
        newer.resolve({ data: smaller });
        await second;
        older.resolve({ data: catalog });
        await first;
        assertOrThrow(getPizzaCatalog() === smaller, 'an older answer arriving late is ignored');

        const lost = deferred();
        const kept = deferred();
        answers.push(lost.promise, kept.promise);
        const failing = reloadPizzaCatalog();
        const working = reloadPizzaCatalog();
        kept.resolve({ data: catalog });
        await working;
        lost.reject({ response: { status: 404 } });
        await failing;
        assertOrThrow(getPizzaCatalog() === catalog, 'an older 404 arriving late is ignored too');
        const calls = route.calls.length;
        assertOrThrow((await loadPizzaCatalog()) === catalog, 'the latest fetch stays the answer');
        assertEqualOrThrow(route.calls.length, calls, 'with no further request');
      } finally {
        route.restore();
      }
    },

  'Case 10c: signing in or out forgets the catalogue, and the next load fetches again':
    async () => {
      const { getPizzaCatalog, loadPizzaCatalog, reloadPizzaCatalog } = pizzaCatalog();
      const { notifySessionBoundary } = require('../frontend/src/store/session-events');
      const smaller = { ...catalog, deals: [] };
      let answer: () => Promise<unknown> = async () => ({ data: catalog });
      const route = stubCatalogRoute(() => answer());
      try {
        await reloadPizzaCatalog();
        assertOrThrow(getPizzaCatalog() === catalog, 'a catalogue is held');
        const held = route.calls.length;
        notifySessionBoundary('lock');
        assertOrThrow(getPizzaCatalog() === catalog, 'locking the screen keeps it');
        notifySessionBoundary('pin-login');
        assertOrThrow(getPizzaCatalog() === catalog, 'and so does unlocking with a PIN');
        assertOrThrow((await loadPizzaCatalog()) === catalog, 'a load after the unlock');
        assertEqualOrThrow(route.calls.length, held, 'answers from memory, with no request');
        notifySessionBoundary('login');
        assertEqualOrThrow(getPizzaCatalog(), null, 'signing in forgets it');
        assertOrThrow((await loadPizzaCatalog()) === catalog, 'and the next load fetches again');
        assertEqualOrThrow(route.calls.length, held + 1, 'with a request of its own');
        notifySessionBoundary('logout');
        assertEqualOrThrow(getPizzaCatalog(), null, 'signing out forgets it');
        answer = async () => ({ data: smaller });
        let calls = route.calls.length;
        assertOrThrow((await loadPizzaCatalog()) === smaller, 'the next load fetches again');
        assertEqualOrThrow(route.calls.length, calls + 1, 'with a request of its own');

        answer = () => Promise.reject({ response: { status: 404 } });
        assertEqualOrThrow(await reloadPizzaCatalog(), null, 'a shop with no pizza menu');
        notifySessionBoundary('login');
        answer = async () => ({ data: catalog });
        assertOrThrow(
          (await loadPizzaCatalog()) === catalog,
          'a remembered "no menu" does not outlive the session',
        );

        const slow = deferred();
        answer = () => slow.promise as Promise<unknown>;
        const before = reloadPizzaCatalog();
        notifySessionBoundary('logout');
        slow.resolve({ data: smaller });
        await before;
        assertEqualOrThrow(
          getPizzaCatalog(),
          null,
          'an answer from before the boundary is not kept',
        );
        answer = async () => ({ data: catalog });
        calls = route.calls.length;
        assertOrThrow((await loadPizzaCatalog()) === catalog, 'and the next load asks again');
        assertEqualOrThrow(route.calls.length, calls + 1, 'with a request of its own');
        notifySessionBoundary('logout');
      } finally {
        route.restore();
      }
    },

  'Case 10d: the catalogue belongs to the tenant it was fetched for': async () => {
    const { getPizzaCatalog, loadPizzaCatalog, reloadPizzaCatalog } = pizzaCatalog();
    const { useAuthStore } = frontend.auth;
    const tenant = (id: number | null) =>
      useAuthStore.setState({ currentTenant: id === null ? null : ({ id } as any) });
    const noMenu = () => Promise.reject({ response: { status: 404 } });
    let answer: () => Promise<unknown> = async () => ({ data: catalog });
    const route = stubCatalogRoute(() => answer());
    try {
      tenant(1);
      assertOrThrow((await loadPizzaCatalog()) === catalog, 'the first tenant has a pizza menu');
      tenant(2);
      assertEqualOrThrow(getPizzaCatalog(), null, 'another tenant does not read it');
      answer = noMenu;
      const calls = route.calls.length;
      assertEqualOrThrow(await loadPizzaCatalog(), null, 'its own load says it has no menu');
      assertEqualOrThrow(route.calls.length, calls + 1, 'with a request of its own');
      assertEqualOrThrow(getPizzaCatalog(), null, 'and nothing is held for it');

      tenant(1);
      const slow = deferred();
      answer = () => slow.promise as Promise<unknown>;
      const before = reloadPizzaCatalog();
      tenant(2);
      answer = noMenu;
      const asked = route.calls.length;
      assertEqualOrThrow(
        await loadPizzaCatalog(),
        null,
        'a fetch in flight for the tenant left does not answer the next tenant',
      );
      assertEqualOrThrow(route.calls.length, asked + 1, 'which asks for itself');
      slow.resolve({ data: catalog });
      await before;
      assertEqualOrThrow(getPizzaCatalog(), null, "and its late answer is not this tenant's menu");

      tenant(1);
      answer = async () => ({ data: catalog });
      await reloadPizzaCatalog();
      tenant(null);
      assertEqualOrThrow(
        getPizzaCatalog(),
        null,
        'a locked screen has no tenant and reads nothing',
      );
      tenant(1);
      const kept = route.calls.length;
      assertOrThrow((await loadPizzaCatalog()) === catalog, 'the same tenant back reads it again');
      assertEqualOrThrow(route.calls.length, kept, 'from memory');
    } finally {
      route.restore();
      tenant(null);
      require('../frontend/src/store/session-events').notifySessionBoundary('logout');
    }
  },

  'Case 10e: a refresh asks at most every 30 seconds and says whether the menu changed':
    async () => {
      const {
        getPizzaCatalog,
        onPizzaCatalogChange,
        refreshPizzaCatalog,
        reloadPizzaCatalog,
        REFRESH_MS,
      } = pizzaCatalog();
      const edited = {
        ...catalog,
        sizes: catalog.sizes.map((size: any) => ({ ...size, priceCents: size.priceCents + 100 })),
      };
      let answer: () => Promise<unknown> = async () => ({ data: catalog });
      const route = stubCatalogRoute(() => answer());
      const replaced: boolean[] = [];
      const stop = onPizzaCatalogChange((known: boolean) => replaced.push(known));
      try {
        assertEqualOrThrow(await refreshPizzaCatalog(0), false, 'nothing held, nothing to refresh');
        assertEqualOrThrow(route.calls.length, 0, 'and no request');

        await reloadPizzaCatalog(1_000);
        same(replaced, [false], 'the first answer replaces nothing');
        assertEqualOrThrow(
          await refreshPizzaCatalog(1_000 + REFRESH_MS - 1),
          false,
          'within 30 seconds of the last fetch a refresh does nothing',
        );
        assertEqualOrThrow(route.calls.length, 1, 'and asks nothing');

        answer = async () => ({ data: JSON.parse(JSON.stringify(catalog)) });
        assertEqualOrThrow(
          await refreshPizzaCatalog(1_000 + REFRESH_MS),
          false,
          'the same menu again is no change',
        );
        assertEqualOrThrow(route.calls.length, 2, 'though it was fetched');
        assertOrThrow(getPizzaCatalog() === catalog, 'and the catalogue held is the same object');
        same(replaced, [false], 'so no screen is told');

        answer = async () => ({ data: edited });
        assertEqualOrThrow(await refreshPizzaCatalog(100_000), true, 'an edited menu is a change');
        assertOrThrow(getPizzaCatalog() === edited, 'which is held');
        same(replaced, [false, true], 'and the screens are told a menu they knew was replaced');

        answer = () => Promise.reject({ response: { status: 500 } });
        assertEqualOrThrow(await refreshPizzaCatalog(200_000), false, 'a failed refresh');
        assertOrThrow(getPizzaCatalog() === edited, 'keeps the catalogue held');

        answer = async () => ({ data: { ...catalog, pizzas: [] } });
        await reloadPizzaCatalog(250_000);
        const emptied = route.calls.length;
        assertEqualOrThrow(await refreshPizzaCatalog(290_000), false, 'a menu with no pizzas');
        assertEqualOrThrow(route.calls.length, emptied, 'is not asked again by a refresh either');

        answer = () => Promise.reject({ response: { status: 404 } });
        await reloadPizzaCatalog(300_000);
        const calls = route.calls.length;
        assertEqualOrThrow(await refreshPizzaCatalog(400_000), false, 'a shop with no menu');
        assertEqualOrThrow(route.calls.length, calls, 'is not asked again by a refresh');
      } finally {
        stop();
        route.restore();
        require('../frontend/src/store/session-events').notifySessionBoundary('logout');
      }
    },

  'Case 10f: an order refused because the menu changed reloads the catalogue': async () => {
    const { getPizzaCatalog, isStaleMenuRefusal, reloadPizzaCatalog } = pizzaCatalog();
    const refusal = (status: number, error: unknown) => ({ response: { status, data: { error } } });
    for (const message of [
      'That pizza is not on the menu. Pick another pizza',
      'Pizza 2: That size is not on the menu. Pick a size',
      'That deal is not on the menu. Pick another deal',
      'That drink is not on the menu. Pick another drink',
      'Garden does not have that ingredient. Choose what to remove again',
    ]) {
      assertOrThrow(isStaleMenuRefusal(refusal(400, message)), `stale: ${message}`);
    }
    assertOrThrow(
      isStaleMenuRefusal(refusal(503, 'The pizza menu is not loaded. Load the menu file again.')),
      'a menu the server cannot read is stale too',
    );
    for (const other of [
      refusal(400, 'Pick a size'),
      refusal(400, 'Both halves are the same. Choose a whole pizza instead'),
      refusal(500, 'That pizza is not on the menu. Pick another pizza'),
      refusal(400, undefined),
      new Error('Network Error'),
    ]) {
      assertOrThrow(!isStaleMenuRefusal(other), `not stale: ${JSON.stringify(other)}`);
    }

    const smaller = { ...catalog, deals: [] };
    let answer: () => Promise<unknown> = async () => ({ data: catalog });
    const route = stubCatalogRoute(() => answer());
    const refusedWith = (status: number, error: string) =>
      frontend.api
        .post(
          '/orders',
          {},
          {
            adapter: (config: unknown) =>
              Promise.reject(
                Object.assign(new Error('refused'), { config, ...refusal(status, error) }),
              ),
          },
        )
        .then(
          () => assertOrThrow(false, 'the request is refused'),
          (error: any) => error.response.data.error,
        );
    try {
      await reloadPizzaCatalog();
      answer = async () => ({ data: smaller });
      assertEqualOrThrow(
        await refusedWith(400, 'Pick a size'),
        'Pick a size',
        'an ordinary refusal',
      );
      assertEqualOrThrow(route.calls.length, 1, 'asks for no menu');
      const said = await refusedWith(400, 'That deal is not on the menu. Pick another deal');
      assertEqualOrThrow(
        said,
        'That deal is not on the menu. Pick another deal',
        'the caller still gets the refusal',
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEqualOrThrow(route.calls.length, 2, 'and the catalogue is fetched again');
      assertOrThrow(getPizzaCatalog() === smaller, 'so the till holds the menu the server has');
    } finally {
      route.restore();
      require('../frontend/src/store/session-events').notifySessionBoundary('logout');
    }
  },

  'Case 10g: a changed menu is held back while a sheet is open, whatever fetched it': async () => {
    const { getPizzaCatalog, holdPizzaCatalog, onPizzaCatalogChange, reloadPizzaCatalog } =
      pizzaCatalog();
    const { useAuthStore } = frontend.auth;
    const edited = { ...catalog, deals: [] };
    let answer: () => Promise<unknown> = async () => ({ data: catalog });
    const route = stubCatalogRoute(() => answer());
    const told: boolean[] = [];
    const stop = onPizzaCatalogChange((replaced: boolean) => told.push(replaced));
    try {
      await reloadPizzaCatalog();
      told.length = 0;

      const slow = deferred();
      answer = () => slow.promise as Promise<unknown>;
      const inFlight = reloadPizzaCatalog();
      holdPizzaCatalog(true);
      slow.resolve({ data: edited });
      await inFlight;
      assertOrThrow(
        getPizzaCatalog() === catalog,
        'a fetch already in flight does not swap the menu',
      );
      same(told, [], 'and no screen is told');
      holdPizzaCatalog(false);
      assertOrThrow(getPizzaCatalog() === edited, 'the new menu applies when the sheet closes');
      same(told, [true], 'and the screens are told then, once');

      holdPizzaCatalog(true);
      answer = async () => ({ data: catalog });
      await frontend.api
        .post(
          '/orders',
          {},
          {
            adapter: (config: unknown) =>
              Promise.reject(
                Object.assign(new Error('refused'), {
                  config,
                  response: {
                    status: 400,
                    data: { error: 'That deal is not on the menu. Pick another deal' },
                  },
                }),
              ),
          },
        )
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertOrThrow(getPizzaCatalog() === edited, 'nor does the reload after a refused order');
      answer = async () => ({ data: JSON.parse(JSON.stringify(edited)) });
      await reloadPizzaCatalog();
      holdPizzaCatalog(false);
      assertOrThrow(
        getPizzaCatalog() === edited,
        'a menu that went back to the one held changes nothing',
      );
      same(told, [true], 'and tells nobody');

      holdPizzaCatalog(true);
      answer = async () => ({ data: catalog });
      await reloadPizzaCatalog();
      useAuthStore.setState({ currentTenant: { id: 9 } as any });
      holdPizzaCatalog(false);
      assertEqualOrThrow(
        getPizzaCatalog(),
        null,
        "a menu held back for the tenant left is not the next tenant's",
      );
    } finally {
      holdPizzaCatalog(false);
      stop();
      route.restore();
      useAuthStore.setState({ currentTenant: null });
      require('../frontend/src/store/session-events').notifySessionBoundary('logout');
    }
  },

  'Case 10h: the lists that go with a menu load together, for the session and tenant that asked':
    async () => {
      const { menuListLoader } = require('../frontend/src/lib/pizza/menu-lists');
      const { notifySessionBoundary } = require('../frontend/src/store/session-events');
      const { useAuthStore } = frontend.auth;
      const tenant = (id: number | null) =>
        useAuthStore.setState({ currentTenant: id === null ? null : ({ id } as any) });
      const originalGet = frontend.api.get;
      let answer: (url: string) => Promise<unknown> = async (url) => ({ data: { from: url } });
      frontend.api.get = (url: string) => answer(url);
      const got: Record<string, unknown[]> = { products: [], categories: [] };
      const load = menuListLoader([
        { url: '/products?active=1', apply: (data: unknown) => got.products.push(data) },
        { url: '/categories?active=1', apply: (data: unknown) => got.categories.push(data) },
      ]);
      const refused = (loading: Promise<unknown>) =>
        loading.then(
          () => false,
          () => true,
        );
      try {
        tenant(1);
        const apply = await load();
        same([got.products.length, got.categories.length], [0, 0], 'loading shows nothing yet');
        apply();
        same(
          [got.products, got.categories],
          [[{ from: '/products?active=1' }], [{ from: '/categories?active=1' }]],
          'the lists are put on screen together, when asked',
        );

        answer = (url) =>
          url.startsWith('/products')
            ? Promise.reject({ response: { status: 500 } })
            : Promise.resolve({ data: { from: url } });
        assertOrThrow(
          await refused(load()),
          'one list failing fails the load, so none is shown alone',
        );

        const slow = deferred();
        answer = () => slow.promise as Promise<unknown>;
        const leaving = refused(load());
        tenant(2);
        slow.resolve({ data: { from: 'tenant 1' } });
        assertOrThrow(await leaving, 'an answer for the tenant left is refused');

        const late = deferred();
        answer = () => late.promise as Promise<unknown>;
        const before = refused(load());
        notifySessionBoundary('login');
        late.resolve({ data: { from: 'the session before' } });
        assertOrThrow(await before, 'and so is one from before a sign-in');
        same([got.products.length, got.categories.length], [1, 1], 'neither reached the screen');
      } finally {
        frontend.api.get = originalGet;
        tenant(null);
        notifySessionBoundary('logout');
      }
    },

  'Case 10j: a changed menu and the lists that go with it are published in one step': async () => {
    const {
      getPizzaCatalog,
      holdPizzaCatalog,
      onPizzaCatalogChange,
      reloadPizzaCatalog,
      setPizzaMenuCompanion,
    } = pizzaCatalog();
    const { notifySessionBoundary } = require('../frontend/src/store/session-events');
    const { useAuthStore } = frontend.auth;
    const tenant = (id: number | null) =>
      useAuthStore.setState({ currentTenant: id === null ? null : ({ id } as any) });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    /** The menu as the server holds it at version `v`, and the lists that go with it. */
    const menuAt = (v: number) => ({
      ...catalog,
      sizes: catalog.sizes.map((size: any) => ({ ...size, priceCents: size.priceCents + v })),
    });
    const versionOf = (held: any) => held.sizes[0].priceCents - catalog.sizes[0].priceCents;
    let server = 1;
    const route = stubCatalogRoute(async () => ({ data: menuAt(server) }));
    /** What the till shows: the lists the page holds, beside the catalogue held. */
    const shown = { products: 1, categories: 1 };
    let listAnswers: Array<() => Promise<number>> = [];
    let listRequests = 0;
    const companion = async () => {
      listRequests += 1;
      const next = listAnswers.shift() ?? (async () => server);
      const version = await next();
      return () => {
        shown.products = version;
        shown.categories = version;
      };
    };
    const agrees = (expected: number, step: string) =>
      same(
        [versionOf(getPizzaCatalog()), shown.products, shown.categories],
        [expected, expected, expected],
        `${step}: the menu, the products and the categories are of one version`,
      );
    const told: boolean[] = [];
    const stop = onPizzaCatalogChange((replaced: boolean) => {
      told.push(replaced);
      const version = versionOf(getPizzaCatalog());
      same(
        [shown.products, shown.categories],
        [version, version],
        'a screen told of a menu sees its lists',
      );
    });
    try {
      tenant(1);
      await reloadPizzaCatalog();
      setPizzaMenuCompanion(companion, 5);
      told.length = 0;
      agrees(1, 'the first load');

      // Another device loads a menu; the lists for it are slow.
      const lists = deferred();
      listAnswers = [() => lists.promise as Promise<number>];
      server = 2;
      await reloadPizzaCatalog();
      agrees(1, 'the new catalogue has answered, its lists have not');
      await tick();
      agrees(1, 'still waiting for the lists');
      same(told, [], 'no screen is told yet');
      lists.resolve(2);
      await tick();
      agrees(2, 'the lists arrived');
      same(told, [true], 'the screens are told once');

      // The list requests fail, then work: no focus, no refresh, only the timer.
      server = 3;
      listRequests = 0;
      const failing = () => Promise.reject(new Error('offline'));
      listAnswers = [failing, failing];
      await reloadPizzaCatalog();
      await tick();
      agrees(2, 'a failed list request leaves the old menu and the old lists');
      await new Promise((resolve) => setTimeout(resolve, 60));
      agrees(3, 'the request is tried again on a timer, and the three change together');
      assertEqualOrThrow(listRequests, 3, 'after two failures and one answer');

      // A sheet is open: the swap waits for it, lists and all.
      server = 4;
      holdPizzaCatalog(true);
      await reloadPizzaCatalog();
      await tick();
      agrees(3, 'under an open sheet nothing changes, though the lists have loaded');
      holdPizzaCatalog(false);
      agrees(4, 'closing it swaps the three in one step');

      // The sheet opens while the lists are on their way.
      const underway = deferred();
      listAnswers = [() => underway.promise as Promise<number>];
      server = 5;
      await reloadPizzaCatalog();
      holdPizzaCatalog(true);
      underway.resolve(5);
      await tick();
      agrees(4, 'lists that arrive under an open sheet wait too');
      holdPizzaCatalog(false);
      agrees(5, 'and go on screen with the menu when it closes');

      // The menu changes again before the first lists arrive: those lists are for an older menu.
      const older = deferred();
      const newer = deferred();
      listAnswers = [
        () => older.promise as Promise<number>,
        () => newer.promise as Promise<number>,
      ];
      server = 6;
      await reloadPizzaCatalog();
      server = 7;
      await reloadPizzaCatalog();
      older.resolve(6);
      await tick();
      agrees(5, 'lists asked for before the last menu change are not shown');
      newer.resolve(7);
      await tick();
      agrees(7, 'the lists of the last change are');

      // Tenant and session: a late answer changes nothing for whoever is signed in now.
      const leaving = deferred();
      listAnswers = [() => leaving.promise as Promise<number>];
      server = 8;
      await reloadPizzaCatalog();
      tenant(2);
      leaving.resolve(8);
      await tick();
      same([shown.products, shown.categories], [7, 7], 'lists for the tenant left are not applied');
      tenant(1);
      agrees(7, 'and that tenant still has a menu and lists that agree');

      const signedOut = deferred();
      listAnswers = [() => signedOut.promise as Promise<number>];
      server = 9;
      await reloadPizzaCatalog();
      notifySessionBoundary('logout');
      signedOut.resolve(9);
      await tick();
      same([shown.products, shown.categories], [7, 7], 'nor are lists from before a sign-out');
      assertEqualOrThrow(getPizzaCatalog(), null, 'and no menu is held for the new session');
    } finally {
      stop();
      setPizzaMenuCompanion(null);
      holdPizzaCatalog(false);
      route.restore();
      tenant(null);
      notifySessionBoundary('logout');
    }
  },

  'Case 10i: opening a sheet, a configurator, a dialog or a sent line holds the menu at once':
    async () => {
      const { getPizzaCatalog, holdPizzaCatalog, reloadPizzaCatalog } = pizzaCatalog();
      const React = require('../frontend/node_modules/react');
      const { renderToString } = require('../frontend/node_modules/react-dom/server');
      const { IntlProvider } = require('../frontend/node_modules/use-intl');
      const { usePizzaPos } = require('../frontend/src/components/pos/pizza/usePizzaPos');
      const {
        useQuickButtonStore,
      } = require('../frontend/src/components/pos/pizza/useQuickButtons');
      const { openSentLine } = require('../frontend/src/components/pos/pizza/SentPizzaLine');
      const messages = { pizza: require('../frontend/src/lib/i18n/messages-pizza/en.json') };
      const edited = { ...catalog, deals: [] };
      const products = [
        { id: 'pz-garden', name: 'Garden', price: 0, variants: [] },
        { id: 'dl-party', name: 'Party Pack', price: 118.4 },
      ];
      const nothing = () => {};

      /** Renders the POS hook on the server, where no effect runs, and calls `open` during it. */
      const duringRender = (open: (pos: any) => void) => () => {
        let called = false;
        const Probe = () => {
          const pos = usePizzaPos(products, [], nothing, nothing, nothing);
          assertOrThrow(pos !== null, 'the pizza screens are on');
          if (!called) {
            called = true;
            open(pos);
          }
          return null;
        };
        renderToString(
          React.createElement(IntlProvider, { locale: 'en', messages }, React.createElement(Probe)),
        );
        assertOrThrow(called, 'the opener was called');
      };
      const openers: Record<string, () => void> = {
        'the pizza sheet': duringRender((pos) => pos.open(products[0])),
        'the deal configurator': duringRender((pos) => pos.open(products[1])),
        'a quick button dialog': () =>
          useQuickButtonStore.getState().open({ type: 'save', line: null, forCustomer: false }),
        'a sent line': () => openSentLine(41),
      };

      let answer: () => Promise<unknown> = async () => ({ data: catalog });
      const route = stubCatalogRoute(() => answer());
      try {
        for (const [name, open] of Object.entries(openers)) {
          answer = async () => ({ data: catalog });
          await reloadPizzaCatalog();
          assertOrThrow(getPizzaCatalog() === catalog, `${name}: the menu held before it opens`);
          const slow = deferred();
          answer = () => slow.promise as Promise<unknown>;
          const inFlight = reloadPizzaCatalog();
          open();
          // No effect has run: the answer arrives in the same turn the opener was called in.
          slow.resolve({ data: edited });
          await inFlight;
          assertOrThrow(
            getPizzaCatalog() === catalog,
            `${name}: an answer arriving right after it opens does not change the menu it reads`,
          );
          holdPizzaCatalog(false);
          assertOrThrow(
            getPizzaCatalog() === edited,
            `${name}: the new menu applies once it closes`,
          );
        }
      } finally {
        holdPizzaCatalog(false);
        useQuickButtonStore.setState({ dialog: null });
        route.restore();
        require('../frontend/src/store/session-events').notifySessionBoundary('logout');
      }
    },

  'Case 11: a cart line gives its detail lines at the cart panel width': async () => {
    const { cartLineDetailLines, CART_DETAIL_COLUMNS } = detailLines();
    const { reloadPizzaCatalog } = pizzaCatalog();
    const long = halves(
      part('garden', ['Cheese', 'Green peppers', 'Mushrooms', 'Olives', 'Onions', 'Tomato sauce']),
      part('smokehouse', ['Red onions']),
      { cook: 'well-done', cut: 'square-cut' },
    );
    same(
      cartLineDetailLines(lineOf(long)),
      [RECIPE_NOT_PRINTED],
      'with no catalogue a recipe shows the warning words',
    );
    same(cartLineDetailLines(lineOf(undefined)), [], 'and a line without a recipe nothing');

    const route = stubCatalogRoute(async () => ({ data: catalog }));
    try {
      await reloadPizzaCatalog();
    } finally {
      route.restore();
    }
    for (const recipe of [ISLAND_CLASSIC, long, NO_OLIVES]) {
      same(
        cartLineDetailLines(lineOf(recipe)),
        ticketLines(catalog, recipe, CART_DETAIL_COLUMNS).detailLines,
        'the lines ticketLines gives at the cart width',
      );
    }
    same(
      cartLineDetailLines(lineOf(ISLAND_CLASSIC)),
      ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC PEPPERONI'],
      'a half and half in the cart',
    );
    assertOrThrow(
      cartLineDetailLines(lineOf(long)).every(
        (row: string) => row.length <= CART_DETAIL_COLUMNS - 3,
      ),
      'no line is wider than ticketLines allows at that width',
    );
    same(cartLineDetailLines(lineOf(undefined)), [], 'a line without a recipe shows nothing extra');
    same(
      cartLineDetailLines(lineOf({ kind: 'deal' })),
      [RECIPE_NOT_PRINTED],
      'a recipe that cannot be written out shows the warning words',
    );
  },

  'Case 12: a pizza moved to another size takes its recipe with it': () => {
    cart().clearCart();
    cart().addItem(GARDEN, 1, [], '', LARGE_GARDEN, NO_OLIVES);
    cart().addItem(HALF, 2, [], '', LARGE, ISLAND_CLASSIC);
    const [whole, half] = cart().items;
    cart().updateItemDetails(whole.id, 1, [], '', MEDIUM_GARDEN);
    cart().updateItemDetails(half.id, 2, [], '', MEDIUM);
    same(
      cart().items.map((item: any) => [item.variant.id, item.recipe]),
      [
        ['pz-garden-medium', medium(NO_OLIVES)],
        ['pz-half-and-half-medium', medium(ISLAND_CLASSIC)],
      ],
      'a whole pizza and a half and half both say medium in their recipes',
    );
    same(
      cart().items.map((item: any) => item.id),
      [
        generateCartItemId(GARDEN.id, MEDIUM_GARDEN.id, [], '', undefined, medium(NO_OLIVES)),
        generateCartItemId(HALF.id, MEDIUM.id, [], '', undefined, medium(ISLAND_CLASSIC)),
      ],
      'and each line takes the identity of the medium pizza',
    );
    assertOrThrow(
      cart().items[0].id !== whole.id && cart().items[1].id !== half.id,
      'which is not the identity it had',
    );
    assertEqualOrThrow(NO_OLIVES.sizeId, 'large', 'the recipe it was given is as it was');

    cart().updateItemDetails(cart().items[0].id, 3, [], 'no box');
    same(
      [cart().items[0].quantity, cart().items[0].recipe],
      [3, medium(NO_OLIVES)],
      'an edit that leaves the size alone leaves the recipe alone',
    );

    cart().clearCart();
    cart().addItem(GARDEN, 1, [], '', MEDIUM_GARDEN, medium(NO_OLIVES));
    cart().addItem(GARDEN, 2, [], '', LARGE_GARDEN, NO_OLIVES);
    cart().addItem(GARDEN, 1, [], '', LARGE_GARDEN);
    cart().updateItemDetails(cart().items[1].id, 2, [], '', MEDIUM_GARDEN);
    cart().updateItemDetails(cart().items[1].id, 1, [], '', MEDIUM_GARDEN);
    same(
      cart().items.map((item: any) => [item.quantity, item.variant.id, item.recipe]),
      [
        [3, 'pz-garden-medium', medium(NO_OLIVES)],
        [1, 'pz-garden-medium', undefined],
      ],
      'a resized pizza joins the same pizza at that size; a plain pizza gains no recipe',
    );
  },

  'Case 13: a plain whole pizza is the same line with or without its recipe': () => {
    assertEqualOrThrow(
      generateCartItemId(GARDEN.id, LARGE_GARDEN.id, [], '', undefined, PLAIN_GARDEN),
      PLAIN_GARDEN_ID,
      'a recipe that says nothing gives the id of no recipe',
    );
    for (const said of [
      { cook: 'well-done' },
      { cut: 'uncut' },
      { whole: part('garden', ['Olives']) },
    ]) {
      assertOrThrow(
        generateCartItemId(GARDEN.id, LARGE_GARDEN.id, [], '', undefined, {
          ...PLAIN_GARDEN,
          ...said,
        }) !== PLAIN_GARDEN_ID,
        `${json(said)} is not plain`,
      );
    }
    assertOrThrow(
      idOf(halves(part('garden'), part('classic'))) !== idOf(),
      'a half and half is never plain',
    );

    for (const order of [
      [PLAIN_GARDEN, undefined],
      [undefined, PLAIN_GARDEN],
    ]) {
      cart().clearCart();
      for (const recipe of order) cart().addItem(GARDEN, 1, [], '', LARGE_GARDEN, recipe);
      same(
        cart().items.map((item: any) => [item.id, item.quantity]),
        [[PLAIN_GARDEN_ID, 2]],
        'a plain pizza from a quick button and one from a tile are one 2x line',
      );
    }
    same(
      normalizeCartItems([
        lineOf(PLAIN_GARDEN, { product: GARDEN, variant: LARGE_GARDEN }),
        lineOf(undefined, { product: GARDEN, variant: LARGE_GARDEN, quantity: 2 }),
      ]).map((item: any) => [item.id, item.quantity]),
      [[PLAIN_GARDEN_ID, 3]],
      'and they merge when a saved cart is restored',
    );
    same(
      cartItemToOrderItem(lineOf(PLAIN_GARDEN, { product: GARDEN, variant: LARGE_GARDEN })),
      {
        product_id: 'pz-garden',
        variant_id: 'pz-garden-large',
        quantity: 1,
        addons: null,
        special_instructions: null,
        modifier_selection: null,
      },
      'a plain pizza goes out saying it has no recipe',
    );
  },

  'Case 14: a line opened in the sheet and saved unchanged keeps its identity': () => {
    const { replaceCartLine } = cartLines();
    const { newSheet, sheetReducer, sheetLine } = sheet();
    cart().clearCart();
    cart().addItem(HALF, 2, [dip(), ranch(2)], 'no box', LARGE, GARDEN_TWICE_TAPPED_BACKWARDS);
    cart().addItem(GARDEN, 1, [ranch(1)], '', LARGE_GARDEN, { ...NO_OLIVES, cut: 'uncut' });
    cart().addItem(GARDEN, 3, [dip()], '', LARGE_GARDEN);
    const before = cart().items;
    for (const line of before) {
      const state = sheetReducer(newSheet(), { type: 'load', line });
      const saved = sheetLine(catalog, state);
      assertOrThrow(saved.canAdd, `${line.id}: the sheet accepts the line it loaded`);
      assertEqualOrThrow(saved.productId, line.product.id, `${line.id}: the same product`);
      assertEqualOrThrow(saved.variantId, line.variant.id, `${line.id}: the same variant`);
      const edited = {
        ...line,
        quantity: state.quantity,
        special_instructions: state.note,
        recipe: saved.recipe,
        addons: saved.dips.map((entry: any) => ({
          ...line.addons.find((addon: any) => addon.id === entry.addonId),
          quantity: entry.quantity,
        })),
      };
      const after = replaceCartLine(before, line.id, edited);
      same(
        after.map((item: any) => [item.id, item.quantity]),
        before.map((item: any) => [item.id, item.quantity]),
        `${line.id}: every line has the id and quantity it had`,
      );
    }
  },

  'Case 15: the order request says a plain pizza has no recipe, and says nothing for other products':
    () => {
      const garden = (recipe?: object) =>
        lineOf(recipe, { product: GARDEN, variant: LARGE_GARDEN });
      for (const [label, line] of [
        ['with no recipe on the line', garden()],
        ['with a plain whole recipe on the line', garden(PLAIN_GARDEN)],
        ['with a null recipe on the line', { ...garden(), recipe: null }],
      ] as const) {
        const payload = cartItemToOrderItem(line);
        assertOrThrow('modifier_selection' in payload, `a plain pizza ${label}: the key is sent`);
        assertEqualOrThrow(payload.modifier_selection, null, `a plain pizza ${label}: as null`);
      }
      same(
        cartItemToOrderItem(garden(NO_OLIVES)).modifier_selection,
        NO_OLIVES,
        'a pizza with a removal sends its recipe',
      );
      same(
        cartItemToOrderItem(lineOf(ISLAND_CLASSIC)).modifier_selection,
        ISLAND_CLASSIC,
        'a half and half sends its recipe',
      );
      assertEqualOrThrow(
        cartItemToOrderItem(lineOf(undefined)).modifier_selection,
        null,
        'a half-and-half product with no recipe says so, and the server refuses it',
      );

      for (const [productId, variantId] of [
        ['sd-wings', null],
        ['dr-cola', 'dr-cola-can'],
        ['dl-party', null],
        ['prod-1', 'var-large'],
        ['pizza-oven-mitt', null],
      ]) {
        const payload = cartItemToOrderItem(
          lineOf(undefined, {
            product: product(productId as string, 'Other'),
            variant: variantId ? variant(productId as string, 'x', 2) : null,
          }),
        );
        assertOrThrow(
          !('modifier_selection' in payload),
          `${productId}: no modifier_selection key at all`,
        );
      }

      assertEqualOrThrow(
        fingerprint([garden()]),
        fingerprint([garden(PLAIN_GARDEN)]),
        'a plain pizza has one retry fingerprint, with or without a plain recipe on its line',
      );
      assertOrThrow(
        fingerprint([garden()]) !== fingerprint([garden(NO_OLIVES)]),
        'and a different one once something is removed',
      );
    },
});
