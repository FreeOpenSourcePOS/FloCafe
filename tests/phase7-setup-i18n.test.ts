/**
 * Phase 7 setup/demo and print-test locale coverage.
 *
 * The seed path is exercised through the exported setup-profile API for every
 * registered UI locale. Filipino's English-identical seed data is an explicit
 * reviewed exception; country selection is passed separately and must not be
 * inferred from the selected UI language.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-phase7-i18n-'));
const Module = require('module');
process.env.NODE_PATH = [path.join(__dirname, '../frontend/node_modules'), process.env.NODE_PATH]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => testDir,
        getVersion: () => 'phase7-test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase } = require('../main/db') as typeof import('../main/db');
const {
  seedSetupProfile,
  ENGLISH_IDENTICAL_SEED_LANGUAGES,
} = require('../main/routes/auth') as typeof import('../main/routes/auth');
const { LANGUAGES } = require('../frontend/src/lib/i18n/languages') as typeof import('../frontend/src/lib/i18n/languages');
const { loadLocaleMessages } = require('../frontend/src/lib/i18n/loader') as typeof import('../frontend/src/lib/i18n/loader');
const { parsePhoneE164 } = require('../main/lib/phone') as typeof import('../main/lib/phone');
const { createTranslator } = require('use-intl/core') as typeof import('use-intl/core');
const { printLabel } = require('../main/print/print-labels.generated') as typeof import('../main/print/print-labels.generated');

const languages = Object.keys(LANGUAGES) as Array<keyof typeof LANGUAGES>;
const englishIdenticalSeeds = new Set<string>(ENGLISH_IDENTICAL_SEED_LANGUAGES);

function resetDatabase(): void {
  try { closeDatabase(); } catch { /* first iteration */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = path.join(testDir, `flo.db${suffix}`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const marker = path.join(testDir, '.flo-db-initialized');
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  initDatabase();
}

function rows(table: string, columns: string, where: string): any[] {
  return getDatabase().prepare(`SELECT ${columns} FROM ${table} WHERE ${where}`).all();
}

