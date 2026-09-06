import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { isLanguage, type Language } from './languages';

export type ServerInfo = {
  language: Language | null;
  country: string | null;
  kdsDefaultView: 'tabs' | 'kanban' | null;
};

/** Fetches tenant preferred language and KDS defaults from public info
 * endpoint with 1.5s timeout, returning empty defaults on failure. */
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

/** Fetches tenant preferred language on mount and updates posSettingsStore;
 * safe best-effort sync for standalone views. */
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
