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
  next_cursor?: string | null;
  has_more?: boolean;
}

export function isCustomerDisplayFeed(value: unknown): value is CustomerDisplayFeed {
  if (!value || typeof value !== 'object') return false;
  const { business_name, config, orders, next_cursor, has_more } = value as Record<string, unknown>;
  return (
    typeof business_name === 'string' &&
    isCustomerDisplayConfig(config) &&
    Array.isArray(orders) &&
    orders.every(
      (order) =>
        !!order &&
        typeof order === 'object' &&
        (typeof (order as BoardOrder).id === 'number' ||
          typeof (order as BoardOrder).id === 'string') &&
        typeof (order as BoardOrder).number === 'string' &&
        typeof (order as BoardOrder).status === 'string',
    ) &&
    (next_cursor === undefined || next_cursor === null || typeof next_cursor === 'string') &&
    (has_more === undefined || typeof has_more === 'boolean')
  );
}
