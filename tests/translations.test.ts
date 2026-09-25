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
 *      every leaf key path in en.json must exist in es/fr/pt/fa (zero missing)
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
 *   9. French safeguards: fr.json values never silently fall back to the
 *      English value (documented intentional identical list excepted).
 *  10. Turkish safeguards: tr.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  11. Filipino safeguards: fil.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  12. German safeguards: de.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  13. Indonesian safeguards: id.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  14. Italian safeguards: it.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  15. Japanese and Chinese safeguards: ja.json, zh.json, and zh-tw.json values
 *      never contain placeholders or silently fall back to English (documented
 *      intentional lists excepted).
 *  16. Dutch safeguards: nl.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  17. Hindi safeguards: hi.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  18. Bengali safeguards: bn.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  19. Albanian safeguards: sq.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  20. Urdu safeguards: ur.json values never contain placeholders or silently
 *      fall back to the English value (documented intentional identical list excepted).
 *  21. Russian safeguards: ru.json values never contain placeholders, malformed
 *      Unicode, or silently fall back to the English value.
 *  22. Vietnamese safeguards: vi.json values never contain placeholders,
 *      malformed replacement characters, or non-NFC text, and only documented
 *      shared values may remain identical to English.
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
import { walkTypeScriptFiles, collectCalledKeys } from './helpers/i18n-scanner';

const ROOT = path.join(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'frontend/src/lib/i18n/messages');
const FRONTEND_SRC = path.join(ROOT, 'frontend/src');
const MESSAGES_DTS = path.join(ROOT, 'frontend/src/lib/i18n/messages.d.ts');
const FILES = (Object.keys(LANGUAGES) as Array<keyof typeof LANGUAGES>).map((lang) => ({
  lang,
  file: path.join(I18N_DIR, `${lang}.json`),
}));

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
  'settings.paymentMethodUpi', // technical acronym (payment rail name)
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

/** fr.json keys whose value is intentionally identical to en.json. These are
 * brand names, technical identifiers, pure format strings, and French words
 * that are spelled the same as English. Other identical values are treated as
 * untranslated so the French UI cannot silently regress to English.
 */
const FR_INTENTIONAL_IDENTICAL: ReadonlySet<string> = new Set([
  'auth.emailPlaceholder', // example email
  'dashboard.exportCsv', // format label "CSV (.csv)"
  'dashboard.exportXlsx', // format label "Excel (.xlsx)"
  'businessType.restaurant', // same word in French
  'common.appTitle', // brand
  'common.brandName', // brand
  'common.logoAlt', // brand
  'common.tableFallback', // same word in French
  'common.total', // same word in French
  'customer.ptsSuffix', // standard abbreviation
  'customers.columnActions', // same word in French
  'customers.columnDate', // same word in French
  'customers.columnDescription', // same word in French
  'customers.columnPoints', // same word in French
  'inventory.actions', // same word in French
  'inventory.date', // same word in French
  'inventory.movementType', // same word in French
  'inventory.stock', // same word in French
  'kds.emptyColumn', // em dash
  'kds.tableLabel', // same word in French
  'kds.viewKanban', // product term
  'nav.kds', // technical acronym
  'nav.portLabel', // same word in French
  'nav.pos', // technical acronym
  'nav.tables', // same word in French
  'nav.whatsapp', // product name
  'orders.tableAt', // same word in French
  'pos.addonPrice', // pure format: +{currency}{price}
  'pos.loadingEllipsis', // ellipsis
  'pos.loyaltyPointsShort', // standard abbreviation
  'pos.pointsApproxValue', // pure format with standard abbreviation
  'pos.tagCount', // pure format: {tag} ×{count}
  'pos.taxLine', // pure format: {title} @{rate}%
  'pos.total', // same word in French
  'printTest.escpos', // technical acronym
  'printTest.paperWidth58', // measurement
  'printTest.paperWidth80', // measurement
  'print.note', // same word in French
  'print.grandTotal', // receipt convention
  'print.kot.type', // same word in French
  'print.hsn', // technical acronym
  'products.addonSelectionRange', // pure format: {min} – {max}
  'products.cashbackGlobalBadge', // same word in French
  'products.categoryDescription', // same word in French
  'products.colorCyan', // same color name
  'products.colorFuchsia', // same color name
  'products.colorIndigo', // same color name
  'products.colorOrange', // same color name
  'products.colorViolet', // same color name
  'products.columnActions', // same word in French
  'products.columnStock', // same word in French
  'products.fieldSku', // technical acronym
  'receipt.date', // same word in French
  'receipt.table', // same word in French
  'serverApp.emailPlaceholder', // example email
  'serverApp.orderSlipTotal', // same word in French
  'serverApp.tableLabel', // same word in French
  'serverApp.tables', // same word in French
  'settings.apiKeyInputPlaceholder', // example API key
  'settings.connectionUsb', // technical acronym
  'settings.paymentMethodUpi', // technical acronym (payment rail name)
  'settings.instagramPlaceholder', // example handle
  'settings.ipAddressPlaceholder', // example IP
  'settings.iranCurrencyDisplayRial', // currency name and native script
  'settings.iranCurrencyDisplayToman', // currency name and native script
  'settings.kds', // technical acronym
  'settings.paperSize58', // measurement
  'settings.paperSize80', // measurement
  'settings.paperWidth58', // measurement
  'settings.paperWidth80', // measurement
  'settings.paperWidth80Safe', // measurement
  'settings.port', // same word in French
  'settings.portPlaceholder', // example port
  'settings.registrationEmailPlaceholder', // example email
  'settings.registrationLastError', // pure placeholder: {error}
  'settings.revflo', // brand
  'settings.tabOrderflow', // brand
  'settings.tabWhatsapp', // product name
  'settings.unicode', // technical term
  'settings.version', // same word in French
  'settings.whatsapp', // product name
  'setup.expressLabel', // setup mode name
  'setup.ownerEmailPlaceholder', // example email
  'setup.pinLabel', // technical acronym
  'staff.roleChef', // same loanword in French UI
  'permissionMatrix.areas.menu', // same word in French
  'support.restaurant', // same word in French
  'support.version', // same word in French
  'tables.section', // same word in French
  'tables.title', // same word in French
  'tables.floorplanAuto', // same word in French ("Auto")
  'tax.actions', // same word in French
  'tax.auditCreateOverride', // pure format with identifiers
  'tax.type', // same word in French
  'update.downloadingBadge', // symbol + placeholder
  'whatsapp.connect.pairingPhonePlaceholder', // pure format: {dialCode}XXXXXXXXXX
]);

function frFallbackErrors(frFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const frVal = frFlat[k];
    if (frVal === undefined) continue; // reported by key parity
    if (frVal === enFlat[k] && !FR_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`fr.json ${k} — identical to English value (renders as English for French users)`);
    }
  }
  return errors;
}

const TR_INTENTIONAL_IDENTICAL = new Set<string>([
  'dashboard.exportCsv', // format label "CSV (.csv)"
  'dashboard.exportXlsx', // format label "Excel (.xlsx)"
  'settings.paymentMethodUpi', // technical acronym (payment rail name)
  'common.appTitle', // brand name "Flo"
  'common.brandName', // brand name "Flo Cafe"
  'common.logoAlt', // brand name "Flo Cafe"
  'nav.portLabel', // technical term "Port"
  'nav.whatsapp', // product name "WhatsApp"
  'pos.addonPrice', // pure format "+{currency}{price}"
  'pos.loadingEllipsis', // pure symbol "…"
  'pos.tagCount', // pure format "{tag} ×{count}"
  'pos.tagVegan', // universal dietary term "Vegan"
  'printTest.escpos', // technical hardware standard "ESCPOS (USB)"
  'products.addonSelectionRange', // pure format "{min} – {max}"
  'products.columnCashback', // financial loanword "Cashback"
  'products.fieldSku', // technical acronym "SKU"
  'products.saleUnitCl', // unit "cl"
  'products.saleUnitFlOz', // unit "fl oz"
  'products.saleUnitG', // unit "g"
  'products.saleUnitKg', // unit "kg"
  'products.saleUnitL', // unit "l"
  'products.saleUnitLb', // unit "lb"
  'products.saleUnitMl', // unit "ml"
  'products.saleUnitOz', // unit "oz"
  'products.skuLabel', // pure format "SKU: {sku}"
  'products.tagVegan', // universal dietary term "Vegan"
  'settings.ipAddressPlaceholder', // example IP "192.168.1.100"
  'settings.iranNumberDigitsLatin', // script name "Latin (0-9)"
  'settings.plan', // loanword / term "Plan"
  'settings.port', // technical term "Port"
  'settings.revflo', // brand name "RevFlo"
  'settings.tabWhatsapp', // product name "WhatsApp"
  'settings.unicode', // technical term "Unicode"
  'settings.whatsapp', // product name "WhatsApp"
  'support.platform', // loanword / term "Platform"
  'tax.auditCreateOverride', // pure format with identifiers
  'tax.auditUpdateOverride', // pure format with identifiers
  'whatsapp.connect.pairingPhonePlaceholder', // pure format: {dialCode}XXXXXXXXXX
]);

function trFallbackErrors(trFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const trVal = trFlat[k];
    if (trVal === undefined) continue; // reported by key parity
    if (trVal.startsWith('[TR]') || trVal.startsWith('[TODO]')) {
      errors.push(`tr.json ${k} — placeholder prefix found: "${trVal}"`);
    } else if (trVal === enFlat[k] && !TR_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`tr.json ${k} — identical to English value (renders as English for Turkish users)`);
    }
  }
  return errors;
}

