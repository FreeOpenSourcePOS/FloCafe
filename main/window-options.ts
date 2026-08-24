import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { resolveTitleBarOverlayColors, TITLE_BAR_HEIGHT } from './title-bar-theme';

export type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindow;

// macOS traffic-light buttons are 12px tall; y = (40 - 12) / 2 centers them in
// the 40px title bar. x keeps the standard inset margin from the window edge.
const MAC_TRAFFIC_LIGHT_POSITION = { x: 16, y: 14 } as const;

export function createMainWindow(
  BrowserWindowConstructor: BrowserWindowConstructor,
  preload: string,
  platform: NodeJS.Platform = process.platform,
): BrowserWindow {
  return new BrowserWindowConstructor({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    title: 'Flo',
    titleBarStyle: platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: {
      ...resolveTitleBarOverlayColors(false),
      height: TITLE_BAR_HEIGHT,
    },
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
