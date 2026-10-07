/**
 * Product variant helpers.
 *
 * Sold-out gating and default selection are pure so the POS modal and its tests
 * agree on one rule: a variant that tracks inventory and has none left cannot be
 * sold. The row/payload helpers serve the back-office variants table.
 */

import { roundCurrencyValue } from './currency-input';
import type { AddonGroup, ProductVariant } from '@/lib/types';

/**
 * A tracked variant with no stock cannot be sold. A variant that links to a
 * recipe ingredient never sells from its own pool (the backend gives the link
 * precedence over `track_inventory`), so its own stock must not gate it.
 */
export function isVariantSoldOut(variant: ProductVariant): boolean {
  if (variant.inventory_product_id) return false;
  return Boolean(variant.track_inventory) && Number(variant.stock_quantity) <= 0;
}

/**
 * Whether a scanned variant must pass through the customizer instead of the
 * cart: a required add-on group still needs a selection, and a sold-out
 * variant needs the picker rather than a sale that fails at checkout.
 */
export function scannedVariantNeedsCustomizer(
  product: { addon_groups?: AddonGroup[] },
  variant: ProductVariant,
): boolean {
  const needsRequiredSelection = (product.addon_groups || []).some((group) => {
    const requiredMin = group.is_required ? Math.max(1, group.min_selection || 1) : (group.min_selection || 0);
    return requiredMin > 0;
  });
  return needsRequiredSelection || isVariantSoldOut(variant);
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
  /** Stock the row was loaded with; sent to the API only when the merchant changed it. */
  loaded_stock_quantity: string | null;
  /** Editor-only: marks a row the merchant edited, so untouched inactive history stays out of the payload. */
  touched: boolean;
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
  /**
   * Portions of the product's own ingredient recipe, as typed: 1 is one base
   * portion, 0.5 half, 2 double. Not a money value, so it is never rounded to
   * the tenant currency precision.
   */
  recipe_multiplier: string;
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
  /** Omitted when the merchant did not change the stock field, so intervening sales survive the save. */
  stock_quantity?: number;
  low_stock_threshold: number | null;
  inventory_product_id: string | null;
  inventory_deduction_quantity: number | null;
  recipe_multiplier: number;
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
    loaded_stock_quantity: null,
    touched: false,
    is_active: true,
    cost_price: null,
    track_inventory: false,
    low_stock_threshold: null,
    inventory_product_id: null,
    inventory_deduction_quantity: 1,
    recipe_multiplier: '1',
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
    loaded_stock_quantity: String(variant.stock_quantity ?? 0),
    touched: false,
    is_active: Boolean(variant.is_active),
    cost_price: variant.cost_price ?? null,
    // The variant table stores these as 0/1 integers; normalise before sending.
    track_inventory: Boolean(variant.track_inventory),
    low_stock_threshold: variant.low_stock_threshold ?? null,
    inventory_product_id: variant.inventory_product_id ?? null,
    inventory_deduction_quantity: variant.inventory_deduction_quantity ?? 1,
    // A response from a server that does not carry the portion means one.
    recipe_multiplier: String(variant.recipe_multiplier ?? 1),
  }));
}

/** A submitted portion must be a positive finite number of base recipe portions. */
export function isPositiveRecipeMultiplier(value: string): boolean {
  if (value.trim() === '') return false;
  const portion = Number(value);
  return Number.isFinite(portion) && portion > 0;
}

export function hasInvalidVariantRow(rows: ProductVariantRow[]): boolean {
  return rows.some((row) => row.name.trim() === ''
    || row.price === ''
    || !Number.isFinite(Number(row.price))
    || !isPositiveRecipeMultiplier(row.recipe_multiplier));
}

/**
 * Rows the merchant removed are absent from the payload: the products API
 * soft-deactivates the omitted variants so historical order items keep
 * resolving them.
 *
 * Untouched inactive rows are history too: submitting them would only consume
 * one of the API's 64 variant slots on every later save, so they are skipped
 * unless the merchant edited them. Active rows always travel, because the API
 * reads an omitted active row as removed.
 */
export function buildVariantsPayload(rows: ProductVariantRow[], maxDecimals: number): ProductVariantPayload[] {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.is_active || row.id === null || row.touched)
    .map(({ row, index }) => {
      const stockQuantity = Math.max(0, Number(row.stock_quantity) || 0);
      const loadedStockQuantity = row.loaded_stock_quantity !== null
        ? Math.max(0, Number(row.loaded_stock_quantity) || 0)
        : null;
      const stockUnchanged = row.id !== null
        && loadedStockQuantity !== null
        && stockQuantity === loadedStockQuantity;

      return {
        ...(row.id ? { id: row.id } : {}),
        name: row.name.trim(),
        price: roundCurrencyValue(Number(row.price), maxDecimals),
        online_price: row.online_price === '' ? null : roundCurrencyValue(Number(row.online_price), maxDecimals),
        sku: row.sku.trim() || null,
        barcode: row.barcode.trim() || null,
        // Stock is absolute on the server: resubmitting the value the editor
        // loaded would credit back any sale that happened in between.
        ...(stockUnchanged ? {} : { stock_quantity: stockQuantity }),
        is_active: row.is_active,
        cost_price: row.cost_price,
        track_inventory: row.track_inventory,
        low_stock_threshold: row.low_stock_threshold,
        inventory_product_id: row.inventory_product_id,
        inventory_deduction_quantity: row.inventory_deduction_quantity,
        recipe_multiplier: Number(row.recipe_multiplier),
        // The position in the full editor table, so a skipped inactive row keeps
        // the display order of the rows around it.
        sort_order: index,
      };
    });
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
