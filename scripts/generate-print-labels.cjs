#!/usr/bin/env node
/*
 * Generates main/print/print-labels.generated.ts — a derived view (#440) of
 * the canonical locale messages (frontend/src/lib/i18n/messages/*.json) for
 * backend thermal printing.
 *
 * The Electron main process cannot import the frontend i18n loaders, and the
 * locale JSONs must remain the single translation source. This script
 * extracts:
 *
 *   - the `print.*` namespace added by issue #440, plus
 *   - a manifest of BORROWED existing keys from other namespaces that the
 *     audited receipt/KOT concepts already resolve through,
 *
 * for every committed language, into one typed TypeScript module. The module
 * is committed; ordinary builds consume it as-is and never regenerate tracked
 * sources. Regenerate explicitly after editing messages:
 *
 *   npm run generate:print-labels
 *
 * Drift validation (regenerate in memory, byte-compare against the committed
 * file) runs via `--check` and is wired into `npm run i18n:check` and the
 * `test:print-labels` suite.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MESSAGES_DIR = path.join(ROOT, 'frontend/src/lib/i18n/messages');
const OUT_FILE = path.join(ROOT, 'main/print/print-labels.generated.ts');

/** Committed languages, in stable generation order (keep in sync with languages.ts). */
const LANGUAGES = ['en', 'fa', 'es', 'fr', 'pt', 'tr', 'fil'];


/**
 * New `print.*` keys owned by issue #440, in contract order. Dotted leaf
 * paths under the `print.` prefix.
 */
const PRINT_NAMESPACE_KEYS = [
  'print.taxInvoiceTitle',
  'print.invoiceTitle',
  'print.invoiceNumber',
  'print.time',
  'print.customerShort',
  'print.numberShort',
  'print.address',
  'print.call',
  'print.note',
  'print.phoneLong',
  'print.subtotalExclTax',
  'print.serviceChargeShort',
  'print.grandTotal',
  'print.thankYouShort',
  'print.thankYouVisitAgain',
  'print.pleaseComeAgain',
  'print.ratesInclusiveNote',
  'print.pointsEarned',
  'print.pointsBalance',
  'print.pointsRedeemed',
  'print.kot.title',
  'print.kot.banner',
  'print.kot.station',
  'print.kot.type',
  'print.kot.noPendingItems',
  'print.kot.end',
  'print.hsn',
  'print.test.title',
  'print.test.networkUsb',
  'print.test.columns',
  'print.test.wrapHint',
  'print.test.success',
];

/**
 * Existing keys outside `print.*` that the audit mapping table (#440)
 * reuses verbatim — listed here instead of being duplicated into the
 * messages. Concept IDs keep their full dotted key so call sites stay
 * unambiguous about where a label resolves.
 */
const BORROWED_KEYS = [
  'receipt.billNumber',
  'receipt.date',
  'pos.tableLabel',
  'pos.customer',
  'receipt.customerNo',
  'receipt.phone',
  'receipt.item',
  'receipt.qty',
  'receipt.rate',
  'receipt.amount',
  'printTest.amt',
  'pos.subtotal',
  'pos.discount',
  'pos.tax',
  'pos.delivery',
  'receipt.totalTax',
  'receipt.serviceCharge',
  'receipt.taxDetails',
  'receipt.payments',
  'receipt.thankYou',
  'receipt.taxIncluded',
  'receipt.reprint',
  'receipt.onlineOrder',
  // Payment-method names, ported from web-print.ts's method mapping (#440).
  'pos.methodCash',
  'pos.methodCard',
  'pos.methodWallet',
];

const ALL_CONCEPTS = [...PRINT_NAMESPACE_KEYS, ...BORROWED_KEYS];

function getLeaf(messages, dottedKey) {
  let node = messages;
  for (const part of dottedKey.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) return undefined;
    node = node[part];
  }
  if (typeof node !== 'string') return undefined;
  return node;
}

