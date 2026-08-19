import {
  LANGUAGES,
  getLanguageDirection,
  getLanguageLocale,
  type Language,
  type LanguageDirection,
} from './i18n/languages';

// Backward-compatible re-exports: existing callers (HtmlLangSync, KdsHtmlLang,
// DirectionalToaster, useI18n, the pos-settings/auth stores, etc.) keep
// importing `Language`, `LanguageDirection`, and the direction helper from this
// module while the single source of truth now lives in ./i18n/languages.
export {
  LANGUAGES,
  getLanguageDirection,
  getLanguageLocale,
  type Language,
  type LanguageDirection,
};

import en from './i18n/messages/en.json';
import es from './i18n/messages/es.json';
import pt from './i18n/messages/pt.json';
import fa from './i18n/messages/fa.json';

type NestedMessages = Record<string, unknown>;

const translations: Record<Language, NestedMessages> = { en, es, pt, fa };

/**
 * Resolve a legacy dotted key (e.g. "auth.signIn") against the nested message
 * tree by traversing each segment. Returns the leaf string, or undefined when
 * the path does not resolve to a string leaf. This preserves the pre-nesting
 * fallback semantics of {@link t} (target language → English → raw key).
 */
function resolveMessage(messages: NestedMessages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      return undefined;
    }
    node = (node as NestedMessages)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const PLURAL_RE = /\{(\w+),\s*plural,\s*((?:\s*(?:zero|one|two|few|many|other)\s*\{[^}]*\})+)\s*\}/g;
const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getPluralRules(locale: string): Intl.PluralRules {
  let pr = pluralRulesCache.get(locale);
  if (!pr) {
    pr = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, pr);
  }
  return pr;
}

function formatIcuPlural(template: string, params: Record<string, string | number>, lang: Language): string {
  return template.replace(PLURAL_RE, (_match, name: string, cases: string) => {
    const raw = Number(params[name] ?? 0);
    const locale = lang === 'es' ? 'es-AR' : lang === 'pt' ? 'pt-BR' : lang === 'fa' ? 'fa-IR' : 'en';
    const pr = getPluralRules(locale).select(raw);
    const ordered = ['zero', 'one', 'two', 'few', 'many', 'other'];
    const seen: Record<string, string> = {};
    const caseRe = /(zero|one|two|few|many|other)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = caseRe.exec(cases)) !== null) seen[m[1]] = m[2];
    let body = seen[pr];
    if (body === undefined) {
      const fallbackIdx = ordered.indexOf(pr) + 1;
      for (let i = fallbackIdx; i < ordered.length; i++) {
        if (seen[ordered[i]] !== undefined) { body = seen[ordered[i]]; break; }
      }
      if (body === undefined) body = seen.other ?? '';
    }
    return body.replace(/#/g, String(raw));
  });
}

export function t(key: string, lang: Language, params?: Record<string, string | number>): string {
  let value =
    resolveMessage(translations[lang], key) ??
    resolveMessage(translations.en, key) ??
    key;
  if (params) {
    value = formatIcuPlural(value, params, lang);
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return value;
}

export function getBrowserLanguage(): Language {
  if (typeof navigator !== 'undefined') {
    const nav = navigator.language?.toLowerCase();
    if (nav?.startsWith('es')) return 'es';
    if (nav?.startsWith('pt')) return 'pt';
    if (nav?.startsWith('fa')) return 'fa';
  }
  return 'en';
}

/**
 * On mount, fetches the tenant's preferred language from a public info
 * endpoint and pushes it into the global `usePosSettingsStore`. Cross-origin
 * tabs (KDS standalone, Server App standalone) inherit the language set on
 * the dashboard.
 *
 * `infoPath` defaults to `/api/kds/info` and can be pointed at the Server
 * App's `/api/server-app/info`, which exposes the same `language` field.
 *
 * Idempotent: only sets language if the server actually returned one.
 * Best-effort: never throws, never blocks the UI.
 */
import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';

export function useSyncServerLanguage(infoPath = '/api/kds/info'): void {
  const setLanguage = usePosSettingsStore((s) => s.setLanguage);
  useEffect(() => {
    let cancelled = false;
    fetchServerInfo('', 1500, infoPath).then((info) => {
      if (cancelled) return;
      // Keep the existing tenant language when metadata is unavailable.
      if (info.language) setLanguage(info.language);
    });
    return () => {
      cancelled = true;
    };
  }, [setLanguage, infoPath]);
}

export type ServerInfo = {
  language: Language | null;
  country: string | null;
  kdsDefaultView: 'tabs' | 'kanban' | null;
};

/**
 * Fetch the tenant's preferred language + KDS defaults from a public info
 * endpoint (default `/api/kds/info`; the Server App uses
 * `/api/server-app/info`, which exposes the same `language`/`country`
 * fields). Never throws: on timeout/error returns empty info, so callers
 * fall back to local heuristics. 1500ms is generous for a LAN; this must
 * not block first paint of the login screen.
 */
export async function fetchServerInfo(baseUrl = '', timeoutMs = 1500, infoPath = '/api/kds/info'): Promise<ServerInfo> {
  const empty: ServerInfo = { language: null, country: null, kdsDefaultView: null };
  if (typeof window === 'undefined') return empty;
  try {
    const res = await fetch(`${baseUrl}${infoPath}`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!res.ok) return empty;
    const data = (await res.json()) as {
      language?: string | null;
      country?: string | null;
      kds_default_view?: string | null;
    };
    return {
      language: data.language === 'fa' ? 'fa' : data.language === 'es' ? 'es' : data.language === 'pt' ? 'pt' : data.language === 'en' ? 'en' : null,
      country: data.country || null,
      kdsDefaultView:
        data.kds_default_view === 'kanban' ? 'kanban' : data.kds_default_view === 'tabs' ? 'tabs' : null,
    };
  } catch {
    return empty;
  }
}