const FIL_INTENTIONAL_IDENTICAL = new Set<string>([
  'dashboard.exportCsv', // format label "CSV (.csv)"
  'dashboard.exportXlsx', // format label "Excel (.xlsx)"
  'auth.countryIndia',
  'auth.countryThailand',
  'auth.email',
  'auth.password',
  'auth.recoverPinLabel',
  'common.appTitle',
  'common.brandName',
  'common.discount',
  'common.logoAlt',
  'common.subtotal',
  'customer.email',
  'customer.loyalty',
  'customer.ptsSuffix',
  'customers.columnBill',
  'customers.columnCustomer',
  'customers.columnLedger',
  'customers.loyaltyLedger',
  'dashboard.minutesValue',
  'dashboard.title',
  'dashboard.walkIn',
  'inventory.stock', // loanword in Filipino UI
  'inventory.supply', // loanword in Filipino UI
  'inventory.yield', // technical term
  'kds.connectionLive',
  'kds.modalOrderNumber',
  'kds.viewKanban',
  'kds.viewTabs',
  'nav.dashboard',
  'nav.kds',
  'nav.portLabel',
  'nav.pos',
  'nav.staff',
  'nav.whatsapp',
  'orders.delivery',
  'orders.dineIn',
  'orders.managerPinLabel',
  'orders.online',
  'orders.overridePinLabel',
  'orders.takeaway',
  'pos.addonPrice',
  'pos.billNumber',
  'pos.cart',
  'pos.customer',
  'pos.delivery',
  'pos.discount',
  'pos.loadingEllipsis',
  'pos.loyalty',
  'pos.loyaltyPointsShort',
  'pos.loyaltyWallet',
  'pos.managerPin',
  'pos.managerPinRequired',
  'pos.methodCard',
  'pos.methodCash',
  'pos.methodWallet',
  'settings.paymentMethodCard',
  'settings.paymentMethodCash',
  'pos.orderNumber',
  'pos.orderTypeDelivery',
  'pos.orderTypeOnline',
  'pos.orderTypeSuffix_delivery',
  'pos.orderTypeSuffix_dine_in',
  'pos.orderTypeSuffix_online',
  'pos.orderTypeSuffix_takeaway',
  'pos.orderTypeTakeaway',
  'pos.packaging',
  'pos.pointsApproxValue',
  'pos.subtotal',
  'pos.tagBestseller',
  'pos.tagCount',
  'pos.tagOrganic',
  'pos.tagVegan',
  'pos.taxLine',
  'pos.numericKeypad',
  'printTest.escpos',
  'printTest.kitchenStation', // English-identical station sample data
  'printTest.item',
  'printTest.paperWidth58',
  'printTest.paperWidth80',
  'printTest.optionWebPrint', // technical browser print mode label
  'print.taxInvoiceTitle',
  'print.customerShort',
  'print.address',
  'print.kot.banner',
  'print.test.title',
  'products.addonSelectionRange',
  'products.barcodeLabel',
  'products.cashbackGlobalBadge',
  'products.cashbackLabel',
  'products.colorAmber',
  'products.colorCyan',
  'products.colorEmerald',
  'products.colorFuchsia',
  'products.colorIndigo',
  'products.colorLime',
  'products.colorTeal',
  'products.columnCashback',
  'products.columnStock',
  'products.defaultCategoryTag',
  'products.fieldBarcode',
  'products.fieldSku',
  'products.imageCamera',
  'products.saleUnitCl',
  'products.saleUnitFlOz',
  'products.saleUnitG',
  'products.saleUnitKg',
  'products.saleUnitL',
  'products.saleUnitLb',
  'products.saleUnitMl',
  'products.saleUnitOz',
  'products.skuLabel',
  'products.tagBestseller',
  'products.tagOrganic',
  'products.tagVegan',
  'products.taxExclusive',
  'products.taxExclusiveShort',
  'products.taxExempt',
  'products.taxInclusive',
  'products.taxInclusiveShort',
  'receipt.billNumber',
  'receipt.economicCode',
  'receipt.item',
  'receipt.onlineOrder',
  'receipt.reprint',
  'receipt.serviceCharge',
  'serverApp.emailPlaceholder',
  'serverApp.orderSlipServiceCharge',
  'serverApp.orderSlipSubtotal',
  'serverApp.orderSlipTitle',
  'serverApp.title',
  'settings.aboutGithub',
  'settings.account',
  'settings.address',
  'settings.apiKey',
  'settings.apiKeyInputPlaceholder',
  'settings.appQrAlt',
  'settings.backupKindAuto',
  'settings.backupSchemaVersion',
  'settings.billTemplateCompactName',
  'settings.browserWebusb',
  'settings.connectionNetwork',
  'settings.connectionUsb',
  'settings.paymentMethodUpi', // technical acronym (payment rail name)
  'settings.cashDrawerPulseEnabledShort',
  'settings.currency',
  'settings.default',
  'settings.defaultPrinter',
  'settings.defaultPrinterTipTitle',
  'settings.email',
  'settings.googleDriveAccount',
  'settings.instagramHandle',
  'settings.invoiceNumberPrefix',
  'settings.invoiceNumberPreview',
  'settings.ipAddress',
  'settings.ipAddressPlaceholder',
  'settings.iranCalendarGregorian',
  'settings.iranCalendarLocale',
  'settings.iranCalendarPersian',
  'settings.iranCurrencyDisplayRial',
  'settings.iranCurrencyDisplayToman',
  'settings.iranNumberDigitsLatin',
  'settings.iranNumberDigitsLocale',
  'settings.kds',
  'settings.kdsQrAlt',
  'settings.languageFa',
  'settings.loyalty',
  'settings.loyaltyProgram',
  'settings.masterPin',
  'settings.mdnsAlwaysStable',
  'settings.mobileApp',
  'settings.navGroupAccount',
  'settings.orderNumberPrefix',
  'settings.orderNumberPreview',
  'settings.paperSize58',
  'settings.paperSize80',
  'settings.paperWidth58',
  'settings.paperWidth80',
  'settings.paperWidth80Safe',
  'settings.percentMaximum',
  'settings.plan',
  'settings.port',
  'settings.portPlaceholder',
  'settings.posQrAlt',
  'settings.printMethodEscpos',
  'settings.printerOffline',
  'settings.printerOnline',
  'settings.privacy',
  'settings.registrationLastError',
  'settings.revflo',
  'settings.serverApp',
  'settings.stationPrinter',
  'settings.storeId',
  'settings.tabData',
  'settings.tabMobileAccess',
  'settings.tabOrderflow',
  'settings.tabWhatsapp',
  'settings.taxIdLabel',
  'settings.timezone',
  'settings.unicode',
  'settings.updateStatusAvailable',
  'settings.updateStatusOffline',
  'settings.vpnMeshNetwork',
  'settings.whatsapp',
  'settings.themeSystem',
  'setup.cloudUrlLabel',
  'setup.demoLabel',
  'setup.expressLabel',
  'setup.finedineLabel',
  'setup.languagePersian',
  'setup.languagePortuguese',
  'setup.password',
  'setup.pinLabel',
  'setup.qsrDesc',
  'setup.qsrLabel',
  'setup.timezoneLabel',
  'staff.passwordPlaceholder',
  'staff.roleManager',
  'staff.roleServer',
  'permissionMatrix.managerDescription',
  'permissionMatrix.areas.staff',
  'permissionMatrix.areas.system',
  'support.email',
  'support.platform',
  'support.requestId',
  'support.restaurant',
  'tax.auditCreateOverride',
  'tax.auditSystem',
  'tax.auditUpdateOverride',
  'tax.entityServiceCharge',
  'tax.fixed',
  'tax.readOnly',
  'tax.target',
  'update.downloadingBadge',
  'update.betaOn',
  'update.betaOff',
  'whatsapp.blocklist.title',
  'whatsapp.connect.pairingMethodTitle',
  'whatsapp.connect.pairingPhonePlaceholder',
  'whatsapp.connect.qrMethodTitle',
  'whatsapp.sent.timeline',
  'whatsapp.tabs.inbox',
]);

function filFallbackErrors(filFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const filVal = filFlat[k];
    if (filVal === undefined) continue; // reported by key parity
    if (filVal.startsWith('[FIL]') || filVal.startsWith('[TODO]')) {
      errors.push(`fil.json ${k} — placeholder prefix found: "${filVal}"`);
    } else if (filVal === enFlat[k] && !FIL_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`fil.json ${k} — identical to English value (renders as English for Filipino users)`);
    }
  }
  return errors;
}

/**
 * German translation safeguards (PR #560).
 *
 * Like French and Turkish, de.json values must be fully translated with no leftover
 * [DE] scaffolds or English fallbacks, except for legitimate international shared technical
 * tokens or identical words.
 */
