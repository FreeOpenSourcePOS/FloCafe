/**
 * Sold-out gating and default selection for product variants.
 *
 * Pure so the POS modal and its tests agree on one rule: a variant that
 * tracks inventory and has none left cannot be sold.
 */

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