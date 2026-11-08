import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LANGUAGES } from '../frontend/src/lib/i18n/languages';
import {
  DEFAULT_SETTINGS_PERMISSIONS,
  SETTINGS_SEARCH_CATALOG,
  isSettingsEntryVisible,
  normalizeSearchText,
  resolveSettingsKey,
  searchSettingsCatalog,
  type SettingsPermissions,
  type SettingsTabValue,
  type SettingsTranslatorMap,
} from '../frontend/src/lib/settings-search';

const ROOT = path.resolve(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'frontend/src/lib/i18n/messages');

type LocaleBundle = Record<string, Record<string, unknown>>;

function loadLocaleBundle(locale: string): LocaleBundle {
  const filePath = path.join(I18N_DIR, `${locale}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as LocaleBundle;
}

function createTranslatorsForLocale(bundle: LocaleBundle): SettingsTranslatorMap {
  const makeNamespaceTranslator =
    (ns: string) =>
    (key: string): string => {
      const section = bundle[ns];
      if (section && typeof section === 'object' && typeof section[key] === 'string') {
        return section[key] as string;
      }
      return key;
    };

  return {
    settings: makeNamespaceTranslator('settings'),
    pos: makeNamespaceTranslator('pos'),
    customerDisplay: makeNamespaceTranslator('customerDisplay'),
    tax: makeNamespaceTranslator('tax'),
    qrMenu: makeNamespaceTranslator('qrMenu'),
    update: makeNamespaceTranslator('update'),
    productAnalytics: makeNamespaceTranslator('productAnalytics'),
  };
}

const enBundle = loadLocaleBundle('en');
const enTranslators = createTranslatorsForLocale(enBundle);

// 1. Catalog completeness and translation integrity
{
  const expectedTabs: SettingsTabValue[] = [
    'store',
    'receipts-printers',
    'payments',
    'appearance',
    'tax',
    'pos',
    'kitchen-stations',
    'kds',
    'server-app',
    'whatsapp',
    'qr-menu',
    'counters',
    'loyalty',
    'discounts',
    'mobile-access',
    'data',
    'orderflow',
    'account',
    'privacy',
    'updates',
    'about',
  ];

  const coveredTabs = new Set(SETTINGS_SEARCH_CATALOG.map((entry) => entry.tab));
  for (const tab of expectedTabs) {
    assert.ok(coveredTabs.has(tab), `Expected SETTINGS_SEARCH_CATALOG to cover tab "${tab}"`);
  }

  const allEntryIds = new Set(SETTINGS_SEARCH_CATALOG.map((entry) => entry.id));
  const seenIds = new Set<string>();
  for (const entry of SETTINGS_SEARCH_CATALOG) {
    assert.ok(!seenIds.has(entry.id), `Duplicate catalog entry id "${entry.id}"`);
    seenIds.add(entry.id);

    if (entry.fallbackSectionId) {
      assert.ok(
        allEntryIds.has(entry.fallbackSectionId),
        `Expected fallbackSectionId "${entry.fallbackSectionId}" for "${entry.id}" to reference a known catalog entry id`,
      );
    }

    const title = resolveSettingsKey(entry.titleKey, entry.fallbackTitleKey, enTranslators);
    const hint = resolveSettingsKey(entry.hintKey, entry.fallbackHintKey, enTranslators);
    const tabLabel = resolveSettingsKey(entry.tabLabelKey, undefined, enTranslators);
    const groupLabel = resolveSettingsKey(entry.groupLabelKey, undefined, enTranslators);

    assert.ok(title.length > 0 && title !== entry.titleKey, `Unresolved titleKey for ${entry.id}`);
    assert.ok(hint.length > 0 && hint !== entry.hintKey, `Unresolved hintKey for ${entry.id}`);
    assert.ok(
      tabLabel.length > 0 && tabLabel !== entry.tabLabelKey,
      `Unresolved tabLabelKey for ${entry.id}`,
    );
    assert.ok(
      groupLabel.length > 0 && groupLabel !== entry.groupLabelKey,
      `Unresolved groupLabelKey for ${entry.id}`,
    );
    assert.ok(entry.keywords.length > 0, `Expected keywords for ${entry.id}`);
  }
}

// 2. Normalization and diacritic insensitivity
{
  assert.equal(normalizeSearchText('  Auto-Lock / Idle_Timeout! '), 'auto lock idle timeout');
  assert.equal(normalizeSearchText('Facturación Electrónica'), 'facturacion electronica');
  assert.equal(normalizeSearchText('Configuração de Impressão'), 'configuracao de impressao');
  assert.equal(normalizeSearchText('Impôt & Taxes'), 'impot taxes');
  // Non-Latin scripts and Indic vowel signs (matras) are preserved
  assert.ok(normalizeSearchText('प्रिंटर सेटिंग्स').includes('प्रिंटर'));
}

// 3. Exact title matches, synonym/keyword matches, and multi-word queries
{
  const assertTopMatch = (query: string, expectedId: string, expectedTab: SettingsTabValue) => {
    const results = searchSettingsCatalog(query, enTranslators);
    assert.ok(results.length > 0, `Expected results for query "${query}"`);
    const match = results.find((r) => r.id === expectedId);
    assert.ok(
      match,
      `Expected "${expectedId}" in results for "${query}", got: ${results.map((r) => r.id).join(', ')}`,
    );
    assert.equal(match.tab, expectedTab);
    assert.equal(results[0].id, expectedId, `Expected "${expectedId}" to rank #1 for "${query}"`);
  };

  assertTopMatch('58mm', 'printers-hardware', 'receipts-printers');
  assertTopMatch('76mm', 'printers-hardware', 'receipts-printers');
  assertTopMatch('80mm thermal', 'printers-hardware', 'receipts-printers');
  assertTopMatch('gst', 'tax-configuration', 'tax');
  assertTopMatch('parcel', 'charges-surcharges', 'pos');
  assertTopMatch('google drive', 'google-drive-backup', 'data');
  assertTopMatch('idle lock', 'pos-auto-lock', 'pos');
  assertTopMatch('second screen', 'customer-display', 'kds');
  assertTopMatch('pole display', 'customer-display', 'kds');
  assertTopMatch('dark mode', 'appearance-theme', 'appearance');
  assertTopMatch('master pin', 'master-pin', 'data');
  assertTopMatch('split bill', 'split-checks', 'payments');
  assertTopMatch('closing time', 'store-business-day', 'store');
  assertTopMatch('store logo', 'store-logo', 'store');
  assertTopMatch('upload logo', 'store-logo', 'store');
  assertTopMatch('instagram', 'store-logo', 'store');
  assertTopMatch('bill content', 'bill-content', 'receipts-printers');
  assertTopMatch('footer message', 'bill-content', 'receipts-printers');

  // Ranking order: title match > keyword match > description match
  const workflowResults = searchSettingsCatalog('POS Workflow', enTranslators);
  assert.ok(workflowResults.length > 0);
  assert.equal(workflowResults[0].id, 'pos-workflow');
  assert.equal(workflowResults[0].matchTier, 'title');

  const paymentMethodResults = searchSettingsCatalog('Payment Methods', enTranslators);
  assert.ok(paymentMethodResults.length > 0);
  assert.equal(paymentMethodResults[0].id, 'payment-methods');
  assert.equal(paymentMethodResults[0].matchTier, 'keyword');

  // Breadcrumb formatting
  const autoLockResult = searchSettingsCatalog('idle lock', enTranslators)[0];
  assert.equal(autoLockResult.breadcrumb, 'Operations · POS Workflow');

  // Unmatched query returns empty array
  assert.deepEqual(searchSettingsCatalog('xyz-nonexistent-setting-999', enTranslators), []);
  assert.deepEqual(searchSettingsCatalog('   ', enTranslators), []);
}

