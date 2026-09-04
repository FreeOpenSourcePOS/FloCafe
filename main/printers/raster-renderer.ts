import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import {
  isRasterRenderRequest,
  type RasterIpcResultMessage,
  type RasterRenderRequest,
  type RasterRenderResult,
  type RasterSemanticUnit,
} from '../../shared/print/raster';

const RENDER_TIMEOUT_MS = 10_000;

/**
 * The page loaded by this window is intentionally self-contained. It has no
 * navigation, network access, Node integration, or relationship to the POS
 * window. Fonts arrive only as validated data URLs in the typed request.
 */
export function rasterRendererHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>Flo raster surface</title>
<style>html,body{margin:0;padding:0;background:#fff}canvas{display:block}</style>
<script>
(() => {
  const api = window.__floRaster;
  if (!api) return;
  const familyName = (value) => /^[A-Za-z0-9 _-]{1,64}$/.test(value);
  const makeFailure = (request, code, detail) => ({ version: 1, requestId: request.requestId, ok: false, code, detail });
  const render = async (request) => {
    if (!request || request.version !== 1 || typeof request.text !== 'string' || !familyName(request.bundledFont?.family)) {
      return makeFailure(request || { requestId: '' }, 'invalid-request', 'Raster request failed validation');
    }
    try {
      const font = new FontFace(request.bundledFont.family, 'url(' + request.bundledFont.dataUrl + ')');
      try {
        await font.load();
        document.fonts.add(font);
      } catch (error) {
        return makeFailure(request, 'font-unavailable', error instanceof Error ? error.message : String(error));
      }
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return makeFailure(request, 'render-failed', 'Canvas 2D context is unavailable');
      const scale = request.style === 'double-width' ? 2 : 1;
      const lineHeight = request.style === 'double-height' ? 40 : 20;
      const fontSize = request.style === 'double-height' ? 24 : 16;
      const weight = request.style === 'bold' ? '700' : '400';
      context.font = weight + ' ' + fontSize + 'px ' + JSON.stringify(request.bundledFont.family);
      context.textBaseline = 'top';
      context.direction = request.direction;
      context.textAlign = request.direction === 'rtl' ? 'right' : 'left';
      const measure = (value) => context.measureText(value).width * scale;
      const lines = [];
      const sourceLines = request.text.split(/\\r?\\n/);
      for (const source of sourceLines) {
        let current = '';
        for (const character of Array.from(source)) {
          const candidate = current + character;
          if (current && measure(candidate) > request.widthDots) {
            lines.push(current);
            current = character;
          } else {
            current = candidate;
          }
        }
        lines.push(current);
      }
      let bounded = lines.slice(0, request.maxLines);
      if (lines.length > request.maxLines && bounded.length > 0) {
        let last = bounded[bounded.length - 1];
        while (last && measure(last + '…') > request.widthDots) last = last.slice(0, -1);
        bounded[bounded.length - 1] = last + '…';
      }
      const width = request.widthDots;
      const pixels = new Uint8Array(width * Math.max(1, bounded.length * lineHeight));
      canvas.width = width;
      canvas.height = Math.max(1, bounded.length * lineHeight);
      // Resizing a canvas resets its drawing state, so restore the measured
      // font and bidi direction before painting the final pixels.
      context.font = weight + ' ' + fontSize + 'px ' + JSON.stringify(request.bundledFont.family);
      context.textBaseline = 'top';
      context.direction = request.direction;
      context.textAlign = request.direction === 'rtl' ? 'right' : 'left';
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, canvas.height);
      context.fillStyle = '#000';
      bounded.forEach((line, index) => context.fillText(line, request.direction === 'rtl' ? width : 0, index * lineHeight));
      const image = context.getImageData(0, 0, width, canvas.height).data;
      for (let i = 0; i < pixels.length; i++) pixels[i] = image[i * 4] < 128 ? 1 : 0;
      const bands = [];
      for (let offset = 0; offset < canvas.height; offset += request.maxBandHeight) {
        const height = Math.min(request.maxBandHeight, canvas.height - offset);
        const bandPixels = pixels.slice(offset * width, (offset + height) * width);
        bands.push({ widthDots: width, heightDots: height, pixels: bandPixels });
      }
      return { version: 1, requestId: request.requestId, ok: true, unit: { unitId: request.requestId, financial: false, complete: true, bands } };
    } catch (error) {
      return makeFailure(request, 'render-failed', error instanceof Error ? error.message : String(error));
    }
  };
  api.onRequest(async (message) => {
    const request = message && message.request;
    api.sendResult({ version: 1, result: await render(request) });
  });
})();
</script>`;
}

type RasterSurface = Pick<BrowserWindow, 'isDestroyed' | 'close' | 'webContents'>;

export interface RasterRendererOptions {
  readonly preloadPath?: string;
  readonly windowFactory?: (options: Electron.BrowserWindowConstructorOptions) => RasterSurface;
  readonly timeoutMs?: number;
}

/** Main-process owner for the dedicated, hidden Chromium raster surface. */
export class ChromiumRasterRenderer {
  private readonly surface: RasterSurface;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, { resolve: (result: RasterRenderResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyError: string | null = null;
  private readonly onResult = (event: Electron.IpcMainEvent, result: unknown): void => {
    if (!this.isSurfaceSender(event.sender) || !result || typeof result !== 'object') return;
    const message = result as Partial<RasterIpcResultMessage>;
    const candidate = message.result;
    if (message.version !== 1 || !candidate || candidate.version !== 1 || typeof candidate.requestId !== 'string') return;
    const entry = this.pending.get(candidate.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(candidate.requestId);
    entry.resolve(candidate);
  };
  private readonly onReady = (event: Electron.IpcMainEvent): void => {
    if (this.isSurfaceSender(event.sender)) this.readyResolve();
  };
  private readonly onLoadFailure = (_event: Electron.Event, errorCode: number, errorDescription: string): void => {
    this.readyError = `Raster surface failed to load (${errorCode}): ${errorDescription}`;
    this.readyResolve();
  };

  constructor(options: RasterRendererOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
    const windowFactory = options.windowFactory ?? ((windowOptions) => new BrowserWindow(windowOptions));
    this.surface = windowFactory({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: options.preloadPath ?? path.join(__dirname, '../raster-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.ready = new Promise<void>((resolve) => { this.readyResolve = resolve; });
    ipcMain.on('flo:raster-ready', this.onReady);
    ipcMain.on('flo:raster-result', this.onResult);
    this.surface.webContents.on('did-fail-load', this.onLoadFailure);
    void this.surface.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rasterRendererHtml())}`);
  }

  private isSurfaceSender(sender: Electron.WebContents): boolean {
    return sender === this.surface.webContents;
  }

  async render(request: unknown): Promise<RasterRenderResult> {
    if (!isRasterRenderRequest(request)) {
      const requestId = request && typeof request === 'object' && 'requestId' in request && typeof request.requestId === 'string'
        ? request.requestId
        : '';
      return { version: 1, requestId, ok: false, code: 'invalid-request', detail: 'Raster request failed validation' };
    }
    if (this.surface.isDestroyed()) {
      return { version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: 'Raster surface is unavailable' };
    }
    await this.ready;
    if (this.readyError) return { version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: this.readyError };
    return await new Promise<RasterRenderResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        resolve({ version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: 'Raster rendering timed out' });
      }, this.timeoutMs);
      this.pending.set(request.requestId, { resolve, timer });
      this.surface.webContents.send('flo:raster-request', { version: 1, request });
    });
  }

  destroy(): void {
    ipcMain.removeListener('flo:raster-ready', this.onReady);
    ipcMain.removeListener('flo:raster-result', this.onResult);
    this.surface.webContents.removeListener('did-fail-load', this.onLoadFailure);
    this.readyError = this.readyError ?? 'Raster surface was closed';
    this.readyResolve();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ version: 1, requestId: '', ok: false, code: 'render-failed', detail: 'Raster surface was closed' });
    }
    this.pending.clear();
    if (!this.surface.isDestroyed()) this.surface.close();
  }
}

/** Attach the semantic financial boundary only after a successful full render. */
export async function renderRasterSemanticUnit(
  renderer: Pick<ChromiumRasterRenderer, 'render'>,
  request: RasterRenderRequest,
  financial: boolean,
): Promise<{ ok: true; unit: RasterSemanticUnit } | { ok: false; code: string; detail: string; financial: boolean }> {
  const result = await renderer.render(request);
  if (!result.ok) return { ok: false, code: result.code, detail: result.detail, financial };
  if (!result.unit.complete || result.unit.bands.length === 0) {
    return { ok: false, code: 'render-failed', detail: 'Raster renderer returned an incomplete semantic unit', financial };
  }
  return { ok: true, unit: { ...result.unit, financial, complete: true } };
}
