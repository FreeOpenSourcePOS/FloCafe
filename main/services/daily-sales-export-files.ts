import ExcelJS from 'exceljs';
import { toCsvRow } from '../lib/csv';
import {
  DAILY_SALES_ITEM_COLUMNS,
  DAILY_SALES_PAYMENT_COLUMNS,
  dailySalesSummaryMetricRows,
  type DailySalesExportDataset,
  type DailySalesExportItemRow,
} from './daily-sales-export';

export type DailySalesExportFormat = 'xlsx' | 'csv';
export type DailySalesExportCsvPart = 'summary' | 'items' | 'payments';

export function dailySalesExportFilename(
  businessDate: string,
  format: DailySalesExportFormat,
  part?: DailySalesExportCsvPart,
): string {
  if (format === 'xlsx') return `daily-sales-${businessDate}.xlsx`;
  if (part === 'summary') return `daily-sales-${businessDate}-summary.csv`;
  if (part === 'items') return `daily-sales-${businessDate}-items.csv`;
  if (part === 'payments') return `daily-sales-${businessDate}-payments.csv`;
  throw new Error('CSV export requires part=summary, part=items or part=payments');
}

function moneyNumFmt(fractionDigits: number): string {
  const zeros = '0'.repeat(Math.max(0, fractionDigits));
  return fractionDigits > 0 ? `#,##0.${zeros}` : '#,##0';
}

/**
 * Serializers only — no accounting math. Both formats read the same dataset.
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
