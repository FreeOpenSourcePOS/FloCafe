import type { NativeTheme } from 'electron';

/** Title-bar palette tokens and overlay helpers for native title bars. */

export const TITLE_BAR_HEIGHT = 40;

export interface TitleBarOverlayColors {
  readonly color: string;
  readonly symbolColor: string;
}

export const TITLE_BAR_OVERLAY_COLORS: Readonly<Record<'light' | 'dark', TitleBarOverlayColors>> = {
  light: { color: '#ffffff', symbolColor: '#0a0a0a' },
  dark: { color: '#0a0a0a', symbolColor: '#fafafa' },
};

export function resolveTitleBarOverlayColors(isDark: boolean): TitleBarOverlayColors {
  return isDark ? TITLE_BAR_OVERLAY_COLORS.dark : TITLE_BAR_OVERLAY_COLORS.light;
}

/** Checks whether the platform reliably supports runtime title-bar overlay theme updates. */
export function supportsTitleBarOverlay(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

type OverlayCapableWindow = {
  setTitleBarOverlay?: (options: { color: string; symbolColor: string; height?: number }) => void;
};

/** Applies the overlay colors for the given theme mode. */
export function applyTitleBarOverlayTheme(
  win: unknown,
  isDark: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!supportsTitleBarOverlay(platform)) return false;
  const candidate = win as OverlayCapableWindow | null | undefined;
  if (!candidate || typeof candidate.setTitleBarOverlay !== 'function') return false;
  try {
    candidate.setTitleBarOverlay({ ...resolveTitleBarOverlayColors(isDark), height: TITLE_BAR_HEIGHT });
    return true;
  } catch {
    // Some window-manager combinations reject runtime overlay changes even
    // when the API exists; keep the last applied colors instead of crashing.
    return false;
  }
}

type ThemeLike = Pick<NativeTheme, 'shouldUseDarkColors'> & {
  on(event: 'updated', listener: () => void): unknown;
};

/** Subscribes to OS theme changes and syncs the window's title-bar overlay. */
export function attachTitleBarThemeSync(
  nativeTheme: ThemeLike,
  getWindow: () => OverlayCapableWindow | null | undefined,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (!supportsTitleBarOverlay(platform)) return () => {};
  const onUpdated = (): void => {
    applyTitleBarOverlayTheme(getWindow(), nativeTheme.shouldUseDarkColors, platform);
  };
  nativeTheme.on('updated', onUpdated);
  return () => {
    (nativeTheme as ThemeLike & { off?(event: 'updated', listener: () => void): unknown }).off?.('updated', onUpdated);
  };
}

export type ThemeMode = 'light' | 'dark' | 'system';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Absent, null, or unrecognized values resolve to 'system'. */
export function resolveThemeMode(value: string | null | undefined): ThemeMode {
  return isThemeMode(value) ? value : 'system';
}

/** Initial window darkness: explicit modes win; 'system' defers to the OS signal. */
export function resolveInitialIsDark(mode: ThemeMode, systemPrefersDark: boolean): boolean {
  return mode === 'dark' || (mode === 'system' && systemPrefersDark);
}

/** Adds current theme palette query parameter to standalone-window URLs. */
export function appendThemeQueryParam(url: string, isDark: boolean): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('theme', isDark ? 'dark' : 'light');
    return parsed.toString();
  } catch {
    return url;
  }
}