// 4. Permission filtering
{
  const restrictedPermissions: SettingsPermissions = {
    isAdmin: false,
    isOwner: false,
    canViewTaxConfiguration: false,
    canManageQrMenu: false,
    canManageMobileAccess: false,
    canManageDatabase: false,
  };

  assert.deepEqual(
    searchSettingsCatalog('dark mode', enTranslators, restrictedPermissions),
    [],
    'Appearance settings must be hidden when isAdmin is false',
  );
  assert.deepEqual(
    searchSettingsCatalog('contact email', enTranslators, restrictedPermissions),
    [],
    'Account contact email setting must be hidden when isOwner is false',
  );
  assert.deepEqual(
    searchSettingsCatalog('cloud privacy controls', enTranslators, restrictedPermissions),
    [],
    'Cloud privacy controls setting must be hidden when isOwner is false',
  );
  assert.deepEqual(
    searchSettingsCatalog('gst', enTranslators, restrictedPermissions).filter(
      (r) => r.tab === 'tax',
    ),
    [],
    'Tax Configuration tab settings must be hidden when canViewTaxConfiguration is false',
  );
  assert.deepEqual(
    searchSettingsCatalog('qr menu', enTranslators, restrictedPermissions),
    [],
    'QR Menu settings must be hidden when canManageQrMenu is false',
  );
  assert.deepEqual(
    searchSettingsCatalog('revflo', enTranslators, restrictedPermissions),
    [],
    'Mobile Access settings must be hidden when canManageMobileAccess is false',
  );
  assert.deepEqual(
    searchSettingsCatalog('google drive', enTranslators, restrictedPermissions).filter(
      (r) => r.tab === 'data',
    ),
    [],
    'Database/Backup settings must be hidden when canManageDatabase is false',
  );
  assert.deepEqual(
    searchSettingsCatalog('master pin', enTranslators, restrictedPermissions),
    [],
    'Master PIN setting must be hidden when canManageDatabase is false',
  );

  // Non-gated tabs remain searchable for restricted roles
  const storeResults = searchSettingsCatalog('currency', enTranslators, restrictedPermissions);
  assert.ok(storeResults.some((r) => r.id === 'store-currency'));

  for (const entry of SETTINGS_SEARCH_CATALOG) {
    assert.equal(isSettingsEntryVisible(entry, DEFAULT_SETTINGS_PERMISSIONS), true);
  }
}

