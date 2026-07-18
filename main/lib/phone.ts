import { parsePhoneNumber, type CountryCode } from 'libphonenumber-js';

export function parsePhoneE164(input: string, defaultCountry: string): { e164: string; countryCode: string } | null {
  try {
    const parsed = parsePhoneNumber(input, { defaultCountry: defaultCountry as CountryCode, extract: false });
    if (!parsed?.isValid()) return null;
    return { e164: parsed.number, countryCode: `+${parsed.countryCallingCode}` };
  } catch {
    return null;
  }
}

export function stripPhoneDigits(input: string): string {
  return String(input || '').replace(/\D/g, '');
}
