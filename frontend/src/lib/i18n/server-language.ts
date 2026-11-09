import { useEffect } from 'react';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useThemeMode, type ThemeMode } from '@/store/theme';
import { isLanguage, type Language } from './languages';

export type ServerInfo = {
  language: Language | null;
  country: string | null;
  kdsDefaultView: 'tabs' | 'kanban' | null;
  themeMode?: ThemeMode | null;
};

/** Fetches tenant preferred language, KDS defaults, and theme mode from public
 * info endpoint with 1.5s timeout, returning empty defaults on failure. */
export async function fetchServerInfo(
  baseUrl = '',
  timeoutMs = 1500,
  infoPath = '/api/kds/info',
): Promise<ServerInfo> {
  const empty: ServerInfo = {
    language: null,
    country: null,
    kdsDefaultView: null,
    themeMode: null,
  };
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
      theme_mode?: string | null;
    };
    return {
      language: isLanguage(data.language) ? data.language : null,
      country: data.country || null,
      kdsDefaultView:
        data.kds_default_view === 'kanban'
          ? 'kanban'
          : data.kds_default_view === 'tabs'
            ? 'tabs'
            : null,
      themeMode:
        data.theme_mode === 'light' || data.theme_mode === 'dark' || data.theme_mode === 'system'
          ? data.theme_mode
          : null,
    };
  } catch {
    return empty;
  }
}

/** Fetches tenant preferred language and theme mode on mount and updates client
 * stores; safe best-effort sync for standalone views. */
export function useSyncServerLanguage(infoPath = '/api/kds/info'): void {
  const setLanguage = usePosSettingsStore((s) => s.setLanguage);
  useEffect(() => {
    let cancelled = false;
    fetchServerInfo('', 1500, infoPath).then((info) => {
      if (cancelled) return;
      // Keep the existing tenant language when metadata is unavailable.
      if (info.language) setLanguage(info.language);
      if (info.themeMode && !useThemeMode.getState().userSelected) {
        useThemeMode.getState().setMode(info.themeMode);
        if (typeof document !== 'undefined') {
          const isDark =
            info.themeMode === 'dark' ||
            (info.themeMode === 'system' &&
              typeof window !== 'undefined' &&
              typeof window.matchMedia === 'function' &&
              window.matchMedia('(prefers-color-scheme: dark)').matches);
          document.documentElement?.classList?.toggle('dark', isDark);
          try {
            window.localStorage?.setItem('flo-theme-resolved', isDark ? 'dark' : 'light');
          } catch {}
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [setLanguage, infoPath]);
}
