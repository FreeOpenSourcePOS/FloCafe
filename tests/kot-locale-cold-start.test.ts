/**
 * KOT browser-print cold-start locale regression test (Greptile P1, PR #474).
 *
 * When a FIXED KOT language differs from the active UI language, a cold
 * start has only the UI locale in the shared message cache. The KOT print
 * path must load the ticket language's messages BEFORE generateKotHtml,
 * otherwise the cache-only translator silently falls back to English.
 *
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/kot-locale-cold-start.test.ts
 */

import assert from 'node:assert/strict';
import path from 'node:path';

type PrintWarning = { field: string; text: string; message: string };

const moduleApi = require('module') as {
  _resolveFilename: (...args: any[]) => string;
};
const originalResolveFilename = moduleApi._resolveFilename;

/** Keep alias resolution active for the whole run: usePrinter dynamically
 *  imports kot-web-print via '@/lib/printer/kot-web-print' at print time. */
moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request === '@countries') {
    resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
  } else if (request.startsWith('@/')) {
    resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
  } else if (request.startsWith('@print/')) {
    resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

function loadFrontendModules() {
  try {
    return {
      loader: require('../frontend/src/lib/i18n/loader'),
      posSettings: require('../frontend/src/store/pos-settings'),
      policy: require('../shared/print/policy'),
      usePrinter: require('../frontend/src/hooks/usePrinter'),
      printerServiceModule: require('../frontend/src/lib/printer/PrinterService'),
    };
  } finally {
    // Hook stays installed until process exit (see note above).
  }
}

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`   ✓ ${label}`);
  } else {
    failed++;
    console.log(`   ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function run(): Promise<void> {
  console.log('🧪 KOT browser-print cold-start locale regression (fixed KOT lang ≠ UI lang)');
  const { loader, posSettings, policy, usePrinter, printerServiceModule } = loadFrontendModules();

  // Cold start: prime ONLY the UI locale (en); fa stays out of the cache.
  await loader.loadLocaleMessages('en');
  check('fa messages are not cached at cold start', !loader.getCachedMessages('fa'));

  const settings = posSettings.usePosSettingsStore.getState();
  // Fixed KOT language (fa) while the active UI language is en.
  settings.setKotLanguagePolicy({ primary: { mode: 'fixed', language: 'fa' }, additional: [] });
  settings.setLanguage('en');
  settings.setKotPrintingEnabled(true);

  const printerStore = usePrinter.usePrinterStore;
  printerStore.getState().setPrintMethod('browser');

  // Capture the HTML the KOT print path hands to the browser dialog.
  const captured: string[] = [];
  const printerService = printerServiceModule.printerService as {
    printViaBrowser: (html: string, paperWidth: 58 | 80) => Promise<void>;
  };
  const originalPrintViaBrowser = printerService.printViaBrowser.bind(printerService);
  (printerService as any).printViaBrowser = async (html: string): Promise<void> => {
    captured.push(html);
  };

  try {
    const order = {
      id: 1,
      order_number: 'ORD-KOT-COLD-001',
      type: 'dine_in',
      status: 'pending',
      created_at: '2026-08-22T18:42:00Z',
      items: [
        {
          product_name: 'Espresso',
          quantity: 2,
          status: 'pending',
          addons: [],
          special_instructions: null,
        },
      ],
    } as any;

    await printerStore.getState().printKot(order);

    check('KOT browser print produced HTML', captured.length === 1);
    const html = captured[0] ?? '';
    // The fixed fa policy's banner label — proof the fa bundle was loaded
    // before generation instead of falling back to English.
    check('KOT labels render in the fixed fa language on cold start', html.includes('برگ سفارش آشپزخانه'), html.slice(0, 200));
    check('KOT labels do NOT fall back to English', !html.includes('KITCHEN ORDER TICKET'));
    check('order number still rendered', html.includes('ORD-KOT-COLD-001'));
  } finally {
    (printerService as any).printViaBrowser = originalPrintViaBrowser;
    // Restore store defaults so later suites in the same process are unaffected.
    settings.setKotLanguagePolicy(policy.defaultPrintLanguagePolicy() as never);
    settings.setLanguage('en');
  }

  console.log(`\n${passed + failed} checks | ${passed} passed | ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
