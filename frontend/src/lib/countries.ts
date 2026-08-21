import { countryName as englishCountryName, type Country } from '@countries';

export {
  COUNTRIES,
  DEFAULT_COUNTRY_PROFILE,
  getCountryByCode,
  listTimeZones,
  isValidTimeZone,
  getCurrencySymbol,
  formatCurrency,
  formatCurrencyForTenant,
  formatMoney,
  formatNumber,
  formatNumberForTenant,
  formatDateForTenant,
  getCurrencyUnitAdapter,
  countryName,
  type Country,
  type CountryLocaleOptions,
  type LocalePreferences,
  type CurrencyDisplay,
  type DigitMode,
  type CalendarMode,
  type CurrencyUnitAdapter,
} from '@countries';

const localizedDisplayNamesCache = new Map<string, Intl.DisplayNames>();

function displayNamesForLocale(locale: string): Intl.DisplayNames {
  const normalizedLocale = locale.trim() || 'en';
  const cached = localizedDisplayNamesCache.get(normalizedLocale);
  if (cached) return cached;

  try {
    const displayNames = new Intl.DisplayNames([normalizedLocale], { type: 'region' });
    localizedDisplayNamesCache.set(normalizedLocale, displayNames);
    return displayNames;
  } catch {
    if (normalizedLocale !== 'en') return displayNamesForLocale('en');
    throw new Error('Intl.DisplayNames is unavailable');
  }
}

/** Resolve a country name for the active UI locale without changing its ISO identity. */
export function getLocalizedCountryName(code: string, locale: string): string {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!normalizedCode) return '';

  try {
    const localized = displayNamesForLocale(locale).of(normalizedCode);
    if (localized) return localized;
  } catch {
    // Fall through to the static English name/ISO code for unsupported runtimes or locales.
  }

  return englishCountryName(normalizedCode) || normalizedCode;
}

/** Match localized names plus English names, ISO codes, currencies, and locale identifiers. */
export function countryMatchesQuery(country: Country, query: string, locale: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  if (!normalizedQuery) return true;

  return [
    getLocalizedCountryName(country.code, locale),
    englishCountryName(country.code),
    country.code,
    country.currency,
    country.locale,
  ].some((value) => value.toLocaleLowerCase(locale).includes(normalizedQuery));
}

/** Sort countries by their localized display name while keeping IN and AR pinned first. */
export function sortCountriesByLocalizedName(countries: readonly Country[], locale: string): Country[] {
  const pinned = ['IN', 'AR'];
  const pinIndex = (code: string) => {
    const index = pinned.indexOf(code);
    return index === -1 ? pinned.length : index;
  };

  return [...countries].sort((a, b) => {
    const aPin = pinIndex(a.code);
    const bPin = pinIndex(b.code);
    if (aPin !== bPin) return aPin - bPin;

    const aName = getLocalizedCountryName(a.code, locale);
    const bName = getLocalizedCountryName(b.code, locale);
    try {
      return aName.localeCompare(bName, locale, { sensitivity: 'base' });
    } catch {
      return aName.localeCompare(bName);
    }
  });
}