// 5. Multi-language search across all 32 supported locales
{
  const locales = Object.keys(LANGUAGES);
  assert.ok(locales.length >= 32, `Expected at least 32 locales, found ${locales.length}`);

  for (const locale of locales) {
    const bundle = loadLocaleBundle(locale);
    const translators = createTranslatorsForLocale(bundle);
    const localizedPrintersTitle = resolveSettingsKey('printers', undefined, translators);
    const results = searchSettingsCatalog(localizedPrintersTitle, translators);
    assert.ok(
      results.some((r) => r.id === 'printers-hardware'),
      `Expected localized printers title "${localizedPrintersTitle}" in locale "${locale}" to match printers-hardware`,
    );

    // Universal keyword search still works in every locale
    const keywordResults = searchSettingsCatalog('58mm', translators);
    assert.ok(
      keywordResults.some((r) => r.id === 'printers-hardware'),
      `Expected keyword "58mm" in locale "${locale}" to match printers-hardware`,
    );
  }

  // Diacritic-insensitive localized query test (Spanish & French)
  const esTranslators = createTranslatorsForLocale(loadLocaleBundle('es'));
  const esLoyaltyTitle = resolveSettingsKey('loyaltyProgram', undefined, esTranslators);
  const strippedEsQuery = esLoyaltyTitle.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const esResults = searchSettingsCatalog(strippedEsQuery, esTranslators);
  assert.ok(esResults.some((r) => r.id === 'loyalty-program'));
}

console.log('✓ settings-search unit tests passed');
