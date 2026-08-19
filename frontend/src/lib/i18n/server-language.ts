import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { isLanguage, type Language } from './languages';

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
export async function fetchServerInfo(
  baseUrl = '',
  timeoutMs = 1500,
  infoPath = '/api/kds/info',
): Promise<ServerInfo> {
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
      language: isLanguage(data.language) ? data.language : null,
      country: data.country || null,
      kdsDefaultView:
        data.kds_default_view === 'kanban' ? 'kanban' : data.kds_default_view === 'tabs' ? 'tabs' : null,
    };
  } catch {
    return empty;
  }
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
