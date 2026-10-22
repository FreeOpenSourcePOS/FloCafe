/**
 * The one rule for the unit price a cart line shows.
 *
 * An online order with a selected platform quotes the variant's platform price,
 * exactly as the backend prices the order it becomes; a blank platform is a
 * counter order. Kept dependency-free so the cart store stays loadable in tests.
 */

import type { ProductVariant } from '@/lib/types';

export function normalizeOverridePrice(price: number | string, decimals = 2): number {
  const num = Number(price);
  if (!Number.isFinite(num) || num < 0) return 0;
  const [mantissa, exp = '0'] = num.toString().toLowerCase().split('e');
  const shifted = Number(`${mantissa}e${Number(exp) + decimals}`);
  return Number(`${Math.round(shifted)}e-${decimals}`);
}

export function cartLineUnitPrice(
  item: {
    variant?: ProductVariant | null;
    product: { price: number | string };
    price_override?: { price: number } | null;
  },
  onlinePlatformSelected: boolean,
): number {
  return item.price_override
    ? normalizeOverridePrice(item.price_override.price)
    : cartVariantUnitPrice(item, onlinePlatformSelected);
}

export function cartVariantUnitPrice(
  item: { variant?: ProductVariant | null; product: { price: number | string } },
  onlinePlatformSelected: boolean,
): number {
  const platformPrice = onlinePlatformSelected ? item.variant?.online_price : null;
  return Number(platformPrice ?? item.variant?.price ?? item.product.price) || 0;
}
