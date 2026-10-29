/**
 * Order item status rules shared by the backend and the renderer: the two
 * tax-components implementations keep separate numeric policies, but they must
 * not disagree about which items count on a printed document.
 */

/** Item statuses excluded from active order calculations and printed tax. */
export const TERMINAL_ITEM_STATUSES: string[] = [
  'cancelled',
  'voided',
  'void_adjustment',
  'refunded',
];

export function isTerminalItemStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_ITEM_STATUSES.includes(status);
}

/**
 * Item statuses excluded from printed bill item lists.
 * Cancelled, voided, and negative void_adjustment rows are excluded, while
 * refunded rows remain on historical bill copies whose stored totals include them.
 */
export function isExcludedFromBillReceipt(status: unknown): boolean {
  return status !== 'refunded' && isTerminalItemStatus(status);
}

export type DerivedOrderKdsStatus = 'pending' | 'preparing' | 'ready' | 'served';
export type CustomerDisplayProjectedStatus = 'pending' | 'preparing' | 'ready';

export interface OrderItemStatusLike {
  status?: unknown;
  quantity?: unknown;
}

const DELIVERED_ITEM_STATUSES = new Set(['served', 'completed']);
const READY_OR_DELIVERED_ITEM_STATUSES = new Set(['ready', 'served', 'completed']);
const STARTED_ITEM_STATUSES = new Set(['preparing', 'ready', 'served', 'completed']);

export function deriveOrderStatusFromItems(
  items: readonly OrderItemStatusLike[] | null | undefined
): DerivedOrderKdsStatus | null {
  if (!Array.isArray(items) || items.length === 0) return null;

  const liveItems = items.filter(
    (item) => item != null && !isTerminalItemStatus(item.status) && Number(item.quantity) > 0
  );
  if (liveItems.length === 0) return null;

  if (liveItems.every((item) => typeof item.status === 'string' && DELIVERED_ITEM_STATUSES.has(item.status))) {
    return 'served';
  }
  if (
    liveItems.every((item) => typeof item.status === 'string' && READY_OR_DELIVERED_ITEM_STATUSES.has(item.status)) &&
    liveItems.some((item) => item.status === 'ready')
  ) {
    return 'ready';
  }
  if (liveItems.some((item) => typeof item.status === 'string' && STARTED_ITEM_STATUSES.has(item.status))) {
    return 'preparing';
  }
  return 'pending';
}

export function projectBoardStatusFromItems(
  items: readonly OrderItemStatusLike[] | null | undefined
): CustomerDisplayProjectedStatus | null {
  const derived = deriveOrderStatusFromItems(items);
  if (derived === null || derived === 'served') return null;
  return derived;
}
