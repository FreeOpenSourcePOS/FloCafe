import en from './messages/en.json';
import { LANGUAGES, type Language } from './languages';

export type Messages = Record<string, unknown>;

/**
 * Shared locale message loader + cache (#375).
 *
 * - English is primed synchronously at module load: it is the packaged
 *   cold-boot fallback, so the application can always render without
 *   waiting for any network or chunk resolution.
 * - All other locales are fetched on demand via each language's dynamic
 *   chunk loader and shared between React (`I18nProvider`) and non-React
 *   consumers (the legacy `t()` adapter, print helpers, lang/dir sync).
 * - In-flight loads are deduplicated: concurrent callers for the same
 *   language share a single promise, and failed loads are retried on the
 *   next request (the failed promise is removed from the in-flight map).
 *
 * All chunks are packaged local assets served by FloCafe's embedded
 * localhost server — zero external translation network calls.
 */
const messageCache = new Map<Language, Messages>();
const inFlightPromises = new Map<Language, Promise<Messages>>();

messageCache.set('en', en as Messages);

/** Synchronously cached messages for a language (undefined until loaded). */
export function getCachedMessages(lang: Language): Messages | undefined {
  return messageCache.get(lang);
}

/** True when a language's messages are available synchronously. */
export function isLocaleLoaded(lang: Language): boolean {
  return messageCache.has(lang);
}

/**
 * Load (and cache) the messages for a language. Returns the cached copy for
 * already-loaded languages and deduplicates concurrent in-flight requests.
 * Unknown/unsupported languages fall back to the packaged English loader so
 * callers never throw on registry drift.
 */
export function loadLocaleMessages(lang: Language): Promise<Messages> {
  const cached = messageCache.get(lang);
  if (cached) return Promise.resolve(cached);

  const inFlight = inFlightPromises.get(lang);
  if (inFlight) return inFlight;

  const config = LANGUAGES[lang] ?? LANGUAGES.en;
  const promise = (config.load ? config.load() : Promise.resolve({ default: en })).then((mod) => {
    const messages = (mod.default ?? mod) as Messages;
    messageCache.set(lang, messages);
    inFlightPromises.delete(lang);
    return messages;
  });
  promise.catch(() => {
    inFlightPromises.delete(lang);
  });

  inFlightPromises.set(lang, promise);
  return promise;
}
