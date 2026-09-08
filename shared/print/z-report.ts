import type { DirectionalText, SemanticLabel } from './document';
import { directionalText } from './document';
import { resolveDirectionSpec, type DirectionSpec } from './direction';
import type { LabelConceptId, LabelResolver } from './document';
import type { PrintLanguageCode, ResolvedPrintLanguages, TextDirection } from './types';

export interface ZReportPaymentSnapshot {
  readonly method: string;
  readonly count: number;
  readonly totalCents?: number;
  readonly total?: number;
}

export interface ZReportTaxSnapshot {
  readonly title?: string;
  readonly label?: string;
  readonly amount: number;
}

export interface ZReportStaffSnapshot {
  readonly name?: string;
  readonly userId?: string;
  readonly orderCount?: number;
  readonly orders?: number;
  readonly revenueCents?: number;
  readonly revenue?: number;
}

/** Stored cash-closure truth normalized for the print document builder. */
export interface ZReportPrintData {
  readonly zNumber: string | number;
  readonly businessDate: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingFloatCents: number;
  readonly paymentMethods: readonly ZReportPaymentSnapshot[];
  readonly refundCount: number;
  readonly refundedCents: number;
  readonly taxComponents: readonly ZReportTaxSnapshot[];
  readonly staffSales: readonly ZReportStaffSnapshot[];
  readonly expectedCashCents: number;
  readonly countedCashCents: number;
  readonly varianceCents: number;
  readonly closedByName: string;
  readonly businessName: string;
  readonly businessAddress: string;
  readonly taxRegistrationNumber: string;
  readonly isReprint: boolean;
}

export interface ZReportContext {
  readonly languages: ResolvedPrintLanguages;
  readonly baseDirection: TextDirection;
  readonly resolveLabel: LabelResolver;
}

export interface ZReportPeriodRow {
  readonly label: SemanticLabel;
  readonly value: DirectionalText;
}

export interface ZReportPaymentRow {
  readonly method: string;
  readonly label: SemanticLabel;
  readonly countLabel: SemanticLabel;
  readonly count: number;
  readonly totalCents: number;
}

export interface ZReportAmountRow {
  readonly label: SemanticLabel;
  readonly amount: number;
}

export interface ZReportCountAmountBlock {
  readonly heading: SemanticLabel;
  readonly countLabel: SemanticLabel;
  readonly count: number;
  readonly totalLabel: SemanticLabel;
  readonly totalCents: number;
}

export interface ZReportSection<T> {
  readonly heading: SemanticLabel;
  readonly none: SemanticLabel;
  readonly rows: readonly T[];
}

export interface ZReportDocument {
  readonly version: 1;
  readonly direction: DirectionSpec;
  readonly languages: ResolvedPrintLanguages;
  readonly header: {
    readonly title: SemanticLabel;
    readonly zNumber: DirectionalText;
    readonly reprintMarker: SemanticLabel | null;
    readonly businessName: DirectionalText | null;
    readonly businessAddress: DirectionalText | null;
    readonly taxRegistrationNumber: DirectionalText | null;
  };
  readonly period: readonly ZReportPeriodRow[];
  readonly openingFloat: { readonly label: SemanticLabel; readonly cents: number };
  readonly payments: ZReportSection<ZReportPaymentRow>;
  readonly refunds: ZReportCountAmountBlock;
  readonly tax: ZReportSection<ZReportAmountRow>;
  readonly staff: ZReportSection<ZReportPaymentRow>;
  readonly cash: {
    readonly expected: { readonly label: SemanticLabel; readonly cents: number };
    readonly counted: { readonly label: SemanticLabel; readonly cents: number };
    readonly variance: { readonly label: SemanticLabel; readonly cents: number };
  };
  readonly operator: {
    readonly label: SemanticLabel;
    readonly name: DirectionalText | null;
    readonly signatureLabel: SemanticLabel;
  };
  readonly footer: SemanticLabel;
}

const PAYMENT_METHOD_CONCEPTS: Readonly<Record<string, LabelConceptId>> = Object.freeze({
  cash: 'pos.methodCash',
  card: 'pos.methodCard',
  wallet: 'pos.methodWallet',
});

function label(context: ZReportContext, conceptId: LabelConceptId): SemanticLabel {
  const primary = context.languages[0] as PrintLanguageCode;
  const secondary = context.languages[1] as PrintLanguageCode | undefined;
  return Object.freeze({
    conceptId,
    primary: context.resolveLabel(conceptId, primary),
    ...(secondary ? { secondary: context.resolveLabel(conceptId, secondary) } : {}),
  });
}

