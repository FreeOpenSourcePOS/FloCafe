/**
 * Translation integrity test (repository-native validation, Issue #382).
 *
 * FloCafe manages translations directly in Git — no Crowdin/Weblate/Tolgee.
 * This suite is the safety gate for every component migration and community
 * translation contribution. It verifies, on every run:
 *
 *   1. Registry ↔ file consistency: every language in
 *      `frontend/src/lib/i18n/languages.ts` has a message JSON file and vice
 *      versa; locale tags are valid BCP-47 and directions are ltr/rtl.
 *   2. Exact nested leaf key parity with `en.json` as the canonical schema:
 *      every leaf key path in en.json must exist in es/pt/fa (zero missing)
 *      and no locale may carry orphan extra keys.
 *   3. String leaf validity: every leaf must be a non-empty string (reject
 *      null, boolean, numeric, object, array), with no corrupted leaf
 *      strings (raw newlines, trailing JSON syntax leftovers, unbalanced
 *      braces) and no empty object/array nodes.
 *   4. ICU syntax validation: every message parses with
 *      `@formatjs/icu-messageformat-parser` (malformed plural rules, invalid
 *      case selectors, unclosed brackets, and syntax errors all fail).
 *   5. ICU variable and placeholder parity: every locale uses the same
 *      argument names as English, and plural/select selector variables match.
 *   6. Rich-text & tag placeholder parity: `{tag}`-style formatting tags
 *      (e.g. `<bold>`, `<link>`) used by English are preserved by every
 *      locale.
 *   7. TypeScript key safety: `t('...')` literal keys used in the frontend
 *      are all defined; template-literal `t(`prefix.${var}`)` calls must
 *      carry an exhaustively typed key cast (`as 'a' | 'b'`); the
 *      `use-intl` AppConfig augmentation in `messages.d.ts` is present.
 *   8. Persian safeguards: fa.json values never silently fall back to the
 *      English value (documented intentional identical list excepted).
 *
 * Negative tests at the bottom feed broken fixture data into each validator
 * and assert it is caught, so a regression in the validators themselves
 * fails CI.
 *
 * Run: npm run test:translations  (also wired into `npm test` and
 * `npm run i18n:check`)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import {
  parse,
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isTimeElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';
import { LANGUAGES } from '../frontend/src/lib/i18n/languages';

const ROOT = path.join(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'frontend/src/lib/i18n/messages');
const FRONTEND_SRC = path.join(ROOT, 'frontend/src');
const MESSAGES_DTS = path.join(ROOT, 'frontend/src/lib/i18n/messages.d.ts');
const FILES = [
  { lang: 'en', file: path.join(I18N_DIR, 'en.json') },
  { lang: 'es', file: path.join(I18N_DIR, 'es.json') },
  { lang: 'pt', file: path.join(I18N_DIR, 'pt.json') },
  { lang: 'fa', file: path.join(I18N_DIR, 'fa.json') },
] as const;

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

/**
 * Recursively flatten a nested message tree into flat dotted leaf keys
 * (e.g. `{ auth: { signIn: "Sign In" } }` → `{ "auth.signIn": "Sign In" }`).
 * This is the canonical view used for cross-locale parity and value checks.
 */
function flattenLeaves(node: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        flattenLeaves(v, full, out);
      } else {
        out[full] = v;
      }
    }
  }
  return out;
}

/**
 * Scan raw JSON for duplicate keys scoped to their own object. JSON.parse
 * silently drops duplicates, so walk the text ourselves: read string tokens
 * (skipping escapes), treat a string followed by `:` as a key, and track
 * `{`/`}` nesting so the same leaf name is allowed in different namespaces
 * while a repeat inside one object is flagged.
 */
