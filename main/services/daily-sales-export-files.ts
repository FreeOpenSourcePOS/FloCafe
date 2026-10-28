import ExcelJS from 'exceljs';
import { toCsvRow } from '../lib/csv';
import {
  DAILY_SALES_DAILY_COLUMNS,
  DAILY_SALES_ITEM_COLUMNS,
  DAILY_SALES_PAYMENT_COLUMNS,
  DAILY_SALES_TAX_COLUMNS,
  dailySalesSummaryMetricRows,
  serializeDailySalesExportHtml,
  type DailySalesExportDataset,
  type DailySalesExportItemRow,
  type DailySalesHtmlOptions,
} from './daily-sales-export';

export { serializeDailySalesExportHtml, type DailySalesHtmlOptions };

export type DailySalesExportFormat = 'xlsx' | 'csv' | 'html';
export type DailySalesExportCsvPart = 'summary' | 'daily' | 'taxes' | 'items' | 'payments';

export const DAILY_SALES_CSV_PARTS: readonly DailySalesExportCsvPart[] = [
  'summary',
  'daily',
  'taxes',
  'items',
  'payments',
] as const;

export function dailySalesExportFilename(
  period: string | { fromDate: string; toDate: string },
  format: DailySalesExportFormat,
  part?: DailySalesExportCsvPart,
): string {
  const slug =
    typeof period === 'string'
      ? period
      : period.fromDate === period.toDate
        ? period.fromDate
        : `${period.fromDate}_to_${period.toDate}`;
  if (format === 'xlsx') return `daily-sales-${slug}.xlsx`;
  if (format === 'html') return `daily-sales-${slug}.html`;
  if (part && DAILY_SALES_CSV_PARTS.includes(part)) {
    return `daily-sales-${slug}-${part}.csv`;
  }
  throw new Error(
    'CSV export requires part=summary, part=daily, part=taxes, part=items or part=payments',
  );
}

function moneyNumFmt(fractionDigits: number): string {
  const zeros = '0'.repeat(Math.max(0, fractionDigits));
  return fractionDigits > 0 ? `#,##0.${zeros}` : '#,##0';
}

/**
 * Serializers only - no accounting math. Both formats read the same dataset.
 * Values stay numeric in XLSX; CSV uses ASCII '.' decimals for stable Sheets import.
 */
