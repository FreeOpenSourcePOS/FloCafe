/**
 * Order notes validation functions.
 *
 * Separated from orders.ts so they can be imported by tests without
 * pulling in Electron, Express, or other heavy dependencies.
 *
 * Both functions accept a `db` parameter (any object with a `.prepare().get()`
 * interface) to stay dependency-free and testable with node:sqlite or better-sqlite3.
 */

const DEFAULT_MAX_ORDER_NOTES_LENGTH = 200;
const DEFAULT_MAX_ITEM_NOTES_LENGTH = 100;

function validateNoteLength(db: any, settingKey: string, defaultLimit: number, notes: string | null | undefined, label: string): void {
  if (!notes) return;
  const rawValue = (db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey) as { value?: string } | undefined)?.value;
  const parsed = parseInt(rawValue || '', 10);
  const maxLength = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultLimit;
  if (notes.length > maxLength) {
    throw new Error(`${label} exceed maximum length of ${maxLength} characters`);
  }
}

export function validateOrderNotes(db: any, notes: string | null | undefined): void {
  validateNoteLength(db, 'max_order_notes_length', DEFAULT_MAX_ORDER_NOTES_LENGTH, notes, 'Order notes');
}

export function validateItemNotes(db: any, notes: string | null | undefined): void {
  validateNoteLength(db, 'max_item_notes_length', DEFAULT_MAX_ITEM_NOTES_LENGTH, notes, 'Item notes');
}
