/**
 * Customer contact on the kitchen ticket: with `kot_show_customer_contact` on,
 * the header prints the customer's phone number, and for a delivery order the
 * delivery address and delivery note. Off (the default) changes nothing.
 *
 * Run: npm run test:pizza-kot-customer-contact
 */
const {
  assertOrThrow,
  assertEqualOrThrow,
  loadFrontend,
  rows,
  runCases,
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCustomer,
  api,
} = require('./helpers/pizza-print-harness');
const net = require('node:net');
const { renderKotViaDocument, renderKotDocumentToLines } = require('../main/printers/document-kot');
const { buildEscPos } = require('../main/printers/formatting-helpers');
const { printKOTDetailed } = require('../main/printers/thermal');
const { settingsRoutes } = require('../main/routes/settings');
const { isKotDocument } = require('../shared/print');

const frontend = loadFrontend();

const SETTING = 'kot_show_customer_contact';
const PHONE = '+16045550100';
const ADDRESS = '1234 West Broadway Avenue, Unit 405, Vancouver BC V6H 1G8';
const NOTE = 'Side door, call on arrival';
const PHONE_LINE = `Customer No: ${PHONE}`;
const ADDRESS_LINE = `Delivery address: ${ADDRESS}`;
const NOTE_LINE = `Delivery note: ${NOTE}`;
const COLUMNS = [42, 48];

const items = [
  {
    id: 1,
    order_id: 1,
    product_id: 'p1',
    product_name: 'Margherita',
    product_sku: null,
    unit_price: 18,
    quantity: 1,
    subtotal: 18,
    tax_amount: 0,
    total: 18,
    addons: [],
    special_instructions: null,
    status: 'pending',
  },
];
const customer = { id: 'cust-1', name: 'Asha Kumar', phone: '+16045550100' };
const baseOrder = {
  id: 1,
  order_number: 'P-7',
  created_at: '2026-01-01T12:00:00.000Z',
  delivery_address: ADDRESS,
  delivery_note: NOTE,
  items,
};
const deliveryOrder: any = { ...baseOrder, type: 'delivery', customer_id: 'cust-1', customer };
const pickupOrder: any = { ...baseOrder, type: 'takeaway', customer_id: 'cust-1', customer };
const anonymousOrder: any = { ...baseOrder, type: 'takeaway', delivery_address: '' };

const kotOptions = (columns: number) => ({
  columns,
  language: 'en',
  timezone: 'UTC',
  useUnicode: false,
  arabicShaping: false,
  cutMode: 'partial' as const,
});

/** The four kitchen ticket paths, each rendered to comparable text. */
const paths: Record<string, (order: any, show: boolean, columns: number) => string> = {
  'server ESC/POS': (order, show, columns) =>
    rows(
      renderKotViaDocument(
        show ? { ...order, show_customer_contact: true } : order,
        order.items,
        'Kitchen',
        kotOptions(columns),
      ).data,
    ).join('\n'),
  'browser ESC/POS': (order, show, columns) =>
    rows(
      frontend.kotEncoder.buildKotBytes(
        order,
        {
          columns,
          paperWidth: 80,
          stationName: 'Kitchen',
          language: 'en',
          timezone: 'UTC',
          showCustomerContact: show,
        } as any,
        [],
      ),
    ).join('\n'),
  'raster document': (order, show, columns) => {
    const document = frontend.printDocument.buildFrontendKotDocument(order, {
      stationName: 'Kitchen',
      columns,
      language: 'en',
      timezone: 'UTC',
      showCustomerContact: show,
    } as any);
    assertOrThrow(isKotDocument(document), `raster ${columns}: the document is valid`);
    return rows(
      buildEscPos(renderKotDocumentToLines(document, kotOptions(columns)), false, {
        cutMode: 'partial',
        columns,
        language: 'en',
      }),
    ).join('\n');
  },
  'browser HTML': (order, show) =>
    frontend.kotWebPrint
      .generateKotHtml(order, {
        paperWidth: 80,
        language: 'en',
        stationName: 'Kitchen',
        timezone: 'UTC',
        showCustomerContact: show,
      } as any)
      .replace(/<[^>]+>/g, '\n'),
};

