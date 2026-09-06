import { getCountryByCode, DEFAULT_COUNTRY_PROFILE } from '@/lib/countries';

/** Resolve the tax-id label printed on receipts, falling back to country profile or default. */
export function resolveTaxIdLabel(country?: string, taxIdLabel?: string): string {
  if (taxIdLabel) return taxIdLabel;
  return getCountryByCode((country ?? '').toUpperCase())?.taxIdLabel || DEFAULT_COUNTRY_PROFILE.taxIdLabel;
}