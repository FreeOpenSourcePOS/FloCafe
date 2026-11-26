/**
 * Recipes on order lines: what a cashier built is checked against the menu,
 * returned as a normalised copy, and refused with a message they can act on.
 *
 * Run: npm run test:pizza-recipe
 */
const { assertOrThrow, assertEqualOrThrow, runCases } = require('./helpers/pizza-print-harness');
const { parseMenuFile } = require('../shared/pizza/menu');
const { RecipeError, validateRecipe, recipeKey, dealPickCount } = require('../shared/pizza/recipe');
const sample = require('./fixtures/pizza-sample-menu.json');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(JSON.stringify(actual), JSON.stringify(expected), message);

const catalog = () => parseMenuFile(sample);

const whole = (pizzaId: string, removed: string[] = [], more: object = {}) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  whole: { pizzaId, removed },
  ...more,
});
const halves = (first: unknown, second: unknown, more: object = {}) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [first, second],
  ...more,
});
const part = (pizzaId: string, removed: string[] = []) => ({ pizzaId, removed });
const deal = (dealId: string, pizzas: unknown[], more: object = {}) => ({
  kind: 'deal',
  v: 1,
  dealId,
  pizzas,
  ...more,
});
const larges = (count: number) => Array.from({ length: count }, () => whole('classic'));

/** Validate a recipe that must be refused and return the message the cashier sees. */
function refused(raw: unknown, expectedMessage: string | RegExp, message: string): string {
  let error: any;
  try {
    validateRecipe(catalog(), raw);
  } catch (caught) {
    error = caught;
  }
  assertOrThrow(error instanceof RecipeError, `${message}: refused with a RecipeError`);
  if (typeof expectedMessage === 'string')
    assertEqualOrThrow(error.message, expectedMessage, `${message}: says what to do`);
  else
    assertOrThrow(
      expectedMessage.test(error.message),
      `${message}: "${error.message}" matches ${expectedMessage}`,
    );
  return error.message;
}

