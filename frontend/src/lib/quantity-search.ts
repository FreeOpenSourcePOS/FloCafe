export interface QuantitySearchResult {
  quantity: number;
  query: string;
}

/**
 * Parses search strings with quantity multiplier prefixes like "3*latte" or "5xcroissant".
 * Returns the parsed numeric quantity and target query, or null if no multiplier is present.
 */
export function parseQuantitySearch(input: string): QuantitySearchResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const starMatch = /^(\d+(?:\.\d+)?)\s*\*\s*(.*)$/.exec(trimmed);
  const xMatch = starMatch ? null : /^(\d+(?:\.\d+)?)\s*[xX]\s*(.+)$/.exec(trimmed);
  const match = starMatch ?? xMatch;
  if (!match) return null;
  const qty = parseFloat(match[1]);
  const query = match[2].trim();
  if (!Number.isFinite(qty) || qty <= 0 || (!starMatch && !query)) return null;
  return { quantity: qty, query };
}
