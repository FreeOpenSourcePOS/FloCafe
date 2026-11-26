/**
 * The order types the POS switch offers, in the switch's own order: the ones
 * the store's `pos_order_types` setting names, plus the type of the order
 * being added to. A setting that names none of them hides nothing.
 */
export function offeredOrderTypes<T extends string>(
  all: readonly T[],
  allowed: readonly string[],
  existing?: string | null,
): T[] {
  const narrowed = all.some((type) => allowed.includes(type));
  return all.filter((type) => !narrowed || allowed.includes(type) || type === existing);
}

/**
 * The type a new order moves to: the first one offered, when the setting narrowed the switch and
 * hides the cart's own type. Null leaves the cart as it is, which is always so without the setting.
 */
export function orderTypeToStartOn<T extends string>(
  all: readonly T[],
  allowed: readonly string[],
  current: string,
  existing?: string | null,
): T | null {
  const offered = all.filter((type) => allowed.includes(type));
  return existing || offered.length === 0 || allowed.includes(current) ? null : offered[0];
}
