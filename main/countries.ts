import { getCountryCallingCode, type CountryCode } from 'libphonenumber-js';

export interface TaxIdFormat {
  // JS RegExp source (no slashes/flags) — validated case-insensitively.
  pattern: string;
  description: string;
}

/**
 * Which locale display preferences a country supports. The Settings UI only
 * renders these controls when a country's profile declares them, so
 * region-specific options never appear (or bloat) other regions' UI.
 */
export interface CountryLocaleOptions {
  currencyDisplay?: ('rial' | 'toman' | 'toman_short')[];
  digits?: ('locale' | 'latin')[];
  calendar?: ('locale' | 'persian' | 'gregorian')[];
}

export interface Country {
  code: string;
  name: string;
  currency: string;
  timezone: string;
  dialCode: string;
  locale: string;
  taxIdLabel?: string;
  taxName?: string;
  // Only enforced when an official (non-local) tax pack is active for this
  // country — see resolveTaxIdFormat() in services/tax.ts. Left undefined
  // for countries we haven't verified a format for; unset means no format
  // is enforced, never "reject everything".
  taxIdFormat?: TaxIdFormat;
  // Locale display preferences available for this country (undefined = none).
  localeOptions?: CountryLocaleOptions;
}

const dn = new Intl.DisplayNames(['en'], { type: 'region' });

interface Row {
  locale: string;
  currency: string;
  tz: string;
  taxIdLabel?: string;
  taxName?: string;
  taxIdFormat?: TaxIdFormat;
  localeOptions?: CountryLocaleOptions;
}

