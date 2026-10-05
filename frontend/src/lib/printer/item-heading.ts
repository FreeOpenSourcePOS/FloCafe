/**
 * Item heading for a sold product variant, mirroring the rule in the backend
 * helper `formatVariantItemHeading` (main/printers/formatting-helpers.ts).
 * The two must stay in step: a printed or displayed line always names the
 * variant that was sold, and a product with no variant prints exactly its own
 * name. This is a browser-side mirror rather than a shared cross-boundary
 * module, so the desktop and browser print paths each stay self-contained.
 */

export interface ItemVariantSnapshot {
  name?: string | null;
  sku?: string | null;
}

/** Read an order item's variant snapshot, stored either as JSON text or an object. */
export function parseVariantSelection(value: unknown): ItemVariantSnapshot | null {
  let candidate = value;
  if (typeof candidate === 'string') {
    if (!candidate) return null;
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate as ItemVariantSnapshot;
}

export function formatItemHeading(productName: string, variantSelection: unknown): string {
  const variant = parseVariantSelection(variantSelection);
  const variantName = String(variant?.name ?? '').trim();
  if (!variantName) return productName;
  const sku = String(variant?.sku ?? '').trim();
  return `${productName} (${variantName})${sku ? ` [${sku}]` : ''}`;
}