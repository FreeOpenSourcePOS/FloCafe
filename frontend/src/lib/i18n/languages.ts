export type LanguageDirection = 'ltr' | 'rtl';

export interface LanguageConfig {
  readonly locale: string;
  readonly nativeName: string;
  readonly direction: LanguageDirection;
  readonly selectable: boolean;
  /** Dynamic chunk loader for this language's message bundle (#375). */
  readonly load: () => Promise<{ default: Record<string, unknown> }>;
}

/**
 * Single source of truth for supported UI languages, BCP-47 locale tags,
 * native display names, text directions, user-facing selectability, and
 * dynamic chunk loaders.
 *
 * Message bundles are NOT statically imported here: each language is loaded
 * on demand through `load()` and shared via `loader.ts`, so only the active
 * locale bundle ships in the startup payload (#375).
 *
 * `as const satisfies Record<string, LanguageConfig>` preserves the literal
 * keys/types (so `Language` and `Locale` can be derived) while still
 * enforcing that every entry conforms to {@link LanguageConfig}.
 */
export const LANGUAGES = {
  en: {
    locale: 'en',
    nativeName: 'English',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/en.json'),
  },
  es: {
    locale: 'es',
    nativeName: 'Español',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/es.json'),
  },
  pt: {
    locale: 'pt-BR',
    nativeName: 'Português',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/pt.json'),
  },
  fa: {
    locale: 'fa-IR',
    nativeName: 'فارسی',
    direction: 'rtl',
    // Governed by #241 acceptance: technical readiness only until Persian is
    // enabled for end users, so keep it hidden from the language selector.
    selectable: false,
    load: () => import('./messages/fa.json'),
  },
} as const satisfies Record<string, LanguageConfig>;

export type Language = keyof typeof LANGUAGES;
export type Locale = (typeof LANGUAGES)[Language]['locale'];

/**
 * Reverse lookup: BCP-47 locale tag (as configured in {@link LANGUAGES})
 * → registered language. Used by components that read the active locale
 * from the i18n context (e.g. `useLocale()`) and need the language key to
 * resolve direction or message metadata.
 */
const LOCALE_TO_LANGUAGE: Record<string, Language> = Object.fromEntries(
  (Object.keys(LANGUAGES) as Language[]).map((lang) => [LANGUAGES[lang].locale, lang]),
);

/** Returns the registered language for a BCP-47 locale tag (undefined when unknown). */
export function getLanguageFromLocale(locale: string): Language | undefined {
  return LOCALE_TO_LANGUAGE[locale];
}

/** Returns the text direction of a UI language (defaults to `ltr`). */
export function getLanguageDirection(lang: Language): LanguageDirection {
  return LANGUAGES[lang]?.direction ?? 'ltr';
}

/** Returns the BCP-47 locale tag of a UI language (defaults to `en`). */
export function getLanguageLocale(lang: Language): string {
  return LANGUAGES[lang]?.locale ?? 'en';
}
