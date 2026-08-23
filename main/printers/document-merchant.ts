/**
 * Merchant template → classic thermal receipt renderer (#447, epic #438).
 *
 * Resolves an ACTIVE merchant template through the PrintDocument pipeline:
 * authoritative rows → PrintData/PrintContext → buildBillDocument →
 * applyMerchantTemplate (semantic block selection/order/label variants) →
 * classic token lines → bytes. Because the template is applied at the
 * SEMANTIC layer, every renderer that consumes the applied document produces
 * the same content — the parity harness asserts this byte-equivalence in
 * merchant-template mode.
 *
 * v1 renders merchant receipt documents through the classic layout pipeline;
 * compact/KOT adoption of merchant docs belongs to their owning issues.
 */

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

export interface MerchantDocumentRenderResult {
  readonly data: Buffer;
  readonly lines: string[];
  readonly warnings: PrintWarning[];
  /** True when the stored payload failed validation and classic was used. */
  readonly fellBackToClassic: boolean;
}

/**
 * Render a bill through a merchant template row. Fail-closed on render too:
 * if the stored payload no longer validates against this build's schema
 * (e.g. written by a newer version), a warning is recorded and the plain
 * classic document is rendered instead of garbage or nothing.
 */
export function renderMerchantReceiptViaDocument(
  order: any,
  bill: any,
  business: any,
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
  },
): MerchantDocumentRenderResult {
  const warnings: PrintWarning[] = [];

  const finish = (lines: string[], fellBackToClassic: boolean) => {
    const data = buildEscPos(lines, opts.useUnicode, {
      cutMode: opts.cutMode,
      arabicShaping: opts.arabicShaping,
      columns: opts.columns,
    }, warnings);
    return { data, lines, warnings, fellBackToClassic };
  };

  const row = loadActiveMerchantPrintTemplate(templateId);
  if (!row) {
    warnings.push({
      field: 'bill_template',
      text: templateId,
      message: `Merchant template ${templateId} is not active; rendered with the classic layout.`,
    });
    const printContext = buildBillPrintContext({
      columns: opts.columns,
      language: opts.language,
      ...(opts.additionalLanguage !== undefined ? { additionalLanguage: opts.additionalLanguage } : {}),
      business,
    });
    return finish(
      renderBillDocumentToClassicLines(buildBillDocument(buildBillPrintData(order, bill, business, opts.isReprint), printContext), {
        columns: opts.columns,
        language: printContext.languages[0],
        locale: printContext.locale,
        ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
        currencySymbol: printContext.currencySymbol,
        trimDecimals: printContext.trimDecimals,
        useUnicode: opts.useUnicode,
        arabicShaping: opts.arabicShaping,
        cutMode: opts.cutMode,
      }),
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
    currencySymbol: printContext.currencySymbol,
    trimDecimals: printContext.trimDecimals,
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
  } as const;

  if (!validation.ok) {
    // Fail closed: unknown future schema or corrupt payload must never reach
    // a renderer. Warn loudly and fall back to the unmodified classic doc.
    warnings.push({
      field: 'bill_template',
      text: templateId,
      message: `Merchant template ${templateId} failed validation (${validation.errors[0]}); rendered with the classic layout.`,
    });
    return finish(renderBillDocumentToClassicLines(buildBillDocument(printData, printContext), baseOptions), true);
  }

  const document = applyMerchantTemplate(buildBillDocument(printData, printContext), validation.payload);
  return finish(renderBillDocumentToClassicLines(document, baseOptions), false);
}
