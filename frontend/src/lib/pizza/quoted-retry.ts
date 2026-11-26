/**
 * A retry sends the request its idempotency key was first sent with: the lines and the amount
 * the till quoted then. A re-price changes add-on prices and the quote, not which order a request
 * is, so a stored attempt is matched to the cart without them.
 */
import { fingerprintsMatchAcrossScheduleToggle } from '@/lib/order-attempt';

type Line = { addons?: Array<{ id: string; quantity?: number }> | null };

/** The fingerprint without the quote and with each add-on as its id and quantity. */
function unpriced(fingerprint: string): string {
  try {
    const { expected_subtotal: _quote, ...request } = JSON.parse(fingerprint);
    if (Array.isArray(request.items))
      request.items = request.items.map((item: Line) =>
        item?.addons
          ? { ...item, addons: item.addons.map(({ id, quantity }) => ({ id, quantity })) }
          : item,
      );
    return JSON.stringify(request);
  } catch {
    return fingerprint;
  }
}

/** True when a stored attempt's fingerprint and the cart's are the same order but for prices. */
export function sameRequestApartFromPrices(stored: string | undefined, current: string): boolean {
  return !!stored && fingerprintsMatchAcrossScheduleToggle(unpriced(stored), unpriced(current));
}

/** The stored fingerprint when the cart is still that request, so its key and lines are reused. */
export function retryFingerprint(stored: string | undefined, current: string): string {
  return stored && sameRequestApartFromPrices(stored, current) ? stored : current;
}

/**
 * The lines and quote first sent under an attempt's key, which end every order request: the
 * lines of its fingerprint and its quote, or the quote the fingerprint holds; with neither, none.
 */
export function quotedLines(
  fingerprint: string,
  quote: number | undefined,
): { items: unknown; expected_subtotal?: number } {
  const stored = JSON.parse(fingerprint) as { items: unknown; expected_subtotal?: number };
  const sent = quote ?? stored.expected_subtotal;
  return { items: stored.items, ...(typeof sent === 'number' ? { expected_subtotal: sent } : {}) };
}

/** The add-items request of a stored append attempt, first send or replay alike. */
export function appendBody(attempt: {
  items: unknown[];
  specialInstructions?: string;
  expectedSubtotal?: number;
}) {
  return {
    items: attempt.items,
    special_instructions: attempt.specialInstructions,
    expected_subtotal: attempt.expectedSubtotal,
  };
}
