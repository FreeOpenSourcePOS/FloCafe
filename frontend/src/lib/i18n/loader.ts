import en from './messages/en.json';
import { LANGUAGES, type Language } from './languages';

export type Messages = Record<string, unknown>;

/** Shared locale message loader and cache with bundled English cold-boot
 * fallback and deduplicated in-flight dynamic chunk fetches. */
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

/** Loads and caches messages for a language, deduplicating in-flight
 * requests and falling back to English for unknown locales. */
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
