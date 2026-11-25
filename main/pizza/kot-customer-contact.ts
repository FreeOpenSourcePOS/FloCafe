/** Loads what a kitchen ticket needs to print customer contact, when the merchant turned it on. */
import { getDatabase, getSettingValue } from '../db';

/**
 * Order fields to merge before rendering a kitchen ticket. Empty unless
 * `kot_show_customer_contact` is on; then the flag, plus the customer's phone
 * number, which the print routes do not load.
 */
export function kotCustomerContactFields(
  order: { customer_id?: string | number | null; customer?: object | null } | null | undefined,
): Record<string, unknown> {
  if (getSettingValue('kot_show_customer_contact') !== 'true') return {};
  const contact = order?.customer_id
    ? (getDatabase().prepare('SELECT phone FROM customers WHERE id = ?').get(order.customer_id) as
        | { phone?: string }
        | undefined)
    : undefined;
  return {
    show_customer_contact: true,
    ...(contact ? { customer: { ...order?.customer, ...contact } } : {}),
  };
}
