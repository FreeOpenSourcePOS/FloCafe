/**
 * Issue #392: localized country display names and country selector behavior.
 *
 * Run: npm run test:country-localization
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('module');

const moduleApi = Module;
const originalResolveFilename = moduleApi._resolveFilename;
moduleApi._resolveFilename = function (request, parent, isMain, options) {
  if (request === '@countries') {
    request = path.resolve(__dirname, '../main/countries');
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const {
  COUNTRIES,
  countryMatchesQuery,
  getCountryByCode,
  getLocalizedCountryName,
  sortCountriesByLocalizedName,
} = require('../frontend/src/lib/countries');

moduleApi._resolveFilename = originalResolveFilename;

function selectedCountries() {
  return COUNTRIES.filter((country) => ['IN', 'AR', 'DE', 'US', 'JP'].includes(country.code));
}

function codes(countries) {
  return countries.map((country) => country.code);
}

try {
  assert.equal(getLocalizedCountryName('DE', 'en'), 'Germany');
  assert.equal(getLocalizedCountryName('US', 'en'), 'United States');
  assert.equal(getLocalizedCountryName('JP', 'en'), 'Japan');

  assert.equal(getLocalizedCountryName('DE', 'es'), 'Alemania');
  assert.equal(getLocalizedCountryName('US', 'es'), 'Estados Unidos');
  assert.equal(getLocalizedCountryName('JP', 'es'), 'Japón');

  assert.equal(getLocalizedCountryName('DE', 'pt-BR'), 'Alemanha');
  assert.equal(getLocalizedCountryName('US', 'pt-BR'), 'Estados Unidos');
  assert.equal(getLocalizedCountryName('JP', 'pt-BR'), 'Japão');

  assert.equal(getLocalizedCountryName('DE', 'fa-IR'), 'آلمان');
  assert.equal(getLocalizedCountryName('US', 'fa-IR'), 'ایالات متحده');

  const germany = getCountryByCode('DE');
  assert(germany, 'Germany country profile exists');
  assert(countryMatchesQuery(germany, 'Alemania', 'es'), 'search matches a localized Spanish name');
  assert(countryMatchesQuery(germany, 'Germany', 'es'), 'search matches the English fallback name');
  assert(countryMatchesQuery(germany, 'DE', 'es'), 'search matches the ISO country code');
  assert(countryMatchesQuery(germany, 'EUR', 'es'), 'search matches the currency');
  assert(countryMatchesQuery(germany, 'de-DE', 'es'), 'search matches the country locale');
  assert(!countryMatchesQuery(germany, 'Brasil', 'es'), 'search excludes unrelated localized names');

  assert.deepEqual(
    codes(sortCountriesByLocalizedName(selectedCountries(), 'es')),
    ['IN', 'AR', 'DE', 'US', 'JP'],
    'Spanish sorting keeps pinned countries first and then sorts localized names',
  );
  assert.deepEqual(
    codes(sortCountriesByLocalizedName(selectedCountries(), 'pt-BR')),
    ['IN', 'AR', 'DE', 'US', 'JP'],
    'Portuguese sorting keeps pinned countries first and then sorts localized names',
  );

  console.log('✅ Issue #392 country localization checks passed');
} finally {
  // Keep the test isolated if a module import fails before normal completion.
  moduleApi._resolveFilename = originalResolveFilename;
}