function findDuplicateKeys(raw: string): string[] {
  const dups: string[] = [];
  const stack: Array<Set<string>> = [new Set()];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      let j = i + 1;
      let str = '';
      while (j < raw.length) {
        if (raw[j] === '\\') {
          if (raw[j + 1] === 'u') { str += raw.slice(j, j + 6); j += 6; }
          else { str += raw[j] + raw[j + 1]; j += 2; }
          continue;
        }
        if (raw[j] === '"') break;
        str += raw[j];
        j += 1;
      }
      i = j + 1;
      let k = i;
      while (k < raw.length && /\s/.test(raw[k])) k += 1;
      if (raw[k] === ':') {
        const key = JSON.parse(`"${str}"`);
        const top = stack[stack.length - 1];
        if (top.has(key)) dups.push(key); else top.add(key);
        i = k + 1;
      }
    } else if (c === '{') {
      stack.push(new Set());
      i += 1;
    } else if (c === '}') {
      if (stack.length > 1) stack.pop();
      i += 1;
    } else {
      i += 1;
    }
  }
  return dups;
}

/** Value-shape checks that only apply to string leaves. */
function isMalformedValue(value: unknown): string | null {
  if (typeof value !== 'string') return `non-string value (${typeof value})`;
  if (value.trim().length === 0) return 'empty or whitespace-only';

  if (/["`,]$/.test(value)) return 'trailing JSON artifact (\", `, `,` or `$)';

  if (value.includes('\n')) return 'contains a real newline character';

  const opens = (value.match(/\{/g) || []).length;
  const closes = (value.match(/\}/g) || []).length;
  if (opens !== closes) {
    return `unbalanced braces (${opens} '{' vs ${closes} '}')`;
  }

  return null;
}

/**
 * Structural walk of the raw message tree. Flags anything that is not a
 * non-empty string leaf: empty objects (a namespace that produces zero
 * leaves would otherwise silently vanish from parity checks), arrays, and
 * null/boolean/numeric values at any depth.
 */
function findStructuralErrors(tree: Record<string, unknown>, lang: string): string[] {
  const errors: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      errors.push(`[${lang}] ${prefix} — array value at non-leaf position`);
      return;
    }
    const entries = Object.entries(node as Record<string, unknown>);
    if (entries.length === 0) {
      errors.push(`[${lang}] ${prefix} — empty object (no leaf keys)`);
      return;
    }
    for (const [k, v] of entries) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') {
        if (Array.isArray(v)) {
          errors.push(`[${lang}] ${full} — array value (must be a string leaf)`);
        } else if (Object.keys(v as Record<string, unknown>).length === 0) {
          errors.push(`[${lang}] ${full} — empty object (must be a string leaf)`);
        } else {
          walk(v, full);
        }
      } else if (typeof v !== 'string' || v.trim().length === 0) {
        errors.push(`[${lang}] ${full} — non-string or empty leaf (${JSON.stringify(v)})`);
      }
    }
  };
  walk(tree, '');
  return errors;
}

/* ------------------------------------------------------------------ *
 * ICU helpers — argument / selector / tag extraction from the parser *
 * AST. Used for syntax validation and English-parity comparisons.    *
 * ------------------------------------------------------------------ */

interface IcuInfo {
  args: Set<string>;
  selectors: Map<string, 'plural' | 'select'>;
  tags: Set<string>;
}

/**
 * Parse an ICU message and collect the argument names, plural/select
 * selector variables, and rich-text tag names it uses. Throws a SyntaxError
 * on malformed ICU (unclosed brackets, missing `other`, invalid selectors).
 */
function icuInfo(message: string): IcuInfo {
  const ast = parse(message);
  const info: IcuInfo = { args: new Set(), selectors: new Map(), tags: new Set() };
  const walk = (els: MessageFormatElement[]): void => {
    for (const el of els) {
      if (isArgumentElement(el)) {
        info.args.add(el.value);
      } else if (isNumberElement(el) || isDateElement(el) || isTimeElement(el)) {
        info.args.add(el.value);
      } else if (isPluralElement(el) || isSelectElement(el)) {
        info.args.add(el.value);
        info.selectors.set(el.value, isPluralElement(el) ? 'plural' : 'select');
        for (const opt of Object.values(el.options)) walk(opt.value);
      } else if (isTagElement(el)) {
        info.tags.add(el.value);
        walk(el.children);
      }
    }
  };
  walk(ast);
  return info;
}

