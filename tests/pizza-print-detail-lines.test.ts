/**
 * Detail lines on order items: ready-formatted text lines that every kitchen
 * ticket and customer receipt path prints under the item heading, before
 * add-ons.
 *
 * Run: npm run test:pizza-print-detail-lines
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  rows,
  runCases,
} = require('./helpers/pizza-print-harness');
const { createHash } = require('node:crypto');
const { renderKotViaDocument, renderKotDocumentToLines } = require('../main/printers/document-kot');
const { renderClassicReceiptViaDocument } = require('../main/printers/document-classic');
const { renderCompactReceiptViaDocument } = require('../main/printers/document-compact');
const { buildEscPos } = require('../main/printers/formatting-helpers');
const { isKotDocument, isPrintDocument } = require('../shared/print');

const frontend = loadFrontend();

const HEADING = 'LARGE (14") - THIN CRUST';
const DETAIL = [
  'HALF: PEPPERONI / HALF: HAWAIIAN',
  'WHOLE: + Extra Cheese, Well Done',
  'LEFT:  + Mushrooms',
  'RIGHT: NO PINEAPPLE, + Jalapenos',
];
const LONG =
  'WHOLE: + Extra Cheese, + Roasted Garlic, + Caramelized Onions, + Sun-Dried Tomatoes, Well Done!';
const INDENT = '   ';
const COLUMNS = [42, 48];

const item = (id: number, detailLines?: string[]) => ({
  id,
  order_id: 1,
  product_id: 'p1',
  product_name: HEADING,
  product_sku: null,
  unit_price: 24,
  quantity: 1,
  subtotal: 24,
  tax_amount: 0,
  total: 24,
  addons: [{ name: 'Garlic Dip', price: 1.5 }],
  special_instructions: 'Ring the bell',
  status: 'pending',
  ...(detailLines ? { detailLines } : {}),
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
  subtotal: 25.5,
  discount_amount: 0,
  tax_amount: 0,
  total: 25.5,
  payment_details: [{ method: 'cash', amount: 25.5 }],
  order,
});
const business = { name: 'Pizza Test', country: 'US', currency: 'USD', timezone: 'UTC' };
const tenant = { business_name: 'Pizza Test', country: 'US', currency: 'USD', timezone: 'UTC' };

const detailOrder = orderWith([item(1, DETAIL)]);
const longOrder = orderWith([item(1, [LONG])]);
const plainOrder = orderWith([item(1), item(2)]);

const kotOptions = (columns: number) => ({
  columns,
  language: 'en',
  timezone: 'UTC',
  useUnicode: false,
  arabicShaping: false,
  cutMode: 'partial' as const,
});
const receiptOptions = (columns: number) => ({ ...kotOptions(columns), isReprint: false });

const serverKot = (order: any, columns: number): Buffer =>
  renderKotViaDocument(order, order.items, 'Kitchen', kotOptions(columns)).data;
const browserKot = (order: any, columns: number): Uint8Array =>
  frontend.kotEncoder.buildKotBytes(
    order,
    { columns, paperWidth: 80, stationName: 'Kitchen', language: 'en', timezone: 'UTC' },
    [],
  );
const rasterKotDocument = (order: any, columns: number) =>
  frontend.printDocument.buildFrontendKotDocument(order, {
    stationName: 'Kitchen',
    columns,
    language: 'en',
    timezone: 'UTC',
  });
/** The raster path hands its document to the server renderer; render it the same way. */
const rasterKot = (order: any, columns: number): Buffer =>
  buildEscPos(
    renderKotDocumentToLines(rasterKotDocument(order, columns), kotOptions(columns)),
    false,
    { cutMode: 'partial', columns, language: 'en' },
  );
const htmlKot = (order: any): string =>
  frontend.kotWebPrint.generateKotHtml(order, {
    paperWidth: 80,
    language: 'en',
    stationName: 'Kitchen',
    timezone: 'UTC',
  });
