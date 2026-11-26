/**
 * The browser print paths fill an item's detail lines from its recipe and the
 * pizza catalogue: the ESC/POS kitchen ticket, the raster ticket document, the
 * HTML kitchen ticket and the classic and compact receipts.
 *
 * Run: npm run test:pizza-kot-browser
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  rows,
  runCases,
} = require('./helpers/pizza-print-harness');
const { createHash } = require('node:crypto');
const { parseMenuFile } = require('../shared/pizza/menu');
const { RECIPE_NOT_PRINTED, ticketLines } = require('../shared/pizza/ticket');
const { isKotDocument, isPrintDocument } = require('../shared/print');
const sample = require('./fixtures/pizza-sample-menu.json');

const frontend = loadFrontend();
const pizzaCatalog = () => require('../frontend/src/lib/pizza/catalog');

const catalog = parseMenuFile(sample);
const INDENT = '   ';
const COLUMNS = [42, 48];
/** 58 mm paper prints 32 columns; the wider counts are 80 mm paper. */
const BASELINE_COLUMNS = [32, ...COLUMNS];
const paperOf = (columns: number) => (columns === 32 ? 58 : 80);

const part = (pizzaId: string, removed: string[] = []) => ({ pizzaId, removed });
const HALF_AND_HALF = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [part('island', ['Pineapple']), part('garden', ['Olives', 'Onions'])],
  cook: 'well-done',
};
const THREE_PIZZA_DEAL = {
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [
    { kind: 'pizza', v: 1, sizeId: 'large', whole: part('garden', ['Olives']) },
    { kind: 'pizza', v: 1, sizeId: 'large', halves: [part('island'), part('plain')] },
    { kind: 'pizza', v: 1, sizeId: 'large', whole: part('classic') },
  ],
  wingFlavour: 'sweet-chili',
};

const item = (id: number, name: string, more: object = {}) => ({
  id,
  order_id: 1,
  product_id: `p${id}`,
  product_name: name,
  product_sku: null,
  unit_price: 23,
  quantity: 1,
  subtotal: 23,
  tax_amount: 0,
  total: 23,
  addons: [{ name: 'Garlic', price: 1.25 }],
  special_instructions: 'Ring the bell',
  status: 'pending',
  ...more,
});
const orderWith = (items: unknown[]): any => ({
  id: 1,
  order_number: 'P-1',
  created_at: '2026-01-01T12:00:00.000Z',
  type: 'takeaway',
  items,
});
const billFor = (order: any): any => ({
  id: 1,
  bill_number: 'B-1',
  subtotal: 48.5,
  discount_amount: 0,
  tax_amount: 0,
  total: 48.5,
  payment_details: [{ method: 'cash', amount: 48.5 }],
  order,
});
const tenant = { business_name: 'Pizza Test', country: 'US', currency: 'USD', timezone: 'UTC' };

const RECIPE_ITEMS = [
  { name: 'Half & Half', recipe: HALF_AND_HALF },
  { name: 'Large Pizzas & Wings', recipe: THREE_PIZZA_DEAL },
];
const recipeOrder = orderWith(
  RECIPE_ITEMS.map((entry, index) =>
    item(index + 1, entry.name, { modifier_selection: entry.recipe }),
  ),
);
const plainOrder = orderWith([item(1, 'Half & Half'), item(2, 'Large Pizzas & Wings')]);

const browserKot = (order: any, columns: number): Uint8Array =>
  frontend.kotEncoder.buildKotBytes(
    order,
    {
      columns,
      paperWidth: paperOf(columns),
      stationName: 'Kitchen',
      language: 'en',
      timezone: 'UTC',
    },
    [],
  );
const rasterKotDocument = (order: any, columns: number) =>
  frontend.printDocument.buildFrontendKotDocument(order, {
    stationName: 'Kitchen',
    columns,
    language: 'en',
    timezone: 'UTC',
  });
const htmlKot = (order: any, options: object = {}): string =>
  frontend.kotWebPrint.generateKotHtml(order, {
    paperWidth: 80,
    language: 'en',
    stationName: 'Kitchen',
    timezone: 'UTC',
    ...options,
  });
