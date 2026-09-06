'use client';

import { useEffect } from 'react';
import { useLocale } from 'use-intl';
import { getLanguageDirection, getLanguageFromLocale, getLanguageLocale } from '@/lib/i18n';

/** Syncs <html lang> and <html dir> with active UI language
 * after the corresponding locale message bundle has loaded. */
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
