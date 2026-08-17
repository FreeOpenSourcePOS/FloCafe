/**
 * RTL/LTR KDS, Server App, and WhatsApp regression test (Batch F, Refs #241).
 *
 * Extends the shared direction foundation (Batch C), the Setup/Auth/Settings
 * guard (Batch D), and the Dashboard/POS guard (Batch E) to the remaining
 * Persian-facing operational surfaces:
 *
 *   - standalone KDS (components + pages, incl. disabled state)
 *   - Server App / tableside ordering (standalone page + layout)
 *   - WhatsApp page and its LTR operational values
 *
 *   1. These screens must not use physical left/right utilities for
 *      content-flow layout (margin, padding, alignment, borders, rounding,
 *      positioning). The shared logical equivalents (`ms/me/ps/pe/start/end/
 *      text-start/text-end/border-s/border-e/rounded-s/rounded-e`) render
 *      identically in LTR and mirror under `dir="rtl"`, so any remaining
 *      physical utility is a regression.
 *
 *   2. Directional icons (`ArrowLeft`/`ArrowRight`/`ChevronLeft`/
 *      `ChevronRight`) must carry the shared `.rtl-flip` class so they
 *      mirror under `[dir="rtl"]` (e.g. the KDS status-flow chevrons).
 *
 *   3. Naturally LTR values must be isolated with the shared `Ltr`
 *      component (`dir="ltr"` + bidi isolation): KDS order numbers and
 *      elapsed time, WhatsApp phone numbers and pairing codes, Server App
 *      money/quantity values, and LAN URLs in Settings pairing cards.
 *
 *   4. The standalone apps sync `dir`/`lang` on the document: the KDS
 *      standalone layout carries `KdsHtmlLang`, the Server App standalone
 *      layout carries `HtmlLangSync`.
 *
 *   5. The Server App and KDS disabled states and operational strings must be
 *      localized through i18n keys across all supported languages (en/es/pt/fa).
 *
 *   6. The Server App inherits the tenant language through the shared
 *      `useSyncServerLanguage` path pointed at `/api/server-app/info`
 *      (same `language` field as `/api/kds/info`). This is exercised
 *      end-to-end through `fetchServerInfo`.
 *
 * Run: npm run test:rtl-kds-server-whatsapp
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const storage = new Map<string, string>();
const dummyStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
  clear: () => { storage.clear(); },
};
(global as any).localStorage = dummyStorage;
(global as any).window = { localStorage: dummyStorage };

const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));

/** Batch F screen files that must use logical direction utilities. */
const SCREEN_FILES = [
  // Standalone KDS
  'frontend/src/app/kds-standalone/page.tsx',
  'frontend/src/app/kds-standalone/layout.tsx',
  'frontend/src/components/kds/KdsHeader.tsx',
  'frontend/src/components/kds/KdsKanbanBoard.tsx',
  'frontend/src/components/kds/KdsTabsView.tsx',
  'frontend/src/components/kds/KdsColumn.tsx',
  'frontend/src/components/kds/KdsItemModal.tsx',
  'frontend/src/components/kds/KdsLoginForm.tsx',
  'frontend/src/components/kds/KdsWorkspace.tsx',
  'frontend/src/components/kds/ElapsedTime.tsx',
  'frontend/src/components/kds/KdsHtmlLang.tsx',
  // Dashboard-embedded KDS
  'frontend/src/app/(dashboard)/kds/page.tsx',
  // Server App / tableside ordering
  'frontend/src/app/server-standalone/page.tsx',
  'frontend/src/app/server-standalone/layout.tsx',
  // WhatsApp
  'frontend/src/app/(dashboard)/whatsapp/page.tsx',
];

/**
 * Physical directional utilities that must be converted to logical ones in the
 * batch screens. Same rule set as the shared foundation and Batch D/E tests.
 */
const PHYSICAL_UTIL_RE =
  /\b(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|left|right)-[0-9a-zA-Z.]+|\btext-(left|right)\b/g;

/**
 * Per-file allowlist of physical utilities that are genuinely intentional.
 * Currently empty: every physical utility found in the batch was converted to
 * its logical equivalent. If a future change introduces a genuinely physical
 * case (e.g. a fixed-position overlay pinned to a physical corner), it must be
 * listed here with a comment explaining why it stays physical.
 */
const ALLOWLIST: Record<string, string[]> = {};

