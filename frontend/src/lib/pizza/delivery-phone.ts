/**
 * The phone number a pizza delivery order needs for its delivery slip. The pizza setup is told by
 * the fork's `pos_order_types` setting, which only the pizza profile writes.
 */
import { parsePhone } from '@/lib/phone';
import type { Customer } from '@/lib/types';

export const DELIVERY_PHONE_ID = 'pizza-delivery-phone';

export type DeliveryPhone = NonNullable<ReturnType<typeof parsePhone>>;

type Client = {
  get: (url: string, config: { params: { phone: string } }) => Promise<{ data: unknown }>;
  post: (url: string, body: Record<string, string>) => Promise<{ data: unknown }>;
};

/** True when Place Order needs a phone number: a new delivery order of the pizza setup. */
export function phoneRequired(
  posOrderTypes: readonly string[],
  orderType: string,
  addingToOrder: boolean,
): boolean {
  return posOrderTypes.length > 0 && orderType === 'delivery' && !addingToOrder;
}

/** The number typed, read with the store's country code as the customer search reads it. */
export function deliveryPhone(text: string, country: string): DeliveryPhone | null {
  return parsePhone(text, country);
}

export function sameNumber(
  customer: Pick<Customer, 'phone'> | null,
  phone: DeliveryPhone | null,
): boolean {
  const digits = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');
  return !!customer && !!phone && digits(customer.phone) === digits(phone.e164);
}

/** The active customer with this number, through the find-by-phone route; null when none. */
export async function findByPhone(
  client: Pick<Client, 'get'>,
  e164: string,
): Promise<Customer | null> {
  const { data } = await client.get('/crm/lookup', { params: { phone: e164 } });
  const customer = (data as { customer?: (Customer & { is_active?: number }) | null }).customer;
  return customer && customer.is_active !== 0 ? customer : null;
}

/** The customer for the order: the one with this number, or a new one made from it and the name. */
export async function deliveryCustomer(
  client: Client,
  phone: DeliveryPhone,
  name: string,
): Promise<Customer> {
  const found = await findByPhone(client, phone.e164);
  if (found) return found;
  const { data } = await client.post('/customers', {
    name: name.trim() || phone.e164,
    phone: phone.e164,
    country_code: phone.countryCode,
  });
  return (data as { customer: Customer }).customer;
}
