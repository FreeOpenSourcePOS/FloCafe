/**
 * Source-level guards for the POS surfaces reported as unusable at narrow
 * widths and at high control counts:
 *
 *   - the POS top bar crushed the customer name/phone fields and then
 *     overlapped them once the action buttons ran out of room;
 *   - the Add/Edit Product dialog was too narrow for the variant editor, which
 *     spilled outside the popup;
 *   - the Print Menu dialog jammed each checkbox against its label, and offered
 *     only A4/Letter output on whichever printer happened to be selected
 *     system-wide.
 *
 * These are layout contracts, so they are asserted against the rendered
 * markup's own class contract rather than through a DOM, in the same shape as
 * the other UI-regression guards in this directory.
 *
 * Run: ts-node --transpile-only -P tests/tsconfig.json tests/pos-ux-layout-guards.test.ts
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

// ── POS top bar: actions move to their own row instead of overlapping ────────
{
  const topbar = source('frontend/src/components/pos/PosTopbar.tsx');

  assert.match(
    topbar,
    /className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-card[^"]*"/,
    'the top bar wraps, so its rows stack instead of overlapping',
  );
  assert.match(
    topbar,
    /className="flex-1 min-w-0">\s*<CustomerSearch/,
    'the customer fields keep their own shrinkable row above the actions',
  );
  assert.match(
    topbar,
    /className="flex w-full flex-wrap items-center justify-end gap-2 xl:w-auto"/,
    'the action buttons form one right-aligned group that takes a full row until there is room',
  );
  assert.match(
    topbar,
    /<PrinterStatus \/>/,
    'the printer control stays in the action group',
  );
}

// ── Add/Edit Product dialog: wide enough for the variant editor ─────────────
{
  const products = source('frontend/src/app/(dashboard)/products/page.tsx');

  assert.match(
    products,
    /bg-card rounded-2xl w-full max-w-5xl max-h-\[92vh\] flex flex-col overflow-hidden/,
    'the product dialog uses the wide layout and a bounded, scrollable height',
  );
  assert.match(
    products,
    /<form id="product-form"[\s\S]{0,80}className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2/,
    'the product form lays out in two columns once there is room',
  );
  assert.match(
    products,
    /className="space-y-3 rounded-xl border border-border bg-muted\/40 p-4 lg:col-span-2"/,
    'the variant editor is a full-width framed section, so its wider table stays inside the dialog',
  );
  assert.match(
    products,
    /className="w-full min-w-\[720px\] text-sm"/,
    'the variant table keeps enough width for a full variant row',
  );
  assert.match(
    products,
    /<span className="text-sm font-semibold text-foreground">\{t\('variantsSection'\)\}<\/span>/,
    'the variant section is labelled by its own short heading, not a repeat of the toggle sentence',
  );
  assert.match(
    products,
    /<Button type="submit" form="product-form">/,
    'Save lives in the dialog footer and submits the form it is no longer nested in',
  );
  assert.match(
    products,
    /flex shrink-0 justify-end gap-3 border-t border-border p-4/,
    'the footer stays pinned outside the scrolling form body',
  );
}

// ── Print Menu dialog: readable filters, receivable destinations ────────────
{
  const modal = source('frontend/src/components/products/PrintMenuModal.tsx');

  assert.match(
    modal,
    /touch-target flex min-h-12 w-full items-center justify-between gap-6 px-4 text-start/,
    'each include filter puts its label at the start and its check at the end',
  );
  assert.match(
    modal,
    /role="radiogroup" aria-label=\{t\('printDestination'\)\}/,
    'the print destination is an explicit, labelled choice rather than an implicit default',
  );
  for (const destination of ['receipt', 'paper', 'pdf'] as const) {
    assert.match(
      modal,
      new RegExp(`id: '${destination}'`),
      `the ${destination} destination is offered`,
    );
  }
  assert.match(
    modal,
    /aria-label=\{t\('printerDestination'\)\}/,
    'the receipt destination lets the operator pick which configured printer receives the menu',
  );
  assert.match(
    modal,
    /\.\.\.\(selectedPrinterId \? \{ printerId: selectedPrinterId \} : \{\}\)/,
    'a chosen printer rides on the request, and an unchosen one keeps the configured default in charge',
  );
  assert.match(
    modal,
    /window\.electronAPI\?\.saveHtmlAsPdf/,
    'PDF export goes through the desktop bridge when it exists',
  );
  assert.match(
    modal,
    /printMenuInBrowser\(html\)/,
    'PDF export still falls back to the browser print dialog outside Electron',
  );
  const paperSizeUsages = modal.match(/tSettings\('paperSize'\)/g) ?? [];
  assert.ok(
    paperSizeUsages.length >= 2,
    'both the A4/Letter choice and the receipt roll width reuse the translated paper-size label',
  );
  // A4/Letter used to be the only output control; it is now a detail of a
  // destination the operator picks first.
  assert.ok(
    modal.indexOf('role="radiogroup"') < modal.indexOf("tSettings('paperSize')"),
    'the destination choice is presented before any paper-size detail',
  );
}

console.log('pos-ux-layout-guards: top bar, product dialog, and print menu contracts hold');
