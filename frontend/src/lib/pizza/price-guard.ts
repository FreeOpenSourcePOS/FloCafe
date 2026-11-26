/**
 * The price guard, on the till's side: the amount the cart showed goes with the
 * order as `expected_subtotal`, and the server refuses the order with 409
 * `PRICES_CHANGED` when it would charge another. The cart is then priced again
 * from the fresh product list, every line kept.
 */
import { create } from 'zustand';
import { normalizeCartItems } from '@/lib/cart-identity';
import { cartLineUnitPrice, draftLinesTotal } from '@/lib/cart-price';
import type { CartItem, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';

/**
 * What the cart shows for its lines before tax, order discounts and charges:
 * unit price (the owner's override, or the platform price of an online order)
 * plus add-ons, times quantity, each line rounded as the server rounds it.
 * `online` is whether the order is priced for a platform; the cart's own answer
 * by default, the order's when lines are added to one.
 */
export function cartExpectedSubtotal(
  cart: { items: CartItem[]; orderType: string; onlinePlatform: string },
  online?: boolean,
): number {
  const platform = online ?? (cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0);
  return draftLinesTotal(
    cart.items.map((item) => ({
      unitPrice: cartLineUnitPrice(item, platform),
      quantity: Number(item.quantity) || 1,
      addons: item.addons,
    })),
  );
}

/** True for the server's refusal of an order whose prices are not the ones the till showed. */
export function isPricesChanged(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { code?: unknown } } })
    ?.response;
  return response?.status === 409 && response.data?.code === 'PRICES_CHANGED';
}

/**
 * The cart with the product, size and add-on prices of `products`, the fresh
 * list. A line whose product, size or add-on is not in it is left as it was and
 * named in `offSale`; none is dropped.
 */
export function repricedCart(
  items: CartItem[],
  products: Product[],
): { items: CartItem[]; offSale: string[] } {
  const offSale: string[] = [];
  const priced = items.map((item) => {
    const product = products.find((entry) => entry.id === item.product.id);
    const variant = item.variant
      ? product?.variants?.find((entry) => entry.id === item.variant?.id)
      : null;
    const onSale = (product?.addon_groups ?? []).flatMap((group) => group.addons ?? []);
    const addons = item.addons.flatMap((addon) => {
      const now = onSale.find((entry) => entry.id === addon.id);
      return now ? [{ ...addon, name: now.name, price: now.price }] : [];
    });
    if (!product || variant === undefined || addons.length !== item.addons.length) {
      offSale.push(item.id);
      return item;
    }
    return { ...item, product, variant, addons };
  });
  // A line's identity holds its add-on prices, so the lines are named again.
  return { items: normalizeCartItems(priced), offSale };
}

/** The cart lines the last refusal found off sale, until they leave the cart. */
export const usePriceGuardStore = create<{ offSale: string[] }>(() => ({ offSale: [] }));

useCartStore.subscribe((cart) => {
  const { offSale } = usePriceGuardStore.getState();
  const kept = offSale.filter((id) => cart.items.some((item) => item.id === id));
  if (kept.length !== offSale.length) usePriceGuardStore.setState({ offSale: kept });
});
