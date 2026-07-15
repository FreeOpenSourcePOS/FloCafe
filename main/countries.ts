import { getCountryCallingCode, type CountryCode } from 'libphonenumber-js';

export interface Country {
  code: string;
  name: string;
  currency: string;
  timezone: string;
  dialCode: string;
  locale: string;
  defaultLanguage: string;
  taxIdLabel?: string;
  taxName?: string;
  documentTitle?: string;
}

const dn = new Intl.DisplayNames(['en'], { type: 'region' });

interface Row {
  locale: string;
  currency: string;
  tz: string;
  taxIdLabel?: string;
  taxName?: string;
  documentTitle?: string;
}

const SUPPORTED: Record<string, Row> = {
  IN: { locale: 'en-IN', currency: 'INR', tz: 'Asia/Kolkata',                    taxIdLabel: 'GSTIN', taxName: 'GST',       documentTitle: 'Tax Invoice' },
  AR: { locale: 'es-AR', currency: 'ARS', tz: 'America/Argentina/Buenos_Aires',  taxIdLabel: 'CUIT',  taxName: 'IVA',       documentTitle: 'Comprobante' },
  US: { locale: 'en-US', currency: 'USD', tz: 'America/New_York',                taxIdLabel: 'EIN',   taxName: 'Sales Tax', documentTitle: 'Invoice' },
  CA: { locale: 'en-CA', currency: 'CAD', tz: 'America/Toronto',                 taxIdLabel: 'BN',    taxName: 'GST/HST' },
  GB: { locale: 'en-GB', currency: 'GBP', tz: 'Europe/London',                   taxIdLabel: 'VAT',   taxName: 'VAT' },
  TH: { locale: 'th-TH', currency: 'THB', tz: 'Asia/Bangkok',                    taxIdLabel: 'Tax ID',taxName: 'VAT' },
  SG: { locale: 'en-SG', currency: 'SGD', tz: 'Asia/Singapore',                  taxIdLabel: 'UEN',   taxName: 'GST' },
  MY: { locale: 'ms-MY', currency: 'MYR', tz: 'Asia/Kuala_Lumpur',                                                     taxName: 'SST' },
  ID: { locale: 'id-ID', currency: 'IDR', tz: 'Asia/Jakarta',                    taxIdLabel: 'NPWP',  taxName: 'VAT' },
  PH: { locale: 'en-PH', currency: 'PHP', tz: 'Asia/Manila',                     taxIdLabel: 'TIN',   taxName: 'VAT' },
  VN: { locale: 'vi-VN', currency: 'VND', tz: 'Asia/Ho_Chi_Minh',                taxIdLabel: 'MST',   taxName: 'VAT' },
  AU: { locale: 'en-AU', currency: 'AUD', tz: 'Australia/Sydney',                taxIdLabel: 'ABN',   taxName: 'GST',       documentTitle: 'Tax Invoice' },
  NZ: { locale: 'en-NZ', currency: 'NZD', tz: 'Pacific/Auckland',                taxIdLabel: 'IRD',   taxName: 'GST',       documentTitle: 'Tax Invoice' },
  AE: { locale: 'ar-AE', currency: 'AED', tz: 'Asia/Dubai',                      taxIdLabel: 'TRN',   taxName: 'VAT',       documentTitle: 'Tax Invoice' },
  SA: { locale: 'ar-SA', currency: 'SAR', tz: 'Asia/Riyadh',                     taxIdLabel: 'VAT',   taxName: 'VAT',       documentTitle: 'Tax Invoice' },
  ZA: { locale: 'en-ZA', currency: 'ZAR', tz: 'Africa/Johannesburg',             taxIdLabel: 'VAT',   taxName: 'VAT' },
  KE: { locale: 'en-KE', currency: 'KES', tz: 'Africa/Nairobi',                  taxIdLabel: 'PIN',   taxName: 'VAT' },
  NG: { locale: 'en-NG', currency: 'NGN', tz: 'Africa/Lagos',                    taxIdLabel: 'TIN',   taxName: 'VAT' },
  BR: { locale: 'pt-BR', currency: 'BRL', tz: 'America/Sao_Paulo',               taxIdLabel: 'CNPJ',  taxName: 'ICMS',      documentTitle: 'Nota Fiscal' },
  MX: { locale: 'es-MX', currency: 'MXN', tz: 'America/Mexico_City',             taxIdLabel: 'RFC',   taxName: 'IVA',       documentTitle: 'Factura' },
  CL: { locale: 'es-CL', currency: 'CLP', tz: 'America/Santiago',                taxIdLabel: 'RUT',   taxName: 'IVA',       documentTitle: 'Boleta' },
  UY: { locale: 'es-UY', currency: 'UYU', tz: 'America/Montevideo',              taxIdLabel: 'RUT',   taxName: 'IVA',       documentTitle: 'Comprobante' },
  PY: { locale: 'es-PY', currency: 'PYG', tz: 'America/Asuncion',                taxIdLabel: 'RUC',   taxName: 'IVA',       documentTitle: 'Comprobante' },
  JP: { locale: 'ja-JP', currency: 'JPY', tz: 'Asia/Tokyo',                                                            taxName: 'VAT' },
  KR: { locale: 'ko-KR', currency: 'KRW', tz: 'Asia/Seoul',                      taxIdLabel: 'BRN',   taxName: 'VAT' },
  CN: { locale: 'zh-CN', currency: 'CNY', tz: 'Asia/Shanghai',                   taxIdLabel: 'USCC',  taxName: 'VAT' },
  HK: { locale: 'zh-HK', currency: 'HKD', tz: 'Asia/Hong_Kong' },
  TW: { locale: 'zh-TW', currency: 'TWD', tz: 'Asia/Taipei',                     taxIdLabel: 'UBN',   taxName: 'VAT' },
  PK: { locale: 'en-PK', currency: 'PKR', tz: 'Asia/Karachi',                    taxIdLabel: 'NTN',   taxName: 'GST' },
  BD: { locale: 'bn-BD', currency: 'BDT', tz: 'Asia/Dhaka',                      taxIdLabel: 'TIN',   taxName: 'VAT' },
  LK: { locale: 'en-LK', currency: 'LKR', tz: 'Asia/Colombo',                    taxIdLabel: 'TIN',   taxName: 'VAT' },
  NP: { locale: 'ne-NP', currency: 'NPR', tz: 'Asia/Kathmandu',                  taxIdLabel: 'TIN',   taxName: 'VAT' },
  EG: { locale: 'ar-EG', currency: 'EGP', tz: 'Africa/Cairo',                    taxIdLabel: 'TIN',   taxName: 'VAT',       documentTitle: 'Tax Invoice' },
  IL: { locale: 'he-IL', currency: 'ILS', tz: 'Asia/Jerusalem',                                                      taxName: 'VAT' },
  TR: { locale: 'tr-TR', currency: 'TRY', tz: 'Europe/Istanbul',                 taxIdLabel: 'VKN',   taxName: 'KDV' },
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
    defaultLanguage: r.locale.split('-')[0],
    taxIdLabel: r.taxIdLabel,
    taxName: r.taxName,
    documentTitle: r.documentTitle,
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
    return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'symbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
};

export const formatCurrency = (amount: number, currency: string, locale = 'en-US'): string => {
  if (!currency) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
};

export const countryName = (code: string): string => dn.of(code.toUpperCase()) ?? code;

export const countryFlag = (code: string): string =>
  /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65))) : '';

export const DEFAULT_COUNTRY_PROFILE = {
  dialCode: '+1',
  locale: 'en-US',
  defaultLanguage: 'en',
  taxIdLabel: 'Tax ID',
  taxName: 'Tax',
  documentTitle: 'Receipt',
} as const;
