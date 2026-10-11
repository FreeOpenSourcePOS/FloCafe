/**
 * Pure image rasterization and dithering helpers for ESC/POS receipt logo printing.
 *
 * Adheres strictly to print kernel invariants: pure functions only, no DOM,
 * no Electron, no Node IO, no filesystem, no network.
 */

import { type RasterBand, DEFAULT_RASTER_MAX_BAND_HEIGHT } from './raster';

const MAX_LOGO_RASTER_JSON_LENGTH = 250_000;
const MAX_LOGO_WIDTH_DOTS = 576;
const MAX_LOGO_HEIGHT_DOTS = 0xFFFF;

export interface PackedLogoVariant {
  readonly width: number;
  readonly height: number;
  readonly dataBase64: string;
}

export interface ReceiptLogoData {
  readonly version: 1;
  readonly originalDataUrl: string;
  readonly variants: {
    readonly [widthDots: string]: PackedLogoVariant;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseReceiptLogoData(value: ReceiptLogoData | string): ReceiptLogoData | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.length > MAX_LOGO_RASTER_JSON_LENGTH || !value.startsWith('{')) return null;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }

  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['version', 'originalDataUrl', 'variants']) ||
    parsed.version !== 1 ||
    typeof parsed.originalDataUrl !== 'string' ||
    parsed.originalDataUrl.length > MAX_LOGO_RASTER_JSON_LENGTH ||
    !isRecord(parsed.variants)
  ) {
    return null;
  }

  const variants = parsed.variants;
  const variantWidths = Object.keys(variants);
  if (variantWidths.length === 0 || variantWidths.some((width) => width !== '384' && width !== '576')) {
    return null;
  }

  for (const widthKey of variantWidths) {
    const variant = variants[widthKey];
    if (
      !isRecord(variant) ||
      !hasExactKeys(variant, ['width', 'height', 'dataBase64']) ||
      typeof variant.dataBase64 !== 'string' ||
      variant.dataBase64.length > MAX_LOGO_RASTER_JSON_LENGTH ||
      !Number.isSafeInteger(variant.width) ||
      (variant.width as number) <= 0 ||
      (variant.width as number) > Number(widthKey) ||
      !Number.isSafeInteger(variant.height) ||
      (variant.height as number) <= 0 ||
      (variant.height as number) > MAX_LOGO_HEIGHT_DOTS
    ) {
      return null;
    }

    const packedLength = Math.ceil((variant.width as number) / 8) * (variant.height as number);
    const base64Length = 4 * Math.ceil(packedLength / 3);
    if (
      !Number.isSafeInteger(packedLength) ||
      variant.dataBase64.length !== base64Length ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        variant.dataBase64,
      )
    ) {
      return null;
    }
  }

  try {
    if (JSON.stringify(parsed).length > MAX_LOGO_RASTER_JSON_LENGTH) return null;
  } catch {
    return null;
  }

  return parsed as unknown as ReceiptLogoData;
}

/**
 * Pack a 1-bit row-major pixel array (1 = black, 0 = white) into MSB-first bytes
 * as required by ESC/POS GS v 0.
 */
export function pack1BitPixels(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const widthBytes = Math.ceil(width / 8);
  const packed = new Uint8Array(widthBytes * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    const packedRowOffset = y * widthBytes;
    for (let x = 0; x < width; x += 1) {
      if (pixels[rowOffset + x] !== 0) {
        packed[packedRowOffset + Math.floor(x / 8)] |= 0x80 >> (x % 8);
      }
    }
  }

  return packed;
}

/**
 * Unpack MSB-first bytes into a 1-byte-per-pixel array (1 = black, 0 = white).
 */
export function unpack1BitPixels(packed: Uint8Array, width: number, height: number): Uint8Array {
  const widthBytes = Math.ceil(width / 8);
  const pixels = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    const packedRowOffset = y * widthBytes;
    for (let x = 0; x < width; x += 1) {
      const byte = packed[packedRowOffset + Math.floor(x / 8)];
      if ((byte & (0x80 >> (x % 8))) !== 0) {
        pixels[rowOffset + x] = 1;
      }
    }
  }

  return pixels;
}

/**
 * Applies classic Floyd-Steinberg error-diffusion dithering to grayscale pixels.
 * Input: values 0..255 (0 = black, 255 = white).
 * Output: 1 for black (ink on thermal paper), 0 for white (no ink).
 */