export async function serializeDailySalesExportXlsx(
  dataset: DailySalesExportDataset,
  options: { fractionDigits: number },
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const moneyFmt = moneyNumFmt(options.fractionDigits);

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'metric', key: 'metric', width: 28 },
    { header: 'value', key: 'value', width: 36 },
  ];
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of dailySalesSummaryMetricRows(dataset.summary)) {
    const entry = summarySheet.addRow({ metric: row.metric, value: row.value });
    if (
      typeof row.value === 'number' &&
      !row.metric.endsWith('_count') &&
      !row.metric.endsWith('_percent')
    ) {
      entry.getCell('value').numFmt = moneyFmt;
    } else if (typeof row.value === 'number' && row.metric.endsWith('_percent')) {
      entry.getCell('value').numFmt = '0.00';
    }
  }

  const dailySheet = workbook.addWorksheet('Daily');
  dailySheet.columns = [
    { header: 'business_date', key: 'business_date', width: 16 },
    { header: 'order_count', key: 'order_count', width: 14 },
    { header: 'paid_bill_count', key: 'paid_bill_count', width: 16 },
    { header: 'gross_collected', key: 'gross_collected', width: 18 },
    { header: 'refunds_issued', key: 'refunds_issued', width: 16 },
    { header: 'net_collected', key: 'net_collected', width: 16 },
    { header: 'tax_total', key: 'tax_total', width: 14 },
    { header: 'discount_total', key: 'discount_total', width: 16 },
    { header: 'service_charge_total', key: 'service_charge_total', width: 20 },
    { header: 'packaging_charge_total', key: 'packaging_charge_total', width: 22 },
    { header: 'delivery_charge_total', key: 'delivery_charge_total', width: 20 },
    { header: 'known_cost_net_item_sales', key: 'known_cost_net_item_sales', width: 24 },
    { header: 'ingredient_cost_total', key: 'ingredient_cost_total', width: 20 },
    { header: 'gross_profit_total', key: 'gross_profit_total', width: 18 },
    { header: 'gross_margin_percent', key: 'gross_margin_percent', width: 20 },
    { header: 'cost_coverage_status', key: 'cost_coverage_status', width: 20 },
  ];
  dailySheet.getRow(1).font = { bold: true };
  dailySheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const day of dataset.daily) {
    const entry = dailySheet.addRow({
      business_date: day.business_date,
      order_count: day.order_count,
      paid_bill_count: day.paid_bill_count,
      gross_collected: day.gross_collected,
      refunds_issued: day.refunds_issued,
      net_collected: day.net_collected,
      tax_total: day.tax_total,
      discount_total: day.discount_total,
      service_charge_total: day.service_charge_total,
      packaging_charge_total: day.packaging_charge_total,
      delivery_charge_total: day.delivery_charge_total,
      known_cost_net_item_sales: day.known_cost_net_item_sales,
      ingredient_cost_total: day.ingredient_cost_total ?? '',
      gross_profit_total: day.gross_profit_total ?? '',
      gross_margin_percent: day.gross_margin_percent ?? '',
      cost_coverage_status: day.cost_coverage_status,
    });
    for (const col of ['order_count', 'paid_bill_count'] as const) {
      entry.getCell(col).numFmt = '#,##0';
    }
    for (const col of [
      'gross_collected',
      'refunds_issued',
      'net_collected',
      'tax_total',
      'discount_total',
      'service_charge_total',
      'packaging_charge_total',
      'delivery_charge_total',
      'known_cost_net_item_sales',
    ] as const) {
      entry.getCell(col).numFmt = moneyFmt;
    }
    if (typeof day.ingredient_cost_total === 'number') {
      entry.getCell('ingredient_cost_total').numFmt = moneyFmt;
    }
    if (typeof day.gross_profit_total === 'number') {
      entry.getCell('gross_profit_total').numFmt = moneyFmt;
    }
    if (typeof day.gross_margin_percent === 'number') {
      entry.getCell('gross_margin_percent').numFmt = '0.00';
    }
  }

  const taxesSheet = workbook.addWorksheet('Taxes');
  taxesSheet.columns = [
    { header: 'business_date', key: 'business_date', width: 16 },
    { header: 'tax_name', key: 'tax_name', width: 22 },
    { header: 'tax_rate', key: 'tax_rate', width: 12 },
    { header: 'taxable_base', key: 'taxable_base', width: 16 },
    { header: 'tax_amount', key: 'tax_amount', width: 16 },
    { header: 'gross_amount', key: 'gross_amount', width: 16 },
    { header: 'shared_base', key: 'shared_base', width: 14 },
    { header: 'base_additive', key: 'base_additive', width: 14 },
    { header: 'incomplete_detail', key: 'incomplete_detail', width: 18 },
    { header: 'warning', key: 'warning', width: 48 },
  ];
  taxesSheet.getRow(1).font = { bold: true };
  taxesSheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const tax of dataset.taxes) {
    const entry = taxesSheet.addRow({
      business_date: tax.business_date,
      tax_name: tax.tax_name,
      tax_rate: tax.tax_rate ?? '',
      taxable_base: tax.taxable_base ?? '',
      tax_amount: tax.tax_amount,
      gross_amount: tax.gross_amount ?? '',
      shared_base: tax.shared_base,
      base_additive: tax.base_additive,
      incomplete_detail: tax.incomplete_detail,
      warning: tax.warning,
    });
    if (typeof tax.tax_rate === 'number') {
      entry.getCell('tax_rate').numFmt = '0.##';
    }
    if (typeof tax.taxable_base === 'number') {
      entry.getCell('taxable_base').numFmt = moneyFmt;
    }
    entry.getCell('tax_amount').numFmt = moneyFmt;
    if (typeof tax.gross_amount === 'number') {
      entry.getCell('gross_amount').numFmt = moneyFmt;
    }
  }

  const itemsSheet = workbook.addWorksheet('Items');
  itemsSheet.columns = [
    { header: 'product_id', key: 'product_id', width: 18 },
    { header: 'product_name', key: 'product_name', width: 32 },
    { header: 'product_sku', key: 'product_sku', width: 16 },
    { header: 'quantity', key: 'quantity', width: 12 },
    { header: 'gross_item_sales', key: 'gross_item_sales', width: 18 },
    { header: 'item_discounts', key: 'item_discounts', width: 16 },
    { header: 'net_item_sales', key: 'net_item_sales', width: 16 },
    { header: 'tax_amount', key: 'tax_amount', width: 14 },
    { header: 'ingredient_cost', key: 'ingredient_cost', width: 16 },
    { header: 'profit', key: 'profit', width: 16 },
    { header: 'margin_percent', key: 'margin_percent', width: 16 },
    { header: 'cost_status', key: 'cost_status', width: 14 },
  ];
  itemsSheet.getRow(1).font = { bold: true };
  itemsSheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const item of dataset.items) {
    const entry = itemsSheet.addRow({
      product_id: item.product_id,
      product_name: item.product_name,
      product_sku: item.product_sku ?? '',
      quantity: item.quantity,
      gross_item_sales: item.gross_item_sales,
      item_discounts: item.item_discounts,
      net_item_sales: item.net_item_sales,
      tax_amount: item.tax_amount,
      ingredient_cost: item.ingredient_cost ?? '',
      profit: item.profit ?? '',
      margin_percent: item.margin_percent ?? '',
      cost_status: item.cost_status,
    });
    entry.getCell('quantity').numFmt = '#,##0.###';
    for (const col of [
      'gross_item_sales',
      'item_discounts',
      'net_item_sales',
      'tax_amount',
    ] as const) {
      entry.getCell(col).numFmt = moneyFmt;
    }
    if (typeof item.ingredient_cost === 'number') {
      entry.getCell('ingredient_cost').numFmt = moneyFmt;
    }
    if (typeof item.profit === 'number') {
      entry.getCell('profit').numFmt = moneyFmt;
    }
    if (typeof item.margin_percent === 'number') {
      entry.getCell('margin_percent').numFmt = '0.00';
    }
  }

  const paymentsSheet = workbook.addWorksheet('Payments');
  paymentsSheet.columns = [
    { header: 'bill_number', key: 'bill_number', width: 22 },
    { header: 'order_number', key: 'order_number', width: 22 },
    { header: 'payment_time', key: 'payment_time', width: 20 },
    { header: 'method', key: 'method', width: 18 },
    { header: 'amount', key: 'amount', width: 14 },
    { header: 'transaction_id', key: 'transaction_id', width: 28 },
  ];
  paymentsSheet.getRow(1).font = { bold: true };
  paymentsSheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const payment of dataset.payments) {
    const entry = paymentsSheet.addRow({ ...payment });
    entry.getCell('amount').numFmt = moneyFmt;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function serializeDailySalesExportCsv(
  dataset: DailySalesExportDataset,
  part: DailySalesExportCsvPart,
): string {
  const lines: string[] = [];
  if (part === 'summary') {
    lines.push(toCsvRow(['metric', 'value']));
    for (const row of dailySalesSummaryMetricRows(dataset.summary)) {
      lines.push(toCsvRow([row.metric, row.value]));
    }
  } else if (part === 'daily') {
    lines.push(toCsvRow([...DAILY_SALES_DAILY_COLUMNS]));
    for (const day of dataset.daily) {
      lines.push(
        toCsvRow([
          day.business_date,
          day.order_count,
          day.paid_bill_count,
          day.gross_collected,
          day.refunds_issued,
          day.net_collected,
          day.tax_total,
          day.discount_total,
          day.service_charge_total,
          day.packaging_charge_total,
          day.delivery_charge_total,
          day.known_cost_net_item_sales,
          day.ingredient_cost_total ?? '',
          day.gross_profit_total ?? '',
          day.gross_margin_percent ?? '',
          day.cost_coverage_status,
        ]),
      );
    }
  } else if (part === 'taxes') {
    lines.push(toCsvRow([...DAILY_SALES_TAX_COLUMNS]));
    for (const tax of dataset.taxes) {
      lines.push(
        toCsvRow([
          tax.business_date,
          tax.tax_name,
          tax.tax_rate ?? '',
          tax.taxable_base ?? '',
          tax.tax_amount,
          tax.gross_amount ?? '',
          String(tax.shared_base),
          String(tax.base_additive),
          String(tax.incomplete_detail),
          tax.warning,
        ]),
      );
    }
  } else if (part === 'payments') {
    lines.push(toCsvRow([...DAILY_SALES_PAYMENT_COLUMNS]));
    for (const payment of dataset.payments) {
      lines.push(toCsvRow(DAILY_SALES_PAYMENT_COLUMNS.map((column) => payment[column])));
    }
  } else {
    lines.push(toCsvRow([...DAILY_SALES_ITEM_COLUMNS]));
    for (const item of dataset.items as DailySalesExportItemRow[]) {
      lines.push(
        toCsvRow([
          item.product_id,
          item.product_name,
          item.product_sku ?? '',
          item.quantity,
          item.gross_item_sales,
          item.item_discounts,
          item.net_item_sales,
          item.tax_amount,
          item.ingredient_cost ?? '',
          item.profit ?? '',
          item.margin_percent ?? '',
          item.cost_status,
        ]),
      );
    }
  }
  return lines.join('\n') + '\n';
}
