/** Customer contact facts a kitchen ticket header prints when the merchant opts in. */

import { stripControlBytes } from './detail-lines';

/** One labelled header line; `concept` names an existing print label. */
export interface KotContactLine {
  readonly concept:
    | 'print.numberShort'
    | 'print.deliverySlip.address'
    | 'print.deliverySlip.deliveryNote';
  readonly text: string;
}

/** One line of text: a stored line break becomes a space, so the two parts do not run together. */
const text = (value: unknown): string =>
  typeof value === 'string' ? stripControlBytes(value.replace(/\s+/g, ' ')).trim() : '';

/**
 * Contact lines for a raw order: the customer's phone number when the order
 * has one, then the delivery address and delivery note of a delivery order.
 * `show` is the `kot_show_customer_contact` setting: `true` prints them, `'delivery'`
 * prints them on delivery orders only, and anything else prints none.
 */
export function kotContactLines(order: unknown, show: unknown): KotContactLine[] {
  const row = (order ?? {}) as {
    type?: unknown;
    delivery_address?: unknown;
    delivery_note?: unknown;
    customer?: { phone?: unknown } | null;
  };
  const phone = text(row.customer?.phone);
  const isDelivery = text(row.type) === 'delivery';
  if (show !== true && !(show === 'delivery' && isDelivery)) return [];
  const lines: KotContactLine[] = [
    { concept: 'print.numberShort', text: phone },
    { concept: 'print.deliverySlip.address', text: isDelivery ? text(row.delivery_address) : '' },
    { concept: 'print.deliverySlip.deliveryNote', text: isDelivery ? text(row.delivery_note) : '' },
  ];
  return lines.filter((line) => line.text.length > 0);
}

/**
 * `SCHEDULED 6:30 PM` for an order with a `scheduled_for`, the time it goes to the kitchen, while
 * `show` is true, which is the store having scheduled orders on. The time is in
 * the store's time zone and the locale's clock format; null for any other order. A time on
 * another day than `now`, the day the ticket prints, carries its date: `SCHEDULED 1/2/2026 6:30 PM`.
 */
export function kotScheduleLine(
  order: unknown,
  show: unknown,
  locale: string,
  timeZone?: string,
  now = new Date(),
): string | null {
  // A stored instant is UTC, with or without the zone written out.
  const stored = text((order as { scheduled_for?: unknown } | null)?.scheduled_for);
  const at = new Date(stored.replace(/^(\S+) (\S+)$/, '$1T$2Z'));
  if (show !== true || !stored || Number.isNaN(at.getTime())) return null;
  const format = (options: Intl.DateTimeFormatOptions, instant: Date): string =>
    new Intl.DateTimeFormat(`${locale}-u-nu-latn`, {
      ...options,
      // An unset store time zone arrives as '', which Intl refuses.
      timeZone: timeZone || undefined,
    }).format(instant);
  const day = { year: 'numeric', month: 'numeric', day: 'numeric' } as const;
  const date = format(day, at);
  const time = format({ hour: 'numeric', minute: '2-digit' }, at);
  // Intl separates the day period with a narrow no-break space, which a thermal code page lacks.
  return `SCHEDULED ${date === format(day, now) ? '' : `${date} `}${time}`.replace(/\s/g, ' ');
}
