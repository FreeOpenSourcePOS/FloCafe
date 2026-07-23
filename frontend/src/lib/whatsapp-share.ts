/**
 * whatsapp-share.ts
 *
 * Generate WhatsApp share links for bills.
 * Uses wa.me API to pre-fill message with bill details.
 */

import type { Bill, Tenant, Customer } from '@/lib/types';
import { getCountryByCode, getCurrencySymbol } from '@/lib/countries';
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
  opts: WhatsAppShareOptions = {}
): string {
  const { pointsEarned = 0, walletBalance, businessPhone } = opts;
  const currency = getCurrencySymbol(tenant.currency ?? 'INR', getCountryByCode(tenant.country ?? 'IN')?.locale);
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';

  // Build the message
  const lines: string[] = [];

  lines.push(`*${tenant.business_name}*`);
  lines.push(`Bill #: ${bill.bill_number}`);
  lines.push(`Date: ${formatDate(bill.order?.created_at, locale)}`);
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
  lines.push(`Thank you for your visit!`);

  const message = lines.join('\n');

  // Determine phone number to send to
  const phone = customer?.phone?.replace(/\D/g, '') || '';


  // Use wa.me API - works for both personal and business WhatsApp
  // If businessPhone is provided, send to business account, otherwise to customer
  const waPhone = businessPhone?.replace(/\D/g, '') || '';

  // Build wa.me URL
  const waUrl = `https://wa.me/${waPhone || phone}?text=${encodeURIComponent(message)}`;

  return waUrl;
}

/**
 * Open WhatsApp share in a new window/tab.
 */
export function shareBillViaWhatsApp(
  bill: Bill,
  customerInfo: Pick<Customer, 'phone' | 'country_code'> | null,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: WhatsAppShareOptions = {}
): void {
  const url = getWhatsAppShareUrl(bill, tenant, customerInfo, opts);
  window.open(url, '_blank');
}

/**
 * Generate just the message text (for copying to clipboard).
 */
export function getWhatsAppMessage(
  bill: Bill,
  tenant: Pick<Tenant, 'business_name' | 'currency' | 'country'>,
  opts: WhatsAppShareOptions = {}
): string {
  const { pointsEarned = 0, walletBalance } = opts;
  const currency = tenant.currency ?? '₹';
  const locale = getCountryByCode(tenant.country ?? 'IN')?.locale ?? 'en-US';

  const lines: string[] = [];

  lines.push(`${tenant.business_name}`);
  lines.push(`Bill #: ${bill.bill_number}`);
  lines.push(`Date: ${formatDate(bill.order?.created_at)}`);
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

function formatAmount(value: number | string, currency: string, locale: string): string {
  return `${currency}${Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Send a paid bill receipt through Flo's connected WhatsApp session.
 * Single source of truth for the /whatsapp/send call + error-toast mapping,
 * shared by the orders list and the PaymentModal "send after payment" step.
 */
export async function sendBillViaFlo(
  bill: Bill,
  customerPhone: string,
  currency: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): Promise<void> {
  const message = `Receipt for bill ${bill.bill_number} — Total ${currency} ${bill.total}`;
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
    const msg = axiosErr?.response?.data?.error ?? t('whatsapp.send.failed');
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
