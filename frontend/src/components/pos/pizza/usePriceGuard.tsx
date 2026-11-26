'use client';

import { useCallback, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { usePriceGuardStore } from '@/lib/pizza/price-guard';
import { productsShown, refreshAfterRefusal } from '@/lib/pizza/price-refresh';
import type { CartItem, Product } from '@/lib/types';

/**
 * What the POS page hands a failed order request. For the server's refusal of the prices the
 * till showed it answers true, shows the message and fetches the menu, products and categories
 * again; a refusal of a line no longer on sale fetches them too and answers false. When those
 * products, or the ones a published menu brings, reach the page the cart is priced from them,
 * every line kept and any line off sale marked. Any other failure answers false and is the page's.
 */
export function usePriceGuard(products: Product[]): (error: unknown) => boolean {
  const t = useTranslations('pizza');
  useEffect(() => productsShown(products), [products]);
  return useCallback(
    (error) => {
      if (!refreshAfterRefusal(error)) return false;
      toast.error(t('pricesChanged'), { id: 'pizza-prices-changed', duration: 10_000 });
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