const receiptOptions = (columns: number) => ({
  columns,
  paperWidth: paperOf(columns),
  languages: ['en'] as const,
});
const receipts: Record<string, (order: any, columns: number) => Uint8Array> = {
  'browser classic': (order, columns) =>
    frontend.receiptEncoder.buildClassicReceiptBytes(
      billFor(order),
      tenant as any,
      receiptOptions(columns) as any,
      [],
    ),
  'browser compact': (order, columns) =>
    frontend.receiptEncoder.buildCompactReceiptBytes(
      billFor(order),
      tenant as any,
      receiptOptions(columns) as any,
      [],
    ),
};

const sha = (value: Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : Buffer.from(value))
    .digest('hex')
    .slice(0, 16);

/**
 * Output of every browser path, hashed from the code as it was before these
 * paths read a recipe. Nothing printed a recipe then, so the order whose items
 * carry one and the order whose items do not gave the same bytes. Print the
 * current values with `PIZZA_KOT_BROWSER_BASELINE=print npm run test:pizza-kot-browser`.
 */
const BASELINE: Record<string, string> = {
  'kitchen ticket, browser HTML': '1fb411bc9075d737',
  'kitchen ticket, browser HTML, 58 mm': 'd16488b262059ba0',
  'kitchen ticket, browser ESC/POS, 32 columns': '4df009d02493d810',
  'kitchen ticket, raster document, 32 columns': 'c3fa2399a45058d8',
  'receipt, browser classic, 32 columns': '72c6518f817a437c',
  'receipt, browser compact, 32 columns': '9830477e7f96173f',
  'kitchen ticket, browser ESC/POS, 42 columns': 'a4580e20d495a1ac',
  'kitchen ticket, raster document, 42 columns': 'c3fa2399a45058d8',
  'receipt, browser classic, 42 columns': 'ea71a9c9fc44ed96',
  'receipt, browser compact, 42 columns': '86805e108d9579cf',
  'kitchen ticket, browser ESC/POS, 48 columns': 'e90a6c461d6eb01a',
  'kitchen ticket, raster document, 48 columns': 'c3fa2399a45058d8',
  'receipt, browser classic, 48 columns': '95b0c0b036d1aad8',
  'receipt, browser compact, 48 columns': '5d76b9743697454a',
};

function outputs(order: any): Record<string, string> {
  const result: Record<string, string> = {
    'kitchen ticket, browser HTML': sha(htmlKot(order)),
    'kitchen ticket, browser HTML, 58 mm': sha(htmlKot(order, { paperWidth: 58 })),
  };
  for (const columns of BASELINE_COLUMNS) {
    result[`kitchen ticket, browser ESC/POS, ${columns} columns`] = sha(browserKot(order, columns));
    result[`kitchen ticket, raster document, ${columns} columns`] = sha(
      JSON.stringify(rasterKotDocument(order, columns)),
    );
    for (const [name, render] of Object.entries(receipts)) {
      result[`receipt, ${name}, ${columns} columns`] = sha(render(order, columns));
    }
  }
  return result;
}

if (process.env.PIZZA_KOT_BROWSER_BASELINE === 'print') {
  console.log(
    JSON.stringify({ plain: outputs(plainOrder), recipe: outputs(recipeOrder) }, null, 2),
  );
  process.exit(0);
}

function unchanged(order: any, message: string) {
  const printed = outputs(order);
  assertEqualOrThrow(
    Object.keys(printed).length,
    Object.keys(BASELINE).length,
    'every path has a recorded baseline',
  );
  for (const [path, hash] of Object.entries(printed)) {
    assertEqualOrThrow(hash, BASELINE[path], `${message}: ${path}`);
  }
}

/** What `ticketLines` gives each recipe item at this width. */
const expected = (columns: number): string[][] =>
  RECIPE_ITEMS.map((entry) => ticketLines(catalog, entry.recipe, columns).detailLines);

