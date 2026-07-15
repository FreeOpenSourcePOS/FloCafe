import {
  parsePhoneNumber,
  getCountryCallingCode,
  type CountryCode,
} from 'libphonenumber-js';

/** E.164 string (`+CC...`) or null when the input cannot be parsed as a valid phone. */
export function toE164(input: string, defaultCountry: string): string | null {
  return parsePhoneNumber(input, { defaultCountry: defaultCountry as CountryCode, extract: false })?.number ?? null;
}

/** ISO code → calling code (`'IN' → '+91'`). Returns empty string when unknown. */
export function dialCodeFor(code: string): string {
  try {
    return `+${getCountryCallingCode(code as CountryCode)}`;
  } catch {
    return '';
  }
}
