import { useAuthStore } from '@/store/auth';
import { formatCurrencyForTenant } from '@/lib/countries';

export function useFormatCurrency() {
  const country = useAuthStore((s) => s.currentTenant?.country);
  const currency = useAuthStore((s) => s.currentTenant?.currency ?? 'INR');
  return (n: number) => formatCurrencyForTenant(n, country, currency);
}
