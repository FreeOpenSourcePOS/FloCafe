'use client';

import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';

/**
 * Syncs `<html lang>` and `<html dir>` with the active UI language.
 *
 * Persian (fa) is RTL; all other supported languages are LTR.
 * This runs client-side on every language change so the browser and screen
 * readers always have the correct BCP 47 locale and text-direction cues,
 * even though the root layout is a static Next.js export.
 *
 * Used in every layout subtree that can switch languages (main app, KDS
 * standalone).  Server-standalone keeps lang="en" hardcoded because the
 * customer-facing ordering UI is in the tenant language, not the operator
 * language, and no i18n switching is wired there yet.
 */
export function HtmlLangSync() {
  const language = usePosSettingsStore((s) => s.language);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    switch (language) {
      case 'fa':
        el.lang = 'fa-IR';
        el.dir = 'rtl';
        break;
      case 'es':
        el.lang = 'es';
        el.dir = 'ltr';
        break;
      case 'pt':
        el.lang = 'pt-BR';
        el.dir = 'ltr';
        break;
      default:
        el.lang = 'en';
        el.dir = 'ltr';
    }
  }, [language]);
  return null;
}