const DE_INTENTIONAL_IDENTICAL = new Set<string>([
  'dashboard.exportCsv', // format label "CSV (.csv)"
  'dashboard.exportXlsx', // format label "Excel (.xlsx)"
  'auth.countryThailand',
  'businessType.restaurant',
  'common.appTitle',
  'common.brandName',
  'common.logoAlt',
  'common.namePlaceholder',
  'dashboard.title',
  'inventory.supplyName', // same word in German
  'kds.connectionLive',
  'kds.emptyColumn',
  'kds.viewKanban',
  'nav.dashboard',
  'nav.kds',
  'nav.portLabel',
  'nav.support',
  'nav.whatsapp',
  'orders.online',
  'permissionMatrix.areas.support',
  'permissionMatrix.areas.system',
  'pos.addonPrice',
  'pos.loadingEllipsis',
  'pos.orderTypeOnline',
  'pos.tagBestseller',
  'pos.tagCount',
  'pos.tagVegan',
  'pos.taxLine',
  'print.hsn',
  'print.kot.station',
  'printTest.escpos',
  'products.addonSelectionRange',
  'products.barcodeLabel',
  'products.cashbackGlobalBadge',
  'products.colorCyan',
  'products.colorFuchsia',
  'products.colorIndigo',
  'products.colorOrange',
  'products.colorRose',
  'products.columnCashback',
  'products.columnStatus',
  'products.fieldBarcode',
  'products.nameLabel',
  'products.optional',
  'products.optionalTag',
  'products.saleUnitCl',
  'products.saleUnitFlOz',
  'products.saleUnitG',
  'products.saleUnitKg',
  'products.saleUnitL',
  'products.saleUnitLb',
  'products.saleUnitMl',
  'products.saleUnitOz',
  'products.skuLabel',
  'products.tagBestseller',
  'products.tagVegan',
  'serverApp.emailPlaceholder',
  'settings.apiKeyInputPlaceholder',
  'settings.connectionUsb',
  'settings.paymentMethodUpi', // technical acronym (payment rail name)
  'settings.errorDetails',
  'settings.ipAddressPlaceholder',
  'settings.iranCurrencyDisplayRial',
  'settings.iranCurrencyDisplayToman',
  'settings.kds',
  'settings.name',
  'settings.port',
  'settings.portPlaceholder',
  'settings.printerOffline',
  'settings.printerOnline',
  'settings.registrationLastError',
  'settings.revflo',
  'settings.status',
  'settings.tabWhatsapp',
  'settings.test',
  'settings.themeSystem',
  'settings.unicode',
  'settings.updateStatusOffline',
  'settings.updates',
  'settings.version',
  'settings.whatsapp',
  'setup.demoLabel',
  'setup.expressLabel',
  'setup.finedineLabel', // FloCafe product flow name
  'setup.pinLabel',
  'staff.roleManager',
  'support.menuLabel', // same loanword in German
  'support.version',
  'tax.auditCreateOverride',
  'tax.auditSystem',
  'tax.auditUpdateOverride',
  'update.downloadingBadge',
  'whatsapp.connect.pairingPhonePlaceholder',
  'whatsapp.sent.colStatus',
]);

function deFallbackErrors(deFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const deVal = deFlat[k];
    if (deVal === undefined) continue; // reported by key parity
    if (deVal.startsWith('[DE]') || deVal.startsWith('[TODO]')) {
      errors.push(`de.json ${k} — placeholder prefix found: "${deVal}"`);
    } else if (deVal === enFlat[k] && !DE_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`de.json ${k} — identical to English value (renders as English for German users)`);
    }
  }
  return errors;
}

/**
 * Italian translation safeguards (feat/italian-lang-support).
 *
 * it.json values must be fully translated with no leftover placeholders or English
 * fallbacks, except for legitimate international shared technical tokens, brand
 * names, pure format strings, and Italian words spelled the same as English.
 */
const IT_INTENTIONAL_IDENTICAL = new Set<string>([
  'dashboard.exportCsv', // format label "CSV (.csv)"
  'dashboard.exportXlsx', // format label "Excel (.xlsx)"
  'auth.countryIndia', // country name identical in Italian
  'auth.email', // Italian uses "Email"
  'auth.password', // Italian uses "Password"
  'common.appTitle', // brand
  'common.brandName', // brand
  'common.logoAlt', // brand
  'common.no', // Italian uses "No"
  'customer.email', // Italian uses "Email"
  'dashboard.ticketMethodCount', // pure format: {count} ×
  'dashboard.title', // common Italian software term
  'kds.connectionLive', // Italian uses "Live"
  'kds.connectionPolling', // technical: Polling 5s
  'kds.emptyColumn', // em dash
  'kds.viewKanban', // methodology name shared with English
  'nav.dashboard', // common Italian software term
  'nav.heapLabel', // technical label
  'nav.kds', // technical acronym
  'nav.pos', // technical acronym
  'nav.serverLabel', // Italian uses "Server"
  'nav.whatsapp', // brand
  'orders.online', // Italian uses "Online"
  'permissionMatrix.areas.menu', // Italian uses "Menu"
  'pos.addonPrice', // pure format: +{currency}{price}
  'pos.checkout', // common Italian POS term
  'pos.loadingEllipsis', // ellipsis
  'pos.orderTypeOnline', // Italian uses "Online"
  'pos.tagCount', // pure format: {tag} ×{count}
  'pos.taxLine', // pure format: {title} @{rate}%
  'print.hsn', // technical acronym
  'print.zReport.paymentCount', // pure format: x{count}
  'printTest.escpos', // technical acronym
  'products.addonSelectionRange', // pure format: {min} – {max}
  'products.colorLime', // color name shared with English
  'products.columnCashback', // Italian uses "Cashback"
  'products.fieldSku', // technical acronym
  'products.saleUnitCl', // unit symbol
  'products.saleUnitFlOz', // unit symbol
  'products.saleUnitG', // unit symbol
  'products.saleUnitKg', // unit symbol
  'products.saleUnitL', // unit symbol
  'products.saleUnitLb', // unit symbol
  'products.saleUnitMl', // unit symbol
  'products.saleUnitOz', // unit symbol
  'products.skuLabel', // technical acronym
  'products.taxInclusiveShort', // Italian abbreviation "Incl."
  'serverApp.emailPlaceholder', // example email
  'settings.account', // Italian uses "Account"
  'settings.apiKeyInputPlaceholder', // example API key
  'settings.backupKindAuto', // Italian uses "Auto"
  'settings.backupSchemaVersion', // pure format: schema v{version}
  'settings.connectionUsb', // technical acronym
  'settings.connectionWebusb', // technical: WebUSB (browser)
  'settings.email', // Italian uses "Email"
  'settings.googleDriveAccount', // Italian uses "Account"
  'settings.ipAddressPlaceholder', // example IP
  'settings.iranCalendarLocale', // option label: Auto (Shamsi)
  'settings.iranCurrencyDisplayRial', // currency display name
  'settings.iranCurrencyDisplayToman', // currency display name
  'settings.kds', // technical acronym
  'settings.languageEn', // native language name
  'settings.languageEs', // native language name
  'settings.languagePt', // native language name
  'settings.navGroupAccount', // Italian uses "Account"
  'settings.no', // Italian uses "No"
  'settings.paymentMethodUpi', // technical acronym (payment rail name)
  'settings.portPlaceholder', // example port
  'settings.printerOffline', // Italian uses "Offline"
  'settings.printerOnline', // Italian uses "Online"
  'settings.privacy', // Italian uses "Privacy"
  'settings.registrationLastError', // pure placeholder: {error}
  'settings.revflo', // brand
  'settings.tabOrderflow', // brand
  'settings.tabWhatsapp', // brand
  'settings.test', // Italian uses "Test"
  'settings.unicode', // technical name
  'settings.updateStatusOffline', // Italian uses "Offline"
  'settings.whatsapp', // brand
  'setup.demoLabel', // Italian uses "Demo"
  'setup.expressLabel', // Italian uses "Express"
  'setup.finedineLabel', // FloCafe product flow name
  'setup.password', // Italian uses "Password"
  'setup.pinLabel', // technical acronym
  'setup.qsrLabel', // industry acronym
  'staff.passwordPlaceholder', // Italian uses "Password"
  'support.email', // Italian uses "Email"
  'tables.floorplanAuto', // Italian uses "Auto"
  'tax.auditCreateOverride', // pure format: {entityType} {entityId} → {categoryId}
  'tax.auditUpdateOverride', // pure format: {entityType} {entityId}: {before} → {after}
  'update.downloadingBadge', // pure format: ↓ {percent}%
  'whatsapp.connect.pairingPhonePlaceholder', // pure format: {dialCode}XXXXXXXXXX
]);

function itFallbackErrors(itFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const itVal = itFlat[k];
    if (itVal === undefined) continue; // reported by key parity
    if (itVal.startsWith('[IT]') || itVal.startsWith('[TODO]')) {
      errors.push(`it.json ${k} — placeholder prefix found: "${itVal}"`);
    } else if (itVal === enFlat[k] && !IT_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`it.json ${k} — identical to English value (renders as English for Italian users)`);
    }
  }
  return errors;
}

/** Russian translation safeguards. */
const RU_INTENTIONAL_IDENTICAL = new Set<string>([
  'common.appTitle', 'common.brandName',
  'dashboard.exportCsv', 'dashboard.exportXlsx', 'dashboard.ticketMethodCount',
  'kds.emptyColumn', 'nav.kds', 'nav.pos', 'nav.whatsapp',
  'pos.addonPrice', 'pos.loadingEllipsis', 'pos.tagCount', 'pos.taxLine',
  'print.hsn', 'print.zReport.paymentCount', 'printTest.escpos',
  'products.addonSelectionRange', 'products.saleUnitCl',
  'serverApp.emailPlaceholder', 'settings.connectionUsb', 'settings.instagramPlaceholder', 'settings.ipAddressPlaceholder',
  'settings.kds', 'settings.portPlaceholder', 'settings.registrationEmailPlaceholder',
  'settings.registrationLastError', 'settings.tabWhatsapp', 'settings.whatsapp',
  'setup.finedineLabel', 'setup.ownerEmailPlaceholder', 'setup.qsrLabel',
  'tax.auditCreateOverride', 'tax.auditUpdateOverride', 'update.downloadingBadge',
  'whatsapp.connect.pairingPhonePlaceholder',
]);

