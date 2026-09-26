/**
 * Delivery slip HTML renderer for the browser print dialog.
 *
 * The browser path is the full-Unicode path, so an address in any script
 * survives it. Like the byte encoder, the customer number is printed in full
 * and there is no mask option here: the receipt's masking lives on the receipt
 * renderer so the two documents cannot share a default.
 */

import { createTranslator } from 'use-intl/core';
import { getCachedMessages } from '@/lib/i18n/loader';
import { LANGUAGES, getLanguageDirection, type Language } from '@/lib/i18n/languages';
import { escapeHtml } from './web-print';
import { formatTime } from './format-date';
import type {
  DeliverySlipContact,
  DeliverySlipItem,
  DeliverySlipOrder,
} from './delivery-slip-encoder';

export interface DeliverySlipWebPrintOptions {
  /** 58 mm or 80mm paper. Controls font sizing. Default: 58 */
  paperWidth?: 58 | 80;
  /** UI/receipt language. */
  language?: Language;
  /** BCP-47 locale used by the print fragment. */
  locale?: string;
  /** Store timezone used for business-local time formatting. */
  timezone?: string;
}

function translatorFor(lang: Language): ((key: string) => string) {
  const locale = LANGUAGES[lang]?.locale ?? 'en';
  const messages = getCachedMessages(lang) ?? getCachedMessages('en') ?? {};
  return createTranslator({ locale, messages }) as unknown as (key: string) => string;
}

/** Render one delivery slip as a printable HTML fragment. */
export function generateDeliverySlipHtml(
  order: DeliverySlipOrder,
  items: DeliverySlipItem[],
  contact: DeliverySlipContact,
  opts: DeliverySlipWebPrintOptions = {},
): string {
  const paperWidth = opts.paperWidth ?? 58;
  const fontSize = paperWidth === 58 ? '10px' : '12px';
  const padding = paperWidth === 58 ? '4px' : '6px';
  const paperWidthCss = paperWidth === 58 ? '58mm' : '80mm';
  const lang = opts.language ?? 'en';
  const tr = translatorFor(lang);
  const direction = getLanguageDirection(lang);
  const locale = opts.locale ?? LANGUAGES[lang]?.locale ?? 'en';
  const timezone = opts.timezone;
  const textAlign = direction === 'rtl' ? 'right' : 'left';

  const itemRows = (items ?? []).map((item) => `
    <div style="margin:${padding} 0;font-weight:bold;">${escapeHtml(`${item.quantity}x ${item.product_name}`)}</div>
    ${item.special_instructions ? `<div style="padding-inline-start:1em;font-style:italic;">&gt;&gt; ${escapeHtml(item.special_instructions)}</div>` : ''}
  `).join('');

  return `
    <div class="delivery-slip" lang="${escapeHtml(locale)}" dir="${direction}" style="width:100%;max-width:${paperWidthCss};min-width:0;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word;padding:${padding};font-family:'Courier New','Noto Sans Bengali','Nirmala UI','Vrinda','Bangla Sangam MN','Noto Sans Devanagari','Kohinoor Devanagari','Devanagari Sangam MN','Noto Sans Thai','Leelawadee UI',Thonburi,monospace;font-size:${fontSize};direction:${direction};text-align:${textAlign};">
      <h2 style="margin:0 0 ${padding} 0;font-size:${paperWidth === 58 ? '14px' : '16px'};text-align:center;">${escapeHtml(tr('print.deliverySlip.banner'))}</h2>
      <p style="margin:2px 0;font-weight:bold;">#${escapeHtml(order.order_number)}</p>
      <p style="margin:2px 0;">${escapeHtml(tr('print.time'))}: ${escapeHtml(formatTime(order.created_at, locale, timezone ? { timeZone: timezone } : undefined))}</p>
      <hr style="border:1px dashed #000;margin:${padding} 0;">
      ${contact.name ? `<p style="margin:2px 0;font-weight:bold;">${escapeHtml(contact.name)}</p>` : ''}
      ${contact.phone ? `<p style="margin:2px 0;">${escapeHtml(tr('print.numberShort'))}: ${escapeHtml(contact.phone)}</p>` : ''}
      ${contact.address ? `<p style="margin:2px 0;">${escapeHtml(tr('print.deliverySlip.address'))}: ${escapeHtml(contact.address)}</p>` : ''}
      <hr style="border:1px dashed #000;margin:${padding} 0;">
      ${itemRows}
      <hr style="border:1px dashed #000;margin:${padding} 0;">
    </div>
  `;
}
