export type LanguageDirection = 'ltr' | 'rtl';

export interface LanguageConfig {
  readonly locale: string;
  readonly nativeName: string;
  readonly direction: LanguageDirection;
  readonly selectable: boolean;
  /** Dynamic chunk loader for this language's message bundle (#375). */
  readonly load: () => Promise<{ default: Record<string, unknown> }>;
}

/** Single source of truth for supported UI languages, BCP-47 locale tags,
 * display names, directions, and dynamic chunk loaders. */
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
  de: {
    locale: 'de-DE',
    nativeName: 'Deutsch',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/de.json'),
  },
  tr: {
    locale: 'tr-TR',
    nativeName: 'Türkçe',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/tr.json'),
  },
  fil: {
    locale: 'fil-PH',
    nativeName: 'Filipino',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/fil.json'),
  },

  fr: {
    locale: 'fr-FR',
    nativeName: 'Français',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/fr.json'),
  },
  it: {
    locale: 'it-IT',
    nativeName: 'Italiano',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/it.json'),
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
    // Persian has complete message parity and RTL coverage, so it is ready
    // for end-user selection (#241 / #372).
    selectable: true,
    load: () => import('./messages/fa.json'),
  },
  ar: {
    locale: 'ar-SA',
    nativeName: 'العربية',
    direction: 'rtl',
    selectable: true,
    load: () => import('./messages/ar.json'),
  },
  ja: {
    locale: 'ja-JP',
    nativeName: '日本語',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/ja.json'),
  },
  zh: {
    locale: 'zh-CN',
    nativeName: '简体中文',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/zh.json'),
  },
  'zh-tw': {
    locale: 'zh-TW',
    nativeName: '繁體中文',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/zh-tw.json'),
  },
  ko: {
    locale: 'ko-KR',
    nativeName: '한국어',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/ko.json'),
  },
  id: {
    locale: 'id-ID',
    nativeName: 'Bahasa Indonesia',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/id.json'),
  },
  nl: {
    locale: 'nl-NL',
    nativeName: 'Nederlands',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/nl.json'),
  },
  hi: {
    locale: 'hi-IN',
    nativeName: 'हिन्दी',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/hi.json'),
  },
  bn: {
    locale: 'bn-BD',
    nativeName: 'বাংলা',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/bn.json'),
  },
  sq: {
    locale: 'sq-AL',
    nativeName: 'Shqip',
    direction: 'ltr',
    selectable: true,
    load: () => import('./messages/sq.json'),
  },
} as const satisfies Record<string, LanguageConfig>;

export type Language = keyof typeof LANGUAGES;
export type Locale = (typeof LANGUAGES)[Language]['locale'];

/** Returns whether an unknown value is a registered language key. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, value);
}

/** Reverse map: BCP-47 locale tag to registered language key. */
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