function ruFallbackErrors(ruFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const ruVal = ruFlat[k];
    if (ruVal === undefined) continue;
    if (ruVal.startsWith('[RU]') || ruVal.startsWith('[TODO]')) {
      errors.push(`ru.json ${k} — placeholder prefix found: "${ruVal}"`);
    } else if (ruVal === enFlat[k] && !RU_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`ru.json ${k} — identical to English value (renders as English for Russian users)`);
    } else if (ruVal !== ruVal.normalize('NFC')) {
      errors.push(`ru.json ${k} — value must use Unicode NFC`);
    } else if (ruVal.includes('\uFFFD')) {
      errors.push(`ru.json ${k} — value contains a Unicode replacement character`);
    } else if (/[\u200B\u200C\u200D\u00AD\uFEFF]/u.test(ruVal)) {
      errors.push(`ru.json ${k} — invisible formatting character found`);
    }
  }
  return errors;
}

/** Urdu translation safeguards. */
const UR_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.emailPlaceholder', 'common.appTitle', 'common.brandName', 'common.logoAlt',
  'dashboard.exportXlsx', 'dashboard.exportCsv', 'dashboard.ticketMethodCount',
  'kds.emptyColumn', 'nav.kds', 'nav.pos', 'nav.whatsapp', 'pos.addonPrice',
  'pos.loadingEllipsis', 'pos.tagCount', 'pos.taxLine', 'print.hsn',
  'print.zReport.paymentCount', 'printTest.escpos', 'printTest.paperWidth58',
  'printTest.paperWidth80', 'products.addonSelectionRange', 'products.fieldSku',
  'products.saleUnitCl', 'products.saleUnitFlOz', 'products.saleUnitG', 'products.saleUnitKg',
  'products.saleUnitL', 'products.saleUnitLb', 'products.saleUnitMl', 'products.saleUnitOz',
  'products.skuLabel', 'serverApp.emailPlaceholder', 'serverApp.title',
  'settings.apiKeyInputPlaceholder', 'settings.backupSchemaVersion', 'settings.connectionUsb',
  'settings.instagramPlaceholder', 'settings.ipAddressPlaceholder', 'settings.kds',
  'settings.languageEn', 'settings.languageEs', 'settings.languagePt', 'settings.paperSize58',
  'settings.paperSize80', 'settings.paperWidth58', 'settings.paymentMethodUpi',
  'settings.portPlaceholder', 'settings.registrationEmailPlaceholder', 'settings.registrationLastError',
  'settings.revflo', 'settings.serverApp', 'settings.tabOrderflow', 'settings.tabWhatsapp',
  'settings.unicode', 'settings.whatsapp', 'setup.expressLabel', 'setup.finedineLabel',
  'setup.languageEnglish', 'setup.ownerEmailPlaceholder', 'setup.pinLabel', 'setup.qsrLabel',
  'tax.auditCreateOverride', 'tax.auditUpdateOverride', 'update.downloadingBadge',
  'whatsapp.connect.pairingPhonePlaceholder',
]);

function urFallbackErrors(urFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const urVal = urFlat[k];
    if (urVal === undefined) continue;
    if (urVal.startsWith('[UR]') || urVal.startsWith('[TODO]')) {
      errors.push(`ur.json ${k} — placeholder prefix found: "${urVal}"`);
    } else if (urVal === enFlat[k] && !UR_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`ur.json ${k} — identical to English value (renders as English for Urdu users)`);
    }
  }
  return errors;
}

/** Japanese translation safeguards. */
const JA_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.emailPlaceholder', 'common.appTitle', 'common.brandName', 'common.logoAlt',
  'dashboard.ticketMethodCount', 'kds.emptyColumn', 'nav.kds', 'nav.pos', 'nav.whatsapp',
  'pos.addonPrice', 'pos.loadingEllipsis', 'pos.tagCount', 'pos.taxLine', 'printTest.escpos',
  'printTest.paperWidth58', 'printTest.paperWidth80', 'print.hsn', 'print.zReport.paymentCount',
  'products.addonSelectionRange', 'products.fieldSku', 'products.saleUnitCl',
  'products.saleUnitFlOz', 'products.saleUnitG', 'products.saleUnitKg', 'products.saleUnitL',
  'products.saleUnitLb', 'products.saleUnitMl', 'products.saleUnitOz',
  'serverApp.emailPlaceholder', 'settings.apiKeyInputPlaceholder', 'settings.connectionUsb',
  'settings.paymentMethodUpi', 'settings.instagramPlaceholder', 'settings.ipAddressPlaceholder',
  'settings.kds', 'settings.portPlaceholder', 'settings.registrationEmailPlaceholder',
  'settings.registrationLastError', 'settings.revflo', 'settings.serverApp',
  'settings.tabOrderflow', 'settings.tabWhatsapp', 'settings.unicode', 'settings.whatsapp',
  'setup.finedineLabel', 'setup.ownerEmailPlaceholder', 'setup.qsrLabel',
  'tax.auditCreateOverride', 'tax.auditUpdateOverride', 'update.downloadingBadge',
  'whatsapp.connect.pairingPhonePlaceholder',
]);

function jaFallbackErrors(jaFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const jaVal = jaFlat[k];
    if (jaVal === undefined) continue;
    if (jaVal.startsWith('[JA]') || jaVal.startsWith('[TODO]')) {
      errors.push(`ja.json ${k} — placeholder prefix found: "${jaVal}"`);
    } else if (jaVal === enFlat[k] && !JA_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`ja.json ${k} — identical to English value (renders as English for Japanese users)`);
    }
  }
  return errors;
}

/** Chinese translation safeguards. */
const ZH_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.emailPlaceholder', 'common.appTitle', 'common.brandName', 'common.logoAlt',
  'dashboard.ticketMethodCount', 'kds.emptyColumn', 'nav.kds', 'nav.pos', 'nav.whatsapp',
  'pos.addonPrice', 'pos.loadingEllipsis', 'pos.tagCount', 'pos.taxLine', 'print.hsn',
  'print.zReport.paymentCount', 'printTest.escpos', 'printTest.paperWidth58',
  'printTest.paperWidth80', 'products.addonSelectionRange', 'products.fieldSku',
  'products.saleUnitCl', 'products.saleUnitFlOz', 'products.saleUnitG', 'products.saleUnitKg',
  'products.saleUnitL', 'products.saleUnitLb', 'products.saleUnitMl', 'products.saleUnitOz',
  'products.skuLabel', 'serverApp.emailPlaceholder', 'settings.apiKeyInputPlaceholder',
  'settings.connectionUsb', 'settings.instagramPlaceholder', 'settings.ipAddressPlaceholder',
  'settings.kds', 'settings.paperSize58', 'settings.paperSize80',
  'settings.paymentMethodUpi', 'settings.portPlaceholder', 'settings.registrationEmailPlaceholder',
  'settings.registrationLastError', 'settings.revflo', 'settings.tabOrderflow',
  'settings.tabWhatsapp', 'settings.unicode', 'settings.whatsapp', 'setup.finedineLabel',
  'setup.ownerEmailPlaceholder', 'setup.pinLabel', 'tax.auditCreateOverride',
  'tax.auditUpdateOverride', 'update.downloadingBadge', 'whatsapp.connect.pairingPhonePlaceholder',
]);

function zhFallbackErrors(zhFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const zhVal = zhFlat[k];
    if (zhVal === undefined) continue;
    if (zhVal.startsWith('[ZH]') || zhVal.startsWith('[TODO]')) {
      errors.push(`zh.json ${k} — placeholder prefix found: "${zhVal}"`);
    } else if (zhVal === enFlat[k] && !ZH_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`zh.json ${k} — identical to English value (renders as English for Chinese users)`);
    }
  }
  return errors;
}

function zhTwFallbackErrors(zhTwFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const zhTwVal = zhTwFlat[k];
    if (zhTwVal === undefined) continue;
    if (zhTwVal.startsWith('[ZH-TW]') || zhTwVal.startsWith('[TODO]')) {
      errors.push(`zh-tw.json ${k} — placeholder prefix found: "${zhTwVal}"`);
    } else if (zhTwVal === enFlat[k] && !ZH_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`zh-tw.json ${k} — identical to English value (renders as English for Taiwan users)`);
    }
  }
  return errors;
}

/** Korean translation safeguards. */
const KO_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.emailPlaceholder', 'common.appTitle', 'common.brandName', 'common.logoAlt',
  'dashboard.exportCsv', 'dashboard.exportXlsx', 'dashboard.ticketMethodCount',
  'kds.emptyColumn', 'nav.kds', 'nav.pos', 'nav.whatsapp', 'pos.addonPrice',
  'pos.loadingEllipsis', 'pos.tagCount', 'pos.taxLine', 'print.hsn',
  'print.zReport.paymentCount', 'printTest.escpos', 'printTest.paperWidth58',
  'printTest.paperWidth80', 'products.addonSelectionRange', 'products.fieldSku',
  'products.saleUnitCl', 'products.saleUnitFlOz', 'products.saleUnitG', 'products.saleUnitKg',
  'products.saleUnitL', 'products.saleUnitLb', 'products.saleUnitMl', 'products.saleUnitOz',
  'products.skuLabel', 'serverApp.emailPlaceholder', 'settings.apiKeyInputPlaceholder',
  'settings.connectionUsb', 'settings.instagramPlaceholder', 'settings.ipAddressPlaceholder',
  'settings.kds', 'settings.paperSize58', 'settings.paperSize80',
  'settings.paymentMethodUpi', 'settings.portPlaceholder', 'settings.registrationEmailPlaceholder',
  'settings.registrationLastError', 'settings.revflo', 'settings.tabOrderflow',
  'settings.tabWhatsapp', 'settings.unicode', 'settings.whatsapp', 'setup.finedineLabel',
  'setup.ownerEmailPlaceholder', 'setup.pinLabel', 'setup.qsrLabel',
  'tax.auditCreateOverride', 'tax.auditUpdateOverride', 'update.downloadingBadge',
  'whatsapp.connect.pairingPhonePlaceholder',
]);

