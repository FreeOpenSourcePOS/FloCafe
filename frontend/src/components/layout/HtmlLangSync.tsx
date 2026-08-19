'use client';

import { useEffect } from 'react';
import { useLocale } from 'use-intl';
import { getLanguageDirection, getLanguageFromLocale, getLanguageLocale } from '@/lib/i18n';

/**
 * Syncs `<html lang>` and `<html dir>` with the active UI language.
 *
 * Direction and locale come from the active loaded locale in the i18n context
 * (`useLocale`), so RTL languages are handled automatically rather than
 * hard-coded. #375/#376: the provider switches the context locale only after
 * the language's message bundle has actually loaded, so lang/dir never flip
 * ahead of message resolution (no key flashing or layout jump during
 * language switches).
 *
 * HtmlLangSync handles the main application document and standalone layouts
 * (such as Server App). KDS performs equivalent synchronization separately
 * through KdsHtmlLang.
 */
export function HtmlLangSync() {
  const locale = useLocale();
  const language = getLanguageFromLocale(locale) ?? 'en';
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    el.lang = getLanguageLocale(language);
    el.dir = getLanguageDirection(language);
  }, [language]);
  return null;
}