runCases('Pizza recipe', {
  'Case 1: a whole pizza comes back as a normalised copy': () => {
    const raw = { ...whole('garden', ['Olives']), cook: 'well-done', cut: 'square-cut', extra: 1 };
    const before = JSON.stringify(raw);
    const recipe = validateRecipe(catalog(), raw);
    same(
      recipe,
      {
        kind: 'pizza',
        v: 1,
        sizeId: 'large',
        whole: { pizzaId: 'garden', removed: ['Olives'] },
        cook: 'well-done',
        cut: 'square-cut',
      },
      'known fields in a fixed order, unknown fields dropped',
    );
    assertEqualOrThrow(JSON.stringify(raw), before, 'the input is not changed');
    assertOrThrow(recipe !== raw && recipe.whole !== raw.whole, 'the result is a copy');
    same(
      validateRecipe(catalog(), {
        kind: 'pizza',
        v: 1,
        sizeId: 'small',
        whole: { pizzaId: 'plain' },
      }),
      { kind: 'pizza', v: 1, sizeId: 'small', whole: { pizzaId: 'plain', removed: [] } },
      'a pizza with nothing removed and no notes is valid',
    );
    same(
      validateRecipe(catalog(), validateRecipe(catalog(), raw)),
      recipe,
      'validating a normalised recipe changes nothing',
    );
  },

  'Case 2: removals are sorted and de-duplicated; the input keeps its order': () => {
    const raw = whole('garden', ['Onions', 'Olives', 'Onions', 'Cheese']);
    same(
      validateRecipe(catalog(), raw).whole.removed,
      ['Cheese', 'Olives', 'Onions'],
      'sorted, each ingredient once',
    );
    same(
      raw.whole.removed,
      ['Onions', 'Olives', 'Onions', 'Cheese'],
      'the input list is untouched',
    );
  },

  'Case 3: half and half keeps which half is which': () => {
    const recipe = validateRecipe(
      catalog(),
      halves(part('island', ['Pineapple']), part('classic'), { cut: 'uncut' }),
    );
    same(
      recipe,
      {
        kind: 'pizza',
        v: 1,
        sizeId: 'large',
        halves: [
          { pizzaId: 'island', removed: ['Pineapple'] },
          { pizzaId: 'classic', removed: [] },
        ],
        cut: 'uncut',
      },
      'two halves in the order given',
    );
    const swapped = validateRecipe(
      catalog(),
      halves(part('classic'), part('island', ['Pineapple'])),
    );
    assertEqualOrThrow(swapped.halves[0].pizzaId, 'classic', 'the halves are not reordered');
    same(
      validateRecipe(catalog(), halves(part('garden', ['Olives']), part('garden'))).halves,
      [
        { pizzaId: 'garden', removed: ['Olives'] },
        { pizzaId: 'garden', removed: [] },
      ],
      'the same pizza twice is fine when the removals differ',
    );
  },

  'Case 4: two identical halves are refused, not converted': () => {
    refused(
      halves(part('garden'), part('garden')),
      'Both halves are the same. Choose a whole pizza instead',
      'the same pizza on both halves',
    );
    refused(
      halves(part('garden', ['Olives', 'Onions']), part('garden', ['Onions', 'Olives', 'Onions'])),
      'Both halves are the same. Choose a whole pizza instead',
      'the same removals tapped in another order',
    );
  },

  'Case 5: an unknown pizza, size or ingredient is refused in words a cashier can act on': () => {
    refused(
      whole('meatball'),
      'That pizza is not on the menu. Pick another pizza',
      'unknown pizza',
    );
    refused(
      { ...whole('garden'), sizeId: 'jumbo' },
      'That size is not on the menu. Pick a size',
      'unknown size',
    );
    refused({ kind: 'pizza', v: 1, whole: part('garden') }, 'Pick a size', 'no size');
    refused(
      whole('island', ['Olives']),
      'Island does not have that ingredient. Choose what to remove again',
      'an ingredient of another pizza',
    );
    refused(
      whole('plain', ['Cheese']),
      'Plain Cheese does not have that ingredient. Choose what to remove again',
      'a removal from a pizza with nothing to remove',
    );
    refused({ kind: 'pizza', v: 1, sizeId: 'large' }, 'Pick a pizza', 'neither whole nor halves');
    refused(
      { ...whole('garden'), halves: [part('island'), part('classic')] },
      'Choose a whole pizza or a half and half, not both',
      'both whole and halves',
    );
    refused(
      { kind: 'pizza', v: 1, sizeId: 'large', halves: [part('island')] },
      'Pick the second half',
      'one half',
    );
    refused(halves(part('island'), null), 'Pick the second half', 'an empty second half');
    refused(halves(null, part('island')), 'Pick the first half', 'an empty first half');
    refused(
      halves(part('island'), part('meatball')),
      'Second half: That pizza is not on the menu. Pick another pizza',
      'an unknown pizza on one half',
    );
    refused(
      halves(part('island', ['Olives']), part('classic')),
      'First half: Island does not have that ingredient. Choose what to remove again',
      'a wrong removal on one half',
    );
    refused(
      { ...whole('garden'), cook: 'burnt' },
      'Choose well done or light bake',
      'unknown cook note',
    );
    refused(
      { ...whole('garden'), cut: 'triangles' },
      'Choose square cut or uncut',
      'unknown cut note',
    );
  },

  'Case 6: the same recipe gives the same key whatever order removals and pops were tapped in':
    () => {
      assertEqualOrThrow(
        recipeKey(whole('garden', ['Onions', 'Olives', 'Onions'])),
        recipeKey(whole('garden', ['Olives', 'Onions'])),
        'removal order and repeats do not change the key',
      );
      const raw = {
        cut: 'uncut',
        whole: part('garden', ['Olives']),
        v: 1,
        sizeId: 'large',
        kind: 'pizza',
      };
      assertEqualOrThrow(
        recipeKey(raw),
        recipeKey(validateRecipe(catalog(), raw)),
        'a recipe and its normalised copy share a key',
      );
      const cans = (pops: Record<string, number>) => deal('large-combo', larges(1), { pops });
      assertEqualOrThrow(
        recipeKey(cans({ 'ginger-ale': 1, cola: 1, 'lemon-lime': 0 })),
        recipeKey(cans({ cola: 1, 'ginger-ale': 1 })),
        'the order pops were tapped in does not change the key',
      );
      const keys = [
        whole('garden'),
        whole('garden', ['Olives']),
        whole('island'),
        { ...whole('garden'), sizeId: 'small' },
        whole('garden', [], { cook: 'well-done' }),
        whole('garden', [], { cut: 'uncut' }),
        halves(part('island'), part('classic')),
        halves(part('classic'), part('island')),
        cans({ cola: 2 }),
        cans({ cola: 1, 'ginger-ale': 1 }),
        deal('three-large-wings', larges(3), { wingFlavour: 'hot' }),
        deal('three-large-wings', larges(3), { wingFlavour: 'sweet-chili' }),
        deal('three-large-wings', [whole('garden'), whole('classic'), whole('classic')], {
          wingFlavour: 'hot',
        }),
        deal('three-large-wings', [whole('classic'), whole('garden'), whole('classic')], {
          wingFlavour: 'hot',
        }),
        deal('party', larges(6), { pops: { cola: 4 } }),
        deal('party', larges(6), { twoLitre: 'cola' }),
      ].map(recipeKey);
      assertEqualOrThrow(new Set(keys).size, keys.length, 'different recipes have different keys');
    },

  'Case 7: what each deal asks for': () => {
    const counts = Object.fromEntries(
      catalog().deals.map((entry: any) => [entry.id, dealPickCount(entry)]),
    );
    same(
      counts,
      {
        'large-combo': {
          pizzas: [{ sizeId: 'large' }],
          pops: 2,
          wingFlavour: false,
          choice: false,
        },
        'three-large-wings': {
          pizzas: [{ sizeId: 'large' }, { sizeId: 'large' }, { sizeId: 'large' }],
          pops: 0,
          wingFlavour: true,
          choice: false,
        },
        party: {
          pizzas: Array.from({ length: 6 }, () => ({ sizeId: 'large' })),
          pops: 0,
          wingFlavour: false,
          choice: true,
        },
        'pasta-night': { pizzas: [], pops: 3, wingFlavour: false, choice: false },
      },
      'pizzas in pick order, fixed pops, wing flavour and choice',
    );
    same(
      dealPickCount({
        picks: [
          { type: 'pizza', size: 'small', count: 1 },
          { type: 'pizza', size: 'large', count: 2 },
        ],
      }).pizzas,
      [{ sizeId: 'small' }, { sizeId: 'large' }, { sizeId: 'large' }],
      'pizzas of two sizes are listed in pick order',
    );
  },

  'Case 8: a deal needs one pizza per pick at the deal size': () => {
    const pizzas = [
      whole('garden', ['Onions', 'Olives']),
      halves(part('island'), part('plain')),
      whole('classic'),
    ];
    same(
      validateRecipe(catalog(), deal('three-large-wings', pizzas, { wingFlavour: 'sweet-chili' })),
      {
        kind: 'deal',
        v: 1,
        dealId: 'three-large-wings',
        pizzas: [
          {
            kind: 'pizza',
            v: 1,
            sizeId: 'large',
            whole: { pizzaId: 'garden', removed: ['Olives', 'Onions'] },
          },
          {
            kind: 'pizza',
            v: 1,
            sizeId: 'large',
            halves: [
              { pizzaId: 'island', removed: [] },
              { pizzaId: 'plain', removed: [] },
            ],
          },
          { kind: 'pizza', v: 1, sizeId: 'large', whole: { pizzaId: 'classic', removed: [] } },
        ],
        wingFlavour: 'sweet-chili',
      },
      'each pizza is normalised and kept in its place',
    );
    refused(deal('feast', []), 'That deal is not on the menu. Pick another deal', 'unknown deal');
    refused(
      deal('three-large-wings', larges(2), { wingFlavour: 'hot' }),
      'Pick 3 pizzas for Large Pizzas & Wings',
      'too few pizzas',
    );
    refused(
      deal('large-combo', larges(2), { pops: { cola: 2 } }),
      'Pick 1 pizza for Large Pizza Combo',
      'too many pizzas',
    );
    refused(
      deal(
        'three-large-wings',
        [whole('classic'), { ...whole('classic'), sizeId: 'small' }, whole('classic')],
        { wingFlavour: 'hot' },
      ),
      'Pizza 2: Pick a Large pizza',
      'a pizza of another size',
    );
    refused(
      deal('three-large-wings', [whole('classic'), whole('classic'), whole('meatball')], {
        wingFlavour: 'hot',
      }),
      'Pizza 3: That pizza is not on the menu. Pick another pizza',
      'an unknown pizza inside a deal',
    );
    refused(
      deal(
        'three-large-wings',
        [
          whole('classic'),
          { kind: 'pizza', v: 1, sizeId: 'large', halves: [part('island')] },
          whole('classic'),
        ],
        { wingFlavour: 'hot' },
      ),
      'Pizza 2: Pick the second half',
      'an unfinished half and half inside a deal',
    );
    refused(
      deal('pasta-night', larges(1), { pops: { cola: 3 } }),
      'Pasta Night has no pizzas to pick',
      'a pizza on a deal without pizzas',
    );
    refused(
      { kind: 'deal', v: 1, dealId: 'large-combo', pizzas: 'classic', pops: { cola: 2 } },
      'Pick 1 pizza for Large Pizza Combo',
      'pizzas that are not a list',
    );
  },

  'Case 9: a wing flavour when the deal asks for one, and only then': () => {
    refused(deal('three-large-wings', larges(3)), 'Pick a wing flavour', 'no wing flavour');
    refused(
      deal('three-large-wings', larges(3), { wingFlavour: 'ranch' }),
      'Pick a wing flavour',
      'a flavour that is not a wing flavour',
    );
    refused(
      deal('large-combo', larges(1), { pops: { cola: 2 }, wingFlavour: 'hot' }),
      'Large Pizza Combo has no wing flavour to pick',
      'a wing flavour on a deal without wings',
    );
  },

  'Case 10: pops add up to what the deal gives': () => {
    same(
      validateRecipe(
        catalog(),
        deal('large-combo', larges(1), { pops: { 'lemon-lime': 1, cola: 1, 'ginger-ale': 0 } }),
      ).pops,
      { cola: 1, 'lemon-lime': 1 },
      'zero entries are dropped and keys sorted',
    );
    same(
      validateRecipe(catalog(), { kind: 'deal', v: 1, dealId: 'pasta-night', pops: { cola: 3 } }),
      { kind: 'deal', v: 1, dealId: 'pasta-night', pizzas: [], pops: { cola: 3 } },
      'a deal with no pizzas needs only its pops',
    );
    refused(deal('large-combo', larges(1)), 'Pick 2 pops', 'no pops');
    refused(deal('large-combo', larges(1), { pops: { cola: 1 } }), 'Pick 2 pops', 'too few pops');
    refused(deal('large-combo', larges(1), { pops: { cola: 3 } }), 'Pick 2 pops', 'too many pops');
    refused(
      deal('large-combo', larges(1), { pops: { cola: 1, 'root-beer': 1 } }),
      'That drink is not on the menu. Pick another drink',
      'an unknown drink',
    );
    for (const pops of [{ cola: 2.5 }, { cola: -1, 'ginger-ale': 3 }, { cola: '2' }, ['cola'], 2])
      refused(
        deal('large-combo', larges(1), { pops }),
        /could not be read/,
        `pops written as ${JSON.stringify(pops)}`,
      );
    refused(
      deal('large-combo', larges(1), { pops: { cola: 2 }, twoLitre: 'cola' }),
      'Large Pizza Combo has no 2L bottle to pick',
      'a bottle on a deal that gives cans',
    );
    refused(
      deal('three-large-wings', larges(3), { wingFlavour: 'hot', pops: { cola: 1 } }),
      'Large Pizzas & Wings has no pops to pick',
      'pops on a deal without drinks',
    );
  },

  'Case 11: a choice is answered exactly once': () => {
    same(
      validateRecipe(catalog(), deal('party', larges(6), { pops: { cola: 2, 'lemon-lime': 2 } }))
        .pops,
      { cola: 2, 'lemon-lime': 2 },
      'four cans answer the choice',
    );
    const bottle = validateRecipe(
      catalog(),
      deal('party', larges(6), { twoLitre: 'ginger-ale', pops: {} }),
    );
    assertEqualOrThrow(bottle.twoLitre, 'ginger-ale', 'a bottle answers the choice');
    assertOrThrow(!('pops' in bottle), 'an empty pops list is left out');
    refused(deal('party', larges(6)), 'Pick 4 pops or a 2L bottle', 'no answer');
    refused(
      deal('party', larges(6), { pops: { cola: 4 }, twoLitre: 'cola' }),
      'Pick 4 pops or a 2L bottle, not both',
      'both answers',
    );
    refused(
      deal('party', larges(6), { pops: { cola: 3 } }),
      'Pick 4 pops or a 2L bottle',
      'three cans',
    );
    refused(
      deal('party', larges(6), { twoLitre: 'root-beer' }),
      'That drink is not on the menu. Pick another drink',
      'an unknown bottle',
    );
  },

  'Case 12: a malformed or oversized recipe is refused': () => {
    const unreadable = /could not be read/;
    for (const raw of [null, undefined, 'pizza', 42, [], [whole('garden')], new Date(0)])
      refused(raw, unreadable, `${JSON.stringify(raw)} is not a recipe`);
    refused({ ...whole('garden'), kind: 'calzone' }, unreadable, 'unknown kind');
    refused({ ...whole('garden'), kind: undefined }, unreadable, 'no kind');
    refused({ ...whole('garden'), v: 2 }, unreadable, 'another format version');
    refused({ kind: 'pizza', v: 1, sizeId: 'large', whole: 'garden' }, unreadable, 'whole as text');
    refused(
      { kind: 'pizza', v: 1, sizeId: 'large', whole: { pizzaId: 7 } },
      /not on the menu/,
      'a pizza id that is a number',
    );
    refused(whole('garden', 'Olives' as any), unreadable, 'removed as text');
    refused(
      whole('garden', [7 as any]),
      /does not have that ingredient/,
      'a removal that is a number',
    );
    refused(
      halves(part('island'), part('classic'), {
        halves: [part('island'), part('classic'), part('garden')],
      }),
      unreadable,
      'three halves',
    );
    refused(
      deal('three-large-wings', [whole('classic'), deal('party', []), whole('classic')], {
        wingFlavour: 'hot',
      }),
      /^Pizza 2: .*could not be read/,
      'a deal inside a deal',
    );
    refused(
      deal('party', larges(60), { twoLitre: 'cola' }),
      'Pick 6 pizzas for Party Pack',
      'ten times the pizzas the deal has',
    );
    refused(
      whole(
        'garden',
        Array.from({ length: 5000 }, () => 'Olives'),
      ),
      unreadable,
      'a removal list far longer than any pizza needs',
    );
    refused(
      { ...whole('garden'), note: 'x'.repeat(50_000) },
      unreadable,
      'a recipe carrying a large unknown field',
    );
    const loop: any = whole('garden');
    loop.self = loop;
    refused(loop, unreadable, 'a recipe that contains itself');
    const message = refused(whole('<script>alert(1)</script>'), /not on the menu/, 'a hostile id');
    assertOrThrow(!message.includes('script'), 'the message does not repeat what was sent');
  },

  'Case 13: the size limit counts bytes as stored, not characters': () => {
    const unreadable = /could not be read/;
    const bytes = (raw: unknown) => Buffer.byteLength(JSON.stringify(raw), 'utf8');
    const padded = (filler: string) => ({ ...whole('garden'), note: filler });
    const overhead = bytes(padded(''));

    const wide = padded('\u3042'.repeat(8000));
    assertOrThrow(JSON.stringify(wide).length < 20_000, 'under 20,000 characters');
    assertOrThrow(bytes(wide) > 20_000, 'and over 20,000 bytes');
    refused(wide, unreadable, 'a recipe of 24 KB in three-byte characters');

    const room = 20_000 - overhead;
    const atLimit = padded('\u00e9'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2));
    assertEqualOrThrow(bytes(atLimit), 20_000, 'a recipe of exactly 20,000 bytes');
    assertEqualOrThrow(validateRecipe(catalog(), atLimit).kind, 'pizza', 'is accepted');
    refused(padded(`${atLimit.note}x`), unreadable, 'one byte more');
  },

  'Case 14: the largest deal a menu can hold fits the size limit': () => {
    const id = (stem: string) => stem.padEnd(40, 'x');
    const letter = (index: number) => String.fromCharCode(0x4e00 + index);
    // 60 ingredients in 240 characters, each starting with a letter that capitalises to three.
    const description = (pizza: number) =>
      Array.from(
        { length: 60 },
        (_, index) => `\u0390${letter(pizza * 100 + index)}${letter(index)}`,
      ).join(',') + letter(0);
    assertEqualOrThrow(description(0).length, 240, 'a description at its cap');
    const largest = parseMenuFile({
      tax: { GST: 0.05, PST: 0.07 },
      sizes: { pizza: [{ id: id('size'), label: 'Size', price: 1 }] },
      categories: [
        {
          id: 'pizzas',
          items: [0, 1].map((pizza) => ({
            id: id(`pizza${pizza}`),
            name: 'Pizza',
            description: description(pizza),
            sizes: 'pizza',
          })),
        },
        {
          id: 'sides',
          items: [
            {
              id: 'wings',
              name: 'Wings',
              price: 1,
              modifiers: [
                {
                  id: 'flavour',
                  label: 'Flavour',
                  required: true,
                  options: [{ id: id('flavour'), label: 'Flavour' }],
                },
              ],
            },
          ],
        },
        {
          id: 'drinks',
          variants: [{ id: 'can', label: 'Can', price: 1 }],
          items: Array.from({ length: 50 }, (_, index) => ({
            id: id(`drink${index}`),
            name: 'Drink',
          })),
        },
        {
          id: 'deals',
          items: [
            {
              id: id('deal'),
              name: 'Deal',
              price: 1,
              description: '',
              picks: [
                { type: 'pizza', size: id('size'), count: 8 },
                { type: 'pop', count: 99 },
                { type: 'wing-flavour', count: 1 },
              ],
            },
          ],
        },
      ],
    });
    assertEqualOrThrow(largest.pizzas[0].ingredients.length, 60, 'a pizza of 60 ingredients');
    const half = (pizza: number) => ({
      pizzaId: id(`pizza${pizza}`),
      removed: largest.pizzas[pizza].ingredients,
    });
    // Every pizza a half and half with everything removed, every drink picked, five in double figures.
    const recipe = {
      kind: 'deal',
      v: 1,
      dealId: id('deal'),
      pizzas: Array.from({ length: 8 }, () => ({
        kind: 'pizza',
        v: 1,
        sizeId: id('size'),
        halves: [half(0), half(1)],
        cook: 'light-bake',
        cut: 'square-cut',
      })),
      pops: Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [
          id(`drink${index}`),
          index === 0 ? 14 : index < 5 ? 10 : 1,
        ]),
      ),
      wingFlavour: id('flavour'),
    };
    const size = Buffer.byteLength(JSON.stringify(recipe), 'utf8');
    assertOrThrow(size > 18_000 && size <= 20_000, `it comes to ${size} bytes, under the limit`);
    assertEqualOrThrow(validateRecipe(largest, recipe).pizzas.length, 8, 'and is accepted');
  },
});
