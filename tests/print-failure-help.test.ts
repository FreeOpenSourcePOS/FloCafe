/**
 * Print failure hints: the cause reported by the printer wins over the failure
 * class, the offline step differs per desktop platform, and an unknown class
 * keeps the message the printer path already produced.
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-print-help-'));
const originalLoad = Module._load;
Module._load = function (request: string) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const moduleApi = Module as unknown as { _resolveFilename: (...args: any[]) => string };
const originalResolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options?: any,
) {
  const resolvedRequest = request.startsWith('@print/')
    ? path.resolve(__dirname, '../shared/print', request.slice('@print/'.length))
    : request.startsWith('@shared/')
      ? path.resolve(__dirname, '../shared', request.slice('@shared/'.length))
      : request === '@countries'
        ? path.resolve(__dirname, '../main/countries.ts')
        : request.startsWith('@/')
          ? path.resolve(__dirname, '../frontend/src', request.slice('@/'.length))
          : request;
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const { assertEqualOrThrow, assertOrThrow } = require('./helpers/test-setup');
const { printFailureHint } = require('../frontend/src/lib/printer/print-failure-help');
const {
  extractPrintErrorToastOptions,
  formatKotErrorToast,
  formatReceiptErrorToast,
} = require('../frontend/src/lib/printer/warnings');
const en = require('../frontend/src/lib/i18n/messages/en.json');

const FIX = en.printWarnings.fix;

/** Stands in for the app translator; a key missing from en.json fails the test. */
function t(key: string): string {
  const value = key.split('.').reduce<any>((node, part) => node?.[part], en);
  if (typeof value !== 'string') throw new Error(`missing message: ${key}`);
  return value;
}

// ── Cause beats failure class ────────────────────────────────────────────────
assertEqualOrThrow(
  printFailureHint({ cause: 'paper_out', failureClass: 'driver_error', platform: 'win32' }, t),
  FIX.cause.paper_out,
  'cause wins over failure_class',
);
assertEqualOrThrow(
  printFailureHint({ cause: 'unreachable', platform: 'darwin' }, t),
  FIX.cause.unreachable,
  'cause alone returns its hint',
);
assertEqualOrThrow(
  printFailureHint({ cause: 'queue_missing', platform: 'linux' }, t),
  FIX.cause.queue_missing,
  'queue_missing cause returns its hint',
);

// ── The offline step is different on each desktop platform ───────────────────
const winText = printFailureHint({ failureClass: 'offline', platform: 'win32' }, t);
const macText = printFailureHint({ failureClass: 'offline', platform: 'darwin' }, t);
const linuxText = printFailureHint({ failureClass: 'offline', platform: 'linux' }, t);
assertEqualOrThrow(winText, FIX.class.offline.win32, 'offline on Windows');
assertEqualOrThrow(macText, FIX.class.offline.darwin, 'offline on macOS');
assertEqualOrThrow(linuxText, FIX.class.offline.linux, 'offline on Linux');
assertEqualOrThrow(
  printFailureHint({ failureClass: 'offline', connectionType: 'network', platform: 'linux' }, t),
  FIX.cause.unreachable,
  'a direct network printer that does not answer gets the cable step, not the OS queue step',
);
assertEqualOrThrow(
  printFailureHint({ failureClass: 'offline', connectionType: 'usb', platform: 'win32' }, t),
  FIX.class.offline.win32,
  'an OS queue that is offline keeps the queue step',
);
assertOrThrow(
  winText !== macText && macText !== linuxText && winText !== linuxText,
  'the Windows, macOS and Linux offline texts differ',
);
assertEqualOrThrow(
  printFailureHint({ failureClass: 'queue_offline', platform: 'win32' }, t),
  winText,
  'queue_offline uses the same Windows step as offline',
);
assertEqualOrThrow(
  printFailureHint({ failureClass: 'offline', platform: 'freebsd' }, t),
  linuxText,
  'an unknown platform gets the CUPS step',
);
assertEqualOrThrow(
  printFailureHint({ failureClass: 'driver_error' }, t),
  FIX.class.driver_error,
  'driver_error hint',
);

