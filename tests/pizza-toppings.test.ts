/**
 * Extra and added toppings: the menu's toppings list, the recipe that records
 * them, the ticket text, and the sheet that builds them.
 *
 * Run: npm run test:pizza-toppings
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  rows,
  runCases,
} = require('./helpers/pizza-print-harness');
const { MenuError, parseMenuFile } = require('../shared/pizza/menu');
const { RecipeError, validateRecipe, recipeKey } = require('../shared/pizza/recipe');
const { kitchenAddons, toppingCounts } = require('../shared/pizza/toppings');
const { ticketLines } = require('../shared/pizza/ticket');
const sample = require('./fixtures/pizza-sample-menu.json');
const {
  newSheet,
  sheetReducer,
  sheetLine,
  sheetQuote,
} = require('../frontend/src/lib/pizza/sheet-state');
const {
  newDeal,
  dealReducer,
  dealLine,
  dealQuote,
} = require('../frontend/src/lib/pizza/deal-state');
const { sheetAddons } = require('../frontend/src/lib/pizza/cart-lines');
const { lineRecipe } = require('../frontend/src/lib/pizza/line-recipe');
const {
  sentLine,
  sentLineEdit,
  sentLineReprices,
  sheetSentLine,
  sheetSource,
  soldPrices,
  dealSentLine,
} = require('../frontend/src/lib/pizza/sent-line');
const {
  buttonContents,
  buttonLine,
  buttonPrice,
} = require('../frontend/src/lib/pizza/quick-buttons');
const {
  chargedAddons,
  handPickedGroups,
  keptToppingAddons,
  toppingCharges,
  toppingPrices,
} = require('../frontend/src/lib/pizza/toppings');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(JSON.stringify(actual), JSON.stringify(expected), message);

const catalog = () => parseMenuFile(sample);
const part = (pizzaId: string, more: object = {}) => ({ pizzaId, removed: [], ...more });
const pizza = (parts: object) => ({ kind: 'pizza', v: 1, sizeId: 'large', ...parts });
const whole = (pizzaId: string, more: object = {}) => pizza({ whole: part(pizzaId, more) });
const halves = (first: object, second: object) => pizza({ halves: [first, second] });

/** Applies actions in order, as taps on the sheet would. */
const tap = (state: object, ...actions: object[]) =>
  actions.reduce((current, action) => sheetReducer(current, action), state) as any;
const olives = { type: 'ingredient', half: 0, name: 'Olives' };
const choose = (half: number, pizzaId: string) => ({ type: 'pizza', half, pizzaId });
const topping = (half: number, toppingId: string) => ({ type: 'topping', half, toppingId });
const threeLarge = {
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [
    whole('garden', { extra: ['Cheese', 'Onions'] }),
    halves(part('island', { added: ['bacon', 'feta'] }), part('plain', { added: ['feta'] })),
    whole('classic'),
  ],
  wingFlavour: 'hot',
};

/** POS products as `GET /products` lists them: size variants and the add-on groups linked to them. */
const addon = (id: string, addon_group_id: string, name: string, price: number) => ({
  id,
  addon_group_id,
  name,
  price,
});
const addonGroups = [
  { id: 'ag-dips', name: 'Dips', addons: [addon('ad-dips-ranch', 'ag-dips', 'Ranch', 1.25)] },
  {
    id: 'ag-toppings',
    name: 'Toppings',
    addons: [
      addon('ad-topping', 'ag-toppings', 'Topping', 2.25),
      addon('ad-topping-half', 'ag-toppings', 'Half topping', 1.13),
    ],
  },
];
const pizzaProduct = (id: string, name: string) => ({
  id,
  name,
  price: 15,
  variants: [{ id: `${id}-large`, name: 'Large', price: 23 }],
  addon_groups: addonGroups,
});
const gardenProduct = pizzaProduct('pz-garden', 'Garden');
const halfProduct = pizzaProduct('pz-half-and-half', 'Half & Half');
const dealProduct = {
  id: 'dl-three-large-wings',
  name: 'Large Pizzas & Wings',
  price: 71.25,
  addon_groups: addonGroups,
};
const cartLine = (productId: string, recipe: object) => ({
  product: { id: productId },
  variant: { id: `${productId}-large` },
  quantity: 1,
  addons: [],
  special_instructions: '',
  recipe,
});

function menuRejected(change: (menu: any) => void, expectedPath: string, message: string) {
  const menu = structuredClone(sample);
  change(menu);
  let error: any;
  try {
    parseMenuFile(menu);
  } catch (caught) {
    error = caught;
  }
  assertOrThrow(error instanceof MenuError, `${message}: rejected with a MenuError`);
  assertEqualOrThrow(error.path, expectedPath, `${message}: names the entry`);
  return error;
}

function refused(raw: unknown, expected: string, message: string) {
  let error: any;
  try {
    validateRecipe(catalog(), raw);
  } catch (caught) {
    error = caught;
  }
  assertOrThrow(error instanceof RecipeError, `${message}: refused with a RecipeError`);
  assertEqualOrThrow(error.message, expected, `${message}: says what to do`);
}

