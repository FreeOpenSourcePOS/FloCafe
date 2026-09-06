import {
  parsePhoneNumber,
  getCountryCallingCode,
  type CountryCode,
} from 'libphonenumber-js';

export interface NormalizedPhoneResult {
  valid: boolean;
  e164: string | null;
  digits: string | null;
  countryCode: string | null;
  error?: string;
}

/** Parse + return e164, digits, and country code (e.g. `'+91'`). null when invalid or unparseable. */
export function parsePhone(
  input: string | null | undefined,
  defaultCountry: string = 'IN'
): { e164: string; countryCode: string; digits: string } | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  try {
    const parsed = parsePhoneNumber(raw, {
      defaultCountry: (defaultCountry || 'IN').toUpperCase() as CountryCode,
      extract: false,
    });
    if (!parsed?.isValid()) return null;
    return {
      e164: parsed.number,
      countryCode: `+${parsed.countryCallingCode}`,
      digits: parsed.nationalNumber,
    };
  } catch {
    return null;
  }
}

/** Normalizes optional phone input; returns valid with null fields
 * when empty, or validates against defaultCountry. */
export function normalizeOptionalPhone(
  input: unknown,
  defaultCountry: string = 'IN'
): NormalizedPhoneResult {
  if (input === null || input === undefined) {
    return { valid: true, e164: null, digits: null, countryCode: null };
  }
  const raw = String(input).trim();
  if (!raw) {
    return { valid: true, e164: null, digits: null, countryCode: null };
  }
  const parsed = parsePhone(raw, defaultCountry);
  if (!parsed) {
    return {
      valid: false,
      e164: null,
      digits: null,
      countryCode: null,
      error: 'Invalid phone number format. Please provide a valid phone number with optional country code.',
    };
  }
  return {
    valid: true,
    e164: parsed.e164,
    digits: parsed.digits,
    countryCode: parsed.countryCode,
  };
}

/** ISO code → calling code (`'IN' → '+91'`). Returns empty string when unknown or empty. */
export function dialCodeFor(code: string): string {
  if (!code) return '';
  try {
    return `+${getCountryCallingCode(code.toUpperCase() as CountryCode)}`;
  } catch {
    return '';
  }
}

/** Format phone for display or return original string */
export function formatPhoneDisplay(phone: string | null | undefined, defaultCountry: string = 'IN'): string {
  if (!phone) return '';
  const parsed = parsePhone(phone, defaultCountry);
  return parsed?.e164 || phone;
}
