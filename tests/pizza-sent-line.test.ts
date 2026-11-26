/**
 * A sent order line reopened in the pizza sheet or the deal configurator: the
 * line it loads, the edit it sends, and the lines shown under it.
 *
 * Run: npm run test:pizza-sent-line
 */
const { assertOrThrow, assertEqualOrThrow, runCases } = require('./helpers/pizza-print-harness');
const { isDeepStrictEqual } = require('node:util');
const { parseMenuFile } = require('../shared/pizza/menu');
const { RECIPE_NOT_PRINTED } = require('../shared/pizza/ticket');
const sample = require('./fixtures/pizza-sample-menu.json');
const { newSheet, sheetReducer, sheetLine } = require('../frontend/src/lib/pizza/sheet-state');
const { newDeal, dealReducer, dealLine } = require('../frontend/src/lib/pizza/deal-state');
const {
  needsPizzaScreen,
  sentDetailLines,
  sentLine,
  sentLineChangeable,
  sentLineEdit,
  sentLineRepriced,
  sentLineReprices,
  sentPriceGate,
  sheetSentLine,
  soldPrices,
  sheetSource,
} = require('../frontend/src/lib/pizza/sent-line');

const catalog = parseMenuFile(sample);
const json = (value: unknown) => JSON.stringify(value);
const same = (actual: unknown, expected: unknown, message: string) =>
  assertOrThrow(isDeepStrictEqual(actual, expected), `${message} (got ${json(actual)})`);

/** An order item as the order routes answer it. */
const item = (fields: object) => ({
  id: 41,
  order_id: 7,
  quantity: 1,
  addons: [],
  special_instructions: null,
  status: 'pending',
  edit_version: 3,
  modifier_selection: null,
  ...fields,
});

const GARDEN = item({ product_id: 'pz-garden', variant_id: 'pz-garden-large' });
const HALVES = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [
    { pizzaId: 'garden', removed: ['Olives'] },
    { pizzaId: 'classic', removed: [] },
  ],
};
const HALF_AND_HALF = item({
  product_id: 'pz-half-and-half',
  variant_id: 'pz-half-and-half-large',
  quantity: 2,
  addons: [{ id: 'ad-dips-ranch', name: 'Ranch', price: 1.25, quantity: 2 }],
  special_instructions: 'Ring the bell',
  modifier_selection: HALVES,
});
const COMBO = {
  kind: 'deal',
  v: 1,
  dealId: 'large-combo',
  pizzas: [{ kind: 'pizza', v: 1, sizeId: 'large', whole: { pizzaId: 'garden', removed: [] } }],
  pops: { cola: 2 },
};
const DEAL = item({
  product_id: 'dl-large-combo',
  variant_id: null,
  quantity: 2,
  special_instructions: 'Back door',
  modifier_selection: COMBO,
});

/** The lines under a sent line, at the cart's width. */
const lines = (held: object | null, sent: object) => sentDetailLines(held, sent, 32);

/** The edit the sheet sends after these taps on a sent pizza line. */
function sheetEdit(sent: object, ...actions: object[]) {
  const was = sentLine(sent);
  const opened = sheetReducer(newSheet(), { type: 'load', line: sheetSource(was) });
  const state = actions.reduce((current, action) => sheetReducer(current, action), opened);
  const line = sheetLine(catalog, state);
  assertOrThrow(line.canAdd, `the sheet accepts the pizza (${line.message})`);
  return sentLineEdit(sent, sheetSentLine(was, line, state));
}

/** The edit the configurator sends after these taps on a sent deal line. */
function dealEdit(sent: any, ...actions: object[]) {
  const was = sentLine(sent);
  const deal = catalog.deals.find((entry: { id: string }) => `dl-${entry.id}` === was.productId);
  const state = actions.reduce(
    (current, action) => dealReducer(current, action),
    newDeal(deal, was.recipe),
  );
  const { recipe, message } = dealLine(catalog, state);
  assertOrThrow(recipe, `the configurator accepts the deal (${message})`);
  return sentLineEdit(sent, { ...was, recipe });
}

