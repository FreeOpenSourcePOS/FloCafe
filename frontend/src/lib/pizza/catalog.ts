/**
 * The pizza menu the server holds, kept for the tenant it was fetched for until
 * someone signs in or out. `refreshPizzaCatalog()` asks again, which is how a
 * till notices a menu another device loaded; the screen that loads a new menu
 * calls `reloadPizzaCatalog()`. A menu that replaces one a screen already shows
 * is published together with the lists that screen shows beside it, never before.
 */
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { onSessionBoundary } from '@/store/session-events';
import type { PizzaCatalog } from '../../../../shared/pizza/types';

type Scope = string | number | null;
type Listener = (replaced: boolean) => void;

/** A refresh fetches at most this often. */
export const REFRESH_MS = 30_000;

let held: { scope: Scope; catalog: PizzaCatalog | null } | null = null;
let request: { scope: Scope; fetching: Promise<PizzaCatalog | null> } | null = null;
let fetchedAt = -Infinity;
/** Loads the lists a screen shows beside the menu, and answers what puts them on screen. */
type Companion = () => Promise<() => void>;

/** A changed menu that is not published yet. */
interface Waiting {
  scope: Scope;
  catalog: PizzaCatalog | null;
  /** Puts the lists that go with this menu on screen; null until they have loaded. */
  apply: (() => void) | null;
  asking: boolean;
  retry?: ReturnType<typeof setTimeout>;
}

/** True while a sheet or configurator is open: a changed menu waits in `waiting`. */
let holding = false;
let waiting: Waiting | null = null;
let companion: Companion | null = null;
let companionRetryMs = 3000;
const listeners = new Set<Listener>();

/** Whose menu this is: the tenant of the session, as the POS page scopes its own data. */
const scope = (): Scope => useAuthStore.getState().currentTenant?.id ?? null;

/** The catalogue held for this tenant: null before it has loaded, and when the shop has no pizza menu. */
export function getPizzaCatalog(): PizzaCatalog | null {
  return held?.scope === scope() ? held.catalog : null;
}

/**
 * True when `menu`, by default the catalogue held now, has at least one pizza.
 * A stored menu with no pizzas counts as no menu: the pizza screens stay off.
 */
export function hasPizzaMenu(menu: PizzaCatalog | null = getPizzaCatalog()): menu is PizzaCatalog {
  return (menu?.pizzas?.length ?? 0) > 0;
}

/**
 * Calls `listener` whenever the catalogue held changes. `replaced` is true when
 * an answer this tenant already had gave way to a different one, which is when
 * the products on screen are out of date too.
 */
export function onPizzaCatalogChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Makes `answer` the catalogue held for `tenant`, puts the lists that go with
 * it on screen, and then tells every screen: one step, so a screen never
 * renders a menu beside the lists of another.
 */
function publish(tenant: Scope, answer: PizzaCatalog | null, apply?: () => void): void {
  const known = held?.scope === tenant;
  held = { scope: tenant, catalog: answer };
  apply?.();
  for (const listener of listeners) listener(known);
}

/** Forgets the menu that waits, and the retry it may have pending. */
function dropWaiting(): void {
  clearTimeout(waiting?.retry);
  waiting = null;
}

/**
 * Publishes the menu that waits once nothing holds it back: no sheet is open,
 * its lists have loaded, and the tenant it was fetched for is the one signed in.
 */
function settle(): void {
  const waited = waiting;
  if (!waited || holding || !waited.apply || waited.scope !== scope()) return;
  waiting = null;
  publish(waited.scope, waited.catalog, waited.apply);
}

/**
 * Asks for the lists that go with the menu that waits. A request that fails is
 * sent again after `companionRetryMs`, with no focus change needed; meanwhile
 * the menu and the lists on screen stay the old ones, which agree.
 */
function loadCompanion(): void {
  const waited = waiting;
  if (!waited || waited.apply || waited.asking || waited.scope !== scope()) return;
  if (!companion) {
    waited.apply = () => {};
    settle();
    return;
  }
  clearTimeout(waited.retry);
  waited.asking = true;
  companion().then(
    (apply) => {
      waited.asking = false;
      // A newer menu, a sign-out or another tenant took this one's place meanwhile.
      if (waiting !== waited) return;
      waited.apply = apply;
      settle();
    },
    () => {
      waited.asking = false;
      if (waiting === waited) waited.retry = setTimeout(loadCompanion, companionRetryMs);
    },
  );
}

/**
 * Names what loads the lists a screen shows beside the menu, which the POS page
 * does for its products and categories; null when that screen goes away. While
 * one is named, a menu that replaces the one held waits until its lists have
 * loaded, and the three are swapped together.
 */
export function setPizzaMenuCompanion(load: Companion | null, retryMs = 3000): void {
  companion = load;
  companionRetryMs = retryMs;
  loadCompanion();
}

