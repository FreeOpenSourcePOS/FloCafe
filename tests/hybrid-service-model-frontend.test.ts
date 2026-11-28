// Frontend regression tests for ready-made KOT suppression and hybrid settings sync.
// Usage: tsx --tsconfig tests/tsconfig.json -r ./tests/register-tsx.cjs tests/hybrid-service-model-frontend.test.ts

import assert from 'node:assert/strict';

const syncModule =
  require('../frontend/src/hooks/useReceiptSettingsSync') as typeof import('../frontend/src/hooks/useReceiptSettingsSync');
syncModule.ensureReceiptSettingsLoaded = async () => true;

const { usePrinterStore } =
  require('../frontend/src/hooks/usePrinter') as typeof import('../frontend/src/hooks/usePrinter');
const { applyServiceModelChange, resolveSavedTablesRequired, usePosSettingsStore } =
  require('../frontend/src/store/pos-settings') as typeof import('../frontend/src/store/pos-settings');
const { printerService } =
  require('../frontend/src/lib/printer/PrinterService') as typeof import('../frontend/src/lib/printer/PrinterService');
const api = (require('../frontend/src/lib/api') as typeof import('../frontend/src/lib/api'))
  .default;

async function run(): Promise<void> {
  console.log('Hybrid service model frontend regressions');

  const originalPost = api.post;
  const originalPrint = printerService.print.bind(printerService);
  const originalPrintViaBrowser = printerService.printViaBrowser.bind(printerService);
  const originalAwaitPendingReconnect = printerService.awaitPendingReconnect.bind(printerService);
  const originalIsConnectedDesc = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(printerService),
    'isConnected',
  );

  let hostKotCalls = 0;
  let webUsbCalls = 0;
  let browserCalls: string[] = [];
  let fakeConnected = false;

  api.post = (async (url: string) => {
    if (url === '/printers/print-kot') hostKotCalls += 1;
    return { data: { warnings: [] } };
  }) as typeof api.post;
  printerService.awaitPendingReconnect = async () => {};
  printerService.print = async () => {
    webUsbCalls += 1;
  };
  printerService.printViaBrowser = async (html: string) => {
    browserCalls.push(html);
  };
  Object.defineProperty(printerService, 'isConnected', {
    configurable: true,
    get: () => fakeConnected,
  });

  try {
    usePosSettingsStore.getState().setKotPrintingEnabled(true);

    const readyMadeOrder: any = {
      id: 101,
      order_number: 'ORD-RM-101',
      type: 'takeaway',
      status: 'completed',
      created_at: '2026-11-27 12:00:00',
      items: [
        {
          id: 1,
          product_id: 'cola',
          product_name: 'Bottled Cola',
          quantity: 2,
          status: 'served',
          requires_kitchen: 0,
        },
      ],
    };

    // 1. Hardware printer mode skips /printers/print-kot for ready-made-only orders
    usePrinterStore.setState({
      printMethod: 'escpos',
      hardwarePrinter: {
        id: 'hw-1',
        name: 'Kitchen Net',
        connection_type: 'network',
        is_default: 1,
      } as any,
      webusbPrinter: null,
    });
    const hwWarnings = await usePrinterStore.getState().printKot(readyMadeOrder, {
      items: readyMadeOrder.items,
    });
    assert.deepEqual(hwWarnings, [], 'ready-made-only hardware KOT returns empty warnings');
    assert.equal(hostKotCalls, 0, 'ready-made-only order never posts to /printers/print-kot');

    // 2. WebUSB mode never prints empty KOT for ready-made-only orders
    fakeConnected = true;
    usePrinterStore.setState({
      printMethod: 'escpos',
      hardwarePrinter: null,
      webusbPrinter: null,
    });
    const usbWarnings = await usePrinterStore.getState().printKot(readyMadeOrder, {
      items: readyMadeOrder.items,
    });
    assert.deepEqual(usbWarnings, [], 'ready-made-only WebUSB KOT returns empty warnings');
    assert.equal(webUsbCalls, 0, 'ready-made-only order never sends bytes to WebUSB');
    assert.equal(browserCalls.length, 0, 'ready-made-only order never opens browser print');

    // 3. Browser Print mode never prints empty KOT for ready-made-only orders
    fakeConnected = false;
    usePrinterStore.setState({
      printMethod: 'browser',
      hardwarePrinter: null,
      webusbPrinter: null,
    });
    const browserWarnings = await usePrinterStore.getState().printKot(readyMadeOrder, {
      items: readyMadeOrder.items,
    });
    assert.deepEqual(browserWarnings, [], 'ready-made-only browser KOT returns empty warnings');
    assert.equal(browserCalls.length, 0, 'ready-made-only order never calls printViaBrowser');

    // 3b. Empty item arrays skip printing on Browser Print and WebUSB instead of printing an empty ticket
    const emptyOverrideWarnings = await usePrinterStore.getState().printKot(readyMadeOrder, {
      items: [],
    });
    assert.deepEqual(emptyOverrideWarnings, [], 'empty opts.items returns empty warnings');
    const emptyOrderItemsWarnings = await usePrinterStore.getState().printKot({
      ...readyMadeOrder,
      items: [],
    });
    assert.deepEqual(emptyOrderItemsWarnings, [], 'empty order.items returns empty warnings');
    assert.equal(browserCalls.length, 0, 'empty item lists never call printViaBrowser');

    // 4. Mixed order with a pending kitchen line prints only the kitchen item, even if a ready-made item carries pending status
    const mixedOrder: any = {
      ...readyMadeOrder,
      id: 102,
      order_number: 'ORD-MIX-102',
      items: [
        {
          id: 2,
          product_id: 'fish',
          product_name: 'Grilled Fish',
          quantity: 1,
          status: 'pending',
          requires_kitchen: 1,
        },
        {
          ...readyMadeOrder.items[0],
          status: 'pending',
        },
      ],
    };
    await usePrinterStore.getState().printKot(mixedOrder, { items: mixedOrder.items });
    assert.equal(browserCalls.length, 1, 'mixed order prints KOT once in browser mode');
    assert.ok(browserCalls[0].includes('Grilled Fish'), 'mixed KOT includes the kitchen item');
    assert.ok(!browserCalls[0].includes('Bottled Cola'), 'mixed KOT excludes the ready-made item');

    // 5. Selecting hybrid forces tablesRequired=true and marks it touched
    const qsrForm = { serviceModel: 'qsr' as const, tablesRequired: false, businessName: 'Cafe' };
    const hybridTransition = applyServiceModelChange(qsrForm, 'hybrid');
    assert.equal(hybridTransition.nextForm.serviceModel, 'hybrid');
    assert.equal(
      hybridTransition.nextForm.tablesRequired,
      true,
      'switching from qsr (tablesRequired=false) to hybrid forces tablesRequired=true',
    );
    assert.equal(hybridTransition.nextForm.businessName, 'Cafe');
    assert.deepEqual(
      hybridTransition.touchedFields,
      ['serviceModel', 'tablesRequired'],
      'switching to hybrid marks both serviceModel and tablesRequired hydration-touched',
    );

    const finedineTransition = applyServiceModelChange(qsrForm, 'finedine');
    assert.equal(finedineTransition.nextForm.serviceModel, 'finedine');
    assert.equal(
      finedineTransition.nextForm.tablesRequired,
      false,
      'switching to non-hybrid preserves existing tablesRequired value',
    );
    assert.deepEqual(finedineTransition.touchedFields, ['serviceModel']);

    // 6. Saving business settings hydrates server-authoritative tables_required
    assert.equal(
      resolveSavedTablesRequired(true, 'hybrid', false),
      true,
      'server tables_required=true overrides stale local false',
    );
    assert.equal(
      resolveSavedTablesRequired(false, 'qsr', true),
      false,
      'server tables_required=false overrides stale local true for non-hybrid',
    );
    assert.equal(
      resolveSavedTablesRequired(undefined, 'hybrid', false),
      true,
      'missing server tables_required still enforces true for hybrid',
    );
    assert.equal(
      resolveSavedTablesRequired(undefined, 'qsr', false),
      false,
      'missing server tables_required preserves local value for non-hybrid',
    );

    usePosSettingsStore.setState({ serviceModel: 'qsr', tablesRequired: false });
    const hydratedTablesRequired = resolveSavedTablesRequired(true, 'hybrid', false);
    usePosSettingsStore.getState().hydrateReceiptSettings({
      service_model: 'hybrid',
      tables_required: hydratedTablesRequired,
    });
    assert.equal(usePosSettingsStore.getState().serviceModel, 'hybrid');
    assert.equal(
      usePosSettingsStore.getState().tablesRequired,
      true,
      'hydrateReceiptSettings updates store tablesRequired from resolved server response',
    );

    console.log('✓ All hybrid frontend regressions passed');
  } finally {
    api.post = originalPost;
    printerService.print = originalPrint;
    printerService.printViaBrowser = originalPrintViaBrowser;
    printerService.awaitPendingReconnect = originalAwaitPendingReconnect;
    if (originalIsConnectedDesc) {
      Object.defineProperty(printerService, 'isConnected', originalIsConnectedDesc);
    } else {
      delete (printerService as any).isConnected;
    }
    usePrinterStore.setState({ hardwarePrinter: null, webusbPrinter: null, printMethod: 'escpos' });
  }
}

run().catch((err) => {
  console.error('Hybrid service model frontend test failed:', err);
  process.exit(1);
});
