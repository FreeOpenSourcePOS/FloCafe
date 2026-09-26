/** CSV field serializer with spreadsheet formula neutralization (CWE-1236). */
export function toCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields
    .map((f) => {
      let s = String(f ?? '');
      // Escape spreadsheet formula triggers (=, +, -, @) on non-numeric strings
      // with a leading quote. Leading whitespace counts as part of the prefix:
      // importers strip it before deciding the cell is a formula, so "\t=1+1"
      // evaluates just like "=1+1" (CWE-1236).
      if (typeof f !== 'number' && /^\s*[=+\-@]/.test(s)) {
        s = "'" + s;
      }
      return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    })
    .join(',');
}
