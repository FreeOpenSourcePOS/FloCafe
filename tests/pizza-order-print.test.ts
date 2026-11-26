/**
 * The recipe on an order line, on the server print paths and the kitchen
 * display: the kitchen ticket and the classic, compact, merchant-template and
 * tax-pack receipts print the recipe's detail lines under FloCafe's own item heading,
 * wrapped for the printer's real column count; a recipe that cannot be printed
 * leaves a warning line; and a restricted station's item carries the recipe.
 *
 * Run: npm run test:pizza-order-print
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  rows,
  runCases,
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  api,
} = require('./helpers/pizza-print-harness');
const { seedPizzaMenu, writePizzaMenu } = require('./helpers/pizza-fixture');
const net = require('node:net');
const { projectKdsItem } = require('../main/db');
const {
  printKOTDetailed,
  prepareReceipt,
  renderPluginReceipt,
} = require('../main/printers/thermal');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { getEffectiveOrderItems, printerRoutes } = require('../main/routes/printers');
const {
  activateMerchantPrintTemplate,
  createMerchantPrintTemplate,
} = require('../main/services/merchant-print-templates');
const { serializeBillTemplateSelection } = require('../main/services/print-templates');
const { ticketLines } = require('../shared/pizza/ticket');

const INDENT = '   ';
const NOT_PRINTED = `${INDENT}RECIPE NOT PRINTED - CHECK ORDER`;
const whole = (pizzaId: string, removed: string[] = []) => ({
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  whole: { pizzaId, removed },
});
const half = {
  kind: 'pizza',
  v: 1,
  sizeId: 'large',
  halves: [
    { pizzaId: 'island', removed: ['Pineapple'] },
    { pizzaId: 'classic', removed: [] },
  ],
};
const threeLarge = {
  kind: 'deal',
  v: 1,
  dealId: 'three-large-wings',
  pizzas: [
    whole('garden', ['Olives']),
    {
      kind: 'pizza',
      v: 1,
      sizeId: 'large',
      halves: [
        { pizzaId: 'island', removed: [] },
        { pizzaId: 'plain', removed: [] },
      ],
    },
    whole('classic'),
  ],
  wingFlavour: 'sweet-chili',
};

// The contract's ticket text; every line fits 42 and 48 columns.
const HALF_LINES = ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC PEPPERONI'];
// At extra large text a 48-column printer lays out 24: the long second half wraps.
const HALF_LINES_24 = ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC', 'PEPPERONI'];
const DEAL_LINES = [
  '1) LARGE GARDEN',
  '   NO OLIVES',
  '2) LARGE HALF & HALF',
  '   1ST: ISLAND',
  '   2ND: PLAIN CHEESE',
  '3) LARGE CLASSIC PEPPERONI',
  'WINGS: SWEET CHILI',
  'INCLUDES: ANY 3 LARGE PIZZAS & 12 WINGS',
];

/** Paper and text size as stored on a printer, and the columns layout gets for them. */
const PRINTERS = [
  { label: '42 columns', paper_width: 'cols-42', text_size: 'normal', columns: 42 },
  { label: '48 columns', paper_width: 'cols-48', text_size: 'normal', columns: 48 },
  { label: '48 columns, large text', paper_width: 'cols-48', text_size: 'large', columns: 48 },
  {
    label: '48 columns, extra large text',
    paper_width: 'cols-48',
    text_size: 'extra_large',
    columns: 24,
  },
];
const business = { name: 'Sample Pizza Co.', country: 'US', currency: 'USD', timezone: 'UTC' };
/** A receipt template as a tax pack installs it, with the renderer's default layout. */
const taxPackTemplate = {
  template_id: 'sample-pack-receipt',
  renderer_json: JSON.stringify({ id: 'flocafe-thermal-receipt-template', version: 1 }),
  template_payload_json: JSON.stringify({
    format: 'escpos-line-template-v1',
    widthProfiles: [42, 48].map((columns) => ({ columns, layout: {} })),
  }),
};

