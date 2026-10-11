/**
 * Pure image rasterization and dithering helpers for ESC/POS receipt logo printing.
 *
 * Adheres strictly to print kernel invariants: pure functions only, no DOM,
 * no Electron, no Node IO, no filesystem, no network.
 */

import { type RasterBand, DEFAULT_RASTER_MAX_BAND_HEIGHT } from './raster';

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
 * Parse and resolve a RasterBand for the target printer width from stored logo data.
 */
export function getLogoRasterBand(
  storedLogoData: ReceiptLogoData | string | null | undefined,
  targetWidthDots: number,
  maxBandHeight = DEFAULT_RASTER_MAX_BAND_HEIGHT,
): RasterBand | null {
  if (!storedLogoData) return null;

  let parsed: ReceiptLogoData | null = null;
  if (typeof storedLogoData === 'string') {
    if (!storedLogoData.startsWith('{')) return null;
    try {
      parsed = JSON.parse(storedLogoData) as ReceiptLogoData;
    } catch {
      return null;
    }
  } else if (typeof storedLogoData === 'object' && storedLogoData.version === 1) {
    parsed = storedLogoData;
  }

  if (!parsed || !parsed.variants) return null;

  // Pick exact match or closest matching width variant
  const widths = Object.keys(parsed.variants)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (widths.length === 0) return null;

  let selectedWidth = widths[0];
  if (parsed.variants[String(targetWidthDots)]) {
    selectedWidth = targetWidthDots;
  } else {
    // Pick largest variant that fits within targetWidthDots, or the smallest available
    const smaller = widths.filter((w) => w <= targetWidthDots);
    selectedWidth = smaller.length > 0 ? Math.max(...smaller) : Math.min(...widths);
  }

  const variant = parsed.variants[String(selectedWidth)];
  if (!variant || !variant.dataBase64 || variant.width <= 0 || variant.height <= 0) return null;

  try {
    const binaryStr =
      typeof atob === 'function'
        ? atob(variant.dataBase64)
        : Buffer.from(variant.dataBase64, 'base64').toString('binary');
    const packed = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i += 1) {
      packed[i] = binaryStr.charCodeAt(i);
    }

    const unpacked = unpack1BitPixels(packed, variant.width, variant.height);
    const centered = centerPixels(unpacked, variant.width, variant.height, targetWidthDots);

    return {
      widthDots: targetWidthDots,
      heightDots: Math.min(variant.height, maxBandHeight),
      pixels: centered.slice(0, targetWidthDots * Math.min(variant.height, maxBandHeight)),
    };
  } catch {
    return null;
  }
}
