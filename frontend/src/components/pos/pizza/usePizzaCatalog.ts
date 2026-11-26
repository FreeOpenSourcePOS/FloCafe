'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  getPizzaCatalog,
  hasPizzaMenu,
  holdPizzaCatalog,
  loadPizzaCatalog,
  onPizzaCatalogChange,
  refreshPizzaCatalog,
} from '@/lib/pizza/catalog';
import { menuListSync } from '@/lib/pizza/menu-lists';
import type { Category, Product } from '@/lib/types';
import { useAuthStore } from '@/store/auth';
import type { PizzaCatalog } from '@shared/pizza/types';

/** The catalogue held when it is a pizza menu, which is what switches the pizza screens on. */
const pizzaMenu = () => {
  const held = getPizzaCatalog();
  return hasPizzaMenu(held) ? held : null;
};

/**
 * The shop's pizza menu, or null when it has none or the menu has no pizzas.
 * Fetched when the screen mounts and again when the session's token or tenant
 * changes, which covers a sign-in and a change of tenant; it follows every
 * later change of the catalogue held.
 */
export function usePizzaCatalog(): PizzaCatalog | null {
  const token = useAuthStore((state) => state.token);
  const tenantId = useAuthStore((state) => state.currentTenant?.id);
  useEffect(() => {
    // A failed fetch keeps what is held; the next mount asks again.
    if (token) loadPizzaCatalog().catch(() => {});
  }, [token, tenantId]);
  return useSyncExternalStore(onPizzaCatalogChange, pizzaMenu, pizzaMenu);
}

/**
 * Keeps the POS page on the menu the server holds. The catalogue is refreshed
 * when the page mounts, when its window takes the focus or shows again, and
 * when `busy` ends. While `busy` a changed menu is held back, whatever fetched
 * it, so an open sheet keeps the menu it opened on; the handler that opens one
 * calls `holdPizzaCatalog(true)` itself, so no answer slips in before this runs. When a menu the page knew
 * is replaced, the products and categories are fetched again, so the tiles,
 * the prices and the sheet agree; a list that did not arrive is asked for
 * again at the next of those moments.
 */
export function usePizzaMenuRefresh(
  busy: boolean,
  setProducts: (products: Product[]) => void,
  setCategories: (categories: Category[]) => void,
): void {
  const lists = useMemo(
    () =>
      menuListSync([
        {
          url: '/products?active=1',
          apply: (data: { products?: Product[] }) => setProducts(data.products || []),
        },
        {
          url: '/categories?active=1',
          apply: (data: { categories?: Category[] }) => setCategories(data.categories || []),
        },
      ]),
    [setProducts, setCategories],
  );
  useEffect(
    () =>
      onPizzaCatalogChange((replaced) => {
        if (!replaced) return;
        lists.markAll();
        void lists.run();
      }),
    [lists],
  );
  // Whatever opens a sheet holds the menu in its own handler, before anything renders; this
  // keeps the hold while `busy` and lets go when it ends. It never lets go at any other moment.
  useEffect(() => {
    if (!busy) return;
    holdPizzaCatalog(true);
    return () => holdPizzaCatalog(false);
  }, [busy]);
  useEffect(() => {
    if (busy) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshPizzaCatalog();
      void lists.run();
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [busy, lists]);
}