const SUPPORTED: Record<string, Row> = {
  IN: { locale: 'en-IN', currency: 'INR', tz: 'Asia/Kolkata',                    taxIdLabel: 'GSTIN', taxName: 'GST',
    taxIdFormat: {
      pattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$',
      description: '15 characters: 2-digit state code + 10-character PAN + entity code + "Z" + checksum (e.g. 29ABCDE1234F1Z5)',
    } },
  AR: { locale: 'es-AR', currency: 'ARS', tz: 'America/Argentina/Buenos_Aires',  taxIdLabel: 'CUIT',  taxName: 'IVA' },
  US: { locale: 'en-US', currency: 'USD', tz: 'America/New_York',                taxIdLabel: 'EIN',   taxName: 'Sales Tax' },
  CA: { locale: 'en-CA', currency: 'CAD', tz: 'America/Toronto',                 taxIdLabel: 'BN',    taxName: 'GST/HST' },
  GB: { locale: 'en-GB', currency: 'GBP', tz: 'Europe/London',                   taxIdLabel: 'VAT',   taxName: 'VAT' },
  TH: { locale: 'th-TH', currency: 'THB', tz: 'Asia/Bangkok',                    taxIdLabel: 'Tax ID',taxName: 'VAT' },
  SG: { locale: 'en-SG', currency: 'SGD', tz: 'Asia/Singapore',                  taxIdLabel: 'UEN',   taxName: 'GST' },
  MY: { locale: 'ms-MY', currency: 'MYR', tz: 'Asia/Kuala_Lumpur',                                                     taxName: 'SST' },
  ID: { locale: 'id-ID', currency: 'IDR', tz: 'Asia/Jakarta',                    taxIdLabel: 'NPWP',  taxName: 'VAT' },
  PH: { locale: 'en-PH', currency: 'PHP', tz: 'Asia/Manila',                     taxIdLabel: 'TIN',   taxName: 'VAT' },
  VN: { locale: 'vi-VN', currency: 'VND', tz: 'Asia/Ho_Chi_Minh',                taxIdLabel: 'MST',   taxName: 'VAT' },
  AU: { locale: 'en-AU', currency: 'AUD', tz: 'Australia/Sydney',                taxIdLabel: 'ABN',   taxName: 'GST' },
  NZ: { locale: 'en-NZ', currency: 'NZD', tz: 'Pacific/Auckland',                taxIdLabel: 'IRD',   taxName: 'GST' },
  AE: { locale: 'ar-AE', currency: 'AED', tz: 'Asia/Dubai',                      taxIdLabel: 'TRN',   taxName: 'VAT' },
  SA: { locale: 'ar-SA', currency: 'SAR', tz: 'Asia/Riyadh',                     taxIdLabel: 'VAT',   taxName: 'VAT' },
  ZA: { locale: 'en-ZA', currency: 'ZAR', tz: 'Africa/Johannesburg',             taxIdLabel: 'VAT',   taxName: 'VAT' },
  MA: { locale: 'fr-MA', currency: 'MAD', tz: 'Africa/Casablanca',               taxIdLabel: 'Tax ID',taxName: 'VAT' },
  KE: { locale: 'en-KE', currency: 'KES', tz: 'Africa/Nairobi',                  taxIdLabel: 'PIN',   taxName: 'VAT' },
  NG: { locale: 'en-NG', currency: 'NGN', tz: 'Africa/Lagos',                    taxIdLabel: 'TIN',   taxName: 'VAT' },
  BR: { locale: 'pt-BR', currency: 'BRL', tz: 'America/Sao_Paulo',               taxIdLabel: 'CNPJ',  taxName: 'ICMS' },
  MX: { locale: 'es-MX', currency: 'MXN', tz: 'America/Mexico_City',             taxIdLabel: 'RFC',   taxName: 'IVA' },
  CL: { locale: 'es-CL', currency: 'CLP', tz: 'America/Santiago',                taxIdLabel: 'RUT',   taxName: 'IVA' },
  UY: { locale: 'es-UY', currency: 'UYU', tz: 'America/Montevideo',              taxIdLabel: 'RUT',   taxName: 'IVA' },
  PY: { locale: 'es-PY', currency: 'PYG', tz: 'America/Asuncion',                taxIdLabel: 'RUC',   taxName: 'IVA' },
  JP: { locale: 'ja-JP', currency: 'JPY', tz: 'Asia/Tokyo',                                                            taxName: 'VAT' },
  KR: { locale: 'ko-KR', currency: 'KRW', tz: 'Asia/Seoul',                      taxIdLabel: 'BRN',   taxName: 'VAT' },
  CN: { locale: 'zh-CN', currency: 'CNY', tz: 'Asia/Shanghai',                   taxIdLabel: 'USCC',  taxName: 'VAT' },
  HK: { locale: 'zh-HK', currency: 'HKD', tz: 'Asia/Hong_Kong' },
  TW: { locale: 'zh-TW', currency: 'TWD', tz: 'Asia/Taipei',                     taxIdLabel: 'UBN',   taxName: 'VAT' },
  PK: { locale: 'en-PK', currency: 'PKR', tz: 'Asia/Karachi',                    taxIdLabel: 'NTN',   taxName: 'GST' },
  BD: { locale: 'bn-BD', currency: 'BDT', tz: 'Asia/Dhaka',                      taxIdLabel: 'TIN',   taxName: 'VAT' },
  LK: { locale: 'en-LK', currency: 'LKR', tz: 'Asia/Colombo',                    taxIdLabel: 'TIN',   taxName: 'VAT' },
  NP: { locale: 'ne-NP', currency: 'NPR', tz: 'Asia/Kathmandu',                  taxIdLabel: 'TIN',   taxName: 'VAT' },
  EG: { locale: 'ar-EG', currency: 'EGP', tz: 'Africa/Cairo',                    taxIdLabel: 'TIN',   taxName: 'VAT' },
  IL: { locale: 'he-IL', currency: 'ILS', tz: 'Asia/Jerusalem',                                                      taxName: 'VAT' },
  TR: { locale: 'tr-TR', currency: 'TRY', tz: 'Europe/Istanbul',                 taxIdLabel: 'VKN',   taxName: 'KDV' },
  IR: { locale: 'fa-IR', currency: 'IRR', tz: 'Asia/Tehran',                     taxIdLabel: 'Economic Code', taxName: 'VAT',
    localeOptions: {
      currencyDisplay: ['rial', 'toman', 'toman_short'],
      digits: ['locale', 'latin'],
      calendar: ['locale', 'persian', 'gregorian'],
    } },
};

