/**
 * Kitchen ticket text for a recipe: the heading and the ready-wrapped detail
 * lines, asserted line for line against the contract's examples.
 *
 * Run: npm run test:pizza-ticket
 */
const { assertOrThrow, assertEqualOrThrow, runCases } = require('./helpers/pizza-print-harness');
const { parseMenuFile } = require('../shared/pizza/menu');
const { ticketLines } = require('../shared/pizza/ticket');
const sample = require('./fixtures/pizza-sample-menu.json');

const COLUMNS = [42, 48];
const catalog = () => parseMenuFile(sample);

const whole = (pizzaId: string, removed: string[] = [], more: object = {}) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  whole: { pizzaId, removed },
  ...more,
});
const halves = (first: object, second: object, more: object = {}) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [first, second],
  ...more,
});
const part = (pizzaId: string, removed: string[] = []) => ({ pizzaId, removed });
const deal = (dealId: string, pizzas: object[], more: object = {}) => ({
  kind: 'deal',
  v: 1,
  dealId,
  pizzas,
  ...more,
});

const EVERYTHING_OFF = ['Cheese', 'Green peppers', 'Mushrooms', 'Olives', 'Onions', 'Tomato sauce'];
const THREE_LARGE = deal(
  'three-large-wings',
  [whole('garden', ['Olives']), halves(part('island'), part('plain')), whole('classic')],
  { wingFlavour: 'sweet-chili' },
);
const PARTY_PIZZAS = [whole('garden'), ...Array.from({ length: 5 }, () => whole('classic'))];
const PARTY_LINES = [
  '1) LARGE GARDEN',
  ...[2, 3, 4, 5, 6].map((n) => `${n}) LARGE CLASSIC PEPPERONI`),
];

/** Display cells of a line: a full-width character takes two. */
const cells = (line: string) =>
  [...line].reduce((sum, char) => sum + (char.codePointAt(0)! >= 0xff00 ? 2 : 1), 0);
const indentOf = (line: string) => line.length - line.trimStart().length;

function prints(
  recipe: object,
  columns: number,
  heading: string,
  detailLines: string[],
  message: string,
  menu = catalog(),
) {
  const ticket = ticketLines(menu, recipe, columns);
  assertEqualOrThrow(ticket.heading, heading, `${message}: heading at ${columns} columns`);
  assertEqualOrThrow(
    ticket.detailLines.join('\n'),
    detailLines.join('\n'),
    `${message}: detail lines at ${columns} columns`,
  );
}

/** The rules every ticket obeys, whatever the recipe and the paper. */
function obeysTheRules(recipe: object, columns: number, message: string, menu = catalog()) {
  const { heading, detailLines } = ticketLines(menu, recipe, columns);
  const label = `${message} at ${columns} columns`;
  assertEqualOrThrow(heading, heading.toUpperCase(), `${label}: the heading is upper case`);
  assertOrThrow(heading.trim().length > 0, `${label}: there is a heading`);
  for (const line of detailLines) {
    assertOrThrow(cells(line) <= columns - 3, `${label}: "${line}" fits in ${columns - 3} cells`);
    assertOrThrow(line === line.toUpperCase(), `${label}: "${line}" is upper case`);
    assertOrThrow(
      line.trim().length > 0 && line === line.trimEnd(),
      `${label}: "${line}" is trimmed`,
    );
    assertOrThrow(
      !/(^|\s)(NO|\+)$/.test(line),
      `${label}: "${line}" does not end in a lone NO or +`,
    );
  }
  return detailLines;
}

function withMenu(change: (menu: any) => void) {
  const menu = structuredClone(sample);
  change(menu);
  return parseMenuFile(menu);
}
const pizzasOf = (menu: any) => menu.categories.find((entry: any) => entry.id === 'pizzas').items;

