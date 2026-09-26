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

/**
 * Cap a customer address on the way in.
 *
 * The delivery slip prints the address in full, so the address is free text
 * flowing into a printed document and is capped the same way order notes are.
 * This refuses a too-long new value; it never rewrites an existing row, so a
 * legacy address written before the cap still reads and still prints (wrapped)
 * on the slip.
 */
export function validateCustomerAddress(db: SettingsLookup, address: string | null | undefined): void {
  validateNoteLength(db, 'max_customer_address_length', DEFAULT_MAX_CUSTOMER_ADDRESS_LENGTH, address, 'Customer address');
}

/**
 * Cap a per-order delivery address on the way in.
 *
 * Same reason as the customer address: the courier slip prints it in full, so it
 * is free text flowing into a printed document. Capped at the order boundary, so
 * nothing unbounded is ever persisted.
 */
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
