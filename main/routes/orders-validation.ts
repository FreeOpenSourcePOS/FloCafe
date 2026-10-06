/** Order and item notes validation functions. */

/** The read-only handle these validators need: a settings lookup and nothing more. */
type SettingsLookup = { prepare(sql: string): { get(...params: unknown[]): unknown } };

const DEFAULT_MAX_ORDER_NOTES_LENGTH = 200;
const DEFAULT_MAX_ITEM_NOTES_LENGTH = 100;
const DEFAULT_MAX_CUSTOMER_ADDRESS_LENGTH = 300;
const DEFAULT_MAX_DELIVERY_ADDRESS_LENGTH = 300;
const DEFAULT_MAX_DELIVERY_NOTE_LENGTH = 200;
/** Built-in methods a courier can collect at the door; wallet and loyalty settle in-store. */
const COURIER_COLLECTIBLE_METHODS = ['cash', 'card'];

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

/** Courier-only free text, bounded for the slip like the delivery address. */
export function validateDeliveryNote(db: SettingsLookup, note: string | null | undefined): void {
  validateNoteLength(db, 'max_delivery_note_length', DEFAULT_MAX_DELIVERY_NOTE_LENGTH, note, 'Delivery note');
}

/**
 * The method the courier expects to collect, never a record of payment. Null is
 * unknown; `pending` means the customer has not decided yet.
 */
export function resolveExpectedPaymentMethod(db: SettingsLookup, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('expected_payment_method must be a string');
  const method = value.trim();
  const normalized = method.toLowerCase();
  if (normalized === '' || normalized === 'unknown') return null;
  if (normalized === 'pending' || COURIER_COLLECTIBLE_METHODS.includes(normalized)) return normalized;
  const custom = db.prepare('SELECT name FROM payment_methods WHERE name = ? COLLATE NOCASE AND is_active = 1').get(method) as { name?: string } | undefined;
  if (!custom?.name) {
    throw new Error('expected_payment_method must be unknown, pending, cash, card, or an active payment method');
  }
  return custom.name;
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
