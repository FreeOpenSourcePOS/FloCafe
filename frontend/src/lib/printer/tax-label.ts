import { getCountryByCode, DEFAULT_COUNTRY_PROFILE } from '@/lib/countries';

/**
 * Resolve the tax-id label printed on receipts. Explicit label wins, else
 * look up by ISO country code via the shared country profile, else fall
 * back to the default label.
 */
export function resolveTaxIdLabel(country?: string, taxIdLabel?: string): string {
  if (taxIdLabel) return taxIdLabel;
  return getCountryByCode((country ?? '').toUpperCase())?.taxIdLabel || DEFAULT_COUNTRY_PROFILE.taxIdLabel;
}