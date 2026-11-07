/** No mask option here either, so the two documents cannot share a default. */

import { createTranslator } from 'use-intl/core';
import { getCachedMessages } from '@/lib/i18n/loader';
import { LANGUAGES, getLanguageDirection, type Language } from '@/lib/i18n/languages';
import { escapeHtml } from './web-print';
import { formatItemHeading } from './item-heading';
import { formatTime } from './format-date';
import type {
  DeliverySlipContact,
  DeliverySlipItem,
  DeliverySlipOrder,
} from './delivery-slip-encoder';
import {
  clampDeliverySlipText,
  deliverySlipExpectedPaymentText,
  sanitizeDeliverySlipPaymentMethod,
  type DeliverySlipPrintData,
} from '@print/document';
import { isTerminalItemStatus } from '../../../../shared/order-item-status';
import { normalizePrinterTextSize, type PrinterTextSize } from '../../../../shared/print/text-size';

export interface DeliverySlipWebPrintOptions {
  /** 58 mm or 80mm paper. Controls font sizing. Default: 58 */
  paperWidth?: 58 | 80;
  /** Printer text size preset. Default: 'normal' */
  textSize?: PrinterTextSize;
  /** UI/receipt language. */
  language?: Language;
  /** BCP-47 locale used by the print fragment. */
  locale?: string;
  /** Store timezone used for business-local time formatting. */
  timezone?: string;
  payment?: NonNullable<DeliverySlipPrintData['payment']>;
}

function translatorFor(lang: Language): (key: string) => string {
  const locale = LANGUAGES[lang]?.locale ?? 'en';
  const messages = getCachedMessages(lang) ?? getCachedMessages('en') ?? {};
  return createTranslator({ locale, messages }) as unknown as (key: string) => string;
}

function slipNoteHtml(
  raw: string | null | undefined,
  label: string,
  tr: (key: string) => string,
): string {
  const { text, truncatedChars: truncated } = clampDeliverySlipText((raw ?? '').trim());
  if (!text && truncated <= 0) return '';
  const marker =
    truncated > 0
      ? `<p style="margin:2px 0;font-style:italic;">${escapeHtml(tr('print.deliverySlip.addressTruncated').replace('{count}', String(truncated)))}</p>`
      : '';
  const noteHtml = text
    ? `<p style="margin:2px 0;">${escapeHtml(label)}: ${escapeHtml(text)}</p>`
    : '';
  return `${noteHtml}${marker}`;
}

