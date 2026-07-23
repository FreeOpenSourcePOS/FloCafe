import { useEffect, useState } from 'react';
import { fetchServerInfo } from '@/lib/i18n';
import type { KdsViewMode } from '@/hooks/useKdsView';

export interface ServerKdsInfo {
  language: 'en' | 'es' | null;
  country: string | null;
  kdsDefaultView: KdsViewMode | null;
}

const EMPTY: ServerKdsInfo = { language: null, country: null, kdsDefaultView: null };

/**
 * Read tenant KDS metadata once on mount. Single source for both views
 * (dashboard embedded + standalone on :3002). Never throws.
 *
 * Pass `baseUrl` as empty string for relative fetch (dashboard on same origin),
 * or a full origin (standalone KDS) to target its own backend.
 */
export function useServerKdsInfo(baseUrl = ''): ServerKdsInfo {
  const [info, setInfo] = useState<ServerKdsInfo>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    fetchServerInfo(baseUrl).then((server) => {
      if (cancelled) return;
      setInfo({
        language: server.language,
        country: server.country,
        kdsDefaultView: server.kdsDefaultView,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  return info;
}
