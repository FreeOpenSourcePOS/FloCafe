/**
 * The pizza menu parser: a shop's menu file becomes a validated catalogue with
 * money in whole cents, and every rejection names the bad entry.
 *
 * Run: npm run test:pizza-menu
 */
const { assertOrThrow, assertEqualOrThrow, runCases } = require('./helpers/pizza-print-harness');
const fs = require('node:fs');
const path = require('node:path');
const { MenuError, parseMenuFile, ingredientsOf, toCents } = require('../shared/pizza/menu');
const sample = require('./fixtures/pizza-sample-menu.json');

const same = (actual: unknown, expected: unknown, message: string) =>
  assertEqualOrThrow(JSON.stringify(actual), JSON.stringify(expected), message);

const category = (menu: any, id: string) => menu.categories.find((entry: any) => entry.id === id);

/** Parse a changed copy of the sample and return the `MenuError` it must raise. */
function rejected(change: (menu: any) => void, expectedPath: string, message: string) {
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
  assertOrThrow(error.message.includes(expectedPath), `${message}: the message carries the path`);
  return error;
}

/** The sample with 200 pizzas and 12 sizes, the most the parser accepts. */
function largestMenu() {
  const menu = structuredClone(sample);
  const pizzas = category(menu, 'pizzas').items;
  pizzas.splice(
    0,
    pizzas.length,
    ...Array.from({ length: 200 }, (_, index) => ({
      ...pizzas[1],
      id: `pizza-${index}`,
      number: index + 1,
      name: `Pizza ${index + 1}`,
    })),
  );
  menu.sizes.pizza = [
    ...menu.sizes.pizza,
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `size-${index}`,
      label: `Size ${index}`,
      price: 30 + index,
    })),
  ];
  return menu;
}

function throwsRangeError(run: () => unknown, message: string) {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  assertOrThrow(error instanceof RangeError, message);
}

