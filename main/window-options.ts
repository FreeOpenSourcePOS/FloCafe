import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { resolveTitleBarOverlayColors, TITLE_BAR_HEIGHT } from './title-bar-theme';

/** How the main window's caption controls are supplied. */
export type TitleBarMode = 'native-overlay' | 'html-fallback';

/** The single narrow window-control verb set exposed over IPC. */
export type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close';

export type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindow;

// macOS traffic-light buttons are 12px tall; y = (40 - 12) / 2 centers them in
// the 40px title bar. x keeps the standard inset margin from the window edge.
// Exported for the platform-matrix runtime probe (tests/platform-titlebar-runtime-probe.cjs)
// so the macOS hands-on row can assert the exact centered values.
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const;

/**
 * Window Controls Overlay APIs became dependable across our supported
 * platforms from Electron 33 onward; older builds can end up hidden-with-
 * no-controls when the overlay silently fails, so they fall back.
 */
const MIN_OVERLAY_ELECTRON_MAJOR = 33;

/**
 * Decides whether the main window can rely on Electron's native
 * titleBarOverlay caption buttons, or whether the renderer must draw HTML
 * fallback controls.
 *
 * Deliberately defensive: an unknown platform, a pre-33 Electron, or a
 * missing runtime overlay API all resolve to 'html-fallback' so the window
 * never ends up frameless with no visible way to minimize/close it.
 */
export function resolveTitleBarMode(probe: {
  platform: NodeJS.Platform;
  electronVersion: string;
  overlayApiPresent: boolean;
}): TitleBarMode {
  if (probe.platform !== 'darwin' && probe.platform !== 'win32' && probe.platform !== 'linux') {
    return 'html-fallback';
  }
  if (probe.platform === 'darwin') {
    // macOS supplies native traffic lights via titleBarStyle: 'hiddenInset'.
    // It never needs HTML fallback caption buttons.
    return 'native-overlay';
  }
  const versionMatch = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    probe.electronVersion,
  );
  const major = versionMatch ? Number(versionMatch[1]) : Number.NaN;
  if (!Number.isSafeInteger(major) || major < MIN_OVERLAY_ELECTRON_MAJOR) return 'html-fallback';
  if (!probe.overlayApiPresent) return 'html-fallback';
  return 'native-overlay';
}

export function createMainWindow(
  BrowserWindowConstructor: BrowserWindowConstructor,
  preload: string,
  platform: NodeJS.Platform = process.platform,
  isDarkOrTitleBarMode: boolean | TitleBarMode = false,
  titleBarMode: TitleBarMode = typeof isDarkOrTitleBarMode === 'string' ? isDarkOrTitleBarMode : 'native-overlay',
): BrowserWindow {
  const isDark = typeof isDarkOrTitleBarMode === 'boolean' ? isDarkOrTitleBarMode : false;
  const resolvedTitleBarMode = typeof isDarkOrTitleBarMode === 'string' ? isDarkOrTitleBarMode : titleBarMode;
  return new BrowserWindowConstructor({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Flo',
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(resolvedTitleBarMode === 'native-overlay'
      ? {
          titleBarOverlay: {
            ...resolveTitleBarOverlayColors(isDark),
            height: TITLE_BAR_HEIGHT,
          },
        }
      : {}),
    ...(platform === 'darwin' ? { trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION } : {}),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });
}

/** Minimal window surface needed to service a window-control action. */
export type WindowControlTarget = Pick<
  BrowserWindow,
  'isDestroyed' | 'minimize' | 'isMaximized' | 'maximize' | 'unmaximize' | 'close'
>;

/**
 * Applies one validated window-control action. 'close' intentionally goes
 * through `win.close()` so it fires the same 'close' event as the native
 * caption button, preserving close-to-tray semantics.
 */
export function applyWindowControlAction(
  win: WindowControlTarget,
  action: unknown,
): { success: true } | { error: string } {
  if (action !== 'minimize' && action !== 'toggle-maximize' && action !== 'close') {
    return { error: 'Unsupported window action' };
  }
  switch (action) {
    case 'minimize':
      win.minimize();
      break;
    case 'toggle-maximize':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'close':
      win.close();
      break;
  }
  return { success: true };
}

export function getPopupWindowOptions(isBlank: boolean): BrowserWindowConstructorOptions {
  return {
    width: isBlank ? 800 : 1280,
    height: isBlank ? 600 : 800,
    title: isBlank ? 'Print Receipt' : 'Flo - Kitchen Display',
    autoHideMenuBar: isBlank,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

export function getKdsWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    title: 'Flo - Kitchen Display',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

export function createKdsWindow(BrowserWindowConstructor: BrowserWindowConstructor): BrowserWindow {
  return new BrowserWindowConstructor(getKdsWindowOptions());
}

type LocalWindowUrlChecker = (rawUrl: string, port: number, localIp?: string) => boolean;

export function createLocalWindowOpenHandler(
  isAllowedLocalWindowUrl: LocalWindowUrlChecker,
  getServerPort: () => number,
  getLocalIP: () => string,
): (details: { url: string }) => { action: 'allow'; overrideBrowserWindowOptions: BrowserWindowConstructorOptions } | null {
  return ({ url }) => {
    const isBlank = url === 'about:blank' || url === '';
    if (!isAllowedLocalWindowUrl(url, getServerPort(), getLocalIP())) return null;

    return {
      action: 'allow',
      overrideBrowserWindowOptions: getPopupWindowOptions(isBlank),
    };
  };
}