/** Try to parse a message; returns the syntax error text or null. */
function icuSyntaxError(message: string): string | null {
  try {
    parse(message);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ---------------------------------------------------------------- *
 * Validators — each takes plain data so the negative tests at the  *
 * bottom can feed broken fixtures. Returns an array of error       *
 * strings; empty array means valid.                                *
 * ---------------------------------------------------------------- */

function registryConsistencyErrors(
  registry: Record<string, { locale: string; direction: string; selectable: boolean }>,
  filesOnDisk: string[],
): string[] {
  const errors: string[] = [];
  const langs = Object.keys(registry);
  const fileSet = new Set(filesOnDisk);

  for (const lang of langs) {
    if (!fileSet.has(`${lang}.json`)) {
      errors.push(`registry language "${lang}" has no messages/${lang}.json file`);
    }
    const cfg = registry[lang];
    try {
      const canonical = new Intl.Locale(cfg.locale).toString();
      if (canonical !== cfg.locale) {
        errors.push(`language "${lang}" locale "${cfg.locale}" is not canonical BCP-47 (expected "${canonical}")`);
      }
    } catch {
      errors.push(`language "${lang}" has invalid BCP-47 locale tag "${cfg.locale}"`);
    }
    if (cfg.direction !== 'ltr' && cfg.direction !== 'rtl') {
      errors.push(`language "${lang}" has invalid direction "${cfg.direction}" (expected ltr or rtl)`);
    }
    if (typeof cfg.selectable !== 'boolean') {
      errors.push(`language "${lang}" selectable must be a boolean`);
    }
  }

  for (const f of filesOnDisk) {
    const lang = f.replace(/\.json$/, '');
    if (!langs.includes(lang)) {
      errors.push(`messages/${f} has no matching entry in the languages.ts registry`);
    }
  }

  return errors;
}

function keyParityErrors(enKeys: Set<string>, localeKeys: Set<string>, lang: string): string[] {
  const errors: string[] = [];
  const missing = [...enKeys].filter((k) => !localeKeys.has(k));
  const orphan = [...localeKeys].filter((k) => !enKeys.has(k));
  for (const k of missing) errors.push(`[${lang}] missing key: ${k}`);
  for (const k of orphan) errors.push(`[${lang}] orphan extra key (not in en.json): ${k}`);
  return errors;
}

function leafStringErrors(flat: Record<string, unknown>, lang: string): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(flat)) {
    const reason = isMalformedValue(v);
    if (reason) errors.push(`[${lang}] ${k} — ${reason}`);
  }
  return errors;
}

function icuSyntaxErrors(flat: Record<string, string>, lang: string): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(flat)) {
    const err = icuSyntaxError(v);
    if (err) errors.push(`[${lang}] ${k} — invalid ICU syntax: ${err}`);
  }
  return errors;
}

function icuParityErrors(enFlat: Record<string, string>, localeFlat: Record<string, string>, lang: string): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const localeVal = localeFlat[k];
    if (localeVal === undefined) continue; // missing keys reported by keyParityErrors
    const en = icuInfo(enFlat[k]);
    const loc = icuInfo(localeVal);

    const enOnlyArgs = [...en.args].filter((a) => !loc.args.has(a));
    const locOnlyArgs = [...loc.args].filter((a) => !en.args.has(a));
    if (enOnlyArgs.length || locOnlyArgs.length) {
      errors.push(
        `[${lang}] ${k} — placeholder argument mismatch: EN-only=[${enOnlyArgs.join(',')}] ${lang}-only=[${locOnlyArgs.join(',')}]`,
      );
    }

    const enOnlySel = [...en.selectors.entries()].filter(([name]) => !loc.selectors.has(name));
    const locOnlySel = [...loc.selectors.entries()].filter(([name]) => !en.selectors.has(name));
    const typeMismatch = [...en.selectors.entries()].filter(
      ([name, type]) => loc.selectors.get(name) && loc.selectors.get(name) !== type,
    );
    if (enOnlySel.length || locOnlySel.length || typeMismatch.length) {
      errors.push(
        `[${lang}] ${k} — plural/select selector mismatch: EN=[${[...en.selectors.entries()].map(([n, t]) => `${n}(${t})`).join(',')}] ${lang}=[${[...loc.selectors.entries()].map(([n, t]) => `${n}(${t})`).join(',')}]`,
      );
    }
  }
  return errors;
}

