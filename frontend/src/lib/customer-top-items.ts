import type { Product } from '@/lib/types';

/** One entry of `GET /customers/:id/top-items`. */
export interface CustomerTopItem {
  product_id: string;
  product_name: string;
  total_quantity: number;
  order_count: number;
  available: boolean;
}

/** A settled top-items request, tagged with the customer it was made for. */
export type CustomerTopItemsResult =
  | { customerId: string; status: 'ready'; items: CustomerTopItem[] }
  | { customerId: string; status: 'error' };

export interface ResolvedCustomerTopItem extends CustomerTopItem {
  /** The product as the POS catalog has it now; null when it cannot be added. */
  product: Product | null;
}

export type CustomerTopItemsView =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'items'; items: ResolvedCustomerTopItem[] };

/**
 * Pairs each history entry with the current catalog product, so a click adds it at today's price.
 * A product the backend marks unavailable, or one missing from the loaded catalog, stays listed
 * without a product to add.
 */
export function resolveCustomerTopItems(items: CustomerTopItem[], products: Product[]): ResolvedCustomerTopItem[] {
  const catalog = new Map(products.map((product) => [String(product.id), product]));
  return items.map((item) => ({
    ...item,
    product: item.available ? catalog.get(String(item.product_id)) ?? null : null,
  }));
}

/** A result fetched for any customer other than the one on screen reads as still loading. */
export function customerTopItemsView(
  customerId: string | null,
  result: CustomerTopItemsResult | null,
  products: Product[],
): CustomerTopItemsView {
  if (customerId === null) return { kind: 'hidden' };
  if (!result || result.customerId !== customerId) return { kind: 'loading' };
  if (result.status === 'error') return { kind: 'error' };
  if (result.items.length === 0) return { kind: 'empty' };
  return { kind: 'items', items: resolveCustomerTopItems(result.items, products) };
}

type TopItemsGet = (url: string, config: { signal: AbortSignal }) => Promise<{ data?: { items?: unknown } }>;

/** Settles once for `customerId`, unless the request was aborted because the customer changed. */
export async function fetchCustomerTopItems(
  get: TopItemsGet,
  customerId: string,
  signal: AbortSignal,
  onSettled: (result: CustomerTopItemsResult) => void,
): Promise<void> {
  let result: CustomerTopItemsResult;
  try {
    const res = await get(`/customers/${encodeURIComponent(customerId)}/top-items`, { signal });
    const items = Array.isArray(res.data?.items) ? (res.data.items as CustomerTopItem[]) : [];
    result = { customerId, status: 'ready', items };
  } catch {
    result = { customerId, status: 'error' };
  }
  if (!signal.aborted) onSettled(result);
}