/** Asserts that each item's lines print, indented, between its heading and its add-on. */
function printsUnderEachItem(printed: string[], columns: number, path: string) {
  let cursor = 0;
  expected(columns).forEach((lines, index) => {
    const name = RECIPE_ITEMS[index].name;
    const heading = printed.findIndex((row, at) => at >= cursor && row.includes(name));
    assertOrThrow(heading >= 0, `${path} ${columns}: "${name}" prints`);
    const first = printed.indexOf(INDENT + lines[0], heading);
    assertOrThrow(first > heading, `${path} ${columns}: detail lines follow "${name}"`);
    assertEqualOrThrow(
      JSON.stringify(printed.slice(first, first + lines.length)),
      JSON.stringify(lines.map((line) => INDENT + line)),
      `${path} ${columns}: "${name}" prints the lines ticketLines gives, in order`,
    );
    const addon = printed.findIndex((row, at) => at > heading && row.includes('Garlic'));
    assertOrThrow(
      addon >= first + lines.length,
      `${path} ${columns}: the add-on of "${name}" prints after its detail lines`,
    );
    cursor = addon;
  });
}

/** Asserts that the HTML ticket carries each item's lines for this many columns, in order. */
function htmlCarries(html: string, columns: number, label: string) {
  let cursor = 0;
  expected(columns).forEach((lines, index) => {
    cursor = html.indexOf(escapeHtml(RECIPE_ITEMS[index].name), cursor);
    assertOrThrow(cursor >= 0, `${label}: the heading of item ${index + 1} is present`);
    for (const line of lines) {
      const at = html.indexOf(`>${escapeHtml(line)}<`, cursor);
      assertOrThrow(at > cursor, `${label}: "${line}" follows in order, unchanged`);
      cursor = at;
    }
    const addon = html.indexOf('Garlic', cursor);
    assertOrThrow(addon > cursor, `${label}: the add-on follows the detail lines`);
    cursor = addon;
  });
}