function tagParityErrors(enFlat: Record<string, string>, localeFlat: Record<string, string>, lang: string): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const localeVal = localeFlat[k];
    if (localeVal === undefined) continue;
    const enTags = icuInfo(enFlat[k]).tags;
    const locTags = icuInfo(localeVal).tags;
    const missing = [...enTags].filter((t) => !locTags.has(t));
    const extra = [...locTags].filter((t) => !enTags.has(t));
    if (missing.length || extra.length) {
      errors.push(
        `[${lang}] ${k} — rich-text tag mismatch: EN tags=[${[...enTags].join(',')}] ${lang} tags=[${[...locTags].join(',')}]`,
      );
    }
  }
  return errors;
}

/** fa.json keys whose value is intentionally identical to en.json. These are
 * brand names, pure format strings, technical identifiers, example inputs,
 * and measurements — translating them would be wrong or meaningless.
 * Anything else that equals its English value is an untranslated string and
 * must be fixed (or added here with a comment explaining why it is shared).
 */
const FA_INTENTIONAL_IDENTICAL: ReadonlySet<string> = new Set([
  'auth.emailPlaceholder', // example email
  'common.appTitle', // brand
  'common.brandName', // brand
  'common.logoAlt', // brand
  'kds.emptyColumn', // em dash
  'pos.addonPrice', // pure format: +{currency}{price}
  'pos.loadingEllipsis', // ellipsis
  'pos.tagCount', // pure format: {tag} ×{count}
  'pos.taxLine', // pure format: {title} @{rate}%
  'printTest.escpos', // technical acronym
  'printTest.paperWidth58', // measurement
  'printTest.paperWidth80', // measurement
  'products.addonSelectionRange', // pure format: {min} – {max}
  'setup.ownerEmailPlaceholder', // example email
  'settings.apiKeyInputPlaceholder', // example API key
  'settings.connectionUsb', // technical acronym
  'settings.instagramPlaceholder', // example handle
  'settings.ipAddressPlaceholder', // example IP
  'settings.kds', // technical acronym
  'settings.paperSize58', // measurement
  'settings.paperSize80', // measurement
  'settings.paperWidth58', // measurement
  'settings.paperWidth80', // measurement
  'settings.paperWidth80Safe', // measurement
  'settings.portPlaceholder', // example port
  'settings.registrationEmailPlaceholder', // example email
  'settings.registrationLastError', // pure placeholder: {error}
  'serverApp.emailPlaceholder', // example email
  'settings.revflo', // brand
  'settings.tabOrderflow', // brand
  'whatsapp.connect.pairingPhonePlaceholder', // pure format: {dialCode}XXXXXXXXXX
]);

function faFallbackErrors(faFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const faVal = faFlat[k];
    if (faVal === undefined) continue; // reported by key parity
    if (faVal === enFlat[k] && !FA_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`fa.json ${k} — identical to English value (renders as English for Persian users)`);
    }
  }
  return errors;
}

/* ------------------------------------------------------------ *
 * Frontend source scans (TypeScript key safety, Issue #382 §6). *
 * ------------------------------------------------------------ */

/**
 * Collect every dotted key passed to `t('foo.bar')`, `t(\`foo.bar\`, ...)`,
 * or `t("foo.bar", ...)` in the given TypeScript source directory. The
 * translation helper is the only `t(` call site we care about: it has at
 * least one dotted identifier argument.
 */
