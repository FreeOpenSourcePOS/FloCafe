import assert from 'node:assert/strict';

const { printerService } =
  require('../frontend/src/lib/printer/PrinterService') as typeof import('../frontend/src/lib/printer/PrinterService');

async function run(): Promise<void> {
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  let claimStarted!: () => void;
  const claimStartedPromise = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  let released = 0;
  let closed = 0;
  const device = {
    vendorId: 1,
    productId: 2,
    productName: 'Test Printer',
    serialNumber: 'serial',
    configuration: { configurationValue: 1 },
    configurations: [
      {
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [
              {
                interfaceClass: 7,
                endpoints: [{ type: 'bulk', direction: 'out', endpointNumber: 1 }],
              },
            ],
          },
        ],
      },
    ],
    open: async () => {},
    selectConfiguration: async () => {},
    claimInterface: async () => {
      claimStarted();
      await claimGate;
    },
    releaseInterface: async () => {
      released += 1;
    },
    close: async () => {
      closed += 1;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      usb: {
        getDevices: async () => [device],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    },
  });

  printerService.setPrintMode('escpos');
  const reconnect = printerService.tryReconnect();
  await claimStartedPromise;
  printerService.setPrintMode('browser');
  releaseClaim();
  const browserInterruptedResult = await reconnect;

  assert.equal(
    browserInterruptedResult,
    false,
    'tryReconnect must return false when browser mode disconnects mid-claim',
  );
  assert.notEqual(printerService.status, 'connected', 'browser mode must not report connected');
  assert.equal(printerService.isConnected, false);
  assert.equal(released, 1, 'the claimed interface is released');
  assert.equal(closed, 1, 'the device is closed');

  printerService.setPrintMode('escpos');
  const cleanReconnect = await printerService.tryReconnect();
  assert.equal(cleanReconnect, true, 'tryReconnect returns true when USB connection succeeds');
  assert.equal(printerService.isConnected, true);
  await printerService.disconnect();
  console.log('✓ switching to Browser Print during a pending claim releases the USB interface');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
