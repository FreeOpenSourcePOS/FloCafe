import { useAuthStore } from '@/store/auth';
import { getCurrencyUnitAdapter, type CurrencyUnitAdapter } from '@/lib/countries';

export function useCurrencyUnitAdapter(): CurrencyUnitAdapter {
  const tenant = useAuthStore((s) => s.currentTenant);
  const currency = tenant?.currency ?? 'INR';
  const country = tenant?.country;
  const prefs = {
    currencyDisplay: tenant?.currency_display,
    digits: tenant?.number_digits,
  };
  return getCurrencyUnitAdapter(currency, country, prefs);
}