function koFallbackErrors(koFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const koVal = koFlat[k];
    if (koVal === undefined) continue;
    if (koVal.startsWith('[KO]') || koVal.startsWith('[TODO]')) {
      errors.push(`ko.json ${k} — placeholder prefix found: "${koVal}"`);
    } else if (koVal === enFlat[k] && !KO_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`ko.json ${k} — identical to English value (renders as English for Korean users)`);
    }
  }
  return errors;
}

/** Indonesian translation safeguards. */
const ID_INTENTIONAL_IDENTICAL = new Set<string>([
  'common.appTitle', 'common.brandName', 'common.logoAlt', 'settings.revflo', 'setup.finedineLabel',
  'auth.email', 'auth.recoverPinLabel', 'kds.connectionPolling', 'kds.emptyColumn', 'kds.viewKanban',
  'nav.kds', 'nav.pos', 'nav.whatsapp', 'nav.heapLabel', 'nav.portLabel', 'nav.serverLabel',
  'pos.orderTypeOnline', 'printTest.escpos', 'printTest.item', 'printTest.paperWidth58',
  'printTest.paperWidth80', 'print.hsn', 'print.zReport.paymentCount', 'print.zReport.amount',
  'products.barcodeLabel', 'products.fieldBarcode', 'products.fieldSku', 'products.skuLabel',
  'settings.apiKeyInputPlaceholder', 'settings.connectionUsb', 'settings.paymentMethodUpi',
  'settings.ipAddressPlaceholder', 'settings.kds', 'settings.paperSize58', 'settings.paperSize80',
  'settings.port', 'settings.portPlaceholder', 'settings.stationPrinter', 'settings.status',
  'settings.tabData', 'settings.tabDataCloud', 'settings.tabWhatsapp', 'settings.unicode',
  'settings.whatsapp', 'setup.pinLabel', 'support.platform', 'whatsapp.connect.pairingPhonePlaceholder',
  'auth.countryIndia', 'auth.countryThailand', 'common.subtotal', 'common.total', 'customer.email',
  'dashboard.exportCsv', 'dashboard.exportXlsx', 'dashboard.ticketMethodCount', 'pos.addonPrice', 'pos.loadingEllipsis', 'pos.subtotal', 'pos.tagCount',
  'pos.tagVegan', 'pos.taxLine', 'pos.total', 'print.grandTotal', 'products.addonSelectionRange',
  'products.cashbackGlobalBadge', 'products.colorAmber', 'products.columnCashback', 'products.columnStatus',
  'products.saleUnitCl', 'products.saleUnitFlOz', 'products.saleUnitG', 'products.saleUnitKg', 'products.saleUnitL', 'products.saleUnitLb', 'products.saleUnitMl', 'products.saleUnitOz', 'products.tagVegan',
  'serverApp.emailPlaceholder', 'serverApp.orderSlipSubtotal', 'serverApp.orderSlipTotal', 'settings.email',
  'settings.iranCurrencyDisplayRial', 'settings.iranCurrencyDisplayToman', 'settings.iranNumberDigitsLatin',
  'setup.demoLabel', 'setup.expressLabel', 'setup.qsrLabel', 'permissionMatrix.areas.menu', 'support.email',
  'tax.auditCreateOverride', 'tax.auditUpdateOverride', 'tax.target', 'update.downloadingBadge',
  'whatsapp.sent.colStatus', 'receipt.item',
]);

function idFallbackErrors(idFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const idVal = idFlat[k];
    if (idVal === undefined) continue;
    if (idVal.startsWith('[ID]') || idVal.startsWith('[TODO]')) {
      errors.push(`id.json ${k} — placeholder prefix found: "${idVal}"`);
    } else if (idVal === enFlat[k] && !ID_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`id.json ${k} — identical to English value (renders as English for Indonesian users)`);
    }
  }
  return errors;
}

/** Dutch translation safeguards. */
const NL_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.countryThailand', 'auth.emailPlaceholder', 'businessType.restaurant',
  'common.appTitle', 'common.brandName', 'common.logoAlt', 'common.percentage',
  'common.timeHoursMinutes', 'common.timeMinutes', 'dashboard.minutesValue', 'dashboard.title',
  'dashboard.exportXlsx', 'dashboard.exportCsv', 'dashboard.ticketMethodCount',
  'inventory.product', 'kds.addonsLabel', 'kds.connectionLive', 'kds.emptyColumn', 'kds.viewKanban',
  'nav.dashboard', 'nav.kds', 'nav.pos', 'nav.whatsapp', 'orders.online', 'pos.addonPrice',
  'pos.loadingEllipsis', 'pos.orderTypeOnline', 'pos.percentage', 'pos.tagBestseller', 'pos.tagCount',
  'pos.taxLine', 'printTest.downloadBin', 'printTest.escpos', 'print.kot.type', 'print.hsn',
  'print.zReport.paymentCount', 'products.addonSelectionRange', 'products.colorAmber',
  'products.colorFuchsia', 'products.colorIndigo', 'products.colorViolet', 'products.columnProduct',
  'products.columnStatus', 'products.fieldSku', 'products.imageCamera', 'products.saleUnitCl',
  'products.saleUnitFlOz', 'products.saleUnitG', 'products.saleUnitKg', 'products.saleUnitL',
  'products.saleUnitLb', 'products.saleUnitMl', 'products.saleUnitOz', 'products.skuLabel',
  'products.tagBestseller', 'products.taxExclusiveShort', 'products.taxInclusiveShort',
  'serverApp.emailPlaceholder', 'settings.account', 'settings.googleDriveAccount', 'settings.navGroupAccount', 'settings.appQrAlt', 'settings.backupKindAuto',
  'settings.backupSchemaVersion', 'settings.billTemplateCompactName', 'settings.browserWebusb',
  'settings.connectionUsb', 'settings.connectionWebusb', 'settings.paymentMethodUpi',
  'settings.defaultPrinterTipTitle', 'settings.ipAddressPlaceholder', 'settings.iranCalendarLocale',
  'settings.iranCurrencyDisplayRial', 'settings.iranCurrencyDisplayToman', 'settings.kds',
  'settings.languageEs', 'settings.plan', 'settings.portPlaceholder', 'settings.posQrAlt',
  'settings.printerOffline', 'settings.printerOnline', 'settings.printers', 'settings.privacy',
  'settings.registrationEmailPlaceholder', 'settings.registrationLastError', 'settings.revflo',
  'settings.stationPrinter', 'settings.status', 'settings.tabOrderflow', 'settings.tabPrinters',
  'settings.tabWhatsapp', 'settings.test', 'settings.unicode', 'settings.updateStatusOffline',
  'settings.errorDetails', 'settings.updates', 'settings.whatsapp', 'setup.demoLabel',
  'setup.ownerEmailPlaceholder', 'setup.pinLabel', 'setup.qsrLabel', 'staff.roleManager',
  'staff.roleServer', 'permissionMatrix.areas.menu', 'support.platform', 'support.restaurant',
  'tables.floorplanAuto', 'tax.auditCreateOverride', 'tax.auditUpdateOverride', 'tax.entityAddon',
  'tax.entityProduct', 'tax.type', 'update.downloadingBadge', 'whatsapp.inbox.title',
  'whatsapp.sent.colStatus', 'whatsapp.tabs.inbox',
]);

function nlFallbackErrors(nlFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const nlVal = nlFlat[k];
    if (nlVal === undefined) continue;
    if (nlVal.startsWith('[NL]') || nlVal.startsWith('[TODO]')) {
      errors.push(`nl.json ${k} — placeholder prefix found: "${nlVal}"`);
    } else if (nlVal === enFlat[k] && !NL_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`nl.json ${k} — identical to English value (renders as English for Dutch users)`);
    }
  }
  return errors;
}

/** Hindi translation safeguards. */
const HI_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.emailPlaceholder', 'common.appTitle', 'common.brandName', 'common.logoAlt',
  'dashboard.exportCsv', 'dashboard.exportXlsx', 'dashboard.ticketMethodCount', 'kds.emptyColumn',
  'nav.kds', 'nav.pos', 'nav.whatsapp', 'pos.addonPrice', 'pos.loadingEllipsis', 'pos.tagCount',
  'pos.taxLine', 'printTest.escpos', 'printTest.paperWidth58', 'printTest.paperWidth80',
  'print.hsn', 'print.zReport.paymentCount', 'products.addonSelectionRange', 'products.fieldSku',
  'products.skuLabel', 'serverApp.emailPlaceholder', 'settings.apiKeyInputPlaceholder',
  'settings.backupSchemaVersion', 'settings.connectionUsb', 'settings.connectionWebusb',
  'settings.instagramPlaceholder', 'settings.ipAddressPlaceholder', 'settings.kds',
  'settings.languageEn', 'settings.languageEs', 'settings.languagePt', 'settings.paperSize58',
  'settings.paperSize80', 'settings.paperWidth58', 'settings.paperWidth80', 'settings.paperWidth80Safe',
  'settings.paymentMethodUpi', 'settings.portPlaceholder', 'settings.registrationEmailPlaceholder',
  'settings.registrationLastError', 'settings.revflo', 'settings.tabOrderflow', 'settings.tabWhatsapp',
  'settings.whatsapp', 'setup.ownerEmailPlaceholder', 'setup.qsrLabel', 'tax.auditCreateOverride',
  'tax.auditUpdateOverride', 'update.downloadingBadge', 'whatsapp.connect.pairingPhonePlaceholder',
]);