export function ditherGrayscalePixels(
  grayscale: Float32Array,
  width: number,
  height: number,
): Uint8Array {
  const output = new Uint8Array(width * height);
  const buffer = new Float32Array(grayscale);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const oldVal = buffer[idx];
      const newVal = oldVal < 128 ? 0 : 255;
      output[idx] = newVal === 0 ? 1 : 0; // 1 = black pixel
      const err = oldVal - newVal;

      if (x + 1 < width) {
        buffer[idx + 1] += (err * 7) / 16;
      }
      if (y + 1 < height) {
        if (x > 0) {
          buffer[(y + 1) * width + (x - 1)] += (err * 3) / 16;
        }
        buffer[(y + 1) * width + x] += (err * 5) / 16;
        if (x + 1 < width) {
          buffer[(y + 1) * width + (x + 1)] += (err * 1) / 16;
        }
      }
    }
  }

  return output;
}

/**
 * Center a pixel bitmap horizontally within a target dot width by padding with 0s.
 */
export function centerPixels(
  sourcePixels: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidthDots: number,
): Uint8Array {
  if (sourceWidth === targetWidthDots) {
    return new Uint8Array(sourcePixels);
  }

  const padded = new Uint8Array(targetWidthDots * sourceHeight);
  const leftPad = Math.max(0, Math.floor((targetWidthDots - sourceWidth) / 2));
  const copyWidth = Math.min(sourceWidth, targetWidthDots);

  for (let y = 0; y < sourceHeight; y += 1) {
    const srcStart = y * sourceWidth;
    const dstStart = y * targetWidthDots + leftPad;
    for (let x = 0; x < copyWidth; x += 1) {
      padded[dstStart + x] = sourcePixels[srcStart + x];
    }
  }

  return padded;
}

/**
 * Parse and resolve raster bands for the target printer width from stored logo data.
 */
export function getLogoRasterBands(
  storedLogoData: ReceiptLogoData | string | null | undefined,
  targetWidthDots: number,
  maxBandHeight = DEFAULT_RASTER_MAX_BAND_HEIGHT,
): RasterBand[] {
  if (
    !storedLogoData ||
    !Number.isSafeInteger(targetWidthDots) ||
    targetWidthDots <= 0 ||
    targetWidthDots > MAX_LOGO_WIDTH_DOTS ||
    !Number.isSafeInteger(maxBandHeight) ||
    maxBandHeight <= 0 ||
    maxBandHeight > MAX_LOGO_HEIGHT_DOTS
  ) {
    return [];
  }

  const parsed = parseReceiptLogoData(storedLogoData);
  if (!parsed) return [];

  // Pick exact match or closest matching width variant
  const widths = Object.keys(parsed.variants)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (widths.length === 0) return [];

  let selectedWidth = widths[0];
  if (parsed.variants[String(targetWidthDots)]) {
    selectedWidth = targetWidthDots;
  } else {
    // Pick largest variant that fits within targetWidthDots, or the smallest available
    const smaller = widths.filter((w) => w <= targetWidthDots);
    selectedWidth = smaller.length > 0 ? Math.max(...smaller) : Math.min(...widths);
  }

  const variant = parsed.variants[String(selectedWidth)];
  if (!variant) return [];

  try {
    const binaryStr =
      typeof atob === 'function'
        ? atob(variant.dataBase64)
        : Buffer.from(variant.dataBase64, 'base64').toString('binary');
    const packed = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i += 1) {
      packed[i] = binaryStr.charCodeAt(i);
    }
    if (packed.length !== Math.ceil(variant.width / 8) * variant.height) return [];

    const unpacked = unpack1BitPixels(packed, variant.width, variant.height);
    const centered = centerPixels(unpacked, variant.width, variant.height, targetWidthDots);
    const bands: RasterBand[] = [];
    for (let row = 0; row < variant.height; row += maxBandHeight) {
      const heightDots = Math.min(maxBandHeight, variant.height - row);
      bands.push({
        widthDots: targetWidthDots,
        heightDots,
        pixels: centered.slice(row * targetWidthDots, (row + heightDots) * targetWidthDots),
      });
    }
    return bands;
  } catch {
    return [];
  }
}
