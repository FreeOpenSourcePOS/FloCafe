import { useCallback } from 'react';
import { useAuthStore } from '@/store/auth';
import { formatDateForTenant } from '@/lib/countries';
import { parseDbTimestamp } from '@/lib/utils';

// String timestamps arrive in the DB's UTC space form (`YYYY-MM-DD HH:MM:SS`);
// V8's legacy parser reads that form as machine-local, so only Date/number
// inputs may use `new Date` directly.
function toDate(date: string | Date | number): Date {
  return typeof date === 'string' ? parseDbTimestamp(date) : new Date(date);
}

export function useFormatDate() {
  const currentTenant = useAuthStore((s) => s.currentTenant);

  const country = currentTenant?.country;
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const prefs = {
    calendar: currentTenant?.calendar,
    digits: currentTenant?.number_digits,
  };

  const format = useCallback((
    date: string | Date | number | null | undefined,
    options: Intl.DateTimeFormatOptions = {},
  ): string => {
    if (!date) return '';
    const d = toDate(date);
    if (isNaN(d.getTime())) return String(date);
    return formatDateForTenant(d, country, timeZone, prefs, options);
  }, [country, timeZone, currentTenant?.calendar, currentTenant?.number_digits]);

  const formatDate = useCallback((date?: string | Date | number | null, options?: Intl.DateTimeFormatOptions) =>
    format(date, { year: 'numeric', month: 'short', day: 'numeric', ...options }),
  [format]);

  const formatTime = useCallback((date?: string | Date | number | null, options?: Intl.DateTimeFormatOptions) =>
    format(date, { hour: '2-digit', minute: '2-digit', ...options }),
  [format]);

  const formatDateTime = useCallback((date?: string | Date | number | null, options?: Intl.DateTimeFormatOptions) =>
    format(date, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', ...options }),
  [format]);

  return { formatDate, formatTime, formatDateTime };
}