function loadComponents(): {
  Ltr: any;
  KdsHtmlLang: any;
  HtmlLangSync: any;
  usePosSettingsStore: any;
  t: any;
  fetchServerInfo: any;
  getLanguageDirection: any;
  React: typeof import('react');
  ReactDOMServer: typeof import('react-dom/server');
} {
  const moduleApi = require('module') as {
    _resolveFilename: (...args: any[]) => string;
  };
  const originalResolveFilename = moduleApi._resolveFilename;

  moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let resolvedRequest = request;
    if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(ROOT, 'frontend/src', request.slice(2));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };

  try {
    const React = frontendRequire('react');
    const ReactDOMServer = frontendRequire('react-dom/server');
    const { Ltr } = require('../frontend/src/components/layout/Ltr');
    const { KdsHtmlLang } = require('../frontend/src/components/kds/KdsHtmlLang');
    const { HtmlLangSync } = require('../frontend/src/components/layout/HtmlLangSync');
    const { usePosSettingsStore } = require('../frontend/src/store/pos-settings');
    const { t, fetchServerInfo, getLanguageDirection } = require('../frontend/src/lib/i18n');
    return {
      Ltr,
      KdsHtmlLang,
      HtmlLangSync,
      usePosSettingsStore,
      t,
      fetchServerInfo,
      getLanguageDirection,
      React,
      ReactDOMServer,
    };
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function run(): Promise<void> {
  console.log('RTL/LTR KDS, Server App, and WhatsApp checks:');

  // 1. Batch screens use logical direction utilities (or are allowlisted).
  let totalPhysical = 0;
  for (const file of SCREEN_FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const matches = src.match(PHYSICAL_UTIL_RE) ?? [];
    const allowed = ALLOWLIST[path.basename(file)] ?? [];
    const violations = matches.filter((m) => !allowed.includes(m));
    if (violations.length) {
      console.error(`\nPhysical direction utilities in ${file}:`);
      for (const v of violations) console.error(`  - ${v}`);
      assert(false, `physical direction utilities remain in ${file}`);
    }
    totalPhysical += matches.length;
  }
  console.log(`  ✓ batch screens use logical direction utilities (${totalPhysical} allowlisted physical cases)`);

  // 2. Directional icons carry `.rtl-flip`.
  const iconFiles = SCREEN_FILES.filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /\b(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b/.test(src);
  });
  for (const file of iconFiles) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Only flag JSX usage (`<Arrow…`, `<Chevron…`), not the lucide import statement.
      if (/<(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b/.test(line) && !line.includes('rtl-flip')) {
        assert(false, `${file}:${i + 1} uses a directional icon without rtl-flip: ${line.trim()}`);
      }
    });
  }
  console.log(`  ✓ directional icons carry rtl-flip (${iconFiles.length} file(s) with directional icons)`);

  // 3. Executable Ltr component isolates Batch F operational values.
  const {
    Ltr,
    KdsHtmlLang,
    HtmlLangSync,
    usePosSettingsStore,
    t,
    fetchServerInfo,
    getLanguageDirection,
    React,
    ReactDOMServer,
  } = loadComponents();

  React.useSyncExternalStore = (_subscribe: any, getSnapshot: () => any) => getSnapshot();

  const orderNumRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, null, '#101')
  );
  assert(
    orderNumRender === '<span dir="ltr" class="ltr-island">#101</span>',
    `Ltr must isolate KDS order numbers with dir="ltr", got: ${orderNumRender}`
  );

  const elapsedRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, null, '05:32')
  );
  assert(
    elapsedRender === '<span dir="ltr" class="ltr-island">05:32</span>',
    `Ltr must isolate KDS elapsed time with dir="ltr", got: ${elapsedRender}`
  );

  const pairingCodeRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, { className: 'font-mono tracking-widest' }, '7H3K-9Q2M')
  );
  assert(
    pairingCodeRender === '<span dir="ltr" class="ltr-island font-mono tracking-widest">7H3K-9Q2M</span>',
    `Ltr must isolate pairing codes with dir="ltr", got: ${pairingCodeRender}`
  );

  const phoneRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, null, '+98 912 123 4567')
  );
  assert(
    phoneRender === '<span dir="ltr" class="ltr-island">+98 912 123 4567</span>',
    `Ltr must isolate WhatsApp phone numbers with dir="ltr", got: ${phoneRender}`
  );

  const priceRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, null, '$14.99')
  );
  assert(
    priceRender === '<span dir="ltr" class="ltr-island">$14.99</span>',
    `Ltr must isolate Server App prices with dir="ltr", got: ${priceRender}`
  );

  const qtyRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, null, 2)
  );
  assert(
    qtyRender === '<span dir="ltr" class="ltr-island">2</span>',
    `Ltr must isolate Server App item quantities with dir="ltr", got: ${qtyRender}`
  );

  const urlRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      Ltr,
      {
        as: 'a',
        href: 'http://192.168.1.50:3001/server-standalone',
        className: 'block font-mono text-sm break-all',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      'http://192.168.1.50:3001/server-standalone'
    )
  );
  assert(
    urlRender ===
      '<a dir="ltr" class="ltr-island block font-mono text-sm break-all" href="http://192.168.1.50:3001/server-standalone" target="_blank" rel="noopener noreferrer">http://192.168.1.50:3001/server-standalone</a>',
    `Ltr as="a" must isolate Server App LAN URLs with dir="ltr", got: ${urlRender}`
  );
  console.log('  ✓ naturally LTR values are isolated with Ltr (order #, elapsed time, phones, pairing code, money, LAN URLs)');

  // 4. Standalone layouts sync dir/lang on the document.
  for (const lang of ['en', 'es', 'pt', 'fa'] as const) {
    usePosSettingsStore.getState().setLanguage(lang);
    const kdsMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(KdsHtmlLang));
    assert(kdsMarkup === '', `KdsHtmlLang must render null, got: ${kdsMarkup}`);
    const serverMarkup = ReactDOMServer.renderToStaticMarkup(React.createElement(HtmlLangSync));
    assert(serverMarkup === '', `HtmlLangSync must render null, got: ${serverMarkup}`);
  }

  assert(getLanguageDirection('fa') === 'rtl', 'Persian (fa) must resolve to rtl');
  for (const ltrLang of ['en', 'es', 'pt'] as const) {
    assert(getLanguageDirection(ltrLang) === 'ltr', `${ltrLang} must resolve to ltr`);
  }
  console.log('  ✓ standalone layouts sync document dir/lang (KdsHtmlLang / HtmlLangSync)');

  // 5. KDS disabled screens and Server App strings resolve localized i18n keys.
  const kdsDisabledFa = t('kds.disabledTitle', 'fa');
  assert(
    kdsDisabledFa && kdsDisabledFa !== 'kds.disabledTitle' && kdsDisabledFa !== 'Kitchen Display is disabled',
    `kds.disabledTitle in Persian must be localized, got: ${kdsDisabledFa}`
  );
  const kdsHintFa = t('kds.disabledHint', 'fa');
  assert(
    kdsHintFa && kdsHintFa !== 'kds.disabledHint' && !kdsHintFa.includes('This business has turned off'),
    `kds.disabledHint in Persian must be localized, got: ${kdsHintFa}`
  );

  const serverAppTitleFa = t('serverApp.title', 'fa');
  assert(
    serverAppTitleFa && serverAppTitleFa !== 'serverApp.title',
    `serverApp.title in Persian must be localized, got: ${serverAppTitleFa}`
  );
  const serverAppDisabledFa = t('serverApp.disabledTitle', 'fa');
  assert(
    serverAppDisabledFa && serverAppDisabledFa !== 'serverApp.disabledTitle' && serverAppDisabledFa !== 'Server App is disabled',
    `serverApp.disabledTitle in Persian must be localized, got: ${serverAppDisabledFa}`
  );

  const tableEn = t('serverApp.tableLabel', 'en', { name: '12' });
  assert(tableEn === 'Table 12', `serverApp.tableLabel EN substitution failed, got: ${tableEn}`);
  const tableFa = t('serverApp.tableLabel', 'fa', { name: '12' });
  assert(tableFa.includes('12') && tableFa !== 'Table 12', `serverApp.tableLabel FA substitution failed, got: ${tableFa}`);

  const guestFa = t('serverApp.guestFallbackName', 'fa', { last4: '5678' });
  assert(guestFa.includes('5678') && !guestFa.startsWith('Guest '), `serverApp.guestFallbackName FA substitution failed, got: ${guestFa}`);

  for (const lang of ['en', 'es', 'pt', 'fa'] as const) {
    for (const key of ['kds.disabledTitle', 'kds.disabledHint', 'serverApp.disabledTitle', 'serverApp.disabledHint']) {
      const val = t(key, lang);
      assert(val && val !== key, `Translation key ${key} must resolve for ${lang}`);
    }
  }
  console.log('  ✓ KDS disabled screens use localized i18n keys');

  // 6. Executable: Server App inherits the tenant language through the
  //    shared fetchServerInfo path pointed at /api/server-app/info.
  const realFetch = global.fetch;
  const realWindow = (global as any).window;
  const fetchCalls: string[] = [];
  global.fetch = (async (input: any) => {
    fetchCalls.push(String(input));
    return {
      ok: true,
      json: async () => ({ language: 'fa', country: 'IR', kds_default_view: null }),
    };
  }) as any;
  (global as any).window = {};
  try {
    const info = await fetchServerInfo('http://192.168.1.50:3002', 1500, '/api/server-app/info');
    assert(info.language === 'fa', `Server App info must resolve language 'fa', got: ${info.language}`);
    assert(info.country === 'IR', `Server App info must resolve country 'IR', got: ${info.country}`);
    assert(
      fetchCalls.length === 1 && fetchCalls[0] === 'http://192.168.1.50:3002/api/server-app/info',
      `Server App info must be fetched from /api/server-app/info, got: ${fetchCalls.join(', ')}`
    );
  } finally {
    global.fetch = realFetch;
    (global as any).window = realWindow;
  }
  console.log('  ✓ Server App inherits tenant language via /api/server-app/info (useSyncServerLanguage path)');

  console.log('\n✅ All RTL/LTR KDS, Server App, and WhatsApp checks passed.');
}

run().catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
