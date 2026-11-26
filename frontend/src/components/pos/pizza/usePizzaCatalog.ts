'use client';

import { useEffect, useReducer, useRef } from 'react';
import {
  getPizzaCatalog,
  hasPizzaMenu,
  holdPizzaCatalog,
  loadPizzaCatalog,
  onPizzaCatalogChange,
  refreshPizzaCatalog,
  retryPizzaMenuLists,
  setPizzaMenuCompanion,
} from '@/lib/pizza/catalog';
import { menuListLoader } from '@/lib/pizza/menu-lists';
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
 *
 * A change is taken as an ordinary state update, not through
 * `useSyncExternalStore`, whose updates React renders ahead of others: the menu
 * and the product list the POS page is handed in the same step must reach the
 * screen in one render.
 */
export function usePizzaCatalog(): PizzaCatalog | null {
  const token = useAuthStore((state) => state.token);
  const tenantId = useAuthStore((state) => state.currentTenant?.id);
  const [, changed] = useReducer((count: number) => count + 1, 0);
  const shown = pizzaMenu();
  const first = useRef(shown);
  useEffect(() => {
    // A change between the first render and this subscription would otherwise be missed.
    if (pizzaMenu() !== first.current) changed();
    return onPizzaCatalogChange(changed);
  }, []);
  useEffect(() => {
    // A failed fetch keeps what is held; the next mount asks again.
    if (token) loadPizzaCatalog().catch(() => {});
  }, [token, tenantId]);
  return shown;
}

/**
 * Keeps the POS page on the menu the server holds. The catalogue is refreshed
 * when the page mounts, when its window takes the focus or shows again, and
 * when `busy` ends. A menu that replaces the one on screen is published only
 * together with the products and categories that go with it: until both lists
 * have loaded the page keeps the old menu and the old lists, which agree, and a
 * failed request is sent again on a timer. While `busy` the swap is held back,
 * whatever fetched the menu, so an open sheet keeps the menu it opened on; the
 * handler that opens one calls `holdPizzaCatalog(true)` itself, so no answer
 * slips in before this runs.
 */
export function usePizzaMenuRefresh(
  busy: boolean,
  setProducts: (products: Product[]) => void,
  setCategories: (categories: Category[]) => void,
): void {
  useEffect(() => {
    setPizzaMenuCompanion(
      menuListLoader([
        {
          url: '/products?active=1',
          apply: (data: { products?: Product[] }) => setProducts(data.products || []),
        },
        {
          url: '/categories?active=1',
          apply: (data: { categories?: Category[] }) => setCategories(data.categories || []),
        },
      ]),
    );
    return () => setPizzaMenuCompanion(null);
  }, [setProducts, setCategories]);
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
      retryPizzaMenuLists();
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [busy]);
}
