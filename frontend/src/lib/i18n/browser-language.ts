import { isLanguage, LANGUAGES, type Language } from './languages';

/**
 * Detect the user's preferred language from the browser `navigator`.
 *
 * Uses `Intl.Locale` to parse BCP-47 language tags from the browser's
 * ordered preference list, then matches only registered selectable languages.
 * A legacy `navigator.language` fallback keeps older/webview implementations
 * working when `navigator.languages` is absent or incomplete.
 */
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