/** Asserts that every browser path prints the one warning line under each item of `order`. */
function warnsUnderEachItem(order: any, label: string) {
  const count = order.items.length;
  const warned = (printed: string[], path: string) =>
    assertEqualOrThrow(
      printed.filter((row) => row === INDENT + RECIPE_NOT_PRINTED).length,
      count,
      `${label}: ${path} prints the warning under each item`,
    );
  for (const columns of COLUMNS) {
    warned(rows(browserKot(order, columns)), `browser ESC/POS ${columns}`);
    for (const [name, render] of Object.entries(receipts)) {
      warned(rows(render(order, columns)), `${name} ${columns}`);
    }
    const document = rasterKotDocument(order, columns);
    assertEqualOrThrow(
      JSON.stringify(
        document.blocks[1].rows.map((row: any) =>
          (row.detailLines ?? []).map((line: { text: string }) => line.text),
        ),
      ),
      JSON.stringify(order.items.map(() => [RECIPE_NOT_PRINTED])),
      `${label}: raster ${columns} carries the warning on each row`,
    );
  }
  assertEqualOrThrow(
    htmlKot(order).split(`>${RECIPE_NOT_PRINTED}<`).length - 1,
    count,
    `${label}: the HTML ticket carries the warning under each item`,
  );
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

runCases('pizza-kot-browser', {
  'Case 1: the fixtures are a half and half with removals and a three-pizza deal': () => {
    assertEqualOrThrow(
      JSON.stringify(expected(42)[0]),
      JSON.stringify([
        '1ST: ISLAND',
        '  NO PINEAPPLE',
        '2ND: GARDEN',
        '  NO OLIVES, NO ONIONS',
        'WELL DONE',
      ]),
      'the half and half',
    );
    assertEqualOrThrow(
      JSON.stringify(expected(42)[1]),
      JSON.stringify([
        '1) LARGE GARDEN',
        '   NO OLIVES',
        '2) LARGE HALF & HALF',
        '   1ST: ISLAND',
        '   2ND: PLAIN CHEESE',
        '3) LARGE CLASSIC PEPPERONI',
        'WINGS: SWEET CHILI',
        'INCLUDES: ANY 3 LARGE PIZZAS & 12 WINGS',
      ]),
      'the three-pizza deal',
    );
  },

  'Case 2: with no catalogue loaded, a recipe prints the warning line and nothing else changes':
    () => {
      assertEqualOrThrow(pizzaCatalog().getPizzaCatalog(), null, 'no catalogue is loaded yet');
      unchanged(plainOrder, 'no catalogue, no recipe');
      warnsUnderEachItem(recipeOrder, 'no catalogue');
      const readyMade = orderWith(
        recipeOrder.items.map((entry: object) => ({ ...entry, detailLines: ['FROM THE SERVER'] })),
      );
      const printed = rows(browserKot(readyMade, 42));
      assertOrThrow(
        printed.includes(INDENT + 'FROM THE SERVER') &&
          !printed.includes(INDENT + RECIPE_NOT_PRINTED),
        'no catalogue: the lines the item carries print, with no warning',
      );
    },

  'Case 3: the catalogue loads from the API': async () => {
    const originalGet = frontend.api.get;
    frontend.api.get = async (url: string) => {
      assertEqualOrThrow(url, '/pizza/catalog', 'the catalogue route');
      return { data: catalog };
    };
    try {
      await pizzaCatalog().loadPizzaCatalog();
    } finally {
      frontend.api.get = originalGet;
    }
    assertEqualOrThrow(pizzaCatalog().getPizzaCatalog(), catalog, 'the catalogue is readable');
  },

  'Case 4: an item without a recipe prints byte for byte as before': () => {
    unchanged(plainOrder, 'a catalogue, no recipe');
    for (const modifier_selection of [null, 'not json', { kind: 'side' }, { size: 'large' }, 7]) {
      const order = orderWith(
        plainOrder.items.map((entry: object) => ({ ...entry, modifier_selection })),
      );
      unchanged(
        order,
        `modifier_selection = ${JSON.stringify(modifier_selection)} is not a recipe`,
      );
    }
  },

  'Case 4b: a recipe ticketLines cannot write out prints the warning line': () => {
    for (const modifier_selection of [{ kind: 'pizza' }, '{"kind":"deal"}']) {
      warnsUnderEachItem(
        orderWith(plainOrder.items.map((entry: object) => ({ ...entry, modifier_selection }))),
        `modifier_selection = ${JSON.stringify(modifier_selection)}`,
      );
    }
    const plainPizza = { kind: 'pizza', v: 1, sizeId: 'large', whole: part('garden') };
    unchanged(
      orderWith(
        plainOrder.items.map((entry: object) => ({ ...entry, modifier_selection: plainPizza })),
      ),
      'a whole pizza with nothing removed has no lines and no warning',
    );
  },

  'Case 5: the browser ESC/POS ticket prints the lines ticketLines gives': () => {
    for (const columns of COLUMNS) {
      printsUnderEachItem(rows(browserKot(recipeOrder, columns)), columns, 'browser ESC/POS');
    }
  },

  'Case 6: the raster ticket document carries the same lines': () => {
    for (const columns of COLUMNS) {
      const document = rasterKotDocument(recipeOrder, columns);
      assertOrThrow(isKotDocument(document), `raster ${columns}: the document is still valid`);
      expected(columns).forEach((lines, index) => {
        const row = document.blocks[1].rows[index] as any;
        assertEqualOrThrow(
          JSON.stringify((row.detailLines ?? []).map((line: { text: string }) => line.text)),
          JSON.stringify(lines),
          `raster ${columns}: row ${index + 1} carries the lines ticketLines gives`,
        );
      });
    }
  },

  'Case 7: the browser HTML ticket carries the same lines': () => {
    for (const columns of COLUMNS) {
      htmlCarries(htmlKot(recipeOrder, { columns }), columns, `html ${columns}`);
    }
    htmlCarries(htmlKot(recipeOrder), 42, 'html, 80 mm paper and no column count');
    htmlCarries(htmlKot(recipeOrder, { paperWidth: 58 }), 32, 'html, 58 mm paper');
  },

  'Case 7b: the HTML ticket wraps for the columns its text size leaves': () => {
    for (const columns of COLUMNS) {
      htmlCarries(
        htmlKot(recipeOrder, { columns, textSize: 'large' }),
        columns,
        `html ${columns}, large text keeps every column`,
      );
      htmlCarries(
        htmlKot(recipeOrder, { columns, textSize: 'extra_large' }),
        columns / 2,
        `html ${columns}, extra large text has half the columns`,
      );
    }
    htmlCarries(
      htmlKot(recipeOrder, { paperWidth: 58, textSize: 'extra_large' }),
      16,
      'html, 58 mm paper at extra large text',
    );
  },

  'Case 8: the browser classic and compact receipts print the same lines': () => {
    for (const columns of COLUMNS) {
      for (const [name, render] of Object.entries(receipts)) {
        const document = frontend.printDocument.buildFrontendBillDocument(
          billFor(recipeOrder),
          tenant,
          { columns, languages: ['en'] },
        );
        assertOrThrow(isPrintDocument(document), `${name} ${columns}: the document is valid`);
        printsUnderEachItem(rows(render(recipeOrder, columns)), columns, name);
      }
    }
  },

  'Case 9: ready-made lines on the item print as given, and a recipe never adds to them': () => {
    const order = orderWith(
      recipeOrder.items.map((entry: object) => ({ ...entry, detailLines: ['FROM THE SERVER'] })),
    );
    for (const columns of COLUMNS) {
      const printed = rows(browserKot(order, columns));
      assertEqualOrThrow(
        printed.filter((row) => row === INDENT + 'FROM THE SERVER').length,
        order.items.length,
        `${columns}: the lines the server supplied print under each item`,
      );
      for (const lines of expected(columns)) {
        assertOrThrow(
          !printed.includes(INDENT + lines[0]),
          `${columns}: the catalogue held now does not write the recipe out again`,
        );
      }
    }
    const blank = orderWith(
      recipeOrder.items.map((entry: object) => ({ ...entry, detailLines: ['', '  '] })),
    );
    printsUnderEachItem(rows(browserKot(blank, 42)), 42, 'blank ready-made lines, browser ESC/POS');
  },

  'Case 10: an id the menu no longer has still prints, as the id': () => {
    const order = orderWith([
      item(1, 'Half & Half', {
        modifier_selection: { ...HALF_AND_HALF, halves: [part('retired'), part('garden')] },
      }),
    ]);
    const printed = rows(browserKot(order, 42));
    assertOrThrow(printed.includes(INDENT + '1ST: RETIRED'), 'the first half prints its id');
    assertOrThrow(printed.includes(INDENT + '2ND: GARDEN'), 'the second half prints its name');
  },

  'Case 11: a deal prints the description it was sold with, not the menu held now': async () => {
    const changed = JSON.parse(JSON.stringify(catalog));
    changed.deals.find((deal: any) => deal.id === 'three-large-wings').description =
      'Any 3 large pizzas & 6 wings';
    const hold = async (held: unknown) => {
      const originalGet = frontend.api.get;
      frontend.api.get = async () => ({ data: held });
      try {
        await pizzaCatalog().reloadPizzaCatalog();
      } finally {
        frontend.api.get = originalGet;
      }
      assertEqualOrThrow(pizzaCatalog().getPizzaCatalog(), held, 'the browser holds that menu');
    };
    await hold(changed);
    try {
      const sold = orderWith([
        item(1, 'Large Pizzas & Wings', {
          modifier_selection: { ...THREE_PIZZA_DEAL, includes: 'Any 3 large pizzas & 12 wings' },
        }),
      ]);
      const printed = {
        'browser ESC/POS': rows(browserKot(sold, 42)),
        'browser HTML': [htmlKot(sold)],
        'browser classic': rows(receipts['browser classic'](sold, 42)),
      };
      for (const [name, text] of Object.entries(printed)) {
        assertOrThrow(text.join('\n').includes('12 WINGS'), `${name}: the sold description prints`);
        assertOrThrow(!text.join('\n').includes('6 WINGS'), `${name}: the held one does not`);
      }
    } finally {
      await hold(catalog);
    }
  },
});
