'use client';

import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';

export function KdsHtmlLang() {
  const language = usePosSettingsStore((s) => s.language);
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const el = document.documentElement;
      if (language === 'fa') {
        el.lang = 'fa-IR';
        el.dir = 'rtl';
      } else {
        el.lang = language === 'es' ? 'es' : language === 'pt' ? 'pt-BR' : 'en';
        el.dir = 'ltr';
      }
    }
  }, [language]);
  return null;
}