function literalLabel(value: string): SemanticLabel {
  return Object.freeze({ primary: value });
}

function optionalValue(value: string, direction: TextDirection): DirectionalText | null {
  return value.length > 0 ? directionalText(value, direction) : null;
}

function paymentLabel(context: ZReportContext, method: string): SemanticLabel {
  const concept = PAYMENT_METHOD_CONCEPTS[method.toLowerCase()];
  return concept ? label(context, concept) : literalLabel(method);
}

function numberOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** Build a typed, localized Z-report document from stored closure truth. */
export function buildZReportDocument(data: ZReportPrintData, context: ZReportContext): ZReportDocument {
  const direction = context.baseDirection;
  const periodLabel = (conceptId: LabelConceptId, value: string): ZReportPeriodRow => ({
    label: label(context, conceptId),
    value: directionalText(value, direction),
  });
  const paymentRows = data.paymentMethods.map((row) => ({
    method: row.method,
    label: paymentLabel(context, row.method),
    countLabel: label(context, 'print.zReport.paymentCount'),
    count: numberOrZero(row.count),
    totalCents: numberOrZero(row.totalCents ?? row.total),
  }));
  const taxRows = data.taxComponents.map((row) => ({
    label: literalLabel(String(row.title ?? row.label ?? '')),
    amount: numberOrZero(row.amount),
  }));
  const staffRows = data.staffSales.map((row) => ({
    method: String(row.name ?? row.userId ?? ''),
    label: literalLabel(String(row.name ?? row.userId ?? '')),
    countLabel: label(context, 'print.zReport.paymentCount'),
    count: numberOrZero(row.orderCount ?? row.orders),
    totalCents: numberOrZero(row.revenueCents ?? row.revenue),
  }));

  return Object.freeze({
    version: 1 as const,
    direction: resolveDirectionSpec(direction),
    languages: context.languages,
    header: Object.freeze({
      title: label(context, 'print.zReport.title'),
      zNumber: directionalText(String(data.zNumber), direction),
      reprintMarker: data.isReprint ? label(context, 'receipt.reprint') : null,
      businessName: optionalValue(data.businessName, direction),
      businessAddress: optionalValue(data.businessAddress, direction),
      taxRegistrationNumber: optionalValue(data.taxRegistrationNumber, direction),
    }),
    period: Object.freeze([
      periodLabel('print.zReport.businessDate', data.businessDate),
      periodLabel('print.zReport.periodStart', data.periodStart),
      periodLabel('print.zReport.periodEnd', data.periodEnd),
    ]),
    openingFloat: Object.freeze({ label: label(context, 'print.zReport.openingFloat'), cents: numberOrZero(data.openingFloatCents) }),
    payments: Object.freeze({
      heading: label(context, 'print.zReport.payments'),
      none: label(context, 'print.zReport.none'),
      rows: Object.freeze(paymentRows),
    }),
    refunds: Object.freeze({
      heading: label(context, 'print.zReport.refunds'),
      countLabel: label(context, 'print.zReport.count'),
      count: numberOrZero(data.refundCount),
      totalLabel: label(context, 'print.zReport.amount'),
      totalCents: numberOrZero(data.refundedCents),
    }),
    tax: Object.freeze({
      heading: label(context, 'print.zReport.tax'),
      none: label(context, 'print.zReport.none'),
      rows: Object.freeze(taxRows),
    }),
    staff: Object.freeze({
      heading: label(context, 'print.zReport.staff'),
      none: label(context, 'print.zReport.none'),
      rows: Object.freeze(staffRows),
    }),
    cash: Object.freeze({
      expected: Object.freeze({ label: label(context, 'print.zReport.expectedCash'), cents: numberOrZero(data.expectedCashCents) }),
      counted: Object.freeze({ label: label(context, 'print.zReport.countedCash'), cents: numberOrZero(data.countedCashCents) }),
      variance: Object.freeze({ label: label(context, 'print.zReport.variance'), cents: numberOrZero(data.varianceCents) }),
    }),
    operator: Object.freeze({
      label: label(context, 'print.zReport.closedBy'),
      name: optionalValue(data.closedByName, direction),
      signatureLabel: label(context, 'print.zReport.operatorSignature'),
    }),
    footer: label(context, 'print.zReport.footer'),
  });
}
