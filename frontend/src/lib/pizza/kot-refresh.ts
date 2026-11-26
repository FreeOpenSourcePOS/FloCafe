/** The kitchen ticket of an order whose lines another device may have replaced since it was read. */
import type { Order } from '@/lib/types';

/** What the print-kot route answers, with 409, when every line asked for was replaced or cancelled. */
export const KOT_ITEMS_CHANGED = 'KOT_ITEMS_CHANGED';

function itemsChanged(error: unknown): boolean {
  const failure = error as { status?: unknown; code?: unknown } | null;
  return failure?.status === 409 && failure.code === KOT_ITEMS_CHANGED;
}

/**
 * Prints `order`'s ticket. When its lines were replaced elsewhere first, reads the order again and
 * prints, once, its pending lines from the first one asked for on: a replacement is a newer line,
 * and an older batch has had its ticket. With none, nothing prints.
 */
export async function printKotWithRefresh<T>(
  order: Order,
  print: (order: Order) => Promise<T>,
  refresh: (orderId: Order['id']) => Promise<Order>,
): Promise<T | undefined> {
  try {
    return await print(order);
  } catch (error) {
    if (!itemsChanged(error)) throw error;
    const first = Math.min(...(order.items ?? []).map((item) => Number(item.id)));
    const fresh = await refresh(order.id);
    const items = (fresh.items ?? []).filter(
      (item) => item.status === 'pending' && Number(item.id) >= first,
    );
    return items.length > 0 ? print({ ...fresh, items }) : undefined;
  }
}
