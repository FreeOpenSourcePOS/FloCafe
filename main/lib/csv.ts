export const FLO_CSV_ENCODING_COLUMN = 'flo_csv_encoding';
export const FLO_CSV_ENCODING_QUOTE_V1 = 'quote-v1';

const FORMULA_TRIGGER_PREFIX = /^\s*[=+\-@]/;
const QUOTE_V1_ADDED_APOSTROPHE = /^'(?:'|\s*[=+\-@])/;

/** CSV field serializer with spreadsheet formula neutralization (CWE-1236). */
export function toCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields
    .map((f) => {
      let s = String(f ?? '');
      // Escape spreadsheet formula triggers (=, +, -, @) on non-numeric strings
      // with a leading quote. Leading whitespace counts as part of the prefix:
      // importers strip it before deciding the cell is a formula, so "\t=1+1"
      // evaluates just like "=1+1" (CWE-1236).
      if (typeof f !== 'number' && FORMULA_TRIGGER_PREFIX.test(s)) {
        s = "'" + s;
      }
      return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    })
    .join(',');
}

/** Doubles an original leading apostrophe before `toCsvRow` formula neutralization. */
export function encodeQuoteV1Field(
  field: string | number | null | undefined,
): string | number | null | undefined {
  if (typeof field === 'number' || field === null || field === undefined) {
    return field;
  }
  const s = String(field);
  return s.startsWith("'") ? `'${s}` : s;
}

/** Serializes a CSV row using reversible `quote-v1` escaping plus spreadsheet formula neutralization. */
export function toQuoteV1CsvRow(fields: (string | number | null | undefined)[]): string {
  return toCsvRow(fields.map(encodeQuoteV1Field));
}

/** Removes the single apostrophe added by `quote-v1` encoding. */
export function decodeQuoteV1Field(value: string): string {
  return QUOTE_V1_ADDED_APOSTROPHE.test(value) ? value.slice(1) : value;
}

/**
 * Decodes an unmarked legacy CSV field only when comparison with an existing
 * record's stored value proves the leading apostrophe was added by formula neutralization.
 */
export function decodeLegacyProvenField(
  csvValue: string,
  storedValue: string | null | undefined,
): string {
  if (!csvValue || typeof storedValue !== 'string' || !storedValue) {
    return csvValue;
  }
  if (FORMULA_TRIGGER_PREFIX.test(storedValue) && csvValue === `'${storedValue}`.trim()) {
    return storedValue;
  }
  return csvValue;
}