const browserReceiptOptions = (columns: number) => ({
  columns,
  paperWidth: 80 as const,
  languages: ['en'] as const,
});
const receipts: Record<string, (order: any, columns: number) => Buffer | Uint8Array> = {
  'server classic': (order, columns) =>
    renderClassicReceiptViaDocument(order, billFor(order), business, receiptOptions(columns)).data,
  'server compact': (order, columns) =>
    renderCompactReceiptViaDocument(order, billFor(order), business, receiptOptions(columns)).data,
  'browser classic': (order, columns) =>
    frontend.receiptEncoder.buildClassicReceiptBytes(
      billFor(order),
      tenant as any,
      browserReceiptOptions(columns) as any,
      [],
    ),
  'browser compact': (order, columns) =>
    frontend.receiptEncoder.buildCompactReceiptBytes(
      billFor(order),
      tenant as any,
      browserReceiptOptions(columns) as any,
      [],
    ),
};

/** Rows printed for the first item of a kitchen ticket, heading first. */
function firstItemRows(bytes: Buffer | Uint8Array): string[] {
  const all = rows(bytes);
  const start = all.findIndex((row: string) => /^1x\s+LARGE/.test(row));
  assertOrThrow(start >= 0, 'the ticket prints the item heading');
  const end = all.findIndex((row: string, index: number) => index > start && row.trim() === '');
  return all.slice(start, end === -1 ? undefined : end);
}

/** Detail rows of the first item: everything between its heading and its add-on. */
function detailRows(bytes: Buffer | Uint8Array): string[] {
  const itemRows = firstItemRows(bytes);
  const addon = itemRows.findIndex((row) => row.includes('+ Garlic Dip'));
  assertOrThrow(addon > 0, 'the add-on prints after the heading');
  return itemRows.slice(1, addon);
}

const sha = (value: Buffer | Uint8Array | string): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : Buffer.from(value))
    .digest('hex')
    .slice(0, 16);

/**
 * Output of every path for an order whose items carry no `detailLines`,
 * hashed from the code as it was before detail lines existed. A hash moves
 * only when the ticket or receipt layout itself changes; print the current
 * values with `PIZZA_PRINT_BASELINE=print npm run test:pizza-print-detail-lines`.
 */
const BASELINE: Record<string, string> = {
  'kitchen ticket, browser HTML': 'dc72f935edf717c0',
  'kitchen ticket, server ESC/POS, 42 columns': '5d94a1879c051426',
  'kitchen ticket, browser ESC/POS, 42 columns': '6bf6743b916f9243',
  'kitchen ticket, raster document, 42 columns': '10f7976256b707ed',
  'receipt, server classic, 42 columns': 'a79729cedd49d405',
  'receipt, server compact, 42 columns': '0404f9100d60b9e1',
  'receipt, browser classic, 42 columns': '441e707ed6c4bdb1',
  'receipt, browser compact, 42 columns': '76b44e0bb057e4da',
  'kitchen ticket, server ESC/POS, 48 columns': '927de3995b2e4d9d',
  'kitchen ticket, browser ESC/POS, 48 columns': 'd8db0c3d9a1720b1',
  'kitchen ticket, raster document, 48 columns': '10f7976256b707ed',
  'receipt, server classic, 48 columns': '3d73e5281d5b1854',
  'receipt, server compact, 48 columns': 'e9faf9cf6bd184d4',
  'receipt, browser classic, 48 columns': '2fcc2b4f696dadb3',
  'receipt, browser compact, 48 columns': 'ac724e2acef13561',
};

function baselineOutputs(): Record<string, string> {
  const outputs: Record<string, string> = {
    'kitchen ticket, browser HTML': sha(htmlKot(plainOrder)),
  };
  for (const columns of COLUMNS) {
    outputs[`kitchen ticket, server ESC/POS, ${columns} columns`] = sha(
      serverKot(plainOrder, columns),
    );
    outputs[`kitchen ticket, browser ESC/POS, ${columns} columns`] = sha(
      browserKot(plainOrder, columns),
    );
    outputs[`kitchen ticket, raster document, ${columns} columns`] = sha(
      JSON.stringify(rasterKotDocument(plainOrder, columns)),
    );
    for (const [name, render] of Object.entries(receipts)) {
      outputs[`receipt, ${name}, ${columns} columns`] = sha(render(plainOrder, columns));
    }
  }
  return outputs;
}

if (process.env.PIZZA_PRINT_BASELINE === 'print') {
  console.log(JSON.stringify(baselineOutputs(), null, 2));
  process.exit(0);
}

