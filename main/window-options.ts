import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export type BrowserWindowConstructor = new (options: BrowserWindowConstructorOptions) => BrowserWindow;

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
      color: '#ffffff',
      symbolColor: '#475569',
      height: 40,
    },
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
