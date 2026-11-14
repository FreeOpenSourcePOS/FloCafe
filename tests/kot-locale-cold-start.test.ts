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
moduleApi._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options?: any,
) {
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
    check(
      'KOT labels render in the fixed fa language on cold start',
      html.includes('برگ سفارش آشپزخانه'),
      html.slice(0, 200),
    );
    check('KOT labels do NOT fall back to English', !html.includes('KITCHEN ORDER TICKET'));
    check('order number still rendered', html.includes('ORD-KOT-COLD-001'));
  } finally {
    (printerService as any).printViaBrowser = originalPrintViaBrowser;
    // Restore store defaults so later suites in the same process are unaffected.
    settings.setKotLanguagePolicy(policy.defaultPrintLanguagePolicy() as never);
    settings.setLanguage('en');
  }

  // ------------------------------------------------------------------
  // Scenario 2: the ticket locale's bundle FAILS to load. Printing must
  // still proceed (offline-first graceful degradation to English) but the
  // failure must be surfaced via the returned print warnings (Greptile P1).
  // ------------------------------------------------------------------
  {
    settings.setKotLanguagePolicy({ primary: { mode: 'fixed', language: 'fa' }, additional: [] });
    const loaderModule = require('../frontend/src/lib/i18n/loader');
    const originalLoad = loaderModule.loadLocaleMessages;
    loaderModule.loadLocaleMessages = async (lang: string) => {
      if (lang === 'fa') throw new Error('simulated offline bundle fetch failure');
      return originalLoad(lang);
    };

    const failureCaptured: string[] = [];
    (printerService as any).printViaBrowser = async (html: string): Promise<void> => {
      failureCaptured.push(html);
    };

    try {
      const order = {
        id: 2,
        order_number: 'ORD-KOT-COLD-002',
        type: 'dine_in',
        status: 'pending',
        created_at: '2026-08-22T18:42:00Z',
        items: [
          {
            product_name: 'Espresso',
            quantity: 1,
            status: 'pending',
            addons: [],
            special_instructions: null,
          },
        ],
      } as any;

      let warnings: PrintWarning[] = [];
      try {
        warnings = await printerStore.getState().printKot(order);
      } catch (err) {
        check('failed locale load does not abort printing', false, String(err));
      }

      check('KOT print proceeds despite failed locale load', failureCaptured.length === 1);
      check(
        'failed KOT locale is surfaced as a print warning',
        warnings.some(
          (w) =>
            w.field === 'kot language' && w.text === 'fa' && /could not be loaded/.test(w.message),
        ),
        JSON.stringify(warnings),
      );
      // Note: scenario 1 already warmed the fa cache, so the ticket may
      // render cached Persian labels here; what matters is that printing
      // proceeds and the failure is surfaced rather than silent.
      check(
        'ticket still renders content',
        (failureCaptured[0] ?? '').includes('ORD-KOT-COLD-002'),
      );
    } finally {
      loaderModule.loadLocaleMessages = originalLoad;
      (printerService as any).printViaBrowser = originalPrintViaBrowser;
      settings.setKotLanguagePolicy(policy.defaultPrintLanguagePolicy() as never);
      settings.setLanguage('en');
    }
  }

  // Scenario 3: KDS sign-in with delayed locale load gates immediate receipt and KOT
  // prints on bootstrap readiness so the first print uses the tenant's fixed locale.
  {
    const authModule =
      require('../frontend/src/store/auth') as typeof import('../frontend/src/store/auth');
    const webPrintModule =
      require('../frontend/src/lib/printer/web-print') as typeof import('../frontend/src/lib/printer/web-print');
    const loaderModule = require('../frontend/src/lib/i18n/loader');
    const originalLoad = loaderModule.loadLocaleMessages;
    const originalWindow = (globalThis as any).window;
    const originalLocalStorage = (globalThis as any).localStorage;
    const originalPrint = printerService.print.bind(printerService);
    const isConnectedDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(printerService),
      'isConnected',
    );

    const storageMap = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storageMap.set(k, v);
      },
      removeItem: (k: string) => {
        storageMap.delete(k);
      },
    };

    const makePopupWindow = (sink: string[]) => ({
      closed: false,
      close() {
        this.closed = true;
      },
      print() {},
      document: {
        readyState: 'complete',
        open() {},
        write(html: string) {
          sink.push(html);
        },
        close() {},
      },
    });

    try {
      check('fr messages are not cached before KDS sign-in', !loader.getCachedMessages('fr'));
      settings.setBillLanguagePolicy(policy.defaultPrintLanguagePolicy() as never);
      settings.setKotLanguagePolicy(policy.defaultPrintLanguagePolicy() as never);
      settings.setLanguage('en');
      settings.setKotPrintingEnabled(true);

      let releaseFrLoad!: () => void;
      const frLoadGate = new Promise<void>((resolve) => {
        releaseFrLoad = resolve;
      });
      loaderModule.loadLocaleMessages = async (lang: string) => {
        if (lang === 'fr') {
          await frLoadGate;
        }
        return originalLoad(lang);
      };

      const frTenant = {
        id: 77,
        business_name: 'Bistro Flo',
        business_type: 'cafe',
        country: 'FR',
        currency: 'EUR',
        timezone: 'Europe/Paris',
        plan: 'desktop',
        status: 'active',
        language: 'en',
        permission_ids: ['kds.view'],
        bill_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'fr' },
          additional: [],
        }),
        kot_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'fr' },
          additional: [],
        }),
      } as any;

      const sampleOrder = {
        id: 701,
        order_number: 'ORD-KDS-SYNC-001',
        type: 'dine_in',
        status: 'completed',
        subtotal: 20,
        tax_amount: 0,
        discount_amount: 0,
        total: 20,
        created_at: '2026-08-22T18:42:00Z',
        items: [
          {
            id: 1,
            order_id: 701,
            product_id: 'p1',
            product_name: 'Croissant',
            unit_price: 10,
            quantity: 2,
            subtotal: 20,
            tax_amount: 0,
            total: 20,
            status: 'pending',
            addons: [],
            special_instructions: null,
          },
        ],
      } as any;

      const sampleBill = {
        id: 901,
        bill_number: 'BILL-KDS-SYNC-001',
        order_id: 701,
        subtotal: 20,
        tax_amount: 0,
        discount_amount: 0,
        service_charge: 0,
        delivery_charge: 0,
        total: 20,
        paid_amount: 20,
        balance: 0,
        payment_status: 'paid',
        payment_details: [{ method: 'cash', amount: 20, timestamp: '2026-08-22T18:45:00Z' }],
        order: sampleOrder,
      } as any;

      const browserReceiptHtmls: string[] = [];
      const directWebBillHtmls: string[] = [];
      const kotHtmls: string[] = [];
      (globalThis as any).window = {
        dispatchEvent: () => true,
        open: () => makePopupWindow(directWebBillHtmls),
      };
      (printerService as any).printViaBrowser = async (html: string): Promise<void> => {
        kotHtmls.push(html);
      };
      printerStore.getState().setPrintMethod('browser');

      authModule.useAuthStore.getState().syncAuthenticatedSession({
        token: 'kds-token-fr',
        user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
        currentTenant: frTenant,
        tenants: [frTenant],
      });

      check(
        'syncAuthenticatedSession marks auth loading=false synchronously',
        authModule.useAuthStore.getState().loading === false,
      );

      // Start immediate browser receipt + direct printWebBill + KOT print BEFORE fr locale resolves.
      const reservedPopup = makePopupWindow(browserReceiptHtmls) as any;
      const immediateBillPrint = printerStore
        .getState()
        .printBill(sampleBill, frTenant, {}, reservedPopup);
      const immediateWebBillPrint = webPrintModule.printWebBill(sampleBill, frTenant, {});
      const immediateKotPrint = printerStore.getState().printKot(sampleOrder);

      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseFrLoad();
      await Promise.all([immediateBillPrint, immediateWebBillPrint, immediateKotPrint]);

      const firstBrowserHtml = browserReceiptHtmls[0] ?? '';
      check(
        'first browser printBill after KDS sign-in renders French locale tag',
        firstBrowserHtml.includes('<html lang="fr-FR" dir="ltr">'),
        firstBrowserHtml.slice(0, 160),
      );
      check(
        'first browser printBill after KDS sign-in renders French footer label',
        firstBrowserHtml.includes('Merci de votre visite !'),
      );
      const firstDirectWebHtml = directWebBillHtmls[0] ?? '';
      check(
        'first direct printWebBill after KDS sign-in renders French locale tag',
        firstDirectWebHtml.includes('<html lang="fr-FR" dir="ltr">'),
        firstDirectWebHtml.slice(0, 160),
      );
      const firstKotHtml = kotHtmls[0] ?? '';
      check(
        'first KOT print after KDS sign-in renders French banner',
        firstKotHtml.includes('BON DE COMMANDE CUISINE'),
        firstKotHtml.slice(0, 160),
      );

      // Verify WebUSB receipt path on a fresh uncached locale ('nl') with delayed load.
      check(
        'nl messages are not cached before WebUSB KDS sign-in',
        !loader.getCachedMessages('nl'),
      );
      let releaseNlLoad!: () => void;
      const nlLoadGate = new Promise<void>((resolve) => {
        releaseNlLoad = resolve;
      });
      loaderModule.loadLocaleMessages = async (lang: string) => {
        if (lang === 'nl') {
          await nlLoadGate;
        }
        return originalLoad(lang);
      };

      const nlTenant = {
        ...frTenant,
        id: 78,
        country: 'NL',
        bill_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'nl' },
          additional: [],
        }),
        kot_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'nl' },
          additional: [],
        }),
      };

      const webusbPayloads: Uint8Array[] = [];
      Object.defineProperty(printerService, 'isConnected', {
        configurable: true,
        get: () => true,
      });
      (printerService as any).print = async (bytes: Uint8Array): Promise<void> => {
        webusbPayloads.push(bytes);
      };
      printerStore.getState().setPrintMethod('escpos');

      authModule.useAuthStore.getState().syncAuthenticatedSession({
        token: 'kds-token-nl',
        user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
        currentTenant: nlTenant,
        tenants: [nlTenant],
      });

      const immediateWebUsbBill = printerStore.getState().printBill(sampleBill, nlTenant);
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseNlLoad();
      await immediateWebUsbBill;

      const webusbText = Buffer.from(webusbPayloads[0] ?? new Uint8Array()).toString('latin1');
      check(
        'first WebUSB printBill after KDS sign-in renders Dutch receipt labels',
        webusbText.includes('Factuurnr.: BILL-KDS-SYNC-001') &&
          webusbText.includes('Bedankt voor uw bezoek!'),
        webusbText.slice(0, 320),
      );

      // Scenario 4: clearing session while a bootstrap locale load is in flight releases waiters
      // and resets stale fixed policies back to default inherit.
      let releaseDeLoad!: () => void;
      const deLoadGate = new Promise<void>((resolve) => {
        releaseDeLoad = resolve;
      });
      loaderModule.loadLocaleMessages = async (lang: string) => {
        if (lang === 'de') {
          await deLoadGate;
        }
        return originalLoad(lang);
      };
      const deTenant = {
        ...frTenant,
        id: 79,
        country: 'DE',
        bill_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'de' },
          additional: [],
        }),
        kot_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'de' },
          additional: [],
        }),
      };
      authModule.useAuthStore.getState().syncAuthenticatedSession({
        token: 'kds-token-de',
        user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
        currentTenant: deTenant,
        tenants: [deTenant],
      });
      authModule.useAuthStore.getState().clearLocalSession();
      settings.setLanguage('en');
      directWebBillHtmls.length = 0;
      await webPrintModule.printWebBill(sampleBill, frTenant, {});
      check(
        'clearLocalSession releases pending bootstrap without hanging and resets policy to default',
        (directWebBillHtmls[0] ?? '').includes('<html lang="en" dir="ltr">'),
        (directWebBillHtmls[0] ?? '').slice(0, 160),
      );
      releaseDeLoad();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Scenario 5: token rotation via replaceSessionToken during KDS locale warmup
      // preserves policy ownership so Italian receipt and KOT policies still apply.
      check('it messages are not cached before rotation test', !loader.getCachedMessages('it'));
      let releaseItLoad!: () => void;
      const itLoadGate = new Promise<void>((resolve) => {
        releaseItLoad = resolve;
      });
      loaderModule.loadLocaleMessages = async (lang: string) => {
        if (lang === 'it') {
          await itLoadGate;
        }
        return originalLoad(lang);
      };
      const itTenant = {
        ...frTenant,
        id: 80,
        country: 'IT',
        bill_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'it' },
          additional: [],
        }),
        kot_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'it' },
          additional: [],
        }),
      };
      printerStore.getState().setPrintMethod('browser');
      browserReceiptHtmls.length = 0;
      kotHtmls.length = 0;
      authModule.useAuthStore.getState().syncAuthenticatedSession({
        token: 'kds-token-it-initial',
        user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
        currentTenant: itTenant,
        tenants: [itTenant],
      });
      authModule.useAuthStore.getState().replaceSessionToken('kds-token-it-rotated');
      check(
        'replaceSessionToken updates active JWT during bootstrap',
        authModule.useAuthStore.getState().token === 'kds-token-it-rotated',
      );
      const rotatedBillPopup = makePopupWindow(browserReceiptHtmls) as any;
      const rotatedBillPrint = printerStore
        .getState()
        .printBill(sampleBill, itTenant, {}, rotatedBillPopup);
      const rotatedKotPrint = printerStore.getState().printKot(sampleOrder);
      await new Promise((resolve) => setTimeout(resolve, 25));
      releaseItLoad();
      await Promise.all([rotatedBillPrint, rotatedKotPrint]);
      check(
        'receipt policy still applies after KDS token rotation during locale warmup',
        (browserReceiptHtmls[0] ?? '').includes('Grazie per la visita!'),
        (browserReceiptHtmls[0] ?? '').slice(0, 160),
      );
      check(
        'KOT policy still applies after KDS token rotation during locale warmup',
        (kotHtmls[0] ?? '').includes('BIGLIETTO ORDINE DI CUCINA'),
        (kotHtmls[0] ?? '').slice(0, 160),
      );

      // Scenario 6: hung locale fetch hits the bounded deadline, applies policies,
      // releases the bootstrap barrier, and falls back to English with a warning.
      const bootstrapModule =
        require('../frontend/src/lib/print-policy-bootstrap') as typeof import('../frontend/src/lib/print-policy-bootstrap');
      const printDocModule =
        require('../frontend/src/lib/printer/print-document') as typeof import('../frontend/src/lib/printer/print-document');
      loaderModule.loadLocaleMessages = async (lang: string) => {
        if (lang === 'ja') {
          return new Promise<never>(() => {});
        }
        return originalLoad(lang);
      };
      const jaTenant = {
        ...frTenant,
        id: 81,
        country: 'JP',
        bill_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'ja' },
          additional: [],
        }),
        kot_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'ja' },
          additional: [],
        }),
      };
      const startedAt = Date.now();
      const timedOutLanguages = await bootstrapModule.registerPrintPolicyBootstrap(
        bootstrapModule.syncPrintPoliciesAtBootstrap(
          jaTenant,
          posSettings.usePosSettingsStore,
          () => true,
          30,
        ),
      );
      const elapsedMs = Date.now() - startedAt;
      check(
        'hung locale load settles promptly at deadline and reports ja as failed',
        elapsedMs < 1000 && timedOutLanguages.includes('ja'),
        `elapsed=${elapsedMs}ms failed=${JSON.stringify(timedOutLanguages)}`,
      );
      check(
        'tenant receipt policy is still applied after bounded locale timeout',
        (posSettings.usePosSettingsStore.getState().billLanguagePolicy as any)?.primary
          ?.language === 'ja',
      );
      const docFailed = await printDocModule.ensurePrintLanguagesLoaded(['ja'], 30);
      check(
        'ensurePrintLanguagesLoaded also bounds hung locale fetches',
        docFailed.includes('ja'),
        JSON.stringify(docFailed),
      );

      // Scenario 7: printDeliverySlip cancels cleanly and closes reserved popup
      // if the active tenant changes while waiting on language bootstrap.
      const apiModule = require('../frontend/src/lib/api').default as {
        get: (...args: any[]) => Promise<any>;
      };
      const originalApiGet = apiModule.get;
      const originalReserve = printerService.reserveBrowserPrintWindow.bind(printerService);
      let paymentFetchCount = 0;
      apiModule.get = async (...args: any[]) => {
        if (String(args[0] ?? '').includes('/printers/delivery-slip-payment/')) {
          paymentFetchCount += 1;
        }
        return originalApiGet(...args);
      };
      const slipPopup = makePopupWindow([]) as any;
      (printerService as any).reserveBrowserPrintWindow = () => slipPopup;
      let releaseEsLoad!: () => void;
      const esLoadGate = new Promise<void>((resolve) => {
        releaseEsLoad = resolve;
      });
      loaderModule.loadLocaleMessages = async (lang: string) => {
        if (lang === 'es') {
          await esLoadGate;
        }
        return originalLoad(lang);
      };
      const esTenant = {
        ...frTenant,
        id: 82,
        country: 'ES',
        bill_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'es' },
          additional: [],
        }),
        kot_language_policy: JSON.stringify({
          primary: { mode: 'fixed', language: 'es' },
          additional: [],
        }),
      };
      try {
        authModule.useAuthStore.getState().syncAuthenticatedSession({
          token: 'kds-token-es',
          user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
          currentTenant: esTenant,
          tenants: [esTenant],
        });
        const slipPromise = printerStore
          .getState()
          .printDeliverySlip(sampleOrder, { name: 'Ana', phone: '5550100', address: 'Calle 1' });
        authModule.useAuthStore.getState().syncAuthenticatedSession({
          token: 'kds-token-fr-next',
          user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
          currentTenant: frTenant,
          tenants: [frTenant],
        });
        releaseEsLoad();
        let caughtSlipErr: unknown = null;
        try {
          await slipPromise;
        } catch (err) {
          caughtSlipErr = err;
        }
        check(
          'printDeliverySlip rejects with PrintCancelledOnTenantChangeError on tenant switch',
          usePrinter.isPrintCancelledOnTenantChangeError(caughtSlipErr),
          String(caughtSlipErr),
        );
        check('printDeliverySlip closes reserved popup on tenant switch', slipPopup.closed);
        check(
          'printDeliverySlip skips payment fetch and leaves lastError null on tenant switch',
          paymentFetchCount === 0 && printerStore.getState().lastError === null,
          `paymentFetchCount=${paymentFetchCount} lastError=${printerStore.getState().lastError}`,
        );
      } finally {
        apiModule.get = originalApiGet;
        (printerService as any).reserveBrowserPrintWindow = originalReserve;
        authModule.useAuthStore.getState().clearLocalSession();
      }

      // Scenario 8: print-test handlers (KOT browser print, receipt browser print,
      // and HTML download) cancel cleanly and close reserved popups when the
      // active tenant changes while waiting on language bootstrap.
      {
        const Module = require('node:module') as {
          _load: (request: string, parent: any, isMain: boolean) => any;
        };
        const originalModuleLoad = Module._load;
        const printTestPagePath =
          require.resolve('../frontend/src/app/(dashboard)/print-test/page');
        const originalReserve = printerService.reserveBrowserPrintWindow.bind(printerService);
        const savedWindow = (globalThis as any).window;
        const savedDocument = (globalThis as any).document;
        const savedCreateObjectURL = URL.createObjectURL;
        const savedRevokeObjectURL = URL.revokeObjectURL;

        const successToasts: string[] = [];
        const errorToasts: string[] = [];
        const states: any[] = [];
        let stateCursor = 0;

        const reactStub = {
          useState: <T>(initial: T | (() => T)) => {
            const idx = stateCursor++;
            if (!(idx in states)) {
              states[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
            }
            const setter = (next: T | ((prev: T) => T)) => {
              states[idx] =
                typeof next === 'function' ? (next as (prev: T) => T)(states[idx]) : next;
            };
            return [states[idx], setter] as const;
          },
          useMemo: <T>(factory: () => T) => factory(),
        };
        const jsxElement = (type: unknown, props: Record<string, any>, key?: unknown) => ({
          type,
          props: props ?? {},
          key,
        });
        const IconStub = () => null;
        const ButtonStub = (props: Record<string, any>) => ({ type: 'Button', props });
        const toastSpy = Object.assign(() => {}, {
          success: (msg: string) => {
            successToasts.push(String(msg));
          },
          error: (msg: string) => {
            errorToasts.push(String(msg));
          },
        });
        const hookableStore = <T extends { getState: () => any }>(store: T) =>
          Object.assign(
            (selector?: (state: any) => any) =>
              selector ? selector(store.getState()) : store.getState(),
            store,
          );

        const hasText = (node: unknown, target: string): boolean => {
          if (typeof node === 'string') return node === target;
          if (Array.isArray(node)) return node.some((child) => hasText(child, target));
          if (node && typeof node === 'object') {
            return hasText((node as { props?: { children?: unknown } }).props?.children, target);
          }
          return false;
        };
        const findElement = (
          node: unknown,
          predicate: (el: { type?: unknown; props?: Record<string, any> }) => boolean,
        ): { type?: unknown; props?: Record<string, any> } | undefined => {
          if (Array.isArray(node)) {
            for (const child of node) {
              const hit = findElement(child, predicate);
              if (hit) return hit;
            }
            return undefined;
          }
          if (!node || typeof node !== 'object') return undefined;
          const el = node as { type?: unknown; props?: Record<string, any> };
          if (predicate(el)) return el;
          return findElement(el.props?.children, predicate);
        };

        let releasePtLoad = () => {};
        let releaseTrLoad = () => {};
        let releaseDeReceiptLoad = () => {};

        try {
          delete require.cache[printTestPagePath];
          Module._load = function (request: string, parent: unknown, isMain: boolean) {
            if (request === 'react') return reactStub;
            if (request === 'react/jsx-runtime') {
              return { jsx: jsxElement, jsxs: jsxElement, Fragment: 'Fragment' };
            }
            if (request === 'use-intl') {
              return { useTranslations: (ns: string) => (key: string) => `${ns}.${key}` };
            }
            if (request === 'lucide-react') {
              return new Proxy({}, { get: () => IconStub });
            }
            if (request === 'react-hot-toast') {
              return { __esModule: true, default: toastSpy };
            }
            if (request === '@/components/ui/button') return { Button: ButtonStub };
            if (request === '@/store/auth') {
              return { ...authModule, useAuthStore: hookableStore(authModule.useAuthStore) };
            }
            if (request === '@/store/pos-settings') {
              return {
                ...posSettings,
                usePosSettingsStore: hookableStore(posSettings.usePosSettingsStore),
              };
            }
            if (request === '@/hooks/usePrinter') {
              return { ...usePrinter, usePrinterStore: hookableStore(usePrinter.usePrinterStore) };
            }
            return originalModuleLoad.apply(this, arguments as any);
          };

          const PrintTestPage = require(printTestPagePath).default as () => any;
          const renderPrintTestPage = () => {
            stateCursor = 0;
            return PrintTestPage();
          };

          // 8a: KOT browser test print closes reserved popup and cancels after bootstrap wait.
          const ptLoadGate = new Promise<void>((resolve) => {
            releasePtLoad = resolve;
          });
          const trLoadGate = new Promise<void>((resolve) => {
            releaseTrLoad = resolve;
          });
          const deReceiptLoadGate = new Promise<void>((resolve) => {
            releaseDeReceiptLoad = resolve;
          });
          loaderModule.loadLocaleMessages = async (lang: string) => {
            if (lang === 'pt') await ptLoadGate;
            if (lang === 'tr') await trLoadGate;
            if (lang === 'de') await deReceiptLoadGate;
            return originalLoad(lang);
          };

          const ptTenant = {
            ...frTenant,
            id: 83,
            country: 'PT',
            bill_language_policy: JSON.stringify({
              primary: { mode: 'fixed', language: 'pt' },
              additional: [],
            }),
            kot_language_policy: JSON.stringify({
              primary: { mode: 'fixed', language: 'pt' },
              additional: [],
            }),
          };
          const kotPopup = makePopupWindow(kotHtmls) as any;
          kotHtmls.length = 0;
          (printerService as any).reserveBrowserPrintWindow = () => kotPopup;
          printerStore.getState().setPrintMethod('browser');
          settings.setKotPrintingEnabled(true);

          authModule.useAuthStore.getState().syncAuthenticatedSession({
            token: 'kds-token-pt',
            user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
            currentTenant: ptTenant,
            tenants: [ptTenant],
          });

          let tree = renderPrintTestPage();
          const kotModeBtn = findElement(
            tree,
            (el) => el.type === 'button' && hasText(el, 'printTest.optionKot'),
          );
          check('print-test renders KOT option button', Boolean(kotModeBtn));
          kotModeBtn!.props.onClick();
          tree = renderPrintTestPage();
          const kotRunBtn = findElement(
            tree,
            (el) => el.type === 'Button' && hasText(el, 'printTest.runTest'),
          );
          const kotRunPromise = kotRunBtn!.props.onClick() as Promise<void>;
          await new Promise((resolve) => setTimeout(resolve, 15));
          authModule.useAuthStore.getState().syncAuthenticatedSession({
            token: 'kds-token-fr-switch-1',
            user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
            currentTenant: frTenant,
            tenants: [frTenant],
          });
          releasePtLoad();
          await kotRunPromise;
          tree = renderPrintTestPage();
          const kotRunBtnAfter = findElement(
            tree,
            (el) => el.type === 'Button' && hasText(el, 'printTest.runTest'),
          );
          check(
            'print-test KOT browser print cancels and closes popup on tenant change after bootstrap wait',
            kotPopup.closed === true &&
              kotHtmls.length === 0 &&
              successToasts.length === 0 &&
              errorToasts.length === 0 &&
              kotRunBtnAfter?.props.disabled === false,
            `closed=${kotPopup.closed} htmls=${kotHtmls.length} success=${successToasts.length} error=${errorToasts.length}`,
          );

          // 8b: Web-print HTML download cancels without creating blob/anchor on tenant change.
          let objectUrlCount = 0;
          let downloadAnchorClicks = 0;
          URL.createObjectURL = () => {
            objectUrlCount += 1;
            return 'blob:print-test';
          };
          URL.revokeObjectURL = () => {};
          (globalThis as any).document = {
            createElement: () => ({
              href: '',
              download: '',
              click: () => {
                downloadAnchorClicks += 1;
              },
            }),
          };

          const trTenant = {
            ...frTenant,
            id: 84,
            country: 'TR',
            bill_language_policy: JSON.stringify({
              primary: { mode: 'fixed', language: 'tr' },
              additional: [],
            }),
            kot_language_policy: JSON.stringify({
              primary: { mode: 'fixed', language: 'tr' },
              additional: [],
            }),
          };
          authModule.useAuthStore.getState().syncAuthenticatedSession({
            token: 'kds-token-tr',
            user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
            currentTenant: trTenant,
            tenants: [trTenant],
          });

          const webPrintModeBtn = findElement(
            tree,
            (el) => el.type === 'button' && hasText(el, 'printTest.optionWebPrint'),
          );
          webPrintModeBtn!.props.onClick();
          tree = renderPrintTestPage();
          const downloadBtn = findElement(
            tree,
            (el) => el.type === 'Button' && hasText(el, 'printTest.downloadHtml'),
          );
          check('print-test renders Download HTML button in web-print mode', Boolean(downloadBtn));
          const downloadPromise = downloadBtn!.props.onClick() as Promise<void>;
          await new Promise((resolve) => setTimeout(resolve, 15));
          authModule.useAuthStore.getState().syncAuthenticatedSession({
            token: 'kds-token-fr-switch-2',
            user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
            currentTenant: frTenant,
            tenants: [frTenant],
          });
          releaseTrLoad();
          await downloadPromise;
          check(
            'print-test HTML download cancels without download or toast on tenant change after bootstrap wait',
            objectUrlCount === 0 &&
              downloadAnchorClicks === 0 &&
              successToasts.length === 0 &&
              errorToasts.length === 0,
            `urls=${objectUrlCount} clicks=${downloadAnchorClicks} success=${successToasts.length} error=${errorToasts.length}`,
          );

          // 8c: Browser receipt print cancels and closes window.open popup on tenant change.
          const receiptPopupHtmls: string[] = [];
          const receiptPopup = makePopupWindow(receiptPopupHtmls) as any;
          (globalThis as any).window = {
            ...savedWindow,
            open: () => receiptPopup,
          };
          const deReceiptTenant = {
            ...frTenant,
            id: 85,
            country: 'DE',
            bill_language_policy: JSON.stringify({
              primary: { mode: 'fixed', language: 'de' },
              additional: [],
            }),
            kot_language_policy: JSON.stringify({
              primary: { mode: 'fixed', language: 'de' },
              additional: [],
            }),
          };
          authModule.useAuthStore.getState().syncAuthenticatedSession({
            token: 'kds-token-de-receipt',
            user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
            currentTenant: deReceiptTenant,
            tenants: [deReceiptTenant],
          });
          const receiptModeBtn = findElement(
            tree,
            (el) => el.type === 'button' && hasText(el, 'printTest.optionBasicReceipt'),
          );
          receiptModeBtn!.props.onClick();
          tree = renderPrintTestPage();
          const receiptRunBtn = findElement(
            tree,
            (el) => el.type === 'Button' && hasText(el, 'printTest.runTest'),
          );
          const receiptRunPromise = receiptRunBtn!.props.onClick() as Promise<void>;
          await new Promise((resolve) => setTimeout(resolve, 15));
          authModule.useAuthStore.getState().syncAuthenticatedSession({
            token: 'kds-token-fr-switch-3',
            user: { id: 'u-kds', name: 'Chef', email: 'chef@bistro.local', role: 'chef' } as any,
            currentTenant: frTenant,
            tenants: [frTenant],
          });
          releaseDeReceiptLoad();
          await receiptRunPromise;
          check(
            'print-test browser receipt cancels and closes popup on tenant change after bootstrap wait',
            receiptPopup.closed === true &&
              receiptPopupHtmls.length === 0 &&
              successToasts.length === 0 &&
              errorToasts.length === 0,
            `closed=${receiptPopup.closed} htmls=${receiptPopupHtmls.length} success=${successToasts.length} error=${errorToasts.length}`,
          );
        } finally {
          releasePtLoad();
          releaseTrLoad();
          releaseDeReceiptLoad();
          Module._load = originalModuleLoad;
          delete require.cache[printTestPagePath];
          (printerService as any).reserveBrowserPrintWindow = originalReserve;
          if (savedWindow === undefined) delete (globalThis as any).window;
          else (globalThis as any).window = savedWindow;
          if (savedDocument === undefined) delete (globalThis as any).document;
          else (globalThis as any).document = savedDocument;
          URL.createObjectURL = savedCreateObjectURL;
          URL.revokeObjectURL = savedRevokeObjectURL;
          authModule.useAuthStore.getState().clearLocalSession();
        }
      }
    } finally {
      loaderModule.loadLocaleMessages = originalLoad;
      (printerService as any).printViaBrowser = originalPrintViaBrowser;
      (printerService as any).print = originalPrint;
      if (isConnectedDescriptor) {
        Object.defineProperty(printerService, 'isConnected', isConnectedDescriptor);
      } else {
        delete (printerService as any).isConnected;
      }
      if (originalWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = originalWindow;
      if (originalLocalStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = originalLocalStorage;
      printerStore.getState().setPrintMethod('browser');
      settings.setBillLanguagePolicy(policy.defaultPrintLanguagePolicy() as never);
      settings.setKotLanguagePolicy(policy.defaultPrintLanguagePolicy() as never);
      settings.setLanguage('en');
    }
  }

  console.log(`\n${passed + failed} checks | ${passed} passed | ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
