/**
 * The price guard, on the till's side: the amount the cart showed goes with the
 * order as `expected_subtotal`, and the server refuses the order with 409
 * `PRICES_CHANGED` when it would charge another. The cart is then priced again
 * from the fresh product list, every line kept.
 */
import { create } from 'zustand';
import { normalizeCartItems } from '@/lib/cart-identity';
import { cartLinesTotal } from '@/lib/cart-price';
import type { CartItem, Order, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';

type PricedCart = { items: CartItem[]; orderType: string; onlinePlatform: string };

/**
 * Whether the cart's lines are priced for a platform: by the order they are being added to, or
 * by the cart's own order type and platform.
 */
export function cartPricedOnline(cart: PricedCart, order?: Order | null): boolean {
  return order
    ? Boolean(order.online_platform)
    : cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0;
}

/**
 * What the cart shows for its lines before tax, order discounts and charges, the same figure
 * `subtotal()` shows: unit price (the owner's override, or the platform price of an online
 * order) plus add-ons, times quantity, each line rounded as the server rounds it.
 */
export function cartExpectedSubtotal(cart: PricedCart, online = cartPricedOnline(cart)): number {
  return cartLinesTotal(cart.items, online);
}

/** True for the server's refusal of an order whose prices are not the ones the till showed. */
export function isPricesChanged(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { code?: unknown } } })
    ?.response;
  return response?.status === 409 && response.data?.code === 'PRICES_CHANGED';
}

const STALE_SELECTION =
  /is not on the menu|is not available|was not found|^Product \S+ not found$|is not an option for/;

/** True for the server's refusal of a product, size or add-on that is no longer on sale. */
export function isStaleSelectionRefusal(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { error?: unknown } } })
    ?.response;
  const said = response?.data?.error;
  return (
    (response?.status === 400 || response?.status === 404) &&
    typeof said === 'string' &&
    STALE_SELECTION.test(said)
  );
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

/**
 * Puts the lines of an append refused for its prices back in an empty cart, set up for the order
 * they were for; the lists the refusal fetches price them. False when there is nothing to put
 * back or the cart already holds lines.
 */
export function giveBackAppend(
  attempt: { lines?: unknown[]; specialInstructions?: string },
  order: Order,
): boolean {
  const cart = useCartStore.getState();
  if (!attempt.lines?.length || cart.items.length > 0) return false;
  cart.setOrderType(order.type);
  cart.loadItems(
    attempt.lines as CartItem[],
    order.table_id,
    cart.customerId,
    order.guest_count || 1,
    attempt.specialInstructions,
  );
  return true;
}

useCartStore.subscribe((cart) => {
  const { offSale } = usePriceGuardStore.getState();
  const kept = offSale.filter((id) => cart.items.some((item) => item.id === id));
  if (kept.length !== offSale.length) usePriceGuardStore.setState({ offSale: kept });
});
