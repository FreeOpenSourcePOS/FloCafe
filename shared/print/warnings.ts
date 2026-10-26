/** Common warning contract shared by native, WebUSB, and browser print adapters. */
export type PrintWarningKind = 'line' | 'financial' | 'configuration' | 'locale';

export interface PrintWarning {
  field: string;
  text: string;
  message: string;
  kind?: PrintWarningKind;
}

const RASTER_FAILURE_PREFIX = 'Raster rendering failed';

export function hasFinancialPrintWarning(warnings: readonly PrintWarning[]): boolean {
  return warnings.some((warning) => warning.kind === 'financial');
}

/** Fail-closed refusal: names the row, why neither text nor image output worked, and what to try. */
export function makeFinancialPrintRefusalMessage(warnings: readonly PrintWarning[]): string {
  const financial = warnings.filter((warning) => warning.kind === 'financial');
  const row = financial.find((warning) => warning.text.trim().length > 0);
  const rasterFailure = financial.find((warning) =>
    warning.message.startsWith(RASTER_FAILURE_PREFIX),
  );
  const rowText = row ? `: ${row.text.trim().replace(/\s*\n\s*/g, ' / ')}` : '';
  const cause = rasterFailure
    ? `The printer cannot print these characters as text, and printing them as an image failed (${rasterFailure.message}).`
    : 'The printer cannot print these characters as text, and no image fallback is available on this print path.';
  return `Receipt not printed: a financial row contains unsupported printer text${rowText}. ${cause} Nothing was printed, so no amount is missing. Try again, or use system/browser printing.`;
}
