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

/**
 * Bounded identity for one cart line: the canonical form grows with add-on and
 * note text, while some consumers bound an id (POST /held-orders caps it).
 * FNV-1a over two 32-bit lanes stays deterministic and collision-resistant
 * enough to keep distinct lines distinct.
 */
function lineDigest(value: string): string {
  let first = 0x811c9dc5;
  let second = 0xc9dc5118;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x01000193) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

/** Builds order-insensitive, typed cart identity for merging equivalent items. */
export function generateCartItemId(
  productId: number | string,
  variantId: string | null,
  addons: Addon[],
  specialInstructions: string,
): string {
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

  return `cart-v3:${lineDigest(canonicalize({ productId, variantId, addons: sortedAddons, specialInstructions }))}`;
}

/** Normalize persisted/held cart lines to the current identity format. */
export function normalizeCartItems(items: CartItem[]): CartItem[] {
  const normalized: CartItem[] = [];
  for (const item of items) {
    const id = generateCartItemId(item.product.id, item.variant?.id ?? null, item.addons || [], item.special_instructions || '');
    const existing = normalized.find((candidate) => candidate.id === id);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      normalized.push({ ...item, id });
    }
  }
  return normalized;
}
