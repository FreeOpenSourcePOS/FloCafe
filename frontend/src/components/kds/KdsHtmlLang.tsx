'use client';

import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLanguageDirection, getLanguageLocale } from '@/lib/i18n';
import { loadLocaleMessages } from '@/lib/i18n/loader';

/** Syncs document <html lang> and <html dir> with active UI language
 * atomically after locale messages have loaded. */
export function KdsHtmlLang() {
  const language = usePosSettingsStore((s) => s.language);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let cancelled = false;
    loadLocaleMessages(language)
      .then(() => {
        if (cancelled) return;
        const el = document.documentElement;
        el.lang = getLanguageLocale(language);
        el.dir = getLanguageDirection(language);
      })
      .catch(() => {
        // Locale failed to load: keep the current document lang/dir.
      });
    return () => {
      cancelled = true;
    };
  }, [language]);
  return null;
}
