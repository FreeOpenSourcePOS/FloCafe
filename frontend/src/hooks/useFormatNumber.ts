import { useAuthStore } from '@/store/auth';
import { formatNumberForTenant } from '@/lib/countries';

/**
 * Returns a formatter for plain (non-currency) numbers using the current
 * tenant's country locale, so counts/points render in the tenant's digits
 * and grouping (e.g. Persian digits for an Iranian tenant) instead of the
 * browser's default locale.
 */
export function useFormatNumber() {
  const country = useAuthStore((s) => s.currentTenant?.country);
  return (n: number) => formatNumberForTenant(n, country);
}
