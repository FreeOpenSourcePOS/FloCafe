/** CSV field serializer with spreadsheet formula neutralization (CWE-1236). */
export function toCsvRow(fields: (string | number | null | undefined)[]): string {
  return fields
    .map((f) => {
      let s = String(f ?? '');
      // Escape spreadsheet formula triggers (=, +, -, @) on non-numeric strings with a leading quote.
      if (typeof f !== 'number' && /^[=+\-@]/.test(s)) {
        s = "'" + s;
      }
      return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    })
    .join(',');
}
