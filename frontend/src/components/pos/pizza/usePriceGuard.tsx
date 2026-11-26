'use client';

import { useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { reloadPizzaMenuAndLists } from '@/lib/pizza/catalog';
import { isPricesChanged, repricedCart, usePriceGuardStore } from '@/lib/pizza/price-guard';
import type { CartItem, Product } from '@/lib/types';
import { useCartStore } from '@/store/cart';

/**
 * What the POS page hands a failed order request. For the server's refusal of the prices the
 * till showed it answers true, shows the message and fetches the menu, products and categories
 * again; when those products reach the page the cart is priced from them, every line kept, and
 * the cashier places the order again. Any other failure answers false and is the page's.
 */
export function usePriceGuard(products: Product[]): (error: unknown) => boolean {
  const t = useTranslations('pizza');
  const refused = useRef(false);
  useEffect(() => {
    if (!refused.current) return;
    refused.current = false;
    const fresh = repricedCart(useCartStore.getState().items, products);
    useCartStore.setState({ items: fresh.items });
    usePriceGuardStore.setState({ offSale: fresh.offSale });
  }, [products]);
  return useCallback(
    (error) => {
      if (!isPricesChanged(error)) return false;
      refused.current = true;
      toast.error(t('pricesChanged'), { id: 'pizza-prices-changed', duration: 10_000 });
      // A failed fetch leaves the cart as it is; the lists that arrive next price it.
      reloadPizzaMenuAndLists().catch(() => {});
      return true;
    },
    [t],
  );
}

/** Marks a cart line the last refusal found off sale; the server refuses it until it is removed. */
export function OffSaleMark({ item }: { item: CartItem }) {
  const t = useTranslations('pizza');
  const offSale = usePriceGuardStore((state) => state.offSale.includes(item.id));
  if (!offSale) return null;
  return (
    <span
      data-testid="pizza-line-off-sale"
      className="ms-1.5 inline-block rounded-full bg-red-700 px-1.5 align-middle text-[11px] font-bold leading-4 text-white"
    >
      {t('offSale')}
    </span>
  );
}
