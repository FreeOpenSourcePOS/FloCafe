import {
  projectBoardStatusFromItems,
  type OrderItemStatusLike,
} from '../../../shared/order-item-status';

export const CUSTOMER_DISPLAY_STATUSES = ['pending', 'preparing', 'ready'] as const;
export const CUSTOMER_DISPLAY_ORDER_TYPES = ['takeaway', 'dine_in', 'online', 'delivery'] as const;

export const MAX_DISPLAY_FEED_PAGES = 50;

export type CustomerDisplayStatus = (typeof CUSTOMER_DISPLAY_STATUSES)[number];
export type CustomerDisplayOrderType = (typeof CUSTOMER_DISPLAY_ORDER_TYPES)[number];

export interface CustomerDisplayConfig {
  statuses: CustomerDisplayStatus[];
  order_types: CustomerDisplayOrderType[];
  refresh_seconds: number;
  show_updated: boolean;
}

export const CUSTOMER_DISPLAY_DEFAULTS: CustomerDisplayConfig = {
  statuses: [...CUSTOMER_DISPLAY_STATUSES],
  order_types: ['takeaway'],
  refresh_seconds: 3,
  show_updated: true,
};

export const CUSTOMER_DISPLAY_PATH = '/customer-display/';

export function isCustomerDisplayConfig(value: unknown): value is CustomerDisplayConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const { statuses, order_types, refresh_seconds, show_updated } = record;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    !statuses.every((s) => (CUSTOMER_DISPLAY_STATUSES as readonly unknown[]).includes(s)) ||
    typeof refresh_seconds !== 'number' ||
    typeof show_updated !== 'boolean'
  ) {
    return false;
  }
  if (order_types === undefined) {
    if (Object.isExtensible(record)) {
      record.order_types = [...CUSTOMER_DISPLAY_DEFAULTS.order_types];
    }
    return true;
  }
  if (
    !Array.isArray(order_types) ||
    order_types.length === 0 ||
    !order_types.every((t) => (CUSTOMER_DISPLAY_ORDER_TYPES as readonly unknown[]).includes(t))
  ) {
    return false;
  }
  const normalizedOrderTypes = CUSTOMER_DISPLAY_ORDER_TYPES.filter((t) => order_types.includes(t));
  if (normalizedOrderTypes.length === 0) return false;
  if (!Object.isFrozen(record)) {
    record.order_types = normalizedOrderTypes;
  }
  return true;
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

export interface SignedInBoardOrderSource {
  id: number | string;
  order_number: string;
  status: string;
  type?: string | null;
  created_at: string;
  bill?: { bill_number?: string | null } | null;
  items?: readonly OrderItemStatusLike[] | null;
}

export interface SignedInOrdersQueryParams {
  view: 'active';
  board_status?: string;
  type?: string;
  per_page: number;
  before_id?: number | string;
}

export interface SignedInOrdersPageResponse {
  orders?: SignedInBoardOrderSource[];
  nextCursor?: number | string | null;
}

export function compareBoardOrderIds(a: number | string, b: number | string): number {
  const numA = typeof a === 'number' ? a : Number(a);
  const numB = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) {
    return numA - numB;
  }
  return String(a).localeCompare(String(b));
}

export function resolveOrderBoardStatus(order: SignedInBoardOrderSource): string | null {
  if (order.status === 'completed') {
    return projectBoardStatusFromItems(order.items);
  }
  return order.status;
}

export function toBoardOrder(order: SignedInBoardOrderSource, status: string): BoardOrder {
  return {
    id: order.id,
    number: order.bill?.bill_number || order.order_number,
    status,
  };
}

export async function fetchSignedInBoardOrders(options: {
  config: Omit<CustomerDisplayConfig, 'order_types'> & {
    order_types?: CustomerDisplayOrderType[];
  };
  fetchPage: (params: SignedInOrdersQueryParams) => Promise<SignedInOrdersPageResponse>;
  isStale?: () => boolean;
}): Promise<{ orders: BoardOrder[]; stale: boolean }> {
  const { config, fetchPage, isStale } = options;
  const orderTypes =
    config.order_types && config.order_types.length > 0
      ? config.order_types
      : CUSTOMER_DISPLAY_DEFAULTS.order_types;
  const allowedOrderTypes = new Set<string>(orderTypes);
  const seenById = new Map<string, { order: SignedInBoardOrderSource; projectedStatus: string }>();
  let beforeId: number | string | null = null;

  for (let pageIndex = 0; pageIndex < MAX_DISPLAY_FEED_PAGES; pageIndex += 1) {
    const page = await fetchPage({
      view: 'active',
      board_status: config.statuses.join(','),
      type: orderTypes.join(','),
      per_page: 100,
      ...(beforeId !== null ? { before_id: beforeId } : {}),
    });
    if (isStale?.()) {
      return { orders: [], stale: true };
    }
    for (const order of page.orders ?? []) {
      if (
        typeof order.type === 'string' &&
        order.type.length > 0 &&
        !allowedOrderTypes.has(order.type)
      ) {
        continue;
      }
      const projectedStatus = resolveOrderBoardStatus(order);
      if (projectedStatus && (config.statuses as string[]).includes(projectedStatus)) {
        seenById.set(String(order.id), { order, projectedStatus });
      }
    }
    const nextCursor = page.nextCursor;
    if (nextCursor === undefined || nextCursor === null || nextCursor === '') break;
    if (beforeId !== null && String(beforeId) === String(nextCursor)) break;
    beforeId = nextCursor;
  }

  if (isStale?.()) {
    return { orders: [], stale: true };
  }

  const orders = [...seenById.values()]
    .sort((a, b) => {
      if (a.order.created_at !== b.order.created_at) {
        return a.order.created_at < b.order.created_at ? -1 : 1;
      }
      return compareBoardOrderIds(a.order.id, b.order.id);
    })
    .map(({ order, projectedStatus }) => toBoardOrder(order, projectedStatus));

  return { orders, stale: false };
}
