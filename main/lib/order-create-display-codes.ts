/** Re-exported so the create path keeps one import path for its codes. */
export {
  ORDER_CREATE_DISPLAY_CODES,
  type OrderCreateDisplayCode,
} from '../../shared/order-create-display-codes';

import type { OrderCreateDisplayCode } from '../../shared/order-create-display-codes';

/** Errors thrown deeper in the create path carry one of these codes, never free text. */
const ERROR_CODE_TO_DISPLAY_CODE: Readonly<Record<string, OrderCreateDisplayCode>> = {
  MULTI_COUNTER_DISABLED: 'multi_counter_disabled',
  SCHEDULED_ORDERS_DISABLED: 'scheduled_orders_disabled',
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',
  PRODUCT_NOT_FOUND: 'item_not_found',
  PRICE_INVALID: 'price_invalid',
  PRICE_OVERRIDE_FORBIDDEN: 'price_override_forbidden',
  ADDON_QUANTITY_INVALID: 'addon_quantity_invalid',
  INVALID_CHARGE_AMOUNT: 'invalid_charge_amount',
  ORDER_NOTES_TOO_LONG: 'order_notes_too_long',
  ITEM_NOTES_TOO_LONG: 'item_notes_too_long',
  DELIVERY_ADDRESS_TOO_LONG: 'delivery_address_too_long',
  DELIVERY_NOTE_TOO_LONG: 'delivery_note_too_long',
  EXPECTED_PAYMENT_METHOD_INVALID: 'expected_payment_method_invalid',
};

/** Maps a thrown error to its display code; unknown errors stay uncoded instead of guessed. */
export function orderCreateDisplayCodeFromError(
  error: unknown,
): OrderCreateDisplayCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { diagnosticCode, code, name } = error as {
    diagnosticCode?: unknown;
    code?: unknown;
    name?: unknown;
  };
  if (name === 'ChargeValidationError') return 'invalid_charge_amount';
  const key = typeof diagnosticCode === 'string' ? diagnosticCode : code;
  if (typeof key !== 'string' || !Object.hasOwn(ERROR_CODE_TO_DISPLAY_CODE, key)) return undefined;
  return ERROR_CODE_TO_DISPLAY_CODE[key];
}
