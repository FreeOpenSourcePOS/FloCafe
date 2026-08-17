'use client';

import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLanguageDirection } from '@/lib/i18n';

/**
 * Syncs `<html lang>` and `<html dir>` with the active UI language.
 *
 * Direction comes from the shared language metadata (`getLanguageDirection`),
 * so an RTL language is handled automatically rather than hard-coded here.
 * This runs client-side on every language change so the browser and screen
 * readers always have the correct BCP 47 locale and text-direction cues,
 * even though the root layout is a static Next.js export.
 *
 * HtmlLangSync handles the main application document and standalone layouts (such as Server App).
 * KDS performs equivalent synchronization separately through KdsHtmlLang.
 */
export function HtmlLangSync() {
  const language = usePosSettingsStore((s) => s.language);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    el.dir = getLanguageDirection(language);
    switch (language) {
      case 'fa':
        el.lang = 'fa-IR';
        break;
      case 'es':
        el.lang = 'es';
        break;
      case 'pt':
        el.lang = 'pt-BR';
        break;
      default:
        el.lang = 'en';
    }
  }, [language]);
  return null;
}
