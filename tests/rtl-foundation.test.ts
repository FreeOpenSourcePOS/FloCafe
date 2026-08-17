/**
 * RTL/LTR UI foundation regression test (Batch C, Refs #241).
 *
 * Guards the shared direction foundation:
 *
 *   1. Shared `ui/` and `layout/` components must not use physical
 *      left/right utilities for content-flow layout (margin, padding,
 *      alignment, borders, rounding, insets). In Tailwind v4 the logical
 *      equivalents (`ms/me/ps/pe/start/end/text-start/text-end/border-s/e/
 *      rounded-s/e`) render identically in LTR, so converting is free and
 *      makes the same components mirror correctly under `dir="rtl"`.
 *
 *      A small per-file allowlist covers genuinely physical cases: the
 *      sheet/drawer `side` positioning, and the sidebar's `side`/rail/inset
 *      geometry (all driven by an explicit physical `side` prop). Everything
 *      else is a regression and fails the test.
 *
 *   2. The RTL foundation CSS rules exist in globals.css: `.ltr-island`
 *      (LTR direction + bidi isolation for explicit LTR content) and
 *      `.rtl-flip` (mirrors directional icons under `[dir="rtl"]`).
 *
 *   3. The shared `Ltr` component renders `dir="ltr"` with the `.ltr-island`
 *      class so explicit LTR islands (emails, URLs, codes, numbers) stay
 *      readable inside RTL pages.
 *
 * Run: npm run test:rtl-foundation
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'frontend/src/components/ui');
const LAYOUT_DIR = path.join(ROOT, 'frontend/src/components/layout');
const GLOBALS_CSS = path.join(ROOT, 'frontend/src/app/globals.css');
const Module = require('module');
const frontendRequire = Module.createRequire(path.join(ROOT, 'frontend/package.json'));

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

/**
 * Physical directional utilities that must be converted to logical ones in
 * shared components. Animation utilities (`slide-in-from-right-*` /
 * `slide-in-from-left-*`) and `data-[side=…]` attribute selectors are
 * stripped before scanning because they are keyed to physical popover sides.
 */
const PHYSICAL_UTIL_RE =
  /\b(ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|left|right)-[0-9a-zA-Z.]+|\btext-(left|right)\b/g;

/**
 * Per-file allowlist of physical utilities that are genuinely intentional.
 * Each entry documents why it stays physical.
 */
const ALLOWLIST: Record<string, string[]> = {
  'drawer.tsx': [
    'right-0', // vaul drawer side="right" (explicit physical placement)
    'left-0', // vaul drawer side="left" (explicit physical placement)
  ],
  'sheet.tsx': [
    'right-0', // sheet side="right" (explicit physical placement)
    'left-0', // sheet side="left" (explicit physical placement)
  ],
  'sidebar.tsx': [
    'left-0', // sidebar side="left" positioning (explicit physical side)
    'right-0', // sidebar side="right" positioning (explicit physical side)
    'right-4', // sidebar rail offset (-right-4)
    'left-1', // sidebar rail center guide (after:left-1/2)
    'left-full', // sidebar rail offcanvas guide (after:left-full)
    'right-2', // sidebar rail offcanvas offset (-right-2)
    'left-2', // sidebar rail offcanvas offset (-left-2)
    'ml-0', // sidebar inset margin next to the physical sidebar
    'ml-2', // sidebar inset collapsed margin next to the physical sidebar
  ],
};

/** Files that are scanned but are not shared layout primitives. */
const SKIP_FILES = new Set(['Ltr.tsx']); // the LTR-island component itself

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function scanFile(filePath: string): string[] {
  let src = fs.readFileSync(filePath, 'utf8');
  // Strip Radix/vaul side-entry animations — they are physical by design.
  src = src.replace(/data-\[side=[^\]]+\]:slide-in-from-(right|left)-[0-9a-zA-Z.]+/g, '');
  const matches = src.match(PHYSICAL_UTIL_RE) ?? [];
  return [...new Set(matches)];
}