/** A loopback socket that stands in for a network printer and keeps what it is sent. */
async function startCapturePrinter() {
  const jobs: Buffer[] = [];
  const server = net.createServer((socket: any) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => jobs.push(Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    printer: {
      id: 'capture',
      name: 'Capture',
      connection_type: 'network',
      ip_address: '127.0.0.1',
      port: server.address().port,
    },
    async lastJob(): Promise<string[]> {
      for (let waited = 0; jobs.length === 0 && waited < 5000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return rows(jobs.pop() ?? Buffer.alloc(0));
    },
  };
}

/** Checks that `lines` print in order, indented and unchanged, and returns the row above them. */
function assertDetailRows(printed: string[], lines: string[], label: string): string {
  const first = printed.indexOf(INDENT + lines[0]);
  assertOrThrow(first > 0, `${label}: the first detail line prints`);
  assertEqualOrThrow(
    JSON.stringify(printed.slice(first, first + lines.length)),
    JSON.stringify(lines.map((line) => INDENT + line)),
    `${label}: the detail lines print in order, unchanged`,
  );
  return printed[first - 1];
}

async function main() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const catalog = seedPizzaMenu(db);
  const { baseUrl } = await startServer(
    createApp({
      '/api/orders': orderRoutes,
      '/api/bills': billRoutes,
      '/api/printers': printerRoutes,
    }),
  );
  const template = createMerchantPrintTemplate(
    {
      name: 'Recipe lines',
      payload: require('./fixtures/merchant-templates/golden-receipt-v1.json'),
    },
    owner.userId,
  );
  activateMerchantPrintTemplate(template.id, owner.userId);
  const merchant = serializeBillTemplateSelection({ source: 'merchant', id: template.id });
  const capture = await startCapturePrinter();
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, ip_address, port, is_default)
     VALUES ('capture', 'Capture', 'network', '127.0.0.1', ?, 1)`,
  ).run(capture.printer.port);

  const post = (path: string, body: object) =>
    api(baseUrl, path, { method: 'POST', body, headers: owner.authHeader });
  /** An order placed through the API, loaded back the way the print routes load it. */
  async function placedOrder(items: object[]) {
    const created = await post('/api/orders', { type: 'takeaway', items });
    assertEqualOrThrow(created.status, 201, 'the order is accepted');
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(created.data.order.id) as any;
    order.items = getEffectiveOrderItems(db, String(order.id));
    const bill = (await post('/api/bills/generate', { order_id: order.id })).data.bill;
    return { order, bill };
  }
  /** Stores a paper width and text size on the printer the server prints to. */
  function usePrinter(printer: (typeof PRINTERS)[number]) {
    db.prepare('UPDATE printers SET paper_width = ?, text_size = ?').run(
      printer.paper_width,
      printer.text_size,
    );
    return db.prepare("SELECT * FROM printers WHERE id = 'capture'").get();
  }
  /** The ticket and the three receipts for one stored printer configuration, as printed rows. */
  async function printAll(placed: { order: any; bill: any }, printer: (typeof PRINTERS)[number]) {
    const stored = usePrinter(printer);
    const ticket = await printKOTDetailed(placed.order, placed.order.items, 'Kitchen', false, {
      ...stored,
    });
    assertOrThrow(ticket.ok, `${printer.label}: the kitchen ticket is sent`);
    const receipt = (selection: string) => {
      const prepared = prepareReceipt(placed.order, placed.bill, business, selection);
      assertEqualOrThrow(prepared.columns, printer.columns, `${printer.label}: layout columns`);
      assertOrThrow(
        !prepared.warnings.some((warning: any) => warning.field === 'bill_template'),
        `${printer.label}: the selected template is the one rendered`,
      );
      return rows(prepared.data);
    };
    return {
      'kitchen ticket': await capture.lastJob(),
      'classic receipt': receipt('classic'),
      'compact receipt': receipt('compact'),
      'merchant receipt': receipt(merchant),
      'tax-pack receipt': rows(
        renderPluginReceipt(
          taxPackTemplate,
          placed.order,
          placed.bill,
          business,
          printer.columns,
          false,
          false,
          'full',
        ),
      ),
    };
  }

  await runCases('pizza-order-print', {
    'Case 1: a half and half and a three-pizza deal print their detail lines': async () => {
      const placed = await placedOrder([
        {
          product_id: 'pz-half-and-half',
          variant_id: 'pz-half-and-half-large',
          quantity: 1,
          modifier_selection: half,
        },
        { product_id: 'dl-three-large-wings', quantity: 1, modifier_selection: threeLarge },
      ]);
      for (const printer of PRINTERS) {
        const budget = printer.columns - INDENT.length;
        const expected = (recipe: object, contract: string[]) => {
          const lines = ticketLines(catalog, recipe, printer.columns).detailLines;
          assertOrThrow(
            lines.every((line: string) => line.length <= budget),
            `${printer.label}: no detail line is wider than the columns less three`,
          );
          const fits = contract.every((line) => line.length <= budget);
          if (fits) return contract;
          assertOrThrow(lines.length > contract.length, `${printer.label}: long lines wrap`);
          return lines;
        };
        if (printer.columns === 24) {
          assertEqualOrThrow(
            JSON.stringify(expected(half, HALF_LINES)),
            JSON.stringify(HALF_LINES_24),
            `${printer.label}: the half and half is wrapped for 24 columns`,
          );
        }
        const documents = await printAll(placed, printer);
        for (const [name, printed] of Object.entries(documents)) {
          const label = `${name}, ${printer.label}`;
          const aboveHalf = assertDetailRows(printed, expected(half, HALF_LINES), `${label}, half`);
          const aboveDeal = assertDetailRows(
            printed,
            expected(threeLarge, DEAL_LINES),
            `${label}, deal`,
          );
          assertOrThrow(
            !printed.join('\n').includes('LARGE PIZZAS & WINGS'),
            `${label}: the heading is not replaced by the recipe's`,
          );
          // The item column of a receipt wraps a name; the ticket heading has the full width.
          if (name === 'kitchen ticket') {
            assertOrThrow(
              /^1x\s+Half & Half/.test(aboveHalf),
              `${label}: lines follow the heading`,
            );
            assertOrThrow(/^1x\s+Large Pizzas/.test(aboveDeal), `${label}: lines follow the deal`);
          } else if (printer.columns >= 42) {
            assertOrThrow(/^Half & Half/.test(aboveHalf), `${label}: lines follow the name`);
            assertOrThrow(
              /^Large Pizzas & Wings/.test(aboveDeal),
              `${label}: lines follow the deal`,
            );
          }
        }
      }
    },

    'Case 2: a line without a recipe prints as before': async () => {
      const plain = [
        { product_id: 'pz-garden', variant_id: 'pz-garden-large', quantity: 1 },
        { product_id: 'sd-green-salad', quantity: 2, modifier_selection: { kind: 'note', a: 1 } },
      ];
      const placed = await placedOrder(plain);
      const withRecipe = await placedOrder([
        ...plain,
        {
          product_id: 'pz-island',
          variant_id: 'pz-island-large',
          quantity: 1,
          modifier_selection: whole('island', ['Ham']),
        },
      ]);
      for (const printer of [PRINTERS[0], PRINTERS[3]]) {
        const documents = await printAll(placed, printer);
        const beside = await printAll(withRecipe, printer);
        for (const [name, printed] of Object.entries(documents)) {
          const label = `${name}, ${printer.label}`;
          assertOrThrow(
            printed.some((row) => row.includes('Garden')) &&
              printed.some((row) => row.includes('Salad')),
            `${label}: both items print`,
          );
          assertOrThrow(
            !printed.some((row) => /^ {3}\S/.test(row)),
            `${label}: no detail line is added`,
          );
          const other = (beside as Record<string, string[]>)[name];
          const detail = other.filter((row) => /^ {3}\S/.test(row));
          assertEqualOrThrow(
            JSON.stringify(detail),
            JSON.stringify([`${INDENT}NO HAM`]),
            `${label}: beside a pizza with a recipe, only that pizza gains a line`,
          );
        }
      }

      // Lines the item already carries still print when it has no recipe.
      placed.order.items[1].detailLines = ['DRESSING ON THE SIDE'];
      const own = await printAll(placed, PRINTERS[0]);
      for (const [name, printed] of Object.entries(own)) {
        assertOrThrow(
          printed.includes(`${INDENT}DRESSING ON THE SIDE`),
          `${name}: an item's own detail lines still print`,
        );
      }
    },

    'Case 3: a restricted kitchen display station gets the recipe': async () => {
      const { order } = await placedOrder([
        {
          product_id: 'pz-half-and-half',
          variant_id: 'pz-half-and-half-large',
          quantity: 1,
          modifier_selection: half,
        },
      ]);
      const projected = projectKdsItem(order.items[0], true);
      assertEqualOrThrow(
        JSON.stringify(projected.modifier_selection),
        JSON.stringify(half),
        'the projected item carries the recipe',
      );
      assertOrThrow(!('unit_price' in projected), 'and still no price');

      // Some kitchen display routes hand the stored text over unparsed.
      const text = JSON.stringify(half);
      assertEqualOrThrow(
        projectKdsItem({ ...order.items[0], modifier_selection: text }, true).modifier_selection,
        text,
        'a recipe still stored as text is carried as it is',
      );
      for (const other of [{ kind: 'note', price: 5 }, '{"kind":"note"}', 'not json', null]) {
        assertEqualOrThrow(
          projectKdsItem({ ...order.items[0], modifier_selection: other }, true).modifier_selection,
          null,
          `anything that is not a recipe is projected as null: ${JSON.stringify(other)}`,
        );
      }
    },

    'Case 4: a recipe that cannot be printed leaves a warning line on the ticket': async () => {
      const line = (productId: string, recipe: object) => ({
        product_id: `pz-${productId}`,
        variant_id: `pz-${productId}-large`,
        quantity: 1,
        modifier_selection: recipe,
      });
      const placed = await placedOrder([
        line('garden', whole('garden', ['Olives'])),
        line('classic', whole('classic', ['Pepperoni'])),
        line('island', whole('island', ['Ham'])),
      ]);
      const warned: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '));
      try {
        // None of these can be written out.
        usePrinter(PRINTERS[0]);
        const [garden] = placed.order.items;
        const part = { pizzaId: 'garden', removed: [] };
        const malformed: Record<string, object> = {
          'a pizza with neither a whole nor halves': { kind: 'pizza' },
          'removals that are text, not a list': {
            ...garden.modifier_selection,
            whole: { pizzaId: 'garden', removed: 'Olives' },
          },
          'removals that are a number': {
            ...garden.modifier_selection,
            whole: { pizzaId: 'garden', removed: 5 },
          },
          'no removals list at all': {
            ...garden.modifier_selection,
            whole: { pizzaId: 'garden' },
          },
          'only one half': { kind: 'pizza', v: 1, sizeId: 'large', halves: [part] },
          'both a whole and halves': { ...garden.modifier_selection, halves: [part, part] },
          'a deal with no pizza list': { kind: 'deal', v: 1, dealId: 'party' },
          'a deal holding an empty pizza': { kind: 'deal', v: 1, dealId: 'party', pizzas: [{}] },
          'a deal whose pops are a number': {
            kind: 'deal',
            v: 1,
            dealId: 'party',
            pizzas: [],
            pops: 3,
          },
        };
        // Lines stored in a shape that cannot be written out, as damaged data would be. The
        // request still carries the readable recipes the browser last saw.
        const shapes = Object.keys(malformed);
        const damaged = await placedOrder([
          ...shapes.map(() => line('garden', whole('garden', ['Olives']))),
          line('island', whole('island', ['Ham'])),
        ]);
        const badItems = damaged.order.items.slice(0, shapes.length);
        badItems.forEach((item: any, index: number) =>
          db
            .prepare('UPDATE order_items SET modifier_selection = ? WHERE id = ?')
            .run(JSON.stringify(malformed[shapes[index]]), item.id),
        );
        const sent = await post('/api/printers/print-kot', {
          orderId: damaged.order.id,
          stationName: 'Kitchen',
          items: damaged.order.items,
        });
        assertEqualOrThrow(sent.status, 200, 'stored lines: the ticket is sent');
        const ticket = await capture.lastJob();
        assertEqualOrThrow(
          ticket.filter((row) => row === NOT_PRINTED).length,
          badItems.length,
          'stored lines: each unreadable recipe leaves the warning line',
        );
        assertOrThrow(ticket.includes(`${INDENT}NO HAM`), 'stored lines: the good recipe prints');
        assertOrThrow(!ticket.join('\n').includes('NO OLIVES'), 'stored lines: nothing is guessed');
        // A raster-capable printer renders the ticket twice, so each is logged at least once.
        shapes.forEach((shape, index) => {
          assertOrThrow(
            warned.some((entry) => entry.includes(`order item ${badItems[index].id}:`)),
            `stored lines: the log names the item with ${shape}`,
          );
        });
        assertOrThrow(
          !warned.some((entry) => entry.includes(`order item ${damaged.order.items.at(-1).id}:`)),
          'stored lines: the good recipe is not logged',
        );

        // The stored menu is gone: no recipe can be written out.
        warned.length = 0;
        db.prepare('DELETE FROM pizza_menu').run();
        const documents = await printAll(placed, PRINTERS[0]);
        for (const [name, printed] of Object.entries(documents)) {
          assertEqualOrThrow(
            printed.filter((row) => row === NOT_PRINTED).length,
            3,
            `no menu, ${name}: every recipe line carries the warning`,
          );
          assertOrThrow(printed.join('\n').includes('Garden'), `no menu, ${name}: items print`);
        }
        assertOrThrow(warned.length >= 3, 'no menu: the failure is logged');
        assertOrThrow(warned[0].includes('menu is not loaded'), 'no menu: the log says why');
      } finally {
        console.warn = originalWarn;
        writePizzaMenu(db, JSON.stringify(catalog));
      }
    },

    'Case 4b: the ticket prints the saved lines, whatever item bodies the request carries':
      async () => {
        usePrinter(PRINTERS[0]);
        const garden = {
          product_id: 'pz-garden',
          variant_id: 'pz-garden-large',
          quantity: 2,
          modifier_selection: whole('garden', ['Olives']),
          special_instructions: 'Ring the bell',
        };
        const island = {
          product_id: 'pz-island',
          variant_id: 'pz-island-large',
          quantity: 1,
          modifier_selection: whole('island', ['Ham']),
        };
        const placed = await placedOrder([garden, island]);
        const other = await placedOrder([
          { ...island, modifier_selection: whole('island', ['Pineapple']) },
        ]);
        const [savedGarden] = placed.order.items;
        const print = async (items?: object[]) => {
          const sent = await post('/api/printers/print-kot', {
            orderId: placed.order.id,
            stationName: 'Kitchen',
            ...(items ? { items } : {}),
          });
          assertEqualOrThrow(sent.status, 200, 'the ticket is sent');
          return (await capture.lastJob()).join('\n');
        };

        // A browser that last saw the line before its removal was saved, and more besides.
        const stale = await print([
          {
            ...savedGarden,
            product_name: 'Free Pizza',
            quantity: 9,
            modifier_selection: whole('garden', []),
            special_instructions: 'No charge',
            addons: [{ name: 'Extra cheese', quantity: 1 }],
          },
          { ...savedGarden, id: 987654, product_name: 'Ghost Pizza' },
          other.order.items[0],
        ]);
        assertOrThrow(/2x\s+Garden/.test(stale), 'stale body: the saved name and quantity print');
        assertOrThrow(stale.includes(`${INDENT}NO OLIVES`), 'stale body: the saved removal prints');
        assertOrThrow(stale.includes('Ring the bell'), 'stale body: the saved note prints');
        for (const made of ['Free Pizza', '9x', 'No charge', 'Extra cheese', 'Ghost Pizza']) {
          assertOrThrow(
            !stale.includes(made),
            `stale body: "${made}" from the request is not printed`,
          );
        }
        assertOrThrow(
          !stale.includes('NO PINEAPPLE'),
          'stale body: a line of another order is not printed',
        );
        assertOrThrow(
          !stale.includes('NO HAM'),
          'the request still chooses the lines: one that was not asked for stays off the ticket',
        );

        const all = await print();
        assertOrThrow(
          all.includes(`${INDENT}NO OLIVES`) && all.includes(`${INDENT}NO HAM`),
          'with no items in the request, every saved line prints',
        );
      },

    'Case 4c: the print test gets a sample ticket the server owns, never an order': async () => {
      usePrinter(PRINTERS[0]);
      const placed = await placedOrder([
        {
          product_id: 'pz-garden',
          variant_id: 'pz-garden-large',
          quantity: 1,
          modifier_selection: whole('garden', ['Olives']),
        },
      ]);
      // With an order's id and lines beside the flag, the order is still not read.
      for (const body of [
        { sample: true },
        { sample: true, orderId: placed.order.id, items: placed.order.items },
        { sample: true, orderId: 987654 },
      ]) {
        const sent = await post('/api/printers/print-kot', { stationName: 'Kitchen', ...body });
        assertEqualOrThrow(sent.status, 200, 'the sample ticket is sent');
        const ticket = (await capture.lastJob()).join('\n');
        assertOrThrow(/2x\s+Sample Item/.test(ticket), 'it prints the sample item');
        assertOrThrow(ticket.includes('TEST-001'), 'under the sample order number');
        assertOrThrow(
          !ticket.includes('Garden') && !ticket.includes('NO OLIVES'),
          'and nothing of a real order',
        );
      }
      const live = await post('/api/printers/print-kot', { stationName: 'Kitchen' });
      assertEqualOrThrow(live.status, 400, 'without the flag, an order id is still required');
    },

    'Case 5: a stored recipe still prints after the menu has changed under it': async () => {
      const placed = await placedOrder([
        {
          product_id: 'pz-half-and-half',
          variant_id: 'pz-half-and-half-large',
          quantity: 1,
          modifier_selection: half,
        },
        {
          product_id: 'pz-garden',
          variant_id: 'pz-garden-large',
          quantity: 1,
          modifier_selection: whole('garden', ['Olives']),
        },
      ]);
      // Classic Pepperoni leaves the menu, and Garden's olives are renamed.
      const changed = {
        ...catalog,
        pizzas: catalog.pizzas
          .filter((pizza: any) => pizza.id !== 'classic')
          .map((pizza: any) => ({
            ...pizza,
            ingredients: pizza.ingredients.map((name: string) =>
              name === 'Olives' ? 'Black olives' : name,
            ),
          })),
      };
      const warned: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '));
      writePizzaMenu(db, JSON.stringify(changed));
      try {
        const documents = await printAll(placed, PRINTERS[0]);
        for (const [name, printed] of Object.entries(documents)) {
          // A pizza the menu no longer has prints by its id.
          assertDetailRows(
            printed,
            ['1ST: ISLAND', '  NO PINEAPPLE', '2ND: CLASSIC'],
            `${name}, removed pizza`,
          );
          assertOrThrow(
            printed.includes(`${INDENT}NO OLIVES`),
            `${name}: the removal prints under the name it was sold with`,
          );
          assertOrThrow(!printed.includes(NOT_PRINTED), `${name}: no warning line`);
        }
        assertEqualOrThrow(warned.length, 0, 'nothing is logged');
      } finally {
        console.warn = originalWarn;
        writePizzaMenu(db, JSON.stringify(catalog));
      }
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
