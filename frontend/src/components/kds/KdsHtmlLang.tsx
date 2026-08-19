'use client';

import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLanguageDirection, getLanguageLocale } from '@/lib/i18n';
import { loadLocaleMessages } from '@/lib/i18n/loader';

/**
 * Syncs the KDS standalone document's `<html lang>` and `<html dir>` with the
 * active UI language.
 *
 * Direction and locale come from the shared language metadata, so RTL
 * languages are handled automatically rather than hard-coded. #375: lang/dir
 * are applied atomically only after the locale's messages have actually
 * loaded, so the document direction never flips ahead of message resolution.
 */
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
