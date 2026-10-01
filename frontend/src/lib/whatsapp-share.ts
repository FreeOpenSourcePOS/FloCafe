/** Generates WhatsApp share links for bills using wa.me API. */

import type { Bill, Tenant, Customer } from '@/lib/types';
import { getCountryByCode, getCurrencyFractionDigits } from '@/lib/countries';
import { formatDate } from './printer/format-date';
import api from './api';
import toast from 'react-hot-toast';

export interface WhatsAppShareOptions {
  /** Points earned from this bill (cashback) */
  pointsEarned?: number;
  /** Current wallet balance */
  walletBalance?: number;
  /** Business phone for WhatsApp business account */
  businessPhone?: string;
}

interface CashCloseReportBase {
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
  paymentMethods: { method: string; count: number; total: number }[];
}

export type XReportExport = CashCloseReportBase;

export interface ZReportExport extends CashCloseReportBase {
  zNumber: number;
  closedAt: string;
  closedBy: string;
  notes: string | null;
  countedCash: number;
  cashVariance: number;
}

export interface CashCloseWhatsAppLabels {
  xReport?: string;
  zReport?: string;
  date?: string;
  closedBy?: string;
  grossSales?: string;
  refunds?: string;
  netCollections?: string;
  billCount?: (count: number) => string;
  openingFloat?: string;
  expectedCash?: string;
  countedCash?: string;
  variance?: string;
  notes?: string;
  none?: string;
  varianceExact?: string;
  varianceShort?: string;
  varianceOver?: string;
  paymentMethod?: (method: string) => string;
  salesSummary?: string;
  paymentBreakdown?: string;
  drawerReconciliation?: string;
}

export function formatCashCloseWhatsAppMessage(
  report: XReportExport | ZReportExport,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country' | 'timezone'>,
  localeOverride?: string,
  labels: CashCloseWhatsAppLabels = {},
): string {
  const locale = localeOverride || getCountryByCode(tenant.country)?.locale || 'en-US';
  const isZReport = 'zNumber' in report;
  const expectedCash = isZReport ? report.expectedCash : report.expectedCash + report.openingFloat;
  const period = `${formatReportDateTime(report.periodStart, locale, tenant.timezone)} - ${formatReportDateTime(report.periodEnd, locale, tenant.timezone)}`;
  const lines = [
    `📊 *${isZReport ? `${labels.zReport || 'Z-Report'} #${report.zNumber}` : labels.xReport || 'X-Report'} - ${tenant.business_name}*`,
    `📅 *${labels.date || 'Date'}:* ${formatBusinessDate(report.businessDate, locale)} (${period})`,
  ];

  if (isZReport) lines.push(`👤 *${labels.closedBy || 'Closed by'}:* ${report.closedBy}`);

  lines.push(
    '',
    `💰 *${labels.salesSummary || 'SALES SUMMARY'}*`,
    `• ${labels.grossSales || 'Gross Sales'}: ${formatAmount(report.grossSales, tenant.currency, locale)}`,
    `• ${labels.refunds || 'Refunds'}: ${formatAmount(report.refunds, tenant.currency, locale)}`,
    `• ${labels.netCollections || 'Net Collections'}: ${formatAmount(report.netCollections, tenant.currency, locale)}`,
    `• ${labels.billCount?.(report.billCount) || `Total Bills: ${report.billCount}`}`,
    '',
    `💳 *${labels.paymentBreakdown || 'PAYMENTS'}*`,
    ...report.paymentMethods.map((payment) =>
      `• ${labels.paymentMethod?.(payment.method) || payment.method}: ${formatAmount(payment.total, tenant.currency, locale)} (${payment.count})`),
  );

  lines.push(
    '',
    `💵 *${labels.drawerReconciliation || 'DRAWER RECONCILIATION'}*`,
    `• ${labels.openingFloat || 'Opening Float'}: ${formatAmount(report.openingFloat, tenant.currency, locale)}`,
    `• ${labels.expectedCash || 'Expected Cash'}: ${formatAmount(expectedCash, tenant.currency, locale)}`,
  );

  if (isZReport) {
    const varianceIndicator = report.cashVariance === 0
      ? `✅ ${labels.varianceExact || 'Exact'}`
      : report.cashVariance < 0 ? `⚠️ ${labels.varianceShort || 'Short'}` : `⚠️ ${labels.varianceOver || 'Over'}`;
    lines.push(
      `• ${labels.countedCash || 'Counted Cash'}: ${formatAmount(report.countedCash, tenant.currency, locale)}`,
      `• ${labels.variance || 'Variance'}: ${formatAmount(report.cashVariance, tenant.currency, locale)} (${varianceIndicator})`,
      '',
      `📝 *${labels.notes || 'Notes'}:* ${report.notes || labels.none || 'None'}`,
    );
  }

  return lines.join('\n');
}

