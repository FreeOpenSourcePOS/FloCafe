/**
 * Image utilities for product image upload and display.
 *
 * compressImage() — Canvas API pipeline: resize to 1:1, compress to WebP.
 * nameToColor() — Deterministic HSL color from product name (for fallback tiles).
 * validateImageSize() — Check Base64 data URI length against 50K limit.
 */

const MAX_BASE64_LENGTH = 50_000;

/**
 * Compress an image file to a Base64 WebP data URI.
 * Pipeline: load → draw to canvas (1:1 crop) → toDataURL('image/webp', quality).
 *
 * @param file - Raw image file from user (max 5 MB pre-check done before calling)
 * @param quality - WebP quality (0.8 default, retries at 0.6 then 0.4 if too large)
 * @returns Base64 data URI string, or null if all attempts fail
 */
export function compressImage(file: File, quality = 0.8): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Determine crop dimensions (center-crop to 1:1)
      const size = Math.min(img.width, img.height);
      const offsetX = (img.width - size) / 2;
      const offsetY = (img.height - size) / 2;

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }

      ctx.drawImage(img, offsetX, offsetY, size, size, 0, 0, size, size);

      // Try compression with retry at lower quality
      const qualities = [quality, 0.6, 0.4];
      for (const q of qualities) {
        const dataUri = canvas.toDataURL('image/webp', q);
        if (dataUri.length <= MAX_BASE64_LENGTH) {
          resolve(dataUri);
          return;
        }
      }

      // All qualities too large — try PNG as fallback (smaller than original)
      const pngUri = canvas.toDataURL('image/png');
      if (pngUri.length <= MAX_BASE64_LENGTH) {
        resolve(pngUri);
        return;
      }

      resolve(null); // Image too complex for the size limit
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };

    img.src = url;
  });
}

/**
 * Generate a deterministic HSL color from a product name.
 * Same name always produces the same color — cashiers develop muscle memory.
 *
 * @param name - Product name
 * @returns HSL color string (e.g., "hsl(142, 45%, 65%)")
 */
export function nameToColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 65%)`;
}

/**
 * Check if a Base64 data URI is within the size limit.
 *
 * @param dataUri - Base64 data URI string
 * @returns true if valid and within 50K character limit
 */
export function validateImageSize(dataUri: string): boolean {
  return typeof dataUri === 'string' && dataUri.length <= MAX_BASE64_LENGTH;
}

/** Max Base64 string length (characters). ~36.6 KB decoded. */
export const MAX_IMAGE_LENGTH = MAX_BASE64_LENGTH;

/** Max raw file size before loading into memory (5 MB). */
export const MAX_RAW_FILE_SIZE = 5 * 1024 * 1024;
