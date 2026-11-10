import assert from 'node:assert/strict';
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

const { formatReceiptErrorToast, formatKotErrorToast, extractPrinterErrorMessage } =
  require('../frontend/src/lib/printer/warnings') as WarningsMod;
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
