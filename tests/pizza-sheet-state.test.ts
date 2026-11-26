/**
 * The pizza sheet's state: every action, what the sheet derives from its state
 * and the catalogue, and when Add is refused.
 *
 * Run: npm run test:pizza-sheet-state
 */
const { assertOrThrow, assertEqualOrThrow, runCases } = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');
const { parseMenuFile } = require('../shared/pizza/menu');
const { recipeKey, validateRecipe } = require('../shared/pizza/recipe');
const { ticketLines } = require('../shared/pizza/ticket');
const sample = require('./fixtures/pizza-sample-menu.json');
const {
  newSheet,
  sheetReducer,
  sheetLine,
  sheetQuote,
} = require('../frontend/src/lib/pizza/sheet-state');

const catalog = parseMenuFile(sample);
const json = (value: unknown) => JSON.stringify(value);

/** Applies actions in order, as taps on the sheet would. */
const after = (state: object, ...actions: object[]) =>
  actions.reduce((current, action) => sheetReducer(current, action), state);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${json(actual)})`);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const EMPTY = {
  sizeId: null,
  split: false,
  halves: [
    { pizzaId: null, removed: [] },
    { pizzaId: null, removed: [] },
  ],
  cook: null,
  cut: null,
  dips: {},
  note: '',
  quantity: 1,
};
const largeGarden = () => newSheet({ pizzaId: 'garden', sizeId: 'large' });
const largeHalves = () =>
  after(
    newSheet({ split: true, sizeId: 'large' }),
    { type: 'pizza', half: 0, pizzaId: 'garden' },
    { type: 'ingredient', half: 0, name: 'Olives' },
    { type: 'pizza', half: 1, pizzaId: 'classic' },
  );

/** A cart line as the POS holds it: the product, its size variant and its dips. */
const cartLine = (productId: string, variantId: string, more: object = {}) => ({
  id: 'line-1',
  product: { id: productId, name: productId, price: 0 },
  variant: { id: variantId, product_id: productId, name: variantId, price: 23 },
  quantity: 1,
  addons: [],
  special_instructions: '',
  ...more,
});
const dipAddon = (id: string, quantity: number) => ({
  id: `ad-dips-${id}`,
  addon_group_id: 'ag-dips',
  name: id,
  price: 1.25,
  quantity,
});

const REFUSED = { recipe: null, productId: null, variantId: null, printsAs: null, canAdd: false };
function refused(state: object, message: string, label: string) {
  const line = sheetLine(catalog, state);
  assertEqualOrThrow(line.canAdd, false, `${label}: Add is off`);
  assertEqualOrThrow(line.message, message, `${label}: the message`);
  for (const [key, value] of Object.entries(REFUSED)) {
    assertEqualOrThrow(line[key], value, `${label}: ${key}`);
  }
}

runCases('pizza-sheet-state', {
  'Case 1: the sheet opens empty, on a pizza, on a size, or as a half and half': () => {
    same(newSheet(), EMPTY, 'an empty sheet');
    same(
      newSheet({ pizzaId: 'garden' }),
      { ...EMPTY, halves: [{ pizzaId: 'garden', removed: [] }, EMPTY.halves[1]] },
      'Customize on a tile: the pizza, no size yet',
    );
    same(
      largeGarden(),
      { ...EMPTY, sizeId: 'large', halves: [{ pizzaId: 'garden', removed: [] }, EMPTY.halves[1]] },
      'a size button on a tile: the pizza and the size',
    );
    same(
      newSheet({ split: true, sizeId: 'large' }),
      { ...EMPTY, sizeId: 'large', split: true },
      'a size button on the half and half tile',
    );
  },

  'Case 2: a size button on a tile adds a plain pizza without the sheet': () => {
    const line = sheetLine(catalog, largeGarden());
    same(
      line,
      {
        recipe: null,
        productId: 'pz-garden',
        variantId: 'pz-garden-large',
        dips: [],
        unitPriceCents: 2300,
        printsAs: { heading: 'LARGE GARDEN', detailLines: [] },
        canAdd: true,
        message: null,
      },
      'a plain large Garden',
    );
    assertEqualOrThrow(
      sheetLine(catalog, newSheet({ pizzaId: 'plain', sizeId: 'small' })).unitPriceCents,
      1500,
      'every pizza costs its size price',
    );
  },

  'Case 3: every action changes its part of the state': () => {
    const start = newSheet();
    same(after(start, { type: 'size', sizeId: 'medium' }), { ...EMPTY, sizeId: 'medium' }, 'size');
    same(after(start, { type: 'split', split: true }), { ...EMPTY, split: true }, 'half and half');
    same(
      after(start, { type: 'split', split: true }, { type: 'split', split: false }),
      EMPTY,
      'back to a whole pizza',
    );

    const island = after(start, { type: 'pizza', half: 0, pizzaId: 'island' });
    same(island.halves, [{ pizzaId: 'island', removed: [] }, EMPTY.halves[1]], 'the first pizza');
    same(
      after(start, { type: 'pizza', half: 1, pizzaId: 'classic' }).halves,
      [EMPTY.halves[0], { pizzaId: 'classic', removed: [] }],
      'the second half',
    );

    const noHam = after(island, { type: 'ingredient', half: 0, name: 'Ham' });
    same(noHam.halves[0].removed, ['Ham'], 'a tap removes an ingredient');
    same(
      after(noHam, { type: 'ingredient', half: 0, name: 'Pineapple' }).halves[0].removed,
      ['Ham', 'Pineapple'],
      'a second ingredient',
    );
    same(
      after(noHam, { type: 'ingredient', half: 0, name: 'Ham' }).halves[0].removed,
      [],
      'a second tap puts the ingredient back',
    );
    same(
      after(noHam, { type: 'ingredient', half: 1, name: 'Ham' }).halves[0].removed,
      ['Ham'],
      'a tap on the other half leaves this half alone',
    );
    same(
      after(noHam, { type: 'pizza', half: 0, pizzaId: 'island' }).halves[0].removed,
      ['Ham'],
      'picking the same pizza again keeps its removals',
    );
    same(
      after(noHam, { type: 'pizza', half: 0, pizzaId: 'garden' }).halves[0],
      { pizzaId: 'garden', removed: [] },
      'picking another pizza drops the removals of the old one',
    );

    assertEqualOrThrow(after(start, { type: 'cook', cook: 'well-done' }).cook, 'well-done', 'cook');
    assertEqualOrThrow(
      after(start, { type: 'cook', cook: 'light-bake' }, { type: 'cook', cook: null }).cook,
      null,
      'cook back to normal',
    );
    assertEqualOrThrow(after(start, { type: 'cut', cut: 'uncut' }).cut, 'uncut', 'cut');
    assertEqualOrThrow(
      after(start, { type: 'cut', cut: 'square-cut' }, { type: 'cut', cut: null }).cut,
      null,
      'cut back to normal',
    );

    const dips = after(
      start,
      { type: 'dip', dipId: 'garlic', count: 1 },
      { type: 'dip', dipId: 'ranch', count: 2 },
    );
    same(dips.dips, { garlic: 1, ranch: 2 }, 'dip counts');
    same(after(dips, { type: 'dip', dipId: 'garlic', count: 0 }).dips, { ranch: 2 }, 'no dip');
    same(
      after(dips, { type: 'dip', dipId: 'ranch', count: -1 }).dips,
      { garlic: 1 },
      'a count never goes below zero',
    );

    assertEqualOrThrow(after(start, { type: 'note', note: 'no box' }).note, 'no box', 'note');
    assertEqualOrThrow(after(start, { type: 'quantity', quantity: 3 }).quantity, 3, 'quantity');
    assertEqualOrThrow(
      after(start, { type: 'quantity', quantity: 0 }).quantity,
      1,
      'quantity never goes below one',
    );
  },

  'Case 4: a whole pizza with removals': () => {
    const state = after(
      largeGarden(),
      { type: 'ingredient', half: 0, name: 'Onions' },
      { type: 'ingredient', half: 0, name: 'Olives' },
      { type: 'cook', cook: 'well-done' },
      { type: 'cut', cut: 'square-cut' },
    );
    const recipe = {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      whole: { pizzaId: 'garden', removed: ['Olives', 'Onions'] },
      cook: 'well-done',
      cut: 'square-cut',
    };
    const line = sheetLine(catalog, state);
    same(line.recipe, recipe, 'the recipe, removals sorted whatever order they were tapped in');
    assertEqualOrThrow(line.productId, 'pz-garden', 'the product');
    assertEqualOrThrow(line.variantId, 'pz-garden-large', 'the size variant');
    same(line.dips, [], 'no dips');
    assertEqualOrThrow(line.unitPriceCents, 2300, 'removals do not change the price');
    same(
      line.printsAs,
      {
        heading: 'LARGE GARDEN',
        detailLines: ['NO OLIVES, NO ONIONS', 'WELL DONE, SQUARE CUT'],
      },
      'prints as',
    );
    for (const columns of [42, 48]) {
      same(
        sheetLine(catalog, state, columns).printsAs,
        ticketLines(catalog, recipe, columns),
        `prints as, at ${columns} columns`,
      );
    }
    assertOrThrow(line.canAdd && line.message === null, 'Add is on');
    same(
      sheetLine(catalog, after(largeGarden(), { type: 'cut', cut: 'uncut' })).recipe,
      {
        kind: 'pizza',
        v: 1,
        sizeId: 'large',
        whole: { pizzaId: 'garden', removed: [] },
        cut: 'uncut',
      },
      'a cook or cut note alone makes a recipe',
    );
  },

  'Case 5: a half and half with removals on one half': () => {
    const recipe = {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      halves: [
        { pizzaId: 'garden', removed: ['Olives'] },
        { pizzaId: 'classic', removed: [] },
      ],
    };
    const line = sheetLine(catalog, largeHalves());
    same(line.recipe, recipe, 'the recipe, first half first');
    assertEqualOrThrow(line.productId, 'pz-half-and-half', 'the half-and-half product');
    assertEqualOrThrow(line.variantId, 'pz-half-and-half-large', 'its size variant');
    assertEqualOrThrow(line.unitPriceCents, 2300, 'a half and half costs the size price');
    same(
      line.printsAs,
      {
        heading: 'LARGE HALF & HALF',
        detailLines: ['1ST: GARDEN', '  NO OLIVES', '2ND: CLASSIC PEPPERONI'],
      },
      'prints as',
    );
    assertOrThrow(line.canAdd && line.message === null, 'Add is on');

    const whole = sheetLine(catalog, after(largeHalves(), { type: 'split', split: false }));
    same(
      whole.recipe,
      { kind: 'pizza', v: 1, sizeId: 'large', whole: { pizzaId: 'garden', removed: ['Olives'] } },
      'switching to a whole pizza keeps the first half as the pizza',
    );
    assertEqualOrThrow(whole.productId, 'pz-garden', 'and takes that pizza as the product');
    same(
      sheetLine(
        catalog,
        after(largeHalves(), { type: 'split', split: false }, { type: 'split', split: true }),
      ).recipe,
      recipe,
      'switching back brings the second half back',
    );
  },

  'Case 6: dips are add-ons with a price, not part of the recipe': () => {
    const state = after(
      largeGarden(),
      { type: 'dip', dipId: 'garlic', count: 1 },
      { type: 'dip', dipId: 'ranch', count: 2 },
      { type: 'dip', dipId: 'not-on-the-menu', count: 4 },
    );
    const line = sheetLine(catalog, state);
    same(
      line.dips,
      [
        { addonId: 'ad-dips-ranch', name: 'Ranch', priceCents: 125, quantity: 2 },
        { addonId: 'ad-dips-garlic', name: 'Garlic', priceCents: 125, quantity: 1 },
      ],
      'the dips, in menu order, without one the menu does not have',
    );
    assertEqualOrThrow(line.unitPriceCents, 2300 + 3 * 125, 'the size price plus the dips');
    assertEqualOrThrow(line.recipe, null, 'a pizza with dips and nothing else is still plain');
    assertEqualOrThrow(
      sheetLine(catalog, after(largeHalves(), { type: 'dip', dipId: 'garlic', count: 1 }))
        .unitPriceCents,
      2300 + 125,
      'a half and half with a dip',
    );
    same(
      sheetLine(catalog, after(state, { type: 'quantity', quantity: 3 })).unitPriceCents,
      2300 + 3 * 125,
      'the unit price is for one, whatever the quantity',
    );
  },

  'Case 7: Add is refused with a message the cashier can act on': () => {
    refused(newSheet({ pizzaId: 'garden' }), 'Pick a size', 'no size yet');
    assertEqualOrThrow(
      sheetLine(catalog, newSheet({ pizzaId: 'garden' })).unitPriceCents,
      null,
      'no size yet: no price',
    );
    refused(newSheet({ sizeId: 'large' }), 'Pick a pizza', 'no pizza yet');

    const split = newSheet({ split: true, sizeId: 'large' });
    const second = after(split, { type: 'pizza', half: 1, pizzaId: 'classic' });
    const first = after(split, { type: 'pizza', half: 0, pizzaId: 'garden' });
    refused(split, 'Pick the first half', 'no half yet');
    refused(second, 'Pick the first half', 'only the second half');
    refused(first, 'Pick the second half', 'only the first half');
    assertEqualOrThrow(
      sheetLine(catalog, first).unitPriceCents,
      2300,
      'the price shows while a half is still missing',
    );

    let coreMessage = '';
    try {
      const half = { pizzaId: 'garden', removed: [] };
      validateRecipe(catalog, { kind: 'pizza', v: 1, sizeId: 'large', halves: [half, half] });
    } catch (error) {
      coreMessage = (error as Error).message;
    }
    assertOrThrow(coreMessage.length > 0, 'the core rejects identical halves');
    const twins = after(first, { type: 'pizza', half: 1, pizzaId: 'garden' });
    refused(twins, coreMessage, 'identical halves');
    const differ = after(twins, { type: 'ingredient', half: 1, name: 'Olives' });
    assertOrThrow(
      sheetLine(catalog, differ).canAdd,
      'the same pizza on both halves is allowed once the removals differ',
    );
    refused(
      after(differ, { type: 'ingredient', half: 0, name: 'Olives' }),
      coreMessage,
      'identical halves with identical removals',
    );
  },

  'Case 8: a cart line loads into the sheet and saves back as the same recipe': () => {
    const wholeRecipe = {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      whole: { pizzaId: 'garden', removed: ['Onions', 'Olives'] },
      cook: 'light-bake',
      cut: 'uncut',
    };
    const halvesRecipe = {
      kind: 'pizza',
      v: 1,
      sizeId: 'medium',
      halves: [
        { pizzaId: 'island', removed: ['Pineapple'] },
        { pizzaId: 'island', removed: [] },
      ],
      cut: 'square-cut',
    };
    const lines = [
      cartLine('pz-garden', 'pz-garden-large', {
        recipe: wholeRecipe,
        quantity: 2,
        special_instructions: 'no box',
        addons: [dipAddon('garlic', 2), dipAddon('ranch', 1)],
      }),
      cartLine('pz-half-and-half', 'pz-half-and-half-medium', { recipe: halvesRecipe }),
    ];
    for (const line of lines) {
      const state = after(largeHalves(), { type: 'load', line });
      const saved = sheetLine(catalog, state);
      assertEqualOrThrow(
        recipeKey(saved.recipe),
        recipeKey(line.recipe),
        `${line.product.id}: the same recipe`,
      );
      assertEqualOrThrow(saved.productId, line.product.id, `${line.product.id}: the same product`);
      assertEqualOrThrow(saved.variantId, line.variant.id, `${line.product.id}: the same variant`);
      same(
        saved.dips.map((dip: any) => [dip.addonId, dip.quantity]).sort(),
        line.addons.map((addon: any) => [addon.id, addon.quantity]).sort(),
        `${line.product.id}: the same dips`,
      );
      assertEqualOrThrow(state.note, line.special_instructions, `${line.product.id}: the note`);
      assertEqualOrThrow(state.quantity, line.quantity, `${line.product.id}: the quantity`);
    }

    const plain = cartLine('pz-classic', 'pz-classic-medium', { addons: [dipAddon('ranch', 1)] });
    const state = after(newSheet(), { type: 'load', line: plain });
    same(
      state,
      {
        ...EMPTY,
        sizeId: 'medium',
        halves: [{ pizzaId: 'classic', removed: [] }, EMPTY.halves[1]],
        dips: { ranch: 1 },
      },
      'a plain pizza line, which has no recipe, loads from its product and variant',
    );
    const saved = sheetLine(catalog, state);
    assertEqualOrThrow(saved.recipe, null, 'and saves back without a recipe');
    assertEqualOrThrow(saved.productId, 'pz-classic', 'as the same product');
    assertEqualOrThrow(saved.variantId, 'pz-classic-medium', 'and the same variant');

    const deal = cartLine('dl-party', null as any, {
      variant: null,
      recipe: { kind: 'deal', v: 1, dealId: 'party', pizzas: [] },
    });
    same(
      after(largeHalves(), { type: 'load', line: deal }),
      largeHalves(),
      'a deal line is not a pizza and leaves the sheet as it was',
    );
    for (const [productId, variantId] of [
      ['sd-wings', null],
      ['dr-cola', 'dr-cola-can'],
      ['dl-party', null],
    ]) {
      const other = cartLine(productId as string, variantId as any, {
        variant: variantId ? { id: variantId, product_id: productId, name: 'x', price: 2 } : null,
      });
      same(
        after(largeHalves(), { type: 'load', line: other }),
        largeHalves(),
        `${productId} is not a pizza and leaves the sheet as it was`,
      );
    }
  },

  'Case 9: the reducer never changes the state or the action it is given': () => {
    const line = cartLine('pz-garden', 'pz-garden-large', {
      recipe: {
        kind: 'pizza',
        v: 1,
        sizeId: 'large',
        whole: { pizzaId: 'garden', removed: ['Olives'] },
      },
      addons: [dipAddon('garlic', 1)],
    });
    const actions = [
      { type: 'size', sizeId: 'small' },
      { type: 'split', split: false },
      { type: 'pizza', half: 0, pizzaId: 'island' },
      { type: 'pizza', half: 1, pizzaId: 'island' },
      { type: 'ingredient', half: 0, name: 'Olives' },
      { type: 'ingredient', half: 0, name: 'Onions' },
      { type: 'cook', cook: 'well-done' },
      { type: 'cut', cut: 'uncut' },
      { type: 'dip', dipId: 'ranch', count: 2 },
      { type: 'dip', dipId: 'garlic', count: 0 },
      { type: 'note', note: 'no box' },
      { type: 'quantity', quantity: 4 },
      { type: 'load', line },
    ];
    const state = deepFreeze(
      after(
        largeHalves(),
        { type: 'ingredient', half: 0, name: 'Mushrooms' },
        { type: 'dip', dipId: 'garlic', count: 1 },
        { type: 'note', note: 'ring the bell' },
      ),
    );
    const before = json(state);
    for (const action of actions) {
      const frozen = deepFreeze(structuredClone(action));
      const next = sheetReducer(state, frozen);
      assertEqualOrThrow(json(state), before, `${action.type}: the state is as it was`);
      assertEqualOrThrow(json(frozen), json(action), `${action.type}: the action is as it was`);
      assertOrThrow(next !== state, `${action.type}: a new state comes back`);
      assertOrThrow(json(next) !== before, `${action.type}: and it differs`);
    }
    sheetLine(catalog, state);
    assertEqualOrThrow(json(state), before, 'deriving the line leaves the state alone');
    same(line.recipe.whole.removed, ['Olives'], 'loading a line leaves the line alone');
    same(line.addons, [dipAddon('garlic', 1)], 'and its add-ons');
  },

  'Case 10: the sheet quotes what the cart charges: the product, its size and its add-ons': () => {
    const sized = (id: string, price: number, online: number | null) =>
      catalog.sizes.map((size: { id: string }) => ({
        id: `${id}-${size.id}`,
        price: size.id === 'large' ? price : 1,
        online_price: size.id === 'large' ? online : null,
      }));
    const dips = [{ addons: [{ id: 'ad-dips-garlic', price: 1.5 }] }];
    const products = [
      { id: 'pz-garden', price: 0, variants: sized('pz-garden', 24, 30), addon_groups: dips },
      { id: 'pz-half-and-half', price: 0, variants: sized('pz-half-and-half', 26, null) },
    ];
    const withDips = after(largeGarden(), { type: 'dip', dipId: 'garlic', count: 2 });

    const menu = sheetQuote(catalog, withDips, undefined, false);
    same(menu.sizes, { small: 15, medium: 19, large: 23 }, 'with no product list: the menu sizes');
    same(menu.dips, { ranch: 1.25, garlic: 1.25 }, 'and the menu dips');
    assertEqualOrThrow(menu.unit, 23 + 2.5, 'which is what the sheet quoted before');

    const counter = sheetQuote(catalog, withDips, products, false);
    assertEqualOrThrow(counter.sizes.large, 24, 'at the counter: the price of the product size');
    assertEqualOrThrow(counter.dips.garlic, 1.5, 'and of the product dip');
    assertEqualOrThrow(
      counter.dips.ranch,
      1.25,
      'a dip the product does not offer: the menu price',
    );
    assertEqualOrThrow(counter.pizza, 24, 'the pizza line');
    assertEqualOrThrow(counter.unit, 24 + 3, 'the pizza and its dips');
    assertEqualOrThrow(counter.kept, false, 'no price is kept');

    const online = sheetQuote(catalog, withDips, products, true);
    assertEqualOrThrow(online.sizes.large, 30, 'for an online platform: the size online price');
    assertEqualOrThrow(online.sizes.small, 1, 'a size with no online price keeps its own');
    assertEqualOrThrow(online.unit, 30 + 3, 'as the cart charges it');

    const kept = sheetQuote(catalog, withDips, products, true, { price: 10 });
    assertEqualOrThrow(kept.pizza, 10, 'a line with a price set by hand keeps that price');
    assertEqualOrThrow(kept.unit, 10 + 3, 'with its dips on top, as the cart charges it');
    assertEqualOrThrow(kept.kept, true, 'and the sheet is told so');

    assertEqualOrThrow(
      sheetQuote(catalog, largeHalves(), products, true).pizza,
      26,
      'a half and half is quoted from its own product',
    );
    assertEqualOrThrow(
      sheetQuote(catalog, newSheet({ sizeId: 'large' }), products, false).pizza,
      26,
      'with no pizza chosen yet: the half-and-half product stands in',
    );
    assertEqualOrThrow(
      sheetQuote(catalog, largeGarden(), [], false).pizza,
      23,
      'a pizza the POS does not sell: the menu price',
    );
    const sold = sheetQuote(catalog, withDips, products, true, null, {
      price: 20,
      dips: { garlic: 1 },
    });
    assertEqualOrThrow(sold.pizza, 20, 'a sent line unchanged in size: the price it was sold at');
    assertEqualOrThrow(sold.dips.garlic, 1, 'and its dips at the price they were sold at');
    assertEqualOrThrow(sold.unit, 20 + 2, 'which is what saving charges');
    assertEqualOrThrow(sold.kept, false, 'with no word about a price set by hand');
    assertEqualOrThrow(sold.sizes.large, 30, 'another size still shows what choosing it charges');

    const unsized = sheetQuote(catalog, newSheet({ pizzaId: 'garden' }), products, false);
    assertEqualOrThrow(unsized.pizza, null, 'no size chosen: no pizza price');
    assertEqualOrThrow(unsized.unit, null, 'and no total');
  },
});
