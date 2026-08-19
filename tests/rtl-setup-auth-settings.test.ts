/**
 * RTL/LTR Setup, Auth, and Settings regression test (Batch D, Refs #241).
 *
 * Builds on the shared direction foundation guarded by `rtl-foundation.test.ts`
 * (Batch C) and extends the same guarantees to the Setup wizard, the auth
 * screens (login / recover), and the Settings screens + dialogs:
 *
 *   1. These screens must not use physical left/right utilities for
 *      content-flow layout (margin, padding, alignment, borders). The shared
 *      logical equivalents (`ms/me/ps/pe/start/end/text-start/text-end/
 *      border-s/border-e`) render identically in LTR and mirror under
 *      `dir="rtl"`, so any remaining physical utility is a regression.
 *
 *      A small per-file allowlist covers genuinely physical cases: the
 *      fixed "unsaved changes" save bar in Settings is horizontally
 *      centered with `left-1/2 -translate-x-1/2`, which is physical
 *      centering that stays centered in both directions.
 *
 *   2. Directional navigation arrows (`ArrowLeft` / `ArrowRight`) must carry
 *      the shared `.rtl-flip` class so they mirror under `[dir="rtl"]`
 *      (back/forward arrows point the correct way in Persian).
 *
 *   3. The shared `Ltr` component must keep rendering `dir="ltr"` with the
 *      `.ltr-island` class through its polymorphic `as` prop (`a`, `code`),
 *      which the Settings screens rely on for URL anchors and code values.
 *
 * Run: npm run test:rtl-setup-auth-settings
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));

/** Batch D screen files that must use logical direction utilities. */
const SCREEN_FILES = [
  'frontend/src/app/setup/page.tsx',
  'frontend/src/app/auth/login/page.tsx',
  'frontend/src/app/auth/recover/page.tsx',
  'frontend/src/app/(dashboard)/settings/page.tsx',
  'frontend/src/components/settings/TaxConfigurationPanel.tsx',
  'frontend/src/components/settings/PaymentMethodsSettings.tsx',
  'frontend/src/components/settings/InitializeDatabaseDialog.tsx',
  'frontend/src/components/settings/HealthCheckDialog.tsx',
  'frontend/src/components/settings/MasterPinPrompt.tsx',
  'frontend/src/components/settings/WhatsAppEnableCard.tsx',
];

/**
 * Physical directional utilities that must be converted to logical ones in the
 * batch screens. Same rule set as the shared foundation test.
 */
const PHYSICAL_UTIL_RE =
  /\b(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|left|right)-[0-9a-zA-Z.]+|\btext-(left|right)\b/g;

/**
 * Per-file allowlist of physical utilities that are genuinely intentional.
 * Each entry documents why it stays physical.
 */
const ALLOWLIST: Record<string, string[]> = {
  'page.tsx': [
    // Fixed "unsaved changes" save bar — physical horizontal centering
    // (left-1/2 -translate-x-1/2) stays centered in both directions. The
    // scanner captures the class prefix `left-1` from `left-1/2`.
    'left-1',
  ],
};