export async function shareCashCloseViaWhatsApp(
  report: XReportExport | ZReportExport,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country' | 'timezone'>,
  phoneE164: string,
  labels: CashCloseWhatsAppLabels = {},
  cashCloseId?: number,
  localeOverride?: string,
): Promise<'sent' | 'opened' | false> {
  const message = formatCashCloseWhatsAppMessage(report, tenant, localeOverride, labels);
  const url = `https://wa.me/${phoneE164.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
  const popup = window.electronAPI ? null : window.open('', '_blank');
  if (popup) popup.opener = null;

  const openFallback = async (): Promise<'opened' | false> => {
    if (window.electronAPI?.openWhatsAppShare) {
      const result = await window.electronAPI.openWhatsAppShare(url);
      return 'success' in result && result.success === true ? 'opened' : false;
    }
    if (!popup) return false;
    popup.location.href = url;
    return 'opened';
  };

  if (message.length > 4096) return openFallback();

  if ('zNumber' in report && cashCloseId !== undefined) {
    try {
      const { data } = await api.post(`/reports/cash-closes/${cashCloseId}/whatsapp`, {
        phone_e164: phoneE164,
        body: message,
      });
      if (data?.success === true) {
        popup?.close();
        return 'sent';
      }
      if (data?.fallback === true && data?.reason === 'not_connected') return openFallback();
      popup?.close();
      return false;
    } catch (error: unknown) {
      const reason = (error as { response?: { data?: { reason?: string } } })?.response?.data?.reason;
      if (reason !== 'not_connected') {
        popup?.close();
        throw error;
      }
      return openFallback();
    }
  }

  return openFallback();
}

/** Generates a wa.me URL pre-filled with bill details for WhatsApp sharing. */
export function getWhatsAppShareUrl(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  customer: Pick<Customer, 'phone' | 'country_code'> | null,
  opts: WhatsAppShareOptions = {},
  localeOverride?: string,
): string {
  const { pointsEarned = 0, walletBalance, businessPhone } = opts;
  const currency = tenant.currency;
  const locale = localeOverride || getCountryByCode(tenant.country)?.locale || 'en-US';

  // Build the message
  const lines: string[] = [];

  lines.push(`*${tenant.business_name}*`);
  lines.push(`Bill #: ${bill.bill_number}`);
  lines.push(`Date: ${formatDate(bill.order?.created_at, locale)}`);
  const itemLines = formatItemsList(bill.order, currency, locale);
  if (itemLines.length > 0) {
    lines.push(``);
    lines.push(`*Items:*`);
    lines.push(...itemLines);
  }
  lines.push(``);
  lines.push(`*Total: ${formatAmount(bill.total, currency, locale)}*`);

  if (pointsEarned > 0) {
    lines.push(``);
    lines.push(`You earned ${pointsEarned} loyalty points! 🎉`);
  }

  if (walletBalance !== undefined && walletBalance > 0) {
    lines.push(`Your wallet balance: ${formatAmount(walletBalance, currency, locale)}`);
  }

  lines.push(``);
  lines.push(`Thank you for your visit! 🙏`);

  if (businessPhone) {
    lines.push(`Contact: ${businessPhone}`);
  }

  const message = lines.join('\n');
  const encoded = encodeURIComponent(message);

  if (customer && customer.phone) {
    const cleanPhone = customer.phone.replace(/[^0-9]/g, '');
    return `https://wa.me/${cleanPhone}?text=${encoded}`;
  }

  return `https://wa.me/?text=${encoded}`;
}