function build(code: string): Country {
  const r = SUPPORTED[code];
  return {
    code,
    name: dn.of(code) ?? code,
    currency: r.currency,
    timezone: r.tz,
    dialCode: (() => { try { return `+${getCountryCallingCode(code as CountryCode)}`; } catch { return '+1'; } })(),
    locale: r.locale,
    taxIdLabel: r.taxIdLabel,
    taxName: r.taxName,
    taxIdFormat: r.taxIdFormat,
    localeOptions: r.localeOptions,
  };
}

export const COUNTRIES: Country[] = Object.keys(SUPPORTED)
  .map(build)
  .sort((a, b) => {
    if (a.code === 'IN') return -1;
    if (b.code === 'IN') return 1;
    if (a.code === 'AR') return -1;
    if (b.code === 'AR') return 1;
    return a.name.localeCompare(b.name);
  });

export const getCountryByCode = (code: string): Country | undefined => {
  if (!code) return undefined;
  return COUNTRIES.find((c) => c.code === code.toUpperCase());
};

export const getCurrencySymbol = (currency: string, locale = 'en-US'): string => {
  if (!currency) return currency;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
};

/**
 * Iran/Persian display preferences. Storage is never affected: monetary
 * values are always persisted in the tenant's currency code (IRR for Iran,
 * i.e. Rial) and these options only change how values are *rendered*.
 *
 * - `currencyDisplay`: `rial` (default) renders the stored unit verbatim;
 *   `toman` divides by 10 (1 Toman = 10 Rial) and suffixes `تومان`;
 *   `toman_short` divides by 10 and suffixes `ت`/`T` (Persian/Latin digits).
 * - `digits`: `locale` (default) follows the locale's native digits
 *   (Persian for `fa-IR`); `latin` forces Western digits.
 * - `calendar`: `locale` (default) follows the locale's calendar (Shamsi for
 *   `fa-IR`); `persian` forces Shamsi; `gregorian` forces Gregorian.
 *
 * Toman conversion is display-only: product/payment inputs remain in the
 * stored unit (Rial) so no existing database value is ever reinterpreted.
 */
export type CurrencyDisplay = 'rial' | 'toman' | 'toman_short';
export type DigitMode = 'locale' | 'latin';
export type CalendarMode = 'locale' | 'persian' | 'gregorian';

export interface LocalePreferences {
  currencyDisplay?: CurrencyDisplay;
  digits?: DigitMode;
  calendar?: CalendarMode;
}

const IRAN_CURRENCY = 'IRR';
const TOMAN_PER_RIAL = 10;

const normalizePreferences = (prefs?: LocalePreferences): Required<LocalePreferences> => ({
  currencyDisplay: prefs?.currencyDisplay ?? 'rial',
  digits: prefs?.digits ?? 'locale',
  calendar: prefs?.calendar ?? 'locale',
});

export const formatCurrency = (amount: number, currency: string, locale = 'en-US'): string => {
  if (!currency) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
};

/**
 * Currency display with the Iran `currencyDisplay`/`digits` preferences
 * applied. Non-IRR currencies and the `rial` mode behave like
 * `formatCurrency` (plus the optional Latin-digit override).
 */
export const formatMoney = (
  amount: number,
  currency: string,
  locale = 'en-US',
  prefs?: LocalePreferences,
): string => {
  const { currencyDisplay, digits } = normalizePreferences(prefs);
  const numberingSystem = digits === 'latin' ? 'latn' : undefined;

  if (currency === IRAN_CURRENCY && currencyDisplay !== 'rial') {
    // 1 Toman = 10 Rial; divide for display only, never for storage.
    const toman = amount / TOMAN_PER_RIAL;
    if (currencyDisplay === 'toman') {
      return `${formatNumber(toman, locale, numberingSystem)} تومان`;
    }
    // toman_short — colloquial shorthand, Persian/Latin suffix by digit mode.
    return `${formatNumber(toman, locale, numberingSystem)}${digits === 'latin' ? 'T' : 'ت'}`;
  }

  if (!currency) return formatNumber(amount, locale, numberingSystem);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      numberingSystem,
    }).format(amount);
  } catch {
    return `${currency} ${formatNumber(amount, locale, numberingSystem)}`;
  }
};

export interface CurrencyUnitAdapter {
  scale: number;
  label: string;
  step: string;
  maxDecimals: number;
  toDisplay: (storedAmount: number) => number;
  toStored: (displayAmount: number) => number;
  formatInput: (displayAmount: number) => string;
}