function buildTable() {
  const tables = {};
  for (const lang of LANGUAGES) {
    const file = path.join(MESSAGES_DIR, `${lang}.json`);
    const messages = JSON.parse(fs.readFileSync(file, 'utf8'));
    const table = {};
    for (const key of ALL_CONCEPTS) {
      const value = getLeaf(messages, key);
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${lang}.json: missing or empty message '${key}'`);
      }
      table[key] = value;
    }
    tables[lang] = table;
  }
  return tables;
}

function generateTypeScript(tables) {
  const lines = [];
  lines.push('/* GENERATED FILE — edit messages, then run `npm run generate:print-labels`. */');
  lines.push('// Derived view of frontend/src/lib/i18n/messages/*.json for backend thermal');
  lines.push('// printing (#440). Do not edit by hand: regeneration must be byte-identical.');
  lines.push('');
  lines.push('/** Stable concept identifiers resolvable through printLabel(). */');
  lines.push('export type PrintConceptId =');
  for (const key of ALL_CONCEPTS) {
    lines.push(`  | '${key}'`);
  }
  lines.push('  ;');
  lines.push('');
  lines.push('export const PRINT_LABEL_LANGUAGES = [');
  for (const lang of LANGUAGES) {
    lines.push(`  '${lang}',`);
  }
  lines.push('] as const;');
  lines.push('');
  lines.push('export type PrintLabelLanguage = (typeof PRINT_LABEL_LANGUAGES)[number];');
  lines.push('');
  lines.push('type PrintLabelTable = Record<PrintConceptId, string>;');
  lines.push('');
  lines.push('const PRINT_LABELS: Record<PrintLabelLanguage, PrintLabelTable> = {');
  for (const lang of LANGUAGES) {
    lines.push(`  ${lang}: {`);
    for (const key of ALL_CONCEPTS) {
      lines.push(`    '${key}': ${JSON.stringify(tables[lang][key])},`);
    }
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('/**');
  lines.push(' * Resolve a receipt/KOT label concept in the requested language.');
  lines.push(' * Unknown languages and unknown languages missing individual entries fall');
  lines.push(' * back to English so a receipt always renders real labels, never raw keys.');
  lines.push(' */');
  lines.push('export function printLabel(lang: string, conceptId: PrintConceptId): string {');
  lines.push('  const table = (PRINT_LABELS as Record<string, PrintLabelTable | undefined>)[lang];');
  lines.push('  return table?.[conceptId] ?? PRINT_LABELS.en[conceptId];');
  lines.push('}');
  lines.push('');
  lines.push('/** True when the generated view carries a dedicated table for `lang`. */');
  lines.push('export function isGeneratedPrintLanguage(lang: string): lang is PrintLabelLanguage {');
  lines.push('  return (PRINT_LABELS as Record<string, unknown>).hasOwnProperty(lang);');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function regenerate() {
  return generateTypeScript(buildTable());
}

/**
 * Normalize CRLF/CR to LF before byte-comparing. Windows checkouts with
 * git's default core.autocrlf rewrite the committed LF file to CRLF on
 * disk, which must not read as generator drift.
 */
function normalizeEol(text) {
  return text.replace(/\r\n?/g, '\n');
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const content = regenerate();

  if (!checkOnly) {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, content, 'utf8');
    console.log(`[generate-print-labels] wrote ${path.relative(ROOT, OUT_FILE)}`);
    return;
  }

  const committed = fs.existsSync(OUT_FILE)
    ? normalizeEol(fs.readFileSync(OUT_FILE, 'utf8'))
    : '';
  if (committed !== normalizeEol(content)) {
    console.error('[generate-print-labels] DRIFT DETECTED: main/print/print-labels.generated.ts is stale.');
    console.error('Run `npm run generate:print-labels` after editing messages and commit the result.');
    process.exit(1);
  }
  console.log('[generate-print-labels] drift check passed: generated view matches canonical messages.');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[generate-print-labels] failed:', err.message);
    process.exit(1);
  }
}

module.exports = { LANGUAGES, PRINT_NAMESPACE_KEYS, BORROWED_KEYS, ALL_CONCEPTS, OUT_FILE, normalizeEol, regenerate };
