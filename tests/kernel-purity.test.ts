/**
 * Print kernel purity audit (#441, epic #438).
 *
 * shared/print must stay a neutral, dependency-free kernel:
 *   - only relative imports inside shared/print (no frontend/, main/, or
 *     bare/node built-in imports — no IO of any kind);
 *   - no hardcoded language-code unions anywhere in the kernel.
 *
 * Run: npm run test:print-kernel
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

import { LANGUAGES } from '../frontend/src/lib/i18n/languages';

const KERNEL_DIR = path.resolve(__dirname, '../shared/print');
const ALLOWED_IMPORT_PREFIXES = ['./', '../'];
// Modules the kernel may never touch (IO / framework boundaries).
const FORBIDDEN_SPECIFIERS = [
  'electron',
  'react',
  'react-dom',
  'express',
  'next',
];

function kernelSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return kernelSources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const sources = kernelSources(KERNEL_DIR);
assert.ok(sources.length >= 4, 'kernel sources should exist');

console.log('Auditing shared/print imports for purity...');

for (const file of sources) {
  const rel = path.relative(path.dirname(KERNEL_DIR), file);
  const src = fs.readFileSync(file, 'utf8');
  const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(src)) !== null) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    const isRelative = ALLOWED_IMPORT_PREFIXES.some((p) => specifier.startsWith(p));
    const withinKernel = isRelative && !specifier.includes('frontend') && !specifier.includes('main/');
    assert.ok(
      withinKernel,
      `${rel} imports "${specifier}" — the kernel may only import within shared/print`,
    );
    for (const forbidden of FORBIDDEN_SPECIFIERS) {
      assert.ok(
        !specifier.startsWith(forbidden),
        `${rel} imports forbidden module "${specifier}"`,
      );
    }
    assert.ok(!specifier.startsWith('node:'), `${rel} must not import Node builtins (${specifier})`);
  }
}

console.log('✓ no IO/framework imports in shared/print');

// No hardcoded language codes: registered UI language keys must never appear
// as string-literal types anywhere in the kernel (single literals and union
// members alike, in any formatting). The forbidden set comes from the
// authoritative central registry, not from this test.
console.log('Auditing shared/print for hardcoded language codes in type positions...');
const LANGUAGE_CODES: ReadonlySet<string> = new Set(Object.keys(LANGUAGES));
assert.ok(LANGUAGE_CODES.size > 0, 'language registry should expose registered codes');

function typePositionStringLiterals(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isLiteralTypeNode(node)) {
      const literal = node.literal;
      if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) {
        found.push(literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

for (const file of sources) {
  const rel = path.relative(path.dirname(KERNEL_DIR), file);
  const src = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  for (const literalText of typePositionStringLiterals(sourceFile)) {
    assert.ok(
      !LANGUAGE_CODES.has(literalText),
      `${rel} hardcodes language code "${literalText}" in a type position — use PrintLanguageCode`,
    );
  }
}

console.log('✓ no hardcoded language codes in type positions');
console.log('\nPrint kernel purity audit passed.');
