'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { usePosSettingsStore } from '@/store/pos-settings';
import { LANGUAGES, getBrowserLanguage, isLanguage, type Language } from '@/lib/i18n';
import { getCachedMessages, loadLocaleMessages } from '@/lib/i18n/loader';

/**
 * Wraps the application in use-intl's `IntlProvider` so `useTranslations`,
 * `createTranslator`, and the ICU formatters resolve against the active
 * language's messages.
 *
 * #375: messages are lazy-loaded. English is always available synchronously
 * (packaged cold-boot fallback), so the app renders immediately; the active
 * locale's bundle is fetched on demand and applied atomically when ready.
 * Rapid language switches ignore stale loads (latest request wins), and a
 * failed switch keeps the current language and reverts the store request.
 *
 * Supplies a resolved system timeZone (or UTC) to `IntlProvider` and suppresses
 * `ENVIRONMENT_FALLBACK` error codes during SSR/development pre-rendering while
 * forwarding other formatting errors to `console.error`.
 */
function resolveInitialLanguage(): Language {
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem('pos-settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        const savedLang = parsed?.state?.language;
        if (isLanguage(savedLang)) {
          return savedLang;
        }
      }
    } catch {
      // Fall through to browser detection
    }
  }
  const browser = getBrowserLanguage();
  if (LANGUAGES[browser]) return browser;
  return 'en';
}

export function handleI18nError(error: { code?: string; message?: string } | Error) {
  if ('code' in error && error.code === 'ENVIRONMENT_FALLBACK') return;
  console.error(error);
}

export function getDefaultTimeZone(): string {
  return typeof Intl !== 'undefined'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    : 'UTC';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const language = usePosSettingsStore((s) => s.language);
  const [active, setActive] = useState<Language>('en');
  const activeRef = useRef<Language>('en');

  // One-time: resolve the deterministic initial language (persisted store
  // preference → browser match against selectable languages → packaged
  // English) and sync the store so non-React and standalone consumers render
  // the same language as the provider.
  useEffect(() => {
    const initial = resolveInitialLanguage();
    if (initial !== usePosSettingsStore.getState().language) {
      usePosSettingsStore.setState({ language: initial });
    }
  }, []);

  // Keep the rendered messages + active locale in sync with the requested
  // store language. Stale loads are ignored (effect cleanup + latest-wins
  // guard), and failed switches keep the current language rendered while
  // reverting the store request.
  useEffect(() => {
    if (language === activeRef.current) return;
    let cancelled = false;
    loadLocaleMessages(language)
      .then(() => {
        if (cancelled) return;
        if (usePosSettingsStore.getState().language !== language) return; // superseded
        activeRef.current = language;
        setActive(language);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (usePosSettingsStore.getState().language !== language) return; // superseded
        console.warn(`[i18n] Failed to load messages for "${language}" — staying on "${activeRef.current}".`, err);
        usePosSettingsStore.setState({ language: activeRef.current });
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const config = LANGUAGES[active] ?? LANGUAGES.en;
  const messages = getCachedMessages(active) ?? getCachedMessages('en') ?? {};

  return (
    <IntlProvider
      locale={config.locale}
      messages={messages}
      timeZone={getDefaultTimeZone()}
      onError={handleI18nError}
    >
      {children}
    </IntlProvider>
  );
}
