/**
 * The pizza menu the server holds, fetched once and kept until someone signs
 * in or out. The screen that loads a new menu into the POS must call
 * `reloadPizzaCatalog()`; nothing else notices that the menu changed.
 */
import api from '@/lib/api';
import { onSessionBoundary } from '@/store/session-events';
import type { PizzaCatalog } from '../../../../shared/pizza/types';

let catalog: PizzaCatalog | null = null;
let request: Promise<PizzaCatalog | null> | null = null;

/** The catalogue held now: null before it has loaded, and when the shop has no pizza menu. */
export function getPizzaCatalog(): PizzaCatalog | null {
  return catalog;
}

/**
 * True when `held`, by default the catalogue held now, has at least one pizza.
 * A stored menu with no pizzas counts as no menu: the pizza screens stay off.
 */
export function hasPizzaMenu(held: PizzaCatalog | null = catalog): held is PizzaCatalog {
  return (held?.pizzas?.length ?? 0) > 0;
}

/**
 * Fetches the catalogue again. A 404 means no pizza menu is loaded, and answers
 * null. Only the latest fetch changes what is held, whatever order answers arrive in.
 */
export function reloadPizzaCatalog(): Promise<PizzaCatalog | null> {
  const fetching: Promise<PizzaCatalog | null> = api
    .get<PizzaCatalog>('/pizza/catalog')
    .then(
      (response) => response.data,
      (error) => {
        if (error?.response?.status === 404) return null;
        // What is held stays, and the next load asks again.
        if (request === fetching) request = null;
        throw error;
      },
    )
    .then((answer) => {
      if (request === fetching) catalog = answer;
      return answer;
    });
  request = fetching;
  return fetching;
}

/** Fetches the catalogue the first time; every later call answers that same fetch. */
export function loadPizzaCatalog(): Promise<PizzaCatalog | null> {
  return request ?? reloadPizzaCatalog();
}

// A sign-in may be another store, and a remembered "no menu" must not outlive the session.
// Locking and unlocking with a PIN keep the store and its menu, so the catalogue stays.
onSessionBoundary((event) => {
  if (event !== 'login' && event !== 'logout') return;
  catalog = null;
  request = null;
});
