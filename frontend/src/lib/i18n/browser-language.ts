import { LANGUAGES, type Language } from './languages';

/**
 * Detect the user's preferred language from the browser `navigator`.
 *
 * Uses `Intl.Locale` to parse BCP-47 language tags from `navigator.languages`
 * (or `navigator.language` as fallback) and matches the parsed language
 * against registered languages in {@link LANGUAGES}.
 *
 * Tolerates malformed tags, dialect/region subtags (e.g. `fa-IR`, `pt-BR`,
 * `es-ES`, `en-US`), and missing navigator (SSR), safely defaulting to `'en'`.
 */
export function getBrowserLanguage(): Language {
  if (typeof navigator === 'undefined') return 'en';

  const rawLanguages: readonly string[] =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : [];

  if (!rawLanguages.length) return 'en';

  for (const raw of rawLanguages) {
    try {
      const parsed = new Intl.Locale(raw);
      const lang = parsed.language?.toLowerCase();
      if (lang && lang in LANGUAGES) {
        return lang as Language;
      }
    } catch {
      // Malformed language tag — continue searching fallback preferences.
    }
  }

  return 'en';
}
