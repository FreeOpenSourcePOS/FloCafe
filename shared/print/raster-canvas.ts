/**
 * Canvas painter for raster render requests, shared by the Electron raster surface
 * and the browser WebUSB path so both produce the same bands.
 *
 * The function is serialized into the Electron surface page, so it must stay
 * self-contained: no references to imports or module-level values.
 */
import type { RasterRenderRequest, RasterRenderResult } from './raster';

/** Structural 2D context so the kernel needs no DOM typings. */
export interface RasterCanvasContext {
  font: string;
  textBaseline: string;
  direction: string;
  textAlign: string;
  fillStyle: unknown;
  measureText(text: string): { width: number };
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { readonly data: ArrayLike<number> };
}

export interface RasterCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d', options?: { alpha?: boolean }): RasterCanvasContext | null;
}

export function paintRasterRequest(
  request: RasterRenderRequest,
  createCanvas: () => RasterCanvas,
): RasterRenderResult {
  const makeFailure = (detail: string): RasterRenderResult => ({
    version: 1,
    requestId: request.requestId,
    ok: false,
    code: 'render-failed',
    detail,
  });
  try {
    const canvas = createCanvas();
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return makeFailure('Canvas 2D context is unavailable');
    const styles = Array.isArray(request.styles) ? request.styles : [request.style];
    const scaleX = styles.includes('double-width') ? 2 : 1;
    const scaleY = styles.includes('double-height') ? 2 : 1;
    const logicalLineHeight = 32;
    const lineHeight = logicalLineHeight * scaleY;
    const fontSize = styles.includes('font-b') ? 17 : 24;
    const topPad = 3;
    const weight = styles.includes('bold') ? '700' : '400';
    const fontFallback =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Bengali", "Nirmala UI", "Vrinda", "Bangla Sangam MN", "Noto Sans Devanagari", "Kohinoor Devanagari", "Devanagari Sangam MN", "Noto Sans Thai", "Leelawadee UI", "Thonburi", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", "Noto Sans", sans-serif';
    const fontSpec = request.bundledFont
      ? JSON.stringify(request.bundledFont.family) + ', ' + fontFallback
      : fontFallback;
    context.font = weight + ' ' + fontSize + 'px ' + fontSpec;
    context.textBaseline = 'top';
    context.direction = request.direction;
    context.textAlign = request.align === 'center' ? 'center' : 'left';
    const measure = (value: string): number => context.measureText(value).width * scaleX;
    if (typeof Intl.Segmenter !== 'function')
      return makeFailure('Grapheme segmentation is unavailable');
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const graphemes = (value: string): string[] =>
      Array.from(segmenter.segment(value), (part) => part.segment);
    const wrap = (value: string, width: number): string[] => {
      const wrapped: string[] = [];
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
    type Cell = { text: string; align: 'left' | 'right' | 'center'; width: number };
    const gapDots = Math.max(1, Math.round(request.widthDots / 48));
    const layout = request.layout;
    const renderLines: Cell[][] = layout
      ? (() => {
          const columns = layout.columns;
          const measured = columns.map((column) => Math.max(1, measure(column.text)));
          for (let i = 1; i < columns.length; i += 1) {
            if (Math.ceil(measured[i]) > request.widthDots) {
              throw new Error('Financial raster column exceeds printable width');
            }
          }
          const gaps = gapDots * (columns.length - 1);
          const available = Math.max(1, request.widthDots - gaps);
          const hasRatios = columns.every(
            (c) => typeof c.widthRatio === 'number' && c.widthRatio > 0,
          );
          const widths = hasRatios
            ? (() => {
                const allocated = columns.map((c) =>
                  Math.max(1, Math.round(available * (c.widthRatio as number))),
                );
                const totalAllocated = allocated.reduce((sum, w) => sum + w, 0);
                allocated[0] = Math.max(1, allocated[0] + (available - totalAllocated));
                return allocated;
              })()
            : columns.length === 2
              ? [
                  0,
                  Math.min(
                    Math.max(Math.ceil(measured[1]) + gapDots, Math.floor(available * 0.25)),
                    Math.floor(available * 0.45),
                  ),
                ]
              : [
                  0,
                  Math.min(
                    Math.max(Math.ceil(measured[1]) + gapDots, Math.floor(available * 0.08)),
                    Math.floor(available * 0.2),
                  ),
                  Math.min(
                    Math.max(Math.ceil(measured[2]) + gapDots, Math.floor(available * 0.22)),
                    Math.floor(available * 0.4),
                  ),
                ];
          if (!hasRatios) {
            if (columns.length === 2) widths[0] = Math.max(1, available - widths[1]);
            else widths[0] = Math.max(1, available - widths[1] - widths[2]);
          }
          for (let i = columns.length - 1; i >= 1; i -= 1) {
            const needed = Math.ceil(measured[i]);
            if (needed <= widths[i]) continue;
            let deficit = needed - widths[i];
            for (let j = 1; j < columns.length && deficit > 0; j += 1) {
              if (j === i) continue;
              const spare = Math.max(0, widths[j] - Math.ceil(measured[j]));
              if (spare > 0) {
                const take = Math.min(deficit, spare);
                widths[j] -= take;
                widths[i] += take;
                deficit -= take;
              }
            }
            if (deficit > 0) {
              const minFirstWidth = Math.min(
                widths[0],
                Math.max(1, Math.min(Math.ceil(measured[0]), Math.floor(available * 0.25))),
              );
              const spare = Math.max(0, widths[0] - minFirstWidth);
              if (spare > 0) {
                const take = Math.min(deficit, spare);
                widths[0] -= take;
                widths[i] += take;
              }
            }
          }
          const financialFitsSingleRow = columns.every(
            (_, index) => index === 0 || Math.ceil(measured[index]) <= widths[index],
          );
          if (!financialFitsSingleRow) {
            const stackedLines: Cell[][] = wrap(columns[0].text, request.widthDots).map((text) => [
              {
                text,
                align: columns[0].align,
                width: request.widthDots,
              },
            ]);
            type GroupItem = { text: string; width: number };
            let currentGroup: GroupItem[] = [];
            let currentWidth = 0;
            const flushGroup = (group: GroupItem[]): void => {
              if (group.length === 0) return;
              const leadingSlack = Math.max(0, request.widthDots - currentWidth);
              stackedLines.push(
                group.map((item, idx) => ({
                  text: item.text,
                  align: 'right' as const,
                  width: idx === 0 ? item.width + leadingSlack : item.width,
                })),
              );
            };
            for (let i = 1; i < columns.length; i += 1) {
              const colText = columns[i].text.trim();
              if (!colText) continue;
              const colWidth = Math.ceil(measured[i]);
              const nextWidth =
                currentGroup.length === 0 ? colWidth : currentWidth + gapDots + colWidth;
              if (currentGroup.length > 0 && nextWidth > request.widthDots) {
                flushGroup(currentGroup);
                currentGroup = [{ text: colText, width: colWidth }];
                currentWidth = colWidth;
              } else {
                currentGroup.push({ text: colText, width: colWidth });
                currentWidth = nextWidth;
              }
            }
            flushGroup(currentGroup);
            return stackedLines;
          }
          const wrappedColumns = columns.map((column, index) =>
            index === 0 ? wrap(column.text, widths[index]) : [column.text],
          );
          const lineCount = Math.max(1, ...wrappedColumns.map((column) => column.length));
          return Array.from({ length: lineCount }, (_, lineIndex) =>
            columns.map((column, columnIndex) => ({
              text: wrappedColumns[columnIndex][lineIndex] || '',
              align: column.align,
              width: widths[columnIndex],
            })),
          );
        })()
      : request.text
          .split(/\r?\n/)
          .flatMap((source) => wrap(source, request.widthDots))
          .map((text) => [
            {
              text,
              align: request.align === 'center' ? 'center' : 'left',
              width: request.widthDots,
            },
          ]);
    if (renderLines.length > request.maxLines) {
      return makeFailure(
        request.financial
          ? 'Financial raster unit exceeds renderer line limit'
          : 'Raster unit exceeds renderer line limit',
      );
    }
    const width = request.widthDots;
    const pixels = new Uint8Array(width * Math.max(1, renderLines.length * lineHeight));
    canvas.width = width;
    canvas.height = Math.max(1, renderLines.length * lineHeight);
    // Resizing a canvas resets its drawing state, so restore the measured
    // font and bidi direction before painting the final pixels.
    context.font = weight + ' ' + fontSize + 'px ' + fontSpec;
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
        context.textAlign = cell.align;
        const cellX =
          cell.align === 'right'
            ? x + cell.width
            : cell.align === 'center'
              ? x + cell.width / 2
              : x;
        context.fillText(cell.text, cellX / scaleX, lineIndex * logicalLineHeight + topPad);
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
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      unit: { unitId: request.requestId, financial: request.financial, complete: true, bands },
    };
  } catch (error) {
    return makeFailure(error instanceof Error ? error.message : String(error));
  }
}
