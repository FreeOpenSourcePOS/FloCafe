/**
 * Translation integrity test.
 *
 * Verifies, on every run, that:
 *   1. Every key in en.json is also present in es.json (and vice versa).
 *      Missing key on either side means the UI falls back to a raw key string
 *      for the unmatched language.
 *   2. Neither file contains a duplicate key. JSON.parse silently drops
 *      duplicates, so we scan the raw text for `"key":` patterns and fail
 *      loudly when a key appears more than once.
 *   3. No value is an obviously broken shape: empty, whitespace-only, with
 *      stray JSON-parse artifacts at the edges (trailing `"` or `,`), real
 *      embedded newlines, or unbalanced braces. These signatures only catch
 *      the broken translations we have actually seen in the tree — replace
 *      value-corruption sources manually when new shapes appear.
 *   4. Every key used in the frontend (via `t('foo.bar')` and friends) is
 *      defined. Without this, missing keys render as raw strings like
 *      "dashboard.runningOrders" in the UI.
 *
 * Run: npm run test:translations
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'frontend/src/lib/i18n');
const FILES = [
  { lang: 'en', file: path.join(I18N_DIR, 'en.json') },
  { lang: 'es', file: path.join(I18N_DIR, 'es.json') },
  { lang: 'pt', file: path.join(I18N_DIR, 'pt.json') },
  { lang: 'fa', file: path.join(I18N_DIR, 'fa.json') },
] as const;

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function loadKeys(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
  const seen: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) seen.push(m[1]);
  return seen;
}

function findDuplicates(keys: string[]): string[] {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

function isMalformedValue(value: unknown): string | null {
  if (typeof value !== 'string') return `non-string value (${typeof value})`;
  if (value.trim().length === 0) return 'empty or whitespace-only';

  if (/["`,]$/.test(value)) return 'trailing JSON artifact (", `, `,` or `$)';

  if (value.includes('\n')) return 'contains a real newline character';

  const opens = (value.match(/\{/g) || []).length;
  const closes = (value.match(/\}/g) || []).length;
  if (opens !== closes) {
    return `unbalanced braces (${opens} '{' vs ${closes} '}')`;
  }

  return null;
}

/**
 * Collect every dotted key passed to `t('foo.bar')`, `t(\`foo.bar\`, ...)`, or
 * `t("foo.bar", ...)` in the frontend TypeScript source. The translation
 * helper is the only `t(` call site we care about: it has at least one
 * dotted identifier argument.
 */
function collectCalledKeys(): Set<string> {
  const out = new Set<string>();
  // No shell — pass the pattern as a single argv entry to dodge backtick
  // and quote escaping in /bin/sh.
  const result = spawnSync(
    'grep',
    [
      '-rohE',
      String.raw`t\(\s*['"\`][a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+['"\`]\s*[,)]`,
      'frontend/src',
      '--include=*.ts',
      '--include=*.tsx',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status && result.status > 1) {
    throw new Error(`grep failed: ${result.stderr}`);
  }
  const re = /['"`]([a-zA-Z][a-zA-Z0-9_]*\.[a-zA-Z][a-zA-Z0-9_]*)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(result.stdout)) !== null) out.add(m[1]);
  return out;
}

async function run(): Promise<void> {
  const langs = FILES.map((f) => f.lang);
  console.log(`Translation integrity: ${langs.join(' <-> ')}`);

  const sets = new Map<string, Set<string>>();
  const dups = new Map<string, string[]>();
  const loaded = new Map<string, Record<string, string>>();

  for (const { lang, file } of FILES) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Record<string, string>;
    loaded.set(lang, data);

    const keys = Object.keys(data);
    sets.set(lang, new Set(keys));

    const dupesRaw = findDuplicates(loadKeys(file));
    if (dupesRaw.length) dups.set(lang, dupesRaw);

    console.log(`  ${lang}.json: ${keys.length} keys`);
  }

  // 1. No missing keys — every file must hold the union of all keys.
  const union = new Set<string>();
  for (const s of sets.values()) for (const k of s) union.add(k);
  const missing: Array<{ lang: string; key: string }> = [];
  for (const { lang } of FILES) {
    const s = sets.get(lang)!;
    for (const k of union) if (!s.has(k)) missing.push({ lang, key: k });
  }
  if (missing.length) {
    const byLang = new Map<string, string[]>();
    for (const m of missing) {
      const arr = byLang.get(m.lang) ?? [];
      arr.push(m.key);
      byLang.set(m.lang, arr);
    }
    for (const [lang, ks] of byLang) {
      console.error(`\nKeys missing from ${lang}.json (${ks.length}):`);
      for (const k of ks) console.error(`  - ${k}`);
    }
    assert(false, `translation key mismatch across ${langs.join('/')}`);
  }
  console.log(`  ✓ no missing keys (${langs.join(' <-> ')})`);

  // 2. No duplicate keys within a file.
  if (dups.size) {
    for (const [lang, ks] of dups) {
      console.error(`\nDuplicate keys in ${lang}.json (${ks.length}):`);
      for (const k of ks) console.error(`  - ${k}`);
    }
    assert(false, 'duplicate translation keys detected');
  }
  console.log('  ✓ no duplicate keys');

  // 3. No malformed values (empty, JSON leftovers, unbalanced braces, real
  // newlines).
  const malformed: Array<{ lang: string; key: string; reason: string }> = [];
  for (const { lang } of FILES) {
    const dict = loaded.get(lang)!;
    for (const [k, v] of Object.entries(dict)) {
      const reason = isMalformedValue(v);
      if (reason) malformed.push({ lang, key: k, reason });
    }
  }
  if (malformed.length) {
    console.error(`\nMalformed translation values (${malformed.length}):`);
    for (const m of malformed) {
      console.error(`  - [${m.lang}] ${m.key} — ${m.reason}`);
    }
    assert(false, 'malformed translation values detected');
  }
  console.log('  ✓ no malformed values');

  // 4. Every t('...') call in the frontend points at a defined key.
  const called = collectCalledKeys();
  const undefinedKeys = [...called].filter((k) => !union.has(k));
  if (undefinedKeys.length) {
    console.error(`\nKeys used in t() but missing from one of ${langs.join('/')} (${undefinedKeys.length}):`);
    for (const k of undefinedKeys) console.error(`  - ${k}`);
    assert(false, 'untranslated t() keys referenced in the frontend');
  }
  console.log(`  ✓ no undefined keys (${called.size} t() calls covered)`);

  console.log('\n✅ All translation integrity checks passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