function collectCalledKeys(dir: string = FRONTEND_SRC): Set<string> {
  const out = new Set<string>();
  // No shell — pass the pattern as a single argv entry to dodge backtick
  // and quote escaping in /bin/sh.
  const result = spawnSync(
    'grep',
    [
      '-rohE',
      String.raw`t\(\s*['"\`][a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+['"\`]\s*[,)]`,
      dir,
      '--include=*.ts',
      '--include=*.tsx',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status && result.status > 1) {
    throw new Error(`grep failed: ${result.stderr}`);
  }
  // Capture the full dotted key (any number of segments). The earlier
  // two-segment-only regex silently skipped 3+ segment keys like
  // `whatsapp.send.error.notConnected`, leaving them unchecked.
  const re = /['"`]([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(result.stdout)) !== null) out.add(m[1]);
  return out;
}

/**
 * Find unsafe template-literal translation calls: `t(\`prefix.${var}\`)`
 * without an exhaustively typed `as 'key1' | 'key2'` cast. Dynamic keys must
 * be pinned to a closed set of valid message keys so a typo or an
 * unexpected runtime value cannot render a raw key string in the UI.
 */
function collectUnsafeDynamicKeys(dir: string = FRONTEND_SRC): Array<{ file: string; line: number; code: string }> {
  const hits: Array<{ file: string; line: number; code: string }> = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'out') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          // `t(` immediately followed by a backtick template containing `${`
          // and NOT followed (after the closing backtick) by ` as `.
          const re = /(?:^|[^\w$.])t\(\s*`([^`]*\$\{[^}]*\}[^`]*)`(?!\s*as\s+)/;
          if (re.test(line)) {
            hits.push({ file: path.relative(ROOT, full), line: idx + 1, code: line.trim() });
          }
        });
      }
    }
  };
  walk(dir);
  return hits;
}

/** The `use-intl` AppConfig augmentation must stay wired (Issue #382 §6). */
function messagesDtsErrors(): string[] {
  const errors: string[] = [];
  if (!fs.existsSync(MESSAGES_DTS)) {
    errors.push('frontend/src/lib/i18n/messages.d.ts is missing (use-intl AppConfig augmentation)');
    return errors;
  }
  const content = fs.readFileSync(MESSAGES_DTS, 'utf8');
  if (!content.includes("declare module 'use-intl'")) errors.push('messages.d.ts must declare module \'use-intl\'');
  if (!content.includes('interface AppConfig')) errors.push('messages.d.ts must declare interface AppConfig');
  if (!/Messages\s*:/.test(content)) errors.push('messages.d.ts AppConfig must type Messages');
  if (!/Locale\s*:/.test(content)) errors.push('messages.d.ts AppConfig must type Locale');
  return errors;
}

/* ----------------------------------------------------------------- *
 * Live repository checks — run against the real message files.      *
 * ----------------------------------------------------------------- */

