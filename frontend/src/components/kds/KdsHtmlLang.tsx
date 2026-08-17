'use client';

import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLanguageDirection } from '@/lib/i18n';

export function KdsHtmlLang() {
  const language = usePosSettingsStore((s) => s.language);
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const el = document.documentElement;
      el.dir = getLanguageDirection(language);
      el.lang = language === 'fa' ? 'fa-IR' : language === 'es' ? 'es' : language === 'pt' ? 'pt-BR' : 'en';
    }
  }, [language]);
  return null;
}
