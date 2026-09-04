import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import {
  isRasterRenderRequest,
  isRasterRenderResult,
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
      const scaleX = request.style === 'double-width' ? 2 : 1;
      const scaleY = request.style === 'double-height' ? 2 : 1;
      const logicalLineHeight = 20;
      const lineHeight = logicalLineHeight * scaleY;
      const fontSize = 16;
      const weight = request.style === 'bold' ? '700' : '400';
      context.font = weight + ' ' + fontSize + 'px ' + JSON.stringify(request.bundledFont.family);
      context.textBaseline = 'top';
      context.direction = request.direction;
      context.textAlign = request.direction === 'rtl' ? 'right' : 'left';
      const measure = (value) => context.measureText(value).width * scaleX;
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
      context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, canvas.height);
      context.fillStyle = '#000';
      bounded.forEach((line, index) => context.fillText(line, request.direction === 'rtl' ? width / scaleX : 0, index * logicalLineHeight));
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

type RasterSurface = Pick<BrowserWindow, 'isDestroyed' | 'close' | 'on' | 'removeListener' | 'webContents'>;

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
  private readyTimer!: ReturnType<typeof setTimeout>;
  private readySettled = false;
  private readyError: string | null = null;
  private destroyed = false;
  private readonly onResult = (event: Electron.IpcMainEvent, result: unknown): void => {
    if (!this.isSurfaceSender(event.sender) || !result || typeof result !== 'object') return;
    const message = result as Partial<RasterIpcResultMessage>;
    const candidate = message.result;
    if (message.version !== 1 || !candidate || candidate.version !== 1 || typeof candidate.requestId !== 'string') return;
    const entry = this.pending.get(candidate.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(candidate.requestId);
    entry.resolve(isRasterRenderResult(candidate)
      ? candidate
      : { version: 1, requestId: candidate.requestId, ok: false, code: 'render-failed', detail: 'Raster renderer returned an invalid result' });
  };
  private readonly onReady = (event: Electron.IpcMainEvent): void => {
    if (this.isSurfaceSender(event.sender)) this.settleReady();
  };
  private readonly onLoadFailure = (_event: Electron.Event, errorCode: number, errorDescription: string): void => {
    this.failSurface(`Raster surface failed to load (${errorCode}): ${errorDescription}`);
  };
  private readonly onSurfaceClosed = (): void => {
    this.failSurface('Raster surface was closed');
  };
  private readonly onRenderProcessGone = (): void => {
    this.failSurface('Raster renderer process exited');
  };

  constructor(options: RasterRendererOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
    this.ready = new Promise<void>((resolve) => { this.readyResolve = resolve; });
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
    ipcMain.on('flo:raster-ready', this.onReady);
    ipcMain.on('flo:raster-result', this.onResult);
    this.surface.on('closed', this.onSurfaceClosed);
    this.surface.webContents.on('did-fail-load', this.onLoadFailure);
    this.surface.webContents.on('render-process-gone', this.onRenderProcessGone);
    this.readyTimer = setTimeout(() => this.settleReady('Raster surface readiness timed out'), this.timeoutMs);
    void this.surface.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rasterRendererHtml())}`);
  }

  private isSurfaceSender(sender: Electron.WebContents): boolean {
    return sender === this.surface.webContents;
  }

  private settleReady(error?: string): void {
    if (this.readySettled) return;
    this.readySettled = true;
    if (error) this.readyError = error;
    clearTimeout(this.readyTimer);
    this.readyResolve();
  }

  private failSurface(detail: string): void {
    this.settleReady(detail);
    for (const [requestId, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.resolve({ version: 1, requestId, ok: false, code: 'render-failed', detail });
    }
    this.pending.clear();
  }

  async render(request: unknown): Promise<RasterRenderResult> {
    if (!isRasterRenderRequest(request)) {
      const requestId = request && typeof request === 'object' && 'requestId' in request && typeof request.requestId === 'string'
        ? request.requestId
        : '';
      return { version: 1, requestId, ok: false, code: 'invalid-request', detail: 'Raster request failed validation' };
    }
    if (this.destroyed || this.surface.isDestroyed()) {
      return { version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: 'Raster surface is unavailable' };
    }
    await this.ready;
    if (this.readyError) return { version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: this.readyError };
    return await new Promise<RasterRenderResult>((resolve) => {
      if (this.pending.has(request.requestId)) {
        resolve({ version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: 'Duplicate raster request ID' });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        resolve({ version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: 'Raster rendering timed out' });
      }, this.timeoutMs);
      this.pending.set(request.requestId, { resolve, timer });
      try {
        this.surface.webContents.send('flo:raster-request', { version: 1, request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        resolve({
          version: 1,
          requestId: request.requestId,
          ok: false,
          code: 'render-failed',
          detail: error instanceof Error ? error.message : 'Raster surface is unavailable',
        });
      }
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    ipcMain.removeListener('flo:raster-ready', this.onReady);
    ipcMain.removeListener('flo:raster-result', this.onResult);
    this.surface.removeListener('closed', this.onSurfaceClosed);
    this.surface.webContents.removeListener('did-fail-load', this.onLoadFailure);
    this.surface.webContents.removeListener('render-process-gone', this.onRenderProcessGone);
    this.failSurface('Raster surface was closed');
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
