/**
 * The one rule for the unit price a cart line shows.
 *
 * An online order with a selected platform quotes the variant's platform price,
 * exactly as the backend prices the order it becomes; a blank platform is a
 * counter order. Kept dependency-free so the cart store stays loadable in tests.
 */

import type { ProductVariant } from '@/lib/types';

const NON_TWO_DECIMAL_COUNTRY_CURRENCIES: Record<string, string> = {
  AF: 'AFN',
  AL: 'ALL',
  BH: 'BHD',
  CI: 'XOF',
  CL: 'CLP',
  CM: 'XAF',
  CO: 'COP',
  HU: 'HUF',
  ID: 'IDR',
  IQ: 'IQD',
  IS: 'ISK',
  JO: 'JOD',
  JP: 'JPY',
  KR: 'KRW',
  KW: 'KWD',
  LA: 'LAK',
  LB: 'LBP',
  MM: 'MMK',
  OM: 'OMR',
  PK: 'PKR',
  PY: 'PYG',
  RS: 'RSD',
  RW: 'RWF',
  SN: 'XOF',
  TN: 'TND',
  UG: 'UGX',
  VN: 'VND',
  YE: 'YER',
};

function currencyFractionDigits(currencyOrCountry: string): number {
  const trimmed = currencyOrCountry.trim().toUpperCase();
  if (!trimmed) return 2;
  const currency =
    trimmed.length === 2 ? NON_TWO_DECIMAL_COUNTRY_CURRENCIES[trimmed] || trimmed : trimmed;
  if (currency === 'COP') return 0;
  if (currency === 'IRR') return 2;
  if (!/^[A-Z]{3}$/.test(currency)) return 2;
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function decimalsFromTenantRecord(tenant: unknown): number | null {
  if (!tenant || typeof tenant !== 'object') return null;
  const record = tenant as Record<string, unknown>;
  const explicitDigits = record.currency_fraction_digits ?? record.currencyFractionDigits;
  if (
    typeof explicitDigits === 'number' &&
    Number.isInteger(explicitDigits) &&
    explicitDigits >= 0 &&
    explicitDigits <= 4
  ) {
    return explicitDigits;
  }
  if (typeof record.currency === 'string' && record.currency.trim()) {
    return currencyFractionDigits(record.currency);
  }
  if (typeof record.country === 'string' && record.country.trim()) {
    return currencyFractionDigits(record.country);
  }
  return null;
}

function getSafeLocalStorage(): { getItem: (key: string) => string | null } | null {
  try {
    if (typeof window === 'undefined') {
      const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
      if (!desc || !('value' in desc)) return null;
      const val = desc.value as { getItem?: (key: string) => string | null } | null | undefined;
      return val && typeof val.getItem === 'function'
        ? (val as { getItem: (key: string) => string | null })
        : null;
    }
    const storage = globalThis.localStorage;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

export function resolveActiveCurrencyDecimals(decimalsOrCurrency?: number | string): number {
  if (
    typeof decimalsOrCurrency === 'number' &&
    Number.isInteger(decimalsOrCurrency) &&
    decimalsOrCurrency >= 0 &&
    decimalsOrCurrency <= 4
  ) {
    return decimalsOrCurrency;
  }
  if (typeof decimalsOrCurrency === 'string' && decimalsOrCurrency.trim()) {
    return currencyFractionDigits(decimalsOrCurrency);
  }

  try {
    const storage = getSafeLocalStorage();
    if (storage) {
      for (const key of ['tenant', 'pos-auth']) {
        const raw = storage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        const state =
          parsed?.state && typeof parsed.state === 'object'
            ? (parsed.state as Record<string, unknown>)
            : null;
        const candidate =
          state?.currentTenant ??
          state?.tenant ??
          parsed?.currentTenant ??
          parsed?.tenant ??
          parsed;
        const resolved = decimalsFromTenantRecord(candidate);
        if (resolved !== null) return resolved;
      }
    }
  } catch {
    // Ignore storage read errors in non-browser or restricted environments.
  }

  try {
    const req = typeof require === 'function' ? require : undefined;
    const cache = req?.cache as Record<string, { exports?: Record<string, unknown> }> | undefined;
    if (cache) {
      for (const [key, mod] of Object.entries(cache)) {
        const authStore = mod?.exports?.useAuthStore as
          | { getState?: () => { currentTenant?: unknown; tenant?: unknown } }
          | undefined;
        if (typeof authStore?.getState === 'function') {
          const state = authStore.getState();
          const resolved = decimalsFromTenantRecord(state?.currentTenant ?? state?.tenant);
          if (resolved !== null) return resolved;
        }
        if (
          (key.endsWith('/main/db.ts') ||
            key.endsWith('/main/db.js') ||
            key.endsWith('\\main\\db.ts') ||
            key.endsWith('\\main\\db.js')) &&
          typeof mod?.exports?.getSettingValue === 'function'
        ) {
          const getSettingValue = mod.exports.getSettingValue as (k: string) => string | null;
          const currency = getSettingValue('currency');
          if (typeof currency === 'string' && currency.trim()) {
            return currencyFractionDigits(currency);
          }
          const country = getSettingValue('country');
          if (typeof country === 'string' && country.trim()) {
            return currencyFractionDigits(country);
          }
        }
      }
    }
  } catch {
    // Ignore module cache inspection errors when database or store is uninitialized.
  }

  return 2;
}

export function roundMoney(
  n: number,
  decimals: number | string = resolveActiveCurrencyDecimals(),
): number {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  const places = resolveActiveCurrencyDecimals(decimals);
  const sign = num < 0 ? -1 : 1;
  const [mantissa, exp = '0'] = Math.abs(num).toString().toLowerCase().split('e');
  const shifted = Number(`${mantissa}e${Number(exp) + places}`);
  const rounded = Number(`${Math.round(shifted)}e-${places}`);
  return rounded === 0 ? 0 : sign * rounded;
}

export const roundCartMoney = roundMoney;

export function clampCartPriceOverride(
  rawPrice: unknown,
  baseUnitPrice?: unknown,
  decimalsOrCurrency?: number | string,
): number | null {
  if (
    rawPrice === null ||
    rawPrice === undefined ||
    rawPrice === '' ||
    typeof rawPrice === 'boolean'
  ) {
    return null;
  }
  const num = Number(rawPrice);
  if (!Number.isFinite(num) || num < 0) return null;
  const effectiveCurrency =
    decimalsOrCurrency !== undefined
      ? decimalsOrCurrency
      : typeof baseUnitPrice === 'string' && /^[A-Za-z]{2,3}$/.test(baseUnitPrice.trim())
        ? baseUnitPrice
        : undefined;
  const decimals = resolveActiveCurrencyDecimals(effectiveCurrency);
  return roundMoney(num, decimals);
}

export function normalizeOverridePrice(
  price: number | string,
  decimals: number | string = resolveActiveCurrencyDecimals(),
): number {
  const num = Number(price);
  if (!Number.isFinite(num) || num < 0) return 0;
  return roundMoney(num, decimals);
}

export function cartLineUnitPrice(
  item: {
    variant?: ProductVariant | null;
    product: { price: number | string };
    price_override?: { price: number } | null;
  },
  onlinePlatformSelected: boolean,
  decimalsOrCurrency?: number | string,
): number {
  return item.price_override
    ? normalizeOverridePrice(item.price_override.price, decimalsOrCurrency)
    : cartVariantUnitPrice(item, onlinePlatformSelected);
}

export function cartVariantUnitPrice(
  item: { variant?: ProductVariant | null; product: { price: number | string } },
  onlinePlatformSelected: boolean,
): number {
  const platformPrice = onlinePlatformSelected ? item.variant?.online_price : null;
  return Number(platformPrice ?? item.variant?.price ?? item.product.price) || 0;
}
