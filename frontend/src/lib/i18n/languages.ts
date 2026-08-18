import en from './messages/en.json';
import es from './messages/es.json';
import pt from './messages/pt.json';
import fa from './messages/fa.json';

export type LanguageDirection = 'ltr' | 'rtl';

export interface LanguageConfig {
  readonly locale: string;
  readonly nativeName: string;
  readonly direction: LanguageDirection;
  readonly selectable: boolean;
  readonly messages: Record<string, unknown>;
  readonly load?: () => Promise<{ default: Record<string, unknown> }>;
}

/**
 * Single source of truth for supported UI languages, BCP-47 locale tags,
 * native display names, text directions, user-facing selectability, and
 * (later) dynamic chunk loaders.
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
    messages: en,
    load: () => import('./messages/en.json'),
  },
  es: {
    locale: 'es',
    nativeName: 'Español',
    direction: 'ltr',
    selectable: true,
    messages: es,
    load: () => import('./messages/es.json'),
  },
  pt: {
    locale: 'pt-BR',
    nativeName: 'Português',
    direction: 'ltr',
    selectable: true,
    messages: pt,
    load: () => import('./messages/pt.json'),
  },
  fa: {
    locale: 'fa-IR',
    nativeName: 'فارسی',
    direction: 'rtl',
    // Governed by #241 acceptance: technical readiness only until Persian is
    // enabled for end users, so keep it hidden from the language selector.
    selectable: false,
    messages: fa,
    load: () => import('./messages/fa.json'),
  },
} as const satisfies Record<string, LanguageConfig>;

export type Language = keyof typeof LANGUAGES;
export type Locale = (typeof LANGUAGES)[Language]['locale'];

/** Returns the text direction of a UI language (defaults to `ltr`). */
export function getLanguageDirection(lang: Language): LanguageDirection {
  return LANGUAGES[lang]?.direction ?? 'ltr';
}

/** Returns the BCP-47 locale tag of a UI language (defaults to `en`). */
export function getLanguageLocale(lang: Language): string {
  return LANGUAGES[lang]?.locale ?? 'en';
}