runCases('Pizza ticket', {
  "Case 1: the contract's whole pizza, line for line": () => {
    for (const columns of COLUMNS) {
      prints(
        whole('garden', ['Olives', 'Onions'], { cook: 'well-done', cut: 'square-cut' }),
        columns,
        'LARGE GARDEN',
        ['NO OLIVES, NO ONIONS', 'WELL DONE, SQUARE CUT'],
        'a whole pizza with removals and notes',
      );
      prints(whole('classic'), columns, 'LARGE CLASSIC PEPPERONI', [], 'a pizza as it comes');
      prints(
        { ...whole('island', ['Ham']), sizeId: 'small' },
        columns,
        'SMALL ISLAND',
        ['NO HAM'],
        'removals only',
      );
      prints(
        whole('plain', [], { cook: 'light-bake', cut: 'uncut' }),
        columns,
        'LARGE PLAIN CHEESE',
        ['LIGHT BAKE, UNCUT'],
        'notes only',
      );
      prints(
        whole('plain', [], { cut: 'square-cut' }),
        columns,
        'LARGE PLAIN CHEESE',
        ['SQUARE CUT'],
        'one note',
      );
    }
  },

  "Case 2: the contract's half and half, line for line": () => {
    for (const columns of COLUMNS) {
      prints(
        halves(part('island', ['Pineapple']), part('classic')),
        columns,
        'LARGE HALF & HALF',
        ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC PEPPERONI'],
        'a half and half',
      );
      prints(
        halves(part('classic'), part('garden', ['Olives', 'Onions']), { cook: 'well-done' }),
        columns,
        'LARGE HALF & HALF',
        ['1ST: CLASSIC PEPPERONI', '2ND: GARDEN', '  NO OLIVES, NO ONIONS', 'WELL DONE'],
        'removals on the second half, then the notes',
      );
    }
  },

  "Case 3: the contract's deals, line for line": () => {
    for (const columns of COLUMNS) {
      prints(
        THREE_LARGE,
        columns,
        'LARGE PIZZAS & WINGS',
        [
          '1) LARGE GARDEN',
          '   NO OLIVES',
          '2) LARGE HALF & HALF',
          '   1ST: ISLAND',
          '   2ND: PLAIN CHEESE',
          '3) LARGE CLASSIC PEPPERONI',
          'WINGS: SWEET CHILI',
        ],
        'three pizzas and wings',
      );
      prints(
        deal('party', PARTY_PIZZAS, { pops: { cola: 2, 'ginger-ale': 1, 'lemon-lime': 1 } }),
        columns,
        'PARTY PACK',
        [...PARTY_LINES, 'POP: 2 COLA, 1 GINGER ALE, 1 LEMON LIME'],
        'the party pack with cans',
      );
      prints(
        deal('party', PARTY_PIZZAS, { twoLitre: 'cola' }),
        columns,
        'PARTY PACK',
        [...PARTY_LINES, '2L: COLA'],
        'the party pack with a bottle',
      );
      prints(
        deal('pasta-night', [], { pops: { cola: 3 } }),
        columns,
        'PASTA NIGHT',
        ['POP: 3 COLA'],
        'a deal with no pizzas',
      );
      prints(
        deal(
          'large-combo',
          [
            halves(part('island', ['Pineapple']), part('classic'), {
              cook: 'well-done',
              cut: 'uncut',
            }),
          ],
          { pops: { cola: 1, 'ginger-ale': 1 } },
        ),
        columns,
        'LARGE PIZZA COMBO',
        [
          '1) LARGE HALF & HALF',
          '   1ST: ISLAND',
          '     NO PINEAPPLE',
          '   2ND: CLASSIC PEPPERONI',
          '   WELL DONE, UNCUT',
          'POP: 1 COLA, 1 GINGER ALE',
        ],
        "a deal pizza's own lines are indented by three",
      );
    }
  },

  'Case 4: a long removal list wraps at commas': () => {
    prints(
      whole('garden', EVERYTHING_OFF),
      42,
      'LARGE GARDEN',
      ['NO CHEESE, NO GREEN PEPPERS,', 'NO MUSHROOMS, NO OLIVES, NO ONIONS,', 'NO TOMATO SAUCE'],
      'every ingredient removed',
    );
    prints(
      whole('garden', EVERYTHING_OFF),
      48,
      'LARGE GARDEN',
      ['NO CHEESE, NO GREEN PEPPERS, NO MUSHROOMS,', 'NO OLIVES, NO ONIONS, NO TOMATO SAUCE'],
      'every ingredient removed',
    );
    prints(
      deal('large-combo', [halves(part('classic'), part('garden', EVERYTHING_OFF))], {
        pops: { cola: 2 },
      }),
      42,
      'LARGE PIZZA COMBO',
      [
        '1) LARGE HALF & HALF',
        '   1ST: CLASSIC PEPPERONI',
        '   2ND: GARDEN',
        '     NO CHEESE, NO GREEN PEPPERS,',
        '     NO MUSHROOMS, NO OLIVES,',
        '     NO ONIONS, NO TOMATO SAUCE',
        'POP: 2 COLA',
      ],
      'a continuation line starts at the indent of the line it continues',
    );
  },

  'Case 5: no line is wider than the paper allows': () => {
    const recipes: Record<string, object> = {
      'everything off': whole('garden', EVERYTHING_OFF, { cook: 'well-done', cut: 'square-cut' }),
      'both halves stripped': halves(
        part('garden', EVERYTHING_OFF),
        part('smokehouse', [
          'BBQ sauce',
          'Cheddar',
          'Jalapeño pepper',
          'Red onions',
          'Roasted chicken',
        ]),
        { cook: 'light-bake', cut: 'uncut' },
      ),
      'three pizzas and wings': THREE_LARGE,
      'a party of stripped halves': deal(
        'party',
        Array.from({ length: 6 }, () =>
          halves(part('garden', EVERYTHING_OFF), part('island', ['Cheese', 'Ham', 'Pineapple']), {
            cook: 'well-done',
            cut: 'square-cut',
          }),
        ),
        { pops: { cola: 1, 'ginger-ale': 2, 'lemon-lime': 1 } },
      ),
    };
    for (const [name, recipe] of Object.entries(recipes)) {
      for (const columns of [32, ...COLUMNS]) {
        const lines = obeysTheRules(recipe, columns, name);
        assertOrThrow(lines.length > 0, `${name} at ${columns} columns: prints detail lines`);
      }
    }
  },

  'Case 6: a name too long for the line wraps on spaces at the same indent': () => {
    const longName = withMenu((menu) => {
      pizzasOf(menu)[0].name = 'Extraordinarily Long Made-Up Pizza Name For Testing Only';
    });
    prints(
      deal('large-combo', [whole('garden', ['Olives'])], { pops: { cola: 2 } }),
      42,
      'LARGE PIZZA COMBO',
      [
        '1) LARGE EXTRAORDINARILY LONG MADE-UP',
        'PIZZA NAME FOR TESTING ONLY',
        '   NO OLIVES',
        'POP: 2 COLA',
      ],
      'a long pizza name inside a deal',
      longName,
    );
    prints(
      deal('large-combo', [halves(part('classic'), part('garden'))], { pops: { cola: 2 } }),
      42,
      'LARGE PIZZA COMBO',
      [
        '1) LARGE HALF & HALF',
        '   1ST: CLASSIC PEPPERONI',
        '   2ND: EXTRAORDINARILY LONG MADE-UP',
        '   PIZZA NAME FOR TESTING ONLY',
        'POP: 2 COLA',
      ],
      'a long pizza name on a half',
      longName,
    );
    assertEqualOrThrow(
      ticketLines(longName, whole('garden'), 42).heading,
      'LARGE EXTRAORDINARILY LONG MADE-UP PIZZA NAME FOR TESTING ONLY',
      'the heading is left for the print layer to wrap',
    );

    const removed = [
      'A made-up topping with a name far too long to fit on one line of paper',
      'Thirty-one letter made-up thing',
      'Supercalifragilisticexpialidocious-style-pepperoncini',
    ];
    // Together these are longer than a menu file's description may be, so they are set after parsing.
    const longIngredient = catalog();
    longIngredient.pizzas[0].ingredients = [removed[1], removed[0], removed[2]];
    prints(
      whole('garden', [removed[0], removed[1]]),
      42,
      'LARGE GARDEN',
      [
        'NO A MADE-UP TOPPING WITH A NAME FAR',
        'TOO LONG TO FIT ON ONE LINE OF PAPER,',
        'NO THIRTY-ONE LETTER MADE-UP THING',
      ],
      'a long ingredient wraps on spaces',
      longIngredient,
    );
    prints(
      whole('garden', [removed[1], removed[0]]),
      42,
      'LARGE GARDEN',
      [
        'NO THIRTY-ONE LETTER MADE-UP THING,',
        'NO A MADE-UP TOPPING WITH A NAME FAR',
        'TOO LONG TO FIT ON ONE LINE OF PAPER',
      ],
      'NO moves down with its ingredient when only the NO would fit',
      longIngredient,
    );
    for (const columns of [32, ...COLUMNS]) {
      const recipe = deal('large-combo', [halves(part('garden', removed), part('classic'))], {
        pops: { cola: 2 },
      });
      const lines = obeysTheRules(recipe, columns, 'a word longer than the line', longIngredient);
      assertEqualOrThrow(
        lines
          .join('')
          .replace(/\s/g, '')
          .includes('SUPERCALIFRAGILISTICEXPIALIDOCIOUS-STYLE-PEPPERONCINI'),
        true,
        `at ${columns} columns no letter of the long word is lost`,
      );
      const removalLines = lines.filter((line) => indentOf(line) === 5);
      assertOrThrow(removalLines.length > 2, `at ${columns} columns the removals wrap`);
    }
  },

  'Case 6b: a width that is not a positive number never loops and keeps lines as narrow as it can':
    () => {
      for (const columns of [0, 3, -10, Number.NaN, 2.5]) {
        const { detailLines } = ticketLines(
          catalog(),
          whole('garden', ['Olives', 'Onions']),
          columns,
        );
        assertOrThrow(detailLines.length > 0, `columns ${columns}: lines are still produced`);
        assertOrThrow(
          detailLines.every((line: string) => !/, \S/.test(line)),
          `columns ${columns}: one item per line`,
        );
      }
    },

  'Case 7: text is upper-cased as written and measured in display cells': () => {
    for (const columns of COLUMNS) {
      prints(
        whole('smokehouse', ['Jalapeño pepper', 'Red onions']),
        columns,
        'LARGE SMOKEHOUSE CHICKEN',
        ['NO JALAPEÑO PEPPER, NO RED ONIONS'],
        'a letter such as Ñ is kept',
      );
    }
    const wide = withMenu((menu) => {
      pizzasOf(menu)[0].description = 'ａａａａａａａａ, ｂｂｂｂｂｂｂｂ & ｃｃｃｃｃｃｃｃ';
    });
    const recipe = whole('garden', ['ａａａａａａａａ', 'ｂｂｂｂｂｂｂｂ', 'ｃｃｃｃｃｃｃｃ']);
    prints(
      recipe,
      42,
      'LARGE GARDEN',
      ['NO ＡＡＡＡＡＡＡＡ,', 'NO ＢＢＢＢＢＢＢＢ,', 'NO ＣＣＣＣＣＣＣＣ'],
      'full-width letters take two cells each',
      wide,
    );
    obeysTheRules(recipe, 48, 'full-width letters', wide);
  },

  'Case 8: a recipe from an older menu still prints': () => {
    prints(
      { ...whole('retired-pizza', ['Anchovies']), sizeId: 'jumbo' },
      42,
      'JUMBO RETIRED-PIZZA',
      ['NO ANCHOVIES'],
      'a pizza and size no longer on the menu print by id',
    );
    prints(
      deal('retired-deal', [whole('classic')], { pops: { 'root-beer': 2 }, wingFlavour: 'smoky' }),
      42,
      'RETIRED-DEAL',
      ['1) LARGE CLASSIC PEPPERONI', 'POP: 2 ROOT-BEER', 'WINGS: SMOKY'],
      'a deal no longer on the menu prints by id',
    );
  },
});
