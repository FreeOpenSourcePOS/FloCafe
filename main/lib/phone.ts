import { parsePhoneNumber, type CountryCode } from 'libphonenumber-js';

export function parsePhoneE164(input: string, defaultCountry: string): { e164: string; countryCode: string } | null {
  try {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const country = (defaultCountry || 'IN').toUpperCase() as CountryCode;
    const parsed = parsePhoneNumber(raw, { defaultCountry: country, extract: false });
    if (!parsed?.isValid()) return null;
    return { e164: parsed.number, countryCode: `+${parsed.countryCallingCode}` };
  } catch {
    return null;
  }
}

export function stripPhoneDigits(input: string): string {
  return String(input || '').replace(/\D/g, '');
}

export type NormalizedPhoneResult = {
  valid: boolean;
  e164: string | null;
  countryCode: string | null;
  error?: string;
};

export function normalizeOptionalPhone(input: unknown, defaultCountry = 'IN'): NormalizedPhoneResult {
  if (input === undefined || input === null) {
    return { valid: true, e164: null, countryCode: null };
  }
  const raw = String(input).trim();
  if (raw === '') {
    return { valid: true, e164: null, countryCode: null };
  }
  const parsed = parsePhoneE164(raw, defaultCountry);
  if (!parsed) {
    return {
      valid: false,
      e164: null,
      countryCode: null,
      error: 'Invalid phone number format. Please provide a valid phone number with optional country code.',
    };
  }
  return { valid: true, e164: parsed.e164, countryCode: parsed.countryCode };
}
