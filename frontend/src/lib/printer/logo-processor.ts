import {
  ditherGrayscalePixels,
  findLogoContentBounds,
  normalizeGrayscaleContrast,
  pack1BitPixels,
  parseReceiptLogoData,
  unpack1BitPixels,
  type PackedLogoVariant,
  type ReceiptLogoData,
} from '@print/image-raster';

export interface ProcessedReceiptLogo {
  originalDataUrl: string;
  rasterJson: string;
  previewDataUrl: string;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_PERSISTED_LOGO_LENGTH = 250_000;
const TARGET_DATA_URL_LENGTH = 200_000;
const MAX_SOURCE_DIMENSION = 2048;
const MAX_TARGET_HEIGHT = 240;
const TRIM_MARGIN_PX = 4;
const TARGET_WIDTHS = [384, 576] as const;
const SUPPORTED_IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif|svg|avif|ico)$/i;

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

function createSourceCanvasAndCrop(img: HTMLImageElement): {
  sourceCanvas: HTMLCanvasElement;
  crop: { x: number; y: number; width: number; height: number };
} {
  const rawWidth = Math.max(1, img.naturalWidth || img.width || 576);
  const rawHeight = Math.max(1, img.naturalHeight || img.height || 240);
  const preScale = Math.min(1, MAX_SOURCE_DIMENSION / Math.max(rawWidth, rawHeight));
  const srcWidth = Math.max(1, Math.round(rawWidth * preScale));
  const srcHeight = Math.max(1, Math.round(rawHeight * preScale));

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = srcWidth;
  sourceCanvas.height = srcHeight;
  const ctx = sourceCanvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2d canvas context');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, srcWidth, srcHeight);
  ctx.drawImage(img, 0, 0, srcWidth, srcHeight);

  const imgData = ctx.getImageData(0, 0, srcWidth, srcHeight);
  const crop = findLogoContentBounds(imgData.data, srcWidth, srcHeight, TRIM_MARGIN_PX);
  return { sourceCanvas, crop };
}

function renderDitheredVariant(
  sourceCanvas: HTMLCanvasElement,
  crop: { x: number; y: number; width: number; height: number },
  targetWidth: number,
): { variant: PackedLogoVariant; dithered: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, targetWidth / crop.width, MAX_TARGET_HEIGHT / crop.height);
  const width = Math.max(1, Math.min(targetWidth, Math.round(crop.width * scale)));
  const height = Math.max(1, Math.min(MAX_TARGET_HEIGHT, Math.round(crop.height * scale)));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2d canvas context');

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const grayscale = new Float32Array(width * height);

  for (let i = 0; i < grayscale.length; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    const alphaNorm = a / 255;
    const gray = (0.299 * r + 0.587 * g + 0.114 * b) * alphaNorm + 255 * (1 - alphaNorm);
    grayscale[i] = gray;
  }

  const normalized = normalizeGrayscaleContrast(grayscale);
  const dithered = ditherGrayscalePixels(normalized, width, height);
  const packed = pack1BitPixels(dithered, width, height);

  return {
    variant: {
      width,
      height,
      dataBase64: uint8ToBase64(packed),
    },
    dithered,
    width,
    height,
  };
}

