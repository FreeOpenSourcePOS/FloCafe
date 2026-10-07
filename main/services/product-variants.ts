import { getDatabase } from '../db';

export interface ProductVariant {
  id: string;
  product_id: string;
  name: string;
  sku: string | null;
  price: number;
  online_price: number | null;
  track_inventory: number;
  inventory_product_id: string | null;
  inventory_deduction_quantity: number | null;
  /** Portions of this product's own ingredient recipe the variant consumes. */
  recipe_multiplier: number;
  is_active: number;
}

const VARIANT_COLUMNS = 'id, product_id, name, sku, price, online_price, track_inventory, inventory_product_id, inventory_deduction_quantity, recipe_multiplier, is_active';

export function loadProductVariant(db: ReturnType<typeof getDatabase>, variantId: string): ProductVariant | undefined {
  return db.prepare(`SELECT ${VARIANT_COLUMNS} FROM product_variants WHERE id = ?`).get(variantId) as ProductVariant | undefined;
}

/**
 * Resolves the catalog variant an order line names. A missing, foreign, or
 * inactive variant is rejected rather than silently sold at the base price.
 * Every pricing surface calls this so a quote and the order it becomes cannot
 * disagree about what the customer is buying.
 */
export function resolveOrderItemVariant(
  db: ReturnType<typeof getDatabase>,
  product: { id: string; name?: string },
  item: { variant_id?: unknown },
  isOnlineOrder: boolean,
): ProductVariant | null {
  const supplied = item.variant_id;
  if (supplied !== undefined && supplied !== null && typeof supplied !== 'string') {
    throw Object.assign(new Error('variant_id must be a string'), { statusCode: 400 });
  }
  const variantId = typeof supplied === 'string' ? supplied.trim() : '';
  if (!variantId) {
    const hasVariants = db.prepare('SELECT 1 FROM product_variants WHERE product_id = ? AND is_active = 1 LIMIT 1').get(product.id);
    if (hasVariants) {
      throw Object.assign(new Error(`A variant must be selected for ${product.name || product.id}`), { statusCode: 400 });
    }
    return null;
  }

  const variant = loadProductVariant(db, variantId);
  if (!variant) {
    throw Object.assign(new Error(`Variant ${variantId} was not found`), { statusCode: 400 });
  }
  if (variant.product_id !== product.id) {
    throw Object.assign(new Error(`Variant "${variant.name}" is not an option for ${product.name || product.id}`), { statusCode: 400 });
  }
  if (Number(variant.is_active) !== 1) {
    throw Object.assign(new Error(`Variant "${variant.name}" is not available`), { statusCode: 400 });
  }
  return variant;
}

/** Backend-authoritative sell price for a variant; online orders may carry a platform price. */
export function variantUnitPrice(variant: ProductVariant, isOnlineOrder: boolean): number {
  const platformPrice = variant.online_price;
  if (isOnlineOrder && platformPrice !== null && platformPrice !== undefined) {
    return Number(platformPrice);
  }
  return Number(variant.price);
}