import { useCallback } from 'react';
import { useAuthStore } from '@/store/auth';
import { getCountryByCode } from '@/lib/countries';

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
      const d = new Date(date);
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
      const d = new Date(date);
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
      const d = new Date(date);
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