/**
 * Asks again, at once, for lists that failed to load, and publishes a menu that waited for its
 * tenant to be signed in again: the POS calls it when it mounts and when its window comes back.
 */
export function retryPizzaMenuLists(): void {
  loadCompanion();
  settle();
}

/**
 * While held back, a changed menu is not published, whatever fetched it: a
 * refresh, a fetch already in flight, or the reload after a refused order. The
 * POS holds back while a sheet or configurator is open, so the menu does not
 * change under the cashier; letting go publishes the menu that waited with its
 * lists, once they have loaded, unless the tenant changed meanwhile.
 */
export function holdPizzaCatalog(hold: boolean): void {
  holding = hold;
  if (hold || !waiting) return;
  if (waiting.scope !== scope()) dropWaiting();
  else settle();
}

/**
 * Fetches the catalogue again. A 404 means no pizza menu is loaded, and answers
 * null. Only the latest fetch changes what is held, whatever order answers
 * arrive in, and an answer equal to what is held changes nothing. The route
 * sends no version, so equal means the same body.
 */
export function reloadPizzaCatalog(now = Date.now()): Promise<PizzaCatalog | null> {
  const tenant = scope();
  fetchedAt = now;
  const fetching: Promise<PizzaCatalog | null> = api
    .get<PizzaCatalog>('/pizza/catalog')
    .then(
      (response) => response.data,
      (error) => {
        if (error?.response?.status === 404) return null;
        // What is held stays, and the next load asks again.
        if (request?.fetching === fetching) request = null;
        throw error;
      },
    )
    .then((answer) => {
      if (request?.fetching !== fetching) return answer;
      const known = held?.scope === tenant ? held : null;
      const body = JSON.stringify(answer);
      if (known && JSON.stringify(known.catalog) === body) {
        dropWaiting();
        return known.catalog;
      }
      // The first answer for a tenant has no lists to wait for: the screen loads its own.
      if (!known && !holding) {
        dropWaiting();
        publish(tenant, answer);
        return answer;
      }
      // The same menu as the one that waits keeps its lists, loaded or on their way.
      if (waiting?.scope !== tenant || JSON.stringify(waiting.catalog) !== body) {
        dropWaiting();
        waiting = { scope: tenant, catalog: answer, apply: known ? null : () => {}, asking: false };
      }
      loadCompanion();
      settle();
      return answer;
    });
  request = { scope: tenant, fetching };
  return fetching;
}

/**
 * Fetches the menu now and puts fresh lists on screen beside it whether or not it changed: an
 * order was refused for its prices, and a price is not always in the menu. A changed menu brings
 * its lists itself, in the one step every change takes; an unchanged one has them loaded here.
 */
export async function reloadPizzaMenuAndLists(): Promise<void> {
  const tenant = scope();
  const before = held;
  await reloadPizzaCatalog();
  if (waiting?.scope === tenant || held !== before) return;
  const apply = await companion?.();
  if (tenant === scope()) apply?.();
}

/** Fetches the catalogue the first time; every later call by the same tenant answers that same fetch. */
export function loadPizzaCatalog(): Promise<PizzaCatalog | null> {
  return request?.scope === scope() ? request.fetching : reloadPizzaCatalog();
}

/**
 * Fetches the menu again when this tenant holds a pizza menu and the last
 * fetch is at least `REFRESH_MS` old. True when the menu changed. A shop with
 * no pizza menu, or with a stored menu that has no pizzas, is not asked, and a
 * failed fetch keeps what is held.
 */
export async function refreshPizzaCatalog(now = Date.now()): Promise<boolean> {
  const before = getPizzaCatalog();
  if (!hasPizzaMenu(before) || now - fetchedAt < REFRESH_MS) return false;
  try {
    return (await reloadPizzaCatalog(now)) !== before;
  } catch {
    return false;
  }
}

const STALE_MENU = /is not on the menu|does not have that ingredient|The pizza menu is not loaded/;

/** True for the server's refusal of a line that the menu it now holds does not fit. */
export function isStaleMenuRefusal(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { error?: unknown } } })
    ?.response;
  const said = response?.data?.error;
  return (
    (response?.status === 400 || response?.status === 503) &&
    typeof said === 'string' &&
    STALE_MENU.test(said)
  );
}

// The till's menu is older than the server's: fetch it now, whatever the refresh interval says.
api.interceptors.response.use(undefined, (error) => {
  if (isStaleMenuRefusal(error)) reloadPizzaCatalog().catch(() => {});
  return Promise.reject(error);
});

// A sign-in may be another store, and a remembered "no menu" must not outlive the session.
// Locking and unlocking with a PIN keep the store and its menu, so the catalogue stays.
onSessionBoundary((event) => {
  if (event !== 'login' && event !== 'logout') return;
  held = null;
  request = null;
  dropWaiting();
  fetchedAt = -Infinity;
  for (const listener of listeners) listener(false);
});
