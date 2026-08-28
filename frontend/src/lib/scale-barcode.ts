import type { Product } from '@/lib/types';

export type ScaleBarcodeConfig = {
  prefix: string;
  productDigits: number;
  weightDigits: number;
  unit: 'grams';
};

export type ParsedScaleBarcode = {
  plu: string;
  quantity: number;
};

export const DEFAULT_SCALE_BARCODE_CONFIG: ScaleBarcodeConfig = {
  prefix: '21',
  productDigits: 5,
  weightDigits: 5,
  unit: 'grams',
};

export function normalizeBarcode(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseScaleBarcode(
  code: string,
  config: ScaleBarcodeConfig = DEFAULT_SCALE_BARCODE_CONFIG,
): ParsedScaleBarcode | null {
  const normalized = normalizeBarcode(code);
  const payloadLength = config.prefix.length + config.productDigits + config.weightDigits;
  if (normalized.length < payloadLength || !normalized.startsWith(config.prefix) || !/^\d+$/.test(normalized)) {
    return null;
  }

  const pluStart = config.prefix.length;
  const plu = normalized.slice(pluStart, pluStart + config.productDigits);
  const weightRaw = normalized.slice(pluStart + config.productDigits, payloadLength);
  const grams = Number.parseInt(weightRaw, 10);
  if (!Number.isSafeInteger(grams) || grams <= 0) return null;
  return { plu, quantity: grams / 1000 };
}

function roundedQuantity(value: number, precision: number | null | undefined): number {
  const digits = Number.isSafeInteger(precision) ? Math.min(Math.max(Number(precision), 0), 4) : 3;
  return Number(value.toFixed(digits));
}

function quantityForProductUnit(parsed: ParsedScaleBarcode, product: Product): number | null {
  if (product.sale_unit === 'kg') return roundedQuantity(parsed.quantity, product.weight_precision);
  if (product.sale_unit === 'g') return roundedQuantity(parsed.quantity * 1000, product.weight_precision);
  if (product.sale_unit === 'lb') return roundedQuantity(parsed.quantity / 0.45359237, product.weight_precision);
  return null;
}

export function resolveScannedProduct(
  code: string,
  products: Product[],
): { product: Product; quantity: number; scaleBarcode: ParsedScaleBarcode | null } | null {
  const normalizedCode = normalizeBarcode(code);
  const exact = products.find((product) => normalizeBarcode(product.barcode) === normalizedCode);
  if (exact) return { product: exact, quantity: 1, scaleBarcode: null };

  const parsed = parseScaleBarcode(normalizedCode);
  if (!parsed) return null;
  const product = products.find((candidate) => {
    if (!candidate.allow_fractional_quantity) return false;
    if (candidate.sale_unit !== 'kg' && candidate.sale_unit !== 'g' && candidate.sale_unit !== 'lb') return false;
    return normalizeBarcode(candidate.barcode) === parsed.plu || normalizeBarcode(candidate.sku) === parsed.plu;
  });
  if (!product) return null;
  const quantity = quantityForProductUnit(parsed, product);
  return quantity ? { product, quantity, scaleBarcode: parsed } : null;
}
