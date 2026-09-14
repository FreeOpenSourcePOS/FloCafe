interface SearchableOrder {
  order_number: string;
  customer?: { name?: string | null; phone?: string | null; phone_digits?: string | null } | null;
}

const digitsOnly = (value: string): string => value.replace(/\D/g, '');

/** Matches an order against the orders-page search box: order number, customer name, or phone digits. */
export function matchesOrderSearch(order: SearchableOrder, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (order.order_number.toLowerCase().includes(q)) return true;
  const name = order.customer?.name;
  if (name && name.toLowerCase().includes(q)) return true;
  const qDigits = digitsOnly(q);
  // Skip phone matching once the query contains letters (e.g. "Alice 2"),
  // otherwise the leftover digits would match almost any phone number.
  if (qDigits && !/\p{L}/u.test(q)) {
    const phones = [order.customer?.phone_digits, order.customer?.phone];
    if (phones.some((p) => p && digitsOnly(p).includes(qDigits))) return true;
  }
  return false;
}
