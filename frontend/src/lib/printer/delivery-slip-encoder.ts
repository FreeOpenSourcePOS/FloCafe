/** A courier slip has no money on it and no mask option; see product-invariants. */

import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import { columnsForReceiptPaperSize } from '@print/width';
import { formatTime } from './format-date';
import { safePrinterText as writeSafePrinterText, type PrintWarning } from './warnings';
import { printLabelResolver } from './print-document';

export interface DeliverySlipWebUsbOptions {
  /** 58 mm (32 cols) or 80 mm (42 cols). Default: 58 */
  paperWidth?: 58 | 80;
  /** Exact column count the configured printer declares; overrides `paperWidth`. */
  columns?: number;
  /** Print language resolved from the receipt language policy. */
  language?: string;
  /** Store timezone used for business-local time formatting. */
  timezone?: string;
  /** Printer firmware performs Arabic/Persian contextual shaping. Default: false. */
  arabicShaping?: boolean;
}

/** Contact facts for one courier slip. The phone is already country-code prefixed. */
export interface DeliverySlipContact {
  name: string;
  phone: string;
  address: string;
}

export interface DeliverySlipOrder {
  order_number: string;
  created_at: string;
  type?: string;
}

export interface DeliverySlipItem {
  product_name: string;
  quantity: number;
  /** Selected add-ons, printed under the item as the kitchen ticket does. */
  addons?: Array<{ name: string; quantity?: number }>;
  special_instructions?: string | null;
}

// Paper-size fallback only; callers that know the configured printer pass
// `columns`. The number itself lives in `columnsForReceiptPaperSize`.
const CHARS: Record<58 | 80, number> = { 58: columnsForReceiptPaperSize(58), 80: columnsForReceiptPaperSize(80) };

export function buildDeliverySlipBytes(
  order: DeliverySlipOrder,
  items: DeliverySlipItem[],
  contact: DeliverySlipContact,
  opts: DeliverySlipWebUsbOptions = {},
  warnings: PrintWarning[] = [],
): Uint8Array {
  const {
    paperWidth = 58,
    language = 'en',
    timezone,
    arabicShaping = false,
  } = opts;
  const cols = opts.columns ?? CHARS[paperWidth];
  const safePrinterText = writeSafePrinterText;
  const enc = new ReceiptPrinterEncoder({ columns: cols });

  const label = (concept: string): string => printLabelResolver(concept as never, language);
  const dash = '-'.repeat(cols);
  const bar = '='.repeat(cols);

  enc.align('center').bold(true);
  safePrinterText(enc, label('print.deliverySlip.banner'), warnings, true, arabicShaping, undefined, cols, language);
  enc.bold(false).align('left').newline().newline();

  safePrinterText(enc, `${label('pos.orderNumber').replace('{number}', order.order_number)}`, warnings, false, arabicShaping, undefined, cols, language).newline();
  if (order.type) {
    safePrinterText(enc, `${label('print.kot.type')}: ${order.type.replace(/_/g, ' ').toUpperCase()}`, warnings, false, arabicShaping, undefined, cols, language).newline();
  }
  safePrinterText(enc, `${label('print.time')}: ${formatTime(order.created_at, 'en-US', timezone ? { timeZone: timezone } : undefined)}`, warnings, false, arabicShaping, undefined, cols, language).newline();

  enc.newline();
  enc.align('center');
  if (contact.name) {
    enc.bold(true);
    safePrinterText(enc, contact.name, warnings, false, arabicShaping, undefined, cols, language).newline();
    enc.bold(false);
  }
  if (contact.phone) {
    safePrinterText(enc, `${label('print.numberShort')}: ${contact.phone}`, warnings, false, arabicShaping, undefined, cols, language).newline();
  }
  // Wrapped, not truncated: a wrapped address stays readable at 32 columns.
  if (contact.address) {
    safePrinterText(enc, `${label('print.deliverySlip.address')}: ${contact.address}`, warnings, false, arabicShaping, undefined, cols, language).newline();
  }

  enc.align('left').newline();
  enc.text(dash).newline().newline();

  for (const item of items ?? []) {
    const prefix = `${item.quantity}x  `;
    enc.bold(true);
    safePrinterText(enc, prefix + item.product_name, warnings, false, arabicShaping, undefined, cols, language).newline();
    enc.bold(false);
    for (const addon of item.addons ?? []) {
      const suffix = addon.quantity && addon.quantity > 1 ? ` x${addon.quantity}` : '';
      safePrinterText(enc, `  + ${addon.name}${suffix}`, warnings, false, arabicShaping, undefined, cols, language).newline();
    }
    if (item.special_instructions) {
      safePrinterText(enc, `  >> ${item.special_instructions}`, warnings, false, arabicShaping, undefined, cols, language).newline();
    }
  }

  enc.newline();
  enc.text(bar).newline().newline().cut();

  return enc.encode();
}
