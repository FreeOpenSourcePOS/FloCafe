/**
 * Phase 6 locale-loading coverage.
 *
 * Every registered locale must be warmed before browser or WebUSB receipt
 * rendering, and authenticated print policies must be applied during bootstrap.
 */
import assert from 'node:assert/strict';
import path from 'node:path';

const moduleApi = require('module') as { _resolveFilename: (...args: any[]) => string };
const originalResolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request === '@countries') {
    resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
  } else if (request.startsWith('@/')) {
    resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
  } else if (request.startsWith('@print/')) {
    resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

const { LANGUAGES } = require('../frontend/src/lib/i18n/languages') as typeof import('../frontend/src/lib/i18n/languages');
const { loadLocaleMessages, isLocaleLoaded } = require('../frontend/src/lib/i18n/loader') as typeof import('../frontend/src/lib/i18n/loader');
const { syncPrintPoliciesAtBootstrap } = require('../frontend/src/lib/print-policy-bootstrap') as typeof import('../frontend/src/lib/print-policy-bootstrap');
const { generateBillHtml } = require('../frontend/src/lib/printer/web-print') as typeof import('../frontend/src/lib/printer/web-print');
const { buildClassicReceiptBytes } = require('../frontend/src/lib/printer/receipt-encoder') as typeof import('../frontend/src/lib/printer/receipt-encoder');

const languages = Object.keys(LANGUAGES) as Array<keyof typeof LANGUAGES>;
const bill = {
  id: 1,
  bill_number: 'PHASE6-001',
  subtotal: 10,
  discount_amount: 0,
  tax_amount: 0,
  total: 10,
  payment_details: [{ method: 'cash', amount: 10 }],
  order: {
    order_number: 'ORD-PHASE6-001',
    created_at: '2026-08-22T12:00:00Z',
    items: [{ product_name: 'Coffee', quantity: 1, unit_price: 10, total: 10, addons: [] }],
  },
};
const tenant = { business_name: 'Phase 6 Cafe', country: 'IN', currency: 'INR', timezone: 'UTC' };

async function run(): Promise<void> {
  console.log(`Phase 6 locale loading: ${languages.length} registered locales`);

  const settings = {
    state: {
      language: 'en' as const,
      billLanguagePolicy: undefined,
      kotLanguagePolicy: undefined,
      setBillLanguagePolicy(policy: unknown) { this.billLanguagePolicy = policy; },
      setKotLanguagePolicy(policy: unknown) { this.kotLanguagePolicy = policy; },
    },
    getState() { return this.state; },
  };
  const failed = await syncPrintPoliciesAtBootstrap({
    id: 1,
    business_name: 'Phase 6 Cafe',
    slug: 'local',
    database_name: 'local',
    business_type: 'restaurant',
    country: 'IN',
    currency: 'INR',
    timezone: 'UTC',
    plan: 'desktop',
    status: 'active',
    language: 'en',
    bill_language_policy: JSON.stringify({ primary: { mode: 'fixed', language: 'de' }, additional: ['fa'] }),
    kot_language_policy: JSON.stringify({ primary: { mode: 'fixed', language: 'tr' }, additional: [] }),
  }, settings);
  assert.deepEqual(failed, [], 'authenticated print-policy locale warmup succeeds');
  assert.equal(settings.state.billLanguagePolicy.primary.language, 'de', 'receipt policy is applied during bootstrap');
  assert.equal(settings.state.kotLanguagePolicy.primary.language, 'tr', 'KOT policy is applied during bootstrap');
  assert.ok(isLocaleLoaded('de') && isLocaleLoaded('fa') && isLocaleLoaded('tr'), 'selected print locales are loaded before bootstrap completes');

  await Promise.all(languages.map((language) => loadLocaleMessages(language)));
  for (const language of languages) {
    const browserHtml = generateBillHtml(bill as any, tenant as any, { language });
    assert.match(browserHtml, new RegExp(`<html lang="${LANGUAGES[language].locale}"`), `${language}: browser receipt locale`);
    assert.doesNotMatch(browserHtml, /receipt\.[A-Za-z]/, `${language}: browser receipt has no raw label key`);

    const warnings: any[] = [];
    const bytes = buildClassicReceiptBytes(bill as any, tenant as any, {
      paperWidth: 58,
      language,
      languages: [language],
      locale: LANGUAGES[language].locale,
    } as any, warnings);
    assert.ok(bytes.length > 0, `${language}: WebUSB receipt bytes generated after locale load`);
    assert.doesNotMatch(Buffer.from(bytes).toString('utf8'), /receipt\.[A-Za-z]/, `${language}: WebUSB receipt has no raw label key`);
  }

  console.log('✅ Browser and WebUSB receipt loading covered every registered locale.');
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleApi._resolveFilename = originalResolveFilename;
  });