async function run(): Promise<void> {
  const langs = FILES.map((f) => f.lang);
  console.log(`Translation integrity: ${langs.join(' <-> ')}`);

  // 1. Registry ↔ file consistency.
  const filesOnDisk = fs.readdirSync(I18N_DIR).filter((f) => f.endsWith('.json')).sort();
  const registryErrors = registryConsistencyErrors(LANGUAGES, filesOnDisk);
  if (registryErrors.length) {
    for (const e of registryErrors) console.error(`  - ${e}`);
    assert(false, 'languages.ts registry is inconsistent with messages/ files');
  }
  console.log(`  ✓ registry ↔ files consistent (${langs.length} languages, ${filesOnDisk.length} files)`);

  const sets = new Map<string, Set<string>>();
  const dups = new Map<string, string[]>();
  const loaded = new Map<string, Record<string, unknown>>();
  const loadedStrings = new Map<string, Record<string, string>>();
  const rawTrees = new Map<string, Record<string, unknown>>();

  for (const { lang, file } of FILES) {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data = flattenLeaves(parsed);
    loaded.set(lang, data);
    loadedStrings.set(lang, data as Record<string, string>);
    rawTrees.set(lang, parsed);

    const keys = Object.keys(data);
    sets.set(lang, new Set(keys));

    const dupesRaw = findDuplicateKeys(raw);
    if (dupesRaw.length) dups.set(lang, dupesRaw);

    console.log(`  ${lang}.json: ${keys.length} leaf keys`);
  }

  const enKeys = sets.get('en')!;

  // 2. Exact nested leaf key parity — en.json is canonical (zero missing,
  // zero orphan extras), including `selectable: false` locales like fa.
  const parityErrors: string[] = [];
  for (const { lang } of FILES) {
    if (lang === 'en') continue;
    parityErrors.push(...keyParityErrors(enKeys, sets.get(lang)!, lang));
  }
  if (parityErrors.length) {
    console.error(`\nKey parity violations vs en.json (${parityErrors.length}):`);
    for (const e of parityErrors.slice(0, 100)) console.error(`  - ${e}`);
    if (parityErrors.length > 100) console.error(`  … and ${parityErrors.length - 100} more`);
    assert(false, 'translation key parity vs en.json violated');
  }
  console.log('  ✓ exact leaf key parity with en.json (no missing, no orphan keys)');

  // 3a. Structural leaf validation: only non-empty string leaves, no empty
  // objects / arrays / null / booleans / numbers anywhere.
  const structuralErrors: string[] = [];
  for (const { lang } of FILES) {
    structuralErrors.push(...findStructuralErrors(rawTrees.get(lang)!, lang));
  }
  if (structuralErrors.length) {
    console.error(`\nStructural leaf violations (${structuralErrors.length}):`);
    for (const e of structuralErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'non-string or empty leaves detected');
  }
  console.log('  ✓ all leaves are non-empty strings (no empty objects/arrays/null/booleans/numbers)');

  // 3b. Malformed string values (empty, JSON leftovers, unbalanced braces,
  // real newlines).
  const malformed: string[] = [];
  for (const { lang } of FILES) {
    malformed.push(...leafStringErrors(loaded.get(lang)!, lang));
  }
  if (malformed.length) {
    console.error(`\nMalformed translation values (${malformed.length}):`);
    for (const e of malformed.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'malformed translation values detected');
  }
  console.log('  ✓ no malformed values');

  // 4. ICU syntax validation across all locales.
  const icuErrors: string[] = [];
  for (const { lang } of FILES) {
    icuErrors.push(...icuSyntaxErrors(loadedStrings.get(lang)!, lang));
  }
  if (icuErrors.length) {
    console.error(`\nICU syntax errors (${icuErrors.length}):`);
    for (const e of icuErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'ICU syntax errors detected');
  }
  console.log('  ✓ all messages parse as valid ICU (plurals, selects, brackets)');

  // 5. ICU variable and placeholder parity vs en.json (args + selectors).
  const icuParity: string[] = [];
  for (const { lang } of FILES) {
    if (lang === 'en') continue;
    icuParity.push(...icuParityErrors(loadedStrings.get('en')!, loadedStrings.get(lang)!, lang));
  }
  if (icuParity.length) {
    console.error(`\nICU placeholder/selector mismatches vs en.json (${icuParity.length}):`);
    for (const e of icuParity.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'ICU placeholder parity vs en.json violated');
  }
  console.log('  ✓ placeholder arguments and plural/select selectors match en.json in all locales');

  // 6. Rich-text tag parity vs en.json.
  const tagParity: string[] = [];
  for (const { lang } of FILES) {
    if (lang === 'en') continue;
    tagParity.push(...tagParityErrors(loadedStrings.get('en')!, loadedStrings.get(lang)!, lang));
  }
  if (tagParity.length) {
    console.error(`\nRich-text tag mismatches vs en.json (${tagParity.length}):`);
    for (const e of tagParity.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'rich-text tag parity vs en.json violated');
  }
  console.log('  ✓ rich-text tags match en.json in all locales');

  // 7a. Every literal t('...') key used in the frontend is defined.
  const union = new Set<string>();
  for (const s of sets.values()) for (const k of s) union.add(k);
  const called = collectCalledKeys();
  const undefinedKeys = [...called].filter((k) => !union.has(k));
  if (undefinedKeys.length) {
    console.error(`\nKeys used in t() but missing from all locales (${undefinedKeys.length}):`);
    for (const k of undefinedKeys) console.error(`  - ${k}`);
    assert(false, 'untranslated t() keys referenced in the frontend');
  }
  console.log(`  ✓ no undefined keys (${called.size} literal t() calls covered)`);

  // 7b. No unsafe template-literal t(`prefix.${var}`) calls without an
  // exhaustively typed cast.
  const unsafe = collectUnsafeDynamicKeys();
  if (unsafe.length) {
    console.error(`\nUnsafe dynamic t() template-literal calls (${unsafe.length}):`);
    for (const u of unsafe) console.error(`  - ${u.file}:${u.line} — ${u.code}`);
    console.error('  Add an exhaustively typed cast: t(`prefix.${var}` as \'prefix.a\' | \'prefix.b\')');
    assert(false, 'unsafe dynamic translation keys found in the frontend');
  }
  console.log('  ✓ no unsafe template-literal t() calls (all dynamic keys exhaustively cast)');

  // 7c. The use-intl AppConfig augmentation is wired (compile-time key safety).
  const dtsErrors = messagesDtsErrors();
  if (dtsErrors.length) {
    for (const e of dtsErrors) console.error(`  - ${e}`);
    assert(false, 'use-intl AppConfig augmentation broken');
  }
  console.log('  ✓ messages.d.ts AppConfig augmentation present (compile-time key checks active)');

  // 8. fa.json values must not silently fall back to the English value.
  const faErrors = faFallbackErrors(loadedStrings.get('fa')!, loadedStrings.get('en')!);
  if (faErrors.length) {
    console.error(`\nfa.json values identical to English (${faErrors.length}) — these render as English for Persian users:`);
    for (const e of faErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'fa.json contains untranslated (English-identical) values');
  }
  console.log(`  ✓ no untranslated fa.json values (${FA_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  console.log('\n✅ All translation integrity checks passed.');
}

/* ----------------------------------------------------------------- *
 * Negative tests — feed broken fixtures to each validator and       *
 * assert the failure mode is detected. A validator that stops       *
 * catching its class of bug fails CI here.                          *
 * ----------------------------------------------------------------- */

function expectDetected(name: string, errors: string[]): void {
  assert(errors.length > 0, `negative test "${name}" — validator failed to detect the violation`);
}

function runNegativeTests(): void {
  console.log('\nNegative tests (fixture-based):');

  // 1. Registry consistency.
  expectDetected(
    'registry: missing file for language',
    registryConsistencyErrors({ xx: { locale: 'xx', direction: 'ltr', selectable: true } }, ['en.json']),
  );
  expectDetected(
    'registry: orphan file without registry entry',
    registryConsistencyErrors({ en: { locale: 'en', direction: 'ltr', selectable: true } }, ['en.json', 'zz.json']),
  );
  expectDetected(
    'registry: invalid BCP-47 locale',
    registryConsistencyErrors({ en: { locale: 'not a tag', direction: 'ltr', selectable: true } }, ['en.json']),
  );
  expectDetected(
    'registry: non-canonical BCP-47 locale',
    registryConsistencyErrors({ en: { locale: 'EN_us', direction: 'ltr', selectable: true } }, ['en.json']),
  );
  expectDetected(
    'registry: invalid direction',
    registryConsistencyErrors({ en: { locale: 'en', direction: 'sideways', selectable: true } }, ['en.json']),
  );

  // 2. Key parity: missing and orphan keys.
  expectDetected(
    'parity: missing key in locale',
    keyParityErrors(new Set(['a.b', 'a.c']), new Set(['a.b']), 'es'),
  );
  expectDetected(
    'parity: orphan extra key in locale',
    keyParityErrors(new Set(['a.b']), new Set(['a.b', 'a.zzz']), 'es'),
  );

  // 3. Leaf validity: non-string leaves, empty objects, arrays, malformed strings.
  expectDetected('leaf: numeric leaf', findStructuralErrors({ a: 42 }, 'es'));
  expectDetected('leaf: null leaf', findStructuralErrors({ a: null }, 'es'));
  expectDetected('leaf: empty object namespace', findStructuralErrors({ a: {} }, 'es'));
  expectDetected('leaf: array value', findStructuralErrors({ a: ['x'] }, 'es'));
  expectDetected('leaf: empty string', findStructuralErrors({ a: '   ' }, 'es'));
  expectDetected(
    'leaf: trailing JSON artifact',
    leafStringErrors({ 'a.b': 'value",' }, 'es'),
  );
  expectDetected('leaf: real newline', leafStringErrors({ 'a.b': 'line1\nline2' }, 'es'));
  expectDetected('leaf: unbalanced braces', leafStringErrors({ 'a.b': 'one { two' }, 'es'));

  // 4. ICU syntax.
  expectDetected('icu: unclosed bracket', icuSyntaxErrors({ 'a.b': 'Hello {name' }, 'es'));
  expectDetected(
    'icu: plural missing other clause',
    icuSyntaxErrors({ 'a.b': '{count, plural, one {# item}}' }, 'es'),
  );
  expectDetected(
    'icu: select missing other clause',
    icuSyntaxErrors({ 'a.b': '{gender, select, male {He} female {She}}' }, 'es'),
  );

  // 5. Placeholder parity: renamed argument, and selector dropped/renamed.
  expectDetected(
    'icu parity: renamed placeholder arg',
    icuParityErrors({ 'a.b': 'Hello {count}' }, { 'a.b': 'Hola {total}' }, 'es'),
  );
  expectDetected(
    'icu parity: plural selector dropped',
    icuParityErrors(
      { 'a.b': '{count, plural, one {# item} other {# items}}' },
      { 'a.b': '{count} items' },
      'es',
    ),
  );
  expectDetected(
    'icu parity: plural selector renamed',
    icuParityErrors(
      { 'a.b': '{count, plural, one {# item} other {# items}}' },
      { 'a.b': '{total, plural, one {# item} other {# items}}' },
      'es',
    ),
  );

  // 6. Rich-text tag parity.
  expectDetected(
    'tag parity: renamed tag',
    tagParityErrors({ 'a.b': 'Click <bold>here</bold>' }, { 'a.b': 'Click <link>aquí</link>' }, 'es'),
  );
  expectDetected(
    'tag parity: dropped tag',
    tagParityErrors({ 'a.b': 'Click <bold>here</bold>' }, { 'a.b': 'Click here' }, 'es'),
  );

  // 7. fa safeguards.
  expectDetected(
    'fa: English-identical value',
    faFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );

  // 8. TypeScript key safety.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-negative-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'fixture.ts'),
      [
        "const bad = t('does.not.exist');",
        "const unsafe = t(`prefix.${value}`);",
        "const safe = t(`prefix.${value}` as 'prefix.a' | 'prefix.b');",
      ].join('\n'),
    );

    const called = collectCalledKeys(tmp);
    expectDetected(
      'ts: invalid literal key',
      [...called].filter((k) => !new Set(['prefix.a', 'prefix.b']).has(k)),
    );

    const unsafe = collectUnsafeDynamicKeys(tmp);
    expectDetected('ts: unsafe template-literal t() call', unsafe.map((u) => u.code));
    const flaggedLines = unsafe.map((u) => u.line);
    assert(
      flaggedLines.length === 1 && flaggedLines[0] === 2,
      `ts: exhaustively cast dynamic key must NOT be flagged (flagged lines: ${flaggedLines.join(',')})`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  ✓ all negative fixtures detected by their validators');
}

async function main(): Promise<void> {
  await run();
  runNegativeTests();
  console.log('\n✅ All translation integrity checks + negative tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