runCases('pizza-sent-line', {
  'Case 1: a plain pizza with an ingredient taken off sends its recipe': () => {
    same(
      sheetEdit(GARDEN, { type: 'ingredient', half: 0, name: 'Onions' }),
      {
        expected_edit_version: 3,
        replacement: {
          product_id: 'pz-garden',
          variant_id: 'pz-garden-large',
          quantity: 1,
          addons: [],
          modifier_selection: {
            kind: 'pizza',
            v: 1,
            sizeId: 'large',
            whole: { pizzaId: 'garden', removed: ['Onions'] },
          },
        },
      },
      'the replacement carries the new recipe, the same product and size',
    );
  },

  'Case 2: a half and half with another ingredient off keeps its dips, note and quantity': () => {
    same(
      sheetEdit(HALF_AND_HALF, { type: 'ingredient', half: 0, name: 'Onions' }),
      {
        expected_edit_version: 3,
        replacement: {
          product_id: 'pz-half-and-half',
          variant_id: 'pz-half-and-half-large',
          quantity: 2,
          addons: [{ id: 'ad-dips-ranch', name: 'Ranch', price: 1.25, quantity: 2 }],
          special_instructions: 'Ring the bell',
          modifier_selection: {
            ...HALVES,
            halves: [{ pizzaId: 'garden', removed: ['Olives', 'Onions'] }, HALVES.halves[1]],
          },
        },
      },
      'both removals are on the first half',
    );
  },

  'Case 3: a deal with one pizza changed sends the whole deal recipe': () => {
    same(
      dealEdit(DEAL, {
        type: 'pizza',
        index: 0,
        action: { type: 'pizza', half: 0, pizzaId: 'island' },
      }),
      {
        expected_edit_version: 3,
        replacement: {
          product_id: 'dl-large-combo',
          quantity: 2,
          addons: [],
          special_instructions: 'Back door',
          modifier_selection: {
            ...COMBO,
            pizzas: [{ ...COMBO.pizzas[0], whole: { pizzaId: 'island', removed: [] } }],
          },
        },
      },
      'the deal keeps its quantity and note and has no variant',
    );
  },

  'Case 4: an untouched line sends nothing': () => {
    assertEqualOrThrow(sheetEdit(GARDEN), null, 'a plain pizza saved as it was');
    assertEqualOrThrow(sheetEdit(HALF_AND_HALF), null, 'a half and half saved as it was');
    assertEqualOrThrow(dealEdit(DEAL), null, 'a deal saved as it was');
    // The same removals tapped in another order are the same pizza.
    assertEqualOrThrow(
      sheetEdit(
        item({ ...HALF_AND_HALF, modifier_selection: JSON.stringify(HALVES) }),
        { type: 'ingredient', half: 0, name: 'Olives' },
        { type: 'ingredient', half: 0, name: 'Olives' },
      ),
      null,
      'a recipe stored as text, with a removal put back and taken off again',
    );
  },

  'Case 5: a quantity change alone sends the quantity and no recipe': () => {
    same(
      sheetEdit(HALF_AND_HALF, { type: 'quantity', quantity: 3 }),
      { expected_edit_version: 3, quantity: 3 },
      'the stored recipe is not sent again',
    );
  },

  'Case 6: a pizza made plain again clears its recipe, and a new size moves the variant': () => {
    const noOnions = item({
      ...GARDEN,
      modifier_selection: {
        kind: 'pizza',
        v: 1,
        sizeId: 'large',
        whole: { pizzaId: 'garden', removed: ['Onions'] },
      },
    });
    const plain = sheetEdit(noOnions, { type: 'ingredient', half: 0, name: 'Onions' });
    assertEqualOrThrow(plain.replacement.modifier_selection, null, 'null clears the stored recipe');
    const small = sheetEdit(noOnions, { type: 'size', sizeId: 'small' });
    assertEqualOrThrow(small.replacement.variant_id, 'pz-garden-small', 'the variant is the size');
    assertEqualOrThrow(small.replacement.modifier_selection.sizeId, 'small', 'so is the recipe');
  },

  'Case 7: a dip added in the sheet joins the add-ons the line had': () => {
    const withOther = item({
      ...GARDEN,
      addons: [{ id: 'ad-extra-cheese', name: 'Extra cheese', price: 2, quantity: 1 }],
      edit_version: undefined,
    });
    const edit = sheetEdit(withOther, { type: 'dip', dipId: 'garlic', count: 2 });
    same(
      edit.replacement.addons,
      [
        { id: 'ad-extra-cheese', name: 'Extra cheese', price: 2, quantity: 1 },
        { id: 'ad-dips-garlic', name: 'Garlic', price: 1.25, quantity: 2 },
      ],
      'the other add-on stays and the dip follows it',
    );
    assertEqualOrThrow(edit.expected_edit_version, 0, 'an item with no version sends 0');
    assertEqualOrThrow(
      'modifier_selection' in edit.replacement && edit.replacement.modifier_selection,
      null,
      'a plain pizza says it has no recipe',
    );
  },

  'Case 8: only the half and half and the deals need the pizza screens': () => {
    assertEqualOrThrow(needsPizzaScreen('pz-half-and-half'), true, 'the half and half');
    assertEqualOrThrow(needsPizzaScreen('dl-party'), true, 'a deal');
    assertEqualOrThrow(needsPizzaScreen('pz-garden'), false, 'a plain pizza');
    assertEqualOrThrow(needsPizzaScreen('dr-cola'), false, 'a drink');
    assertEqualOrThrow(needsPizzaScreen('sd-wings'), false, 'a side');
  },

  'Case 9: the lines under a sent line': () => {
    same(lines(null, HALF_AND_HALF), [RECIPE_NOT_PRINTED], 'no menu: the warning line');
    same(
      lines(catalog, HALF_AND_HALF),
      ['1ST: GARDEN', '  NO OLIVES', '2ND: CLASSIC PEPPERONI'],
      'the lines the cart shows',
    );
    same(lines(catalog, GARDEN), [], 'a plain pizza has none');
    same(lines(null, GARDEN), [], 'and no warning either');
    same(
      lines(null, item({ product_id: 'x', modifier_selection: { size: 'L' } })),
      [],
      'a selection that is not a recipe is left alone',
    );
    same(
      lines(catalog, item({ product_id: 'dl-nope', modifier_selection: { kind: 'deal' } })),
      [RECIPE_NOT_PRINTED],
      'a recipe the menu no longer fits: the warning line',
    );
  },

  'Case 10: a stored note with outer spaces does not make an untouched line a change': () => {
    const spaced = item({ ...HALF_AND_HALF, special_instructions: '  Ring the bell ' });
    assertEqualOrThrow(sheetEdit(spaced), null, 'saved as it was, nothing is sent');
    const edit = sheetEdit(spaced, { type: 'cook', cook: 'well-done' });
    assertEqualOrThrow(
      edit.replacement.special_instructions,
      'Ring the bell',
      'a real change sends the note trimmed',
    );
  },

  'Case 11: a line with an add-on the catalogue no longer names cannot be changed': () => {
    assertEqualOrThrow(sentLineChangeable(HALF_AND_HALF), true, 'add-ons with ids');
    assertEqualOrThrow(sentLineChangeable(GARDEN), true, 'no add-ons');
    assertEqualOrThrow(
      sentLineChangeable(item({ ...GARDEN, addons: [{ id: null, name: 'Old dip', price: 1 }] })),
      false,
      'an add-on with no id: the route would refuse the edit',
    );
  },

  'Case 12: a line with its own price goes back to the menu price when it is replaced': () => {
    assertEqualOrThrow(sentLineRepriced(GARDEN), false, 'a line at the menu price');
    assertEqualOrThrow(
      sentLineRepriced(item({ ...GARDEN, price_overridden: 1 })),
      true,
      'override',
    );
    assertEqualOrThrow(
      sentLineRepriced(item({ ...GARDEN, discount_amount: 2.5 })),
      true,
      'discount',
    );
    assertEqualOrThrow(
      sentLineRepriced(item({ ...GARDEN, discount_amount: 0 })),
      false,
      'no discount',
    );
  },

  'Case 13: a change of recipe or note keeps the sold prices; size, quantity or add-ons re-price':
    () => {
      const sold = item({ ...HALF_AND_HALF, unit_price: 21.5 });
      const was = sentLine(sold);
      same(
        soldPrices(sold),
        { price: 21.5, dips: { ranch: 1.25 } },
        'what the line was sold at: the pizza, and each dip by its menu id',
      );
      const after = (...actions: object[]) => {
        const opened = sheetReducer(newSheet(), { type: 'load', line: sheetSource(was) });
        const state = actions.reduce((current, action) => sheetReducer(current, action), opened);
        return sentLineReprices(was, sheetSentLine(was, sheetLine(catalog, state), state));
      };
      assertEqualOrThrow(after(), false, 'untouched');
      assertEqualOrThrow(
        after({ type: 'ingredient', half: 0, name: 'Onions' }),
        false,
        'an ingredient taken off: the recipe only',
      );
      assertEqualOrThrow(after({ type: 'note', note: 'Side door' }), false, 'the note only');
      assertEqualOrThrow(after({ type: 'cook', cook: 'well-done' }), false, 'the cook note');
      assertEqualOrThrow(after({ type: 'size', sizeId: 'medium' }), true, 'another size');
      assertEqualOrThrow(after({ type: 'quantity', quantity: 3 }), true, 'another quantity');
      assertEqualOrThrow(after({ type: 'dip', dipId: 'garlic', count: 1 }), true, 'a dip added');
      assertEqualOrThrow(after({ type: 'dip', dipId: 'ranch', count: 1 }), true, 'a dip fewer');
      assertEqualOrThrow(
        sentLineReprices(sentLine(GARDEN), { ...sentLine(GARDEN), productId: 'pz-island' }),
        true,
        'another product',
      );
    },

  'Case 14: until the product prices are held, only a change that keeps the sold price is saved':
    () => {
      same(
        sentPriceGate({ reprices: false, held: false, failed: false }),
        { blocked: false, notice: false },
        'prices on their way, recipe or note changed: saved, and nothing to say yet',
      );
      same(
        sentPriceGate({ reprices: false, held: false, failed: true }),
        { blocked: false, notice: true },
        'the request failed: still saved, and the sheet says prices could not be loaded',
      );
      same(
        sentPriceGate({ reprices: true, held: false, failed: true }),
        { blocked: true, notice: true },
        'a change of size, quantity or dips is not offered without prices',
      );
      same(
        sentPriceGate({ reprices: true, held: false, failed: false }),
        { blocked: true, notice: true },
        'nor while the first request has not answered',
      );
      same(
        sentPriceGate({ reprices: true, held: true, failed: true }),
        { blocked: false, notice: false },
        'once a request succeeded everything is offered again',
      );
    },
});
