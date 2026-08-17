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
 *   4. The standalone apps must sync `dir`/`lang` on the document: the KDS
 *      standalone layout carries `KdsHtmlLang`, the Server App standalone
 *      layout carries `HtmlLangSync`.
 *
 *   5. The Server App inherits the tenant language through the shared
 *      `useSyncServerLanguage` path pointed at `/api/server-app/info`
 *      (same `language` field as `/api/kds/info`). This is exercised
 *      end-to-end through `fetchServerInfo`.
 *
 *   6. The Server App and KDS disabled states must be localized through
 *      i18n keys (no hard-coded English), with full key parity across
 *      en/es/pt/fa covered by tests/translations.test.ts.
 *
 * Run: npm run test:rtl-kds-server-whatsapp
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
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
    return { Ltr, React, ReactDOMServer };
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

  // 3. Naturally LTR values are isolated with the shared Ltr component.
  function assertInFile(file: string, re: RegExp, msg: string): void {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert(re.test(src), `${msg} (missing in ${file})`);
  }

  // KDS order numbers and elapsed time.
  assertInFile(
    'frontend/src/components/kds/KdsKanbanBoard.tsx',
    /<Ltr[^>]*>#\{order\.order_number\}<\/Ltr>/,
    'KDS kanban order numbers must be Ltr-isolated'
  );
  assertInFile(
    'frontend/src/components/kds/KdsTabsView.tsx',
    /<Ltr[^>]*>#\{order\.order_number\}<\/Ltr>/,
    'KDS tabs order numbers must be Ltr-isolated'
  );
  for (const f of ['KdsKanbanBoard.tsx', 'KdsTabsView.tsx']) {
    assertInFile(
      `frontend/src/components/kds/${f}`,
      /<Ltr>\s*<ElapsedTime[^>]*\/>\s*<\/Ltr>/,
      `KDS ${f} elapsed time must be Ltr-isolated`
    );
  }

  // WhatsApp phone numbers and pairing code.
  const whatsappSrc = fs.readFileSync(path.join(ROOT, 'frontend/src/app/(dashboard)/whatsapp/page.tsx'), 'utf8');
  assert(
    /<Ltr[^>]*>\{pairingCode\}<\/Ltr>/.test(whatsappSrc),
    'WhatsApp pairing code must be Ltr-isolated'
  );
  assert(
    /<Ltr[^>]*>\{status\.connectedPhone\}<\/Ltr>/.test(whatsappSrc),
    'WhatsApp connected phone must be Ltr-isolated'
  );
  assert(
    /<Ltr[^>]*>\{b\.phone_e164\}<\/Ltr>/.test(whatsappSrc),
    'WhatsApp blocked phone numbers must be Ltr-isolated'
  );
  assert(
    /<Ltr[^>]*>\{m\.phone_e164\}<\/Ltr>/.test(whatsappSrc),
    'WhatsApp message phone numbers must be Ltr-isolated'
  );

  // Server App money/quantity values.
  const serverAppSrc = fs.readFileSync(path.join(ROOT, 'frontend/src/app/server-standalone/page.tsx'), 'utf8');
  assert(/<Ltr>\{money\([^)]*\)\}<\/Ltr>/.test(serverAppSrc), 'Server App prices must be Ltr-isolated');
  assert(/<Ltr>\{item\.quantity\}<\/Ltr>/.test(serverAppSrc), 'Server App item quantities must be Ltr-isolated');

  // Settings Server App pairing URL is Ltr-isolated (like POS/KDS pairing).
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'frontend/src/app/(dashboard)/settings/page.tsx'), 'utf8');
  assert(
    /<Ltr as="a" href=\{ipInfo\.url\}/.test(settingsSrc),
    'Settings Server App pairing URL must be Ltr-isolated'
  );

  console.log('  ✓ naturally LTR values are isolated with Ltr (order #, elapsed time, phones, pairing code, money, LAN URLs)');

  // 4. Standalone layouts sync dir/lang on the document.
  const kdsLayout = fs.readFileSync(path.join(ROOT, 'frontend/src/app/kds-standalone/layout.tsx'), 'utf8');
  assert(/KdsHtmlLang/.test(kdsLayout), 'KDS standalone layout must carry KdsHtmlLang');
  const serverLayout = fs.readFileSync(path.join(ROOT, 'frontend/src/app/server-standalone/layout.tsx'), 'utf8');
  assert(/HtmlLangSync/.test(serverLayout), 'Server App standalone layout must carry HtmlLangSync');
  console.log('  ✓ standalone layouts sync document dir/lang (KdsHtmlLang / HtmlLangSync)');

  // 5. KDS disabled screens are localized (no hard-coded English).
  for (const f of ['frontend/src/app/kds-standalone/page.tsx', 'frontend/src/app/(dashboard)/kds/page.tsx']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert(/t\('kds\.disabledTitle'\)/.test(src), `KDS disabled title must use kds.disabledTitle in ${f}`);
    assert(!/Kitchen Display is disabled/.test(src), `KDS disabled screen must not hard-code English in ${f}`);
  }
  console.log('  ✓ KDS disabled screens use localized i18n keys');

  // 6. Executable: Server App inherits the tenant language through the
  //    shared fetchServerInfo path pointed at /api/server-app/info.
  //    (Loaded through the same `@/` alias hook as loadComponents so the
  //    frontend imports inside i18n.ts resolve.)
  const moduleApi = require('module') as { _resolveFilename: (...args: any[]) => string };
  const originalResolveFilename = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let resolvedRequest = request;
    if (request.startsWith('@/')) {
      resolvedRequest = path.resolve(ROOT, 'frontend/src', request.slice(2));
    }
    return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
  };
  let fetchServerInfo: any;
  try {
    ({ fetchServerInfo } = require('../frontend/src/lib/i18n'));
  } finally {
    moduleApi._resolveFilename = originalResolveFilename;
  }
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

  // 7. Executable: Ltr isolates the WhatsApp pairing code style of value.
  const { Ltr, React, ReactDOMServer } = loadComponents();
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
  console.log('  ✓ Ltr component isolates WhatsApp operational values (pairing code, phone)');

  console.log('\n✅ All RTL/LTR KDS, Server App, and WhatsApp checks passed.');
}

run().catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
