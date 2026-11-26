/**
 * When the cart is priced again: from the lists a published menu brings, and from the lists
 * fetched again after a refusal. Apart from the price guard so the guard needs no menu module.
 */
import { hasPizzaMenu, menuListsCurrentSince, reloadPizzaMenuAndLists } from '@/lib/pizza/catalog';
import {
  isPricesChanged,
  isStaleSelectionRefusal,
  repricedCart,
  usePriceGuardStore,
} from '@/lib/pizza/price-guard';
import type { Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';

let listsAt = menuListsCurrentSince();
let refreshDue = false;

/**
 * Called with each product list the POS puts on screen. When the list came with a published
 * menu, or with the refresh after a refusal, the cart is priced from it and its lines marked.
 */
export function productsShown(products: Product[]): void {
  // The page starts with no list: pricing from it would mark every line.
  if (products.length === 0 || (!refreshDue && listsAt())) return;
  refreshDue = false;
  listsAt = menuListsCurrentSince();
  const fresh = repricedCart(useCartStore.getState().items, products);
  useCartStore.setState({ items: fresh.items });
  usePriceGuardStore.setState({ offSale: fresh.offSale });
}

/**
 * Fetches the menu, products and categories again after a refusal: for its prices, or, in a shop
 * with a pizza menu, for a line no longer on sale. True for the price refusal.
 */
export function refreshAfterRefusal(error: unknown): boolean {
  const prices = isPricesChanged(error);
  if (!prices && !(hasPizzaMenu() && isStaleSelectionRefusal(error))) return false;
  refreshDue = true;
  // A failed fetch leaves the cart as it is; the lists that arrive next price it.
  reloadPizzaMenuAndLists().catch(() => {});
  return prices;
}
