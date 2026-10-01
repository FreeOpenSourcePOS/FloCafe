import ExcelJS from 'exceljs';
import { toCsvRow } from '../lib/csv';

interface CashClosePaymentExportRow {
  method: string;
  count: number;
  total: number;
}

interface CashCloseStaffExportRow {
  name: string;
  role: string;
  orderCount: number;
  revenue: number;
}

interface CashCloseExportBase {
  businessDate: string;
  periodStart: string;
  periodEnd: string;
  grossSales: number;
  refunds: number;
  netCollections: number;
  billCount: number;
  expectedCash: number;
  openingFloat: number;
  payIn: number;
  payOut: number;
  safeDrops: number;
  paymentMethods: CashClosePaymentExportRow[];
  staffSales: CashCloseStaffExportRow[];
}

export type XReportExport = CashCloseExportBase;

export interface ZReportExport extends CashCloseExportBase {
  zNumber: number;
  closedAt: string;
  closedBy: string;
  notes: string | null;
  countedCash: number;
  cashVariance: number;
}

type ReportMetric = [string, string | number | null];

function xReportMetrics(report: XReportExport): ReportMetric[] {
  return [
    ['Business Date', report.businessDate],
    ['Period Start', report.periodStart],
    ['Period End', report.periodEnd],
    ['Gross Sales', report.grossSales],
    ['Refunds', report.refunds],
    ['Net Collections', report.netCollections],
    ['Bill Count', report.billCount],
    ['Expected Cash in Drawer', report.expectedCash],
    ['Opening Float', report.openingFloat],
    ['Pay-in Total', report.payIn],
    ['Pay-out Total', report.payOut],
    ['Safe Drops', report.safeDrops],
  ];
}

function zReportMetrics(report: ZReportExport): ReportMetric[] {
  return [
    ...xReportMetrics(report),
    ['Z Number', report.zNumber],
    ['Closed At', report.closedAt],
    ['Closed By', report.closedBy],
    ['Notes', report.notes],
    ['Counted Cash', report.countedCash],
    ['Cash Variance', report.cashVariance],
  ];
}

function serializeCsv(metrics: ReportMetric[], report: CashCloseExportBase): string {
  const lines = [toCsvRow(['section', 'field', 'name', 'role', 'count', 'value'])];
  for (const [field, value] of metrics) {
    lines.push(toCsvRow(['summary', field, '', '', '', value]));
  }
  for (const payment of report.paymentMethods) {
    lines.push(toCsvRow(['payment', '', payment.method, '', payment.count, payment.total]));
  }
  for (const staff of report.staffSales) {
    lines.push(toCsvRow(['staff', '', staff.name, staff.role, staff.orderCount, staff.revenue]));
  }
  return `${lines.join('\n')}\n`;
}

async function serializeXlsx(metrics: ReportMetric[], report: CashCloseExportBase): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Value', key: 'value', width: 36 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.views = [{ state: 'frozen', ySplit: 1 }];
  for (const [metric, value] of metrics) summary.addRow({ metric, value });

  const payments = workbook.addWorksheet('Payments');
  payments.columns = [
    { header: 'Method', key: 'method', width: 28 },
    { header: 'Count', key: 'count', width: 12 },
    { header: 'Total', key: 'total', width: 18 },
  ];
  payments.getRow(1).font = { bold: true };
  payments.views = [{ state: 'frozen', ySplit: 1 }];
  for (const payment of report.paymentMethods) payments.addRow(payment);

  const staff = workbook.addWorksheet('Staff');
  staff.columns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Role', key: 'role', width: 18 },
    { header: 'Orders', key: 'orderCount', width: 12 },
    { header: 'Revenue', key: 'revenue', width: 18 },
  ];
  staff.getRow(1).font = { bold: true };
  staff.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of report.staffSales) staff.addRow(row);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function serializeXReportCsv(report: XReportExport): string {
  return serializeCsv(xReportMetrics(report), report);
}

export function serializeZReportCsv(report: ZReportExport): string {
  return serializeCsv(zReportMetrics(report), report);
}

export function serializeXReportXlsx(report: XReportExport): Promise<Buffer> {
  return serializeXlsx(xReportMetrics(report), report);
}

export function serializeZReportXlsx(report: ZReportExport): Promise<Buffer> {
  return serializeXlsx(zReportMetrics(report), report);
}
