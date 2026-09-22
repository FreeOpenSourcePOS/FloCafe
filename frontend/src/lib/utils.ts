import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Parses backend UTC timestamp (YYYY-MM-DD HH:MM:SS or ISO) into Date
 * without shifting for local machine timezone offset. */
export function parseDbTimestamp(ts: string | null | undefined): Date {
  if (!ts) return new Date(NaN)
  return /^\d{4}-\d{2}-\d{2} /.test(ts) ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date(ts)
}

/** Step for fractional quantity products, or null when integer-only. */
export function fractionalQuantityStep(product: {
  allow_fractional_quantity?: boolean | null | undefined;
  sale_unit?: string | null | undefined;
  weight_precision?: number | null | undefined;
}): number | null {
  if (!product.allow_fractional_quantity || product.sale_unit === 'each') return null
  const raw = product.weight_precision
  const precision = Number.isInteger(raw) ? Math.min(Math.max(raw as number, 0), 4) : 3
  return 10 ** -precision
}

export function roundToQuantityPrecision(value: number, step: number): number {
  if (step >= 1) return Math.round(value)
  const precision = Math.round(-Math.log10(step))
  return Number(value.toFixed(precision))
}
