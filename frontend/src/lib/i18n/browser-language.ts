import { isLanguage, LANGUAGES, type Language } from './languages';

/** Detects user's preferred language from navigator.languages
 * using Intl.Locale, matching against registered selectable languages. */
export function getBrowserLanguage(): Language {
  if (typeof navigator === 'undefined') return 'en';

  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const candidate of candidates) {
    try {
      const parsed = new Intl.Locale(candidate);
      const lang = parsed.language?.toLowerCase();
      if (isLanguage(lang) && LANGUAGES[lang].selectable) return lang;
    } catch {
      // Malformed language tag — continue searching fallback preferences.
    }
  }

  return 'en';
}
