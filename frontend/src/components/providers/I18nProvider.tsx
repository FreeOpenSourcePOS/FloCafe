'use client';

import { type ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { usePosSettingsStore } from '@/store/pos-settings';
import { LANGUAGES, type Language } from '@/lib/i18n/languages';

/**
 * Wraps the application in use-intl's `IntlProvider` so `useTranslations`,
 * `createTranslator`, and the ICU formatters resolve against the active
 * language's messages.
 *
 * Kept synchronous in this phase (#373): messages are statically imported via
 * the registry, so existing consumers continue to work without any async
 * bootstrap flicker. Lazy loading is introduced later (#375).
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const language = usePosSettingsStore((s) => s.language) as Language;
  const config = LANGUAGES[language] ?? LANGUAGES.en;

  return (
    <IntlProvider locale={config.locale} messages={config.messages}>
      {children}
    </IntlProvider>
  );
}
