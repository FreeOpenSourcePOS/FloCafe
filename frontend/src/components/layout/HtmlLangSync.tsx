'use client';

import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLanguageDirection, getLanguageLocale } from '@/lib/i18n';
import { loadLocaleMessages } from '@/lib/i18n/loader';

/**
 * Syncs `<html lang>` and `<html dir>` with the active UI language.
 *
 * Direction and locale come from the shared language metadata, so RTL
 * languages are handled automatically rather than hard-coded. #375: lang/dir
 * are applied atomically only after the locale's messages have actually
 * loaded, so the document direction never flips ahead of message resolution
 * (no key flashing or layout jump during language switches).
 *
 * HtmlLangSync handles the main application document and standalone layouts
 * (such as Server App). KDS performs equivalent synchronization separately
 * through KdsHtmlLang.
 */
export function HtmlLangSync() {
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
        // Locale failed to load: keep the current document lang/dir; the
        // provider reverts the store request in this case.
      });
    return () => {
      cancelled = true;
    };
  }, [language]);
  return null;
}
