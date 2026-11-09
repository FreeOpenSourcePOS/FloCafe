import assert from 'node:assert/strict';
import path from 'node:path';
import moduleApi from 'node:module';
import {
  PrinterOperationError,
  buildPrinterOperationFailureSupportPayload,
  sanitizePrinterErrorDetail,
  toPrinterOperationError,
} from '../frontend/src/lib/operation-failure';

function loadFrontendWarnings(): typeof import('../frontend/src/lib/printer/warnings') {
  const mod = moduleApi as unknown as { _resolveFilename: (...args: any[]) => string };
  const originalResolveFilename = mod._resolveFilename;
  mod._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    const resolvedRequest = request.startsWith('@print/')
      ? path.resolve(__dirname, '../shared/print', request.slice('@print/'.length))
      : request.startsWith('@/')
        ? path.resolve(__dirname, '../frontend/src', request.slice('@/'.length))
        : request;
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  try {
    return require('../frontend/src/lib/printer/warnings');
  } finally {
    mod._resolveFilename = originalResolveFilename;
  }
}

const { formatReceiptErrorToast, formatKotErrorToast, extractPrinterErrorMessage } =
  loadFrontendWarnings();

function runTests(): void {
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

  // KOT timeout maps to fc.backend.printer.kot.timeout and normalizes bluetooth/serial to usb
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

  console.log('✓ All printer error toast clarity tests passed.');
}

runTests();
