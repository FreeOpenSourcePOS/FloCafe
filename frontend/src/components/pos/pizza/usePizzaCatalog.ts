'use client';

import { useEffect, useState } from 'react';
import { getPizzaCatalog, hasPizzaMenu, loadPizzaCatalog } from '@/lib/pizza/catalog';
import { useAuthStore } from '@/store/auth';
import type { PizzaCatalog } from '@shared/pizza/types';

/** The catalogue when it is a pizza menu, which is what switches the pizza screens on. */
const pizzaMenu = (held: PizzaCatalog | null) => (hasPizzaMenu(held) ? held : null);

/**
 * The shop's pizza menu, or null when it has none or the menu has no pizzas.
 * Fetched when the screen mounts and again after a sign-in, which clears what
 * was held.
 */
export function usePizzaCatalog(): PizzaCatalog | null {
  const token = useAuthStore((state) => state.token);
  const [catalog, setCatalog] = useState(() => pizzaMenu(getPizzaCatalog()));
  useEffect(() => {
    let current = true;
    (token ? loadPizzaCatalog() : Promise.resolve(null)).then(
      (loaded) => {
        if (current) setCatalog(pizzaMenu(loaded));
      },
      // A failed fetch keeps what is held; the next mount asks again.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [token]);
  return catalog;
}