async function run(): Promise<void> {
  console.log(`Phase 7 setup/demo locale coverage: ${languages.length} registered locales`);
  assert.deepEqual([...englishIdenticalSeeds].sort(), ['fil'], 'Filipino is the only non-English locale on the documented English-identical seed allowlist');

  const translators = new Map<string, (key: string, values?: Record<string, unknown>) => string>();
  for (const language of languages) {
    const messages = await loadLocaleMessages(language);
    translators.set(language, createTranslator({ locale: LANGUAGES[language].locale, messages }) as unknown as (key: string, values?: Record<string, unknown>) => string);
  }
  const translate = (language: string, key: string, values?: Record<string, unknown>): string => {
    const translator = translators.get(language);
    assert.ok(translator, `${language}: runtime translator is available`);
    return translator(key, values);
  };

  const snapshots = new Map<string, { category: string; product: string; manager: string; customer: string }>();
  for (const language of languages) {
    resetDatabase();
    const db = getDatabase();

    seedSetupProfile(db, 'express', 'qsr', language);
    assert.equal(rows('categories', 'name', "id = 'cat-express-food'").length, 1, `${language}: express setup seeds food category`);
    assert.equal(rows('products', 'name', "id = 'prod-express-meal'").length, 1, `${language}: express setup seeds starter product`);
    if (language === 'ar') {
      assert.equal(rows('categories', 'name', "id = 'cat-express-food'")[0].name, 'الأطعمة', 'Arabic express category is localized');
      assert.equal(rows('products', 'name', "id = 'prod-express-meal'")[0].name, 'وجبة', 'Arabic express product is localized');
    }
    if (language === 'zh-tw') {
      assert.equal(rows('categories', 'name', "id = 'cat-express-food'")[0].name, '餐點', 'Taiwan Traditional Chinese express category is localized');
      assert.equal(rows('products', 'name', "id = 'prod-express-meal'")[0].name, '餐點', 'Taiwan Traditional Chinese express product is localized');
    }

    seedSetupProfile(db, 'demo', 'finedine', language, 'IN');
    const seededCustomers = rows('customers', 'phone, phone_digits, country_code', 'is_active = 1');
    for (const customer of seededCustomers) {
      const parsed = parsePhoneE164(customer.phone, 'IN');
      assert.ok(parsed, `${language}: demo customer phone ${customer.phone} must be valid E.164`);
      assert.equal(customer.phone, `+${customer.phone_digits}`, `${language}: demo customer phone and digits must agree`);
      assert.equal(customer.country_code, parsed.countryCode, `${language}: demo customer country code must follow the phone number`);
    }
    const snapshot = {
      category: rows('categories', 'name', "id = 'cat-demo-starters'")[0].name,
      product: rows('products', 'name', "id LIKE 'prod-demo-%'")[0].name,
      manager: rows('users', 'name', "id = 'user-demo-manager'")[0].name,
      customer: rows('customers', 'name', "id = 'cust-demo-1'")[0].name,
    };
    snapshots.set(language, snapshot);
    if (language === 'zh-tw') {
      assert.equal(snapshot.category, '前菜', 'Taiwan Traditional Chinese demo category is localized');
      assert.equal(snapshot.product, '春捲', 'Taiwan Traditional Chinese demo product is localized');
      assert.equal(rows('products', 'name', "id = 'prod-demo-sweet-sour'")[0].name, '糖醋里肌', 'Taiwan Traditional Chinese demo product uses Taiwan terminology');
      assert.equal(snapshot.manager, '示範經理', 'Taiwan Traditional Chinese demo manager is localized');
      assert.equal(snapshot.customer, '李娜', 'Taiwan Traditional Chinese demo customer is localized');
    }
    assert.equal(rows('customers', 'id', 'is_active = 1').length, 3, `${language}: demo setup seeds customers`);
    assert.equal(rows('tables', 'id', "id LIKE 'tbl-demo-%'").length, 4, `${language}: demo FineDine setup seeds tables`);

    if (englishIdenticalSeeds.has(language)) {
      assert.deepEqual(snapshot, snapshots.get('en') ?? snapshot, `${language}: seed data follows the documented English-identical allowlist`);
    } else if (language !== 'en') {
      const english = snapshots.get('en');
      assert.ok(english, 'English baseline is available before localized locale checks');
      assert.notEqual(snapshot.category, english.category, `${language}: demo category is localized`);
      assert.notEqual(snapshot.product, english.product, `${language}: demo product is localized`);
      assert.notEqual(snapshot.manager, english.manager, `${language}: demo staff name is localized`);
      assert.notEqual(snapshot.customer, english.customer, `${language}: demo customer name is localized`);
    }
  }

  resetDatabase();
  seedSetupProfile(getDatabase(), 'demo', 'qsr', 'es', 'TR');
  const selectedCountryCustomer = rows('customers', 'phone, country_code', "id = 'cust-demo-1'")[0];
  assert.equal(selectedCountryCustomer.country_code, '+54', 'E.164 demo phone country remains independent of the selected Turkish store country');
  assert.equal(selectedCountryCustomer.phone, '+541145678901', 'Spanish demo phone remains E.164 in a non-Argentina store');

  resetDatabase();
  seedSetupProfile(getDatabase(), 'demo', 'qsr', 'es', 'IN');
  const explicitCountryCustomer = rows('customers', 'phone, country_code', "id = 'cust-demo-1'")[0];
  assert.equal(explicitCountryCustomer.country_code, '+54', 'E.164 demo phone country is not derived from the selected Indian store country');
  assert.equal(explicitCountryCustomer.phone, '+541145678901', 'Spanish demo phone remains E.164 in a non-Argentina store');

  const filipinoArabicWarning = translate('fil', 'printWarnings.arabicShapingHint');
  assert.equal(filipinoArabicWarning.includes('Your printer'), false, 'Filipino Arabic warning is not mixed English/Filipino');
  assert.equal(filipinoArabicWarning.includes('I-enable'), false, 'Filipino Arabic warning uses localized imperative wording');
  assert.equal(translate('de', 'setup.finedineLabel'), 'FineDine', 'German setup uses the product flow name, not the unrelated Fine Dining term');
  assert.match(translate('de', 'setup.expressDetails'), /FineDine/);
  assert.equal(translate('de', 'print.pleaseComeAgain'), 'Bitte kommen Sie wieder!', 'German receipt semantic string asks guests to return');

  // The generated print-label boundary preserves the existing Spanish and
  // Portuguese fallback coverage independently of country defaults.
  assert.equal(printLabel('es', 'print.taxInvoiceTitle'), 'FACTURA CON IMPUESTOS');
  assert.equal(printLabel('pt', 'print.thankYouShort'), 'Obrigado!');
  for (const language of languages) {
    assert.notEqual(translate(language, 'printTest.optionBasicReceipt'), 'printTest.optionBasicReceipt', `${language}: basic receipt label resolves`);
    assert.notEqual(translate(language, 'printTest.optionWebPrint'), 'printTest.optionWebPrint', `${language}: web print label resolves`);
    assert.notEqual(translate(language, 'printTest.kitchenStation'), 'printTest.kitchenStation', `${language}: kitchen station label resolves`);
    assert.notEqual(translate(language, 'printWarnings.languageLoadError', { languages: 'fa' }), 'printWarnings.languageLoadError', `${language}: locale-load warning resolves`);
  }

  console.log('Phase 7 setup/demo, allowlist, country decoupling, fallback, warning, and print-test checks passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  fs.rmSync(testDir, { recursive: true, force: true });
  Module._load = originalLoad;
});
