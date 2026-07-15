import { useAuthStore } from '@/store/auth';
import { formatCurrencyForTenant } from '@/lib/countries';

export function useFormatCurrency() {
  const { country, currency } = useAuthStore((s) => ({
    country: s.currentTenant?.country,
    currency: s.currentTenant?.currency ?? 'INR',
  }));
  return (n: number) => formatCurrencyForTenant(n, country, currency);
}