function hiFallbackErrors(hiFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const hiVal = hiFlat[k];
    if (hiVal === undefined) continue;
    if (hiVal.startsWith('[HI]') || hiVal.startsWith('[TODO]')) {
      errors.push(`hi.json ${k} — placeholder prefix found: "${hiVal}"`);
    } else if (hiVal === enFlat[k] && !HI_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`hi.json ${k} — identical to English value (renders as English for Hindi users)`);
    }
  }
  return errors;
}

/** Bengali translation safeguards. */
const BN_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.emailPlaceholder', 'dashboard.exportCsv', 'nav.pos', 'pos.addonPrice', 'pos.loadingEllipsis',
  'printTest.escpos', 'print.hsn', 'print.zReport.paymentCount', 'products.saleUnitCl',
  'products.saleUnitFlOz', 'products.saleUnitG', 'products.saleUnitL', 'products.saleUnitOz',
  'serverApp.emailPlaceholder', 'settings.apiKeyInputPlaceholder', 'settings.ipAddressPlaceholder',
  'settings.languageEs', 'settings.portPlaceholder', 'settings.registrationEmailPlaceholder',
  'settings.registrationLastError', 'setup.ownerEmailPlaceholder', 'setup.qsrLabel',
  'tax.auditCreateOverride', 'tax.auditUpdateOverride', 'whatsapp.connect.pairingPhonePlaceholder',
]);

function bnFallbackErrors(bnFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const bnVal = bnFlat[k];
    if (bnVal === undefined) continue;
    if (bnVal.startsWith('[BN]') || bnVal.startsWith('[TODO]')) {
      errors.push(`bn.json ${k} — placeholder prefix found: "${bnVal}"`);
    } else if (bnVal === enFlat[k] && !BN_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`bn.json ${k} — identical to English value (renders as English for Bengali users)`);
    }
  }
  return errors;
}

/** Albanian translation safeguards. */
const SQ_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.countryIndia', 'auth.email', 'auth.emailPlaceholder', 'common.appTitle', 'common.brandName', 'common.logoAlt',
  'customer.email', 'dashboard.exportCsv', 'dashboard.exportXlsx', 'dashboard.ticketMethodCount',
  'kds.viewKanban', 'nav.kds', 'nav.pos', 'nav.whatsapp', 'orders.online',
  'pos.addonPrice', 'pos.loadingEllipsis', 'pos.methodCash', 'pos.orderTypeOnline', 'pos.tagVegan', 'pos.taxLine',
  'printTest.escpos', 'print.hsn', 'print.zReport.paymentCount',
  'products.colorIndigo', 'products.fieldSku', 'products.saleUnitCl', 'products.saleUnitFlOz', 'products.saleUnitG',
  'products.saleUnitKg', 'products.saleUnitL', 'products.saleUnitMl', 'products.saleUnitOz', 'products.skuLabel', 'products.tagVegan',
  'serverApp.emailPlaceholder', 'serverApp.title', 'settings.apiKeyInputPlaceholder', 'settings.connectionUsb',
  'settings.email', 'settings.instagramPlaceholder', 'settings.ipAddressPlaceholder',
  'settings.iranCalendarGregorian', 'settings.iranCalendarLocale', 'settings.iranCurrencyDisplayRial', 'settings.iranCurrencyDisplayToman', 'settings.kds',
  'settings.languageEs', 'settings.portPlaceholder', 'settings.registrationEmailPlaceholder',
  'settings.registrationLastError', 'settings.revflo', 'settings.serverApp', 'settings.tabOrderflow', 'settings.tabWhatsapp',
  'settings.unicode', 'settings.whatsapp', 'setup.demoLabel', 'setup.expressLabel', 'setup.finedineLabel',
  'setup.ownerEmailPlaceholder', 'setup.pinLabel', 'setup.qsrLabel', 'settings.paymentMethodUpi',
  'support.email', 'tax.auditCreateOverride', 'tax.auditUpdateOverride', 'update.downloadingBadge',
]);

function sqFallbackErrors(sqFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const sqVal = sqFlat[k];
    if (sqVal === undefined) continue;
    if (sqVal.startsWith('[SQ]') || sqVal.startsWith('[TODO]')) {
      errors.push(`sq.json ${k} — placeholder prefix found: "${sqVal}"`);
    } else if (sqVal === enFlat[k] && !SQ_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`sq.json ${k} — identical to English value (renders as English for Albanian users)`);
    }
  }
  return errors;
}

/** Vietnamese translation safeguards, including canonical NFC text. */
const VI_INTENTIONAL_IDENTICAL = new Set<string>([
  'auth.email',
  'auth.emailPlaceholder',
  'common.appTitle',
  'common.brandName',
  'common.logoAlt',
  'customer.email',
  'dashboard.exportCsv',
  'dashboard.exportXlsx',
  'dashboard.ticketMethodCount',
  'kds.emptyColumn',
  'kds.viewKanban',
  'nav.kds',
  'nav.pos',
  'nav.whatsapp',
  'pos.addonPrice',
  'pos.loadingEllipsis',
  'pos.tagCount',
  'pos.taxLine',
  'printTest.escpos',
  'printTest.paperWidth58',
  'printTest.paperWidth80',
  'print.hsn',
  'print.zReport.paymentCount',
  'products.addonSelectionRange',
  'products.fieldSku',
  'products.saleUnitCl',
  'products.saleUnitFlOz',
  'products.saleUnitG',
  'products.saleUnitKg',
  'products.saleUnitL',
  'products.saleUnitLb',
  'products.saleUnitMl',
  'products.saleUnitOz',
  'products.skuLabel',
  'serverApp.emailPlaceholder',
  'serverApp.title',
  'settings.apiKeyInputPlaceholder',
  'settings.connectionUsb',
  'settings.email',
  'settings.instagramPlaceholder',
  'settings.ipAddressPlaceholder',
  'settings.iranCurrencyDisplayRial',
  'settings.iranCurrencyDisplayToman',
  'settings.iranNumberDigitsLatin',
  'settings.kds',
  'settings.languageEn',
  'settings.languageEs',
  'settings.languagePt',
  'settings.paperSize58',
  'settings.paperSize80',
  'settings.paymentMethodUpi',
  'settings.portPlaceholder',
  'settings.registrationEmailPlaceholder',
  'settings.registrationLastError',
  'settings.revflo',
  'settings.serverApp',
  'settings.tabOrderflow',
  'settings.tabWhatsapp',
  'settings.unicode',
  'settings.whatsapp',
  'setup.demoLabel',
  'setup.expressLabel',
  'setup.finedineLabel',
  'setup.ownerEmailPlaceholder',
  'setup.pinLabel',
  'setup.qsrLabel',
  'support.email',
  'tax.auditCreateOverride',
  'tax.auditUpdateOverride',
  'update.downloadingBadge',
  'whatsapp.connect.pairingPhonePlaceholder',
]);

function viFallbackErrors(viFlat: Record<string, string>, enFlat: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const viVal = viFlat[k];
    if (viVal === undefined) continue;
    if (viVal.startsWith('[VI]') || viVal.startsWith('[TODO]')) {
      errors.push(`vi.json ${k} — placeholder prefix found: "${viVal}"`);
    } else if (viVal === enFlat[k] && !VI_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`vi.json ${k} — identical to English value (renders as English for Vietnamese users)`);
    } else if (viVal !== viVal.normalize('NFC')) {
      errors.push(`vi.json ${k} — value must use Unicode NFC`);
    } else if (viVal.includes('\uFFFD')) {
      errors.push(`vi.json ${k} — value contains a Unicode replacement character`);
    }
  }
  return errors;
}

/* ------------------------------------------------------------ *
 * Frontend source scans (TypeScript key safety, Issue #382 §6). *
 * ------------------------------------------------------------ */


/**
 * Find unsafe template-literal translation calls: `t(\`prefix.${var}\`)`
 * without an exhaustively typed `as 'key1' | 'key2'` cast. Dynamic keys must
 * be pinned to a closed set of valid message keys so a typo or an
 * unexpected runtime value cannot render a raw key string in the UI.
 */
function collectUnsafeDynamicKeys(dir: string = FRONTEND_SRC): Array<{ file: string; line: number; code: string }> {
  const hits: Array<{ file: string; line: number; code: string }> = [];
  for (const file of walkTypeScriptFiles(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      // `t(` immediately followed by a backtick template containing `${`
      // and NOT followed (after the closing backtick) by ` as `.
      const re = /(?:^|[^\w$.])t\(\s*`([^`]*\$\{[^}]*\}[^`]*)`(?!\s*as\s+)/;
      if (re.test(line)) {
        hits.push({ file: path.relative(ROOT, file), line: idx + 1, code: line.trim() });
      }
    });
  }
  return hits;
}

