/** Loads what a kitchen ticket needs to print customer contact, when the merchant turned it on. */
import { getDatabase, getSettingValue } from '../db';

/**
 * Order fields to merge before rendering a kitchen ticket: whether the store has scheduled orders
 * on, so a scheduled order's time prints, and, when `kot_show_customer_contact` is `true` or
 * `delivery`, that value plus the customer's phone number, which the print routes do not load.
 */
export function kotCustomerContactFields(
  order: { customer_id?: string | number | null; customer?: object | null } | null | undefined,
): Record<string, unknown> {
  const scheduled = {
    show_scheduled_time: getSettingValue('scheduled_orders_enabled') === 'true',
  };
  const show = getSettingValue('kot_show_customer_contact');
  if (show !== 'true' && show !== 'delivery') return scheduled;
  const contact = order?.customer_id
    ? (getDatabase().prepare('SELECT phone FROM customers WHERE id = ?').get(order.customer_id) as
        | { phone?: string }
        | undefined)
    : undefined;
  return {
    ...scheduled,
    show_customer_contact: show === 'delivery' ? show : true,
    ...(contact ? { customer: { ...order?.customer, ...contact } } : {}),
  };
}
