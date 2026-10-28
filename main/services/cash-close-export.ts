import ExcelJS from 'exceljs';
import {
  formatMoney,
  formatNumber,
  resolveRegionalSnapshot,
  type LocalePreferences,
} from '../countries';
import { getSettingValue } from '../db';
import { toCsvRow } from '../lib/csv';

export interface CashClosePaymentExportRow {
  method: string;
  count: number;
  total: number;
}

export interface CashCloseStaffExportRow {
  name: string;
  role: string;
  orderCount: number;
  revenue: number;
}

export interface CashCloseTaxComponentExportRow {
  title: string;
  rate: number | null;
  amount: number;
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
  taxComponents?: CashCloseTaxComponentExportRow[];
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

export interface CashCloseHtmlOptions {
  businessName?: string;
  currency?: string;
  locale?: string;
  timezone?: string;
  preferences?: LocalePreferences;
}

type ReportMetric = [string, string | number | null];

const MONEY_METRICS = new Set<string>([
  'Gross Sales',
  'Refunds',
  'Net Collections',
  'Expected Cash in Drawer',
  'Opening Float',
  'Pay-in Total',
  'Pay-out Total',
  'Safe Drops',
  'Counted Cash',
  'Cash Variance',
]);

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveHtmlOptions(options?: CashCloseHtmlOptions): Required<CashCloseHtmlOptions> {
  let currency = options?.currency || '';
  let locale = options?.locale || '';
  let timezone = options?.timezone || '';
  let preferences = options?.preferences;

  if (!currency || !locale || !timezone || !preferences) {
    try {
      const snapshot = resolveRegionalSnapshot({
        country: getSettingValue('country') ?? undefined,
        currency: getSettingValue('currency') ?? undefined,
        timezone: getSettingValue('timezone') ?? undefined,
        currency_display: getSettingValue('currency_display') ?? undefined,
        number_digits: getSettingValue('number_digits') ?? undefined,
        calendar: getSettingValue('calendar') ?? undefined,
      });
      if (!currency) currency = snapshot.currency;
      if (!locale) locale = snapshot.locale;
      if (!timezone) timezone = snapshot.timezone;
      if (!preferences) preferences = snapshot.preferences;
    } catch {
      if (!currency) currency = getSettingValue('currency') || 'USD';
      if (!locale) locale = 'en-US';
      if (!timezone) timezone = getSettingValue('timezone') || 'UTC';
    }
  }

  const businessName =
    options?.businessName !== undefined
      ? options.businessName
      : (getSettingValue('business_name') ?? '');

  return {
    businessName: businessName || 'FloCafe',
    currency: currency || 'USD',
    locale: locale || 'en-US',
    timezone: timezone || 'UTC',
    preferences: preferences ?? { currencyDisplay: 'rial', digits: 'locale', calendar: 'locale' },
  };
}

function formatMoneyWithExact(amount: number, resolved: Required<CashCloseHtmlOptions>): string {
  const formatted = formatMoney(amount, resolved.currency, resolved.locale, resolved.preferences);
  const exact = String(amount);
  if (formatted.includes(exact)) {
    return escapeHtml(formatted);
  }
  return `${escapeHtml(formatted)} <span class="exact-num">(${escapeHtml(exact)})</span>`;
}

function formatCountWithExact(count: number, resolved: Required<CashCloseHtmlOptions>): string {
  const numberingSystem = resolved.preferences.digits === 'latin' ? 'latn' : undefined;
  const formatted = formatNumber(count, resolved.locale, numberingSystem);
  const exact = String(count);
  if (formatted.includes(exact)) {
    return escapeHtml(formatted);
  }
  return `${escapeHtml(formatted)} <span class="exact-num">(${escapeHtml(exact)})</span>`;
}

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

async function serializeXlsx(
  metrics: ReportMetric[],
  report: CashCloseExportBase,
): Promise<Buffer> {
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

function serializeHtml(
  kind: 'x' | 'z',
  metrics: ReportMetric[],
  report: CashCloseExportBase & Partial<ZReportExport>,
  options?: CashCloseHtmlOptions,
): string {
  const resolved = resolveHtmlOptions(options);
  const titleText =
    kind === 'z' && typeof report.zNumber === 'number'
      ? `Z Report #${report.zNumber} — ${report.businessDate}`
      : `X Report — ${report.businessDate}`;

  const summaryRowsHtml = metrics
    .map(([metric, value]) => {
      const rawValue = value === null || value === undefined ? '' : String(value);
      let renderedValue: string;
      let isNumeric = false;
      if (typeof value === 'number' && MONEY_METRICS.has(metric)) {
        renderedValue = formatMoneyWithExact(value, resolved);
        isNumeric = true;
      } else if (typeof value === 'number' && metric === 'Bill Count') {
        renderedValue = formatCountWithExact(value, resolved);
        isNumeric = true;
      } else if (typeof value === 'number' && metric === 'Z Number') {
        renderedValue = `Z#${escapeHtml(String(value))} <span class="exact-num">(${escapeHtml(String(value))})</span>`;
        isNumeric = true;
      } else if (value === null || value === '') {
        renderedValue = '—';
      } else {
        renderedValue = `<span dir="auto" class="bidi-text">${escapeHtml(String(value))}</span>`;
      }
      return `<tr data-section="summary" data-metric="${escapeHtml(metric)}" data-value="${escapeHtml(rawValue)}">
            <th scope="row">${escapeHtml(metric)}</th>
            <td class="${isNumeric ? 'num' : ''}" data-value="${escapeHtml(rawValue)}">${renderedValue}</td>
          </tr>`;
    })
    .join('\n');

  const paymentRowsHtml =
    report.paymentMethods.length > 0
      ? report.paymentMethods
          .map(
            (
              payment,
            ) => `<tr data-section="payment" data-method="${escapeHtml(payment.method)}" data-count="${escapeHtml(String(payment.count))}" data-total="${escapeHtml(String(payment.total))}">
            <td data-col="method" data-value="${escapeHtml(payment.method)}"><span dir="auto" class="bidi-text">${escapeHtml(payment.method)}</span></td>
            <td class="num" data-col="count" data-value="${escapeHtml(String(payment.count))}">${formatCountWithExact(payment.count, resolved)}</td>
            <td class="num" data-col="total" data-value="${escapeHtml(String(payment.total))}">${formatMoneyWithExact(payment.total, resolved)}</td>
          </tr>`,
          )
          .join('\n')
      : `<tr class="empty-row"><td colspan="3">No payments recorded</td></tr>`;

  const taxComponents = Array.isArray(report.taxComponents) ? report.taxComponents : [];
  const taxSectionHtml =
    taxComponents.length > 0
      ? `<section class="report-section" data-section="taxes">
      <h2>Tax Breakdown</h2>
      <table>
        <thead>
          <tr>
            <th>Tax</th>
            <th class="num">Rate (%)</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${taxComponents
            .map(
              (
                tax,
              ) => `<tr data-section="tax" data-title="${escapeHtml(tax.title)}" data-rate="${escapeHtml(tax.rate === null ? '' : String(tax.rate))}" data-amount="${escapeHtml(String(tax.amount))}">
            <td data-col="title" data-value="${escapeHtml(tax.title)}"><span dir="auto" class="bidi-text">${escapeHtml(tax.title)}</span></td>
            <td class="num" data-col="rate" data-value="${escapeHtml(tax.rate === null ? '' : String(tax.rate))}">${tax.rate === null ? '—' : `${escapeHtml(String(tax.rate))}%`}</td>
            <td class="num" data-col="amount" data-value="${escapeHtml(String(tax.amount))}">${formatMoneyWithExact(tax.amount, resolved)}</td>
          </tr>`,
            )
            .join('\n')}
        </tbody>
      </table>
    </section>`
      : '';

  const staffRowsHtml =
    report.staffSales.length > 0
      ? report.staffSales
          .map(
            (
              staff,
            ) => `<tr data-section="staff" data-name="${escapeHtml(staff.name)}" data-role="${escapeHtml(staff.role)}" data-orders="${escapeHtml(String(staff.orderCount))}" data-revenue="${escapeHtml(String(staff.revenue))}">
            <td data-col="name" data-value="${escapeHtml(staff.name)}"><span dir="auto" class="bidi-text">${escapeHtml(staff.name)}</span></td>
            <td data-col="role" data-value="${escapeHtml(staff.role)}"><span dir="auto" class="bidi-text">${escapeHtml(staff.role)}</span></td>
            <td class="num" data-col="orderCount" data-value="${escapeHtml(String(staff.orderCount))}">${formatCountWithExact(staff.orderCount, resolved)}</td>
            <td class="num" data-col="revenue" data-value="${escapeHtml(String(staff.revenue))}">${formatMoneyWithExact(staff.revenue, resolved)}</td>
          </tr>`,
          )
          .join('\n')
      : `<tr class="empty-row"><td colspan="4">No staff sales recorded</td></tr>`;

  return `<!doctype html>
<html lang="${escapeHtml(resolved.locale)}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(resolved.businessName)} — ${escapeHtml(titleText)}</title>
  <style>
    @page { size: A4 portrait; margin: 12mm; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Naskh Arabic", "Noto Sans Arabic", "Noto Sans Bengali", "Vrinda", "Bangla Sangam MN", "Noto Sans Devanagari", "Nirmala UI", "Kohinoor Devanagari", "Devanagari Sangam MN", "Noto Sans Thai", "Leelawadee UI", "Thonburi", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", "Hiragino Sans", "Yu Gothic", "Meiryo", "Noto Sans CJK JP", "Noto Sans JP", "Noto Sans", "Helvetica Neue", Arial, sans-serif;
      font-size: 11px;
      line-height: 1.45;
      color: #111827;
      background: #ffffff;
    }
    .report-header {
      border-bottom: 2px solid #111827;
      padding-bottom: 8px;
      margin-bottom: 14px;
      break-inside: avoid;
    }
    .business-name {
      font-size: 18px;
      font-weight: 700;
      margin: 0 0 2px 0;
      unicode-bidi: plaintext;
    }
    .report-title {
      font-size: 14px;
      font-weight: 600;
      margin: 0 0 4px 0;
      color: #1f2937;
    }
    .report-meta {
      font-size: 10px;
      color: #4b5563;
      margin: 0;
    }
    .report-section {
      margin-bottom: 16px;
    }
    .report-section h2 {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #374151;
      margin: 0 0 6px 0;
      break-after: avoid;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: auto;
    }
    thead {
      display: table-header-group;
    }
    tr {
      break-inside: avoid;
    }
    th, td {
      border: 1px solid #d1d5db;
      padding: 5px 8px;
      text-align: left;
      vertical-align: top;
    }
    thead th {
      background: #f3f4f6;
      font-weight: 600;
      color: #111827;
    }
    tbody th {
      background: #f9fafb;
      font-weight: 500;
      width: 42%;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .bidi-text {
      unicode-bidi: plaintext;
    }
    .exact-num {
      color: #6b7280;
      font-size: 10px;
    }
    .empty-row td {
      text-align: center;
      color: #6b7280;
      font-style: italic;
    }
  </style>
</head>
<body>
  <header class="report-header">
    <h1 class="business-name" dir="auto">${escapeHtml(resolved.businessName)}</h1>
    <div class="report-title">${escapeHtml(titleText)}</div>
    <p class="report-meta">
      Business Date: <strong>${escapeHtml(report.businessDate)}</strong>
      &middot; Period: <strong>${escapeHtml(report.periodStart)}</strong> to <strong>${escapeHtml(report.periodEnd)}</strong>
      &middot; Currency: <strong>${escapeHtml(resolved.currency)}</strong>
    </p>
  </header>

  <section class="report-section" data-section="summary">
    <h2>Summary</h2>
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          <th class="num">Value</th>
        </tr>
      </thead>
      <tbody>
        ${summaryRowsHtml}
      </tbody>
    </table>
  </section>

  <section class="report-section" data-section="payments">
    <h2>Payment Methods</h2>
    <table>
      <thead>
        <tr>
          <th>Method</th>
          <th class="num">Count</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>
        ${paymentRowsHtml}
      </tbody>
    </table>
  </section>

  ${taxSectionHtml}

  <section class="report-section" data-section="staff">
    <h2>Staff Sales</h2>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Role</th>
          <th class="num">Orders</th>
          <th class="num">Revenue</th>
        </tr>
      </thead>
      <tbody>
        ${staffRowsHtml}
      </tbody>
    </table>
  </section>
</body>
</html>
`;
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

export function serializeXReportHtml(
  report: XReportExport,
  options?: CashCloseHtmlOptions,
): string {
  return serializeHtml('x', xReportMetrics(report), report, options);
}

export function serializeZReportHtml(
  report: ZReportExport,
  options?: CashCloseHtmlOptions,
): string {
  return serializeHtml('z', zReportMetrics(report), report, options);
}
