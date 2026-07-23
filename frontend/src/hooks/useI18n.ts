import { useCallback } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { t as translate, type Language } from '@/lib/i18n';

/** Returns the active UI language and a `t(key, params?)` shorthand for the same value. */
export function useI18n(): {
  language: Language;
  t: (key: string, params?: Record<string, string | number>) => string;
  setLanguage: (lang: Language) => void;
} {
  const language = usePosSettingsStore((s) => s.language);
  const setLanguage = usePosSettingsStore((s) => s.setLanguage);

  // Stable identity per language — prevents `useCallback(..., [t])` consumers
  // (e.g. useKdsConnection's tryWebSocket) from churning on every render and
  // tearing down their WebSocket in a loop.
  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(key, language, params),
    [language],
  );
  return { language, setLanguage, t };
}