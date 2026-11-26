/**
 * The lists a screen shows beside the pizza menu, which are the POS page's
 * products and categories: fetched again after the menu changed, for the
 * session and tenant that asked, until each has answered.
 */
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { getSessionBoundaryEpoch } from '@/store/session-events';

export interface MenuList {
  url: string;
  /** Takes the route's answer; not called for an answer that came for another session or tenant. */
  apply: (data: never) => void;
}

/** Who a request is for: the tenant, and the session as its boundaries count it. */
const asker = () =>
  `${useAuthStore.getState().currentTenant?.id ?? ''}:${getSessionBoundaryEpoch()}`;

/**
 * `markAll()` says every list is out of date. `run()` fetches each list that
 * still is and has no request on its way. A list whose fetch fails, or whose
 * answer arrives after the tenant or the session changed, stays out of date,
 * so the next `run()` asks for it again. An answer asked for before the last
 * `markAll()` is older than the menu and is dropped, and the list is fetched
 * again as soon as that request settles.
 */
export function menuListSync(lists: MenuList[]) {
  /** How many times each list was marked, and the mark its applied answer was asked under. */
  const marked = new Map<MenuList, number>();
  const applied = new Map<MenuList, number>();
  const asking = new Set<MenuList>();

  const fetchList = async (list: MenuList): Promise<void> => {
    const askedBy = asker();
    const mark = marked.get(list);
    asking.add(list);
    try {
      const { data } = await api.get(list.url);
      if (askedBy === asker() && mark === marked.get(list)) {
        applied.set(list, mark as number);
        list.apply(data as never);
      }
    } catch {
      // Still out of date; the next run asks again.
    } finally {
      asking.delete(list);
    }
    // The menu changed again while this request was on its way.
    if (askedBy === asker() && mark !== marked.get(list)) await fetchList(list);
  };

  return {
    markAll: () => lists.forEach((list) => marked.set(list, (marked.get(list) ?? 0) + 1)),
    run: async (): Promise<void> => {
      await Promise.all(
        lists
          .filter((list) => marked.get(list) !== applied.get(list) && !asking.has(list))
          .map(fetchList),
      );
    },
  };
}
