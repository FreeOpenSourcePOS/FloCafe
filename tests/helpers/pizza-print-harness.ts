/**
 * Shared harness for the pizza print suites. Require it before anything from
 * `main/`: it installs the Electron mock that `main/db` needs.
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-pizza-print-'));
const originalLoad = Module._load;
Module._load = function (request: string) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const setup = require('./test-setup');
const { measureEscPos } = require('./receipt-column-measure');

type FrontendPrintModules = {
  kotEncoder: typeof import('../../frontend/src/lib/printer/kot-encoder');
  kotWebPrint: typeof import('../../frontend/src/lib/printer/kot-web-print');
  printDocument: typeof import('../../frontend/src/lib/printer/print-document');
  receiptEncoder: typeof import('../../frontend/src/lib/printer/receipt-encoder');
  printerService: typeof import('../../frontend/src/lib/printer/PrinterService');
  posSettings: typeof import('../../frontend/src/store/pos-settings');
  auth: typeof import('../../frontend/src/store/auth');
  usePrinter: typeof import('../../frontend/src/hooks/usePrinter');
  api: any;
};

/**
 * Load the browser print modules. The production path aliases stay remapped
 * afterwards, because the print hook imports some modules only when it prints.
 */
function loadFrontend(): FrontendPrintModules {
  const originalResolveFilename = Module._resolveFilename;
  const aliases: Array<[string, string]> = [
    ['@/', '../../frontend/src'],
    ['@print/', '../../shared/print'],
    ['@shared/', '../../shared'],
  ];
  Module._resolveFilename = function (request: string, ...rest: any[]) {
    let resolved = request;
    if (request === '@countries') resolved = path.resolve(__dirname, '../../main/countries.ts');
    for (const [prefix, target] of aliases) {
      if (request.startsWith(prefix))
        resolved = path.resolve(__dirname, target, request.slice(prefix.length));
    }
    return originalResolveFilename.call(this, resolved, ...rest);
  };
  const apiClient = require('../../frontend/src/lib/api');
  return {
    kotEncoder: require('../../frontend/src/lib/printer/kot-encoder'),
    kotWebPrint: require('../../frontend/src/lib/printer/kot-web-print'),
    printDocument: require('../../frontend/src/lib/printer/print-document'),
    receiptEncoder: require('../../frontend/src/lib/printer/receipt-encoder'),
    printerService: require('../../frontend/src/lib/printer/PrinterService'),
    posSettings: require('../../frontend/src/store/pos-settings'),
    auth: require('../../frontend/src/store/auth'),
    usePrinter: require('../../frontend/src/hooks/usePrinter'),
    api: apiClient.default || apiClient,
  };
}

/** Printed rows decoded from real ESC/POS bytes, leading spaces kept. */
function rows(bytes: Buffer | Uint8Array): string[] {
  return measureEscPos(bytes).lines.map((line: { text: string }) => line.text);
}

/**
 * Run every case even when an earlier one fails, so one run shows which cases
 * are red, then exit non-zero if any failed.
 */
async function runCases(suite: string, cases: Record<string, () => void | Promise<void>>) {
  const failed: string[] = [];
  for (const [name, run] of Object.entries(cases)) {
    console.log(`\n${name}`);
    try {
      await run();
    } catch (error) {
      failed.push(name);
      console.error(`  FAILED: ${(error as Error).message}`);
    }
  }
  const total = Object.keys(cases).length;
  console.log(`\n${suite}: ${total - failed.length} of ${total} cases passed.`);
  if (failed.length > 0) {
    console.error(`${suite}: failing cases:\n${failed.map((name) => `  - ${name}`).join('\n')}`);
    process.exit(1);
  }
  process.exit(0);
}

module.exports = { ...setup, loadFrontend, rows, runCases, testDir };