runCases('Pizza toppings', {
  'Case 1: the menu lists the toppings and their one price': () => {
    const { toppings } = catalog();
    assertEqualOrThrow(toppings.priceCents, 225, 'the topping price in whole cents');
    assertEqualOrThrow(toppings.items.length, 8, 'eight toppings');
    same(toppings.items[5], { id: 'banana-peppers', label: 'Banana Peppers' }, 'id and name');

    const without = structuredClone(sample);
    delete without.toppings;
    const plain = parseMenuFile(without);
    assertOrThrow(!('toppings' in plain), 'a menu without toppings loads, with no toppings field');

    const items = (menu: any) => menu.toppings.items;
    menuRejected((menu) => (menu.toppings = []), 'toppings', 'toppings as a bare list');
    menuRejected((menu) => (menu.toppings.price = 2.255), 'toppings.price', 'a fraction of a cent');
    menuRejected((menu) => delete menu.toppings.price, 'toppings.price', 'no price');
    menuRejected((menu) => (menu.toppings.price = -1), 'toppings.price', 'a negative price');
    menuRejected((menu) => (items(menu)[1].id = 'Bacon'), 'toppings.items[1].id', 'a bad id');
    menuRejected((menu) => (items(menu)[1].name = ''), 'toppings.items[1].name', 'an empty name');
    menuRejected(
      (menu) => (items(menu)[1].name = 'Bacon\nbits'),
      'toppings.items[1].name',
      'a line break in a name',
    );
    menuRejected((menu) => (items(menu)[2].id = 'bacon'), 'toppings.items[2].id', 'an id twice');
    const grown = (count: number) => (menu: any) =>
      (menu.toppings.items = Array.from({ length: count }, (_, index) => ({
        id: `topping-${index}`,
        name: `Topping ${index}`,
      })));
    const tooMany = menuRejected(grown(61), 'toppings.items', '61 toppings');
    assertOrThrow(tooMany.message.includes('at most 60'), 'the message gives the cap');
    const most = structuredClone(sample);
    grown(60)(most);
    assertEqualOrThrow(parseMenuFile(most).toppings.items.length, 60, '60 toppings are accepted');
  },

  'Case 2: a recipe records extras and added toppings, sorted and without duplicates': () => {
    const raw = whole('garden', {
      removed: ['Olives'],
      extra: ['Onions', 'Cheese', 'Onions'],
      added: ['feta', 'bacon', 'feta'],
    });
    const before = JSON.stringify(raw);
    same(
      validateRecipe(catalog(), raw),
      pizza({
        whole: {
          pizzaId: 'garden',
          removed: ['Olives'],
          extra: ['Cheese', 'Onions'],
          added: ['bacon', 'feta'],
        },
      }),
      'the normalised copy',
    );
    assertEqualOrThrow(JSON.stringify(raw), before, 'the input is not changed');

    const half = validateRecipe(
      catalog(),
      halves(part('island', { added: ['bacon'] }), part('classic', { extra: ['Cheese'] })),
    );
    same(
      half.halves,
      [
        { pizzaId: 'island', removed: [], added: ['bacon'] },
        { pizzaId: 'classic', removed: [], extra: ['Cheese'] },
      ],
      'each half keeps its own',
    );
  },

  'Case 3: a recipe stored before toppings is unchanged and means the same': () => {
    const old = whole('garden', { removed: ['Olives'] });
    same(validateRecipe(catalog(), old), old, 'no new field appears');
    same(
      validateRecipe(catalog(), whole('garden', { removed: ['Olives'], extra: [], added: [] })),
      old,
      'an empty list is an absent one',
    );
    assertEqualOrThrow(
      recipeKey(old),
      '{"kind":"pizza","v":1,"sizeId":"large","whole":{"pizzaId":"garden","removed":["Olives"]}}',
      'and its key is the key it always had',
    );
    assertEqualOrThrow(
      recipeKey(whole('garden', { removed: ['Olives'], extra: [], added: [] })),
      recipeKey(old),
      'with or without empty lists',
    );
    const without = structuredClone(sample);
    delete without.toppings;
    same(validateRecipe(parseMenuFile(without), old), old, 'also on a menu without toppings');
  },

  'Case 4: each refusal says what to do': () => {
    refused(
      whole('island', { extra: ['Olives'] }),
      'Island does not have that ingredient. Choose what to make extra again',
      'an extra of an ingredient the pizza does not have',
    );
    refused(
      whole('garden', { removed: ['Olives'], extra: ['Olives'] }),
      'Olives cannot be both removed and extra. Choose one',
      'an ingredient both removed and extra',
    );
    refused(
      whole('garden', { added: ['gold-leaf'] }),
      'That topping is not on the menu. Pick another topping',
      'a topping the menu does not list',
    );
    refused(
      whole('garden', { added: ['mushrooms'] }),
      'Garden already has Mushrooms. Choose extra Mushrooms instead',
      'a topping that is already an ingredient',
    );
    refused(
      halves(part('island'), part('garden', { added: ['mushrooms'] })),
      'Second half: Garden already has Mushrooms. Choose extra Mushrooms instead',
      'the same on a half, naming the half',
    );
    refused(
      whole('garden', { extra: 'Cheese' }),
      'This item could not be read. Remove it and add it again',
      'extras that are not a list',
    );
    refused(
      whole('garden', { added: [7] }),
      'That topping is not on the menu. Pick another topping',
      'a topping that is not text',
    );

    const without = structuredClone(sample);
    delete without.toppings;
    let error: any;
    try {
      validateRecipe(parseMenuFile(without), whole('garden', { added: ['bacon'] }));
    } catch (caught) {
      error = caught;
    }
    assertOrThrow(error instanceof RecipeError, 'a menu without toppings takes no added topping');
    // An extra is charged the topping price, and a menu without toppings has none.
    try {
      error = undefined;
      validateRecipe(parseMenuFile(without), whole('garden', { extra: ['Cheese'] }));
    } catch (caught) {
      error = caught;
    }
    assertEqualOrThrow(
      error?.message,
      'This menu has no price for extra Cheese. Take the extra off',
      'a menu without toppings takes no extra either',
    );

    assertEqualOrThrow(
      validateRecipe(catalog(), whole('island', { added: ['mushrooms'] })).whole.added[0],
      'mushrooms',
      'the same topping goes on a pizza that does not have it',
    );
  },

  'Case 5: the key differs when an extra or a topping differs, not when only the order does':
    () => {
      const key = (more: object) => recipeKey(validateRecipe(catalog(), whole('garden', more)));
      const plain = key({});
      assertOrThrow(key({ extra: ['Cheese'] }) !== plain, 'an extra changes the key');
      assertOrThrow(key({ added: ['bacon'] }) !== plain, 'an added topping changes the key');
      assertOrThrow(
        key({ extra: ['Cheese'] }) !== key({ extra: ['Onions'] }),
        'which extra counts',
      );
      assertOrThrow(key({ added: ['bacon'] }) !== key({ added: ['feta'] }), 'which topping counts');
      assertEqualOrThrow(
        key({ extra: ['Onions', 'Cheese'], added: ['feta', 'bacon'] }),
        key({ extra: ['Cheese', 'Onions'], added: ['bacon', 'feta'] }),
        'the order they were tapped in does not',
      );
      assertEqualOrThrow(
        recipeKey(whole('garden', { extra: ['Onions', 'Cheese'] })),
        recipeKey(whole('garden', { extra: ['Cheese', 'Onions'] })),
        'recipeKey itself sorts',
      );
    },

  'Case 6: identical halves are compared whole, extras and toppings included': () => {
    const same = 'Both halves are the same. Choose a whole pizza instead';
    refused(
      halves(part('garden', { extra: ['Cheese'] }), part('garden', { extra: ['Cheese'] })),
      same,
      'two halves with the same extra',
    );
    refused(
      halves(
        part('island', { added: ['feta', 'bacon'] }),
        part('island', { added: ['bacon', 'feta'] }),
      ),
      same,
      'two halves with the same toppings in another order',
    );
    for (const more of [{ extra: ['Cheese'] }, { added: ['bacon'] }])
      assertOrThrow(
        validateRecipe(catalog(), halves(part('garden'), part('garden', more))).halves,
        `halves that differ only by ${JSON.stringify(more)} are allowed`,
      );
  },

  'Case 7: at most ten toppings are added to one pizza or half': () => {
    const many = structuredClone(sample);
    many.toppings.items = Array.from({ length: 11 }, (_, index) => ({
      id: `topping-${index}`,
      name: `Topping ${index}`,
    }));
    const menu = parseMenuFile(many);
    const ids = many.toppings.items.map((item: any) => item.id);
    assertEqualOrThrow(
      validateRecipe(menu, whole('garden', { added: ids.slice(0, 10) })).whole.added.length,
      10,
      'ten are accepted',
    );
    let error: any;
    try {
      validateRecipe(menu, whole('garden', { added: ids }));
    } catch (caught) {
      error = caught;
    }
    assertOrThrow(error instanceof RecipeError, 'eleven are refused');
    assertEqualOrThrow(
      error.message,
      'A pizza takes at most 10 added toppings. Take one off',
      'in words a cashier can act on',
    );
  },

  'Case 8: what a recipe is charged: whole toppings and half toppings': () => {
    same(toppingCounts(null), { whole: 0, half: 0 }, 'no recipe, no toppings');
    same(
      toppingCounts(whole('garden', { removed: ['Olives'] })),
      { whole: 0, half: 0 },
      'a removal is free',
    );
    same(
      toppingCounts(whole('garden', { extra: ['Cheese'], added: ['bacon'] })),
      { whole: 2, half: 0 },
      'an extra and an added topping on a whole pizza',
    );
    same(
      toppingCounts(
        halves(part('island', { added: ['bacon'] }), part('classic', { extra: ['Cheese'] })),
      ),
      { whole: 0, half: 2 },
      'one on each half',
    );
    same(
      toppingCounts({
        kind: 'deal',
        v: 1,
        dealId: 'three-large-wings',
        pizzas: [
          whole('garden', { extra: ['Cheese', 'Onions'] }),
          halves(part('island', { added: ['bacon', 'feta'] }), part('plain', { added: ['feta'] })),
          whole('classic'),
        ],
      }),
      { whole: 2, half: 3 },
      "a deal adds up its pizzas'",
    );
  },

  'Case 9: the ticket says EXTRA and ADD under the pizza, after the NO line': () => {
    const recipe = pizza({
      whole: part('garden', { removed: ['Olives'], extra: ['Cheese'], added: ['bacon', 'feta'] }),
      cook: 'well-done',
    });
    for (const columns of [42, 48]) {
      const lines = ticketLines(catalog(), recipe, columns);
      assertEqualOrThrow(lines.heading, 'LARGE GARDEN', `${columns}: the heading is unchanged`);
      same(
        lines.detailLines,
        ['NO OLIVES', 'EXTRA CHEESE', 'ADD BACON, ADD FETA', 'WELL DONE'],
        `${columns}: a whole pizza`,
      );
    }
    same(
      ticketLines(catalog(), whole('garden', { removed: ['Olives'] }), 42).detailLines,
      ['NO OLIVES'],
      'a recipe without extras or toppings prints as before',
    );
  },

  'Case 10: each half prints its own extras and toppings': () => {
    const recipe = halves(
      part('island', { extra: ['Ham'], added: ['bacon'] }),
      part('classic', { removed: ['Cheese'], extra: ['Pepperoni'] }),
    );
    for (const columns of [42, 48])
      same(
        ticketLines(catalog(), recipe, columns).detailLines,
        [
          '1ST: ISLAND',
          '  EXTRA HAM',
          '  ADD BACON',
          '2ND: CLASSIC PEPPERONI',
          '  NO CHEESE',
          '  EXTRA PEPPERONI',
        ],
        `${columns}: a half and half`,
      );
  },

  'Case 11: a pizza inside a deal prints them under its own number': () => {
    const recipe = {
      kind: 'deal',
      v: 1,
      dealId: 'three-large-wings',
      pizzas: [
        whole('garden', { extra: ['Cheese'], added: ['bacon'] }),
        halves(part('island', { added: ['feta'] }), part('plain')),
        whole('classic'),
      ],
      wingFlavour: 'hot',
    };
    for (const columns of [42, 48])
      same(
        ticketLines(catalog(), recipe, columns).detailLines,
        [
          '1) LARGE GARDEN',
          '   EXTRA CHEESE',
          '   ADD BACON',
          '2) LARGE HALF & HALF',
          '   1ST: ISLAND',
          '     ADD FETA',
          '   2ND: PLAIN CHEESE',
          '3) LARGE CLASSIC PEPPERONI',
          'WINGS: HOT',
          'INCLUDES: ANY 3 LARGE PIZZAS & 12 WINGS',
        ],
        `${columns}: a deal`,
      );
  },

  'Case 12: a long list wraps at commas and no line ends in a lone EXTRA or ADD': () => {
    const five = whole('island', {
      added: ['bacon', 'banana-peppers', 'feta', 'spinach', 'tomatoes'],
    });
    same(
      ticketLines(catalog(), five, 42).detailLines,
      ['ADD BACON, ADD BANANA PEPPERS,', 'ADD FETA, ADD SPINACH, ADD TOMATOES'],
      '42: five toppings',
    );
    same(
      ticketLines(catalog(), five, 48).detailLines,
      ['ADD BACON, ADD BANANA PEPPERS, ADD FETA,', 'ADD SPINACH, ADD TOMATOES'],
      '48: five toppings',
    );
    const narrow = ticketLines(
      catalog(),
      whole('garden', { extra: ['Green peppers', 'Tomato sauce'], added: ['banana-peppers'] }),
      16,
    ).detailLines;
    same(
      narrow,
      ['EXTRA GREEN', 'PEPPERS,', 'EXTRA TOMATO', 'SAUCE', 'ADD BANANA', 'PEPPERS'],
      'at 13 cells a name wraps on spaces, the word staying with its first word',
    );
    for (const columns of [16, 20, 42, 48])
      for (const line of ticketLines(
        catalog(),
        halves(
          part('garden', { extra: ['Green peppers', 'Mushrooms'], added: ['banana-peppers'] }),
          part('smokehouse', { extra: ['Roasted chicken'], added: ['artichokes', 'anchovies'] }),
        ),
        columns,
      ).detailLines) {
        assertOrThrow(!/(^|\s)(EXTRA|ADD)$/.test(line), `${columns}: "${line}" has no lone word`);
        assertOrThrow(line.length <= Math.max(1, columns - 3), `${columns}: "${line}" fits`);
      }
  },

  'Case 13: a topping the menu no longer lists prints as its id': () => {
    const without = structuredClone(sample);
    delete without.toppings;
    same(
      ticketLines(parseMenuFile(without), whole('island', { added: ['bacon'] }), 42).detailLines,
      ['ADD BACON'],
      'the id, upper-cased',
    );
  },

  'Case 14: an ingredient cycles normal, NO, EXTRA, normal': () => {
    const start = newSheet({ pizzaId: 'garden', sizeId: 'large' });
    same(start.halves[0], { pizzaId: 'garden', removed: [], extra: [], added: [] }, 'normal');
    const once = tap(start, olives);
    same([once.halves[0].removed, once.halves[0].extra], [['Olives'], []], 'one tap: NO');
    const twice = tap(once, olives);
    same([twice.halves[0].removed, twice.halves[0].extra], [[], ['Olives']], 'two taps: EXTRA');
    same(tap(twice, olives), start, 'three taps: normal again');
    // A menu without toppings has no price for an extra: there a second tap puts the ingredient back.
    same(tap(once, { ...olives, extras: false }), start, 'without extras, two taps: normal again');
    same(start.halves[0].extra, [], 'the state given is not changed');

    const split = tap(
      newSheet({ split: true, sizeId: 'large' }),
      choose(0, 'garden'),
      choose(1, 'garden'),
    );
    const oneHalf = tap(
      split,
      { type: 'ingredient', half: 1, name: 'Cheese' },
      { type: 'ingredient', half: 1, name: 'Cheese' },
    );
    same(
      [oneHalf.halves[0].extra, oneHalf.halves[1].extra],
      [[], ['Cheese']],
      'each half cycles on its own',
    );
    const line = sheetLine(catalog(), oneHalf);
    assertOrThrow(line.canAdd, `halves that differ only by an extra are allowed (${line.message})`);
    assertEqualOrThrow(
      sheetLine(catalog(), split).message,
      'Both halves are the same. Choose a whole pizza instead',
      'and without it they are the same',
    );
  },

  'Case 15: a topping is added to a pizza or a half and taken off again': () => {
    const start = newSheet({ pizzaId: 'island', sizeId: 'large' });
    const added = tap(start, topping(0, 'bacon'), topping(0, 'feta'));
    same(added.halves[0].added, ['bacon', 'feta'], 'two toppings added');
    same(tap(added, topping(0, 'bacon')).halves[0].added, ['feta'], 'one taken off');
    same(tap(added, topping(0, 'bacon'), topping(0, 'feta')), start, 'both off: as it started');

    const split = tap(
      newSheet({ split: true, sizeId: 'large' }),
      choose(0, 'island'),
      choose(1, 'classic'),
      topping(1, 'bacon'),
    );
    same([split.halves[0].added, split.halves[1].added], [[], ['bacon']], 'on one half only');

    const other = tap(added, { type: 'ingredient', half: 0, name: 'Ham' }, choose(0, 'garden'));
    same(
      other.halves[0],
      { pizzaId: 'garden', removed: [], extra: [], added: [] },
      'another pizza starts with nothing changed',
    );
    same(tap(added, choose(0, 'island')), added, 'the same pizza chosen again keeps everything');
  },

  'Case 16: a plain pizza with only an extra or an added topping has a recipe': () => {
    const plain = newSheet({ pizzaId: 'garden', sizeId: 'large' });
    assertEqualOrThrow(sheetLine(catalog(), plain).recipe, null, 'a plain pizza has none');
    same(toppingCharges(sheetLine(catalog(), plain).recipe), [], 'and no topping to charge');

    const extra = sheetLine(catalog(), tap(plain, olives, olives));
    same(extra.recipe, whole('garden', { extra: ['Olives'] }), 'an extra alone is a recipe');
    same(
      toppingCharges(extra.recipe),
      [{ id: 'ad-topping', quantity: 1 }],
      'charged as one topping',
    );
    same(extra.printsAs.detailLines, ['EXTRA OLIVES'], 'and printed');
    const added = sheetLine(catalog(), tap(plain, topping(0, 'bacon')));
    same(added.recipe, whole('garden', { added: ['bacon'] }), 'so is an added topping alone');
    assertEqualOrThrow(lineRecipe(whole('garden')), null, 'lineRecipe: plain is no recipe');
    assertOrThrow(lineRecipe(whole('garden', { extra: ['Olives'] })), 'lineRecipe: an extra is');
    assertOrThrow(lineRecipe(whole('garden', { added: ['bacon'] })), 'lineRecipe: a topping is');

    const halfLine = sheetLine(
      catalog(),
      tap(
        newSheet({ split: true, sizeId: 'large' }),
        choose(0, 'island'),
        choose(1, 'classic'),
        topping(0, 'bacon'),
        { type: 'ingredient', half: 1, name: 'Cheese' },
        { type: 'ingredient', half: 1, name: 'Cheese' },
      ),
    );
    same(
      toppingCharges(halfLine.recipe),
      [{ id: 'ad-topping-half', quantity: 2 }],
      'halves: two half toppings',
    );
    same(
      toppingCharges(threeLarge),
      [
        { id: 'ad-topping', quantity: 2 },
        { id: 'ad-topping-half', quantity: 3 },
      ],
      'a deal: both kinds',
    );
  },

  'Case 17: a cart line with extras and toppings loads into the sheet and saves back the same':
    () => {
      const recipe = pizza({
        whole: part('garden', { removed: ['Olives'], extra: ['Cheese'], added: ['bacon'] }),
      });
      const loaded = sheetReducer(newSheet(), {
        type: 'load',
        line: cartLine('pz-garden', recipe),
      });
      same(
        loaded.halves[0],
        { pizzaId: 'garden', removed: ['Olives'], extra: ['Cheese'], added: ['bacon'] },
        'the chips the line was saved with',
      );
      same(sheetLine(catalog(), loaded).recipe, recipe, 'saved unchanged it is the same recipe');

      const stale = sheetReducer(newSheet(), {
        type: 'load',
        line: cartLine('pz-garden', whole('garden', { added: ['mushrooms'] })),
      });
      assertEqualOrThrow(
        sheetLine(catalog(), stale).message,
        'Garden already has Mushrooms. Choose extra Mushrooms instead',
        'a topping the pizza now has is refused in words',
      );
    },

  'Case 18: the sheet quotes toppings at the add-on prices of the POS product': () => {
    const two = tap(
      newSheet({ pizzaId: 'garden', sizeId: 'large' }),
      olives,
      olives,
      topping(0, 'bacon'),
    );
    const quote = sheetQuote(catalog(), two, [gardenProduct, halfProduct], false);
    same(quote.toppings, { whole: 2.25, half: 1.13 }, 'one topping and one half topping');
    assertEqualOrThrow(quote.unit, 27.5, 'a large with two toppings: 23.00 + 2 x 2.25');

    const eachHalf = tap(
      newSheet({ split: true, sizeId: 'large' }),
      choose(0, 'island'),
      choose(1, 'classic'),
      topping(0, 'bacon'),
      topping(1, 'feta'),
    );
    assertEqualOrThrow(
      sheetQuote(catalog(), eachHalf, [gardenProduct, halfProduct], false).unit.toFixed(2),
      '25.26',
      'one on each half: 23.00 + 2 x 1.13, as the sheet shows it',
    );

    const unsold = sheetQuote(catalog(), two, undefined, false);
    same(unsold.toppings, { whole: null, half: null }, 'no price without the POS product');
    assertEqualOrThrow(unsold.unit, null, 'and so no total to promise');
    assertEqualOrThrow(
      sheetQuote(catalog(), newSheet({ pizzaId: 'garden', sizeId: 'large' }), undefined, false)
        .unit,
      23,
      'a pizza without toppings is still quoted from the menu',
    );

    const sold = { price: 21, dips: {}, toppings: { whole: 2, half: 1 } };
    assertEqualOrThrow(
      sheetQuote(catalog(), two, [gardenProduct], false, null, sold).unit,
      25,
      'a sold line is quoted at what its toppings were sold for: 21.00 + 2 x 2.00',
    );
    same(
      toppingPrices({ addon_groups: [] }, undefined),
      { whole: null, half: null },
      'a product without the add-ons has no topping price',
    );
  },

  'Case 19: a line carries the topping add-ons its recipe derives, at the POS prices': () => {
    const onSale = gardenProduct.addon_groups.flatMap((group: any) => group.addons);
    const ranch = { ...onSale[0], quantity: 2 };
    const recipe = whole('garden', { extra: ['Cheese'], added: ['bacon'] });
    same(
      chargedAddons([ranch], recipe, onSale).map((addon: any) => [
        addon.id,
        addon.price,
        addon.quantity,
      ]),
      [
        ['ad-dips-ranch', 1.25, 2],
        ['ad-topping', 2.25, 2],
      ],
      'the dips stay and two toppings are added',
    );
    const stale = [ranch, { ...onSale[1], quantity: 5 }, { ...onSale[2], quantity: 1 }];
    same(
      chargedAddons(stale, whole('garden', { extra: ['Cheese'] }), onSale).map((addon: any) => [
        addon.id,
        addon.quantity,
      ]),
      [
        ['ad-dips-ranch', 2],
        ['ad-topping', 1],
      ],
      'whatever topping add-ons the line had are replaced',
    );
    same(
      chargedAddons(stale, null, onSale).map((addon: any) => addon.id),
      ['ad-dips-ranch'],
      'a plain pizza carries none',
    );
    assertEqualOrThrow(
      chargedAddons([], recipe, [onSale[0]]),
      null,
      'null when the POS does not sell the add-on, so nothing is added uncharged',
    );
    same(
      sheetAddons(stale, [{ ...onSale[1], quantity: 1 }]).map((addon: any) => [
        addon.id,
        addon.quantity,
      ]),
      [['ad-topping', 1]],
      'the sheet replaces the dips and the toppings of the line it saves',
    );
    same(
      handPickedGroups(gardenProduct.addon_groups).map((group: any) => group.id),
      ['ag-dips'],
      "upstream's add-on window is not offered the toppings group",
    );
  },

  'Case 20: a deal pizza takes extras and toppings, and the deal is quoted with them': () => {
    const deal = catalog().deals.find((entry: any) => entry.id === 'three-large-wings');
    const opened = newDeal(deal, threeLarge);
    same(
      opened.pizzas[0].halves[0],
      { pizzaId: 'garden', removed: [], extra: ['Cheese', 'Onions'], added: [] },
      'a stored deal loads its extras',
    );
    same(dealLine(catalog(), opened).recipe, threeLarge, 'and saves back the same recipe');

    let state = newDeal(deal);
    for (const [index, pizzaId] of ['garden', 'island', 'classic'].entries())
      state = dealReducer(state, { type: 'pizza', index, action: choose(0, pizzaId) });
    state = dealReducer(state, { type: 'pizza', index: 0, action: olives });
    state = dealReducer(state, { type: 'pizza', index: 0, action: olives });
    state = dealReducer(state, { type: 'pizza', index: 1, action: topping(0, 'bacon') });
    state = dealReducer(state, { type: 'wings', flavourId: 'hot' });
    const line = dealLine(catalog(), state);
    same(line.tabs[0].lines, ['1) LARGE GARDEN', '   EXTRA OLIVES'], 'the tab prints the extra');
    assertEqualOrThrow(line.tabs[0].summary, 'Garden · EXTRA OLIVES', 'and its summary says it');
    assertEqualOrThrow(line.tabs[1].summary, 'Island · ADD BACON', 'an added topping too');
    same(
      toppingCharges(line.recipe),
      [{ id: 'ad-topping', quantity: 2 }],
      'two toppings to charge',
    );

    const quote = dealQuote(deal, dealProduct, null, state);
    same(
      [quote.price, quote.toppings, quote.unit],
      [71.25, { whole: 2.25, half: 1.13 }, 75.75],
      'the deal price plus 2 x 2.25',
    );
    assertEqualOrThrow(dealQuote(deal, dealProduct).unit, 71.25, 'a deal with none is its price');
    assertEqualOrThrow(
      dealQuote(deal, { price: 71.25 }, null, state).unit,
      null,
      'no total while the topping price is not known',
    );
  },

  'Case 21: a sent line saved from the sheet or the configurator carries the add-ons of its recipe':
    () => {
      const sold = {
        id: 41,
        product_id: 'pz-garden',
        variant_id: 'pz-garden-large',
        quantity: 1,
        unit_price: 23,
        edit_version: 3,
        addons: [
          { id: 'ad-dips-ranch', name: 'Ranch', price: 1.25, quantity: 1 },
          { id: 'ad-topping', name: 'Topping', price: 2, quantity: 1 },
        ],
        modifier_selection: whole('garden', { extra: ['Cheese'] }),
      };
      same(soldPrices(sold).toppings, { whole: 2, half: null }, 'what its topping was sold for');
      const was = sentLine(sold);
      const opened = sheetReducer(newSheet(), { type: 'load', line: sheetSource(was) });
      same(opened.halves[0].extra, ['Cheese'], 'the sheet opens on the extra');

      const save = (state: any) => sheetSentLine(was, sheetLine(catalog(), state), state);
      same(sentLineEdit(sold, save(opened)), null, 'saved unchanged, nothing is sent');
      const noOlives = save(tap(opened, olives));
      assertOrThrow(!sentLineReprices(was, noOlives), 'a removal beside it keeps the sold prices');
      same(
        sentLineEdit(sold, noOlives).replacement.addons.map((addon: any) => [
          addon.id,
          addon.quantity,
        ]),
        // The sold rows go back as they were sold, in the order they were sold.
        [
          ['ad-topping', 1],
          ['ad-dips-ranch', 1],
        ],
        'and the same add-ons',
      );
      const withBacon = save(tap(opened, topping(0, 'bacon')));
      assertOrThrow(sentLineReprices(was, withBacon), 'another topping prices the line again');
      const edit = sentLineEdit(sold, withBacon);
      same(
        edit.replacement.addons.map((addon: any) => [addon.id, addon.quantity]),
        [
          ['ad-dips-ranch', 1],
          ['ad-topping', 2],
        ],
        'with two toppings charged',
      );
      same(
        edit.replacement.modifier_selection,
        whole('garden', { extra: ['Cheese'], added: ['bacon'] }),
        'for the recipe that has two',
      );
      const plain = save(tap(opened, { type: 'ingredient', half: 0, name: 'Cheese' }));
      same(
        sentLineEdit(sold, plain).replacement.addons.map((addon: any) => addon.id),
        ['ad-dips-ranch'],
        'made plain, the topping add-on goes',
      );

      const soldDeal = {
        id: 42,
        product_id: 'dl-three-large-wings',
        quantity: 1,
        unit_price: 71.25,
        edit_version: 1,
        addons: [],
        modifier_selection: {
          ...threeLarge,
          pizzas: [whole('garden'), whole('island'), whole('classic')],
        },
      };
      const changed = dealSentLine(sentLine(soldDeal), threeLarge);
      same(
        changed.addons.map((addon: any) => [addon.id, addon.quantity]),
        [
          ['ad-topping', 2],
          ['ad-topping-half', 3],
        ],
        'a deal saved with toppings on its pizzas carries both add-ons',
      );
      assertOrThrow(sentLineReprices(sentLine(soldDeal), changed), 'which prices it again');
    },

  'Case 22: a quick button keeps the topping add-ons with the recipe': () => {
    const onSale = gardenProduct.addon_groups.flatMap((group: any) => group.addons);
    const recipe = whole('garden', { extra: ['Cheese'], added: ['bacon'] });
    const line = {
      product: gardenProduct,
      variant: gardenProduct.variants[0],
      addons: chargedAddons([], recipe, onSale),
      special_instructions: '',
      recipe,
    };
    const contents = buttonContents(line);
    same(contents.addons, [{ id: 'ad-topping', quantity: 2 }], 'the button stores the add-ons');
    same(contents.recipe, recipe, 'beside the recipe');
    const tapped = buttonLine({ ...contents, usable: true, note: null }, [gardenProduct]);
    same(
      tapped.addons.map((addon: any) => [addon.id, addon.price, addon.quantity]),
      [['ad-topping', 2.25, 2]],
      'a tap adds them at the price of the day',
    );
    assertEqualOrThrow(buttonPrice(tapped), 27.5, 'so the tile shows 23.00 + 2 x 2.25');
  },

  'Case 23: what the menu no longer has can be taken off, and the line can then be saved': () => {
    // A cart line made before a menu load that dropped the topping and one of the ingredients.
    const stale = sheetReducer(newSheet(), {
      type: 'load',
      line: cartLine(
        'pz-garden',
        pizza({
          whole: {
            pizzaId: 'garden',
            removed: ['Capers'],
            extra: ['Olives', 'Pesto'],
            added: ['bacon', 'gold-leaf'],
          },
        }),
      ),
    });
    same(
      stale.halves[0],
      {
        pizzaId: 'garden',
        removed: ['Capers'],
        extra: ['Olives', 'Pesto'],
        added: ['bacon', 'gold-leaf'],
      },
      'the sheet holds everything the line has, on the menu or not',
    );
    assertOrThrow(!sheetLine(catalog(), stale).canAdd, 'and it cannot be saved as it stands');
    // One tap on each stale chip: an ingredient the pizza lost goes straight back to nothing.
    const cleared = tap(
      stale,
      { type: 'ingredient', half: 0, name: 'Capers', extras: false },
      { type: 'ingredient', half: 0, name: 'Pesto', extras: false },
      { type: 'topping', half: 0, toppingId: 'gold-leaf' },
    );
    same(
      cleared.halves[0],
      { pizzaId: 'garden', removed: [], extra: ['Olives'], added: ['bacon'] },
      'what the menu still has stays',
    );
    const line = sheetLine(catalog(), cleared);
    assertOrThrow(line.canAdd, `and the line can be saved (${line.message})`);

    // A menu that dropped its toppings altogether: the extra and the topping both come off.
    const without = structuredClone(sample);
    delete without.toppings;
    const menu = parseMenuFile(without);
    const held = sheetReducer(newSheet(), {
      type: 'load',
      line: cartLine('pz-garden', whole('garden', { extra: ['Olives'], added: ['bacon'] })),
    });
    assertOrThrow(!sheetLine(menu, held).canAdd, 'without toppings on the menu it is refused');
    const plain = tap(held, { ...olives, extras: false }, topping(0, 'bacon'));
    assertEqualOrThrow(sheetLine(menu, plain).recipe, null, 'with both off it is a plain pizza');
    assertOrThrow(sheetLine(menu, plain).canAdd, 'that can be saved');
  },

  'Case 24: the kitchen is not shown the charge: topping add-ons are left off its lists': () => {
    const ranch = { id: 'ad-dips-ranch', name: 'Ranch', price: 1.25, quantity: 2 };
    const charges = [
      { id: 'ad-topping', name: 'Topping', price: 2.25, quantity: 2 },
      { id: 'ad-topping-half', name: 'Half topping', price: 1.13, quantity: 1 },
    ];
    same(kitchenAddons([ranch, ...charges]), [ranch], 'the dip stays, the two charges go');
    same(kitchenAddons(JSON.stringify([ranch, ...charges])), [ranch], 'also from stored text');
    same(kitchenAddons([{ name: 'Topping' }]), [{ name: 'Topping' }], 'only the ids decide');
    for (const other of [null, undefined, 'not json', 7])
      assertEqualOrThrow(kitchenAddons(other), other, `${String(other)} is handed back`);

    const frontend = loadFrontend();
    require('../frontend/src/lib/pizza/catalog');
    const recipe = whole('garden', { extra: ['Cheese'], added: ['bacon'] });
    const order = (addons: unknown) => ({
      id: 1,
      order_number: 'P-1',
      created_at: '2026-01-01T12:00:00.000Z',
      type: 'takeaway',
      items: [
        {
          id: 1,
          order_id: 1,
          product_id: 'pz-garden',
          product_name: 'Garden',
          unit_price: 23,
          quantity: 3,
          subtotal: 86.25,
          tax_amount: 0,
          total: 86.25,
          addons,
          detailLines: ticketLines(catalog(), recipe, 42).detailLines,
          modifier_selection: recipe,
          special_instructions: null,
          status: 'pending',
        },
      ],
    });
    const options = { stationName: 'Kitchen', language: 'en', timezone: 'UTC' };
    const kitchen: Record<string, (addons: unknown) => string> = {
      'browser ESC/POS': (addons) =>
        rows(
          frontend.kotEncoder.buildKotBytes(
            order(addons),
            { ...options, columns: 42, paperWidth: 80 },
            [],
          ),
        ).join('\n'),
      'raster document': (addons) =>
        JSON.stringify(
          frontend.printDocument.buildFrontendKotDocument(order(addons), {
            ...options,
            columns: 42,
          }),
        ),
      'browser HTML': (addons) =>
        frontend.kotWebPrint.generateKotHtml(order(addons), { ...options, paperWidth: 80 }),
    };
    for (const [path, print] of Object.entries(kitchen)) {
      for (const addons of [[ranch, ...charges], JSON.stringify([ranch, ...charges])]) {
        const stored = typeof addons === 'string' ? ', add-ons stored as text' : '';
        const printed = print(addons);
        // Upstream's HTML ticket lists add-ons only from a list, so text prints none there.
        const expected =
          stored && path === 'browser HTML'
            ? ['EXTRA CHEESE', 'ADD BACON']
            : ['EXTRA CHEESE', 'ADD BACON', 'Ranch'];
        for (const line of expected)
          assertOrThrow(printed.includes(line), `kitchen ticket, ${path}${stored}: prints ${line}`);
        assertOrThrow(
          !/topping/i.test(printed),
          `kitchen ticket, ${path}${stored}: prints no topping charge line`,
        );
      }
      assertOrThrow(
        /Topping/.test(print([{ id: 'ad-hand-made', name: 'Topping sauce', quantity: 1 }])),
        `kitchen ticket, ${path}: an add-on of another id prints as before, whatever its name`,
      );
    }
    const bill = {
      id: 1,
      bill_number: 'B-1',
      subtotal: 86.25,
      discount_amount: 0,
      tax_amount: 0,
      total: 86.25,
      payment_details: [{ method: 'cash', amount: 86.25 }],
      order: order([ranch, ...charges]),
    };
    const tenant = { business_name: 'Pizza Test', country: 'US', currency: 'USD', timezone: 'UTC' };
    const receiptOptions = { columns: 42, paperWidth: 80, languages: ['en'] };
    for (const [name, build] of [
      ['classic', frontend.receiptEncoder.buildClassicReceiptBytes],
      ['compact', frontend.receiptEncoder.buildCompactReceiptBytes],
    ] as const) {
      const printed = rows(build(bill, tenant, receiptOptions, [])).join('\n');
      assertOrThrow(/Topping/.test(printed), `receipt, browser ${name}: keeps the Topping charge`);
      assertOrThrow(/Half topping/.test(printed), `receipt, browser ${name}: and the Half topping`);
    }
  },

  "Case 25: the Orders page's replace window keeps the toppings a sent pizza is charged for":
    () => {
      const sold = {
        product_id: 'pz-garden',
        addons: [
          { id: 'ad-dips-ranch', name: 'Ranch', price: 1.25, quantity: 1 },
          { id: 'ad-topping', name: 'Topping', price: 2.25, quantity: 2 },
        ],
      };
      const garlic = { id: 'ad-dips-garlic', name: 'Garlic', price: 1.25, quantity: 1 };
      same(
        keptToppingAddons(sold, 'pz-garden', [garlic]).map((addon: any) => [
          addon.id,
          addon.quantity,
        ]),
        [
          ['ad-dips-garlic', 1],
          ['ad-topping', 2],
        ],
        'the same pizza keeps its topping add-ons beside what the window chose',
      );
      same(
        keptToppingAddons(sold, 'pz-garden', [garlic, sold.addons[1]]).length,
        2,
        'one it already carries is not added twice',
      );
      same(keptToppingAddons(sold, 'pz-island', [garlic]), [garlic], 'another product takes none');
      same(
        keptToppingAddons({ product_id: 'pz-garden' }, 'pz-garden', []),
        [],
        'nor a line with none',
      );
    },
});
