import { useAuthStore } from '@/store/auth';
import type { AmountFormat } from '@/lib/currency-input';

/** The store's regional snapshot separators, for CurrencyAmountInput. Falls back to a
 * neutral en-US-shaped format only when the snapshot hasn't reached the tenant yet. */
export function useAmountFormat(): AmountFormat {
  const tenant = useAuthStore((s) => s.currentTenant);
  return {
    decimalSeparator: tenant?.decimal_separator || '.',
    groupSeparator: tenant?.group_separator ?? ',',
    currencyFractionDigits: tenant?.currency_fraction_digits ?? 2,
  };
}
