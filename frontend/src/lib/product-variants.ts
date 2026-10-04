/**
 * Product variant helpers.
 *
 * Sold-out gating and default selection are pure so the POS modal and its tests
 * agree on one rule: a variant that tracks inventory and has none left cannot be
 * sold. The row/payload helpers serve the back-office variants table.
 */

import { roundCurrencyValue } from './currency-input';
import type { ProductVariant } from '@/lib/types';

/** A tracked variant with no stock cannot be sold. */
export function isVariantSoldOut(variant: ProductVariant): boolean {
  return Boolean(variant.track_inventory) && Number(variant.stock_quantity) <= 0;
}

/** Active variants in display order. */
export function activeVariants(variants: ProductVariant[] | null | undefined): ProductVariant[] {
  return (variants || []).filter((variant) => variant.is_active);
}

/**
 * The variant a customizer opens on: the one already on the line when it is
 * still sellable, otherwise the first sellable variant. Null when the product
 * has variants but none of them can be sold.
 */
export function selectDefaultVariant(
  variants: ProductVariant[],
  initialVariantId?: string | null,
): ProductVariant | null {
  return variants.find((variant) => variant.id === initialVariantId && !isVariantSoldOut(variant))
    ?? variants.find((variant) => !isVariantSoldOut(variant))
    ?? null;
}

/** Editable state for one row of the back-office variants table. */
export interface ProductVariantRow {
  /** Existing server-side id; null for a row the merchant just added. */
  id: string | null;
  name: string;
  price: string;
  online_price: string;
  sku: string;
  barcode: string;
  stock_quantity: string;
  is_active: boolean;
  /**
   * Backend-managed. This screen has no inputs for these, but the products API
   * treats the submitted array as authoritative and resets anything omitted, so
   * they are loaded from the product and round-tripped unchanged on every save.
   */
  cost_price: number | null;
  track_inventory: boolean;
  low_stock_threshold: number | null;
  inventory_product_id: string | null;
  inventory_deduction_quantity: number | null;
}

export interface ProductVariantPayload {
  id?: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  online_price: number | null;
  cost_price: number | null;
  track_inventory: boolean;
  stock_quantity: number;
  low_stock_threshold: number | null;
  inventory_product_id: string | null;
  inventory_deduction_quantity: number | null;
  is_active: boolean;
  sort_order: number;
}

export function newVariantRow(): ProductVariantRow {
  return {
    id: null,
    name: '',
    price: '',
    online_price: '',
    sku: '',
    barcode: '',
    stock_quantity: '0',
    is_active: true,
    cost_price: null,
    track_inventory: false,
    low_stock_threshold: null,
    inventory_product_id: null,
    inventory_deduction_quantity: 1,
  };
}

export function toVariantRows(variants: ProductVariant[] | null | undefined): ProductVariantRow[] {
  return (variants ?? []).map((variant) => ({
    id: variant.id,
    name: variant.name,
    price: String(variant.price),
    online_price: variant.online_price === null || variant.online_price === undefined ? '' : String(variant.online_price),
    sku: variant.sku ?? '',
    barcode: variant.barcode ?? '',
    stock_quantity: String(variant.stock_quantity ?? 0),
    is_active: Boolean(variant.is_active),
    cost_price: variant.cost_price ?? null,
    // The variant table stores these as 0/1 integers; normalise before sending.
    track_inventory: Boolean(variant.track_inventory),
    low_stock_threshold: variant.low_stock_threshold ?? null,
    inventory_product_id: variant.inventory_product_id ?? null,
    inventory_deduction_quantity: variant.inventory_deduction_quantity ?? 1,
  }));
}

export function hasInvalidVariantRow(rows: ProductVariantRow[]): boolean {
  return rows.some((row) => row.name.trim() === '' || row.price === '' || !Number.isFinite(Number(row.price)));
}

/**
 * Rows the merchant removed are absent from the payload: the products API
 * soft-deactivates the omitted variants so historical order items keep
 * resolving them.
 */
export function buildVariantsPayload(rows: ProductVariantRow[], maxDecimals: number): ProductVariantPayload[] {
  return rows.map((row, index) => ({
    ...(row.id ? { id: row.id } : {}),
    name: row.name.trim(),
    price: roundCurrencyValue(Number(row.price), maxDecimals),
    online_price: row.online_price === '' ? null : roundCurrencyValue(Number(row.online_price), maxDecimals),
    sku: row.sku.trim() || null,
    barcode: row.barcode.trim() || null,
    stock_quantity: Math.max(0, Number(row.stock_quantity) || 0),
    is_active: row.is_active,
    cost_price: row.cost_price,
    track_inventory: row.track_inventory,
    low_stock_threshold: row.low_stock_threshold,
    inventory_product_id: row.inventory_product_id,
    inventory_deduction_quantity: row.inventory_deduction_quantity,
    sort_order: index,
  }));
}

/** Returns the same array reference when the move would fall outside the table. */
export function moveVariantRow(rows: ProductVariantRow[], index: number, offset: -1 | 1): ProductVariantRow[] {
  const target = index + offset;
  if (target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function removeVariantRow(rows: ProductVariantRow[], index: number): ProductVariantRow[] {
  return rows.filter((_, i) => i !== index);
}
