import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import {
  isRasterRenderRequest,
  isRasterRenderResult,
  type RasterIpcResultMessage,
  type RasterRenderRequest,
  type RasterRenderResult,
  type RasterStyle,
  type RasterSemanticUnit,
  type RasterSemanticLineGroup,
  type RasterTextLayout,
} from '../../shared/print/raster';
import {
  isThermalTextRepresentable,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';

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
    if (!request || request.version !== 1 || typeof request.text !== 'string' || typeof request.financial !== 'boolean' || !familyName(request.bundledFont?.family)) {
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
      const styles = Array.isArray(request.styles) ? request.styles : [request.style];
      const scaleX = styles.includes('double-width') ? 2 : 1;
      const scaleY = styles.includes('double-height') ? 2 : 1;
      const logicalLineHeight = 24;
      const lineHeight = logicalLineHeight * scaleY;
      const fontSize = styles.includes('font-b') ? 12 : 16;
      const weight = styles.includes('bold') ? '700' : '400';
      context.font = weight + ' ' + fontSize + 'px ' + JSON.stringify(request.bundledFont.family);
      context.textBaseline = 'top';
      context.direction = request.direction;
      context.textAlign = request.align === 'center' ? 'center' : 'left';
      const measure = (value) => context.measureText(value).width * scaleX;
      if (typeof Intl.Segmenter !== 'function') return makeFailure(request, 'render-failed', 'Grapheme segmentation is unavailable');
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const graphemes = (value) => Array.from(segmenter.segment(value), (part) => part.segment);
      const wrap = (value, width) => {
        const wrapped = [];
        let current = '';
        for (const grapheme of graphemes(value)) {
          const candidate = current + grapheme;
          if (current && measure(candidate) > width) {
            wrapped.push(current);
            current = grapheme;
          } else {
            current = candidate;
          }
        }
        wrapped.push(current);
        return wrapped;
      };
      const gapDots = Math.max(1, Math.round(request.widthDots / 48));
      const renderLines = request.layout
        ? (() => {
          const columns = request.layout.columns;
          const measured = columns.map((column) => Math.max(1, measure(column.text)));
          const gaps = gapDots * (columns.length - 1);
          const available = Math.max(1, request.widthDots - gaps);
          const widths = columns.length === 2
            ? [Math.max(1, available - Math.min(Math.max(measured[1] + gapDots, Math.floor(available * 0.2)), Math.floor(available * 0.45))), 0]
            : [0, Math.max(1, Math.floor(available * 0.1)), 0];
          if (columns.length === 2) widths[1] = available - widths[0];
          else {
            widths[2] = Math.min(Math.max(measured[2] + gapDots, Math.floor(available * 0.2)), Math.floor(available * 0.35));
            widths[0] = Math.max(1, available - widths[1] - widths[2]);
          }
          const wrappedColumns = columns.map((column, index) => wrap(column.text, widths[index]));
          const lineCount = Math.max(1, ...wrappedColumns.map((column) => column.length));
          return Array.from({ length: lineCount }, (_, lineIndex) => columns.map((column, columnIndex) => ({
            text: wrappedColumns[columnIndex][lineIndex] || '',
            align: column.align,
            width: widths[columnIndex],
          })));
        })()
        : request.text.split(/\\r?\\n/).flatMap((source) => wrap(source, request.widthDots)).map((text) => [{
          text,
          align: request.align === 'center' ? 'center' : 'left',
          width: request.widthDots,
        }]);
      if (renderLines.length > request.maxLines) {
        return makeFailure(request, 'render-failed', request.financial
          ? 'Financial raster unit exceeds renderer line limit'
          : 'Raster unit exceeds renderer line limit');
      }
      const width = request.widthDots;
      const pixels = new Uint8Array(width * Math.max(1, renderLines.length * lineHeight));
      canvas.width = width;
      canvas.height = Math.max(1, renderLines.length * lineHeight);
      // Resizing a canvas resets its drawing state, so restore the measured
      // font and bidi direction before painting the final pixels.
      context.font = weight + ' ' + fontSize + 'px ' + JSON.stringify(request.bundledFont.family);
      context.textBaseline = 'top';
      context.direction = request.direction;
      context.textAlign = request.align === 'center' ? 'center' : 'left';
      context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, canvas.height);
      context.fillStyle = '#000';
      renderLines.forEach((line, lineIndex) => {
        let x = 0;
        line.forEach((cell, cellIndex) => {
          context.textAlign = cell.align === 'center' ? 'center' : cell.align;
          const cellX = cell.align === 'right' ? x + cell.width : cell.align === 'center' ? x + cell.width / 2 : x;
          context.fillText(cell.text, cellX / scaleX, lineIndex * logicalLineHeight);
          x += cell.width;
          if (cellIndex < line.length - 1) x += gapDots;
        });
      });
      const image = context.getImageData(0, 0, width, canvas.height).data;
      for (let i = 0; i < pixels.length; i++) pixels[i] = image[i * 4] < 128 ? 1 : 0;
      const bands = [];
      for (let offset = 0; offset < canvas.height; offset += request.maxBandHeight) {
        const height = Math.min(request.maxBandHeight, canvas.height - offset);
        const bandPixels = pixels.slice(offset * width, (offset + height) * width);
        bands.push({ widthDots: width, heightDots: height, pixels: bandPixels });
      }
      return { version: 1, requestId: request.requestId, ok: true, unit: { unitId: request.requestId, financial: request.financial, complete: true, bands } };
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
  readonly ipc?: Pick<Electron.IpcMain, 'on' | 'removeListener'>;
  readonly timeoutMs?: number;
}

