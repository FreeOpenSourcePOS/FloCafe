/** Merchant template to classic thermal receipt renderer; resolves active template through PrintDocument pipeline. */

import { loadActiveMerchantPrintTemplate } from '../services/merchant-print-templates';
import { validateMerchantTemplate } from '../../shared/print';
import {
  applyMerchantTemplate,
  buildBillDocument,
} from '../../shared/print';
import {
  buildBillPrintContext,
  buildBillPrintData,
  renderBillDocumentToClassicLines,
} from './document-classic';
import { buildEscPos, type PrintWarning } from './thermal';
import type { PrinterCutMode } from './profiles';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { RasterSemanticLineGroup } from '../../shared/print/raster';

export interface MerchantDocumentRenderResult {
  readonly data: Buffer;
  readonly lines: string[];
  readonly warnings: PrintWarning[];
  /** True when the stored payload failed validation and classic was used. */
  readonly fellBackToClassic: boolean;
  readonly rasterGroups: readonly RasterSemanticLineGroup[];
}

type RawPrintRecord = Record<string, unknown>;

/** Render bill through merchant template; falls back to classic if invalid. */
export function renderMerchantReceiptViaDocument(
  order: RawPrintRecord,
  bill: RawPrintRecord,
  business: RawPrintRecord,
  templateId: string,
  opts: {
    columns: number;
    language: string;
    /** Optional second receipt language from the resolved policy (max 2, v1). */
    additionalLanguage?: string;
    isReprint: boolean;
    useUnicode: boolean;
    arabicShaping: boolean;
    cutMode: PrinterCutMode;
    capabilities?: ThermalPrinterCapabilities;
  },
): MerchantDocumentRenderResult {
  const warnings: PrintWarning[] = [];
  const printContext = buildBillPrintContext({
    columns: opts.columns,
    language: opts.language,
    ...(opts.additionalLanguage !== undefined ? { additionalLanguage: opts.additionalLanguage } : {}),
    business,
  });
  const baseOptions = {
    columns: opts.columns,
    language: printContext.languages[0],
    locale: printContext.locale,
    ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
    currency: printContext.currency,
    currencySymbol: printContext.currencySymbol,
    trimDecimals: printContext.trimDecimals,
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
    capabilities: opts.capabilities,
  } as const;

  const renderDocument = (document: Parameters<typeof renderBillDocumentToClassicLines>[0]) => {
    const rasterGroups: RasterSemanticLineGroup[] = [];
    const lines = renderBillDocumentToClassicLines(document, { ...baseOptions, rasterGroups });
    return { lines, rasterGroups };
  };

  const finish = (rendered: { lines: string[]; rasterGroups: RasterSemanticLineGroup[] }, fellBackToClassic: boolean) => {
    const data = buildEscPos(rendered.lines, opts.useUnicode, {
      cutMode: opts.cutMode,
      arabicShaping: opts.arabicShaping,
      columns: opts.columns,
      language: opts.language,
      capabilities: opts.capabilities,
    }, warnings);
    return { data, lines: rendered.lines, warnings, fellBackToClassic, rasterGroups: rendered.rasterGroups };
  };

  const row = loadActiveMerchantPrintTemplate(templateId);
  if (!row) {
    warnings.push({
      field: 'bill_template',
      text: templateId,
      message: `Merchant template ${templateId} is not active; rendered with the classic layout.`,
    });
    return finish(
      renderDocument(buildBillDocument(buildBillPrintData(order, bill, business, opts.isReprint), printContext)),
      true,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    parsed = null;
  }
  const validation = validateMerchantTemplate(parsed);
  const printData = buildBillPrintData(order, bill, business, opts.isReprint);

  if (!validation.ok) {
    // Fail closed: unknown future schema or corrupt payload must never reach
    // a renderer. Warn loudly and fall back to the unmodified classic doc.
    warnings.push({
      field: 'bill_template',
      text: templateId,
      message: `Merchant template ${templateId} failed validation (${validation.errors[0]}); rendered with the classic layout.`,
    });
    return finish(renderDocument(buildBillDocument(printData, printContext)), true);
  }

  const document = applyMerchantTemplate(buildBillDocument(printData, printContext), validation.payload);
  return finish(renderDocument(document), false);
}