/** Ticket text with wrapped rows rejoined, so a wrapped address still reads whole. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

function forEveryPath(run: (name: string, render: (order: any, show: boolean) => string) => void) {
  for (const [name, render] of Object.entries(paths)) {
    for (const columns of name === 'browser HTML' ? [COLUMNS[0]] : COLUMNS) {
      run(`${name} ${columns}`, (order, show) => render(order, show, columns));
    }
  }
}

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
      paper_width: 'cols-42',
    },
    async lastJob(): Promise<string> {
      for (let waited = 0; jobs.length === 0 && waited < 5000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return rows(jobs.pop() ?? Buffer.alloc(0)).join('\n');
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

runCases('pizza-kot-customer-contact', {
  'Case 1: setting off, a delivery ticket has no phone and no address': () => {
    forEveryPath((name, render) => {
      const text = flat(render(deliveryOrder, false));
      assertOrThrow(text.includes('Asha Kumar'), `${name}: the customer name still prints`);
      assertOrThrow(!text.includes('6045550100'), `${name}: no phone number`);
      assertOrThrow(!text.includes('West Broadway'), `${name}: no delivery address`);
      assertOrThrow(!text.includes(NOTE), `${name}: no delivery note`);
    });
  },

  'Case 2: setting on, a delivery ticket prints phone, address and delivery note': () => {
    forEveryPath((name, render) => {
      const text = flat(render(deliveryOrder, true));
      const [nameAt, phoneAt, addressAt, noteAt, itemAt] = [
        'Asha Kumar',
        PHONE_LINE,
        ADDRESS_LINE,
        NOTE_LINE,
        '1x',
      ].map((needle) => text.indexOf(needle));
      assertOrThrow(phoneAt > nameAt, `${name}: the phone follows the customer name`);
      assertOrThrow(addressAt > phoneAt, `${name}: the whole address follows the phone`);
      assertOrThrow(noteAt > addressAt, `${name}: the delivery note follows the address`);
      assertOrThrow(itemAt > noteAt, `${name}: all three are in the header, above the items`);
    });
    for (const columns of COLUMNS) {
      const printed = paths['server ESC/POS'](deliveryOrder, true, columns).split('\n');
      assertOrThrow(
        printed.every((row) => row.length <= columns),
        `server ESC/POS ${columns}: the address wraps inside the width`,
      );
      assertEqualOrThrow(
        paths['browser ESC/POS'](deliveryOrder, true, columns)
          .split('\n')
          .filter((row) => row.length > columns).length,
        0,
        `browser ESC/POS ${columns}: the address wraps inside the width`,
      );
    }
  },

  'Case 2b: contact text that spells a printer control token prints as text': () => {
    const order = {
      ...deliveryOrder,
      delivery_address: `${'x'.repeat(24)} {CUT}`,
      delivery_note: '{BOLD} ring twice',
    };
    for (const name of ['server ESC/POS', 'raster document']) {
      const text = flat(paths[name](order, true, 42));
      assertOrThrow(text.includes('{ CUT }'), `${name}: the cut token is printed, not obeyed`);
      assertOrThrow(text.includes('{ BOLD } ring twice'), `${name}: the note prints whole`);
      assertOrThrow(text.indexOf('1x') > text.indexOf('ring twice'), `${name}: items follow`);
    }
  },

  'Case 2c: an address stored on two lines prints with a space between them': () => {
    const order = { ...deliveryOrder, delivery_address: '12 Main St\nApt 4' };
    forEveryPath((name, render) => {
      assertOrThrow(
        flat(render(order, true)).includes('Delivery address: 12 Main St Apt 4'),
        `${name}: the two lines are separated`,
      );
    });
  },

  'Case 3: setting on, a pickup ticket with a phone prints the phone only': () => {
    forEveryPath((name, render) => {
      const text = flat(render(pickupOrder, true));
      assertOrThrow(text.includes(PHONE_LINE), `${name}: the phone prints`);
      assertOrThrow(!text.includes('Delivery address'), `${name}: no delivery address`);
      assertOrThrow(!text.includes('Delivery note'), `${name}: no delivery note`);
    });
  },

  'Case 4: setting on, an order with no customer adds nothing': () => {
    forEveryPath((name, render) => {
      const on = render(anonymousOrder, true);
      assertEqualOrThrow(on, render(anonymousOrder, false), `${name}: same ticket as setting off`);
      for (const label of ['Customer No', 'Delivery address', 'Delivery note']) {
        assertOrThrow(!on.includes(label), `${name}: no empty "${label}" line`);
      }
    });
  },

  'Case 5: the stored setting reaches the server and the browser print paths': async () => {
    const db = initTestDb();
    const owner = seedOwnerUser(db);
    seedCustomer(db, customer.id, customer.name, customer.phone);
    const { baseUrl, server } = await startServer(createApp({ '/api/settings': settingsRoutes }));
    const capture = await startCapturePrinter();
    const { usePrinterStore } = frontend.usePrinter;
    const { printerService } = frontend.printerService;
    const originalGet = frontend.api.get;
    const originalPrintViaBrowser = printerService.printViaBrowser;
    const originalPrint = printerService.print;
    // The server route attaches only the customer's name; the ticket code loads the rest.
    const routeOrder = { ...deliveryOrder, customer: { name: customer.name } };
    try {
      const before = await api(baseUrl, '/api/settings/business', { headers: owner.authHeader });
      assertEqualOrThrow(before.data[SETTING], false, 'the setting is off by default');
      await printKOTDetailed(routeOrder, items, 'Kitchen', false, capture.printer);
      const offJob = flat(await capture.lastJob());
      assertOrThrow(offJob.includes('Asha Kumar'), 'server, setting off: the ticket prints');
      assertOrThrow(!offJob.includes('6045550100'), 'server, setting off: no phone number');
      assertOrThrow(!offJob.includes('West Broadway'), 'server, setting off: no address');

      const saved = await api(baseUrl, `/api/settings/${SETTING}`, {
        method: 'PUT',
        headers: owner.authHeader,
        body: { value: 'true' },
      });
      assertEqualOrThrow(saved.status, 200, 'the settings route accepts the key');
      const business = await api(baseUrl, '/api/settings/business', { headers: owner.authHeader });
      assertEqualOrThrow(business.data[SETTING], true, 'the business settings report it on');
      assertEqualOrThrow(
        frontend.posSettings.usePosSettingsStore.getState().kotShowCustomerContact,
        false,
        'the browser store starts with it off',
      );

      await printKOTDetailed(routeOrder, items, 'Kitchen', false, capture.printer);
      const onJob = flat(await capture.lastJob());
      for (const line of [PHONE_LINE, ADDRESS_LINE, NOTE_LINE]) {
        assertOrThrow(onJob.includes(line), `server, setting on: prints "${line}"`);
      }

      // The browser reads the same settings response, then prints through the hook.
      frontend.api.get = async (url: string) =>
        url === '/settings/business' ? { data: business.data } : originalGet(url);
      let html = '';
      printerService.printViaBrowser = async (content: string) => {
        html = content;
      };
      frontend.auth.useAuthStore.setState({
        currentTenant: { id: 1, role: 'owner', country: 'US', timezone: 'UTC' } as any,
      });
      usePrinterStore.setState({ hardwarePrinter: null, printMethod: 'browser' });
      await usePrinterStore.getState().printKot(deliveryOrder);
      const browserJob = flat(html.replace(/<[^>]+>/g, '\n'));
      for (const line of [PHONE_LINE, ADDRESS_LINE, NOTE_LINE]) {
        assertOrThrow(browserJob.includes(line), `browser hook, setting on: prints "${line}"`);
      }

      // The same hook with a WebUSB printer connected sends ESC/POS bytes instead.
      let bytes = new Uint8Array();
      Object.defineProperty(printerService, 'isConnected', { get: () => true, configurable: true });
      printerService.print = async (data: Uint8Array) => {
        bytes = data;
      };
      (globalThis as any).window = {};
      usePrinterStore.setState({ printMethod: 'escpos' });
      await usePrinterStore.getState().printKot(deliveryOrder);
      const webusbJob = flat(rows(bytes).join('\n'));
      for (const line of [PHONE_LINE, ADDRESS_LINE, NOTE_LINE]) {
        assertOrThrow(webusbJob.includes(line), `WebUSB hook, setting on: prints "${line}"`);
      }
    } finally {
      frontend.api.get = originalGet;
      printerService.printViaBrowser = originalPrintViaBrowser;
      printerService.print = originalPrint;
      delete (printerService as any).isConnected;
      delete (globalThis as any).window;
      await capture.close();
      await new Promise((resolve) => server.close(resolve));
      frontend.auth.useAuthStore.setState({ currentTenant: null });
    }
  },
});