// ── A queue refusal from an SNMP-checked port carries its own step ──────────
const SNMP_DETAIL = 'printer is offline (SNMP status is enabled on this printer port)';
assertEqualOrThrow(
  printFailureHint({ failureClass: 'offline', platform: 'win32', detail: SNMP_DETAIL }, t),
  FIX.cause.queue_offline_snmp,
  'the SNMP port detail beats the failure class',
);
assertEqualOrThrow(
  formatReceiptErrorToast(SNMP_DETAIL, 'Receipt print failed', { failureClass: 'offline' }),
  FIX.cause.queue_offline_snmp,
  'formatReceiptErrorToast shows the SNMP port step',
);
assertEqualOrThrow(
  printFailureHint({ failureClass: 'offline', platform: 'win32', detail: 'printer is offline' }, t),
  FIX.class.offline.win32,
  'a refusal without the SNMP note keeps the class hint',
);

// ── Unknown classes keep the current message ────────────────────────────────
assertEqualOrThrow(
  printFailureHint({ failureClass: 'write_error' }, t),
  null,
  'write_error has no hint',
);
assertEqualOrThrow(printFailureHint({}, t), null, 'no cause and no class returns null');
assertEqualOrThrow(
  printFailureHint({ cause: 'something_new', failureClass: 'unknown' }, t),
  null,
  'an unrecognised cause returns null',
);

// ── Toast paths use the hint and keep the old paths ─────────────────────────
assertEqualOrThrow(
  formatKotErrorToast('print failed', 'KOT print failed', { failureClass: 'driver_error' }),
  FIX.class.driver_error,
  'formatKotErrorToast returns the failure_class hint',
);
assertEqualOrThrow(
  formatKotErrorToast('WritePrinter failed', 'KOT print failed', { cause: 'cover_open' }),
  FIX.cause.cover_open,
  'formatKotErrorToast prefers the cause hint',
);
assertEqualOrThrow(
  formatReceiptErrorToast('print failed', 'Receipt print failed', { failureClass: 'offline' }),
  FIX.class.offline.linux,
  'formatReceiptErrorToast uses the offline hint, CUPS text outside Electron',
);
assertEqualOrThrow(
  formatReceiptErrorToast('Use Printer Offline', 'Receipt print failed'),
  t('printWarnings.printerOfflineHint'),
  'the Windows offline detail still returns printerOfflineHint',
);
assertEqualOrThrow(
  formatReceiptErrorToast('Timed out connecting', 'Receipt print failed', {
    failureClass: 'write_error',
  }),
  'Receipt print failed (Timed out connecting)',
  'a class without a hint keeps the existing detail text',
);
assertEqualOrThrow(
  formatReceiptErrorToast('Receipt not printed: no default printer', 'Receipt print failed', {
    failureClass: 'offline',
  }),
  'Receipt not printed: no default printer',
  'an explained "Receipt not printed" detail wins over the class hint',
);

// The Orders page passes the 502 body of a refused print, as the walk saw it.
const refused = {
  response: {
    data: {
      error: 'Network error: connect ECONNREFUSED',
      detail: 'Network error: connect ECONNREFUSED',
      failure_class: 'offline',
      cause: null,
    },
  },
};
assertEqualOrThrow(
  formatReceiptErrorToast(
    'Network error: connect ECONNREFUSED',
    'Failed to print receipt',
    extractPrintErrorToastOptions(refused),
  ),
  FIX.class.offline.linux,
  'an Orders-page 502 with failure_class shows the offline fix step',
);
// usePrinter.printBill rejects with a PrinterOperationError, which carries failure_class itself.
const operationError = Object.assign(new Error('Network error: connect ECONNREFUSED'), {
  failure_class: 'offline',
  cause: new Error('socket'),
});
assertEqualOrThrow(
  extractPrintErrorToastOptions(operationError).failureClass,
  'offline',
  'a PrinterOperationError keeps its failure class',
);
assertEqualOrThrow(
  extractPrintErrorToastOptions(Object.assign(new Error('x'), { connection_type: 'network' }))
    .connectionType,
  'network',
  'the connection type reaches the hint',
);
assertEqualOrThrow(
  extractPrintErrorToastOptions(operationError).cause,
  null,
  'an Error.cause object is not a printer cause',
);
assertEqualOrThrow(
  extractPrintErrorToastOptions(new Error('boom')).failureClass,
  null,
  'a plain error has no failure class',
);

console.log('print failure help tests passed');
