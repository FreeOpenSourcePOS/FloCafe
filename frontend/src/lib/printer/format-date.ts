import { parseDbTimestamp } from '@/lib/utils';

export function formatDate(iso?: string, locale: string = 'en-US', options?: Intl.DateTimeFormatOptions): string {
  if (!iso) return '';
  try {
    const d = parseDbTimestamp(iso);
    if (isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...options
    }).format(d);
  } catch {
    return iso;
  }
}

export function formatTime(iso?: string, locale: string = 'en-US', options?: Intl.DateTimeFormatOptions): string {
  if (!iso) return '';
  try {
    const d = parseDbTimestamp(iso);
    if (isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...options
    }).format(d);
  } catch {
    return iso;
  }
}