function loadLtrComponent(): {
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
  console.log('RTL/LTR Setup, Auth, and Settings checks:');

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

  // 2. Directional navigation arrows carry `.rtl-flip`.
  const arrowFiles = SCREEN_FILES.filter((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /\bArrow(Left|Right)\b/.test(src);
  });
  for (const file of arrowFiles) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Only flag JSX usage (`<Arrow…`), not the lucide import statement.
      if (/<Arrow(Left|Right)\b/.test(line) && !line.includes('rtl-flip')) {
        assert(false, `${file}:${i + 1} uses a directional arrow without rtl-flip: ${line.trim()}`);
      }
    });
  }
  console.log(`  ✓ directional arrows carry rtl-flip (${arrowFiles.length} file(s) with arrows)`);

  // 3. The shared Ltr component renders dir="ltr" LTR islands through its
  //    polymorphic `as` prop (a, code) used by Settings.
  const { Ltr, React, ReactDOMServer } = loadLtrComponent();
  assert(typeof Ltr === 'function', 'Ltr component must be exported as a function');

  const anchorRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      Ltr,
      { as: 'a', href: 'http://192.168.1.5:3001', target: '_blank', rel: 'noopener noreferrer', className: 'block font-mono text-sm break-all' },
      'http://192.168.1.5:3001'
    )
  );
  assert(
    anchorRender ===
      '<a dir="ltr" class="ltr-island block font-mono text-sm break-all" href="http://192.168.1.5:3001" target="_blank" rel="noopener noreferrer">http://192.168.1.5:3001</a>',
    `Ltr as="a" must render an anchor with dir="ltr" and ltr-island, got: ${anchorRender}`
  );

  const codeRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, { as: 'code', className: 'text-xs' }, 'cat_standard')
  );
  assert(
    codeRender === '<code dir="ltr" class="ltr-island text-xs">cat_standard</code>',
    `Ltr as="code" must render a code element with dir="ltr" and ltr-island, got: ${codeRender}`
  );

  console.log('  ✓ Ltr polymorphic rendering (as="a", as="code") verified through React interface');

  // 4. getBrowserLanguage returns 'fa' for fa locales, 'es' for es, 'pt' for pt, 'en' otherwise.
  const i18nModule = (() => {
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
      return require('../frontend/src/lib/i18n');
    } finally {
      moduleApi._resolveFilename = originalResolveFilename;
    }
  })();

  function withNavigatorLanguage(lang: string | undefined, fn: () => void, languages?: string[]): void {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalNav = (globalThis as any).navigator;
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: lang !== undefined ? { language: lang, languages: languages ?? [lang] } : undefined,
        configurable: true,
        writable: true,
      });
      fn();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'navigator', originalDescriptor);
      } else {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNav,
          configurable: true,
          writable: true,
        });
      }
    }
  }

  withNavigatorLanguage('fa-IR', () => {
    assert(i18nModule.getBrowserLanguage() === 'fa', 'getBrowserLanguage must return "fa" for fa-IR');
  });
  withNavigatorLanguage('fa', () => {
    assert(i18nModule.getBrowserLanguage() === 'fa', 'getBrowserLanguage must return "fa" for fa');
  });
  withNavigatorLanguage('fa-AF', () => {
    assert(i18nModule.getBrowserLanguage() === 'fa', 'getBrowserLanguage must return "fa" for fa-AF');
  });
  withNavigatorLanguage('es-ES', () => {
    assert(i18nModule.getBrowserLanguage() === 'es', 'getBrowserLanguage must return "es" for es-ES');
  });
  withNavigatorLanguage('pt-BR', () => {
    assert(i18nModule.getBrowserLanguage() === 'pt', 'getBrowserLanguage must return "pt" for pt-BR');
  });
  withNavigatorLanguage('en-US', () => {
    assert(i18nModule.getBrowserLanguage() === 'en', 'getBrowserLanguage must return "en" for en-US');
  });
  withNavigatorLanguage('fr-FR', () => {
    assert(i18nModule.getBrowserLanguage() === 'en', 'getBrowserLanguage must fallback to "en" for unsupported locales');
  });
  withNavigatorLanguage('en-US', () => {
    assert(i18nModule.getBrowserLanguage() === 'es', 'getBrowserLanguage must honor the first supported navigator.languages preference');
  }, ['es-ES', 'en-US']);
  withNavigatorLanguage('zz-ZZ', () => {
    assert(i18nModule.getBrowserLanguage() === 'pt', 'getBrowserLanguage must skip unsupported navigator.languages preferences');
  }, ['zz-ZZ', 'pt-BR']);
  withNavigatorLanguage(undefined, () => {
    assert(i18nModule.getBrowserLanguage() === 'en', 'getBrowserLanguage must fallback to "en" when navigator is undefined');
  });
  console.log('  ✓ getBrowserLanguage resolves fa for fa* locales and defaults correctly');

  // 5. Translation keys setup.languagePersian and settings.languageFa resolve in all four languages.
  const languages = ['en', 'es', 'pt', 'fa'] as const;
  const { createTranslator } = frontendRequire('use-intl/core');
  // #375: prime the shared locale cache so messages resolve for all locales.
  for (const lang of languages) {
    await i18nModule.loadLocaleMessages(lang);
  }
  for (const lang of languages) {
    const t = createTranslator({
      locale: i18nModule.getLanguageLocale(lang),
      messages: i18nModule.getCachedMessages(lang),
    });
    const setupLabel = t('setup.languagePersian');
    assert(setupLabel && setupLabel !== 'setup.languagePersian', `setup.languagePersian must be translated in ${lang}, got: ${setupLabel}`);
    const settingsLabel = t('settings.languageFa');
    assert(settingsLabel && settingsLabel !== 'settings.languageFa', `settings.languageFa must be translated in ${lang}, got: ${settingsLabel}`);
  }
  const tFa = createTranslator({ locale: 'fa-IR', messages: i18nModule.getCachedMessages('fa') });
  const tEn = createTranslator({ locale: 'en', messages: i18nModule.getCachedMessages('en') });
  assert(tFa('setup.languagePersian') === 'فارسی', 'setup.languagePersian in fa must be فارسی');
  assert(tFa('settings.languageFa') === 'فارسی (FA)', 'settings.languageFa in fa must be فارسی (FA)');
  assert(tEn('setup.languagePersian') === 'Persian', 'setup.languagePersian in en must be Persian');
  assert(tEn('settings.languageFa') === 'Persian (FA)', 'settings.languageFa in en must be Persian (FA)');
  console.log('  ✓ setup.languagePersian and settings.languageFa translate across en, es, pt, fa');

  console.log('\n✅ All RTL/LTR Setup, Auth, and Settings checks passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
