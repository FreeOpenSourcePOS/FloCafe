import { useAuthStore } from '@/store/auth';
import { formatNumberForTenant } from '@/lib/countries';

/** Returns formatter for plain numbers using tenant's country locale
 * and configured digit preferences. */
export function useFormatNumber() {
  const tenant = useAuthStore((s) => s.currentTenant);
  return (n: number) => formatNumberForTenant(n, tenant?.country, { digits: tenant?.number_digits });
}