/** Main-process owner for the dedicated, hidden Chromium raster surface. */
export class ChromiumRasterRenderer {
  private readonly surface: RasterSurface;
  private readonly timeoutMs: number;
  private readonly ipc: Pick<Electron.IpcMain, 'on' | 'removeListener'>;
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
    const candidate: unknown = message.result;
    if (!candidate || typeof candidate !== 'object') return;
    const candidateRecord = candidate as { version?: unknown; requestId?: unknown };
    if (message.version !== 1 || candidateRecord.version !== 1 || typeof candidateRecord.requestId !== 'string') return;
    const requestId = candidateRecord.requestId;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(isRasterRenderResult(candidate)
      ? candidate
      : { version: 1, requestId, ok: false, code: 'render-failed', detail: 'Raster renderer returned an invalid result' });
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
    this.ipc = options.ipc ?? ipcMain;
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
    this.ipc.on('flo:raster-ready', this.onReady);
    this.ipc.on('flo:raster-result', this.onResult);
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
    if (error && !this.readyError) this.readyError = error;
    if (this.readySettled) return;
    this.readySettled = true;
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
    this.ipc.removeListener('flo:raster-ready', this.onReady);
    this.ipc.removeListener('flo:raster-result', this.onResult);
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

export interface RasterLineRenderFailure {
  readonly lineIndex: number;
  readonly lineCount: number;
  readonly text: string;
  readonly financial: boolean;
  readonly code: string;
  readonly detail: string;
}

interface RasterSemanticLineGroupWithLines extends RasterSemanticLineGroup {
  readonly groupId: string;
  readonly lineIndex: number;
  readonly lines: readonly string[];
}

interface RasterPhysicalSourceLine {
  readonly lineIndex: number;
  readonly lineCount: number;
  readonly sourceIndex?: number;
  readonly controlLine: string;
}

function mapPhysicalSourceLines(group: RasterSemanticLineGroupWithLines): RasterPhysicalSourceLine[] | null {
  if (!group.sourceLines) {
    return [{ lineIndex: group.lineIndex, lineCount: group.lineCount, controlLine: group.lines[0] ?? '' }];
  }
  const controlLines = group.sourceControlLines;
  if (!controlLines) {
    return group.sourceLines.length === group.lineCount
      ? group.sourceLines.map((_, sourceIndex) => ({ lineIndex: group.lineIndex + sourceIndex, lineCount: 1, sourceIndex, controlLine: group.lines[sourceIndex] ?? '' }))
      : null;
  }
  if (controlLines.length !== group.sourceLines.length || controlLines.length === 0) return null;
  const starts: number[] = [];
  let cursor = 0;
  for (const controlLine of controlLines) {
    const start = group.lines.indexOf(controlLine, cursor);
    if (start < 0 || (starts.length === 0 && start !== 0)) return null;
    starts.push(start);
    cursor = start + 1;
  }
  const ranges = starts.map((start, sourceIndex) => ({
    lineIndex: group.lineIndex + start,
    lineCount: (starts[sourceIndex + 1] ?? group.lines.length) - start,
    sourceIndex,
    controlLine: controlLines[sourceIndex],
  }));
  return ranges.every((range) => range.lineCount > 0)
    && ranges.at(-1)!.lineIndex + ranges.at(-1)!.lineCount === group.lineIndex + group.lineCount
    ? ranges
    : null;
}

function semanticLineGroups(lines: readonly string[]): RasterSemanticLineGroupWithLines[] {
  const groups: RasterSemanticLineGroupWithLines[] = [];
  for (let lineIndex = 0; lineIndex < lines.length;) {
    const line = lines[lineIndex];
    const kotItem = line.includes('{DOUBLE_HEIGHT}') && line.includes('{BOLD}') && !line.includes('{/CENTER}');
    if (kotItem) {
      const end = lineIndex + 1;
      let next = end;
      while (next < lines.length) {
        const candidate = lines[next];
        if (candidate.includes('{CUT}') || /^[-=]{8,}$/.test(candidate)) break;
        if (kotItem && candidate.includes('{DOUBLE_HEIGHT}') && candidate.includes('{BOLD}')) break;
        next += 1;
      }
      groups.push({ groupId: `kot-item-${lineIndex}`, lineIndex, lineCount: next - lineIndex, lines: lines.slice(lineIndex, next) });
      lineIndex = next;
      continue;
    }
    groups.push({ groupId: `line-${lineIndex}`, lineIndex, lineCount: 1, lines: [line] });
    lineIndex += 1;
  }
  return groups;
}

const RASTER_CONTROL_TOKEN_RE = /\{(?:\/?(?:CENTER|BOLD|DOUBLE_HEIGHT|DOUBLE_WIDTH|FONT_B)|INIT|CUT|FEED|STORE_NAME|FINANCIAL)\}/g;

function stripRasterControlTokens(line: string): string {
  return line.replace(RASTER_CONTROL_TOKEN_RE, '');
}

function financialLayoutForLine(groupId: string, offset: number, sourceText: string): RasterTextLayout | undefined {
  const amountPattern = /((?:[-+]\s*)?(?:[^0-9\s]+\s*)?\d[\d\s.,]*(?:\s+[^\d\s]+)?)$/u;
  if (groupId.startsWith('item-table-row-') && offset === 0) {
    const itemMatch = sourceText.match(/^([\s\S]+?)\s+(\d+(?:[.,]\d+)?)\s+((?:[-+]\s*)?(?:[^0-9\s]+\s*)?\d[\d\s.,]*)$/u);
    if (itemMatch) {
      return {
        kind: 'financial-item',
        columns: [
          { text: itemMatch[1], align: 'left' },
          { text: itemMatch[2], align: 'left' },
          { text: itemMatch[3].trimStart(), align: 'right' },
        ],
      };
    }
  }
  const amountMatch = sourceText.match(amountPattern);
  if (!amountMatch || amountMatch.index === undefined || amountMatch.index <= 0) return undefined;
  const label = sourceText.slice(0, amountMatch.index).trimEnd();
  const value = amountMatch[1].trimStart();
  if (!label || !value) return undefined;
  return {
    kind: 'financial-summary',
    columns: [
      { text: label, align: 'left' },
      { text: value, align: 'right' },
    ],
  };
}

function controlMetadataLine(line: string, sourceText?: string): string {
  if (sourceText === undefined) return line;
  if (sourceText.length === 0) return line;
  let sourceIndex = line.indexOf(sourceText);
  while (sourceIndex >= 0) {
    const tokenStart = line.lastIndexOf('{', sourceIndex);
    const tokenEnd = tokenStart >= 0 ? line.indexOf('}', tokenStart) : -1;
    if (tokenStart < 0 || tokenStart === sourceIndex || tokenEnd < sourceIndex) {
      return line.slice(0, sourceIndex) + line.slice(sourceIndex + sourceText.length);
    }
    sourceIndex = line.indexOf(sourceText, sourceIndex + sourceText.length);
  }
  let metadataLine = line;
  for (const token of sourceText.match(RASTER_CONTROL_TOKEN_RE) ?? []) {
    const tokenIndex = metadataLine.lastIndexOf(token);
    if (tokenIndex >= 0) metadataLine = metadataLine.slice(0, tokenIndex) + metadataLine.slice(tokenIndex + token.length);
  }
  return metadataLine;
}

function requestForRasterLine(
  line: string,
  lineIndex: number,
  capabilities: ThermalPrinterCapabilities,
  requestId: string,
  financial: boolean,
  sourceText?: string,
  layout?: RasterTextLayout,
): RasterRenderRequest | null {
  const metadataLine = controlMetadataLine(line, sourceText);
  if (metadataLine.includes('{INIT}') || metadataLine.includes('{CUT}') || metadataLine.includes('{FEED}')) return null;
  const text = sourceText !== undefined ? (sourceText || ' ') : (stripRasterControlTokens(line) || ' ');
  const styles: RasterStyle[] = [
    metadataLine.includes('{BOLD}') ? 'bold' : null,
    metadataLine.includes('{DOUBLE_HEIGHT}') ? 'double-height' : null,
    metadataLine.includes('{DOUBLE_WIDTH}') ? 'double-width' : null,
    metadataLine.includes('{FONT_B}') ? 'font-b' : null,
  ].filter((style): style is RasterStyle => style !== null);
  return {
    version: 1,
    requestId: `${requestId}-${lineIndex}`,
    text,
    widthDots: capabilities.raster.widthDots,
    maxBandHeight: capabilities.raster.maxBandHeight,
    direction: /[\u0590-\u08FF\uFB50-\uFEFF]/.test(text) ? 'rtl' : 'ltr',
    align: metadataLine.includes('{CENTER}') && metadataLine.includes('{/CENTER}') ? 'center' : 'left',
    ...(layout ? { layout } : {}),
    style: metadataLine.includes('{DOUBLE_HEIGHT}') ? 'double-height'
      : metadataLine.includes('{DOUBLE_WIDTH}') ? 'double-width'
        : metadataLine.includes('{FONT_B}') ? 'font-b'
          : metadataLine.includes('{BOLD}') ? 'bold' : 'normal',
    ...(styles.length > 0 ? { styles } : {}),
    financial,
    maxLines: 256,
    bundledFont: capabilities.raster.font!,
  };
}

export async function renderUnsupportedRasterLines(
  renderer: Pick<ChromiumRasterRenderer, 'render'>,
  lines: readonly string[],
  capabilities: ThermalPrinterCapabilities,
  requestPrefix: string,
  rasterGroups?: readonly RasterSemanticLineGroup[],
): Promise<{ units: Array<{ lineIndex: number; lineCount: number; unit: RasterSemanticUnit }>; failures: RasterLineRenderFailure[] }> {
  const units: Array<{ lineIndex: number; lineCount: number; unit: RasterSemanticUnit }> = [];
  const failures: RasterLineRenderFailure[] = [];
  const groups = rasterGroups
    ? rasterGroups.flatMap((group) => {
      const valid = Number.isSafeInteger(group.lineIndex) && Number.isSafeInteger(group.lineCount)
        && group.lineIndex >= 0 && group.lineCount > 0 && group.lineIndex + group.lineCount <= lines.length;
      if (!valid) {
        failures.push({
          lineIndex: Number.isSafeInteger(group.lineIndex) ? group.lineIndex : 0,
          lineCount: Number.isSafeInteger(group.lineCount) && group.lineCount > 0 ? group.lineCount : 1,
          text: (group.sourceLines ?? []).filter(Boolean).join('\n'),
          financial: group.financial === true,
          code: 'invalid-range',
          detail: 'Raster semantic group range is outside the print document',
        });
        return [];
      }
      return [{ ...group, lines: lines.slice(group.lineIndex, group.lineIndex + group.lineCount) }];
    })
    : semanticLineGroups(lines);
  const overlappingGroups = new Set<RasterSemanticLineGroupWithLines>();
  for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
      const left = groups[leftIndex];
      const right = groups[rightIndex];
      if (left.lineIndex < right.lineIndex + right.lineCount && right.lineIndex < left.lineIndex + left.lineCount) {
        overlappingGroups.add(left);
        overlappingGroups.add(right);
      }
    }
  }
  for (const group of overlappingGroups) {
    failures.push({
      lineIndex: group.lineIndex,
      lineCount: group.lineCount,
      text: (group.sourceLines ?? group.lines.map(stripRasterControlTokens)).filter(Boolean).join('\n'),
      financial: group.financial === true,
      code: 'invalid-range',
      detail: 'Raster semantic groups overlap in the print document',
    });
  }
  const covered = new Set<number>(groups.flatMap((group) => Array.from({ length: group.lineCount }, (_, offset) => group.lineIndex + offset)));
  const completeGroups: RasterSemanticLineGroupWithLines[] = groups.filter((group) => !overlappingGroups.has(group));
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!covered.has(lineIndex)) completeGroups.push({ groupId: `line-${lineIndex}`, lineIndex, lineCount: 1, lines: [lines[lineIndex]] });
  }
  completeGroups.sort((left, right) => left.lineIndex - right.lineIndex);
  const semanticGroups = Array.from(
    completeGroups.reduce((groups, group) => {
      const ranges = groups.get(group.groupId) ?? [];
      ranges.push(group);
      groups.set(group.groupId, ranges);
      return groups;
    }, new Map<string, RasterSemanticLineGroupWithLines[]>()),
  ).map(([, ranges]) => ranges).sort((left, right) => left[0].lineIndex - right[0].lineIndex);
  for (const ranges of semanticGroups) {
    const group = ranges[0];
    const groupText = ranges.flatMap((range) => range.sourceLines
      ? Array.from(range.sourceLines)
      : range.lines.map(stripRasterControlTokens))
      .filter(Boolean).join('\n');
    const needsRaster = ranges.some((range) => (range.sourceLines ?? range.lines).some((line) => {
      const text = range.sourceLines ? line : stripRasterControlTokens(line);
      return text.length > 0 && !isThermalTextRepresentable(text, capabilities);
    }));
    if (!needsRaster) continue;
    const financial = ranges.some((range) => range.financial === true);
    const renderedRanges: Array<{ lineIndex: number; lineCount: number; bands: RasterSemanticUnit['bands'] }> = [];
    let failure: RasterLineRenderFailure | null = null;
    if (!capabilities.raster.font) {
      failure = { lineIndex: group.lineIndex, lineCount: group.lines.length, text: groupText, financial, code: 'font-unavailable', detail: 'No bundled raster font is configured' };
    } else {
      for (const range of ranges) {
        const renderedUnits: RasterSemanticUnit[] = [];
        const physicalSourceLines = mapPhysicalSourceLines(range);
        if (!physicalSourceLines) {
          failure = {
            lineIndex: range.lineIndex,
            lineCount: range.lineCount,
            text: groupText,
            financial,
            code: 'invalid-range',
            detail: 'Raster semantic source rows do not map to physical print lines',
          };
          break;
        }
        for (const physicalSourceLine of physicalSourceLines) {
          const sourceText = physicalSourceLine.sourceIndex === undefined ? undefined : range.sourceLines![physicalSourceLine.sourceIndex];
          const layoutFinancial = physicalSourceLine.sourceIndex === undefined
            ? financial
            : range.financialSourceLines?.[physicalSourceLine.sourceIndex] ?? financial;
          const layout = sourceText !== undefined && layoutFinancial
            ? financialLayoutForLine(group.groupId, physicalSourceLine.sourceIndex!, sourceText)
            : undefined;
          const request = requestForRasterLine(physicalSourceLine.controlLine, physicalSourceLine.lineIndex, capabilities, requestPrefix, layoutFinancial, sourceText, layout);
          if (!request) continue;
          let result: Awaited<ReturnType<typeof renderRasterSemanticUnit>>;
          try {
            result = await renderRasterSemanticUnit(renderer, request, layoutFinancial);
          } catch (error) {
            result = {
              ok: false,
              code: 'render-failed',
              detail: error instanceof Error ? error.message : String(error),
              financial: layoutFinancial,
            };
          }
          if (!result.ok) {
            failure = { lineIndex: range.lineIndex, lineCount: range.lineCount, text: groupText, financial: result.financial, code: result.code, detail: result.detail };
            break;
          }
          renderedUnits.push(result.unit);
        }
        if (failure) break;
        renderedRanges.push({ lineIndex: range.lineIndex, lineCount: range.lines.length, bands: renderedUnits.flatMap((unit) => unit.bands) });
      }
    }
    if (failure) {
      failures.push(...ranges.map((range) => ({ ...failure, lineIndex: range.lineIndex, lineCount: range.lines.length })));
      continue;
    }
    units.push(...renderedRanges.map((range) => ({
      lineIndex: range.lineIndex,
      lineCount: range.lineCount,
      unit: {
        unitId: ranges.length === 1 ? group.groupId : `${group.groupId}-${range.lineIndex}`,
        financial,
        complete: true,
        bands: range.bands,
      },
    })));
  }
  return { units, failures };
}