export function generateDeliverySlipHtml(
  order: DeliverySlipOrder,
  items: DeliverySlipItem[],
  contact: DeliverySlipContact,
  opts: DeliverySlipWebPrintOptions = {},
): string {
  const paperWidth = opts.paperWidth ?? 58;
  const normalizedTextSize = normalizePrinterTextSize(opts.textSize);
  const fontSize =
    paperWidth === 58
      ? normalizedTextSize === 'extra_large'
        ? '16px'
        : normalizedTextSize === 'large'
          ? '14px'
          : '12px'
      : normalizedTextSize === 'extra_large'
        ? '18px'
        : normalizedTextSize === 'large'
          ? '16px'
          : '13px';
  const headingFontSize =
    paperWidth === 58
      ? normalizedTextSize === 'extra_large'
        ? '20px'
        : normalizedTextSize === 'large'
          ? '18px'
          : '15px'
      : normalizedTextSize === 'extra_large'
        ? '22px'
        : normalizedTextSize === 'large'
          ? '20px'
          : '16px';
  const fontWeight = normalizedTextSize === 'normal' ? 600 : 700;
  const padding = paperWidth === 58 ? '4px' : '6px';
  const paperWidthCss = paperWidth === 58 ? '58mm' : '80mm';
  const lang = opts.language ?? 'en';
  const tr = translatorFor(lang);
  const direction = getLanguageDirection(lang);
  const locale = opts.locale ?? LANGUAGES[lang]?.locale ?? 'en';
  const timezone = opts.timezone;
  const textAlign = direction === 'rtl' ? 'right' : 'left';

  const activeItems = (items ?? []).filter((item) => !isTerminalItemStatus(item?.status));
  const itemRows = activeItems
    .map(
      (item) => `
    <div style="margin:${padding} 0;font-weight:bold;">${escapeHtml(`${item.quantity}x ${formatItemHeading(item.product_name, item.variant_selection)}`)}</div>
    ${(item.addons ?? []).map((addon) => `<div style="padding-inline-start:1em;">+ ${escapeHtml(addon.name)}${addon.quantity && addon.quantity > 1 ? ` x${addon.quantity}` : ''}</div>`).join('')}
    ${item.special_instructions ? `<div style="padding-inline-start:1em;font-style:italic;">&gt;&gt; ${escapeHtml(item.special_instructions)}</div>` : ''}
  `,
    )
    .join('');

  const payment = opts.payment;
  const isPaid = payment?.status === 'paid';
  const isCollectible = payment?.status === 'unpaid' && payment.amount > 0;
  const method = isPaid
    ? payment.methods && payment.methods.length > 1
      ? tr('print.deliverySlip.multiplePaymentMethods')
      : sanitizeDeliverySlipPaymentMethod(payment.method)
    : '';
  const paymentMethod =
    method.toLowerCase() === 'cash'
      ? tr('pos.methodCash')
      : method.toLowerCase() === 'card'
        ? tr('pos.methodCard')
        : ['wallet', 'loyalty', 'loyalty wallet'].includes(method.toLowerCase())
          ? tr('pos.methodWallet')
          : method;
  const paymentHtml = !payment
    ? ''
    : isPaid
      ? `<div class="delivery-slip-payment delivery-slip-payment-paid" style="margin:${padding} 0;padding:${padding};border:2px solid #000;border-radius:4px;background:transparent;color:#000;overflow-wrap:anywhere;word-break:break-word;font-weight:bold;"><div>${escapeHtml(tr('print.deliverySlip.paid'))}: ${escapeHtml(paymentMethod)} (${escapeHtml(tr('pos.total'))}: ${escapeHtml(payment.formattedAmount)})</div>${payment.formattedAmountDue ? `<div style="margin-top:2px;font-weight:normal;">${escapeHtml(tr('print.deliverySlip.amountDue'))}: ${escapeHtml(payment.formattedAmountDue)}</div>` : ''}</div>`
      : isCollectible
        ? `<div class="delivery-slip-payment delivery-slip-payment-collect" style="margin:${padding} 0;padding:${padding};border:2px solid #000;border-radius:4px;background:transparent;color:#000;overflow-wrap:anywhere;word-break:break-word;font-weight:bold;">${escapeHtml(tr('print.deliverySlip.toCollect'))}: ${escapeHtml(payment.formattedAmount)} (${escapeHtml(deliverySlipExpectedPaymentText(payment.expectedMethod, tr, payment.expectedMethodIsCustom === true))})</div>`
        : payment.status === 'unpaid'
          ? `<div class="delivery-slip-payment delivery-slip-payment-unpaid" style="margin:${padding} 0;padding:${padding};border:1px solid #000;border-radius:4px;background:transparent;color:#000;overflow-wrap:anywhere;word-break:break-word;font-weight:bold;">${escapeHtml(tr('print.deliverySlip.amountDue'))}: ${escapeHtml(payment.formattedAmount)}</div>`
          : `<div class="delivery-slip-payment delivery-slip-payment-refunded" style="margin:${padding} 0;padding:${padding};border:1px solid #000;border-radius:4px;background:transparent;color:#000;overflow-wrap:anywhere;word-break:break-word;font-weight:bold;"><div>${escapeHtml(tr(payment.status === 'refunded' ? 'print.deliverySlip.refunded' : 'print.deliverySlip.partiallyRefunded'))}</div><div style="margin-top:2px;font-weight:normal;">${escapeHtml(tr('print.deliverySlip.amountDue'))}: ${escapeHtml(payment.formattedAmountDue ?? '')}</div></div>`;

  return `
    <div class="delivery-slip" lang="${escapeHtml(locale)}" dir="${direction}" style="width:100%;max-width:${paperWidthCss};min-width:0;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word;padding:${padding};font-family:'Courier New','Noto Sans Bengali','Nirmala UI','Vrinda','Bangla Sangam MN','Noto Sans Devanagari','Kohinoor Devanagari','Devanagari Sangam MN','Noto Sans Gurmukhi','Raavi','Kohinoor Gurmukhi','Gurmukhi Sangam MN','Noto Sans Telugu','Kohinoor Telugu','Telugu Sangam MN','Noto Sans Thai','Leelawadee UI',Thonburi,monospace;font-size:${fontSize};font-weight:${fontWeight};color:#000;direction:${direction};text-align:${textAlign};">
      <h2 style="margin:0 0 ${padding} 0;font-size:${headingFontSize};text-align:center;">${escapeHtml(tr('print.deliverySlip.banner'))}</h2>
      <p style="margin:2px 0;font-weight:bold;">#${escapeHtml(order.order_number)}</p>
      <p style="margin:2px 0;">${escapeHtml(tr('print.time'))}: ${escapeHtml(formatTime(order.created_at, locale, timezone ? { timeZone: timezone } : undefined))}</p>
      <hr style="border:1px dashed #000;margin:${padding} 0;">
      ${contact.name ? `<p style="margin:2px 0;font-weight:bold;">${escapeHtml(contact.name)}</p>` : ''}
      ${contact.phone ? `<p style="margin:2px 0;">${escapeHtml(tr('print.numberShort'))}: ${escapeHtml(contact.phone)}</p>` : ''}
      ${contact.address ? `<p style="margin:2px 0;">${escapeHtml(tr('print.deliverySlip.address'))}: ${escapeHtml(contact.address)}</p>` : ''}
      ${slipNoteHtml(order.delivery_note, tr('print.deliverySlip.deliveryNote'), tr)}
      ${slipNoteHtml(order.special_instructions, tr('print.note'), tr)}
      ${paymentHtml}
      <hr style="border:1px dashed #000;margin:${padding} 0;">
      ${itemRows}
      <hr style="border:1px dashed #000;margin:${padding} 0;">
    </div>
  `;
}
