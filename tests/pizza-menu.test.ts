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
