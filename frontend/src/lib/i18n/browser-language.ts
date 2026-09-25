import { isLanguage, LANGUAGES, type Language } from './languages';

const SELECTABLE_LOCALES = (Object.keys(LANGUAGES) as Language[])
  .filter((language) => LANGUAGES[language].selectable)
  .map((language) => {
    const locale = new Intl.Locale(LANGUAGES[language].locale);
    const maximized = locale.maximize();
    return {
      language,
      languageCode: locale.language,
      baseName: locale.baseName,
      maximizedBaseName: maximized.baseName,
      script: maximized.script,
    };
  });

function resolveRegisteredLocale(parsed: Intl.Locale): Language | null {
  const exact = SELECTABLE_LOCALES.find((entry) => entry.baseName === parsed.baseName);
  if (exact) return exact.language;

  const maximizedBaseName = parsed.maximize().baseName;
  const maximized = SELECTABLE_LOCALES.find((entry) => entry.maximizedBaseName === maximizedBaseName);
  if (maximized) return maximized.language;

  // A region/script tag may still use a registered bundle with the same script
  // (for example de-CH -> de-DE), but never cross a script boundary (zh-TW must
  // not silently select zh-CN/Hans). Keep this fallback narrow so unsupported
  // regional/script variants continue to the next preference or English.
  if (parsed.script || parsed.region) {
    const script = parsed.maximize().script;
    const sameScript = SELECTABLE_LOCALES.filter((entry) => entry.languageCode === parsed.language && entry.script === script);
    if (sameScript.length === 1) return sameScript[0].language;
    return null;
  }

  const lang = parsed.language?.toLowerCase();
  return isLanguage(lang) && LANGUAGES[lang].selectable ? lang : null;
}

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
      const resolved = resolveRegisteredLocale(new Intl.Locale(candidate));
      if (resolved) return resolved;
    } catch {
      // Malformed language tag — continue searching fallback preferences.
    }
  }

  return 'en';
}