/** Prevent new frontend consumers from depending on the bridge removed by #381. */
function legacyImportErrors(dir: string = FRONTEND_SRC): string[] {
  const errors: string[] = [];
  const allowed = new Set([
    path.normalize(path.join(dir, 'lib/i18n.ts')),
  ]);
  for (const file of walkTypeScriptFiles(dir)) {
    if (allowed.has(path.normalize(file))) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/\buseI18n\b/.test(source)) {
      errors.push(`${path.relative(ROOT, file)} uses the legacy useI18n bridge`);
    }
    if (/\bformatIcuPlural\b/.test(source)) {
      errors.push(`${path.relative(ROOT, file)} uses the legacy formatIcuPlural helper`);
    }
    if (/import\s*\{[\s\S]*?\b(?:t|translate)\b[\s\S]*?\}\s*from\s*['"]@\/lib\/i18n['"]/.test(source)) {
      errors.push(`${path.relative(ROOT, file)} imports the legacy t() bridge`);
    }
  }
  return errors;
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

  if (dups.size) {
    console.error(`\nDuplicate keys detected in translation files:`);
    for (const [lang, dupList] of dups.entries()) {
      for (const d of dupList) console.error(`  - [${lang}] duplicate key: "${d}"`);
    }
    assert(false, 'duplicate keys found in translation JSON');
  }
  console.log('  ✓ no duplicate keys within translation files');

  const enKeys = sets.get('en');
  if (!enKeys) throw new Error('languages registry must include the canonical en locale');

  // 2. Exact nested leaf key parity — en.json is canonical (zero missing,
  // zero orphan extras) across all registered locales.
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

  // 7c. No active frontend component may add a dependency on the bridge
  // scheduled for deletion in #381.
  const legacyErrors = legacyImportErrors();
  if (legacyErrors.length) {
    for (const e of legacyErrors) console.error(`  - ${e}`);
    assert(false, 'legacy i18n bridge imports found in active frontend source');
  }
  console.log('  ✓ no active frontend consumers import the legacy i18n bridge');

  // 7d. The use-intl AppConfig augmentation is wired (compile-time key checks).
  const dtsErrors = messagesDtsErrors();
  if (dtsErrors.length) {
    for (const e of dtsErrors) console.error(`  - ${e}`);
    assert(false, 'use-intl AppConfig augmentation broken');
  }
  console.log('  ✓ messages.d.ts AppConfig augmentation present (compile-time key checks active)');

  // 8. fa.json values must not silently fall back to the English value.
  const faMessages = loadedStrings.get('fa');
  if (!faMessages) throw new Error('languages registry must include the maintained fa locale');
  const faErrors = faFallbackErrors(faMessages, loadedStrings.get('en')!);
  if (faErrors.length) {
    console.error(`\nfa.json values identical to English (${faErrors.length}) — these render as English for Persian users:`);
    for (const e of faErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'fa.json contains untranslated (English-identical) values');
  }
  console.log(`  ✓ no untranslated fa.json values (${FA_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 9. fr.json values must not silently fall back to the English value.
  const frMessages = loadedStrings.get('fr');
  if (!frMessages) throw new Error('languages registry must include the maintained fr locale');
  const frErrors = frFallbackErrors(frMessages, loadedStrings.get('en')!);
  if (frErrors.length) {
    console.error(`\nfr.json values identical to English (${frErrors.length}) — these render as English for French users:`);
    for (const e of frErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'fr.json contains untranslated (English-identical) values');
  }
  console.log(`  ✓ no untranslated fr.json values (${FR_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 10. tr.json values must not contain placeholders or fall back to English.
  const trMessages = loadedStrings.get('tr');
  if (!trMessages) throw new Error('languages registry must include the maintained tr locale');
  const trErrors = trFallbackErrors(trMessages, loadedStrings.get('en')!);
  if (trErrors.length) {
    console.error(`\ntr.json values with errors (${trErrors.length}):`);
    for (const e of trErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'tr.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated tr.json values (${TR_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 11. fil.json values must not contain placeholders or fall back to English.
  const filMessages = loadedStrings.get('fil');
  if (!filMessages) throw new Error('languages registry must include the maintained fil locale');
  const filErrors = filFallbackErrors(filMessages, loadedStrings.get('en')!);
  if (filErrors.length) {
    console.error(`\nfil.json values with errors (${filErrors.length}):`);
    for (const e of filErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'fil.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated fil.json values (${FIL_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 12. de.json values must not contain placeholders or fall back to English.
  const deMessages = loadedStrings.get('de');
  if (!deMessages) throw new Error('languages registry must include the maintained de locale');
  const deErrors = deFallbackErrors(deMessages, loadedStrings.get('en')!);
  if (deErrors.length) {
    console.error(`\nde.json values with errors (${deErrors.length}):`);
    for (const e of deErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'de.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated de.json values (${DE_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 13. it.json values must not contain placeholders or fall back to English.
  const itMessages = loadedStrings.get('it');
  if (!itMessages) throw new Error('languages registry must include the maintained it locale');
  const itErrors = itFallbackErrors(itMessages, loadedStrings.get('en')!);
  if (itErrors.length) {
    console.error(`\nit.json values with errors (${itErrors.length}):`);
    for (const e of itErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'it.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated it.json values (${IT_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  const ruMessages = loadedStrings.get('ru');
  if (!ruMessages) throw new Error('languages registry must include the maintained ru locale');
  const ruErrors = ruFallbackErrors(ruMessages, loadedStrings.get('en')!);
  if (ruErrors.length) {
    console.error(`\nru.json values with errors (${ruErrors.length}):`);
    for (const e of ruErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'ru.json contains untranslated, placeholder, malformed, or invisible Unicode values');
  }
  assert(ruMessages['receipt.cashReceived'] === 'Получено наличными', 'Russian cash-received label must use the canonical receipt key');
  assert(ruMessages['auth.attemptsRemaining'] === 'До блокировки осталось попыток: {count}', 'Russian attempt counter must use count-safe label wording');
  assert(ruMessages['pos.tableSeats'] === 'Мест: {count}', 'Russian seat counter must use count-safe label wording');
  assert(ruMessages['settings.printColumnsShort'] === 'Столбцов: {cols}', 'Russian print-column counter must use count-safe label wording');
  assert(ruMessages['pos.tagVeg'] === 'Вегетарианское' && ruMessages['products.tagVeg'] === 'Вегетарианское', 'Russian vegetarian tags must use the reviewed term');
  assert(ruMessages['pos.tagNonVeg'] === 'Не вегетарианское' && ruMessages['products.tagNonVeg'] === 'Не вегетарианское', 'Russian non-vegetarian tags must use the reviewed term');
  assert(ruMessages['settings.discountModeFlat'] === 'Только фиксированная сумма', 'Russian flat discount mode must mean a fixed amount');
  assert(ruMessages['tables.markCleaning'] === 'Отметить как убираемый', 'Russian table-cleaning action must describe setting a cleaning status');
  assert(ruMessages['tax.fixed'] === 'Фиксированная', 'Russian fixed tax label must describe a fixed amount');
  assert(ruMessages['tax.actionRollback'] === 'Пакет откатан', 'Russian tax-pack rollback must describe an operator action');
  for (const [key, technicalLiteral] of [
    ['products.csvAddonsHelp', 'group_name'],
    ['products.csvAddonsHelp', 'addon_name'],
    ['products.csvAddonsHelp', 'price'],
    ['products.csvAddonsHelp', 'group_required'],
    ['products.csvAddonsHelp', 'group_min_select'],
    ['products.csvAddonsHelp', 'group_max_select'],
    ['products.csvCategoriesHelp', 'name'],
    ['products.csvCategoriesHelp', 'description'],
    ['products.csvCategoriesHelp', 'color'],
    ['products.csvCategoriesHelp', 'icon'],
    ['products.csvCategoriesHelp', 'sort_order'],
    ['products.csvProductsHelp', 'id'],
    ['products.csvProductsHelp', 'sku'],
    ['products.csvProductsHelp', 'name'],
    ['products.csvProductsHelp', 'category'],
    ['products.csvProductsHelp', 'price'],
    ['products.csvProductsHelp', 'description'],
    ['products.csvProductsHelp', 'cost'],
    ['products.csvProductsHelp', 'tax_category'],
    ['products.csvProductsHelp', 'tax_behavior'],
    ['products.csvProductsHelp', 'cashback_percent'],
    ['products.csvProductsHelp', 'tags'],
    ['products.csvProductsHelp', 'non_veg'],
    ['products.csvProductsHelp', 'is_active'],
  ] as const) {
    assert(ruMessages[key]?.includes(technicalLiteral), `ru.json ${key} must preserve the machine-readable CSV field ${technicalLiteral}`);
  }
  console.log('  ✓ Russian CSV guidance preserves machine-readable field names');
  console.log(`  ✓ no untranslated ru.json values (${RU_INTENTIONAL_IDENTICAL.size} intentional shared values; NFC verified)`);

  const urMessages = loadedStrings.get('ur');
  if (!urMessages) throw new Error('languages registry must include the maintained ur locale');
  const urErrors = urFallbackErrors(urMessages, loadedStrings.get('en')!);
  if (urErrors.length) {
    console.error(`\nur.json values with errors (${urErrors.length}) — these render as English for Urdu users:`);
    for (const e of urErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'ur.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated ur.json values (${UR_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 14. Japanese and Chinese values must not contain placeholders or fall back to English.
  const jaMessages = loadedStrings.get('ja');
  if (!jaMessages) throw new Error('languages registry must include the maintained ja locale');
  const jaErrors = jaFallbackErrors(jaMessages, loadedStrings.get('en')!);
  if (jaErrors.length) {
    console.error(`\nja.json values with errors (${jaErrors.length}):`);
    for (const e of jaErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'ja.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated ja.json values (${JA_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  const zhMessages = loadedStrings.get('zh');
  if (!zhMessages) throw new Error('languages registry must include the maintained zh locale');
  const zhErrors = zhFallbackErrors(zhMessages, loadedStrings.get('en')!);
  if (zhErrors.length) {
    console.error(`\nzh.json values with errors (${zhErrors.length}):`);
    for (const e of zhErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'zh.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated zh.json values (${ZH_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  const zhTwMessages = loadedStrings.get('zh-tw');
  if (!zhTwMessages) throw new Error('languages registry must include the maintained zh-tw locale');
  const zhTwErrors = zhTwFallbackErrors(zhTwMessages, loadedStrings.get('en')!);
  if (zhTwErrors.length) {
    console.error(`\nzh-tw.json values with errors (${zhTwErrors.length}):`);
    for (const e of zhTwErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'zh-tw.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated zh-tw.json values (${ZH_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 15. Korean values must not contain placeholders or fall back to English.
  const koMessages = loadedStrings.get('ko');
  if (!koMessages) throw new Error('languages registry must include the maintained ko locale');
  const koErrors = koFallbackErrors(koMessages, loadedStrings.get('en')!);
  if (koErrors.length) {
    console.error(`\nko.json values with errors (${koErrors.length}):`);
    for (const e of koErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'ko.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated ko.json values (${KO_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 16. id.json values must not contain placeholders or fall back to English.
  const idMessages = loadedStrings.get('id');
  if (!idMessages) throw new Error('languages registry must include the maintained id locale');
  const idErrors = idFallbackErrors(idMessages, loadedStrings.get('en')!);
  if (idErrors.length) {
    console.error(`\nid.json values with errors (${idErrors.length}):`);
    for (const e of idErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'id.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated id.json values (${ID_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 17. nl.json values must not contain placeholders or fall back to English.
  const nlMessages = loadedStrings.get('nl');
  if (!nlMessages) throw new Error('languages registry must include the maintained nl locale');
  const nlErrors = nlFallbackErrors(nlMessages, loadedStrings.get('en')!);
  if (nlErrors.length) {
    console.error(`\nnl.json values with errors (${nlErrors.length}):`);
    for (const e of nlErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'nl.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated nl.json values (${NL_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 18. hi.json values must not contain placeholders or fall back to English.
  const hiMessages = loadedStrings.get('hi');
  if (!hiMessages) throw new Error('languages registry must include the maintained hi locale');
  const hiErrors = hiFallbackErrors(hiMessages, loadedStrings.get('en')!);
  if (hiErrors.length) {
    console.error(`\nhi.json values with errors (${hiErrors.length}):`);
    for (const e of hiErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'hi.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated hi.json values (${HI_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 19. bn.json values must not contain placeholders or fall back to English.
  const bnMessages = loadedStrings.get('bn');
  if (!bnMessages) throw new Error('languages registry must include the maintained bn locale');
  const bnErrors = bnFallbackErrors(bnMessages, loadedStrings.get('en')!);
  if (bnErrors.length) {
    console.error(`\nbn.json values with errors (${bnErrors.length}):`);
    for (const e of bnErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'bn.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated bn.json values (${BN_INTENTIONAL_IDENTICAL.size} intentional shared values)`);

  // 20. sq.json values must not contain placeholders or fall back to English.
  const sqMessages = loadedStrings.get('sq');
  if (!sqMessages) throw new Error('languages registry must include the maintained sq locale');
  const sqErrors = sqFallbackErrors(sqMessages, loadedStrings.get('en')!);
  if (sqErrors.length) {
    console.error(`\nsq.json values with errors (${sqErrors.length}):`);
    for (const e of sqErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'sq.json contains untranslated (English-identical) or placeholder values');
  }
  console.log(`  ✓ no untranslated sq.json values (${SQ_INTENTIONAL_IDENTICAL.size} intentional shared values)`);
  for (const [key, technicalLiteral] of [
    ['products.csvCategoriesHelp', 'sort_order'],
    ['products.csvProductsHelp', 'tax_category'],
    ['products.csvProductsHelp', 'tax_behavior'],
    ['products.csvProductsHelp', 'cashback_percent'],
    ['products.csvProductsHelp', 'is_active'],
  ] as const) {
    assert(sqMessages[key]?.includes(technicalLiteral), `sq.json ${key} must preserve the CSV field ${technicalLiteral}`);
  }
  console.log('  ✓ Albanian CSV guidance preserves machine-readable field names');
  assert(sqMessages['dashboard.payIn'] === 'Depozitë', 'Albanian cash pay-in label must match the Z-report terminology');
  assert(sqMessages['dashboard.payOut'] === 'Tërheqje', 'Albanian cash pay-out label must match the Z-report terminology');
  assert(sqMessages['orders.takeaway'] === 'Me vete', 'Albanian takeaway label must use the approved pickup term');
  assert(sqMessages['pos.orderTypeTakeaway'] === 'Me vete', 'Albanian order-type takeaway label must use the approved pickup term');
  assert(sqMessages['orders.convertToTakeaway'] === 'Konverto në porosi me vete', 'Albanian takeaway conversion action must use pickup wording');
  assert(sqMessages['orders.orderConvertedTakeaway'] === 'Porosia u konvertua në porosi me vete', 'Albanian takeaway conversion result must use pickup wording');
  console.log('  ✓ Albanian cash-movement and takeaway terminology is consistent');

  // 21. vi.json values must be complete, NFC text without malformed characters.
  const viMessages = loadedStrings.get('vi');
  if (!viMessages) throw new Error('languages registry must include the maintained vi locale');
  const viErrors = viFallbackErrors(viMessages, loadedStrings.get('en')!);
  if (viErrors.length) {
    console.error(`\nvi.json values with errors (${viErrors.length}):`);
    for (const e of viErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'vi.json contains untranslated, placeholder, non-NFC, or replacement-character values');
  }
  assert(viMessages['receipt.cashReceived'] === 'Tiền mặt đã nhận', 'vi.json receipt.cashReceived must preserve the canonical cash-received label');
  assert(viMessages['pos.tagVeg'] === 'Ăn chay' && viMessages['products.tagVeg'] === 'Ăn chay', 'vi.json vegetarian product tags must use the reviewed Vietnamese term');
  assert(!viMessages['orders.voidItemConfirm'].includes('đã đang'), 'vi.json void confirmation must not contain duplicated progressive grammar');
  console.log(`  ✓ no untranslated vi.json values (${VI_INTENTIONAL_IDENTICAL.size} intentional shared values; NFC verified)`);

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
  expectDetected('leaf: duplicate keys', findDuplicateKeys('{"a": {"b": 1, "b": 2}}'));

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

  // 7. Language safeguards (fa, fr, tr, fil, de, it, ru, ur, ja, zh, ko, id, nl, hi, bn, sq, vi).
  expectDetected(
    'fa: English-identical value',
    faFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'fr: English-identical value',
    frFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'tr: English-identical value',
    trFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'tr: placeholder prefix value',
    trFallbackErrors({ 'a.b': '[TR] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'fil: English-identical value',
    filFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'fil: placeholder prefix value',
    filFallbackErrors({ 'a.b': '[FIL] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'de: English-identical value',
    deFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'de: placeholder prefix value',
    deFallbackErrors({ 'a.b': '[DE] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'it: English-identical value',
    itFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'it: placeholder prefix value',
    itFallbackErrors({ 'a.b': '[IT] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'ru: English-identical value',
    ruFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'ru: placeholder prefix value',
    ruFallbackErrors({ 'a.b': '[RU] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'ru: invisible formatting character',
    ruFallbackErrors({ 'a.b': 'Скрытый\u200bтекст' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'ur: English-identical value',
    urFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'ur: placeholder prefix value',
    urFallbackErrors({ 'a.b': '[UR] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'ja: English-identical value',
    jaFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'ja: placeholder prefix value',
    jaFallbackErrors({ 'a.b': '[JA] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'zh: English-identical value',
    zhFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'zh: placeholder prefix value',
    zhFallbackErrors({ 'a.b': '[ZH] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'zh-tw: English-identical value',
    zhTwFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'zh-tw: placeholder prefix value',
    zhTwFallbackErrors({ 'a.b': '[ZH-TW] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'ko: English-identical value',
    koFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'ko: placeholder prefix value',
    koFallbackErrors({ 'a.b': '[KO] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'id: English-identical value',
    idFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'id: placeholder prefix value',
    idFallbackErrors({ 'a.b': '[ID] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'nl: English-identical value',
    nlFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'nl: placeholder prefix value',
    nlFallbackErrors({ 'a.b': '[NL] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'hi: English-identical value',
    hiFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'hi: placeholder prefix value',
    hiFallbackErrors({ 'a.b': '[HI] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'bn: English-identical value',
    bnFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'bn: placeholder prefix value',
    bnFallbackErrors({ 'a.b': '[BN] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'sq: English-identical value',
    sqFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'sq: placeholder prefix value',
    sqFallbackErrors({ 'a.b': '[SQ] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'vi: English-identical value',
    viFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'vi: placeholder prefix value',
    viFallbackErrors({ 'a.b': '[VI] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'vi: non-NFC value',
    viFallbackErrors({ 'a.b': 'Tiếng Việt'.normalize('NFD') }, { 'a.b': 'Tiếng Việt'.normalize('NFC') }),
  );
  expectDetected(
    'vi: Unicode replacement character',
    viFallbackErrors({ 'a.b': 'Ti�ng Việt' }, { 'a.b': 'Tiếng Việt' }),
  );

  // 8. TypeScript key safety.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-negative-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'fixture.ts'),
      [
        "const bad = t('does.not.exist');",
        "const tPos = useTranslations('pos');",
        "const badScoped = tPos('doesNotExistScoped');",
        "const unsafe = t(`prefix.${value}`);",
        "const safe = t(`prefix.${value}` as 'prefix.a' | 'prefix.b');",
        "import { useI18n } from '@/hooks/useI18n';",
        "const legacyPlural = formatIcuPlural('items', 5);",
      ].join('\n'),
    );

    const called = collectCalledKeys(tmp);
    expectDetected(
      'ts: invalid literal key',
      [...called].filter((k) => !new Set(['prefix.a', 'prefix.b']).has(k)),
    );

    const unsafe = collectUnsafeDynamicKeys(tmp);
    expectDetected('ts: unsafe template-literal t() call', unsafe.map((u) => u.code));
    expectDetected(
      'ts: legacy i18n bridge import',
      legacyImportErrors(tmp),
    );
    const flaggedLines = unsafe.map((u) => u.line);
    assert(
      flaggedLines.length === 1 && flaggedLines[0] === 4,
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
