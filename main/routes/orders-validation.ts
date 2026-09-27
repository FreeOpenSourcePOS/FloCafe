/** Order and item notes validation functions. */

/** The read-only handle these validators need: a settings lookup and nothing more. */
type SettingsLookup = { prepare(sql: string): { get(...params: unknown[]): unknown } };

const DEFAULT_MAX_ORDER_NOTES_LENGTH = 200;
const DEFAULT_MAX_ITEM_NOTES_LENGTH = 100;
const DEFAULT_MAX_CUSTOMER_ADDRESS_LENGTH = 300;
const DEFAULT_MAX_DELIVERY_ADDRESS_LENGTH = 300;

function validateNoteLength(db: SettingsLookup, settingKey: string, defaultLimit: number, notes: string | null | undefined, label: string): void {
  if (!notes) return;
  const rawValue = (db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey) as { value?: string } | undefined)?.value;
  const parsed = parseInt(rawValue || '', 10);
  const maxLength = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultLimit;
  if (notes.length > maxLength) {
    throw new Error(`${label} exceed maximum length of ${maxLength} characters`);
  }
}

export function validateOrderNotes(db: SettingsLookup, notes: string | null | undefined): void {
  validateNoteLength(db, 'max_order_notes_length', DEFAULT_MAX_ORDER_NOTES_LENGTH, notes, 'Order notes');
}

export function validateItemNotes(db: SettingsLookup, notes: string | null | undefined): void {
  validateNoteLength(db, 'max_item_notes_length', DEFAULT_MAX_ITEM_NOTES_LENGTH, notes, 'Item notes');
}

/** Refuses a too-long new value; never rewrites a legacy row that is too long. */
export function validateCustomerAddress(db: SettingsLookup, address: string | null | undefined): void {
  validateNoteLength(db, 'max_customer_address_length', DEFAULT_MAX_CUSTOMER_ADDRESS_LENGTH, address, 'Customer address');
}

/** Free text bound for a printed document, so nothing unbounded is persisted. */
export function validateDeliveryAddress(db: SettingsLookup, address: string | null | undefined): void {
  validateNoteLength(db, 'max_delivery_address_length', DEFAULT_MAX_DELIVERY_ADDRESS_LENGTH, address, 'Delivery address');
}

export function validateProductQuantity(
  product: { name?: string; sale_unit?: string; allow_fractional_quantity?: boolean | number; weight_precision?: number },
  quantity: unknown,
): asserts quantity is number {
  const productName = product.name || 'product';
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw Object.assign(new Error(`Invalid quantity for ${productName}: must be a positive number`), { statusCode: 400 });
  }
  if (Number.isInteger(quantity)) return;
  if (!['kg', 'g', 'lb', 'ml', 'cl', 'l', 'fl oz', 'oz'].includes(product.sale_unit || 'each') || Number(product.allow_fractional_quantity) !== 1) {
    throw Object.assign(new Error(`Invalid quantity for ${productName}: fractional quantities are not allowed`), { statusCode: 400 });
  }

  const precision = Number.isInteger(product.weight_precision)
    ? Math.min(Math.max(Number(product.weight_precision), 0), 4)
    : 3;
  const scale = 10 ** precision;
  if (Math.abs(quantity * scale - Math.round(quantity * scale)) > 1e-8) {
    throw Object.assign(new Error(`Invalid quantity for ${productName}: use at most ${precision} decimal places`), { statusCode: 400 });
  }
}
