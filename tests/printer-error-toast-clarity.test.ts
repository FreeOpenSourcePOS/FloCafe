import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import moduleApi from 'node:module';
import {
  PrinterOperationError,
  buildPrinterOperationFailureSupportPayload,
  classifyPrinterFailureClass,
  normalizePrinterConnectionType,
  sanitizePrinterErrorDetail,
  toPrinterOperationError,
} from '../frontend/src/lib/operation-failure';

const mod = moduleApi as unknown as { _resolveFilename: (...args: any[]) => string };
const originalResolveFilename = mod._resolveFilename;
mod._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  const resolvedRequest =
    request === '@countries'
      ? path.resolve(__dirname, '../main/countries.ts')
      : request.startsWith('@print/')
        ? path.resolve(__dirname, '../shared/print', request.slice('@print/'.length))
        : request.startsWith('@shared/')
          ? path.resolve(__dirname, '../shared', request.slice('@shared/'.length))
          : request.startsWith('@/')
            ? path.resolve(__dirname, '../frontend/src', request.slice('@/'.length))
            : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

type WarningsMod = typeof import('../frontend/src/lib/printer/warnings');
type UsePrinterMod = typeof import('../frontend/src/hooks/usePrinter');
type PrinterServiceMod = typeof import('../frontend/src/lib/printer/PrinterService');
type PosSettingsMod = typeof import('../frontend/src/store/pos-settings');
type AuthStoreMod = typeof import('../frontend/src/store/auth');

const {
  formatReceiptErrorToast,
  formatKotErrorToast,
  extractPrinterErrorMessage,
  formatPrinterSettingsErrorMessage,
} = require('../frontend/src/lib/printer/warnings') as WarningsMod;
const { usePrinterStore, PrintCancelledOnTenantChangeError, isPrintCancelledOnTenantChangeError } =
  require('../frontend/src/hooks/usePrinter') as UsePrinterMod;
const { printerService } =
  require('../frontend/src/lib/printer/PrinterService') as PrinterServiceMod;
const { usePosSettingsStore } = require('../frontend/src/store/pos-settings') as PosSettingsMod;
const { useAuthStore } = require('../frontend/src/store/auth') as AuthStoreMod;
const frontendApiModule = require('../frontend/src/lib/api');
const frontendApi = frontendApiModule.default || frontendApiModule;

