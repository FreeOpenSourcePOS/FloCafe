import { useCallback } from 'react';
import { useAuthStore } from '@/store/auth';
import { getCountryByCode } from '@/lib/countries';
import { parseDbTimestamp } from '@/lib/utils';

// String timestamps arrive in the DB's UTC space form (`YYYY-MM-DD HH:MM:SS`);
// V8's legacy parser reads that form as machine-local, so only Date/number
// inputs may use `new Date` directly.
function toDate(date: string | Date | number): Date {
  return typeof date === 'string' ? parseDbTimestamp(date) : new Date(date);
}

export function useFormatDate() {
  const currentTenant = useAuthStore((s) => s.currentTenant);

  // Plain computed value (not useMemo) — the optional chain in the dependency array
  // (currentTenant?.country) doesn't match what React Compiler infers from the body
  // (currentTenant.country), so manual memoization here can't be preserved anyway.
  // It's a cheap string lookup, so recomputing each render is fine.
  const locale = currentTenant?.country
    ? (getCountryByCode(currentTenant.country)?.locale ?? 'en-US')
    : 'en-US';

  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const formatDate = useCallback((date?: string | Date | number | null, options?: Intl.DateTimeFormatOptions) => {
    if (!date) return '';
    try {
      const d = toDate(date);
      if (isNaN(d.getTime())) return String(date);
      return new Intl.DateTimeFormat(locale, {
        timeZone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        ...options
      }).format(d);
    } catch {
      return String(date);
    }
  }, [locale, timeZone]);

  const formatTime = useCallback((date?: string | Date | number | null, options?: Intl.DateTimeFormatOptions) => {
    if (!date) return '';
    try {
      const d = toDate(date);
      if (isNaN(d.getTime())) return String(date);
      return new Intl.DateTimeFormat(locale, {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        ...options
      }).format(d);
    } catch {
      return String(date);
    }
  }, [locale, timeZone]);

  const formatDateTime = useCallback((date?: string | Date | number | null, options?: Intl.DateTimeFormatOptions) => {
    if (!date) return '';
    try {
      const d = toDate(date);
      if (isNaN(d.getTime())) return String(date);
      return new Intl.DateTimeFormat(locale, {
        timeZone,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        ...options
      }).format(d);
    } catch {
      return String(date);
    }
  }, [locale, timeZone]);

  return { formatDate, formatTime, formatDateTime };
}