/** Opens the WhatsApp share URL externally and reports whether it opened. */
export function shareBillViaWhatsApp(
  bill: Bill,
  customerInfo: Pick<Customer, 'phone' | 'country_code'> | null,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: WhatsAppShareOptions = {},
  localeOverride?: string,
): Promise<boolean> {
  const url = getWhatsAppShareUrl(bill, tenant, customerInfo, opts, localeOverride);
  if (window.electronAPI?.openWhatsAppShare) {
    return window.electronAPI.openWhatsAppShare(url)
      .then((result) => 'success' in result && result.success === true);
  }
  const popup = window.open('', '_blank');
  if (!popup) return Promise.resolve(false);
  popup.opener = null;
  popup.location.href = url;
  return Promise.resolve(true);
}

/** Generates plain text bill summary message for clipboard copy. */
export function getWhatsAppMessage(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: WhatsAppShareOptions = {},
  localeOverride?: string,
): string {
  const { pointsEarned = 0, walletBalance } = opts;
  const currency = tenant.currency;
  const locale = localeOverride || getCountryByCode(tenant.country)?.locale || 'en-US';

  const lines: string[] = [];

  lines.push(`${tenant.business_name}`);
  lines.push(`Bill #: ${bill.bill_number}`);
  lines.push(`Date: ${formatDate(bill.order?.created_at, locale)}`);
  const itemLines = formatItemsList(bill.order, currency, locale);
  if (itemLines.length > 0) {
    lines.push(``);
    lines.push(`Items:`);
    lines.push(...itemLines);
  }
  lines.push(``);
  lines.push(`Total: ${formatAmount(bill.total, currency, locale)}`);

  if (pointsEarned > 0) {
    lines.push(``);
    lines.push(`You earned ${pointsEarned} loyalty points!`);
  }

  if (walletBalance !== undefined && walletBalance > 0) {
    lines.push(`Your wallet balance: ${formatAmount(walletBalance, currency, locale)}`);
  }

  lines.push(``);
  lines.push(`Thank you for your visit!`);

  return lines.join('\n');
}

// Helpers

function formatAmount(value: number | string, currencyCode: string, locale: string): string {
  const amount = Number(value);
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    const decimals = getCurrencyFractionDigits(currencyCode);
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(safeAmount);
  } catch {
    // currencyCode empty/invalid (e.g. tenant regional snapshot not resolved
    // yet) — Intl throws for an empty/invalid currency. Plain number, no
    // symbol, rather than crashing or guessing a currency (never restore INR).
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(safeAmount);
  }
}

function formatBusinessDate(value: string, locale: string): string {
  try {
    const date = new Date(`${value}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
  } catch {
    return value;
  }
}

function formatReportDateTime(value: string, locale: string, timeZone: string): string {
  try {
    const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    return value;
  }
}

/** One line per ordered item (skipping cancelled ones), e.g. "2x Chicken Biryani - ₹360.00". */
function formatItemsList(order: Bill['order'], currencyCode: string, locale: string): string[] {
  const items = order?.items?.filter((item) => item.status !== 'cancelled') ?? [];
  return items.map((item) => `${item.quantity}x ${item.product_name} - ${formatAmount(item.total, currencyCode, locale)}`);
}

/** Sends paid bill receipt through connected WhatsApp session. */
export async function sendBillViaFlo(
  bill: Bill,
  customerPhone: string,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  t: (key: string, params?: Record<string, string | number>) => string,
  opts: WhatsAppShareOptions = {},
  localeOverride?: string,
): Promise<void> {
  const message = getWhatsAppMessage(bill, tenant, opts, localeOverride);
  try {
    const { data } = await api.post('/whatsapp/send', {
      bill_id: bill.id,
      kind: 'bill_receipt',
      phone_e164: customerPhone,
      body: message,
    });
    if (data?.ok) toast.success(t('whatsapp.send.success'));
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string; reason?: string } } };
    const reason = axiosErr?.response?.data?.reason;
    const msg = t('whatsapp.send.failed');
    if (reason === 'not_connected') {
      toast.error(t('whatsapp.send.error.notConnected'));
    } else if (reason === 'not_on_whatsapp') {
      toast.error(t('whatsapp.send.error.notOnWhatsapp'));
    } else if (reason === 'blocked') {
      toast.error(t('whatsapp.send.error.blocked'));
    } else if (reason === 'rate_limited') {
      toast.error(msg || t('whatsapp.send.error.rateLimited'));
    } else {
      toast.error(msg);
    }
  }
}