runCases('pizza-print-detail-lines', {
  'Case 1: the five lines print in order and unchanged on both ESC/POS ticket paths': () => {
    assertEqualOrThrow(DETAIL[2], 'LEFT:  + Mushrooms', 'the fixture keeps two spaces after LEFT:');
    for (const columns of COLUMNS) {
      for (const [path, bytes] of [
        ['server', serverKot(detailOrder, columns)],
        ['browser', browserKot(detailOrder, columns)],
      ] as const) {
        const itemRows = firstItemRows(bytes);
        assertOrThrow(
          /^1x {1,2}LARGE \(14"\) - THIN CRUST$/.test(itemRows[0]),
          `${path} ${columns}: the heading prints unchanged`,
        );
        assertEqualOrThrow(
          JSON.stringify(itemRows.slice(1, 5)),
          JSON.stringify(DETAIL.map((line) => INDENT + line)),
          `${path} ${columns}: the four detail lines follow the heading, unchanged`,
        );
        assertOrThrow(
          itemRows[5].includes('+ Garlic Dip'),
          `${path} ${columns}: add-ons print after the detail lines`,
        );
      }
    }
  },

  'Case 2: the raster ticket document and the browser HTML ticket carry the same lines': () => {
    for (const columns of COLUMNS) {
      const document = rasterKotDocument(detailOrder, columns);
      assertOrThrow(isKotDocument(document), `raster ${columns}: the document is still valid`);
      const row = document.blocks[1].rows[0] as any;
      assertEqualOrThrow(
        JSON.stringify((row.detailLines ?? []).map((line: { text: string }) => line.text)),
        JSON.stringify(DETAIL),
        `raster ${columns}: the document row carries the detail lines`,
      );
      assertEqualOrThrow(
        JSON.stringify(detailRows(rasterKot(detailOrder, columns))),
        JSON.stringify(DETAIL.map((line) => INDENT + line)),
        `raster ${columns}: the server renderer prints them from the document`,
      );
    }
    const html = htmlKot(detailOrder);
    let cursor = html.indexOf('LARGE (14&quot;) - THIN CRUST');
    assertOrThrow(cursor >= 0, 'html: the heading is present');
    for (const line of DETAIL) {
      const at = html.indexOf(`>${line}<`, cursor);
      assertOrThrow(at > cursor, `html: "${line}" follows in order, unchanged`);
      cursor = at;
    }
    assertOrThrow(html.indexOf('+ Garlic Dip') > cursor, 'html: add-ons follow the detail lines');
    assertOrThrow(
      /white-space:\s*pre-wrap[^>]*>LEFT: {2}\+ Mushrooms</.test(html),
      'html: the detail line keeps its run of spaces when rendered',
    );
  },

  'Case 3: a 95-character line wraps the same way on server and browser, losing nothing': () => {
    assertEqualOrThrow(LONG.length, 95, 'the fixture line is 95 characters');
    for (const columns of COLUMNS) {
      const server = detailRows(serverKot(longOrder, columns));
      const browser = detailRows(browserKot(longOrder, columns));
      assertOrThrow(server.length > 1, `${columns}: the line wraps onto several rows`);
      assertEqualOrThrow(
        JSON.stringify(browser),
        JSON.stringify(server),
        `${columns}: server and browser wrap identically`,
      );
      assertEqualOrThrow(
        server.map((row) => row.trim()).join(' '),
        LONG,
        `${columns}: no text is lost`,
      );
      assertOrThrow(
        server.every((row) => row.startsWith(INDENT) && row.length <= columns),
        `${columns}: every row is indented and inside the width`,
      );
    }
  },

  'Case 3b: a line that spells a printer control token prints as text': () => {
    const order = orderWith([item(1, ['{CUT}', 'WHOLE: + Extra Cheese'])]);
    const renderers: Record<string, (columns: number) => Buffer | Uint8Array> = {
      'server ticket': (columns) => serverKot(order, columns),
      'raster ticket': (columns) => rasterKot(order, columns),
      'server classic receipt': (columns) => receipts['server classic'](order, columns),
      'server compact receipt': (columns) => receipts['server compact'](order, columns),
    };
    for (const [name, render] of Object.entries(renderers)) {
      const printed = rows(render(42));
      const token = printed.indexOf(INDENT + '{ CUT }');
      assertOrThrow(token >= 0, `${name}: the token is printed as text, not obeyed`);
      assertEqualOrThrow(
        printed[token + 1],
        INDENT + 'WHOLE: + Extra Cheese',
        `${name}: the next line still prints on the same ticket`,
      );
    }
  },

  'Case 4: classic and compact receipts print the lines under the item': () => {
    for (const columns of COLUMNS) {
      for (const [name, render] of Object.entries(receipts)) {
        const document = name.startsWith('server')
          ? null
          : frontend.printDocument.buildFrontendBillDocument(billFor(detailOrder), tenant, {
              columns,
              languages: ['en'],
            });
        if (document) assertOrThrow(isPrintDocument(document), `${name}: the document is valid`);
        const printed = rows(render(detailOrder, columns));
        const heading = printed.findIndex((row: string) => row.includes('LARGE (14")'));
        const first = printed.indexOf(INDENT + DETAIL[0]);
        assertOrThrow(heading >= 0, `${name} ${columns}: the item prints`);
        assertOrThrow(first > heading, `${name} ${columns}: detail lines follow the item`);
        assertEqualOrThrow(
          JSON.stringify(printed.slice(first, first + DETAIL.length)),
          JSON.stringify(DETAIL.map((line) => INDENT + line)),
          `${name} ${columns}: the four lines print in order, unchanged`,
        );
        assertOrThrow(
          printed.findIndex((row: string) => row.includes('+ Garlic Dip')) >= first + DETAIL.length,
          `${name} ${columns}: add-ons print after the detail lines`,
        );
      }
    }
  },

  'Case 5: an item without detailLines prints exactly as before, on every path': () => {
    const outputs = baselineOutputs();
    assertEqualOrThrow(
      Object.keys(outputs).length,
      Object.keys(BASELINE).length,
      'every path has a recorded baseline',
    );
    for (const [path, hash] of Object.entries(outputs)) {
      assertEqualOrThrow(hash, BASELINE[path], `${path}: unchanged`);
    }
    // An empty or malformed list is the same as no list.
    for (const detailLines of [[], ['   '], 'not a list', [42]]) {
      const order = orderWith([{ ...item(1), detailLines }, item(2)]);
      assertEqualOrThrow(
        sha(serverKot(order, 42)),
        BASELINE['kitchen ticket, server ESC/POS, 42 columns'],
        `server ticket ignores detailLines = ${JSON.stringify(detailLines)}`,
      );
      assertEqualOrThrow(
        sha(browserKot(order, 42)),
        BASELINE['kitchen ticket, browser ESC/POS, 42 columns'],
        `browser ticket ignores detailLines = ${JSON.stringify(detailLines)}`,
      );
    }
  },

  'Case: the print test asks the server for its own sample ticket, naming no order': async () => {
    const { usePrinterStore } = frontend.usePrinter;
    frontend.posSettings.usePosSettingsStore.getState().setKotPrintingEnabled(true);
    usePrinterStore.setState({
      hardwarePrinter: { id: 'hw', name: 'Kitchen', connection_type: 'network', is_default: 1 },
      printMethod: 'escpos',
    });
    const sent: any[] = [];
    const originalPost = frontend.api.post;
    frontend.api.post = async (url: string, body: any) => {
      if (url === '/printers/print-kot') sent.push(body);
      return { data: { warnings: [] } };
    };
    try {
      // The print test's made-up order: its ids could be a real order's.
      await usePrinterStore
        .getState()
        .printKot(detailOrder, { stationName: 'Kitchen', sample: true });
      await usePrinterStore.getState().printKot(detailOrder, { stationName: 'Kitchen' });
    } finally {
      frontend.api.post = originalPost;
    }
    assertEqualOrThrow(sent.length, 2, 'both prints go to the kitchen ticket route');
    assertEqualOrThrow(sent[0].sample, true, 'the print test asks for the sample ticket');
    assertOrThrow(
      !('orderId' in sent[0]) && !('items' in sent[0]),
      'and sends no order id and no items',
    );
    assertEqualOrThrow(sent[0].stationName, 'Kitchen', 'the station name still goes along');
    assertOrThrow(
      sent[1].orderId === 1 && sent[1].items.length === 1 && !('sample' in sent[1]),
      'a real print still names its order and lines',
    );
  },
});
