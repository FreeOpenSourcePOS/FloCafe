import ExcelJS from 'exceljs';
import { toCsvRow } from '../lib/csv';
import {
  DAILY_SALES_ITEM_COLUMNS,
  dailySalesSummaryMetricRows,
  type DailySalesExportDataset,
  type DailySalesExportItemRow,
} from './daily-sales-export';

export type DailySalesExportFormat = 'xlsx' | 'csv';
export type DailySalesExportCsvPart = 'summary' | 'items';

export function dailySalesExportFilename(
  businessDate: string,
  format: DailySalesExportFormat,
  part?: DailySalesExportCsvPart,
): string {
  if (format === 'xlsx') return `daily-sales-${businessDate}.xlsx`;
  if (part === 'summary') return `daily-sales-${businessDate}-summary.csv`;
  if (part === 'items') return `daily-sales-${businessDate}-items.csv`;
  throw new Error('CSV export requires part=summary or part=items');
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
    if (typeof row.value === 'number' && !row.metric.endsWith('_count')) {
      entry.getCell('value').numFmt = moneyFmt;
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
    });
    entry.getCell('quantity').numFmt = '#,##0.###';
    for (const col of ['gross_item_sales', 'item_discounts', 'net_item_sales', 'tax_amount'] as const) {
      entry.getCell(col).numFmt = moneyFmt;
    }
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
  } else {
    lines.push(toCsvRow([...DAILY_SALES_ITEM_COLUMNS]));
    for (const item of dataset.items as DailySalesExportItemRow[]) {
      lines.push(toCsvRow([
        item.product_id,
        item.product_name,
        item.product_sku ?? '',
        item.quantity,
        item.gross_item_sales,
        item.item_discounts,
        item.net_item_sales,
        item.tax_amount,
      ]));
    }
  }
  return lines.join('\n') + '\n';
}
