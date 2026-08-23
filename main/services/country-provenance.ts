/**
 * How much a store's configured country is actually worth.
 *
 * `settings.country` is seeded to 'IN' by seedInstallDefaults() at install, so
 * reading it tells you nothing about whether anyone chose India. Every consumer
 * that treats it as the store's location — cloud registration, telemetry — was
 * therefore reporting India for every install on earth that had not yet
 * finished the setup wizard. On FloAdmin that turned into two installs of one
 * Dominican restaurant appearing as India and the Dominican Republic, and into
 * 19 stores across 15 countries filed under India.
 *
 * This module answers two separate questions that were previously conflated:
 *
 *   "what did the merchant choose?"  → country + source, where source is
 *                                      'default' until a human sets it
 *   "where is this machine?"         → the OS's own region/locale/timezone,
 *                                      which no install default can fake
 *
 * It deliberately does NOT change what `settings.country` returns. Tax packs,
 * currency formatting and printing all key off it and all need a concrete value
 * to behave at all; 'IN' as a working default is fine for them. The problem was
 * only ever reporting that default outward as fact.
 */

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

/**
 * Has a human ever set this store's country?
 *
 * Only `country_confirmed_at` counts, and only countryConfirmationPatch() below
 * writes it. Completing onboarding deliberately does NOT: the setup wizard
 * preselects IN in its country picker and submits it whether or not anyone
 * touches the control, so treating setup completion as proof of a choice would
 * launder the install default into "the merchant chose India" — the exact bug
 * this module exists to stop.
 *
 * An install that genuinely chose a country but predates the stamp reports as
 * unconfirmed until someone next saves a country. That withholds the country
 * from registration, which is harmless: FloAdmin COALESCEs, so it keeps the
 * value it already has. Under-claiming is the safe direction here — the OS and
 * geo signals arbitrate, and a wrong "the merchant chose this" is far more
 * expensive than a missing one.
 */
export function isCountryConfirmed(): boolean {
  return (getSettingValue('country_confirmed_at') || '').trim() !== '';
}

/**
 * The operating system's own region, locale and timezone.
 *
 * Wrapped because none of it is worth failing a registration over: under the
 * test stub, an older Electron, or a stripped Linux environment any of these
 * can be missing or throw, and a null just means one signal is unavailable.
 */
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
    // Withheld rather than guessed when unconfirmed: FloAdmin's register
    // handler COALESCEs, so null leaves whatever it already knows untouched
    // instead of overwriting it with an install default.
    country: confirmed ? normalizeCountry(getSettingValue('country')) : null,
    countrySource: confirmed ? 'user' : 'default',
    ...readOsLocale(),
  };
}

/**
 * Settings patch that records a country as human-chosen — empty when the
 * submission is not evidence of a choice.
 *
 * Both places a country can be saved submit one unconditionally: the setup
 * wizard preselects IN, and Settings → Business PUTs its whole form, so a
 * merchant saving their phone number re-sends the country untouched. Presence
 * of the field therefore proves nothing, and stamping on presence would mark
 * every install as having chosen India.
 *
 * A change from the stored value is affirmative — nothing else moves it. The
 * case this cannot see is a merchant who deliberately picks the country already
 * selected; `explicit` exists for clients that can report that interaction
 * directly. Absent such a signal that merchant stays unconfirmed, which is
 * accurate: from here it is indistinguishable from one who never looked.
 */
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
