/** Tracks whether store country was user-chosen or defaulted, with OS locale signals. */

import { app } from 'electron';
import { getSettingValue } from '../db';

export type CountrySource = 'user' | 'default';

export interface CountryProvenance {
  /** The configured country, or null when nobody has confirmed one. */
  country: string | null;
  countrySource: CountrySource;
  osCountry: string | null;
  osLocale: string | null;
  osTimezone: string | null;
}

function normalizeCountry(value: string | null | undefined): string | null {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Returns true if a user has explicitly confirmed or changed the store's country. */
export function isCountryConfirmed(): boolean {
  return (getSettingValue('country_confirmed_at') || '').trim() !== '';
}

/** Safely reads the operating system's region, locale, and timezone. */
function readOsLocale(): Pick<CountryProvenance, 'osCountry' | 'osLocale' | 'osTimezone'> {
  let osCountry: string | null = null;
  let osLocale: string | null = null;
  let osTimezone: string | null = null;

  try {
    osCountry = normalizeCountry(app?.getLocaleCountryCode?.());
  } catch { /* signal unavailable */ }
  try {
    const locale = String(app?.getLocale?.() || '').trim();
    osLocale = locale !== '' ? locale.slice(0, 35) : null;
  } catch { /* signal unavailable */ }
  try {
    const zone = String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim();
    osTimezone = zone !== '' ? zone.slice(0, 100) : null;
  } catch { /* signal unavailable */ }

  return { osCountry, osLocale, osTimezone };
}

export function readCountryProvenance(): CountryProvenance {
  const confirmed = isCountryConfirmed();
  return {
    // Withheld when unconfirmed so remote registry preserves existing values.
    country: confirmed ? normalizeCountry(getSettingValue('country')) : null,
    countrySource: confirmed ? 'user' : 'default',
    ...readOsLocale(),
  };
}

/** Generates a settings patch stamping country confirmation if explicitly chosen or changed. */
export function countryConfirmationPatch(
  submitted: unknown,
  stored: string | null | undefined,
  explicit?: unknown
): Record<string, string> {
  const stamp = { country_confirmed_at: new Date().toISOString() };
  if (explicit === true) return stamp;

  const code = normalizeCountry(typeof submitted === 'string' ? submitted : null);
  if (!code) return {};
  return code === normalizeCountry(stored) ? {} : stamp;
}
