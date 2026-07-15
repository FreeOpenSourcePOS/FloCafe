import {
  parsePhoneNumber,
  getCountryCallingCode,
  type CountryCode,
} from 'libphonenumber-js';

/** Parse + return both e164 and the parsed number's actual country code (e.g. `'+91'`). null when invalid or unparseable. */
export function parsePhone(input: string, defaultCountry: string): { e164: string; countryCode: string } | null {
  try {
    const parsed = parsePhoneNumber(input, { defaultCountry: defaultCountry as CountryCode, extract: false });
    if (!parsed?.isValid()) return null;
    return { e164: parsed.number, countryCode: `+${parsed.countryCallingCode}` };
  } catch {
    return null;
  }
}

/** ISO code → calling code (`'IN' → '+91'`). Returns empty string when unknown. */
export function dialCodeFor(code: string): string {
  try {
    return `+${getCountryCallingCode(code as CountryCode)}`;
  } catch {
    return '';
  }
}
