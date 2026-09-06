import type { Addon, CartItem } from './types';

/** Serializes cart identity into a typed, sorted canonical representation. */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  switch (typeof value) {
    case 'string':
      return `string:${JSON.stringify(value)}`;
    case 'number':
      if (Number.isNaN(value)) return 'number:NaN';
      if (value === Infinity) return 'number:Infinity';
      if (value === -Infinity) return 'number:-Infinity';
      if (Object.is(value, -0)) return 'number:-0';
      return `number:${String(value)}`;
    case 'boolean':
      return `boolean:${value ? 'true' : 'false'}`;
    case 'bigint':
      return `bigint:${value.toString()}`;
    case 'symbol':
      return `symbol:${String(value)}`;
    case 'function':
      return `function:${String(value)}`;
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
      }
      const entries = Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      return `${typeof value}:${String(value)}`;
  }
}

/** Builds order-insensitive, typed cart identity for merging equivalent items. */
export function generateCartItemId(productId: number | string, addons: Addon[], specialInstructions: string): string {
  const normalizedAddons = addons.map((addon) => ({
    ...addon,
    quantity: addon.quantity || 1,
  }));
  const sortedAddons = normalizedAddons.sort((left, right) => {
    const leftKey = canonicalize(left);
    const rightKey = canonicalize(right);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });

  return `cart-v2:${canonicalize({ productId, addons: sortedAddons, specialInstructions })}`;
}

/** Normalize persisted/held cart lines to the current identity format. */
export function normalizeCartItems(items: CartItem[]): CartItem[] {
  const normalized: CartItem[] = [];
  for (const item of items) {
    const id = generateCartItemId(item.product.id, item.addons || [], item.special_instructions || '');
    const existing = normalized.find((candidate) => candidate.id === id);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      normalized.push({ ...item, id });
    }
  }
  return normalized;
}