function scanDir(dir: string): Array<{ file: string; matches: string[] }> {
  const out: Array<{ file: string; matches: string[] }> = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.tsx')).sort()) {
    if (SKIP_FILES.has(f)) continue;
    out.push({ file: f, matches: scanFile(path.join(dir, f)) });
  }
  return out;
}

function run(): void {
  console.log('RTL/LTR UI foundation checks:');

  // 1. Shared components use logical utilities (or are allowlisted).
  let totalPhysical = 0;
  for (const dir of [UI_DIR, LAYOUT_DIR]) {
    for (const { file, matches } of scanDir(dir)) {
      const allowed = ALLOWLIST[file] ?? [];
      const violations = matches.filter((m) => !allowed.includes(m));
      if (violations.length) {
        console.error(`\nPhysical direction utilities in ${path.basename(dir)}/${file}:`);
        for (const v of violations) console.error(`  - ${v}`);
        assert(false, `physical direction utilities remain in ${file}`);
      }
      totalPhysical += matches.length;
    }
  }
  console.log(`  ✓ shared components use logical direction utilities (${totalPhysical} allowlisted physical cases)`);

  // 2. globals.css contains the RTL foundation rules.
  const css = fs.readFileSync(GLOBALS_CSS, 'utf8');
  assert(css.includes('.ltr-island'), 'globals.css missing .ltr-island rule');
  assert(/\{\s*direction:\s*ltr;\s*unicode-bidi:\s*isolate;\s*\}/.test(css), '.ltr-island must set direction:ltr and unicode-bidi:isolate');
  assert(/\[dir="rtl"\]\s*\.rtl-flip/.test(css), 'globals.css missing [dir="rtl"] .rtl-flip rule');
  assert(/scaleX\(-1\)/.test(css), '.rtl-flip must mirror with scaleX(-1)');
  console.log('  ✓ globals.css defines .ltr-island and .rtl-flip');

  // 3. The shared Ltr component renders dir="ltr" with the ltr-island class via React.
  const { Ltr, React, ReactDOMServer } = loadLtrComponent();
  assert(typeof Ltr === 'function', 'Ltr component must be exported as a function');

  const defaultRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, null, 'user@example.com')
  );
  assert(
    defaultRender === '<span dir="ltr" class="ltr-island">user@example.com</span>',
    `Ltr must render default span with dir="ltr" and ltr-island class, got: ${defaultRender}`
  );

  const customClassRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, { className: 'font-mono text-sm' }, '192.168.1.1')
  );
  assert(
    customClassRender === '<span dir="ltr" class="ltr-island font-mono text-sm">192.168.1.1</span>',
    `Ltr must merge custom className with ltr-island class, got: ${customClassRender}`
  );

  const customTagRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, { as: 'div', className: 'text-xs' }, 'PAIR-1234')
  );
  assert(
    customTagRender === '<div dir="ltr" class="ltr-island text-xs">PAIR-1234</div>',
    `Ltr must support rendering as a custom element tag (as="div"), got: ${customTagRender}`
  );

  const propsRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, { id: 'email-link', 'data-testid': 'user-email', title: 'User Email' }, 'test@domain.com')
  );
  assert(
    propsRender.includes('dir="ltr"') &&
      propsRender.includes('class="ltr-island"') &&
      propsRender.includes('id="email-link"') &&
      propsRender.includes('data-testid="user-email"') &&
      propsRender.includes('title="User Email"') &&
      propsRender.includes('test@domain.com'),
    `Ltr must forward HTML attributes and props to the rendered element, got: ${propsRender}`
  );

  const nestedRender = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Ltr, null, React.createElement('strong', null, 'nested'))
  );
  assert(
    nestedRender === '<span dir="ltr" class="ltr-island"><strong>nested</strong></span>',
    `Ltr must render nested children correctly, got: ${nestedRender}`
  );

  console.log('  ✓ Ltr component renders dir="ltr" LTR islands through React interface');

  console.log('\n✅ All RTL/LTR foundation checks passed.');
}

run();