/**
 * Returns a centralized adapter for handling input/display unit conversions
 * across all currencies and tenant display preferences (e.g. Rial vs Toman).
 */
export const getCurrencyUnitAdapter = (
  currency: string,
  countryCode?: string,
  prefs?: LocalePreferences,
): CurrencyUnitAdapter => {
  const { currencyDisplay, digits } = normalizePreferences(prefs);
  if (currency === IRAN_CURRENCY && currencyDisplay !== 'rial') {
    const label = currencyDisplay === 'toman_short'
      ? (digits === 'latin' ? 'T' : 'ت')
      : 'تومان';
    return {
      scale: 0.1,
      label,
      step: '0.001',
      maxDecimals: 3,
      toDisplay: (storedAmount: number) => Number((storedAmount / TOMAN_PER_RIAL).toFixed(4)),
      toStored: (displayAmount: number) => Number((displayAmount * TOMAN_PER_RIAL).toFixed(2)),
      formatInput: (displayAmount: number) => String(Number(displayAmount.toFixed(3))),
    };
  }

  return {
    scale: 1,
    label: currency,
    step: '0.01',
    maxDecimals: 2,
    toDisplay: (storedAmount: number) => Number(storedAmount.toFixed(2)),
    toStored: (displayAmount: number) => Number(displayAmount.toFixed(2)),
    formatInput: (displayAmount: number) => String(Number(displayAmount.toFixed(2))),
  };
};

export const formatCurrencyForTenant = (
  amount: number,
  countryCode: string | undefined,
  currency: string,
  prefs?: LocalePreferences,
): string => formatMoney(amount, currency, getCountryByCode(countryCode ?? 'IN')?.locale ?? 'en-US', prefs);

/**
 * Formats a plain (non-currency) number using the given locale's digits and
 * grouping (e.g. `1234.5` → `۱٬۲۳۴٫۵` in `fa-IR`). Used for counts, points,
 * and other bare numbers so they follow the tenant locale instead of the
 * browser's default locale.
 */
export const formatNumber = (value: number, locale = 'en-US', numberingSystem?: string): string => {
  try {
    return new Intl.NumberFormat(locale, numberingSystem ? { numberingSystem } : undefined).format(value);
  } catch {
    return String(value);
  }
};

/**
 * Formats a plain number using the tenant's country locale and digit
 * preference. Mirrors `formatCurrencyForTenant` for non-monetary values.
 */
export const formatNumberForTenant = (
  value: number,
  countryCode: string | undefined,
  prefs?: LocalePreferences,
): string => {
  const { digits } = normalizePreferences(prefs);
  return formatNumber(
    value,
    getCountryByCode(countryCode ?? 'IN')?.locale ?? 'en-US',
    digits === 'latin' ? 'latn' : undefined,
  );
};

function calendarOption(calendar: CalendarMode): 'gregory' | 'persian' | undefined {
  if (calendar === 'gregorian') return 'gregory';
  if (calendar === 'persian') return 'persian';
  return undefined;
}

/**
 * Formats a date with the tenant's locale, timezone, and calendar/digit
 * preferences. Dates are stored as UTC timestamps; this is display-only.
 */
export const formatDateForTenant = (
  date: Date,
  countryCode: string | undefined,
  timezone: string,
  prefs?: LocalePreferences,
  options: Intl.DateTimeFormatOptions = {},
): string => {
  const { digits, calendar } = normalizePreferences(prefs);
  const locale = getCountryByCode(countryCode ?? 'IN')?.locale ?? 'en-US';
  const numberingSystem = digits === 'latin' ? 'latn' : undefined;
  const calendarValue = calendarOption(calendar);
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      ...(numberingSystem ? { numberingSystem } : {}),
      ...(calendarValue ? { calendar: calendarValue } : {}),
      ...options,
    }).format(date);
  } catch {
    return date.toISOString();
  }
};

export const countryName = (code: string): string => dn.of(code.toUpperCase()) ?? code;

export const DEFAULT_COUNTRY_PROFILE = {
  dialCode: '+1',
  locale: 'en-US',
  taxIdLabel: 'Tax ID',
  taxName: 'Tax',
} as const;