runCases('Pizza menu', {
  'Case 1: the sample menu parses into a catalogue in whole cents': () => {
    const catalog = parseMenuFile(sample);
    same(
      catalog.sizes,
      [
        { id: 'small', label: 'Small', priceCents: 1500 },
        { id: 'medium', label: 'Medium', priceCents: 1900 },
        { id: 'large', label: 'Large', priceCents: 2300 },
      ],
      'sizes carry the size price in cents',
    );
    same(
      catalog.pizzas.map((pizza: any) => pizza.id),
      ['garden', 'island', 'classic', 'smokehouse', 'plain'],
      'every pizza is in the catalogue, in file order',
    );
    same(
      catalog.pizzas[1],
      {
        id: 'island',
        number: 2,
        name: 'Island',
        description: 'Ham, pineapple, cheese & tomato sauce',
        ingredients: ['Ham', 'Pineapple', 'Cheese', 'Tomato sauce'],
      },
      'a pizza keeps its number, name and description and gains its ingredients',
    );
    same(
      catalog.sides.map((side: any) => [side.id, side.priceCents]),
      [
        ['wings', 1225],
        ['green-salad', 549],
        ['garlic-toast', 250],
        ['dip', 125],
        ['pasta', 1100],
      ],
      'sides are priced in cents',
    );
    same(
      catalog.sides[0].modifier,
      {
        id: 'flavour',
        label: 'Flavour',
        required: true,
        choose: 1,
        options: [
          { id: 'hot', label: 'Hot' },
          { id: 'sweet-chili', label: 'Sweet Chili' },
        ],
      },
      'a side keeps its one modifier',
    );
    assertEqualOrThrow(catalog.sides[1].modifier, undefined, 'a plain side has no modifier');
    same(
      catalog.drinks,
      [
        { id: 'cola', label: 'Cola' },
        { id: 'ginger-ale', label: 'Ginger Ale' },
        { id: 'lemon-lime', label: 'Lemon Lime' },
      ],
      'drinks are listed by id and name',
    );
    same(
      catalog.drinkVariants,
      [
        { id: 'can', label: 'Can', priceCents: 175 },
        { id: '2l', label: '2L Bottle', priceCents: 450 },
      ],
      'drink variants are priced in cents',
    );
    assertEqualOrThrow(catalog.drinksPst, true, 'drinks carry provincial sales tax');
    same(
      catalog.deals.map((deal: any) => [deal.id, deal.priceCents]),
      [
        ['large-combo', 3550],
        ['three-large-wings', 7125],
        ['party', 11840],
        ['pasta-night', 2999],
      ],
      'deals are priced in cents',
    );
    same(
      catalog.deals[2],
      {
        id: 'party',
        name: 'Party Pack',
        priceCents: 11840,
        description: 'Any 6 large pizzas & 4 can pops or a 2L bottle',
        picks: [
          { type: 'pizza', size: 'large', count: 6 },
          {
            type: 'choice',
            options: [
              { type: 'pop', count: 4 },
              { type: '2l', count: 1 },
            ],
          },
        ],
      },
      'a deal keeps its picks',
    );
    same(catalog.tax, { gst: 0.05, pst: 0.07 }, 'tax rates are carried over');
    const drinks = structuredClone(sample);
    delete category(drinks, 'drinks').pst;
    assertEqualOrThrow(parseMenuFile(drinks).drinksPst, false, 'no pst flag means no PST');
  },

  'Case 2: prices become whole cents; a fraction of a cent is rejected': () => {
    assertEqualOrThrow(toCents(15), 1500, 'whole dollars');
    assertEqualOrThrow(toCents(118.4), 11840, 'a price that is not exact in binary');
    assertEqualOrThrow(toCents(5.49), 549, 'dollars and cents');
    assertEqualOrThrow(toCents(0), 0, 'zero');
    throwsRangeError(() => toCents(12.345), 'half a cent is rejected');
    throwsRangeError(() => toCents(1.001), 'a tenth of a cent is rejected');
    throwsRangeError(() => toCents(Number.NaN), 'not a number is rejected');
    throwsRangeError(() => toCents(Number.POSITIVE_INFINITY), 'infinity is rejected');

    rejected(
      (menu) => (menu.sizes.pizza[1].price = 19.005),
      'sizes.pizza[1].price',
      'a size price with a fraction of a cent',
    );
    rejected(
      (menu) => (category(menu, 'sides').items[0].price = 12.255),
      'categories.sides.items[0].price',
      'a side price with a fraction of a cent',
    );
    rejected(
      (menu) => (category(menu, 'drinks').variants[1].price = '4.50'),
      'categories.drinks.variants[1].price',
      'a price written as text',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[3].price = -1),
      'categories.deals.items[3].price',
      'a negative price',
    );
  },

  'Case 3: ingredients are split from the description': () => {
    same(
      ingredientsOf('Ham, pineapple, cheese & tomato sauce'),
      ['Ham', 'Pineapple', 'Cheese', 'Tomato sauce'],
      "the contract's example",
    );
    same(
      ingredientsOf('Roasted chicken, red onions, jalapeño pepper, cheddar & BBQ sauce'),
      ['Roasted chicken', 'Red onions', 'Jalapeño pepper', 'Cheddar', 'BBQ sauce'],
      'accents and capitals inside a name are kept',
    );
    same(ingredientsOf(''), [], 'an empty description has no ingredients');
    same(ingredientsOf(' , cheese &  '), ['Cheese'], 'blank entries are dropped');
    same(
      ingredientsOf('ham, Ham & cheese'),
      ['Ham', 'Cheese'],
      'an ingredient listed twice appears once',
    );
    same(parseMenuFile(sample).pizzas[4].ingredients, [], 'the plain pizza has nothing to remove');
  },

  'Case 4: dips come from the dip side': () => {
    const catalog = parseMenuFile(sample);
    same(
      catalog.dips,
      [
        { id: 'ranch', label: 'Ranch', priceCents: 125 },
        { id: 'garlic', label: 'Garlic', priceCents: 125 },
      ],
      "each dip option costs the dip side's price",
    );
    assertOrThrow(
      catalog.sides.some((side: any) => side.id === 'dip'),
      'the dip side is still a side a customer can buy alone',
    );
    const noDip = structuredClone(sample);
    const sides = category(noDip, 'sides');
    sides.items = sides.items.filter((side: any) => side.id !== 'dip');
    same(parseMenuFile(noDip).dips, [], 'a menu without a dip side has no dips');
  },

  'Case 5: a deal pointing at an unknown size is rejected': () => {
    const error = rejected(
      (menu) => (category(menu, 'deals').items[1].picks[0].size = 'jumbo'),
      'categories.deals.items[1].picks[0].size',
      'an unknown size in a deal',
    );
    assertOrThrow(error.message.includes('jumbo'), 'the message says which size');
  },

  'Case 6: duplicate ids are rejected': () => {
    rejected(
      (menu) => (menu.sizes.pizza[2].id = 'small'),
      'sizes.pizza[2].id',
      'two sizes with one id',
    );
    rejected(
      (menu) => (category(menu, 'pizzas').items[1].id = 'garden'),
      'categories.pizzas.items[1].id',
      'two pizzas with one id',
    );
    rejected(
      (menu) => (category(menu, 'sides').items[2].id = 'wings'),
      'categories.sides.items[2].id',
      'two sides with one id',
    );
    rejected(
      (menu) => (category(menu, 'sides').items[0].modifiers[0].options[1].id = 'hot'),
      'categories.sides.items[0].modifiers[0].options[1].id',
      'two options with one id',
    );
    rejected(
      (menu) => (category(menu, 'drinks').items[2].id = 'cola'),
      'categories.drinks.items[2].id',
      'two drinks with one id',
    );
    rejected(
      (menu) => (category(menu, 'drinks').variants[1].id = 'can'),
      'categories.drinks.variants[1].id',
      'two drink variants with one id',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[3].id = 'party'),
      'categories.deals.items[3].id',
      'two deals with one id',
    );
  },

  'Case 7: categories are the four known ones, each at most once, pizzas required': () => {
    rejected(
      (menu) => menu.categories.push({ id: 'desserts', name: 'Desserts', items: [] }),
      'categories[4].id',
      'a category this layer does not know',
    );
    rejected(
      (menu) => menu.categories.push({ id: 'pizzas', name: 'More Pizzas', items: [] }),
      'categories[4].id',
      'a category listed twice',
    );
    rejected(
      (menu) => (menu.categories = menu.categories.filter((entry: any) => entry.id !== 'pizzas')),
      'categories',
      'a menu without a pizzas category',
    );
    const pizzasOnly = structuredClone(sample);
    pizzasOnly.categories = [category(pizzasOnly, 'pizzas')];
    const catalog = parseMenuFile(pizzasOnly);
    same(
      [catalog.sides, catalog.dips, catalog.drinks, catalog.drinkVariants, catalog.deals],
      [[], [], [], [], []],
      'absent sides, drinks and deals are empty',
    );
    assertEqualOrThrow(catalog.drinksPst, false, 'no drinks category means no PST on drinks');
    assertEqualOrThrow(catalog.pizzas.length, 5, 'the pizzas are still there');
  },

  'Case 8: pizza, side and pick rules': () => {
    rejected(
      (menu) => (category(menu, 'pizzas').items[2].id = 'half-and-half'),
      'categories.pizzas.items[2].id',
      'a pizza with the reserved id',
    );
    rejected(
      (menu) => (category(menu, 'pizzas').items[0].sizes = 'slices'),
      'categories.pizzas.items[0].sizes',
      'a pizza sold at another set of sizes',
    );
    rejected(
      (menu) => {
        const wings = category(menu, 'sides').items[0];
        wings.modifiers.push({ id: 'sauce', label: 'Sauce', options: [{ id: 'a', label: 'A' }] });
      },
      'categories.sides.items[0].modifiers',
      'a side with two modifiers',
    );
    rejected(
      (menu) => (category(menu, 'sides').items[0].modifiers[0].required = false),
      'categories.sides.items[0].modifiers[0].required',
      'an optional modifier',
    );
    rejected(
      (menu) => delete category(menu, 'sides').items[4].modifiers[0].required,
      'categories.sides.items[4].modifiers[0].required',
      'a modifier that does not say it is required',
    );
    rejected(
      (menu) => (category(menu, 'sides').items[3].modifiers[0].choose = 2),
      'categories.sides.items[3].modifiers[0].choose',
      'a modifier that takes two answers',
    );
    const noChoose = structuredClone(sample);
    delete category(noChoose, 'sides').items[0].modifiers[0].choose;
    assertEqualOrThrow(
      parseMenuFile(noChoose).sides[0].modifier.choose,
      undefined,
      'a modifier may leave out how many to choose',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[2].picks[1].options[1] = { type: 'pop', count: 6 }),
      'categories.deals.items[2].picks[1].options',
      'a choice between two numbers of pops',
    );
    rejected(
      (menu) => category(menu, 'deals').items[2].picks[1].options.pop(),
      'categories.deals.items[2].picks[1].options',
      'a choice with one option',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[3].picks[0].count = 1.5),
      'categories.deals.items[3].picks[0].count',
      'half a pop',
    );
    rejected(
      (menu) => category(menu, 'deals').items[2].picks.push({ type: 'pop', count: 2 }),
      'categories.deals.items[2].picks[2]',
      'a deal with a choice and a pop pick',
    );
    rejected(
      (menu) => category(menu, 'deals').items[0].picks.push({ type: 'pop', count: 1 }),
      'categories.deals.items[0].picks[2]',
      'a deal with two pop picks',
    );
    rejected(
      (menu) => {
        const picks = category(menu, 'deals').items[2].picks;
        picks.push(structuredClone(picks[1]));
      },
      'categories.deals.items[2].picks[2]',
      'a deal with two choices',
    );
    rejected(
      (menu) => category(menu, 'deals').items[1].picks.push({ type: 'wing-flavour', count: 1 }),
      'categories.deals.items[1].picks[2]',
      'a deal with two wing flavours',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[1].picks[1].count = 2),
      'categories.deals.items[1].picks[1].count',
      'a wing flavour pick that is not one flavour',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[2].picks[1].options[1].count = 2),
      'categories.deals.items[2].picks[1].options[1].count',
      'a two-litre option that is not one bottle',
    );
    rejected(
      (menu) => {
        const sides = category(menu, 'sides');
        sides.items = sides.items.filter((side: any) => side.id !== 'wings');
      },
      'categories.deals.items[1].picks[1]',
      'a wing flavour pick with no wings side',
    );
    rejected(
      (menu) => (menu.categories = menu.categories.filter((entry: any) => entry.id !== 'drinks')),
      'categories.deals.items[0].picks[1]',
      'a drink pick with no drinks',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[0].picks[0].count = 0),
      'categories.deals.items[0].picks[0].count',
      'a pick of nothing',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[3].picks[0].count = 0),
      'categories.deals.items[3].picks[0].count',
      'a pop pick of nothing',
    );
    rejected(
      (menu) => (category(menu, 'drinks').pst = 'yes'),
      'categories.drinks.pst',
      'a pst flag that is not true or false',
    );
    rejected((menu) => (menu.tax.GST = -0.05), 'tax.GST', 'a negative tax rate');
    rejected(
      (menu) => (category(menu, 'deals').items[0].picks[1].type = 'dessert'),
      'categories.deals.items[0].picks[1].type',
      'a kind of pick this layer does not know',
    );
    const twoSizes = structuredClone(sample);
    category(twoSizes, 'deals').items[0].picks.unshift({ type: 'pizza', size: 'small', count: 1 });
    assertEqualOrThrow(
      parseMenuFile(twoSizes).deals[0].picks.length,
      3,
      'a deal may have pizzas of two sizes',
    );
  },

  'Case 9: every error names the bad entry': () => {
    for (const raw of [null, undefined, 'menu', 42, []]) {
      let error: any;
      try {
        parseMenuFile(raw);
      } catch (caught) {
        error = caught;
      }
      assertOrThrow(error instanceof MenuError, `${JSON.stringify(raw)} is not a menu`);
      assertEqualOrThrow(error.path, 'menu', 'the path is the file itself');
    }
    rejected((menu) => delete menu.tax, 'tax', 'no tax block');
    rejected((menu) => (menu.tax.PST = 7), 'tax.PST', 'a tax rate written as a percentage');
    rejected((menu) => (menu.sizes.pizza = []), 'sizes.pizza', 'no pizza sizes');
    rejected((menu) => delete menu.sizes.pizza[0].label, 'sizes.pizza[0].label', 'a size label');
    rejected((menu) => (menu.categories = {}), 'categories', 'categories that are not a list');
    rejected(
      (menu) => (category(menu, 'pizzas').items[3] = 'smokehouse'),
      'categories.pizzas.items[3]',
      'a pizza that is not an object',
    );
    rejected(
      (menu) => delete category(menu, 'pizzas').items[3].description,
      'categories.pizzas.items[3].description',
      'a pizza without a description',
    );
    rejected(
      (menu) => (category(menu, 'pizzas').items[0].name = '  '),
      'categories.pizzas.items[0].name',
      'a blank pizza name',
    );
    rejected(
      (menu) => (category(menu, 'sides').items[4].modifiers[0].options = []),
      'categories.sides.items[4].modifiers[0].options',
      'a modifier with nothing to choose',
    );
    rejected(
      (menu) => (category(menu, 'drinks').variants = []),
      'categories.drinks.variants',
      'drinks sold in no variant',
    );
    rejected(
      (menu) => delete category(menu, 'deals').items[0].picks,
      'categories.deals.items[0].picks',
      'a deal without picks',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[2].picks[1].options[0].type = 'juice'),
      'categories.deals.items[2].picks[1].options[0].type',
      'a choice option this layer does not know',
    );
  },

  'Case 10: unknown extra fields are ignored and the input is not changed': () => {
    const before = JSON.stringify(sample);
    const expected = parseMenuFile(sample);
    assertEqualOrThrow(JSON.stringify(sample), before, 'parsing does not change the file');

    const extra = structuredClone(sample);
    extra.hours = { monday: '11-9' };
    extra.sizes.pizza[0].diameter = 10;
    extra.sizes.wings = [{ id: 'eight', label: '8 pcs.', price: 12.25 }];
    for (const entry of extra.categories) {
      entry.note = 'seasonal';
      for (const item of entry.items) item.photo = 'photo.jpg';
    }
    category(extra, 'sides').items[0].modifiers[0].options[0].spicy = true;
    category(extra, 'drinks').variants[0].volume = '355 ml';
    category(extra, 'deals').items[0].picks[0].note = 'any';
    same(parseMenuFile(extra), expected, 'extra fields at every level change nothing');

    const text = JSON.stringify(expected);
    for (const field of ['image', 'restaurant', 'source', 'rules', 'sizes":"pizza'])
      assertOrThrow(!text.includes(`"${field}`), `the catalogue does not carry "${field}"`);
  },

  'Case 12: an id is lower-case letters, digits and hyphens, at most 40 characters': () => {
    const pizzaId = 'categories.pizzas.items[0].id';
    const bad: Array<[id: string, what: string]> = [
      ['__proto__', 'the prototype key'],
      ['two words', 'a space'],
      ['a:b', 'a colon'],
      ['Garden', 'an upper-case letter'],
      ['-garden', 'a leading hyphen'],
      ['a'.repeat(41), '41 characters'],
    ];
    for (const [id, what] of bad)
      rejected(
        (menu) => (category(menu, 'pizzas').items[0].id = id),
        pizzaId,
        `a pizza id: ${what}`,
      );
    const longest = structuredClone(sample);
    category(longest, 'pizzas').items[0].id = '0' + 'a'.repeat(39);
    assertEqualOrThrow(parseMenuFile(longest).pizzas[0].id.length, 40, '40 characters is accepted');

    const everywhere: Array<[change: (menu: any) => void, at: string]> = [
      [(menu) => (menu.sizes.pizza[0].id = 'Small'), 'sizes.pizza[0].id'],
      [(menu) => (category(menu, 'sides').items[1].id = 'a b'), 'categories.sides.items[1].id'],
      [
        (menu) => (category(menu, 'sides').items[0].modifiers[0].id = 'a b'),
        'categories.sides.items[0].modifiers[0].id',
      ],
      [
        (menu) => (category(menu, 'sides').items[0].modifiers[0].options[0].id = '__proto__'),
        'categories.sides.items[0].modifiers[0].options[0].id',
      ],
      [(menu) => (category(menu, 'drinks').items[0].id = 'a:b'), 'categories.drinks.items[0].id'],
      [
        (menu) => (category(menu, 'drinks').variants[0].id = 'Can'),
        'categories.drinks.variants[0].id',
      ],
      [(menu) => (category(menu, 'deals').items[0].id = 'a b'), 'categories.deals.items[0].id'],
    ];
    for (const [change, at] of everywhere) rejected(change, at, `a bad id at ${at}`);
  },

  'Case 13: names, labels and descriptions are short and hold no control bytes': () => {
    const long = 'x'.repeat(241);
    const fields: Array<[set: (menu: any, value: string) => void, at: string]> = [
      [(menu, value) => (menu.sizes.pizza[0].label = value), 'sizes.pizza[0].label'],
      [
        (menu, value) => (category(menu, 'pizzas').items[0].name = value),
        'categories.pizzas.items[0].name',
      ],
      [
        (menu, value) => (category(menu, 'pizzas').items[0].description = value),
        'categories.pizzas.items[0].description',
      ],
      [
        (menu, value) => (category(menu, 'sides').items[1].name = value),
        'categories.sides.items[1].name',
      ],
      [
        (menu, value) => (category(menu, 'sides').items[1].description = value),
        'categories.sides.items[1].description',
      ],
      [
        (menu, value) => (category(menu, 'sides').items[0].modifiers[0].label = value),
        'categories.sides.items[0].modifiers[0].label',
      ],
      [
        (menu, value) => (category(menu, 'sides').items[0].modifiers[0].options[0].label = value),
        'categories.sides.items[0].modifiers[0].options[0].label',
      ],
      [
        (menu, value) => (category(menu, 'drinks').items[0].name = value),
        'categories.drinks.items[0].name',
      ],
      [
        (menu, value) => (category(menu, 'drinks').variants[0].label = value),
        'categories.drinks.variants[0].label',
      ],
      [
        (menu, value) => (category(menu, 'deals').items[0].name = value),
        'categories.deals.items[0].name',
      ],
      [
        (menu, value) => (category(menu, 'deals').items[0].description = value),
        'categories.deals.items[0].description',
      ],
    ];
    for (const [set, at] of fields) {
      rejected((menu) => set(menu, long), at, `241 characters at ${at}`);
      rejected((menu) => set(menu, 'Cut\x1Bhere'), at, `an escape byte at ${at}`);
      rejected((menu) => set(menu, 'Two\nlines'), at, `a line break at ${at}`);
      const atCap = structuredClone(sample);
      set(atCap, 'x'.repeat(240));
      parseMenuFile(atCap);
    }
    assertOrThrow(true, '240 characters is accepted in every field');
  },

  'Case 14: every list has a cap': () => {
    /** `count` copies of the first entry, each with its own id. */
    const grow = (items: any[], count: number) =>
      items.splice(
        0,
        items.length,
        ...Array.from({ length: count }, (_, index) => ({
          ...items[0],
          id: `entry-${index}`,
        })),
      );
    const lists: Array<[pick: (menu: any) => any[], cap: number, at: string]> = [
      [(menu) => menu.sizes.pizza, 12, 'sizes.pizza'],
      [(menu) => category(menu, 'pizzas').items, 200, 'categories.pizzas.items'],
      [(menu) => category(menu, 'sides').items, 50, 'categories.sides.items'],
      [(menu) => category(menu, 'drinks').items, 50, 'categories.drinks.items'],
      [(menu) => category(menu, 'drinks').variants, 30, 'categories.drinks.variants'],
      [
        (menu) => category(menu, 'sides').items[0].modifiers[0].options,
        30,
        'categories.sides.items[0].modifiers[0].options',
      ],
    ];
    for (const [pick, cap, at] of lists) {
      const error = rejected(
        (menu) => grow(pick(menu), cap + 1),
        at,
        `${cap + 1} entries in ${at}`,
      );
      assertOrThrow(error.message.includes(String(cap)), `${at}: the message gives the cap`);
    }

    // Deals and picks are checked without the deals that point at sizes or drinks by id.
    const oneDeal = (menu: any) => {
      const deals = category(menu, 'deals').items;
      deals.splice(0, deals.length, {
        ...deals[0],
        picks: [{ type: 'pizza', size: 'large', count: 1 }],
      });
      return deals;
    };
    rejected((menu) => grow(oneDeal(menu), 51), 'categories.deals.items', '51 deals');
    rejected(
      (menu) => {
        const [deal] = oneDeal(menu);
        deal.picks = Array.from({ length: 31 }, () => ({
          type: 'pizza',
          size: 'large',
          count: 1,
        }));
      },
      'categories.deals.items[0].picks',
      '31 picks in a deal',
    );
    rejected(
      (menu) => (category(menu, 'deals').items[2].picks[1].options = new Array(31).fill({})),
      'categories.deals.items[2].picks[1].options',
      '31 options in a choice pick',
    );
    rejected((menu) => (menu.categories = new Array(31).fill({})), 'categories', '31 categories');

    const ingredients = (count: number) =>
      Array.from({ length: count }, (_, index) => `a${index}`).join(',');
    const error = rejected(
      (menu) => (category(menu, 'pizzas').items[0].description = ingredients(61)),
      'categories.pizzas.items[0].description',
      '61 ingredients on one pizza',
    );
    assertOrThrow(error.message.includes('60'), 'the message gives the ingredient cap');

    const atCap = structuredClone(sample);
    grow(category(atCap, 'sides').items[0].modifiers[0].options, 30);
    grow(category(atCap, 'drinks').variants, 30);
    grow(category(atCap, 'drinks').items, 50);
    const sides = category(atCap, 'sides').items;
    sides.push(
      ...Array.from({ length: 50 - sides.length }, (_, index) => ({
        ...sides[1],
        id: `extra-${index}`,
      })),
    );
    grow(oneDeal(atCap), 50);
    const catalog = parseMenuFile(atCap);
    same(
      [
        catalog.sides.length,
        catalog.drinks.length,
        catalog.drinkVariants.length,
        catalog.deals.length,
      ],
      [50, 50, 30, 50],
      'a list exactly at its cap is accepted',
    );
  },

  'Case 15: the largest menu the caps allow, 200 pizzas in 12 sizes, parses': () => {
    const catalog = parseMenuFile(largestMenu());
    same([catalog.pizzas.length, catalog.sizes.length], [200, 12], 'every pizza and size is kept');
    assertEqualOrThrow(catalog.pizzas[199].ingredients.length, 4, 'with its ingredients');
  },

  'Case 16: two entries that would derive the same catalogue id are rejected, naming both': () => {
    const sideWith = (id: string, modifierId: string, optionId: string) => ({
      id,
      name: 'Side',
      price: 1,
      modifiers: [
        {
          id: modifierId,
          label: 'Kind',
          required: true,
          options: [{ id: optionId, label: 'One' }],
        },
      ],
    });
    const sized = { name: 'Pie', description: '', sizes: 'pizza' };
    const clashes: Array<[kind: string, change: (menu: any) => void, id: string, names: string[]]> =
      [
        [
          'pizza and size',
          (menu) => {
            menu.sizes.pizza.push(
              { id: 'b-c', label: 'One', price: 1 },
              { id: 'c', label: 'Two', price: 1 },
            );
            category(menu, 'pizzas').items.push({ ...sized, id: 'a' }, { ...sized, id: 'a-b' });
          },
          'pz-a-b-c',
          ['pizza "a" in size "b-c"', 'pizza "a-b" in size "c"'],
        ],
        [
          'a pizza and the half and half',
          (menu) => {
            menu.sizes.pizza.push(
              { id: 'half-x', label: 'One', price: 1 },
              { id: 'x', label: 'Two', price: 1 },
            );
            category(menu, 'pizzas').items.push({ ...sized, id: 'half-and' });
          },
          'pz-half-and-half-x',
          ['pizza "half-and" in size "half-x"', 'the half and half in size "x"'],
        ],
        [
          'drink and variant',
          (menu) => {
            category(menu, 'drinks').variants.push(
              { id: 'b-c', label: 'One', price: 1 },
              { id: 'c', label: 'Two', price: 1 },
            );
            category(menu, 'drinks').items.push(
              { id: 'a', name: 'One' },
              { id: 'a-b', name: 'Two' },
            );
          },
          'dr-a-b-c',
          ['drink "a" in variant "b-c"', 'drink "a-b" in variant "c"'],
        ],
        [
          'side and modifier',
          (menu) =>
            category(menu, 'sides').items.push(
              sideWith('a', 'b-c', 'x'),
              sideWith('a-b', 'c', 'y'),
            ),
          'ag-a-b-c',
          ['modifier "b-c" of side "a"', 'modifier "c" of side "a-b"'],
        ],
        [
          'modifier and option',
          (menu) =>
            category(menu, 'sides').items.push(
              sideWith('a', 'b', 'c-x'),
              sideWith('a-b', 'c', 'x'),
            ),
          'ad-a-b-c-x',
          ['option "c-x" of modifier "b" of side "a"', 'option "x" of modifier "c" of side "a-b"'],
        ],
        [
          'a dip and a side option',
          (menu) => {
            category(menu, 'sides').items[3].modifiers[0].options.push({
              id: 'm-o',
              label: 'Extra',
            });
            category(menu, 'sides').items.push(sideWith('dips', 'm', 'o'));
          },
          'ad-dips-m-o',
          ['dip "m-o"', 'option "o" of modifier "m" of side "dips"'],
        ],
      ];
    for (const [kind, change, id, names] of clashes) {
      const error = rejected(change, 'menu', kind);
      assertOrThrow(error.message.includes(`"${id}"`), `${kind}: the message gives the id ${id}`);
      for (const name of names)
        assertOrThrow(error.message.includes(name), `${kind}: the message names ${name}`);
    }
  },

  'Case 17: a deal holds at most 8 pizzas and 99 cans, so its recipe always fits an order': () => {
    const picks = (menu: any) => category(menu, 'deals').items[2].picks;
    const pizzas =
      (...counts: number[]) =>
      (menu: any) =>
        picks(menu).splice(
          0,
          1,
          ...counts.map((count, index) => ({
            type: 'pizza',
            size: index % 2 ? 'medium' : 'large',
            count,
          })),
        );
    const at = 'categories.deals.items[2].picks';
    const tooMany = rejected(pizzas(500), at, 'a deal of 500 pizzas');
    assertOrThrow(tooMany.message.includes('at most 8'), 'the message gives the pizza cap');
    rejected(pizzas(9), at, 'a deal of 9 pizzas');
    rejected(pizzas(4, 5), at, '9 pizzas over two picks');
    const most = structuredClone(sample);
    pizzas(4, 4)(most);
    assertEqualOrThrow(
      parseMenuFile(most).deals[2].picks.length,
      3,
      'a deal of 8 pizzas over two picks is accepted',
    );

    const cans = rejected(
      (menu) => (category(menu, 'deals').items[3].picks[0].count = 100),
      'categories.deals.items[3].picks[0].count',
      '100 cans in a pop pick',
    );
    assertOrThrow(cans.message.includes('at most 99'), 'the message gives the can cap');
    rejected(
      (menu) => (picks(menu)[1].options[0].count = 100),
      'categories.deals.items[2].picks[1].options[0].count',
      '100 cans in the pop option of a choice',
    );
    const full = structuredClone(sample);
    category(full, 'deals').items[3].picks[0].count = 99;
    picks(full)[1].options[0].count = 99;
    assertEqualOrThrow(parseMenuFile(full).deals[3].picks[0].count, 99, '99 cans are accepted');

    // Half a character pair is written out as six bytes, which no size limit here allows for.
    rejected(
      (menu) => (category(menu, 'pizzas').items[0].description = 'Olives, \ud83c & cheese'),
      'categories.pizzas.items[0].description',
      'half a character pair in a description',
    );
    const emoji = structuredClone(sample);
    category(emoji, 'pizzas').items[0].description = 'Olives, \ud83c\udf55 & cheese';
    assertEqualOrThrow(
      parseMenuFile(emoji).pizzas[0].ingredients[1],
      '\ud83c\udf55',
      'a whole character pair is kept',
    );
  },

  'Case 11: nothing under shared/pizza imports outside shared': () => {
    const pizzaDir = path.resolve(__dirname, '../shared/pizza');
    const sharedDir = path.resolve(__dirname, '../shared') + path.sep;
    const files = fs.readdirSync(pizzaDir).filter((name: string) => name.endsWith('.ts'));
    for (const name of ['menu.ts', 'recipe.ts', 'ticket.ts', 'types.ts'])
      assertOrThrow(files.includes(name), `shared/pizza/${name} exists`);
    for (const name of files) {
      const source = fs.readFileSync(path.join(pizzaDir, name), 'utf8');
      const imports =
        /^[ \t]*import\s+['"]([^'"]+)['"]|^[ \t]*(?:import|export)\b[^'";=]*?\bfrom\s*['"]([^'"]+)['"]|\b(?:require|import)\(\s*['"]([^'"]+)['"]/gm;
      const specifiers = [...source.matchAll(imports)].map(
        (match) => match[1] ?? match[2] ?? match[3],
      );
      assertOrThrow(specifiers.length > 0 || name === 'types.ts', `shared/pizza/${name} is read`);
      for (const specifier of specifiers) {
        assertOrThrow(
          specifier.startsWith('.') &&
            (path.resolve(pizzaDir, specifier) + path.sep).startsWith(sharedDir),
          `shared/pizza/${name} imports ${specifier} from inside shared/`,
        );
      }
    }
  },
});
