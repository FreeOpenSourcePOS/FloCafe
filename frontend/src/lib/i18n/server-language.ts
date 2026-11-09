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

export const KDS_THEME_OVERRIDE_KEY = 'flo-kds-theme-override';
const THEME_MIRROR_KEY = 'flo-theme-resolved';

export function readKdsThemeOverride(): 'light' | 'dark' | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage?.getItem(KDS_THEME_OVERRIDE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

export function persistKdsThemeOverride(mode: 'light' | 'dark'): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(KDS_THEME_OVERRIDE_KEY, mode);
    window.localStorage?.setItem(THEME_MIRROR_KEY, mode);
  } catch {}
}

function applyResolvedThemeDom(isDark: boolean): void {
  if (typeof document !== 'undefined') {
    document.documentElement?.classList?.toggle('dark', isDark);
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(THEME_MIRROR_KEY, isDark ? 'dark' : 'light');
    } catch {}
  }
}

export function hydrateKdsThemeOverride(infoPath = '/api/kds/info'): 'light' | 'dark' | null {
  if (infoPath !== '/api/kds/info') return null;
  const override = readKdsThemeOverride();
  if (!override) return null;
  if (!useThemeMode.getState().userSelected) {
    useThemeMode.getState().selectMode(override);
  }
  applyResolvedThemeDom(override === 'dark');
  return override;
}

export function applyServerThemeInfo(
  themeMode: ThemeMode | null | undefined,
  infoPath = '/api/kds/info',
): void {
  if (hydrateKdsThemeOverride(infoPath)) return;
  if (!themeMode || useThemeMode.getState().userSelected) return;
  useThemeMode.getState().setMode(themeMode);
  const isDark =
    themeMode === 'dark' ||
    (themeMode === 'system' &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      Boolean(window.matchMedia('(prefers-color-scheme: dark)').matches));
  applyResolvedThemeDom(isDark);
}

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
    hydrateKdsThemeOverride(infoPath);
    fetchServerInfo('', 1500, infoPath).then((info) => {
      if (cancelled) return;
      // Keep the existing tenant language when metadata is unavailable.
      if (info.language) setLanguage(info.language);
      applyServerThemeInfo(info.themeMode, infoPath);
    });
    return () => {
      cancelled = true;
    };
  }, [setLanguage, infoPath]);
}