function createThermalPreview(dithered: Uint8Array, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;

  for (let i = 0; i < dithered.length; i += 1) {
    const isInk = dithered[i] === 1;
    const val = isInk ? 20 : 255; // Slightly dark gray for thermal receipt look
    data[i * 4] = val;
    data[i * 4 + 1] = val;
    data[i * 4 + 2] = val;
    data[i * 4 + 3] = 255;
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

export function getThermalPreviewDataUrl(rasterJson: string | undefined): string {
  if (!rasterJson || typeof document === 'undefined') return '';
  const parsed = parseReceiptLogoData(rasterJson);
  if (!parsed) return '';
  const variant = parsed.variants['576'] ?? parsed.variants['384'];
  if (!variant) return '';
  try {
    const packed = base64ToUint8(variant.dataBase64);
    const unpacked = unpack1BitPixels(packed, variant.width, variant.height);
    return createThermalPreview(unpacked, variant.width, variant.height);
  } catch {
    return '';
  }
}

function encodeWebLogoDataUrl(
  sourceCanvas: HTMLCanvasElement,
  crop: { x: number; y: number; width: number; height: number },
): string {
  const baseScale = Math.min(1, 576 / crop.width, MAX_TARGET_HEIGHT / crop.height);
  const baseWidth = Math.max(1, Math.round(crop.width * baseScale));
  const baseHeight = Math.max(1, Math.round(crop.height * baseScale));

  const renderAtSize = (w: number, h: number): HTMLCanvasElement => {
    const webCanvas = document.createElement('canvas');
    webCanvas.width = w;
    webCanvas.height = h;
    const webCtx = webCanvas.getContext('2d');
    if (!webCtx) throw new Error('Failed to get web canvas context');
    webCtx.fillStyle = '#FFFFFF';
    webCtx.fillRect(0, 0, w, h);
    webCtx.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h);
    return webCanvas;
  };

  const fullCanvas = renderAtSize(baseWidth, baseHeight);
  const pngUrl = fullCanvas.toDataURL('image/png');
  if (pngUrl.length <= TARGET_DATA_URL_LENGTH) {
    return pngUrl;
  }

  for (const mime of ['image/webp', 'image/jpeg'] as const) {
    for (const quality of [0.85, 0.7, 0.5] as const) {
      const candidate = fullCanvas.toDataURL(mime, quality);
      if (candidate.startsWith(`data:${mime}`) && candidate.length <= TARGET_DATA_URL_LENGTH) {
        return candidate;
      }
    }
  }

  for (const factor of [0.75, 0.5, 0.35] as const) {
    const w = Math.max(1, Math.round(baseWidth * factor));
    const h = Math.max(1, Math.round(baseHeight * factor));
    const scaledCanvas = renderAtSize(w, h);
    const candidate = scaledCanvas.toDataURL('image/jpeg', 0.7);
    if (candidate.length <= TARGET_DATA_URL_LENGTH) {
      return candidate;
    }
  }

  return fullCanvas.toDataURL('image/jpeg', 0.5);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

export function isSupportedReceiptLogoFile(file: Pick<File, 'type' | 'name'>): boolean {
  return file.type.startsWith('image/') || SUPPORTED_IMAGE_EXT_RE.test(file.name || '');
}

export async function processReceiptLogoFile(file: File): Promise<ProcessedReceiptLogo> {
  if (!isSupportedReceiptLogoFile(file)) {
    throw new Error('Selected file is not an image');
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('Image size must be less than 5 MB');
  }

  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const { sourceCanvas, crop } = createSourceCanvasAndCrop(img);
  const variants: Record<string, PackedLogoVariant> = {};
  let previewDataUrl = '';

  for (const tw of TARGET_WIDTHS) {
    const { variant, dithered, width, height } = renderDitheredVariant(sourceCanvas, crop, tw);
    variants[String(tw)] = variant;
    if (tw === 576 || !previewDataUrl) {
      previewDataUrl = createThermalPreview(dithered, width, height);
    }
  }

  const originalDataUrl = encodeWebLogoDataUrl(sourceCanvas, crop);
  if (originalDataUrl.length > MAX_PERSISTED_LOGO_LENGTH) {
    throw new Error('Processed logo exceeds maximum size (250 KB)');
  }

  const logoData: ReceiptLogoData = {
    version: 1,
    originalDataUrl: '',
    variants,
  };
  const rasterJson = JSON.stringify(logoData);
  if (rasterJson.length > MAX_PERSISTED_LOGO_LENGTH) {
    throw new Error('Processed logo exceeds maximum size (250 KB)');
  }

  return {
    originalDataUrl,
    rasterJson,
    previewDataUrl,
  };
}
