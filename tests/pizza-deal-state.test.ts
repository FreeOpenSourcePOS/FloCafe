/**
 * The deal configurator's state: the tabs a deal asks for, the recipe a
 * finished deal gives, what is still missing, and a stored recipe loaded back.
 *
 * Run: npm run test:pizza-deal-state
 */
const { assertOrThrow, assertEqualOrThrow, runCases } = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');
const { parseMenuFile } = require('../shared/pizza/menu');
const { validateRecipe } = require('../shared/pizza/recipe');
const { ticketLines } = require('../shared/pizza/ticket');
const sample = require('./fixtures/pizza-sample-menu.json');
const {
  newDeal,
  dealReducer,
  dealLine,
  dealQuote,
} = require('../frontend/src/lib/pizza/deal-state');

const catalog = parseMenuFile(sample);
const json = (value: unknown) => JSON.stringify(value);
const dealOf = (id: string) => catalog.deals.find((deal: { id: string }) => deal.id === id);

/** Applies actions in order, as taps on the configurator would. */
const after = (state: object, ...actions: object[]) =>
  actions.reduce((current, action) => dealReducer(current, action), state);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${json(actual)})`);
const tabIds = (state: object) => dealLine(catalog, state).tabs.map((tab: any) => tab.id);
const missing = (state: object) =>
  dealLine(catalog, state)
    .tabs.filter((tab: any) => !tab.done)
    .map((tab: any) => tab.id);
const tabOf = (state: object, id: string) =>
  dealLine(catalog, state).tabs.find((tab: any) => tab.id === id);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** A tap on a pizza button of the whole pizza, or of one half. */
const pick = (index: number, pizzaId: string, half = 0) => ({
  type: 'pizza',
  index,
  action: { type: 'pizza', half, pizzaId },
});
const sheet = (index: number, action: object) => ({ type: 'pizza', index, action });
const large = (pizzaId: string, removed: string[] = []) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  whole: { pizzaId, removed },
});

/** Garden without olives, Island and Plain Cheese half and half, Classic Pepperoni, sweet chili wings. */
const THREE_LARGE = {
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [
    large('garden', ['Olives']),
    {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      halves: [
        { pizzaId: 'island', removed: [] },
        { pizzaId: 'plain', removed: [] },
      ],
    },
    large('classic'),
  ],
  wingFlavour: 'sweet-chili',
};
const threeLargeTaps = [
  pick(0, 'garden'),
  sheet(0, { type: 'ingredient', half: 0, name: 'Olives' }),
  sheet(1, { type: 'split', split: true }),
  pick(1, 'island'),
  pick(1, 'plain', 1),
  pick(2, 'classic'),
];
const sixLarge = ['garden', 'island', 'classic', 'smokehouse', 'plain', 'garden'];
const PARTY = {
  kind: 'deal',
  v: 1,
  dealId: 'party',
  pizzas: sixLarge.map((pizzaId) => large(pizzaId)),
};

runCases('pizza-deal-state', {
  'Case 1: the tabs each deal of the sample menu asks for': () => {
    const expected: Record<string, string[]> = {
      'large-combo': ['pizza-1', 'drinks'],
      'three-large-wings': ['pizza-1', 'pizza-2', 'pizza-3', 'wings'],
      party: ['pizza-1', 'pizza-2', 'pizza-3', 'pizza-4', 'pizza-5', 'pizza-6', 'drinks'],
      'pasta-night': ['drinks'],
    };
    same(catalog.deals.map((deal: any) => deal.id).sort(), Object.keys(expected).sort(), 'deals');
    for (const [dealId, tabs] of Object.entries(expected)) {
      const state = newDeal(dealOf(dealId));
      same(tabIds(state), tabs, `${dealId}: its tabs, pizzas first`);
      assertEqualOrThrow(state.tab, 0, `${dealId}: opens on the first tab`);
      same(missing(state), tabs, `${dealId}: nothing is chosen yet`);
      const line = dealLine(catalog, state);
      assertEqualOrThrow(line.recipe, null, `${dealId}: no recipe yet`);
      assertOrThrow(
        line.tabs.every((tab: any) => tab.summary === null && tab.lines.length === 0),
        `${dealId}: no tab has a summary yet`,
      );
    }
    same(
      newDeal(dealOf('party')).pizzas.map((pizza: any) => pizza.sizeId),
      Array(6).fill('large'),
      'every pizza of a deal starts at the size the deal sets',
    );
    same(
      [
        dealLine(catalog, newDeal(dealOf('large-combo'))).cans,
        dealLine(catalog, newDeal(dealOf('party'))).cans,
        dealLine(catalog, newDeal(dealOf('pasta-night'))).cans,
        dealLine(catalog, newDeal(dealOf('three-large-wings'))).cans,
      ],
      [{ asked: 2, chosen: 0 }, { asked: 4, chosen: 0 }, { asked: 3, chosen: 0 }, null],
      'the cans each deal asks for',
    );
  },

  'Case 2: a finished deal gives the hand-written recipe': () => {
    const state = after(newDeal(dealOf('three-large-wings')), ...threeLargeTaps, {
      type: 'wings',
      flavourId: 'sweet-chili',
    });
    const line = dealLine(catalog, state);
    same(line.recipe, THREE_LARGE, 'the recipe');
    same(validateRecipe(catalog, line.recipe), THREE_LARGE, 'the core accepts it unchanged');
    assertEqualOrThrow(line.message, null, 'no message');
    same(missing(state), [], 'nothing is missing');
    assertEqualOrThrow(line.heading, 'LARGE PIZZAS & WINGS', 'the heading');
    same(
      line.tabs.map((tab: any) => tab.lines),
      [
        ['1) LARGE GARDEN', '   NO OLIVES'],
        ['2) LARGE HALF & HALF', '   1ST: ISLAND', '   2ND: PLAIN CHEESE'],
        ['3) LARGE CLASSIC PEPPERONI'],
        ['WINGS: SWEET CHILI'],
      ],
      'the ticket lines of each tab',
    );
    same(
      line.includes,
      ['INCLUDES: ANY 3 LARGE PIZZAS & 12 WINGS'],
      'what comes with the deal, once, after the tabs',
    );
    for (const columns of [42, 48]) {
      same(
        [
          ...dealLine(catalog, state, columns).tabs.flatMap((tab: any) => tab.lines),
          ...dealLine(catalog, state, columns).includes,
        ],
        ticketLines(catalog, THREE_LARGE, columns).detailLines,
        `together they are the ticket's lines, at ${columns} columns`,
      );
    }
    same(
      line.tabs.map((tab: any) => tab.summary),
      ['Garden · NO OLIVES', 'Island / Plain Cheese', 'Classic Pepperoni', 'Sweet Chili'],
      'one line per tab',
    );

    const cooked = after(
      state,
      sheet(2, { type: 'cook', cook: 'well-done' }),
      sheet(2, { type: 'cut', cut: 'square-cut' }),
    );
    same(
      dealLine(catalog, cooked).recipe.pizzas[2],
      { ...large('classic'), cook: 'well-done', cut: 'square-cut' },
      'cook and cut belong to one pizza of the deal',
    );
    same(
      tabOf(cooked, 'pizza-3').lines,
      ['3) LARGE CLASSIC PEPPERONI', '   WELL DONE, SQUARE CUT'],
      'and print under it',
    );

    const combo = after(newDeal(dealOf('large-combo')), pick(0, 'plain'), {
      type: 'pop',
      drinkId: 'cola',
      count: 2,
    });
    same(
      dealLine(catalog, combo).recipe,
      { kind: 'deal', v: 1, dealId: 'large-combo', pizzas: [large('plain')], pops: { cola: 2 } },
      'a deal with one pizza and two pops',
    );
    same(tabOf(combo, 'drinks').lines, ['POP: 2 COLA'], 'the pops line');
    assertEqualOrThrow(tabOf(combo, 'drinks').summary, '2 Cola', 'the pops in one line');

    const pasta = after(
      newDeal(dealOf('pasta-night')),
      { type: 'pop', drinkId: 'lemon-lime', count: 1 },
      { type: 'pop', drinkId: 'cola', count: 2 },
    );
    same(
      dealLine(catalog, pasta).recipe,
      { kind: 'deal', v: 1, dealId: 'pasta-night', pizzas: [], pops: { cola: 2, 'lemon-lime': 1 } },
      'a deal with no pizzas',
    );
    assertEqualOrThrow(tabOf(pasta, 'drinks').summary, '2 Cola, 1 Lemon Lime', 'in menu order');
  },

  'Case 3: cans or a bottle, never both': () => {
    const pizzas = sixLarge.map((pizzaId, index) => pick(index, pizzaId));
    const cans = after(
      newDeal(dealOf('party')),
      ...pizzas,
      { type: 'pop', drinkId: 'cola', count: 2 },
      { type: 'pop', drinkId: 'ginger-ale', count: 1 },
    );
    same(dealLine(catalog, cans).cans, { asked: 4, chosen: 3 }, 'three of four cans');
    same(missing(cans), ['drinks'], 'three cans are not four');
    assertEqualOrThrow(
      dealLine(catalog, cans).message,
      'Pick 4 pops or a 2L bottle',
      'the core says what the deal asks for',
    );

    const four = after(cans, { type: 'pop', drinkId: 'lemon-lime', count: 1 });
    same(
      dealLine(catalog, four).recipe,
      { ...PARTY, pops: { cola: 2, 'ginger-ale': 1, 'lemon-lime': 1 } },
      'four cans finish the deal',
    );
    same(tabOf(four, 'drinks').lines, ['POP: 2 COLA, 1 GINGER ALE, 1 LEMON LIME'], 'the pops line');
    same(
      after(four, { type: 'pop', drinkId: 'cola', count: 0 }).pops,
      { 'ginger-ale': 1, 'lemon-lime': 1 },
      'a drink at zero is no longer held',
    );

    const bottle = after(four, { type: 'bottle', bottle: true });
    same(bottle.pops, {}, 'switching to the bottle clears the cans');
    same(missing(bottle), ['drinks'], 'and waits for a bottle');
    const ginger = after(bottle, { type: 'twoLitre', drinkId: 'ginger-ale' });
    same(dealLine(catalog, ginger).recipe, { ...PARTY, twoLitre: 'ginger-ale' }, 'a bottle');
    same(tabOf(ginger, 'drinks').lines, ['2L: GINGER ALE'], 'the bottle line');
    assertEqualOrThrow(tabOf(ginger, 'drinks').summary, '2L Ginger Ale', 'the bottle in one line');
    const back = after(ginger, { type: 'bottle', bottle: false });
    assertEqualOrThrow(back.twoLitre, null, 'switching back to cans clears the bottle');
    same(missing(back), ['drinks'], 'and waits for the cans');
  },

  'Case 4: each kind of missing choice is counted and named': () => {
    const start = newDeal(dealOf('three-large-wings'));
    const messageOf = (state: object) => dealLine(catalog, state).message;
    same(missing(start), ['pizza-1', 'pizza-2', 'pizza-3', 'wings'], 'four choices to make');
    assertEqualOrThrow(
      messageOf(start),
      'Pizza 1: Pick a pizza',
      'the first one, in the core words',
    );
    assertEqualOrThrow(tabOf(start, 'pizza-1').message, 'Pick a pizza', 'on the tab of that pizza');

    const two = after(start, pick(0, 'garden'), pick(2, 'classic'));
    same(missing(two), ['pizza-2', 'wings'], 'two pizzas chosen, in any order');
    assertEqualOrThrow(messageOf(two), 'Pizza 2: Pick a pizza', 'the next one missing');

    const halfDone = after(two, sheet(1, { type: 'split', split: true }), pick(1, 'island'));
    same(missing(halfDone), ['pizza-2', 'wings'], 'half a pizza is not a pizza');
    assertEqualOrThrow(
      tabOf(halfDone, 'pizza-2').message,
      'Pick the second half',
      'the half missing',
    );

    const pizzasDone = after(halfDone, pick(1, 'plain', 1));
    same(missing(pizzasDone), ['wings'], 'only the wing flavour is left');
    assertEqualOrThrow(messageOf(pizzasDone), 'Pick a wing flavour', 'the core asks for it');
    assertEqualOrThrow(dealLine(catalog, pizzasDone).recipe, null, 'still no recipe');

    same(missing(after(pizzasDone, { type: 'wings', flavourId: 'hot' })), [], 'all chosen');
    same(
      missing(after(pizzasDone, { type: 'wings', flavourId: 'not-on-the-menu' })),
      ['wings'],
      'a flavour the menu does not have is not a choice',
    );

    const combo = after(newDeal(dealOf('large-combo')), pick(0, 'garden'), {
      type: 'pop',
      drinkId: 'cola',
      count: 1,
    });
    same(missing(combo), ['drinks'], 'one pop of two');
    assertEqualOrThrow(messageOf(combo), 'Pick 2 pops', 'the core counts the pops');
    same(
      missing(after(combo, { type: 'pop', drinkId: 'not-on-the-menu', count: 1 })),
      ['drinks'],
      'a drink the menu does not have is not counted',
    );
  },

  'Case 5: identical halves on one pizza are refused with the message of the contract': () => {
    let coreMessage = '';
    try {
      const half = { pizzaId: 'garden', removed: [] };
      validateRecipe(catalog, { kind: 'pizza', v: 1, sizeId: 'large', halves: [half, half] });
    } catch (error) {
      coreMessage = (error as Error).message;
    }
    assertEqualOrThrow(
      coreMessage,
      'Both halves are the same. Choose a whole pizza instead',
      'the message of the contract',
    );

    const done = after(newDeal(dealOf('three-large-wings')), ...threeLargeTaps, {
      type: 'wings',
      flavourId: 'hot',
    });
    const twins = after(done, pick(1, 'island', 1));
    const line = dealLine(catalog, twins);
    assertEqualOrThrow(line.recipe, null, 'the deal is refused');
    same(missing(twins), ['pizza-2'], 'that pizza counts as missing');
    assertEqualOrThrow(tabOf(twins, 'pizza-2').message, coreMessage, 'its tab says why');
    assertEqualOrThrow(line.message, `Pizza 2: ${coreMessage}`, 'and so does the deal');

    const differ = after(twins, sheet(1, { type: 'ingredient', half: 1, name: 'Ham' }));
    assertOrThrow(
      dealLine(catalog, differ).recipe !== null,
      'the same pizza on both halves is allowed once the removals differ',
    );
  },

  'Case 6: a stored recipe loads and saves back unchanged': () => {
    const stored = [
      THREE_LARGE,
      { ...PARTY, pops: { cola: 3, 'lemon-lime': 1 } },
      { ...PARTY, twoLitre: 'cola' },
      {
        kind: 'deal',
        v: 1,
        dealId: 'large-combo',
        pizzas: [
          {
            kind: 'pizza',
            v: 1,
            sizeId: 'large',
            halves: [
              { pizzaId: 'garden', removed: ['Olives', 'Onions'] },
              { pizzaId: 'garden', removed: [] },
            ],
            cook: 'light-bake',
            cut: 'uncut',
          },
        ],
        pops: { 'ginger-ale': 2 },
      },
      { kind: 'deal', v: 1, dealId: 'pasta-night', pizzas: [], pops: { cola: 3 } },
    ];
    for (const recipe of stored) {
      const state = newDeal(dealOf(recipe.dealId), deepFreeze(recipe));
      same(dealLine(catalog, state).recipe, recipe, `${json(recipe)}: the same recipe`);
      assertEqualOrThrow(state.tab, 0, 'a loaded deal opens on its first tab');
    }
    assertEqualOrThrow(
      newDeal(dealOf('party'), stored[2]).bottle,
      true,
      'a deal stored with a bottle opens on the bottle',
    );

    const edited = after(
      newDeal(dealOf('three-large-wings'), THREE_LARGE),
      sheet(0, { type: 'ingredient', half: 0, name: 'Olives' }),
      pick(2, 'smokehouse'),
    );
    same(
      dealLine(catalog, edited).recipe,
      { ...THREE_LARGE, pizzas: [large('garden'), THREE_LARGE.pizzas[1], large('smokehouse')] },
      'an edit changes only the pizzas it touches',
    );

    const gone = newDeal(dealOf('three-large-wings'), {
      ...THREE_LARGE,
      pizzas: [large('not-on-the-menu'), ...THREE_LARGE.pizzas.slice(1)],
    });
    same(missing(gone), ['pizza-1'], 'a pizza the menu no longer has is asked for again');
    const small = newDeal(dealOf('three-large-wings'), {
      ...THREE_LARGE,
      pizzas: THREE_LARGE.pizzas.map((pizza) => ({ ...pizza, sizeId: 'small' })),
    });
    same(dealLine(catalog, small).recipe, THREE_LARGE, 'the size is the one the deal sets');
  },

  'Case 7: the reducer changes nothing it is given': () => {
    const start = deepFreeze(newDeal(dealOf('party')));
    const moved = dealReducer(start, { type: 'tab', tab: 6 });
    assertEqualOrThrow(moved.tab, 6, 'a tab is opened by its place');
    assertEqualOrThrow(start.tab, 0, 'the state it came from is as it was');
    const state = deepFreeze(
      after(
        start,
        pick(3, 'island'),
        sheet(3, { type: 'ingredient', half: 0, name: 'Ham' }),
        { type: 'pop', drinkId: 'cola', count: 4 },
        { type: 'bottle', bottle: true },
        { type: 'twoLitre', drinkId: 'cola' },
      ),
    );
    same(state.pizzas[3].halves[0], { pizzaId: 'island', removed: ['Ham'] }, 'one pizza changed');
    same(state.pizzas[2], start.pizzas[2], 'the others are the same objects');
    same(missing(state), ['pizza-1', 'pizza-2', 'pizza-3', 'pizza-5', 'pizza-6'], 'five to go');
  },

  'Case 8: the fixed price shown is the price of the product the cart charges': () => {
    const deal = dealOf('party');
    assertEqualOrThrow(dealQuote(deal, undefined).price, 118.4, 'with no product: the menu price');
    const product = { id: 'dl-party', price: 120 };
    same(dealQuote(deal, product), { price: 120, kept: false }, 'the product price');
    same(
      dealQuote(deal, product, { price: 99 }),
      { price: 99, kept: true },
      'a line with a price set by hand keeps that price',
    );
  },
});
