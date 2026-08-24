import type { NativeTheme } from 'electron';

/**
 * Title-bar theme tokens and helpers for the native-controls title bar
 * (Refs #457, Phase 2 theme synchronization).
 *
 * The overlay colors mirror the renderer CSS custom properties defined in
 * `frontend/src/app/globals.css` so the native Window Controls Overlay stays
 * visually continuous with the `.flo-title-bar` surface:
 * - light: `--background` oklch(1 0 0) -> #ffffff and `--foreground`
 *   oklch(0.145 0 0) -> #0a0a0a.
 * - dark: `--background` oklch(0.145 0 0) -> #0a0a0a and `--foreground`
 *   oklch(0.985 0 0) -> #fafafa.
 *
 * Keep this module free of Electron runtime imports so the color resolution
 * stays unit-testable without launching Electron.
 */

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

/**
 * Runtime theme updates are supported on Windows and macOS. Linux may expose
 * `BrowserWindow.setTitleBarOverlay` for native-overlay window creation, but
 * dynamic overlay updates intentionally no-op there because window-manager
 * support is inconsistent across Linux environments.
 */
export function supportsTitleBarOverlay(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

type OverlayCapableWindow = {
  setTitleBarOverlay?: (options: { color: string; symbolColor: string; height?: number }) => void;
};

/**
 * Applies the overlay colors for the given theme mode. Returns true when the
 * call was attempted successfully, false when unsupported or rejected.
 */
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

/**
 * Subscribes to OS theme changes so the main window's title-bar overlay keeps
 * following light/dark at runtime. Returns an unsubscribe function. No-ops on
 * platforms where the overlay cannot be updated.
 */
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
