import { useEffect, useState } from 'react';
import { fetchServerInfo } from '@/lib/i18n';
import type { Language } from '@/lib/i18n';
import type { KdsViewMode } from '@/hooks/useKdsView';

export interface ServerKdsInfo {
  language: Language | null;
  country: string | null;
  kdsDefaultView: KdsViewMode | null;
}

const EMPTY: ServerKdsInfo = { language: null, country: null, kdsDefaultView: null };

/** Reads tenant KDS metadata once on mount for dashboard and
 * standalone views without throwing. */
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
    }).catch(() => {
      if (!cancelled) setInfo(EMPTY);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  return info;
}
