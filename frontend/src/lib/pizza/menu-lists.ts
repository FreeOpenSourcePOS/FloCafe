/**
 * The lists a screen shows beside the pizza menu, which are the POS page's
 * products and categories: loaded together for the session and tenant that
 * asked, and put on screen in one step.
 */
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { getSessionBoundaryEpoch } from '@/store/session-events';

export interface MenuList {
  url: string;
  /** Takes the route's answer and puts it on screen. */
  apply: (data: never) => void;
}

/** Who a request is for: the tenant, and the session as its boundaries count it. */
const asker = () =>
  `${useAuthStore.getState().currentTenant?.id ?? ''}:${getSessionBoundaryEpoch()}`;

/**
 * A loader for `setPizzaMenuCompanion`: each call fetches every list and
 * answers the function that puts them all on screen. It fails, showing
 * nothing, when any list fails or when the tenant or the session changed
 * before the answers arrived, so one list is never shown without the other.
 */
export function menuListLoader(lists: MenuList[]): () => Promise<() => void> {
  return async () => {
    const askedBy = asker();
    const answers = await Promise.all(lists.map((list) => api.get(list.url)));
    if (askedBy !== asker()) throw new Error('The lists were asked for by another session');
    return () => lists.forEach((list, index) => list.apply(answers[index].data as never));
  };
}