async function runTests(): Promise<void> {
  // 1. Receipt formatting: financial refusal is passed as-is without double-wrapping
  const financialMsg =
    'Receipt not printed: a financial row contains unsupported printer text: €5.00';
  assert.equal(formatReceiptErrorToast(financialMsg, 'Receipt print failed'), financialMsg);

  // 2. Receipt formatting: specific operational detail is appended with context
  const timeoutMsg = 'Timed out connecting to 192.168.1.100:9100';
  assert.equal(
    formatReceiptErrorToast(timeoutMsg, 'Receipt print failed'),
    'Receipt print failed (Timed out connecting to 192.168.1.100:9100)',
  );

  // 3. Receipt formatting: generic messages fall back cleanly without empty parentheses
  assert.equal(
    formatReceiptErrorToast('print failed', 'Receipt print failed'),
    'Receipt print failed',
  );
  assert.equal(
    formatReceiptErrorToast('Print failed', 'Receipt print failed'),
    'Receipt print failed',
  );
  assert.equal(formatReceiptErrorToast('', 'Receipt print failed'), 'Receipt print failed');
  assert.equal(formatReceiptErrorToast(undefined, 'Receipt print failed'), 'Receipt print failed');

  // 4. KOT formatting: operational detail is appended
  assert.equal(
    formatKotErrorToast('Spooler service paused', 'KOT print failed'),
    'KOT print failed: Spooler service paused',
  );

  // 5. KOT formatting: generic messages fall back cleanly
  assert.equal(formatKotErrorToast('print failed', 'KOT print failed'), 'KOT print failed');
  assert.equal(formatKotErrorToast('KOT print failed', 'KOT print failed'), 'KOT print failed');
  assert.equal(formatKotErrorToast('', 'KOT print failed'), 'KOT print failed');
  assert.equal(formatKotErrorToast(undefined, 'KOT print failed'), 'KOT print failed');

  // 6. extractPrinterErrorMessage extracts from Axios response objects and standard errors
  assert.equal(
    extractPrinterErrorMessage({ response: { data: { detail: 'Driver disconnected' } } }),
    'Driver disconnected',
  );
  assert.equal(
    extractPrinterErrorMessage({ response: { data: { error: 'Network error' } } }),
    'Network error',
  );
  assert.equal(extractPrinterErrorMessage(new Error('Printer paper out')), 'Printer paper out');
  // Non-string detail/error responses should not throw or return object strings
  assert.equal(
    extractPrinterErrorMessage({ response: { data: { detail: { nested: 'object' } } } }),
    '',
  );
  assert.equal(extractPrinterErrorMessage({ response: { data: { error: 12345 } } }), '');
  assert.equal(extractPrinterErrorMessage(null), '');
  assert.equal(extractPrinterErrorMessage(undefined), '');
  assert.equal(extractPrinterErrorMessage({}), '');

  // 7. #789 sanitization: raw PowerShell commands, -EncodedCommand, CLIXML, and temp paths never leak
  const rawPowerShellStderr =
    'Command failed: powershell.exe -NoProfile -NonInteractive -EncodedCommand SQBuAHYAbwBrAGUALQBXAG0AaQBNAGUAdABoAG8AZAAgAC0ATgBhAG0AZQAgAFAAcgBpAG4AdAA=\n' +
    'Write-RawBytes C:\\Users\\Cashier\\AppData\\Local\\Temp\\flo_print_99182.bin failed: Printer queue unavailable at /tmp/flo_print_99182.bin';
  const sanitizedDetail = sanitizePrinterErrorDetail(rawPowerShellStderr);
  assert(!/powershell/i.test(sanitizedDetail), 'must strip powershell binary name');
  assert(!/EncodedCommand/i.test(sanitizedDetail), 'must strip -EncodedCommand flag');
  assert(!/SQBuAHYAbwBrAGUA/.test(sanitizedDetail), 'must strip encoded script payload');
  assert(!/C:\\Users\\Cashier/i.test(sanitizedDetail), 'must redact Windows user path');
  assert(!/\/tmp\/flo_print_99182\.bin/.test(sanitizedDetail), 'must redact POSIX temp path');
  assert(sanitizedDetail.includes('<payload file>'), 'replaces temp payload file with placeholder');

  const clixmlError =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Printer is set to Use Printer Offline in Windows_x000D__x000A_</S></Objs>';
  assert.equal(
    sanitizePrinterErrorDetail(clixmlError),
    'Printer is set to Use Printer Offline in Windows',
  );
  assert(
    !formatReceiptErrorToast(rawPowerShellStderr, 'Receipt print failed').includes(
      'EncodedCommand',
    ),
    'toast formatter must sanitize PowerShell command strings',
  );

  // Non-PowerShell subprocess failures (e.g. macOS/Linux CUPS lp) must not claim Windows
  const cupsSubprocessFailure =
    'Command failed: lp -d Kitchen -o raw /var/folders/ab/cd/T/flo_print_123.bin';
  assert.equal(sanitizePrinterErrorDetail(cupsSubprocessFailure), 'Print command failed');
  const cupsSubprocessTimeout =
    'Command failed: lp -d Kitchen -o raw /tmp/flo_print_123.bin (ETIMEDOUT)';
  assert.equal(sanitizePrinterErrorDetail(cupsSubprocessTimeout), 'Print command timed out');

  // Progress-only CLIXML must strip <Objs>...</Objs> without leaking PowerShell object text
  const progressOnlyClixml =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><Obj N="SourceId">0</Obj><S N="Record">System.Management.Automation.PSCustomObject Preparing modules for first use.</S></MS></Obj></Objs>';
  assert.equal(sanitizePrinterErrorDetail(progressOnlyClixml), '');
  assert.equal(
    sanitizePrinterErrorDetail(`${progressOnlyClixml}\r\nPrinter spooler is stopped`),
    'Printer spooler is stopped',
  );

  // Windows path followed by a UNC printer name must not collapse intervening prose into <path>
  assert.equal(
    sanitizePrinterErrorDetail(
      'Write-RawBytes C:\\Temp\\spool_check.dat failed for printer \\\\Server\\Kitchen',
    ),
    'Write-RawBytes <path> failed for printer \\\\Server\\Kitchen',
  );

  // 8. #1465: structured PrinterOperationError preserves backend failure_class, correlation_id, connection_type, and sanitized detail
  const backendCorrelationId = '4f8b8e11-53d9-4d4a-9f88-112233445566';
  const axiosPrintError = {
    response: {
      status: 502,
      data: {
        error: 'Print failed',
        detail: 'Printer is set to Use Printer Offline in Windows',
        failure_class: 'offline',
        connection_type: 'usb',
        code: 'print.receipt.failed',
        stage: 'dispatch',
        correlation_id: backendCorrelationId,
      },
    },
  };
  const typedReceiptError = toPrinterOperationError(axiosPrintError, {
    kind: 'receipt',
    connectionType: 'usb',
    stage: 'dispatch',
  });
  assert(typedReceiptError instanceof PrinterOperationError);
  assert.equal(typedReceiptError.code, 'print.receipt.failed');
  assert.equal(typedReceiptError.failure_class, 'offline');
  assert.equal(typedReceiptError.connection_type, 'usb');
  assert.equal(typedReceiptError.correlation_id, backendCorrelationId);
  assert.equal(typedReceiptError.capture_point, 'fc.backend.printer.receipt.queue');

  const receiptHelpPayload = buildPrinterOperationFailureSupportPayload(typedReceiptError, {
    kind: 'receipt',
    fallbackDetail: 'Receipt printing failed after payment was completed',
  });
  assert.equal(receiptHelpPayload.correlation_id, backendCorrelationId);
  assert.equal(receiptHelpPayload.detail, 'Printer is set to Use Printer Offline in Windows');
  assert.deepEqual(receiptHelpPayload.operation_failure, {
    capture_point: 'fc.backend.printer.receipt.queue',
    operation_id: backendCorrelationId,
    outcome: 'unknown',
    facts: {
      kind: 'receipt',
      failure_class: 'offline',
      connection_type: 'usb',
    },
  });

  // KOT timeout maps to fc.backend.printer.kot.timeout; non-allowlisted transports normalize to unknown
  assert.equal(normalizePrinterConnectionType('bluetooth'), 'unknown');
  assert.equal(normalizePrinterConnectionType('serial'), 'unknown');
  assert.equal(classifyPrinterFailureClass('Please allow popups to print'), 'unsupported');
  assert.equal(classifyPrinterFailureClass('Popup window was blocked by browser'), 'unsupported');
  const kotCorrelationId = '9a1b2c3d-4e5f-4a6b-8c7d-0123456789ab';
  const kotTimeoutError = toPrinterOperationError(
    {
      response: {
        status: 502,
        data: {
          error: 'Print failed',
          detail: 'Timed out connecting to kitchen printer 192.168.1.55:9100',
          failure_class: 'timeout',
          connection_type: 'network',
          code: 'print.kot.failed',
          stage: 'dispatch',
          correlation_id: kotCorrelationId,
        },
      },
    },
    { kind: 'kot', connectionType: 'network' },
  );
  const kotHelpPayload = buildPrinterOperationFailureSupportPayload(kotTimeoutError, {
    kind: 'kot',
    fallbackDetail: 'Kitchen ticket printing failed after the order was created',
  });
  assert.deepEqual(kotHelpPayload.operation_failure, {
    capture_point: 'fc.backend.printer.kot.timeout',
    operation_id: kotCorrelationId,
    outcome: 'unknown',
    facts: {
      kind: 'kot',
      failure_class: 'timeout',
      connection_type: 'network',
    },
  });

  const unknownBackendCorrelationId = '3e7a1b2c-9d8f-4e6a-8b5c-1234567890ab';
  const unknownBackendHelp = buildPrinterOperationFailureSupportPayload(
    {
      response: {
        status: 502,
        data: {
          error: 'Print failed',
          detail: 'Network error: connect ETIMEDOUT 192.168.1.50:9100',
          failure_class: 'unknown',
          connection_type: 'network',
          code: 'print.receipt.failed',
          stage: 'dispatch',
          correlation_id: unknownBackendCorrelationId,
        },
      },
    },
    {
      kind: 'receipt',
      connectionType: 'network',
      fallbackDetail: 'Receipt printing failed after payment was completed',
    },
  );
  assert.equal(unknownBackendHelp.failure_class, 'unknown');
  assert.equal(unknownBackendHelp.reasonCode, 'printer.queue_failed');
  assert.equal(unknownBackendHelp.capture_point, 'fc.backend.printer.receipt.queue');
  assert.deepEqual(unknownBackendHelp.operation_failure, {
    capture_point: 'fc.backend.printer.receipt.queue',
    operation_id: unknownBackendCorrelationId,
    outcome: 'unknown',
    facts: {
      kind: 'receipt',
      failure_class: 'unknown',
      connection_type: 'network',
    },
  });

  const popupFallbackHelp = buildPrinterOperationFailureSupportPayload(
    new Error('Popup window was blocked by browser'),
    {
      kind: 'receipt',
      connectionType: 'unknown',
      fallbackDetail: 'Receipt printing failed after payment was completed',
    },
  );
  assert.equal(popupFallbackHelp.correlation_id, null);
  assert.equal(popupFallbackHelp.capture_point, null);
  assert.equal(popupFallbackHelp.operation_failure, undefined);
  assert.equal(popupFallbackHelp.failure_class, 'unsupported');
  assert.equal(popupFallbackHelp.connection_type, 'unknown');
  assert.equal(popupFallbackHelp.detail, 'Popup window was blocked by browser');

  const nonDispatchHttpHelp = buildPrinterOperationFailureSupportPayload(
    {
      response: {
        status: 403,
        data: {
          error: 'KOT printing is disabled for this business',
        },
      },
    },
    {
      kind: 'kot',
      connectionType: 'usb',
      fallbackDetail: 'Kitchen ticket printing failed after the order was created',
    },
  );
  assert.equal(nonDispatchHttpHelp.correlation_id, null);
  assert.equal(nonDispatchHttpHelp.capture_point, null);
  assert.equal(nonDispatchHttpHelp.operation_failure, undefined);
  assert.equal(nonDispatchHttpHelp.connection_type, 'usb');
  assert.equal(nonDispatchHttpHelp.detail, 'KOT printing is disabled for this business');

  // 9. Browser print mode reports connection_type 'unknown' and failure_class 'unsupported' even if WebUSB is connected,
  //    and printKot cancels with PrintCancelledOnTenantChangeError across mid-flight tenant switches.
  const origIsConnected = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(printerService),
    'isConnected',
  );
  const origPost = frontendApi.post;
  const origGet = frontendApi.get;
  try {
    Object.defineProperty(printerService, 'isConnected', {
      configurable: true,
      get: () => true,
    });
    frontendApi.get = async () => ({ data: {} });
    usePosSettingsStore.setState({ kotPrintingEnabled: true });
    useAuthStore.setState({
      currentTenant: {
        id: 101,
        business_name: 'Cafe One',
        country: 'US',
        currency: 'USD',
        timezone: 'UTC',
      } as any,
    });
    usePrinterStore.setState({
      printMethod: 'browser',
      hardwarePrinter: null,
      lastError: null,
    });

    let browserBillErr: unknown = null;
    try {
      await usePrinterStore.getState().printBill(
        {
          id: 1,
          bill_number: 'B-1',
          subtotal: 10,
          tax_amount: 0,
          discount_amount: 0,
          total: 10,
          payment_status: 'paid',
          created_at: '2026-11-09T12:00:00Z',
          items: [],
        } as any,
        {
          business_name: 'Cafe One',
          currency: 'USD',
          country: 'US',
          timezone: 'UTC',
        },
        undefined,
        null,
      );
    } catch (err) {
      browserBillErr = err;
    }
    assert(browserBillErr instanceof PrinterOperationError);
    assert.equal(browserBillErr.failure_class, 'unsupported');
    assert.equal(browserBillErr.connection_type, 'unknown');
    assert.equal(browserBillErr.correlation_id, null);
    assert.equal(browserBillErr.capture_point, null);

    let browserKotErr: unknown = null;
    try {
      await usePrinterStore.getState().printKot({
        id: 1,
        order_number: 'ORD-1',
        type: 'dine_in',
        status: 'pending',
        subtotal: 10,
        tax_amount: 0,
        discount_amount: 0,
        total: 10,
        created_at: '2026-11-09T12:00:00Z',
        items: [
          {
            id: 1,
            product_id: 'p1',
            product_name: 'Soup',
            quantity: 1,
            unit_price: 10,
            subtotal: 10,
          },
        ],
      } as any);
    } catch (err) {
      browserKotErr = err;
    }
    assert(browserKotErr instanceof PrinterOperationError);
    assert.equal(browserKotErr.failure_class, 'unsupported');
    assert.equal(browserKotErr.connection_type, 'unknown');
    assert.equal(browserKotErr.correlation_id, null);
    assert.equal(browserKotErr.capture_point, null);

    // Mid-flight tenant switch during printKot cancels with PrintCancelledOnTenantChangeError
    let rejectKotPost!: (reason?: unknown) => void;
    frontendApi.post = () =>
      new Promise((_resolve, reject) => {
        rejectKotPost = reject;
      });
    Object.defineProperty(printerService, 'isConnected', {
      configurable: true,
      get: () => false,
    });
    usePrinterStore.setState({
      printMethod: 'escpos',
      hardwarePrinter: {
        id: 'hw-kot',
        name: 'Kitchen USB',
        connection_type: 'usb',
        is_default: 1,
      } as any,
      lastError: null,
    });
    const kotInFlight = usePrinterStore.getState().printKot({
      id: 2,
      order_number: 'ORD-2',
      type: 'dine_in',
      status: 'pending',
      subtotal: 10,
      tax_amount: 0,
      discount_amount: 0,
      total: 10,
      created_at: '2026-11-09T12:00:00Z',
      items: [
        {
          id: 2,
          product_id: 'p1',
          product_name: 'Soup',
          quantity: 1,
          unit_price: 10,
          subtotal: 10,
        },
      ],
    } as any);
    useAuthStore.setState({
      currentTenant: {
        id: 202,
        business_name: 'Cafe Two',
        country: 'US',
        currency: 'USD',
        timezone: 'UTC',
      } as any,
    });
    rejectKotPost({
      response: {
        status: 502,
        data: { error: 'Print failed', detail: 'Printer offline', failure_class: 'offline' },
      },
    });
    let cancelledKotErr: unknown = null;
    try {
      await kotInFlight;
    } catch (err) {
      cancelledKotErr = err;
    }
    assert(
      cancelledKotErr instanceof PrintCancelledOnTenantChangeError &&
        isPrintCancelledOnTenantChangeError(cancelledKotErr),
      'printKot throws PrintCancelledOnTenantChangeError when tenant switches mid-print',
    );
    assert.equal(
      usePrinterStore.getState().lastError,
      null,
      'printKot leaves lastError null on tenant change',
    );

    // 10. Finding #8: printDeliverySlip preserves PrinterOperationError metadata (failure_class, connection_type, code, correlation_id)
    const deliveryCorrId = '550e8400-e29b-41d4-a716-446655440999';
    frontendApi.post = async () => {
      throw {
        response: {
          status: 502,
          data: {
            error: 'Printer is offline',
            detail: 'Printer is offline',
            failure_class: 'offline',
            connection_type: 'usb',
            code: 'print.receipt.failed',
            correlation_id: deliveryCorrId,
            stage: 'dispatch',
          },
        },
      };
    };
    let deliveryErr: unknown = null;
    try {
      await usePrinterStore.getState().printDeliverySlip(
        {
          id: 99,
          order_number: 'ORD-99',
          type: 'delivery',
          status: 'pending',
          subtotal: 20,
          tax_amount: 0,
          discount_amount: 0,
          total: 20,
          created_at: '2026-11-09T12:00:00Z',
          items: [],
        } as any,
        { name: 'Customer', phone: '555-0100', address: '123 Main St' },
      );
    } catch (err) {
      deliveryErr = err;
    }
    assert(
      deliveryErr instanceof PrinterOperationError,
      'printDeliverySlip throws PrinterOperationError on 502 failure',
    );
    assert.equal(deliveryErr.failure_class, 'offline');
    assert.equal(deliveryErr.connection_type, 'usb');
    assert.equal(deliveryErr.correlation_id, deliveryCorrId);

    // 11. Finding #3 & #4 UI contracts: forceMount Settings guards + model/width forwarding
    const printersTabSrc = readFileSync(
      path.resolve(__dirname, '../frontend/src/components/settings/PrintersSettingsTab.tsx'),
      'utf8',
    );
    const lanDiscoverySrc = readFileSync(
      path.resolve(__dirname, '../frontend/src/components/settings/LanPrinterDiscovery.tsx'),
      'utf8',
    );
    const statusBadgeSrc = readFileSync(
      path.resolve(__dirname, '../frontend/src/components/settings/PrinterStatusBadge.tsx'),
      'utf8',
    );
    assert(
      /\{canManagePrinters\s*&&\s*\(\s*<PrinterStatusBadge[\s\S]*?enabled=\{isActive\}/.test(
        printersTabSrc,
      ),
      'PrinterStatusBadge is gated by canManagePrinters and enabled={isActive}',
    );
    assert(
      /<LanPrinterDiscovery[\s\S]*?enabled=\{isActive\}/.test(printersTabSrc),
      'LanPrinterDiscovery receives enabled={isActive}',
    );
    assert(
      /if\s*\(\s*!enabled\b/.test(lanDiscoverySrc),
      'LanPrinterDiscovery guards its scan effect on enabled',
    );
    assert(
      /if\s*\(\s*!enabled\b/.test(statusBadgeSrc),
      'PrinterStatusBadge guards its status effect on enabled',
    );
    assert(
      /fresh:\s*'1'/.test(statusBadgeSrc),
      'PrinterStatusBadge passes fresh=1 when refreshKey > 0',
    );
    assert(
      /model:\s*printer\.model/.test(lanDiscoverySrc),
      'LanPrinterDiscovery forwards printer.model in onAdd',
    );
    assert(
      /!editingPrinterId\s*&&\s*!paperWidthTouched\s*&&\s*!printerForm\.profile_id/.test(
        printersTabSrc,
      ),
      'savePrinterHw omits default paper_width on new auto-profile add',
    );

    // 12. F-11: formatPrinterSettingsErrorMessage surfaces plain Error details (e.g. WebUSB errors) sanitized
    const identityTranslator = ((key: string) => key) as any;
    assert.equal(
      formatPrinterSettingsErrorMessage(
        new Error('Browser print mode is active. Use window.print() instead.'),
        'Test print failed',
        identityTranslator,
      ),
      'Test print failed: Browser print mode is active. Use window.print() instead.',
    );
    assert.equal(
      formatPrinterSettingsErrorMessage(
        new Error('USB access denied. On Windows, replace the USB driver with WinUSB using Zadig.'),
        'Test print failed',
        identityTranslator,
      ),
      'Test print failed: USB access denied. On Windows, replace the USB driver with WinUSB using Zadig.',
    );
    assert.equal(
      formatPrinterSettingsErrorMessage(
        new Error('Test print failed'),
        'Test print failed',
        identityTranslator,
      ),
      'Test print failed',
    );

    // 13. FC-04 & F-13: await pending WebUSB reconnect before host fallback, and only cache
    //     lastResolvedUsbDevice after a successful /printers refresh.
    const origWindow = (globalThis as any).window;
    const origNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    delete (printerService as any).isConnected;
    let releaseClaim!: () => void;
    let signalClaimStarted!: () => void;
    let claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let claimStarted = new Promise<void>((resolve) => {
      signalClaimStarted = resolve;
    });
    const usbTransfers: Uint8Array[] = [];
    const mockUsbDevice = {
      vendorId: 0x04b8,
      productId: 0x0202,
      productName: 'TM-T88V-F13-Test',
      serialNumber: 'sn-fc04',
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
        signalClaimStarted();
        await claimGate;
      },
      releaseInterface: async () => {},
      close: async () => {},
      transferOut: async (_endpoint: number, data: ArrayBuffer) => {
        usbTransfers.push(new Uint8Array(data));
        return { status: 'ok', bytesWritten: data.byteLength };
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        usb: {
          getDevices: async () => [mockUsbDevice],
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      },
    });
    (globalThis as any).window = { open: () => ({ closed: false, close: () => {} }) };

    try {
      const hostPosts: string[] = [];
      let printerGetCalls = 0;
      let failFirstPrinterGet = true;
      frontendApi.post = async (url: string) => {
        hostPosts.push(url);
        return { data: { warnings: [] } };
      };
      frontendApi.get = async (url: string) => {
        if (url === '/printers') {
          printerGetCalls += 1;
          if (failFirstPrinterGet) {
            failFirstPrinterGet = false;
            throw new Error('Transient /printers failure');
          }
          return {
            data: {
              printers: [
                {
                  id: 'host-1',
                  name: 'Host Printer',
                  connection_type: 'network',
                  is_default: 1,
                },
                {
                  id: 'usb-58',
                  name: 'TM-T88V-F13-Test',
                  connection_type: 'webusb',
                  paper_width: '58mm',
                  is_default: 0,
                },
              ],
            },
          };
        }
        return { data: {} };
      };

      printerService.setPrintMode('escpos');
      usePrinterStore.setState({
        printMethod: 'escpos',
        hardwarePrinter: {
          id: 'host-1',
          name: 'Host Printer',
          connection_type: 'network',
          is_default: 1,
        } as any,
        webusbPrinter: null,
        lastError: null,
      });

      // Start silent reconnect, hold inside claimInterface, then call printBill()
      const reconnectPromise = printerService.tryReconnect();
      await claimStarted;

      const sampleBill = {
        id: 501,
        bill_number: 'INV-FC04',
        subtotal: 10,
        tax_amount: 0,
        discount_amount: 0,
        total: 10,
        payment_status: 'paid',
        created_at: '2026-11-27T12:00:00Z',
        items: [],
      } as any;
      const sampleTenant = {
        business_name: 'Cafe One',
        currency: 'USD',
        country: 'US',
        timezone: 'UTC',
      };

      const billPrintPromise = usePrinterStore
        .getState()
        .printBill(sampleBill, sampleTenant, undefined, null);
      // Give the microtask queue a tick before releasing the USB claim so any premature
      // host dispatch would execute immediately while reconnect is still pending.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        hostPosts,
        [],
        'printBill must await pending WebUSB reconnect before falling back to host printer',
      );
      releaseClaim();
      await reconnectPromise;
      await billPrintPromise;
      assert.equal(hostPosts.length, 0, 'printBill must print to reconnected local WebUSB');
      assert.equal(usbTransfers.length, 1, 'printBill transferred ESC/POS bytes via WebUSB');

      // F-13: first /printers call failed, so webusbPrinter remained null; next print must retry /printers
      assert.equal(printerGetCalls, 1);
      assert.equal(usePrinterStore.getState().webusbPrinter, null);

      // Now test printDeliverySlip while reconnect is pending (reset claim gate first)
      await printerService.disconnect();
      claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      claimStarted = new Promise<void>((resolve) => {
        signalClaimStarted = resolve;
      });
      const reconnectSlipPromise = printerService.tryReconnect();
      await claimStarted;

      const slipPrintPromise = usePrinterStore.getState().printDeliverySlip(
        {
          id: 502,
          order_number: 'ORD-FC04',
          type: 'delivery',
          status: 'pending',
          subtotal: 15,
          tax_amount: 0,
          discount_amount: 0,
          total: 15,
          created_at: '2026-11-27T12:00:00Z',
          items: [{ id: 1, product_id: 'p1', product_name: 'Tea', quantity: 1 }],
        } as any,
        { name: 'Alice', phone: '555-0101', address: '42 Oak Ave' },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(
        hostPosts,
        [],
        'printDeliverySlip must await pending WebUSB reconnect before falling back to host printer',
      );
      releaseClaim();
      await reconnectSlipPromise;
      await slipPrintPromise;
      assert.equal(hostPosts.length, 0, 'printDeliverySlip must print to reconnected local WebUSB');
      assert.equal(
        usbTransfers.length,
        2,
        'printDeliverySlip transferred ESC/POS bytes via WebUSB',
      );

      // F-13: second /printers call succeeded, populating webusbPrinter (58mm)
      assert.equal(printerGetCalls, 2, 'F-13: /printers retried after transient error');
      assert.equal(usePrinterStore.getState().webusbPrinter?.paper_width, '58mm');

      // Subsequent print with same connected device should reuse cached resolution (no 3rd GET /printers)
      await usePrinterStore.getState().printBill(sampleBill, sampleTenant, undefined, null);
      assert.equal(printerGetCalls, 2, 'cached device skips redundant /printers refresh');

      // Desktop mode (window.electronAPI present) still dispatches to host even when WebUSB is connected
      (globalThis as any).window = { electronAPI: { platform: 'darwin' } };
      await usePrinterStore.getState().printBill(sampleBill, sampleTenant, undefined, null);
      assert.deepEqual(
        hostPosts,
        ['/printers/print-bill'],
        'desktop mode preserves host printer priority over local WebUSB',
      );
    } finally {
      await printerService.disconnect();
      if (origWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = origWindow;
      }
      if (origNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', origNavigatorDesc);
      } else {
        delete (globalThis as any).navigator;
      }
    }
  } finally {
    if (origIsConnected) {
      Object.defineProperty(printerService, 'isConnected', origIsConnected);
    } else {
      delete (printerService as any).isConnected;
    }
    frontendApi.post = origPost;
    frontendApi.get = origGet;
    mod._resolveFilename = originalResolveFilename;
  }

  console.log('✓ All printer error toast clarity tests passed.');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
