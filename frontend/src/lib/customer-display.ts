export const CUSTOMER_DISPLAY_STATUSES = ['pending', 'preparing', 'ready'] as const;

export type CustomerDisplayStatus = (typeof CUSTOMER_DISPLAY_STATUSES)[number];

export interface CustomerDisplayConfig {
  statuses: CustomerDisplayStatus[];
  refresh_seconds: number;
  show_updated: boolean;
}

export const CUSTOMER_DISPLAY_DEFAULTS: CustomerDisplayConfig = {
  statuses: [...CUSTOMER_DISPLAY_STATUSES],
  refresh_seconds: 3,
  show_updated: true,
};

export const CUSTOMER_DISPLAY_PATH = '/customer-display/';

export function isCustomerDisplayConfig(value: unknown): value is CustomerDisplayConfig {
  if (!value || typeof value !== 'object') return false;
  const { statuses, refresh_seconds, show_updated } = value as Record<string, unknown>;
  return (
    Array.isArray(statuses) &&
    statuses.length > 0 &&
    statuses.every((s) => (CUSTOMER_DISPLAY_STATUSES as readonly unknown[]).includes(s)) &&
    typeof refresh_seconds === 'number' &&
    typeof show_updated === 'boolean'
  );
}

export const CUSTOMER_DISPLAY_FEED_PATH = '/customer-display/feed';

export interface BoardOrder {
  id: number | string;
  number: string;
  status: string;
}

export interface CustomerDisplayFeed {
  business_name: string;
  config: CustomerDisplayConfig;
  orders: BoardOrder[];
  /** Cursor for the next older page of the eligible queue; absent or null when exhausted. */
  next_cursor?: string | null;
}

/** Upper bound on pages walked per refresh, so a runaway queue cannot loop forever. */
export const CUSTOMER_DISPLAY_MAX_FEED_PAGES = 50;

function boardOrderKey(order: BoardOrder): string {
  return String(order.id ?? order.number);
}

/**
 * Merges feed pages fetched newest-first into one oldest-first list. An order that
 * appears in more than one page keeps its entry from the newest page, so a status
 * change between page reads never produces a duplicate row.
 */
export function mergeFeedPages(pagesNewestFirst: BoardOrder[][]): BoardOrder[] {
  const seen = new Set<string>();
  const kept = pagesNewestFirst.map((page) =>
    page.filter((order) => {
      const key = boardOrderKey(order);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
  return kept.reverse().flat();
}

export function isCustomerDisplayFeed(value: unknown): value is CustomerDisplayFeed {
  if (!value || typeof value !== 'object') return false;
  const { business_name, config, orders, next_cursor } = value as Record<string, unknown>;
  return (
    typeof business_name === 'string' &&
    (next_cursor === undefined || next_cursor === null || typeof next_cursor === 'string') &&
    isCustomerDisplayConfig(config) &&
    Array.isArray(orders) &&
    orders.every(
      (order) =>
        !!order &&
        typeof order === 'object' &&
        typeof (order as BoardOrder).number === 'string' &&
        typeof (order as BoardOrder).status === 'string',
    )
  );
}
