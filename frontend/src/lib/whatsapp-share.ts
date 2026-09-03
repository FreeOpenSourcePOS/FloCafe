/**
 * whatsapp-share.ts
 *
 * Generate WhatsApp share links for bills.
 * Uses wa.me API to pre-fill message with bill details.
 */

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

/**
 * Generate a wa.me URL for sharing bill details via WhatsApp.
 */
export function getWhatsAppShareUrl(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  customer: Pick<Customer, 'phone' | 'country_code'> | null,
  opts: WhatsAppShareOptions = {},
  localeOverride?: string,
): string {
  const { pointsEarned = 0, walletBalance, businessPhone } = opts;
  const currency = tenant.currency ?? 'INR';
  const locale = localeOverride || getCountryByCode(tenant.country ?? 'IN')?.locale || 'en-US';

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

/**
 * Open WhatsApp share in a new window/tab.
 */
export function shareBillViaWhatsApp(
  bill: Bill,
  customerInfo: Pick<Customer, 'phone' | 'country_code'> | null,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: WhatsAppShareOptions = {},
  localeOverride?: string,
): void {
  const url = getWhatsAppShareUrl(bill, tenant, customerInfo, opts, localeOverride);
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Generate just the message text (for copying to clipboard).
 */
export function getWhatsAppMessage(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: WhatsAppShareOptions = {},
  localeOverride?: string,
): string {
  const { pointsEarned = 0, walletBalance } = opts;
  const currency = tenant.currency ?? 'INR';
  const locale = localeOverride || getCountryByCode(tenant.country ?? 'IN')?.locale || 'en-US';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(value: number | string, currencyCode: string, locale: string): string {
  const amount = Number(value);
  const decimals = getCurrencyFractionDigits(currencyCode);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number.isFinite(amount) ? amount : 0);
}

/** One line per ordered item (skipping cancelled ones), e.g. "2x Chicken Biryani - ₹360.00". */
function formatItemsList(order: Bill['order'], currencyCode: string, locale: string): string[] {
  const items = order?.items?.filter((item) => item.status !== 'cancelled') ?? [];
  return items.map((item) => `${item.quantity}x ${item.product_name} - ${formatAmount(item.total, currencyCode, locale)}`);
}

/**
 * Send a paid bill receipt through Flo's connected WhatsApp session.
 * Single source of truth for the /whatsapp/send call + error-toast mapping,
 * shared by the orders list and the PaymentModal "send after payment" step.
 */
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
