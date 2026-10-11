import {
  ditherGrayscalePixels,
  pack1BitPixels,
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
const TARGET_WIDTHS = [384, 576] as const;

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

function renderDitheredVariant(
  img: HTMLImageElement,
  targetWidth: number,
): { variant: PackedLogoVariant; dithered: Uint8Array; width: number; height: number } {
  // Scale down to fit within targetWidth, preserving aspect ratio.
  const scale = img.width > targetWidth ? targetWidth / img.width : 1;
  const width = Math.max(1, Math.min(targetWidth, Math.round(img.width * scale)));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2d canvas context');

  // Fill white background first (in case of transparent PNG)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const grayscale = new Float32Array(width * height);

  for (let i = 0; i < grayscale.length; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    // Blend with white if semi-transparent
    const alphaNorm = a / 255;
    const gray = (0.299 * r + 0.587 * g + 0.114 * b) * alphaNorm + 255 * (1 - alphaNorm);
    grayscale[i] = gray;
  }

  const dithered = ditherGrayscalePixels(grayscale, width, height);
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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

export async function processReceiptLogoFile(file: File): Promise<ProcessedReceiptLogo> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Selected file is not an image');
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('Image size must be less than 5 MB');
  }

  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const variants: Record<string, PackedLogoVariant> = {};
  let previewDataUrl = '';

  for (const tw of TARGET_WIDTHS) {
    const { variant, dithered, width, height } = renderDitheredVariant(img, tw);
    variants[String(tw)] = variant;
    if (tw === 576 || !previewDataUrl) {
      previewDataUrl = createThermalPreview(dithered, width, height);
    }
  }

  // Generate resized web/browser print data URL (max 576px wide)
  const scale = img.width > 576 ? 576 / img.width : 1;
  const webWidth = Math.round(img.width * scale);
  const webHeight = Math.round(img.height * scale);
  const webCanvas = document.createElement('canvas');
  webCanvas.width = webWidth;
  webCanvas.height = webHeight;
  const webCtx = webCanvas.getContext('2d');
  if (!webCtx) throw new Error('Failed to get web canvas context');
  webCtx.fillStyle = '#FFFFFF';
  webCtx.fillRect(0, 0, webWidth, webHeight);
  webCtx.drawImage(img, 0, 0, webWidth, webHeight);

  const originalDataUrl = webCanvas.toDataURL('image/png');
  if (originalDataUrl.length > MAX_PERSISTED_LOGO_LENGTH) {
    throw new Error('Processed logo exceeds maximum size (250 KB)');
  }

  const logoData: ReceiptLogoData = {
    version: 1,
    originalDataUrl,
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
